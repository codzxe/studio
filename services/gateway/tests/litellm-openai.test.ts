// M4-A — LiteLLM openai client unit tests (fake in-process OpenAI SSE
// server; deterministic, no network). Covers the SSE line parser, streamed
// tool_calls fragment aggregation, usage capture, bearer selection, abort
// and the 2-retry (1s/2s) policy with an injectable sleep.

import { describe, expect, it } from "vitest";

import {
  type ModelStreamEvent,
  ModelUnavailableError,
  type OpenAIChatMessage,
  streamChatCompletion,
} from "../src/litellm/openai.js";

// ---------------------------------------------------------------------------
// Fake OpenAI SSE server
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function frame(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function textDelta(content: string): string {
  return frame({ choices: [{ delta: { content } }] });
}

function toolCallStart(index: number, id: string, name: string): string {
  return frame({
    choices: [
      {
        delta: { tool_calls: [{ index, id, type: "function", function: { name, arguments: "" } }] },
      },
    ],
  });
}

function toolCallArgs(index: number, args: string): string {
  return frame({
    choices: [{ delta: { tool_calls: [{ index, function: { arguments: args } }] } }],
  });
}

function finish(reason: string): string {
  return frame({ choices: [{ delta: {}, finish_reason: reason }] });
}

function usageFrame(promptTokens: number, completionTokens: number): string {
  return frame({
    choices: [],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  });
}

const DONE = "data: [DONE]\n\n";

function sseResponse(frames: readonly string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of frames) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

interface RecordedCall {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

/** A fetch stub with a fixed script; records every call for assertions. */
function scriptedFetch(script: ReadonlyArray<Response>): typeof fetch & {
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let index = 0;
  const stub = (async (url: unknown, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(url),
      headers,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const next = script[index];
    index += 1;
    if (next === undefined) throw new Error("script exhausted");
    return next;
  }) as typeof fetch & { calls: RecordedCall[] };
  stub.calls = calls;
  return stub;
}

async function collect(events: AsyncGenerator<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const collected: ModelStreamEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

const messages: OpenAIChatMessage[] = [{ role: "user", content: "hello" }];

function clientDeps(overrides: Partial<Parameters<typeof streamChatCompletion>[0]> = {}) {
  return {
    baseUrl: "http://127.0.0.1:4000",
    bearer: "sk-virtual-test",
    sleep: async () => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe("streamChatCompletion", () => {
  it("emits text deltas, aggregated tool calls, usage and finish in order", async () => {
    const fetchStub = scriptedFetch([
      sseResponse([
        ": keep-alive comment\n\n",
        textDelta("Hi "),
        textDelta("there"),
        toolCallStart(0, "call_a", "studio.get_context"),
        toolCallArgs(0, '{"incl'),
        toolCallArgs(0, 'ude":["activeComp"]}'),
        toolCallStart(1, "call_b", "studio.list_layers"),
        toolCallArgs(1, "{}"),
        finish("tool_calls"),
        usageFrame(120, 30),
        DONE,
      ]),
    ]);

    const events = await collect(
      streamChatCompletion(clientDeps({ fetch: fetchStub }), {
        model: "studio-smart",
        messages,
        tools: [
          {
            type: "function",
            function: { name: "studio.get_context", description: "d", parameters: {} },
          },
        ],
        signal: new AbortController().signal,
      }),
    );

    expect(events).toEqual([
      { type: "text", delta: "Hi " },
      { type: "text", delta: "there" },
      {
        type: "tool_call",
        call: {
          index: 0,
          id: "call_a",
          name: "studio.get_context",
          arguments: '{"include":["activeComp"]}',
        },
      },
      {
        type: "tool_call",
        call: { index: 1, id: "call_b", name: "studio.list_layers", arguments: "{}" },
      },
      { type: "finish", reason: "tool_calls" },
      { type: "usage", usage: { inputTokens: 120, outputTokens: 30 } },
    ]);
  });

  it("tolerates CRLF line endings and a final frame without trailing newline", async () => {
    const crlf =
      frame({ choices: [{ delta: { content: "a" } }] }).replaceAll("\n", "\r\n") +
      frame({ choices: [{ delta: {}, finish_reason: "stop" }] }).replace(/\n+$/, "");
    const events = await collect(
      streamChatCompletion(clientDeps({ fetch: scriptedFetch([sseResponse([crlf])]) }), {
        model: "studio-fast",
        messages,
        signal: new AbortController().signal,
      }),
    );
    expect(events).toEqual([
      { type: "text", delta: "a" },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("posts the §8.2 body shape and the bearer token to {base}/v1/chat/completions", async () => {
    const fetchStub = scriptedFetch([sseResponse([finish("stop"), DONE])]);
    await collect(
      streamChatCompletion(clientDeps({ fetch: fetchStub, bearer: "sk-platform" }), {
        model: "studio-fast",
        messages,
        tools: [
          {
            type: "function",
            function: { name: "studio.get_context", description: "d", parameters: {} },
          },
        ],
        signal: new AbortController().signal,
      }),
    );
    const call = fetchStub.calls[0];
    expect(call?.url).toBe("http://127.0.0.1:4000/v1/chat/completions");
    expect(call?.headers.authorization).toBe("Bearer sk-platform");
    expect(call?.body.model).toBe("studio-fast");
    expect(call?.body.stream).toBe(true);
    expect(call?.body.stream_options).toEqual({ include_usage: true });
    expect(call?.body.tool_choice).toBe("auto");
    expect(Array.isArray(call?.body.tools)).toBe(true);
  });

  it("omits tools/tool_choice for structured-output calls", async () => {
    const fetchStub = scriptedFetch([sseResponse([finish("stop"), DONE])]);
    await collect(
      streamChatCompletion(clientDeps({ fetch: fetchStub }), {
        model: "studio-fast",
        messages,
        signal: new AbortController().signal,
      }),
    );
    const call = fetchStub.calls[0];
    expect("tools" in (call ?? {})).toBe(false);
    expect("tool_choice" in (call ?? {})).toBe(false);
  });

  it("retries HTTP 500 twice (1s/2s backoff) then succeeds", async () => {
    const sleeps: number[] = [];
    const fetchStub = scriptedFetch([
      new Response("upstream exploded", { status: 500 }),
      new Response("still exploding", { status: 502 }),
      sseResponse([textDelta("ok"), finish("stop"), DONE]),
    ]);
    const events = await collect(
      streamChatCompletion(
        clientDeps({
          fetch: fetchStub,
          sleep: async (ms: number) => {
            sleeps.push(ms);
          },
        }),
        { model: "studio-fast", messages, signal: new AbortController().signal },
      ),
    );
    expect(fetchStub.calls.length).toBe(3);
    expect(sleeps).toEqual([1_000, 2_000]);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
  });

  it("throws ModelUnavailableError after 2 failed retries", async () => {
    const fetchStub = scriptedFetch([
      new Response("boom", { status: 500 }),
      new Response("boom", { status: 500 }),
      new Response("boom", { status: 500 }),
    ]);
    await expect(
      collect(
        streamChatCompletion(clientDeps({ fetch: fetchStub }), {
          model: "studio-fast",
          messages,
          signal: new AbortController().signal,
        }),
      ),
    ).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(fetchStub.calls.length).toBe(3);
  });

  it("aborts mid-stream with an AbortError the caller can map to cancelled", async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(controller2) {
        controller2.enqueue(encoder.encode(textDelta("partial")));
        controller.signal.addEventListener(
          "abort",
          () => controller2.error(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      },
    });
    const fetchStub = scriptedFetch([new Response(body, { status: 200 })]);
    const iterator = streamChatCompletion(clientDeps({ fetch: fetchStub }), {
      model: "studio-fast",
      messages,
      signal: controller.signal,
    });
    const first = await iterator.next();
    expect(first.value).toEqual({ type: "text", delta: "partial" });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("maps a mid-stream failure (not aborted) to ModelUnavailableError", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller2) {
        controller2.enqueue(encoder.encode(textDelta("partial")));
        controller2.error(new Error("connection reset"));
      },
    });
    const fetchStub = scriptedFetch([new Response(body, { status: 200 })]);
    await expect(
      collect(
        streamChatCompletion(clientDeps({ fetch: fetchStub }), {
          model: "studio-fast",
          messages,
          signal: new AbortController().signal,
        }),
      ),
    ).rejects.toBeInstanceOf(ModelUnavailableError);
  });
});
