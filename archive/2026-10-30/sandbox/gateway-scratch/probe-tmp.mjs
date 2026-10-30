// Probe the Vercel AI SDK v7 behaviors needed for the Studio runner migration.
// Scenarios: wire shape (URL/headers/body), text streaming, tool calls without
// execute, unknown tools, invalid args, usage, retries, abort, generateText.
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, NoSuchToolError, RetryError, streamText, tool } from "ai";
import { z } from "zod";

const enc = new TextEncoder();
const frame = (data) => `data: ${JSON.stringify(data)}\n\n`;
const textDelta = (content) => frame({ choices: [{ delta: { content } }] });
const toolCallStart = (index, id, name) =>
  frame({ choices: [{ delta: { tool_calls: [{ index, id, type: "function", function: { name, arguments: "" } }] } }] });
const toolCallArgs = (index, args) =>
  frame({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: args } }] } }] });
const finish = (reason) => frame({ choices: [{ delta: {}, finish_reason: reason }] });
const usageFrame = (promptTokens, completionTokens) =>
  frame({ choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens } });
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
    calls.push({
      url: String(url),
      urlType: typeof url,
      headers: init?.headers,
      headersType: init?.headers?.constructor?.name,
      body: JSON.parse(String(init?.body)),
      rawBody: String(init?.body),
    });
    const next = script[index];
    index += 1;
    if (next === undefined) throw new Error("script exhausted");
    return next;
  };
  const provider = createOpenAICompatible({
    name: "litellm",
    baseURL: "http://127.0.0.1:4000/v1",
    apiKey: "sk-test-bearer",
    fetch: fetchStub,
    includeUsage: true,
  });
  return provider;
}

const echoTool = tool({
  description: "echo a message",
  parameters: z.object({ message: z.string() }),
  // no execute on purpose
});

async function scenario(name, fn) {
  console.log(`\n===== ${name} =====`);
  try {
    await fn();
  } catch (error) {
    console.log("THROWN:", error?.name, "-", error?.message?.slice(0, 120));
    if (error instanceof NoSuchToolError) console.log("  NoSuchToolError.toolName:", error.toolName);
    if (error instanceof RetryError) console.log("  RetryError.reason:", error.reason, "lastError:", error.lastError?.name);
  }
}

// 1. Wire shape + text streaming + usage
await scenario("1. text-only round: URL/headers/body + usage", async () => {
  const calls = [];
  const provider = makeProvider([sseResponse([textDelta("You have "), textDelta("3 comps."), finish("stop"), usageFrame(25000, 9000), DONE])], calls);
  const result = streamText({
    model: provider.chatModel("studio-smart"),
    messages: [{ role: "user", content: "what is on this comp?" }],
    maxRetries: 2,
  });
  for await (const part of result.fullStream) {
    if (part.type === "text-delta") console.log("  delta:", JSON.stringify(part.text));
    if (part.type === "finish-step") console.log("  finish-step:", part.finishReason, "usage:", JSON.stringify(part.usage));
    if (part.type === "finish") console.log("  finish:", part.finishReason, "totalUsage:", JSON.stringify(part.totalUsage));
    if (part.type === "error") console.log("  error part:", part.error?.name);
  }
  const r = await result;
  console.log("  result.text:", JSON.stringify(r.text));
  console.log("  result.usage:", JSON.stringify(r.usage));
  console.log("  result.finishReason:", r.finishReason);
  console.log("  WIRE url:", calls[0].url, "urlType:", calls[0].urlType);
  console.log("  WIRE headersType:", calls[0].headersType, "auth:", calls[0].headers?.authorization ?? "(see below)");
  console.log("  WIRE headers keys:", calls[0].headers ? Object.keys(calls[0].headers) : String(calls[0].headers));
  console.log("  WIRE body keys:", Object.keys(calls[0].body));
  console.log("  WIRE stream_options:", JSON.stringify(calls[0].body.stream_options));
});

// 2. Valid tool call, tool WITHOUT execute
await scenario("2. tool call without execute: parts + finishReason", async () => {
  const calls = [];
  const provider = makeProvider([sseResponse([
    textDelta("Checking."),
    toolCallStart(0, "call_get", "studio_echo"),
    toolCallArgs(0, '{"message":"hello"}'),
    finish("tool_calls"),
    usageFrame(100, 40),
    DONE,
  ])], calls);
  const result = streamText({
    model: provider.chatModel("studio-fast"),
    messages: [{ role: "user", content: "echo hello" }],
    tools: { studio_echo: echoTool },
    maxRetries: 2,
  });
  for await (const part of result.fullStream) {
    if (part.type === "text-delta") console.log("  delta:", JSON.stringify(part.text));
    if (part.type === "tool-input-start") console.log("  tool-input-start:", part.toolCallId, part.toolName);
    if (part.type === "tool-input-delta") console.log("  tool-input-delta:", JSON.stringify(part.delta).slice(0, 60));
    if (part.type === "tool-call") console.log("  tool-call:", part.toolCallId, part.toolName, "input:", JSON.stringify(part.input), "args:", JSON.stringify(part.args));
    if (part.type === "finish-step") console.log("  finish-step:", part.finishReason, "steps-usage:", JSON.stringify(part.usage));
    if (part.type === "error") console.log("  error part:", part.error?.name, part.error?.message?.slice(0, 100));
  }
  const r = await result;
  console.log("  result.finishReason:", r.finishReason);
  console.log("  result.steps.length:", r.steps.length);
  console.log("  steps[0].toolCalls:", JSON.stringify(r.steps[0]?.toolCalls));
  console.log("  WIRE body tools:", JSON.stringify(calls[0].body.tools));
  console.log("  WIRE tool_choice:", calls[0].body.tool_choice);
});

