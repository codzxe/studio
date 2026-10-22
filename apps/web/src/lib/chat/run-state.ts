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
 *    else in M4 (approval UI is M5; previews ride tool cards).
 *
 * Client-driven transitions (§8.1 states the USER causes — submit, stop, the
 * §8.4 reconnect banner, the pause) never consume a seq; they live in
 * `applyClientAction`.
 */

import type { StudioStreamEvent } from "@studio/contracts";

import type { ChatUiError, ChatUiMessage, ChatUiState, RunPhase, ToolCardState } from "./types";

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

/**
 * Client-driven §8.1 transitions the CONTROLLER dispatches (never the
 * stream): `chat.submit` a send is in flight; `chat.stop` the user hit stop
 * (local phase settles immediately; a late terminal event reconciles it);
 * `chat.reconnecting` the §8.4 banner (also dispatched when resuming a
 * RUN_PAUSED run — only while a resumable stream exists); `chat.paused`
 * backoff exhausted; `chat.error` a fatal send/stream error.
 */
export type ChatClientAction =
  | { readonly type: "chat.submit" }
  | { readonly type: "chat.stop" }
  | { readonly type: "chat.reconnecting" }
  | { readonly type: "chat.paused" }
  | { readonly type: "chat.error"; readonly error: ChatUiError };

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
  switch (action.type) {
    case "chat.submit": {
      // A new send only starts from idle or a terminal phase; a live run
      // takes the steer queue instead.
      if (LIVE_RUN_PHASES.has(state.phase)) return state;
      return { ...state, phase: "sending", error: undefined };
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
      return { ...state, phase: "failed", error: action.error };
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
      if (!frozen) next = { ...next, phase: resumeConfirm(next.phase) };
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
      next = {
        ...next,
        phase: resumeConfirm(next.phase),
        messages: mapActiveMessage(next, (message) => ({ ...message, plan: event.plan })),
      };
      break;
    }
    case "credits": {
      if (frozen) break;
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
    case "run.completed": {
      next = { ...next, phase: "done", error: undefined };
      break;
    }
    case "run.failed": {
      next = {
        ...next,
        phase: "failed",
        error: { code: event.code, message: event.message, retryable: event.retryable },
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
