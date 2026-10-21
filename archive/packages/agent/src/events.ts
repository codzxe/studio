// @studio/agent — SSE run-event payload types. Owner: W1-P (docs/AGENTS.md).
//
// Spec §13.2: events carry `{ seq, run_id, at, type, payload }` on the wire (the
// client dedupes by `seq`, resumes with `Last-Event-ID`). This module defines the
// in-memory shape with `runId` (fleet camelCase); `toWireRunEvent` serializes to
// the exact §13.2 wire keys (`run_id`).
//
// Event type strings are imported from `@studio/config` (W1-B), whose actual
// export shape is `SSE_EVENT_TYPE_KEYS`/`SSE_EVENT_TYPES` (13 exact §13.2
// strings) — re-exported here as `RUN_EVENT_TYPES` for agent consumers; the
// import-time equality check below fails loudly on any drift.
import {
  type RunTierId,
  SSE_EVENT_TYPES,
  SSE_EVENT_TYPE_KEYS,
  type SseEventType,
} from "@studio/config";
import type { Plan } from "./plan.js";
import type { RunPhase } from "./state.js";

// --- Payload types, discriminated by `type` (§13.2) ------------------------------

/** `run.queued` — the run was accepted onto a tier queue (§5.2). */
export interface RunQueuedPayload {
  readonly tier: RunTierId;
}

/** `run.started` — a worker picked it up; §5.6 revision at run start. */
export interface RunStartedPayload {
  readonly revisionBefore: number;
}

/** `run.plan` — the §5.5 plan after schema validation (before any engine command). */
export interface RunPlanPayload {
  readonly plan: Plan;
}

/** `step.started` — one step begins (tool steps carry the tool name). */
export interface StepStartedPayload {
  readonly stepSeq: number;
  readonly phase: RunPhase;
  readonly tool: string | null;
}

/** `step.finished` — one step ended; §5.5 deviations are surfaced, not hidden. */
export interface StepFinishedPayload {
  readonly stepSeq: number;
  readonly phase: RunPhase;
  readonly tool: string | null;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly deviationFromPlan: boolean;
}

/** `preview.updated` — §13.2: URL + revision. */
export interface PreviewUpdatedPayload {
  readonly url: string;
  readonly revision: number;
}

/** `validate.report` — §11.1 deterministic validator outcome (issue codes per level). */
export interface ValidateReportPayload {
  readonly ok: boolean;
  readonly blockers: readonly string[];
  readonly majors: readonly string[];
  readonly minors: readonly string[];
}

/**
 * `critique.report` — §11.2 vision-critic output. Field names mirror the §11.2
 * critic JSON contract exactly (snake_case score keys) so the event can carry the
 * validated critic output without remapping.
 */
export interface CritiqueReportPayload {
  readonly verdict: "accept" | "revise";
  readonly scores: Readonly<{
    hierarchy: number;
    balance: number;
    contrast: number;
    brief_adherence: number;
    brand_fit: number;
    editability: number;
  }>;
  readonly issues: readonly CritiqueIssue[];
}

/** §11.2 critic issue (≤5 in a report; only blocker/major drive repairs). */
export interface CritiqueIssue {
  readonly severity: "blocker" | "major" | "minor";
  readonly code: string;
  readonly layer?: string;
  readonly observation: string;
  readonly fix: string;
}

/** `credits.reserved` — §14.2 hold placed before the run starts. */
export interface CreditsReservedPayload {
  readonly reserved: number;
}

/** `credits.charged` — §14.2: full charge, or partial (rule 4: 0.5 on partial failure). */
export interface CreditsChargedPayload {
  readonly charged: number;
  readonly partial: boolean;
}

/** `run.succeeded` — committed; remaining §5.1 issues ship as warnings. */
export interface RunSucceededPayload {
  readonly revisionAfter: number;
  readonly warnings: readonly string[];
}

/** `run.failed` — terminal §13.3-style envelope; never a stack trace or internal id. */
export interface RunFailedPayload {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly hint?: string;
    readonly retryable?: boolean;
  };
}

/** `run.cancelled` — user or system cancellation; §5.6 rollback applied. */
export interface RunCancelledPayload {
  readonly reason: string;
}

