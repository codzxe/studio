/**
 * Chat engine controller v2 — the ROUND-12 CLIENT-DRIVEN AGENT LOOP
 * (research/round12-design.md "Architecture"; Cursor-style; Seam 4 of
 * docs/phases/M4-SEAMS.md; EDITOR_CHAT_UX §3.4 steer, §8.3 cancellation).
 *
 * The loop lives HERE, in the browser — the round-10 production "stuck in a
 * loop" failure class (serverless 60s hard-kill → in-memory replay MISS →
 * duplicate run → RUN_PAUSED → retry → infinite) is dead by construction:
 * every gateway request is ONE bounded turn (POST /v1/threads/:id/turn, one
 * model call, durable per-turn persistence, per-turn credit reserve/commit).
 *
 * Per run (runId = client `crypto.randomUUID()`, stable for the whole run):
 *  1. build the CURRENT-RUN transcript (TURN_REQUEST_SCHEMA parts: the user
 *     part on step 0; assistant text + tool_call/tool_result parts after each
 *     turn; steer parts for mid-run sends, §3.4);
 *  2. POST ONE turn via `client.chat.turn` (the api-client's `streamTurn`:
 *     SSE, `Idempotency-Key: ${runId}:${stepIndex}` header, bounded same-key
 *     recovery — transport drop → up to 3 attempts → `TURN_PAUSED`; a
 *     retryable `turn.failed` → ONE same-key retry);
 *  3. fold the turn.* events into the store (run-state.ts) as they stream;
 *  4. on `turn.completed`: WRITE tools (proposal carriers) ACCUMULATE — the
 *     client NEVER executes them during the run, it echoes `resultForModel`;
 *     READ/GENERATIVE tools execute LOCALLY through the injected executor
 *     (i5's pinned seam) and echo the real result (`ClientToolError` → the
 *     `{error, message}` result so the model can recover);
 *  5. repeat until a turn completes with NO tool calls → merge the proposal
 *     carriers (`mergeEditPlans`, @studio/contracts — the design-pinned pure
 *     seam) → POST /v1/runs/:id/plan → fold the plan card (the existing
 *     run-state plan fold) → synthesize the LOCAL run.completed (the server
 *     is stateless per turn and never needs to say it) → the round-10
 *     auto-apply drive fires when the §7.3 verdict says "auto".
 *
 * Loop guards (PINNED):
 *  * step cap — CHAT_MAX_CLIENT_STEPS (24); abort code RUN_STEP_LIMIT;
 *  * repetition guard — same `${tool}:${JSON.stringify(args)}` twice → the
 *    steer nudge "You already proposed {tool}; continue with the next step.";
 *    three times → abort RUN_STEP_LIMIT;
 *  * wall-clock cap — CHAT_RUN_TIMEOUT_MS (10 min); abort code RUN_TIMEOUT.
 *
 * stop() aborts the in-flight fetch, folds `cancelled` locally and
 * fire-and-forget POSTs `/v1/runs/:id/abandon` (once per run). retry()
 * re-sends the CURRENT step with the SAME idempotency key (a parked
 * TURN_PAUSED run or a surfaced turn.failed) or starts a fresh run when the
 * old one ended (fresh runId — a new key, never a replay of the old log).
 *
 * No React anywhere — pure TS. `useSyncExternalStore`-ready store over
 * `ChatUiState`; the provider (provider.tsx) wires the executor factory and
 * the canvas snapshot.
 */

import { EDIT_PLAN_SCHEMA, mergeEditPlans } from "@studio/contracts";

import type { TurnStreamHandle } from "@studio/api-client";
import type {
  EditPlan,
  PlanIntent,
  StudioStreamEvent,
  TurnCanvas,
  TurnToolCall,
} from "@studio/contracts";
import type { RunPlanResponse } from "./types.js";

import type { TurnMessage } from "@studio/contracts";
import type { ApplicablePlan, ApplyController, ApplyOutcome, UndoOutcome } from "./apply";
import {
  LIVE_RUN_PHASES,
  TERMINAL_RUN_PHASES,
  applicablePlanOf,
  applyClientAction,
  applyUserMessage,
  createInitialChatUiState,
  foldEvent,
  planRuntimeOf,
} from "./run-state";
import { isClientToolError } from "./tool-executor";
import type {
  ChatControllerClient,
  ChatSendInput,
  ChatToolExecutorFactory,
  ChatUiError,
  ChatUiState,
  TurnToolExecutor,
} from "./types";

// ---------------------------------------------------------------------------
// Loop guards (PINNED — research/round12-design.md "Battle-testing")
// ---------------------------------------------------------------------------

/** Per-run step cap (design doc: CHAT_MAX_STEPS default 24). */
export const CHAT_MAX_CLIENT_STEPS = 24;

/** Whole-run wall-clock cap (10 minutes; abort code RUN_TIMEOUT). */
export const CHAT_RUN_TIMEOUT_MS = 10 * 60 * 1000;

/** The §7.3-style abort code when the step cap fires. */
export const RUN_STEP_LIMIT_CODE = "RUN_STEP_LIMIT";

/** The §7.3-style abort code when the wall-clock cap fires. */
export const RUN_TIMEOUT_CODE = "RUN_TIMEOUT";

/** Repetition guard: the (tool, args) pair at this occurrence steers the nudge. */
const REPETITION_NUDGE_AT = 2;

/** Repetition guard: this occurrence aborts with RUN_STEP_LIMIT. */
const REPETITION_ABORT_AT = 3;

/** The steer nudge injected at the repetition guard's 2nd occurrence. */
export const repetitionNudge = (tool: string): string =>
  `You already proposed ${tool}; continue with the next step.`;

/** Turn transcript parts bound (contracts TURN_REQUEST_SCHEMA; mirrored). */
const MAX_TURN_MESSAGE_PARTS = 64;

/** Contracts `MAX_BATCH_LABEL_LENGTH` (engine-batch) — batch label clamp. */
const MAX_BATCH_LABEL_LENGTH = 280;

/** Contracts `MAX_PLAN_SUMMARY_LENGTH` (edit-plan) — summary clamp. */
const MAX_PLAN_SUMMARY_LENGTH = 280;

