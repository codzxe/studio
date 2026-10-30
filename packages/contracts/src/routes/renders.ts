// @studio/contracts — render queue (PRODUCT_ARCHITECTURE.md §7.2, §9.1 `renders`).
//
// M8 wire v2 (BUILD_PLAN §M8 task 2; DECISIONS D-2/D-11/D-12):
//  - Statuses are the DB vocabulary (D-11 — DB wins): queued | running |
//    completed | failed | cancelled. "succeeded" is GONE from the wire as of
//    v2; the gateway's legacy completed→succeeded mapping is removed in the
//    M8-G route-flip wave.
//  - All five §7.2 formats stay DECLARED (D-2): mp4 | prores | png-seq | gif
//    | wav. Enforcement is downstream — worker/gateway reject the disabled
//    formats with a typed error until they are enabled.
//  - Credits are whole-credit DISPLAY numbers (D-12): the ledger stores
//    integer microcredits and the gateway converts µc→credits at the route
//    boundary; contracts never see µc.
//  - The SERVER pins the version: queueing captures the project's
//    currentVersionId into RenderJob.versionId — clients never send one.
//
// Routes (§7.2). Requests carry Zod schemas (house rule: strictObject);
// responses are the house readonly interfaces the api-client derives its
// response validators from:
//   POST /v1/renders             QUEUE_RENDER_SCHEMA (idempotencyKey in the
//                                body, as first shipped) → RenderJob
//   POST /v1/renders/estimate    RENDER_ESTIMATE_REQUEST_SCHEMA — a PURE
//                                READ: no idempotencyKey anywhere (the
//                                gateway exempts the route from the §7.2
//                                Idempotency-Key header gate) → EstimateResult
//   POST /v1/renders/:id/cancel CANCEL_RENDER_SCHEMA (optional reason);
//                                Idempotency-Key HEADER required (§7.2 house
//                                mutation convention) → RenderJob
//   GET  /v1/renders             RENDERS_QUERY_SCHEMA → Page<RenderJob>
//   GET  /v1/renders/:id         → RenderJob

import { z } from "zod";

import { IDEMPOTENCY_KEY_SCHEMA, ID_SCHEMA, type Id, PAGINATION_QUERY_SCHEMA } from "./common.js";

/** §7.2 render formats: mp4 | prores | png-seq | gif | wav (D-2: all declared). */
export const RENDER_FORMATS = [
  "mp4",
  "prores",
  "png-seq",
  "gif",
  "wav",
] as const satisfies readonly string[];

export const RENDER_FORMAT_SCHEMA = z.enum(RENDER_FORMATS);

export type RenderFormat = z.infer<typeof RENDER_FORMAT_SCHEMA>;

export const RENDER_QUALITY_SCHEMA = z.enum(["draft", "good", "best"]);

export type RenderQuality = z.infer<typeof RENDER_QUALITY_SCHEMA>;

/**
 * BIL-06 (2026-10-30 audit): the frame-rate ceiling for BOTH the requested
 * setting and the effective rate a comp's native metadata may drive. 240
 * covers every practical format (cinema 24, PAL 25, NTSC 29.97, web 60,
 * slow-motion exports up to 240) — anything above is a CPU-farm shape, not
 * a render. The gateway clamps the EFFECTIVE rate (comp-native included)
 * to the same bound; the worker re-clamps before spawning.
 */
export const MAX_RENDER_FRAME_RATE = 240;

/**
 * BIL-06/ENG-05: the per-job FRAME ceiling — ceil(outputSeconds × frameRate).
 * 1.5M frames passes the largest plan's full monthly budget at standard
 * film rates (600 min × 60 s × 30 fps = 1.08M) while capping pathological
 * long-and-fast jobs (the zero-net-credit CPU farm: a hostile comp that
 * refunds fully after burning worker CPU). Jobs above it fail typed with
 * RENDER_QUOTA_EXCEEDED — at queue time (gateway) and again at spawn time
 * (worker, for legacy rows queued before this guard).
 */
export const MAX_RENDER_FRAMES = 1_500_000;

