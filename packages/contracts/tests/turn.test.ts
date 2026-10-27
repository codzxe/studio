// Round-12 TURN WIRE CONTRACT tests (research/round12-design.md — pinned).
//
// POST /v1/threads/:id/turn request bodies, the TurnMessage role union, the
// TurnToolCall proposal carrier, the turn.* SSE events and the reducer's
// PASSIVE stance toward them (the client chat-controller owns turn state).

import { describe, expect, it } from "vitest";

import type { EditPlan } from "../src/edit-plan.js";
import {
  STUDIO_STREAM_EVENT_SCHEMA,
  STUDIO_STREAM_EVENT_TYPES,
  TURN_COMPLETED_EVENT_SCHEMA,
  TURN_FAILED_EVENT_SCHEMA,
  TURN_FINISH_REASON_SCHEMA,
  TURN_STARTED_EVENT_SCHEMA,
  TURN_TOOL_CALL_SCHEMA,
  applyEvents,
  reduceEvents,
} from "../src/events.js";
import {
  MAX_TURN_CANVAS_LAYERS,
  MAX_TURN_MESSAGES_BYTES,
  MAX_TURN_MESSAGE_PARTS,
  TURN_MESSAGE_SCHEMA,
  TURN_REQUEST_SCHEMA,
} from "../src/routes/turn.js";

const RUN_ID = "run_0192";
const STEER_TEXT = "Make the headline bolder, keep the rest.";

/** One tool-call carrier with the gateway-compiled proposal (write tools). */
function proposalCarrier() {
  const batch = {
    label: 'Agent: Add text layer "Headline"',
    atomic: true as const,
    steps: [{ command: "layer.newText", params: { text: "Hello", name: "Headline" } }],
  };
  return {
    toolCallId: "call_1",
    tool: "studio.create_text",
    args: { text: "Hello", name: "Headline" },
    resultForModel: {
      proposedBatch: { label: batch.label, steps: batch.steps },
      note: "Proposed batch only — nothing is executed until the user applies the plan.",
    },
    proposal: {
      compiled: {
        batch,
        risk: "low",
        estimatedCredits: 1.5,
        resolutionRequests: [{ requestId: "lr-1", layerName: "Headline", disambiguation: [] }],
      },
    },
  };
}

describe("turn: TurnMessage role union (TURN WIRE CONTRACT roles, exact)", () => {
  it("parses all five roles with their exact shapes", () => {
    const samples = [
      { role: "user", text: "Animate the headline in" },
      { role: "assistant", text: "On it — keyframing scale." },
      { role: "tool_call", toolCallId: "call_1", tool: "studio.get_context", args: {} },
      { role: "tool_result", toolCallId: "call_1", tool: "studio.get_context", result: {} },
      { role: "steer", text: STEER_TEXT },
    ];
    for (const message of samples) {
      const parsed = TURN_MESSAGE_SCHEMA.safeParse(message);
      expect(parsed.success, JSON.stringify(message)).toBe(true);
      expect((parsed.success ? parsed.data : undefined)?.role).toBe(message.role);
    }
  });

  it("assistant text may be empty (tool-calls-only round); user/steer may not", () => {
    expect(TURN_MESSAGE_SCHEMA.safeParse({ role: "assistant", text: "" }).success).toBe(true);
    expect(TURN_MESSAGE_SCHEMA.safeParse({ role: "user", text: "" }).success).toBe(false);
    expect(TURN_MESSAGE_SCHEMA.safeParse({ role: "steer", text: "" }).success).toBe(false);
  });

  it("rejects unknown roles, cross-role fields and strict unknowns", () => {
    expect(TURN_MESSAGE_SCHEMA.safeParse({ role: "system", text: "x" }).success).toBe(false);
    expect(
      TURN_MESSAGE_SCHEMA.safeParse({ role: "user", text: "x", toolCallId: "t" }).success,
    ).toBe(false);
    expect(
      TURN_MESSAGE_SCHEMA.safeParse({ role: "tool_call", toolCallId: "t", tool: "x" }).success, // no args
    ).toBe(false);
    expect(
      TURN_MESSAGE_SCHEMA.safeParse({
        role: "tool_result",
        toolCallId: "t",
        tool: "x",
        result: {},
        extra: true,
      }).success,
    ).toBe(false);
  });
});

