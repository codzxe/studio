#!/usr/bin/env node
/**
 * scripts/dev/zai-shim.mjs — a local OpenAI-compatible proxy in front of the
 * z-ai SDK (GLM), so `MOCK_MODEL=false LITELLM_BASE_URL=http://localhost:4000`
 * gives the gateway a REAL model with zero external repo deps.
 *
 * Why this exists: the dev box has no LiteLLM proxy and no Docker (see
 * scripts/dev-litellm.sh), but the z-ai-web-dev-sdk (backend-only) reaches
 * GLM. The SDK's chat.completions API is *almost* OpenAI-shaped: it accepts
 * { model?, messages, stream, thinking, tools, tool_choice } and multi-turn
 * transcripts with assistant.tool_calls + role:"tool" echo rows, and its
 * STREAM yields raw OpenAI SSE frames as byte arrays — so the shim is mostly
 * a pipe with framing repair.
 *
 * Endpoints:
 *   POST /v1/chat/completions  (stream + non-stream; tools pass through)
 *   GET  /v1/models            (LiteLLM-compatible stub)
 *   GET  /health, /v1/health
 *
 * Env:
 *   PORT        default 4000 (the dev:ready LITELLM_BASE_URL default)
 *   ZAI_MODEL   default glm-4.7 (what every alias maps to)
 *   ZAI_SDK_PATH  explicit path to the SDK's dist/index.js (optional; the
 *                 sandbox bun cache is probed automatically)
 *
 * Run:  node scripts/dev/zai-shim.mjs   (plain node — no tsx watch; the
 *       sandbox's inotify budget is spent, see 08fe4f8)
 */

import { createServer } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const PORT = Number(process.env.PORT ?? 4000);
const ZAI_MODEL = process.env.ZAI_MODEL ?? "glm-4.7";

// ---------------------------------------------------------------------------
// z-ai-web-dev-sdk resolution (dev-only; NOT a repo dependency)
// ---------------------------------------------------------------------------

const SDK_CANDIDATES = [
  // 1. a real install (repo node_modules / global)
  "z-ai-web-dev-sdk",
  // 2. the dev box's bun cache (newest version first)
  ...(() => {
    const cache = path.join(os.homedir(), ".bun/install/cache/z-ai-web-dev-sdk");
    if (!existsSync(cache)) return [];
    return readdirSync(cache)
      .map((entry) => path.join(cache, entry, "dist/index.js"))
      .filter((entry) => existsSync(entry))
      .sort()
      .reverse();
  })(),
  // 3. explicit override
  process.env.ZAI_SDK_PATH,
].filter((entry) => typeof entry === "string" && entry !== "");

async function loadSdk() {
  for (const candidate of SDK_CANDIDATES) {
    try {
      const mod = await import(
        candidate.startsWith("/") || candidate.startsWith(".") ?
          `file://${candidate}`
        : candidate
      );
      return mod.default ?? mod;
    } catch {
      // try the next candidate
    }
  }
  throw new Error(
    "z-ai-web-dev-sdk not found. Install it, or set ZAI_SDK_PATH to its dist/index.js.",
  );
}

const ZAI = await loadSdk();
let zai = null;

async function client() {
  if (zai === null) zai = await ZAI.create();
  return zai;
}

// ---------------------------------------------------------------------------
// SSE plumbing
// ---------------------------------------------------------------------------

const decoder = new TextDecoder();

/** The SDK's stream yields byte arrays / strings of RAW OpenAI SSE frames. */
function chunkToText(chunk) {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return decoder.decode(chunk);
  if (chunk && typeof chunk[Symbol.iterator] === "function") {
    let out = "";
    for (const byte of chunk) out += String.fromCharCode(byte);
    return out;
  }
  return String(chunk);
}

/**
 * Write complete frames from `text` (plus `carry`) to `res`; returns the
 * leftover partial frame. `onDone` reports a [DONE] terminator passing through.
 */
function pumpFrames(text, carry, res, onDone) {
  let buffer = carry + text;
  for (;;) {
    const index = buffer.indexOf("\n\n");
    if (index === -1) break;
    const frame = buffer.slice(0, index + 2);
    buffer = buffer.slice(index + 2);
    if (frame.includes("[DONE]")) onDone(true);
    res.write(frame);
  }
  return buffer;
}

