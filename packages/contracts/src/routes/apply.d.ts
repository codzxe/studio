import { z } from "zod";
import { type Id } from "./common.js";
/**
 * One client-side layer resolution posted with the apply (§8.7): the plan
 * compiler referenced a layer BY NAME; the client resolved the id against
 * the live editor (ids never enter the model context, §8.7). Bounded, and
 * validated at the boundary even though the batch already ran client-side.
 */
export declare const RESOLVED_LAYER_SCHEMA: z.ZodObject<{
    requestId: z.ZodString;
    layerId: z.ZodString;
}, z.core.$strict>;
export type ResolvedLayer = z.infer<typeof RESOLVED_LAYER_SCHEMA>;
/** POST /v1/runs/:id/apply request body (M5-SEAMS pinned interface). */
export declare const APPLY_REQUEST_SCHEMA: z.ZodObject<{
    batchSha256: z.ZodString;
    versionId: z.ZodString;
    idempotencyKey: z.ZodString;
    resolvedLayers: z.ZodOptional<z.ZodArray<z.ZodObject<{
        requestId: z.ZodString;
        layerId: z.ZodString;
    }, z.core.$strict>>>;
}, z.core.$strict>;
export type ApplyRequest = z.infer<typeof APPLY_REQUEST_SCHEMA>;
/** POST /v1/runs/:id/undo request body. */
export declare const UNDO_REQUEST_SCHEMA: z.ZodObject<{
    idempotencyKey: z.ZodString;
}, z.core.$strict>;
export type UndoRequest = z.infer<typeof UNDO_REQUEST_SCHEMA>;
/** POST /v1/runs/:id/apply → 200 Ok body (M5-SEAMS). */
export interface ApplyResponse {
    readonly applied: true;
    /** The version this apply created (echoes the request's versionId). */
    readonly versionId: Id;
    /**
     * Plan credits committed by this apply (§8.8). 0 when the run's hold was
     * already fully settled (D-20 makes replays commit-free); replays return
     * the original amount.
     */
    readonly creditsCommitted: number;
}
/** POST /v1/runs/:id/undo → 200 Ok body (M5-SEAMS). */
export interface UndoResponse {
    readonly undone: true;
}
/**
 * Add-only §7.3 Err codes for the apply/undo surface (codes are add-only
 * strings on the wire). `VERSION_CONFLICT` is the M5-SEAMS wire code for the
 * apply-time base/head mismatch (BP M5.5 "re-apply only if base_version_id
 * matches"); the upload path keeps PROJECT_VERSION_CONFLICT (§9.3).
 */
export declare const APPLY_ERROR_CODES: readonly ["VERSION_CONFLICT", "INSUFFICIENT_CREDITS", "RUN_NOT_APPLIED", "RUN_ALREADY_APPLIED", "RUN_NOT_ACTIVE"];
export type ApplyErrorCode = (typeof APPLY_ERROR_CODES)[number];
