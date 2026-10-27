/**
 * Reducer suite — Seam 4 pure folds (deterministic, no network, no timers).
 *
 * The §7.4 event sequences come from @studio/api-client's committed fixtures
 * (`fixtures.runs.applied/undone.events`) — the same demo run logs the
 * gateway replays — plus hand-made edge events for the paths the fixtures
 * do not exercise (fail/cancel/freeze/orphan tools).
 */

// W2-B3: fixtures moved off the main barrel to the `./fixtures` subpath.
import { fixtures } from "@studio/api-client/fixtures";
import type { EditPlan, StudioStreamEvent } from "@studio/contracts";
import { describe, expect, it } from "vitest";

import {
  RUN_PAUSED_ERROR,
  applyClientAction,
  applyUserMessage,
  createInitialChatUiState,
  foldEvent,
  latestCreditsSnapshot,
} from "./run-state";
import type { ChatUiState } from "./types";

const APPLIED = fixtures.runs.applied.events;
const UNDONE = fixtures.runs.undone.events;
const RUN_A = "run_demo_launch_applied";
const RUN_B = "run_demo_launch_undone";

/** Plan fixture accessor (the barrel is Record-typed: index access is `| undefined`). */
function requirePlan(key: "headlineSpring" | "subheadSofter"): EditPlan {
  const plan = fixtures.plans[key];
  if (plan === undefined) throw new Error(`fixtures.plans.${key} is missing`);
  return plan;
}

const START_A: StudioStreamEvent = APPLIED[0] ?? {
  type: "run.started",
  runId: RUN_A,
  seq: 0,
  model: "studio-smart",
};

/** The full expected assistant text for the applied demo run (fixture deltas). */
const APPLIED_TEXT =
  "I'll animate Scale from 20% to 100% with an overshoot at 0.45s, settling at 0.7s. Keyframing now — the text layer stays editable.";

function withUserMessage(): ChatUiState {
  return applyUserMessage(createInitialChatUiState(), { id: "msg_user_1", text: "Pop the title." });
}

describe("createInitialChatUiState", () => {
  it("is an empty idle thread with a below-zero seq cursor", () => {
    expect(createInitialChatUiState()).toEqual({
      messages: [],
      phase: "idle",
      activeRunId: null,
      lastSeq: -1,
    });
  });
});

describe("foldEvent — new-run takeover", () => {
  it("run.started creates the assistant placeholder bound to the run", () => {
    const state = foldEvent(withUserMessage(), START_A);
    expect(state.messages).toHaveLength(2);
    const assistant = state.messages[1];
    expect(assistant).toMatchObject({
      id: `run:${RUN_A}`,
      role: "assistant",
      text: "",
      runId: RUN_A,
    });
    expect(assistant?.toolCards).toEqual([]);
    expect(state.phase).toBe("streaming");
    expect(state.activeRunId).toBe(RUN_A);
    expect(state.lastSeq).toBe(0);
    expect(state.error).toBeUndefined();
  });

  it("a stale error banner clears when a NEW run takes over", () => {
    let state = foldEvent(withUserMessage(), START_A);
    state = foldEvent(state, {
      type: "run.failed",
      runId: RUN_A,
      seq: 1,
      code: "RUN_MODEL_UNAVAILABLE",
      message: "The model is unavailable.",
      retryable: true,
    });
    expect(state.error).toBeDefined();
    state = foldEvent(state, {
      type: "run.started",
      runId: "run_demo_launch_retry",
      seq: 0,
      model: "studio-fast",
    });
    expect(state.phase).toBe("streaming");
    expect(state.activeRunId).toBe("run_demo_launch_retry");
    expect(state.error).toBeUndefined();
    expect(state.messages).toHaveLength(3); // user + failed assistant + new placeholder
    expect(state.lastSeq).toBe(0);
  });

  it("replaying the active run's started with a later seq advances the cursor only", () => {
    let state = foldEvent(withUserMessage(), START_A);
    state = foldEvent(state, {
      type: "run.failed",
      runId: RUN_A,
      seq: 1,
      code: "RUN_MODEL_UNAVAILABLE",
      message: "The model is unavailable.",
      retryable: true,
    });
    const retried = foldEvent(state, {
      type: "run.started",
      runId: RUN_A,
      seq: 2,
      model: "studio-smart",
    });
    // Same run — the placeholder exists: no new message, the failed phase
    // is terminal/frozen, only the cursor advances.
    expect(retried.messages).toHaveLength(2);
    expect(retried.phase).toBe("failed");
    expect(retried.lastSeq).toBe(2);
  });
});