// ---------------------------------------------------------------------------
// Carrier EditPlan construction (gateway `writeToolCarrierPlan` parity)
// ---------------------------------------------------------------------------

/**
 * The gateway's per-write-tool intent map (services/gateway/src/litellm/
 * turn-engine.ts WRITE_TOOL_INTENTS) — mirrored so the client's merged plan
 * carries the same intent the server's own carrier would.
 */
const WRITE_TOOL_INTENTS: Readonly<Record<string, PlanIntent>> = {
  "studio.create_composition": "create",
  "studio.create_text": "create",
  "studio.set_properties": "edit",
  "studio.add_effect": "style",
  "studio.set_keyframes": "animate",
  "studio.apply_preset": "animate",
  "studio.engine_commands": "edit",
  "studio.run_script": "animate",
  "studio.add_asset": "create",
  "studio.undo_run": "organize",
  "studio.save_version": "organize",
};

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function clamp280(value: string): string {
  return value.length <= MAX_PLAN_SUMMARY_LENGTH
    ? value
    : `${value.slice(0, MAX_PLAN_SUMMARY_LENGTH - 1)}…`;
}

/**
 * Deterministic HUMAN summary of one write-tool call — the gateway's
 * `writeToolSummary` (turn-engine.ts) mirrored verbatim so the client's
 * merged plan card reads exactly like a server-compiled one.
 */
export function writeToolSummary(toolId: string, args: Record<string, unknown>): string {
  const layerNames = array(args.layers)
    .map((layer) =>
      typeof layer === "object" && layer !== null
        ? str((layer as Record<string, unknown>).name)
        : "",
    )
    .filter((name) => name !== "");
  switch (toolId) {
    case "studio.create_composition":
      return `Create composition "${str(args.name)}"`;
    case "studio.create_text": {
      const content = str(args.text);
      const label = str(args.name) || (content.length > 40 ? `${content.slice(0, 39)}…` : content);
      return `Add text layer "${label}"`;
    }
    case "studio.set_properties": {
      const updates = array(args.properties).length;
      const noun = updates === 1 ? "property" : "properties";
      const layers = layerNames.length === 0 ? 1 : layerNames.length;
      return `Set ${updates} ${noun} on ${layers} layer${layers > 1 ? "s" : ""}`;
    }
    case "studio.add_effect":
      return `Add effect "${str(
        typeof args.effect === "object" && args.effect !== null
          ? str((args.effect as Record<string, unknown>).name)
          : "",
      )}" to ${layerNames.length} layer${layerNames.length === 1 ? "" : "s"}`;
    case "studio.set_keyframes":
      return `Set ${array(args.keys).length} keyframes on ${str(args.propertyPath)} of ${
        layerNames.length
      } layer${layerNames.length === 1 ? "" : "s"}`;
    case "studio.apply_preset": {
      const preset =
        typeof args.preset === "object" && args.preset !== null
          ? str((args.preset as Record<string, unknown>).name) ||
            str((args.preset as Record<string, unknown>).builtinId)
          : "";
      const targets = layerNames.length > 0 ? layerNames.length : 1;
      return `Apply preset "${preset}" to ${targets} layer${targets === 1 ? "" : "s"}`;
    }
    case "studio.engine_commands":
      return `Run ${array(args.steps).length} engine command${
        array(args.steps).length === 1 ? "" : "s"
      }`;
    case "studio.run_script":
      return `Run an engine script (${str(args.code).length} chars)`;
    case "studio.add_asset":
      return `Add ${str(args.kind)} asset "${str(args.name)}"`;
    case "studio.undo_run":
      return "Undo the most recent applied agent run";
    case "studio.save_version":
      return str(args.label) === ""
        ? "Save a version snapshot of the project"
        : `Save a version snapshot labeled "${str(args.label)}"`;
    default:
      return `Propose ${toolId.replace(/^studio\./, "")}`;
  }
}

/**
 * The one-step EditPlan CARRIER for one write-tool proposal (the client-side
 * twin of the gateway's `writeToolCarrierPlan`: intent by tool, summary by
 * `writeToolSummary`, risk from the SERVER-compiled carrier, ONE step whose
 * batch names the tool without the `studio.` prefix). Merged later through
 * `mergeEditPlans` (contracts) — the pure seam the design doc pins.
 */
export function carrierEditPlan(call: TurnToolCall): EditPlan {
  const record = (typeof call.args === "object" && call.args !== null ? call.args : {}) as Record<
    string,
    unknown
  >;
  const summary = clamp280(writeToolSummary(call.tool, record));
  const risk = call.proposal?.compiled?.risk ?? "medium";
  // The gateway's carrier shape verbatim (turn-engine.ts writeToolCarrier
  // Plan): an untyped literal — the batch keeps its `atomic: true` — pumped
  // through EDIT_PLAN_SCHEMA.parse, the spec-pinned validation seam. The
  // schema is non-strict, so parse VALIDATES the carrier and normalizes it
  // to the EditPlan type (mirroring the gateway byte-for-byte, `atomic`
  // rides the pre-parse literal exactly as it does server-side).
  const carrier = {
    intent: WRITE_TOOL_INTENTS[call.tool] ?? "edit",
    summary,
    risk,
    requiresApproval: risk === "high",
    affectedLayers: [],
    estimatedCredits: call.proposal?.compiled?.estimatedCredits ?? 0,
    steps: [
      {
        title: summary,
        tool: call.tool,
        args: call.args,
        batch: {
          label: `Agent: ${summary}`.slice(0, MAX_BATCH_LABEL_LENGTH),
          atomic: true,
          steps: [{ command: call.tool.replace(/^studio\./, ""), params: record }],
        },
      },
    ],
  };
  return EDIT_PLAN_SCHEMA.parse(carrier);
}

