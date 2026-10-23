// @studio/contracts — share links (BUILD_PLAN §M7 task 5; PRODUCT_ARCHITECTURE
// §7.2, §9.1 `share_tokens`).
//
// Authed surface (member, editor role):
//   POST   /v1/projects/:id/share-links — mint a token (returned ONCE)
//   GET    /v1/projects/:id/share-links — active links, NO secrets
//   DELETE /v1/share/:id                — revoke (creator or admin)
//
// PUBLIC surface (no session — the token, or token+password, IS the
// capability; consumed by the /s/:token share page):
//   GET  /v1/share/:token               — share metadata (never content)
//   GET  /v1/share/:token/manifest      — web-player manifest (password-gated)
//   GET  /v1/share/:token/comments      — guest-readable comments (gated)
//   POST /v1/share/:token/comments      — guest comment (gated, rate-limited;
//                                          body = GUEST_COMMENT_SCHEMA from
//                                          routes/comments.ts, handler pinned
//                                          in the gateway as createGuestComment)
//   POST /v1/share/:token/request-access — record an access request (audit row)
//
// SECURITY PINS (§M7 task 5 + §12.1):
// - The raw token is returned ONCE by the issue route and never crosses the
//   wire again; only sha256(token) is stored. It appears in NO response of
//   the public surface.
// - Anonymous visitors get a player, NEVER the editor (no editor wasm on
//   the share page in v1).
// - The public manifest carries NO internal ids (no project/version/asset
//   ids, no workspace ids, no object keys) — signed URLs are the §9.2
//   10-minute read path and the only content addressing on the wire.
// - Passwords travel in the `x-share-password` header, never the URL/query.
import { z } from "zod";
import { COMMENTS_QUERY_SCHEMA, GUEST_COMMENT_SCHEMA } from "./comments.js";
// ---------------------------------------------------------------------------
// Path token + password header
// ---------------------------------------------------------------------------
/**
 * The raw share token in the URL: 256-bit random, base64url (43 chars) —
 * minted by the gateway. The schema bounds the shape without constraining
 * the encoding scheme (older links / future schemes must keep resolving).
 */
export const SHARE_TOKEN_PATH_SCHEMA = z
    .string()
    .min(16)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/, "must be url-safe");
/** Password gate header (protected tokens; never a query parameter). */
export const SHARE_PASSWORD_HEADER = "x-share-password";
// ---------------------------------------------------------------------------
// Authed: issue / list / revoke
// ---------------------------------------------------------------------------
/** Share passwords: same floor as account passwords, tighter ceiling. */
export const SHARE_PASSWORD_SCHEMA = z.string().min(8).max(128);
/** `POST /v1/projects/:id/share-links` body (all optional). */
export const ISSUE_SHARE_LINK_SCHEMA = z.strictObject({
    password: SHARE_PASSWORD_SCHEMA.optional(),
    /** Whole days from now; 1..365. Omitted = never expires. */
    expiresInDays: z.number().int().min(1).max(365).optional(),
});
// ---------------------------------------------------------------------------
// PUBLIC: comments + request access
// ---------------------------------------------------------------------------
/**
 * `POST /v1/share/:token/comments` body == GUEST_COMMENT_SCHEMA (routes/
 * comments.ts, M7-A): comp anchor + display name ≤ 80 + email + body. Guests
 * post top-level comments only (no `parentId` on this surface).
 */
export const CREATE_SHARE_COMMENT_SCHEMA = GUEST_COMMENT_SCHEMA;
/**
 * `GET /v1/share/:token/comments` query — identical to the member comments
 * query (D-15: compId filters server-side; resolved accepts "true"/"false"
 * query-string spellings); aliased so the share client region is self-
 * describing.
 */
export const SHARE_COMMENTS_QUERY_SCHEMA = COMMENTS_QUERY_SCHEMA;
/** `POST /v1/share/:token/request-access` body. */
export const REQUEST_ACCESS_SCHEMA = z.strictObject({
    email: z.email().max(320),
    /** Optional free-text note (≤ 2000 chars). */
    message: z.string().max(2000).optional(),
});
// ---------------------------------------------------------------------------
// Abuse limits (per-IP fixed windows enforced by the gateway share routes)
// ---------------------------------------------------------------------------
/** Guest comments per minute per IP (§M7 task 1 "rate-limited"). */
export const SHARE_GUEST_COMMENT_LIMIT_PER_MIN = 5;
/** Request-access posts per minute per IP. */
export const SHARE_REQUEST_ACCESS_LIMIT_PER_MIN = 5;
/** Password attempts per minute per IP (missing/wrong both count). */
export const SHARE_PASSWORD_ATTEMPT_LIMIT_PER_MIN = 10;
//# sourceMappingURL=share.js.map