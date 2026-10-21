// SessionContext + cookie-session resolution for the gateway (W4-A; §15.2).
//
// `SessionContext` is the four-field contract the landed middleware expects
// (src/middleware/auth-context.ts — its header asks this module to replace the
// local mirror via `import type { SessionContext } from "../auth/session.js"`),
// and what src/authz/guard.js consumes as GuardContext:
//   { userId, organizationId, role, permissions }
// `organizationId` is the §15.1 tenant anchor and is non-null BY CONSTRUCTION:
// a caller without an active workspace is not a gateway caller (the web app
// routes them to onboarding). Fail-closed: any doubt resolves to `null` → the
// middleware answers the one generic 401 (no oracle about which check failed).
//
// Session validation mirrors the reference starter's server-side pattern
// (vendor/next-saas-stripe-starter lib/auth/session.ts):
//   auth.api.getSession({ headers })          → httpOnly cookie session
//   auth.api.getActiveMember({ headers })     → member row of the active org
// translated to Hono: callers pass `c.req.raw` (a standard Request), so the
// same code serves both `app.request()` tests and live traffic.

import type { Permission, Role } from "../authz/roles.js";
import { isRole, PERMISSIONS } from "../authz/roles.js";
import { isAPIError } from "better-auth/api";
import { getAuthServer, type AuthServer } from "./server.js";

/**
 * Authenticated caller identity (§15.2 contract; ADR-0003 role names).
 * Frozen everywhere — never mutated downstream.
 */
export interface SessionContext {
  /** Authenticated user id (Better Auth `user.id`). */
  readonly userId: string;
  /** Active workspace id — THE tenant key (§15.1; non-null by construction). */
  readonly organizationId: string;
  /** Workspace role of this member (owner|admin|editor|viewer, §15.2 ladder). */
  readonly role: Role;
  /**
   * Effective grants for this session: `PERMISSIONS[role]` (authz/roles.js,
   * ADR-0003). API-key sessions carry the key-scope intersection instead —
   * never wider than the creating member (see ./api-keys.js).
   */
  readonly permissions: readonly Permission[];
}

/**
 * Pure builder for member sessions. Middleware and tests use it directly;
 * permissions are always derived, never passed in (§15.2: one source of
 * truth in authz/roles.js).
 */
export function buildSessionContext(input: {
  readonly userId: string;
  readonly organizationId: string;
  readonly role: Role;
}): SessionContext {
  return Object.freeze({
    userId: input.userId,
    organizationId: input.organizationId,
    role: input.role,
    permissions: PERMISSIONS[input.role]
  });
}

/**
 * Resolve the caller from the httpOnly session cookie carried by `request`.
 * Mirrors the vendor starter (getSession + getActiveMember) and narrows to the
 * §15.2 ladder:
 *
 *   - no session                     → null (middleware answers the typed 401)
 *   - no active organization         → null (tenant anchor required, §15.1)
 *   - no/unknown membership or role  → null (fail closed, §15.2)
 *
 * `getActiveMember` signals a missing active-org/membership with a 400
 * APIError; that is the expected "no workspace scope" outcome → null. Anything
 * else (DB down, 5xx) propagates so the error mapper answers 500 — a provider
 * outage must never masquerade as an unauthenticated request (W4-B contract).
 *
 * Live-auth behavior (real cookies → Postgres) is covered by CI, not unit
 * tests; this file's unit surface is `buildSessionContext` + the narrowing.
 */
export async function getSessionUser(
  request: Request,
  auth: AuthServer = getAuthServer()
): Promise<SessionContext | null> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return null;
  }

  const organizationId = session.session.activeOrganizationId ?? null;
  if (!organizationId) {
    return null; // signed in but no active workspace — not a gateway caller yet
  }

  let member: { userId: string; organizationId: string; role: string } | null = null;
  try {
    member = await auth.api.getActiveMember({ headers: request.headers });
  } catch (error) {
    if (isAPIError(error) && error.status === 400) {
      return null; // no active organization / no membership — fail closed
    }
    throw error; // infrastructure failure — do NOT turn an outage into a 401
  }

  const role = member?.role ?? null;
  if (!member || !isRole(role)) {
    return null; // unknown role strings grant nothing (§15.2 fail closed)
  }
  return buildSessionContext({ userId: session.user.id, organizationId, role });
}
