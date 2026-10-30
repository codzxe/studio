# TS AI Agent Frameworks — Evaluation for Replacing the Hand-Rolled Tool-Calling Loop

**Task ID:** 12-w1-r2 · **Date:** 2026-10-26 · **Method:** live npm registry JSON (registry.npmjs.org) + official docs fetched as markdown (`mastra.ai/docs/*.md`, `ai-sdk.dev/docs/*.md`, `docs.langchain.com/oss/javascript/*.md`, `developers.cloudflare.com/agents/*.md`, `openai.github.io/openai-agents-js/llms-small.txt`, `voltagent.dev/llms.txt`, `pikku` npm/registry). No memory-only claims — every version below was read from the registry/docs today.

## 0. Our constraints (from worklog)

- Node 22, pnpm monorepo, Vercel (icn1) + Supabase PG; gateway = `services/gateway` with a **hand-rolled LLM loop** (`src/litellm/openai.ts`, fetch against OpenAI-compatible Token Harbor, alias→wire model map).
- Tools execute **partially remote**: plan/edit proposals are carried by write-tools and executed by the **editor client** through the `/v1/runs/:id/events` SSE seam; runs are rows in our own DB; auto-apply policy D-28; message history fully ours.
- Need: server-side multi-step tool loop against OpenAI-compatible provider, client-bridge tools, **full message-history control**, SSE to browser, no vendor lock-in, minimal deps.

## 1. Current versions (npm registry, 2026-10-26)

| Framework / package | Version | Notes |
|---|---|---|
| **Mastra** `@mastra/core` | **1.79.0** (published 2026-10-21) | 1.0.0 shipped 2026-01-20; no "2.0" (dist-tags: latest 1.79.0, alpha 1.80.0-alpha.3) |
| `mastra` (CLI) | 1.35.0 | dev/deploy CLI |
| `@mastra/memory` | 1.39.0 | separate memory package |
| `@mastra/ai-sdk` | 1.11.2 | AI SDK interop layer (UIMessage ↔ Mastra) |
| `@mastra/pg` / `@mastra/libsql` | 1.32.0 / 1.27.0 | storage adapters |
| **Vercel AI SDK** `ai` | **7.0.153** (2026-10-24) | v6.0.0 shipped 2025-12-22 (v6 line still maintained: 6.0.315); **v7.0.0 shipped 2026-06-25** |
| `@ai-sdk/openai` / `@ai-sdk/openai-compatible` | 4.0.102 / 3.0.78 | openai-compatible = any baseURL |
| `@ai-sdk/react` | 4.0.157 | `useChat` SSE client |
| `@ai-sdk/harness` (+ adapters claude-code/codex/pi/opencode, sandbox-vercel/just-bash) | 1.0.164–1.0.168 | harness abstraction (see §4) |
| **LangGraph.js** `@langchain/langgraph` | **1.5.2** (2026-10-21) | 1.0.0 shipped 2025-10-18 |
| `langchain` / `@langchain/core` | 1.5.19 / 1.3.0 | `createAgent` harness lives here |
| **Cloudflare Agents SDK** `agents` | **0.30.1** (2026-10-23) | still 0.x |
| **LlamaIndex.TS** `llamaindex` | **0.12.1** (published 2025-12-02; `@llamaindex/core` 0.6.23, 2026-03-09) | ~10 months without a main-package release — maintenance slowed |
| **Pikku** `@pikku/core` | **0.12.148** (2026-10-25 — very actively released) | server framework + thin AI glue |
| **VoltAgent** `@voltagent/core` | **2.11.0** (2026-09-28) | v2 is current |
| **Agno** | Python-only (npm `agno` 1.0.0 is an unrelated "Agnostic Migrations" package) | no official TS framework |
| **OpenAI Agents SDK (JS)** `@openai/agents` | **0.21.0** (2026-10-20) | requires zod v4 |
| **Claude Agent SDK (TS)** `@anthropic-ai/claude-agent-sdk` | 0.3.310 (2026-10-23) | Claude Code harness as a library |
| **TanStack AI** `@tanstack/ai` | 1.0.0 (new 2026 entrant) | type-safe streaming SDK; emits **AG-UI** events (`@ag-ui/core` 1.0.3) |
| **MCP TS SDK** `@modelcontextprotocol/sdk` | 1.32.2 | streamable-HTTP transport = network tool bridging |
| Harness CLIs: `@openai/codex` 0.164.0 · `@google/gemini-cli` 0.65.0 · `@opencode/cli` 2.1.4 (`opencode-ai` legacy line 1.19.4) · `@earendil-works/pi-coding-agent` 1.4.0 (Pi) | | |

