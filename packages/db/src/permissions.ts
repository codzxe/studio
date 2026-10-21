/**
 * Role matrix — PRODUCT_ARCHITECTURE §3.3 + ADR-0003 §RBAC.
 *
 * Better Auth organization roles are the single source of truth; the gateway
 * maps them to capabilities via these pure functions. UI hiding is never
 * enforcement. `viewer ⊂ editor ⊂ admin ⊂ owner` (cumulative).
 *
 * | Capability                        | viewer | editor | admin | owner |
 * |-----------------------------------|:------:|:------:|:-----:|:-----:|
 * | read projects/assets/versions     |   ✅   |   ✅   |   ✅  |   ✅  |
 * | comment                           |   ✅   |   ✅   |   ✅  |   ✅  |
 * | open editor (read-only w/o lease) |   ✅   |   ✅   |   ✅  |   ✅  |
 * | create/edit projects, take lease  |   ❌   |   ✅   |   ✅  |   ✅  |
 * | run agent / manual commands       |   ❌   |   ✅   |   ✅  |   ✅  |
 * | upload assets                     |   ❌   |   ✅   |   ✅  |   ✅  |
 * | create renders/exports            |   ❌   |   ✅   |   ✅  |   ✅  |
 * | invite/remove members             |   ❌   |   ❌   |   ✅  |   ✅  |
 * | billing, API keys, settings       |   ❌   |   ❌   |   ✅  |   ✅  |
 * | delete workspace / transfer       |   ❌   |   ❌   |   ❌  |   ✅  |
 */

export const ROLES = ["owner", "admin", "editor", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/** Wire-stable role names (ADR-0003: never sprinkle strings through handlers). */
export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3,
};

/** Cumulative-role check. */
export function atLeast(role: Role, minimum: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

export const CAPABILITIES = [
  "read",
  "comment",
  "openEditor",
  "createProjects",
  "takeLease",
  "runAgent",
  "uploadAssets",
  "render",
  "invite",
  "removeMembers",
  "manageBilling",
  "manageApiKeys",
  "manageWorkspace",
  "deleteWorkspace",
  "transferOwnership",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const VIEWER: readonly Capability[] = ["read", "comment", "openEditor"];
const EDITOR: readonly Capability[] = [
  ...VIEWER,
  "createProjects",
  "takeLease",
  "runAgent",
  "uploadAssets",
  "render",
];
const ADMIN: readonly Capability[] = [
  ...EDITOR,
  "invite",
  "removeMembers",
  "manageBilling",
  "manageApiKeys",
  "manageWorkspace",
];

export const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  viewer: VIEWER,
  editor: EDITOR,
  admin: ADMIN,
  owner: [...ADMIN, "deleteWorkspace", "transferOwnership"],
};

export function capabilitiesFor(role: Role): readonly Capability[] {
  return ROLE_CAPABILITIES[role];
}

/** Core predicate — all named helpers below delegate here. */
export function can(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

export const canCreateProjects = (role: Role): boolean => can(role, "createProjects");
export const canRunAgent = (role: Role): boolean => can(role, "runAgent");
export const canUploadAssets = (role: Role): boolean => can(role, "uploadAssets");
export const canRender = (role: Role): boolean => can(role, "render");
export const canInvite = (role: Role): boolean => can(role, "invite");
export const canRemoveMembers = (role: Role): boolean => can(role, "removeMembers");
export const canManageBilling = (role: Role): boolean => can(role, "manageBilling");
export const canManageApiKeys = (role: Role): boolean => can(role, "manageApiKeys");
export const canManageWorkspace = (role: Role): boolean => can(role, "manageWorkspace");
export const canDeleteWorkspace = (role: Role): boolean => can(role, "deleteWorkspace");
export const canTransferOwnership = (role: Role): boolean => can(role, "transferOwnership");
export const canComment = (role: Role): boolean => can(role, "comment");
export const canOpenEditor = (role: Role): boolean => can(role, "openEditor");
export const canTakeLease = (role: Role): boolean => can(role, "takeLease");
export const canRead = (role: Role): boolean => can(role, "read");