/** Render settings (§7.2 `settings`); per-plan quotas are enforced server-side. */
export const RENDER_SETTINGS_SCHEMA = z
  .strictObject({
    timeFrom: z.number().nonnegative().optional(),
    timeTo: z.number().nonnegative().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    // BIL-06: 1..MAX_RENDER_FRAME_RATE (fractional allowed — 29.97 etc.).
    frameRate: z.number().min(1).max(MAX_RENDER_FRAME_RATE).optional(),
    quality: RENDER_QUALITY_SCHEMA.optional(),
    /** Format-specific passthrough knobs; server validates against the plan. */
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    (settings) =>
      settings.timeFrom === undefined ||
      settings.timeTo === undefined ||
      settings.timeTo >= settings.timeFrom,
    "timeTo must be >= timeFrom",
  );

export type RenderSettings = z.infer<typeof RENDER_SETTINGS_SCHEMA>;

/**
 * `POST /v1/renders` body (queue a render; §7.2 — idempotent, tenant-scoped).
 * The SERVER pins the version: it captures the project's currentVersionId at
 * queue time (→ RenderJob.versionId); clients never send one.
 */
export const QUEUE_RENDER_SCHEMA = z.strictObject({
  projectId: z.string().min(1),
  compId: z.string().min(1),
  format: RENDER_FORMAT_SCHEMA,
  settings: RENDER_SETTINGS_SCHEMA,
  idempotencyKey: IDEMPOTENCY_KEY_SCHEMA,
});

export type QueueRenderRequest = z.infer<typeof QUEUE_RENDER_SCHEMA>;

/**
 * Render statuses — the §9.1 `renders.status` DB vocabulary (D-11: DB wins).
 * Wire v2 flips the old `succeeded` to `completed`; the gateway's legacy
 * completed→succeeded mapping is removed in the M8-G route flip. "succeeded"
 * is no longer accepted anywhere on the render wire.
 */
export const RENDER_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly string[];

export const RENDER_STATUS_SCHEMA = z.enum(RENDER_STATUSES);

export type RenderStatus = z.infer<typeof RENDER_STATUS_SCHEMA>;

/**
 * Worker progress snapshot carried on every RenderJob. `percent` is an
 * integer 0..100 computed server-side — the UI never re-derives it.
 */
export interface RenderProgress {
  readonly framesDone: number;
  readonly framesTotal: number;
  /** Integer 0..100. */
  readonly percent: number;
}

/**
 * One `renders` row on the wire — `GET /v1/renders/:id`, the queue/cancel
 * mutations and the history list all return this shape (§9.1; BP §M8 task 2
 * "render history with status, error, credits, expiry").
 */
export interface RenderJob {
  readonly id: Id;
  readonly projectId: Id;
  readonly compId: Id;
  /** Project version pinned at queue time (server captures the current head). */
  readonly versionId: Id;
  readonly format: RenderFormat;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly status: RenderStatus;
  /** Set once the user asked to cancel; the job then lands in `cancelled`. */
  readonly cancelRequested: boolean;
  /** Latest worker progress snapshot (0/0/0 while queued). */
  readonly progress: RenderProgress;
  /**
   * Whole-credit DISPLAY number (D-12: µc live in the integer ledger; the
   * gateway converts at the route boundary — contracts never see µc); null
   * until priced/charged.
   */
  readonly credits: number | null;
  readonly resultUrl: string | null;
  /** Stable machine code (e.g. RENDER_TIMEOUT); null unless status = failed. */
  readonly errorCode: string | null;
  /** Human-safe failure copy; null unless status = failed. */
  readonly error: string | null;
  /** Output artifact size in bytes; null until the artifact exists. */
  readonly sizeBytes: number | null;
  readonly createdBy: Id;
  readonly createdAt: string;
  /** When the worker picked the job up; null while queued. */
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  /** When the signed download expires (retention by plan, BP §M8 task 4). */
  readonly expiresAt: string | null;
}

// ---------------------------------------------------------------------------
// Estimate — BP §M8 task 2 "credit estimate" (a pure read)
// ---------------------------------------------------------------------------

/**
 * `POST /v1/renders/estimate` body. Same inputs as queue, minus the key: a
 * PURE READ carries NO idempotencyKey — not in the body, and the gateway
 * exempts the route from the §7.2 Idempotency-Key header gate
 * (IDEMPOTENCY_EXCLUDED_PATHS). Nesting `settings` rules out a query-string
 * GET.
 */
export const RENDER_ESTIMATE_REQUEST_SCHEMA = z.strictObject({
  projectId: z.string().min(1),
  compId: z.string().min(1),
  format: RENDER_FORMAT_SCHEMA,
  settings: RENDER_SETTINGS_SCHEMA,
});

export type RenderEstimateRequest = z.infer<typeof RENDER_ESTIMATE_REQUEST_SCHEMA>;

/** `POST /v1/renders/estimate` → the queue-dialog numbers before committing. */
export interface EstimateResult {
  /** Whole-credit DISPLAY estimate (D-12; µc never crosses the wire). */
  readonly credits: number;
  /** Rendered output duration in seconds. */
  readonly outputSeconds: number;
  /** Output long edge in pixels (D-7 caps PREVIEWS at 1280; finals are quota-enforced server-side). */
  readonly longEdgePx: number;
  readonly format: RenderFormat;
  /** Effective quality after defaults — the estimate reflects it. */
  readonly quality: RenderQuality;
  /** True when the platform minimum charge was applied (raw estimate below it). */
  readonly minApplied: boolean;
}

// ---------------------------------------------------------------------------
// Cancel — BP §M8 task 1 "cancellation"
// ---------------------------------------------------------------------------

/**
 * `POST /v1/renders/:id/cancel` body. Mirrors CANCEL_RUN_SCHEMA: an optional
 * human-safe reason; an empty body cancels. Idempotency rides the
 * Idempotency-Key HEADER (§7.2 house mutation convention — 8–128 chars,
 * bounded by IDEMPOTENCY_KEY_SCHEMA, enforced by the gateway POST
 * middleware); it must NOT ride the body (strictObject rejects it).
 */
export const CANCEL_RENDER_SCHEMA = z.strictObject({
  reason: z.string().max(280).optional(),
});

export type CancelRenderRequest = z.infer<typeof CANCEL_RENDER_SCHEMA>;

// ---------------------------------------------------------------------------
// History list — BP §M8 task 2 "render history"
// ---------------------------------------------------------------------------

/**
 * `GET /v1/renders` query — render history, newest-first, cursor-paginated
 * (house PAGINATION_QUERY_SCHEMA → Page<RenderJob>). Both filters are
 * optional: the workspace scope comes from the session (house rule);
 * `status` accepts only the D-11 vocabulary — "succeeded" is rejected.
 */
export const RENDERS_QUERY_SCHEMA = PAGINATION_QUERY_SCHEMA.extend({
  projectId: ID_SCHEMA.optional(),
  status: RENDER_STATUS_SCHEMA.optional(),
});

export type RendersQuery = z.infer<typeof RENDERS_QUERY_SCHEMA>;
