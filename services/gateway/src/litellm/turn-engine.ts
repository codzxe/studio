// @studio/gateway — the round-12 TURN ENGINE (client-driven agent loop,
// docs/research/round12-design.md "TURN WIRE CONTRACT").
//
// STATELESS per turn: the browser owns the agent loop and the engine tools;
// the gateway does auth → history → ONE AI-SDK model call → write-tool compile
// → persist → commit. No cross-request server state, no in-memory run logs,
// no server-side multi-round loop — the round-10 "stuck in a loop" class
// (serverless 60s hard-kill → idempotent replay MISS → duplicate run →
// client drops foreign events → RUN_PAUSED → retry → infinite) is now
// IMPOSSIBLE BY CONSTRUCTION: a turn is one bounded model call, retried
// idempotently by (runId, stepIndex).
//
// The transport is the proven AI SDK v7 seam (openai.ts streamChatCompletion —
// createOpenAICompatible + streamText + the underscore tool-name seam for
// strict providers like Token Harbor). This module owns:
//
//   1. buildTurnMessages — system prompt + thread history (loadThreadHistory,
//      40 messages / 24k chars, tool parts included) + canvas/context notes +
//      the current run transcript → OpenAIChatMessage[].
//   2. executeModelTurn — ONE model call: text deltas streamed out live,
//      tool calls aggregated, usage collected (§8.8).
//   3. resolveToolCall — §8.4/§8.9 validation; write tools compile to
//      PROPOSE-ONLY carriers (writeToolCarrierPlan + the plan compiler) with
//      the compiled proposal riding turn.completed for the client's plan
//      accumulator; studio.plan_edit stays SERVER-SIDE (structured-output
//      side call, 2 attempts — the proven §8.6 path, kept off the wire).
//   4. committedCreditsFor — §8.8 usage → credits (MODEL_CATALOG rates,
//      chars/4 fallback, min 1) — byte-identical semantics to the old runner.
//   5. mockTurn — MOCK_MODEL=true canned journey (the e2e mock: one turn of
//      propose-only write carriers, one closing text turn) so the offline
//      stack drives the full loop with zero model keys.
//
// Redaction (M4.3): the logger receives ONLY lengths + sha256 prefixes
// (prompt.ts fingerprintMessages) — never bodies.

import { z } from "zod";

import {
  type ContextSelection,
  EDIT_PLAN_SCHEMA,
  type EditPlan,
  MAX_BATCH_LABEL_LENGTH,
  MAX_PLAN_STEPS,
  MAX_PLAN_SUMMARY_LENGTH,
  MODEL_CATALOG,
  type ModelId,
  PROPOSED_BATCH_NOTE,
  type PinnedContextItem,
  type PlanIntent,
  type PlanRisk,
  TOOL_LIST,
  type ToolDefinition,
  type TurnCanvas,
  type TurnMessage,
  type TurnToolCall,
  WRITE_TOOL_RESULT_SCHEMA,
  estimateCredits,
} from "@studio/contracts";

import { type Logger, nullLogger } from "../logger.js";
import { compilePlan as compilePlanWithCompiler, defaultCompileDeps } from "../plan-compiler.js";
import {
  type AggregatedToolCall,
  type ChatCompletionRequest,
  type ModelStreamEvent,
  ModelUnavailableError,
  type OpenAIChatMessage,
  type OpenAIToolSpec,
  streamChatCompletion,
} from "./openai.js";
import { SYSTEM_PROMPT, planInstruction } from "./prompt.js";

// ---------------------------------------------------------------------------
// Tool registrations on the wire (§8.4 curated + round-12 v3 additions)
// ---------------------------------------------------------------------------

/** Everything the model can call this turn: the full v3 catalog (TOOL_LIST). */
export const TURN_TOOLS: readonly ToolDefinition[] = TOOL_LIST;

const TOOL_BY_ID: ReadonlyMap<string, ToolDefinition> = new Map(
  TURN_TOOLS.map((tool) => [tool.id, tool]),
);

/** Read/plan/generative tool ids — the CLIENT executes these locally. */
const CLIENT_EXECUTED_TOOLS: ReadonlySet<string> = new Set(
  TURN_TOOLS.filter((tool) => tool.kind !== "write").map((tool) => tool.id),
);

