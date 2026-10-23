import { z } from "zod";
import { type Id } from "./common.js";
export declare const ASSET_NAME_SCHEMA: z.ZodString;
/** Coarse media type; the worker MIME-sniffs and allowlists (§12.3). */
export declare const ASSET_MIME_SCHEMA: z.ZodString;
/** `POST /v1/assets` body: descriptor only (no bytes; sizes/dimensions probed §12.3). */
export declare const CREATE_ASSET_SCHEMA: z.ZodObject<{
    name: z.ZodString;
    mime: z.ZodString;
    sizeBytes: z.ZodNumber;
    sha256: z.ZodString;
    width: z.ZodOptional<z.ZodNumber>;
    height: z.ZodOptional<z.ZodNumber>;
    durationTicks: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
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
