// @studio/contracts — workspace assets (PRODUCT_ARCHITECTURE.md §7.2, §9.1, §12.3).
//
// Upload is two-phase: create a descriptor (JSON), then PUT bytes to the
// returned signed URL. Assets are referenced by id/name — never by path (§8.3).

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

/** `POST /v1/assets` → asset + upload target (signed URL). */
export interface CreateAssetResponse {
  readonly asset: Asset;
  readonly upload: {
    readonly url: string;
    readonly method: "PUT";
    readonly expiresAt: string;
    readonly headers: Readonly<Record<string, string>>;
  };
}

/** `GET /v1/assets/:id/url` → short-lived signed download URL (§9.2). */
export interface SignedUrlResponse {
  readonly url: string;
  readonly expiresAt: string;
}
