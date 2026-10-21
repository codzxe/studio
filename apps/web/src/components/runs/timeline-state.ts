// apps/web — run timeline pure core (W8-E). Owner: W8-E (docs/AGENTS.md).
//
// Spec anchors:
//   §13.2  the 13 SSE event types and their payloads; seq dedupe + Last-Event-ID.
//   §5.5   the plan card fields (intent / template / checks / notes_for_user,
//          steps, palette, typography) + "agent deviated from plan" surfacing.
//   §5.1   run state machine (queued → phases → succeeded | succeeded_with_
//          warnings | failed | cancelled); step phases.
//   §13.1  GET /v1/runs/:id — status + plan + steps summary + cost.
//   §20 #5 the timeline streams plan → steps → previews → verdicts.
//   §24.4 one-click retry of a failed run (needs the original brief client-side).
//
// This module is the browser-side mirror of two server contracts the web app
// must NOT import directly (@studio/agent would drag the whole agent into the
// browser bundle; the gateway is a separate service):
//   - packages/agent/src/events.ts — the §13.2 payload types (camelCase keys),
//   - apps/gateway/src/services/runs.ts — RunDetailApiView (snake_case keys).
// Both are mirrored as Zod schemas so a drifting server can never crash the
// page: malformed events/steps are skipped, never thrown (the live timeline
// degrades, it does not wedge — §13.2's "never let the stream wedge" rule).
//
// Pure by design: no React, no fetch, no timers — deterministically unit-tested
// in timeline-state.test.ts.

import { z } from "zod";

// ---------------------------------------------------------------------------
// §5.1 mirrors — statuses, phases, terminal states
// ---------------------------------------------------------------------------

/** packages/db RUN_STATUSES mirror (§5.1) — 9 live phases/states + 4 terminal. */
export const RUN_STATUS_NAMES = [
  "queued",
  "planning",
  "executing",
  "observing",
  "rendering",
  "validating",
  "critiquing",
  "repairing",
  "finalizing",
  "succeeded",
  "succeeded_with_warnings",
  "failed",
  "cancelled",
] as const satisfies readonly string[];

export type RunStatusName = (typeof RUN_STATUS_NAMES)[number];

/** §5.1 terminal states — a run in one of these is finished, not cancellable. */
export const TERMINAL_RUN_STATUSES = [
  "succeeded",
  "succeeded_with_warnings",
  "failed",
  "cancelled",
] as const satisfies readonly RunStatusName[];

export function isTerminalRunStatus(status: RunStatusName): boolean {
  return (TERMINAL_RUN_STATUSES as readonly RunStatusName[]).includes(status);
}

/** packages/db RUN_PHASES mirror (§5.1) — the 8 phases a step may belong to. */
export const RUN_PHASE_NAMES = [
  "planning",
  "executing",
  "observing",
  "rendering",
  "validating",
  "critiquing",
  "repairing",
  "finalizing",
] as const satisfies readonly string[];

export type RunPhaseName = (typeof RUN_PHASE_NAMES)[number];

const runPhaseSchema = z.enum(RUN_PHASE_NAMES);

// ---------------------------------------------------------------------------
// §13.2 event type names (mirror of apps/web/src/lib/api.ts RUN_EVENT_TYPES)
// ---------------------------------------------------------------------------

export type RunEventTypeName =
  | "run.queued"
  | "run.started"
  | "run.plan"
  | "step.started"
  | "step.finished"
  | "preview.updated"
  | "validate.report"
  | "critique.report"
  | "credits.reserved"
  | "credits.charged"
  | "run.succeeded"
  | "run.failed"
  | "run.cancelled";

// ---------------------------------------------------------------------------
// Shared wire types (§13.3 envelope shape — code/message/hint/retryable)
// ---------------------------------------------------------------------------

/** Typed failure envelope (§13.3) — detail.error and run.failed share it. */
export interface RunFailure {
  readonly code: string;
  readonly message: string;
  readonly hint?: string;
  readonly retryable?: boolean;
}

const runFailureSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  hint: z.string().optional(),
  retryable: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// §5.5 plan view (lenient browser mirror of packages/agent planSchema)
// ---------------------------------------------------------------------------

/** §5.5 `intent` — exactly these five. */
export const PLAN_INTENT_NAMES = [
  "create_post",
  "edit_layers",
  "resize",
  "variant",
  "export",
] as const satisfies readonly string[];