/** Outcome-reason → §7.3-style code the plan card renders (M5 slice). */
const APPLY_ERROR_CODES: Readonly<Record<string, string>> = {
  ambiguous: "LAYER_AMBIGUOUS",
  "not-found": "LAYER_NOT_FOUND",
  "resolution-failed": "PLAN_RESOLUTION_FAILED",
  "invalid-batch": "PLAN_BATCH_INVALID",
  "engine-failed": "APPLY_ENGINE_FAILED",
  "editor-disconnected": "EDITOR_DISCONNECTED",
  "save-failed": "APPLY_SAVE_FAILED",
  "save-conflict": "APPLY_SAVE_CONFLICT",
  conflict: "VERSION_CONFLICT",
  "insufficient-credits": "INSUFFICIENT_CREDITS",
  "base-version-changed": "BASE_VERSION_CHANGED",
  failed: "APPLY_FAILED",
};

/** Everything the wave-2 provider (M4-J) passes to build one controller. */
export interface CreateChatControllerOptions {
  /** The real `ApiClient` (satisfies `ChatControllerClient` structurally) or a fake. */
  readonly client: ChatControllerClient;
  /** Reserved for the tool-executor + provider wiring. */
  readonly workspaceId: string;
  /** Reserved for the tool-executor + provider wiring. */
  readonly projectId: string;
  /** The thread this controller drives; created by the host (M4-J), not here. */
  readonly threadId: string;
  /**
   * Fired whenever the controller enters an error state — fatal send/stream
   * errors, surfaced turn failures and TURN_PAUSED. Not fired for stop().
   */
  readonly onError?: (error: { code: string; message: string }) => void;
  /**
   * The M5 apply engine (BUILD_PLAN §M5.4/§M5.5). When present the store
   * exposes apply/undo/reapply/dismissPlan for the plan card (M5-G's props:
   * onApply/onCancel/onUndo/onReapply); when absent those gestures fold a
   * typed APPLY_UNAVAILABLE error onto the card and nothing executes.
   */
  readonly apply?: ApplyController;
  /**
   * ROUND 12 (pinned seam with i5's tool-executor.ts): builds the per-run
   * client tool executor (read/generative tools execute LOCALLY against the
   * live bridge / gateway tool endpoints). Called once per run with the
   * client-generated runId + the run's context selection; absent ⇒ read/
   * generative calls echo a typed unavailable result (fail-closed, the run
   * continues).
   */
  readonly toolExecutor?: ChatToolExecutorFactory;
  /**
   * ROUND 12: compact canvas snapshot provider. Included in the turn body on
   * step 0 and on every later step whose snapshot JSON hash changed since the
   * last INCLUDED turn (the TURN WIRE CONTRACT's client-side call).
   */
  readonly canvasSnapshot?: () => TurnCanvas | null;
  /** Wall-clock seam (tests); defaults to `Date.now`. */
  readonly now?: () => number;
}

/** The store contract wave-2 consumes (pinned Seam 4 surface). */
export interface ChatController {
  /** The run currently streaming; the most recent run while terminal. */
  readonly runId: string | null;
  /** Referentially stable between changes (useSyncExternalStore contract). */
  getSnapshot(): ChatUiState;
  subscribe(listener: () => void): () => void;
  /**
   * Send now (idle/terminal) or steer the live run (§3.4): the user message
   * renders immediately and rides the NEXT turn as a `steer` part. A send
   * that races the run's very end queues and starts a fresh run.
   */
  send(input: ChatSendInput): void;
  /**
   * §8.3: folds `cancelled` locally at once, aborts the in-flight turn fetch
   * and fire-and-forget POSTs `/v1/runs/:id/abandon` (once per run).
   */
  stop(): void;
  /**
   * Resume a TURN_PAUSED run (re-POST the CURRENT step, SAME idempotency
   * key) or a surfaced retryable turn failure; a run that ENDED starts a
   * FRESH run (new runId — a new key, never a replay of the old log).
   */
  retry(): void;
  /**
   * M5 (§6.2 "Apply", BUILD_PLAN §M5.4): ONE user gesture → the ApplyController
   * runs resolve→patch→ONE `engine.batch`→`saveNow("agent-apply")`→applyRun.
   * The card's busy state folds from the outcome (never a throw).
   */
  apply(plan: ApplicablePlan): void;
  /** §M5.5 "Undo the whole run": `edit.undo` + `undoRun`, folded from the outcome. */
  undo(runId: string): void;
  /** §M5.5 "Re-apply": gated on the plan's base version matching the session. */
  reapply(plan: ApplicablePlan): void;
  /** §6.2 "Cancel": the user dismissed the plan card for this run. */
  dismissPlan(runId: string): void;
  /**
   * M5-Q (F-L1/F-L3): re-save an executed-but-unsaved run — the apply engine's
   * `retrySave` re-runs ONLY the D-6 upload + gateway report (the batch is
   * never re-executed). The card's failed-state Try-again for save failures
   * wires here; without the engine seam the gesture folds the honest
   * unavailable error and nothing runs.
   */
  retrySave(runId: string): void;
  /**
   * M5-Q (§8.7): the user picked a candidate for an ambiguous layer name.
   * Only valid from the ambiguous apply-failure state — the pick folds into
   * the plan's runtime (requestId → layer id, pre-patched into the batch by
   * `applicablePlanOf`) and IMMEDIATELY re-drives the apply. A hostile or
   * unparseable candidate is a no-op (nothing executes). The parse mirrors
   * apply.ts's pinned candidate format `"${layerName} (layer ${id})"`
   * (apply.ts resolveRequests — keep in sync).
   */
  resolveCandidate(runId: string, requestId: string, candidate: string): void;
  /** Abort in-flight, abandon the live run, drop the queue, unsubscribe. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Error mapping helpers
// ---------------------------------------------------------------------------

/** Narrows the api-client's synchronous ApiError-shaped throw to a UI error. */
function toUiError(error: unknown): ChatUiError {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    const retryable = "retryable" in error && error.retryable === true;
    return { code: error.code, message: error.message, retryable };
  }
  return { code: "NETWORK_ERROR", message: "Could not reach the server.", retryable: true };
}

/** ApplyOutcome → the card's typed error surface (never a throw). */
function applyOutcomeError(outcome: Extract<ApplyOutcome, { ok: false }>): ChatUiError {
  return {
    code: APPLY_ERROR_CODES[outcome.reason] ?? "APPLY_FAILED",
    message: outcome.message,
    retryable: false,
  };
}