export function isClientExecutedTool(id: string): boolean {
  return CLIENT_EXECUTED_TOOLS.has(id);
}

/** Tool registrations for the provider, derived from the Zod args schemas. */
export function turnOpenAiToolSpecs(): OpenAIToolSpec[] {
  return TURN_TOOLS.map((tool) => ({
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
  return Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$schema"));
}

// ---------------------------------------------------------------------------
// Prompt assembly: history + notes + transcript → OpenAIChatMessage[]
// ---------------------------------------------------------------------------

/** One row from repos.threads.loadThreadHistory (oldest-first). */
export interface TurnHistoryRow {
  readonly role: "user" | "assistant" | "tool";
  readonly text?: string;
  readonly contentJson?: unknown;
  readonly runId?: string | null;
}

/** History is capped by BOTH count and chars (loadThreadHistory defaults). */
export const TURN_HISTORY_MAX_MESSAGES = 2_000;
export const TURN_HISTORY_MAX_CHARS = 1_600_000;

/** Tool-result bodies are compacted to this size inside history. */
const HISTORY_TOOL_RESULT_CHARS = 2_000;

interface ToolRowPayload {
  readonly kind?: unknown;
  readonly toolCallId?: unknown;
  readonly tool?: unknown;
  readonly payload?: unknown;
  readonly result?: unknown;
  readonly args?: unknown;
}

function compactForHistory(value: unknown): string {
  const text = JSON.stringify(value) ?? "null";
  if (text.length <= HISTORY_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, HISTORY_TOOL_RESULT_CHARS - 1)}…`;
}

function canvasNote(canvas: TurnCanvas): string {
  const layers =
    canvas.layers.length === 0
      ? "no layers"
      : `${canvas.layers.length} layers: ${canvas.layers
          .slice(0, 40)
          .map((layer) => `${layer.name} (${layer.type})`)
          .join(", ")}`;
  const selection =
    canvas.selection.length === 0
      ? "nothing selected"
      : canvas.selection
          .slice(0, 10)
          .map((id) => canvas.layers.find((layer) => layer.id === id)?.name ?? `layer ${id}`)
          .join(", ");
  return [
    "Current canvas state:",
    `- Active composition: ${canvas.activeComp ?? "none"}`,
    `- Layers: ${layers}`,
    `- Selection: ${selection}`,
    `- Playhead: ${canvas.playhead}s; composition: ${canvas.duration}s at ${canvas.fps}fps`,
  ].join("\n");
}

function contextFlagsNote(context: ContextSelection): string {
  const enabled = Object.entries(context)
    .filter(([, enabled]) => enabled === true)
    .map(([key]) => key);
  return `Context blocks the user enabled for this message: ${
    enabled.length > 0 ? enabled.join(", ") : "none"
  }. The studio.get_context tool returns only these blocks; a missing block was removed by the user.`;
}

function pinnedNote(pinned: readonly PinnedContextItem[]): string {
  if (pinned.length === 0) return "";
  return `Pinned context for this message: ${pinned
    .map((item) => `${item.kind}: ${item.label}`)
    .join("; ")}.`;
}

/** Map one loadThreadHistory row → OpenAI wire messages (tool rows expand). */
function historyRowToMessages(row: TurnHistoryRow): OpenAIChatMessage[] {
  if (row.role === "user") {
    return [{ role: "user", content: row.text ?? "" }];
  }
  if (row.role === "assistant") {
    const text = row.text ?? "";
    if (text === "") return [];
    return [{ role: "assistant", content: text }];
  }
  // Tool rows: { kind:"tool", toolCallId, tool, payload:{args,result} } —
  // rebuilt as the assistant tool-call + its tool result so the model sees
  // WHAT it called and WHAT came back.
  const payload = (row.contentJson ?? {}) as ToolRowPayload;
  if (payload.kind !== "tool" || typeof payload.tool !== "string") return [];
  const toolCallId =
    typeof payload.toolCallId === "string" && payload.toolCallId !== ""
      ? payload.toolCallId
      : `hist_${Math.random().toString(36).slice(2, 10)}`;
  // The turn route persists contentJson = {kind,toolCallId,tool,payload:{args,result}}
  // (12-w5-t3/t7 pin). Legacy pre-round-12 rows degrade to result-only.
  const nested =
    typeof payload.payload === "object" && payload.payload !== null
      ? (payload.payload as { args?: unknown; result?: unknown })
      : {};
  const args =
    typeof nested.args === "object" && nested.args !== null
      ? nested.args
      : typeof payload.args === "object" && payload.args !== null
        ? payload.args
        : {};
  const result = nested.result !== undefined ? nested.result : (payload.result ?? null);
  return [
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: toolCallId,
          type: "function",
          function: { name: payload.tool, arguments: JSON.stringify(args) },
        },
      ],
    },
    { role: "tool", tool_call_id: toolCallId, content: compactForHistory(result) },
  ];
}

/** Map one transcript part → OpenAI wire message(s). */
function transcriptPartToMessages(part: TurnMessage): OpenAIChatMessage[] {
  switch (part.role) {
    case "user":
    case "steer":
      return [{ role: "user", content: part.text }];
    case "assistant":
      return part.text === "" ? [] : [{ role: "assistant", content: part.text }];
    case "tool_call":
      return [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: part.toolCallId,
              type: "function",
              function: { name: part.tool, arguments: JSON.stringify(part.args ?? {}) },
            },
          ],
        },
      ];
    case "tool_result":
      return [
        {
          role: "tool",
          tool_call_id: part.toolCallId,
          content: compactForHistory(part.result),
        },
      ];
  }
}

export interface BuildTurnMessagesInput {
  readonly history: readonly TurnHistoryRow[];
  readonly transcript: readonly TurnMessage[];
  readonly canvas?: TurnCanvas | null;
  readonly context?: ContextSelection;
  readonly pinned?: readonly PinnedContextItem[];
  /**
   * The run the current transcript belongs to (12-w6-g1: history rows of the
   * SAME run are dropped — the cumulative transcript already carries them,
   * so a step>0 prompt would otherwise duplicate every user/assistant/tool
   * part of the run).
   */
  readonly currentRunId?: string;
}

/**
 * The full prompt for one turn: system prompt, thread history (capped, tool
 * parts included — the round-12 "the model never sees chat/tool history" fix),
 * the canvas + context notes (system role; toSdkPrompt folds them into the
 * instructions), then the CURRENT RUN transcript verbatim.
 */
export function buildTurnMessages(input: BuildTurnMessagesInput): OpenAIChatMessage[] {
  const messages: OpenAIChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  for (const row of input.history) {
    if (input.currentRunId !== undefined && row.runId === input.currentRunId) continue;
    messages.push(...historyRowToMessages(row));
  }
  const notes: string[] = [];
  if (input.canvas != null) notes.push(canvasNote(input.canvas));
  if (input.context !== undefined) notes.push(contextFlagsNote(input.context));
  const pinnedLine = input.pinned === undefined ? "" : pinnedNote(input.pinned);
  if (pinnedLine !== "") notes.push(pinnedLine);
  if (notes.length > 0) {
    messages.push({ role: "system", content: notes.join("\n\n") });
  }
  for (const part of input.transcript) {
    messages.push(...transcriptPartToMessages(part));
  }
  return messages;
}

// ---------------------------------------------------------------------------
// ONE model call (the whole turn)
// ---------------------------------------------------------------------------

export interface OpenAITurnDeps {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly virtualKey?: string | undefined;
  readonly modelMap?: Readonly<Record<string, string>> | undefined;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly logger?: Logger;
}

export interface ModelTurnResult {
  readonly text: string;
  /** The turn's full thinking text (ROUND 13 live thinking; "" when the
   * provider emits no reasoning tokens). */
  readonly reasoning: string;
  readonly calls: readonly AggregatedToolCall[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly usageSeen: boolean;
  readonly finishReason: string;
}

/** ONE streamed model call; deltas stream out live via `onDelta` (text) and
 * `onReasoningDelta` (thinking tokens — ROUND 13 live thinking). */
export async function executeModelTurn(
  deps: OpenAITurnDeps,
  input: {
    readonly model: string;
    readonly messages: readonly OpenAIChatMessage[];
    readonly withTools: boolean;
    readonly signal: AbortSignal;
    readonly onDelta?: (delta: string) => void;
    readonly onReasoningDelta?: (delta: string) => void;
  },
): Promise<ModelTurnResult> {
  const bearer =
    deps.virtualKey !== undefined && deps.virtualKey !== "" ? deps.virtualKey : deps.apiKey;
  const request: ChatCompletionRequest = {
    model: input.model,
    messages: input.messages,
    tools: input.withTools ? turnOpenAiToolSpecs() : undefined,
    signal: input.signal,
  };
  let text = "";
  let reasoning = "";
  const calls: AggregatedToolCall[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let usageSeen = false;
  let finishReason = "stop";
  for await (const event of streamChatCompletion(
    {
      baseUrl: deps.baseUrl,
      bearer,
      modelMap: deps.modelMap,
      fetch: deps.fetch,
      sleep: deps.sleep,
    },
    request,
  )) {
    if (event.type === "text") {
      text += event.delta;
      input.onDelta?.(event.delta);
    } else if (event.type === "reasoning") {
      reasoning += event.delta;
      input.onReasoningDelta?.(event.delta);
    } else if (event.type === "tool_call") {
      calls.push(event.call);
    } else if (event.type === "usage") {
      inputTokens += event.usage.inputTokens;
      outputTokens += event.usage.outputTokens;
      usageSeen = true;
    } else if (event.type === "finish") {
      finishReason = event.reason;
    }
  }
  return { text, reasoning, calls, inputTokens, outputTokens, usageSeen, finishReason };
}

// ---------------------------------------------------------------------------
// §8.8 credits (byte-identical semantics to the retired runner)
// ---------------------------------------------------------------------------

function messageChars(message: OpenAIChatMessage): number {
  const serialized = JSON.stringify(message);
  return serialized === undefined ? 0 : serialized.length;
}

/** ceil(input/1000×rateIn + output/1000×rateOut), min 1 (§8.8). */
export function committedCreditsFor(
  model: string,
  usage: { inputTokens: number; outputTokens: number; usageSeen: boolean },
  messages: readonly OpenAIChatMessage[],
): number {
  const descriptor = MODEL_CATALOG[model as ModelId] ?? MODEL_CATALOG["studio-fast"];
  let inputTokens = usage.inputTokens;
  let outputTokens = usage.outputTokens;
  if (!usage.usageSeen) {
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
// Write-tool carriers (PROPOSE-ONLY, §8.4/§8.7 — ported from the retired
// runner; one source of truth: the plan compiler)
// ---------------------------------------------------------------------------

/** EditPlan intent per write tool (§8.6 vocabulary; undo/save are structural). */
const WRITE_TOOL_INTENTS: Readonly<Record<string, PlanIntent>> = {
  "studio.create_composition": "create",
  "studio.create_text": "create",
  "studio.set_properties": "edit",
  "studio.add_effect": "style",
  "studio.set_keyframes": "animate",
  "studio.apply_preset": "animate",
  "studio.engine_commands": "edit",
  "studio.run_script": "animate",
  "studio.add_asset": "create",
  "studio.undo_run": "organize",
  "studio.save_version": "organize",
};

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function clamp280(value: string): string {
  return value.length <= MAX_PLAN_SUMMARY_LENGTH
    ? value
    : `${value.slice(0, MAX_PLAN_SUMMARY_LENGTH - 1)}…`;
}

/** Deterministic HUMAN summary of one write-tool call (§8.6 display data). */
export function writeToolSummary(toolId: string, args: Record<string, unknown>): string {
  const layerNames = array(args.layers)
    .map((layer) =>
      typeof layer === "object" && layer !== null
        ? str((layer as Record<string, unknown>).name)
        : "",
    )
    .filter((name) => name !== "");
  switch (toolId) {
    case "studio.create_composition":
      return `Create composition "${str(args.name)}"`;
    case "studio.create_text": {
      const content = str(args.text);
      const label = str(args.name) || (content.length > 40 ? `${content.slice(0, 39)}…` : content);
      return `Add text layer "${label}"`;
    }
    case "studio.set_properties": {
      const updates = array(args.properties).length;
      const noun = updates === 1 ? "property" : "properties";
      const layers = layerNames.length === 0 ? 1 : layerNames.length;
      return `Set ${updates} ${noun} on ${layers} layer${layers > 1 ? "s" : ""}`;
    }
    case "studio.add_effect":
      return `Add effect "${str(
        typeof args.effect === "object" && args.effect !== null
          ? str((args.effect as Record<string, unknown>).name)
          : "",
      )}" to ${layerNames.length} layer${layerNames.length === 1 ? "" : "s"}`;
    case "studio.set_keyframes":
      return `Set ${array(args.keys).length} keyframes on ${str(args.propertyPath)} of ${
        layerNames.length
      } layer${layerNames.length === 1 ? "" : "s"}`;
    case "studio.apply_preset": {
      const preset =
        typeof args.preset === "object" && args.preset !== null
          ? str((args.preset as Record<string, unknown>).name) ||
            str((args.preset as Record<string, unknown>).builtinId)
          : "";
      const targets = layerNames.length > 0 ? layerNames.length : 1;
      return `Apply preset "${preset}" to ${targets} layer${targets === 1 ? "" : "s"}`;
    }
    case "studio.engine_commands":
      return `Run ${array(args.steps).length} engine command${array(args.steps).length === 1 ? "" : "s"}`;
    case "studio.run_script":
      return `Run an engine script (${str(args.code).length} chars)`;
    case "studio.add_asset":
      return `Add ${str(args.kind)} asset "${str(args.name)}"`;
    case "studio.undo_run":
      return "Undo the most recent applied agent run";
    case "studio.save_version":
      return str(args.label) === ""
        ? "Save a version snapshot of the project"
        : `Save a version snapshot labeled "${str(args.label)}"`;
    default:
      return `Propose ${toolId.replace(/^studio\./, "")}`;
  }
}

