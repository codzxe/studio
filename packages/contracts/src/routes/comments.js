// @studio/contracts — comments (PRODUCT_ARCHITECTURE.md §7.2, §9.1 `comments`, §11).
//
// Comments anchor to a project/composition/layer/time (§M7 task 1); replies
// thread through `parentCommentId` (the list stays FLAT — the client builds
// the tree); resolve/unresolve only — bodies are never edited.
import { z } from "zod";
import { ID_SCHEMA, PAGINATION_QUERY_SCHEMA } from "./common.js";
/** Comment body bound (§9.1; hostile-input cap shared by every author kind). */
export const COMMENT_BODY_MAX = 2000;
/** Guest display-name bound (mirrors the `guest_name` column, ≤ 80). */
export const GUEST_NAME_MAX = 80;
/** Guest email bound (mirrors the `guest_email` column, ≤ 200). */
export const GUEST_EMAIL_MAX = 200;
/**
 * Basic email SHAPE check only (local@domain.tld, no whitespace) — an
 * hostile-input bound, never a deliverability claim.
 */
export const GUEST_EMAIL_SCHEMA = z
    .string()
    .min(3)
    .max(GUEST_EMAIL_MAX)
    .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "must be an email address");
/** Query-string booleans arrive as "true"/"false" — accept both spellings. */
const BOOLEAN_QUERY_SCHEMA = z
    .union([z.boolean(), z.literal("true"), z.literal("false")])
    .transform((value) => (typeof value === "boolean" ? value : value === "true"));
/** `POST /v1/projects/:id/comments` body (comp anchor required, §9.1). */
export const CREATE_COMMENT_SCHEMA = z.strictObject({
    compId: ID_SCHEMA,
    layerId: ID_SCHEMA.optional(),
    timeTicks: z.number().int().nonnegative().optional(),
    body: z.string().min(1).max(COMMENT_BODY_MAX),
});
/**
 * `POST /v1/comments/:id/replies` body — a reply INHERITS the parent's
 * project/comp/layer/time anchor (thread integrity), so only the text rides
 * the wire. Server enforces depth ≤ 3 (root → reply → reply-to-reply).
 */
export const COMMENT_REPLY_SCHEMA = z.strictObject({
    body: z.string().min(1).max(COMMENT_BODY_MAX),
});
/**
 * Guest comment body for the PUBLIC share surface (M7-E mounts the route):
 * anchor + display name + email. No author id ever rides the wire — the
 * server records `authorId: null` and the name/email as guest fields.
 */
export const GUEST_COMMENT_SCHEMA = z.strictObject({
    compId: ID_SCHEMA,
    layerId: ID_SCHEMA.optional(),
    timeTicks: z.number().int().nonnegative().optional(),
    body: z.string().min(1).max(COMMENT_BODY_MAX),
    guestName: z.string().min(1).max(GUEST_NAME_MAX),
    guestEmail: GUEST_EMAIL_SCHEMA,
});
/** `GET /v1/projects/:id/comments` query (D-15: `compId` filters server-side). */
export const COMMENTS_QUERY_SCHEMA = PAGINATION_QUERY_SCHEMA.extend({
    compId: ID_SCHEMA.optional(),
    resolved: BOOLEAN_QUERY_SCHEMA.optional(),
});
/**
 * `POST /v1/comments/:id/resolve` body. Resolving is idempotent (the FIRST
 * resolver is recorded); `resolved: false` reopens the thread. An empty body
 * means resolve.
 */
export const RESOLVE_COMMENT_SCHEMA = z.strictObject({
    resolved: z.boolean().default(true),
});
//# sourceMappingURL=comments.js.map