// @studio/agent — the executor loop (§5.1 "executing ⇄ observing" driver). Owner: W6-B.
//
// Spec anchors:
//   §5.1  "Small steps: no more than 8 model↔tool round trips per phase by
//          default (configurable per tier)" — enforced here as a HARD CAP via
//          @studio/config `roundtripsPerPhase` (8 on every interactive tier);
//          "observe after act" (layer.list + ≤1024 px render) is the RUN
//          MANAGER's next phase, fed by this service's ExecutorReport.
//   §5.2  budgets are hard caps; exceeding one is a FEATURE (predictable
//          pricing), not an error: stop cleanly, keep committed work, tell the
//          user what was cut. The executor NEVER throws on a budget stop — it
//          returns `status:"budget_stopped"` + a cut report (§5.2 sentence).
//   §5.3  the model seam below is provider-agnostic; the WORKER wires the AI
//          SDK / the router's ProviderLike (W6-H) into `ExecuteModelLike`.
//   §5.5  "The executor may deviate from steps only to fix errors; every
//          deviation is logged and surfaced" — deviations are recorded and the
//          step.finished event carries deviationFromPlan.
//   §5.7  every model-proposed tool name and argument is UNTRUSTED: names are
//          checked against the registry (unknown → skipped + logged), args are
//          parsed against the tool's Zod schema at the boundary (parseToolArgs).
//   §6.3  "the agent must read the error, fix the argument, and retry (the
//          worker enforces a retry budget)" + §23.1 rule 7: an identical failed
//          call is NEVER executed twice, and each tool error grants exactly
//          ONE retry per (step, tool) — a second failure exhausts the budget
//          (errors.ts `tool_retry_exhausted`) and further calls are refused.
//   §3.4  per-tool-call deadline (5 s typical) composed with the run's
//          AbortSignal, which is checked between every step and before/during
//          every call.
//
// Ownership: this file drives plan.steps; it never imports a provider SDK, never
// touches the engine directly (tools own that), and never emits SSE itself —
// step.started/step.finished ride the injected emit seam (§13.2 payloads).

import { type RunTierId, resolveTierConfig } from "@studio/config";
import {
  type AnyTool,
  err as buildToolErr,
  type ToolContext,
  type ToolErrorCode,
  type ToolListing,
  type ToolResult,
  parseToolArgs,
  toToolErr,
} from "@studio/tools";
import { z } from "zod";
import { type BudgetExceeded, BudgetTracker, type BudgetSnapshot, type Clock } from "../budgets.js";
import { type StepFinishedPayload, type StepStartedPayload } from "../events.js";
import { type Plan, type PlanStep } from "../plan.js";
import { type RunPhase } from "../state.js";
import { buildExecutorSystemPrompt } from "./prompt.js";

// ---------------------------------------------------------------------------
// Limits (§5.1 round trips; §3.4 per-call deadline)
// ---------------------------------------------------------------------------

/** §5.1: max model↔tool round trips per phase by default. */
export const EXECUTOR_DEFAULT_MAX_ROUND_TRIPS = 8;
/** §3.4: "per-tool (5 s typical)". */
export const EXECUTOR_DEFAULT_TOOL_CALL_TIMEOUT_MS = 5000;

export interface ExecutorLimits {
  /** §5.1 round-trip cap for the whole execute() walk (tier-configurable). */
  readonly maxRoundTrips: number;
  /** §3.4 per-call deadline; `null` disables it (deterministic tests). */
  readonly toolCallTimeoutMs: number | null;
}

export const EXECUTOR_LIMITS_SCHEMA = z
  .strictObject({
    maxRoundTrips: z.number().int().min(1),
    toolCallTimeoutMs: z.number().int().min(1).nullable(),
  })
  .strict();

/** Resolves the §5.1 round-trip cap from the §5.2 tier (@studio/config). */
export function executorLimitsFromTier(tier: RunTierId): ExecutorLimits {
  const resolved = resolveTierConfig(tier);
  if (resolved.roundtripsPerPhase === null) {
    throw new Error(
      `[agent/executor] tier "${tier}" has no round-trip budget — image tiers never execute plans (§5.2)`,
    );
  }
  return {
    maxRoundTrips: resolved.roundtripsPerPhase,
    toolCallTimeoutMs: EXECUTOR_DEFAULT_TOOL_CALL_TIMEOUT_MS,
  };
}