## 2. Mastra (deep dive)

**What it is (Oct 2026):** full-stack agent platform: Agent runtime + memory + workflows + evals + tracing + deployers + CLI/Studio. OSS core Apache-2.0; Mastra Cloud optional.

**Agent loop API:** `new Agent({ id, name, instructions, model, tools })` from `@mastra/core/agent`; `.generate(messages, options)` / `.stream(...)` returning `MastraModelOutput` (`textStream`, promises for `toolCalls`, `toolResults`, `steps`, `usage`). `messages` accepts `string | string[] | CoreMessage[]` (AI SDK CoreMessages) — **we can pass our own full history every call**. Options include `maxSteps` (default 5), `stopWhen`, `system`, `context`, `prepareStep`, `clientTools`, `savePerStep`, `onIterationComplete` (fires with the complete accumulated `messages` array — full history control). Models: `'provider/model'` strings via the model router, or raw **AI SDK provider objects** — Mastra depends on `@ai-sdk/provider-v5/v6/v7` (+ `@mastra/schema-compat`), so **it is built on the Vercel AI SDK provider ecosystem** and supports custom OpenAI-compatible gateways via `createOpenAICompatible` from `@ai-sdk/openai-compatible-v5` wrapped in a custom Gateway (`models/gateways/custom-gateways` doc).

**Tools:** `createTool({ id, description, inputSchema (zod/standard-schema), outputSchema, execute(inputData, context), suspendSchema, resumeSchema })`. Hooks run around every tool call; `transform` shapes payloads for UI/transcript.

**Client-bridge tools (exactly our pattern):** a tool **without `execute`** = client tool: run ends with `finishReason: 'tool-calls'`, client executes, appends the result, re-sends. `options.clientTools` declares client-side tools per call; `toModelOutput` remaps the returned result server-side. Subagents cannot run client tools (documented limitation). Alternative in-run pattern: call `suspend()` inside `execute` → stream emits `tool-call-suspended` chunk with `suspendPayload` → resume with `agent.resumeStream()/resumeGenerate({…}, {runId})`. There is even a built-in `submitPlanTool` (Cursor-style plan submission + approval) and `askQuestionTool`.

**Memory/storage:** `Memory` requires a storage adapter (LibSQL/PG/Mongo/…, ~20 adapters). **BUT storage is optional for agents**: the runtime defaults to an **in-memory store**; without `memory` configured, the agent is a stateless loop — we keep history in our own tables and pass it in. Workflows (suspend/resume/snapshots), observability, durable agents (`createDurableAgent`, resumable streams, crash recovery), evals, schedules DO require persistent storage.

**Workflows:** typed graph/steps engine (branching, suspend/resume, snapshots, time travel, scheduled runs, Inngest runner) — a durable-execution engine, not needed for a single agent loop.

**Overhead / lock-in:** `@mastra/core` 1.79.0 = **79 MB unpacked, 30 runtime deps** (ws, hono, re2js, xxhash-wasm, jpeg-js, croner, execa, posthog-node, A2A SDKs, AI SDK provider shims…). Heavy for one loop; bundles its own server stack (hono) and telemetry dep (posthog-node) — audit opt-out flags before adoption. No cloud lock-in for the core (OSS; deploy anywhere; `MASTRA_OFFLINE` env exists for some remote fetches), but the happy path (CLI, Studio, deployers, Cloud) nudges toward its conventions.

**Verdict:** Yes, you *can* use **just Agent+tools without its storage layer** (pass history yourself; skip memory/workflows). You get the richest built-in client-bridge/HITL primitives in any framework today. Cost = dependency weight.

## 3. Vercel AI SDK v7 (ai 7.0.153)