describe("foldEvent — full fixtures run (the §7.4 happy path)", () => {
  it("folds the applied demo run into the pinned message/thread shape", () => {
    let state = withUserMessage();
    for (const event of APPLIED) state = foldEvent(state, event);

    expect(state.phase).toBe("done");
    expect(state.activeRunId).toBe(RUN_A);
    expect(state.lastSeq).toBe(9);
    expect(state.error).toBeUndefined();
    expect(state.messages).toHaveLength(2);

    const assistant = state.messages[1];
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.text).toBe(APPLIED_TEXT);
    expect(assistant?.plan).toEqual(fixtures.plans.headlineSpring);
    // credits → the LATEST snapshot on the message (the fixture sends two).
    expect(assistant?.credits).toEqual({ reserved: 0, committed: 29.75, balance: 2389.5 });
    expect(assistant?.toolCards).toEqual([
      {
        toolCallId: "call_demo_ctx_1",
        name: "studio.get_context",
        args: { blocks: ["projectSummary", "activeComp", "selection", "playhead"] },
        status: "done",
        result: { comps: 1, layers: 42, effects: 7, assets: 6 },
      },
    ]);
  });

  it("folds the undone demo run the same way (plan + credits, no tools)", () => {
    let state = withUserMessage();
    for (const event of UNDONE) state = foldEvent(state, event);
    expect(state.phase).toBe("done");
    expect(state.activeRunId).toBe(RUN_B);
    const assistant = state.messages[1];
    expect(assistant?.text).toBe("Softening the overshoot on Subhead — 108% peak, 0.6s settle.");
    expect(assistant?.plan).toEqual(fixtures.plans.subheadSofter);
    expect(assistant?.credits).toEqual({ reserved: 0, committed: 19.5, balance: 2449 });
  });
});

describe("foldEvent — replay idempotency (§7.4 Last-Event-ID rules)", () => {
  it("feeding the same event list twice changes nothing", () => {
    let first = withUserMessage();
    for (const event of APPLIED) first = foldEvent(first, event);
    let second = withUserMessage();
    for (const event of APPLIED) second = foldEvent(second, event);
    for (const event of APPLIED) second = foldEvent(second, event);
    expect(second).toEqual(first);
  });

  it("returns the SAME reference for dropped events", () => {
    let state = withUserMessage();
    for (const event of APPLIED) state = foldEvent(state, event);
    // Whole-list replay…
    let replayed = state;
    for (const event of APPLIED) replayed = foldEvent(replayed, event);
    expect(replayed).toBe(state);
    // …and a single duplicate event too.
    expect(foldEvent(state, START_A)).toBe(state);
  });

  it("drops at/below the cursor within one pass (out-of-order replay)", () => {
    let state = foldEvent(withUserMessage(), START_A);
    state = foldEvent(state, { type: "message.delta", runId: RUN_A, seq: 2, delta: "B" });
    // The seq-1 delta arrives late: already below the cursor → dropped.
    state = foldEvent(state, { type: "message.delta", runId: RUN_A, seq: 1, delta: "A" });
    const assistant = state.messages[1];
    expect(assistant?.text).toBe("B");
  });

  it("drops events for unknown runs (before run.started)", () => {
    const state = withUserMessage();
    const stray = foldEvent(state, {
      type: "message.delta",
      runId: "run_ghost",
      seq: 0,
      delta: "…",
    });
    expect(stray).toBe(state);
  });
});

describe("foldEvent — multiple runs in one thread", () => {
  it("a second run takes over; the older run stays frozen", () => {
    let state = withUserMessage();
    for (const event of APPLIED) state = foldEvent(state, event);
    for (const event of UNDONE) state = foldEvent(state, event);

    expect(state.messages).toHaveLength(3);
    expect(state.activeRunId).toBe(RUN_B);
    // The per-run seq space reset: run B's seqs 0..5 fold after run A's 0..9.
    expect(state.lastSeq).toBe(5);

    // A late tail for run A is dropped (frozen), even at a higher seq.
    const late = foldEvent(state, {
      type: "message.delta",
      runId: RUN_A,
      seq: 99,
      delta: "zombie text",
    });
    expect(late).toBe(state);
    const frozenA = state.messages[1];
    expect(frozenA?.text).toBe(APPLIED_TEXT);
  });

  it("re-feeding run B's list after a run A replay stays idempotent", () => {
    let state = withUserMessage();
    for (const event of APPLIED) state = foldEvent(state, event);
    for (const event of UNDONE) state = foldEvent(state, event);
    let replayed = state;
    for (const event of APPLIED) replayed = foldEvent(replayed, event);
    for (const event of UNDONE) replayed = foldEvent(replayed, event);
    expect(replayed).toBe(state);
  });
});

