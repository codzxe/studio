/**
 * streamTurn — the round-12 turn transport (TURN WIRE CONTRACT) against a
 * scripted fetch: header pin (`Idempotency-Key: ${runId}:${stepIndex}`),
 * bounded same-key re-POSTs (3 attempts, 1s/2s backoff, then TURN_PAUSED),
 * the single retry for a retryable turn.failed, abort semantics, the
 * seqBase/replayCursor resume fold and the client surface
 * (`chat.turn` / `runs.submitPlan` / `runs.abandon`).
 */

import type { EditPlan, StudioStreamEvent, TurnToolCall } from "@studio/contracts";
import { describe, expect, it } from "vitest";

import { type ApiError, isApiError } from "../src/api-error";
import type { RunPlanResponse } from "../src/response-schemas";
import { isValidTurnCanvas, mergeTurnProposals, writeToolCarrierPlan } from "../src/chat-tools";
import { createApiClient } from "../src/client";
import {
  TURN_FAILED_MAX_RETRIES,
  TURN_MAX_ATTEMPTS,
  TURN_PAUSED_ERROR_CODE,
  TURN_RETRY_SCHEDULE_MS,
  type TurnStreamHandle,
  streamTurn,
} from "../src/sse";
import { controlledStream, fetchRecorder, jsonErr, sseLines, sseResponse } from "./helpers";

const BASE = "https://api.studio.test/v1";
const RUN_ID = "run_turn_1";
const THREAD_ID = "thr_turn";

const turnBody = (stepIndex: number, messages: unknown[]) => ({
  runId: RUN_ID,
  stepIndex,
  messages,
});

const USER_PART = { role: "user", text: "Make the headline pop." };

/** One turn's server events (per-run seq space starts at 0 per POST). */
const turnEvents = (step: number, extra: StudioStreamEvent[] = []): string =>
  sseLines(
    { type: "run.started", runId: RUN_ID, seq: 0, model: "studio-fast" },
    { type: "turn.started", runId: RUN_ID, seq: 1, stepIndex: step },
    { type: "message.delta", runId: RUN_ID, seq: 2, delta: "Working." },
    ...extra,
  );

const TURN_COMPLETED: StudioStreamEvent = {
  type: "turn.completed",
  runId: RUN_ID,
  seq: 3,
  stepIndex: 0,
  finishReason: "stop",
  usage: { inputTokens: 10, outputTokens: 5 },
  credits: { committed: 1 },
  assistantText: "Working.",
  toolCalls: [],
};

const TURN_FAILED_RETRYABLE: StudioStreamEvent = {
  type: "turn.failed",
  runId: RUN_ID,
  seq: 3,
  stepIndex: 0,
  code: "RUN_MODEL_UNAVAILABLE",
  message: "The model service is unavailable right now.",
  retryable: true,
  credits: { committed: 0 },
};

const TURN_FAILED_PERMANENT: StudioStreamEvent = {
  type: "turn.failed",
  runId: RUN_ID,
  seq: 3,
  stepIndex: 0,
  code: "RUN_INVALID_TOOL",
  message: "The tool call could not be repaired.",
  retryable: false,
  credits: { committed: 0 },
};

const zeroSleep = (): Promise<void> => Promise.resolve();

interface TurnRecording {
  readonly handle: TurnStreamHandle;
  readonly events: StudioStreamEvent[];
  readonly errors: ApiError[];
  readonly reconnects: Array<{ attempt: number; delayMs: number }>;
  readonly dones: string[];
}

/** streamTurn with recording handlers + zero-delay backoff. */
function runTurn(
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
  body: unknown,
  options: { seqBase?: number; replayCursor?: number } = {},
): TurnRecording {
  const events: StudioStreamEvent[] = [];
  const errors: ApiError[] = [];
  const reconnects: Array<{ attempt: number; delayMs: number }> = [];
  const dones: string[] = [];
  const handle = streamTurn({
    threadId: THREAD_ID,
    body,
    baseUrl: BASE,
    fetchImpl: fetch,
    reconnect: { sleep: zeroSleep },
    seqBase: options.seqBase,
    replayCursor: options.replayCursor,
    onEvent: (event) => events.push(event),
    onError: (error) => errors.push(error),
    onReconnect: (info) => reconnects.push(info),
    onDone: (summary) => dones.push(summary.reason),
  });
  return { handle, events, errors, reconnects, dones };
}

