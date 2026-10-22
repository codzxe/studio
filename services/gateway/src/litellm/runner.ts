// @studio/gateway — the LiteLLM agent runner (PRODUCT_ARCHITECTURE §8.1-§8.9,
// D-16; M4-SEAMS Seam 3). REAL OpenAI-compatible runner behind the
// AgentRunner seam — replaces the old UnavailableRunner.
//
// Loop per run (§8.1 stack roles — the gateway never talks to a provider
// directly, always through the LiteLLM proxy):
//   1. emit run.started (model alias)
//   2. stream from the model; text deltas → message.delta events
//   3. tool calls: allowlist = the 5 READ tools only (M4.6 hard rule: NO
//      write tool is ever registered). Unknown tool or args failing the
//      TOOL_LIST Zod schema → ONE repair turn (validation error as the tool
//      result); second offense → failed RUN_INVALID_TOOL (§8.9).
//   4. client tools (get_context/list_layers/get_properties/render_preview):
//      tool.started + expectToolCall, then waitForToolResult (Seam 2) — the
//      editor executes via the bridge and POSTs /v1/runs/:id/events; timeout
//      → failed EDITOR_DISCONNECTED "The editor didn't respond in time."
//   5. studio.plan_edit is SERVER-SIDE: a structured-output call to the SAME
//      alias (strict JSON prompt + EDIT_PLAN_SCHEMA parse, 2 attempts) →
//      emit {type:"plan"}; the validated plan is the tool result. The client
//      does NOT execute plan_edit.
//   6. repeat until finish or the round cap → failed RUN_STEP_LIMIT.
//   7. usage → committedCredits: ceil(in/1000×rateIn + out/1000×rateOut),
//      min 1, from MODEL_CATALOG; usage missing → tokens ≈ chars/4.
//
// Redaction (M4.3): the logger receives ONLY lengths + sha256 prefixes of
// prompts — never bodies (see prompt.ts fingerprintMessages).

import { z } from "zod";

import {
  EDIT_PLAN_SCHEMA,
  type EditPlan,
  MODEL_CATALOG,
  type ModelId,
  TOOL_LIST,
  type ToolDefinition,
} from "@studio/contracts";

import { type Logger, nullLogger } from "../logger.js";
import type { AgentRun, AgentRunOutcome, AgentRunStream, AgentRunner } from "../runner.js";
import {
  type AggregatedToolCall,
  type ChatCompletionRequest,
  type ModelStreamEvent,
  ModelUnavailableError,
  type OpenAIChatMessage,
  type OpenAIToolSpec,
  streamChatCompletion,
} from "./openai.js";
import { buildMessages, fingerprintMessages, planInstruction } from "./prompt.js";

/**
 * How long the runner waits for the editor client to POST a tool result
 * before failing the run with EDITOR_DISCONNECTED (M4 Seam 2; §8.9's closest
 * honest code — the run pauses, then stops).
 */
export const TOOL_RESULT_TIMEOUT_MS = 30_000;

export interface LiteLLMRunnerDeps {
  /** LiteLLM proxy base URL (env LITELLM_BASE_URL). */
  readonly baseUrl: string;
  /** Platform key (env LITELLM_API_KEY) — bearer when no virtual key. */
  readonly apiKey: string;
  /** Workspace virtual key (env LITELLM_VIRTUAL_KEY) — bearer when set. */
  readonly virtualKey?: string | undefined;
  /** Model round cap (env CHAT_MAX_STEPS). */
  readonly maxSteps: number;
  /** Injectable fetch (tests: fake OpenAI SSE server). */
  readonly fetch?: typeof fetch;
  /** Injectable sleep so retry backoff is instant in tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Redacted-metadata-only logger (M4.3); defaults to silent. */
  readonly logger?: Logger;
}

// ---------------------------------------------------------------------------
// Read-tool surface (M4.6: NOTHING else is ever registered)
// ---------------------------------------------------------------------------

/** Exactly the §8.4 read tools (5). No write tool is ever sent to a model. */
export const RUNNER_READ_TOOLS: readonly ToolDefinition[] = TOOL_LIST.filter(
  (tool) => tool.kind === "read",
);

const READ_TOOL_BY_ID: ReadonlyMap<string, ToolDefinition> = new Map(
  RUNNER_READ_TOOLS.map((tool) => [tool.id, tool]),
);