describe("foldEvent — terminal outcomes + reconciliation", () => {
  it("run.failed maps code/message/retryable and freezes the message", () => {
    let state = foldEvent(withUserMessage(), START_A);
    state = foldEvent(state, { type: "message.delta", runId: RUN_A, seq: 1, delta: "partial" });
    state = foldEvent(state, {
      type: "run.failed",
      runId: RUN_A,
      seq: 2,
      code: "RUN_MODEL_UNAVAILABLE",
      message: "The model is unavailable. Retry or switch models.",
      retryable: true,
    });
    expect(state.phase).toBe("failed");
    expect(state.error).toEqual({
      code: "RUN_MODEL_UNAVAILABLE",
      message: "The model is unavailable. Retry or switch models.",
      retryable: true,
    });
    // Late tail after the terminal event: cursor advances, message freezes.
    const frozen = foldEvent(state, { type: "message.delta", runId: RUN_A, seq: 3, delta: "late" });
    expect(frozen.lastSeq).toBe(3);
    expect(frozen.messages[1]?.text).toBe("partial");
    expect(frozen.phase).toBe("failed");
  });

  it("run.cancelled settles the phase; a later run.completed reconciles to done", () => {
    let state = foldEvent(withUserMessage(), START_A);
    state = foldEvent(state, { type: "run.cancelled", runId: RUN_A, seq: 1 });
    expect(state.phase).toBe("cancelled");
    // §8.3 server truth: the run had already completed when the stop landed.
    state = foldEvent(state, { type: "run.completed", runId: RUN_A, seq: 2, versionId: "ver_1" });
    expect(state.phase).toBe("done");
    expect(state.error).toBeUndefined();
  });

  it("preview and approval.required advance the cursor without touching state", () => {
    let state = foldEvent(withUserMessage(), START_A);
    state = foldEvent(state, { type: "message.delta", runId: RUN_A, seq: 1, delta: "x" });
    const before = state;
    const withPreview = foldEvent(state, {
      type: "preview",
      runId: RUN_A,
      seq: 2,
      pngBase64: "iVBOR…",
      width: 16,
      height: 16,
    });
    expect(withPreview.messages).toEqual(before.messages);
    expect(withPreview.phase).toBe(before.phase);
    expect(withPreview.lastSeq).toBe(2);
    const withApproval = foldEvent(withPreview, {
      type: "approval.required",
      runId: RUN_A,
      seq: 3,
      plan: requirePlan("headlineSpring"),
    });
    expect(withApproval.messages).toEqual(before.messages);
    expect(withApproval.phase).toBe("streaming"); // approval is M5 — not modeled
    expect(withApproval.lastSeq).toBe(3);
  });
});

