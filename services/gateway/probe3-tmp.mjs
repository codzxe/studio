// Probe round 3: v7-correct API (instructions, inputSchema) — round-trip wire,
// retry timing, result fields, SSE tolerance.
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
  return createOpenAICompatible({ name: "litellm", baseURL: "http://127.0.0.1:4000/v1", apiKey: "sk", fetch: fetchStub, includeUsage: true });
}
const jsonEcho = tool({
  description: "echo",
  inputSchema: jsonSchema({ type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false }),
});
async function scenario(name, fn) {
  console.log(`\n===== ${name} =====`);
  try { await fn(); } catch (error) { console.log("THROWN:", error?.name, "-", error?.message?.slice(0, 140)); }
}

// C2. instructions + round-trip messages → wire shape
await scenario("C2. instructions + assistant tool-call + tool result round-trip", async () => {
  const calls = [];
  const provider = makeProvider([sseResponse([textDelta("done"), finish("stop"), DONE])], calls);
  const result = streamText({
    model: provider.chatModel("studio-smart"),
    instructions: "SYSTEM PROMPT TEXT",
    messages: [
      { role: "user", content: "echo hi" },
      { role: "assistant", content: [{ type: "text", text: "Let me check." }, { type: "tool-call", toolCallId: "call_get", toolName: "studio_echo", input: { message: "hi" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call_get", toolName: "studio_echo", output: { projectSummary: "3 comps" } }] },
    ],
    maxRetries: 0,
  });
  for await (const _p of result.fullStream) { }
  console.log("  wire messages:", JSON.stringify(calls[0].body.messages, null, 1));
});

// D2. retry timing
await scenario("D2. retry timing", async () => {
  const calls = [];
  const provider = makeProvider([new Response("b", { status: 500 }), new Response("b", { status: 500 }), new Response("b", { status: 500 })], calls);
  const t0 = Date.now();
  try {
    const result = streamText({ model: provider.chatModel("m"), messages: [{ role: "user", content: "hi" }], maxRetries: 2 });
    for await (const _p of result.fullStream) { }
  } catch { }
  console.log("  RESULT attempts:", calls.length, "elapsed ms:", Date.now() - t0);
});

// E. awaited result fields
await scenario("E. result fields", async () => {
  const provider = makeProvider([sseResponse([textDelta("abc"), finish("stop"), usageFrame(10, 5), DONE])], []);
  const result = streamText({ model: provider.chatModel("m"), instructions: "s", messages: [{ role: "user", content: "hi" }], maxRetries: 0 });
  let text = "";
  for await (const p of result.fullStream) if (p.type === "text-delta") text += p.text;
  const usage = await result.usage;
  const fr = await result.finishReason;
  console.log("  RESULT text:", JSON.stringify(text), "usage:", usage?.inputTokens, usage?.outputTokens, "fr:", fr);
});

// F. SSE tolerance: CRLF + comments + no trailing newline
await scenario("F. SSE tolerance", async () => {
  const crlf = frame({ choices: [{ delta: { content: "a" } }] }).replaceAll("\n", "\r\n") +
    frame({ choices: [{ delta: {}, finish_reason: "stop" }] }).replace(/\n+$/, "");
  const provider = makeProvider([new Response(enc.encode(": keep-alive\n\n" + crlf), { status: 200 })], []);
  const result = streamText({ model: provider.chatModel("m"), messages: [{ role: "user", content: "hi" }], maxRetries: 0 });
  let text = "";
  let sawFinish = false;
  for await (const p of result.fullStream) {
    if (p.type === "text-delta") text += p.text;
    if (p.type === "finish") sawFinish = true;
  }
  console.log("  RESULT text:", JSON.stringify(text), "finish:", sawFinish, await result.finishReason);
});

// H. tool-call round with no text at all + usage
await scenario("H. tool round, no text", async () => {
  const provider = makeProvider([sseResponse([toolCallStart(0, "c1", "studio_echo"), toolCallArgs(0, '{"message":"x"}'), finish("tool_calls"), usageFrame(10, 5), DONE])], []);
  const result = streamText({ model: provider.chatModel("m"), messages: [{ role: "user", content: "go" }], tools: { studio_echo: jsonEcho }, maxRetries: 0 });
  let text = ""; let call = null; let usage = null;
  for await (const p of result.fullStream) {
    if (p.type === "text-delta") text += p.text;
    if (p.type === "tool-call") call = p;
    if (p.type === "finish-step") usage = p.usage;
  }
  console.log("  RESULT text:", JSON.stringify(text), "call:", call?.toolCallId, call?.toolName, JSON.stringify(call?.input), "usage:", usage?.inputTokens, usage?.outputTokens, "fr:", await result.finishReason);
});

// I. invalid JSON args fragments (malformed) → what input surfaces?
await scenario("I. malformed JSON args", async () => {
  const provider = makeProvider([sseResponse([toolCallStart(0, "c1", "studio_echo"), toolCallArgs(0, '{"message": "unclosed'), finish("tool_calls"), DONE])], []);
  const result = streamText({ model: provider.chatModel("m"), messages: [{ role: "user", content: "go" }], tools: { studio_echo: jsonEcho }, maxRetries: 0 });
  for await (const p of result.fullStream) {
    if (p.type === "tool-call") console.log("  tool-call input:", JSON.stringify(p.input), "args:", JSON.stringify(p.args));
    if (p.type === "tool-error") console.log("  tool-error:", p.toolCallId, p.error?.name, String(p.error?.message).slice(0, 100));
  }
  console.log("  fr:", await result.finishReason);
});

// J. multiple tool calls in one round
await scenario("J. two tool calls one round", async () => {
  const provider = makeProvider([sseResponse([
    toolCallStart(0, "c1", "studio_echo"), toolCallArgs(0, '{"message":"a"}'),
    toolCallStart(1, "c2", "studio_echo"), toolCallArgs(1, '{"message":"b"}'),
    finish("tool_calls"), DONE,
  ])], []);
  const result = streamText({ model: provider.chatModel("m"), messages: [{ role: "user", content: "go" }], tools: { studio_echo: jsonEcho }, maxRetries: 0 });
  const callsSeen = [];
  for await (const p of result.fullStream) if (p.type === "tool-call") callsSeen.push(`${p.toolCallId}:${JSON.stringify(p.input)}`);
  console.log("  RESULT calls:", callsSeen.join(" | "));
});

// K. user-agent header + full header set
await scenario("K. headers", async () => {
  const calls = [];
  const provider = makeProvider([sseResponse([finish("stop"), DONE])], calls);
  const result = streamText({ model: provider.chatModel("m"), messages: [{ role: "user", content: "hi" }], maxRetries: 0 });
  for await (const _p of result.fullStream) { }
  console.log("  RESULT headers:", JSON.stringify(calls[0].headers));
});
