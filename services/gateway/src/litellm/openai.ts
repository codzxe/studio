// @studio/gateway — OpenAI-compatible streaming chat client, built on the
// Vercel AI SDK (PRODUCT_ARCHITECTURE §8.1/§8.2, BUILD_PLAN M4.3, D-16).
//
// The transport is the Vercel AI SDK: `createOpenAICompatible` (provider
// construction, wire serialization, SSE parsing, tool-call fragment
// aggregation) + `streamText` (part stream). This module owns:
//
//   * the §8.1 message vocabulary: OpenAIChatMessage[] (system/user/
//     assistant+tool_calls/tool) — the runner's conversation format —
//     converted to SDK prompt (system messages become `instructions`,
//     which the provider re-serializes as the SAME leading system message
//     on the wire; assistant tool_calls and tool results round-trip
//     byte-identically, verified against the installed SDK);
//   * the §8.4 tool registrations: OpenAIToolSpec[] → an execute-less
//     ToolSet (server-side interception — the SDK never auto-loops, the
//     runner drives rounds itself);
//   * the §8.9 failure policy: connect/HTTP failures retried twice
//     (1s/2s backoff — OUR loop with the injectable `sleep`, the SDK runs
//     with maxRetries: 0 because its backoff is real-time and the tests
//     must stay instant); a stream that already produced events is NEVER
//     retried (the client would see duplicated deltas).
//
// Part mapping (streamText fullStream → ModelStreamEvent):
//   text-delta (non-empty)          → {type:"text"}           (streamed out)
//   tool-call                       → {type:"tool_call"}      (aggregated by
//                                     the SDK; arguments re-serialized from
//                                     the parsed input — invalid JSON args
//                                     arrive as the RAW STRING, which the
//                                     runner's validation repair-turns)
//   finish-step (non-error reason)  → {type:"finish"} + {type:"usage"} when
//                                     the provider sent usage (absent/zero
//                                     usage is NOT emitted — the runner then
//                                     falls back to its chars/4 estimate)
//   error part, AI_JSONParseError   → skipped, non-fatal (a malformed SSE
//                                     frame — the SDK keeps parsing)
//   error part, anything else        → transport failure (HTTP status,
//                                     rejected fetch, schema violation):
//                                     retried when nothing was emitted yet,
//                                     else ModelUnavailableError
//   finish-step (reason "error")    → the stream failed without a finish
//                                     reason: retried when nothing was
//                                     emitted, else ModelUnavailableError
//   abort part / AbortError         → DOMException AbortError (the caller
//                                     maps it to `cancelled`)
//
// Spec-compliance note: the SDK's SSE parser dispatches events only at
// event-terminating blank lines — a final frame WITHOUT a trailing newline
// is an incomplete event and the stream fails (OpenAI/LiteLLM always
// terminate events, so this matches every real server).
//
// Bearer token = `LITELLM_VIRTUAL_KEY ?? LITELLM_API_KEY` (workspace virtual
// keys map to LiteLLM budgets; the platform key is the fallback).
//
// Wire model id (direct-provider seam): `modelMap` optionally rewrites the
// request's studio alias (studio-fast/smart/vision) to a provider model id
// AT THE WIRE ONLY — every internal seam (plan entitlements, run rows,
// credit rates) keeps speaking aliases. Unset/miss = pass-through, the
// LiteLLM-proxy posture (the proxy owns alias→model resolution there).
//
// Wire tool names (same seam): the OpenAI-compatible tool-name grammar is
// ^[a-zA-Z0-9_-]{1,64}$ — the studio.* registry ids carry dots, which strict
// providers (Token Harbor's edge validator among them) reject with a 400 on
// `tools.N.function.name`. `toolSeam` rewrites dots to underscores for the
// registrations and normalizes the model's echoed name back to the registry
// id — the prompt speaks dotted ids, so the echo may arrive in EITHER form;
// both collapse through the same sanitizer. The runner, conversation history
// and every internal seam keep speaking the dotted ids.

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { type JSONValue, type ModelMessage, type ToolSet, jsonSchema, streamText, tool } from "ai";

