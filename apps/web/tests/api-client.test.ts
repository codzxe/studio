/**
 * Gateway client tests (W8-T) — the wave-8 suite next to W1-K's tests/api.test.ts,
 * reusing its conventions (queued fake fetch, SSE body builders; no network,
 * no filesystem, deterministic, <5 s). W8-T scope:
 *   - envelope unwrap: ok body pas/schema and the flat `{ ok:false, … }`
 *     error envelope collapsing into ApiError with code/hint (§13.3);
 *   - SSE chunk parsing (WHATWG), §13.2 seq dedupe + Last-Event-ID resume,
 *     and the run.resync sentinel frame at stream level;
 *   - Idempotency-Key generation for every mutating call (§13).
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
// Helpers (W1-K conventions)
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

function eventBody(
  seq: number,
  type: RunEventType | "run.resync",
  payload: unknown,
): string {
  return JSON.stringify({
    seq,
    run_id: "run_018f",
    at: "2026-07-04T12:00:00.000Z",
    type,
    payload,
  });
}

/** One §13.2 run event rendered as an SSE block (id line: seq, custom, or none). */
function runEventBlock(
  seq: number,
  type: RunEventType | "run.resync",
  payload: unknown,
  options?: { readonly id?: string | false },
): string {
  const idLine =
    options?.id === undefined
      ? `id: ${seq}\n`
      : options.id === false
        ? ""
        : `id: ${options.id}\n`;
  return `event: ${type}\n${idLine}data: ${eventBody(seq, type, payload)}\n\n`;
}

const msg = (event: string, data: string, id: string | null): SseMessage => ({
  event,
  data,
  id,
});

function headersOf(call: RecordedCall | undefined): Record<string, string> {
  return call?.init?.headers as Record<string, string>;
}

// ---------------------------------------------------------------------------
// Envelope unwrap — ok body + flat error envelope (§13.3)
// ---------------------------------------------------------------------------

const creditsSchema = z.object({ balance: z.number() });

describe("createGatewayClient envelope unwrap", () => {
  it("returns an ok body parsed against the caller's schema", async () => {
    const { fetch } = queuedFetch([jsonResponse(200, { balance: 10 })]);
    const client = createGatewayClient({ baseUrl: BASE_URL, fetch });
    expect(await client.get("/credits", { schema: creditsSchema })).toEqual({
      balance: 10,
    });
  });

  it("passes an ok body through untouched when no schema is provided", async () => {
    const { fetch } = queuedFetch([
      jsonResponse(200, { ok: true, run_id: "run_1", status: "queued" }),
    ]);
    const client = createGatewayClient({ baseUrl: BASE_URL, fetch });
    expect(await client.get("/runs/run_1")).toEqual({
      ok: true,
      run_id: "run_1",
      status: "queued",
    });
  });

  it("unwraps the flat { ok:false } envelope into an ApiError with code + hint", async () => {
    const { fetch } = queuedFetch([
      jsonResponse(422, {
        ok: false,
        code: "validation_failed",
        message: "The brief is empty.",
        hint: "Describe what you want the agent to make.",
      }),
    ]);
    const client = createGatewayClient({ baseUrl: BASE_URL, fetch });
    const failure = client.post("/runs", { body: { prompt: "" } });
    await expect(failure).rejects.toThrowError(ApiError);
    const error = await failure.catch((caught: unknown) => caught);
    expect(isApiError(error)).toBe(true);
    if (isApiError(error)) {
      expect(error.code).toBe("validation_failed");
      expect(error.message).toBe("The brief is empty.");
      expect(error.hint).toBe("Describe what you want the agent to make.");
      expect(error.status).toBe(422);
      expect(error.retryable).toBe(false); // 422 < 500 and no retryable flag
    }
  });

  it("keeps the hint undefined when the flat envelope omits it (never invented)", async () => {
    const { fetch } = queuedFetch([
      jsonResponse(409, { ok: false, code: "conflict", message: "Already running." }),
    ]);
    const client = createGatewayClient({ baseUrl: BASE_URL, fetch });
    const error = await client
      .post("/runs", { body: { prompt: "x" } })
      .catch((caught: unknown) => (isApiError(caught) ? caught : null));
    expect(error).not.toBeNull();
    expect(error?.code).toBe("conflict");
    expect(error?.hint).toBeUndefined();
  });

  it("derives retryable from status for flat 5xx and carries docs_url", async () => {
    const { fetch } = queuedFetch([
      jsonResponse(503, {
        ok: false,
        code: "engine_unavailable",
        message: "Every engine is busy.",
        docs_url: "https://docs.example.com/errors/engine",
      }),
    ]);
    const client = createGatewayClient({ baseUrl: BASE_URL, fetch });
    const error = await client
      .get("/runs/run_1")
      .catch((caught: unknown) => (isApiError(caught) ? caught : null));
    expect(error).not.toBeNull();
    expect(error?.retryable).toBe(true); // 503 ≥ 500
    expect(error?.docsUrl).toBe("https://docs.example.com/errors/engine");
  });
});

