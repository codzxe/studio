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
  AUTO_APPLY_BATCH_NOTE,
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
  batchCreatedCompositionNames,
  batchCreatedLayerNames,
  estimateCredits,
  isAutoApplicable,
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

/** History is capped by BOTH count and chars (loadThreadHistory defaults —
 * the DB window stays wide because the durable REPLAY lookup scans it; the
 * MODEL-facing budget is applied in buildTurnMessages, not here). */
export const TURN_HISTORY_MAX_MESSAGES = 2_000;
export const TURN_HISTORY_MAX_CHARS = 1_600_000;

// ---------------------------------------------------------------------------
// PROMPT BUDGET (2026-11-02 token-management round).
//
// f62251b raised the DB history window to "unlimited", so every model call
// re-sent the ENTIRE thread — every past user message, tool call and tool
// result — as full-price input (real deployment: ~50k input tokens per step,
// the complaint this budget answers). The loader keeps the wide window for
// replay; the prompt assembler applies the real budget:
//
//   1. HISTORY WINDOW — at most the newest 60 rows / 60k chars of PRIOR
//      conversation reach the model (≈15k tokens). Durable work lives in the
//      project (the canvas note + apply receipts summarize it), not in an
//      ever-growing transcript.
//   2. TIERED RESULT COMPACTION — history tool results and transcript tool
//      results older than the recent window compact to 480 chars; only the
//      CURRENT run's 8 most recent tool results keep the full 2000-char
//      window the model is actively acting on.
//   3. CACHE-STABLE RENDERING — compaction is a pure function of row
//      content and the fallback tool-call ids are deterministic (djb2, no
//      Math.random), so as the thread grows the rendered prefix stays
//      byte-identical and the provider's implicit prompt cache (Z.ai GLM
//      context caching, OpenAI automatic prefix caching) actually HITS:
//      cached input bills at ~18-20% of full price on those providers.
// ---------------------------------------------------------------------------
export const TURN_PROMPT_MAX_HISTORY_MESSAGES = 60;
export const TURN_PROMPT_MAX_HISTORY_CHARS = 60_000;
export const TURN_PROMPT_MAX_TRANSCRIPT_PARTS = 160;
export const TURN_PROMPT_MAX_TRANSCRIPT_CHARS = 80_000;

/** Tool-result bodies compact to this size in history and in the transcript
 * beyond the recent window. */
const HISTORY_TOOL_RESULT_CHARS = 480;
/** The current run's most recent tool results keep this richer window. */
const TRANSCRIPT_RECENT_RESULTS = 8;
const TRANSCRIPT_RECENT_RESULT_CHARS = 2_000;

interface ToolRowPayload {
  readonly kind?: unknown;
  readonly toolCallId?: unknown;
  readonly tool?: unknown;
  readonly payload?: unknown;
  readonly result?: unknown;
  readonly args?: unknown;
}

function compactForHistory(value: unknown, maxChars: number): string {
  const text = JSON.stringify(value) ?? "null";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

/**
 * Deterministic fallback tool-call id for legacy history rows that persisted
 * without one. A Math.random id here would re-render every replayed prompt
 * differently and defeat the provider's prefix cache; djb2 over the row's
 * own content keeps the rendering byte-stable across calls.
 */
function stableFallbackToolCallId(tool: string, args: unknown): string {
  const basis = `${tool}:${JSON.stringify(args) ?? ""}`;
  let hash = 5381;
  for (let index = 0; index < basis.length; index += 1) {
    hash = (((hash << 5) + hash + basis.charCodeAt(index)) | 0) >>> 0;
  }
  return `hist_${hash.toString(36)}`;
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
  // The turn route persists contentJson = {kind,toolCallId,tool,payload:{args,result}}
  // (12-w5-t3/t7 pin). Legacy pre-round-12 rows degrade to result-only.
  const nested =
    typeof payload.payload === "object" && payload.payload !== null
      ? (payload.payload as { args?: unknown; result?: unknown })
      : {};
  const toolCallId =
    typeof payload.toolCallId === "string" && payload.toolCallId !== ""
      ? payload.toolCallId
      : stableFallbackToolCallId(payload.tool, nested.args ?? payload.args ?? {});
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
    { role: "tool", tool_call_id: toolCallId, content: compactForHistory(result, HISTORY_TOOL_RESULT_CHARS) },
  ];
}

/** Map one transcript part → OpenAI wire message(s). `resultMaxChars` is the
 * compaction tier for tool_result bodies (recent results keep more). */
