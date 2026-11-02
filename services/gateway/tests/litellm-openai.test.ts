// M4-A — LiteLLM openai client unit tests (fake in-process OpenAI SSE
// server; deterministic, no network). Covers the SSE line parser, streamed
// tool_calls fragment aggregation, usage capture, bearer selection, abort,
// the 2-retry (1s/2s) policy with an injectable sleep, and the wire
// tool-name seam (dots ⇄ underscores).

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

/** Usage WITH the provider's cache state (Z.ai GLM / OpenAI report
 * prompt_tokens_details.cached_tokens on cache-hitting prompts). */
function cachedUsageFrame(
  promptTokens: number,
  completionTokens: number,
  cachedTokens: number,
): string {
  return frame({
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      prompt_tokens_details: { cached_tokens: cachedTokens },
    },
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
  it("forwards reasoning_content deltas as reasoning events before the text (round 13 live thinking)", async () => {
    const fetchStub = scriptedFetch([
      sseResponse([
        frame({ choices: [{ delta: { reasoning_content: "Planning the build. " } }] }),
        frame({ choices: [{ delta: { reasoning_content: "One composition, two layers." } }] }),
        // Some providers use the `reasoning` field name instead.
        frame({ choices: [{ delta: { reasoning: "Ready to write." } }] }),
        textDelta("Building it now."),
        finish("stop"),
        DONE,
      ]),
    ]);

    const events = await collect(
      streamChatCompletion(clientDeps({ fetch: fetchStub }), {
        model: "studio-smart",
        messages,
        signal: new AbortController().signal,
      }),
    );

    expect(events).toEqual([
      { type: "reasoning", delta: "Planning the build. " },
      { type: "reasoning", delta: "One composition, two layers." },
      { type: "reasoning", delta: "Ready to write." },
      { type: "text", delta: "Building it now." },
      { type: "finish", reason: "stop" },
    ]);
  });

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
      { type: "usage", usage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 0 } },
    ]);
  });

  it("surfaces the provider's prompt-cache hits (prompt_tokens_details.cached_tokens) in the usage event", async () => {
    // Z.ai GLM implicit context caching / OpenAI automatic prefix caching
    // report cached tokens inside the SAME usage frame — the harness bills
    // them at the discounted rate, so the adapter must carry them through
    // instead of dropping the field (the pre-round-15 behavior).
    const fetch = scriptedFetch([
      sseResponse([
        frame({ choices: [{ delta: { content: "ok" } }] }),
        finish("stop"),
        cachedUsageFrame(50_000, 500, 47_000),
        DONE,
      ]),
    ]);
    const events = await collect(
      streamChatCompletion(clientDeps({ fetch }), {
        model: "studio-fast",
        messages,
        signal: new AbortController().signal,
      }),
    );
    expect(events).toEqual([
      { type: "text", delta: "ok" },
      { type: "finish", reason: "stop" },
      {
        type: "usage",
        usage: { inputTokens: 50_000, outputTokens: 500, cachedInputTokens: 47_000 },
      },
    ]);
  });

  it("clamps an impossible cached report (cached > input) to the input total", async () => {
    const fetch = scriptedFetch([
      sseResponse([finish("stop"), cachedUsageFrame(1_000, 10, 5_000), DONE]),
    ]);
    const events = await collect(
      streamChatCompletion(clientDeps({ fetch }), {
        model: "studio-fast",
        messages,
        signal: new AbortController().signal,
      }),
    );
    const usage = events.find((event) => event.type === "usage");
    expect(usage).toMatchObject({ usage: { inputTokens: 1_000, cachedInputTokens: 1_000 } });
  });

  it("tolerates CRLF line endings", async () => {
    const crlf = [
      frame({ choices: [{ delta: { content: "a" } }] }),
      frame({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    ]
      .join("")
      .replaceAll("\n", "\r\n");
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

  it("fails unavailable when the stream ends mid-frame (no terminating newline)", async () => {
    // Spec-compliant SSE dispatches an event only at its terminating blank
    // line — a trailing frame without one is incomplete and the SDK ends the
    // stream without a finish reason. OpenAI/LiteLLM always terminate events,
    // so this is a broken-stream failure (§8.9), never silent truncation.
    const truncated =
      frame({ choices: [{ delta: { content: "a" } }] }) +
      frame({ choices: [{ delta: {}, finish_reason: "stop" }] }).replace(/\n+$/, "");
    await expect(
      collect(
        streamChatCompletion(clientDeps({ fetch: scriptedFetch([sseResponse([truncated])]) }), {
          model: "studio-fast",
          messages,
          signal: new AbortController().signal,
        }),
      ),
    ).rejects.toBeInstanceOf(ModelUnavailableError);
  });

  it("round-trips system + assistant tool_calls + tool results through the SDK wire", async () => {
    const fetchStub = scriptedFetch([sseResponse([finish("stop"), DONE])]);
    await collect(
      streamChatCompletion(clientDeps({ fetch: fetchStub }), {
        model: "studio-smart",
        messages: [
          { role: "system", content: "You are the Studio agent." },
          { role: "user", content: "what is on this comp?" },
          {
            role: "assistant",
            content: "Let me check.",
            tool_calls: [
              {
                id: "call_get",
                type: "function",
                function: {
                  name: "studio.get_context",
                  arguments: '{"include":["projectSummary"]}',
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_get",
            content: JSON.stringify({ projectSummary: "3 comps" }),
          },
          { role: "user", content: "thanks" },
        ],
        signal: new AbortController().signal,
      }),
    );
    // The SDK re-serializes the SAME OpenAI wire: `instructions` becomes the
    // leading system message, tool arguments/results as JSON strings.
    expect(fetchStub.calls[0]?.body.messages).toEqual([
      { role: "system", content: "You are the Studio agent." },
      { role: "user", content: "what is on this comp?" },
      {
        role: "assistant",
        content: "Let me check.",
        tool_calls: [
          {
            id: "call_get",
            type: "function",
            function: { name: "studio.get_context", arguments: '{"include":["projectSummary"]}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_get", content: '{"projectSummary":"3 comps"}' },
      { role: "user", content: "thanks" },
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

  // -------------------------------------------------------------------------
  // Wire model-id seam (env LITELLM_MODEL_MAP): the request keeps speaking
  // studio aliases; only the wire body's model field is rewritten.
  // -------------------------------------------------------------------------

  it("rewrites the wire model id via modelMap while the alias stays internal", async () => {
    const fetchStub = scriptedFetch([sseResponse([finish("stop"), DONE])]);
    await collect(
      streamChatCompletion(
        clientDeps({
          fetch: fetchStub,
          modelMap: { "studio-fast": "deepseek-v4.1-flash", "studio-smart": "th-rudder" },
        }),
        { model: "studio-smart", messages, signal: new AbortController().signal },
      ),
    );
    expect(fetchStub.calls[0]?.body.model).toBe("th-rudder");
  });

  it("passes an unmapped alias through unchanged when modelMap is set", async () => {
    const fetchStub = scriptedFetch([sseResponse([finish("stop"), DONE])]);
    await collect(
      streamChatCompletion(
        clientDeps({ fetch: fetchStub, modelMap: { "studio-fast": "deepseek-v4.1-flash" } }),
        { model: "studio-smart", messages, signal: new AbortController().signal },
      ),
    );
    expect(fetchStub.calls[0]?.body.model).toBe("studio-smart");
  });

  it("sends the raw alias when modelMap is unset (the LiteLLM-proxy default)", async () => {
    const fetchStub = scriptedFetch([sseResponse([finish("stop"), DONE])]);
    await collect(
      streamChatCompletion(clientDeps({ fetch: fetchStub }), {
        model: "studio-fast",
        messages,
        signal: new AbortController().signal,
      }),
    );
    expect(fetchStub.calls[0]?.body.model).toBe("studio-fast");
  });

  // -------------------------------------------------------------------------
  // Wire tool-name seam: registry ids carry dots (studio.get_context), the
  // OpenAI-compatible grammar ^[a-zA-Z0-9_-]{1,64}$ forbids them — strict
  // providers (Token Harbor) 400 on tools.N.function.name. Registrations go
  // out sanitized; echoes come back in either form and restore the registry
  // id (the prompt speaks dotted ids, so models may echo those verbatim).
  // -------------------------------------------------------------------------

  it("registers sanitized wire tool names and restores registry ids from sanitized echoes", async () => {
    const fetchStub = scriptedFetch([
      sseResponse([
        toolCallStart(0, "call_a", "studio_get_context"),
        toolCallArgs(0, "{}"),
        finish("tool_calls"),
        DONE,
      ]),
    ]);
    const events = await collect(
      streamChatCompletion(clientDeps({ fetch: fetchStub }), {
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
    // Outbound: the registration carries the sanitized wire name.
    expect(fetchStub.calls[0]?.body.tools).toEqual([
      {
        type: "function",
        function: { name: "studio_get_context", description: "d", parameters: {} },
      },
    ]);
    // Inbound: the sanitized echo restores the registry's dotted id.
    expect(events).toEqual([
      {
        type: "tool_call",
        call: { index: 0, id: "call_a", name: "studio.get_context", arguments: "{}" },
      },
      { type: "finish", reason: "tool_calls" },
    ]);
  });

  it("restores registry ids from dotted echoes and passes unknown names through", async () => {
    const fetchStub = scriptedFetch([
      sseResponse([
        toolCallStart(0, "call_a", "studio.list_layers"),
        toolCallArgs(0, "{}"),
        toolCallStart(1, "call_b", "mystery_tool"),
        toolCallArgs(1, "{}"),
        finish("tool_calls"),
        DONE,
      ]),
    ]);
    const events = await collect(
      streamChatCompletion(clientDeps({ fetch: fetchStub }), {
        model: "studio-fast",
        messages,
        tools: [
          {
            type: "function",
            function: { name: "studio.list_layers", description: "d", parameters: {} },
          },
        ],
        signal: new AbortController().signal,
      }),
    );
    // Dotted echo (the prompt-mentioned form) → the registry id.
    expect(events[0]).toEqual({
      type: "tool_call",
      call: { index: 0, id: "call_a", name: "studio.list_layers", arguments: "{}" },
    });
    // An unknown echoed name is NOT invented into a registry id — the
    // runner's §8.9 unknown-tool repair turn owns it.
    expect(events[1]).toEqual({
      type: "tool_call",
      call: { index: 1, id: "call_b", name: "mystery_tool", arguments: "{}" },
    });
  });
});
