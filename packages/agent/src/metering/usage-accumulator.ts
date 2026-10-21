// @studio/agent — metering: per-run usage accumulation. Owner: W9-C.
//
// Spec anchors:
//   §22    metrics: tokens in/out/cache, tool error rate, AI cost per run
//   §12.1  agent_runs cost columns + agent_steps cost columns
//   §5.1   steps belong to exactly one run phase (planning…finalizing)
//
// Pure, synchronous, single-owner (a run is owned by one worker — see
// TierBudgetTracker's non-thread-safety note). Aggregates in bigint micro-USD
// and only converts to DB-column numbers at row time, via microToSafeNumber.
//
// Structural compatibility (no import from @studio/db to keep this module
// pure): `RunUsageRow` matches the cost-bearing subset of agent_runs
// (tokens_in / tokens_out / cache_hits / model_calls jsonb / cost_micro_usd)
// and `ModelCallUsageRow` IS the runs.ts `ModelCallUsage` shape
// { calls, tokensIn, tokensOut, cacheHits, costMicroUsd }. `StepUsageRow`
// matches the agent_steps cost subset (tokensIn / tokensOut / costMicroUsd)
// plus the per-tool counters the §22 tool-error-rate metric needs.
import {
  computeCost,
  MeteringError,
  microToSafeNumber,
  resolveModelRates,
  type ModelRatesTable,
} from "./cost-model.js";

/** runs.ts `ModelCallUsage` (agent_runs.model_calls jsonb), per model id. */
export interface ModelCallUsageRow {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  cacheHits: number;
  costMicroUsd: number;
}

/** agent_runs cost fields (§12.1) — the cost-bearing subset of a run row. */
export interface RunUsageRow {
  runId: string;
  tokensIn: number;
  tokensOut: number;
  cacheHits: number;
  modelCalls: Record<string, ModelCallUsageRow>;
  costMicroUsd: number;
}

/** agent_steps cost fields (§12.1) + §22 per-tool counters. */
export interface StepUsageRow {
  seq: number;
  /** §5.1 run phase of the step (planning|executing|…|finalizing). */
  phase: string;
  tool: string | null;
  tokensIn: number;
  tokensOut: number;
  costMicroUsd: number;
  toolCalls: number;
  toolErrors: number;
  durationMs: number;
}

/** §22 tool-error-rate aggregation for one tool name. */
export interface ToolUsageRow {
  tool: string;
  calls: number;
  errors: number;
  durationMs: number;
}

/** One provider call to record (same counters computeCost validates). */
export interface ModelCallInput {
  tokensIn: number;
  tokensOut: number;
  cacheHits?: number;
}

/** One tool invocation to record (§22 tool error rate). */
export interface ToolCallInput {
  /** Marks the call as failed (any typed error envelope). */
  error?: boolean;
  durationMs?: number;
}

/** Step metadata the run loop already knows (§5.1 seq / phase / tool). */
export interface StepMeta {
  seq: number;
  phase: string;
  tool: string | null;
}

interface ModelTally {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  cacheHits: number;
  costMicro: bigint;
}

interface ToolTally {
  calls: number;
  errors: number;
  durationMs: number;
}

/**
 * Per-model + per-tool usage rollup for ONE run, with step-level sub-scopes.
 *
 *   const usage = new RunUsage();
 *   const step = usage.openStep({ seq: 1, phase: "executing", tool: "template_apply" });
 *   step.addModelCall("gemini-3.8-flash", { tokensIn: 80_000, tokensOut: 900, cacheHits: 48_000 });
 *   step.addToolCall({ durationMs: 120 });
 *   usage.closeStep(step);                       // → StepUsageRow (frozen)
 *   const row = usage.toRow("run_123");          // agent_runs cost fields
 *
 * Invariants (pinned by tests):
 *   - run token totals = Σ all recorded calls (step-scoped AND bare calls)
 *   - run costMicroUsd = Σ per-model costMicroUsd = Σ step costMicroUsd + bare-call cost
 *   - steps are sequential: exactly one open step at a time
 * Unknown model ids throw a typed MeteringError from computeCost — costs are
 * never silently priced $0 (add the model to MODEL_RATES_JSON or the table).
 */