function transcriptPartToMessages(
  part: TurnMessage,
  resultMaxChars: number,
): OpenAIChatMessage[] {
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
          content: compactForHistory(part.result, resultMaxChars),
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
  /**
   * APPLY FEEDBACK (2026-11-01 root-cause fix): the client's apply-engine
   * failure messages for earlier turns of THIS run. Without them the model
   * never learns a proposal failed to apply — it only sees the canvas revert
   * and re-proposes the same thing (run 59cead8c: the model apologized and
   * re-created the composition verbatim). Rendered as a system note with a
   * fix-it instruction.
   */
  readonly applyNotes?: readonly string[];
  /**
   * APPLY RECEIPTS (round 14 — the verification half of the loop): what the
   * client's apply engine CONFIRMED applied since the last turn. Rendered as
   * a system note that tells the model exactly what is ALREADY in the canvas
   * — the anti-duplicate, anti-ghost signal: never re-create these, build on
   * them, and verify visually (render_preview) instead of assuming.
   */
  readonly applyReceipts?: readonly string[];
}

/**
 * The full prompt for one turn: system prompt, thread history (capped, tool
 * parts included — the round-12 "the model never sees chat/tool history" fix),
 * the canvas + context + apply-feedback notes (system role; toSdkPrompt folds
 * them into the instructions), then the CURRENT RUN transcript verbatim.
 */
function applyFeedbackNote(notes: readonly string[]): string {
  const lines = notes
    .filter((note) => typeof note === "string" && note.length > 0)
    .slice(0, 3)
    .map((note) => `- ${note.slice(0, 400)}`);
  if (lines.length === 0) return "";
  return [
    "APPLY FEEDBACK — this proposal FAILED to apply, so the canvas did NOT change:",
    ...lines,
    "Read the failure, FIX its cause (reference real layer names, use grouped property " +
      "paths, valid colors), and continue the plan. NEVER re-propose the identical change " +
      "verbatim — it will fail again.",
  ].join("\n");
}

/**
 * Round 14 — the receipts side of the apply loop. Every line is a change the
 * client's apply engine EXECUTED and SAVED (summary + version). The note is
 * phrased as ground truth: this work exists NOW, extending it is the only
 * valid move — re-creating any of it duplicates layers, the exact failure
 * mode the continuity rule below exists for.
 */
export function applyReceiptsNote(receipts: readonly string[]): string {
  const lines = receipts
    .filter((receipt) => typeof receipt === "string" && receipt.length > 0)
    .slice(0, 8)
    .map((receipt) => `- ${receipt.slice(0, 300)}`);
  if (lines.length === 0) return "";
  return [
    "APPLY RECEIPTS — these proposals were APPLIED to the project and SAVED " +
      "(they are in the canvas now):",
    ...lines,
    "Treat every receipt as existing work: build on it, NEVER re-create or duplicate it. " +
      "When a receipt names a layer you still need to style or animate, reference that " +
      "exact name. Before you claim a visual milestone is done, verify it with " +
      "studio.render_preview or studio.get_properties — a proposed-and-applied tool result " +
      "is the apply engine's word, your eyes are yours.",
  ].join("\n");
}

/** Prior-conversation rows that reach the model: newest-wins window over the
 * (already current-run-filtered) rows, capped by BOTH count and rendered
 * chars. Rows are self-contained when rendered (each tool row expands to its
 * own assistant-tool_call + tool-result pair), so any window is a valid
 * OpenAI message sequence — no orphan risk at the cut. */
function boundedHistory(
  rows: readonly TurnHistoryRow[],
  currentRunId: string | undefined,
): readonly TurnHistoryRow[] {
  const eligible =
    currentRunId === undefined
      ? rows
      : rows.filter((row) => row.runId !== currentRunId);
  if (eligible.length <= TURN_PROMPT_MAX_HISTORY_MESSAGES) {
    // Fast path — but the char cap can still bite (a few huge rows).
    let total = 0;
    for (const row of eligible) total += historyRowChars(row);
    if (total <= TURN_PROMPT_MAX_HISTORY_CHARS) return eligible;
  }
  const kept: TurnHistoryRow[] = [];
  let chars = 0;
  for (let index = eligible.length - 1; index >= 0; index -= 1) {
    const row = eligible[index] as TurnHistoryRow;
    if (kept.length >= TURN_PROMPT_MAX_HISTORY_MESSAGES) break;
    const cost = historyRowChars(row);
    if (kept.length > 0 && chars + cost > TURN_PROMPT_MAX_HISTORY_CHARS) break;
    kept.unshift(row);
    chars += cost;
  }
  return kept;
}

