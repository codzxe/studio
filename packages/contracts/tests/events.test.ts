import { describe, expect, it } from "vitest";

import type { EditPlan } from "../src/edit-plan.js";
import {
  INITIAL_RUN_STATE,
  type RunState,
  STUDIO_STREAM_EVENT_SCHEMA,
  STUDIO_STREAM_EVENT_TYPES,
  type StudioStreamEvent,
  applyEvents,
  isStudioStreamEvent,
  reduceEvents,
} from "../src/events.js";

const RUN_ID = "run_0192";

function plan(overrides: Partial<EditPlan> = {}): EditPlan {
  return {
    intent: "animate",
    summary: "Keyframe Scale on Headline",
    risk: "low",
    requiresApproval: true,
    affectedLayers: [{ name: "Headline", change: "keyframe scale" }],
    estimatedCredits: 2,
    steps: [
      {
        title: "Keyframe scale",
        tool: "studio.set_keyframes",
        args: {},
        batch: {
          label: "Agent: keyframe scale",
          steps: [{ command: "prop.set", params: { path: "transform/scale", value: 100 } }],
        },
      },
    ],
    ...overrides,
  };
}

/** Sample of every §7.4 event type, in wire order, seq increasing. */
function allEventSamples(): StudioStreamEvent[] {
  return [
    { type: "run.started", runId: RUN_ID, seq: 0, model: "studio-smart" },
    { type: "message.delta", runId: RUN_ID, seq: 1, delta: "On it — " },
    {
      type: "tool.started",
      runId: RUN_ID,
      seq: 2,
      toolCallId: "t1",
      name: "studio.get_context",
      args: { include: [] },
    },
    { type: "tool.delta", runId: RUN_ID, seq: 3, toolCallId: "t1", delta: '{"comps"' },
    {
      type: "tool.result",
      runId: RUN_ID,
      seq: 4,
      toolCallId: "t1",
      result: { comps: 3, layers: 42 },
    },
    { type: "plan", runId: RUN_ID, seq: 5, plan: plan() },
    { type: "preview", runId: RUN_ID, seq: 6, pngBase64: "iVBORw0KGgo=", width: 1200, height: 675 },
    { type: "approval.required", runId: RUN_ID, seq: 7, plan: plan() },
    { type: "credits", runId: RUN_ID, seq: 8, reserved: 2.4, committed: 1.8, balance: 97.6 },
    { type: "run.completed", runId: RUN_ID, seq: 9, versionId: "ver_77" },
    {
      type: "run.failed",
      runId: RUN_ID,
      seq: 9,
      code: "RUN_INVALID_COMMAND",
      message: "Unknown command",
      retryable: false,
    },
    { type: "run.cancelled", runId: RUN_ID, seq: 9 },
  ];
}

describe("events: §7.4 catalogue", () => {
  it("exposes exactly the 12 spec event types", () => {
    expect([...STUDIO_STREAM_EVENT_TYPES]).toEqual([
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
    ]);
  });

  it("every event sample parses, in any order of emission", () => {
    for (const event of allEventSamples()) {
      const parsed = STUDIO_STREAM_EVENT_SCHEMA.safeParse(event);
      expect(parsed.success, JSON.stringify(event)).toBe(true);
      expect(isStudioStreamEvent(event)).toBe(true);
    }
  });

  it("rejects unknown types, missing runId, and non-monotonic seq shapes", () => {
    expect(
      STUDIO_STREAM_EVENT_SCHEMA.safeParse({ type: "run.paused", runId: RUN_ID, seq: 0 }).success,
    ).toBe(false);
    expect(
      STUDIO_STREAM_EVENT_SCHEMA.safeParse({ type: "run.started", seq: 0, model: "m" }).success,
    ).toBe(false); // missing runId
    expect(
      STUDIO_STREAM_EVENT_SCHEMA.safeParse({
        type: "message.delta",
        runId: RUN_ID,
        seq: -1,
        delta: "x",
      }).success,
    ).toBe(false); // negative seq
    expect(
      STUDIO_STREAM_EVENT_SCHEMA.safeParse({
        type: "message.delta",
        runId: RUN_ID,
        seq: 1.5,
        delta: "x",
      }).success,
    ).toBe(false); // fractional seq
  });

  it("plan/approval events embed full EditPlans", () => {
    const bad = { type: "plan", runId: RUN_ID, seq: 1, plan: { ...plan(), steps: [] } };
    expect(STUDIO_STREAM_EVENT_SCHEMA.safeParse(bad).success).toBe(false); // §8.6: min 1 step
  });
});

