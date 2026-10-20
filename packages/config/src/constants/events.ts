// @studio/config — SSE event type strings, spec §13.2 (exact list).
// Events carry `{ seq, run_id, at, type, payload }`; the client dedupes by `seq`
// and resumes with `Last-Event-ID`. Codes are stable wire strings — never rename.
import { z } from 'zod';

export const SSE_EVENT_TYPE_KEYS = [
  'run.queued',
  'run.started',
  'run.plan',
  'step.started',
  'step.finished',
  'preview.updated',
  'validate.report',
  'critique.report',
  'credits.reserved',
  'credits.charged',
  'run.succeeded',
  'run.failed',
  'run.cancelled',
] as const satisfies readonly string[];

/** Zod schema for the wire `type` field of an SSE event (§13.2). */
export const SSE_EVENT_TYPE_SCHEMA = z.enum(SSE_EVENT_TYPE_KEYS);

export type SseEventType = z.infer<typeof SSE_EVENT_TYPE_SCHEMA>;

/** Type guard for untrusted event payloads at the client boundary. */
export function isSseEventType(value: unknown): value is SseEventType {
  return SSE_EVENT_TYPE_SCHEMA.safeParse(value).success;
}

/** Named constants for emitting/consuming SSE events (§13.2). */
export const SSE_EVENT_TYPES = {
  runQueued: 'run.queued',
  runStarted: 'run.started',
  runPlan: 'run.plan',
  stepStarted: 'step.started',
  stepFinished: 'step.finished',
  previewUpdated: 'preview.updated',
  validateReport: 'validate.report',
  critiqueReport: 'critique.report',
  creditsReserved: 'credits.reserved',
  creditsCharged: 'credits.charged',
  runSucceeded: 'run.succeeded',
  runFailed: 'run.failed',
  runCancelled: 'run.cancelled',
} as const satisfies Record<string, SseEventType>;

/** Every distinct event type, derived from the constant object. */
export const SSE_EVENT_TYPE_VALUES: readonly SseEventType[] = Object.values(SSE_EVENT_TYPES);

/** Wire shape of an SSE event (§13.2: `{ seq, run_id, at, type, payload }`). */
export const SSE_EVENT_SCHEMA = z
  .object({
    seq: z.number().int().min(0),
    run_id: z.string().min(1),
    at: z.coerce.date(),
    type: SSE_EVENT_TYPE_SCHEMA,
    payload: z.unknown(),
  })
  .strict();

export type SseEvent = z.infer<typeof SSE_EVENT_SCHEMA>;