/** Rendered-cost model for one history row (mirrors the DB loader's
 * JSON.stringify budget; text rows cost their text). */
function historyRowChars(row: TurnHistoryRow): number {
  if (row.role !== "tool") return (row.text ?? "").length;
  return JSON.stringify(row.contentJson ?? {}).length;
}

/** Transcript parts that reach the model: newest-wins window capped by BOTH
 * count and chars, with the start aligned off leading tool_result parts (a
 * tool result whose tool_call part was cut would reference a missing call id
 * and the provider would 400 the whole prompt). */
function boundedTranscript(parts: readonly TurnMessage[]): readonly TurnMessage[] {
  if (
    parts.length <= TURN_PROMPT_MAX_TRANSCRIPT_PARTS &&
    parts.reduce((total, part) => total + JSON.stringify(part).length, 0) <=
      TURN_PROMPT_MAX_TRANSCRIPT_CHARS
  ) {
    return parts;
  }
  const kept: TurnMessage[] = [];
  let chars = 0;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index] as TurnMessage;
    if (kept.length >= TURN_PROMPT_MAX_TRANSCRIPT_PARTS) break;
    const cost = JSON.stringify(part).length;
    if (kept.length > 0 && chars + cost > TURN_PROMPT_MAX_TRANSCRIPT_CHARS) break;
    kept.unshift(part);
    chars += cost;
  }
  while (kept.length > 1 && kept[0]?.role === "tool_result") {
    kept.shift();
  }
  return kept;
}

/** Index in `parts` where the recent-results tier begins: the last
 * TRANSCRIPT_RECENT_RESULTS tool_result parts keep the full window; older
 * ones compact. Everything before that index is the "old" tier. */
function recentResultTierStart(parts: readonly TurnMessage[]): number {
  let seen = 0;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index]?.role === "tool_result") {
      seen += 1;
      if (seen === TRANSCRIPT_RECENT_RESULTS) return index;
    }
  }
  return 0;
}

export function buildTurnMessages(input: BuildTurnMessagesInput): OpenAIChatMessage[] {
  const messages: OpenAIChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  for (const row of boundedHistory(input.history, input.currentRunId)) {
    messages.push(...historyRowToMessages(row));
  }
  const notes: string[] = [];
  if (input.canvas != null) notes.push(canvasNote(input.canvas));
  if (input.context !== undefined) notes.push(contextFlagsNote(input.context));
  const pinnedLine = input.pinned === undefined ? "" : pinnedNote(input.pinned);
  if (pinnedLine !== "") notes.push(pinnedLine);
  const applyFeedbackLine =
    input.applyNotes === undefined ? "" : applyFeedbackNote(input.applyNotes);
  if (applyFeedbackLine !== "") notes.push(applyFeedbackLine);
  const applyReceiptsLine =
    input.applyReceipts === undefined ? "" : applyReceiptsNote(input.applyReceipts);
  if (applyReceiptsLine !== "") notes.push(applyReceiptsLine);
  if (notes.length > 0) {
    messages.push({ role: "system", content: notes.join("\n\n") });
  }
  const transcript = boundedTranscript(input.transcript);
  const recentTierStart = recentResultTierStart(transcript);
  for (const [index, part] of transcript.entries()) {
    messages.push(
      ...transcriptPartToMessages(
        part,
        index >= recentTierStart ? TRANSCRIPT_RECENT_RESULT_CHARS : HISTORY_TOOL_RESULT_CHARS,
      ),
    );
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
  /** Provider-reported prompt-cache hits inside inputTokens (0 when the
   * provider does not report cache state). Billing and observability only —
   * never used to change what the model sees. */
  readonly cachedInputTokens: number;
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
  let cachedInputTokens = 0;
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
      cachedInputTokens += event.usage.cachedInputTokens;
      usageSeen = true;
    } else if (event.type === "finish") {
      finishReason = event.reason;
    }
  }
  // The one number that proves the token-management round works: when the
  // cache is healthy, cachedInputTokens ≈ inputTokens on every step after
  // the first (stable prefix) — log it so regressions are visible.
  deps.logger?.debug("model.call.usage", {
    model: input.model,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    toolCalls: calls.length,
  });
  return {
    text,
    reasoning,
    calls,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    usageSeen,
    finishReason,
  };
}

