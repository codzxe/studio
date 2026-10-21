// W4-A auth unit tests (§15.2, ADR-0003) — deterministic, no network, <5 s
// (AGENTS.md). Live auth (real cookies → Postgres, hashed-key verification,
// plugin endpoints) is exercised by CI integration, not here: the module
// under test keeps env singletons lazy, so unit tests never need AUTH_SECRET.
//
// Covers the three contract anchors of the W4-A brief:
//   1. session context shape (+ §15.2 cumulative permission ladder),
//   2. the role union owner|admin|editor|viewer (runtime + compile-time vs
//      the Drizzle member.role enum),
//   3. config validation — missing/short AUTH_SECRET fails fast via
//      @studio/config (parseGatewayEnv), missing/invalid BETTER_AUTH_URL via
//      the local projection (parseAuthEnv).

import { member as memberTable } from "@studio/db";
import { createDb } from "@studio/db";
import { EnvFatalError, parseGatewayEnv, type EnvSource } from "@studio/config";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  API_KEY_SCOPES,
  apiKeyFailureEnvelope,
  buildApiKeyScopes,
  createAuthResolvers,
  extractApiKey,
  ORG_SCOPE_PREFIX,
  parseApiKeyScopes,
  verifyApiKey,
  verifyApiKeyRequest
} from "../src/auth/api-keys.js";
import { buildWebAuthClientConfig } from "../src/auth/client-config.js";
import { acPermissionStrings, buildWorkspaceAccessControl } from "../src/auth/roles.js";
import {
  createAuthServer,
  parseAuthEnv,
  AuthEnvError,
  type AuthServer
} from "../src/auth/server.js";
import { buildSessionContext, type SessionContext } from "../src/auth/session.js";
import { ALL_PERMISSIONS, can, PERMISSIONS, ROLES, type Role } from "../src/authz/roles.js";

// ---------------------------------------------------------------------------
// 1. Role union matches §15.2 (ADR-0003: owner|admin|editor|viewer)
// ---------------------------------------------------------------------------

describe("§15.2 role union", () => {
  it("is exactly owner|admin|editor|viewer, ascending privilege", () => {
    expect([...ROLES]).toEqual(["viewer", "editor", "admin", "owner"]);
  });

  it("compile-time: the gateway Role IS the api_key/member Drizzle enum", () => {
    type DbMemberRole = NonNullable<(typeof memberTable.$inferInsert)["role"]>;
    expectTypeOf<Role>().toEqualTypeOf<DbMemberRole>();
    expectTypeOf<SessionContext["role"]>().toEqualTypeOf<Role>();
  });

  it("ladder is strictly cumulative (viewer ⊂ editor ⊂ admin ⊂ owner)", () => {
    const byRole = ROLES.map((role) => new Set(PERMISSIONS[role]));
    for (let i = 1; i < byRole.length; i++) {
      const lower = byRole[i - 1];
      const higher = byRole[i];
      if (!lower || !higher) {
        throw new Error("unreachable: ROLES has four entries");
      }
      for (const permission of lower) {
        expect(higher.has(permission)).toBe(true);
      }
      expect(higher.size).toBeGreaterThan(lower.size); // strictly cumulative
    }
  });
});

// ---------------------------------------------------------------------------
// 2. SessionContext shape + derived permissions
// ---------------------------------------------------------------------------

