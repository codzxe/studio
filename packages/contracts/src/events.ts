// @studio/contracts — Studio SSE stream events (PRODUCT_ARCHITECTURE.md §7.4)
// and the client run-state reducer (EDITOR_CHAT_UX §8.1/§8.2).
//
// `POST /v1/threads/:id/chat` returns an AI SDK UI stream; product-specific
// events are sent as data parts. Rules (§7.4):
//   * Events are ordered per run; every event carries `runId` and a monotonic
//     per-run `seq`.
//   * Reconnect with `Last-Event-ID`; the server replays from the run log —
//     the reducer deduplicates by `seq`, so replays are idempotent.
//   * Tool results from the client are accepted only with the run token and
//     only for the expected `toolCallId`.

import { z } from "zod";

import { EDIT_PLAN_SCHEMA, type EditPlan, PLAN_RISK_SCHEMA } from "./edit-plan.js";
import { AGENT_BATCH_SCHEMA } from "./engine-batch.js";

// ---------------------------------------------------------------------------
// Event schemas (§7.4 exact, plus the mandatory runId + monotonic seq)
// ---------------------------------------------------------------------------

const runIdField = z.string().min(1);
const seqField = z.number().int().nonnegative();
const toolCallIdField = z.string().min(1);

export const RUN_STARTED_EVENT_SCHEMA = z.object({
  type: z.literal("run.started"),
  runId: runIdField,
  seq: seqField,
  model: z.string().min(1),
});

export const MESSAGE_DELTA_EVENT_SCHEMA = z.object({
  type: z.literal("message.delta"),
  runId: runIdField,
  seq: seqField,
  delta: z.string(),
});

export const TOOL_STARTED_EVENT_SCHEMA = z.object({
  type: z.literal("tool.started"),
  runId: runIdField,
  seq: seqField,
  toolCallId: toolCallIdField,
  name: z.string().min(1),
  args: z.unknown(),
});

export const TOOL_DELTA_EVENT_SCHEMA = z.object({
  type: z.literal("tool.delta"),
  runId: runIdField,
  seq: seqField,
  toolCallId: toolCallIdField,
  delta: z.string(),
});

export const TOOL_RESULT_EVENT_SCHEMA = z.object({
  type: z.literal("tool.result"),
  runId: runIdField,
  seq: seqField,
  toolCallId: toolCallIdField,
  result: z.unknown(),
});

/**
 * One layer-id disambiguation request emitted by the server-side plan
 * compiler (M5-SEAMS): the compiled batch references a layer BY NAME and the
 * CLIENT resolves the id via the bridge (`list_layers`) when applying —
 * layer ids never enter the model context (§8.7).
 */
export const LAYER_RESOLUTION_REQUEST_SCHEMA = z.object({
  requestId: z.string().min(1),
  layerName: z.string().min(1),
  disambiguation: z.array(z.string()),
});

export type LayerResolutionRequest = z.infer<typeof LAYER_RESOLUTION_REQUEST_SCHEMA>;

/** M5.6 (§7.3): the auto-apply verdict modes — "auto" arms the card, never
 * bypasses the Apply click (D-22 candidate ruling, worklog M5-O). */
export const AUTO_APPLY_MODE_SCHEMA = z.enum(["auto", "propose"]);

/**
 * M5.6 auto-apply verdict (BUILD_PLAN §M5 task 6, EDITOR_CHAT_UX §7.3 — off
 * by default): the gateway's SERVER-SIDE decision attached to the plan event.
 * `reason` is a stable, human-safe policy CODE from the gateway's decision
 * module (services/gateway/src/auto-apply.ts — never stack traces, paths or
 * internal ids, law #1); clients own their human copy per reason.
 */
export const PLAN_AUTO_APPLY_SCHEMA = z.object({
  mode: AUTO_APPLY_MODE_SCHEMA,
  reason: z.string().min(1).max(120),
});

export type PlanAutoApplyDecision = z.infer<typeof PLAN_AUTO_APPLY_SCHEMA>;

