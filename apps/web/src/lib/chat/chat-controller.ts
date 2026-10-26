/**
 * Chat engine controller — Seam 4 of docs/phases/M4-SEAMS.md
 * (EDITOR_CHAT_UX §3.4 steer queue, §8.3 cancellation, §8.4 reconnect;
 * PRODUCT_ARCHITECTURE.md §7.2/§7.4).
 *
 * `createChatController` is a `useSyncExternalStore`-ready store over
 * `ChatUiState` (wave-2 UI: `useSyncExternalStore(controller.subscribe,
 * controller.getSnapshot)`). No React anywhere — pure TS.
 *
 * SSE + reconnect ownership (the seam found in `@studio/api-client`'s sse.ts,
 * consumed here rather than re-implemented):
 *  * `client.chat.stream(threadId, body, handlers)` parses + validates the
 *    wire, normalizes every part into typed §7.4 events (`onEvent`) and runs
 *    the WHOLE §8.4 loop itself: on a transport drop it re-POSTs with the
 *    SAME body idempotency key (never duplicates a run) and
 *    `Last-Event-ID: <its lastServerSeq cursor>`, backs off 1s/2s/4s/8s→30s
 *    (`onReconnect` → this controller shows the "reconnecting" banner
 *    phase), and after 3 automatic attempts parks (`onPause` → phase
 *    `failed` + RUN_PAUSED; `retry()` calls `stream.reconnect()`).
 *  * `handle.cancel()` IS the pinned "client.runs.cancel(runId) + abort the
 *    reader" pair as ONE fused mechanism — it POSTs `/v1/runs/:id/cancel`
 *    through the api-client's authenticated transport and aborts the reader,
 *    so no separate cancel POST is made (that would double-cancel).
 *  * Chat send HTTP errors (§7.3 envelopes: INSUFFICIENT_CREDITS 402,
 *    MODEL_NOT_ENTITLED 403, RATE_LIMITED 429…) surface as typed
 *    `ApiError`s through `onError`; this controller maps their
 *    code/message/retryable onto `state.error`.
 *
 * Steer queue (§3.4): `send` while a run is live appends the user message to
 * the thread immediately (the composer never eats input) and queues the wire
 * send; queued messages flush when the active run reaches a terminal phase
 * (done/failed/cancelled).
 *
 * Thread creation is NOT this controller's job (M4-J wires `threadId`).
 */

import type { ChatRequest, StudioStreamEvent } from "@studio/contracts";

import type { ApplicablePlan, ApplyController, ApplyOutcome, UndoOutcome } from "./apply";
import {
  LIVE_RUN_PHASES,
  RUN_PAUSED_ERROR,
  TERMINAL_RUN_PHASES,
  applicablePlanOf,
  applyClientAction,
  applyUserMessage,
  createInitialChatUiState,
  foldEvent,
  planRuntimeOf,
} from "./run-state";
import type {
  ChatControllerClient,
  ChatSendInput,
  ChatStreamHandle,
  ChatUiError,
  ChatUiState,
} from "./types";

/** Everything the wave-2 provider (M4-J) passes to build one controller. */
export interface CreateChatControllerOptions {
  /** The real `ApiClient` (satisfies `ChatControllerClient` structurally) or a fake. */
  readonly client: ChatControllerClient;
  /** Reserved for the M4-C2 tool-executor + M4-J provider wiring. */
  readonly workspaceId: string;
  /** Reserved for the M4-C2 tool-executor + M4-J provider wiring. */
  readonly projectId: string;
  /** The thread this controller drives; created by the host (M4-J), not here. */
  readonly threadId: string;
  /**
   * Fired whenever the controller enters an error state — fatal send/stream
   * errors, `run.failed` events and RUN_PAUSED. Not fired for stop().
   */
  readonly onError?: (error: { code: string; message: string }) => void;
  /**
   * The M5 apply engine (BUILD_PLAN §M5.4/§M5.5). When present the store
   * exposes apply/undo/reapply/dismissPlan for the plan card (M5-G's props:
   * onApply/onCancel/onUndo/onReapply); when absent those gestures fold a
   * typed APPLY_UNAVAILABLE error onto the card and nothing executes.
   */
  readonly apply?: ApplyController;
}

