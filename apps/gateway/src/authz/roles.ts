// Workspace RBAC — roles, permissions, and the pure `can()` predicate.
//
// Source of truth: docs/adr/0003-auth-and-orgs.md "RBAC matrix (§15.2)" —
// Better Auth org roles are the single source of truth and the gateway maps
// them to permissions HERE, so a permission is never a string sprinkled
// through handlers (ADR-0003 consequences). Roles are strictly cumulative
// (viewer ⊂ editor ⊂ admin ⊂ owner), so every permission is declared ONCE
// with its minimum granting role (MIN_ROLE_FOR_PERMISSION) and all per-role
// lists are derived. matrix.ts audits this table against the ADR table
// verbatim; tests/authz.test.ts is the CI gate (§20 #11 is the acceptance
// gate: the automated cross-tenant suite).
//
// Permission names reuse the §13.2 API-key scope vocabulary where they
// overlap (documents:read, documents:write, runs:create, exports:create):
// ADR-0003 constrains API keys "additionally by scope", so members and keys
// share one permission language (a key is never wider than its creator).
//
// §15.2: "RBAC enforced server-side on every endpoint … UI hiding is not
// enforcement" — routes enforce via src/authz/guard.ts (assertCan), never by
// calling can() alone: the guard also checks the session's effective grants.

/** Workspace roles, ascending privilege (ADR-0003; `workspace_members.role`, §12). */
export const ROLES = ["viewer", "editor", "admin", "owner"] as const;

export type Role = (typeof ROLES)[number];

/**
 * Privilege rank per role (ascending). Cumulativity: a permission granted at
 * rank N is granted to every role with rank ≥ N.
 */
export const ROLE_RANK = {
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3
} as const satisfies Readonly<Record<Role, number>>;

/**
 * The minimum role that grants each permission — ONE row per ADR-0003 matrix
 * capability, plus the task-sourced brand-token capability. Keep comments in
 * sync with the ADR table; matrix.ts + tests/authz.test.ts fail CI on drift.
 */
export const MIN_ROLE_FOR_PERMISSION = {
  // ADR-0003: "Read documents/assets/runs/versions" — viewer+. Reading
  // workspace comments rides this permission too (viewers read + comment, §15.2).
  "documents:read": "viewer",
  // ADR-0003: "Comment (with position)" — viewer+ (§15.2 "viewer (read + comment)").
  "comments:create": "viewer",
  // ADR-0003: "Create runs (`POST /runs`, tiers)" — editor+. Chat edits are
  // quick-edit-tier runs (§8.2), so they are gated by this permission as well.
  "runs:create": "editor",
  // ADR-0003: "Manual commands / undo / redo / restore" — editor+ (§15.2
  // "editor (runs + commands)").
  "documents:write": "editor",
  // ADR-0003: "Exports (`exports:create`)" — editor+.
  "exports:create": "editor",
  // ADR-0003: "Upload assets / register templates" — editor+.
  "assets:upload": "editor",
  // ADR-0003: "Manage members + invites" — admin+.
  "members:manage": "admin",
  // ADR-0003: "Billing (checkout/portal, credit packs)" — admin+ (the owner
  // row inherits it cumulatively). NOTE: the W4-C task summary lists billing
  // under owner, but the ADR-0003 table grants admin — the table is
  // authoritative and matrix.ts audits this cell against it.
  "billing:manage": "admin",
  // ADR-0003: "API key management" — admin+.
  "apikeys:manage": "admin",
  // ADR-0003: "Delete workspace (§15.2 \"owner: delete\")" — owner only (danger zone).
  "workspace:delete": "owner",
  // ADR-0003: "Transfer ownership / dissolve" — owner only.
  "workspace:transfer": "owner",
  // NOT an ADR-0003 row: workspace brand tokens (palette, fonts, logo — §5.4
  // style guide; §19 "brand tokens per workspace"). The W4-C task assigns
  // brand-token management to admin; viewing them rides documents:read.
  "brand:manage": "admin"
} as const satisfies Readonly<Record<string, Role>>;

export type Permission = keyof typeof MIN_ROLE_FOR_PERMISSION;

/** Runtime guard: is `value` one of the wire-stable role names? (ADR-0003). */
export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** Runtime guard: is `value` a known permission? (boundary parsing, §15.2). */
export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && Object.hasOwn(MIN_ROLE_FOR_PERMISSION, value);
}

/** All permissions, ascending by minimum role then name (deterministic order). */
export const ALL_PERMISSIONS: readonly Permission[] = Object.freeze(
  (Object.keys(MIN_ROLE_FOR_PERMISSION) as Permission[]).sort((a, b) => {
    const rankDelta = ROLE_RANK[MIN_ROLE_FOR_PERMISSION[b]] - ROLE_RANK[MIN_ROLE_FOR_PERMISSION[a]];
    return rankDelta !== 0 ? rankDelta : a.localeCompare(b);
  })
);

/**
 * Does `role` grant `permission`? Pure, total, fail-closed: an unknown role or
 * permission (possible only from non-TS callers / deserialized payloads)
 * grants nothing.
 */
export function can(role: Role, permission: Permission): boolean {
  if (!isRole(role) || !isPermission(permission)) {
    return false; // runtime defense — fail closed (§15.2)
  }
  return ROLE_RANK[role] >= ROLE_RANK[MIN_ROLE_FOR_PERMISSION[permission]];
}

function permissionsForRole(role: Role): readonly Permission[] {
  return Object.freeze(ALL_PERMISSIONS.filter((permission) => can(role, permission)));
}

/**
 * Effective grants per role (derived from MIN_ROLE_FOR_PERMISSION — never
 * hand-edited). Session middleware (src/auth/session.ts) populates
 * SessionContext.permissions from these lists for member sessions; API-key
 * sessions use the intersection with the key's scopes — never wider
 * (ADR-0003: "an editor's key can hold runs:create; a viewer's cannot").
 */
export const PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = Object.freeze({
  viewer: permissionsForRole("viewer"),
  editor: permissionsForRole("editor"),
  admin: permissionsForRole("admin"),
  owner: permissionsForRole("owner")
});