// ---------------------------------------------------------------------------
// The model seam (§5.3 provider-agnostic; worker wires the AI SDK / ProviderLike)
// ---------------------------------------------------------------------------

/** One model-proposed tool call. UNTRUSTED (§5.7) — name and args are validated before execution. */
export interface ProposedToolCall {
  /** Model-assigned id pairing the assistant record with its tool result. */
  readonly callId: string;
  readonly name: string;
  readonly args: unknown;
}

/**
 * Transcript messages between the model and the executor. The worker maps
 * these onto provider message formats; the executor appends step directives,
 * assistant records and tool results DURING iteration (see ExecutorTranscript).
 */
export type ExecutorMessage =
  | { readonly role: "user"; readonly text: string }
  | {
      readonly role: "assistant";
      readonly text: string;
      readonly toolCalls?: readonly ProposedToolCall[];
    }
  | { readonly role: "tool"; readonly callId: string; readonly name: string; readonly result: ToolResult };

/**
 * The append-only conversation. The seam MUST re-read `messages()` before each
 * of its internal model calls (each round trip): the executor executes proposed
 * calls between the seam's yields and appends the results here — that pull-driven
 * pushback IS the loop's feedback channel (§5.1 observe-after-act in miniature).
 */
export interface ExecutorTranscript {
  /** Frozen snapshot of the messages accumulated so far. */
  messages(): readonly ExecutorMessage[];
  /** Executor-only: append one message. */
  append(message: ExecutorMessage): void;
}

/** Usage of one model call (§22: numbers only, never content) → §5.2 BudgetTracker. */
export interface ExecutorModelUsage {
  readonly model: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheHits?: number;
}

/**
 * Model stream events. One `turn_started` per provider call marks ONE model↔tool
 * round trip (§5.1). A stream that never yields `step_done` simply ends the step
 * when it exhausts (the model stopped talking).
 */
export type ExecutorEvent =
  | { readonly type: "turn_started" }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_call"; readonly callId: string; readonly name: string; readonly args: unknown }
  | { readonly type: "usage"; readonly usage: ExecutorModelUsage }
  | { readonly type: "step_done"; readonly text?: string };

/** Read-only §5.2 headroom handed to the seam per step. */
export interface ExecutorBudgetView {
  readonly maxRoundTrips: number;
  readonly roundTripsRemaining: number;
  readonly toolCallsRemaining: number;
  readonly tokensInRemaining: number | null;
  readonly tokensOutRemaining: number | null;
  readonly wallClockMsRemaining: number;
}

/**
 * THE executor model seam (§5.3). Called once per plan step with the same
 * byte-stable system prompt (§5.3 prompt-cache anchor); the worker's
 * implementation may run several provider calls per invocation (one per
 * `turn_started`), feeding tool results back by re-reading `messages`.
 * The seam never executes tools — the executor owns dispatch and enforcement.
 */
export interface ExecuteModelLike {
  streamToolLoop(
    system: string,
    messages: ExecutorTranscript,
    tools: readonly ToolListing[],
    budget: ExecutorBudgetView,
    signal: AbortSignal,
  ): AsyncIterable<ExecutorEvent>;
}

// ---------------------------------------------------------------------------
// Step events (§13.2 payloads via the injected emit seam)
// ---------------------------------------------------------------------------

export type ExecutorStepEvent =
  | { readonly type: "step.started"; readonly payload: StepStartedPayload }
  | { readonly type: "step.finished"; readonly payload: StepFinishedPayload };

/**
 * Sink for step events (worker wires the durable §13.2/§22 bus). Returning a
 * promise makes the executor await the durable append before proceeding
 * (§22 durability over latency); a rejection propagates and fails the run —
 * the timeline must never silently drop steps.
 */
export type EmitExecutorStepEvent = (event: ExecutorStepEvent) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Deviations (§5.5), step records, cut report, final report
// ---------------------------------------------------------------------------

export const EXECUTOR_DEVIATION_KINDS = [
  "unknown_tool",
  "plan_mismatch",
  "repeated_failed_call",
  "retry_budget_exhausted",
] as const;

