// @studio/contracts — /v1/runs/:id/apply + /undo request/response schemas
// (M5 seam, BUILD_PLAN §M5.4/§M5.5).
//
// STUB — M5-E owns this file in Wave 1 and replaces this content with the
// full wire schemas per M5-SEAMS.md. Envelope rules (law #1/#4) apply:
// idempotency keys required on every mutation, cross-tenant = 404.
import { z } from "zod";

/** POST /v1/runs/:id/apply request body (M5-SEAMS pinned interface). */
export const APPLY_REQUEST_SCHEMA = z.object({
  batchSha256: z.string().min(64).max(64),
  versionId: z.string().min(1),
  idempotencyKey: z.string().min(8).max(128),
});

export type ApplyRequest = z.infer<typeof APPLY_REQUEST_SCHEMA>;

/** POST /v1/runs/:id/undo request body. */
export const UNDO_REQUEST_SCHEMA = z.object({
  idempotencyKey: z.string().min(8).max(128),
});

export type UndoRequest = z.infer<typeof UNDO_REQUEST_SCHEMA>;
