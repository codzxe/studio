// W4-B middleware tests — auth-context + request-context via buildApp
// (AGENTS.md: Vitest, deterministic, <5 s units, table-driven, no network).
// All providers are fakes: no Better Auth, no DB, no engine.
//
// `src/types.ts` (W1-H) does not declare the `auth`/`reqCtx` variables yet —
// `TestEnv` below is the interim contract, and the one `as unknown as` cast in
// makeApp is test-side only until the contract wave extends `AppEnv`.

import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import pino from "pino";
import type { Logger } from "pino";
import { buildApp } from "../src/app.js";
import { gatewayTransportSchema } from "../src/env.js";
import {
  createDefaultAuthProvider,
  extractBearerToken,
  requireAuth,
  requireRole,
  type AuthProvider,
  type Role,
  type SessionContext
} from "../src/middleware/auth-context.js";
import {
  redactPromptish,
  requestContext,
  type PromptLoggingMode,
  type RequestContext
} from "../src/middleware/request-context.js";
import { stubProbes } from "../src/routes/health.js";
import type { AppEnv } from "../src/types.js";

/** Interim full env — what `src/types.ts` should declare after the contract wave. */
type TestEnv = AppEnv & {
  Variables: {
    auth: SessionContext;
    reqCtx: RequestContext;
  };
};

const silentLogger: Logger = pino({ enabled: false });

function fakeSession(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    userId: "user-1",
    organizationId: "org-1",
    role: "editor",
    permissions: ["documents:read", "documents:write", "runs:create"],
    ...overrides
  };
}

/** FakeAuthProvider — resolves from a static map and records the call order. */
class FakeAuthProvider implements AuthProvider {
  readonly calls: string[] = [];
  readonly #apiKeySession: SessionContext | null;
  readonly #cookieSession: SessionContext | null;

  constructor(config: {
    apiKeySession?: SessionContext | null;
    cookieSession?: SessionContext | null;
  }) {
    this.#apiKeySession = config.apiKeySession ?? null;
    this.#cookieSession = config.cookieSession ?? null;
  }

  async getSession(): Promise<SessionContext | null> {
    this.calls.push("getSession");
    return this.#cookieSession;
  }

  async verifyApiKey(): Promise<SessionContext | null> {
    this.calls.push("verifyApiKey");
    return this.#apiKeySession;
  }
}

