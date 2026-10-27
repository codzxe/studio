// Probe round 2: part field names, tool-error shape, abort, round-trip, timing.
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText, tool, jsonSchema } from "ai";

const enc = new TextEncoder();
const frame = (data) => `data: ${JSON.stringify(data)}\n\n`;
const textDelta = (content) => frame({ choices: [{ delta: { content } }] });
const toolCallStart = (index, id, name) =>
  frame({ choices: [{ delta: { tool_calls: [{ index, id, type: "function", function: { name, arguments: "" } }] } }] });
const toolCallArgs = (index, args) =>
  frame({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: args } }] } }] });
const finish = (reason) => frame({ choices: [{ delta: {}, finish_reason: reason }] });
const usageFrame = (p, c) => frame({ choices: [], usage: { prompt_tokens: p, completion_tokens: c } });
const DONE = "data: [DONE]\n\n";

function sseResponse(frames) {
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of frames) controller.enqueue(enc.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function makeProvider(script, calls) {
  let index = 0;
  const fetchStub = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers });
    const next = script[index];
    index += 1;
    if (next === undefined) throw new Error("script exhausted");
    return next;
  };
  return createOpenAICompatible({
    name: "litellm", baseURL: "http://127.0.0.1:4000/v1", apiKey: "sk", fetch: fetchStub, includeUsage: true,
  });
}

const jsonEcho = tool({
  description: "echo",
  parameters: jsonSchema({
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
    additionalProperties: false,
  }),
});

async function scenario(name, fn) {
  console.log(`\n===== ${name} =====`);
  try { await fn(); }
  catch (error) { console.log("THROWN:", error?.name, "-", error?.message?.slice(0, 140)); }
}

// A. jsonSchema tool: wire parameters + unknown tool part shapes
await scenario("A. jsonSchema tool + unknown tool parts", async () => {
  const calls = [];
  const provider = makeProvider([sseResponse([
    toolCallStart(0, "call_bad", "studio.delete_everything"),
    toolCallArgs(0, "{}"),
    finish("tool_calls"),
    DONE,
  ])], calls);
  const result = streamText({
    model: provider.chatModel("studio-fast"),
    messages: [{ role: "user", content: "go" }],
    tools: { studio_echo: jsonEcho },
    maxRetries: 2,
  });
  for await (const part of result.fullStream) {
    if (part.type === "tool-input-start") console.log("  tool-input-start keys:", Object.keys(part).join(","), JSON.stringify({ id: part.id, toolCallId: part.toolCallId, toolName: part.toolName, dynamic: part.dynamic }));
    if (part.type === "tool-call") console.log("  tool-call:", JSON.stringify({ toolCallId: part.toolCallId, toolName: part.toolName, input: part.input }));
    if (part.type === "tool-error") console.log("  tool-error:", JSON.stringify({ toolCallId: part.toolCallId, toolName: part.toolName, errorName: part.error?.name, errorMessage: part.error?.message?.slice(0, 90) }));
    if (part.type === "finish-step") console.log("  finish-step:", part.finishReason);
  }
  console.log("  WIRE parameters:", JSON.stringify(calls[0].body.tools?.[0]?.function?.parameters));
});

// B. abort mid-stream
await scenario("B. abort mid-stream", async () => {
  const controller = new AbortController();
  const body = new ReadableStream({
    start(ctl) {
      ctl.enqueue(enc.encode(textDelta("partial")));
      controller.signal.addEventListener("abort", () => ctl.error(new DOMException("aborted", "AbortError")), { once: true });
    },
  });
  const provider = makeProvider([new Response(body, { status: 200 })], []);
  const result = streamText({
    model: provider.chatModel("studio-fast"),
    messages: [{ role: "user", content: "hi" }],
    abortSignal: controller.signal,
    maxRetries: 0,
  });
  const it = result.fullStream[Symbol.asyncIterator]();
  const first = await it.next();
  console.log("  first part:", first.value.type, JSON.stringify(first.value.text ?? first.value.textDelta ?? ""));
  controller.abort();
  try {
    for (;;) {
      const next = await it.next();
      if (next.done) { console.log("  stream done cleanly (no throw)"); break; }
      console.log("  part after abort:", next.value.type);
    }
  } catch (error) {
    console.log("  thrown after abort:", error?.name, "-", error?.message?.slice(0, 90));
  }
});

