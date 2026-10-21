// The RBAC + tenant assertion seam EVERY gateway route uses (§15.1/§15.2).
//
// Two tenant seams, one isolation rule (§15.1 is the non-negotiable core):
//   1. LOOKUPS stay 404: composite-key scoping in @studio/db means a foreign
//      resource simply is not resolved, so list/get endpoints answer 404
//      (ADR-0003 "Cross-tenant lookups return 404, not 403"; W1-J precedent).
//   2. ASSERTIONS (this file): once a resource IS in hand — fetched by
//      internal id, an engine session claim, a storage key — assertTenant()
//      refuses foreign organizations with the DISTINCT typed
//      `cross_tenant_denied` error and NEVER masks it into a generic
//      not_found: §20 #11's automated cross-tenant suite, the audit trail and
//      dashboards must be able to tell a probing attempt apart from a miss.
//      Wire status: 403 per @studio/config HTTP_STATUS_BY_ERROR_CODE (the
//      repo-canonical registry; its own tests pin the mapping).
//
// Envelopes never leak internals (§13.3 + AGENTS.md): organization/user ids
// go to the structured §22 logs only (request id + actor + caller workspace +
// attempted target); messages and hints name fields, never values.
//
// Per-request wiring (routes):
//   const guard = createResourceGuard({
//     logger: c.get("logger"),       // request-scoped child (requestId bound)
//     requestId: c.get("requestId")  // §22 correlation — required
//   });
//   guard.assertCan(session.role, "runs:create", session);
//   guard.assertTenant({ organizationId: doc.organizationId }, session);
//
// GuardContext is structurally satisfied by SessionContext
// (src/middleware/auth-context.ts / src/auth/session.ts:
// { userId, organizationId, role, permissions }): the auth middleware
// populates `role` (narrowed with isRole) and `permissions` with
// PERMISSIONS[role] for member sessions, or the API-key scope intersection
// for key sessions — never wider than the creating member (ADR-0003).

import { httpStatusFor } from "@studio/config";
import { AppError } from "../middleware/error-mapper.js";
import { can } from "./roles.js";
import type { Permission, Role } from "./roles.js";

/** The session contract the guard enforces (SessionContext, src/auth/session.ts). */
export interface GuardContext {
  readonly userId: string;
  readonly organizationId: string;
  readonly role: Role;
  /**
   * Effective grants for this session. Member sessions: PERMISSIONS[role]
   * (src/authz/roles.ts). API-key sessions: intersection with the key's
   * scopes (§15.2) — an empty or malformed list grants NOTHING (fail closed).
   *
   * Typed as `readonly string[]` (not the Permission union) on purpose so the
   * auth middleware's SessionContext composes without casts (W4-B's mirror
   * uses `Permission = string`); a grant still requires the ADR-bounded
   * matrix check AND membership here, so unknown strings can only narrow.
   */
  readonly permissions: readonly string[];
}

/** A resource owned by an organization — the tenant key every row carries (§15.1). */
export interface TenantScopedResource {
  readonly organizationId: string;
}

/**
 * Logger slice the guard needs. pino's Logger satisfies this structurally;
 * tests pass a capturing fake. Fields are snake_case per §22 log style.
 */
export interface GuardLogger {
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface ResourceGuardDeps {
  readonly logger: GuardLogger;
  /** §22 request id — cross-tenant denials are ALWAYS logged with it. */
  readonly requestId: string;
}

/** RBAC denial (§15.2): authenticated, but the role/effective grants do not allow it. */
export class ForbiddenError extends AppError {
  /** The permission that was required (public vocabulary — safe to surface). */
  readonly permission: Permission | undefined;