/** The one-step EditPlan CARRIER for a validated write-tool call (M5-C seam). */
export function writeToolCarrierPlan(tool: ToolDefinition, args: unknown): EditPlan {
  const record = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  const summary = clamp280(writeToolSummary(tool.id, record));
  const carrier = {
    intent: WRITE_TOOL_INTENTS[tool.id] ?? "edit",
    summary,
    risk: tool.risk,
    requiresApproval: tool.risk !== "low",
    affectedLayers: [],
    estimatedCredits: estimateCredits({ risk: tool.risk, steps: [{}] }),
    steps: [
      {
        title: summary,
        tool: tool.id,
        args,
        batch: {
          label: `Agent: ${summary}`.slice(0, MAX_BATCH_LABEL_LENGTH),
          atomic: true,
          steps: [{ command: tool.id.replace(/^studio\./, ""), params: record }],
        },
      },
    ],
  };
  return EDIT_PLAN_SCHEMA.parse(carrier);
}

/** The propose-only tool result the MODEL sees (§8.4 rules 1-5). */
export function proposedBatchResult(carrier: EditPlan): unknown {
  const step = carrier.steps[0];
  return WRITE_TOOL_RESULT_SCHEMA.parse({
    proposedBatch: step?.batch ?? { label: carrier.summary, steps: [] },
    note: PROPOSED_BATCH_NOTE,
  });
}

