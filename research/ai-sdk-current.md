# Vercel AI SDK — current state (October 2026) — research for gateway harness replacement

Task ID: 12-w1-r1. RESEARCH ONLY. Verified against npm registry JSON + live ai-sdk.dev docs (v7, release name "eve") on 2026-10-28. All API names below are copy-pasted from the official v7 docs (.md exports of ai-sdk.dev pages).

## 0. TL;DR — versions & install

| Package | Latest stable (npm `latest`) | Notes |
|---|---|---|
| `ai` | **7.0.153** | AI SDK v7 ("eve"). ESM-only, `engines.node >= 22` (matches our Node 22). peerDeps: `zod ^3.25.76 || ^4.1.8`. Deps: `@ai-sdk/gateway 4.0.x`, `@ai-sdk/provider 4.0.x`, `@ai-sdk/provider-utils 5.0.x`. |
| `@ai-sdk/openai-compatible` | **3.0.78** | The package we need for the OpenAI-compatible endpoint. peerDeps `zod ^3.25.76 || ^4.1.8`. |
| `@ai-sdk/react` | **4.0.157** | `useChat` / `Chat`. Depends on `ai 7.0.153`, `@ai-sdk/mcp`, `swr`. peer React `^18 || ~19.x || ^19.2.1`. |
| `@ai-sdk/openai` | 4.0.102 | (only if we ever hit real OpenAI) |
| `@ai-sdk/anthropic` | 4.0.88 | |
| `@ai-sdk/otel` | 1.0.153 | OpenTelemetry telemetry integration (new in v6/v7: `registerTelemetry(new OpenTelemetry())`). |
| `@ai-sdk/agent` | **does NOT exist** (registry 404) | The agent abstraction lives in the core `ai` package: `ToolLoopAgent` class + `Agent` interface. There is no separate `@ai-sdk/agent` module. |
| `ai` dist-tags | `latest 7.0.153`, `ai-v6 6.0.315`, `ai-v5 5.0.281`, `beta 7.0.0-beta.187`, `canary 7.0.0-canary.176` | i.e. current major = **7**. |

Install for our gateway + web:
```bash
pnpm add ai@7.0.153 @ai-sdk/openai-compatible@3.0.78        # services/gateway (server)
pnpm add @ai-sdk/react@4.0.157                               # apps/web (client) — brings ai transitively
pnpm add @ai-sdk/otel@1.0.153                               # optional, telemetry
```
(zod 3.25.76+ or 4.x already satisfies the peer range.)

## 1. Version timeline & the big renames (matters: most 2024/2025 blog code is stale)

- **v5 (May 2025)**: `parameters` → `inputSchema` in `tool()`; `args`→`input` on tool calls; `useChat` transport-based rework (`sendMessage`, `UIMessage.parts`, no `isLoading`); `stopWhen` + `stepCountIs` + `prepareStep` replace v4 `maxToolRoundtrips`; `fullStream`; `onFinish` deprecations started.
- **v6 (late 2025 / 2026)**: introduces the **`ToolLoopAgent`** class, `isLoopFinished()`, `runtimeContext`/`toolsContext`/`contextSchema`, `Agent` interface, `onEnd`/`onStepEnd` naming begins, resumable streams, `createAgentUIStreamResponse`.
- **v7 "eve" (current, 2026)**: renames stabilized. Official migration guide (`/docs/migration-guides/migration-guide-7-0`) ships **codemods**: `npx @ai-sdk/codemod v7/<name> src/`.

v7 renames we must use (old names are deprecated aliases or removed):