/** pino logger that captures serialized lines for assertions. */
function makeCapturedLogger(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const logger = pino(
    { level: "info" },
    {
      write(chunk: string): void {
        lines.push(JSON.parse(chunk) as Record<string, unknown>);
      }
    }
  );
  return { logger, lines };
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function makeApp(deps: {
  provider: AuthProvider;
  logger?: Logger;
  promptLogPolicy?: (session: SessionContext | undefined) => PromptLoggingMode;
}): Hono<AppEnv> {
  return buildApp({
    env: gatewayTransportSchema.parse({}),
    logger: deps.logger ?? silentLogger,
    version: "0.0.0-test",
    probes: stubProbes(),
    startedAt: Date.now(),
    mount: (a) => {
      const app = a as unknown as Hono<TestEnv>;
      app.use(requireAuth<TestEnv>(deps.provider));
      app.use(requestContext<TestEnv>({ promptLogPolicy: deps.promptLogPolicy }));
      app.get("/v1/_test/me", (c) => {
        c.get("logger").info({ marker: "route_log" }, "route_log");
        return c.json({
          user_id: c.get("auth").userId,
          organization_id: c.get("auth").organizationId,
          role: c.get("auth").role,
          request_id: c.get("reqCtx").request_id,
          prompt_logging: c.get("reqCtx").prompt_logging
        });
      });
      app.post(
        "/v1/_test/editor-op",
        requireRole<TestEnv>("editor", "admin", "owner"),
        (c) => c.json({ ok: true })
      );
      app.post("/v1/_test/owner-op", requireRole<TestEnv>("owner"), (c) => c.json({ ok: true }));
    }
  });
}

describe("requireAuth (§15.1/§15.2, W4-B)", () => {
  it("accepts a valid cookie session and exposes it to routes", async () => {
    const provider = new FakeAuthProvider({ cookieSession: fakeSession() });
    const res = await makeApp({ provider }).request("/v1/_test/me", {
      headers: { cookie: "sid=ok" }
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      user_id: "user-1",
      organization_id: "org-1",
      role: "editor"
    });
  });

  it("authenticates via 'Authorization: Bearer sk-…' without touching the session path", async () => {
    const provider = new FakeAuthProvider({ apiKeySession: fakeSession({ role: "admin" }) });
    const res = await makeApp({ provider }).request("/v1/_test/me", {
      headers: { authorization: "Bearer sk-test-123" }
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ role: "admin" });
    expect(provider.calls).toEqual(["verifyApiKey"]);
  });

  it("resolves the bearer API key first when both mechanisms are present", async () => {
    const provider = new FakeAuthProvider({
      apiKeySession: fakeSession({ userId: "user-key" }),
      cookieSession: fakeSession({ userId: "user-cookie" })
    });
    const res = await makeApp({ provider }).request("/v1/_test/me", {
      headers: { authorization: "Bearer sk-test-123", cookie: "sid=ok" }
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ user_id: "user-key" });
    expect(provider.calls).toEqual(["verifyApiKey"]);
  });

  it("tries the API-key path, then the session path, before answering the 401", async () => {
    const provider = new FakeAuthProvider({});
    const res = await makeApp({ provider }).request("/v1/_test/me", {
      headers: { authorization: "Bearer sk-bad", cookie: "sid=bad" }
    });
    expect(res.status).toBe(401);
    expect(provider.calls).toEqual(["verifyApiKey", "getSession"]);
  });

  it("skips the API-key path when the provider has no verifyApiKey", async () => {
    const provider: AuthProvider = {
      getSession: async () => fakeSession()
    };
    const res = await makeApp({ provider }).request("/v1/_test/me", {
      headers: { authorization: "Bearer sk-test-123" }
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ user_id: "user-1" });
  });

  it("returns the identical 401 envelope no matter which mechanism failed", async () => {
    const provider = new FakeAuthProvider({});
    const app = makeApp({ provider });
    const viaKey = await app.request("/v1/_test/me", {
      headers: { authorization: "Bearer sk-invalid" }
    });
    const viaCookie = await app.request("/v1/_test/me", { headers: { cookie: "sid=bad" } });
    expect(viaKey.status).toBe(401);
    expect(viaCookie.status).toBe(401);
    const bodyKey = await json(viaKey);
    const bodyCookie = await json(viaCookie);
    expect(bodyCookie).toEqual(bodyKey);
    expect(bodyKey).toMatchObject({
      ok: false,
      code: "unauthenticated",
      message: "Authentication required.",
      retryable: false
    });
    // No auth material or identities in the error body (§13.3, §15.2).
    const serialized = JSON.stringify(bodyKey);
    expect(serialized).not.toContain("sk-invalid");
    expect(serialized).not.toContain("sid=bad");
    expect(serialized).not.toContain("user-1");
    expect(serialized).not.toContain("org-1");
  });
});

describe("requireRole (§15.2 RBAC gate)", () => {
  const ROLE_MATRIX: ReadonlyArray<{
    readonly role: Role;
    readonly op: "editor-op" | "owner-op";
    readonly want: 200 | 403;
  }> = [
    { role: "viewer", op: "editor-op", want: 403 },
    { role: "editor", op: "editor-op", want: 200 },
    { role: "admin", op: "editor-op", want: 200 },
    { role: "owner", op: "editor-op", want: 200 },
    { role: "viewer", op: "owner-op", want: 403 },
    { role: "editor", op: "owner-op", want: 403 },
    { role: "admin", op: "owner-op", want: 403 },
    { role: "owner", op: "owner-op", want: 200 }
  ];

  for (const { role, op, want } of ROLE_MATRIX) {
    it(`role gate matrix: ${role} on ${op} → ${want}`, async () => {
      const provider = new FakeAuthProvider({ cookieSession: fakeSession({ role }) });
      const res = await makeApp({ provider }).request(`/v1/_test/${op}`, {
        method: "POST",
        headers: { cookie: "sid=ok" }
      });
      expect(res.status).toBe(want);
      const body = await json(res);
      if (want === 403) {
        expect(body.code).toBe("forbidden");
        expect(String(body.hint)).toContain(op === "owner-op" ? "owner" : "editor");
        expect(JSON.stringify(body)).not.toContain("user-1");
        expect(JSON.stringify(body)).not.toContain("org-1");
      } else {
        expect(body.ok).toBe(true);
      }
    });
  }

  it("answers 401 (not 403) when no session was resolved", async () => {
    const provider = new FakeAuthProvider({});
    const res = await makeApp({ provider }).request("/v1/_test/editor-op", {
      method: "POST",
      headers: { cookie: "sid=bad" }
    });
    expect(res.status).toBe(401);
    expect((await json(res)).code).toBe("unauthenticated");
  });

  it("answers 401 when the role gate is wired without requireAuth (mis-wiring)", async () => {
    const app = buildApp({
      env: gatewayTransportSchema.parse({}),
      logger: silentLogger,
      version: "0.0.0-test",
      probes: stubProbes(),
      startedAt: Date.now(),
      mount: (a) => {
        const app = a as unknown as Hono<TestEnv>;
        app.post("/v1/_test/editor-op", requireRole<TestEnv>("editor"), (c) => c.json({ ok: true }));
      }
    });
    const res = await app.request("/v1/_test/editor-op", { method: "POST" });
    expect(res.status).toBe(401);
    expect((await json(res)).code).toBe("unauthenticated");
  });
});

describe("requestContext correlation (§22)", () => {
  it("propagates request_id, organization_id and user_id to the request logger child", async () => {
    const { logger, lines } = makeCapturedLogger();
    const provider = new FakeAuthProvider({ cookieSession: fakeSession() });
    const res = await makeApp({ provider, logger }).request("/v1/_test/me", {
      headers: { "x-request-id": "corr-fixed-1", cookie: "sid=ok" }
    });
    expect(res.status).toBe(200);
    const correlated = lines.find((line) => String(line.msg) === "route_log");
    expect(correlated).toMatchObject({
      request_id: "corr-fixed-1",
      organization_id: "org-1",
      user_id: "user-1"
    });
  });

  it("omits organization_id/user_id from the child when the request is anonymous", async () => {
    const { logger, lines } = makeCapturedLogger();
    const app = buildApp({
      env: gatewayTransportSchema.parse({}),
      logger,
      version: "0.0.0-test",
      probes: stubProbes(),
      startedAt: Date.now(),
      mount: (a) => {
        const app = a as unknown as Hono<TestEnv>;
        app.use(requestContext<TestEnv>());
        app.get("/v1/_test/anon", (c) => {
          c.get("logger").info({ marker: "anon_log" }, "anon_log");
          return c.json({ request_id: c.get("reqCtx").request_id });
        });
      }
    });
    const res = await app.request("/v1/_test/anon");
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ request_id: expect.any(String) });
    const anonymous = lines.find((line) => String(line.msg) === "anon_log");
    expect(anonymous).toBeDefined();
    expect(anonymous).not.toHaveProperty("organization_id");
    expect(anonymous).not.toHaveProperty("user_id");
  });

  it("exposes the correlation ids via reqCtx and defaults prompt logging to redacted", async () => {
    const provider = new FakeAuthProvider({ cookieSession: fakeSession() });
    const res = await makeApp({ provider }).request("/v1/_test/me", {
      headers: { "x-request-id": "corr-fixed-2", cookie: "sid=ok" }
    });
    expect(await json(res)).toMatchObject({
      request_id: "corr-fixed-2",
      prompt_logging: "redacted"
    });
  });

  it("resolves prompt logging per the injected policy (§15.3 placeholder seam)", async () => {
    const provider = new FakeAuthProvider({ cookieSession: fakeSession() });
    const res = await makeApp({ provider, promptLogPolicy: () => "raw" }).request("/v1/_test/me", {
      headers: { cookie: "sid=ok" }
    });
    expect(await json(res)).toMatchObject({ prompt_logging: "raw" });
  });
});