export type PlanIntentName = (typeof PLAN_INTENT_NAMES)[number];

/** The §5.5 fields the timeline renders; unknown extras are tolerated. */
export interface PlanView {
  readonly intent: PlanIntentName;
  readonly template: string | null;
  readonly assets: readonly { readonly ref: string; readonly slot: string; readonly fit?: string }[];
  readonly slots: Readonly<Record<string, string>>;
  readonly palette: readonly string[];
  readonly typography: Readonly<Record<string, Record<string, string | number | boolean>>>;
  readonly steps: readonly { readonly tool: string }[];
  readonly checks: readonly string[];
  readonly modelTier: string | null;
  readonly notesForUser: string;
}

/**
 * Wire (§5.5 snake_case keys) → `PlanView`. The `.transform` tail makes
 * `z.infer` EXACTLY `PlanView`, so the run.plan payload schema below is bound
 * to `RunPlanPayload` at compile time. Lenient: additive server fields pass.
 */
const planViewWireSchema = z
  .object({
    intent: z.enum(PLAN_INTENT_NAMES),
    template: z.string().min(1).nullable(),
    assets: z
      .array(
        z.object({ ref: z.string().min(1), slot: z.string().min(1), fit: z.string().optional() }),
      )
      .default([]),
    slots: z.record(z.string(), z.string()).default({}),
    palette: z.array(z.string()).default([]),
    typography: z
      .record(z.string(), z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])))
      .default({}),
    steps: z.array(z.object({ tool: z.string().min(1) })).default([]),
    checks: z.array(z.string()).default([]),
    model_tier: z.string().optional(),
    notes_for_user: z.string().default(""),
  })
  .transform(
    (value): PlanView => ({
      intent: value.intent,
      template: value.template,
      assets: value.assets.map((asset) => ({ ref: asset.ref, slot: asset.slot, fit: asset.fit })),
      slots: value.slots,
      palette: value.palette,
      typography: value.typography,
      steps: value.steps.map((step) => ({ tool: step.tool })),
      checks: value.checks,
      modelTier: value.model_tier ?? null,
      notesForUser: value.notes_for_user,
    }),
  );

