// @studio/contracts — workspace assets (PRODUCT_ARCHITECTURE.md §7.2, §9.1, §12.3).
//
// Upload is two-phase: create a descriptor (JSON), then PUT bytes to the
// returned signed URL. Assets are referenced by id/name — never by path (§8.3).
//
// W1-c additions (AUD-1 gap #5 / M2.2 + M2.5):
// - SHA-256 dedupe at descriptor time: same workspace + same sha256 returns
//   the EXISTING asset row with `upload: null` (nothing to PUT) and
//   `duplicate: true`. No new row, no new bytes.
// - POST /v1/assets/:id/complete — the explicit verify step the descriptor
//   flow calls after the client PUT finishes: the gateway reads ONLY the
//   object head (never the full bytes), magic-byte-sniffs the true MIME,
//   rejects mismatches (415 ASSET_TYPE_MISMATCH) and back-fills image
//   dimensions where cheap (PNG/JPEG/WebP header parse).
// - Per-plan storageBytes quota on the descriptor path (429 QUOTA_EXCEEDED).

import { z } from "zod";

import { type Id, SHA256_SCHEMA } from "./common.js";

export const ASSET_NAME_SCHEMA = z.string().min(1).max(255);

/** Coarse media type; the worker MIME-sniffs and allowlists (§12.3). */
export const ASSET_MIME_SCHEMA = z
  .string()
  .regex(/^[\w.+-]+\/[\w.+-]+$/)
  .max(255);

/** `POST /v1/assets` body: descriptor only (no bytes; sizes/dimensions probed §12.3). */
export const CREATE_ASSET_SCHEMA = z.strictObject({
  name: ASSET_NAME_SCHEMA,
  mime: ASSET_MIME_SCHEMA,
  sizeBytes: z.number().int().positive(),
  sha256: SHA256_SCHEMA,
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationTicks: z.number().int().nonnegative().optional(),
});

export type CreateAssetRequest = z.infer<typeof CREATE_ASSET_SCHEMA>;

/** Asset row (§9.1 `assets`). */
export interface Asset {
  readonly id: Id;
  readonly workspaceId: Id;
  readonly projectId: Id | null;
  readonly name: string;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationTicks: number | null;
  readonly createdBy: Id;
  readonly createdAt: string;
}

/**
 * `POST /v1/assets` → asset + upload target (signed URL).
 *
 * W1-c dedupe: when the workspace already holds an asset with the same sha256
 * (compatible project scope), the response carries the EXISTING row, no upload
 * target (`upload: null` — there are no bytes to PUT) and `duplicate: true`.
 */
export interface CreateAssetResponse {
  readonly asset: Asset;
  readonly upload: {
    readonly url: string;
    readonly method: "PUT";
    readonly expiresAt: string;
    readonly headers: Readonly<Record<string, string>>;
  } | null;
  /** `true` when the response is a dedupe hit on an existing asset row. */
  readonly duplicate?: boolean;
}

/**
 * `POST /v1/assets/:id/complete` (W1-c verify step) → the verified asset.
 *
 * `duplicate: true` means the just-uploaded bytes matched an existing asset
 * row in the same workspace (same sha256, compatible scope): the new row was
 * removed, the freshly PUT bytes are intentionally left in object storage
 * (orphan-reclaimable, §9.2 content addressing) and the response carries the
 * canonical row instead.
 */
export interface VerifyAssetResponse {
  readonly asset: Asset;
  readonly duplicate: boolean;
}

/** `GET /v1/assets/:id/url` → short-lived signed download URL (§9.2). */
export interface SignedUrlResponse {
  readonly url: string;
  readonly expiresAt: string;
}
