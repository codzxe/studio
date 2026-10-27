// Probe round 6: corrected v7 tool-result output shapes + wire dump.
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText } from "ai";

const enc = new TextEncoder();
const frame = (data) => `data: ${JSON.stringify(data)}\n\n`;
const DONE = "data: [DONE]\n\n";
const sseResponse = (frames) => new Response(
  new ReadableStream({ start(c) { for (const f of frames) c.enqueue(enc.encode(f)); c.close(); } }),
  { status: 200, headers: { "content-type": "text/event-stream" } },
);

const calls = [];
const provider = createOpenAICompatible({
  name: "litellm", baseURL: "http://127.0.0.1:4000/v1", apiKey: "sk",
  fetch: async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers, body: JSON.parse(String(init?.body)) });
    return sseResponse([frame({ choices: [{ delta: { content: "ok" } }] }), frame({ choices: [{ delta: {}, finish_reason: "stop" }] }), frame({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } }), DONE]);
  },
  includeUsage: true,
});

// The adapter's conversion: OpenAIChatMessage[] -> ModelMessage[] + instructions
const openaiMessages = [
  { role: "system", content: "You are the Studio agent." },
  { role: "user", content: "what is on this comp?" },
  { role: "assistant", content: "Let me check.", tool_calls: [{ id: "call_get", type: "function", function: { name: "studio_get_context", arguments: '{"question":"layers?"}' } }] },
  { role: "tool", tool_call_id: "call_get", content: JSON.stringify({ comps: 3, layers: 7 }) },
  { role: "user", content: "thanks" },
];

function toModelMessages(messages) {
  const system = [];
  const rest = [];
  for (const m of messages) {
    if (m.role === "system") { system.push(m.content); continue; }
    if (m.role === "assistant" && m.tool_calls?.length) {
      rest.push({
        role: "assistant",
        content: [
          ...(m.content ? [{ type: "text", text: m.content }] : []),
          ...m.tool_calls.map((c) => ({ type: "tool-call", toolCallId: c.id, toolName: c.function.name, input: JSON.parse(c.function.arguments || "{}") })),
        ],
      });
      continue;
    }
    if (m.role === "tool") {
      let parsed;
      try { parsed = JSON.parse(m.content); } catch { parsed = m.content; }
      rest.push({
        role: "tool",
        content: [{ type: "tool-result", toolCallId: m.tool_call_id, toolName: "studio_get_context", output: { type: typeof parsed === "string" ? "text" : "json", value: parsed } }],
      });
      continue;
    }
    rest.push({ role: m.role, content: m.content });
  }
  return { instructions: system.join("\n\n"), messages: rest };
}

const { instructions, messages } = toModelMessages(openaiMessages);
const result = streamText({
  model: provider.chatModel("studio-smart"),
  instructions,
  messages,
  maxRetries: 0,
});
const parts = [];
for await (const part of result.fullStream) {
  parts.push(part.type);
  if (part.type === "finish-step") console.log("finish-step:", part.finishReason, "usage:", part.usage?.inputTokens, part.usage?.outputTokens);
  if (part.type === "error") console.log("error part:", part.error?.name, part.error?.message?.slice(0, 120));
}
console.log("parts:", parts.join(","));
const r = await result;
console.log("finishReason:", JSON.stringify(r.finishReason));
console.log("WIRE url:", calls[0].url);
console.log("WIRE auth:", calls[0].headers?.authorization);
console.log("WIRE body keys:", Object.keys(calls[0].body).join(","));
console.log("WIRE stream_options:", JSON.stringify(calls[0].body.stream_options));
console.log("WIRE messages:", JSON.stringify(calls[0].body.messages, null, 2));