// C. round-trip: assistant tool-call + tool result message → wire
await scenario("C. message round-trip", async () => {
  const calls = [];
  const provider = makeProvider([sseResponse([textDelta("done"), finish("stop"), DONE])], calls);
  const result = streamText({
    model: provider.chatModel("studio-smart"),
    messages: [
      { role: "system", content: "sys prompt" },
      { role: "user", content: "echo hi" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool-call", toolCallId: "call_get", toolName: "studio_echo", input: { message: "hi" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "call_get", toolName: "studio_echo", output: { projectSummary: "3 comps" } }],
      },
    ],
    maxRetries: 0,
  });
  for await (const _part of result.fullStream) { }
  const wire = calls[0].body.messages;
  console.log("  wire messages:", JSON.stringify(wire, null, 1));
});

// D. retry timing (backoff delays)
await scenario("D. retry timing", async () => {
  const calls = [];
  const provider = makeProvider([
    new Response("boom", { status: 500 }),
    new Response("boom", { status: 500 }),
    new Response("boom", { status: 500 }),
  ], calls);
  const started = Date.now();
  try {
    const result = streamText({
      model: provider.chatModel("studio-fast"),
      messages: [{ role: "user", content: "hi" }],
      maxRetries: 2,
    });
    for await (const _part of result.fullStream) { }
  } catch { /* expected */ }
  console.log("  attempts:", calls.length, "elapsed ms:", Date.now() - started);
});

// E. streamText with string output for text-result; result.text awaitable?
await scenario("E. result promise fields", async () => {
  const provider = makeProvider([sseResponse([textDelta("abc"), finish("stop"), usageFrame(10, 5), DONE])], []);
  const result = streamText({
    model: provider.chatModel("studio-fast"),
    messages: [{ role: "user", content: "hi" }],
    maxRetries: 0,
  });
  const text = await result.text;
  const usage = await result.usage;
  const finishReason = await result.finishReason;
  console.log("  awaited text:", JSON.stringify(text), "usage in/out:", usage?.inputTokens, usage?.outputTokens, "finishReason:", finishReason);
});

// F. CRLF + trailing-no-newline + comment frames tolerance
await scenario("F. SSE tolerance (CRLF, comment, no trailing newline)", async () => {
  const crlf = frame({ choices: [{ delta: { content: "a" } }] }).replaceAll("\n", "\r\n") +
    frame({ choices: [{ delta: {}, finish_reason: "stop" }] }).replace(/\n+$/, "");
  const provider = makeProvider([new Response(enc.encode(": keep-alive\n\n" + crlf), { status: 200 })], []);
  const result = streamText({
    model: provider.chatModel("studio-fast"),
    messages: [{ role: "user", content: "hi" }],
    maxRetries: 0,
  });
  let text = "";
  for await (const part of result.fullStream) if (part.type === "text-delta") text += part.text;
  const fr = await result.finishReason;
  console.log("  text:", JSON.stringify(text), "finishReason:", fr);
});

// G. toolChoice option + provider chatModel per-call; also 'stopWhen' n/a
// H. empty text with tool call only (no text parts)
await scenario("H. tool-call round with no text", async () => {
  const provider = makeProvider([sseResponse([
    toolCallStart(0, "c1", "studio_echo"),
    toolCallArgs(0, '{"message":"x"}'),
    finish("tool_calls"),
    usageFrame(10, 5),
    DONE,
  ])], []);
  const result = streamText({
    model: provider.chatModel("studio-fast"),
    messages: [{ role: "user", content: "go" }],
    tools: { studio_echo: jsonEcho },
    maxRetries: 0,
  });
  let text = "";
  let call = null;
  for await (const part of result.fullStream) {
    if (part.type === "text-delta") text += part.text;
    if (part.type === "tool-call") call = part;
  }
  console.log("  text:", JSON.stringify(text), "call:", call?.toolCallId, call?.toolName, JSON.stringify(call?.input));
});