export type OpenAIRole = "system" | "user" | "assistant" | "tool";

/** OpenAI wire message (the subset this client sends). */
export interface OpenAIChatMessage {
  readonly role: OpenAIRole;
  readonly content: string;
  /** Assistant turns only: the calls the model requested. */
  readonly tool_calls?: readonly OpenAIToolCall[];
  /** Tool turns only: which call this answers. */
  readonly tool_call_id?: string;
}

export interface OpenAIToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

/** Function-tool registration sent as `tools` (§8.4: curated read tools). */
export interface OpenAIToolSpec {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

/** A completed, aggregated tool call (streamed fragments merged by index). */
export interface AggregatedToolCall {
  readonly index: number;
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export type ModelStreamEvent =
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "reasoning"; readonly delta: string }
  | { readonly type: "tool_call"; readonly call: AggregatedToolCall }
  | { readonly type: "usage"; readonly usage: ModelUsage }
  | { readonly type: "finish"; readonly reason: string };

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Provider/proxy failure after the retry budget (§8.9 RUN_MODEL_UNAVAILABLE). */
export class ModelUnavailableError extends Error {
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message);
    this.name = "ModelUnavailableError";
    this.cause = options.cause;
  }
}

export interface OpenAIClientDeps {
  /** LiteLLM proxy base URL, e.g. http://127.0.0.1:4000 (no trailing /v1). */
  readonly baseUrl: string;
  /** Bearer token: virtual key when set, else the platform key. */
  readonly bearer: string;
  /**
   * Optional alias→provider-model-id wire map (env LITELLM_MODEL_MAP) — the
   * direct-OpenAI-compatible-provider seam. Unset or a miss passes the alias
   * through unchanged (the LiteLLM-proxy default).
   */
  readonly modelMap?: Readonly<Record<string, string>> | undefined;
  /** Injectable for tests (deterministic fake OpenAI SSE server). */
  readonly fetch?: typeof fetch;
  /** Injectable sleep so the 1s/2s retry backoff is instant in tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ChatCompletionRequest {
  /** LiteLLM alias (§8.2): studio-fast | studio-smart | studio-vision. */
  readonly model: string;
  readonly messages: readonly OpenAIChatMessage[];
  /** Omitted for structured-output calls (no tools, no tool_choice). */
  readonly tools?: readonly OpenAIToolSpec[];
  /** Aborted → the in-flight request/stream is torn down (run cancel). */
  readonly signal: AbortSignal;
}

const RETRY_BACKOFF_MS: readonly number[] = [1_000, 2_000];
const MAX_ATTEMPTS = RETRY_BACKOFF_MS.length + 1;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    const timer = setTimeout(resolveSleep, ms);
    timer.unref?.();
  });
}

function abortError(): Error {
  return new DOMException("The run was cancelled.", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Non-fatal SDK data error: a malformed SSE frame — the stream continues. */
function isNonFatalDataError(error: unknown): boolean {
  return error instanceof Error && error.name === "AI_JSONParseError";
}

/** Transport failure BEFORE any event was emitted — retryable (§8.9). */
class RetryableStreamError extends Error {
  constructor(cause: unknown) {
    super("The model call failed before producing output.");
    this.name = "RetryableStreamError";
    this.cause = cause;
  }
}

/**
 * Stream one chat completion. Async generator: yields text deltas, fully
 * aggregated tool calls (in emission order), the finish reason and — when the
 * provider sent usage — the token counts. Retries connect/HTTP errors per the
 * policy above; throws ModelUnavailableError when the budget is spent and
 * rethrows AbortError so the caller maps it to `cancelled`.
 */
export async function* streamChatCompletion(
  deps: OpenAIClientDeps,
  request: ChatCompletionRequest,
): AsyncGenerator<ModelStreamEvent> {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (request.signal.aborted) {
      throw abortError();
    }
    try {
      yield* streamOnce(deps, doFetch, request);
      return;
    } catch (error) {
      if (request.signal.aborted || isAbortError(error)) {
        throw abortError();
      }
      if (error instanceof ModelUnavailableError) {
        throw error;
      }
      lastError = error;
      if (attempt === MAX_ATTEMPTS - 1) break;
      await sleep(RETRY_BACKOFF_MS[attempt] ?? 1_000);
    }
  }
  throw new ModelUnavailableError("The model service is unavailable right now.", {
    cause: lastError,
  });
}

// ---------------------------------------------------------------------------
// Prompt conversion: OpenAIChatMessage[] → SDK streamText prompt
// ---------------------------------------------------------------------------

/** Parse tool-call arguments; unparsable wire JSON degrades to the raw string. */
function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw === "" ? "{}" : raw);
  } catch {
    return raw;
  }
}