describe("events: reducer happy path (§8.1 idle→sending→streaming→…→applied)", () => {
  it("streams text, tools, plan, approval, credits, then applies and versions", () => {
    const state = reduceEvents([
      { type: "run.submit" },
      { type: "run.started", runId: RUN_ID, seq: 0, model: "studio-smart" },
      { type: "message.delta", runId: RUN_ID, seq: 1, delta: "On it — " },
      { type: "message.delta", runId: RUN_ID, seq: 2, delta: "plan first." },
      {
        type: "tool.started",
        runId: RUN_ID,
        seq: 3,
        toolCallId: "t1",
        name: "studio.get_context",
        args: { include: [] },
      },
      { type: "tool.delta", runId: RUN_ID, seq: 4, toolCallId: "t1", delta: '{"comps"' },
      { type: "tool.result", runId: RUN_ID, seq: 5, toolCallId: "t1", result: { comps: 3 } },
      { type: "plan", runId: RUN_ID, seq: 6, plan: plan() },
      { type: "approval.required", runId: RUN_ID, seq: 7, plan: plan() },
      { type: "credits", runId: RUN_ID, seq: 8, reserved: 2.4, committed: 1.8, balance: 97.6 },
      { type: "run.apply" },
      { type: "run.applied", versionId: "ver_77" },
    ]);

    expect(state.status).toBe("applied");
    expect(state.runId).toBe(RUN_ID);
    expect(state.model).toBe("studio-smart");
    expect(state.text).toBe("On it — plan first.");
    expect(state.toolCalls).toEqual([
      {
        toolCallId: "t1",
        name: "studio.get_context",
        status: "done",
        args: { include: [] },
        deltaText: '{"comps"',
        result: { comps: 3 },
      },
    ]);
    expect(state.plan?.summary).toBe("Keyframe Scale on Headline");
    expect(state.approvalRequired).toBe(false);
    expect(state.credits).toEqual({ reserved: 2.4, committed: 1.8, balance: 97.6, seq: 8 });
    expect(state.versionId).toBe("ver_77");
    expect(state.error).toBeNull();
    expect(state.lastSeq).toBe(8);
  });

  it("run.completed alone drives streaming→applied and fills versionId", () => {
    const state = reduceEvents([
      { type: "run.started", runId: RUN_ID, seq: 0, model: "studio-fast" },
      { type: "plan", runId: RUN_ID, seq: 1, plan: plan({ requiresApproval: false }) },
      { type: "run.completed", runId: RUN_ID, seq: 2, versionId: "ver_78" },
    ]);
    expect(state.status).toBe("applied");
    expect(state.versionId).toBe("ver_78");
  });

  it("plan without requiresApproval keeps the run streaming", () => {
    const state = reduceEvents([
      { type: "run.started", runId: RUN_ID, seq: 0, model: "studio-fast" },
      { type: "plan", runId: RUN_ID, seq: 1, plan: plan({ requiresApproval: false }) },
    ]);
    expect(state.status).toBe("streaming");
  });

  it("preview frames are tracked (latest wins)", () => {
    const state = reduceEvents([
      { type: "run.started", runId: RUN_ID, seq: 0, model: "studio-fast" },
      { type: "preview", runId: RUN_ID, seq: 1, pngBase64: "aaa", width: 100, height: 50 },
      { type: "preview", runId: RUN_ID, seq: 2, pngBase64: "bbb", width: 200, height: 100 },
    ]);
    expect(state.preview).toEqual({ pngBase64: "bbb", width: 200, height: 100, seq: 2 });
  });
});

