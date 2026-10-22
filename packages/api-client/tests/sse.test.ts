import { INITIAL_RUN_STATE, type StudioStreamEvent, applyEvents } from "@studio/contracts";
import { describe, expect, it } from "vitest";

import { ApiError, isApiError } from "../src/api-error";
import { createApiClient } from "../src/client";
import {
  type ChatStreamController,
  type ChatStreamDoneReason,
  RECONNECT_MAX_AUTO_ATTEMPTS,
  RECONNECT_MAX_DELAY_MS,
  RECONNECT_SCHEDULE_MS,
  STREAM_ERROR_CODE,
  type SseMessage,
  StreamEventNormalizer,
  createSseParser,
  streamChat,
} from "../src/sse";
import {
  byteChunkArrays,
  controlledStream,
  jsonErr,
  jsonOk,
  sseLines,
  sseResponse,
} from "./helpers";

const BASE = "https://api.studio.test/v1";

const RUN_ID = "run_test_1";
const CHAT_BODY = {
  message: "Make the headline pop.",
  context: {
    projectSummary: true,
    activeComp: true,
    selection: false,
    playhead: true,
    focusedPanel: true,
    selectedProperties: false,
    currentFrame: false,
    recentCommands: false,
    comments: false,
  },
  idempotencyKey: "idem-chat-0001",
  pinned: [],
};

const PLAN = {
  intent: "animate",
  summary: "Springy scale pop-in on Headline.",
  risk: "low",
  requiresApproval: false,
  affectedLayers: [{ id: 3, name: "Headline", change: "Scale 20% → 110% → 100%" }],
  estimatedCredits: 2,
  steps: [
    {
      title: "Keyframe Scale",
      tool: "studio.set_keyframes",
      args: { layer: "Headline" },
      batch: {
        label: "Agent: headline spring pop-in",
        steps: [{ command: "property.set_keyframes", params: { layerId: "l3" } }],
      },
    },
  ],
};

const RUN_STARTED = { type: "run.started", runId: RUN_ID, seq: 0, model: "studio-smart" };
const RUN_COMPLETED = { type: "run.completed", runId: RUN_ID, seq: 4, versionId: "ver_4" };

// ---------------------------------------------------------------------------
// createSseParser — byte-level framing
// ---------------------------------------------------------------------------

describe("createSseParser", () => {
  it("frames events split across arbitrary byte chunk boundaries", () => {
    const payload = sseLines(
      RUN_STARTED,
      { type: "text-delta", delta: "I’ll animate…" },
      RUN_COMPLETED,
    );
    for (const size of [1, 2, 3, 7, 17, 10_000]) {
      const messages: SseMessage[] = [];
      const parser = createSseParser((m) => messages.push(m));
      for (const chunk of byteChunkArrays(payload, size)) parser.push(chunk);
      parser.end();
      expect(messages.map((m) => m.data)).toEqual([
        JSON.stringify(RUN_STARTED),
        JSON.stringify({ type: "text-delta", delta: "I’ll animate…" }),
        JSON.stringify(RUN_COMPLETED),
      ]);
    }
  });

  it("keeps UTF-8 multi-byte characters intact across chunk splits", () => {
    const text = `data: ${JSON.stringify({ type: "message.delta", delta: "→ 🎬 ü" })}\n\n`;
    const messages: SseMessage[] = [];
    const parser = createSseParser((m) => messages.push(m));
    for (const chunk of byteChunkArrays(text, 1)) parser.push(chunk);
    parser.end();
    expect(JSON.parse(messages[0]?.data ?? "{}")).toEqual({
      type: "message.delta",
      delta: "→ 🎬 ü",
    });
  });

  it("handles a \\r\\n sequence split across two chunks as ONE terminator", () => {
    const messages: SseMessage[] = [];
    const parser = createSseParser((m) => messages.push(m));
    parser.push("data: hel\r");
    expect(messages).toHaveLength(0); // lone trailing \r held back
    parser.push("\n\n");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.data).toBe("hel");
  });

  it("joins multi-line data fields with newlines", () => {
    const messages: SseMessage[] = [];
    const parser = createSseParser((m) => messages.push(m));
    parser.push("data: first\ndata: second\n\n");
    expect(messages[0]?.data).toBe("first\nsecond");
  });

  it("handles CRLF and lone-CR line endings", () => {
    const messages: SseMessage[] = [];
    const parser = createSseParser((m) => messages.push(m));
    parser.push("data: a\r\n\r\n");
    parser.push("data: b\r\r");
    parser.end();
    expect(messages.map((m) => m.data)).toEqual(["a", "b"]);
  });

  it("ignores comments, unknown fields, and parses retry", () => {
    const messages: SseMessage[] = [];
    const parser = createSseParser((m) => messages.push(m));
    parser.push(": ping\nretry: 5000\nunknown: x\ndata: 1\n\n");
    expect(messages).toEqual([{ event: undefined, id: undefined, data: "1", retryMs: 5000 }]);
  });

  it("strips exactly one leading space from field values", () => {
    const messages: SseMessage[] = [];
    const parser = createSseParser((m) => messages.push(m));
    parser.push("data:  two spaces\ndata:no space\n\n");
    expect(messages[0]?.data).toBe(" two spaces\nno space");
  });

  it("tracks the last id at block ends and rejects NUL ids", () => {
    const messages: SseMessage[] = [];
    const parser = createSseParser((m) => messages.push(m));
    parser.push("id: 7\ndata: x\n\n");
    expect(parser.lastEventId).toBe("7");
    parser.push("id: bad\u0000id\ndata: y\n\n");
    expect(parser.lastEventId).toBe("7"); // NUL ids never commit
    parser.push("id: 9\n\n"); // data-less block: id still commits
    expect(parser.lastEventId).toBe("9");
  });

  it("flushes a trailing unterminated block at end() (documented deviation)", () => {
    const messages: SseMessage[] = [];
    const parser = createSseParser((m) => messages.push(m));
    parser.push("data: tail-without-terminator");
    expect(messages).toHaveLength(0);
    parser.end();
    expect(messages.map((m) => m.data)).toEqual(["tail-without-terminator"]);
  });
});

