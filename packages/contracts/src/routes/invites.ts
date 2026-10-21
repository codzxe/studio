// @studio/contracts — /v1/workspaces/:id/invites + /v1/invites/:token/accept
// (PRODUCT_ARCHITECTURE.md §7.2, §7.1 — roles are wire-stable, every invite is audited).

import { z } from "zod";

import { ID_SCHEMA, type Id, ROLE_SCHEMA, type Role } from "./common.js";

/** `POST /v1/workspaces/:id/invites` body. */
export const INVITE_MEMBER_SCHEMA = z.strictObject({
  email: z.email(),
  role: ROLE_SCHEMA,
});

export type InviteMemberRequest = z.infer<typeof INVITE_MEMBER_SCHEMA>;

/** `POST /v1/invites/:token/accept` has no body (token in path). */
export const ACCEPT_INVITE_SCHEMA = z.strictObject({});

export type InviteStatus = "pending" | "accepted" | "revoked";

export interface Invite {
  readonly id: Id;
  readonly workspaceId: Id;
  readonly email: string;
  readonly role: Role;
  readonly status: InviteStatus;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

/** Membership row produced by an accepted invite. */
export interface AcceptedInvite {
  readonly inviteId: Id;
  readonly workspaceId: Id;
  readonly role: Role;
}

export const INVITE_ID_SCHEMA = ID_SCHEMA;