export class RunUsage {
  private readonly rates: ModelRatesTable;
  private readonly models = new Map<string, ModelTally>();
  private readonly tools = new Map<string, ToolTally>();
  private readonly stepRows: StepUsageRow[] = [];
  private currentStep: StepUsage | null = null;

  private tokensIn = 0;
  private tokensOut = 0;
  private cacheHits = 0;
  private costMicro = 0n;

  constructor(options: { rates?: ModelRatesTable } = {}) {
    // No injected table ⇒ resolve Appendix C + MODEL_RATES_JSON now: a broken
    // override fails fast at RunUsage construction (AGENTS.md env rule) instead
    // of mispricing mid-run. Runs are long; parsing the tiny env JSON is noise.
    this.rates = options.rates ?? resolveModelRates();
  }

  /**
   * Records one model call against the run (use from a StepUsage to also count
   * it inside a step). Returns the call's cost in micro-USD (bigint, exact).
   */
  addModelCall(model: string, usage: ModelCallInput): bigint {
    const cost = computeCost(
      { model, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, cacheHits: usage.cacheHits ?? 0 },
      this.rates,
    );
    const tally =
      this.models.get(model) ?? { calls: 0, tokensIn: 0, tokensOut: 0, cacheHits: 0, costMicro: 0n };
    tally.calls += 1;
    tally.tokensIn += usage.tokensIn;
    tally.tokensOut += usage.tokensOut;
    tally.cacheHits += usage.cacheHits ?? 0;
    tally.costMicro += cost;
    this.models.set(model, tally);
    this.tokensIn += usage.tokensIn;
    this.tokensOut += usage.tokensOut;
    this.cacheHits += usage.cacheHits ?? 0;
    this.costMicro += cost;
    return cost;
  }

  /** Records one tool invocation for the §22 tool-error-rate metric. */
  addToolCall(tool: string, call: ToolCallInput = {}): void {
    recordToolCall(this.tools, tool, call);
  }

  /**
   * Opens the next step scope (§5.1). Steps are sequential: opening a second
   * scope before closing the first is a wiring bug and fails fast.
   */
  openStep(meta: StepMeta): StepUsage {
    if (this.currentStep !== null) {
      throw new MeteringError(
        "invalid_usage",
        `cannot open step ${meta.seq} while step ${this.currentStep.seq} is still open`,
        "the run loop closes each step before starting the next",
      );
    }
    if (!Number.isSafeInteger(meta.seq) || meta.seq < 1) {
      throw new MeteringError(
        "invalid_usage",
        `step seq must be a positive integer, got ${meta.seq}`,
        "agent_steps.seq is 1-based (§12.1)",
      );
    }
    this.currentStep = new StepUsage(this, meta);
    return this.currentStep;
  }

  /** Closes the open step and freezes its row. Returns the frozen StepUsageRow. */
  closeStep(step: StepUsage): StepUsageRow {
    if (this.currentStep !== step) {
      throw new MeteringError(
        "invalid_usage",
        `cannot close step ${step.seq}: it is not the open step`,
        "steps close in the order they open (§5.1 run timeline)",
      );
    }
    this.currentStep = null;
    const row = step.close(); // latches closed, freezes the row
    this.stepRows.push(row);
    return row;
  }

  /** All closed step rows, frozen, in close order (== seq order). */
  steps(): readonly StepUsageRow[] {
    return Object.freeze([...this.stepRows]);
  }

  /** §22 tool-error-rate rows, sorted by tool name for deterministic output. */
  toolUsage(): readonly ToolUsageRow[] {
    return Object.freeze(
      [...this.tools.entries()]
        .map(([tool, tally]) => Object.freeze({ tool, ...tally }) as ToolUsageRow)
        .sort((a, b) => a.tool.localeCompare(b.tool)),
    );
  }

  /** Immutable bigint totals for metrics (§22 tokens in/out/cache, cost per run). */
  snapshot(): {
    tokensIn: number;
    tokensOut: number;
    cacheHits: number;
    costMicroUsd: bigint;
    modelCalls: number;
    toolCalls: number;
    toolErrors: number;
    steps: number;
  } {
    let toolCalls = 0;
    let toolErrors = 0;
    for (const tally of this.tools.values()) {
      toolCalls += tally.calls;
      toolErrors += tally.errors;
    }
    return Object.freeze({
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      cacheHits: this.cacheHits,
      costMicroUsd: this.costMicro,
      modelCalls: this.models.size,
      toolCalls,
      toolErrors,
      steps: this.stepRows.length,
    });
  }

