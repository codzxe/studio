// @studio/gateway — minimal OpenAI-compatible streaming chat client
// (PRODUCT_ARCHITECTURE §8.1/§8.2, BUILD_PLAN M4.3, D-16).
//
// NO SDK dependency (the gateway must stay light): plain `fetch` + an SSE line
// parser. Targets the LiteLLM proxy's OpenAI-compatible
// `POST {LITELLM_BASE_URL}/v1/chat/completions` endpoint with
// `{ stream: true, stream_options: { include_usage: true } }`.
//
// Bearer token = `LITELLM_VIRTUAL_KEY ?? LITELLM_API_KEY` (workspace virtual
// keys map to LiteLLM budgets; the platform key is the fallback).
//
// Error policy (§8.9): connect/HTTP failures are retried twice (1s/2s backoff,
// injectable `sleep` for deterministic tests); a stream that already started
// is never retried (the client would see duplicated deltas). After the
// retries the caller maps the thrown ModelUnavailableError to a retryable
// RUN_MODEL_UNAVAILABLE run outcome. Abort is via the run's AbortSignal.

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

function sseUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;
}

/**
 * Stream one chat completion. Async generator: yields text deltas, fully
 * aggregated tool calls (flushed in index order once the stream finishes the
 * calls), the usage chunk (stream_options.include_usage) and the finish
 * reason. Retries connect/HTTP errors per the policy above; throws
 * ModelUnavailableError when the budget is spent and rethrows anything that
 * happened while `signal` was already aborted so the caller maps it to
 * `cancelled`.
 */
export async function* streamChatCompletion(
  deps: OpenAIClientDeps,
  request: ChatCompletionRequest,
): AsyncGenerator<ModelStreamEvent> {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const url = sseUrl(deps.baseUrl);

  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (request.tools !== undefined && request.tools.length > 0) {
    body.tools = request.tools;
    body.tool_choice = "auto";
  }

  let response: Response | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (request.signal.aborted) {
      throw new DOMException("The run was cancelled.", "AbortError");
    }
    try {
      const candidate = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${deps.bearer}`,
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });
      if (!candidate.ok) {
        throw new Error(`openai_http_${candidate.status}`);
      }
      response = candidate;
      break;
    } catch (error) {
      lastError = error;
      if (request.signal.aborted) {
        throw new DOMException("The run was cancelled.", "AbortError");
      }
      if (attempt === MAX_ATTEMPTS - 1) break;
      await sleep(RETRY_BACKOFF_MS[attempt]);
    }
  }
  if (response === null) {
    throw new ModelUnavailableError("The model service is unavailable right now.", {
      cause: lastError,
    });
  }
  if (response.body === null) {
    throw new ModelUnavailableError("The model service returned an empty stream.");
  }

  yield* parseSseStream(response.body, request.signal);
}

/** SSE line parser → ModelStreamEvents (text/tool_call/usage/finish). */
async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<ModelStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const pending: string[] = [];
  const toolCalls = new Map<number, { id: string; name: string; args: string }>();
  let buffer = "";

  function* flushToolCalls(): Generator<ModelStreamEvent> {
    const indexes = [...toolCalls.keys()].sort((a, b) => a - b);
    for (const index of indexes) {
      const call = toolCalls.get(index);
      if (call === undefined) continue;
      toolCalls.delete(index);
      yield {
        type: "tool_call",
        call: { index, id: call.id, name: call.name, arguments: call.args },
      };
    }
  }

  function* handleLine(line: string): Generator<ModelStreamEvent> {
    if (!line.startsWith("data:")) return;
    const data = line.slice("data:".length).trim();
    if (data === "" || data === "[DONE]") return;
    let chunk: unknown;
    try {
      chunk = JSON.parse(data);
    } catch {
      return; // malformed frame: skip, never crash the run
    }
    if (typeof chunk !== "object" || chunk === null) return;
    const record = chunk as {
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      choices?: {
        delta?: { content?: unknown; tool_calls?: unknown };
        finish_reason?: unknown;
      }[];
    };
    if (record.usage !== undefined) {
      const usage = record.usage;
      yield {
        type: "usage",
        usage: {
          inputTokens: Number(usage.prompt_tokens ?? 0),
          outputTokens: Number(usage.completion_tokens ?? 0),
        },
      };
    }
    const choice = record.choices?.[0];
    if (choice === undefined) return;
    const delta = choice.delta;
    if (delta !== undefined && typeof delta.content === "string" && delta.content !== "") {
      yield { type: "text", delta: delta.content };
    }
    if (delta !== undefined && Array.isArray(delta.tool_calls)) {
      for (const fragment of delta.tool_calls) {
        if (typeof fragment !== "object" || fragment === null) continue;
        const item = fragment as {
          index?: number;
          id?: unknown;
          function?: { name?: unknown; arguments?: unknown };
        };
        const index = typeof item.index === "number" ? item.index : 0;
        const current = toolCalls.get(index) ?? { id: "", name: "", args: "" };
        if (typeof item.id === "string" && item.id !== "") current.id = item.id;
        if (item.function !== undefined) {
          if (typeof item.function.name === "string" && item.function.name !== "") {
            current.name = current.name + item.function.name;
          }
          if (typeof item.function.arguments === "string") {
            current.args = current.args + item.function.arguments;
          }
        }
        toolCalls.set(index, current);
      }
    }
    if (typeof choice.finish_reason === "string" && choice.finish_reason !== "") {
      yield* flushToolCalls();
      yield { type: "finish", reason: choice.finish_reason };
    }
  }

  try {
    while (true) {
      if (signal.aborted) {
        throw new DOMException("The run was cancelled.", "AbortError");
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line !== "") pending.push(line);
        newline = buffer.indexOf("\n");
      }
      for (const line of pending.splice(0)) {
        yield* handleLine(line);
      }
      if (signal.aborted) {
        throw new DOMException("The run was cancelled.", "AbortError");
      }
    }
    const tail = buffer.trim();
    if (tail !== "") {
      yield* handleLine(tail);
    }
  } catch (error) {
    if (signal.aborted) {
      throw new DOMException("The run was cancelled.", "AbortError");
    }
    throw new ModelUnavailableError("The model stream failed mid-response.", { cause: error });
  } finally {
    // Always release the provider connection, even on abort.
    await reader.cancel().catch(() => undefined);
  }
}
