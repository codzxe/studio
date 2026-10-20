// Auth middleware — identity resolution + the server-side RBAC role gate (§15.2).
//
// W4-B owns this middleware; W4-A (`apps/gateway/src/auth/`) owns the Better
// Auth client and the hashed API-key store (§15.2, ADR-0003). `requireAuth`
// never touches them directly — it consumes an injected `AuthProvider`, and
// `createDefaultAuthProvider` is the factory the bootstrap/wiring wave uses to
// compose W4-A's resolvers into that provider.
//
// RECONCILIATION (W4-A): `SessionContext` below is a LOCAL structural mirror of
// the contract `{ userId, organizationId, role, permissions }` (W4-B task
// brief), present only because `auth/session.ts` had not landed when this file
// was written. Once it has, replace the mirror with
// `import type { SessionContext } from "../auth/session.js"` — structural
// typing keeps a shape-compatible provider working either way.
//
// Security posture:
// - §15.1: `organizationId` is the tenant anchor; every downstream tenant
//   check keys off it (cross-tenant is 404, never 403 — ADR-0003).
// - §13.3: 401 = unauthenticated, 403 = permission denied; typed envelopes
//   only, never a stack/internal id.
// - §15.2: the 401 never reveals WHICH mechanism failed (no key-validity
//   oracle); bearer API-key path runs first, then the cookie session path.

import type { MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../types.js";
import { AppError } from "./error-mapper.js";

/** Better Auth org roles (§15.2 RBAC; wire-stable per ADR-0003). */
export const ROLES = ["owner", "admin", "editor", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/**
 * Scoped permission strings (§15.2): API-key scopes (`documents:read`,
 * `documents:write`, `runs:create`, `exports:create`) and the role→permission
 * mapping the gateway derives from roles (ADR-0003). A plain string alias on
 * purpose — W4-A/§15.2 waves own the definitive union, and a narrower union
 * still satisfies this shape structurally.
 */
export type Permission = string;

/**
 * Authenticated request identity (W4-A contract mirror — see file header).
 * `organizationId` is the workspace/tenant key (§12, §15.1).
 */
export interface SessionContext {
  readonly userId: string;
  readonly organizationId: string;
  readonly role: Role;
  readonly permissions: readonly Permission[];
}

/**
 * Resolves the caller's identity from an HTTP request. W4-A provides the real
 * implementation (Better Auth session lookup + hashed API-key verification);
 * tests provide fakes.
 */
export interface AuthProvider {
  /** Cookie-session resolution (httpOnly Better Auth cookie, §15.2). */
  getSession(request: Request): Promise<SessionContext | null>;
  /** Bearer API-key resolution (`Authorization: Bearer sk-…`, §15.2). Optional. */
  verifyApiKey?(request: Request): Promise<SessionContext | null>;
}

/** Hono env with the `auth` variable that `requireAuth` sets. */
export type AuthAppEnv = AppEnv & {
  Variables: {
    auth: SessionContext;
  };
};

/**
 * Extract the bearer token from `Authorization: Bearer <token>`. Strict: the
 * header must be exactly two space-separated parts with a `Bearer` scheme
 * (case-insensitive, RFC 9110 §11.6.1). Anything else returns null and the
 * caller falls through to the cookie path.
 */
export function extractBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) {
    return null;
  }
  const parts = header.split(" ");
  if (parts.length !== 2 || !/^bearer$/i.test(parts[0] ?? "")) {
    return null;
  }
  const token = parts[1] ?? "";
  return token.length > 0 ? token : null;
}

/**
 * The one and only 401 this middleware can produce — identical for every
 * failure path so the response never hints which mechanism failed (§15.2).
 */
function throwUnauthenticated(): never {
  throw new AppError(401, "unauthenticated", "Authentication required.", {
    hint: "Sign in for a session cookie, or send 'Authorization: Bearer <api key>'.",
    retryable: false
  });
}

/**
 * requireAuth — resolve the caller via the injected provider, or answer with
 * the generic typed 401 (§13.3 auth). Resolution order per the W4-B contract:
 * bearer API key first, then cookie session. A provider error (DB down, etc.)
 * propagates and maps to a 500 — never a 401 (fail loud, not silently closed).
 *
 * The null checks are falsy checks on purpose: a misbehaving provider that
 * resolves `undefined` is treated exactly like "no session" (fail closed).
 */
export function requireAuth<E extends AuthAppEnv>(provider: AuthProvider): MiddlewareHandler<E> {
  return createMiddleware<E>(async (c, next) => {
    const request = c.req.raw;
    let session: SessionContext | null = null;
    if (extractBearerToken(request) !== null && provider.verifyApiKey) {
      session = await provider.verifyApiKey(request);
    }
    if (!session) {
      session = await provider.getSession(request);
    }
    if (!session) {
      // Best-effort RFC 9110 §11.6.1 challenge header; the envelope is the
      // real contract (§13.3). Same body regardless of which path failed.
      c.header("WWW-Authenticate", 'Bearer realm="api"');
      throwUnauthenticated();
    }
    c.set("auth", session);
    await next();
  });
}

/**
 * requireRole(...roles) — server-side RBAC gate (§15.2: "UI hiding is not
 * enforcement"). Reads `auth.role` (set by `requireAuth`); a caller outside
 * the allowlist gets a typed 403 whose hint names the required roles. Mount it
 * AFTER `requireAuth` — a missing session surfaces as the same 401.
 */
export function requireRole<E extends AuthAppEnv>(...roles: Role[]): MiddlewareHandler<E> {
  if (roles.length === 0) {
    // Wiring bug: an empty allowlist would deny everything. Fail fast at
    // setup time instead of silently locking every route.
    throw new AppError(500, "internal_error", "Role gate configured without any allowed role.");
  }
  return createMiddleware<E>(async (c, next) => {
    const session = c.get("auth");
    if (!session) {
      // requireAuth did not run for this route; treat as unauthenticated.
      throwUnauthenticated();
    }
    if (!roles.includes(session.role)) {
      throw new AppError(403, "forbidden", "You do not have the required role for this action.", {
        hint: `Requires role: ${roles.join(" or ")} (§15.2).`
      });
    }
    await next();
  });
}

/** Resolver pair the default provider composes (W4-A: better-auth + api-key store). */
export interface AuthResolverDeps {
  getSession(request: Request): Promise<SessionContext | null>;
  verifyApiKey(request: Request): Promise<SessionContext | null>;
}

/**
 * Default AuthProvider factory for bootstrap wiring: compose W4-A's resolvers
 * (Better Auth session lookup + hashed/scoped API-key verification, §15.2)
 * into the provider `requireAuth` consumes. A factory so the wiring wave is a
 * one-liner and tests stay provider-free.
 */
export function createDefaultAuthProvider(deps: AuthResolverDeps): AuthProvider {
  return {
    getSession: (request) => deps.getSession(request),
    verifyApiKey: (request) => deps.verifyApiKey(request)
  };
}