/** Tool-result output as the SDK's discriminated union (§ tool-result parts). */
function toolResultOutput(
  content: string,
): { type: "json"; value: JSONValue } | { type: "text"; value: string } {
  try {
    return { type: "json", value: JSON.parse(content) as JSONValue };
  } catch {
    return { type: "text", value: content };
  }
}

/**
 * Tool-result output for a tool call the conversation never answered. The
 * runner's structured-output side call (§8.6 studio.plan_edit) replays the
 * conversation while the model's own tool call is still open — legal on the
 * LiteLLM wire, but the SDK requires every tool call to be answered, so the
 * adapter closes it with this neutral stub.
 */
const SEPARATE_STEP_TOOL_OUTPUT = {
  type: "text",
  value: "This call is completed in a separate step; continue with the latest instruction.",
} as const;

function toSdkPrompt(messages: readonly OpenAIChatMessage[]): {
  readonly instructions: string | undefined;
  readonly messages: ModelMessage[];
} {
  const system: string[] = [];
  const converted: ModelMessage[] = [];
  // tool_call_id → toolName (the OpenAI wire tool turn carries no name; the
  // SDK's tool-result part requires one — resolved from the assistant turn
  // that requested the call, which always precedes the result).
  const toolNames = new Map<string, string>();
  // Tool calls the conversation has not answered yet, in request order.
  let pending: { readonly id: string; readonly name: string }[] = [];

  /** Close every unanswered call with the neutral stub (SDK prompt rule). */
  const flushPending = (): void => {
    for (const call of pending) {
      converted.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: call.id,
            toolName: call.name,
            output: SEPARATE_STEP_TOOL_OUTPUT,
          },
        ],
      });
    }
    pending = [];
  };

  for (const message of messages) {
    if (message.role === "system") {
      system.push(message.content);
      continue;
    }
    if (message.role === "assistant") {
      // A new assistant turn implies the previous one's calls went unanswered.
      flushPending();
      const calls = message.tool_calls ?? [];
      if (calls.length === 0) {
        converted.push({ role: "assistant", content: message.content });
        continue;
      }
      converted.push({
        role: "assistant",
        content: [
          ...(message.content !== "" ? [{ type: "text" as const, text: message.content }] : []),
          ...calls.map((call) => {
            toolNames.set(call.id, call.function.name);
            pending.push({ id: call.id, name: call.function.name });
            return {
              type: "tool-call" as const,
              toolCallId: call.id,
              toolName: call.function.name,
              input: parseArguments(call.function.arguments),
            };
          }),
        ],
      });
      continue;
    }
    if (message.role === "tool") {
      const toolCallId = message.tool_call_id ?? "";
      pending = pending.filter((call) => call.id !== toolCallId);
      converted.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName: toolNames.get(toolCallId) ?? "unknown",
            output: toolResultOutput(message.content),
          },
        ],
      });
      continue;
    }
    flushPending();
    converted.push({ role: "user", content: message.content });
  }
  // Trailing unanswered calls (the plan side-call shape) close here.
  flushPending();

  return {
    instructions: system.length > 0 ? system.join("\n\n") : undefined,
    messages: converted,
  };
}

