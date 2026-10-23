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
export declare const ROLES: readonly ["owner", "admin", "editor", "viewer"];
export type Role = (typeof ROLES)[number];
/** Wire-stable role names (ADR-0003: never sprinkle strings through handlers). */
export declare function isRole(value: unknown): value is Role;
/** Cumulative-role check. */
export declare function atLeast(role: Role, minimum: Role): boolean;
export declare const CAPABILITIES: readonly ["read", "comment", "openEditor", "createProjects", "takeLease", "runAgent", "uploadAssets", "render", "invite", "removeMembers", "manageBilling", "manageApiKeys", "manageWorkspace", "deleteWorkspace", "transferOwnership"];
export type Capability = (typeof CAPABILITIES)[number];
export declare const ROLE_CAPABILITIES: Record<Role, readonly Capability[]>;
export declare function capabilitiesFor(role: Role): readonly Capability[];
/** Core predicate — all named helpers below delegate here. */
export declare function can(role: Role, capability: Capability): boolean;
export declare const canCreateProjects: (role: Role) => boolean;
export declare const canRunAgent: (role: Role) => boolean;
export declare const canUploadAssets: (role: Role) => boolean;
export declare const canRender: (role: Role) => boolean;
export declare const canInvite: (role: Role) => boolean;
export declare const canRemoveMembers: (role: Role) => boolean;
export declare const canManageBilling: (role: Role) => boolean;
export declare const canManageApiKeys: (role: Role) => boolean;
export declare const canManageWorkspace: (role: Role) => boolean;
export declare const canDeleteWorkspace: (role: Role) => boolean;
export declare const canTransferOwnership: (role: Role) => boolean;
export declare const canComment: (role: Role) => boolean;
export declare const canOpenEditor: (role: Role) => boolean;
export declare const canTakeLease: (role: Role) => boolean;
export declare const canRead: (role: Role) => boolean;