| v5/v6 name | v7 name |
|---|---|
| `stepCountIs(n)` | `isStepCount(n)` (codemod `v7/rename-step-count-is`) |
| `onStepFinish` | `onStepEnd` (codemod `v7/rename-on-step-finish-to-on-step-end`) |
| `onFinish` | `onEnd` (codemod `v7/rename-on-finish-to-on-end`) |
| `experimental_repairToolCall` | `repairToolCall` (stable; options now receive `instructions` instead of `system`) |
| `system` prompt option | `instructions` (system REJECTED in messages by default now — see §7) |
| `experimental_prepareStep` | `prepareStep` (removed) |
| `result.fullStream` | `result.stream` |
| `useChat: addToolResult` | `addToolOutput` (addToolResult deprecated) |
| `needsApproval` (on tool) | `toolApproval` (call-level; tool-level `needsApproval` deprecated fallback) |
| `experimental_onStart/onStepStart/onToolCallStart/onToolCallFinish` | `onStart` / `onStepStart` / `onToolExecutionStart` / `onToolExecutionEnd` |
| `experimental_telemetry` / `experimental_output` | `telemetry` / `output` (removed) |

## 2. Recommended agent harness (Oct 2026)

Docs: `/docs/agents/overview` ("The framework for building agents"). Official guidance, verbatim: **"For most use cases, start with the ToolLoopAgent. Use core functions (`generateText`, `streamText`) when you need explicit control over each step."**

### 2.1 `ToolLoopAgent` (THE agent class, exported from `ai`)
```ts
import { ToolLoopAgent, tool, isStepCount } from 'ai';
import { z } from 'zod';

const agent = new ToolLoopAgent({
  model,                    // LanguageModel instance (e.g. provider('model-id')) or gateway string 'anthropic/claude-sonnet-5.5'
  instructions: 'You are …', // system prompt — do NOT put role:'system' in messages (rejected by default)
  tools: {
    weather: tool({
      description: 'Get the weather in a location',
      inputSchema: z.object({ location: z.string().describe('…') }),
      execute: async ({ location }, { abortSignal, messages, toolCallId, context }) => ({ location, temperature: 72 }),
    }),
  },
  stopWhen: isStepCount(50),           // default is isStepCount(20)
  toolChoice: 'auto',                 // 'auto' | 'required' | 'none' | { type:'tool', toolName }
  runtimeContext: { requestId: '…' }, // shared state → prepareStep + callbacks
  toolsContext: { weather: { apiKey: process.env.K! } }, // per-tool typed context (matches contextSchema)
  repairToolCall: async ({ toolCall, tools, inputSchema, error, messages, instructions }) => { /* … return repaired or null */ },
  onStepEnd: ({ stepNumber, usage }) => { /* … */ },   // constructor-wide; also settable per generate()/stream() call
});

const result = await agent.generate({ prompt: '…', abortSignal, timeout: 60_000 });
// result.text, result.steps, result.responseMessages, result.toolCalls, result.staticToolCalls,
// result.totalUsage, result.finishReason, result.output (if output: Output.object was set)

const stream = await agent.stream({ prompt: '…' });   // StreamTextResult: .textStream, .stream, .responseMessages (promise), .consumeStream()
```
Full constructor surface (from `/docs/reference/ai-sdk-core/tool-loop-agent`): `model, id, instructions, allowSystemInMessages, tools, toolChoice, stopWhen, activeTools, toolOrder, toolCallConcurrency, toolApproval, experimental_toolCallers, output, prepareStep, include, repairToolCall, experimental_refineToolInput, onStart, onStepStart, onToolExecutionStart, onToolExecutionEnd, onStepEnd, onStepFinish (deprecated), onEnd, onFinish (deprecated), runtimeContext, toolsContext, telemetry, experimental_download, maxOutputTokens, temperature, topP, topK, presencePenalty, frequencyPenalty, stopSequences, seed, maxRetries, providerOptions, headers, callOptionsSchema, prepareCall`.

Methods: `generate(options)` / `stream(options)` (both accept `prompt | messages`, `abortSignal`, `timeout`, `options` (typed via `callOptionsSchema`), all lifecycle callbacks).

Why ToolLoopAgent: official reasons — less boilerplate, reusable config, one place to maintain; it handles the loop, context management, and stopping conditions. **This is the "battle-tested standard harness" to replace our hand-rolled loop.**