// ---------------------------------------------------------------------------
// Tool registrations: OpenAIToolSpec[] → execute-less ToolSet
// ---------------------------------------------------------------------------

/**
 * OpenAI-compatible wire tool name: providers require
 * `^[a-zA-Z0-9_-]{1,64}$` — the studio.* registry ids' dots are rewritten to
 * underscores at the wire (the runner's registry ids keep their dots).
 */
export function wireToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Wire-name seam for one request: registers each spec under its sanitized
 * wire name and restores the registry id from the model's echoed tool name.
 * Both echo forms (sanitized — what the model saw registered; dotted — what
 * the prompt mentions) normalize through the SAME sanitizer, so the lookup
 * key matches either. Unknown names pass through untouched: the runner owns
 * the §8.9 unknown-tool repair turn and its 400-style validation reply.
 */
function toolSeam(specs: readonly OpenAIToolSpec[]): {
  readonly tools: ToolSet;
  readonly originalOf: (echoedName: string) => string;
} {
  const originalOfWire = new Map<string, string>();
  const set: ToolSet = {};
  for (const spec of specs) {
    const wireName = wireToolName(spec.function.name);
    originalOfWire.set(wireName, spec.function.name);
    set[wireName] = tool({
      description: spec.function.description,
      // The contracts' JSON Schema passes through untouched on the wire.
      inputSchema: jsonSchema(spec.function.parameters as Parameters<typeof jsonSchema>[0]),
      // No execute on purpose: server-side interception. The SDK never
      // auto-loops on these — the runner drives rounds itself (§8.4).
    });
  }
  return {
    tools: set,
    originalOf: (echoedName) => originalOfWire.get(wireToolName(echoedName)) ?? echoedName,
  };
}

// ---------------------------------------------------------------------------
// Part mapping: streamText fullStream → ModelStreamEvent
// ---------------------------------------------------------------------------

/** SDK finish vocabulary → the OpenAI wire names the runner contract uses. */
function wireFinishReason(reason: string): string {
  if (reason === "tool-calls") return "tool_calls";
  if (reason === "content-filter") return "content_filter";
  return reason;
}

/** Usage event only when the provider actually reported tokens (> 0). */
function usageOf(
  usage: { readonly inputTokens?: number; readonly outputTokens?: number } | undefined,
): ModelUsage | null {
  const inputTokens = usage?.inputTokens;
  const outputTokens = usage?.outputTokens;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") return null;
  if (inputTokens <= 0 && outputTokens <= 0) return null;
  return { inputTokens, outputTokens };
}

/** Wire model id for a request: the mapped provider id, else the alias as-is. */
function wireModelOf(deps: Pick<OpenAIClientDeps, "modelMap">, alias: string): string {
  return deps.modelMap?.[alias] ?? alias;
}

