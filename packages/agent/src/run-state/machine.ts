// @studio/agent — run lifecycle machine. Owner: W6-J (docs/AGENTS.md).
//
// Wraps the W1-P §5.1 transition table (packages/agent/src/state.ts — reused,
// never redefined) with the per-run registry, timestamped transition history,
// §13.2 SSE emission and the §5.2 wall-clock clean-stop funnel.
//
// Spec anchors:
//   §5.1  queued → planning → executing ⇄ observing → rendering → validating →
//         critiquing → (repairing → observing)×N → finalizing → succeeded |
//         succeeded_with_warnings | failed | cancelled. `failed`/`cancelled`
//         are reachable from every non-terminal state; terminal states never
//         transition again. Illegal moves are typed `invalid_transition`
//         failures carrying the exact ALLOWED set.
//   §5.2  budgets are a FEATURE, not an error: the tier wall clock
//         (TIER_WALL_CLOCK) is checked on every call; once it fires during an
//         active state the machine FORCES the run into `finalizing` with a
//         timeout budget report — the clean-stop funnel: commit what
//         strengthened the document, charge partially at most, and tell the
//         user what was cut. The funnel preempts everything except a caller
//         already landing `finalizing`/a terminal outcome.
//   §3.4  per-run timeout is the §5.2 wall-clock row; idempotent retries:
//         replaying a transition that already applied is a no-op success.
//   §13.2 the closed 13-type SSE set — the machine maps transitions where
//         applicable and NEVER invents payload numbers:
//           createRun            → run.queued {tier}
//           queued → planning    → run.started {revisionBefore}     (required)
//           planning → executing → run.plan {plan}                  (required)
//           → succeeded[_with_warnings] → run.succeeded {revisionAfter, warnings}
//           → failed             → run.failed {error}               (required)
//           → cancelled         → run.cancelled {reason}
//         Loop-internal edges (executing⇄observing→rendering→validating→
//         critiquing/repairing, forced finalizing) have no §13.2 type — the
//         phase-level step.*/validate.report/critique.report events are the
//         worker's, published while those phases run.
//   §22   the worker is the only writer; EmitLike fronts the durable
//         RunEventBus (eventbus.ts owns seq allocation, durability and typed
//         publish envelopes; publish here is fire-and-forget).
//
// Threading: single-owner per run (one worker owns a run — §5.2 tracker
// note); no locks. The clock is injectable (`Clock = () => epoch ms`,
// budgets.ts) so tests and replayed runs are deterministic.
import { RUN_TIER_ID_SCHEMA, type RunTierId, resolveTierConfig } from "@studio/config";
import { z } from "zod";
import type { Clock } from "../budgets.js";
import type { RunEventPayloadMap, RunEventType } from "../events.js";
import type { Plan } from "../plan.js";
import {
  ALLOWED_TRANSITIONS,
  RUN_STATUS_SCHEMA,
  type RunStatus,
  canTransition,
  isTerminal,
} from "../state.js";

// --- Typed failures (self-contained catalog; errors.ts is W1 lineage) ---------

export const RUN_STATE_ERROR_CODES = [
  // The runId is not registered in this machine instance.
  "run_not_found",
  // createRun collided with an existing runId.
  "run_already_registered",
  // A §5.1 table violation — W1-P state.ts stays the single source of truth.
  "invalid_transition",
  // The transition's mapped §13.2 event needs a ctx payload the caller omitted.
  "transition_payload_required",
  // Wiring bug: malformed createRun init / transition ctx (zod boundary).
  "run_state_input_invalid",
  // Cancellation hit a run that ended in a non-cancelled terminal state.
  "run_already_terminal",
] as const satisfies readonly string[];

export type RunStateErrorCode = (typeof RUN_STATE_ERROR_CODES)[number];

/** Failure envelope — AGENTS.md `{ ok:false, code, message, hint, retryable? }`. */
export interface RunStateFailure {
  readonly ok: false;
  readonly code: RunStateErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly retryable?: boolean;
  /** `invalid_transition` only: the exact ALLOWED set from the current status. */
  readonly allowed?: readonly RunStatus[];
}

