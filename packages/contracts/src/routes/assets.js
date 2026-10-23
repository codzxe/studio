// @studio/contracts — workspace assets (PRODUCT_ARCHITECTURE.md §7.2, §9.1, §12.3).
//
// Upload is two-phase: create a descriptor (JSON), then PUT bytes to the
// returned signed URL. Assets are referenced by id/name — never by path (§8.3).
import { z } from "zod";
import { SHA256_SCHEMA } from "./common.js";
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
//# sourceMappingURL=assets.js.map