  /** agent_runs cost fields (§12.1) for run persistence. Frozen deep-enough copy. */
  toRow(runId: string): RunUsageRow {
    if (typeof runId !== "string" || runId.trim() === "") {
      throw new MeteringError(
        "invalid_usage",
        "runId must be a non-empty string",
        "toRow feeds agent_runs.id (§12.1)",
      );
    }
    const modelCalls: Record<string, ModelCallUsageRow> = {};
    for (const [model, tally] of this.models.entries()) {
      modelCalls[model] = Object.freeze({
        calls: tally.calls,
        tokensIn: tally.tokensIn,
        tokensOut: tally.tokensOut,
        cacheHits: tally.cacheHits,
        costMicroUsd: microToSafeNumber(tally.costMicro),
      });
    }
    return Object.freeze({
      runId,
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      cacheHits: this.cacheHits,
      modelCalls: Object.freeze(modelCalls),
      costMicroUsd: microToSafeNumber(this.costMicro),
    });
  }
}

/**
 * Step-scoped usage tally. Model calls recorded here are ALSO recorded on the
 * owning RunUsage (single source of truth — step sub-totals are additive views,
 * never a second counting path), so run totals always reconcile with steps.
 */
export class StepUsage {
  readonly seq: number;
  readonly phase: string;
  readonly tool: string | null;

  private readonly owner: RunUsage;
  private tokensIn = 0;
  private tokensOut = 0;
  private costMicro = 0n;
  private toolCalls = 0;
  private toolErrors = 0;
  private durationMs = 0;
  private closed = false;

  constructor(owner: RunUsage, meta: StepMeta) {
    this.owner = owner;
    this.seq = meta.seq;
    this.phase = meta.phase;
    this.tool = meta.tool;
  }

  /** Records a model call into the step (and the run — see class note). */
  addModelCall(model: string, usage: ModelCallInput): bigint {
    this.assertOpen();
    const cost = this.owner.addModelCall(model, usage);
    this.tokensIn += usage.tokensIn;
    this.tokensOut += usage.tokensOut;
    this.costMicro += cost;
    return cost;
  }

  /** Records a tool invocation into the step (and the run's tool tally). */
  addToolCall(tool: string, call: ToolCallInput = {}): void {
    this.assertOpen();
    // owner validates tool + durationMs and tallies the run-level §22 rows;
    // agent_steps keeps single-tool columns, so the step only counts.
    this.owner.addToolCall(tool, call);
    this.toolCalls += 1;
    this.toolErrors += call.error ? 1 : 0;
    this.durationMs += call.durationMs ?? 0;
  }

  /** agent_steps cost fields (§12.1); agent_steps carries no cache column. */
  toRow(): StepUsageRow {
    return Object.freeze({
      seq: this.seq,
      phase: this.phase,
      tool: this.tool,
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      costMicroUsd: microToSafeNumber(this.costMicro),
      toolCalls: this.toolCalls,
      toolErrors: this.toolErrors,
      durationMs: this.durationMs,
    });
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new MeteringError(
        "invalid_usage",
        `step ${this.seq} is closed; usage cannot be recorded after closeStep`,
        "the run loop opens a fresh step scope per §5.1 step",
      );
    }
  }

  /** Marks the scope closed — only the owning RunUsage may call this. */
  close(): StepUsageRow {
    this.closed = true;
    return this.toRow();
  }
}

function recordToolCall(tools: Map<string, ToolTally>, tool: string, call: ToolCallInput): void {
  if (typeof tool !== "string" || tool.trim() === "") {
    throw new MeteringError(
      "invalid_usage",
      "tool name must be a non-empty string",
      "tool ids come from the §5.7 tool registry",
    );
  }
  const durationMs = call.durationMs ?? 0;
  if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
    throw new MeteringError(
      "invalid_usage",
      `durationMs must be a non-negative integer, got ${durationMs}`,
      "engine timings are recorded in whole ms",
    );
  }
  const tally = tools.get(tool) ?? { calls: 0, errors: 0, durationMs: 0 };
  tally.calls += 1;
  tally.errors += call.error ? 1 : 0;
  tally.durationMs += durationMs;
  tools.set(tool, tally);
}