// ---------------------------------------------------------------------------
// StreamEventNormalizer — part mapping + seq model
// ---------------------------------------------------------------------------

describe("StreamEventNormalizer", () => {
  it("passes Studio events through (validated, stripped) with local seqs", () => {
    const n = new StreamEventNormalizer();
    const events = [
      ...n.ingest({ ...RUN_STARTED, unknownExtra: "stripped" }),
      ...n.ingest({ type: "message.delta", runId: RUN_ID, seq: 1, delta: "Hi " }),
      ...n.ingest({ type: "message.delta", runId: RUN_ID, seq: 2, delta: "there" }),
    ];
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(events[0]).toEqual(RUN_STARTED);
    expect(events[0]).not.toHaveProperty("unknownExtra");
    expect(n.lastServerSeq).toBe(2);
    expect(n.runId).toBe(RUN_ID);
  });

  it("drops replayed/duplicate server seqs (Last-Event-ID idempotence)", () => {
    const n = new StreamEventNormalizer();
    const first = [
      ...n.ingest(RUN_STARTED),
      ...n.ingest({ type: "message.delta", runId: RUN_ID, seq: 1, delta: "a" }),
    ];
    // Server replays seq 0-1 after reconnect, then continues.
    const replay = [
      ...n.ingest(RUN_STARTED),
      ...n.ingest({ type: "message.delta", runId: RUN_ID, seq: 1, delta: "a" }),
      ...n.ingest({ type: "message.delta", runId: RUN_ID, seq: 2, delta: "b" }),
    ];
    expect(first).toHaveLength(2);
    expect(replay.map((e) => e.type)).toEqual(["message.delta"]);
    expect((replay[0] as { delta: string }).delta).toBe("b");
    const state = [...first, ...replay].reduce((s, e) => applyEvents(s, e), INITIAL_RUN_STATE);
    expect(state.text).toBe("ab"); // no duplicated "a"
  });

  it("drops events for a foreign runId", () => {
    const n = new StreamEventNormalizer();
    n.ingest(RUN_STARTED);
    expect(n.ingest({ type: "run.started", runId: "run_other", seq: 0, model: "m" })).toEqual([]);
    expect(n.ingest({ type: "message.delta", runId: "run_other", seq: 1, delta: "x" })).toEqual([]);
    expect(n.ignoredCount).toBe(2);
  });

  it("maps AI SDK UI parts to §7.4 events", () => {
    const n = new StreamEventNormalizer();
    n.ingest(RUN_STARTED);
    const events = [
      ...n.ingest({ type: "start", messageId: "m1" }),
      ...n.ingest({ type: "text-delta", id: "m1", delta: "I'll " }),
      ...n.ingest({ type: "text-delta", id: "m1", textDelta: "animate " }), // v4 spelling
      ...n.ingest({
        type: "tool-input-start",
        id: "m1",
        toolCallId: "tc_1",
        toolName: "studio.get_context",
      }),
      ...n.ingest({
        type: "tool-input-delta",
        id: "m1",
        toolCallId: "tc_1",
        inputTextDelta: '{"a":1}',
      }),
      ...n.ingest({ type: "tool-input-end", id: "m1", toolCallId: "tc_1" }),
      ...n.ingest({
        type: "tool-output-available",
        id: "m1",
        toolCallId: "tc_1",
        output: { ok: true },
      }),
      ...n.ingest({ type: "finish", id: "m1" }),
    ];
    expect(events.map((e) => `${e.type}:${e.seq}`)).toEqual([
      "message.delta:1",
      "message.delta:2",
      "tool.started:3",
      "tool.delta:4",
      "tool.result:5",
    ]);
    const tool = events[2] as { name: string; toolCallId: string };
    expect(tool.name).toBe("studio.get_context");
    expect(tool.toolCallId).toBe("tc_1");
    // All AI-derived events carry the run bound from run.started.
    expect(events.every((e) => e.runId === RUN_ID)).toBe(true);
  });

  it("accepts v4 tool-call/tool-result part spellings", () => {
    const n = new StreamEventNormalizer();
    n.ingest(RUN_STARTED);
    const events = [
      ...n.ingest({
        type: "tool-call",
        toolCallId: "tc_9",
        toolName: "studio.plan_edit",
        args: { q: 1 },
      }),
      ...n.ingest({ type: "tool-result", toolCallId: "tc_9", result: { plan: true } }),
    ];
    expect(events.map((e) => e.type)).toEqual(["tool.started", "tool.result"]);
    expect(events[0]).toMatchObject({ args: { q: 1 }, name: "studio.plan_edit" });
  });

  it("unwraps AI SDK data-* parts carrying Studio events", () => {
    const n = new StreamEventNormalizer();
    const events = [
      ...n.ingest({ type: "data-studio", id: "m1", data: RUN_STARTED }),
      ...n.ingest({
        type: "data-studio",
        id: "m1",
        data: { type: "plan", runId: RUN_ID, seq: 3, plan: PLAN },
      }),
      ...n.ingest({ type: "data-other", id: "m1", data: { nope: true } }), // not a §7.4 event
    ];
    expect(events.map((e) => e.type)).toEqual(["run.started", "plan"]);
    expect(events[1]).toMatchObject({ plan: { intent: "animate" } });
    expect(n.ignoredCount).toBe(1);
  });

  it("maps AI SDK error parts to run.failed with the STREAM_ERROR code", () => {
    const n = new StreamEventNormalizer();
    n.ingest(RUN_STARTED);
    const [failed] = n.ingest({ type: "error", id: "m1", errorText: "provider exploded" });
    expect(failed).toMatchObject({
      type: "run.failed",
      code: STREAM_ERROR_CODE,
      message: "provider exploded",
      retryable: true,
      runId: RUN_ID,
    });
  });

  it("drops AI parts that arrive before run.started (counted, not guessed)", () => {
    const n = new StreamEventNormalizer();
    expect(n.ingest({ type: "text-delta", delta: "too early" })).toEqual([]);
    expect(n.ignoredCount).toBe(1);
    n.ingest(RUN_STARTED);
    const [event] = n.ingest({ type: "text-delta", delta: "now" });
    expect(event).toMatchObject({ type: "message.delta", delta: "now" });
  });

  it("ignores junk that is neither an object nor a known part", () => {
    const n = new StreamEventNormalizer();
    n.ingest(RUN_STARTED);
    expect(n.ingest("just a string")).toEqual([]);
    expect(n.ingest(42)).toEqual([]);
    expect(n.ingest({ nope: true })).toEqual([]);
    expect(n.ignoredCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// streamChat — controller integration
// ---------------------------------------------------------------------------

function makeChat(
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
  handlers: {
    onEvent?: (event: StudioStreamEvent) => void;
    onError?: (error: ApiError) => void;
    onReconnect?: (info: { attempt: number; delayMs: number; lastEventId: string | null }) => void;
    onPause?: (info: { attempts: number }) => void;
    onDone?: (summary: { reason: ChatStreamDoneReason }) => void;
  } & {
    reconnect?: { enabled?: boolean; maxAutoAttempts?: number; scheduleMs?: readonly number[] };
  } = {},
  signal?: AbortSignal,
): { controller: ChatStreamController; calls: { input: string; init?: RequestInit }[] } {
  const calls: { input: string; init?: RequestInit }[] = [];
  const wrapped = async (input: string, init?: RequestInit) => {
    calls.push({ input, init });
    return fetchImpl(input, init);
  };
  const { reconnect, ...rest } = handlers;
  const controller = streamChat({
    threadId: "thr_1",
    body: CHAT_BODY,
    baseUrl: BASE,
    fetchImpl: wrapped,
    sleep: async () => {},
    signal,
    reconnect,
    ...rest,
  });
  return { controller, calls };
}

function headerOf(call: { init?: RequestInit } | undefined, name: string): string | null {
  const headers = call?.init?.headers;
  if (headers === undefined) return null;
  return headers instanceof Headers
    ? headers.get(name)
    : ((headers as Record<string, string>)[name] ?? null);
}

describe("streamChat — happy path", () => {
  it("normalizes a mixed AI-SDK + Studio stream, folds the reducer, ends terminal", async () => {
    const events: StudioStreamEvent[] = [];
    const done: string[] = [];
    const stream = sseResponse([
      sseLines(RUN_STARTED),
      'data: {"type":"text-delta","id":"m1","delta":"I\'ll "}\n\n',
      sseLines({
        type: "data-studio",
        data: { type: "message.delta", runId: RUN_ID, seq: 1, delta: "animate " },
      }),
      'data: {"type":"text-delta","id":"m1","delta":"the headline."}\n\n',
      sseLines({ type: "plan", runId: RUN_ID, seq: 2, plan: PLAN }),
      sseLines({
        type: "credits",
        runId: RUN_ID,
        seq: 3,
        reserved: 36,
        committed: 0,
        balance: 2413,
      }),
      sseLines(RUN_COMPLETED),
      "data: [DONE]\n\n",
    ]);
    const { controller } = makeChat(() => Promise.resolve(stream), {
      onEvent: (event) => events.push(event),
      onDone: (summary) => done.push(summary.reason),
    });

    await controller.done;

    expect(done).toEqual(["terminal"]);
    expect(controller.status).toBe("applied");
    expect(controller.text).toBe("I'll animate the headline.");
    expect(controller.versionId).toBe("ver_4");
    expect(controller.runId).toBe(RUN_ID);
    expect(controller.plan?.intent).toBe("animate");
    // The reducer snapshot carries the EMITTED event's seq — the local,
    // strictly-increasing arrival number (the wire seq 3 identifies the
    // server log entry; lastServerSeq below tracks that).
    expect(controller.credits).toEqual({ reserved: 36, committed: 0, balance: 2413, seq: 5 });
    expect(controller.lastServerSeq).toBe(4);
    // Local seqs are strictly increasing (arrival order): all seven payloads
    // normalize to events (run.started, 3 deltas, plan, credits, completed).
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(controller.ignoredParts).toBe(0);
    // The full sequence folds through the contracts reducer from scratch.
    const reduced = events.reduce((s, e) => applyEvents(s, e), INITIAL_RUN_STATE);
    expect(reduced.status).toBe("applied");
    expect(reduced.text).toBe("I'll animate the headline.");
  });

  it("produces byte-identical event sequences for 1/2/3/7-byte chunk splits", async () => {
    const payload = [
      sseLines(RUN_STARTED),
      sseLines({ type: "message.delta", runId: RUN_ID, seq: 1, delta: "chunked" }),
      sseLines(RUN_COMPLETED),
    ].join("");
    for (const size of [1, 2, 3, 7, 5_000]) {
      const events: StudioStreamEvent[] = [];
      const stream = sseResponse(byteChunkArrays(payload, size).map((bytes) => bytes));
      const { controller } = makeChat(() => Promise.resolve(stream), {
        onEvent: (event) => events.push(event),
      });
      await controller.done;
      expect(events.map((e) => e.type)).toEqual(["run.started", "message.delta", "run.completed"]);
      expect(controller.text).toBe("chunked");
    }
  });

  it("survives a JSON payload split across chunk boundaries", async () => {
    const line = `data: ${JSON.stringify(RUN_STARTED)}\n\n`;
    const { controller } = makeChat(() =>
      Promise.resolve(sseResponse(byteChunkArrays(line, 3).map((b) => b))),
    );
    await controller.done;
    expect(controller.runId).toBe(RUN_ID);
    expect(controller.status).toBe("streaming"); // no terminal in this stream…
  });

  it("drives awaiting_approval from approval.required (§8.1)", async () => {
    const stream = sseResponse([
      sseLines(RUN_STARTED),
      sseLines({
        type: "approval.required",
        runId: RUN_ID,
        seq: 2,
        plan: { ...PLAN, requiresApproval: true, risk: "medium" },
      }),
    ]);
    const { controller } = makeChat(() => Promise.resolve(stream));
    await controller.done;
    expect(controller.status).toBe("awaiting_approval");
    expect(controller.plan?.requiresApproval).toBe(true);
  });

  it("assembles tool-call state from tool events", async () => {
    const stream = sseResponse([
      sseLines(RUN_STARTED),
      sseLines({
        type: "tool.started",
        runId: RUN_ID,
        seq: 1,
        toolCallId: "tc_1",
        name: "studio.get_context",
        args: { q: 1 },
      }),
      sseLines({ type: "tool.delta", runId: RUN_ID, seq: 2, toolCallId: "tc_1", delta: '{"a"' }),
      sseLines({
        type: "tool.result",
        runId: RUN_ID,
        seq: 3,
        toolCallId: "tc_1",
        result: { layers: 42 },
      }),
      sseLines({ type: "run.cancelled", runId: RUN_ID, seq: 4 }),
    ]);
    const { controller } = makeChat(() => Promise.resolve(stream));
    await controller.done;
    expect(controller.toolCalls).toHaveLength(1);
    expect(controller.toolCalls[0]).toMatchObject({
      toolCallId: "tc_1",
      name: "studio.get_context",
      status: "done",
      deltaText: '{"a"',
      result: { layers: 42 },
      args: { q: 1 },
    });
    expect(controller.status).toBe("cancelled");
  });

  it("stops reading after the terminal event (late bytes never land)", async () => {
    const controlled = controlledStream();
    const { controller } = makeChat(() => Promise.resolve(controlled.response));
    controlled.enqueue(sseLines(RUN_STARTED));
    controlled.enqueue(sseLines(RUN_COMPLETED));
    await controller.done;
    controlled.enqueue(sseLines({ type: "message.delta", runId: RUN_ID, seq: 9, delta: "late" }));
    expect(controller.text).toBe("");
    expect(controller.status).toBe("applied");
  });

  it("ignores [DONE] and junk payloads but keeps the run", async () => {
    const stream = sseResponse([
      "data: not-json\n\n",
      "data: [DONE]\n\n",
      sseLines(RUN_STARTED),
      "data: 42\n\n",
      sseLines(RUN_COMPLETED),
    ]);
    const { controller } = makeChat(() => Promise.resolve(stream));
    await controller.done;
    expect(controller.status).toBe("applied");
    expect(controller.ignoredParts).toBe(2); // "not-json" + "42"
  });
});

describe("streamChat — request shape", () => {
  it("POSTs the validated body with event-stream Accept + idempotency key", async () => {
    const { controller, calls } = makeChat(() =>
      Promise.resolve(sseResponse([sseLines(RUN_STARTED), sseLines(RUN_COMPLETED)])),
    );
    await controller.done;
    expect(calls[0]?.input).toBe(`${BASE}/threads/thr_1/chat`);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(headerOf(calls[0], "Accept")).toBe("text/event-stream");
    expect(headerOf(calls[0], "Idempotency-Key")).toBe("idem-chat-0001");
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      message: "Make the headline pop.",
      idempotencyKey: "idem-chat-0001",
      pinned: [],
    });
  });

  it("applies CHAT_REQUEST_SCHEMA defaults to the outgoing body", async () => {
    const { controller, calls } = makeChat(() =>
      Promise.resolve(sseResponse([sseLines(RUN_STARTED), sseLines(RUN_COMPLETED)])),
    );
    await controller.done;
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    const context = body.context as Record<string, unknown>;
    expect(context.projectSummary).toBe(true); // §5.1 always-on default
    expect(body.pinned).toEqual([]); // .default([]) applied
  });

  it("throws client-side (status 0) for an invalid chat body", () => {
    expect(() =>
      streamChat({
        threadId: "thr_1",
        body: { message: "hi" },
        baseUrl: BASE,
        fetchImpl: async () => {
          throw new Error("must not be called");
        },
      }),
    ).toThrow(ApiError);
    try {
      streamChat({
        threadId: "thr_1",
        body: {},
        baseUrl: BASE,
        fetchImpl: async () => new Response(null),
      });
    } catch (error) {
      expect(isApiError(error)).toBe(true);
      expect((error as ApiError).code).toBe("VALIDATION_FAILED");
      expect((error as ApiError).status).toBe(0);
    }
  });
});

describe("streamChat — cancel & abort (§8.3, pause-on-abort)", () => {
  it("cancel() POSTs /runs/:id/cancel with an idempotency key and aborts", async () => {
    const controlled = controlledStream();
    const cancelCalls: { input: string; init?: RequestInit }[] = [];
    const { controller, calls } = makeChat(async (input) => {
      if (input === `${BASE}/threads/thr_1/chat`) return Promise.resolve(controlled.response);
      cancelCalls.push({ input, init: undefined });
      return Promise.resolve(
        new Response(JSON.stringify({ data: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    controlled.enqueue(sseLines(RUN_STARTED));
    await controller.cancel("changed my mind");

    expect(controller.runId).toBe(RUN_ID);
    const cancelCall = calls[1];
    expect(cancelCall?.input).toBe(`${BASE}/runs/${RUN_ID}/cancel`);
    expect(headerOf(cancelCall, "Idempotency-Key")).toMatch(/^.{8,}$/);
    expect(JSON.parse(String(cancelCall?.init?.body))).toEqual({ reason: "changed my mind" });
    expect(controller.cancelError).toBeNull();
    await controller.done;
    expect(controller.status).toBe("streaming"); // paused, not failed
  });

  it("keeps a failed cancel POST on cancelError instead of throwing", async () => {
    const controlled = controlledStream();
    const { controller } = makeChat(async (input) => {
      if (input === `${BASE}/threads/thr_1/chat`) return Promise.resolve(controlled.response);
      return Promise.resolve(
        jsonErr(500, { code: "INTERNAL_ERROR", message: "down", retryable: true }),
      );
    });
    controlled.enqueue(sseLines(RUN_STARTED));
    await controller.cancel();
    expect(controller.cancelError).not.toBeNull();
    expect(controller.cancelError?.code).toBe("INTERNAL_ERROR");
    await controller.done;
  });

  it("abort() pauses the run and keeps the assembled state", async () => {
    const controlled = controlledStream();
    const { controller } = makeChat(() => Promise.resolve(controlled.response));
    controlled.enqueue(sseLines(RUN_STARTED));
    controlled.enqueue(sseLines({ type: "message.delta", runId: RUN_ID, seq: 1, delta: "Half " }));
    controller.abort();
    await controller.done;
    expect(controller.text).toBe("Half ");
    expect(controller.status).toBe("streaming");
    expect(controller.fatalError).toBeNull();
  });

  it("honours an external AbortSignal without auto-reconnecting", async () => {
    const controller = new AbortController();
    const controlled = controlledStream();
    const done: string[] = [];
    const { controller: run } = makeChat(
      () => Promise.resolve(controlled.response),
      {
        onDone: (summary) => done.push(summary.reason),
      },
      controller.signal,
    );
    controlled.enqueue(sseLines(RUN_STARTED));
    controller.abort();
    await run.done;
    expect(done).toEqual(["aborted"]);
    expect(run.status).toBe("streaming");
  });
});

describe("streamChat — reconnect (§8.4)", () => {
  it("exposes the documented backoff constants", () => {
    expect(RECONNECT_SCHEDULE_MS).toEqual([1000, 2000, 4000, 8000]);
    expect(RECONNECT_MAX_DELAY_MS).toBe(30_000);
    expect(RECONNECT_MAX_AUTO_ATTEMPTS).toBe(3);
  });

  it("resumes a dropped stream: same key, Last-Event-ID, no duplicated text", async () => {
    const first = controlledStream();
    const replays = [
      sseLines(RUN_STARTED),
      sseLines({ type: "message.delta", runId: RUN_ID, seq: 1, delta: "Hel" }),
    ].join("");
    const resumed = [
      replays, // §7.4: server replays from the run log after Last-Event-ID
      sseLines({ type: "message.delta", runId: RUN_ID, seq: 2, delta: "lo" }),
      sseLines({ type: "run.completed", runId: RUN_ID, seq: 3 }),
    ].join("");
    const responses = [first.response, sseResponse([resumed])];
    const reconnects: { attempt: number; delayMs: number; lastEventId: string | null }[] = [];
    const { controller, calls } = makeChat(
      () => Promise.resolve(responses.shift() ?? new Response(null, { status: 500 })),
      { onReconnect: (info) => reconnects.push(info) },
    );

    first.enqueue(sseLines(RUN_STARTED));
    first.enqueue(sseLines({ type: "message.delta", runId: RUN_ID, seq: 1, delta: "Hel" }));
    // Let the reader consume the buffered events first — ReadableStream
    // error() RESETS the queue, so failing before the bytes were read would
    // discard them and no Last-Event-ID could be computed.
    await new Promise((resolve) => setTimeout(resolve, 0));
    first.fail(new TypeError("network dropped"));

    await controller.done;

    expect(controller.text).toBe("Hello"); // replayed "Hel" deduped by server seq
    expect(controller.status).toBe("applied");
    expect(reconnects).toEqual([{ attempt: 1, delayMs: 1000, lastEventId: "1" }]);
    expect(calls).toHaveLength(2);
    expect(headerOf(calls[1], "Idempotency-Key")).toBe("idem-chat-0001"); // never duplicate a run
    expect(headerOf(calls[1], "Last-Event-ID")).toBe("1"); // highest server seq
  });

  it("retries the initial POST on network errors with the same idempotency key", async () => {
    let calls = 0;
    const { controller } = makeChat(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new TypeError("fetch failed"))
        : Promise.resolve(sseResponse([sseLines(RUN_STARTED), sseLines(RUN_COMPLETED)]));
    });
    await controller.done;
    expect(calls).toBe(2);
    expect(controller.status).toBe("applied");
  });

  it("retries retryable HTTP failures on the chat POST", async () => {
    let calls = 0;
    const errors: ApiError[] = [];
    const { controller } = makeChat(
      () => {
        calls += 1;
        return calls === 1
          ? Promise.resolve(
              jsonErr(429, { code: "RATE_LIMITED", message: "slow", retryable: true }),
            )
          : Promise.resolve(sseResponse([sseLines(RUN_STARTED), sseLines(RUN_COMPLETED)]));
      },
      { onError: (error) => errors.push(error) },
    );
    await controller.done;
    expect(calls).toBe(2);
    expect(errors).toEqual([]);
    expect(controller.status).toBe("applied");
  });

  it("treats a clean close without a terminal event as a dropped stream", async () => {
    const first = sseResponse([
      sseLines(RUN_STARTED),
      sseLines({ type: "message.delta", runId: RUN_ID, seq: 1, delta: "cut" }),
    ]);
    const second = sseResponse([sseLines({ type: "run.completed", runId: RUN_ID, seq: 2 })]);
    const responses = [first, second];
    const { controller, calls } = makeChat(() =>
      Promise.resolve(responses.shift() ?? new Response(null, { status: 500 })),
    );
    await controller.done;
    expect(calls).toHaveLength(2);
    expect(controller.status).toBe("applied");
  });

  it("ends `closed` (no retry) when reconnect is disabled", async () => {
    const done: string[] = [];
    const { controller, calls } = makeChat(
      () =>
        Promise.resolve(
          sseResponse([
            sseLines(RUN_STARTED),
            sseLines({ type: "message.delta", runId: RUN_ID, seq: 1, delta: "done?" }),
          ]),
        ),
      { reconnect: { enabled: false }, onDone: (summary) => done.push(summary.reason) },
    );
    await controller.done;
    expect(done).toEqual(["closed"]);
    expect(calls).toHaveLength(1);
    expect(controller.status).toBe("streaming");
  });

  it("pauses after maxAutoAttempts, then manual reconnect() resumes", async () => {
    let handler = async (): Promise<Response> => {
      throw new TypeError("network down");
    };
    const pauses: { attempts: number }[] = [];
    const { controller } = makeChat((input, init) => handler(), {
      reconnect: { maxAutoAttempts: 2 },
      onPause: (info) => pauses.push(info),
    });

    await controller.done;
    expect(controller.paused).toBe(true);
    expect(pauses).toEqual([{ attempts: 2 }]);
    expect(controller.text).toBe("");

    handler = async () =>
      Promise.resolve(
        sseResponse([
          sseLines(RUN_STARTED),
          sseLines({ type: "message.delta", runId: RUN_ID, seq: 1, delta: "back" }),
          sseLines(RUN_COMPLETED),
        ]),
      );
    await controller.reconnect();
    expect(controller.paused).toBe(false);
    expect(controller.status).toBe("applied");
    expect(controller.text).toBe("back");
    await controller.done;
  });

  it("follows the 1/2/4/8s schedule capped at 30s for later attempts", async () => {
    const delays: number[] = [];
    let failures = 0;
    const { controller } = makeChat(
      () => {
        failures += 1;
        return failures <= 6
          ? Promise.reject(new TypeError("down"))
          : Promise.resolve(sseResponse([sseLines(RUN_STARTED), sseLines(RUN_COMPLETED)]));
      },
      {
        reconnect: { maxAutoAttempts: 6 },
      },
    );
    const sleepSpy = async (ms: number) => {
      delays.push(ms);
    };
    // streamChat was already constructed with the default zero sleep; rebuild
    // with the recording sleep instead:
    const rebuilt = streamChat({
      threadId: "thr_1",
      body: CHAT_BODY,
      baseUrl: BASE,
      fetchImpl: () => {
        return Promise.reject(new TypeError("down"));
      },
      sleep: sleepSpy,
      reconnect: { maxAutoAttempts: 6 },
    });
    await rebuilt.done;
    expect(delays).toEqual([1000, 2000, 4000, 8000, 30_000, 30_000]);
    expect(rebuilt.paused).toBe(true);
    void controller;
    await controller.done;
  });
});

describe("streamChat — failure surfaces", () => {
  it("surfaces non-retryable HTTP errors on fatalError without retrying", async () => {
    let calls = 0;
    const errors: ApiError[] = [];
    const done: string[] = [];
    const { controller } = makeChat(
      () => {
        calls += 1;
        return Promise.resolve(
          jsonErr(401, { code: "UNAUTHORIZED", message: "Sign in to continue.", retryable: false }),
        );
      },
      {
        onError: (error) => errors.push(error),
        onDone: (summary) => done.push(summary.reason),
      },
    );
    await controller.done;
    expect(calls).toBe(1);
    expect(done).toEqual(["error"]);
    expect(controller.fatalError?.code).toBe("UNAUTHORIZED");
    expect(errors[0]?.message).toBe("Sign in to continue.");
    expect(controller.status).toBe("sending");
  });

  it("treats a 200 JSON Err envelope as a failure (§7.3 decides, not the status)", async () => {
    const errors: ApiError[] = [];
    const { controller, calls } = makeChat(
      () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: "INSUFFICIENT_CREDITS",
                message: "out of credits",
                retryable: false,
                requestId: "req_z",
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
      { onError: (error) => errors.push(error) },
    );
    await controller.done;
    expect(controller.fatalError?.code).toBe("INSUFFICIENT_CREDITS");
    expect(controller.fatalError?.status).toBe(200);
    expect(controller.fatalError?.requestId).toBe("req_z");
    expect(calls).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it("retries a 200-with-Ok-envelope (no stream) as a malformed response", async () => {
    const responses = [
      jsonOk({}), // 200 JSON where a stream was expected
      sseResponse([sseLines(RUN_STARTED), sseLines(RUN_COMPLETED)]),
    ];
    const { controller, calls } = makeChat(() =>
      Promise.resolve(responses.shift() ?? new Response(null, { status: 500 })),
    );
    await controller.done;
    expect(calls).toHaveLength(2);
    expect(controller.status).toBe("applied");
  });

  it("tracks raw SSE id: fields and prefers server seqs for Last-Event-ID", async () => {
    const first = controlledStream();
    const resumed = sseResponse([
      "id: opaque-server-token\n",
      sseLines(RUN_STARTED),
      sseLines(RUN_COMPLETED),
    ]);
    const responses = [first.response, resumed];
    const { controller, calls } = makeChat(() =>
      Promise.resolve(responses.shift() ?? new Response(null, { status: 500 })),
    );
    first.enqueue("id: opaque-17\n");
    first.enqueue(sseLines(RUN_STARTED));
    // Same as the resume test above: ReadableStream error() resets the queue —
    // the reader must have consumed the id + run.started before the drop, or
    // there is no cursor to prefer a seq over.
    await new Promise((resolve) => setTimeout(resolve, 0));
    first.fail(new TypeError("dropped"));

    await controller.done;
    expect(controller.lastEventId).not.toBeNull();
    expect(controller.lastServerSeq).toBe(4);
    // The reconnect carries the highest SERVER seq seen so far ("0" from
    // run.started) — the seq wins over the raw opaque `id:` field
    // ("opaque-17"); run.completed's seq 4 only arrives on the resumed stream.
    expect(headerOf(calls[1], "Last-Event-ID")).toBe("0");
  });
});

describe("client.chat.stream delegation", () => {
  it("wires the client's baseUrl/fetch/key factory into streamChat", async () => {
    const stream = sseResponse([sseLines(RUN_STARTED), sseLines(RUN_COMPLETED)]);
    const calls: { input: string; init?: RequestInit }[] = [];
    const client = createApiClient({
      baseUrl: BASE,
      fetch: async (input, init) => {
        calls.push({ input, init });
        return stream;
      },
    });
    const controller = client.chat.stream("thr_9", CHAT_BODY);
    await controller.done;
    expect(calls[0]?.input).toBe(`${BASE}/threads/thr_9/chat`);
    expect(controller.status).toBe("applied");
  });
});