describe("foldEvent — tool cards", () => {
  const start = foldEvent(createInitialChatUiState(), START_A);

  it("tool.started → running(args); tool.result → done(result)", () => {
    let state = foldEvent(start, {
      type: "tool.started",
      runId: RUN_A,
      seq: 1,
      toolCallId: "call_1",
      name: "studio.list_layers",
      args: { depth: 2 },
    });
    expect(state.messages[0]?.toolCards).toEqual([
      { toolCallId: "call_1", name: "studio.list_layers", args: { depth: 2 }, status: "running" },
    ]);
    state = foldEvent(state, {
      type: "tool.result",
      runId: RUN_A,
      seq: 2,
      toolCallId: "call_1",
      result: { layers: ["Headline"] },
    });
    expect(state.messages[0]?.toolCards).toEqual([
      {
        toolCallId: "call_1",
        name: "studio.list_layers",
        args: { depth: 2 },
        status: "done",
        result: { layers: ["Headline"] },
      },
    ]);
  });

  it("tool.result with the Seam 6 failure shape → failed card", () => {
    let state = foldEvent(start, {
      type: "tool.started",
      runId: RUN_A,
      seq: 1,
      toolCallId: "call_2",
      name: "studio.render_preview",
      args: {},
    });
    state = foldEvent(state, {
      type: "tool.result",
      runId: RUN_A,
      seq: 2,
      toolCallId: "call_2",
      result: { error: "EDITOR_DISCONNECTED", message: "The editor didn't respond in time." },
    });
    expect(state.messages[0]?.toolCards[0]?.status).toBe("failed");
    expect(state.messages[0]?.toolCards[0]?.result).toEqual({
      error: "EDITOR_DISCONNECTED",
      message: "The editor didn't respond in time.",
    });
  });

  it("tool.delta accumulates deltaText; orphan events still render a card", () => {
    let state = foldEvent(start, {
      type: "tool.started",
      runId: RUN_A,
      seq: 1,
      toolCallId: "call_3",
      name: "studio.plan_edit",
      args: {},
    });
    state = foldEvent(state, {
      type: "tool.delta",
      runId: RUN_A,
      seq: 2,
      toolCallId: "call_3",
      delta: "{",
    });
    state = foldEvent(state, {
      type: "tool.delta",
      runId: RUN_A,
      seq: 3,
      toolCallId: "call_3",
      delta: "}",
    });
    expect(state.messages[0]?.toolCards[0]?.deltaText).toBe("{}");
    // An orphan result (no started card) still shows up, done, unnamed.
    state = foldEvent(state, {
      type: "tool.result",
      runId: RUN_A,
      seq: 4,
      toolCallId: "call_4",
      result: { ok: true },
    });
    expect(state.messages[0]?.toolCards[1]).toEqual({
      toolCallId: "call_4",
      name: "",
      status: "done",
      result: { ok: true },
    });
  });
});

describe("applyUserMessage", () => {
  it("appends a user message without touching the phase", () => {
    const state = applyUserMessage(createInitialChatUiState(), { id: "u1", text: "Hi" });
    expect(state.messages).toEqual([{ id: "u1", role: "user", text: "Hi", toolCards: [] }]);
    expect(state.phase).toBe("idle");
  });
});

describe("applyClientAction", () => {
  it("submit → sending from idle/terminal, clearing the stale error", () => {
    const idle = applyClientAction(createInitialChatUiState(), { type: "chat.submit" });
    expect(idle.phase).toBe("sending");
    let failed = applyClientAction(idle, { type: "chat.paused" });
    expect(failed.error).toEqual(RUN_PAUSED_ERROR);
    failed = applyClientAction(failed, { type: "chat.submit" });
    expect(failed.phase).toBe("sending");
    expect(failed.error).toBeUndefined();
  });

  it("submit from a live phase is a no-op (the queue takes it instead)", () => {
    const streaming: ChatUiState = { ...createInitialChatUiState(), phase: "streaming" };
    expect(applyClientAction(streaming, { type: "chat.submit" })).toBe(streaming);
  });

  it("stop → cancelled from live phases only", () => {
    const streaming: ChatUiState = { ...createInitialChatUiState(), phase: "streaming" };
    expect(applyClientAction(streaming, { type: "chat.stop" }).phase).toBe("cancelled");
    const idle = createInitialChatUiState();
    expect(applyClientAction(idle, { type: "chat.stop" })).toBe(idle);
  });

  it("reconnecting works from live phases AND from failed (RUN_PAUSED resume)", () => {
    const streaming: ChatUiState = { ...createInitialChatUiState(), phase: "streaming" };
    expect(applyClientAction(streaming, { type: "chat.reconnecting" }).phase).toBe("reconnecting");
    const paused = applyClientAction(streaming, { type: "chat.paused" });
    expect(applyClientAction(paused, { type: "chat.reconnecting" }).phase).toBe("reconnecting");
    const idle = createInitialChatUiState();
    expect(applyClientAction(idle, { type: "chat.reconnecting" })).toBe(idle);
  });

  it("paused → failed + the §8.4 RUN_PAUSED error; error → failed + the error", () => {
    const sending: ChatUiState = { ...createInitialChatUiState(), phase: "sending" };
    expect(applyClientAction(sending, { type: "chat.paused" })).toEqual({
      ...sending,
      phase: "failed",
      error: {
        code: "RUN_PAUSED",
        message: "Run paused. Check your connection.",
        retryable: true,
      },
    });
    const error = applyClientAction(sending, {
      type: "chat.error",
      error: { code: "INSUFFICIENT_CREDITS", message: "You're 8 credits short.", retryable: false },
    });
    expect(error.phase).toBe("failed");
    expect(error.error?.code).toBe("INSUFFICIENT_CREDITS");
    const idle = createInitialChatUiState();
    expect(applyClientAction(idle, { type: "chat.paused" })).toBe(idle);
  });
});

