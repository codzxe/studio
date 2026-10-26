// Isolate the failing ModelMessage shape.
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText } from "ai";

const enc = new TextEncoder();
const frame = (data) => `data: ${JSON.stringify(data)}\n\n`;
const sseResponse = (frames) => new Response(
  new ReadableStream({ start(c) { for (const f of frames) c.enqueue(enc.encode(f)); c.close(); } }),
  { status: 200, headers: { "content-type": "text/event-stream" } },
);
const DONE = "data: [DONE]\n\n";

const calls = [];
const provider = createOpenAICompatible({
  name: "litellm", baseURL: "http://127.0.0.1:4000/v1", apiKey: "sk",
  fetch: async (url, init) => { calls.push(JSON.parse(String(init?.body))); return sseResponse([frame({ choices: [{ delta: { content: "ok" } }] }), frame({ choices: [{ delta: {}, finish_reason: "stop" }] }), DONE]); },
  includeUsage: true,
});

async function tryMessages(name, messages) {
  try {
    const result = streamText({
      model: provider.chatModel("studio-smart"),
      instructions: "sys",
      messages,
      maxRetries: 0,
    });
    for await (const _ of result.fullStream) {}
    console.log(`${name}: OK`);
    return true;
  } catch (error) {
    const detail = error?.cause?.error?.errors ?? error?.cause?.message ?? error?.message;
    console.log(`${name}: FAIL —`, String(detail).slice(0, 400));
    return false;
  }
}

await tryMessages("1 user-string", [{ role: "user", content: "hi" }]);
await tryMessages("2 assistant-text-only", [
  { role: "user", content: "hi" },
  { role: "assistant", content: [{ type: "text", text: "hello" }] },
]);
await tryMessages("3 assistant-toolcall", [
  { role: "user", content: "hi" },
  { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "t", input: { q: 1 } }] },
]);
await tryMessages("4 tool-result", [
  { role: "user", content: "hi" },
  { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "t", input: { q: 1 } }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "t", output: { a: 1 } }] },
]);
await tryMessages("5 tool-result-string-output", [
  { role: "user", content: "hi" },
  { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "t", input: { q: 1 } }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "t", output: "{\"a\":1}" }] },
]);
console.log("\nWIRE (last successful):", JSON.stringify(calls.at(-1)?.messages, null, 2));