- v6 (Dec 2025) → v7 (Jun 2026, current; v6 still patched in parallel). `ai` has **3 runtime deps** (`@ai-sdk/provider`, `@ai-sdk/provider-utils`, `@ai-sdk/gateway`).
- **`ToolLoopAgent`** class is now the recommended loop: `new ToolLoopAgent({ model, tools, instructions, stopWhen, prepareStep, toolApproval, runtimeContext })`, `.generate()/.stream()`; default stop `isStepCount(20)`; `stopWhen: [isStepCount(n), hasAnswer…]`; **`prepareStep({ stepNumber, messages, … })` can rewrite the message array between steps** → compaction / full history control.
- **Tool approvals:** per-tool or generic `toolApproval` policy returning `'approved' | 'user-approval' | {type:'denied'}`; `'user-approval'` pauses the run and emits a `tool-approval-request` — the Cursor-style approval seam, built into the loop.
- **Client-bridge tools:** tools without `execute` finish with `finishReason 'tool-calls'`; `useChat` executes client-side tools (`onToolCall`/`addToolResult`) and `sendAutomaticallyWhen` re-submits the transcript with tool results — the exact remote-tool-over-UI-runtime bridge, browser-native.
- **Provider:** `@ai-sdk/openai-compatible` (`createOpenAICompatible({ baseURL, apiKey, name })`) → Token Harbor in one line. No Vercel account needed (Gateway optional; `@ai-sdk/gateway` is a dep but not a requirement).
- **SSE to browser:** `toUIMessageStreamResponse` / `createAgentUIStreamResponse` give ready-made SSE endpoints; or map `fullStream` onto our existing `/v1/runs/:id/events` event contract.
- **NEW: harness layer** (`@ai-sdk/harness` 1.0.164 + adapters `harness-claude-code/-codex/-pi/-opencode`, sandboxes `sandbox-vercel`/`sandbox-just-bash`): `HarnessAgent` runs a preconfigured harness (Claude Code, Codex, Pi, OpenCode) behind a sandbox session and **streams it into AI SDK-compatible result/UI primitives** — the ecosystem is standardizing "editor-like harness as a provider."
- Extras: MCP client built in (`createMcpClient`), `@ai-sdk/tui` terminal UI, message-finish reasons/usage/token accounting consistent across providers.

## 4. LangGraph.js 1.5.2 (+ langchain 1.5.19)

- Two layers: **LangGraph** = low-level Pregel-style graph runtime (StateGraph + new `StateSchema` in v1; durable execution, threads, checkpointers, interrupts) and **`langchain`'s `createAgent`** = the prebuilt tool-calling loop (model string `provider:model`, middleware system incl. human-in-the-loop middleware `interruptOn: { writeFile: true }`, `streamEvents`, `AgentState` with custom state schemas).
- **Checkpointers are required** for: human-in-the-loop/interrupts, thread memory, time travel, fault tolerance. `MemorySaver` (in-memory) ships in-box; `@langchain/langgraph-checkpoint-postgres` (PostgresSaver) is a separate install. So HITL-style pauses are coupled to the checkpointer/thread model — we'd be running their persistence alongside ours unless we avoid interrupts.
- Streaming: `streamEvents`/`.stream()` with modes (values, updates, events) — event stream to SSE is a manual mapping; `@langchain/langgraph-sdk` + LangGraph Server/Platform (Deployment) exist but are optional.
- Package: 4.4 MB unpacked, 4 deps (+ peer `@langchain/core`, zod) — moderate. Complexity: highest of the three majors for a single-loop agent (graph paradigm pays off only for durable multi-node workflows). No checkpointer needed if you just run a graph to completion in-process, but then it's mostly a fancier loop than our hand-rolled one.

## 5. Others (quick verdicts)

