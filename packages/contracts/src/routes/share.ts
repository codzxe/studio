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
import type { Id } from "./common.js";

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

export type ShareTokenPath = z.infer<typeof SHARE_TOKEN_PATH_SCHEMA>;

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

export type IssueShareLinkRequest = z.infer<typeof ISSUE_SHARE_LINK_SCHEMA>;

/**
 * Issue response — the ONLY place the raw token ever appears. Clients must
 * persist it immediately (e.g. copy the /s/:token URL); it cannot be
 * re-fetched.
 */
export interface ShareLinkIssued {
  readonly id: Id;
  /** Raw token — shown exactly once; only sha256(token) is stored. */
  readonly token: string;
  readonly expiresAt: string | null;
  readonly hasPassword: boolean;
}

/**
 * Active share link for member lists/dialogs — NO token material: the raw
 * token no longer exists and the hash/password never leave the db package.
 */
export interface ShareLinkView {
  readonly id: Id;
  readonly projectId: Id;
  readonly createdBy: Id;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly hasPassword: boolean;
}

/** `DELETE /v1/share/:id` (creator or admin) — idempotent revocation. */
export interface ShareLinkRevoked {
  readonly id: Id;
  readonly revokedAt: string | null;
}

// ---------------------------------------------------------------------------
// PUBLIC: share metadata + manifest
// ---------------------------------------------------------------------------

/**
 * `GET /v1/share/:token` — what the share page needs before the password
 * prompt: WHAT is shared and HOW to unlock it. Never project content.
 *
 * v1 notes: `compId` stays null (a token shares the whole project; the
 * player picks the composition); `requestAccessEmail` stays null — v1
 * "notification" is the request-access audit row the workspace reads in the
 * activity feed.
 */
export interface ShareInfo {
  readonly projectId: Id;
  readonly projectName: string;
  readonly compId: string | null;
  readonly expiresAt: string | null;
  readonly hasPassword: boolean;
  readonly requestAccessEmail: string | null;
}

/** One manifest asset for the web player — no ids, signed URL only. */
export interface ShareManifestAsset {
  readonly name: string;
  readonly mime: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationTicks: number | null;
  readonly url: string;
}

/**
 * `GET /v1/share/:token/manifest` (password-gated) — the web player's read
 * surface. Deliberately narrower than the member `ProjectManifest`: NO
 * project/version/asset ids, no sha256, no workspace scoping hints — signed
 * §9.2 URLs are the only content addressing an anonymous visitor ever sees.
 * No editor wasm for anonymous users (v1 pin): the player consumes this.
 */
export interface ShareManifest {
  readonly currentVersion: {
    readonly version: number;
    readonly label: string | null;
    readonly sizeBytes: number;
    readonly createdAt: string;
    readonly url: string;
  } | null;
  readonly assets: readonly ShareManifestAsset[];
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// PUBLIC: comments + request access
// ---------------------------------------------------------------------------

/**
 * `POST /v1/share/:token/comments` body == GUEST_COMMENT_SCHEMA (routes/
 * comments.ts, M7-A): comp anchor + display name ≤ 80 + email + body. Guests
 * post top-level comments only (no `parentId` on this surface).
 */
export const CREATE_SHARE_COMMENT_SCHEMA = GUEST_COMMENT_SCHEMA;

export type CreateShareCommentRequest = z.infer<typeof CREATE_SHARE_COMMENT_SCHEMA>;

/**
 * `GET /v1/share/:token/comments` query — identical to the member comments
 * query (D-15: compId filters server-side; resolved accepts "true"/"false"
 * query-string spellings); aliased so the share client region is self-
 * describing.
 */
export const SHARE_COMMENTS_QUERY_SCHEMA = COMMENTS_QUERY_SCHEMA;

export type ShareCommentsQuery = z.infer<typeof SHARE_COMMENTS_QUERY_SCHEMA>;

/**
 * A comment as an anonymous reviewer sees it. NO member ids, NO guest
 * emails — `guestName` is the only attribution a guest row exposes, and
 * member-authored rows show it as null (the page renders "Studio member").
 * `parentCommentId` matches the member DTO naming (routes/comments.ts).
 */
export interface ShareComment {
  readonly id: Id;
  readonly compId: Id;
  readonly layerId: Id | null;
  readonly timeTicks: number | null;
  readonly parentCommentId: Id | null;
  readonly body: string;
  readonly guestName: string | null;
  readonly resolvedAt: string | null;
  readonly createdAt: string;
}

/** `POST /v1/share/:token/request-access` body. */
export const REQUEST_ACCESS_SCHEMA = z.strictObject({
  email: z.email().max(320),
  /** Optional free-text note (≤ 2000 chars). */
  message: z.string().max(2000).optional(),
});

export type RequestAccessRequest = z.infer<typeof REQUEST_ACCESS_SCHEMA>;

/**
 * Request-access response — a typed ok; v1's notification IS the audit row
 * (action `share.request_access`) the workspace sees in its activity feed.
 */
export interface RequestAccessResponse {
  readonly ok: true;
}

// ---------------------------------------------------------------------------
// Abuse limits (per-IP fixed windows enforced by the gateway share routes)
// ---------------------------------------------------------------------------

/** Guest comments per minute per IP (§M7 task 1 "rate-limited"). */
export const SHARE_GUEST_COMMENT_LIMIT_PER_MIN = 5;

/** Request-access posts per minute per IP. */
export const SHARE_REQUEST_ACCESS_LIMIT_PER_MIN = 5;

/** Password attempts per minute per IP (missing/wrong both count). */
export const SHARE_PASSWORD_ATTEMPT_LIMIT_PER_MIN = 10;
