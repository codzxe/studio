// @studio/gateway — the LiteLLM agent runner (PRODUCT_ARCHITECTURE §8.1-§8.9,
// D-16; M4-SEAMS Seam 3; M5-SEAMS "write tools wired into the loop").
// REAL OpenAI-compatible runner behind the AgentRunner seam.
//
// Loop per run (§8.1 stack roles — the gateway never talks to a provider
// directly, always through the LiteLLM proxy):
//   1. emit run.started (model alias)
//   2. stream from the model; text deltas → message.delta events
//   3. tool calls: allowlist = the 13 CURATED tools (5 read + 8 write, ids
//      pinned by contracts TOOL_LIST / WRITE_TOOL_IDS; §8.4). Unknown tool
//      or args failing the tool's Zod schema → ONE repair turn (validation
//      error as the tool result); second offense → failed RUN_INVALID_TOOL
//      (§8.9).
//   4. client read tools (get_context/list_layers/get_properties/
//      render_preview): tool.started + expectToolCall, then
//      waitForToolResult (Seam 2) — the editor executes via the bridge and
//      POSTs /v1/runs/:id/events; timeout → failed EDITOR_DISCONNECTED.
//   5. studio.plan_edit is SERVER-SIDE: a structured-output call to the SAME
//      alias (strict JSON prompt + EDIT_PLAN_SCHEMA parse, 2 attempts) →
//      emit {type:"plan"} (M5: enriched with the server-side compile —
//      compiledBatch/resolutionRequests/risk/estimatedCredits, all
//      optional so M4 consumers keep parsing); the validated plan is the
//      tool result. The client does NOT execute plan_edit.
//   6. write tools (create_composition/create_text/set_properties/
//      add_effect/set_keyframes/apply_preset/undo_run/save_version) are
//      PROPOSE-ONLY (BUILD_PLAN §M5.1: "Each returns a proposed batch; no
//      direct execution"): the runner resolves them SERVER-SIDE through
//      the M5-B compile seam into a proposed AgentBatch + human summary —
//      the tool.result envelope for the client carries the proposal;
//      the MODEL is fed a redacted summary only (law #5: the compiled
//      registry command ids never enter the model conversation); NOTHING
//      executes in the gateway — the batch executes only when the client
//      applies it (M5-F/M5-E, §8.7).
//   7. repeat until finish or the round cap → failed RUN_STEP_LIMIT
//      (D-1: write tools are model-loop steps too — the cap bounds the
//      whole loop).
//   8. usage → committedCredits: ceil(in/1000×rateIn + out/1000×rateOut),
//      min 1, from MODEL_CATALOG; usage missing → tokens ≈ chars/4.
//
// Redaction (M4.3): the logger receives ONLY lengths + sha256 prefixes of
// prompts — never bodies (see prompt.ts fingerprintMessages).

import { z } from "zod";

import {
  type AgentBatch,
  EDIT_PLAN_SCHEMA,
  type EditPlan,
  type LayerResolutionRequest,
  MAX_BATCH_LABEL_LENGTH,
  MAX_PLAN_AFFECTED_LAYERS,
  MAX_PLAN_SUMMARY_LENGTH,
  MODEL_CATALOG,
  type ModelId,
  PROPOSED_BATCH_NOTE,
  type PlanIntent,
  type PlanRisk,
  TOOL_LIST,
  type ToolDefinition,
  WRITE_TOOL_IDS,
  WRITE_TOOL_RESULT_SCHEMA,
  estimateCredits,
  getTool,
  studioWriteToolId,
} from "@studio/contracts";

import { type Logger, nullLogger } from "../logger.js";
import { compilePlan as compilePlanWithCompiler, defaultCompileDeps } from "../plan-compiler.js";
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
  /**
   * Alias→provider-model-id wire map (env LITELLM_MODEL_MAP, optional) —
   * applied in the OpenAI client at the wire only. Unset = aliases pass
   * through to the proxy unchanged (the default posture).
   */
  readonly modelMap?: Readonly<Record<string, string>> | undefined;
  /** Model round cap (env CHAT_MAX_STEPS). */
  readonly maxSteps: number;
  /** Injectable fetch (tests: fake OpenAI SSE server). */
  readonly fetch?: typeof fetch;
  /** Injectable sleep so retry backoff is instant in tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Redacted-metadata-only logger (M4.3); defaults to silent. */
  readonly logger?: Logger;
  /**
   * M5-B plan-compiler seam (docs/phases/M5-SEAMS.md pinned interface —
   * types below). Injectable so tests are deterministic and the integrator
   * can wire M5-B's ../plan-compiler.ts as the default without touching
   * the loop. Defaults to {@link planCompilerUnavailable} (typed ok:false)
   * until M5-B lands — write tools then answer PROPOSAL_INVALID and plan
   * events stay un-enriched; propose-only, never an execution.
   */
  readonly compilePlan?: CompilePlanFn;
}