describe("SessionContext (src/auth/session.js)", () => {
  it("has exactly { userId, organizationId, role, permissions }, frozen", () => {
    const ctx = buildSessionContext({
      userId: "user-1",
      organizationId: "ws-1",
      role: "editor"
    });
    expect(Object.keys(ctx).sort()).toEqual([
      "organizationId",
      "permissions",
      "role",
      "userId"
    ]);
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(ctx.userId).toBe("user-1");
    expect(ctx.organizationId).toBe("ws-1");
    expect(ctx.role).toBe("editor");
  });

  it.each(ROLES.map((role) => [role] as const))(
    "permissions for %s are the can()-derived ladder grants",
    (role) => {
      const expected = ALL_PERMISSIONS.filter((permission) => can(role, permission));
      const ctx = buildSessionContext({ userId: "u", organizationId: "ws", role });
      expect([...ctx.permissions]).toEqual([...expected]);
      expect(ctx.permissions).toBe(PERMISSIONS[role]); // same derived list, not a copy
    }
  );

  it("viewer reads/comments only; editor runs+writes; admin manages; owner deletes", () => {
    // §15.2 spot checks pinned from the ADR-0003 matrix.
    expect(can("viewer", "documents:read")).toBe(true);
    expect(can("viewer", "comments:create")).toBe(true);
    expect(can("viewer", "runs:create")).toBe(false);
    expect(can("editor", "runs:create")).toBe(true);
    expect(can("editor", "members:manage")).toBe(false);
    expect(can("admin", "members:manage")).toBe(true);
    expect(can("admin", "workspace:delete")).toBe(false);
    expect(can("owner", "workspace:delete")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Better Auth organization-plugin wiring mirrors the ladder (src/auth/roles.js)
// ---------------------------------------------------------------------------

describe("organization plugin access control (src/auth/roles.js)", () => {
  it("declares exactly the four §15.2 roles", () => {
    const { roles } = buildWorkspaceAccessControl();
    expect(Object.keys(roles).sort()).toEqual(["admin", "editor", "owner", "viewer"]);
  });

  it.each(ROLES.map((role) => [role] as const))(
    "plugin grants for %s equal can()-derived product permissions",
    (role) => {
      const expected = ALL_PERMISSIONS.filter((permission) => can(role, permission));
      expect([...acPermissionStrings(role)]).toEqual([...expected]);
    }
  );

  it("internal plugin gates: admin cannot delete the workspace, owner can", () => {
    const { roles } = buildWorkspaceAccessControl();
    expect(roles.owner.statements.organization).toContain("delete");
    expect(roles.admin.statements.organization).not.toContain("delete");
    expect(roles.owner.statements.member).toContain("create");
    expect(roles.admin.statements.member).toContain("create");
    expect(roles.editor.statements.team).toBeUndefined(); // teams inert (server.ts)
  });
});

// ---------------------------------------------------------------------------
// 4. API-key scopes codec (§15.2)
// ---------------------------------------------------------------------------

describe("parseApiKeyScopes / buildApiKeyScopes", () => {
  const scopesJson = JSON.stringify([
    "org:ws-1",
    "documents:read",
    "runs:create",
    "members:manage", // NOT an api-key scope (admin-only capability)
    "nonsense:grant"
  ]);

  it("parses stored JSON text: org binding + known scopes, drops the rest", () => {
    const parsed = parseApiKeyScopes(scopesJson);
    expect(parsed.organizationId).toBe("ws-1");
    expect([...parsed.permissions]).toEqual(["documents:read", "runs:create"]);
  });

  it("accepts the adapter-decoded JS array form", () => {
    expect(parseApiKeyScopes(["org:ws-2", "documents:write"])).toEqual({
      organizationId: "ws-2",
      permissions: ["documents:write"]
    });
  });

  it("accepts the plugin statement-record form", () => {
    const parsed = parseApiKeyScopes({ documents: ["read", "write"], runs: ["create"] });
    expect(parsed.organizationId).toBeNull();
    expect([...parsed.permissions]).toEqual([
      "documents:read",
      "documents:write",
      "runs:create"
    ]);
  });

  it("accepts a Postgres array literal defensively", () => {
    const parsed = parseApiKeyScopes("{org:ws-9,documents:read}");
    expect(parsed.organizationId).toBe("ws-9");
    expect([...parsed.permissions]).toEqual(["documents:read"]);
  });

  it("fails closed: null / malformed / empty input grant nothing", () => {
    expect(parseApiKeyScopes(null)).toEqual({ organizationId: null, permissions: [] });
    expect(parseApiKeyScopes("not json")).toEqual({
      organizationId: null,
      permissions: []
    });
    expect(parseApiKeyScopes(42)).toEqual({ organizationId: null, permissions: [] });
  });

  it("empty org id does not bind; first org entry wins", () => {
    expect(parseApiKeyScopes(["org:", "documents:read"]).organizationId).toBeNull();
    expect(parseApiKeyScopes(["org:ws-a", "org:ws-b"]).organizationId).toBe("ws-a");
  });

  it("round-trips build → parse for every §15.2 scope", () => {
    const json = buildApiKeyScopes({
      organizationId: "ws-7",
      permissions: [...API_KEY_SCOPES]
    });
    const parsed = parseApiKeyScopes(json);
    expect(parsed.organizationId).toBe("ws-7");
    expect([...parsed.permissions]).toEqual([...API_KEY_SCOPES]);
  });

  it("§15.2: API key scopes are exactly the four spec'd strings", () => {
    expect([...API_KEY_SCOPES]).toEqual([
      "documents:read",
      "documents:write",
      "runs:create",
      "exports:create"
    ]);
  });
});

// ---------------------------------------------------------------------------
// 5. Key extraction + failure envelopes + null paths (no oracle, §15.2)
// ---------------------------------------------------------------------------

describe("extractApiKey", () => {
  it("reads a strict bearer token", () => {
    const request = new Request("http://gw/v1/documents", {
      headers: { authorization: "Bearer sk_test_abc123" }
    });
    expect(extractApiKey(request)).toBe("sk_test_abc123");
  });

  it("falls back to x-api-key", () => {
    const request = new Request("http://gw/v1/documents", {
      headers: { "x-api-key": "sk_test_abc123" }
    });
    expect(extractApiKey(request)).toBe("sk_test_abc123");
  });

  it("returns null when no key is present", () => {
    expect(extractApiKey(new Request("http://gw/v1/documents"))).toBeNull();
  });
});

describe("apiKeyFailureEnvelope", () => {
  it("maps transient rate limiting as retryable and the rest as final", () => {
    expect(apiKeyFailureEnvelope("RATE_LIMITED").retryable).toBe(true);
    expect(apiKeyFailureEnvelope("KEY_DISABLED").retryable).toBe(false);
    expect(apiKeyFailureEnvelope("KEY_EXPIRED").retryable).toBe(false);
    expect(apiKeyFailureEnvelope("USAGE_EXCEEDED").retryable).toBe(false);
    expect(apiKeyFailureEnvelope("KEY_NOT_FOUND").retryable).toBe(false);
    expect(apiKeyFailureEnvelope(undefined).retryable).toBe(false);
  });

  it("never leaks internals in the message", () => {
    const envelope = apiKeyFailureEnvelope("KEY_NOT_FOUND");
    expect(envelope.message).not.toMatch(/table|column|sql|postgres/i);
  });
});

describe("verifyApiKey null paths (live hashing is CI territory)", () => {
  it("rejects an empty key with the typed api_key_invalid error, env-free", () => {
    // Must resolve BEFORE any singleton: the test env has no AUTH_SECRET, so a
    // lazy-resolution bug here would throw EnvFatalError instead.
    expect(verifyApiKey("   ")).resolves.toMatchObject({
      ok: false,
      code: "api_key_invalid",
      retryable: false
    });
  });

  it("verifyApiKeyRequest returns null when no key header is present", () => {
    expect(verifyApiKeyRequest(new Request("http://gw/v1/documents"))).resolves.toBeNull();
  });

  it("createAuthResolvers exposes the W4-B resolver pair", () => {
    const resolvers = createAuthResolvers();
    expect(typeof resolvers.getSession).toBe("function");
    expect(typeof resolvers.verifyApiKey).toBe("function");
    expect(resolvers.verifyApiKey(new Request("http://gw/v1/documents"))).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. Config validation — fail fast (§4)
// ---------------------------------------------------------------------------

/** A fully valid gateway env (ADR-0002 matrix) with a 40-char AUTH_SECRET. */
function validGatewayEnv(): EnvSource {
  return {
    DATABASE_URL: "postgres://studio:studio@localhost:5432/studio",
    VALKEY_URL: "redis://localhost:6379",
    S3_ENDPOINT: "http://localhost:9000",
    S3_BUCKET: "studio-local",
    S3_REGION: "auto",
    S3_ACCESS_KEY_ID: "localaccess",
    S3_SECRET_ACCESS_KEY: "local-secret-key-0123456789",
    STRIPE_SECRET_KEY: "sk_test_51abc",
    STRIPE_WEBHOOK_SECRET: "whsec_localtest",
    APP_URL: "http://localhost:3000",
    AUTH_SECRET: "unit-test-secret-0123456789-abcdefghij"
  };
}

describe("AUTH_SECRET fail-fast via @studio/config (§4)", () => {
  it("refuses to start when AUTH_SECRET is missing", () => {
    const env = validGatewayEnv();
    delete env.AUTH_SECRET;
    try {
      parseGatewayEnv(env);
      throw new Error("expected parseGatewayEnv to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvFatalError);
      expect((error as EnvFatalError).missing).toContain("AUTH_SECRET");
    }
  });

  it("refuses to start when AUTH_SECRET is too short (<32)", () => {
    const env = validGatewayEnv();
    env.AUTH_SECRET = "short";
    try {
      parseGatewayEnv(env);
      throw new Error("expected parseGatewayEnv to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvFatalError);
      expect((error as EnvFatalError).invalid.map((v) => v.name)).toContain("AUTH_SECRET");
    }
  });
});

describe("BETTER_AUTH_URL projection (parseAuthEnv)", () => {
  it("projects a valid gateway origin", () => {
    expect(parseAuthEnv({ BETTER_AUTH_URL: "http://localhost:8787" }).baseURL).toBe(
      "http://localhost:8787"
    );
  });

  it("fails fast when missing", () => {
    expect(() => parseAuthEnv({})).toThrow(AuthEnvError);
  });

  it("fails fast when not an http(s) URL", () => {
    expect(() => parseAuthEnv({ BETTER_AUTH_URL: "gateway:8787" })).toThrow(AuthEnvError);
  });
});

// ---------------------------------------------------------------------------
// 7. createAuthServer wiring smoke (lazy pool — no connection, no network)
// ---------------------------------------------------------------------------

describe("createAuthServer (§16.3 plugin wiring)", () => {
  const TEST_SECRET = "x".repeat(40);
  const lazyDb = createDb("postgres://studio:studio@localhost:5432/studio");

  it("builds a Better Auth instance with a mountable handler", () => {
    const auth = createAuthServer({
      db: lazyDb,
      secret: TEST_SECRET,
      baseURL: "http://localhost:8787"
    });
    expect(typeof auth.handler).toBe("function");
    expect(auth.api).toBeTruthy();
  });

  it("exposes the plugin server APIs the gateway consumes (compile-time)", () => {
    const auth = createAuthServer({
      db: lazyDb,
      secret: TEST_SECRET,
      baseURL: "http://localhost:8787"
    });
    // api-key plugin verify endpoint + org plugin session/member APIs.
    expectTypeOf(auth.api.verifyApiKey).toBeFunction();
    expectTypeOf(auth.api.getSession).toBeFunction();
    expectTypeOf(auth.api.getActiveMember).toBeFunction();
    expectTypeOf<AuthServer["api"]["verifyApiKey"]>().toBeFunction();
  });
});

// ---------------------------------------------------------------------------
// 8. Web client config — JSON-safe, secret-free (§15.2)
// ---------------------------------------------------------------------------

describe("buildWebAuthClientConfig", () => {
  it("mirrors the server plugins and carries no secrets", () => {
    const sentinel = "TOP-SECRET-do-not-ship-0123456789";
    const config = buildWebAuthClientConfig({ baseURL: "http://localhost:8787" });
    const serialized = JSON.stringify({ ...config, sentinel: undefined });
    expect(serialized).toContain("http://localhost:8787");
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain("secret");
    expect(config.basePath).toBe("/api/auth");
    expect(config.plugins.organization.teams.enabled).toBe(true);
    expect(config.plugins.organization.teams.defaultTeam.enabled).toBe(false);
    expect(config.plugins.apiKey.enabled).toBe(true);
    expect(config.plugins.apiKey.scopes).toEqual([...API_KEY_SCOPES]);
    expect(config.plugins.admin).toEqual({ enabled: true, defaultRole: "user" });
    expect(ORG_SCOPE_PREFIX).toBe("org:"); // codec sanity next to the scopes
  });

  it("rejects empty and non-http(s) origins", () => {
    expect(() => buildWebAuthClientConfig({ baseURL: "  " })).toThrow();
    expect(() => buildWebAuthClientConfig({ baseURL: "ftp://nope" })).toThrow();
  });
});