export type ExecutorDeviationKind = (typeof EXECUTOR_DEVIATION_KINDS)[number];

/** §5.5: every deviation is logged and surfaced (kept work, normal inspectable event). */
export interface ExecutorDeviationRecord {
  readonly stepSeq: number;
  readonly kind: ExecutorDeviationKind;
  readonly plannedTool: string;
  readonly actualTool: string | null;
  readonly detail: string;
}

export interface ExecutorStepRecord {
  readonly stepSeq: number;
  readonly plannedTool: string;
  /** Tool names whose executed calls returned ok, in order (failed/skipped/refused calls are not listed). */
  readonly succeededTools: readonly string[];
  /** True when the plan's own tool ran successfully (a deviated completion is still `ok`). */
  readonly plannedToolSucceeded: boolean;
  /** True when ≥1 executed call returned ok. */
  readonly ok: boolean;
  readonly deviationFromPlan: boolean;
  readonly durationMs: number;
}

export type ExecutorStopReason = "budget_exceeded" | "round_trip_cap" | "aborted";
export type ExecutorStatus = "completed" | "budget_stopped" | "round_trip_stopped" | "aborted";

/** §5.2 "tell the user what was cut" — the clean-stop report. */
export interface ExecutorCutReport {
  readonly reason: ExecutorStopReason;
  /** Steps that ran to natural completion (their records carry the outcomes). */
  readonly completedSteps: number;
  readonly totalSteps: number;
  /** Step started but interrupted by the stop (it has a record + finished event), or null. */
  readonly inFlightStep: number | null;
  /** Planned tools of steps that never started. */
  readonly cutStepTools: readonly string[];
  /** User-surfaceable sentence (§5.2). */
  readonly message: string;
  /** The §5.2 soft-stop report when reason is `budget_exceeded`. */
  readonly budgetExceeded: BudgetExceeded | null;
}

/** The executor's terminal report — always returned, never thrown for run-level stops. */
export interface ExecutorReport {
  readonly status: ExecutorStatus;
  readonly phase: ExecutorPhase;
  readonly steps: readonly ExecutorStepRecord[];
  readonly deviations: readonly ExecutorDeviationRecord[];
  readonly roundTripsUsed: number;
  readonly maxRoundTrips: number;
  /** Executed tool calls (§5.2 counter mirror; refusals/skips are not counted). */
  readonly toolCallsExecuted: number;
  /** Latest document revision any tool reported (the worker finalizes from it). */
  readonly lastDocumentRevision: number | null;
  /** §23.1 rule 8 closing paragraph, when the model sent one. */
  readonly finalAssistantText: string | null;
  /** Non-null whenever the walk stopped early — the §5.2 feature, not an error. */
  readonly cut: ExecutorCutReport | null;
  readonly usage: BudgetSnapshot;
}

// ---------------------------------------------------------------------------
// Input + service options
// ---------------------------------------------------------------------------

/** §5.1 phases the executor drives (repairing reuses it with a repair plan, W6-F). */
export const EXECUTOR_PHASES = ["executing", "repairing"] as const satisfies readonly RunPhase[];

export type ExecutorPhase = (typeof EXECUTOR_PHASES)[number];

export interface ExecuteInput {
  /** The validated §5.5 plan — `steps` is the executor's worklist. */
  readonly plan: Plan;
  /**
   * The run's §5.2 hard-cap counters (W1-P core; W6-G's TierBudgetTracker
   * extends it). The executor records tool calls and model usage into it and
   * reads `exceeded()` between calls — the caller keeps ownership.
   */
  readonly budget: BudgetTracker;
  /** §23.1 rule-6 numbers — resolve from the tier via @studio/config in the worker. */
  readonly maxToolCalls: number;
  readonly maxRevisions: number;
  readonly maxTokens: number;
  /** §5.4 context prefix (brief, prior conversation); defaults to empty. */
  readonly initialMessages?: readonly ExecutorMessage[];
  /** §5.1 phase label for step events; defaults to "executing". */
  readonly phase?: ExecutorPhase;
}