// ---------------------------------------------------------------------------
// §8.8 credits (byte-identical semantics to the retired runner)
// ---------------------------------------------------------------------------

function messageChars(message: OpenAIChatMessage): number {
  const serialized = JSON.stringify(message);
  return serialized === undefined ? 0 : serialized.length;
}

/**
 * Cached input tokens bill at this fraction of the full input rate — the
 * harness passes the provider's cache discount through instead of charging
 * users full price for tokens the provider served from its prompt cache
 * (Z.ai GLM: cached input ≈ 18% of input; 0.2 is the conservative round-up).
 */
export const CACHED_INPUT_CREDIT_RATE = 0.2;

/** ceil(input/1000×rateIn + output/1000×rateOut), min 1 (§8.8). Cached input
 * tokens (when the provider reports them) bill at CACHED_INPUT_CREDIT_RATE ×
 * the input rate; the estimate path (usage not seen) is unchanged — it has
 * no cache information. */
export function committedCreditsFor(
  model: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    usageSeen: boolean;
    cachedInputTokens?: number;
  },
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
  const cachedTokens = usage.usageSeen
    ? Math.max(0, Math.min(usage.cachedInputTokens ?? 0, inputTokens))
    : 0;
  const billableInput = inputTokens - cachedTokens;
  const cost =
    (billableInput / 1000) * descriptor.creditsPer1kInput +
    (cachedTokens / 1000) * descriptor.creditsPer1kInput * CACHED_INPUT_CREDIT_RATE +
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
  "studio.create_solid": "create",
  "studio.create_camera": "create",
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
    case "studio.create_solid":
      return `Add solid layer "${str(args.name)}"`;
    case "studio.create_camera":
      return `Add camera layer "${str(args.name)}"`;
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
    // 2026-11-01 root-cause fix: carriers NEVER demand approval — the exact
    // ruling contracts' mergeEditPlans documents for the merged plan ("no
    // curated write tool is high-risk; the compiler recomputes risk and the
    // auto-apply policy re-judges the COMPILED batch, never these self-declared
    // fields"). The old `tool.risk !== "low"` made EVERY medium tool —
    // including studio.create_composition, the foundation of any build —
    // fail the per-turn live-apply gate (isAutoApplicable checks
    // !requiresApproval), so the canvas stayed empty for the whole run while
    // the system prompt promised "low/medium plans APPLY THEMSELVES". The
    // model, seeing an eternally-empty canvas state note, concluded its
    // proposals had failed and re-proposed the composition from scratch
    // (run 59cead8c: steps 10-11 duplicated steps 1-2 verbatim), burning
    // turns and credits. Safety is unchanged: the write-tool catalog contains
    // no high-risk tool, and the apply-time walls (server-recomputed risk,
    // reversible-command classification, credit/step ceilings, run-end
    // autoApplyDecision rule 4) all still re-judge every batch.
    requiresApproval: false,
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
  // 2026-11-01 root-cause fix: the note must tell the model what ACTUALLY
  // happens next. Auto-applicable carriers (the §7.3 shape gate passes
  // them — every create/edit/style/animate tool) apply automatically at the
  // turn's end; only the organize-intent carriers (undo_run / save_version)
  // genuinely wait for the user. The old single "nothing is executed until
  // the user applies" note contradicted the live-apply pipeline and taught
  // the model its work never landed (run 59cead8c's duplicate re-proposals).
  const note = isAutoApplicable(carrier) ? AUTO_APPLY_BATCH_NOTE : PROPOSED_BATCH_NOTE;
  return WRITE_TOOL_RESULT_SCHEMA.parse({
    proposedBatch: step?.batch ?? { label: carrier.summary, steps: [] },
    note,
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
// Turn-time layer-reference validation (2026-11-01 root-cause fix)
// ---------------------------------------------------------------------------

/** How many known layer names the rejection message lists (bounded prompt). */
const LAYER_REF_LIST_LIMIT = 12;

/** The verdict a write call with unresolvable layer references settles with. */
export interface LayerRefVerdict {
  readonly error: "INVALID_TOOL_CALL";
  readonly message: string;
}

/**
 * Validate one compiled write call's layer references against everything the
 * gateway KNOWS exists at this point in the turn: the client's canvas
 * snapshot, the layer/composition names earlier calls in THIS turn already
 * created, and the carrier's own batch creations.
 *
 * Why this exists (run 59cead8c): the compiler defers every layer-name site
 * to apply-time resolution, so `set_properties` on the COMPOSITION's name —
 * the model reaching for a background the tool surface never exposed —
 * compiled cleanly, rode the run-end plan card, failed resolution CLIENT-side
 * ("No layer named X is in the composition") and rolled back the ENTIRE
 * atomic batch: every good step died with it ("The edit didn't apply —
 * nothing changed.", 13 credits, empty canvas). The model never saw a repair
 * signal — the failure surfaced after the run had ended.
 *
 * Failing HERE instead is cheap, early and repairable: the verdict echoes to
 * the model in the same turn's tool result, it fixes the reference, and the
 * run continues. Unknown-name rejections list the real layer names; a name
 * that matches a known COMPOSITION gets the background teaching (comp.new
 * takes a background color; layer.newSolid covers the frame).
 *
 * Pure and total — never throws, never mutates its inputs. Returns null when
 * every reference resolves (the call proceeds normally).
 */
export function layerReferenceVerdict(input: {
  readonly toolId: string;
  readonly references: readonly string[];
  readonly canvasLayerNames: readonly string[];
  readonly compositionNames: readonly string[];
  readonly batchCreatedLayers: ReadonlySet<string>;
}): LayerRefVerdict | null {
  const known = new Set(input.canvasLayerNames);
  const unknown = input.references.filter(
    (name) => !known.has(name) && !input.batchCreatedLayers.has(name),
  );
  if (unknown.length === 0) return null;
  const first = unknown[0] as string;
  const more = unknown.length > 1 ? ` (+${unknown.length - 1} more unknown names)` : "";
  const compositions = new Set(input.compositionNames);
  if (compositions.has(first)) {
    return {
      error: "INVALID_TOOL_CALL",
      message:
        `Invalid arguments for ${input.toolId}: "${first}" is a COMPOSITION, not a layer — ` +
        "layer tools target layers by name. Set the composition's background when creating it " +
        "(studio.create_composition accepts a background color), or cover the frame with a " +
        "SOLID layer (studio.engine_commands layer.newSolid {name, color, width, height})" +
        `${more}.`,
    };
  }
  const listed = input.canvasLayerNames.slice(0, LAYER_REF_LIST_LIMIT).join(", ");
  const knownPart =
    listed.length > 0
      ? ` — current layers: ${listed}${
          input.canvasLayerNames.length > LAYER_REF_LIST_LIMIT
            ? ` (+${input.canvasLayerNames.length - LAYER_REF_LIST_LIMIT} more)`
            : ""
        }`
      : " — the composition has no layers yet";
  return {
    error: "INVALID_TOOL_CALL",
    message:
      `Invalid arguments for ${input.toolId}: no layer named "${first}" exists${knownPart}. ` +
      "Create the layer first (studio.create_text, or layer.newSolid via " +
      "studio.engine_commands), or reference an existing layer by its exact name" +
      `${more}.`,
  };
}

/** Layer names the client's canvas snapshot reports (empty when absent). */
export function canvasLayerNames(canvas: TurnCanvas | null | undefined): readonly string[] {
  if (canvas == null) return [];
  return canvas.layers.map((layer) => layer.name);
}

/** Composition names known this turn: the active comp (canvas) + comp.new names. */
export function compositionNames(
  canvas: TurnCanvas | null | undefined,
  batchCreatedCompositions: ReadonlySet<string>,
): readonly string[] {
  const names = new Set<string>(batchCreatedCompositions);
  if (canvas?.activeComp != null && canvas.activeComp !== "") names.add(canvas.activeComp);
  return [...names];
}

/** Everything a turn needs to track for layer-reference validation. */
export interface TurnSymbolTable {
  /** Layer names that exist (canvas ∪ created by earlier calls this turn). */
  readonly layers: ReadonlySet<string>;
  /** Composition names that exist (activeComp ∪ comp.new earlier this turn). */
  readonly compositions: ReadonlySet<string>;
}

/** Seed the turn-local symbol table from the request's canvas snapshot. */
export function seedTurnSymbolTable(canvas: TurnCanvas | null | undefined): TurnSymbolTable {
  return {
    layers: new Set(canvasLayerNames(canvas)),
    compositions: new Set(
      canvas?.activeComp != null && canvas.activeComp !== "" ? [canvas.activeComp] : [],
    ),
  };
}

/** Fold one ACCEPTED write call's creations into the turn symbol table. */
export function foldCreationsInto(
  table: TurnSymbolTable,
  createdLayers: ReadonlySet<string>,
  createdCompositions: ReadonlySet<string>,
): void {
  for (const name of createdLayers) (table.layers as Set<string>).add(name);
  for (const name of createdCompositions) (table.compositions as Set<string>).add(name);
}

// ---------------------------------------------------------------------------
// Durable run-created names (e2e run bba72d51, 2026-11-01: the canvas snapshot
// lagged one live apply — a set_keyframes on the layer the PREVIOUS turn just
// created was falsely rejected because the turn-local table only knew the
// canvas. The run's OWN durable step rows are the complete truth.)
// ---------------------------------------------------------------------------

/** A durable agent_steps row, narrowed to what the extraction needs. */
export interface StepRowForNames {
  readonly tool: string;
  readonly argsJson?: unknown;
  readonly resultJson?: unknown;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string" || value === "") return value === "" ? undefined : value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isAcceptedProposal(result: unknown): boolean {
  if (typeof result !== "string") {
    return (
      typeof result === "object" &&
      result !== null &&
      "proposedBatch" in (result as Record<string, unknown>)
    );
  }
  return result.includes('"proposedBatch"');
}

/**
 * Layer/composition names THIS RUN created, extracted from its durable
 * agent_steps rows (the model's own args — the compiled batches are client
 * state, but the model's create calls carry the names it will reference).
 * Only ACCEPTED proposals count (a result with a proposedBatch); rejected
 * calls created nothing.
 */
export function createdNamesFromSteps(rows: readonly StepRowForNames[]): {
  layers: ReadonlySet<string>;
  compositions: ReadonlySet<string>;
} {
  const layers = new Set<string>();
  const compositions = new Set<string>();
  for (const row of rows) {
    if (!isAcceptedProposal(row.resultJson)) continue;
    const args = parseMaybeJson(row.argsJson);
    if (typeof args !== "object" || args === null) continue;
    const record = args as Record<string, unknown>;
    const addLayer = (name: unknown): void => {
      if (typeof name === "string" && name.length > 0) layers.add(name);
    };
    const addComp = (name: unknown): void => {
      if (typeof name === "string" && name.length > 0) compositions.add(name);
    };
    switch (row.tool) {
      case "studio.create_text": {
        // Mirrors the compiler: an explicit name, else (with opacity) the
        // synthesized text-derived name the follow-up prop.set references.
        const name = record.name;
        if (typeof name === "string" && name.length > 0) {
          addLayer(name);
        } else if (record.opacity !== undefined && typeof record.text === "string") {
          addLayer(record.text.slice(0, 60));
        }
        break;
      }
      case "studio.create_composition":
        addComp(record.name);
        break;
      case "studio.engine_commands": {
        const steps = record.steps;
        if (!Array.isArray(steps)) break;
        for (const step of steps) {
          if (typeof step !== "object" || step === null) continue;
          const { command, params } = step as { command?: unknown; params?: unknown };
          if (typeof command !== "string" || typeof params !== "object" || params === null) {
            continue;
          }
          const name = (params as Record<string, unknown>).name;
          if (command === "comp.new") addComp(name);
          else if (/^layer\.new/.test(command)) addLayer(name);
        }
        break;
      }
      default:
        break;
    }
  }
  return { layers, compositions };
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
  readonly usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
  };
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
  let usageAccumulator = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
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
      cachedInputTokens: usageAccumulator.cachedInputTokens + round.cachedInputTokens,
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
 * still rejects genuinely wrong shapes). 2026-11-01: gained the create_text
 * numeric leaves (opacity, strokeWidth, tracking, leading) — the model sent
 * size:"400" and opacity:"0" as strings in run 59cead8c.
 */
const NUMERIC_ARG_FIELDS: ReadonlySet<string> = new Set([
  "width",
  "height",
  "frameRate",
  "durationSeconds",
  "size",
  "opacity",
  "strokeWidth",
  "tracking",
  "leading",
  "timeSeconds",
  "duration",
  // Read-tool numeric leaves (e2e bba72d51: the model sent list_layers
  // {depth:"2"} three times — each bounced RUN_INVALID_TOOL and the
  // repetition guard had to kill the run).
  "depth",
]);

/** Write tools are exactly the catalog's kind:"write" entries. */
export function isWriteTool(tool: ToolDefinition): boolean {
  return tool.kind === "write";
}

/** The §8.6 20-step merge cap re-export (mergeEditPlans in contracts). */
export { mergeEditPlans } from "@studio/contracts";

export const TURN_ENGINE_LOGGER = nullLogger;