describe("turn: TURN_REQUEST_SCHEMA (runId, stepIndex, messages, context, canvas)", () => {
  const BASE = {
    runId: "run_0192",
    stepIndex: 0,
    messages: [{ role: "user", text: "Make a motion graphics video" }],
  };

  it("accepts the minimal body and the optional model/context/pinned/canvas", () => {
    expect(TURN_REQUEST_SCHEMA.safeParse(BASE).success).toBe(true);
    expect(
      TURN_REQUEST_SCHEMA.safeParse({
        ...BASE,
        model: "studio-smart",
        stepIndex: 3,
        context: { selection: true },
        pinned: [{ kind: "composition", label: "Main" }],
        canvas: {
          layers: [{ id: 1, name: "Headline", type: "text" }],
          selection: [1],
          playhead: 0,
          fps: 30,
          duration: 10,
        },
      }).success,
    ).toBe(true);
    expect(TURN_REQUEST_SCHEMA.safeParse({ ...BASE, canvas: null }).success).toBe(true);
  });

  it("validates runId/stepIndex/model and rejects unknown keys (strict)", () => {
    expect(TURN_REQUEST_SCHEMA.safeParse({ ...BASE, runId: "" }).success).toBe(false);
    expect(TURN_REQUEST_SCHEMA.safeParse({ ...BASE, stepIndex: -1 }).success).toBe(false);
    expect(TURN_REQUEST_SCHEMA.safeParse({ ...BASE, stepIndex: 1.5 }).success).toBe(false);
    expect(TURN_REQUEST_SCHEMA.safeParse({ ...BASE, model: "gpt-9" }).success).toBe(false);
    expect(TURN_REQUEST_SCHEMA.safeParse({ ...BASE, surprise: true }).success).toBe(false);
  });

  it("caps messages at 64 parts and rejects empty transcripts", () => {
    const fill = (count: number) =>
      Array.from({ length: count }, () => ({ role: "assistant", text: "ok" }));
    expect(fill(MAX_TURN_MESSAGE_PARTS).length).toBe(64);
    expect(
      TURN_REQUEST_SCHEMA.safeParse({ ...BASE, messages: fill(MAX_TURN_MESSAGE_PARTS) }).success,
    ).toBe(true);
    expect(
      TURN_REQUEST_SCHEMA.safeParse({ ...BASE, messages: fill(MAX_TURN_MESSAGE_PARTS + 1) })
        .success,
    ).toBe(false);
    expect(TURN_REQUEST_SCHEMA.safeParse({ ...BASE, messages: [] }).success).toBe(false);
  });

  it("enforces the 64 KB serialized messages cap via superRefine", () => {
    const bigText = "x".repeat(32_000);
    const within = { ...BASE, messages: [{ role: "assistant", text: bigText }] };
    expect(JSON.stringify(within.messages).length).toBeLessThanOrEqual(MAX_TURN_MESSAGES_BYTES);
    expect(TURN_REQUEST_SCHEMA.safeParse(within).success).toBe(true);
    const over = {
      ...BASE,
      messages: [
        { role: "assistant", text: bigText },
        { role: "assistant", text: bigText },
        { role: "assistant", text: bigText },
      ],
    };
    expect(JSON.stringify(over.messages).length).toBeGreaterThan(MAX_TURN_MESSAGES_BYTES);
    const parsed = TURN_REQUEST_SCHEMA.safeParse(over);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path[0] === "messages")).toBe(true);
    }
  });

  it("caps the canvas snapshot at 80 layers (design doc)", () => {
    const layers = Array.from({ length: MAX_TURN_CANVAS_LAYERS }, (_, i) => ({
      id: i,
      name: `L${i}`,
      type: "text",
    }));
    const canvas = { layers, selection: [], playhead: 0, fps: 30, duration: 1 };
    expect(TURN_REQUEST_SCHEMA.safeParse({ ...BASE, canvas }).success).toBe(true);
    expect(
      TURN_REQUEST_SCHEMA.safeParse({
        ...BASE,
        canvas: { ...canvas, layers: [...layers, layers[0]] },
      }).success,
    ).toBe(false);
    expect(
      TURN_REQUEST_SCHEMA.safeParse({
        ...BASE,
        canvas: { ...canvas, activeComp: "comp_1" },
      }).success,
    ).toBe(true);
  });
});

describe("turn: TurnToolCall (proposal optional + nullable)", () => {
  it("read/generative tools: proposal omitted or null", () => {
    const read = {
      toolCallId: "call_2",
      tool: "studio.list_layers",
      args: {},
      resultForModel: { comps: 1 },
    };
    expect(TURN_TOOL_CALL_SCHEMA.safeParse(read).success).toBe(true);
    expect(TURN_TOOL_CALL_SCHEMA.safeParse({ ...read, proposal: null }).success).toBe(true);
  });

  it("write tools: proposal.compiled carries batch/risk/credits/resolutionRequests", () => {
    expect(TURN_TOOL_CALL_SCHEMA.safeParse(proposalCarrier()).success).toBe(true);
    const bad = {
      ...proposalCarrier(),
      proposal: {
        compiled: { ...proposalCarrier().proposal?.compiled, batch: { atomic: false } },
      },
    };
    expect(TURN_TOOL_CALL_SCHEMA.safeParse(bad).success).toBe(false); // atomic pinned true
  });

  it("toolCallId/tool are required non-empty strings", () => {
    expect(
      TURN_TOOL_CALL_SCHEMA.safeParse({ toolCallId: "", tool: "x", resultForModel: null }).success,
    ).toBe(false);
    expect(
      TURN_TOOL_CALL_SCHEMA.safeParse({ toolCallId: "t", tool: "", resultForModel: null }).success,
    ).toBe(false);
  });
});