/** The store contract wave-2 consumes (pinned Seam 4 surface). */
export interface ChatController {
  /** The run currently streaming; the most recent run while terminal. */
  readonly runId: string | null;
  /** Referentially stable between changes (useSyncExternalStore contract). */
  getSnapshot(): ChatUiState;
  subscribe(listener: () => void): () => void;
  /**
   * Send now (idle/terminal) or queue as a steer message while a run is
   * live (§3.4). The user message renders immediately in both cases.
   */
  send(input: ChatSendInput): void;
  /** §8.3: local phase settles to `cancelled` at once; the run is cancelled
   *  server-side + the reader aborted via the stream handle's fused cancel. */
  stop(): void;
  /**
   * Resume a RUN_PAUSED run (`stream.reconnect()`) or re-send a failed
   * attempt: SAME idempotency key when no run was ever created (§8.4 "never
   * duplicate a run" — the gateway replays/creates idempotently), a fresh
   * key when the old run terminally failed (its key would replay the
   * terminal log instead of starting a new run).
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
  /** Abort in-flight, drop the queue, unsubscribe every listener. */
  dispose(): void;
}

/** Narrows the api-client's synchronous ApiError-shaped throw to a UI error. */
function toUiError(error: unknown): ChatUiError {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    const retryable = "retryable" in error && error.retryable === true;
    return { code: error.code, message: error.message, retryable };
  }
  return { code: "NETWORK_ERROR", message: "Could not reach the server.", retryable: true };
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