// ---------------------------------------------------------------------------
// SseParser — chunk parsing (WHATWG semantics)
// ---------------------------------------------------------------------------

interface ParserCase {
  readonly name: string;
  readonly pushes: readonly string[];
  readonly afterPush: readonly SseMessage[];
  readonly afterFlush: readonly SseMessage[];
}

const parserCases: readonly ParserCase[] = [
  {
    name: "event name and data split across three chunks",
    pushes: ["event: run.pl", "an\ndata: ", "{\"seq\":1}", "\n\n"],
    afterPush: [msg("run.plan", '{"seq":1}', null)],
    afterFlush: [],
  },
  {
    name: "LF, CRLF and bare-CR line terminators all split lines in one buffer",
    pushes: ["data: a\ndata: b\r\ndata: c\r\rdata: d\n\n"],
    afterPush: [msg("message", "a\nb\nc", null), msg("message", "d", null)],
    afterFlush: [],
  },
  {
    name: "retry: and unknown fields are ignored; data still dispatches",
    pushes: ["retry: 500\nx-future: yes\ndata: hi\n\n"],
    afterPush: [msg("message", "hi", null)],
    afterFlush: [],
  },
  {
    name: "exactly one leading space is stripped after the colon",
    pushes: ["data:  two spaces\n\ndata:no space\n\n"],
    afterPush: [msg("message", " two spaces", null), msg("message", "no space", null)],
    afterFlush: [],
  },
  {
    name: "event name resets to message after each dispatch",
    pushes: ["event: run.plan\ndata: 1\n\ndata: 2\n\n"],
    afterPush: [msg("run.plan", "1", null), msg("message", "2", null)],
    afterFlush: [],
  },
  {
    name: "comments inside a block do not clear the accumulated data",
    pushes: ["data: alpha\n: keepalive\ndata: beta\n\n"],
    afterPush: [msg("message", "alpha\nbeta", null)],
    afterFlush: [],
  },
  {
    name: "ids update lastEventId across multiple blocks (§13.2 resume)",
    pushes: ["id: 5\ndata: first\n\nid: 6\ndata: second\n\n"],
    afterPush: [msg("message", "first", "5"), msg("message", "second", "6")],
    afterFlush: [],
  },
  {
    name: "CRLF split across chunks waits for the LF before splitting",
    pushes: ["data: v\r", "\n\n"],
    afterPush: [msg("message", "v", null)],
    afterFlush: [],
  },
  {
    name: "a lone trailing CR ends its line at flush time",
    pushes: ["data: tail\r"],
    afterPush: [],
    afterFlush: [msg("message", "tail", null)],
  },
];

describe("SseParser chunk parsing", () => {
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

  it("lastEventId keeps the newest id for the Last-Event-ID header (§13.2)", () => {
    const parser = new SseParser();
    parser.push("id: 41\ndata: a\n\n");
    parser.push("id: 42\ndata: b\n\n");
    parser.push("data: c\n\n");
    expect(parser.lastEventId).toBe("42");
  });
});

