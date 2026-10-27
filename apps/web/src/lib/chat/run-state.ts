/**
 * Pure chat run-state reducer — Seam 4 of docs/phases/M4-SEAMS.md
 * (EDITOR_CHAT_UX §8.1/§8.2/§8.4; PRODUCT_ARCHITECTURE.md §7.4).
 *
 * `foldEvent` folds ONE normalized §7.4 event (as parsed + validated by
 * `@studio/api-client`'s SSE reader — never re-validated here) into the
 * whole-thread `ChatUiState`. Total, immutable and replay-idempotent:
 *
 *  * New-run takeover — the first `run.started` for a run the thread has no
 *    assistant message for creates the placeholder bound to that `runId`,
 *    flips the phase to `streaming`, clears any stale error and RESETS the
 *    seq cursor to that run's seq space (§7.4 seqs are per-run).
 *  * Older runs stay frozen — events for any run other than `activeRunId`
 *    are dropped, so a replay of a finished run can never mutate it.
 *  * Replay dedupe — events at/below `lastSeq` for the active run are
 *    dropped, so a `Last-Event-ID` replay (or re-feeding the same list) is a
 *    no-op and the returned reference is unchanged.
 *  * Terminal freeze — once the active run is done/failed/cancelled its
 *    message no longer accepts content events, but a later TERMINAL event
 *    for the same run still reconciles the phase (server truth: a
 *    `run.completed` that lands after a local stop flips `cancelled` →
 *    `done`; §8.3 "cancellation never auto-undoes an applied batch").
 *  * `preview`/`approval.required` advance the cursor but change nothing
 *    else in M4 (previews ride tool cards).
 *
 * M5 (BUILD_PLAN §M5.3–§M5.5): a `plan` event may additionally carry the
 * server-compiled batch + layer-resolution requests + the base version
 * (M5-C adds them to the wire; the SSE reader strips unknown keys until
 * then). When present they fold into the message's `planRuntime` for the
 * ApplyController (M5-F); the thread phase is untouched, so M4 behavior is
 * byte-identical without them.
 *
 * Client-driven transitions (§8.1 states the USER causes — submit, stop, the
 * §8.4 reconnect banner, the pause, and the M5 apply/undo gestures) never
 * consume a seq; they live in `applyClientAction`.
 */

import type { StudioStreamEvent } from "@studio/contracts";

import { type ApplicablePlan, type LayerResolutionRequest, RESOLVE_TOKEN_PREFIX } from "./apply";
import type {
  ChatBlockedCreditsState,
  ChatUiError,
  ChatUiMessage,
  ChatUiState,
  PlanRuntime,
  RunPhase,
  ToolCardState,
} from "./types";
import { INSUFFICIENT_CREDITS_CODE } from "./types";

/** Phases that mean "a run just ended" — steer queues flush on these. */
export const TERMINAL_RUN_PHASES: ReadonlySet<RunPhase> = new Set<RunPhase>([
  "done",
  "failed",
  "cancelled",
]);

/** Phases that mean "a run/stream is live". */
export const LIVE_RUN_PHASES: ReadonlySet<RunPhase> = new Set<RunPhase>([
  "sending",
  "streaming",
  "reconnecting",
]);

/** Fresh thread state: no messages, idle, seq cursor below the first event. */
export function createInitialChatUiState(): ChatUiState {
  return { messages: [], phase: "idle", activeRunId: null, lastSeq: -1 };
}

/** §8.4 "Run paused. Check your connection." — retryable; `retry()` resumes. */
export const RUN_PAUSED_ERROR: ChatUiError = {
  code: "RUN_PAUSED",
  message: "Run paused. Check your connection.",
  retryable: true,
};

// ---------------------------------------------------------------------------
// M6-H: credits visibility + the typed zero-balance block (§8.8/§12)
// ---------------------------------------------------------------------------

/**
 * M6-H: derives the typed blocked state from an `INSUFFICIENT_CREDITS`
 * failure (the §7.3 message is human-safe copy — law #1). Pure.
 */