/** Builds a typed failure envelope; optional fields are omitted when unset. */
export function runStateFailure(
  code: RunStateErrorCode,
  message: string,
  options: { hint?: string; retryable?: boolean; allowed?: readonly RunStatus[] } = {},
): RunStateFailure {
  const envelope: {
    ok: false;
    code: RunStateErrorCode;
    message: string;
    hint?: string;
    retryable?: boolean;
    allowed?: readonly RunStatus[];
  } = { ok: false, code, message };
  if (options.hint !== undefined) {
    envelope.hint = options.hint;
  }
  if (options.retryable !== undefined) {
    envelope.retryable = options.retryable;
  }
  if (options.allowed !== undefined) {
    envelope.allowed = options.allowed;
  }
  return envelope;
}

// --- §13.2 emitter seam ---------------------------------------------------------

/**
 * Minimal publish seam for §13.2 events. The worker fronts the durable
 * RunEventBus (§22 correlation lives with the bus, not the machine):
 *
 * ```ts
 * const emit: EmitLike = {
 *   // One-time adapter cast: the bus payload type is discriminated by `type`
 *   // at ITS boundary; this seam keeps the machine free of §22 org ids.
 *   publish: (runId, type, payload) =>
 *     bus.publish(runId, type as "run.queued", payload as RunQueuedPayload, {
 *       organizationId,
 *     }),
 * };
 * ```
 *
 * Contract: `publish` may return anything (a promise is swallowed, never an
 * unhandled rejection — §22 durability failures belong to the bus envelopes);
 * it must not throw synchronously (a seam breach is reported as `emitFailed`
 * without corrupting the committed transition).
 */
export interface EmitLike {
  publish(runId: string, type: RunEventType, payload: unknown): Promise<unknown> | unknown;
}

// --- Public types ----------------------------------------------------------------

/** The terminal `run.failed` payload's error envelope (§13.3-style stable strings). */
export type RunErrorEnvelope = RunEventPayloadMap["run.failed"]["error"];

/** Neutral, truthful default surfaced on `run.cancelled` when no reason was given. */
export const DEFAULT_CANCEL_REASON = "Cancelled by request";

/** Per-run history bound — §5.2 budgets keep real runs far below this. */
export const DEFAULT_HISTORY_CAP = 256;

export interface CreateRunInit {
  /** §5.2 tier row: the wall-clock budget source + the `run.queued` payload. */
  readonly tier: RunTierId;
  /** Explicit §5.2 wall-clock override (tests / §3.4 resume: shrink the budget). */
  readonly wallClockMs?: number;
  /** Initial status — `queued` (default), or an active status for recovery replay. */
  readonly status?: RunStatus;
}

/**
 * Payloads for the §13.2 events the machine emits. Fields the machine cannot
 * know (revisions, the plan, failure semantics) are the caller's; the machine
 * never invents numbers (see the required-field failures).
 */
export interface TransitionContext {
  /** `run.started`: §5.6 document revision at worker pickup. Required on queued → planning. */
  readonly revisionBefore?: number;
  /** `run.plan`: the §5.5-validated plan the run is about to execute. Required on planning → executing. */
  readonly plan?: Plan;
  /** `run.succeeded`: revision after agent.commit. Required on → succeeded/succeeded_with_warnings. */
  readonly revisionAfter?: number;
  /** `run.succeeded`: remaining §5.1 issues shipped as warnings (defaults to `[]`). */
  readonly warnings?: readonly string[];
  /** `run.failed`: terminal §13.3-style envelope. Required on → failed. */
  readonly error?: RunErrorEnvelope;
  /** `run.cancelled` + history annotation: why the run is stopping. */
  readonly reason?: string;
}

/** One applied transition, timestamped by the injected clock. */
export interface RunTransitionRecord {
  readonly runId: string;
  /** Per-run monotonic ordinal (0 = the creation record, whose `from` is null). */
  readonly seq: number;
  readonly from: RunStatus | null;
  readonly to: RunStatus;
  readonly atMs: number;
  /** True only for the §5.2 timeout funnel (→ finalizing, reason `run_timeout`). */
  readonly forced: boolean;
  /** True when an §3.4 idempotent replay was recorded instead of a real move. */
  readonly replay: boolean;
  readonly reason: string | null;
  /** The §13.2 type published for this transition, if any. */
  readonly emitted: RunEventType | null;
}