async function* streamOnce(
  deps: OpenAIClientDeps,
  doFetch: typeof fetch,
  request: ChatCompletionRequest,
): AsyncGenerator<ModelStreamEvent> {
  const provider = createOpenAICompatible({
    name: "litellm",
    baseURL: `${deps.baseUrl.replace(/\/+$/, "")}/v1`,
    apiKey: deps.bearer,
    fetch: doFetch,
    includeUsage: true,
  });
  const { instructions, messages } = toSdkPrompt(request.messages);
  const withTools = request.tools !== undefined && request.tools.length > 0;
  const seam = withTools ? toolSeam(request.tools ?? []) : null;
  const result = streamText({
    model: provider.chatModel(wireModelOf(deps, request.model)),
    // maxRetries: 0 — §8.9's injectable-backoff retry loop lives HERE (the
    // SDK's own backoff is real-time; the test seam needs instant sleeps).
    maxRetries: 0,
    abortSignal: request.signal,
    // Errors surface through the parts (classified below) and the caller's
    // outcome mapping — silence the SDK's default console.error logger
    // (the gateway logs typed, redacted codes, never bodies).
    onError: () => undefined,
    ...(instructions !== undefined ? { instructions } : {}),
    messages,
    ...(seam !== null ? { tools: seam.tools, toolChoice: "auto" as const } : {}),
  });
  // The aggregate result promise must never reject unhandled — every failure
  // below is surfaced through the parts (or the catch), not by awaiting it.
  void Promise.resolve(result).catch(() => undefined);

  let emitted = false;
  let toolIndex = 0;

  try {
    for await (const part of result.fullStream) {
      if (part.type === "abort" || request.signal.aborted) {
        throw abortError();
      }
      if (part.type === "text-delta" && part.text !== "") {
        emitted = true;
        yield { type: "text", delta: part.text };
        continue;
      }
      // ROUND 13 (live thinking): OpenAI-compatible providers surface chain-of-
      // thought tokens as `reasoning` / `reasoning_content` chunk fields; the
      // SDK maps them to `reasoning-delta` parts ({ id, text } — some provider
      // builds carry `delta` instead; both are accepted). Forwarded verbatim —
      // the turn SSE re-emits each as a `reasoning.delta` frame so the user
      // watches the model think in real time (never a blank screen).
      if (part.type === "reasoning-delta") {
        const providerDelta = (part as { delta?: unknown }).delta;
        const reasoningText =
          typeof part.text === "string"
            ? part.text
            : typeof providerDelta === "string"
              ? providerDelta
              : "";
        if (reasoningText !== "") {
          emitted = true;
          yield { type: "reasoning", delta: reasoningText };
        }
        continue;
      }
      if (part.type === "tool-call") {
        emitted = true;
        yield {
          type: "tool_call",
          call: {
            index: toolIndex,
            id: part.toolCallId,
            // Echoed wire name → registry id (dotted), see toolSeam.
            name: seam !== null ? seam.originalOf(part.toolName) : part.toolName,
            arguments:
              typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? {}),
          },
        };
        toolIndex += 1;
        continue;
      }
      if (part.type === "finish-step") {
        if (part.finishReason === "error") {
          // The stream failed without a finish reason (e.g. a truncated
          // response): retryable only when nothing was emitted yet.
          throw emitted
            ? new ModelUnavailableError("The model stream failed mid-response.")
            : new RetryableStreamError(part.finishReason);
        }
        emitted = true;
        yield { type: "finish", reason: wireFinishReason(part.finishReason) };
        const usage = usageOf(part.usage);
        if (usage !== null) {
          yield { type: "usage", usage };
        }
        continue;
      }
      if (part.type === "error") {
        if (request.signal.aborted) {
          throw abortError();
        }
        if (isNonFatalDataError(part.error)) {
          // A malformed SSE frame is non-fatal — the SDK keeps parsing the
          // rest of the stream (the old parser skipped bad frames too).
          continue;
        }
        // Every other failure — HTTP status (APICallError), a rejected
        // fetch (raw Error), a response that violates the provider schema —
        // is a transport failure for this attempt: retried when nothing was
        // emitted yet, else the stream is dead mid-response (§8.9).
        throw emitted
          ? new ModelUnavailableError("The model stream failed mid-response.", {
              cause: part.error,
            })
          : new RetryableStreamError(part.error);
      }
    }
  } catch (error) {
    if (request.signal.aborted || isAbortError(error)) {
      throw abortError();
    }
    if (error instanceof ModelUnavailableError) {
      throw error;
    }
    if (error instanceof RetryableStreamError) {
      throw error;
    }
    // Errors thrown by the iteration itself (e.g. a reset connection):
    // retried only when the consumer saw nothing (an event already yielded
    // can never be taken back — §8.9's no-duplicated-deltas rule).
    throw emitted
      ? new ModelUnavailableError("The model stream failed mid-response.", { cause: error })
      : new RetryableStreamError(error);
  }
}