describe("redactPromptish (§22 redaction policy)", () => {
  it("redacts prompt-ish fields at any depth, keeping safe fields and never mutating input", () => {
    const body = {
      prompt: "make a poster",
      meta: { instructions: "use brand fonts", keep: 7 },
      attachments: [{ name: "a.png" }],
      note: "safe"
    };
    const out = redactPromptish(body, "redacted");
    expect(out).toEqual({
      prompt: "[redacted]",
      meta: { instructions: "[redacted]", keep: 7 },
      attachments: "[redacted]",
      note: "safe"
    });
    expect(body.prompt).toBe("make a poster");
  });

  it("redacts case-insensitively and inside arrays", () => {
    const out = redactPromptish([{ Prompt: "x", other: 1 }, { text: "y" }], "redacted");
    expect(out).toEqual([{ Prompt: "[redacted]", other: 1 }, { text: "[redacted]" }]);
  });

  it("passes the value through untouched when the workspace opted in (raw)", () => {
    const body = { prompt: "secret sauce" };
    expect(redactPromptish(body, "raw")).toBe(body);
  });

  it("is cycle-safe and passes exotic instances through", () => {
    const cyclic: Record<string, unknown> = { prompt: "x" };
    cyclic.self = cyclic;
    const date = new Date(0);
    const out = redactPromptish({ cyclic, date, safe: 1 }, "redacted") as Record<string, unknown>;
    expect(JSON.stringify(out)).toContain("[truncated]");
    expect(out.date).toBe(date);
  });
});

describe("extractBearerToken", () => {
  const bearerRequest = (header: string): Request =>
    new Request("https://api.invalid/v1", { headers: { authorization: header } });

  it("extracts the token from a well-formed Bearer header (case-insensitive scheme)", () => {
    expect(extractBearerToken(bearerRequest("Bearer sk-abc"))).toBe("sk-abc");
    expect(extractBearerToken(bearerRequest("bearer sk-abc"))).toBe("sk-abc");
  });

  it("rejects malformed Authorization headers", () => {
    for (const header of ["Bearer", "Bearer ", "Bearer  a b", "Basic xyz", ""]) {
      expect(extractBearerToken(bearerRequest(header))).toBeNull();
    }
  });

  it("returns null when the header is absent", () => {
    expect(extractBearerToken(new Request("https://api.invalid/v1"))).toBeNull();
  });
});

describe("createDefaultAuthProvider (wiring factory)", () => {
  it("composes W4-A resolvers into a working AuthProvider", async () => {
    const provider = createDefaultAuthProvider({
      getSession: async () => null,
      verifyApiKey: async () => fakeSession({ userId: "user-key" })
    });
    const res = await makeApp({ provider }).request("/v1/_test/me", {
      headers: { authorization: "Bearer sk-abc" }
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ user_id: "user-key" });
  });
});