const idemKeyOf = (init: RequestInit | undefined): string =>
  new Headers(init?.headers).get("idempotency-key") ?? "";

// ---------------------------------------------------------------------------
// The wire contract
// ---------------------------------------------------------------------------

describe("streamTurn — wire contract", () => {
  it("POSTs the turn with the exact `${runId}:${stepIndex}` idempotency header", async () => {
    const recorder = fetchRecorder(() =>
      Promise.resolve(sseResponse([turnEvents(0, [TURN_COMPLETED])])),
    );
    const recording = runTurn(recorder.fetch, turnBody(0, [USER_PART]));
    const summary = await recording.handle.done;

    expect(summary.reason).toBe("terminal");
    expect(recorder.calls.length).toBe(1);
    expect(recorder.calls[0]?.input).toBe(`${BASE}/threads/${THREAD_ID}/turn`);
    expect(idemKeyOf(recorder.calls[0]?.init)).toBe(`${RUN_ID}:0`);
    const sent = JSON.parse(String(recorder.calls[0]?.init?.body)) as Record<string, unknown>;
    expect(sent.runId).toBe(RUN_ID);
    expect(sent.stepIndex).toBe(0);
  });

  it("emits run-scoped local seqs continuing at seqBase (per-turn server seqs are rewritten)", async () => {
    const recorder = fetchRecorder(() =>
      Promise.resolve(sseResponse([turnEvents(0, [TURN_COMPLETED])])),
    );
    const recording = runTurn(recorder.fetch, turnBody(0, [USER_PART]), { seqBase: 41 });
    await recording.handle.done;

    expect(recording.events.map((event) => event.seq)).toEqual([41, 42, 43, 44]);
    expect(recording.errors).toEqual([]);
  });

  it("throws synchronously on a body that fails TURN_REQUEST_SCHEMA", () => {
    const recorder = fetchRecorder(() => Promise.resolve(sseResponse([turnEvents(0)])));
    let thrown: unknown = null;
    try {
      streamTurn({
        threadId: THREAD_ID,
        body: { runId: RUN_ID, stepIndex: 0, messages: [] }, // min(1) violated
        baseUrl: BASE,
        fetchImpl: recorder.fetch,
      });
    } catch (error) {
      thrown = error;
    }
    expect(isApiError(thrown)).toBe(true);
    expect((thrown as ApiError).code).toBe("VALIDATION_FAILED");
    expect(recorder.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Bounded same-key recovery
// ---------------------------------------------------------------------------

describe("streamTurn — transport drop recovery (bounded)", () => {
  it("a mid-turn drop re-POSTs the SAME key and never re-emits already-seen frames", async () => {
    const dropped = controlledStream();
    let calls = 0;
    const recorder = fetchRecorder(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve(dropped.response);
      // Replay path: the server re-sends the whole turn (seqs 0..) then the rest.
      return Promise.resolve(sseResponse([turnEvents(0, [TURN_COMPLETED])]));
    });
    const recording = runTurn(recorder.fetch, turnBody(0, [USER_PART]));
    // Half the frames, then the connection dies (let the pump read them first).
    dropped.enqueue(sseLines({ type: "run.started", runId: RUN_ID, seq: 0, model: "studio-fast" }));
    dropped.enqueue(
      sseLines(
        { type: "turn.started", runId: RUN_ID, seq: 1, stepIndex: 0 },
        { type: "message.delta", runId: RUN_ID, seq: 2, delta: "Work" },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    dropped.fail(new TypeError("fetch failed"));

    const summary = await recording.handle.done;
    expect(summary.reason).toBe("terminal");
    expect(recorder.calls.length).toBe(2);
    expect(idemKeyOf(recorder.calls[0]?.init)).toBe(idemKeyOf(recorder.calls[1]?.init));
    expect(recording.reconnects).toEqual([{ attempt: 2, delayMs: TURN_RETRY_SCHEDULE_MS[0] }]);
    // The delta folded ONCE (attempt 1's "Work"); the replay's seq-2 frame
    // was dropped — the CONTROLLER's assistantText reconcile completes the
    // text from turn.completed (run-state owns that), never a double delta.
    const deltas = recording.events.filter((event) => event.type === "message.delta");
    expect(deltas.map((event) => (event as { delta: string }).delta)).toEqual(["Work"]);
    expect(recording.errors).toEqual([]);
  });

  it("3 failed attempts park with TURN_PAUSED (never a second run)", async () => {
    const recorder = fetchRecorder(() => Promise.reject(new TypeError("fetch failed")));
    const recording = runTurn(recorder.fetch, turnBody(0, [USER_PART]));

    const summary = await recording.handle.done;
    expect(summary.reason).toBe("paused");
    expect(recorder.calls.length).toBe(TURN_MAX_ATTEMPTS);
    const keys = recorder.calls.map((call) => idemKeyOf(call.init));
    expect(new Set(keys).size).toBe(1); // same key every attempt
    expect(recording.reconnects.map((entry) => entry.delayMs)).toEqual([1000, 2000]);
    expect(recording.errors).toHaveLength(1);
    expect(recording.errors[0]?.code).toBe(TURN_PAUSED_ERROR_CODE);
    expect(recording.handle.paused).toBe(true);
    expect(recording.handle.lastServerSeq).toBe(-1);
  });

  it("a 200 JSON Err envelope where SSE was promised is a retryable drop", async () => {
    let calls = 0;
    const recorder = fetchRecorder(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(
          jsonErr(200, { code: "RUN_MODEL_UNAVAILABLE", message: "m", retryable: true }),
        );
      }
      return Promise.resolve(sseResponse([turnEvents(0, [TURN_COMPLETED])]));
    });
    const recording = runTurn(recorder.fetch, turnBody(0, [USER_PART]));
    const summary = await recording.handle.done;
    expect(summary.reason).toBe("terminal");
    expect(recorder.calls.length).toBe(2);
  });

  it("a non-retryable HTTP error surfaces immediately (no re-POST)", async () => {
    const recorder = fetchRecorder(() =>
      Promise.resolve(jsonErr(402, { code: "INSUFFICIENT_CREDITS", message: "out of credits" })),
    );
    const recording = runTurn(recorder.fetch, turnBody(0, [USER_PART]));
    const summary = await recording.handle.done;
    expect(summary.reason).toBe("error");
    expect(recorder.calls.length).toBe(1);
    expect(recording.errors[0]?.code).toBe("INSUFFICIENT_CREDITS");
  });
});

describe("streamTurn — turn.failed policy", () => {
  it("a retryable turn.failed retries ONCE with the same key, then surfaces its code", async () => {
    let calls = 0;
    const recorder = fetchRecorder(() => {
      calls += 1;
      // Both attempts fail retryably — the single retry then surfaces.
      return Promise.resolve(sseResponse([turnEvents(0, [TURN_FAILED_RETRYABLE])]));
    });
    const recording = runTurn(recorder.fetch, turnBody(0, [USER_PART]));
    const summary = await recording.handle.done;

    expect(summary.reason).toBe("error");
    expect(calls).toBe(1 + TURN_FAILED_MAX_RETRIES);
    const keys = recorder.calls.map((call) => idemKeyOf(call.init));
    expect(new Set(keys).size).toBe(1);
    expect(recording.errors).toHaveLength(1);
    expect(recording.errors[0]?.code).toBe("RUN_MODEL_UNAVAILABLE");
    expect(recording.errors[0]?.retryable).toBe(true);
  });

  it("a retryable turn.failed that heals on the retry folds the failure silently", async () => {
    let calls = 0;
    const recorder = fetchRecorder(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(sseResponse([turnEvents(0, [TURN_FAILED_RETRYABLE])]));
      }
      return Promise.resolve(sseResponse([turnEvents(0, [TURN_COMPLETED])]));
    });
    const recording = runTurn(recorder.fetch, turnBody(0, [USER_PART]));
    const summary = await recording.handle.done;

    expect(summary.reason).toBe("terminal");
    expect(calls).toBe(2);
    expect(recording.errors).toEqual([]); // the transient failure never surfaced
    // The retried attempt's replayed seqs 0..3 were dropped; nothing doubled.
    const deltas = recording.events.filter((event) => event.type === "message.delta");
    expect(deltas).toHaveLength(1);
  });

  it("a permanent turn.failed surfaces immediately", async () => {
    const recorder = fetchRecorder(() =>
      Promise.resolve(sseResponse([turnEvents(0, [TURN_FAILED_PERMANENT])])),
    );
    const recording = runTurn(recorder.fetch, turnBody(0, [USER_PART]));
    const summary = await recording.handle.done;
    expect(summary.reason).toBe("error");
    expect(recorder.calls.length).toBe(1);
    expect(recording.errors[0]?.code).toBe("RUN_INVALID_TOOL");
  });
});

// ---------------------------------------------------------------------------
// Abort + resume
// ---------------------------------------------------------------------------

describe("streamTurn — abort + resume cursors", () => {
  it("abort() settles `aborted` and never re-POSTs", async () => {
    const live = controlledStream();
    const recorder = fetchRecorder(() => Promise.resolve(live.response));
    const recording = runTurn(recorder.fetch, turnBody(0, [USER_PART]));
    live.enqueue(sseLines({ type: "run.started", runId: RUN_ID, seq: 0, model: "studio-fast" }));
    recording.handle.abort();
    const summary = await recording.handle.done;

    expect(summary.reason).toBe("aborted");
    expect(recorder.calls.length).toBe(1);
  });

  it("a resumed call (replayCursor) drops frames it already emitted and continues local seqs", async () => {
    const recorder = fetchRecorder(() =>
      // The paused attempt got through server seq 2 before dying; the resume
      // replays the whole turn + the terminal.
      Promise.resolve(sseResponse([turnEvents(0, [TURN_COMPLETED])])),
    );
    const recording = runTurn(recorder.fetch, turnBody(0, [USER_PART]), {
      seqBase: 7,
      replayCursor: 2,
    });
    const summary = await recording.handle.done;

    expect(summary.reason).toBe("terminal");
    // seqs 0..2 dropped; the terminal continued at the run's next local seq.
    expect(recording.events.map((event) => `${event.type}:${event.seq}`)).toEqual([
      "turn.completed:7",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Proposal merging (chat-tools) — carrier reconstruction + merge parity
// ---------------------------------------------------------------------------

describe("chat-tools — turn proposal merging", () => {
  const compiled: NonNullable<TurnToolCall["proposal"]> = {
    compiled: {
      batch: {
        label: 'Agent: Add text layer "Hi"',
        atomic: true,
        steps: [{ command: "layer.newText", params: { text: "Hi" } }],
      },
      risk: "low",
      estimatedCredits: 1.5,
      resolutionRequests: [],
    },
  };

  const writeCall: TurnToolCall = {
    toolCallId: "call_1",
    tool: "studio.create_text",
    args: { text: "Hi", name: "Headline" },
    resultForModel: {
      proposedBatch: {
        label: 'Agent: Add text "Hi"',
        steps: [{ command: "create_text", params: { text: "Hi" } }],
      },
      note: "Proposed — nothing is executed until the plan is applied.",
    },
    proposal: compiled,
  };

  it("writeToolCarrierPlan rebuilds the one-step carrier (summary off the label, server risk)", () => {
    const carrier = writeToolCarrierPlan(writeCall);
    expect(carrier).not.toBeNull();
    expect(carrier?.intent).toBe("create");
    expect(carrier?.summary).toBe('Add text "Hi"');
    expect(carrier?.risk).toBe("low");
    expect(carrier?.steps[0]?.tool).toBe("studio.create_text");
    expect(carrier?.steps[0]?.batch.label).toBe('Agent: Add text "Hi"');
  });

  it("null for reads, failures and proposal-less calls (only successful write carriers merge)", () => {
    expect(writeToolCarrierPlan({ ...writeCall, tool: "studio.get_context" })).toBeNull();
    expect(
      writeToolCarrierPlan({
        ...writeCall,
        resultForModel: { error: "PLAN_INVALID", message: "bad" },
      }),
    ).toBeNull();
    expect(writeToolCarrierPlan({ ...writeCall, proposal: null })).toBeNull();
  });

  it("mergeTurnProposals merges into ONE plan and returns null for undo_run-only runs", () => {
    const merged = mergeTurnProposals([writeCall]);
    expect(merged?.steps).toHaveLength(1);
    expect(merged?.intent).toBe("create");

    const undoCall = {
      ...writeCall,
      tool: "studio.undo_run",
      resultForModel: {
        proposedBatch: {
          label: "Agent: Undo the most recent applied agent run",
          steps: [{ command: "undo_run", params: {} }],
        },
        note: "n",
      },
    };
    expect(mergeTurnProposals([undoCall])).toBeNull();
  });

  it("isValidTurnCanvas gates the canvas snapshot shape", () => {
    expect(
      isValidTurnCanvas({
        activeComp: "Main",
        layers: [{ id: 1, name: "Headline", type: "text" }],
        selection: [1],
        playhead: 0,
        fps: 30,
        duration: 4,
      }),
    ).toBe(true);
    expect(isValidTurnCanvas({ selection: [] })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The ApiClient surface
// ---------------------------------------------------------------------------

describe("client — chat.turn / runs.submitPlan / runs.abandon", () => {
  const client = (fetchImpl: (input: string, init?: RequestInit) => Promise<Response>) =>
    createApiClient({ baseUrl: BASE, fetch: fetchImpl, sleep: zeroSleep });

  it("chat.turn delegates to the transport (same URL + key)", async () => {
    const recorder = fetchRecorder(() =>
      Promise.resolve(sseResponse([turnEvents(0, [TURN_COMPLETED])])),
    );
    const api = client(recorder.fetch);
    const events: StudioStreamEvent[] = [];
    const handle = api.chat.turn(THREAD_ID, turnBody(0, [USER_PART]), {
      onEvent: (event) => events.push(event),
    });
    const summary = await handle.done;
    expect(summary.reason).toBe("terminal");
    expect(recorder.calls[0]?.input).toBe(`${BASE}/threads/${THREAD_ID}/turn`);
    expect(idemKeyOf(recorder.calls[0]?.init)).toBe(`${RUN_ID}:0`);
    expect(events.length).toBeGreaterThan(0);
  });

  it("runs.submitPlan parses the RAW payload and sends the stable per-run key", async () => {
    const wirePlan: EditPlan = {
      intent: "create",
      summary: "s",
      risk: "low",
      requiresApproval: false,
      affectedLayers: [],
      estimatedCredits: 1,
      steps: [
        {
          title: "t",
          tool: "studio.create_text",
          args: { text: "Hi" },
          batch: { label: "b", steps: [{ command: "create_text", params: {} }] },
        },
      ],
    };
    const recorder = fetchRecorder(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            runId: RUN_ID,
            plan: wirePlan,
            autoApply: { mode: "auto", reason: "eligible" },
            compiledBatch: {
              label: "b",
              atomic: true,
              steps: [{ command: "layer.newText", params: {} }],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const api = client(recorder.fetch);
    // A plan-bearing submit always answers the RunPlanResponse arm — narrow
    // past the {end:true} end-marker union member (12-w7).
    const decision = (await api.runs.submitPlan(RUN_ID, { plan: wirePlan })) as RunPlanResponse;
    expect(decision.autoApply.mode).toBe("auto");
    expect(decision.compiledBatch?.steps).toHaveLength(1);
    expect(recorder.calls[0]?.input).toBe(`${BASE}/runs/${RUN_ID}/plan`);
    expect(idemKeyOf(recorder.calls[0]?.init)).toBe(`plan:${RUN_ID}`);
  });

  it("runs.submitPlan accepts the §7.3 Ok envelope too (both shapes are legal)", async () => {
    const wirePlan: EditPlan = {
      intent: "create",
      summary: "s",
      risk: "low",
      requiresApproval: false,
      affectedLayers: [],
      estimatedCredits: 1,
      steps: [
        {
          title: "t",
          tool: "studio.create_text",
          args: {},
          batch: { label: "b", steps: [{ command: "create_text", params: {} }] },
        },
      ],
    };
    const recorder = fetchRecorder(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              runId: RUN_ID,
              plan: wirePlan,
              autoApply: { mode: "propose", reason: "risk-too-high" },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const api = client(recorder.fetch);
    const decision = (await api.runs.submitPlan(RUN_ID, { plan: wirePlan })) as RunPlanResponse;
    expect(decision.autoApply.mode).toBe("propose");
  });

  it("runs.abandon POSTs with the stable per-run key and never throws its payload", async () => {
    const recorder = fetchRecorder(() =>
      Promise.resolve(
        new Response(JSON.stringify({ runId: RUN_ID, status: "abandoned" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const api = client(recorder.fetch);
    await expect(api.runs.abandon(RUN_ID)).resolves.toBeNull();
    expect(recorder.calls[0]?.input).toBe(`${BASE}/runs/${RUN_ID}/abandon`);
    expect(idemKeyOf(recorder.calls[0]?.init)).toBe(`abandon:${RUN_ID}`);
  });
});
