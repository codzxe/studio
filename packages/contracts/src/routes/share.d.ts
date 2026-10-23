import { z } from "zod";
import type { Id } from "./common.js";
/**
 * The raw share token in the URL: 256-bit random, base64url (43 chars) —
 * minted by the gateway. The schema bounds the shape without constraining
 * the encoding scheme (older links / future schemes must keep resolving).
 */
export declare const SHARE_TOKEN_PATH_SCHEMA: z.ZodString;
export type ShareTokenPath = z.infer<typeof SHARE_TOKEN_PATH_SCHEMA>;
/** Password gate header (protected tokens; never a query parameter). */
export declare const SHARE_PASSWORD_HEADER = "x-share-password";
/** Share passwords: same floor as account passwords, tighter ceiling. */
export declare const SHARE_PASSWORD_SCHEMA: z.ZodString;
/** `POST /v1/projects/:id/share-links` body (all optional). */
export declare const ISSUE_SHARE_LINK_SCHEMA: z.ZodObject<{
    password: z.ZodOptional<z.ZodString>;
    expiresInDays: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
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
/**
 * `POST /v1/share/:token/comments` body == GUEST_COMMENT_SCHEMA (routes/
 * comments.ts, M7-A): comp anchor + display name ≤ 80 + email + body. Guests
 * post top-level comments only (no `parentId` on this surface).
 */
export declare const CREATE_SHARE_COMMENT_SCHEMA: z.ZodObject<{
    compId: z.ZodString;
    layerId: z.ZodOptional<z.ZodString>;
    timeTicks: z.ZodOptional<z.ZodNumber>;
    body: z.ZodString;
    guestName: z.ZodString;
    guestEmail: z.ZodString;
}, z.core.$strict>;
export type CreateShareCommentRequest = z.infer<typeof CREATE_SHARE_COMMENT_SCHEMA>;
/**
 * `GET /v1/share/:token/comments` query — identical to the member comments
 * query (D-15: compId filters server-side; resolved accepts "true"/"false"
 * query-string spellings); aliased so the share client region is self-
 * describing.
 */
export declare const SHARE_COMMENTS_QUERY_SCHEMA: z.ZodObject<{
    cursor: z.ZodOptional<z.ZodString>;
    limit: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    compId: z.ZodOptional<z.ZodString>;
    resolved: z.ZodOptional<z.ZodPipe<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"true">, z.ZodLiteral<"false">]>, z.ZodTransform<boolean, boolean | "false" | "true">>>;
}, z.core.$strip>;
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
export declare const REQUEST_ACCESS_SCHEMA: z.ZodObject<{
    email: z.ZodEmail;
    message: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type RequestAccessRequest = z.infer<typeof REQUEST_ACCESS_SCHEMA>;
/**
 * Request-access response — a typed ok; v1's notification IS the audit row
 * (action `share.request_access`) the workspace sees in its activity feed.
 */
export interface RequestAccessResponse {
    readonly ok: true;
}
/** Guest comments per minute per IP (§M7 task 1 "rate-limited"). */
export declare const SHARE_GUEST_COMMENT_LIMIT_PER_MIN = 5;
/** Request-access posts per minute per IP. */
export declare const SHARE_REQUEST_ACCESS_LIMIT_PER_MIN = 5;
/** Password attempts per minute per IP (missing/wrong both count). */
export declare const SHARE_PASSWORD_ATTEMPT_LIMIT_PER_MIN = 10;