### 2.2 `Agent` interface + friends
- `Agent` (type, exported from `ai`) — the interface `ToolLoopAgent` implements (`version: 'agent-v1'`, `id`, `tools`, `generate()`, `stream()`). SDK utilities that accept an agent: `createAgentUIStream`, `createAgentUIStreamResponse`, `pipeAgentUIStreamToResponse`.
- `HarnessAgent` — run a *preconfigured external harness* (Claude Code, Codex, Pi, Cursor, OpenCode…) as an agent; irrelevant to us. Harnesses live under `@ai-sdk/...` packages listed at `/providers/ai-sdk-harnesses`.
- `WorkflowAgent` — separate abstraction for durable workflow orchestration (no default step limit; `@ai-sdk/workflow`-adjacent reference pages). Overkill for us.
- `@ai-sdk/tui` (`runAgentTUI`) — terminal UI for local dev of a ToolLoopAgent. Nice for debugging our gateway.
- API-route helper: `createAgentUIStreamResponse({ agent, uiMessages, ... })` → returns a `Response` streaming the `UIMessage` protocol that `useChat` consumes.

### 2.3 When core functions are still right
`generateText`/`streamText` (both from `ai`) remain fully supported for single generations, streaming, and fully manual loops (`while` + `result.responseMessages`). With `stopWhen` set they run multi-step internally. Recommended decision matrix from docs: agent-like → `ToolLoopAgent`; deterministic/structured control flow → core functions + explicit code.

## 3. Multi-step loops: `stopWhen`, `prepareStep`, steps

- Loop continues until: non-tool-calls finish reason, a called tool has **no `execute`**, a tool call **needs approval**, or a **stop condition** fires.
- Built-ins (from `ai`): `isStepCount(count)` (default `isStepCount(1)` for core fns; **20 for ToolLoopAgent**), `hasToolCall(...toolNames)`, `isLoopFinished()` (never triggers — unlimited; ToolLoopAgent logs a warning if you keep the implicit 20 default; explicit `stopWhen` silences it). Array = OR. Custom: `const cond: StopCondition<typeof tools> = ({ steps }) => boolean`.
- `stopWhen` conditions are only evaluated when the last step contains tool results.
- **`prepareStep: async ({ model, stopWhen, stepNumber, steps, instructions, initialInstructions, messages, initialMessages, responseMessages, runtimeContext, toolsContext, experimental_sandbox }) => ({})`** — may return `{ model, temperature, maxOutputTokens, topP, topK, presencePenalty, frequencyPenalty, stopSequences, seed, reasoning, activeTools, toolOrder, toolChoice, instructions, messages, experimental_sandbox }`. Returned `messages`/`instructions` **carry forward** to later steps (compaction pattern; `pruneMessages({ messages, reasoning:'all', toolCalls:'before-last-3-messages', emptyMessages:'remove' })` helper). Per-step model switching is a first-class pattern.
- Steps: `result.steps[]` per-step `{ text, toolCalls, toolResults, content, usage, performance, finishReason, responseMessages, … }`; `steps.flatMap(s => s.toolCalls)`.
- Forced tooling pattern: `toolChoice: 'required'` + a `done` tool **without execute** → loop stops on `done`; read the answer from `result.staticToolCalls[0].input.answer` (staticToolCalls = calls that were NOT executed).
- `toolCallConcurrency: 1` forces sequential tool execution in model order; default = all concurrent. Aborts are forwarded to active tools; queued calls never start.

## 4. Tools (`tool()`, `dynamicTool()`), execution options, approval