describe("turn: turn.* SSE events join the StudioStreamEvent union", () => {
  it("all three turn events parse through the union and the individual schemas", () => {
    const events = [
      { type: "turn.started", runId: RUN_ID, seq: 1, stepIndex: 0 },
      {
        type: "turn.completed",
        runId: RUN_ID,
        seq: 2,
        stepIndex: 0,
        finishReason: "tool-calls",
        usage: { inputTokens: 120, outputTokens: 40 },
        credits: { committed: 0.4 },
        assistantText: "Adding the text now.",
        toolCalls: [proposalCarrier()],
      },
      {
        type: "turn.failed",
        runId: RUN_ID,
        seq: 3,
        stepIndex: 1,
        code: "RUN_MODEL_UNAVAILABLE",
        message: "The model provider is unavailable.",
        retryable: true,
        credits: { committed: 0 },
      },
    ];
    for (const event of events) {
      expect(STUDIO_STREAM_EVENT_SCHEMA.safeParse(event).success, JSON.stringify(event)).toBe(true);
    }
    expect(TURN_STARTED_EVENT_SCHEMA.safeParse(events[0]).success).toBe(true);
    expect(TURN_COMPLETED_EVENT_SCHEMA.safeParse(events[1]).success).toBe(true);
    expect(TURN_FAILED_EVENT_SCHEMA.safeParse(events[2]).success).toBe(true);
    for (const type of ["turn.started", "turn.completed", "turn.failed"]) {
      expect(STUDIO_STREAM_EVENT_TYPES).toContain(type);
    }
  });

  it("turn.completed requires the finishReason enum, usage and credits; step-limit included", () => {
    expect([...TURN_FINISH_REASON_SCHEMA.options]).toEqual(["stop", "tool-calls", "step-limit"]);
    const base = {
      type: "turn.completed",
      runId: RUN_ID,
      seq: 2,
      stepIndex: 0,
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
      credits: { committed: 1 },
      toolCalls: [],
    };
    expect(TURN_COMPLETED_EVENT_SCHEMA.safeParse(base).success).toBe(true);
    expect(TURN_COMPLETED_EVENT_SCHEMA.safeParse({ ...base, finishReason: "length" }).success).toBe(
      false,
    );
    expect(
      TURN_COMPLETED_EVENT_SCHEMA.safeParse({ ...base, usage: { inputTokens: 1 } }).success,
    ).toBe(false);
    expect(TURN_COMPLETED_EVENT_SCHEMA.safeParse({ ...base, toolCalls: undefined }).success).toBe(
      false,
    );
  });

  it("turn events are rejected through the union when required fields are missing", () => {
    expect(
      STUDIO_STREAM_EVENT_SCHEMA.safeParse({ type: "turn.started", runId: RUN_ID }).success,
    ).toBe(false); // no seq
    expect(
      STUDIO_STREAM_EVENT_SCHEMA.safeParse({ type: "turn.failed", runId: RUN_ID, seq: 1 }).success,
    ).toBe(false); // no code/message/retryable
  });

  it("the reducer is PASSIVE for turn.* events (chat-controller owns turn state)", () => {
    const state = reduceEvents([
      { type: "run.started", runId: RUN_ID, seq: 0, model: "studio-smart" },
      { type: "turn.started", runId: RUN_ID, seq: 1, stepIndex: 0 },
    ]);
    expect(state.status).toBe("streaming"); // unchanged by turn.started
    expect(state.lastSeq).toBe(1); // ordering rules still apply
    const afterFail = applyEvents(state, {
      type: "turn.failed",
      runId: RUN_ID,
      seq: 2,
      stepIndex: 0,
      code: "RUN_STEP_LIMIT",
      message: "Step budget exhausted.",
      retryable: false,
      credits: { committed: 3.2 },
    });
    expect(afterFail.status).toBe("streaming"); // passive by design — documented
    expect(afterFail.lastSeq).toBe(2);
  });
});

/** Unused-import guard: EditPlan type rides the turn proposal batch below. */
describe("turn: types are importable", () => {
  it("EditPlan and the request types stay type-only importable", () => {
    const plan: EditPlan = {
      intent: "create",
      summary: "Add text",
      risk: "low",
      requiresApproval: false,
      affectedLayers: [],
      estimatedCredits: 1.5,
      steps: [],
    };
    // steps min 1 is enforced by EDIT_PLAN_SCHEMA, not the literal type above.
    expect(plan.intent).toBe("create");
  });
});