// 3. UNKNOWN tool
await scenario("3. unknown tool: what surfaces?", async () => {
  const provider = makeProvider([sseResponse([
    toolCallStart(0, "call_bad", "studio.delete_everything"),
    toolCallArgs(0, "{}"),
    finish("tool_calls"),
    DONE,
  ])], []);
  const result = streamText({
    model: provider.chatModel("studio-fast"),
    messages: [{ role: "user", content: "go" }],
    tools: { studio_echo: echoTool },
    maxRetries: 2,
  });
  for await (const part of result.fullStream) {
    console.log("  part:", part.type, part.type === "tool-input-start" ? `${part.toolCallId} ${part.toolName}` : "", part.type === "error" ? `${part.error?.name}: ${part.error?.message?.slice(0, 100)}` : "");
    if (part.type === "tool-call") console.log("    tool-call:", part.toolCallId, part.toolName);
  }
  const r = await result;
  console.log("  result.finishReason:", r.finishReason);
});

// 4. INVALID args on a known tool
await scenario("4. invalid args (schema violation): what surfaces?", async () => {
  const provider = makeProvider([sseResponse([
    toolCallStart(0, "call_bad", "studio_echo"),
    toolCallArgs(0, '{"message": 5}'),
    finish("tool_calls"),
    DONE,
  ])], []);
  const result = streamText({
    model: provider.chatModel("studio-fast"),
    messages: [{ role: "user", content: "go" }],
    tools: { studio_echo: echoTool },
    maxRetries: 2,
  });
  for await (const part of result.fullStream) {
    console.log("  part:", part.type, part.type === "tool-call" ? `${part.toolCallId} ${part.toolName} input=${JSON.stringify(part.input)}` : "", part.type === "error" ? `${part.error?.name}: ${part.error?.message?.slice(0, 140)}` : "");
  }
  const r = await result;
  console.log("  result.finishReason:", r.finishReason, "steps:", r.steps.length);
});

// 5. Retries on 500s
await scenario("5. retry on HTTP 500 x3 → RetryError, attempt count", async () => {
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
    for await (const _part of result.fullStream) { /* drain */ }
    await result;
    console.log("  (no throw)");
  } catch (error) {
    console.log("  thrown:", error?.name, error?.message?.slice(0, 80));
  }
  console.log("  fetch attempts:", calls.length, "elapsed ms:", Date.now() - started);
});

// 6. Abort mid-stream
await scenario("6. abort mid-stream", async () => {
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
  console.log("  first part:", first.value.type, JSON.stringify(first.value.text ?? ""));
  controller.abort();
  try {
    for (;;) {
      const next = await it.next();
      if (next.done) { console.log("  stream done cleanly"); break; }
      console.log("  part after abort:", next.value.type);
    }
  } catch (error) {
    console.log("  thrown after abort:", error?.name, error?.message?.slice(0, 80));
  }
});

// 7. generateText (structured-output style call)
await scenario("7. generateText no-tools wire shape", async () => {
  const calls = [];
  const provider = makeProvider([sseResponse([textDelta('{"intent":"create"}'), finish("stop"), usageFrame(50, 20), DONE])], calls);
  const result = await generateText({
    model: provider.chatModel("studio-smart"),
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "plan goal" },
    ],
    maxRetries: 2,
  });
  console.log("  text:", JSON.stringify(result.text));
  console.log("  usage:", JSON.stringify(result.usage));
  console.log("  WIRE body keys:", Object.keys(calls[0].body));
  console.log("  WIRE stream:", calls[0].body.stream, "stream_options:", JSON.stringify(calls[0].body.stream_options));
  console.log("  WIRE has tools:", "tools" in calls[0].body);
});

// 8. Round-trip messages: assistant tool-call + tool result → wire
await scenario("8. message round-trip: assistant tool_call + tool result on wire", async () => {
  const calls = [];
  const provider = makeProvider([sseResponse([textDelta("done"), finish("stop"), DONE])], calls);
  const result = await generateText({
    model: provider.chatModel("studio-smart"),
    messages: [
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
    maxRetries: 2,
  });
  const wire = calls[0].body.messages;
  console.log("  wire messages:", JSON.stringify(wire, null, 2).slice(0, 1200));
});