- **Cloudflare Agents SDK 0.30.1:** clean layering — harness (loop) / runtime (Agent class, Durable Objects, state, sessions, WebSockets, scheduling, fibers) / tools (browser, sandbox, AI Search, MCP, payments, **Code Mode**: model writes code that composes tools, with durable approvals/rollback and a **browser iframe executor** for browser-owned tools). Default start is the **Pi harness** (`@earendil-works/pi-durable` running the loop inside a DO). **Hard runtime lock-in: Durable Objects/Workers** — not portable to our Vercel/Node gateway; worth mining for architecture patterns (esp. Code Mode bridging).
- **LlamaIndex.TS:** main package last released 2025-12-02; agent API exists but momentum has moved to Python. Not recommended for new TS agent loops in 2026.
- **Pikku 0.12.148:** typed server framework (code-gen'd functions/wirings, session/kysely services, `@pikku/ai-vercel` = "Vercel AI SDK agent runner for Pikku"). Its AI story is a thin wrapper over AI SDK — pick AI SDK directly.
- **VoltAgent 2.11.0:** MIT, batteries-included (agents, tools, memory, RAG, voice, VoltOps observability) **built on @ai-sdk/\* providers**; 12.3 MB, ~20 AI SDK provider deps — heavier and more opinionated than raw AI SDK; nice DX but a whole platform.
- **Agno:** Python-only; the npm `agno` package is unrelated (migrations/seeder). Skip for TS.
- **OpenAI Agents SDK JS 0.21.0:** genuinely lightweight (`@openai/agents-core/-openai/-realtime`; zod v4). `OpenAIProvider` supports `baseURL` for **OpenAI-compatible endpoints** (works with Token Harbor), Chat Completions mode selectable; but provider surface is OpenAI-shaped (handoffs/guardrails/Responses-first), tracing defaults to OpenAI (can disable), and no browser client-tool seam. Good if we were OpenAI-only.
- **Claude Agent SDK 0.3.310:** Claude Code's harness programmable in TS ("understand codebases, edit files, execute workflows"); tool executions happen in its sandbox with permission callbacks. Relevant only if we adopt an Anthropic-centric coding harness, not as our loop.
- **TanStack AI 1.0.0:** brand-new type-safe streaming chat/tool-calling SDK emitting **AG-UI** (`@ag-ui/core`) events — an "agent→UI" event protocol worth watching for our SSE contract, but 1.0.0-fresh.
- **Newcomer harnesses (2026):** Pi (minimal, extensible, RPC + TS SDK, Node ≥22.19), OpenCode 2.x (client/server: TUI/WebUI ↔ server over HTTP/SSE, tools server-side, `@opencode/sdk` 2.1.4), Codex CLI 0.164.0 (Rust core + `app-server` JSON-RPC for IDE bridging), Gemini CLI 0.65.0.

## 6. Editor-style harness bridging — how the world does it

1. **Client-tools pattern** (AI SDK, Mastra): tool declared without `execute`; run pauses (`finishReason 'tool-calls'` / `tool-call-suspended`); the **UI runtime executes** and the transcript + tool result is re-sent on the next request. Mastra adds `clientTools` + `suspend()/resumeStream(runId)` for resumable pauses with structured payloads. (≈ our current `/v1/runs/:id/events` design.)
2. **Approvals as a loop status** (AI SDK v7 `toolApproval` → `tool-approval-request`; Mastra `requireApproval`/suspended approvals; LangGraph `interrupt()` + checkpointer; Cloudflare Code Mode durable approvals): the harness pauses *in-process* and resumes — stronger than "end the turn and call back".
3. **MCP streamable HTTP** (`@modelcontextprotocol/sdk` 1.32.2): tools live in a remote server; the agent loop is an MCP client; tool calls/results bridge over HTTP+SSE. Standard, language-agnostic, but adds a server-side process.
4. **A2A** (`@a2a-js/sdk-v1`, used by Mastra): agent-to-agent task protocol — for cross-system delegation, not UI bridging.
5. **AI SDK `HarnessAgent` + sandbox adapters** (new in v7): runs Claude Code/Codex/Pi/OpenCode **remotely in a sandbox** and bridges their streams into AI SDK UI messages — the first standardized "harness-as-provider" seam; maps to how Cursor-like products embed mature coding agents.
6. **Cloudflare Code Mode iframe executor:** model-generated code executes against **browser-owned tools** in an iframe with host-side auth/approval — closest published analogue to executing editor tools in the browser from a server-side agent.

## 7. Recommendation for our case

**Rank 1 — Vercel AI SDK v7 core (`ai` + `@ai-sdk/openai-compatible`):** the exact shape we need with the least machinery — `ToolLoopAgent` loop, `prepareStep` full history control, client tools + `toolApproval` pause semantics for the editor bridge, `createOpenAICompatible` for Token Harbor, SSE via `toUIMessageStreamResponse` or mapped onto our existing run-events seam, 3 runtime deps, zero platform coupling (Gateway/cloud optional). v6→v7 is current and actively patched (7.0.153, Oct 24, 2026).

**Rank 2 — Mastra (`@mastra/core`, agent+tools only, storage skipped):** the richest first-class primitives for our hard problems (clientTools, `suspend/resumeGenerate`, `submitPlanTool`, resumable streams, built on the same AI SDK providers we'd use anyway) — but 79 MB / 30 deps incl. hono+posthog for one loop; adopt if we also want its workflows/evals/tracing later.

**Rank 3 — LangGraph.js 1.5.2:** only if we grow into durable multi-node orchestration; for a single loop the graph+checkpointer machinery adds complexity without payoff, and its HITL is coupled to checkpoint threads (a second persistence system next to ours).

Keep: MCP/AG-UI on the radar as interchange formats; Cloudflare Code Mode + AI SDK HarnessAgent as reference architectures for editor-like control; LlamaIndex.TS (stale), Agno (no TS), Cloudflare Agents SDK (Workers lock-in), VoltAgent/Pikku (thin layers over AI SDK), OpenAI Agents SDK (OpenAI-shaped) — not recommended here.

**Honest caveat:** our hand-rolled loop already implements the core pattern well; the concrete wins from adopting AI SDK v7 are battle-tested streaming/usage accounting, provider-agnostic retry/tool-calling quirks handling, and the `toolApproval`/client-tool pause semantics we currently emulate via `finishReason` + plan events. A migration could be incremental: implement `OpenAIClientDeps`-style provider via `createOpenAICompatible` behind our `LITELLM_MODEL_MAP` seam, then swap the loop internals.