export interface ExecutorServiceOptions {
  readonly model: ExecuteModelLike;
  /** Dispatch map: tool name → tool (e.g. TOOLS_DEFAULT from @studio/tools). */
  readonly tools: Readonly<Record<string, AnyTool>>;
  /** Model-visible manifest: name + description ONLY (§6.1; registry.list()). */
  readonly manifest: readonly ToolListing[];
  /** Worker-assembled §6.2 context handed to every executed tool call. */
  readonly toolContext: ToolContext;
  /** §13.2 step.started / step.finished sink (worker wires the durable event bus). */
  readonly emit: EmitExecutorStepEvent;
  /** Injectable wall clock (deterministic tests); defaults to Date.now(). */
  readonly clock?: Clock;
  /** Overrides the §5.1/§3.4 defaults. */
  readonly limits?: Partial<ExecutorLimits>;
}

// ---------------------------------------------------------------------------
// §23.1 rule 7 helpers (failed-call identity)
// ---------------------------------------------------------------------------

/** Depth cap for canonical args serialization (§5.7: model input is untrusted). */
const MAX_CANONICAL_DEPTH = 32;

/** Deterministic serialization of untrusted model args (sorted keys, bounded depth). */
export function canonicalJson(value: unknown, depth = 0): string {
  if (value === null) {
    return "null";
  }
  const type = typeof value;
  if (type === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : '"non-finite"';
  }
  if (type === "boolean") {
    return value ? "true" : "false";
  }
  if (type === "string") {
    return JSON.stringify(value);
  }
  if (type === "bigint") {
    return `"${value.toString()}"`;
  }
  if (depth >= MAX_CANONICAL_DEPTH) {
    return '"[too-deep]"';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  }
  if (type === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], depth + 1)}`)
      .join(",")}}`;
  }
  return `"unsupported:${type}"`; // functions/symbols/undefined never come from JSON args
}

/** The §23.1 rule 7 call identity: tool name + canonical args of the FAILED call. */
export function canonicalCallKey(name: string, args: unknown): string {
  return `${name}\u0000${canonicalJson(args)}`;
}

/**
 * §6.3 retry budget: the initial attempt plus EXACTLY one retry per (step, tool).
 * A third proposal of the same tool in the same step is refused with a
 * `retry_budget_exhausted` deviation (errors.ts `tool_retry_exhausted`).
 */
export const MAX_TOOL_CALL_ATTEMPTS_PER_STEP_TOOL = 2;

/**
 * Swap-point error code (W5-E/W5-D/W5-K fleet precedent): the shared §13.3 +
 * tool catalog carries no retry-budget code yet, so the model-facing refusal
 * uses the code errors.ts already maps `tool_retry_exhausted` onto.
 * types.ts owner (@studio/tools): add "tool_retry_exhausted" to
 * TOOL_ONLY_ERROR_CODES and flip this one-line constant. Tests import it.
 */
export const TOOL_RETRY_EXHAUSTED_FEEDBACK_CODE: ToolErrorCode = "engine_timeout";

// ---------------------------------------------------------------------------
// ExecutorService
// ---------------------------------------------------------------------------

export class ExecutorService {
  private readonly model: ExecuteModelLike;
  private readonly tools: Readonly<Record<string, AnyTool>>;
  private readonly manifest: readonly ToolListing[];
  private readonly toolContext: ToolContext;
  private readonly emit: EmitExecutorStepEvent;
  private readonly clock: Clock;
  private readonly limits: ExecutorLimits;

  constructor(options: ExecutorServiceOptions) {
    if (options == null || typeof options.model?.streamToolLoop !== "function") {
      throw new Error("[agent/executor] options.model.streamToolLoop is required (§5.3 seam)");
    }
    const tools = options.tools;
    if (
      tools == null ||
      typeof tools !== "object" ||
      Object.keys(tools).some((name) => typeof tools[name]?.run !== "function")
    ) {
      throw new Error("[agent/executor] options.tools must be a non-empty name→tool map (§6 registry)");
    }
    if (
      !Array.isArray(options.manifest) ||
      options.manifest.length === 0 ||
      options.manifest.some(
        (tool) => typeof tool?.name !== "string" || typeof tool?.description !== "string",
      )
    ) {
      throw new Error(
        "[agent/executor] options.manifest must be non-empty name+description listings (§6.1)",
      );
    }
    if (options.toolContext == null || typeof options.toolContext !== "object") {
      throw new Error("[agent/executor] options.toolContext is required (§6.2 ctx seam)");
    }
    if (typeof options.emit !== "function") {
      throw new Error("[agent/executor] options.emit is required (§13.2 step events)");
    }
    this.model = options.model;
    this.tools = Object.freeze({ ...tools });
    this.manifest = [...options.manifest];
    this.toolContext = options.toolContext;
    this.emit = options.emit;
    this.clock = options.clock ?? (() => Date.now());
    // Fail fast on wiring nonsense (mirrors BudgetTracker's zod boundary).
    this.limits = EXECUTOR_LIMITS_SCHEMA.parse({
      maxRoundTrips: options.limits?.maxRoundTrips ?? EXECUTOR_DEFAULT_MAX_ROUND_TRIPS,
      toolCallTimeoutMs:
        options.limits?.toolCallTimeoutMs ?? EXECUTOR_DEFAULT_TOOL_CALL_TIMEOUT_MS,
    });
  }