  constructor(message: string, options: { hint?: string; permission?: Permission } = {}) {
    super(httpStatusFor("forbidden"), "forbidden", message, { hint: options.hint });
    this.name = "ForbiddenError";
    this.permission = options.permission;
  }
}

/** Cross-tenant denial (§15.1, §20 #11): the resource belongs to another organization. */
export class CrossTenantDeniedError extends AppError {
  constructor(message: string, options: { hint?: string } = {}) {
    super(httpStatusFor("cross_tenant_denied"), "cross_tenant_denied", message, {
      hint: options.hint
    });
    this.name = "CrossTenantDeniedError";
  }
}

/** Runtime defense: only a real grants array counts — anything else grants nothing. */
function hasSessionPermission(ctx: GuardContext, permission: Permission): boolean {
  const granted: unknown = ctx.permissions;
  return Array.isArray(granted) && granted.includes(permission);
}

/** True when the resource is not provably in the caller's organization (fail closed). */
function isForeignTenant(resourceOrganizationId: string, callerOrganizationId: string): boolean {
  return (
    resourceOrganizationId === "" ||
    callerOrganizationId === "" ||
    resourceOrganizationId !== callerOrganizationId
  );
}

/** The assertion seam every route goes through (see the file header). */
export interface TypedResourceGuard {
  /**
   * Assert the session's role grants `permission`. `role` must be the
   * session's own role (ctx.role) — a mismatch is a handler bug and NEVER
   * grants (fail closed, logged as guard_role_mismatch). The session's
   * effective grants must also include the permission (API-key scope
   * narrowing, ADR-0003). Throws ForbiddenError with the needed permission
   * in the hint.
   */
  assertCan(role: Role, permission: Permission, ctx: GuardContext): void;
  /**
   * Assert `resource` belongs to the caller's organization — THE cross-tenant
   * seam (§15.1). Denials throw the typed CrossTenantDeniedError (never a
   * 404-masked not_found) and are logged with the request id (§22); empty ids
   * fail closed.
   */
  assertTenant(resource: TenantScopedResource, ctx: GuardContext): void;
  /** Convenience: assert a document's owning organization (§15.1). */
  assertDocAccess(documentOrgId: string, ctx: GuardContext): void;
}

export function createResourceGuard(deps: ResourceGuardDeps): TypedResourceGuard {
  const { logger, requestId } = deps;

  function denyTenant(
    resourceOrganizationId: string,
    ctx: GuardContext,
    resourceKind: "resource" | "document"
  ): never {
    const reason =
      resourceOrganizationId === "" || ctx.organizationId === ""
        ? "missing_tenant_scope"
        : "foreign_tenant";
    // §22: request_id → workspace correlation on every cross-tenant attempt.
    // The attempted target id is for OUR logs/audit only — never the envelope.
    logger.warn(
      {
        request_id: requestId,
        user_id: ctx.userId,
        workspace_id: ctx.organizationId,
        resource_organization_id: resourceOrganizationId,
        resource_kind: resourceKind,
        reason
      },
      "cross_tenant_denied"
    );
    throw new CrossTenantDeniedError("You do not have access to this resource.", {
      hint: "This resource belongs to a different workspace."
    });
  }

  const guard: TypedResourceGuard = {
    assertCan(role, permission, ctx) {
      // (1) The route must enforce the session's own role; a mismatch is a
      //     handler bug — deny and log at error level for triage.
      if (role !== ctx.role) {
        logger.error(
          {
            request_id: requestId,
            user_id: ctx.userId,
            workspace_id: ctx.organizationId,
            session_role: ctx.role,
            enforced_role: role,
            permission
          },
          "guard_role_mismatch"
        );
        throw new ForbiddenError("You do not have permission to perform this action.", {
          hint: `This action requires the "${permission}" permission; the enforced role does not match the session role, so access is denied.`,
          permission
        });
      }
      // (2) ADR-0003 matrix check (§15.2 server-side enforcement).
      if (!can(role, permission)) {
        logger.warn(
          {
            request_id: requestId,
            user_id: ctx.userId,
            workspace_id: ctx.organizationId,
            role,
            permission
          },
          "rbac_denied"
        );
        throw new ForbiddenError("You do not have permission to perform this action.", {
          hint: `This action requires the "${permission}" permission, which the "${role}" role does not grant.`,
          permission
        });
      }
      // (3) Effective session grants (API-key scope narrowing, ADR-0003):
      //     fail closed — an empty/malformed list grants nothing.
      if (!hasSessionPermission(ctx, permission)) {
        logger.warn(
          {
            request_id: requestId,
            user_id: ctx.userId,
            workspace_id: ctx.organizationId,
            role,
            permission,
            reason: "session_scope"
          },
          "rbac_denied"
        );
        throw new ForbiddenError("You do not have permission to perform this action.", {
          hint: `This action requires the "${permission}" permission, which this session or API key does not include.`,
          permission
        });
      }
    },

    assertTenant(resource, ctx) {
      if (isForeignTenant(resource.organizationId, ctx.organizationId)) {
        denyTenant(resource.organizationId, ctx, "resource");
      }
    },

    assertDocAccess(documentOrgId, ctx) {
      if (isForeignTenant(documentOrgId, ctx.organizationId)) {
        denyTenant(documentOrgId, ctx, "document");
      }
    }
  };

  return Object.freeze(guard);
}