export const PLAN_EVENT_SCHEMA = z.object({
  type: z.literal("plan"),
  runId: runIdField,
  seq: seqField,
  plan: EDIT_PLAN_SCHEMA,
  // M5 (BUILD_PLAN §M5.1/§M5.2, M5-SEAMS): the gateway plan-compiler runs
  // server-side when studio.plan_edit resolves and its output is attached
  // here. ALL FOUR FIELDS ARE OPTIONAL — the wire stays BACKWARDS COMPATIBLE:
  // M4 events carry none of them, M4 consumers keep parsing (z.object strips
  // unknown keys on older schema copies; absent fields parse on this one).
  /** Compiled `engine.batch` payload (§8.5); absent ⇒ the plan is display-only. */
  compiledBatch: AGENT_BATCH_SCHEMA.optional(),
  /** Layer names the client must disambiguate before applying. */
  resolutionRequests: z.array(LAYER_RESOLUTION_REQUEST_SCHEMA).optional(),
  /** Server-recomputed risk (never the model's self-declared value). */
  risk: PLAN_RISK_SCHEMA.optional(),
  /** Server-recomputed deterministic credit estimate (§8.8). */
  estimatedCredits: z.number().nonnegative().optional(),
  /**
   * The project's version head at propose time (M5-Q; DECISIONS.md D-21 /
   * BP §M5.5): the version the client must STILL be sitting on for re-apply
   * after an undo. The gateway stamps the run's recorded base version here
   * (the same value the /v1/runs/:id/apply lineage gate checks server-side).
   * Optional + additive: M4/M5.0 events carry none and the client's reapply
   * gate fails closed (base-version-changed) without it.
   */
  baseVersionId: z.string().optional(),
  // M5.6 (§7.3, additive + optional like the four above): the server-side
  // auto-apply verdict — UI GUIDANCE ONLY in v1: the client NEVER executes a
  // plan from the event alone; Apply stays the user's explicit button press.
  autoApply: PLAN_AUTO_APPLY_SCHEMA.optional(),
});

