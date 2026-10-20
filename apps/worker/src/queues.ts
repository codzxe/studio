/**
 * Queue topology + job payload contracts for the worker.
 *
 * Spec §3.1 (worker): "one queue per model tier" — §5.2 defines the tiers.
 *
 * Pure module: no BullMQ/ioredis imports, so unit tests run without a broker.
 * The bootstrap in src/index.ts turns these definitions into live Queue and
 * Worker instances.
 */
import { z } from "zod";

/** §5.2 run tiers. */
export const RUN_TIERS = ["quick", "standard", "complex", "premium", "max"] as const;
export type RunTier = (typeof RUN_TIERS)[number];

/** Base queue names. Run queues are derived per tier (see `runQueueName`). */
export const QUEUE_NAMES = {
  runs: "runs",
  exports: "exports",
  images: "images",
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** §5.2: one queue per model tier (runs:quick … runs:max). */
export const RUN_QUEUE_BY_TIER: Record<RunTier, string> = {
  quick: `${QUEUE_NAMES.runs}:quick`,
  standard: `${QUEUE_NAMES.runs}:standard`,
  complex: `${QUEUE_NAMES.runs}:complex`,
  premium: `${QUEUE_NAMES.runs}:premium`,
  max: `${QUEUE_NAMES.runs}:max`,
};

export class InvalidRunTierError extends Error {
  constructor(tier: string) {
    super(`unknown run tier "${tier.slice(0, 32)}" (expected one of: ${RUN_TIERS.join(", ")})`);
    this.name = "InvalidRunTierError";
  }
}

/** Maps a run tier to its physical queue name; runtime-guards untyped callers. */
export function runQueueName(tier: RunTier): string {
  if (!(RUN_TIERS as readonly string[]).includes(tier)) {
    throw new InvalidRunTierError(tier);
  }
  return RUN_QUEUE_BY_TIER[tier];
}

/** Every queue this worker serves: 5 tiered run queues + exports + images. */
export const WORKER_QUEUE_NAMES: readonly string[] = [
  ...RUN_TIERS.map((tier) => RUN_QUEUE_BY_TIER[tier]),
  QUEUE_NAMES.exports,
  QUEUE_NAMES.images,
];

/** §3.4 failure semantics — hard timeouts enforced by the worker/agent loop. */
export const TIMEOUTS_MS = {
  /** per-tool call */
  tool: 5_000,
  /** render pass */
  render: 30_000,
  /** generic per-run cap */
  run: 10 * 60_000,
  /** engine session idle */
  sessionIdle: 15 * 60_000,
} as const;

/** §5.2 tier wall clocks — the per-run AbortSignal deadline in src/index.ts. */
export const TIER_WALL_CLOCK_MS: Record<RunTier, number> = {
  quick: 2 * 60_000,
  standard: 5 * 60_000,
  complex: 10 * 60_000,
  premium: 10 * 60_000,
  max: 15 * 60_000,
};

/** §3.4 crash recovery: retried with backoff; after the last attempt the run is marked failed. */
export const JOB_RETRY = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
} as const;

const identifier = z.string().min(1).max(64);

/**
 * Run payload for the tiered run queues. Producers should pass `runId` as the
 * BullMQ jobId so duplicate enqueues cannot double-apply (§3.4 idempotency).
 */
export const runJobPayloadSchema = z.object({
  runId: identifier,
  organizationId: identifier,
  /** §5.2 tier — selects the queue (runs:<tier>) and the budgets. */
  tier: z.enum(RUN_TIERS),
});
export type RunJobPayload = z.infer<typeof runJobPayloadSchema>;

export const EXPORT_FORMATS = ["pcraft", "png", "jpg", "psd"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * Export payload. Producers should pass `idempotencyKey` as the BullMQ jobId
 * so retries cannot double-render or double-charge (§3.4 idempotency).
 */
export const exportJobPayloadSchema = z.object({
  documentId: identifier,
  format: z.enum(EXPORT_FORMATS),
  /** Optional pixel target; omitted means "document canvas size". */
  width: z.number().int().min(1).max(8192).optional(),
  height: z.number().int().min(1).max(8192).optional(),
  /** JPEG quality, 1–100; ignored for lossless formats. */
  quality: z.number().int().min(1).max(100).optional(),
  idempotencyKey: z.string().min(1).max(128),
});
export type ExportJobPayload = z.infer<typeof exportJobPayloadSchema>;

/** §5.2 image generation — billed per 1024²; size classes cap the render. */
export const IMAGE_SIZE_CLASSES = ["1024x1024", "1536x1024", "1024x1536"] as const;
export type ImageSizeClass = (typeof IMAGE_SIZE_CLASSES)[number];

export const IMAGE_SIZE_RESOLUTIONS: Record<
  ImageSizeClass,
  { readonly width: number; readonly height: number }
> = {
  "1024x1024": { width: 1024, height: 1024 },
  "1536x1024": { width: 1536, height: 1024 },
  "1024x1536": { width: 1024, height: 1536 },
};

export const imageJobPayloadSchema = z.object({
  /** §5.7: user content is data, never instructions — cap string lengths. */
  prompt: z.string().trim().min(1).max(4000),
  sizeClass: z.enum(IMAGE_SIZE_CLASSES),
  /** Owning run, for progress fan-out and cost attribution. */
  runId: identifier,
});
export type ImageJobPayload = z.infer<typeof imageJobPayloadSchema>;

export class InvalidJobPayloadError extends Error {
  readonly issues: readonly string[];

  constructor(
    issues: readonly string[],
    context: { readonly queue: string; readonly jobId?: string },
  ) {
    super(
      `invalid payload for queue "${context.queue}"${
        context.jobId === undefined ? "" : ` (job ${context.jobId})`
      }: ${issues.join("; ")}`,
    );
    this.name = "InvalidJobPayloadError";
    this.issues = issues;
  }
}

/**
 * Parses a job payload at the boundary (Zod at every edge, docs/AGENTS.md).
 * Poison payloads throw so BullMQ marks the job failed after the retry
 * budget (JOB_RETRY, §3.4) — retrying a schema violation can never succeed.
 */
export function parseJobPayload<T>(
  schema: z.ZodType<T>,
  data: unknown,
  context: { readonly queue: string; readonly jobId?: string },
): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new InvalidJobPayloadError(
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      context,
    );
  }
  return parsed.data;
}
