// W3-gw — gateway core behavior with STUB deps (no Postgres): health, the
// §7.3 envelope contract, request ids, rate limiting, idempotency and the
// default 404. Real-Postgres flows live in the other suite files.

import { beforeEach, describe, expect, it } from "vitest";

import type { Hono } from "hono";

import { buildApp } from "../src/app.js";
import type { AppBindings } from "../src/context.js";
import { createInMemoryRateLimiter } from "../src/rate-limit.js";
import { FakeGatewayAuth, fakeRepos, stubDeps, testEnv, unique } from "./helpers.js";

const env = testEnv();

let auth: FakeGatewayAuth;
let calls: Record<string, number>;
let app: Hono<AppBindings>;

beforeEach(() => {
  auth = new FakeGatewayAuth();
  const fakes = fakeRepos(auth);
  calls = fakes.calls;
  const deps = stubDeps(env, { auth, repos: fakes.repos });
  deps.limiter = createInMemoryRateLimiter();
  app = buildApp({ deps });
});

describe("GET /health", () => {
  it("returns 200 with {status:'ok', db:true} and the gateway version", async () => {
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ status: "ok", db: true, version: "0.0.0-test" });
  });

  it("reports db:false when the probe throws (degraded boot, §14)", async () => {
    const deps = stubDeps(env);
    deps.dbHealth = async () => {
      throw new Error("connection refused");
    };
    const degraded = buildApp({ deps });
    const response = await degraded.request("/v1/health");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ status: "ok", db: false, version: "0.0.0-test" });
  });
});

describe("request ids (§7.3)", () => {
  it("generates a fresh req_ id and echoes it as x-request-id on every response", async () => {
    for (const path of ["/health", "/v1/definitely-not-a-route"]) {
      const response = await app.request(path);
      const header = response.headers.get("x-request-id");
      expect(header).toMatch(/^req_[0-9a-f]{32}$/);
    }
  });

  it("echoes a caller-provided x-request-id (≤128 chars)", async () => {
    const response = await app.request("/health", {
      headers: { "x-request-id": "req_caller_123" },
    });
    expect(response.headers.get("x-request-id")).toBe("req_caller_123");
  });

  it("keeps x-request-id on error responses (thrown + notFound paths)", async () => {
    const unauth = await app.request("/v1/me");
    expect(unauth.headers.get("x-request-id")).toMatch(/^req_/);
    const missing = await app.request("/v1/nope");
    expect(missing.headers.get("x-request-id")).toMatch(/^req_/);
  });
});

describe("unauthenticated access", () => {
  it("GET /v1/me → 401 with the exact AUTH_REQUIRED envelope (§7.3, §8.9)", async () => {
    const response = await app.request("/v1/me");
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error).toEqual({
      code: "AUTH_REQUIRED",
      message: "Sign in to continue.",
      hint: "Your session may have expired.",
      retryable: false,
      requestId: expect.stringMatching(/^req_[0-9a-f]{32}$/),
    });
  });
});

describe("404 default", () => {
  it("returns the NOT_FOUND envelope for unknown routes", async () => {
    const response = await app.request("/v1/definitely-not-a-route");
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toBe("Not found.");
    expect(body.error.retryable).toBe(false);
    expect(typeof body.error.requestId).toBe("string");
  });
});

describe("zod validation at the boundary (§7.2)", () => {
  it("rejects an invalid POST /v1/projects body with VALIDATION_FAILED and never calls the repo", async () => {
    const { org } = auth.signUp("owner");
    const response = await app.request("/v1/projects", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `w3gw=fake-session-token-1`,
        "x-workspace-id": org.id,
        "idempotency-key": unique("idem"),
      },
      body: JSON.stringify({ name: "" }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.retryable).toBe(false);
    expect(calls["projects.create"]).toBeUndefined();
  });
});

