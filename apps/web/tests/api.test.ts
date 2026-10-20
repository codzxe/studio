/**
 * Pure-logic tests for the gateway client (W1-K): SSE parser, stream reader,
 * error-envelope unwrapping and the run-events resume/dedupe loop (§13.2).
 * No network — fetch is faked with queued Responses; deterministic, <5 s.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ApiError,
  SseParser,
  createGatewayClient,
  isApiError,
  readSseStream,
  type FetchLike,
  type RunEventType,
  type SseMessage,
} from "../src/lib/api";

const BASE_URL = "http://gateway.test/v1";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RecordedCall {
  readonly input: string;
  readonly init?: RequestInit;
}

/** Queue one Response per expected fetch call; records every call made. */
function queuedFetch(responses: readonly Response[]): {
  fetch: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  const doFetch: FetchLike = async (input, init) => {
    calls.push({ input, init });
    const next = queue.shift();
    if (next === undefined) {
      throw new Error("test: unexpected extra fetch call");
    }
    return next;
  };
  return { fetch: doFetch, calls };
}

function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** One §13.2 run event rendered as an SSE block (id line optional). */
function runEventBlock(
  seq: number,
  type: RunEventType,
  options?: { readonly withId?: boolean },
): string {
  const data = JSON.stringify({
    seq,
    run_id: "run_018f",
    at: "2026-07-04T12:00:00.000Z",
    type,
    payload: { note: seq },
  });
  const idLine = options?.withId === false ? "" : `id: ${seq}\n`;
  return `event: ${type}\n${idLine}data: ${data}\n\n`;
}

async function collectMessages(chunks: readonly string[]): Promise<SseMessage[]> {
  const messages: SseMessage[] = [];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  for await (const message of readSseStream(stream)) {
    messages.push(message);
  }
  return messages;
}

// ---------------------------------------------------------------------------
// SseParser (WHATWG text/event-stream semantics)
// ---------------------------------------------------------------------------

interface ParserCase {
  readonly name: string;
  readonly pushes: readonly string[];
  readonly afterPush: readonly SseMessage[];
  readonly afterFlush: readonly SseMessage[];
}

const msg = (event: string, data: string, id: string | null): SseMessage => ({
  event,
  data,
  id,
});

const parserCases: readonly ParserCase[] = [
  {
    name: "single complete message",
    pushes: ["event: run.plan\ndata: {}\n\n"],
    afterPush: [msg("run.plan", "{}", null)],
    afterFlush: [],
  },
  {
    name: "event split across chunk boundaries",
    pushes: ["event: run.sta", "rted\ndata: 42\n\n"],
    afterPush: [msg("run.started", "42", null)],
    afterFlush: [],
  },
  {
    name: "CRLF line endings",
    pushes: ["event: run.queued\r\ndata: 1\r\n\r\n"],
    afterPush: [msg("run.queued", "1", null)],
    afterFlush: [],
  },
  {
    name: "dangling CR at buffer end waits for more input",
    pushes: ["data: a\r", "\n"],
    afterPush: [],
    afterFlush: [msg("message", "a", null)],
  },
  {
    name: "multi-line data joins with newline",
    pushes: ["data: alpha\ndata: beta\n\n"],
    afterPush: [msg("message", "alpha\nbeta", null)],
    afterFlush: [],
  },
  {
    name: "comment / heartbeat lines are ignored",
    pushes: [": heartbeat\n\n", ": ping\ndata: x\n\n"],
    afterPush: [msg("message", "x", null)],
    afterFlush: [],
  },
  {
    name: "id applies to its own block, but persists as lastEventId",
    pushes: ["id: 7\ndata: first\n\ndata: second\n\n"],
    afterPush: [msg("message", "first", "7"), msg("message", "second", null)],
    afterFlush: [],
  },
  {
    name: "field line without colon parses as empty value",
    pushes: ["event\ndata: x\n\n"],
    afterPush: [msg("message", "x", null)],
    afterFlush: [],
  },
  {
    name: "exactly one leading space after the colon is stripped",
    pushes: ["data: one space\n\ndata:no space\n\n"],
    afterPush: [msg("message", "one space", null), msg("message", "no space", null)],
    afterFlush: [],
  },
  {
    name: "blank line without data dispatches nothing",
    pushes: ["event: run.plan\n\n"],
    afterPush: [],
    afterFlush: [],
  },
  {
    name: "flush dispatches an unterminated tail block",
    pushes: ["data: tail"],
    afterPush: [],
    afterFlush: [msg("message", "tail", null)],
  },
  {
    name: "ids containing NUL are ignored per spec",
    pushes: ["id: bad\u0000id\ndata: x\n\n"],
    afterPush: [msg("message", "x", null)],
    afterFlush: [],
  },
];

