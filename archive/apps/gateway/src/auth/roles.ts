// Better Auth organization-plugin access control for the §15.2 RBAC ladder.
//
// The ladder itself (viewer ⊂ editor ⊂ admin ⊂ owner) and the permission
// vocabulary live in ONE place: `src/authz/roles.js` (W4-C, audited cell-by-cell
// against ADR-0003 by `src/authz/matrix.js` + `tests/authz.test.ts`). This module
// is the bridge that feeds the SAME table into the Better Auth `organization`
// plugin's access-control config (§16.3: "Better Auth … organization plugin for
// workspaces/members/roles/invites"), so the plugin's own endpoints
// (create/invite/remove-member, delete-organization, …) can never drift from the
// gateway's `can()` predicate:
//
//   - every `Permission` string ("resource:action") becomes an AC statement
//     `{ resource: [action, …] }`, granted to a role exactly when
//     `can(role, permission)` (§15.2: "RBAC enforced server-side on every
//     endpoint"; ADR-0003: wire-stable role names);
//   - the plugin-INTERNAL statements (member/invitation/organization/team — the
//     resources its endpoints check) are granted per the same ADR matrix:
//     admin manages members+invites and may update (not delete) the workspace,
//     owner additionally deletes it; editor/viewer get no internal grants
//     (better-auth's member/invitation READ endpoints are session-scoped, no
//     permission check).
//
// The `team` statement is declared but granted to NO role: §16.3 requires
// teams enabled in the plugin config, but @studio/db has no team/team_member
// tables yet (see server.ts) — so team endpoints stay uncallable instead of
// half-working. Grant them only after those tables land.

import { createAccessControl } from "better-auth/plugins/access";
import type { AccessControl, Role as AuthPluginRole } from "better-auth/plugins/access";
import { ALL_PERMISSIONS, can, type Permission, type Role } from "../authz/roles.js";

/**
 * Split a `Permission` string into `[resource, action]`. Pure; every entry in
 * `MIN_ROLE_FOR_PERMISSION` (authz/roles.ts) is `"resource:action"`, enforced
 * by the return-type fallback (`[permission, ""]` never grants anything).
 */
export function splitPermission(permission: string): readonly [string, string] {
  const sep = permission.indexOf(":");
  if (sep <= 0) {
    return [permission, ""];
  }
  return [permission.slice(0, sep), permission.slice(sep + 1)];
}

/** AC statements for the product capabilities — derived, never hand-written. */
function productStatements(): Record<string, readonly string[]> {
  const statements: Record<string, string[]> = {};
  for (const permission of ALL_PERMISSIONS) {
    const [resource, action] = splitPermission(permission);
    (statements[resource] ??= []).push(action);
  }
  return statements;
}

/** AC statements granted to `role` for product capabilities — derived via can(). */
function productGrants(role: Role): Record<string, readonly string[]> {
  const grants: Record<string, string[]> = {};
  for (const permission of ALL_PERMISSIONS) {
    if (!can(role, permission)) {
      continue; // ADR-0003 matrix is the only source of grants
    }
    const [resource, action] = splitPermission(permission);
    (grants[resource] ??= []).push(action);
  }
  return grants;
}

/**
 * Grants for the resources the organization plugin checks INTERNALLY (its
 * default statements, mirrored from better-auth `defaultStatements` minus
 * team). Deliberately literal so drift from the plugin is visible in review.
 */
const INTERNAL_GRANTS = {
  // ADR-0003: owner — workspace delete/transfer; member + invite management.
  owner: {
    organization: ["update", "delete"],
    member: ["create", "update", "delete"],
    invitation: ["create", "cancel"]
  },
  // ADR-0003: admin — "Manage members + invites"; billing lives in product
  // statements; admin may update but never delete the workspace.
  admin: {
    organization: ["update"],
    member: ["create", "update", "delete"],
    invitation: ["create", "cancel"]
  },
  editor: {},
  viewer: {}
} as const satisfies Readonly<Record<Role, Readonly<Record<string, readonly string[]>>>>;

/**
 * The access-control pair handed to `organization({ ac, roles })` in
 * server.ts. Derived on every call (cheap, pure) so the plugin config can
 * never go stale relative to `authz/roles.js`.
 */
export function buildWorkspaceAccessControl(): {
  readonly ac: AccessControl;
  readonly roles: Readonly<Record<Role, AuthPluginRole>>;
} {
  const ac = createAccessControl({
    ...productStatements(),
    organization: ["update", "delete"],
    member: ["create", "update", "delete"],
    invitation: ["create", "cancel"],
    // §16.3 teams: statement reserved; NO role is granted it until the team
    // tables land in @studio/db (grants intentionally omitted above).
    team: ["create", "update", "delete"]
  });

  const roles: Record<Role, AuthPluginRole> = {
    owner: ac.newRole({ ...INTERNAL_GRANTS.owner, ...productGrants("owner") }),
    admin: ac.newRole({ ...INTERNAL_GRANTS.admin, ...productGrants("admin") }),
    editor: ac.newRole(productGrants("editor")),
    viewer: ac.newRole(productGrants("viewer"))
  };
  return { ac, roles };
}

/**
 * Product permissions granted to `role` by the AC wiring above — the inverse
 * of `productGrants`, flattened back to `"resource:action"` strings. Exported
 * for tests so the plugin wiring is asserted against `can()` directly.
 */
export function acPermissionStrings(role: Role): readonly Permission[] {
  const granted = productGrants(role);
  return ALL_PERMISSIONS.filter((permission) => {
    const [resource, action] = splitPermission(permission);
    return (granted[resource] ?? []).includes(action);
  });
}
