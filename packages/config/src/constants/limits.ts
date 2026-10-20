// @studio/config — runtime limits: uploads, run caps, engine automation budgets,
// canvas ceilings, reply budgets. Sources: §2.2 (budgets.rs), §2.3, §3.2/§3.4,
// §5.1, §14.1 (plan-gated limits), §20.2 (upload caps).
import { z } from 'zod';
import type { PlanId } from './pricing.js';

// --- Uploads (§20.2: JPEG/PNG, 25 MB cap, EXIF stripped, 60 MP bomb rejected) ---

/** Hard cap per uploaded file: 25 MB. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Reject uploads above 60 megapixels with a clear error (§20.2). */
export const MAX_UPLOAD_MEGAPIXELS = 60;

/** Accepted upload content types (§20.2). */
export const UPLOAD_MIME_TYPES = ['image/jpeg', 'image/png'] as const satisfies readonly string[];

export const UPLOAD_MIME_TYPE_SCHEMA = z.enum(UPLOAD_MIME_TYPES);

// --- Engine automation budgets (§2.2 — vendor crates/automation/src/budgets.rs) ---

/** Reply/output limit: 8 MiB per engine reply. */
export const ENGINE_REPLY_MAX_BYTES = 8 * 1024 * 1024;

/** Rendered PNG output limit: 5 MiB. */
export const ENGINE_PNG_MAX_BYTES = 5 * 1024 * 1024;

/** Preview long-edge limit: 2048 px. */
export const ENGINE_PREVIEW_MAX_PX = 2048;

/**
 * Hard canvas ceiling: 64 MP, already enforced by automation budgets (§2.2/§2.3).
 * NOTE (§14.1): per-plan max canvas is 32/64/128 MP; the business plan exceeds this
 * engine-side ceiling, so its budget must be raised before the plan can ship.
 */
export const ENGINE_MAX_CANVAS_MEGAPIXELS = 64;

/** Agent observe loop renders a ≤1024 px PNG after each phase (§5.1). */
export const AGENT_OBSERVE_PREVIEW_PX = 1024;

/** Default document preview width (§13.1: GET /v1/documents/:id/preview?w=1024). */
export const PREVIEW_DEFAULT_WIDTH_PX = 1024;

/** Image generation tier target: each 1024² image (§5.2). */
export const IMAGE_GENERATION_EDGE_PX = 1024;

// --- Run caps (§5.1, §3.4, §20.13) ---

/** §5.1: max repair cycles; afterwards ship `succeeded_with_warnings`. */
export const MAX_REPAIR_CYCLES = 2;

/** §5.1: an invalid plan gets exactly one retry with the validation errors attached. */
export const PLAN_RETRY_LIMIT = 1;

/** §3.4: queue job retried with backoff ×3 before the run is marked failed. */
export const QUEUE_JOB_RETRIES = 3;

/** §3.4: after an engine crash the command log is replayed and the run resumed once. */
export const ENGINE_CRASH_RESUME_LIMIT = 1;

/** §20.13: a run killed mid-execution recovers within 60 s or fails cleanly with a refund. */
export const CRASH_RECOVERY_WINDOW_SECONDS = 60;

/**
 * §5.7: cap total mutating commands per run. The spec fixes no number; this is a
 * policy constant, deliberately generous (complex tier allows 24 tool calls, each
 * tool may batch several commands).
 */
export const MAX_MUTATING_COMMANDS_PER_RUN = 256;

// --- Per-plan runtime limits (§14.1) ---
// Plan differences: seats (1/3/10), concurrent runs (1/3/6), max canvas (32/64/128 MP).
// Concurrent sessions per tenant follow the same 1/3/6 ladder (§3.2: "at most N
// concurrent sessions (plan limit)").

const planLimitsSchema = z
  .object({
    seats: z.number().int().min(1),
    concurrentRuns: z.number().int().min(1),
    concurrentSessions: z.number().int().min(1),
    maxCanvasMegapixels: z.number().int().min(1),
  })
  .strict();

export type PlanLimits = z.infer<typeof planLimitsSchema>;

const PLAN_LIMITS_TABLE: Record<PlanId, PlanLimits> = {
  starter: { seats: 1, concurrentRuns: 1, concurrentSessions: 1, maxCanvasMegapixels: 32 },
  pro: { seats: 3, concurrentRuns: 3, concurrentSessions: 3, maxCanvasMegapixels: 64 },
  business: { seats: 10, concurrentRuns: 6, concurrentSessions: 6, maxCanvasMegapixels: 128 },
};

export const PLAN_LIMITS_SCHEMA = z
  .object({
    starter: planLimitsSchema,
    pro: planLimitsSchema,
    business: planLimitsSchema,
  })
  .strict();

/** Per-plan runtime limits (§14.1), validated by Zod at import time. */
export const PLAN_LIMITS: Record<PlanId, PlanLimits> = PLAN_LIMITS_SCHEMA.parse(
  PLAN_LIMITS_TABLE,
);

export function planLimits(plan: PlanId): PlanLimits {
  const limits: PlanLimits | undefined = PLAN_LIMITS[plan];
  if (limits === undefined) {
    // Defence for untyped (JS) callers — the type system prevents this in TS.
    throw new Error(`[config] no limits for plan: ${plan}`);
  }
  return limits;
}
