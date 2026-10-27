// Probe round 4: the EXACT shapes the SDK-backed streamChatCompletion adapter
// will send — streamText + instructions + assistant tool-call + tool-result
// round-trip, chunk-split SSE tolerance, usage mapping, error parts with
// maxRetries: 0.
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { jsonSchema, streamText, tool } from "ai";

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

function sseResponse(frames, chunkSize) {
  const full = frames.join("");
  const chunks = [];
  if (chunkSize === undefined) {
    chunks.push(full);
  } else {
    for (let i = 0; i < full.length; i += chunkSize) chunks.push(full.slice(i, i + chunkSize));
  }
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
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

const readTool = tool({
  description: "read project context",
  inputSchema: jsonSchema({
    type: "object",
    properties: { question: { type: "string" } },
    required: ["question"],
  }),
  // no execute: server-side interception
});

async function scenario(name, fn) {
  console.log(`\n===== ${name} =====`);
  try { await fn(); } catch (error) { console.log("THROWN:", error?.name, "-", error?.message?.slice(0, 160)); }
}

// A. The adapter's exact call: instructions + round-trip messages + tools
await scenario("A. adapter shape: instructions + tool round-trip on the wire", async () => {
  const calls = [];
  const provider = makeProvider([sseResponse([textDelta("Done."), finish("stop"), usageFrame(250, 60), DONE])], calls);
  const result = streamText({
    model: provider.chatModel("studio-smart"),
    instructions: "You are the Studio agent.",
    messages: [
      { role: "user", content: "what is on this comp?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool-call", toolCallId: "call_get", toolName: "studio_get_context", input: { question: "layers?" } },
        ],
      },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call_get", toolName: "studio_get_context", output: { type: "json", value: { summary: "3 comps" } } }] },
      { role: "user", content: "thanks" },
    ],
    tools: { studio_get_context: readTool },
    toolChoice: "auto",
    maxRetries: 0,
  });
  const parts = [];
  for await (const part of result.fullStream) {
    parts.push(part.type);
    if (part.type === "finish-step") console.log("  finish-step:", part.finishReason, "usage in/out:", part.usage?.inputTokens, part.usage?.outputTokens, "raw:", JSON.stringify(part.usage?.raw));
    if (part.type === "error") console.log("  error part:", part.error?.name, part.error?.message?.slice(0, 120));
  }
  console.log("  part sequence:", parts.join(","));
  const r = await result;
  console.log("  finishReason:", JSON.stringify(r.finishReason), "usage:", r.usage?.inputTokens, r.usage?.outputTokens);
  console.log("  WIRE body keys:", Object.keys(calls[0].body).join(","));
  console.log("  WIRE stream_options:", JSON.stringify(calls[0].body.stream_options));
  console.log("  WIRE tool_choice:", calls[0].body.tool_choice);
  console.log("  WIRE tools[0]:", JSON.stringify(calls[0].body.tools?.[0]));
  console.log("  WIRE messages:", JSON.stringify(calls[0].body.messages, null, 2));
});

// B. Chunk-split SSE (1 byte per chunk) — parser tolerance
await scenario("B. 1-byte chunk splits: tool call + usage survive", async () => {
  const provider = makeProvider([
    sseResponse([
      textDelta("hi "),
      textDelta("there"),
      toolCallStart(0, "call_a", "studio_get_context"),
      toolCallArgs(0, '{"question":"'),
      toolCallArgs(0, 'layers?"}'),
      finish("tool_calls"),
      usageFrame(100, 40),
      DONE,
    ], 1),
  ], []);
  const result = streamText({
    model: provider.chatModel("studio-fast"),
    instructions: "sys",
    messages: [{ role: "user", content: "go" }],
    tools: { studio_get_context: readTool },
    maxRetries: 0,
  });
  const calls = [];
  for await (const part of result.fullStream) {
    if (part.type === "tool-call") calls.push({ id: part.toolCallId, name: part.toolName, input: part.input });
    if (part.type === "finish-step") console.log("  finish:", part.finishReason, "usage:", part.usage?.inputTokens, part.usage?.outputTokens);
    if (part.type === "error") console.log("  error part:", part.error?.name);
  }
  console.log("  tool calls:", JSON.stringify(calls));
});

// C. HTTP 500 with maxRetries: 0 — error part or throw?
await scenario("C. HTTP 500, maxRetries 0: part vs throw", async () => {
  const calls = [];
  const provider = makeProvider([new Response("boom", { status: 500 })], calls);
  const result = streamText({
    model: provider.chatModel("studio-fast"),
    instructions: "sys",
    messages: [{ role: "user", content: "go" }],
    maxRetries: 0,
  });
  try {
    for await (const part of result.fullStream) {
      if (part.type === "error") console.log("  error part:", part.error?.name, "status:", part.error?.statusCode, "retryable:", part.error?.isRetryable);
    }
    console.log("  (iteration ended without throw)");
  } catch (error) {
    console.log("  THROWN during iteration:", error?.name, "-", error?.message?.slice(0, 120));
  }
  console.log("  fetch attempts:", calls.length);
});

// D. abort BEFORE iteration starts (pre-flight abort)
await scenario("D. pre-aborted signal", async () => {
  const controller = new AbortController();
  controller.abort();
  const calls = [];
  const provider = makeProvider([new Response("nope")], calls);
  const result = streamText({
    model: provider.chatModel("studio-fast"),
    instructions: "sys",
    messages: [{ role: "user", content: "go" }],
    abortSignal: controller.signal,
    maxRetries: 0,
  });
  try {
    for await (const part of result.fullStream) {
      if (part.type === "abort") console.log("  abort part");
      if (part.type === "error") console.log("  error part:", part.error?.name, error?.message?.slice(0, 80));
    }
    console.log("  (iteration ended without throw)");
  } catch (error) {
    console.log("  THROWN during iteration:", error?.name, "-", error?.message?.slice(0, 100));
  }
  console.log("  fetch attempts:", calls.length);
});
