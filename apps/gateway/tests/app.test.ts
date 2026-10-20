// Gateway app tests — deterministic, no network, via app.request() (AGENTS.md:
// Vitest, <5 s units). CI runs these after `pnpm install`; the imports below
// (hono/zod/pino) are declared in apps/gateway/package.json.

import { describe, expect, it } from "vitest";
import pino from "pino";
import { z } from "zod";
import { buildApp } from "../src/app.js";
import type { AppDeps } from "../src/app.js";
import { gatewayEnvSchema } from "../src/env.js";
import { AppError } from "../src/middleware/error-mapper.js";
import { stubProbes } from "../src/routes/health.js";
import type { DeepCheckReport, Probe } from "../src/routes/health.js";

// Silent logger: tests assert on responses, not stdout.
const logger = pino({ enabled: false });

function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    env: gatewayEnvSchema.parse({}), // defaults: GATEWAY_PORT 8787, LOG_LEVEL info, etc.
    logger,
    version: "0.0.0-test",
    probes: stubProbes(),
    startedAt: Date.now(),
    ...overrides
  };
}

function makeApp(overrides: Partial<AppDeps> = {}): ReturnType<typeof buildApp> {
  return buildApp(makeDeps(overrides));
}

describe("request id (§22)", () => {
  it("generates a uuid and echoes it when the client sends none", async () => {
    const res = await makeApp().request("/v1/health");
    const id = res.headers.get("x-request-id");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("echoes a valid client-supplied X-Request-Id", async () => {
    const res = await makeApp().request("/v1/health", {
      headers: { "x-request-id": "req-abc.123:x" }
    });
    expect(res.headers.get("x-request-id")).toBe("req-abc.123:x");
  });

  it("replaces a malformed X-Request-Id instead of echoing it", async () => {
    const res = await makeApp().request("/v1/health", { headers: { "x-request-id": "bad id!!" } });
    const id = res.headers.get("x-request-id");
    expect(id).not.toBe("bad id!!");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("GET /v1/health (liveness)", () => {
  it("reports 200, ok:true, version and uptime", async () => {
    const res = await makeApp().request("/v1/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      service: string;
      version: string;
      uptime_seconds: number;
    };
    expect(body.ok).toBe(true);
    expect(body.service).toBe("gateway");
    expect(body.version).toBe("0.0.0-test");
    expect(body.uptime_seconds).toBeGreaterThanOrEqual(0);
  });
});

describe("GET /v1/health/deep (dependency checks, §13.1)", () => {
  it("returns 200 when all probes pass, with the five skeleton probe names", async () => {
    const res = await makeApp().request("/v1/health/deep");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; checks: DeepCheckReport[] };
    expect(body.ok).toBe(true);
    expect(body.checks.map((check) => check.name)).toEqual([
      "db",
      "valkey",
      "storage",
      "engine_pool",
      "model_providers"
    ]);
    expect(body.checks.every((check) => check.ok && check.stub === true)).toBe(true);
  });

  it("returns 503 with ok:false when any probe is down", async () => {
    const probes: Probe[] = [
      { name: "db", check: () => Promise.resolve({ ok: false, detail: "connection refused" }) }
    ];
    const res = await makeApp({ probes }).request("/v1/health/deep");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; checks: DeepCheckReport[] };
    expect(body.ok).toBe(false);
    expect(body.checks[0]?.name).toBe("db");
    expect(body.checks[0]?.ok).toBe(false);
    expect(body.checks[0]?.detail).toBe("connection refused");
  });

  it("reports a probe that throws as failed, not crashed", async () => {
    const probes: Probe[] = [{ name: "db", check: () => Promise.reject(new Error("boom")) }];
    const res = await makeApp({ probes }).request("/v1/health/deep");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; checks: DeepCheckReport[] };
    expect(body.checks[0]?.ok).toBe(false);
    expect(body.checks[0]?.detail).toBe("probe failed or timed out");
  });
});

describe("error mapping (§13.3 typed envelopes)", () => {
  it("maps unmatched non-/v1 routes to a 404 envelope", async () => {
    const res = await makeApp().request("/nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; code: string; retryable: boolean };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("not_found");
    expect(body.retryable).toBe(false);
  });

  it("answers spec'd-but-unmounted /v1 routes with a typed 501", async () => {
    const res = await makeApp().request("/v1/documents");
    expect(res.status).toBe(501);
    const body = (await res.json()) as { ok: boolean; code: string; hint?: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("not_implemented");
    expect(body.hint).toContain("§13.1");
  });

  it("maps an unexpected throw to 500 internal_error without leaking internals", async () => {
    const app = makeApp({
      mount: (a) => {
        a.get("/v1/boom", () => {
          throw new Error("kaboom: secret internal detail");
        });
      }
    });
    const res = await app.request("/v1/boom");
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      ok: boolean;
      code: string;
      message: string;
      retryable: boolean;
    };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("internal_error");
    expect(body.message).toBe("Internal server error.");
    expect(body.retryable).toBe(true);
    expect(JSON.stringify(body)).not.toContain("kaboom");
  });

  it("maps ZodError to 422 validation_failed with field details", async () => {
    const app = makeApp({
      mount: (a) => {
        a.get("/v1/zod", () => {
          z.object({ n: z.number() }).parse({ n: "not-a-number" });
          return new Response(null);
        });
      }
    });
    const res = await app.request("/v1/zod");
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      ok: boolean;
      code: string;
      details?: { path: string; message: string }[];
    };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("validation_failed");
    expect(body.details?.[0]?.path).toBe("n");
  });

  it("maps AppError to its own status/code/hint/retryable", async () => {
    const app = makeApp({
      mount: (a) => {
        a.get("/v1/conflict", () => {
          throw new AppError(409, "conflict", "Concurrent edit in progress.", {
            hint: "Reload the document and retry.",
            retryable: true
          });
        });
      }
    });
    const res = await app.request("/v1/conflict");
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      ok: boolean;
      code: string;
      message: string;
      hint?: string;
      retryable: boolean;
    };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("conflict");
    expect(body.message).toBe("Concurrent edit in progress.");
    expect(body.hint).toBe("Reload the document and retry.");
    expect(body.retryable).toBe(true);
  });
});