/** UndoOutcome → the card's typed error surface (never a throw). */
function undoOutcomeError(outcome: Extract<UndoOutcome, { ok: false }>): ChatUiError {
  const code =
    outcome.reason === "nothing-to-undo"
      ? "NOTHING_TO_UNDO"
      : outcome.reason === "editor-disconnected"
        ? "EDITOR_DISCONNECTED"
        : outcome.reason === "conflict"
          ? "VERSION_CONFLICT"
          : outcome.reason === "engine-failed"
            ? "UNDO_ENGINE_FAILED"
            : "UNDO_FAILED";
  return { code, message: outcome.message, retryable: false };
}

/** No apply engine wired (wave-1 coexistence): the card explains, nothing runs. */
const APPLY_UNAVAILABLE: ChatUiError = {
  code: "APPLY_UNAVAILABLE",
  message: "Applying plans is not available in this session.",
  retryable: false,
};

/**
 * apply.ts's pinned candidate format is `"${layerName} (layer ${id})"`
 * (resolveRequests — the ambiguous outcome's candidates). The id is parsed
 * from the END so a hostile layer name that itself contains " (layer N)"
 * cannot spoof a different id.
 */
const CANDIDATE_LAYER_ID_RE = /^[\s\S]* \(layer (\d+)\)$/;

function layerIdOfCandidate(candidate: string): number | null {
  const match = CANDIDATE_LAYER_ID_RE.exec(candidate);
  if (match === null) return null;
  const id = Number.parseInt(match[1] ?? "", 10);
  return Number.isSafeInteger(id) && id >= 0 ? id : null;
}

/** Terminal §7.4 event types the local syntheses reuse. */
type TurnCompletedEvent = Extract<StudioStreamEvent, { type: "turn.completed" }>;

// ---------------------------------------------------------------------------
// The active client-driven run (one per runId)
// ---------------------------------------------------------------------------

/** The live loop state of ONE client-driven run (created by `startRun`). */
interface ActiveRun {
  readonly runId: string;
  readonly input: ChatSendInput;
  /** The per-run client tool executor (i5's seam; null ⇒ fail-closed echo). */
  readonly executor: TurnToolExecutor | null;
  /** The CURRENT-RUN transcript parts (TURN_REQUEST_SCHEMA messages). */
  transcript: TurnMessage[];
  /** §3.4 steer texts waiting for the next turn POST. */
  pendingSteers: string[];
  /** Accumulated write-tool carrier EditPlans (merged at run end). */
  proposals: EditPlan[];
  /** Next model call index (the idempotency key's stepIndex). */
  step: number;
  /** Repetition guard counts: `${tool}:${JSON.stringify(args)}` → occurrences. */
  readonly repetition: Map<string, number>;
  /** Wall-clock start (ms, `options.now`). */
  readonly startedAt: number;
  /** Next LOCAL §7.4 seq for the transport (monotonic across turns). */
  seqBase: number;
  /** The in-flight turn transport, when a POST is live. */
  handle: TurnStreamHandle | null;
  /** A parked attempt's replay cursor (resume dedupe; server seq space). */
  resumeCursor: number | null;
  /** stop()/dispose() folded — the loop returns without touching the phase. */
  stopped: boolean;
  /** TURN_PAUSED parked — retry() re-POSTs the current step, same key. */
  paused: boolean;
  /** A surfaced failure whose step is safe to re-send (same key). */
  resumable: boolean;
  /** The final turn.completed was seen — later sends start a fresh run. */
  ending: boolean;
  /** The run reached its terminal fold — dispose() never abandons it. */
  finished: boolean;
  /** The `/v1/runs/:id/abandon` POST fired (once per run). */
  abandoned: boolean;
  /** JSON hash of the last canvas snapshot INCLUDED in a turn body. */
  lastCanvasHash: string | null;
  /** Whether ANY turn POST already included a canvas snapshot. */
  canvasEverIncluded: boolean;
  /** The last `turn.completed` seen by the event handler (the loop reads it). */
  completed: TurnCompletedEvent | null;
}

/**
 * Reads the transport's captured `turn.completed` WITHOUT control-flow
 * narrowing. The loop resets the field to `null` before each POST and only
 * the onEvent closure can set it again — a DIRECT property read stays
 * narrowed to `null` across the awaited POST, and the null-guard below
 * would then reduce the local to `never`. A function boundary carries the
 * declared `TurnCompletedEvent | null` back instead.
 */
const capturedCompletion = (run: ActiveRun): TurnCompletedEvent | null => run.completed;