describe("SseParser", () => {
  for (const testCase of parserCases) {
    it(testCase.name, () => {
      const parser = new SseParser();
      const got: SseMessage[] = [];
      for (const push of testCase.pushes) {
        got.push(...parser.push(push));
      }
      expect(got).toEqual(testCase.afterPush);
      expect(parser.flush()).toEqual(testCase.afterFlush);
    });
  }

  it("lastEventId survives dispatches for Last-Event-ID resume (§13.2)", () => {
    const parser = new SseParser();
    parser.push("id: 41\ndata: a\n\n");
    parser.push("data: b\n\n");
    expect(parser.lastEventId).toBe("41");
  });
});

describe("readSseStream", () => {
  it("reassembles messages split across stream chunks", async () => {
    const messages = await collectMessages([
      "event: run.plan\n",
      "data: ",
      JSON.stringify({ seq: 1 }),
      "\n\n",
    ]);
    expect(messages).toEqual([msg("run.plan", JSON.stringify({ seq: 1 }), null)]);
  });

  it("decodes multibyte UTF-8 split across chunks", async () => {
    const messages = await collectMessages(["data: ", "Caf", "é", " au Lait\n\n"]);
    expect(messages).toEqual([msg("message", "Café au Lait", null)]);
  });

  it("yields nothing for a comment-only keep-alive stream", async () => {
    const messages = await collectMessages([": ping\n\n", ": ping\n\n"]);
    expect(messages).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Error-envelope unwrapping (flat W1-H shape + nested §13.3 shape)
// ---------------------------------------------------------------------------

const documentSchema = z.object({ id: z.string(), name: z.string() });

describe("createGatewayClient error envelopes", () => {
  it("unwraps the flat { ok:false, code, message, hint } envelope into ApiError", async () => {
    const { fetch } = queuedFetch([
      jsonResponse(409, {
        ok: false,
        code: "conflict",
        message: "Already running.",
        hint: "Wait for the current run to finish.",
        retryable: true,
      }),
    ]);
    const client = createGatewayClient({ baseUrl: BASE_URL, fetch });
    const failure = client.post("/documents/doc_1/runs", { body: { prompt: "x" } });
    await expect(failure).rejects.toThrowError(ApiError);
    const error = await failure.catch((caught: unknown) => caught);
    expect(isApiError(error)).toBe(true);
    if (isApiError(error)) {
      expect(error.code).toBe("conflict");
      expect(error.status).toBe(409);
      expect(error.message).toBe("Already running.");
      expect(error.hint).toBe("Wait for the current run to finish.");
      expect(error.retryable).toBe(true);
    }
  });

  it("also unwraps the nested §13.3 { error: { … } } shape", async () => {
    const { fetch } = queuedFetch([
      jsonResponse(401, {
        error: { code: "unauthorized", message: "Session expired." },
      }),
    ]);
    const client = createGatewayClient({ baseUrl: BASE_URL, fetch });
    const error = await client
      .get("/me")
      .catch((caught: unknown) => (isApiError(caught) ? caught : null));
    expect(error).not.toBeNull();
    expect(error?.code).toBe("unauthorized");
    expect(error?.status).toBe(401);
    expect(error?.retryable).toBe(false);
  });

  it("collapses non-JSON bodies into a generic error (never leaks internals)", async () => {
    const { fetch } = queuedFetch([new Response("upstream exploded", { status: 500 })]);
    const client = createGatewayClient({ baseUrl: BASE_URL, fetch });
    const error = await client
      .get("/templates")
      .catch((caught: unknown) => (isApiError(caught) ? caught : null));
    expect(error).not.toBeNull();
    expect(error?.code).toBe("unexpected_response");
    expect(error?.message).toBe("The server returned an unexpected response.");
    expect(error?.retryable).toBe(true);
  });

  it("maps a network failure onto a retryable network_error", async () => {
    const failing: FetchLike = async () => {
      throw new TypeError("connect ECONNREFUSED");
    };
    const client = createGatewayClient({ baseUrl: BASE_URL, fetch: failing });
    const error = await client
      .get("/health")
      .catch((caught: unknown) => (isApiError(caught) ? caught : null));
    expect(error).not.toBeNull();
    expect(error?.code).toBe("network_error");
    expect(error?.status).toBe(0);
    expect(error?.retryable).toBe(true);
  });
});

describe("createGatewayClient request behavior", () => {
  it("validates a successful body against the provided zod schema", async () => {
    const { fetch } = queuedFetch([
      jsonResponse(200, { id: "doc_1", name: "Flyer" }),
    ]);
    const client = createGatewayClient({ baseUrl: BASE_URL, fetch });
    const document = await client.get("/documents/doc_1", {
      schema: documentSchema,
    });
    expect(document).toEqual({ id: "doc_1", name: "Flyer" });
  });

  it("throws a ZodError on successful-but-drifted payloads (contract drift)", async () => {
    const { fetch } = queuedFetch([jsonResponse(200, { id: 7 })]);
    const client = createGatewayClient({ baseUrl: BASE_URL, fetch });
    await expect(
      client.get("/documents/doc_1", { schema: documentSchema }),
    ).rejects.toThrowError(z.ZodError);
  });

  it("resolves undefined for an empty 200 body (e.g. sign-out)", async () => {
    const { fetch } = queuedFetch([new Response("", { status: 200 })]);
    const client = createGatewayClient({ baseUrl: BASE_URL, fetch });
    expect(await client.post("/auth/sign-out")).toBeUndefined();
  });

  it("auto-generates an Idempotency-Key for mutating calls (§13)", async () => {
    const { fetch, calls } = queuedFetch([
      jsonResponse(201, { run_id: "run_1", credits_reserved: 2 }),
    ]);
    const client = createGatewayClient({ baseUrl: BASE_URL, fetch });
    await client.post("/documents/doc_1/runs", { body: { prompt: "a flyer" } });
    expect(calls.length).toBe(1);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("reuses a caller-provided Idempotency-Key", async () => {
    const { fetch, calls } = queuedFetch([
      jsonResponse(201, { run_id: "run_1", credits_reserved: 2 }),
    ]);
    const client = createGatewayClient({ baseUrl: BASE_URL, fetch });
    await client.post("/documents/doc_1/runs", {
      body: { prompt: "a flyer" },
      idempotencyKey: "key-123",
    });
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("key-123");
  });

  it("does not attach an Idempotency-Key to GET requests", async () => {
    const { fetch, calls } = queuedFetch([jsonResponse(200, [])]);
    const client = createGatewayClient({ baseUrl: BASE_URL, fetch });
    await client.get("/templates");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeUndefined();
  });

  it("strips a trailing slash from the base URL", async () => {
    const { fetch, calls } = queuedFetch([jsonResponse(200, [])]);
    const client = createGatewayClient({ baseUrl: `${BASE_URL}/`, fetch });
    await client.get("/templates");
    expect(calls[0]?.input).toBe(`${BASE_URL}/templates`);
  });
});

// ---------------------------------------------------------------------------
// RunEventStream — terminal stops, Last-Event-ID resume, seq dedupe (§13.2)
// ---------------------------------------------------------------------------

describe("RunEventStream", () => {
  it("delivers events in order and stops after a terminal event", async () => {
    const { fetch, calls } = queuedFetch([
      sseResponse([
        ": connected\n\n", // heartbeat comment must be skipped
        "data: not-json\n\n", // malformed block must be skipped
        runEventBlock(1, "run.queued"),
        runEventBlock(2, "run.plan"),
        runEventBlock(3, "run.succeeded"),
      ]),
    ]);
    const client = createGatewayClient({ baseUrl: BASE_URL, fetch });
    const events: number[] = [];
    await client
      .streamRunEvents({
        runId: "run_018f",
        onEvent: (event) => events.push(event.seq),
      })
      .consume();
    expect(events).toEqual([1, 2, 3]);
    expect(calls.length).toBe(1);
  });

  it("reconnects with Last-Event-ID after a clean stream drop", async () => {
    const { fetch, calls } = queuedFetch([
      sseResponse([runEventBlock(1, "run.queued"), runEventBlock(2, "run.plan")]),
      sseResponse([runEventBlock(3, "run.succeeded")]),
    ]);
    const client = createGatewayClient({ baseUrl: BASE_URL, fetch });
    const events: number[] = [];
    await client
      .streamRunEvents({
        runId: "run_018f",
        reconnectDelayMs: 0,
        onEvent: (event) => events.push(event.seq),
      })
      .consume();
    expect(events).toEqual([1, 2, 3]);
    expect(calls.length).toBe(2);
    const headers = calls[1]?.init?.headers as Record<string, string>;
    expect(headers["Last-Event-ID"]).toBe("2"); // server id line wins (§13.2)
    expect(headers.accept).toBe("text/event-stream");
  });

  it("dedupes replayed backfill events by seq (§13.2)", async () => {
    const { fetch } = queuedFetch([
      sseResponse([runEventBlock(1, "run.queued"), runEventBlock(2, "run.plan")]),
      sseResponse([
        runEventBlock(1, "run.queued"),
        runEventBlock(2, "run.plan"),
        runEventBlock(3, "run.failed"),
      ]),
    ]);
    const client = createGatewayClient({ baseUrl: BASE_URL, fetch });
    const events: number[] = [];
    await client
      .streamRunEvents({
        runId: "run_018f",
        reconnectDelayMs: 0,
        onEvent: (event) => events.push(event.seq),
      })
      .consume();
    expect(events).toEqual([1, 2, 3]);
  });

  it("uses lastSeq as the resume anchor when the server sent no id lines", async () => {
    const { fetch, calls } = queuedFetch([
      sseResponse([
        runEventBlock(1, "run.queued", { withId: false }),
        runEventBlock(2, "run.plan", { withId: false }),
        runEventBlock(3, "run.cancelled", { withId: false }),
      ]),
    ]);
    const client = createGatewayClient({ baseUrl: BASE_URL, fetch });
    const events: number[] = [];
    await client
      .streamRunEvents({
        runId: "run_018f",
        lastSeq: 2,
        onEvent: (event) => events.push(event.seq),
      })
      .consume();
    expect(events).toEqual([3]);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["Last-Event-ID"]).toBe("2");
  });

  it("retries a retryable 5xx envelope, then succeeds", async () => {
    const { fetch, calls } = queuedFetch([
      jsonResponse(503, { ok: false, code: "engine_unavailable", message: "Busy." }),
      sseResponse([runEventBlock(1, "run.succeeded")]),
    ]);
    const client = createGatewayClient({ baseUrl: BASE_URL, fetch });
    const events: number[] = [];
    await client
      .streamRunEvents({
        runId: "run_018f",
        reconnectDelayMs: 0,
        onEvent: (event) => events.push(event.seq),
      })
      .consume();
    expect(events).toEqual([1]);
    expect(calls.length).toBe(2);
  });

  it("fails fast on a non-retryable 4xx without reconnecting", async () => {
    const { fetch, calls } = queuedFetch([
      jsonResponse(404, {
        ok: false,
        code: "not_found",
        message: "Run not found.",
        hint: "Check the run id.",
      }),
    ]);
    const client = createGatewayClient({ baseUrl: BASE_URL, fetch });
    const stream = client.streamRunEvents({
      runId: "run_missing",
      onEvent: () => {},
    });
    await expect(stream.consume()).rejects.toThrowError(ApiError);
    expect(calls.length).toBe(1);
  });

  it("gives up into a typed sse_disconnected error after maxReconnects", async () => {
    const { fetch, calls } = queuedFetch([
      sseResponse([": open\n\n"]), // connects, yields nothing, closes
      sseResponse([": open\n\n"]),
      sseResponse([": open\n\n"]),
    ]);
    const client = createGatewayClient({ baseUrl: BASE_URL, fetch });
    const error = await client
      .streamRunEvents({
        runId: "run_018f",
        reconnectDelayMs: 0,
        maxReconnects: 2,
        onEvent: () => {},
      })
      .consume()
      .catch((caught: unknown) => (isApiError(caught) ? caught : null));
    expect(error).not.toBeNull();
    expect(error?.code).toBe("sse_disconnected");
    expect(error?.retryable).toBe(true);
    expect(calls.length).toBe(3); // initial + 2 reconnects
  });
});
