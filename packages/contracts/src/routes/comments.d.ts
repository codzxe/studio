import { z } from "zod";
import { type Id } from "./common.js";
/** Comment body bound (§9.1; hostile-input cap shared by every author kind). */
export declare const COMMENT_BODY_MAX = 2000;
/** Guest display-name bound (mirrors the `guest_name` column, ≤ 80). */
export declare const GUEST_NAME_MAX = 80;
/** Guest email bound (mirrors the `guest_email` column, ≤ 200). */
export declare const GUEST_EMAIL_MAX = 200;
/**
 * Basic email SHAPE check only (local@domain.tld, no whitespace) — an
 * hostile-input bound, never a deliverability claim.
 */
export declare const GUEST_EMAIL_SCHEMA: z.ZodString;
/** `POST /v1/projects/:id/comments` body (comp anchor required, §9.1). */
export declare const CREATE_COMMENT_SCHEMA: z.ZodObject<{
    compId: z.ZodString;
    layerId: z.ZodOptional<z.ZodString>;
    timeTicks: z.ZodOptional<z.ZodNumber>;
    body: z.ZodString;
}, z.core.$strict>;
export type CreateCommentRequest = z.infer<typeof CREATE_COMMENT_SCHEMA>;
/**
 * `POST /v1/comments/:id/replies` body — a reply INHERITS the parent's
 * project/comp/layer/time anchor (thread integrity), so only the text rides
 * the wire. Server enforces depth ≤ 3 (root → reply → reply-to-reply).
 */
export declare const COMMENT_REPLY_SCHEMA: z.ZodObject<{
    body: z.ZodString;
}, z.core.$strict>;
export type CommentReplyRequest = z.infer<typeof COMMENT_REPLY_SCHEMA>;
/**
 * Guest comment body for the PUBLIC share surface (M7-E mounts the route):
 * anchor + display name + email. No author id ever rides the wire — the
 * server records `authorId: null` and the name/email as guest fields.
 */
export declare const GUEST_COMMENT_SCHEMA: z.ZodObject<{
    compId: z.ZodString;
    layerId: z.ZodOptional<z.ZodString>;
    timeTicks: z.ZodOptional<z.ZodNumber>;
    body: z.ZodString;
    guestName: z.ZodString;
    guestEmail: z.ZodString;
}, z.core.$strict>;
export type GuestCommentRequest = z.infer<typeof GUEST_COMMENT_SCHEMA>;
/** `GET /v1/projects/:id/comments` query (D-15: `compId` filters server-side). */
export declare const COMMENTS_QUERY_SCHEMA: z.ZodObject<{
    cursor: z.ZodOptional<z.ZodString>;
    limit: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    compId: z.ZodOptional<z.ZodString>;
    resolved: z.ZodOptional<z.ZodPipe<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"true">, z.ZodLiteral<"false">]>, z.ZodTransform<boolean, boolean | "false" | "true">>>;
}, z.core.$strip>;
export type CommentsQuery = z.infer<typeof COMMENTS_QUERY_SCHEMA>;
/**
 * `POST /v1/comments/:id/resolve` body. Resolving is idempotent (the FIRST
 * resolver is recorded); `resolved: false` reopens the thread. An empty body
 * means resolve.
 */
export declare const RESOLVE_COMMENT_SCHEMA: z.ZodObject<{
    resolved: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>;
/** Parsed resolve body (`{ resolved }`, defaulted). */
export type ResolveCommentRequest = z.infer<typeof RESOLVE_COMMENT_SCHEMA>;
/** Wire-input view of the resolve body (`resolved` may be omitted → resolve). */
export type ResolveCommentRequestInput = z.input<typeof RESOLVE_COMMENT_SCHEMA>;
/**
 * Comment row (§9.1, §11) as returned by create/reply/resolve and the flat
 * threaded list. `parentCommentId` is the threading link (null = root);
 * `authorId` is null on guest rows, which carry `guestName`/`guestEmail`
 * instead; `resolvedBy` records who resolved (null while open).
 */
export interface Comment {
    readonly id: Id;
    readonly projectId: Id;
    readonly compId: Id;
    readonly layerId: Id | null;
    readonly timeTicks: number | null;
    readonly parentCommentId: Id | null;
    readonly body: string;
    readonly authorId: Id | null;
    readonly guestName: string | null;
    readonly guestEmail: string | null;
    readonly resolvedAt: string | null;
    readonly resolvedBy: Id | null;
    readonly createdAt: string;
}