describe("readSseStream", () => {
  it("reassembles a run-event JSON payload split across four chunks", async () => {
    const messages = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of [
          "event: run.plan\n",
          "data: ",
          '{"seq":1,',
          ' "type":"run.plan"}',
          "\n\n",
        ]) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    for await (const message of readSseStream(stream)) {
      messages.push(message);
    }
    expect(messages).toEqual([msg("run.plan", '{"seq":1, "type":"run.plan"}', null)]);
  });

  it("yields nothing for a stream whose only block carries no data", async () => {
    const messages: SseMessage[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: run.plan\n\n"));
        controller.close();
      },
    });
    for await (const message of readSseStream(stream)) {
      messages.push(message);
    }
    expect(messages).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// RunEventStream — seq dedupe, Last-Event-ID resume, resync sentinel (§13.2)
// ---------------------------------------------------------------------------

describe("RunEventStream resume + dedupe", () => {
  it("sends no Last-Event-ID on a fresh connect (full backfill, first mount)", async () => {
    const { fetch, calls } = queuedFetch([
      sseResponse([
        runEventBlock(1, "run.queued", { tier: "standard" }),
        runEventBlock(2, "run.succeeded", { revisionAfter: 1, warnings: [] }),
      ]),
    ]);
    const client = createGatewayClient({ baseUrl: BASE_URL, fetch });
    const events: number[] = [];
    await client
      .streamRunEvents({ runId: "run_018f", onEvent: (event) => events.push(event.seq) })
      .consume();
    expect(events).toEqual([1, 2]);
    expect(headersOf(calls[0])["Last-Event-ID"]).toBeUndefined();
    expect(headersOf(calls[0]).accept).toBe("text/event-stream");
  });

  it("heals a mid-stream gap: reconnect backfill fills it while deduping the replay", async () => {
    const { fetch, calls } = queuedFetch([
      sseResponse([
        runEventBlock(1, "run.queued", { tier: "standard" }),
        runEventBlock(3, "run.plan", { plan: { intent: "create_post" } }), // gap at 2
      ]),
      sseResponse([
        runEventBlock(1, "run.queued", { tier: "standard" }), // replayed — deduped
        runEventBlock(2, "run.started", { revisionBefore: 0 }), // gap filled
        runEventBlock(4, "run.succeeded", { revisionAfter: 1, warnings: [] }),
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
    expect(events).toEqual([1, 2, 3, 4]); // contiguous after the heal
    expect(calls).toHaveLength(2);
  });

  it("resumes from the server's durable id, not the local seq counter", async () => {
    const { fetch, calls } = queuedFetch([
      sseResponse([
        runEventBlock(1, "run.queued", { tier: "standard" }, { id: "evt-1" }),
        runEventBlock(2, "run.plan", { plan: { intent: "create_post" } }, { id: "evt-2" }),
      ]),
      sseResponse([
        runEventBlock(3, "run.succeeded", { revisionAfter: 1, warnings: [] }),
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
    // durableId ("evt-2") wins over lastSeq ("2") — proves the id-line path.
    expect(headersOf(calls[1])["Last-Event-ID"]).toBe("evt-2");
  });

  it("treats the run.resync sentinel as a skipped frame whose id is the resume anchor", async () => {
    const { fetch, calls } = queuedFetch([
      sseResponse([
        runEventBlock(1, "run.queued", { tier: "standard" }, { id: "evt-1" }),
        // §13.2 resync sentinel (W4-H): not a §13.2 event type — only its id matters.
        runEventBlock(2, "run.resync", { seq: 1 }, { id: "evt-1" }),
      ]),
      sseResponse([
        runEventBlock(2, "run.started", { revisionBefore: 0 }),
        runEventBlock(3, "run.succeeded", { revisionAfter: 1, warnings: [] }),
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
    expect(events).toEqual([1, 2, 3]); // the sentinel frame never surfaces as an event
    expect(headersOf(calls[1])["Last-Event-ID"]).toBe("evt-1");
  });

  it("stops at the terminal event without reconnecting", async () => {
    const { fetch, calls } = queuedFetch([
      sseResponse([
        runEventBlock(1, "run.queued", { tier: "standard" }),
        runEventBlock(2, "run.failed", {
          error: { code: "engine_unavailable", message: "The engine stopped." },
        }),
      ]),
    ]);
    const client = createGatewayClient({ baseUrl: BASE_URL, fetch });
    const events: number[] = [];
    await client
      .streamRunEvents({ runId: "run_018f", onEvent: (event) => events.push(event.seq) })
      .consume();
    expect(events).toEqual([1, 2]);
    expect(calls).toHaveLength(1); // a second queued response would have thrown
  });

  it("fails fast on a 403 envelope without entering the reconnect loop", async () => {
    const { fetch, calls } = queuedFetch([
      jsonResponse(403, {
        ok: false,
        code: "forbidden",
        message: "You cannot view this run.",
      }),
    ]);
    const client = createGatewayClient({ baseUrl: BASE_URL, fetch });
    const stream = client.streamRunEvents({ runId: "run_private", onEvent: () => {} });
    const error = await stream.consume().catch((caught: unknown) =>
      isApiError(caught) ? caught : null,
    );
    expect(error).not.toBeNull();
    expect(error?.code).toBe("forbidden");
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Idempotency-Key generation (§13 — money paths always carry one)
// ---------------------------------------------------------------------------

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("Idempotency-Key generation", () => {
  it("mints a fresh RFC 4122 v4 UUID for every mutating call", async () => {
    const { fetch, calls } = queuedFetch([
      jsonResponse(201, { run_id: "run_1" }),
      jsonResponse(201, { run_id: "run_2" }),
    ]);
    const client = createGatewayClient({ baseUrl: BASE_URL, fetch });
    await client.post("/runs", { body: { prompt: "a flyer" } });
    await client.post("/runs", { body: { prompt: "a poster" } });
    const first = headersOf(calls[0])["Idempotency-Key"];
    const second = headersOf(calls[1])["Idempotency-Key"];
    expect(first).toMatch(UUID_V4);
    expect(second).toMatch(UUID_V4);
    expect(first).not.toBe(second); // a retry replays the SAME key; a new submit mints a new one
  });

  it("attaches the header to POST, PUT, PATCH and DELETE alike", async () => {
    const { fetch, calls } = queuedFetch([
      new Response("", { status: 204 }),
      new Response("", { status: 204 }),
      new Response("", { status: 204 }),
    ]);
    const client = createGatewayClient({ baseUrl: BASE_URL, fetch });
    await client.request("/documents/doc_1", { method: "PUT" });
    await client.request("/documents/doc_1", { method: "PATCH" });
    await client.request("/documents/doc_1", { method: "DELETE" });
    for (const call of calls) {
      expect(headersOf(call)["Idempotency-Key"]).toMatch(UUID_V4);
    }
  });

  it("never attaches the header to a GET", async () => {
    const { fetch, calls } = queuedFetch([jsonResponse(200, { balance: 10 })]);
    const client = createGatewayClient({ baseUrl: BASE_URL, fetch });
    await client.get("/credits");
    expect(headersOf(calls[0])["Idempotency-Key"]).toBeUndefined();
  });

  it("sends a caller-provided key verbatim (retries replay it)", async () => {
    const { fetch, calls } = queuedFetch([new Response("", { status: 204 })]);
    const client = createGatewayClient({ baseUrl: BASE_URL, fetch });
    await client.request("/runs/run_1/cancel", {
      method: "DELETE",
      idempotencyKey: "same-submit-intent-7",
    });
    expect(headersOf(calls[0])["Idempotency-Key"]).toBe("same-submit-intent-7");
  });
});