  /**
   * Walks the plan's steps (§5.5): one model stream per step, tool calls
   * executed through the registry under §5.2/§5.7/§23.1-rule-7 enforcement.
   * Returns a report for every outcome — budget stops and aborts are clean
   * stops, not exceptions (§5.2). Only infrastructure failures (the emit seam
   * rejecting) propagate to the worker.
   */
  async execute(input: ExecuteInput, signal: AbortSignal): Promise<ExecutorReport> {
    const phase: ExecutorPhase = input.phase ?? "executing";
    const budget = input.budget;
    const plan = input.plan;
    const system = buildExecutorSystemPrompt({
      maxToolCalls: input.maxToolCalls,
      maxRevisions: input.maxRevisions,
      maxTokens: input.maxTokens,
      toolsManifest: this.manifest,
    });

    // --- run state (single-owner loop; §5.2 counters live in `budget`) ---------
    const transcript = createTranscript(input.initialMessages ?? []);
    const deviations: ExecutorDeviationRecord[] = [];
    const stepRecords: ExecutorStepRecord[] = [];
    const failedCalls = new Set<string>(); // §23.1 rule 7 identities (run-scoped)
    const toolErrors = new Map<string, number>(); // `${stepSeq}:${name}` → errors so far
    let roundTripsUsed = 0;
    let toolCallsExecuted = 0;
    let lastDocumentRevision: number | null = null;
    let finalAssistantText: string | null = null;
    let stopReason: ExecutorStopReason | null = null;
    let budgetExceeded: BudgetExceeded | null = null;
    let inFlightStep: number | null = null;
    let completedSteps = 0;
    let callCounter = 0;

    const budgetView = (): ExecutorBudgetView => {
      const remaining = budget.remaining();
      return Object.freeze({
        maxRoundTrips: this.limits.maxRoundTrips,
        roundTripsRemaining: Math.max(0, this.limits.maxRoundTrips - roundTripsUsed),
        toolCallsRemaining: remaining.toolCalls,
        tokensInRemaining: remaining.tokensIn,
        tokensOutRemaining: remaining.tokensOut,
        wallClockMsRemaining: remaining.wallClockMs,
      });
    };

    const recordDeviation = (
      stepSeq: number,
      kind: ExecutorDeviationKind,
      plannedTool: string,
      actualTool: string | null,
      detail: string,
    ): void => {
      deviations.push({ stepSeq, kind, plannedTool, actualTool, detail });
    };

    /** Appends the assistant tool-call record + the tool result (the pair the worker replays). */
    const appendCallPair = (proposed: ProposedToolCall, result: ToolResult): void => {
      transcript.append({
        role: "assistant",
        text: "",
        toolCalls: [{ callId: proposed.callId, name: proposed.name, args: proposed.args }],
      });
      transcript.append({
        role: "tool",
        callId: proposed.callId,
        name: proposed.name,
        result,
      });
    };

    const executeToolCall = async (
      tool: AnyTool,
      args: unknown,
      callSignal: AbortSignal,
    ): Promise<ToolResult> => {
      try {
        return await tool.run(this.toolContext, args, callSignal);
      } catch (thrown) {
        return toToolErr(thrown); // defineTool already wraps; defensive for raw tools
      }
    };

    const runToolWithDeadline = async (tool: AnyTool, args: unknown): Promise<ToolResult> => {
      if (this.limits.toolCallTimeoutMs === null) {
        return executeToolCall(tool, args, signal);
      }
      const call = new AbortController();
      const onAbort = (): void => {
        call.abort();
      };
      if (signal.aborted) {
        call.abort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      const timer = setTimeout(() => {
        call.abort(); // §3.4 per-call deadline — becomes a retryable tool error, not a stop
      }, this.limits.toolCallTimeoutMs);
      try {
        return await executeToolCall(tool, args, call.signal);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      }
    };

    /** §5.7/§5.2/§23.1-rule-7 enforcement around ONE proposed tool call. */
    const processToolCall = async (
      stepSeq: number,
      step: PlanStep,
      proposed: ProposedToolCall,
      stepState: { succeededTools: string[]; plannedToolSucceeded: boolean; deviated: boolean },
    ): Promise<void> => {
      const name = typeof proposed.name === "string" ? proposed.name : "";
      const args = proposed.args;

      // §3.4/§5.1: the run signal is checked before every call.
      if (signal.aborted) {
        stopReason ??= "aborted";
        return;
      }

      // §5.2: budgets are hard caps — check between calls, stop cleanly (feature).
      const exceededNow = budget.exceeded();
      if (exceededNow !== null) {
        stopReason ??= "budget_exceeded";
        budgetExceeded ??= exceededNow;
        return;
      }

      // §5.7: untrusted tool name — registry membership gate (skip + deviation log).
      const tool = Object.hasOwn(this.tools, name) ? this.tools[name] : undefined;
      if (tool === undefined) {
        const allowed = Object.keys(this.tools).sort();
        stepState.deviated = true;
        recordDeviation(
          stepSeq,
          "unknown_tool",
          step.tool,
          name,
          `Unknown tool "${truncate(name, 64)}" skipped (§5.7); registered: ${allowed.join(", ")}`,
        );
        appendCallPair(
          proposed,
          buildToolErr("unknown_tool", `Unknown tool "${truncate(name, 64)}"`, {
            hint: `Registered tools: ${allowed.join(", ")}`,
            retryable: false,
          }),
        );
        return;
      }

      // §5.5: planned tool vs actual → deviationFromPlan flag + log.
      if (name !== step.tool) {
        stepState.deviated = true;
        recordDeviation(
          stepSeq,
          "plan_mismatch",
          step.tool,
          name,
          `Planned "${step.tool}" but the model called "${truncate(name, 64)}" (§5.5: deviations only to fix errors)`,
        );
      }

      // §23.1 rule 7: never execute an identical failed call twice.
      const callKey = canonicalCallKey(name, args);
      if (failedCalls.has(callKey)) {
        recordDeviation(
          stepSeq,
          "repeated_failed_call",
          step.tool,
          name,
          `Identical failed call "${truncate(name, 64)}" refused (§23.1 rule 7)`,
        );
        appendCallPair(
          proposed,
          buildToolErr(
            "invalid_args",
            "This exact call failed earlier; an identical repeat is refused (§23.1 rule 7)",
            {
              hint: "Read the earlier error, change the arguments, or skip this call.",
              retryable: false,
            },
          ),
        );
        return;
      }

      // §6.3 retry budget: initial attempt + exactly one retry per (step, tool).
      const errorKey = `${stepSeq}:${name}`;
      const errorsSoFar = toolErrors.get(errorKey) ?? 0;
      if (errorsSoFar >= MAX_TOOL_CALL_ATTEMPTS_PER_STEP_TOOL) {
        recordDeviation(
          stepSeq,
          "retry_budget_exhausted",
          step.tool,
          name,
          `Tool "${truncate(name, 64)}" already failed ${errorsSoFar} times in step ${stepSeq + 1}; retry budget exhausted (§6.3)`,
        );
        appendCallPair(
          proposed,
          buildToolErr(
            TOOL_RETRY_EXHAUSTED_FEEDBACK_CODE,
            `Tool "${truncate(name, 64)}" exceeded its retry budget for this step`,
            {
              hint: "Do not call it again in this step; continue with a different tool or finish.",
              retryable: false,
            },
          ),
        );
        return;
      }

      // §5.7: args are validated against the tool's Zod schema at the boundary.
      const parsed = parseToolArgs(tool, args);
      if (!parsed.ok) {
        failedCalls.add(callKey);
        toolErrors.set(errorKey, errorsSoFar + 1);
        appendCallPair(proposed, parsed); // invalid_args feedback — read it, fix args, retry once
        return;
      }

      // Execute. §5.2 tool-call counter is charged for executed calls only.
      budget.trackToolCall();
      toolCallsExecuted += 1;
      const result = await runToolWithDeadline(tool, parsed.args);

      // The result is recorded whatever the run signal says (the report must
      // describe reality), THEN a run-level abort ends the walk (§3.4 cancel).
      appendCallPair(proposed, result);
      if (result.ok) {
        stepState.succeededTools.push(name);
        if (name === step.tool) {
          stepState.plannedToolSucceeded = true;
        }
        if (typeof result.documentRevision === "number") {
          lastDocumentRevision = result.documentRevision;
        }
      } else {
        // §23.1 rule 7 / §6.3: record the failure; the model gets exactly one retry.
        failedCalls.add(callKey);
        toolErrors.set(errorKey, errorsSoFar + 1);
      }
      if (signal.aborted) {
        stopReason ??= "aborted";
      }
    };

    // --- the walk (§5.1 small steps) -------------------------------------------
    for (let stepSeq = 0; stepSeq < plan.steps.length; stepSeq += 1) {
      const step = plan.steps[stepSeq];
      if (step === undefined) {
        break; // unreachable: planSchema guarantees dense PlanStep rows
      }

      // Checks between every step (§5.1/§5.2/§3.4).
      if (signal.aborted) {
        stopReason ??= "aborted";
        break;
      }
      const exceededBeforeStep = budget.exceeded();
      if (exceededBeforeStep !== null) {
        stopReason ??= "budget_exceeded";
        budgetExceeded ??= exceededBeforeStep;
        break;
      }
      if (roundTripsUsed >= this.limits.maxRoundTrips) {
        stopReason ??= "round_trip_cap";
        break;
      }

      const stepStartedAt = this.clock();
      await this.emit({
        type: "step.started",
        payload: { stepSeq, phase, tool: step.tool },
      });
      inFlightStep = stepSeq;

      transcript.append({
        role: "user",
        text:
          `Plan step ${stepSeq + 1} of ${plan.steps.length}: call the "${step.tool}" tool now. ` +
          `Planned arguments (JSON, adapt to the current document): ${JSON.stringify(step.args)}. ` +
          "Finish the turn when the step is done.",
      });

      const stepState = { succeededTools: [] as string[], plannedToolSucceeded: false, deviated: false };
      let countedFirstTurn = false;
      let stepEnded = false;

      const stream = this.model.streamToolLoop(
        system,
        transcript,
        this.manifest,
        budgetView(),
        signal,
      );
      for await (const event of stream) {
        // §5.1 round-trip accounting: one per provider call. The stream's first
        // event of any type counts its first turn (even if the seam forgot
        // `turn_started`); every later `turn_started` counts a new turn.
        let newTurn = false;
        if (!countedFirstTurn) {
          countedFirstTurn = true;
          newTurn = true;
        } else if (event.type === "turn_started") {
          newTurn = true;
        }
        if (newTurn) {
          if (roundTripsUsed >= this.limits.maxRoundTrips) {
            stopReason ??= "round_trip_cap"; // stop BEFORE the turn's calls run
            break;
          }
          roundTripsUsed += 1;
        }

        if (event.type === "usage") {
          budget.trackTokens(
            event.usage.model,
            event.usage.tokensIn,
            event.usage.tokensOut,
            event.usage.cacheHits ?? 0,
          );
        } else if (event.type === "text") {
          transcript.append({ role: "assistant", text: event.text });
        } else if (event.type === "tool_call") {
          const callId =
            typeof event.callId === "string" && event.callId.length > 0
              ? event.callId
              : `call-${callCounter}`;
          callCounter += 1;
          await processToolCall(
            stepSeq,
            step,
            { callId, name: event.name, args: event.args },
            stepState,
          );
          if (stopReason !== null) {
            break;
          }
        } else if (event.type === "step_done") {
          if (typeof event.text === "string" && event.text.trim().length > 0) {
            transcript.append({ role: "assistant", text: event.text });
            finalAssistantText = event.text; // §23.1 rule 8 closing paragraph
          }
          stepEnded = true;
          break;
        }
      }

      const durationMs = Math.max(0, this.clock() - stepStartedAt);
      const record: ExecutorStepRecord = Object.freeze({
        stepSeq,
        plannedTool: step.tool,
        succeededTools: Object.freeze(stepState.succeededTools),
        plannedToolSucceeded: stepState.plannedToolSucceeded,
        ok: stepState.succeededTools.length > 0,
        deviationFromPlan: stepState.deviated,
        durationMs,
      });
      stepRecords.push(record);
      await this.emit({
        type: "step.finished",
        payload: {
          stepSeq,
          phase,
          tool: step.tool,
          ok: record.ok,
          durationMs,
          deviationFromPlan: record.deviatedFromPlan,
        },
      });

      if (stopReason === null) {
        completedSteps += 1;
        inFlightStep = null;
      } else {
        // The step was interrupted by the stop: it keeps its record (§13.2
        // step.finished already surfaced it) and is reported as in-flight.
        break;
      }
    }

    const status: ExecutorStatus =
      stopReason === null
        ? "completed"
        : stopReason === "budget_exceeded"
          ? "budget_stopped"
          : stopReason === "round_trip_cap"
            ? "round_trip_stopped"
            : "aborted";

    const cut =
      stopReason === null
        ? null
        : this.buildCutReport({
            reason: stopReason,
            budgetExceeded,
            completedSteps,
            inFlightStep,
            plan,
          });

    return Object.freeze({
      status,
      phase,
      steps: Object.freeze(stepRecords),
      deviations: Object.freeze(deviations),
      roundTripsUsed,
      maxRoundTrips: this.limits.maxRoundTrips,
      toolCallsExecuted,
      lastDocumentRevision,
      finalAssistantText,
      cut,
      usage: budget.snapshot(),
    });
  }

  /** §5.2 "tell the user what was cut" for any early stop. */
  private buildCutReport(input: {
    readonly reason: ExecutorStopReason;
    readonly budgetExceeded: BudgetExceeded | null;
    readonly completedSteps: number;
    readonly inFlightStep: number | null;
    readonly plan: Plan;
  }): ExecutorCutReport {
    const { reason, budgetExceeded, completedSteps, inFlightStep, plan } = input;
    const firstUnstarted = inFlightStep === null ? completedSteps : inFlightStep + 1;
    const cutStepTools = plan.steps.slice(firstUnstarted).map((step) => step.tool);
    const cutList = cutStepTools.length > 0 ? cutStepTools.join(", ") : "none";
    const interrupted =
      inFlightStep === null
        ? ""
        : ` Step ${inFlightStep + 1} ("${plan.steps[inFlightStep]?.tool ?? "?"}") was interrupted mid-step; completed work in it is kept.`;
    const message =
      reason === "budget_exceeded"
        ? `${budgetExceeded?.message ?? "A tier budget was reached (§5.2)."} Remaining plan steps cut: ${truncate(cutList, 300)}.${interrupted}`
        : reason === "round_trip_cap"
          ? `Model↔tool round-trip cap for the phase reached (${this.limits.maxRoundTrips} of ${this.limits.maxRoundTrips}, §5.1); the run stops cleanly with completed work. Remaining plan steps cut: ${truncate(cutList, 300)}.${interrupted}`
          : `Run cancelled; the document keeps work committed so far. Remaining plan steps cut: ${truncate(cutList, 300)}.${interrupted}`;
    return Object.freeze({
      reason,
      completedSteps,
      totalSteps: plan.steps.length,
      inFlightStep,
      cutStepTools: Object.freeze(cutStepTools),
      message,
      budgetExceeded,
    });
  }
}

// ---------------------------------------------------------------------------
// Transcript factory
// ---------------------------------------------------------------------------

function createTranscript(initial: readonly ExecutorMessage[]): ExecutorTranscript {
  const messages: ExecutorMessage[] = [...initial];
  return {
    messages(): readonly ExecutorMessage[] {
      return [...messages];
    },
    append(message: ExecutorMessage): void {
      messages.push(message);
    },
  };
}

/** Small echo-guard for model-proposed strings (§6.1: never echo a wall of model output). */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}