// ---------------------------------------------------------------------------
// M5-B plan-compiler seam (docs/phases/M5-SEAMS.md — PINNED interface)
// ---------------------------------------------------------------------------

/** M5-SEAMS pin: `CompilePlanInput { plan: EditPlan; } // + resolution context`. */
export interface CompilePlanInput {
  readonly plan: EditPlan;
}

/** M5-SEAMS pin: compile failures are typed issues — the compiler never throws. */
export interface PlanIssue {
  readonly message: string;
  readonly step?: number;
}

/** M5-SEAMS pin: `ok:true` carries the compiled batch + server-recomputed risk/credits. */
export type CompilePlanResult =
  | {
      readonly ok: true;
      readonly batch: AgentBatch;
      readonly risk: PlanRisk;
      readonly estimatedCredits: number;
      readonly resolutionRequests: readonly LayerResolutionRequest[];
    }
  | {
      readonly ok: false;
      readonly issues: readonly PlanIssue[];
    };

/** The compiler function shape the runner consumes (injectable via deps). */
export type CompilePlanFn = (input: CompilePlanInput) => Promise<CompilePlanResult>;

/**
 * DEFAULT compilePlan: the SERVER-SIDE plan compiler (../plan-compiler.ts)
 * with its default deps (registry + write tools read from contracts at CALL
 * time — both REAL: the curated command registry resolves every allowlisted
 * id and the write-tools catalog carries args schemas + risk badges, so an
 * unknown command or invalid proposal degrades to a typed ok:false issue —
 * propose-only, never an execution, never a throw).
 *
 * The adapter also projects the compiler's richer result (readonly arrays +
 * additive placeholders/warnings fields) onto this module's pinned seam
 * types; if plan-compiler.ts drifts, this is the ONE reconcile point.
 */
const defaultCompilePlan: CompilePlanFn = async (input) => {
  const result = compilePlanWithCompiler(input, defaultCompileDeps());
  if (result.ok) {
    return {
      ok: true,
      batch: result.batch,
      risk: result.risk,
      estimatedCredits: result.estimatedCredits,
      resolutionRequests: result.resolutionRequests.map((request) => ({
        requestId: request.requestId,
        layerName: request.layerName,
        disambiguation: [...request.disambiguation],
      })),
    };
  }
  return { ok: false, issues: result.issues };
};

// ---------------------------------------------------------------------------
// Tool surface (§8.4: curated only — 5 read + 8 write = 13)
// ---------------------------------------------------------------------------

/** Exactly the §8.4 read tools (5). */
export const RUNNER_READ_TOOLS: readonly ToolDefinition[] = TOOL_LIST.filter(
  (tool) => tool.kind === "read",
);

/**
 * The 8 write tools (BUILD_PLAN §M5.1), ids taken from contracts
 * WRITE_TOOL_IDS via studioWriteToolId (lockstep with the curated catalog —
 * never an invented id). PROPOSE-ONLY (§8.4 rules 1-5): results are proposed
 * batches (WRITE_TOOL_RESULT_SCHEMA).
 */
export const RUNNER_WRITE_TOOLS: readonly ToolDefinition[] = WRITE_TOOL_IDS.map((id) =>
  getTool(studioWriteToolId(id)),
).filter((tool): tool is ToolDefinition => tool !== undefined && tool.kind === "write");

/** Everything registered on the provider wire: 5 read + 8 write = 13. */
export const RUNNER_TOOLS: readonly ToolDefinition[] = [
  ...RUNNER_READ_TOOLS,
  ...RUNNER_WRITE_TOOLS,
];

const TOOL_BY_ID: ReadonlyMap<string, ToolDefinition> = new Map(
  RUNNER_TOOLS.map((tool) => [tool.id, tool]),
);