/**
 * §5.2 timeout budget report — a feature, not an error: the machine hands this
 * to the run manager, which decides commit-vs-rollback (§5.2) and surfaces
 * `message` ("tell the user what was cut").
 */
export interface TimeoutBudgetReport {
  /** The §5.2 budget dimension that fired — always the tier wall clock. */
  readonly kind: "wall_clock";
  readonly tier: RunTierId;
  readonly limitMs: number;
  readonly usedMs: number;
  /** Always 0 — the cap is spent (W1-P `BudgetExceeded.remaining` semantics). */
  readonly remainingMs: number;
  readonly startedAtMs: number;
  readonly deadlineAtMs: number;
  readonly detectedAtMs: number;
  /** User-surfaceable sentence (§5.2 "tell the user what was cut"). */
  readonly message: string;
}

/** Point-in-time view of one registered run. */
export interface RunSnapshot {
  readonly runId: string;
  readonly status: RunStatus;
  readonly tier: RunTierId;
  readonly wallClockMs: number;
  readonly createdAtMs: number;
  /** Wall-clock latch — null until worker pickup (queued runs burn no budget). */
  readonly startedAtMs: number | null;
  readonly deadlineAtMs: number | null;
  /** `max(0, deadline - now)`; null while the clock has not started. */
  readonly deadlineRemainingMs: number | null;
  readonly timedOut: boolean;
  readonly transitions: number;
}

export interface TransitionSuccess {
  readonly ok: true;
  readonly runId: string;
  readonly from: RunStatus | null;
  readonly to: RunStatus;
  readonly atMs: number;
  /** True only when the §5.2 funnel forced the move (to === "finalizing"). */
  readonly forced: boolean;
  /** True when this was an §3.4 idempotent replay (no state change). */
  readonly replay: boolean;
  /** The §13.2 type published, if any (null: unmapped edge or emit failure). */
  readonly emitted: RunEventType | null;
  /** True when the emitter threw synchronously (seam breach; state still applied). */
  readonly emitFailed: boolean;
  /** Present whenever the §5.2 wall clock has fired (forced or attached). */
  readonly timeout: TimeoutBudgetReport | null;
}

export type TransitionResult = TransitionSuccess | RunStateFailure;

export type CreateRunResult =
  | {
      readonly ok: true;
      readonly snapshot: RunSnapshot;
      readonly emitted: RunEventType | null;
      readonly emitFailed: boolean;
    }
  | RunStateFailure;

export type DeadlineCheck =
  | {
      readonly ok: true;
      readonly exceeded: boolean;
      readonly report: TimeoutBudgetReport | null;
      /** Status AFTER any forced funnel move. */
      readonly status: RunStatus;
      /** True when THIS call forced an active run into `finalizing`. */
      readonly forced: boolean;
    }
  | RunStateFailure;

export interface RunStateMachineOptions {
  /** §13.2 emitter adapter (fronts the durable RunEventBus; §22 worker-only writer). */
  readonly emit?: EmitLike;
  /** Injectable wall clock (epoch ms) — tests/replay determinism (budgets.ts seam). */
  readonly clock?: Clock;
  /** Per-run history bound (oldest entries dropped first). */
  readonly historyCap?: number;
}

// --- Zod boundaries (wiring-bug guards; BudgetTracker fail-fast precedent) -------

const createRunInitSchema = z.strictObject({
  tier: RUN_TIER_ID_SCHEMA,
  wallClockMs: z.number().int().min(1).optional(),
  status: RUN_STATUS_SCHEMA.optional(),
});

const transitionContextSchema = z.strictObject({
  revisionBefore: z.number().int().min(0).optional(),
  // Passthrough: the §5.5 plan is validated upstream by the planner (§5.1);
  // the machine only carries it onto the `run.plan` event.
  plan: z.unknown().optional(),
  revisionAfter: z.number().int().min(0).optional(),
  warnings: z.array(z.string()).optional(),
  error: z
    .strictObject({
      code: z.string().min(1),
      message: z.string().min(1),
      hint: z.string().optional(),
      retryable: z.boolean().optional(),
    })
    .optional(),
  reason: z.string().min(1).optional(),
});

