// @studio/contracts — render queue (PRODUCT_ARCHITECTURE.md §7.2, §9.1 `renders`).

import { z } from "zod";

import { IDEMPOTENCY_KEY_SCHEMA, type Id } from "./common.js";

/** §7.2 render formats: mp4 | prores | png-seq | gif | wav. */
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

/** Render settings (§7.2 `settings`); per-plan quotas are enforced server-side. */
export const RENDER_SETTINGS_SCHEMA = z
  .strictObject({
    timeFrom: z.number().nonnegative().optional(),
    timeTo: z.number().nonnegative().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    frameRate: z.number().positive().optional(),
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

/** `POST /v1/renders` body (queue a render; §7.2 — idempotent, tenant-scoped). */
export const QUEUE_RENDER_SCHEMA = z.strictObject({
  projectId: z.string().min(1),
  compId: z.string().min(1),
  format: RENDER_FORMAT_SCHEMA,
  settings: RENDER_SETTINGS_SCHEMA,
  idempotencyKey: IDEMPOTENCY_KEY_SCHEMA,
});

export type QueueRenderRequest = z.infer<typeof QUEUE_RENDER_SCHEMA>;

export const RENDER_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const satisfies readonly string[];

export type RenderStatus = (typeof RENDER_STATUSES)[number];

/** `GET /v1/renders/:id` row (§9.1 `renders`). */
export interface RenderJob {
  readonly id: Id;
  readonly projectId: Id;
  readonly compId: Id;
  readonly format: RenderFormat;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly status: RenderStatus;
  readonly credits: number | null;
  readonly resultUrl: string | null;
  readonly error: string | null;
  readonly createdBy: Id;
  readonly createdAt: string;
  readonly completedAt: string | null;
}