/** Parses an untrusted §5.5 plan (detail.plan or run.plan payload); null on drift. */
export function parsePlanView(input: unknown): PlanView | null {
  const parsed = planViewWireSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// §13.2 payload types (mirror of packages/agent/src/events.ts, camelCase)
// ---------------------------------------------------------------------------

/** `run.queued` — the run was accepted onto a tier queue (§5.2). */
export interface RunQueuedPayload {
  readonly tier: string;
}

/** `run.started` — a worker picked it up (§5.6 revision at run start). */
export interface RunStartedPayload {
  readonly revisionBefore: number;
}

/** `run.plan` — the §5.5 plan after schema validation. */
export interface RunPlanPayload {
  readonly plan: PlanView;
}

/** `step.started` — one step begins; tool steps carry the tool name. */
export interface StepStartedPayload {
  readonly stepSeq: number;
  readonly phase: RunPhaseName;
  readonly tool: string | null;
}

/** `step.finished` — one step ended; deviations are surfaced, not hidden (§5.5). */
export interface StepFinishedPayload {
  readonly stepSeq: number;
  readonly phase: RunPhaseName;
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

/** `validate.report` — §11.1 validator outcome (issue codes by level). */
export interface ValidateReportPayload {
  readonly ok: boolean;
  readonly blockers: readonly string[];
  readonly majors: readonly string[];
  readonly minors: readonly string[];
}

/** §11.2 critic issue (≤5 per report; only blocker/major drive repairs). */
export interface CritiqueIssue {
  readonly severity: "blocker" | "major" | "minor";
  readonly code: string;
  readonly layer?: string;
  readonly observation: string;
  readonly fix: string;
}

/** `critique.report` — §11.2 vision-critic output (snake_case score keys). */
export interface CritiqueReportPayload {
  readonly verdict: "accept" | "revise";
  readonly scores: {
    readonly hierarchy: number;
    readonly balance: number;
    readonly contrast: number;
    readonly brief_adherence: number;
    readonly brand_fit: number;
    readonly editability: number;
  };
  readonly issues: readonly CritiqueIssue[];
}

/** `credits.reserved` — §14.2 hold placed before the run starts. */
export interface CreditsReservedPayload {
  readonly reserved: number;
}

/** `credits.charged` — §14.2 full charge, or partial (rule 4). */
export interface CreditsChargedPayload {
  readonly charged: number;
  readonly partial: boolean;
}

/** `run.succeeded` — committed; remaining issues ship as warnings (§5.1). */
export interface RunSucceededPayload {
  readonly revisionAfter: number;
  readonly warnings: readonly string[];
}

/** `run.failed` — terminal §13.3-style envelope; never a stack trace. */
export interface RunFailedPayload {
  readonly error: RunFailure;
}

/** `run.cancelled` — user or system cancellation (§5.6 rollback applied). */
export interface RunCancelledPayload {
  readonly reason: string;
}

/** Payload per event type — the discriminated-union source of truth. */
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

// --- Zod payload schemas — one per §13.2 type, bound to the payload map ------

const runQueuedPayloadSchema = z.object({ tier: z.string().min(1) });
const runStartedPayloadSchema = z.object({ revisionBefore: z.number().nonnegative() });
const runPlanPayloadSchema = z.object({ plan: planViewWireSchema });
const stepStartedPayloadSchema = z.object({
  stepSeq: z.number().nonnegative(),
  phase: runPhaseSchema,
  tool: z.string().min(1).nullable(),
});
const stepFinishedPayloadSchema = z.object({
  stepSeq: z.number().nonnegative(),
  phase: runPhaseSchema,
  tool: z.string().min(1).nullable(),
  ok: z.boolean(),
  durationMs: z.number().nonnegative(),
  deviationFromPlan: z.boolean(),
});
const previewUpdatedPayloadSchema = z.object({
  url: z.string().min(1),
  revision: z.number().nonnegative(),
});
const validateReportPayloadSchema = z.object({
  ok: z.boolean(),
  blockers: z.array(z.string()),
  majors: z.array(z.string()),
  minors: z.array(z.string()),
});
const critiqueIssueSchema = z.object({
  severity: z.enum(["blocker", "major", "minor"]),
  code: z.string().min(1),
  layer: z.string().optional(),
  observation: z.string(),
  fix: z.string(),
});
const critiqueReportPayloadSchema = z.object({
  verdict: z.enum(["accept", "revise"]),
  scores: z.object({
    hierarchy: z.number(),
    balance: z.number(),
    contrast: z.number(),
    brief_adherence: z.number(),
    brand_fit: z.number(),
    editability: z.number(),
  }),
  issues: z.array(critiqueIssueSchema),
});
const creditsReservedPayloadSchema = z.object({ reserved: z.number().nonnegative() });
const creditsChargedPayloadSchema = z.object({
  charged: z.number().nonnegative(),
  partial: z.boolean(),
});
const runSucceededPayloadSchema = z.object({
  revisionAfter: z.number().nonnegative(),
  warnings: z.array(z.string()),
});
const runFailedPayloadSchema = z.object({ error: runFailureSchema });
const runCancelledPayloadSchema = z.object({ reason: z.string() });

/**
 * Schema per event type — `satisfies` binds every schema to its payload-map
 * entry so a schema/payload drift is a compile error, not a runtime surprise.
 */
const RUN_EVENT_PAYLOAD_SCHEMAS = {
  "run.queued": runQueuedPayloadSchema,
  "run.started": runStartedPayloadSchema,
  "run.plan": runPlanPayloadSchema,
  "step.started": stepStartedPayloadSchema,
  "step.finished": stepFinishedPayloadSchema,
  "preview.updated": previewUpdatedPayloadSchema,
  "validate.report": validateReportPayloadSchema,
  "critique.report": critiqueReportPayloadSchema,
  "credits.reserved": creditsReservedPayloadSchema,
  "credits.charged": creditsChargedPayloadSchema,
  "run.succeeded": runSucceededPayloadSchema,
  "run.failed": runFailedPayloadSchema,
  "run.cancelled": runCancelledPayloadSchema,
} as const satisfies {
  readonly [K in keyof RunEventPayloadMap]: z.ZodType<RunEventPayloadMap[K], z.ZodTypeDef, unknown>;
};

// ---------------------------------------------------------------------------
// Event parse — one typed event, all 13 types
// ---------------------------------------------------------------------------

/** One parsed §13.2 event: seq + timestamp + a payload discriminated by type. */
export type ParsedRunEvent = {
  readonly seq: number;
  readonly atMs: number;
} & {
  readonly [K in keyof RunEventPayloadMap]: {
    readonly type: K;
    readonly payload: RunEventPayloadMap[K];
  };
}[keyof RunEventPayloadMap];

/** Minimal structural input — the W1-K `RunEvent` satisfies it. */
export interface WireEventInput {
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
  readonly at: Date | string | number;
}

function toMs(at: Date | string | number): number {
  const ms = at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.parse(at);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Schema-validates one wire event into the typed union; null for unknown types
 * or malformed payloads (defensive §13.2: skip, never wedge the timeline).
 */
export function parseRunEvent(event: WireEventInput): ParsedRunEvent | null {
  const type = event.type as keyof RunEventPayloadMap;
  // The untrusted `type` string is cast for the lookup, so the value is widened
  // to `| undefined` — an unknown type drops the event instead of crashing.
  const schema = RUN_EVENT_PAYLOAD_SCHEMAS[type] as
    | z.ZodType<RunEventPayloadMap[keyof RunEventPayloadMap], z.ZodTypeDef, unknown>
    | undefined;
  if (schema === undefined) {
    return null;
  }
  const parsed = schema.safeParse(event.payload);
  if (!parsed.success) {
    return null;
  }
  // The type↔payload correlation is guaranteed by RUN_EVENT_PAYLOAD_SCHEMAS's
  // `satisfies` binding (the schema was chosen by this very `type`); the cast
  // only re-correlates what TS cannot track through a dynamic keyed lookup.
  return { seq: event.seq, atMs: toMs(event.at), type, payload: parsed.data } as ParsedRunEvent;
}

// ---------------------------------------------------------------------------
// §13.2 seq dedupe — monotonic event store
// ---------------------------------------------------------------------------

/** Parsed events keyed by seq, appended strictly monotonically (§13.2). */
export type RunEventStore = ReadonlyMap<number, ParsedRunEvent>;

/**
 * Appends one event unless it is a §13.2 duplicate or regression — i.e. its
 * seq was already seen, or sits below the high-water mark (the gateway replays
 * backfill after every reconnect; the stream dedupes, this is the second line
 * of defense for StrictMode double-streams and resync-gap replays).
 */
export function mergeRunEvent(store: RunEventStore, event: ParsedRunEvent): RunEventStore {
  let highWater = 0;
  for (const seq of store.keys()) {
    if (seq > highWater) {
      highWater = seq;
    }
  }
  if (event.seq <= highWater || store.has(event.seq)) {
    return store; // replayed/older — drop (§13.2 dedupe)
  }
  const next = new Map(store);
  next.set(event.seq, event);
  return next;
}

/** Store contents in ascending seq order (the run's chronological history). */
export function orderedRunEvents(store: RunEventStore): readonly ParsedRunEvent[] {
  return [...store.values()].sort((a, b) => a.seq - b.seq);
}

// ---------------------------------------------------------------------------
// §13.1 GET /v1/runs/:id — run detail (snake_case mirror of RunDetailApiView)
// ---------------------------------------------------------------------------

const runStepWireSchema = z.object({
  seq: z.number().nonnegative(),
  phase: z.string().min(1),
  tool: z.string().min(1).nullable(),
  duration_ms: z.number().nonnegative(),
  ok: z.boolean(),
  error_code: z.string().min(1).nullable(),
  deviation_from_plan: z.boolean(),
});

const runCostWireSchema = z.object({
  credits_reserved: z.number().nonnegative(),
  credits_charged: z.number().nonnegative(),
  tokens_in: z.number().nonnegative(),
  tokens_out: z.number().nonnegative(),
  cache_hits: z.number().nonnegative(),
  cost_micro_usd: z.number().nonnegative(),
});

/** GET /v1/runs/:id body — status + plan + steps summary + cost (§13.1). */
export const runDetailSchema = z.object({
  run_id: z.string().min(1),
  document_id: z.string().min(1),
  status: z.enum(RUN_STATUS_NAMES),
  tier: z.string().min(1),
  revision_before: z.number().nonnegative(),
  revision_after: z.number().nonnegative().nullable(),
  created_at: z.string().min(1),
  started_at: z.string().min(1).nullable(),
  finished_at: z.string().min(1).nullable(),
  error: runFailureSchema.nullable(),
  plan: z.unknown(),
  cost: runCostWireSchema,
  steps: z.array(runStepWireSchema),
});

export type RunDetailView = z.infer<typeof runDetailSchema>;

// ---------------------------------------------------------------------------
// §13.1/§3.4/§24.4 response schemas used by the timeline page
// ---------------------------------------------------------------------------

/** POST /v1/runs response — { run_id, status, credits_reserved } (§13.1). */
export const createRunResponseSchema = z.object({
  run_id: z.string().min(1),
  status: z.string().min(1),
  credits_reserved: z.number().nonnegative(),
});

/** POST /v1/runs/:id/cancel response (§3.4 refund view). */
export const cancelRunResponseSchema = z.object({
  run_id: z.string().min(1),
  status: z.string().min(1),
  credits_refunded: z.number().nonnegative(),
});

// ---------------------------------------------------------------------------
// Derived timeline — detail seed + §13.2 event fold
// ---------------------------------------------------------------------------

/** One step in the timeline (live or seeded from the run detail). */
export interface TimelineStep {
  readonly stepSeq: number;
  readonly phase: string;
  readonly tool: string | null;
  readonly started: boolean;
  readonly finished: boolean;
  /** null while the step is running. */
  readonly ok: boolean | null;
  readonly durationMs: number | null;
  /** Error code only exists on seeded rows (live finished payloads omit it). */
  readonly errorCode: string | null;
  readonly deviation: boolean;
  /** Wall-clock the step started (live events); null for seeded rows. */
  readonly atMs: number | null;
}

/** `preview.updated` snapshot — the last preview wins (§13.2). */
export interface PreviewSnapshot {
  readonly url: string;
  readonly revision: number;
  readonly atMs: number;
}

/** The §20 #5 timeline: plan → steps → previews → verdicts, plus credits. */
export interface RunTimeline {
  readonly status: RunStatusName;
  readonly terminal: boolean;
  readonly tier: string | null;
  readonly plan: PlanView | null;
  readonly steps: readonly TimelineStep[];
  /** True when steps came from live step events (the seed set is dropped). */
  readonly liveSteps: boolean;
  readonly activeStepSeq: number | null;
  readonly preview: PreviewSnapshot | null;
  readonly validation: ValidateReportPayload | null;
  readonly critique: CritiqueReportPayload | null;
  readonly creditsReserved: number | null;
  readonly creditsCharged: CreditsChargedPayload | null;
  readonly succeeded: RunSucceededPayload | null;
  readonly failure: RunFailure | null;
  readonly cancelledReason: string | null;
  readonly createdAtMs: number | null;
  readonly startedAtMs: number | null;
  readonly finishedAtMs: number | null;
  readonly revisionBefore: number | null;
  readonly revisionAfter: number | null;
  /** Any step deviated from the §5.5 plan ("agent deviated from plan" badge). */
  readonly deviated: boolean;
  readonly lastSeq: number;
}

function toMsOrNull(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Derives the timeline view: the §13.1 detail seeds it (instant paint, cold
 * loads, final refresh) and the §13.2 events fold over the seed (live updates
 * supersede; events carry what the detail cannot — previews, verdicts, live
 * steps). `events` must be seq-ascending and deduped (`orderedRunEvents`).
 */
export function deriveTimeline(
  detail: RunDetailView | null,
  events: readonly ParsedRunEvent[],
): RunTimeline {
  // --- seed from GET /v1/runs/:id (§13.1) ------------------------------------
  const stepRows = new Map<number, TimelineStep>();
  for (const step of detail?.steps ?? []) {
    stepRows.set(step.seq, {
      stepSeq: step.seq,
      phase: step.phase,
      tool: step.tool,
      started: true,
      finished: true,
      ok: step.ok,
      durationMs: step.duration_ms,
      errorCode: step.error_code,
      deviation: step.deviation_from_plan,
      atMs: null, // seeded rows are distinguishable from live rows by this
    });
  }

  let status: RunStatusName = detail?.status ?? "queued";
  let tier: string | null = detail?.tier ?? null;
  let plan: PlanView | null = detail === null ? null : parsePlanView(detail.plan);
  let preview: PreviewSnapshot | null = null;
  let validation: ValidateReportPayload | null = null;
  let critique: CritiqueReportPayload | null = null;
  let creditsReserved: number | null = detail?.cost.credits_reserved ?? null;
  let creditsCharged: CreditsChargedPayload | null =
    detail === null
      ? null
      : {
          charged: detail.cost.credits_charged,
          partial:
            detail.status === "failed" &&
            detail.cost.credits_charged > 0 &&
            detail.cost.credits_charged < detail.cost.credits_reserved,
        };
  let succeeded: RunSucceededPayload | null = null;
  let failure: RunFailure | null = detail?.error ?? null;
  let cancelledReason: string | null = null;
  let terminal = detail !== null && isTerminalRunStatus(detail.status);
  let startedAtMs = detail === null ? null : toMsOrNull(detail.started_at);
  let liveSteps = false;
  let lastSeq = 0;

  // --- fold §13.2 events (all 13 types — the switch is exhaustive) ------------
  for (const event of events) {
    lastSeq = Math.max(lastSeq, event.seq);
    switch (event.type) {
      case "run.queued": {
        tier = event.payload.tier;
        break;
      }
      case "run.started": {
        if (startedAtMs === null) {
          startedAtMs = event.atMs;
        }
        if (status === "queued") {
          status = "planning"; // §5.1: a picked-up run starts planning
        }
        break;
      }
      case "run.plan": {
        plan = event.payload.plan;
        break;
      }
      case "step.started": {
        liveSteps = true;
        const { stepSeq, phase, tool } = event.payload;
        const prior = stepRows.get(stepSeq);
        stepRows.set(stepSeq, {
          stepSeq,
          phase,
          tool,
          started: true,
          finished: prior?.finished ?? false,
          ok: prior?.ok ?? null,
          durationMs: prior?.durationMs ?? null,
          errorCode: prior?.errorCode ?? null,
          deviation: prior?.deviation ?? false,
          atMs: prior?.atMs ?? event.atMs,
        });
        if (!terminal) {
          status = phase; // a live run sits in the phase of its current step (§5.1)
        }
        break;
      }
      case "step.finished": {
        liveSteps = true;
        const { stepSeq, phase, tool, ok, durationMs, deviationFromPlan } = event.payload;
        const prior = stepRows.get(stepSeq);
        stepRows.set(stepSeq, {
          stepSeq,
          phase,
          tool,
          started: true,
          finished: true,
          ok,
          durationMs,
          errorCode: prior?.errorCode ?? null,
          deviation: deviationFromPlan || (prior?.deviation ?? false),
          atMs: prior?.atMs ?? event.atMs,
        });
        break;
      }
      case "preview.updated": {
        preview = { ...event.payload, atMs: event.atMs };
        break;
      }
      case "validate.report": {
        validation = event.payload;
        break;
      }
      case "critique.report": {
        critique = event.payload;
        break;
      }
      case "credits.reserved": {
        creditsReserved = event.payload.reserved;
        break;
      }
      case "credits.charged": {
        creditsCharged = { charged: event.payload.charged, partial: event.payload.partial };
        break;
      }
      case "run.succeeded": {
        terminal = true;
        status = event.payload.warnings.length > 0 ? "succeeded_with_warnings" : "succeeded";
        succeeded = event.payload;
        break;
      }
      case "run.failed": {
        terminal = true;
        status = "failed";
        failure = event.payload.error;
        break;
      }
      case "run.cancelled": {
        terminal = true;
        status = "cancelled";
        cancelledReason = event.payload.reason;
        break;
      }
      default: {
        // Exhaustiveness guard: every §13.2 type is handled above.
        const unhandled: never = event;
        return unhandled;
      }
    }
  }

  // Once live step events exist, drop the seeded (detail) rows: the SSE stepSeq
  // and the detail seq are owned by different writers and their numbering
  // bases are not contractually aligned, so mixing them could duplicate or
  // mislabel steps. Event rows always carry atMs; seeded rows never do.
  // Rendering ordinals (position in the sorted list) keeps the display stable
  // under either numbering convention.
  const mergedRows = [...stepRows.values()].sort((a, b) => a.stepSeq - b.stepSeq);
  const steps = liveSteps ? mergedRows.filter((step) => step.atMs !== null) : mergedRows;

  const activeStep = [...steps]
    .filter((step) => step.started && !step.finished)
    .sort((a, b) => b.stepSeq - a.stepSeq)[0];

  return {
    status,
    terminal,
    tier,
    plan,
    steps,
    liveSteps,
    activeStepSeq: activeStep?.stepSeq ?? null,
    preview,
    validation,
    critique,
    creditsReserved,
    creditsCharged,
    succeeded,
    failure,
    cancelledReason,
    createdAtMs: detail === null ? null : toMsOrNull(detail.created_at),
    startedAtMs,
    finishedAtMs: detail === null ? null : toMsOrNull(detail.finished_at),
    revisionBefore: detail?.revision_before ?? null,
    revisionAfter: detail?.revision_after ?? succeeded?.revisionAfter ?? null,
    deviated: steps.some((step) => step.deviation),
    lastSeq,
  };
}

// ---------------------------------------------------------------------------
// Elapsed clock helpers (§20 #5: finish in ≤ 5 min — show the clock)
// ---------------------------------------------------------------------------

/** The run's elapsed wall clock in ms; null before the detail arrives. */
export function runElapsedMs(timeline: RunTimeline, nowMs: number): number | null {
  const start = timeline.startedAtMs ?? timeline.createdAtMs;
  if (start === null) {
    return null;
  }
  const end = timeline.finishedAtMs ?? nowMs;
  return Math.max(0, end - start);
}

/** A running step's live duration in ms (its start to `nowMs`); null if n/a. */
export function stepElapsedMs(step: TimelineStep, nowMs: number): number | null {
  if (step.finished || step.atMs === null) {
    return null;
  }
  return Math.max(0, nowMs - step.atMs);
}

/** "42s" / "12m 05s" / "1h 03m" — compact human durations. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${totalSeconds}s`;
}

/** User-facing status labels (§5.1 states — never raw codes). */
export function statusLabel(status: RunStatusName): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "planning":
      return "Planning";
    case "executing":
      return "Executing";
    case "observing":
      return "Observing";
    case "rendering":
      return "Rendering";
    case "validating":
      return "Validating";
    case "critiquing":
      return "Critiquing";
    case "repairing":
      return "Repairing";
    case "finalizing":
      return "Finalizing";
    case "succeeded":
      return "Succeeded";
    case "succeeded_with_warnings":
      return "Succeeded with warnings";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

/** User-facing tier labels (§5.2 rows). */
export function tierLabel(tier: string | null): string {
  if (tier === null) {
    return "Unknown tier";
  }
  switch (tier) {
    case "quick":
      return "Quick edit";
    case "standard":
      return "Standard";
    case "complex":
      return "Complex";
    case "premium":
      return "Premium";
    case "max":
      return "Max";
    case "image_gen":
      return "Image generation";
    case "image_gen_hd":
      return "Image generation (HD)";
    default:
      return tier.charAt(0).toUpperCase() + tier.slice(1);
  }
}

// ---------------------------------------------------------------------------
// §24.4 one-click retry — the original brief, recovered client-side
// ---------------------------------------------------------------------------

/**
 * GET /v1/runs/:id does not expose the original prompt (RunDetailApiView has
 * no prompt field), but §24.4's one-click retry must re-send the SAME brief.
 * Until the gateway exposes the prompt (or a POST /v1/runs/:id/retry), the
 * run-creating flow (document page) writes the brief under this key and the
 * timeline reads it back. Flagged for the gateway owner — see the worklog.
 */
export const RETRY_BRIEF_KEY_PREFIX = "app:runs:brief:";

/** The §13.1 create-run body fields a retry can re-send verbatim. */
export interface RetryBrief {
  readonly prompt: string;
}

const retryBriefSchema = z.object({ prompt: z.string().min(1).max(8000) });

/** Minimal storage seam — injects deterministically in tests, SSR-safe live. */
export interface BriefStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const nullStorage: BriefStorage = {
  getItem: () => null,
  setItem: () => {
    /* no storage available — the seam degrades to "brief unknown" */
  },
};

function resolveStorage(storage?: BriefStorage): BriefStorage {
  if (storage !== undefined) {
    return storage;
  }
  return typeof sessionStorage === "undefined" ? nullStorage : sessionStorage;
}

/** Reads the brief that created `runId`; null when it was never stored. */
export function readRetryBrief(runId: string, storage?: BriefStorage): RetryBrief | null {
  const raw = resolveStorage(storage).getItem(`${RETRY_BRIEF_KEY_PREFIX}${runId}`);
  if (raw === null) {
    return null;
  }
  try {
    const parsed = retryBriefSchema.safeParse(JSON.parse(raw));
    return parsed.success ? { prompt: parsed.data.prompt } : null;
  } catch {
    return null;
  }
}

/** Persists the brief for `runId` so a later failed run can retry in one click. */
export function writeRetryBrief(runId: string, brief: RetryBrief, storage?: BriefStorage): void {
  resolveStorage(storage).setItem(`${RETRY_BRIEF_KEY_PREFIX}${runId}`, JSON.stringify(brief));
}