export function createChatController(options: CreateChatControllerOptions): ChatController {
  let snapshot: ChatUiState = createInitialChatUiState();
  const listeners = new Set<() => void>();
  /** Steer queue (§3.4): wire sends waiting for the active run to settle. */
  const queue: Array<{ input: ChatSendInput; idempotencyKey: string }> = [];
  let stream: ChatStreamHandle | null = null;
  /** Bumped per started run: late handlers from replaced streams are ignored. */
  let generation = 0;
  let disposed = false;
  let lastAttempt: { input: ChatSendInput; idempotencyKey: string; startedRun: boolean } | null =
    null;
  /** ROUND-10: runIds already auto-driven — the once-per-run guard. */
  const autoAppliedRuns = new Set<string>();

  const newKey = (): string => crypto.randomUUID();

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

  const buildBody = (input: ChatSendInput, idempotencyKey: string): ChatRequest => ({
    message: input.message,
    context: input.context,
    pinned: input.pinned,
    idempotencyKey,
    ...(input.model !== undefined ? { model: input.model } : {}),
  });

  const handlersFor = (attemptGeneration: number) => ({
    onEvent: (event: StudioStreamEvent): void => {
      if (disposed || attemptGeneration !== generation) return;
      if (event.type === "run.started" && lastAttempt !== null) lastAttempt.startedRun = true;
      // foldEvent returns the SAME reference for replays/no-ops — the store
      // only notifies on real changes.
      commit(foldEvent(snapshot, event));
      // ROUND-10 v2: the §7.3 verdict said "auto" — execute the plan now, no
      // click required (Undo on the applied card is the escape hatch).
      if (event.type === "run.completed") maybeAutoApply(event.runId);
      if (event.type === "run.failed") {
        fireOnError({ code: event.code, message: event.message });
      }
    },
    onError: (error: { code: string; message: string; retryable: boolean }): void => {
      if (disposed || attemptGeneration !== generation) return;
      raiseError({ code: error.code, message: error.message, retryable: error.retryable });
    },
    onReconnect: (): void => {
      if (disposed || attemptGeneration !== generation) return;
      commit(applyClientAction(snapshot, { type: "chat.reconnecting" }));
    },
    onPause: (): void => {
      if (disposed || attemptGeneration !== generation) return;
      commit(applyClientAction(snapshot, { type: "chat.paused" }));
      fireOnError({ code: RUN_PAUSED_ERROR.code, message: RUN_PAUSED_ERROR.message });
    },
    onDone: (summary: { reason: string }): void => {
      if (disposed || attemptGeneration !== generation) return;
      // "paused" keeps the handle for retry(); every other reason is final.
      if (summary.reason === "paused") return;
      stream = null;
      flushQueue();
    },
  });

  const startRun = (input: ChatSendInput, idempotencyKey: string): void => {
    const body = buildBody(input, idempotencyKey);
    commit(applyClientAction(snapshot, { type: "chat.submit" }));
    lastAttempt = { input, idempotencyKey, startedRun: false };
    generation += 1;
    const attemptGeneration = generation;
    let handle: ChatStreamHandle;
    try {
      handle = options.client.chat.stream(options.threadId, body, handlersFor(attemptGeneration));
    } catch (error) {
      // Client-side validation failures throw synchronously (sse.ts contract).
      raiseError(toUiError(error));
      return;
    }
    stream = handle;
  };

  /** §3.4: after a terminal phase, the queued steer sends start in order. */
  const flushQueue = (): void => {
    if (disposed || !TERMINAL_RUN_PHASES.has(snapshot.phase)) return;
    const next = queue.shift();
    if (next === undefined) return;
    // The user message was already appended when it was queued.
    startRun(next.input, next.idempotencyKey);
  };

  const send = (input: ChatSendInput): void => {
    if (disposed || input.message.trim() === "") return;
    if (LIVE_RUN_PHASES.has(snapshot.phase)) {
      // Steer (§3.4): render immediately, send when the active run settles.
      queue.push({ input, idempotencyKey: newKey() });
      commit(applyUserMessage(snapshot, { id: newKey(), text: input.message }));
      return;
    }
    commit(applyUserMessage(snapshot, { id: newKey(), text: input.message }));
    startRun(input, newKey());
  };

  const stop = (): void => {
    if (disposed || !LIVE_RUN_PHASES.has(snapshot.phase)) return;
    // §8.3: local phase settles at once; handle.cancel() POSTs the cancel +
    // aborts the reader (fused §8.3 mechanism of the api-client).
    commit(applyClientAction(snapshot, { type: "chat.stop" }));
    const handle = stream;
    if (handle !== null) void handle.cancel();
  };

  const retry = (): void => {
    if (disposed || snapshot.phase !== "failed") return;
    const handle = stream;
    if (handle !== null) {
      // RUN_PAUSED (or mid-run backoff): resume the SAME run — the api-client
      // re-POSTs with the same idempotency key + its Last-Event-ID cursor.
      commit(applyClientAction(snapshot, { type: "chat.reconnecting" }));
      void handle.reconnect();
      return;
    }
    const attempt = lastAttempt;
    if (attempt === null) return;
    // The send never produced a run (same key: §8.4 never duplicates a run)
    // or the run terminally failed (fresh key: the old key would replay its
    // terminal log instead of starting a new run).
    startRun(attempt.input, attempt.startedRun ? newKey() : attempt.idempotencyKey);
  };

  const dispose = (): void => {
    disposed = true;
    const handle = stream;
    stream = null;
    queue.length = 0;
    if (handle !== null) handle.abort();
    listeners.clear();
  };

  // -------------------------------------------------------------------------
  // M5 apply/undo gestures (§6.2/§M5.4/§M5.5) — the plan card (M5-G) gets
  // these as onApply/onCancel/onUndo/onReapply props. Void by design: the
  // card reads its state back from the store, like send/stop/retry.
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
  // make (the product owner's ruling; superseding the D-22 "UI guidance
  // only" posture). Undo on the applied card is the one-click escape hatch.
  // Guards (all must hold — anything uncertain stays a manual Apply card):
  //   * once per runId — SSE replays and reconnects never re-apply,
  //   * only runs whose run.completed folded LIVE in this controller — a
  //     reloaded page never resurrects old plans (history renders no runtime),
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
