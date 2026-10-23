// @studio/contracts — member management (M1.2, task W1-a): list, role change,
// removal, ownership transfer and active-workspace switch for
// /v1/workspaces/:id/… (PRODUCT_ARCHITECTURE.md §7.2, §7.1, §3.3).
//
// Wire notes:
//   * Roles are wire-stable (owner|admin|editor|viewer) — same set as invites.
//   * `Member.id` is the member's USER id: the stable identifier across
//     GET /v1/me memberships, the workspace member list and the M9 settings
//     surface. (The membership row id better-auth uses internally never
//     crosses the wire.)
//   * `status` is v1-simple: every listed row is an active member. Invited
//     users appear once they accept; pending invitations are a separate
//     surface (see routes/invites.ts).
//   * `lastActiveAt` is null in v1 — better-auth keeps no per-member activity
//     stamp; the field exists so the wire can grow it without a breaking change.

import { z } from "zod";

import { ID_SCHEMA, type Id, PAGINATION_QUERY_SCHEMA, ROLE_SCHEMA, type Role } from "./common.js";

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

/** `PATCH /v1/workspaces/:id/members/:memberId` body — the new role. */
export const PATCH_MEMBER_ROLE_SCHEMA = z.strictObject({
  role: ROLE_SCHEMA,
});

export type PatchMemberRoleRequest = z.infer<typeof PATCH_MEMBER_ROLE_SCHEMA>;

/** `POST /v1/workspaces/:id/transfer-ownership` body — the member who becomes owner. */
export const TRANSFER_OWNERSHIP_SCHEMA = z.strictObject({
  /** The member's user id (must already belong to the workspace). */
  memberId: ID_SCHEMA,
});

export type TransferOwnershipRequest = z.infer<typeof TRANSFER_OWNERSHIP_SCHEMA>;

/**
 * `POST /v1/workspaces/:id/switch` has no body — the path identifies the
 * workspace that becomes the caller's active one (session-scoped).
 */
export const SWITCH_WORKSPACE_SCHEMA = z.strictObject({});

export type SwitchWorkspaceRequest = z.infer<typeof SWITCH_WORKSPACE_SCHEMA>;

/** `GET /v1/workspaces/:id/members` query — the standard cursor page. */
export const MEMBER_LIST_QUERY_SCHEMA = PAGINATION_QUERY_SCHEMA;

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export type MemberStatus = "active";

/** Member row of the workspace member list (§7.2, §3.3). */
export interface Member {
  /** The member's user id (stable across /v1/me and this surface). */
  readonly id: Id;
  readonly name: string | null;
  readonly email: string | null;
  readonly role: Role;
  readonly status: MemberStatus;
  /** ISO-8601; null until per-member activity tracking exists (v1: null). */
  readonly lastActiveAt: string | null;
  /** True when the row is the calling user (the M9 settings surface). */
  readonly isCurrentUser: boolean;
}

/** `DELETE /v1/workspaces/:id/members/:memberId` → Ok\<MemberRemoved\>. */
export interface MemberRemoved {
  readonly id: Id;
  readonly removed: true;
}

/** `POST /v1/workspaces/:id/transfer-ownership` → Ok\<OwnershipTransferred\>. */
export interface OwnershipTransferred {
  readonly workspaceId: Id;
  /** The new owner's user id. */
  readonly ownerId: Id;
  /** The previous owner (now admin). */
  readonly previousOwnerId: Id;
}

/** `POST /v1/workspaces/:id/switch` → Ok\<SwitchedWorkspace\>. */
export interface SwitchedWorkspace {
  readonly workspaceId: Id;
  readonly name: string;
  readonly slug: string;
}