/** Payload type per event type — the discriminated-union source of truth. */
export interface RunEventPayloadMap {
  readonly "run.queued": RunQueuedPayload;
  readonly "run.started": RunStartedPayload;
  readonly "run.plan": RunPlanPayload;
  readonly "step.started": StepStartedPayload;
  readonly "step.finished": StepFinishedPayload;
  readonly "preview.updated": PreviewUpdatedPayload;
  readonly "validate.report": ValidateReportPayload;
  readonly "critique.report": CritiqueReportPayload;
  readonly "credits.reserved": CreditsReservedPayload;
  readonly "credits.charged": CreditsChargedPayload;
  readonly "run.succeeded": RunSucceededPayload;
  readonly "run.failed": RunFailedPayload;
  readonly "run.cancelled": RunCancelledPayload;
}

export type RunEventType = keyof RunEventPayloadMap & SseEventType;

// Compile-time drift guard: the payload map must cover exactly the 13 §13.2 wire
// types from @studio/config (W1-B), in both directions. Resolves to `true`.
type _ExactEventKeys = [SseEventType] extends [keyof RunEventPayloadMap]
  ? [keyof RunEventPayloadMap] extends [SseEventType]
    ? true
    : never
  : never;

/** Internal contract check — resolves to `true`; never import this. */
export type RunEventTypeContract = _ExactEventKeys;

/**
 * The 13 §13.2 event types. Double-checked: `satisfies readonly RunEventType[]`
 * fails compilation if a string is not a payload-mapped @studio/config type, and
 * the import-time loop below fails fast if any §13.2 type is missing here.
 */
export const RUN_EVENT_TYPES = [
  "run.queued",
  "run.started",
  "run.plan",
  "step.started",
  "step.finished",
  "preview.updated",
  "validate.report",
  "critique.report",
  "credits.reserved",
  "credits.charged",
  "run.succeeded",
  "run.failed",
  "run.cancelled",
] as const satisfies readonly RunEventType[];

// Import-time drift check vs @studio/config (W1-B) — fails fast, never silently.
const wireEventTypes = new Set<string>(SSE_EVENT_TYPE_KEYS);
for (const type of RUN_EVENT_TYPES) {
  if (!wireEventTypes.has(type)) {
    throw new Error(`[agent/events] '${type}' is not a §13.2 type in @studio/config`);
  }
  wireEventTypes.delete(type);
}
if (wireEventTypes.size > 0) {
  throw new Error("[agent/events] @studio/config §13.2 types missing a payload here");
}

/** Named emission constants (mirror of @studio/config `SSE_EVENT_TYPES`). */
export const RUN_EVENT_TYPE = SSE_EVENT_TYPES;

/** A fully typed event: payload is discriminated by `type`. */
export interface RunEventFor<T extends RunEventType> {
  readonly seq: number;
  readonly runId: string;
  readonly at: Date;
  readonly type: T;
  readonly payload: RunEventPayloadMap[T];
}

/** The discriminated union of all §13.2 events. */
export type RunEvent = RunEventFor<RunEventType>;

/** The three terminal event types (a client closes the stream after one of these). */
export const TERMINAL_RUN_EVENT_TYPES = ["run.succeeded", "run.failed", "run.cancelled"] as const;

export function isTerminalRunEventType(
  type: RunEventType,
): type is (typeof TERMINAL_RUN_EVENT_TYPES)[number] {
  return (TERMINAL_RUN_EVENT_TYPES as readonly RunEventType[]).includes(type);
}

/** Builds one typed event; the payload type is checked against `type` at compile time. */
export function buildRunEvent<T extends RunEventType>(
  type: T,
  fields: { seq: number; runId: string; at: Date; payload: RunEventPayloadMap[T] },
): RunEventFor<T> {
  return { seq: fields.seq, runId: fields.runId, at: fields.at, type, payload: fields.payload };
}

// --- Wire serialization (§13.2) ----------------------------------------------------

/** The §13.2 wire shape — note the snake_case `run_id`. */
export interface WireRunEvent {
  readonly seq: number;
  readonly run_id: string;
  readonly at: Date;
  readonly type: RunEventType;
  readonly payload: unknown;
}

/** Serializes an in-memory event to the exact §13.2 wire keys. */
export function toWireRunEvent(event: RunEvent): WireRunEvent {
  return {
    seq: event.seq,
    run_id: event.runId,
    at: event.at,
    type: event.type,
    payload: event.payload,
  };
}