// ---------------------------------------------------------------------------
// M6-H — the typed zero-balance block (§8.8 INSUFFICIENT_CREDITS 402) + the
// latest terminal credits snapshot (BP §M6 task 4; §7.4 event values are
// whole-credit DISPLAY units — the gateway emitter's documented units).
// ---------------------------------------------------------------------------

describe("M6-H credits block — chat.error 402 fold", () => {
  it("a 402 INSUFFICIENT_CREDITS chat.error records the typed blocked state (human-safe message, no retry)", () => {
    const sending: ChatUiState = { ...createInitialChatUiState(), phase: "sending" };
    const failed = applyClientAction(sending, {
      type: "chat.error",
      error: {
        code: "INSUFFICIENT_CREDITS",
        message: "This workspace is out of credits.",
        retryable: false,
      },
    });
    expect(failed.phase).toBe("failed");
    expect(failed.blocked).toEqual({
      reason: "insufficient-credits",
      message: "This workspace is out of credits.",
    });
  });

  it("any other §7.3 error code leaves the blocked state UNSET", () => {
    const sending: ChatUiState = { ...createInitialChatUiState(), phase: "sending" };
    const failed = applyClientAction(sending, {
      type: "chat.error",
      error: { code: "RATE_LIMITED", message: "Too many requests.", retryable: true },
    });
    expect(failed.blocked).toBeUndefined();
  });

  it("chat.submit re-arms: a fresh send clears the typed block (the server re-checks on the wire)", () => {
    const sending: ChatUiState = { ...createInitialChatUiState(), phase: "sending" };
    const blocked = applyClientAction(sending, {
      type: "chat.error",
      error: { code: "INSUFFICIENT_CREDITS", message: "Out of credits.", retryable: false },
    });
    const resubmitted = applyClientAction(blocked, { type: "chat.submit" });
    expect(resubmitted.phase).toBe("sending");
    expect(resubmitted.blocked).toBeUndefined();
  });
});

describe("M6-H credits block — run.failed / run.started / run.completed folds", () => {
  it("a terminal run.failed carrying INSUFFICIENT_CREDITS records the block; run.completed clears it", () => {
    const streaming: ChatUiState = foldEvent(
      withUserMessage(),
      START_A as Extract<StudioStreamEvent, { type: "run.started" }>,
    );
    const failed = foldEvent(streaming, {
      type: "run.failed",
      runId: RUN_A,
      seq: 9,
      code: "INSUFFICIENT_CREDITS",
      message: "This workspace is out of credits.",
      retryable: false,
    });
    expect(failed.blocked).toEqual({
      reason: "insufficient-credits",
      message: "This workspace is out of credits.",
    });
    const recovered = foldEvent(failed, {
      type: "run.started",
      runId: RUN_B,
      seq: 0,
      model: "studio-fast",
    });
    expect(recovered.blocked).toBeUndefined();
  });

  it("a new run taking over clears any stale block (the server could fund it)", () => {
    const blocked: ChatUiState = {
      ...withUserMessage(),
      phase: "failed",
      activeRunId: null,
      blocked: { reason: "insufficient-credits", message: "Out of credits." },
      error: { code: "INSUFFICIENT_CREDITS", message: "Out of credits.", retryable: false },
    };
    const takeover = foldEvent(blocked, {
      type: "run.started",
      runId: RUN_B,
      seq: 0,
      model: "studio-smart",
    });
    expect(takeover.phase).toBe("streaming");
    expect(takeover.blocked).toBeUndefined();
  });
});