function blockedCreditsFrom(error: {
  readonly code: string;
  readonly message: string;
}): ChatBlockedCreditsState {
  return { reason: "insufficient-credits", message: error.message };
}

/**
 * M6-H: the NEWEST §7.4 `credits` snapshot on the thread — the terminal
 * `credits` event the gateway emits when it settles the run (reserved →
 * commit/refund), which carries the post-run `balance`.
 *
 * UNITS PIN (w3-b01): the §7.4 `credits` SSE event carries WHOLE-CREDIT
 * DISPLAY units (gateway routes/chat.ts: "the SSE `credits` event carries
 * whole-credit display units" — `microcreditsToDisplayCredits` at the
 * emitter; e.g. `balance: 42.5`), NOT µc. `reserved`/`committed` ride the
 * same display units on that emitter.
 *
 * UNKNOWN ≠ 0: in the round-12 turn wire `turn.completed` carries
 * `credits: { committed }` ONLY (contracts events.ts) — the fold marks the
 * unsaid `reserved`/`balance` as `Number.NaN` (the codebase's designed
 * unknown for credit numbers — the usage-meters precedent), NEVER a
 * fabricated 0. Consumers must treat non-finite as "unknown" (render
 * nothing / never lock); `NaN === 0` is false, so a phony drained-wallet
 * lock is impossible by construction. Pure; `null` when no run has
 * reported credits yet.
 */
export function latestCreditsSnapshot(
  state: ChatUiState,
): NonNullable<ChatUiMessage["credits"]> | null {
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const message = state.messages[index];
    if (message?.credits !== undefined) return message.credits;
  }
  return null;
}

/**
 * Client-driven §8.1 transitions the CONTROLLER dispatches (never the
 * stream): `chat.submit` a send is in flight; `chat.stop` the user hit stop
 * (local phase settles immediately; a late terminal event reconciles it);
 * `chat.reconnecting` the §8.4 banner (also dispatched when resuming a
 * RUN_PAUSED run — only while a resumable stream exists); `chat.paused`
 * backoff exhausted; `chat.error` a fatal send/stream error. The
 * `chat.plan.*` arms are the M5 apply/undo gestures — they fold the plan's
 * per-message runtime only (see `PlanRuntime`), never the thread phase.
 */
export type ChatClientAction =
  | { readonly type: "chat.submit" }
  | { readonly type: "chat.stop" }
  | { readonly type: "chat.reconnecting" }
  | { readonly type: "chat.paused" }
  | { readonly type: "chat.error"; readonly error: ChatUiError }
  // M5 plan-card gestures (§6.2/§M5.4/§M5.5) — they fold the message's
  // planRuntime, never the thread phase. Pinned seam names for M5-G:
  // onApply / onCancel / onUndo / onReapply.
  | { readonly type: "chat.plan.apply"; readonly runId: string }
  | {
      readonly type: "chat.plan.applied";
      readonly runId: string;
      readonly versionId: string;
      readonly creditsCommitted?: number;
    }
  | {
      readonly type: "chat.plan.apply-failed";
      readonly runId: string;
      readonly error: ChatUiError;
      /** M5-Q: the `ambiguous` outcome's candidate strings (§8.7 pick surface). */
      readonly candidates?: readonly string[];
    }
  | { readonly type: "chat.plan.undo"; readonly runId: string }
  | { readonly type: "chat.plan.undone"; readonly runId: string }
  | { readonly type: "chat.plan.undo-failed"; readonly runId: string; readonly error: ChatUiError }
  | {
      /** M5-Q (§8.7): the user picked a candidate for an ambiguous layer name. */
      readonly type: "chat.plan.resolve";
      readonly runId: string;
      readonly requestId: string;
      readonly layerId: number;
    }
  | { readonly type: "chat.plan.dismiss"; readonly runId: string };

/**
 * Appends the user's message to the thread. Pure: the caller owns the id
 * (`crypto.randomUUID()` in the controller). Does NOT touch the phase — the
 * controller decides between `chat.submit` (wire now) and queueing.
 */
export function applyUserMessage(
  state: ChatUiState,
  message: { id: string; text: string },
): ChatUiState {
  const userMessage: ChatUiMessage = {
    id: message.id,
    role: "user",
    text: message.text,
    toolCards: [],
  };
  return { ...state, messages: [...state.messages, userMessage] };
}

