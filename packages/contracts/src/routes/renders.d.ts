import { z } from "zod";
import { type Id } from "./common.js";
/** §7.2 render formats: mp4 | prores | png-seq | gif | wav (D-2: all declared). */
export declare const RENDER_FORMATS: readonly ["mp4", "prores", "png-seq", "gif", "wav"];
export declare const RENDER_FORMAT_SCHEMA: z.ZodEnum<{
    mp4: "mp4";
    "png-seq": "png-seq";
    prores: "prores";
    gif: "gif";
    wav: "wav";
}>;
export type RenderFormat = z.infer<typeof RENDER_FORMAT_SCHEMA>;
export declare const RENDER_QUALITY_SCHEMA: z.ZodEnum<{
    draft: "draft";
    good: "good";
    best: "best";
}>;
export type RenderQuality = z.infer<typeof RENDER_QUALITY_SCHEMA>;
/** Render settings (§7.2 `settings`); per-plan quotas are enforced server-side. */
export declare const RENDER_SETTINGS_SCHEMA: z.ZodObject<{
    timeFrom: z.ZodOptional<z.ZodNumber>;
    timeTo: z.ZodOptional<z.ZodNumber>;
    width: z.ZodOptional<z.ZodNumber>;
    height: z.ZodOptional<z.ZodNumber>;
    frameRate: z.ZodOptional<z.ZodNumber>;
    quality: z.ZodOptional<z.ZodEnum<{
        draft: "draft";
        good: "good";
        best: "best";
    }>>;
    extra: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strict>;
export type RenderSettings = z.infer<typeof RENDER_SETTINGS_SCHEMA>;
/**
 * `POST /v1/renders` body (queue a render; §7.2 — idempotent, tenant-scoped).
 * The SERVER pins the version: it captures the project's currentVersionId at
 * queue time (→ RenderJob.versionId); clients never send one.
 */
export declare const QUEUE_RENDER_SCHEMA: z.ZodObject<{
    projectId: z.ZodString;
    compId: z.ZodString;
    format: z.ZodEnum<{
        mp4: "mp4";
        "png-seq": "png-seq";
        prores: "prores";
        gif: "gif";
        wav: "wav";
    }>;
    settings: z.ZodObject<{
        timeFrom: z.ZodOptional<z.ZodNumber>;
        timeTo: z.ZodOptional<z.ZodNumber>;
        width: z.ZodOptional<z.ZodNumber>;
        height: z.ZodOptional<z.ZodNumber>;
        frameRate: z.ZodOptional<z.ZodNumber>;
        quality: z.ZodOptional<z.ZodEnum<{
            draft: "draft";
            good: "good";
            best: "best";
        }>>;
        extra: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strict>;
    idempotencyKey: z.ZodString;
}, z.core.$strict>;
export type QueueRenderRequest = z.infer<typeof QUEUE_RENDER_SCHEMA>;
/**
 * Render statuses — the §9.1 `renders.status` DB vocabulary (D-11: DB wins).
 * Wire v2 flips the old `succeeded` to `completed`; the gateway's legacy
 * completed→succeeded mapping is removed in the M8-G route flip. "succeeded"
 * is no longer accepted anywhere on the render wire.
 */
export declare const RENDER_STATUSES: readonly ["queued", "running", "completed", "failed", "cancelled"];
export declare const RENDER_STATUS_SCHEMA: z.ZodEnum<{
    queued: "queued";
    running: "running";
    completed: "completed";
    failed: "failed";
    cancelled: "cancelled";
}>;
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
/**
 * `POST /v1/renders/estimate` body. Same inputs as queue, minus the key: a
 * PURE READ carries NO idempotencyKey — not in the body, and the gateway
 * exempts the route from the §7.2 Idempotency-Key header gate
 * (IDEMPOTENCY_EXCLUDED_PATHS). Nesting `settings` rules out a query-string
 * GET.
 */
export declare const RENDER_ESTIMATE_REQUEST_SCHEMA: z.ZodObject<{
    projectId: z.ZodString;
    compId: z.ZodString;
    format: z.ZodEnum<{
        mp4: "mp4";
        "png-seq": "png-seq";
        prores: "prores";
        gif: "gif";
        wav: "wav";
    }>;
    settings: z.ZodObject<{
        timeFrom: z.ZodOptional<z.ZodNumber>;
        timeTo: z.ZodOptional<z.ZodNumber>;
        width: z.ZodOptional<z.ZodNumber>;
        height: z.ZodOptional<z.ZodNumber>;
        frameRate: z.ZodOptional<z.ZodNumber>;
        quality: z.ZodOptional<z.ZodEnum<{
            draft: "draft";
            good: "good";
            best: "best";
        }>>;
        extra: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strict>;
}, z.core.$strict>;
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
/**
 * `POST /v1/renders/:id/cancel` body. Mirrors CANCEL_RUN_SCHEMA: an optional
 * human-safe reason; an empty body cancels. Idempotency rides the
 * Idempotency-Key HEADER (§7.2 house mutation convention — 8–128 chars,
 * bounded by IDEMPOTENCY_KEY_SCHEMA, enforced by the gateway POST
 * middleware); it must NOT ride the body (strictObject rejects it).
 */
export declare const CANCEL_RENDER_SCHEMA: z.ZodObject<{
    reason: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type CancelRenderRequest = z.infer<typeof CANCEL_RENDER_SCHEMA>;
/**
 * `GET /v1/renders` query — render history, newest-first, cursor-paginated
 * (house PAGINATION_QUERY_SCHEMA → Page<RenderJob>). Both filters are
 * optional: the workspace scope comes from the session (house rule);
 * `status` accepts only the D-11 vocabulary — "succeeded" is rejected.
 */
export declare const RENDERS_QUERY_SCHEMA: z.ZodObject<{
    cursor: z.ZodOptional<z.ZodString>;
    limit: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    projectId: z.ZodOptional<z.ZodString>;
    status: z.ZodOptional<z.ZodEnum<{
        queued: "queued";
        running: "running";
        completed: "completed";
        failed: "failed";
        cancelled: "cancelled";
    }>>;
}, z.core.$strip>;
export type RendersQuery = z.infer<typeof RENDERS_QUERY_SCHEMA>;