/** Tool registrations for the provider, derived from the Zod args schemas. */
function openAiToolSpecs(): OpenAIToolSpec[] {
  return RUNNER_TOOLS.map((tool) => ({
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
  // Strip the $schema marker: providers want the bare parameters object.
  return Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$schema"));
}

/** The registered write-tool definition for `name`, or `null` for read tools. */
function registeredWriteTool(name: string): ToolDefinition | null {
  const tool = TOOL_BY_ID.get(name);
  return tool !== undefined && tool.kind === "write" ? tool : null;
}

// ---------------------------------------------------------------------------
// Tool-call validation (§8.9: one repair turn, then RUN_INVALID_TOOL)
// ---------------------------------------------------------------------------

type ValidatedToolCall =
  | { readonly ok: true; readonly name: string; readonly args: unknown }
  | { readonly ok: false; readonly message: string };

function validateToolCall(call: AggregatedToolCall): ValidatedToolCall {
  const tool = TOOL_BY_ID.get(call.name);
  if (tool === undefined) {
    return {
      ok: false,
      message: `Unknown tool "${call.name}". Available tools: ${RUNNER_TOOLS.map((t) => t.id).join(", ")}.`,
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
  // Args are validated against the tool's curated Zod schema from the
  // contracts catalog (`tool.args` — complete for all 13 tools today).
  // M5-A's WRITE_TOOL_ARGS_SCHEMAS registry is the pinned forward surface
  // (M5-SEAMS); once it lands as the authoritative per-tool ZodObjects, the
  // integrator flips this ONE lookup to consult it for write tools.
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
// Write-tool proposal carriers (BUILD_PLAN §M5.1 — propose-only, §8.7)
// ---------------------------------------------------------------------------
// The write-tool path REUSES the M5-B compilePlan per-step translation: the
// validated tool call is wrapped as a ONE-STEP EditPlan carrier and handed
// to the same seam studio.plan_edit uses. The carrier is SERVER-INTERNAL —
// the model never sees it (it is built from the already-validated args).

/** EditPlan intent per write tool (§8.6 vocabulary; undo/save are structural). */
const WRITE_TOOL_INTENTS: Readonly<Record<string, PlanIntent>> = {
  "studio.create_composition": "create",
  "studio.create_text": "create",
  "studio.set_properties": "edit",
  "studio.add_effect": "style",
  "studio.set_keyframes": "animate",
  "studio.apply_preset": "animate",
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

/** Deterministic HUMAN summary of one write-tool call (§8.6 display data;
 * args shapes per contracts write-tools.ts — layers BY NAME, STRICT objects). */
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
      return `Add effect "${effectName(args.effect)}" to ${layerNames.length} layer${
        layerNames.length === 1 ? "" : "s"
      }`;
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
      const targets = layerNames.length > 0 ? layerNames.length : 1; // omitted layers ⇒ current selection
      return `Apply preset "${preset}" to ${targets} layer${targets === 1 ? "" : "s"}`;
    }
    case "studio.undo_run":
      return "Undo the most recent applied agent run"; // undo_run takes NO args (one undo step, law #6)
    case "studio.save_version":
      return str(args.label) === ""
        ? "Save a version snapshot of the project"
        : `Save a version snapshot labeled "${str(args.label)}"`;
    default:
      return `Propose ${toolId.replace(/^studio\./, "")}`;
  }
}

function effectName(effect: unknown): string {
  if (typeof effect === "object" && effect !== null) {
    return str((effect as Record<string, unknown>).name);
  }
  return "";
}

/** Affected-layer rows for the carrier plan (§8.6 card data; bounded ≤ 50). */
function writeToolAffectedLayers(
  toolId: string,
  args: Record<string, unknown>,
): Array<{ name: string; change: string }> {
  const layers: Array<{ name: string; change: string }> = [];
  const push = (name: string, change: string): void => {
    if (name !== "" && layers.length < MAX_PLAN_AFFECTED_LAYERS) layers.push({ name, change });
  };
  const namedLayers = array(args.layers)
    .map((layer) =>
      typeof layer === "object" && layer !== null
        ? str((layer as Record<string, unknown>).name)
        : "",
    )
    .filter((name) => name !== "");
  switch (toolId) {
    case "studio.set_properties": {
      const change = `Set ${array(args.properties).length} propert${
        array(args.properties).length === 1 ? "y" : "ies"
      }`;
      for (const name of namedLayers) push(name, change);
      break;
    }
    case "studio.add_effect":
      for (const name of namedLayers) push(name, `Add effect "${effectName(args.effect)}"`);
      break;
    case "studio.set_keyframes":
      for (const name of namedLayers) push(name, `Keyframes on ${str(args.propertyPath)}`);
      break;
    case "studio.apply_preset": {
      const change = `Apply preset ${
        typeof args.preset === "object" && args.preset !== null
          ? str((args.preset as Record<string, unknown>).name) ||
            str((args.preset as Record<string, unknown>).builtinId)
          : ""
      }`;
      for (const name of namedLayers) push(name, change);
      break;
    }
    default:
      break;
  }
  return layers;
}

/**
 * The one-step EditPlan CARRIER handed to the compile seam for a write-tool
 * call. CARRIER CONVENTION (M5-C ⇄ M5-B seam): the single step is the
 * curated tool id + validated args — `steps[].tool` is authoritative for
 * the compiler's per-step translation (M5-SEAMS: "the plan-compiler maps
 * tool+args → registry command steps"), and the pseudo `batch.step.command`
 * carries the UNPREFIXED tool id purely to satisfy PLAN_STEP_SCHEMA's
 * non-empty batch bound. The compiler MUST NOT execute `steps[].batch`
 * (model-proposed plan batches are validation targets, §8.7 — F-3 class).
 * INTEGRATOR: if M5-B's CompilePlanInput grows a dedicated write-tool arm
 * (e.g. `{ tool, args }`), flip this carrier to it and delete the convention.
 */
export function writeToolCarrierPlan(tool: ToolDefinition, args: unknown): EditPlan {
  const record = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  const summary = clamp280(writeToolSummary(tool.id, record));
  const carrier = {
    intent: WRITE_TOOL_INTENTS[tool.id] ?? "edit",
    summary,
    risk: tool.risk,
    requiresApproval: tool.risk !== "low",
    affectedLayers: writeToolAffectedLayers(tool.id, record),
    estimatedCredits: estimateCredits({ risk: tool.risk, steps: [{}] }),
    steps: [
      {
        title: summary,
        tool: tool.id,
        args,
        batch: {
          label: `Agent: ${summary}`.slice(0, MAX_BATCH_LABEL_LENGTH),
          steps: [{ command: tool.id.replace(/^studio\./, ""), params: record }],
        },
      },
    ],
  };
  return EDIT_PLAN_SCHEMA.parse(carrier);
}

/** First compiler issue as a bounded model/tool message (mirrors PLAN_INVALID). */
function compileIssueMessage(issues: readonly PlanIssue[]): string {
  const first = issues[0]?.message ?? "The proposed change failed validation.";
  const suffix = issues.length > 1 ? ` (+${issues.length - 1} more issues)` : "";
  return `${first}${suffix}`.slice(0, MAX_PLAN_SUMMARY_LENGTH);
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
  // M5-B seam: the injected compiler for tests, the real ../plan-compiler.ts
  // default otherwise (see defaultCompilePlan above).
  const runCompilePlan = deps.compilePlan ?? defaultCompilePlan;
  const clientDeps = {
    baseUrl: deps.baseUrl,
    bearer,
    modelMap: deps.modelMap,
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
        content: `That was not a valid EditPlan: ${
          validation || "not valid JSON"
        }. Respond again with STRICT JSON only — no prose, no markdown fences — matching the EditPlan shape exactly.`,
      });
    }
    return { plan: null, errorMessage: "The proposed plan failed validation twice." };
  }

  return {
    async start(run: AgentRun, stream: AgentRunStream): Promise<AgentRunOutcome> {
      const signal = stream.signal;
      const usage: UsageAccumulator = { inputTokens: 0, outputTokens: 0, seen: false };
      const conversation: OpenAIChatMessage[] = [...buildMessages(run)];

      /** The pinned compile seam is "typed, never throws"; a violating
       * compiler implementation degrades to a typed issue instead of
       * failing the run (defense-in-depth for the M5-B handoff). */
      const compilePlanSafe = async (input: CompilePlanInput): Promise<CompilePlanResult> => {
        try {
          return await runCompilePlan(input);
        } catch (error) {
          logger.error("plan_compiler_threw", {
            runId: run.runId,
            detail: error instanceof Error ? error.name : "unknown",
          });
          return { ok: false, issues: [{ message: "The plan compiler failed unexpectedly." }] };
        }
      };

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

          const writeTool = registeredWriteTool(validated.name);
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
              // M5 (§M5.2): run the server-side compiler on the plan and
              // attach its output to the {type:"plan"} event — compiledBatch
              // + resolutionRequests + server-recomputed risk/credits. All
              // optional (back-compat); a compile failure emits the plan
              // UN-enriched (still valid display data; Apply is gated
              // downstream on compiledBatch's absence). The tool result and
              // the model-facing content stay the BARE plan (M4 behavior)
              // — the compiled registry command ids never reach the model.
              const compiled = await compilePlanSafe({ plan: plan.plan });
              if (compiled.ok) {
                stream.emit({
                  type: "plan",
                  plan: plan.plan,
                  compiledBatch: compiled.batch,
                  resolutionRequests: [...compiled.resolutionRequests],
                  risk: compiled.risk,
                  estimatedCredits: compiled.estimatedCredits,
                });
              } else {
                logger.debug("plan_compile_rejected", {
                  runId: run.runId,
                  issues: compiled.issues.length,
                });
                stream.emit({ type: "plan", plan: plan.plan });
              }
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
          } else if (writeTool !== null) {
            // M5.1 PROPOSE-ONLY write tool: resolve SERVER-SIDE through the
            // compile seam. NOTHING executes in the gateway — the proposed
            // batch executes only when the CLIENT applies it (§8.7, law #6:
            // one atomic engine.batch = one undo step = one version).
            const carrier = writeToolCarrierPlan(writeTool, validated.args);
            const compiled = await compilePlanSafe({ plan: carrier });
            if (compiled.ok) {
              // Client envelope = the pinned WRITE_TOOL_RESULT_SCHEMA
              // (contracts write-tools.ts): ONLY the proposed batch + the
              // canonical proposed-only note — the human summary rides the
              // batch label ("Agent: <summary>"). Boundary re-check (law #2)
              // before the result goes on the wire; a compiler result that
              // fails the pinned shape degrades to PROPOSAL_INVALID below.
              const checked = WRITE_TOOL_RESULT_SCHEMA.safeParse({
                proposedBatch: {
                  label: compiled.batch.label,
                  steps: compiled.batch.steps,
                },
                note: PROPOSED_BATCH_NOTE,
              });
              if (checked.success) {
                stream.emit({
                  type: "tool.result",
                  toolCallId: call.id,
                  result: checked.data,
                });
                await stream.yieldToStream();
                if (signal.aborted) return cancelled();
                logger.debug("write_tool_proposed", {
                  runId: run.runId,
                  tool: writeTool.id,
                  steps: compiled.batch.steps.length,
                  risk: compiled.risk,
                  estimatedCredits: compiled.estimatedCredits,
                  resolutionRequests: compiled.resolutionRequests.length,
                });
                // LAW #5 / M4-SAFETY B2: the model is fed a REDACTED
                // envelope — the human summary + step count + the
                // proposed-only note ONLY. The compiled registry command ids
                // inside proposedBatch never enter the model conversation.
                conversation.push({
                  role: "tool",
                  tool_call_id: call.id,
                  content: JSON.stringify({
                    proposed: true,
                    summary: carrier.summary,
                    note: PROPOSED_BATCH_NOTE,
                    stepCount: compiled.batch.steps.length,
                  }),
                });
              } else {
                // Pinned-envelope violation (compiler drift): degrade safely.
                const rejected = {
                  error: "PROPOSAL_INVALID",
                  message: "The proposed change did not pass the proposal contract.",
                };
                stream.emit({ type: "tool.result", toolCallId: call.id, result: rejected });
                await stream.yieldToStream();
                if (signal.aborted) return cancelled();
                conversation.push({
                  role: "tool",
                  tool_call_id: call.id,
                  content: JSON.stringify(rejected),
                });
              }
            } else {
              // Compile rejected (typed issues — the run survives; the model
              // may adapt within the step cap). Mirrors PLAN_INVALID.
              logger.debug("write_tool_compile_rejected", {
                runId: run.runId,
                tool: writeTool.id,
                issues: compiled.issues.length,
              });
              const rejected = {
                error: "PROPOSAL_INVALID",
                message: compileIssueMessage(compiled.issues),
              };
              stream.emit({ type: "tool.result", toolCallId: call.id, result: rejected });
              await stream.yieldToStream();
              if (signal.aborted) return cancelled();
              conversation.push({
                role: "tool",
                tool_call_id: call.id,
                content: JSON.stringify(rejected),
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