describe("rate limiting (§7.1: per ip × route-class token buckets)", () => {
  it("returns 429 RATE_LIMITED with Retry-After once the auth bucket drains (10/min)", async () => {
    let sawLimited = false;
    let limitedResponse: Response | null = null;
    for (let i = 0; i < 11; i += 1) {
      const response = await app.request("/v1/auth/sign-up/email", { method: "POST" });
      if (response.status === 429) {
        sawLimited = true;
        limitedResponse = response;
        break;
      }
      expect(response.status).toBe(200);
    }
    expect(sawLimited).toBe(true);
    const body = (await limitedResponse!.json()) as { error: Record<string, unknown> };
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.error.retryable).toBe(true);
    const retryAfter = Number.parseInt(limitedResponse!.headers.get("retry-after") ?? "", 10);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
  });

  it("buckets are isolated per route-class: reads stay allowed while auth is drained", async () => {
    for (let i = 0; i < 10; i += 1) {
      await app.request("/v1/auth/sign-up/email", { method: "POST" });
    }
    const limited = await app.request("/v1/auth/sign-up/email", { method: "POST" });
    expect(limited.status).toBe(429);
    const read = await app.request("/health");
    expect(read.status).toBe(200);
  });
});

describe("idempotency for POST /v1 mutations (§7.2)", () => {
  const signUpCookie = (): { cookie: string; workspaceId: string } => {
    const { org } = auth.signUp("owner");
    return { cookie: `w3gw=fake-session-token-1`, workspaceId: org.id };
  };

  it("requires an Idempotency-Key (8-128 chars) before touching auth or handlers", async () => {
    const session = signUpCookie();
    const response = await app.request("/v1/projects", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: session.cookie,
        "x-workspace-id": session.workspaceId,
      },
      body: JSON.stringify({ name: "Keyless" }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(String(body.error.message)).toContain("Idempotency-Key");
    expect(calls["projects.create"]).toBeUndefined();
  });

  it("replays the stored result for the same key + payload without re-calling the repo", async () => {
    const session = signUpCookie();
    const key = unique("idem");
    const request = () =>
      app.request("/v1/projects", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: session.cookie,
          "x-workspace-id": session.workspaceId,
          "idempotency-key": key,
        },
        body: JSON.stringify({ name: `Replayable ${key}` }),
      });
    const first = await request();
    expect(first.status).toBe(201);
    expect(first.headers.get("x-idempotent-replay")).toBeNull();
    const firstBody = await first.json();

    const second = await request();
    expect(second.status).toBe(201);
    expect(second.headers.get("x-idempotent-replay")).toBe("true");
    expect(await second.json()).toEqual(firstBody);
    expect(calls["projects.create"]).toBe(1);
  });

  it("rejects a key reused with a different payload (VALIDATION_FAILED)", async () => {
    const session = signUpCookie();
    const key = unique("idem");
    const post = (name: string) =>
      app.request("/v1/projects", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: session.cookie,
          "x-workspace-id": session.workspaceId,
          "idempotency-key": key,
        },
        body: JSON.stringify({ name }),
      });
    const first = await post("Same key");
    expect(first.status).toBe(201);
    const second = await post("Same key but different payload");
    expect(second.status).toBe(400);
    const body = (await second.json()) as { error: Record<string, unknown> };
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(String(body.error.message)).toContain("different payload");
    expect(calls["projects.create"]).toBe(1);
  });

  it("the stored replay result still carries x-request-id and the original status", async () => {
    const session = signUpCookie();
    const key = unique("idem");
    const post = () =>
      app.request("/v1/projects", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: session.cookie,
          "x-workspace-id": session.workspaceId,
          "idempotency-key": key,
        },
        body: JSON.stringify({ name: "Replay status" }),
      });
    await post();
    const replay = await post();
    expect(replay.status).toBe(201);
    expect(replay.headers.get("x-request-id")).toMatch(/^req_/);
  });
});

describe("Ok envelope shape (§7.3)", () => {
  it("wraps payloads as { data: … } on success", async () => {
    const { org } = auth.signUp("owner");
    const response = await app.request("/v1/projects", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `w3gw=fake-session-token-1`,
        "x-workspace-id": org.id,
        "idempotency-key": unique("idem"),
      },
      body: JSON.stringify({ name: "Enveloped" }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({ name: "Enveloped", workspaceId: org.id });
    expect("error" in body).toBe(false);
  });
});