const machineOptionsSchema = z.strictObject({
  emit: z
    .custom<EmitLike>(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        typeof (value as EmitLike).publish === "function",
      { message: "emit must expose publish(runId, type, payload)" },
    )
    .optional(),
  clock: z
    .custom<Clock>((value) => typeof value === "function", { message: "clock must be a function" })
    .optional(),
  historyCap: z.number().int().min(1).optional(),
});

/** Field PATHS only — never values (§15.3). */
function zodIssuePaths(issues: readonly z.ZodIssue[]): string {
  return issues.map((issue) => issue.path.join(".")).join(", ") || "(root)";
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${seconds}s`;
  }
  return seconds === 0 ? `${minutes}min` : `${minutes}min ${seconds}s`;
}

/**
 * The §13.2 `run.failed` envelope for a §5.2 wall-clock stop — the run manager
 * passes it as `ctx.error` when the forced funnel lands on `failed`
 * (code matches W1-P's stable `run_timeout` catalog entry).
 */
export function timeoutErrorEnvelope(report: TimeoutBudgetReport): RunErrorEnvelope {
  return {
    code: "run_timeout",
    message: report.message,
    hint: "The run hit its tier wall-clock cap and was stopped cleanly (§5.2).",
    retryable: false,
  };
}

// --- Internals -------------------------------------------------------------------

interface RunRecord {
  readonly runId: string;
  readonly tier: RunTierId;
  readonly wallClockMs: number;
  readonly createdAtMs: number;
  status: RunStatus;
  startedAtMs: number | null;
  deadlineAtMs: number | null;
  history: RunTransitionRecord[];
  nextSeq: number;
}

interface EmitOutcome {
  readonly emitted: RunEventType | null;
  readonly emitFailed: boolean;
}

type MappedEvent =
  | { readonly type: "run.started"; readonly payload: RunEventPayloadMap["run.started"] }
  | { readonly type: "run.plan"; readonly payload: RunEventPayloadMap["run.plan"] }
  | { readonly type: "run.succeeded"; readonly payload: RunEventPayloadMap["run.succeeded"] }
  | { readonly type: "run.failed"; readonly payload: RunEventPayloadMap["run.failed"] }
  | { readonly type: "run.cancelled"; readonly payload: RunEventPayloadMap["run.cancelled"] };

const defaultClock: Clock = () => Date.now();

// --- The machine -----------------------------------------------------------------

/**
 * The §5.1 run lifecycle machine: one instance per process, keyed by runId.
 * Reuses the W1-P transition table for every guard; adds run registration,
 * timestamped history, §13.2 emission and §5.2 wall-clock enforcement.
 */
export class RunStateMachine {
  readonly #emit: EmitLike | null;
  readonly #clock: Clock;
  readonly #historyCap: number;
  readonly #runs = new Map<string, RunRecord>();

  constructor(options: RunStateMachineOptions = {}) {
    // Fail fast on hand-wired options (BudgetTracker precedent): a constructor
    // breach is a wiring bug, not runtime data.
    const parsed = machineOptionsSchema.parse(options);
    this.#emit = parsed.emit ?? null;
    this.#clock = parsed.clock ?? defaultClock;
    this.#historyCap = parsed.historyCap ?? DEFAULT_HISTORY_CAP;
  }

  /**
   * Registers a run at the given initial status (default `queued`) and emits
   * `run.queued` for fresh queue entries. Runs registered in an ACTIVE status
   * (§3.4 recovery replay) latch the wall clock immediately; `wallClockMs`
   * lets the caller shrink the remaining budget to match the crash point.
   */
  createRun(runId: string, init: CreateRunInit): CreateRunResult {
    const parsedInit = createRunInitSchema.safeParse(init);
    if (!parsedInit.success) {
      return runStateFailure(
        "run_state_input_invalid",
        "createRun init failed schema validation (wiring bug — the caller is typed).",
        {
          hint: zodIssuePaths(parsedInit.error.issues),
          retryable: false,
        },
      );
    }
    if (this.#runs.has(runId)) {
      return runStateFailure(
        "run_already_registered",
        `Run '${runId}' is already registered in this state machine.`,
        {
          hint: "§3.4 idempotency: reuse the existing run instead of re-creating it.",
          retryable: false,
        },
      );
    }
    const tier = parsedInit.data.tier;
    const now = this.#clock();
    const wallClockMs = parsedInit.data.wallClockMs ?? resolveTierConfig(tier).wallClockMs;
    const status = parsedInit.data.status ?? "queued";
    const startedAtMs = status === "queued" ? null : now;
    const record: RunRecord = {
      runId,
      tier,
      wallClockMs,
      createdAtMs: now,
      status,
      startedAtMs,
      deadlineAtMs: startedAtMs === null ? null : startedAtMs + wallClockMs,
      history: [],
      nextSeq: 0,
    };
    this.#runs.set(runId, record);
    const outcome =
      status === "queued"
        ? this.#emitEvent(runId, "run.queued", { tier })
        : { emitted: null, emitFailed: false };
    this.#appendHistory(record, {
      from: null,
      to: status,
      atMs: now,
      forced: false,
      replay: false,
      reason: null,
      emitted: outcome.emitted,
    });
    return {
      ok: true,
      snapshot: this.#snapshotOf(record),
      emitted: outcome.emitted,
      emitFailed: outcome.emitFailed,
    };
  }

  /** Current status — null when the run is not registered. */
  snapshot(runId: string): RunSnapshot | null {
    const record = this.#runs.get(runId);
    return record === undefined ? null : this.#snapshotOf(record);
  }

  /** Timestamped transition history (oldest dropped past `historyCap`); null when unknown. */
  history(runId: string): readonly RunTransitionRecord[] | null {
    const record = this.#runs.get(runId);
    return record === undefined ? null : Object.freeze([...record.history]);
  }

  /**
   * Applies one §5.1 transition. Order of enforcement:
   *   1. zod ctx boundary, run lookup, §5.1 terminal lock (allowed: []);
   *   2. §5.2 wall clock — exceeded during ANY active state forces the run
   *      into `finalizing` with a timeout budget report (a caller already
   *      landing a terminal outcome keeps control, with the report attached);
   *   3. §3.4 idempotent replay (same status → no-op success);
   *   4. §5.1 table guard (typed `invalid_transition` + the ALLOWED set);
   *   5. §13.2 payload contract (typed `transition_payload_required`);
   *   6. apply: status move, history record, event emission.
   */
  transition(runId: string, to: RunStatus, ctx: TransitionContext = {}): TransitionResult {
    const parsedCtx = transitionContextSchema.safeParse(ctx);
    if (!parsedCtx.success) {
      return runStateFailure(
        "run_state_input_invalid",
        "Transition ctx failed schema validation (wiring bug — the caller is typed).",
        {
          hint: zodIssuePaths(parsedCtx.error.issues),
          retryable: false,
        },
      );
    }
    const record = this.#runs.get(runId);
    if (record === undefined) {
      return runStateFailure(
        "run_not_found",
        `Run '${runId}' is not registered in this state machine.`,
        {
          hint: "createRun(runId, { tier }) before transitioning.",
          retryable: false,
        },
      );
    }
    const from = record.status;
    // §5.1 terminal lock — terminals never move, not even onto themselves.
    if (isTerminal(from)) {
      return runStateFailure(
        "invalid_transition",
        `Cannot transition '${from} → ${to}': '${from}' is terminal (§5.1) — runs never leave a terminal state.`,
        { hint: "Start a new run instead of continuing this one.", retryable: false, allowed: [] },
      );
    }
    const now = this.#clock();
    const report = this.#deadlineReport(record, now);
    if (report !== null && from !== "finalizing" && !isTerminal(to)) {
      // §5.2 clean-stop funnel: ANY active state at deadline → forced finalizing.
      record.status = "finalizing";
      this.#appendHistory(record, {
        from,
        to: "finalizing",
        atMs: now,
        forced: true,
        replay: false,
        reason: "run_timeout",
        emitted: null,
      });
      return {
        ok: true,
        runId,
        from,
        to: "finalizing",
        atMs: now,
        forced: true,
        replay: false,
        emitted: null,
        emitFailed: false,
        timeout: report,
      };
    }
    // §3.4 idempotent retries: replaying the transition that already applied.
    if (from === to) {
      this.#appendHistory(record, {
        from,
        to,
        atMs: now,
        forced: false,
        replay: true,
        reason: "idempotent_replay",
        emitted: null,
      });
      return {
        ok: true,
        runId,
        from,
        to,
        atMs: now,
        forced: false,
        replay: true,
        emitted: null,
        emitFailed: false,
        timeout: report,
      };
    }
    // §5.1 table guard — W1-P state.ts is the single source of truth.
    if (!canTransition(from, to)) {
      return runStateFailure(
        "invalid_transition",
        `A run cannot move from '${from}' to '${to}' (§5.1 state machine).`,
        {
          hint: isTerminal(to)
            ? `Reach '${to}' via 'finalizing' (success) or directly from any active phase (failure/cancel).`
            : `Allowed next states from '${from}': ${ALLOWED_TRANSITIONS[from].join(", ")}.`,
          retryable: false,
          allowed: [...ALLOWED_TRANSITIONS[from]],
        },
      );
    }
    const missing = this.#missingRequired(from, to, ctx);
    if (missing !== null) {
      return runStateFailure(
        "transition_payload_required",
        `Transition '${from} → ${to}' requires ctx.${missing} — its §13.2 event carries it and the machine never invents payload numbers.`,
        {
          hint: `Retry the SAME transition with ctx.${missing} supplied (§3.4 idempotent: no state changed).`,
          retryable: true,
        },
      );
    }
    const mapped = this.#mappedEvent(from, to, ctx);
    const outcome =
      mapped === null
        ? { emitted: null, emitFailed: false }
        : this.#emitEvent(runId, mapped.type, mapped.payload);
    if (from === "queued" && to === "planning") {
      // Worker pickup: the §5.2 wall clock starts NOW (queued runs burn none).
      record.startedAtMs = now;
      record.deadlineAtMs = now + record.wallClockMs;
    }
    record.status = to;
    this.#appendHistory(record, {
      from,
      to,
      atMs: now,
      forced: false,
      replay: false,
      reason: ctx.reason ?? null,
      emitted: outcome.emitted,
    });
    return {
      ok: true,
      runId,
      from,
      to,
      atMs: now,
      forced: false,
      replay: false,
      emitted: outcome.emitted,
      emitFailed: outcome.emitFailed,
      timeout: report,
    };
  }

  /**
   * §5.2 wall-clock probe for the run manager's between-phase checks (the
   * transition guard also runs on every move). Exceeded + active → forces the
   * same §5.2 funnel as `transition`; exceeded inside `finalizing` (or a
   * terminal state) only reports — the caller is already winding down.
   */
  checkDeadline(runId: string): DeadlineCheck {
    const record = this.#runs.get(runId);
    if (record === undefined) {
      return runStateFailure(
        "run_not_found",
        `Run '${runId}' is not registered in this state machine.`,
        {
          hint: "createRun(runId, { tier }) before checking deadlines.",
          retryable: false,
        },
      );
    }
    const now = this.#clock();
    const report = this.#deadlineReport(record, now);
    if (report === null) {
      return { ok: true, exceeded: false, report: null, status: record.status, forced: false };
    }
    if (record.status === "finalizing" || isTerminal(record.status)) {
      return { ok: true, exceeded: true, report, status: record.status, forced: false };
    }
    const from = record.status;
    record.status = "finalizing";
    this.#appendHistory(record, {
      from,
      to: "finalizing",
      atMs: now,
      forced: true,
      replay: false,
      reason: "run_timeout",
      emitted: null,
    });
    return { ok: true, exceeded: true, report, status: "finalizing", forced: true };
  }

  // --- Private helpers -----------------------------------------------------------

  #snapshotOf(record: RunRecord): RunSnapshot {
    const now = this.#clock();
    return {
      runId: record.runId,
      status: record.status,
      tier: record.tier,
      wallClockMs: record.wallClockMs,
      createdAtMs: record.createdAtMs,
      startedAtMs: record.startedAtMs,
      deadlineAtMs: record.deadlineAtMs,
      deadlineRemainingMs:
        record.deadlineAtMs === null ? null : Math.max(0, record.deadlineAtMs - now),
      timedOut: record.deadlineAtMs !== null && now >= record.deadlineAtMs,
      transitions: record.history.length,
    };
  }

  /** §5.2 wall-clock report, or null while the budget still has time (or hasn't started). */
  #deadlineReport(record: RunRecord, now: number): TimeoutBudgetReport | null {
    if (record.startedAtMs === null || record.deadlineAtMs === null || now < record.deadlineAtMs) {
      return null;
    }
    const usedMs = now - record.startedAtMs;
    return {
      kind: "wall_clock",
      tier: record.tier,
      limitMs: record.wallClockMs,
      usedMs,
      remainingMs: 0,
      startedAtMs: record.startedAtMs,
      deadlineAtMs: record.deadlineAtMs,
      detectedAtMs: now,
      message: `Tier wall-clock budget (${formatDuration(record.wallClockMs)}, §5.2) exhausted after ${formatDuration(usedMs)} — clean stop: commit what strengthened the document, charge partially at most, and tell the user what was cut.`,
    };
  }

  /** The §13.2 payload field each mapped transition requires (§13.2 payload table above). */
  #missingRequired(from: RunStatus, to: RunStatus, ctx: TransitionContext): string | null {
    if (from === "queued" && to === "planning" && ctx.revisionBefore === undefined) {
      return "revisionBefore";
    }
    if (from === "planning" && to === "executing" && ctx.plan === undefined) {
      return "plan";
    }
    if (
      (to === "succeeded" || to === "succeeded_with_warnings") &&
      ctx.revisionAfter === undefined
    ) {
      return "revisionAfter";
    }
    if (to === "failed" && ctx.error === undefined) {
      return "error";
    }
    return null;
  }

  #mappedEvent(from: RunStatus, to: RunStatus, ctx: TransitionContext): MappedEvent | null {
    if (from === "queued" && to === "planning") {
      return ctx.revisionBefore === undefined
        ? null
        : { type: "run.started", payload: { revisionBefore: ctx.revisionBefore } };
    }
    if (from === "planning" && to === "executing") {
      return ctx.plan === undefined ? null : { type: "run.plan", payload: { plan: ctx.plan } };
    }
    if (to === "succeeded" || to === "succeeded_with_warnings") {
      return ctx.revisionAfter === undefined
        ? null
        : {
            type: "run.succeeded",
            payload: { revisionAfter: ctx.revisionAfter, warnings: [...(ctx.warnings ?? [])] },
          };
    }
    if (to === "failed") {
      return ctx.error === undefined ? null : { type: "run.failed", payload: { error: ctx.error } };
    }
    if (to === "cancelled") {
      return { type: "run.cancelled", payload: { reason: ctx.reason ?? DEFAULT_CANCEL_REASON } };
    }
    return null;
  }

  #emitEvent(runId: string, type: RunEventType, payload: unknown): EmitOutcome {
    const emit = this.#emit;
    if (emit === null) {
      return { emitted: null, emitFailed: false };
    }
    try {
      const returned: unknown = emit.publish(runId, type, payload);
      // Fire-and-forget: a returned promise must never surface as an unhandled
      // rejection — §22 durability failures belong to the bus envelopes.
      if (
        returned !== null &&
        typeof returned === "object" &&
        typeof (returned as PromiseLike<unknown>).then === "function"
      ) {
        void Promise.resolve(returned as PromiseLike<unknown>).then(
          () => undefined,
          () => undefined,
        );
      }
      return { emitted: type, emitFailed: false };
    } catch {
      // The durable bus never throws (typed envelopes); a seam breach is
      // reported without corrupting the committed transition.
      return { emitted: null, emitFailed: true };
    }
  }

  #appendHistory(
    record: RunRecord,
    entry: {
      from: RunTransitionRecord["from"];
      to: RunStatus;
      atMs: number;
      forced: boolean;
      replay: boolean;
      reason: string | null;
      emitted: RunEventType | null;
    },
  ): RunTransitionRecord {
    const transition: RunTransitionRecord = { runId: record.runId, seq: record.nextSeq, ...entry };
    record.nextSeq += 1;
    record.history.push(transition);
    if (record.history.length > this.#historyCap) {
      record.history.splice(0, record.history.length - this.#historyCap);
    }
    return transition;
  }
}