/** First compiler issue as a bounded message (mirrors the old PLAN_INVALID). */
function compileIssueMessage(issues: readonly { message: string }[]): string {
  const first = issues[0]?.message ?? "The proposed change failed validation.";
  const suffix = issues.length > 1 ? ` (+${issues.length - 1} more issues)` : "";
  return `${first}${suffix}`.slice(0, MAX_PLAN_SUMMARY_LENGTH);
}

export interface CompiledProposal {
  readonly resultForModel: unknown;
  readonly proposal: NonNullable<TurnToolCall["proposal"]>;
}

/**
 * Resolve ONE write-tool call: validate args → carrier → server-side compile.
 * Compile output rides the proposal (the client's plan accumulator); the
 * model sees the §8.4 propose-only result. Never throws — a compile failure
 * degrades to a repairable validation message.
 */
export async function resolveWriteToolCall(
  tool: ToolDefinition,
  args: unknown,
): Promise<CompiledProposal> {
  const carrier = writeToolCarrierPlan(tool, args);
  const compiled = compilePlanWithCompiler({ plan: carrier }, defaultCompileDeps());
  if (compiled.ok) {
    return {
      resultForModel: proposedBatchResult(carrier),
      proposal: {
        compiled: {
          batch: compiled.batch,
          risk: compiled.risk,
          estimatedCredits: compiled.estimatedCredits,
          resolutionRequests: compiled.resolutionRequests.map((request) => ({
            requestId: request.requestId,
            layerName: request.layerName,
            disambiguation: [...request.disambiguation],
          })),
        },
      },
    };
  }
  return {
    resultForModel: {
      error: "PLAN_INVALID",
      message: compileIssueMessage(compiled.issues),
    },
    proposal: {
      compiled: {
        // The compile FAILED — the carrier's PSEUDO batch rides the proposal
        // so the turn.completed frame stays §7.4-VALID (AGENT_BATCH_SCHEMA
        // requires ≥ 1 step; an empty batch would make the client's schema
        // validator drop the WHOLE terminal frame — 12-w6-g1 BUG-1). The
        // pseudo batch never executes (compile failed ⇒ the apply route
        // re-validates + the client gate re-checks every id).
        batch: {
          label: carrier.steps[0]?.batch.label ?? carrier.summary,
          atomic: true,
          steps: [
            {
              command: carrier.steps[0]?.batch.steps[0]?.command ?? "invalid",
              params: (carrier.steps[0]?.batch.steps[0]?.params as Record<string, unknown>) ?? {},
            },
          ],
        },
        risk: carrier.risk,
        estimatedCredits: carrier.estimatedCredits,
        resolutionRequests: [],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// studio.plan_edit — the structured-output side call (§8.4/§8.6, server-side)
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
  // No JSON object extracted at all (prose without braces, "nope"): the
  // schema's safeParse(undefined) reports a "(root): Invalid input: expected
  // object, received undefined" issue — a Zod artifact that leaked into the
  // user's plan card AND the model's repair prompt, where it explains
  // nothing (there was no object to validate). Return "" so the caller's
  // parsed===undefined branch reports the honest "The plan was not valid
  // JSON." (both the final message and the retry-repair instruction).
  if (raw === undefined) return "";
  const checked = EDIT_PLAN_SCHEMA.safeParse(coerceStringifiedJson(raw));
  if (checked.success) return "";
  return checked.error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

export interface ServerSidePlanResult {
  readonly plan: EditPlan | null;
  readonly errorMessage?: string;
  readonly cancelled?: true;
  /** §8.8 honesty (12-w6-g1): the side call's tokens, billed with the turn. */
  readonly usage?: { inputTokens: number; outputTokens: number };
}

/**
 * studio.plan_edit: a structured-output call to the SAME alias (strict JSON
 * prompt + EDIT_PLAN_SCHEMA, 2 attempts) — the proven §8.6 side call, now
 * inside the turn (one extra bounded model call; the plan is the tool's
 * result and its compile rides the proposal for the client's card).
 */
export async function serverSidePlan(
  deps: OpenAITurnDeps,
  input: {
    readonly model: string;
    readonly goal: string;
    readonly conversation: readonly OpenAIChatMessage[];
    readonly signal: AbortSignal;
  },
): Promise<ServerSidePlanResult> {
  let usageAccumulator = { inputTokens: 0, outputTokens: 0 };
  const attemptMessages: OpenAIChatMessage[] = [
    ...input.conversation,
    { role: "user", content: planInstruction(input.goal) },
  ];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (input.signal.aborted) return { plan: null, cancelled: true };
    let round: ModelTurnResult;
    try {
      round = await executeModelTurn(deps, {
        model: input.model,
        messages: attemptMessages,
        withTools: false,
        signal: input.signal,
      });
    } catch (error) {
      if (input.signal.aborted) return { plan: null, cancelled: true };
      if (error instanceof ModelUnavailableError) {
        return { plan: null, errorMessage: "The model service is unavailable right now." };
      }
      return { plan: null, errorMessage: "The plan could not be generated." };
    }
    usageAccumulator = {
      inputTokens: usageAccumulator.inputTokens + round.inputTokens,
      outputTokens: usageAccumulator.outputTokens + round.outputTokens,
    };
    const parsed = coerceStringifiedJson(extractJsonObject(round.text));
    const validation = planValidationError(parsed);
    if (parsed !== undefined && validation === "") {
      return { plan: EDIT_PLAN_SCHEMA.parse(parsed), usage: usageAccumulator };
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
      content: `That was not a valid EditPlan: ${
        validation || "not valid JSON"
      }. Respond again with STRICT JSON only — no prose, no markdown fences — matching the EditPlan shape exactly.`,
    });
  }
  return { plan: null, errorMessage: "The proposed plan failed validation twice." };
}

// ---------------------------------------------------------------------------
// §8.9 tool-call validation (one repair turn, then the client's repetition
// guard aborts — same vocabulary as the retired runner)
// ---------------------------------------------------------------------------

export type ValidatedToolCall =
  | { readonly ok: true; readonly name: string; readonly args: unknown }
  | { readonly ok: false; readonly message: string };

export function validateToolCall(call: AggregatedToolCall): ValidatedToolCall {
  const tool = TOOL_BY_ID.get(call.name);
  if (tool === undefined) {
    return {
      ok: false,
      message: `Unknown tool "${call.name}". Available tools: ${TURN_TOOLS.map((t) => t.id).join(", ")}.`,
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
  const checked = tool.args.safeParse(coerceStringifiedJson(parsedArgs));
  if (!checked.success) {
    const detail = checked.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: `Invalid arguments for ${tool.id}: ${detail}` };
  }
  return { ok: true, name: tool.id, args: checked.data };
}

/** The registered tool for a (possibly underscore-echoed) id, or null. */
export function registeredToolFor(name: string): ToolDefinition | null {
  return TOOL_BY_ID.get(name) ?? null;
}

/**
 * LLM arg repair: stringified JSON in structured fields.
 *
 * Some models (observed with glm-4-plus in the local bridge) emit
 * array/object arguments as JSON-encoded STRINGS — `"[{\"name\":…}]"`
 * instead of `[{"name":…}]`, `"[255, 255, 255]"` instead of `[255, 255,
 * 255]`. The write-tool schemas are strict, so every such call fails
 * validation: the run degrades (steps silently dropped, repair turns
 * burned, plans that animate nothing). One bounded, depth-capped pass:
 * any string that LOOKS like JSON (leading `{`/`[` after whitespace) and
 * PARSES is replaced by its parsed value, recursively — then the strict
 * schema still has the final say (shapes, bounds, dunder keys). A string
 * that looks like JSON but does not parse is left untouched so the schema
 * error still explains the real problem.
 */
export function coerceStringifiedJson(value: unknown, depth = 0): unknown {
  if (depth > 6) return value;
  if (typeof value === "string") {
    const trimmed = value.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return coerceStringifiedJson(JSON.parse(value), depth + 1);
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => coerceStringifiedJson(entry, depth + 1));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] =
        NUMERIC_ARG_FIELDS.has(key) &&
        typeof child === "string" &&
        /^-?\d+(?:\.\d+)?$/.test(child.trim())
          ? Number(child.trim())
          : coerceStringifiedJson(child, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Object fields the curated write-tool schemas type as NUMBERS, observed
 * stringified by weak models ("width":"1920"). Only clean integer/decimal
 * strings under these names coerce — a bare scalar repair, never applied to
 * names, paths, or free-form values (those stay strings so the strict schema
 * still rejects genuinely wrong shapes).
 */
const NUMERIC_ARG_FIELDS: ReadonlySet<string> = new Set([
  "width",
  "height",
  "frameRate",
  "durationSeconds",
  "size",
  "timeSeconds",
  "duration",
]);

/** Write tools are exactly the catalog's kind:"write" entries. */
export function isWriteTool(tool: ToolDefinition): boolean {
  return tool.kind === "write";
}

/** The §8.6 20-step merge cap re-export (mergeEditPlans in contracts). */
export { mergeEditPlans } from "@studio/contracts";

export const TURN_ENGINE_LOGGER = nullLogger;