describe("events: reducer failure and cancel semantics", () => {
  it("run.failed is terminal: error recorded, late tail ignored", () => {
    let state: RunState = reduceEvents([
      { type: "run.started", runId: RUN_ID, seq: 0, model: "studio-smart" },
      {
        type: "run.failed",
        runId: RUN_ID,
        seq: 1,
        code: "RUN_BATCH_ROLLED_BACK",
        message: "step 3 failed; batch rolled back",
        retryable: true,
      },
    ]);
    expect(state.status).toBe("failed");
    expect(state.error).toEqual({
      code: "RUN_BATCH_ROLLED_BACK",
      message: "step 3 failed; batch rolled back",
      retryable: true,
    });
    state = applyEvents(state, {
      type: "credits",
      runId: RUN_ID,
      seq: 2,
      reserved: 0,
      committed: 0,
      balance: 100,
    });
    expect(state.credits).toBeNull(); // terminal → dropped
    expect(state.status).toBe("failed");
  });

  it("client cancel → cancelling; server confirm → cancelled; no auto-undo (§8.3)", () => {
    const midRun = reduceEvents([
      { type: "run.submit" },
      { type: "run.started", runId: RUN_ID, seq: 0, model: "studio-smart" },
      { type: "message.delta", runId: RUN_ID, seq: 1, delta: "hi" },
    ]);
    const cancelling = applyEvents(midRun, { type: "run.cancel" });
    expect(cancelling.status).toBe("cancelling");
    // a late delta still records passively but cannot resurrect streaming
    const afterDelta = applyEvents(cancelling, {
      type: "message.delta",
      runId: RUN_ID,
      seq: 2,
      delta: "…",
    });
    expect(afterDelta.status).toBe("cancelling");
    expect(afterDelta.text).toBe("hi…");
    const cancelled = applyEvents(afterDelta, { type: "run.cancelled", runId: RUN_ID, seq: 3 });
    expect(cancelled.status).toBe("cancelled");
    // cancellation after an applied batch does not undo it
    expect(applyEvents(cancelled, { type: "run.submit" }).status).toBe("sending"); // new message resets the card
  });

  it("run.cancelled straight from streaming (server-side stop)", () => {
    const state = reduceEvents([
      { type: "run.started", runId: RUN_ID, seq: 0, model: "studio-fast" },
      { type: "run.cancelled", runId: RUN_ID, seq: 1 },
    ]);
    expect(state.status).toBe("cancelled");
  });

  it("undo flow: applied → undoing → undone", () => {
    const state = reduceEvents([
      { type: "run.started", runId: RUN_ID, seq: 0, model: "studio-smart" },
      { type: "run.completed", runId: RUN_ID, seq: 1, versionId: "ver_1" },
      { type: "run.undo" },
      { type: "run.undone" },
    ]);
    expect(state.status).toBe("undone");
    expect(state.versionId).toBe("ver_1"); // version remains in history (§8.7)
  });
});

describe("events: ordering rules (§7.4)", () => {
  it("drops duplicate and out-of-order seqs (Last-Event-ID replay is idempotent)", () => {
    const events = allEventSamples().filter(
      (e) => e.type !== "run.failed" && e.type !== "run.cancelled",
    );
    const state = reduceEvents(events);
    const replayed = applyEvents(state, {
      type: "message.delta",
      runId: RUN_ID,
      seq: 1,
      delta: "SHOULD NOT APPEND",
    });
    expect(replayed.text).toBe(state.text);
    const older = applyEvents(state, {
      type: "credits",
      runId: RUN_ID,
      seq: 0,
      reserved: 1,
      committed: 1,
      balance: 1,
    });
    expect(older.credits?.seq).toBe(8);
  });

  it("drops events bound to a different run", () => {
    const state = reduceEvents([
      { type: "run.started", runId: RUN_ID, seq: 0, model: "studio-fast" },
    ]);
    const foreign = applyEvents(state, {
      type: "message.delta",
      runId: "run_OTHER",
      seq: 1,
      delta: "x",
    });
    expect(foreign).toBe(state); // no-op
  });

  it("drops stream events while idle (before run.started)", () => {
    const state = applyEvents(INITIAL_RUN_STATE, {
      type: "message.delta",
      runId: RUN_ID,
      seq: 5,
      delta: "early",
    });
    expect(state).toBe(INITIAL_RUN_STATE);
  });

  it("accepts seq 0 as the first event", () => {
    const state = applyEvents(INITIAL_RUN_STATE, {
      type: "run.started",
      runId: RUN_ID,
      seq: 0,
      model: "studio-fast",
    });
    expect(state.status).toBe("streaming");
    expect(state.lastSeq).toBe(0);
  });

  it("invalid client transitions are no-ops, never throws", () => {
    const idle = INITIAL_RUN_STATE;
    expect(applyEvents(idle, { type: "run.apply" }).status).toBe("idle"); // no plan yet
    expect(applyEvents(idle, { type: "run.applied", versionId: "v" }).status).toBe("idle");
    expect(applyEvents(idle, { type: "run.undo" }).status).toBe("idle");
    expect(applyEvents(idle, { type: "run.undone" }).status).toBe("idle");
    expect(applyEvents(idle, { type: "run.cancel" }).status).toBe("idle"); // nothing to cancel
    expect(applyEvents(idle, { type: "run.submit" }).status).toBe("sending");
    // cannot submit a new message mid-run
    const streaming = applyEvents(applyEvents(idle, { type: "run.submit" }), {
      type: "run.started",
      runId: RUN_ID,
      seq: 0,
      model: "m",
    });
    expect(applyEvents(streaming, { type: "run.submit" }).status).toBe("streaming");
  });
});