```ts
import { tool } from 'ai';

tool({
  description: '…' | ({ context, experimental_sandbox }) => string, // dynamic descriptions
  inputSchema: z.object({ … }),      // zod (3.25.76+/4) or jsonSchema()
  inputExamples: [{ input: { … } }], // Anthropic-only nicety
  contextSchema: z.object({ apiKey: z.string() }), // typed per-tool context, supplied via toolsContext
  strict: true,                      // provider strict mode, default false
  outputSchema: z.object({ … }),     // type inference only
  execute: async (input, options) => result,  // result | Promise | AsyncIterable (last yield = final)
  toModelOutput: ({ toolCallId, input, output }) => ToolResultOutput, // multimodal tool results → model
  onInputStart, onInputDelta, onInputAvailable,  // input lifecycle hooks
  providerOptions, metadata,
});
```
`ToolExecutionOptions<CONTEXT>` (2nd arg of `execute`):
- `toolCallId: string`
- `messages: ModelMessage[]` (history **sent to the model for that step**, incl. prior steps' text/tool calls/results; no system)
- `abortSignal?: AbortSignal` — forwarded from the call's `abortSignal`/`timeout`; forward into `fetch({ signal })` inside tools
- `context: CONTEXT` — from `toolsContext[toolName]`, typed by `contextSchema`
- `experimental_sandbox?: Experimental_SandboxSession`

Key facts:
- **Omitting `execute`** = the call is forwarded, never executed locally (client-side tool / stop signal). This is the hook for "another system resolves this".
- **AsyncIterable execute** = streaming/preliminary tool results (`async *execute` yields progress; last value is the final result; streaming tools hold their concurrency slot).
- `dynamicTool({...})` for runtime-defined tools; `toolCall.dynamic` narrows types.
- Tool errors thrown in `execute` become **`tool-error` content parts** sent back to the model in the next step (self-healing loop); NOT thrown to caller (in multi-step mode).
- Errors that DO throw: `NoSuchToolError`, `InvalidToolInputError`, `ToolCallRepairError`, `ToolChoiceViolationError` (all with `.isInstance(error)` static checks).
- Tool approval (server-side human gate): `toolApproval: { runCode: 'user-approval' | 'approved' | 'denied' | 'not-applicable' }` or object form `{ type: 'denied', reason: '…' }`, per-tool async functions, or one `GenericToolApprovalFunction`. Manual approval = generation ENDS with `tool-approval-request` parts in `result.content` (loop pauses; two-call pattern); resume by appending `{ role: 'tool', content: [{ type: 'tool-approval-response', approvalId, approved, reason }] }` and calling again. `addToolApprovalResponse` on the client.
- `activeTools: ['a','b']`, `toolOrder: ['search']` for caching-friendly stable ordering.

## 5. Tool-call repair — `repairToolCall` (stable, was `experimental_repairToolCall`)

```ts
import { generateText, NoSuchToolError, Output, tool } from 'ai';

generateText({
  model, tools, prompt,
  repairToolCall: async ({ toolCall, tools, inputSchema, error, messages, instructions }) => {
    if (NoSuchToolError.isInstance(error)) return null;          // give up on unknown tool names
    const t = tools[toolCall.toolName as keyof typeof tools];
    const { output: repairedArgs } = await generateText({
      model, output: Output.object({ schema: t.inputSchema }),
      prompt: `The model tried to call "${toolCall.toolName}" with ${JSON.stringify(toolCall.input)}. Schema: ${JSON.stringify(await inputSchema({ toolName: toolCall.toolName }))}. Fix the inputs.`,
    });
    return { ...toolCall, input: JSON.stringify(repairedArgs) };  // return null = unrepairable
  },
});
```
Alternative "re-ask" strategy shown in docs: push `{ role:'assistant', content:[{ type:'tool-call', toolCallId, toolName, input }] }` + `{ role:'tool', content:[{ type:'tool-result', toolCallId, toolName, output: error.message }] }` back into a fresh `generateText` with the same tools and take its corrected tool call. Without repair, invalid calls round-trip through the model automatically in multi-step mode. Also exists as ToolLoopAgent constructor option.

## 6. Aborting & timeouts

- `abortSignal: AbortSignal` on `generateText`/`streamText`/`agent.generate|stream` — cancels call, forwarded **into every tool execute** and the provider request. `AbortSignal.timeout(5000)` idiom.
- **`timeout`** (RequestOptions; works alongside abortSignal — first to fire wins):
  - number = total ms, or object `{ totalMs, stepMs, firstChunkMs, chunkMs, toolMs, tools: { <toolName>Ms: number } }`.
  - `toolMs` — **default timeout for all tool executions; a timed-out tool aborts and returns a `tool-error`** so the model can respond/retry. `tools: { slowApiMs: 10_000 }` per-tool overrides (tool names type-checked). ← exactly what we need for remote/resolved-later tools.
  - `firstChunkMs`/`chunkMs` (streaming only) = time-to-first-content and stalled-stream detectors; `stepMs` covers model+retries+local tools; retries get fresh output budgets.
- `onAbort: ({ callId, steps, reason }) => void` — called when aborted via AbortSignal; **`onEnd` is NOT called on abort** (so persist partial state here). In the raw stream there's also a `case 'abort':` part type. Pending promises (`text`, `steps`) reject with the abort reason.
- Client-side: `useChat().stop()`; with resumable streams, client abort is treated as disconnect (see §10).

## 7. Message history model (`ModelMessage`) & feeding history back

`ModelMessage` (union, from `ai`; zod schemas exported as `modelMessageSchema` etc.):
```ts
{ role: 'system',  content: string }                              // REJECTED by default unless allowSystemInMessages:true — use `instructions`!
{ role: 'user',    content: string | Array<TextPart | FilePart> } // ImagePart deprecated → FilePart mediaType:'image'
{ role: 'assistant', content: string | Array<TextPart | CustomPart | ToolCallPart> }
  // ToolCallPart: { type:'tool-call', toolCallId, toolName, args }   // the model's request
{ role: 'tool',    content: Array<ToolResultPart> }
  // ToolResultPart: { type:'tool-result', toolCallId, toolName, output: ToolResultOutput, providerOptions? }
  // ToolResultOutput: {type:'text'|'error-text', value} | {type:'json'|'error-json', value} | {type:'content', value: parts[]} | {type:'execution-denied', reason?}
```
Feeding a prior conversation INCLUDING tool calls back in:
```ts
const messages: ModelMessage[] = [
  { role: 'user', content: 'What is the weather in SF?' },
  { role: 'assistant', content: [ { type: 'tool-call', toolCallId: 'tc1', toolName: 'weather', args: { location: 'SF' } } ] },
  { role: 'tool', content: [ { type: 'tool-result', toolCallId: 'tc1', toolName: 'weather', output: { type: 'json', value: { temperature: 62 } } } ] },
];
const result = await generateText({ model, messages, tools, stopWhen: isStepCount(5) });
messages.push(...result.responseMessages);   // append assistant + tool messages for the next turn
```
- `result.responseMessages: ModelMessage[]` is THE canonical way to persist a step (also in `onEnd` callback; in `streamText` it's a promise: `await result.responseMessages`).
- `steps[i].responseMessages` gives per-step messages. Approval responses are also `role:'tool'` parts (`type:'tool-approval-response'`).
- UI ↔ core conversion: `convertToModelMessages(uiMessages)` (async; pass the SAME `tools` set so `toModelOutput` applies) and the inverse via UI streams.
- `pruneMessages` helper for compaction; `allowSystemInMessages: true` if we must accept stored system messages.

## 8. Errors & callbacks (current names)

Generation-level callbacks: `onStart`, `onStepStart`, `onToolExecutionStart`, `onToolExecutionEnd` (`toolOutput.type: 'tool-result' | 'tool-error'`), `onStepEnd` (⚠ was `onStepFinish`), `onEnd` (⚠ was `onFinish`; args `{ text, finishReason, usage, totalUsage, responseMessages, steps, runtimeContext, … }`), `onAbort`. Errors thrown inside these callbacks are silently caught.

`streamText` specifics:
- `onError` — receives `{ error }`; may return `{ retry: true }` when `streamRetries` is configured (v7 mid-stream recovery). `StreamProviderError.isInstance(error)` → `{ type, code, statusCode, isRetryable }`.
- `streamRetries: n` (default 0) — automatic mid-stream provider-error retries; reruns only the failed step, preserves completed steps; bounded by `streamRetries + 1` with callback retry.
- Full stream parts (`for await (const part of result.stream)`): `text`, `reasoning`, `tool-call`, `tool-input-start`, `tool-input-delta`, `tool-result`, `tool-error`, `error`, `abort`, `step-start`, `step-end`, `finish`, `raw`, etc.
- `result.consumeStream({ onError })` — drain without processing (abort hygiene; REQUIRED for proper abort handling in UI message streams via `consumeSseStream`).
- `maxRetries` (default 2) — pre-stream request failures only (exponential backoff, retryable errors only).
- UI-stream mapping: `toUIMessageStream({ stream: result.stream, onError: error => 'user-safe message' })` — **onError here is how error text reaches the client**.

## 9. Client side — `useChat` v7 (via `@ai-sdk/react`)

```tsx
'use client';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls } from 'ai';

const { messages, status, error, sendMessage, regenerate, stop, clearError,
         resumeStream, addToolOutput, addToolApprovalResponse, setMessages, id } = useChat({
  id: chatId,                              // stable id → resume + transport
  transport: new DefaultChatTransport({    // or DirectChatTransport / WebSocketChatTransport / custom ChatTransport
    api: '/api/chat',
    headers, body, credentials, fetch,
    prepareSendMessagesRequest: ({ id, messages, trigger, messageId, … }) => ({ body: { id, messages } }),
  }),
  messages: initialUIMessages,              // hydration from persisted history
  sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls, // resubmit when all tool outputs present
  resume: false,                           // true = auto-reconnect to resumable stream on mount
  onToolCall: async ({ toolCall }) => {     // auto-executed client tools
    if (toolCall.dynamic) return;          // ALWAYS check .dynamic first (type narrowing)
    addToolOutput({ tool: 'getLocation', toolCallId: toolCall.toolCallId, output: 'NYC' }); // no await
  },
  onError: (e) => …, onFinish: ({ message, isAbort, isDisconnect, isError, finishReason }) => …,
});
```
- `status: 'submitted' | 'streaming' | 'ready' | 'error'` (NO more `isLoading`).
- `sendMessage({ text, files?, metadata?, messageId? })` — a `messageId` REPLACES that message (edit); `sendMessage()` bare resubmits current messages.
- `regenerate({ messageId? })` — regenerates last (or specific) assistant message.
- **Tool parts**: assistant `message.parts` contains typed parts `tool-<toolName>` with `part.state`:
  `'input-streaming' | 'input-available' | 'approval-requested' | 'approval-responded' | 'output-available' | 'output-error' (→ part.errorText) | 'output-denied'`; access `part.input` / `part.output` / `part.toolCallId`. `isToolOutputErrorUIPart(part)` helper.
- **`addToolOutput({ tool, toolCallId, output })`** or `{ tool, toolCallId, state: 'output-error', errorText }` — replaces deprecated `addToolResult`; with `sendAutomaticallyWhen` set it can trigger automatic resubmission (this IS the client-side remote-tool pattern).
- `addToolApprovalResponse({ id, approved, reason? })` — respond to server-side tool approval requests.
- `stop()` aborts; `throttle` (ms) reduces React re-renders; `resumeStream()` manual reconnect; `messageMetadataSchema`, `dataPartSchemas` for validation.
- Server route that pairs with this: `convertToModelMessages(messages)` → `streamText`/`ToolLoopAgent` → `toUIMessageStream` → `createUIMessageStreamResponse`, or simply `createAgentUIStreamResponse({ agent, uiMessages })`.

## 10. Remote / delayed tool execution (result arrives via external POST) — patterns

There is NO built-in "tool result webhook" primitive; the docs' supported patterns (all usable from Node server):

1. **Pending-promise `execute` (in-process)** — the tool's execute returns a Promise that a separate HTTP handler resolves later (EventEmitter/Map of deferreds/Redis pub-sub in multi-instance setups). Loop simply waits; guard with timeouts + abort:
```ts
const pending = new Map<string, (r: unknown) => void>();
const remoteTool = tool({
  inputSchema: z.object({ job: z.string() }),
  execute: (input, { toolCallId, abortSignal }) =>
    new Promise((resolve, reject) => {
      pending.set(toolCallId, resolve);
      abortSignal?.addEventListener('abort', () => { pending.delete(toolCallId); reject(abortSignal.reason); }, { once: true });
    }),
});
// POST /webhooks/tool-result: const resolve = pending.get(body.toolCallId); resolve?.(body.result);
```
   - Timeouts: `timeout: { toolMs: 120_000, tools: { renderMs: 300_000 } }` — timed-out tool aborts and yields a `tool-error` the model can retry; `onAbort`/abortSignal cleans up.
2. **Preliminary results while waiting** — `async *execute` yielding status objects (UI sees progress; last yield is the result).
3. **No-`execute` tool + two-call pattern (serverless-friendly)** — tool call ends the loop (no execute → stop), persist `responseMessages`; when the external POST arrives, append `{ role:'tool', content:[{ type:'tool-result', toolCallId, toolName, output }] }` and start a NEW generation with full history (this is exactly how the manual loop + tool-approval + client-tool flows work internally; `result.staticToolCalls` carries the unexecuted calls). This maps 1:1 onto our gateway's `client.runs.postEvent(runId, {type:'tool.result', …})` seam if requests must not stay open.
4. **Client-mediated** — no execute server-side; browser `onToolCall`/UI calls `addToolOutput` and `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls` resubmits with the tool result embedded.
5. **Resumable streams** (`resume: true`, `resumable-stream` + Redis, `consumeSseStream`, GET `/api/chat/{id}/stream`) — for long-running generations across reloads; client aborts become disconnects; stop needs a dedicated stop endpoint.

## 11. OpenAI-compatible provider (server-side, custom base URL + model ids)

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const provider = createOpenAICompatible({
  name: 'studio-llm',                    // provider name (used in providerOptions keys, file references)
  baseURL: process.env.LITELLM_BASE_URL!, // e.g. https://tokenharbor.ai/v1 — OpenAI-compatible endpoint
  apiKey: process.env.LITELLM_API_KEY,   // → Authorization: Bearer header
  headers: { 'X-Custom': '…' },           // extra headers (after auth)
  queryParams: { … },
  includeUsage: true,                     // usage in streaming responses (needed for token accounting)
  supportsStructuredOutputs: false,      // enable only if endpoint supports it
  supportsMultiPartToolContent: false,    // only if endpoint accepts content arrays in tool role
  supportedUrls: () => ({ 'video/*': [/^https:\/\/cdn\./] }),  // pass URLs through instead of downloading
  transformRequestBody: (body, warnings) => body,  // shim for nonstandard proxies (e.g. alias → real model id)
  fetch,                                  // custom fetch / middleware (retry shim, logging)
  metadataExtractor: …,
});

const model = provider('studio-fast');    // arbitrary model id string; or provider.chatModel('id') / provider.languageModel('id')
// optional: createOpenAICompatible<'a'|'b'| (string & {})>(...) generics for model-id autocomplete

const { text } = await generateText({ model, prompt: '…' });   // or ToolLoopAgent({ model, … })
```
- Capabilities: text gen, streaming, **tool calling with streaming**, structured outputs (if enabled), reasoning content (DeepSeek R1-style), system messages, multimodal inputs (provider-dependent).
- Model ids are free-form strings — aliases work as-is (e.g. our `studio-fast/smart/vision` aliases could BE the model ids, or `transformRequestBody` can map them).
- Per-call `headers` option also exists on generateText/streamText/ToolLoopAgent for request-scoped headers.
- Alternative built-ins: `@ai-sdk/openai` (with its own `.api()`/baseURL config) for true OpenAI; `@ai-sdk/gateway` model strings (`model: 'anthropic/claude-sonnet-5.5'`) resolve via the Vercel AI Gateway — NOT applicable to a private endpoint.

## 12. Telemetry & retries (summary)

- Retries: `maxRetries` (default 2, pre-stream) + `streamRetries` (default 0, mid-stream step recovery; `onError` can return `{ retry: true }`; `StreamProviderError.isRetryable`).
- Telemetry: **opt-out**; register once at startup:
```ts
import { registerTelemetry } from 'ai';
import { OpenTelemetry } from '@ai-sdk/otel';
registerTelemetry(new OpenTelemetry());   // Node entry file; Next.js: instrumentation.ts (+ @vercel/otel registerOTel)
```
  Per-call: `telemetry: { isEnabled, functionId: 'chat-gateway', metadata: { userId }, recordInputs/recordOutputs, includeToolsContext: { weather: { defaultUnit: true } } }`. New `@ai-sdk/otel` package replaces the old `@opentelemetry`-manual spans; `LegacyOpenTelemetry` still available.

## 13. Fit for our `services/gateway` (mapping notes, no code written)

| Our hand-rolled seam | AI SDK v7 equivalent |
|---|---|
| fetch SSE loop to OpenAI-compatible endpoint | `@ai-sdk/openai-compatible` provider + `streamText`/`ToolLoopAgent` |
| hand-rolled tool-call parsing/execution loop | `ToolLoopAgent` loop (`stopWhen: isStepCount(n)`) or `streamText` + `stopWhen` |
| tool defs w/ zod | `tool({ inputSchema: z.object(...), execute })` |
| repair of malformed tool args | `repairToolCall` |
| per-run abort (stop button) | `abortSignal` + `onAbort`; client `stop()` |
| 20s tool guard / 15s bridge timeout | `timeout: { toolMs, tools: { renderMs } }` |
| tool.result POST from external system | §10 pattern 1 (pending promise) or 3 (two-call + `role:'tool'` tool-result message) |
| history incl. tool calls | `ModelMessage[]` + `result.responseMessages`; `convertToModelMessages` for UI messages |
| retry/backoff logic | `maxRetries` + `streamRetries` |
| token/credit accounting | `usage`/`totalUsage` in `onStepEnd`/`onEnd`; `includeUsage: true` on the provider |
| observability | `@ai-sdk/otel` `registerTelemetry` |

Caveats found while reading: v7 docs still show `experimental_repairToolCall` in one migration-guide snippet (stale); the stable name everywhere else (incl. `streamText` reference) is `repairToolCall` with `instructions` (not `system`). ToolCallPart is documented with `args` on the reference page but repair examples use `input` — both appear in v7 docs; when round-tripping history, mirror what `responseMessages` produces (type-safe if you pass through unchanged).

## Sources (fetched 2026-10-28, all v7 "eve")
- npm registry: `ai@7.0.153`, `@ai-sdk/openai-compatible@3.0.78`, `@ai-sdk/react@4.0.157`, `@ai-sdk/otel@1.0.153`, dist-tags, peer deps (`registry.npmjs.org/*/latest`)
- ai-sdk.dev (page.md exports): /docs/agents/overview, /docs/agents/building-agents, /docs/agents/loop-control, /docs/agents/memory, /docs/agents/tool-approvals, /docs/ai-sdk-core/tools-and-tool-calling, /docs/ai-sdk-core/settings, /docs/ai-sdk-core/error-handling, /docs/ai-sdk-core/telemetry, /docs/ai-sdk-core/lifecycle-callbacks, /docs/reference/ai-sdk-core/{tool-loop-agent,tool,stream-text,model-message,agent}, /docs/reference/ai-sdk-ui/use-chat, /docs/ai-sdk-ui/{chatbot,chatbot-tool-usage,chatbot-resume-streams,transport}, /providers/openai-compatible-providers, /docs/migration-guides/migration-guide-7-0