export const PREVIEW_EVENT_SCHEMA = z.object({
  type: z.literal("preview"),
  runId: runIdField,
  seq: seqField,
  pngBase64: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const APPROVAL_REQUIRED_EVENT_SCHEMA = z.object({
  type: z.literal("approval.required"),
  runId: runIdField,
  seq: seqField,
  plan: EDIT_PLAN_SCHEMA,
});

export const CREDITS_EVENT_SCHEMA = z.object({
  type: z.literal("credits"),
  runId: runIdField,
  seq: seqField,
  reserved: z.number().nonnegative(),
  committed: z.number().nonnegative(),
  balance: z.number().nonnegative(),
});

export const RUN_COMPLETED_EVENT_SCHEMA = z.object({
  type: z.literal("run.completed"),
  runId: runIdField,
  seq: seqField,
  versionId: z.string().min(1).optional(),
});

export const RUN_FAILED_EVENT_SCHEMA = z.object({
  type: z.literal("run.failed"),
  runId: runIdField,
  seq: seqField,
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
});

export const RUN_CANCELLED_EVENT_SCHEMA = z.object({
  type: z.literal("run.cancelled"),
  runId: runIdField,
  seq: seqField,
});

/** All 12 §7.4 event types, in wire order. */
export const STUDIO_STREAM_EVENT_TYPES = [
  "run.started",
  "message.delta",
  "tool.started",
  "tool.delta",
  "tool.result",
  "plan",
  "preview",
  "approval.required",
  "credits",
  "run.completed",
  "run.failed",
  "run.cancelled",
] as const satisfies readonly string[];

export type StudioStreamEventType = (typeof STUDIO_STREAM_EVENT_TYPES)[number];

export const STUDIO_STREAM_EVENT_SCHEMA = z.discriminatedUnion("type", [
  RUN_STARTED_EVENT_SCHEMA,
  MESSAGE_DELTA_EVENT_SCHEMA,
  TOOL_STARTED_EVENT_SCHEMA,
  TOOL_DELTA_EVENT_SCHEMA,
  TOOL_RESULT_EVENT_SCHEMA,
  PLAN_EVENT_SCHEMA,
  PREVIEW_EVENT_SCHEMA,
  APPROVAL_REQUIRED_EVENT_SCHEMA,
  CREDITS_EVENT_SCHEMA,
  RUN_COMPLETED_EVENT_SCHEMA,
  RUN_FAILED_EVENT_SCHEMA,
  RUN_CANCELLED_EVENT_SCHEMA,
]);

export type StudioStreamEvent = z.infer<typeof STUDIO_STREAM_EVENT_SCHEMA>;

export function isStudioStreamEvent(value: unknown): value is StudioStreamEvent {
  return STUDIO_STREAM_EVENT_SCHEMA.safeParse(value).success;
}

// ---------------------------------------------------------------------------
// Client run state machine (EDITOR_CHAT_UX §8.1)
// ---------------------------------------------------------------------------

export const RUN_STATUSES = [
  "idle",
  "sending",
  "streaming",
  "awaiting_approval",
  "applying",
  "applied",
  "undoing",
  "undone",
  "cancelling",
  "cancelled",
  "failed",
] as const satisfies readonly string[];

export type RunStatus = (typeof RUN_STATUSES)[number];

/** Live tool-call card (EDITOR_CHAT_UX §6.1): cards appear as the call starts. */
export interface ToolCallState {
  readonly toolCallId: string;
  readonly name: string;
  readonly status: "running" | "done";
  readonly args?: unknown;
  readonly deltaText: string;
  readonly result?: unknown;
}

/** Latest `preview` frame (§7.4). */
export interface RunPreviewState {
  readonly pngBase64: string;
  readonly width: number;
  readonly height: number;
  readonly seq: number;
}

/** Latest `credits` snapshot (§7.4). */
export interface RunCreditsState {
  readonly reserved: number;
  readonly committed: number;
  readonly balance: number;
  readonly seq: number;
}

/** Terminal `run.failed` payload (§7.4). */
export interface RunErrorState {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

/** Everything the chat panel tracks for one run. */
export interface RunState {
  readonly runId: string | null;
  readonly status: RunStatus;
  readonly model: string | null;
  readonly text: string;
  readonly toolCalls: readonly ToolCallState[];
  readonly plan: EditPlan | null;
  readonly approvalRequired: boolean;
  readonly preview: RunPreviewState | null;
  readonly credits: RunCreditsState | null;
  readonly versionId: string | null;
  readonly error: RunErrorState | null;
  /** Highest accepted event seq; `-1` before the first event. */
  readonly lastSeq: number;
}

export const INITIAL_RUN_STATE: RunState = {
  runId: null,
  status: "idle",
  model: null,
  text: "",
  toolCalls: [],
  plan: null,
  approvalRequired: false,
  preview: null,
  credits: null,
  versionId: null,
  error: null,
  lastSeq: -1,
};

/**
 * Client-driven transitions (§8.1 states driven by the user, not the stream):
 * submit a new message, Apply, undo, cancel. SSE-independent, so they never
 * consume a seq.
 */
export type RunClientAction =
  | { readonly type: "run.submit" }
  | { readonly type: "run.apply" }
  | { readonly type: "run.applied"; readonly versionId?: string }
  | { readonly type: "run.undo" }
  | { readonly type: "run.undone" }
  | { readonly type: "run.cancel" };

const RUN_CLIENT_ACTION_TYPES: ReadonlySet<string> = new Set([
  "run.submit",
  "run.apply",
  "run.applied",
  "run.undo",
  "run.undone",
  "run.cancel",
]);

function isRunClientAction(input: RunStateInput): input is RunClientAction {
  return (
    typeof input === "object" &&
    input !== null &&
    RUN_CLIENT_ACTION_TYPES.has((input as { type: unknown }).type as string)
  );
}

export type RunStateInput = StudioStreamEvent | RunClientAction;

// ---------------------------------------------------------------------------
// Reducer rules (documented contract for client state machines)
// ---------------------------------------------------------------------------
// * Ordering: events with `seq <= lastSeq` are dropped (Last-Event-ID replay is
//   idempotent); events for a different `runId` than the bound run are dropped;
//   events before `run.started` are dropped while `idle`.
// * Terminal states (`cancelled`, `failed`, `undone`) ignore the whole stream —
//   a late tail can no longer change the outcome.
// * `applied` and `cancelling` accept passive data (`credits`, `preview`,
//   text/tool deltas) but only `run.completed` / `run.failed` / `run.cancelled`
//   can still change the status — cancellation never auto-undoes an applied
//   batch (§8.3).
// * Invalid client transitions are no-ops (pure, total: never throws).

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(["cancelled", "failed", "undone"]);
const SUBMITTABLE_STATUSES: ReadonlySet<RunStatus> = new Set([
  "idle",
  "applied",
  "undone",
  "cancelled",
  "failed",
]);

function applyAction(state: RunState, action: RunClientAction): RunState {
  switch (action.type) {
    case "run.submit": {
      if (!SUBMITTABLE_STATUSES.has(state.status)) return state;
      return { ...INITIAL_RUN_STATE, status: "sending" };
    }
    case "run.cancel": {
      // §8.1 "any state → cancelling", except idle (no run to cancel) and
      // already-terminal states.
      if (
        state.status === "idle" ||
        TERMINAL_STATUSES.has(state.status) ||
        state.status === "cancelling"
      ) {
        return state;
      }
      return { ...state, status: "cancelling" };
    }
    case "run.apply": {
      const applicable =
        state.plan !== null &&
        (state.status === "awaiting_approval" || state.status === "streaming");
      if (!applicable) return state;
      return { ...state, status: "applying", approvalRequired: false };
    }
    case "run.applied": {
      const applicable =
        state.plan !== null &&
        (state.status === "applying" ||
          state.status === "awaiting_approval" ||
          state.status === "streaming");
      if (!applicable) return state;
      return {
        ...state,
        status: "applied",
        versionId: action.versionId ?? state.versionId,
        approvalRequired: false,
      };
    }
    case "run.undo": {
      if (state.status !== "applied") return state;
      return { ...state, status: "undoing" };
    }
    case "run.undone": {
      if (state.status !== "undoing") return state;
      return { ...state, status: "undone" };
    }
  }
}

/** Deep-writable draft for building the next state immutably. */
type WritableRunState = { -readonly [K in keyof RunState]: RunState[K] };

function applyEvent(state: RunState, event: StudioStreamEvent): RunState {
  if (state.runId !== null && event.runId !== state.runId) return state;
  if (state.status === "idle" && event.type !== "run.started") return state;
  if (event.seq <= state.lastSeq) return state;
  if (TERMINAL_STATUSES.has(state.status)) return state;

  const passiveOnly = state.status === "applied" || state.status === "cancelling";
  const mayTransition = !passiveOnly;
  const next: WritableRunState = { ...state, runId: event.runId, lastSeq: event.seq };

  switch (event.type) {
    case "run.started": {
      if (mayTransition) next.status = "streaming";
      next.model = event.model;
      break;
    }
    case "message.delta": {
      if (state.status === "sending" && mayTransition) next.status = "streaming";
      next.text = state.text + event.delta;
      break;
    }
    case "tool.started": {
      next.toolCalls = [
        ...state.toolCalls,
        {
          toolCallId: event.toolCallId,
          name: event.name,
          args: event.args,
          status: "running",
          deltaText: "",
        },
      ];
      break;
    }
    case "tool.delta": {
      next.toolCalls = state.toolCalls.map((call) =>
        call.toolCallId === event.toolCallId
          ? { ...call, deltaText: call.deltaText + event.delta }
          : call,
      );
      break;
    }
    case "tool.result": {
      const known = state.toolCalls.some((call) => call.toolCallId === event.toolCallId);
      const doneCall: ToolCallState = {
        toolCallId: event.toolCallId,
        name: "",
        status: "done",
        deltaText: "",
        result: event.result,
      };
      next.toolCalls = state.toolCalls.map((call) =>
        call.toolCallId === event.toolCallId
          ? { ...call, status: "done" as const, result: event.result }
          : call,
      );
      if (!known) next.toolCalls = [...state.toolCalls, doneCall];
      break;
    }
    case "plan": {
      next.plan = event.plan;
      if (mayTransition && event.plan.requiresApproval) next.status = "awaiting_approval";
      break;
    }
    case "approval.required": {
      next.plan = event.plan;
      if (mayTransition) {
        next.status = "awaiting_approval";
        next.approvalRequired = true;
      }
      break;
    }
    case "preview": {
      next.preview = {
        pngBase64: event.pngBase64,
        width: event.width,
        height: event.height,
        seq: event.seq,
      };
      break;
    }
    case "credits": {
      next.credits = {
        reserved: event.reserved,
        committed: event.committed,
        balance: event.balance,
        seq: event.seq,
      };
      break;
    }
    case "run.completed": {
      next.status = "applied";
      next.versionId = event.versionId ?? state.versionId;
      next.approvalRequired = false;
      break;
    }
    case "run.failed": {
      next.status = "failed";
      next.error = { code: event.code, message: event.message, retryable: event.retryable };
      next.approvalRequired = false;
      break;
    }
    case "run.cancelled": {
      next.status = "cancelled";
      next.approvalRequired = false;
      break;
    }
  }
  return next;
}

/**
 * Pure reducer for a client run state machine (§8.1): folds one stream event or
 * client action into `state`. Total (never throws) and immutable; invalid
 * transitions are no-ops.
 */
export function applyEvents(state: RunState, input: RunStateInput): RunState {
  return isRunClientAction(input) ? applyAction(state, input) : applyEvent(state, input);
}

/** Convenience fold: `reduceEvents(events)` over `INITIAL_RUN_STATE`. */
export function reduceEvents(
  inputs: Iterable<RunStateInput>,
  initial: RunState = INITIAL_RUN_STATE,
): RunState {
  let state = initial;
  for (const input of inputs) state = applyEvents(state, input);
  return state;
}
