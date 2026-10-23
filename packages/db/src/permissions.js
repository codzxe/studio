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
export const ROLES = ["owner", "admin", "editor", "viewer"];
/** Wire-stable role names (ADR-0003: never sprinkle strings through handlers). */
export function isRole(value) {
    return typeof value === "string" && ROLES.includes(value);
}
const ROLE_RANK = {
    viewer: 0,
    editor: 1,
    admin: 2,
    owner: 3,
};
/** Cumulative-role check. */
export function atLeast(role, minimum) {
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
];
const VIEWER = ["read", "comment", "openEditor"];
const EDITOR = [
    ...VIEWER,
    "createProjects",
    "takeLease",
    "runAgent",
    "uploadAssets",
    "render",
];
const ADMIN = [
    ...EDITOR,
    "invite",
    "removeMembers",
    "manageBilling",
    "manageApiKeys",
    "manageWorkspace",
];
export const ROLE_CAPABILITIES = {
    viewer: VIEWER,
    editor: EDITOR,
    admin: ADMIN,
    owner: [...ADMIN, "deleteWorkspace", "transferOwnership"],
};
export function capabilitiesFor(role) {
    return ROLE_CAPABILITIES[role];
}
/** Core predicate — all named helpers below delegate here. */
export function can(role, capability) {
    return ROLE_CAPABILITIES[role].includes(capability);
}
export const canCreateProjects = (role) => can(role, "createProjects");
export const canRunAgent = (role) => can(role, "runAgent");
export const canUploadAssets = (role) => can(role, "uploadAssets");
export const canRender = (role) => can(role, "render");
export const canInvite = (role) => can(role, "invite");
export const canRemoveMembers = (role) => can(role, "removeMembers");
export const canManageBilling = (role) => can(role, "manageBilling");
export const canManageApiKeys = (role) => can(role, "manageApiKeys");
export const canManageWorkspace = (role) => can(role, "manageWorkspace");
export const canDeleteWorkspace = (role) => can(role, "deleteWorkspace");
export const canTransferOwnership = (role) => can(role, "transferOwnership");
export const canComment = (role) => can(role, "comment");
export const canOpenEditor = (role) => can(role, "openEditor");
export const canTakeLease = (role) => can(role, "takeLease");
export const canRead = (role) => can(role, "read");
//# sourceMappingURL=permissions.js.map