/**
 * §8.1 client-driven transitions. Total and pure: invalid transitions return
 * the SAME state reference (a no-op).
 */
export function applyClientAction(state: ChatUiState, action: ChatClientAction): ChatUiState {
  // The M5 `chat.plan.*` gestures fold the plan's per-message runtime only
  // (applyPlanAction) — the thread phase keeps its exact M4 semantics so
  // sends/steer/reconnect behave byte-identically.
  if (isPlanGesture(action)) {
    return applyPlanAction(state, action);
  }
  switch (action.type) {
    case "chat.submit": {
      // A new send only starts from idle or a terminal phase; a live run
      // takes the steer queue instead.
      if (LIVE_RUN_PHASES.has(state.phase)) return state;
      // M6-H: a fresh send re-arms the credits block — the server re-enforces
      // the §8.8 gate on the wire (honest client-side UX only, never a
      // permanent client lock).
      return { ...state, phase: "sending", error: undefined, blocked: undefined };
    }
    case "chat.stop": {
      if (!LIVE_RUN_PHASES.has(state.phase)) return state;
      return { ...state, phase: "cancelled" };
    }
    case "chat.reconnecting": {
      // Dispatched ONLY while a resumable stream exists; "failed" here means
      // RUN_PAUSED (resume), not a terminal run failure.
      if (!LIVE_RUN_PHASES.has(state.phase) && state.phase !== "failed") return state;
      return { ...state, phase: "reconnecting" };
    }
    case "chat.paused": {
      if (!LIVE_RUN_PHASES.has(state.phase)) return state;
      return { ...state, phase: "failed", error: RUN_PAUSED_ERROR };
    }
    case "chat.error": {
      if (!LIVE_RUN_PHASES.has(state.phase)) return state;
      // M6-H: a 402 INSUFFICIENT_CREDITS (§8.8 — the POST never started a
      // run) additionally records the TYPED blocked state. It is NOT
      // retryable (the §7.3 envelope says so — no retry loop); the way out
      // is the top-up CTA, and `chat.submit` clears the block.
      return {
        ...state,
        phase: "failed",
        error: action.error,
        ...(action.error.code === INSUFFICIENT_CREDITS_CODE
          ? { blocked: blockedCreditsFrom(action.error) }
          : {}),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers (all pure)
// ---------------------------------------------------------------------------

/** An accepted event on a `sending`/`reconnecting` thread means: alive again. */
function resumeConfirm(phase: RunPhase): RunPhase {
  return phase === "sending" || phase === "reconnecting" ? "streaming" : phase;
}

/** Maps the message bound to `activeRunId` (older runs are left untouched). */
function mapActiveMessage(
  state: ChatUiState,
  update: (message: ChatUiMessage) => ChatUiMessage,
): readonly ChatUiMessage[] {
  return state.messages.map((message) =>
    message.runId === state.activeRunId ? update(message) : message,
  );
}

/** Seam 6 failure shape: `{ error: string; message?: string }` → failed card. */
function isFailedToolResult(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const record = result as Record<string, unknown>;
  if (typeof record.error !== "string") return false;
  return record.message === undefined || typeof record.message === "string";
}

function upsertStartedCard(
  cards: readonly ToolCardState[],
  started: { toolCallId: string; name: string; args: unknown },
): readonly ToolCardState[] {
  if (cards.some((card) => card.toolCallId === started.toolCallId)) {
    return cards.map((card) =>
      card.toolCallId === started.toolCallId
        ? { ...card, name: started.name, args: started.args, status: "running" as const }
        : card,
    );
  }
  return [
    ...cards,
    { toolCallId: started.toolCallId, name: started.name, args: started.args, status: "running" },
  ];
}

function appendDeltaText(
  cards: readonly ToolCardState[],
  delta: { toolCallId: string; delta: string },
): readonly ToolCardState[] {
  if (cards.some((card) => card.toolCallId === delta.toolCallId)) {
    return cards.map((card) =>
      card.toolCallId === delta.toolCallId
        ? { ...card, deltaText: `${card.deltaText ?? ""}${delta.delta}` }
        : card,
    );
  }
  // Orphan delta (the real wire always sends tool.started first): a running
  // card with an unknown name keeps the UI honest without guessing.
  return [
    ...cards,
    { toolCallId: delta.toolCallId, name: "", status: "running", deltaText: delta.delta },
  ];
}

function applyToolResult(
  cards: readonly ToolCardState[],
  result: { toolCallId: string; result: unknown },
): readonly ToolCardState[] {
  const status: "done" | "failed" = isFailedToolResult(result.result) ? "failed" : "done";
  if (cards.some((card) => card.toolCallId === result.toolCallId)) {
    return cards.map((card) =>
      card.toolCallId === result.toolCallId ? { ...card, status, result: result.result } : card,
    );
  }
  // Result without a started card (ordering anomaly): still show the card.
  return [...cards, { toolCallId: result.toolCallId, name: "", status, result: result.result }];
}

function isTerminalEvent(event: StudioStreamEvent): boolean {
  return (
    event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled"
  );
}

// ---------------------------------------------------------------------------
// M5 plan-runtime helpers (compiled batch + resolution requests + lifecycle)
// ---------------------------------------------------------------------------

/**
 * The `plan` event, extended with the M5 runtime fields (M5-C adds them to
 * the wire; absent — and stripped by the SSE reader — until that lands).
 * Presence-checked + narrowly validated below: a malformed runtime folds as
 * a plain M4 plan (card data only, no apply surface).
 */
type PlanEventWithRuntime = Extract<StudioStreamEvent, { type: "plan" }> & {
  readonly compiledBatch?: unknown;
  readonly resolutionRequests?: unknown;
  readonly baseVersionId?: unknown;
  readonly risk?: unknown;
  readonly estimatedCredits?: unknown;
  readonly autoApply?: unknown;
};

/** `steps: [{command, params}]` with a non-empty label — the §8.5 apply payload. */
function parseCompiledBatch(value: unknown): PlanRuntime["compiledBatch"] | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.label !== "string" || record.label.length === 0) return null;
  if (!Array.isArray(record.steps) || record.steps.length === 0) return null;
  const steps: Array<{ command: string; params: Record<string, unknown> }> = [];
  for (const step of record.steps) {
    if (typeof step !== "object" || step === null) return null;
    const stepRecord = step as Record<string, unknown>;
    if (typeof stepRecord.command !== "string" || stepRecord.command.length === 0) return null;
    if (typeof stepRecord.params !== "object" || stepRecord.params === null) return null;
    steps.push({
      command: stepRecord.command,
      params: stepRecord.params as Record<string, unknown>,
    });
  }
  const timeoutMs =
    typeof record.timeoutMs === "number" &&
    Number.isInteger(record.timeoutMs) &&
    record.timeoutMs > 0
      ? record.timeoutMs
      : undefined;
  return timeoutMs === undefined
    ? { label: record.label, atomic: true, steps }
    : { label: record.label, atomic: true, steps, timeoutMs };
}

/** `[{requestId, layerName, disambiguation?}]` — the §8.7 client-side bindings. */
function parseResolutionRequests(value: unknown): readonly LayerResolutionRequest[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const out: LayerResolutionRequest[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const record = entry as Record<string, unknown>;
    if (typeof record.requestId !== "string" || record.requestId.length === 0) return undefined;
    if (typeof record.layerName !== "string") return undefined;
    const hints = Array.isArray(record.disambiguation)
      ? record.disambiguation.filter((hint): hint is string => typeof hint === "string")
      : [];
    out.push({ requestId: record.requestId, layerName: record.layerName, disambiguation: hints });
  }
  return out;
}

/** The §7.3/D-22 verdict — `{mode: "auto"|"propose", reason}`, else undefined. */
function parseAutoApply(value: unknown): PlanRuntime["autoApply"] {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.mode !== "auto" && record.mode !== "propose") return undefined;
  if (typeof record.reason !== "string" || record.reason.length === 0) return undefined;
  return { mode: record.mode, reason: record.reason };
}

/** The server-recomputed risk (D-21: never the model's self-declared value). */
function parseServerRisk(value: unknown): PlanRuntime["risk"] {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

/** The server-recomputed deterministic credit estimate (§8.8). */
function parseServerCredits(value: unknown): PlanRuntime["estimatedCredits"] {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Builds the message's `planRuntime` from a plan event when it carries the M5
 * payload; `null` when it does not (the M4 card shape stays as-is).
 */
export function planRuntimeFromEvent(event: StudioStreamEvent): PlanRuntime | null {
  if (event.type !== "plan") return null;
  const extended = event as PlanEventWithRuntime;
  const compiledBatch = parseCompiledBatch(extended.compiledBatch);
  if (compiledBatch === null) return null;
  const resolutionRequests = parseResolutionRequests(extended.resolutionRequests);
  const baseVersionId =
    typeof extended.baseVersionId === "string" && extended.baseVersionId.length > 0
      ? extended.baseVersionId
      : undefined;
  // M5-Q: the SERVER-recomputed card values (risk/credits, D-21) + the D-22
  // auto-apply verdict fold with the runtime — presence-checked so a hostile
  // stream can only omit them, never fabricate client credit math.
  const risk = parseServerRisk(extended.risk);
  const estimatedCredits = parseServerCredits(extended.estimatedCredits);
  const autoApply = parseAutoApply(extended.autoApply);
  return {
    compiledBatch,
    ...(resolutionRequests !== undefined ? { resolutionRequests } : {}),
    ...(baseVersionId !== undefined ? { baseVersionId } : {}),
    ...(risk !== undefined ? { risk } : {}),
    ...(estimatedCredits !== undefined ? { estimatedCredits } : {}),
    ...(autoApply !== undefined ? { autoApply } : {}),
    outcome: "idle",
  };
}

/** Maps the message bound to `runId` (older runs included — cards stay live). */
function mapMessageOfRun(
  state: ChatUiState,
  runId: string,
  update: (message: ChatUiMessage) => ChatUiMessage,
): readonly ChatUiMessage[] {
  return state.messages.map((message) => (message.runId === runId ? update(message) : message));
}

/** The `chat.plan.*` subset of {@link ChatClientAction} (the M5 card gestures). */
export type PlanGestureAction = Extract<ChatClientAction, { type: `chat.plan.${string}` }>;

/** Type guard narrowing a client action to its M5 `chat.plan.*` arms. */
function isPlanGesture(action: ChatClientAction): action is PlanGestureAction {
  return action.type.startsWith("chat.plan.");
}

/**
 * Merges one user pick into the runtime's pick map (M5-Q, §8.7). The map is
 * rebuilt NULL-PROTOTYPE every time (M4-N F-1): request ids are model-adjacent
 * strings — on a plain `{}` a `__proto__` id would rebind the accumulator's
 * prototype (a spread of a null-proto object would LOSE the null proto, so the
 * merge is an explicit copy loop).
 */
function mergePick(
  existing: Readonly<Record<string, number>> | undefined,
  requestId: string,
  layerId: number,
): Readonly<Record<string, number>> {
  const next = Object.create(null) as Record<string, number>;
  if (existing !== undefined) {
    for (const [key, value] of Object.entries(existing)) next[key] = value;
  }
  next[requestId] = layerId;
  return next;
}

/**
 * Replaces every whole-string `$request:<requestId>` placeholder whose
 * requestId carries a user pick with the chosen layer id (M5-Q). Deterministic
 * deep clone with NULL-PROTOTYPE objects (the M4-N F-1 rule — mirrors
 * apply.ts's `patchPlaceholders`; keep in sync with it).
 */
function patchUserPicks(value: unknown, picks: Readonly<Record<string, number>>): unknown {
  if (typeof value === "string") {
    if (!value.startsWith(RESOLVE_TOKEN_PREFIX)) return value;
    const requestId = value.slice(RESOLVE_TOKEN_PREFIX.length);
    const picked = picks[requestId];
    return picked === undefined ? value : picked;
  }
  if (Array.isArray(value)) return value.map((item) => patchUserPicks(item, picks));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = Object.create(null);
    for (const [key, child] of Object.entries(value)) out[key] = patchUserPicks(child, picks);
    return out;
  }
  return value;
}

/** Folds one `chat.plan.*` gesture onto the message's planRuntime (pure). */
function applyPlanAction(state: ChatUiState, action: PlanGestureAction): ChatUiState {
  const runId = action.runId;
  const foldRuntime = (update: (runtime: PlanRuntime) => PlanRuntime): ChatUiState => ({
    ...state,
    messages: mapMessageOfRun(state, runId, (message) => {
      if (message.planRuntime === undefined) return message; // no M5 payload on this card
      return { ...message, planRuntime: update(message.planRuntime) };
    }),
  });

  switch (action.type) {
    case "chat.plan.apply":
      return foldRuntime((runtime) =>
        runtime.outcome === "idle" ||
        runtime.outcome === "apply-failed" ||
        runtime.outcome === "undone"
          ? { ...runtime, outcome: "applying", error: undefined, candidates: undefined }
          : runtime,
      );
    case "chat.plan.applied":
      return foldRuntime((runtime) =>
        runtime.outcome === "applying"
          ? {
              ...runtime,
              outcome: "applied",
              versionId: action.versionId,
              error: undefined,
              candidates: undefined,
            }
          : runtime,
      );
    case "chat.plan.apply-failed":
      return foldRuntime((runtime) =>
        runtime.outcome === "applying"
          ? {
              ...runtime,
              outcome: "apply-failed",
              error: action.error,
              ...(action.candidates !== undefined ? { candidates: action.candidates } : {}),
            }
          : runtime,
      );
    case "chat.plan.undo":
      return foldRuntime((runtime) =>
        runtime.outcome === "applied" ? { ...runtime, outcome: "undoing" } : runtime,
      );
    case "chat.plan.undone":
      return foldRuntime((runtime) =>
        runtime.outcome === "undoing"
          ? { ...runtime, outcome: "undone", error: undefined }
          : runtime,
      );
    case "chat.plan.undo-failed":
      return foldRuntime((runtime) =>
        runtime.outcome === "undoing"
          ? { ...runtime, outcome: "undo-failed", error: action.error }
          : runtime,
      );
    case "chat.plan.resolve":
      // §8.7 (M5-Q): the user's candidate pick binds requestId → layer id; the
      // pick is durable for this plan (kept across the re-driven attempt) and
      // folds WITHOUT touching the outcome — the re-drive's own `chat.plan.apply`
      // gesture follows immediately.
      return foldRuntime((runtime) => ({
        ...runtime,
        resolutionPicks: mergePick(runtime.resolutionPicks, action.requestId, action.layerId),
      }));
    case "chat.plan.dismiss":
      return foldRuntime((runtime) => ({ ...runtime, dismissed: true }));
  }
}

/**
 * The apply inputs for one plan, straight out of its runtime — the pure core of
 * {@link applicablePlanOf} (the thread layer passes a MESSAGE's runtime in,
 * the same shape the store folds). M5-Q: the user's ambiguous-layer picks are
 * PRE-PATCHED into the batch (`$request:` tokens → layer ids) and their
 * requests drop out of `resolutionRequests`, so the re-driven apply skips name
 * resolution for them (§8.7 — the pick is user authority).
 */
export function applicablePlanFromRuntime(runId: string, runtime: PlanRuntime): ApplicablePlan {
  const picks = runtime.resolutionPicks;
  const hasPicks = picks !== undefined && Object.keys(picks).length > 0;
  const requests =
    runtime.resolutionRequests?.filter((request) => picks?.[request.requestId] === undefined) ?? [];
  const batch = hasPicks
    ? {
        ...runtime.compiledBatch,
        steps: runtime.compiledBatch.steps.map((step) => ({
          command: step.command,
          params: patchUserPicks(step.params, picks ?? {}) as Record<string, unknown>,
        })),
      }
    : runtime.compiledBatch;
  return {
    runId,
    ...(runtime.baseVersionId !== undefined ? { baseVersionId: runtime.baseVersionId } : {}),
    compiledBatch: batch,
    ...(requests.length > 0 ? { resolutionRequests: requests } : {}),
  };
}

/** The message bound to `runId`'s M5 plan runtime, if any (M5-Q helper). */
export function planRuntimeOf(state: ChatUiState, runId: string): PlanRuntime | undefined {
  return state.messages.find((entry) => entry.runId === runId)?.planRuntime;
}

/**
 * The apply inputs for the plan card bound to `runId`, straight out of the
 * folded state (the provider/card passes this to `controller.apply`);
 * `null` when the message has no M5 runtime (no compiled batch to execute).
 */
export function applicablePlanOf(state: ChatUiState, runId: string): ApplicablePlan | null {
  const runtime = planRuntimeOf(state, runId);
  if (runtime === undefined) return null;
  return applicablePlanFromRuntime(runId, runtime);
}

// ---------------------------------------------------------------------------
// foldEvent — the §7.4 → §8.1 reducer
// ---------------------------------------------------------------------------

/**
 * Folds one §7.4 event into the whole-thread state. Pure, total and
 * replay-idempotent (see the module header for the exact rule set); dropped
 * events return the SAME state reference.
 */
export function foldEvent(state: ChatUiState, event: StudioStreamEvent): ChatUiState {
  // New-run takeover: the first run.started for a run with no message yet.
  if (event.type === "run.started" && !state.messages.some((m) => m.runId === event.runId)) {
    const placeholder: ChatUiMessage = {
      id: `run:${event.runId}`,
      role: "assistant",
      text: "",
      runId: event.runId,
      toolCards: [],
    };
    return {
      ...state,
      messages: [...state.messages, placeholder],
      phase: "streaming",
      activeRunId: event.runId,
      error: undefined,
      // M6-H: the server accepted the run, so the workspace could fund it —
      // any stale typed block is over.
      blocked: undefined,
      lastSeq: event.seq,
    };
  }

  // Older runs stay frozen; events for unknown runs are dropped.
  if (event.runId !== state.activeRunId) return state;
  // Replay dedupe (per active run): seqs at/below the cursor were already folded.
  if (event.seq <= state.lastSeq) return state;

  const frozen = TERMINAL_RUN_PHASES.has(state.phase);
  // Every accepted event advances the cursor so the Last-Event-ID stays truthful.
  let next: ChatUiState = { ...state, lastSeq: event.seq };

  switch (event.type) {
    case "run.started": {
      // Replay of the active run's start with a later seq — nothing to create.
      if (!frozen) next = { ...next, phase: resumeConfirm(next.phase), blocked: undefined };
      break;
    }
    case "message.delta": {
      if (frozen) break;
      next = {
        ...next,
        phase: resumeConfirm(next.phase),
        messages: mapActiveMessage(next, (message) => ({
          ...message,
          text: `${message.text}${event.delta}`,
        })),
      };
      break;
    }
    case "tool.started": {
      if (frozen) break;
      next = {
        ...next,
        phase: resumeConfirm(next.phase),
        messages: mapActiveMessage(next, (message) => ({
          ...message,
          toolCards: upsertStartedCard(message.toolCards, event),
        })),
      };
      break;
    }
    case "tool.delta": {
      if (frozen) break;
      next = {
        ...next,
        phase: resumeConfirm(next.phase),
        messages: mapActiveMessage(next, (message) => ({
          ...message,
          toolCards: appendDeltaText(message.toolCards, event),
        })),
      };
      break;
    }
    case "tool.result": {
      if (frozen) break;
      next = {
        ...next,
        phase: resumeConfirm(next.phase),
        messages: mapActiveMessage(next, (message) => ({
          ...message,
          toolCards: applyToolResult(message.toolCards, event),
        })),
      };
      break;
    }
    case "plan": {
      if (frozen) break;
      const planRuntime = planRuntimeFromEvent(event);
      next = {
        ...next,
        phase: resumeConfirm(next.phase),
        messages: mapActiveMessage(next, (message) => ({
          ...message,
          plan: event.plan,
          // A NEW plan event resets the card's runtime (fresh compiled batch,
          // fresh lifecycle); without the M5 payload the runtime clears.
          ...(planRuntime === null ? { planRuntime: undefined } : { planRuntime }),
        })),
      };
      break;
    }
    case "credits": {
      if (frozen) break;
      // A REAL terminal §7.4 snapshot (whole-credit display units — see the
      // latestCreditsSnapshot units pin): every field is server truth, so it
      // replaces the message's snapshot wholesale (including the balance).
      next = {
        ...next,
        phase: resumeConfirm(next.phase),
        messages: mapActiveMessage(next, (message) => ({
          ...message,
          credits: {
            reserved: event.reserved,
            committed: event.committed,
            balance: event.balance,
          },
        })),
      };
      break;
    }
    case "preview":
    case "approval.required":
      // M4: cursor-only events — previews ride tool cards (render_preview is
      // a client tool whose result lands on the card); approval UI is M5.
      break;
    // -----------------------------------------------------------------------
    // ROUND-12 turn events (TURN WIRE CONTRACT): the browser's chat-controller
    // owns the loop; the server is stateless per turn. `turn.started` and a
    // TRANSIENT `turn.failed` (the transport's bounded retry heals it) are
    // cursor-only — the run's phase must never flap mid-recovery.
    // -----------------------------------------------------------------------
    case "turn.started": {
      if (frozen) break;
      next = { ...next, phase: resumeConfirm(next.phase) };
      break;
    }
    case "turn.completed": {
      if (frozen) break;
      next = {
        ...next,
        phase: resumeConfirm(next.phase),
        messages: mapActiveMessage(next, (message) => ({
          ...message,
          // §8.8 display (12-w5-t1 pin): committed credits accumulate across
          // the run's turns — the ONLY credits number this payload carries
          // (whole-credit display units; contracts events.ts
          // `credits: z.strictObject({ committed })`). reserved/balance are
          // NOT on the wire: carry the last REAL values forward, or mark
          // UNKNOWN (NaN) when no §7.4 `credits` event ever set them — never
          // fabricate 0 (the fabricated `balance: 0` used to lock the
          // composer's M6-H gate and render "0.00 credits left" after every
          // run; NaN ≠ 0 and formats as unknown everywhere).
          credits: {
            reserved: message.credits?.reserved ?? Number.NaN,
            committed: (message.credits?.committed ?? 0) + event.credits.committed,
            balance: message.credits?.balance ?? Number.NaN,
          },
          // The chips' authoritative payload (the chips themselves light up
          // from tool.started; this carries resultForModel + proposals).
          toolCalls: event.toolCalls,
          // Replay/drop recovery: a durable turn replay re-sends NO deltas —
          // the terminal alone carries the FULL text. The terminal is
          // authoritative (it equals the streamed text on a clean turn), so a
          // half-streamed bubble completes and a fully streamed one is
          // byte-identical (the !== guard keeps the reference stable).
          ...(event.assistantText !== undefined &&
          event.assistantText !== "" &&
          message.text !== event.assistantText
            ? { text: event.assistantText }
            : {}),
        })),
      };
      break;
    }
    case "turn.failed": {
      // Cursor-only BY DESIGN: the turn transport retries a retryable failure
      // same-key and only the SURFACED one (after retries) reaches the user
      // via the controller's `chat.error` fold. A transient blip the bounded
      // retry heals never flickers the phase.
      break;
    }
    case "run.completed": {
      next = { ...next, phase: "done", error: undefined, blocked: undefined };
      break;
    }
    case "run.failed": {
      next = {
        ...next,
        phase: "failed",
        error: { code: event.code, message: event.message, retryable: event.retryable },
        // M6-H (defensive symmetry): a terminal failure carrying the §8.8
        // code records the typed block too — the shipped gateway 402s BEFORE
        // streaming, but the fold stays honest for any stream that says so.
        ...(event.code === INSUFFICIENT_CREDITS_CODE ? { blocked: blockedCreditsFrom(event) } : {}),
      };
      break;
    }
    case "run.cancelled": {
      next = { ...next, phase: "cancelled" };
      break;
    }
  }
  return next;
}
