import { z } from "zod";
import { type Id, type Role } from "./common.js";
/** `POST /v1/workspaces/:id/invites` body. */
export declare const INVITE_MEMBER_SCHEMA: z.ZodObject<{
    email: z.ZodEmail;
    role: z.ZodEnum<{
        editor: "editor";
        owner: "owner";
        admin: "admin";
        viewer: "viewer";
    }>;
}, z.core.$strict>;
export type InviteMemberRequest = z.infer<typeof INVITE_MEMBER_SCHEMA>;
/** `POST /v1/invites/:token/accept` has no body (token in path). */
export declare const ACCEPT_INVITE_SCHEMA: z.ZodObject<{}, z.core.$strict>;
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
export declare const INVITE_ID_SCHEMA: z.ZodString;