describe("M6-H latestCreditsSnapshot", () => {
  it("returns the NEWEST terminal credits snapshot on the thread (display-unit balance)", () => {
    const done = APPLIED.reduce((state, event) => foldEvent(state, event), withUserMessage());
    const credits = latestCreditsSnapshot(done);
    const expected = APPLIED.filter((event) => event.type === "credits").at(-1);
    expect(credits).not.toBeNull();
    expect(expected?.type).toBe("credits");
    expect(credits?.balance).toBe(expected?.type === "credits" ? expected.balance : undefined);
  });

  it("is null before any run reported credits; survives a trailing message without them", () => {
    expect(latestCreditsSnapshot(createInitialChatUiState())).toBeNull();
    const withCredits = APPLIED.reduce(
      (state, event) => foldEvent(state, event),
      withUserMessage(),
    );
    const plusUser = applyUserMessage(withCredits, { id: "msg_user_2", text: "again" });
    expect(latestCreditsSnapshot(plusUser)?.balance).not.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ROUND 12: turn.* folds (TURN WIRE CONTRACT) — additive, passive, cursor-only
// where the controller owns recovery. The turn transport rewrites per-turn
// server seqs into the run's monotonic LOCAL seqs, so these tests use plain
// increasing seqs like every other fold.
// ---------------------------------------------------------------------------

const RUN_T = "run_turn_local";

function turnThread(): ChatUiState {
  const started: StudioStreamEvent = {
    type: "run.started",
    runId: RUN_T,
    seq: 0,
    model: "gpt-5.2",
  };
  return foldEvent(withUserMessage(), started);
}

describe("foldEvent — round-12 turn.* events", () => {
  it("turn.started is cursor-only: it resumes `sending` but mutates no message", () => {
    const state = foldEvent(turnThread(), {
      type: "turn.started",
      runId: RUN_T,
      seq: 1,
      stepIndex: 0,
    });
    expect(state.phase).toBe("streaming");
    expect(state.messages.at(-1)?.toolCards).toEqual([]);
    expect(state.messages.at(-1)?.toolCalls).toBeUndefined();
    expect(state.lastSeq).toBe(1);
  });

  it("turn.completed stores the toolCalls payload and completes the half-streamed bubble", () => {
    let state = foldEvent(turnThread(), {
      type: "message.delta",
      runId: RUN_T,
      seq: 1,
      delta: "Keyfra",
    });
    state = foldEvent(state, {
      type: "turn.completed",
      runId: RUN_T,
      seq: 2,
      stepIndex: 0,
      finishReason: "tool-calls",
      usage: { inputTokens: 90, outputTokens: 12 },
      credits: { committed: 1 },
      assistantText: "Keyframing now.",
      toolCalls: [
        {
          toolCallId: "call_t1",
          tool: "studio.set_keyframes",
          args: { propertyPath: "scale" },
          resultForModel: { proposedBatch: { label: "Agent: keyframes", steps: [] } },
          proposal: null,
        },
      ],
    });
    const message = state.messages.at(-1);
    expect(message?.text).toBe("Keyframing now."); // the terminal is authoritative
    expect(message?.toolCalls).toHaveLength(1);
    expect(message?.toolCalls?.[0]?.tool).toBe("studio.set_keyframes");
    expect(state.phase).toBe("streaming"); // turn ends ≠ run ends
  });

  it("a fully streamed turn.completed keeps the reference stable (replay repair is a no-op)", () => {
    const before = foldEvent(turnThread(), {
      type: "message.delta",
      runId: RUN_T,
      seq: 1,
      delta: "Done.",
    });
    const after = foldEvent(before, {
      type: "turn.completed",
      runId: RUN_T,
      seq: 2,
      stepIndex: 0,
      finishReason: "stop",
      usage: { inputTokens: 9, outputTokens: 1 },
      credits: { committed: 0 },
      assistantText: "Done.",
      toolCalls: [],
    });
    expect(after.messages.at(-1)?.text).toBe("Done.");
  });

  it("turn.failed is cursor-only: a transient failure never flaps the phase", () => {
    const state = foldEvent(turnThread(), {
      type: "turn.failed",
      runId: RUN_T,
      seq: 1,
      stepIndex: 0,
      code: "PROVIDER_5XX",
      message: "The model hiccuped.",
      retryable: true,
      credits: { committed: 0 },
    });
    expect(state.phase).toBe("streaming");
    expect(state.error).toBeUndefined();
    expect(state.lastSeq).toBe(1); // the cursor still advances
  });

  it("turn events for a frozen (terminal) run change nothing but the cursor", () => {
    let state = turnThread();
    state = foldEvent(state, { type: "run.completed", runId: RUN_T, seq: 1 });
    expect(state.phase).toBe("done");
    const after = foldEvent(state, {
      type: "turn.completed",
      runId: RUN_T,
      seq: 2,
      stepIndex: 3,
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
      credits: { committed: 1 },
      assistantText: "late replay",
      toolCalls: [],
    });
    expect(after.phase).toBe("done");
    expect(after.messages.at(-1)?.text).toBe(""); // frozen — the late text never lands
    expect(after.lastSeq).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// w3-b01 — the turn.completed credits fold: committed ONLY. The payload has
// no balance (contracts events.ts `credits: z.strictObject({ committed })`),
// so reserved/balance carry the last REAL values forward or are marked
// UNKNOWN (NaN) — never a fabricated 0, which used to lock the composer's
// zero-balance gate and render "0.00 credits left" after every run.
// ---------------------------------------------------------------------------

describe("turn.completed credits fold — committed only, never a fabricated balance (w3-b01)", () => {
  it("marks reserved/balance UNKNOWN (NaN) when no §7.4 credits event ever ran", () => {
    const state = foldEvent(turnThread(), {
      type: "turn.completed",
      runId: RUN_T,
      seq: 2,
      stepIndex: 0,
      finishReason: "stop",
      usage: { inputTokens: 9, outputTokens: 1 },
      credits: { committed: 3 },
      assistantText: "Done.",
      toolCalls: [],
    });
    const credits = state.messages.at(-1)?.credits;
    expect(credits).toBeDefined();
    expect(credits?.committed).toBe(3); // the one number the wire carries
    expect(Number.isNaN(credits?.reserved)).toBe(true); // unknown ≠ 0
    expect(Number.isNaN(credits?.balance)).toBe(true); // unknown ≠ 0
    // The chain the fabricated 0 used to break: the latest snapshot's
    // balance can NEVER read as a drained wallet.
    const latest = latestCreditsSnapshot(state);
    expect(latest?.balance === 0).toBe(false);
  });

  it("accumulates committed across the run's turns while the balance stays unknown", () => {
    let state = foldEvent(turnThread(), {
      type: "turn.completed",
      runId: RUN_T,
      seq: 2,
      stepIndex: 0,
      finishReason: "tool-calls",
      usage: { inputTokens: 90, outputTokens: 12 },
      credits: { committed: 3 },
      toolCalls: [],
    });
    state = foldEvent(state, {
      type: "turn.completed",
      runId: RUN_T,
      seq: 3,
      stepIndex: 1,
      finishReason: "stop",
      usage: { inputTokens: 20, outputTokens: 4 },
      credits: { committed: 5 },
      assistantText: "Done.",
      toolCalls: [],
    });
    expect(state.messages.at(-1)?.credits).toEqual({
      reserved: Number.NaN,
      committed: 8,
      balance: Number.NaN,
    });
  });

  it("carries a REAL §7.4 credits balance forward over later turn.completed folds", () => {
    let state = foldEvent(turnThread(), {
      type: "credits",
      runId: RUN_T,
      seq: 2,
      reserved: 36,
      committed: 0,
      balance: 42.5,
    });
    state = foldEvent(state, {
      type: "turn.completed",
      runId: RUN_T,
      seq: 3,
      stepIndex: 0,
      finishReason: "stop",
      usage: { inputTokens: 9, outputTokens: 1 },
      credits: { committed: 7 },
      assistantText: "Done.",
      toolCalls: [],
    });
    expect(state.messages.at(-1)?.credits).toEqual({
      reserved: 36,
      committed: 7,
      balance: 42.5,
    });
  });

  it("a fully completed turn run folds to an UNKNOWN balance — no zero-balance lock is derivable", () => {
    let state = turnThread();
    state = foldEvent(state, {
      type: "turn.completed",
      runId: RUN_T,
      seq: 2,
      stepIndex: 0,
      finishReason: "stop",
      usage: { inputTokens: 9, outputTokens: 1 },
      credits: { committed: 1 },
      assistantText: "Done.",
      toolCalls: [],
    });
    state = foldEvent(state, { type: "run.completed", runId: RUN_T, seq: 3 });
    expect(state.phase).toBe("done");
    const latest = latestCreditsSnapshot(state);
    expect(latest).not.toBeNull();
    expect(latest?.committed).toBe(1);
    expect(Number.isNaN(latest?.balance)).toBe(true); // unknown — the composer gate reads ≠ 0
  });
});