export function createChatController(options: CreateChatControllerOptions): ChatController {
  let snapshot: ChatUiState = createInitialChatUiState();
  const listeners = new Set<() => void>();
  /** §3.4 sends that raced the run's very end — they start a fresh run. */
  const queue: ChatSendInput[] = [];
  let activeRun: ActiveRun | null = null;
  let disposed = false;
  /** The last send — a fresh-run retry() replays it. */
  let lastInput: ChatSendInput | null = null;
  /** ROUND-10: runIds already auto-driven — the once-per-run guard. */
  const autoAppliedRuns = new Set<string>();

  const now = options.now ?? Date.now;
  const newRunId = (): string => crypto.randomUUID();

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  /** Commits the next state; a dropped event keeps the old reference (no notify). */
  const commit = (next: ChatUiState): void => {
    if (next === snapshot) return;
    snapshot = next;
    notify();
  };

  const fireOnError = (error: { code: string; message: string }): void => {
    const callback = options.onError;
    if (callback === undefined) return;
    try {
      callback(error);
    } catch {
      /* a host callback must never break the engine */
    }
  };

  const raiseError = (error: ChatUiError): void => {
    commit(applyClientAction(snapshot, { type: "chat.error", error }));
    fireOnError({ code: error.code, message: error.message });
  };

  /** Folds ONE (locally-seq'd) §7.4 event through the pure reducer. */
  const emit = (event: StudioStreamEvent): void => {
    commit(foldEvent(snapshot, event));
    if (event.type === "run.completed") maybeAutoApply(event.runId);
    if (event.type === "run.failed") {
      fireOnError({ code: event.code, message: event.message });
    }
  };

  /** Fire-and-forget `/v1/runs/:id/abandon` — once per run, never rethrows. */
  const abandonOnce = (run: ActiveRun): void => {
    if (run.abandoned) return;
    run.abandoned = true;
    void options.client.runs
      .abandon(run.runId)
      .then(() => undefined)
      .catch(() => {
        /* best-effort: the stale-heartbeat sweep also reads abandoned */
      });
  };

  // -------------------------------------------------------------------------
  // Tool execution + result echo (step 4 of the loop)
  // -------------------------------------------------------------------------

  /** JSON-sanitizes a local tool result so the transcript can never 4xx. */
  const sanitizeResult = (result: unknown): unknown => {
    try {
      JSON.stringify(result);
      return result;
    } catch {
      return {
        error: "TOOL_FAILED",
        message: "The tool returned a result that could not be sent to the model.",
      };
    }
  };

  /**
   * Executes ONE read/generative tool locally (i5's executor) and maps every
   * failure to the tool_result shape the model can recover from — a
   * ClientToolError carries its typed `{code, message}`, anything else is the
   * generic TOOL_FAILED. Never throws, never aborts the run.
   */
  const executeTool = async (run: ActiveRun, call: TurnToolCall): Promise<unknown> => {
    const executor = run.executor;
    if (executor === null || !executor.handles(call.tool)) {
      return {
        error: "CLIENT_TOOL_UNAVAILABLE",
        message: `"${call.tool}" cannot run in this session.`,
      };
    }
    try {
      return sanitizeResult(await executor.execute(call.tool, call.args));
    } catch (error) {
      if (isClientToolError(error)) {
        return { error: error.code, message: error.message };
      }
      return { error: "TOOL_FAILED", message: "The tool call failed." };
    }
  };

  // -------------------------------------------------------------------------
  // The loop (steps 1–5)
  // -------------------------------------------------------------------------

  /** Guards + transcript assembly + ONE turn POST + outcome fold. */
  const runTurn = async (run: ActiveRun): Promise<void> => {
    for (;;) {
      if (disposed || run.stopped) return;

      // --- loop guards (PINNED) ---
      if (run.step >= CHAT_MAX_CLIENT_STEPS || run.transcript.length > MAX_TURN_MESSAGE_PARTS) {
        raiseError({
          code: RUN_STEP_LIMIT_CODE,
          message: "The run reached its step limit.",
          retryable: false,
        });
        run.finished = true;
        flushQueue();
        return;
      }
      if (now() - run.startedAt > CHAT_RUN_TIMEOUT_MS) {
        raiseError({
          code: RUN_TIMEOUT_CODE,
          message: "The run took too long and was stopped.",
          retryable: false,
        });
        run.finished = true;
        flushQueue();
        return;
      }

      // --- §3.4 steers ride the NEXT turn ---
      if (run.pendingSteers.length > 0) {
        for (const text of run.pendingSteers) {
          run.transcript.push({ role: "steer", text });
        }
        run.pendingSteers = [];
      }

      // --- canvas: step 0 always; later steps only on hash change ---
      const canvas = options.canvasSnapshot === undefined ? null : options.canvasSnapshot();
      const canvasHash = JSON.stringify(canvas) ?? "null";
      const includeCanvas = !run.canvasEverIncluded || canvasHash !== run.lastCanvasHash;
      if (includeCanvas) {
        run.canvasEverIncluded = true;
        run.lastCanvasHash = canvasHash;
      }

      const body = {
        runId: run.runId,
        stepIndex: run.step,
        // Shallow copy: the loop keeps APPENDING to `run.transcript` after
        // the turn settles (assistant parts, next-step tool pairs, steers) —
        // the transport must serialize what THIS step looks like, never the
        // still-mutating live array.
        messages: [...run.transcript],
        context: run.input.context,
        pinned: run.input.pinned,
        ...(run.input.model !== undefined ? { model: run.input.model } : {}),
        ...(includeCanvas ? { canvas } : {}),
      };

      // --- ONE bounded turn POST (the api-client owns same-key recovery) ---
      run.completed = null;
      let handle: TurnStreamHandle;
      try {
        handle = options.client.chat.turn(options.threadId, body, {
          seqBase: run.seqBase,
          ...(run.resumeCursor !== null ? { replayCursor: run.resumeCursor } : {}),
          onEvent: (event: StudioStreamEvent): void => {
            if (disposed || run.stopped) return;
            if (event.seq >= run.seqBase) run.seqBase = event.seq + 1;
            if (event.type === "turn.completed") run.completed = event;
            emit(event);
          },
          onReconnect: (): void => {
            if (disposed || run.stopped) return;
            commit(applyClientAction(snapshot, { type: "chat.reconnecting" }));
          },
          onError: (error: { code: string; message: string; retryable: boolean }): void => {
            if (disposed || run.stopped) return;
            raiseError({ code: error.code, message: error.message, retryable: error.retryable });
          },
        });
      } catch (error) {
        // Client-side validation failures throw synchronously (sse.ts contract).
        raiseError(toUiError(error));
        run.finished = true;
        flushQueue();
        return;
      }
      run.handle = handle;
      const summary = await handle.done;
      run.handle = null;

      if (disposed || run.stopped) return; // stop()/dispose() folded the phase

      if (summary.reason === "aborted") {
        return; // the user aborted; the phase already settled
      }
      if (summary.reason === "paused") {
        // TURN_PAUSED: keep the run — retry() re-POSTs THIS step, same key.
        run.paused = true;
        run.resumable = true;
        run.resumeCursor = handle.lastServerSeq;
        return;
      }
      if (summary.reason === "error") {
        // The surfaced turn.failed (after the transport's ONE same-key retry):
        // the run ENDED — retry() starts a FRESH run (new runId, new key).
        run.finished = true;
        flushQueue();
        return;
      }

      const completed: TurnCompletedEvent | null = capturedCompletion(run);
      run.resumeCursor = null;
      if (completed === null) {
        // A terminal close without the capture is a transport anomaly — park.
        run.paused = true;
        run.resumable = true;
        run.resumeCursor = handle.lastServerSeq;
        return;
      }

      // --- fold the outcome into the transcript (assistant + tool pairs) ---
      // An empty assistantText (a pure tool round) is omitted — each tool
      // turn then costs the wire only its call/result pair.
      if ((completed.assistantText ?? "") !== "") {
        run.transcript.push({ role: "assistant", text: completed.assistantText ?? "" });
      }
      let repeatedThrice = false;
      for (const call of completed.toolCalls) {
        run.transcript.push({
          role: "tool_call",
          toolCallId: call.toolCallId,
          tool: call.tool,
          args: call.args,
        });

        // Repetition guard: `${tool}:${JSON.stringify(args)}` occurrences.
        let repetitionKey: string;
        try {
          repetitionKey = `${call.tool}:${JSON.stringify(call.args)}`;
        } catch {
          repetitionKey = `${call.tool}:${String(call.toolCallId)}`;
        }
        const occurrences = (run.repetition.get(repetitionKey) ?? 0) + 1;
        run.repetition.set(repetitionKey, occurrences);

        if (call.proposal?.compiled !== undefined && call.proposal?.compiled !== null) {
          // WRITE tool: accumulate the carrier; echo the propose-only result.
          // The client NEVER executes write tools during the run.
          run.proposals.push(carrierEditPlan(call));
          run.transcript.push({
            role: "tool_result",
            toolCallId: call.toolCallId,
            tool: call.tool,
            result: call.resultForModel,
          });
          // Settle the chip (12-w5-t1 pin): the tool cards light up from
          // tool.started but the turn wire has no tool.result — the loop
          // synthesizes one through the EXISTING §7.4 fold so the card
          // settles with the proposed-batch payload.
          emitToolResult(run, call.toolCallId, call.resultForModel);
        } else {
          // READ/GENERATIVE tool: execute locally, echo the real result.
          const executed = await executeTool(run, call);
          run.transcript.push({
            role: "tool_result",
            toolCallId: call.toolCallId,
            tool: call.tool,
            result: executed,
          });
          emitToolResult(run, call.toolCallId, executed);
        }

        if (occurrences === REPETITION_NUDGE_AT) {
          run.pendingSteers.push(repetitionNudge(call.tool));
        }
        if (occurrences >= REPETITION_ABORT_AT) {
          repeatedThrice = true;
        }
      }
      if (repeatedThrice) {
        raiseError({
          code: RUN_STEP_LIMIT_CODE,
          message: "The run kept proposing the same change.",
          retryable: false,
        });
        run.finished = true;
        flushQueue();
        return;
      }

      if (completed.toolCalls.length === 0) {
        // Run end (TURN WIRE CONTRACT): no tool calls ⇒ the model finished.
        await finishRun(run);
        return;
      }
      run.step += 1;
    }
  };

  // -------------------------------------------------------------------------
  // Run end: merge carriers → plan POST → plan card → local run.completed
  // -------------------------------------------------------------------------

  /**
   * ROUND-12 (12-w5-t1 pin): the turn wire has no tool.result events — the
   * loop synthesizes them through the existing §7.4 fold so every tool chip
   * settles (writes with their proposed batch, reads with their executed
   * result) instead of spinning forever.
   */
  const emitToolResult = (run: ActiveRun, toolCallId: string, result: unknown): void => {
    if (disposed || run.stopped) return;
    run.seqBase += 1;
    emit({ type: "tool.result", runId: run.runId, seq: run.seqBase, toolCallId, result });
  };

  const finishRun = async (run: ActiveRun): Promise<void> => {
    run.ending = true;

    if (run.proposals.length === 0) {
      // End marker (12-w6-e2 finding): a proposal-less run still tells the
      // gateway it finished — the plan route marks the run completed so it
      // never rots as a stale "running" row (and any late apply of a plan
      // POST the run missed stays possible). Fire-and-forget, never blocks
      // the local run.completed fold.
      void options.client.runs.submitPlan(run.runId, { end: true }).then(
        () => undefined,
        () => undefined,
      ); // fire-and-forget by design
    } else {
      const merged = mergeEditPlans(run.proposals);
      if (merged !== null) {
        try {
          // A plan-bearing submit always answers the RunPlanResponse arm —
          // narrow past the {end:true} union member (12-w7).
          const response = (await options.client.runs.submitPlan(run.runId, {
            plan: merged,
          })) as RunPlanResponse;
          if (disposed || run.stopped) return; // stop() during the plan POST
          // Fold the plan card: the SAME shape a `plan` §7.4 event carries —
          // the run-state fold + PlanRuntime build stay untouched. The plan
          // event schema carries every M5 runtime field, so the synthesized
          // event is a first-class StudioStreamEvent.
          const planEvent: StudioStreamEvent = {
            type: "plan",
            runId: run.runId,
            seq: run.seqBase,
            plan: response.plan,
            ...(response.compiledBatch !== undefined
              ? { compiledBatch: response.compiledBatch }
              : {}),
            // The response type is `readonly LayerResolutionRequest[]`; the
            // §7.4 plan-event member carries the mutable array — copy once.
            ...(response.resolutionRequests !== undefined
              ? { resolutionRequests: [...response.resolutionRequests] }
              : {}),
            ...(response.baseVersionId !== undefined
              ? { baseVersionId: response.baseVersionId }
              : {}),
            ...(response.risk !== undefined ? { risk: response.risk } : {}),
            ...(response.estimatedCredits !== undefined
              ? { estimatedCredits: response.estimatedCredits }
              : {}),
            autoApply: { mode: response.autoApply.mode, reason: response.autoApply.reason },
          };
          run.seqBase += 1;
          emit(planEvent);
        } catch (error) {
          // The plan POST is the ONE run-end mutation that must never eat the
          // run: the text/tool folds stand, the error surfaces, the phase
          // still settles through the local run.completed below.
          fireOnError({
            code: toUiError(error).code,
            message: "The plan could not be submitted.",
          });
        }
      }
    }

    if (disposed || run.stopped) return;
    // The LOCAL run.completed synthesis (the server is stateless per turn):
    // phase done + the round-10 auto-apply drive (once per runId).
    run.seqBase += 1;
    emit({ type: "run.completed", runId: run.runId, seq: run.seqBase });
    // §3.4 (12-w5-t1 pin): steers that raced the FINAL turn never rode any
    // POST — the model never saw them. Flush them as fresh sends so the
    // user's words are never silently dropped (their bubbles already
    // rendered at send time; the queued run carries the text).
    for (const text of run.pendingSteers.splice(0)) {
      queue.push({ ...run.input, message: text });
    }
    run.finished = true;
    flushQueue();
  };

  // -------------------------------------------------------------------------
  // Send / steer / stop / retry / dispose
  // -------------------------------------------------------------------------

  /** §3.4: after a terminal phase, the queued sends start in order. */
  const flushQueue = (): void => {
    if (disposed || !TERMINAL_RUN_PHASES.has(snapshot.phase)) return;
    const next = queue.shift();
    if (next === undefined) return;
    startRun(next);
  };

  const startRun = (input: ChatSendInput): void => {
    const runId = newRunId();
    const run: ActiveRun = {
      runId,
      input,
      executor:
        options.toolExecutor === undefined
          ? null
          : options.toolExecutor({ runId, context: input.context }),
      transcript: [{ role: "user", text: input.message }],
      pendingSteers: [],
      proposals: [],
      step: 0,
      repetition: new Map<string, number>(),
      startedAt: now(),
      seqBase: 0,
      handle: null,
      resumeCursor: null,
      stopped: false,
      paused: false,
      resumable: false,
      ending: false,
      finished: false,
      abandoned: false,
      lastCanvasHash: null,
      canvasEverIncluded: false,
      completed: null,
    };
    lastInput = input;
    activeRun = run;
    commit(applyClientAction(snapshot, { type: "chat.submit" }));
    void runTurn(run).catch((error: unknown) => {
      // runTurn is written never to reject; an escape must not surface as an
      // unhandled rejection — fold the honest failure.
      if (disposed || run.stopped) return;
      raiseError(toUiError(error));
      run.finished = true;
      flushQueue();
    });
  };

  const send = (input: ChatSendInput): void => {
    if (disposed || input.message.trim() === "") return;
    const run = activeRun;
    if (LIVE_RUN_PHASES.has(snapshot.phase)) {
      // §3.4 steer: render immediately; ride the next turn as a steer part.
      // A send racing the run's very end (the final completed is in, the
      // plan POST is settling) queues for a fresh run instead.
      if (run !== null && !run.ending) {
        run.pendingSteers.push(input.message);
        commit(applyUserMessage(snapshot, { id: crypto.randomUUID(), text: input.message }));
        return;
      }
      queue.push(input);
      commit(applyUserMessage(snapshot, { id: crypto.randomUUID(), text: input.message }));
      return;
    }
    commit(applyUserMessage(snapshot, { id: crypto.randomUUID(), text: input.message }));
    startRun(input);
  };

  const stop = (): void => {
    if (disposed || !LIVE_RUN_PHASES.has(snapshot.phase)) return;
    // §8.3: local phase settles at once; the in-flight fetch aborts; the run
    // is abandoned server-side (holds refunded) — fire-and-forget, once.
    commit(applyClientAction(snapshot, { type: "chat.stop" }));
    const run = activeRun;
    if (run === null) return;
    run.stopped = true;
    run.resumable = false;
    run.handle?.abort();
    abandonOnce(run);
  };

  const retry = (): void => {
    if (disposed || snapshot.phase !== "failed") return;
    const run = activeRun;
    if (run?.resumable && !run.stopped) {
      // TURN_PAUSED (or a surfaced turn failure whose step never persisted):
      // re-send the CURRENT step — SAME body key `${runId}:${stepIndex}` —
      // the gateway replays/continues idempotently, never a duplicate run.
      run.paused = false;
      run.resumable = false;
      commit(applyClientAction(snapshot, { type: "chat.reconnecting" }));
      void runTurn(run).catch(() => {
        /* the catch inside startRun owns unexpected escapes */
      });
      return;
    }
    // The run ENDED (guard abort / terminal failure / cancelled): a fresh
    // runId — a new idempotency key — never a replay of the old run's log.
    const input = lastInput;
    if (input === null) return;
    activeRun = null;
    startRun(input);
  };

  const dispose = (): void => {
    disposed = true;
    const run = activeRun;
    activeRun = null;
    queue.length = 0;
    if (run !== null) {
      run.stopped = true;
      run.handle?.abort();
      if (!run.finished) abandonOnce(run);
    }
    listeners.clear();
  };

  // -------------------------------------------------------------------------
  // M5 apply/undo gestures (§6.2/§M5.4/§M5.5) — unchanged from wave-1/M5: the
  // plan card (M5-G) gets these as onApply/onCancel/onUndo/onReapply props.
  // -------------------------------------------------------------------------

  /** Folds the busy state, runs the gesture, folds the typed outcome. */
  const runApplyGesture = (
    plan: ApplicablePlan,
    gesture: (apply: ApplyController) => Promise<ApplyOutcome>,
  ): void => {
    if (disposed) return;
    commit(applyClientAction(snapshot, { type: "chat.plan.apply", runId: plan.runId }));
    const engine = options.apply;
    if (engine === undefined) {
      // Wave-1 coexistence: no apply engine wired — the card explains and
      // nothing executes (no engine.batch, no save, no applyRun).
      commit(
        applyClientAction(snapshot, {
          type: "chat.plan.apply-failed",
          runId: plan.runId,
          error: APPLY_UNAVAILABLE,
        }),
      );
      return;
    }
    void gesture(engine)
      .then((outcome) => {
        if (disposed) return;
        if (outcome.ok) {
          commit(
            applyClientAction(snapshot, {
              type: "chat.plan.applied",
              runId: plan.runId,
              versionId: outcome.versionId,
              ...(outcome.creditsCommitted !== undefined
                ? { creditsCommitted: outcome.creditsCommitted }
                : {}),
            }),
          );
          return;
        }
        commit(
          applyClientAction(snapshot, {
            type: "chat.plan.apply-failed",
            runId: plan.runId,
            error: applyOutcomeError(outcome),
            // §8.7 (M5-Q): the ambiguous outcome's candidate strings ride the
            // fold so the card can render pick buttons (apply.ts's pinned
            // format).
            ...(outcome.ok === false && outcome.reason === "ambiguous"
              ? { candidates: outcome.candidates }
              : {}),
          }),
        );
      })
      .catch(() => {
        // The apply engine never throws; a rejection here is a broken engine —
        // the card still settles honestly instead of spinning forever.
        if (disposed) return;
        commit(
          applyClientAction(snapshot, {
            type: "chat.plan.apply-failed",
            runId: plan.runId,
            error: {
              code: "APPLY_FAILED",
              message: "The plan could not be applied.",
              retryable: false,
            },
          }),
        );
      });
  };

  const apply = (plan: ApplicablePlan): void => {
    runApplyGesture(plan, (engine) => engine.apply(plan));
  };

  // -------------------------------------------------------------------------
  // ROUND-10 v2: the AUTO-APPLY DRIVE. When the server's §7.3 verdict on a
  // run's plan is `mode: "auto"`, the client EXECUTES it automatically once
  // the run completes — Apply is no longer a click the user must remember to
  // make. Undo on the applied card is the one-click escape hatch.
  // Guards (all must hold — anything uncertain stays a manual Apply card):
  //   * once per runId — replays and reconnects never re-apply,
  //   * only runs whose (local) run.completed folded LIVE in this controller,
  //   * only when the apply engine exists (read-only embeds never execute),
  //   * only plans with NO unresolved layer-name requests — ambiguity needs
  //     the user's pick (the card's §8.7 resolve flow),
  //   * only an idle, non-dismissed card — a racing user gesture wins.
  // -------------------------------------------------------------------------
  const maybeAutoApply = (runId: string): void => {
    if (disposed) return;
    if (autoAppliedRuns.has(runId)) return;
    if (options.apply === undefined) return;
    const runtime = planRuntimeOf(snapshot, runId);
    if (runtime === undefined) return;
    if (runtime.autoApply?.mode !== "auto") return;
    if (runtime.outcome !== "idle" || runtime.dismissed === true) return;
    const plan = applicablePlanOf(snapshot, runId);
    if (plan === null) return;
    if (plan.resolutionRequests !== undefined && plan.resolutionRequests.length > 0) return;
    autoAppliedRuns.add(runId);
    apply(plan);
  };

  const reapply = (plan: ApplicablePlan): void => {
    runApplyGesture(plan, (engine) => engine.reapply(plan));
  };

  /** F-L1 (M5-Q): the re-save-only recovery — folds like an apply gesture. */
  const retrySave = (runId: string): void => {
    if (disposed) return;
    commit(applyClientAction(snapshot, { type: "chat.plan.apply", runId }));
    const engine = options.apply;
    const retry = engine?.retrySave;
    if (engine === undefined || retry === undefined) {
      // No retry seam on this engine: explain, never execute anything.
      commit(
        applyClientAction(snapshot, {
          type: "chat.plan.apply-failed",
          runId,
          error: APPLY_UNAVAILABLE,
        }),
      );
      return;
    }
    void retry
      .call(engine, runId)
      .then((outcome) => {
        if (disposed) return;
        if (outcome.ok) {
          commit(
            applyClientAction(snapshot, {
              type: "chat.plan.applied",
              runId,
              versionId: outcome.versionId,
              ...(outcome.creditsCommitted !== undefined
                ? { creditsCommitted: outcome.creditsCommitted }
                : {}),
            }),
          );
          return;
        }
        commit(
          applyClientAction(snapshot, {
            type: "chat.plan.apply-failed",
            runId,
            error: applyOutcomeError(outcome),
          }),
        );
      })
      .catch(() => {
        if (disposed) return;
        commit(
          applyClientAction(snapshot, {
            type: "chat.plan.apply-failed",
            runId,
            error: {
              code: "APPLY_FAILED",
              message: "The plan could not be applied.",
              retryable: false,
            },
          }),
        );
      });
  };

  const undo = (runId: string): void => {
    if (disposed) return;
    commit(applyClientAction(snapshot, { type: "chat.plan.undo", runId }));
    const engine = options.apply;
    if (engine === undefined) {
      commit(
        applyClientAction(snapshot, {
          type: "chat.plan.undo-failed",
          runId,
          error: APPLY_UNAVAILABLE,
        }),
      );
      return;
    }
    void engine
      .undo(runId)
      .then((outcome) => {
        if (disposed) return;
        if (outcome.ok) {
          commit(applyClientAction(snapshot, { type: "chat.plan.undone", runId }));
        } else {
          commit(
            applyClientAction(snapshot, {
              type: "chat.plan.undo-failed",
              runId,
              error: undoOutcomeError(outcome),
            }),
          );
        }
      })
      .catch(() => {
        if (disposed) return;
        commit(
          applyClientAction(snapshot, {
            type: "chat.plan.undo-failed",
            runId,
            error: {
              code: "UNDO_FAILED",
              message: "The run could not be undone.",
              retryable: false,
            },
          }),
        );
      });
  };

  const dismissPlan = (runId: string): void => {
    if (disposed) return;
    commit(applyClientAction(snapshot, { type: "chat.plan.dismiss", runId }));
  };

  const resolveCandidate = (runId: string, requestId: string, candidate: string): void => {
    if (disposed) return;
    // Only from the ambiguous apply-failure state — any other origin (a stale
    // card, a scripted double-click) folds nothing and executes nothing.
    const runtime = planRuntimeOf(snapshot, runId);
    if (runtime === undefined || runtime.outcome !== "apply-failed") return;
    if (runtime.error?.code !== "LAYER_AMBIGUOUS") return;
    const layerId = layerIdOfCandidate(candidate);
    if (layerId === null) return; // hostile/unparseable candidate: inert no-op
    commit(applyClientAction(snapshot, { type: "chat.plan.resolve", runId, requestId, layerId }));
    // The pick folded — re-drive the apply with the pre-patched plan.
    const nextPlan = applicablePlanOf(snapshot, runId);
    if (nextPlan === null) return;
    apply(nextPlan);
  };

  return {
    get runId(): string | null {
      return snapshot.activeRunId;
    },
    getSnapshot: (): ChatUiState => snapshot,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    send,
    stop,
    retry,
    apply,
    undo,
    reapply,
    retrySave,
    dismissPlan,
    resolveCandidate,
    dispose,
  };
}
