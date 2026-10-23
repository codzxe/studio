// @studio/contracts — /v1/runs/:id/apply + /undo wire schemas (M5 seam,
// BUILD_PLAN §M5.4/§M5.5; PRODUCT_ARCHITECTURE.md §8.7 apply/undo/version).
//
// The client flow this body pins (§8.7, M5-SEAMS): ONE atomic
// `effectcraft.execute("engine.batch", compiled)` → autosave
// `saveNow("agent-apply")` (D-6) → the created version is uploaded via
// POST /v1/projects/:id/versions with `agentRunId` = the run id → POST
// /v1/runs/:id/apply records the apply server-side and COMMITS the plan
// credits (§8.8; D-20: settle releases the full hold). Undo reverts the ONE
// batch via `edit.undo` client-side; POST /v1/runs/:id/undo records it —
// version rows are NEVER deleted (§9.3).
//
// Envelope rules (law #1/#4): the gateway requires an `Idempotency-Key`
// HEADER on every POST /v1/* mutation (§7.2) — the body key below is the
// logical operation id; a replayed key returns the original answer. Zod at
// the boundary; cross-tenant ids read as 404, never 403.
import { z } from "zod";
import { IDEMPOTENCY_KEY_SCHEMA, ID_SCHEMA, SHA256_SCHEMA } from "./common.js";
/**
 * One client-side layer resolution posted with the apply (§8.7): the plan
 * compiler referenced a layer BY NAME; the client resolved the id against
 * the live editor (ids never enter the model context, §8.7). Bounded, and
 * validated at the boundary even though the batch already ran client-side.
 */
export const RESOLVED_LAYER_SCHEMA = z.strictObject({
    requestId: ID_SCHEMA,
    layerId: ID_SCHEMA,
});
/** POST /v1/runs/:id/apply request body (M5-SEAMS pinned interface). */
export const APPLY_REQUEST_SCHEMA = z.strictObject({
    /** sha256 of the executed compiled agent batch (content-addressed proof, §8.5). */
    batchSha256: SHA256_SCHEMA,
    /** The version `saveNow("agent-apply")` created and uploaded with `agentRunId`. */
    versionId: ID_SCHEMA,
    /** Logical operation id — replays return the original outcome (§7.2). */
    idempotencyKey: IDEMPOTENCY_KEY_SCHEMA,
    /** Name→id resolutions the client made before executing the batch. */
    resolvedLayers: z.array(RESOLVED_LAYER_SCHEMA).max(50).optional(),
});
/** POST /v1/runs/:id/undo request body. */
export const UNDO_REQUEST_SCHEMA = z.strictObject({
    idempotencyKey: IDEMPOTENCY_KEY_SCHEMA,
});
/**
 * Add-only §7.3 Err codes for the apply/undo surface (codes are add-only
 * strings on the wire). `VERSION_CONFLICT` is the M5-SEAMS wire code for the
 * apply-time base/head mismatch (BP M5.5 "re-apply only if base_version_id
 * matches"); the upload path keeps PROJECT_VERSION_CONFLICT (§9.3).
 */
export const APPLY_ERROR_CODES = [
    "VERSION_CONFLICT",
    "INSUFFICIENT_CREDITS",
    "RUN_NOT_APPLIED",
    // gateway-only additions for this surface (documented; add-only)
    "RUN_ALREADY_APPLIED",
    "RUN_NOT_ACTIVE",
];
//# sourceMappingURL=apply.js.map