/** Extracts complete "data: ..." frames; returns [events, leftover]. */
function parseFrames(buffer) {
  const events = [];
  let text = buffer;
  for (;;) {
    const index = text.indexOf("\n\n");
    if (index === -1) break;
    const frame = text.slice(0, index + 2);
    text = text.slice(index + 2);
    const payload = frame.replace(/^data:\s*/m, "").trim();
    if (payload === "" || payload === "[DONE]") continue;
    try {
      events.push(JSON.parse(payload));
    } catch {
      // skip malformed frames
    }
  }
  return [events, text];
}

// ---------------------------------------------------------------------------
// The proxy
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = req.url ?? "/";

  if (req.method === "GET" && (url === "/health" || url === "/v1/health")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", model: ZAI_MODEL }));
    return;
  }

  if (req.method === "GET" && (url === "/v1/models" || url === "/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        object: "list",
        data: [
          { id: "studio-fast", object: "model", owned_by: "zai" },
          { id: "studio-smart", object: "model", owned_by: "zai" },
          { id: "studio-vision", object: "model", owned_by: "zai" },
          { id: ZAI_MODEL, object: "model", owned_by: "zai" },
        ],
      }),
    );
    return;
  }

  if (req.method === "POST" && url.replace(/\/$/, "").endsWith("/chat/completions")) {
    let body = "";
    req.on("data", (part) => {
      body += part;
    });
    req.on("end", async () => {
      let request;
      try {
        request = JSON.parse(body);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid JSON body" } }));
        return;
      }

      try {
        const zaiClient = await client();
        const upstream = await zaiClient.chat.completions.create({
          // Every gateway alias maps to the one real model.
          model: ZAI_MODEL,
          messages: request.messages ?? [],
          stream: true,
          thinking: { type: "disabled" },
          ...(Array.isArray(request.tools) && request.tools.length > 0 ?
            { tools: request.tools, tool_choice: request.tool_choice ?? "auto" }
          : {}),
        });

        if (request.stream === true) {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          let carry = "";
          let sawDone = false;
          let closed = false;
          req.on("close", () => {
            closed = true;
          });
          for await (const chunk of upstream) {
            if (closed) break;
            carry = pumpFrames(chunkToText(chunk), carry, res, (done) => {
              sawDone = done;
            });
          }
          if (!closed) {
            // Flush any tail frame + guarantee the terminator.
            const tail = carry;
            if (tail !== "") res.write(tail.endsWith("\n\n") ? tail : `${tail}\n\n`);
            if (!sawDone) res.write("data: [DONE]\n\n");
            res.end();
          }
        } else {
          // Aggregate the stream into one completion response.
          let id = `zai-${Date.now()}`;
          let created = Math.floor(Date.now() / 1000);
          let model = ZAI_MODEL;
          const contentParts = [];
          const toolCalls = [];
          let finishReason = "stop";
          let carry = "";
          for await (const chunk of upstream) {
            const [events, leftover] = parseFrames(carry + chunkToText(chunk));
            carry = leftover;
            for (const event of events) {
              if (typeof event.id === "string") id = event.id;
              if (typeof event.created === "number") created = event.created;
              if (typeof event.model === "string") model = event.model;
              const delta = event.choices?.[0]?.delta;
              if (typeof delta?.content === "string") contentParts.push(delta.content);
              if (Array.isArray(delta?.tool_calls)) {
                for (const call of delta.tool_calls) {
                  const slotIndex = call.index ?? toolCalls.length;
                  const slot = toolCalls[slotIndex] ?? {
                    id: `call_${slotIndex}`,
                    type: "function",
                    function: { name: "", arguments: "" },
                  };
                  if (call.id) slot.id = call.id;
                  if (call.function?.name) slot.function.name = call.function.name;
                  if (call.function?.arguments) {
                    slot.function.arguments += call.function.arguments;
                  }
                  toolCalls[slotIndex] = slot;
                }
              }
              if (event.choices?.[0]?.finish_reason) {
                finishReason = event.choices[0].finish_reason;
              }
            }
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              id,
              object: "chat.completion",
              created,
              model,
              choices: [
                {
                  index: 0,
                  finish_reason: finishReason,
                  message: {
                    role: "assistant",
                    content: contentParts.join(""),
                    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
                  },
                },
              ],
            }),
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[zai-shim] upstream failed:", message);
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: `zai upstream: ${message}` } }));
        } else {
          res.end();
        }
      }
    });
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: `no route ${req.method} ${url}` } }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `[zai-shim] OpenAI-compatible GLM proxy on http://127.0.0.1:${PORT} (model ${ZAI_MODEL})`,
  );
});