/** Tool registrations for the provider, derived from the Zod args schemas. */
function openAiToolSpecs(): OpenAIToolSpec[] {
  return RUNNER_READ_TOOLS.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.id,
      description: tool.description,
      parameters: toolParametersSchema(tool),
    },
  }));
}

function toolParametersSchema(tool: ToolDefinition): Record<string, unknown> {
  const schema = z.toJSONSchema(tool.args, { io: "input" }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

// ---------------------------------------------------------------------------
// Tool-call validation (§8.9: one repair turn, then RUN_INVALID_TOOL)
// ---------------------------------------------------------------------------

type ValidatedToolCall =
  | { readonly ok: true; readonly name: string; readonly args: unknown }
  | { readonly ok: false; readonly message: string };

function validateToolCall(call: AggregatedToolCall): ValidatedToolCall {
  const tool = READ_TOOL_BY_ID.get(call.name);
  if (tool === undefined) {
    return {
      ok: false,
      message: `Unknown tool "${call.name}". Available tools: ${RUNNER_READ_TOOLS.map((t) => t.id).join(", ")}.`,
    };
  }
  let parsedArgs: unknown;
  try {
    parsedArgs = JSON.parse(call.arguments === "" ? "{}" : call.arguments);
  } catch {
    return {
      ok: false,
      message: `Tool arguments for ${tool.id} must be a single valid JSON object.`,
    };
  }
  const checked = tool.args.safeParse(parsedArgs);
  if (!checked.success) {
    const detail = checked.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: `Invalid arguments for ${tool.id}: ${detail}` };
  }
  return { ok: true, name: tool.id, args: checked.data };
}

// ---------------------------------------------------------------------------
// Usage → committed credits (§8.8)
// ---------------------------------------------------------------------------

interface UsageAccumulator {
  inputTokens: number;
  outputTokens: number;
  seen: boolean;
}

function applyUsage(usage: UsageAccumulator, event: ModelStreamEvent): void {
  if (event.type === "usage") {
    usage.inputTokens += event.usage.inputTokens;
    usage.outputTokens += event.usage.outputTokens;
    usage.seen = true;
  }
}

function messageChars(message: OpenAIChatMessage): number {
  const serialized = JSON.stringify(message);
  return serialized === undefined ? 0 : serialized.length;
}

/**
 * §8.8 commit math: ceil(input/1000 × creditsPer1kInput + output/1000 ×
 * creditsPer1kOutput), minimum 1, from MODEL_CATALOG for the run's alias.
 * When the provider sent no usage chunk, estimate tokens ≈ chars/4 over the
 * assembled conversation (assistant turns as output, the rest as input).
 */
export function committedCreditsFor(
  model: string,
  usage: UsageAccumulator,
  messages: readonly OpenAIChatMessage[],
): number {
  const descriptor = MODEL_CATALOG[model as ModelId] ?? MODEL_CATALOG["studio-fast"];
  let inputTokens = usage.inputTokens;
  let outputTokens = usage.outputTokens;
  if (!usage.seen) {
    let inputChars = 0;
    let outputChars = 0;
    for (const message of messages) {
      if (message.role === "assistant") outputChars += messageChars(message);
      else inputChars += messageChars(message);
    }
    inputTokens = Math.ceil(inputChars / 4);
    outputTokens = Math.ceil(outputChars / 4);
  }
  const cost =
    (inputTokens / 1000) * descriptor.creditsPer1kInput +
    (outputTokens / 1000) * descriptor.creditsPer1kOutput;
  return Math.max(1, Math.ceil(cost));
}

// ---------------------------------------------------------------------------
// Structured-output plan parsing (§8.6)
// ---------------------------------------------------------------------------

/** Extract the JSON object from a model answer (fences/brace tolerance). */
function extractJsonObject(text: string): unknown {
  let candidate = text.trim();
  if (candidate.startsWith("```")) {
    candidate = candidate.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "");
  }
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function planValidationError(raw: unknown): string {
  const checked = EDIT_PLAN_SCHEMA.safeParse(raw);
  if (checked.success) return "";
  return checked.error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

interface ModelRound {
  readonly text: string;
  readonly calls: readonly AggregatedToolCall[];
}

interface PlanAttempt {
  readonly plan: EditPlan | null;
  readonly errorMessage?: string;
  readonly cancelled?: true;
}

export function createLiteLLMRunner(deps: LiteLLMRunnerDeps): AgentRunner {
  const logger = deps.logger ?? nullLogger;
  const bearer =
    deps.virtualKey !== undefined && deps.virtualKey !== "" ? deps.virtualKey : deps.apiKey;
  const tools = openAiToolSpecs();
  const clientDeps = {
    baseUrl: deps.baseUrl,
    bearer,
    fetch: deps.fetch,
    sleep: deps.sleep,
  };

  /** Stream one model call; `onDelta` streams text out (main rounds only). */
  async function readModelRound(
    model: string,
    messages: readonly OpenAIChatMessage[],
    usage: UsageAccumulator,
    options: { readonly withTools: boolean; readonly onDelta?: (delta: string) => void },
    signal: AbortSignal,
  ): Promise<ModelRound> {
    const request: ChatCompletionRequest = {
      model,
      messages,
      tools: options.withTools ? tools : undefined,
      signal,
    };
    let text = "";
    const calls: AggregatedToolCall[] = [];
    for await (const event of streamChatCompletion(clientDeps, request)) {
      applyUsage(usage, event);
      if (event.type === "text") {
        text += event.delta;
        options.onDelta?.(event.delta);
      } else if (event.type === "tool_call") {
        calls.push(event.call);
      }
    }
    return { text, calls };
  }

  /**
   * studio.plan_edit (§8.4): server-side structured-output call to the SAME
   * alias — a strict JSON prompt validated with EDIT_PLAN_SCHEMA, 2 attempts
   * (the second appends the validation error). Never emits message deltas;
   * the plan reaches the client via the {type:"plan"} event.
   */
  async function serverSidePlan(
    model: string,
    goal: string,
    conversation: readonly OpenAIChatMessage[],
    usage: UsageAccumulator,
    signal: AbortSignal,
  ): Promise<PlanAttempt> {
    const attemptMessages: OpenAIChatMessage[] = [
      ...conversation,
      { role: "user", content: planInstruction(goal) },
    ];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (signal.aborted) return { plan: null, cancelled: true };
      let round: ModelRound;
      try {
        round = await readModelRound(model, attemptMessages, usage, { withTools: false }, signal);
      } catch (error) {
        if (signal.aborted) return { plan: null, cancelled: true };
        if (error instanceof ModelUnavailableError) {
          return { plan: null, errorMessage: "The model service is unavailable right now." };
        }
        return { plan: null, errorMessage: "The plan could not be generated." };
      }
      const parsed = extractJsonObject(round.text);
      const validation = planValidationError(parsed);
      if (parsed !== undefined && validation === "") {
        return { plan: EDIT_PLAN_SCHEMA.parse(parsed) };
      }
      if (attempt === 2) {
        return {
          plan: null,
          errorMessage:
            validation === ""
              ? "The plan was not valid JSON."
              : `The proposed plan failed validation: ${validation}`,
        };
      }
      attemptMessages.push({ role: "assistant", content: round.text });
      attemptMessages.push({
        role: "user",
        content:
          `That was not a valid EditPlan: ${validation || "not valid JSON"}. ` +
          "Respond again with STRICT JSON only — no prose, no markdown fences — matching the EditPlan shape exactly.",
      });
    }
    return { plan: null, errorMessage: "The proposed plan failed validation twice." };
  }

  return {
    async start(run: AgentRun, stream: AgentRunStream): Promise<AgentRunOutcome> {
      const signal = stream.signal;
      const usage: UsageAccumulator = { inputTokens: 0, outputTokens: 0, seen: false };
      const conversation: OpenAIChatMessage[] = [...buildMessages(run)];

      const cancelled = (): AgentRunOutcome => ({ kind: "cancelled" });
      const failed = (code: string, message: string, retryable: boolean): AgentRunOutcome => ({
        kind: "failed",
        code,
        message,
        retryable,
      });

      stream.emit({ type: "run.started", model: run.model });
      await stream.yieldToStream();
      if (signal.aborted) return cancelled();

      const modelFailure = (error: unknown): AgentRunOutcome => {
        if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
          return cancelled();
        }
        if (error instanceof ModelUnavailableError) {
          return failed(
            "RUN_MODEL_UNAVAILABLE",
            "The model service is unavailable right now.",
            true,
          );
        }
        logger.error("litellm_runner_error", {
          runId: run.runId,
          detail: error instanceof Error ? `${error.name}: ${error.message}` : "unknown",
        });
        return failed("INTERNAL", "Something went wrong on our side.", true);
      };

      let invalidToolCalls = 0;
      let rounds = 0;

      while (true) {
        if (signal.aborted) return cancelled();
        if (rounds >= deps.maxSteps) {
          return failed("RUN_STEP_LIMIT", "The agent used too many steps for one message.", false);
        }
        rounds += 1;
        // M4.3 redaction: length + sha256 prefix only — never the body.
        const fingerprint = fingerprintMessages(conversation);
        logger.debug("litellm_model_call", {
          runId: run.runId,
          step: rounds,
          model: run.model,
          promptChars: fingerprint.chars,
          promptSha256: fingerprint.sha256.slice(0, 16),
          promptMessages: fingerprint.messageCount,
        });

        let round: ModelRound;
        try {
          round = await readModelRound(
            run.model,
            conversation,
            usage,
            {
              withTools: true,
              onDelta: (delta) => {
                stream.emit({ type: "message.delta", delta });
              },
            },
            signal,
          );
        } catch (error) {
          return modelFailure(error);
        }
        if (signal.aborted) return cancelled();

        conversation.push(
          round.calls.length > 0
            ? {
                role: "assistant",
                content: round.text,
                tool_calls: round.calls.map((call) => ({
                  id: call.id,
                  type: "function" as const,
                  function: { name: call.name, arguments: call.arguments },
                })),
              }
            : { role: "assistant", content: round.text },
        );
        if (round.calls.length === 0) break; // finish_reason stop — final answer

        for (const call of round.calls) {
          const validated = validateToolCall(call);
          if (!validated.ok) {
            invalidToolCalls += 1;
            if (invalidToolCalls >= 2) {
              return failed(
                "RUN_INVALID_TOOL",
                "The agent requested a tool call we can't validate.",
                false,
              );
            }
            // One repair turn (§8.9): the model sees the validation error as
            // the tool result and may retry with valid args.
            conversation.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify({ error: "VALIDATION_FAILED", message: validated.message }),
            });
            continue;
          }

          stream.expectToolCall(call.id, validated.name);
          stream.emit({
            type: "tool.started",
            toolCallId: call.id,
            name: validated.name,
            args: validated.args,
          });
          await stream.yieldToStream();
          if (signal.aborted) return cancelled();

          if (validated.name === "studio.plan_edit") {
            const goal = (validated.args as { goal?: unknown }).goal;
            const plan = await serverSidePlan(
              run.model,
              typeof goal === "string" ? goal : "",
              conversation,
              usage,
              signal,
            );
            if (plan.cancelled === true) return cancelled();
            if (plan.plan !== null) {
              stream.emit({ type: "plan", plan: plan.plan });
              stream.emit({ type: "tool.result", toolCallId: call.id, result: plan.plan });
              await stream.yieldToStream();
              conversation.push({
                role: "tool",
                tool_call_id: call.id,
                content: JSON.stringify(plan.plan),
              });
            } else {
              stream.emit({
                type: "tool.result",
                toolCallId: call.id,
                result: { error: "PLAN_INVALID", message: plan.errorMessage },
              });
              await stream.yieldToStream();
              conversation.push({
                role: "tool",
                tool_call_id: call.id,
                content: JSON.stringify({ error: "PLAN_INVALID", message: plan.errorMessage }),
              });
            }
          } else {
            const waited = await stream.waitForToolResult(call.id);
            if (!waited.ok) {
              if (signal.aborted) return cancelled();
              if (waited.reason === "timeout") {
                return failed("EDITOR_DISCONNECTED", "The editor didn't respond in time.", true);
              }
              return cancelled();
            }
            // The runs route already emitted the log's tool.result event when
            // the client POSTed it; do not duplicate it here.
            conversation.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify(waited.result),
            });
          }
          if (signal.aborted) return cancelled();
        }
      }

      return {
        kind: "completed",
        committedCredits: committedCreditsFor(run.model, usage, conversation),
      };
    },

    cancel() {
      // The registry's AbortSignal is the single cancel path: it aborts the
      // in-flight provider fetch/stream and every tool-result wait.
    },
  };
}
