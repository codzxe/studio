#!/usr/bin/env node
// Round 10 — NVIDIA NIM candidate test: chat sanity + TOOL CALLING (the
// composition-creation path) + tool STREAMING, for the models shortlisted
// from /v1/models. Direct sandbox calls (NIM is not region-blocked).

const KEY = "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";
const BASE = "https://integrate.api.nvidia.com/v1/chat/completions";

const CANDIDATES = [
  "moonshotai/kimi-k2.6",
  "nvidia/nemotron-3-super-120b-a12b",
  "deepseek-ai/deepseek-v4.1-flash",
  "z-ai/glm-5.3-flash",
  "nvidia/nemotron-3.5-super-vl-120b-a12b",
];

const TOOLS = [
  {
    type: "function",
    function: {
      name: "studio_get_context",
      description: "Read the current project context: compositions, layers, selection, playhead.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "studio_plan_edit",
      description:
        "Propose a structured edit plan to create or modify compositions, layers, keyframes and typography.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short plan title." },
          steps: {
            type: "array",
            description: "Ordered edit operations.",
            items: {
              type: "object",
              properties: {
                op: { type: "string", description: "create_composition | create_text_layer | set_keyframe | ..." },
                args: { type: "object" },
              },
              required: ["op", "args"],
            },
          },
        },
        required: ["title", "steps"],
      },
    },
  },
];

const TASK_PROMPT = "Create a composition called 'Launch Teaser' with a bold text layer saying HELLO.";

async function test(model) {
  const out = { model };
  try {
    // 1. plain chat
    let r = await fetch(BASE, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Say BANANA." }],
        max_tokens: 30,
        stream: false,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    let j = await r.json().catch(() => ({ raw: "unparsable" }));
    out.chat = r.status === 200 ? (j.choices?.[0]?.message?.content ?? "").slice(0, 60) : `HTTP ${r.status} ${JSON.stringify(j).slice(0, 160)}`;

    // 2. tool calling
    r = await fetch(BASE, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "You are Studio's motion-graphics editing agent. Use the provided tools to act on the project." },
          { role: "user", content: TASK_PROMPT },
        ],
        tools: TOOLS,
        tool_choice: "auto",
        max_tokens: 500,
        stream: false,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    j = await r.json().catch(() => ({ raw: "unparsable" }));
    const msg = j.choices?.[0]?.message;
    out.tool = r.status !== 200
      ? `HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`
      : msg?.tool_calls?.length
        ? `CALLS=${msg.tool_calls.map((c) => c.function?.name).join(",")}`
        : `no_tool_call content=${(msg?.content ?? "").slice(0, 80)}`;

    // 3. streaming with tools (gateway shape)
    r = await fetch(BASE, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: TASK_PROMPT }],
        tools: TOOLS,
        tool_choice: "auto",
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 500,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (r.status !== 200) {
      out.stream = `HTTP ${r.status} ${(await r.text()).slice(0, 120)}`;
    } else {
      const text = await r.text();
      const hasToolCall = text.includes('"tool_calls"') || text.includes("tool_calls");
      const hasDelta = text.includes("message.delta") || text.includes('"delta"');
      out.stream = `ok events=${text.split("\n\n").filter((s) => s.startsWith("data:")).length} tool=${hasToolCall} delta=${hasDelta}`;
    }
  } catch (e) {
    out.error = String(e).slice(0, 200);
  }
  console.log(JSON.stringify(out));
}

for (const m of CANDIDATES) {
  await test(m);
}
