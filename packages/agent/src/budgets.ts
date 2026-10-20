// @studio/agent — tier budget enforcement (§5.2). Owner: W1-P (docs/AGENTS.md).
//
// §5.2: "Budgets are hard caps enforced by the worker (token counters +
// tool-call counters). Exceeding a budget is a FEATURE (predictable pricing),
// not an error: stop cleanly, commit what strengthened the document (…), charge
// partially at most, and tell the user what was cut."
//
// `exceeded()` therefore returns a typed soft-stop REPORT (never throws, never a
// hard failure): the loop uses it to finish cleanly and surface `message` via
// SSE. The clock is injectable (`Clock = () => epoch ms`) so tests and replayed
// runs are deterministic.
import { z } from 'zod';
import { resolveTierConfig, type RunTierId } from '@studio/config';

/** Injectable wall clock: returns epoch milliseconds. */
export type Clock = () => number;

/** Budget dimensions, in the deterministic order `exceeded()` reports them. */
export const BUDGET_KINDS = ['tokens_in', 'tokens_out', 'tool_calls', 'revisions', 'wall_clock'] as const;

export type BudgetKind = (typeof BUDGET_KINDS)[number];

/** Absolute §5.2 caps for one run. Token budgets are `null` for image tiers (n/a). */
export interface BudgetLimits {
  readonly tokenBudgetIn: number | null;
  readonly tokenBudgetOut: number | null;
  readonly toolCallCap: number;
  readonly revisions: number;
  readonly wallClockMs: number;
}

export const budgetLimitsSchema = z
  .strictObject({
    tokenBudgetIn: z.number().int().min(0).nullable(),
    tokenBudgetOut: z.number().int().min(0).nullable(),
    toolCallCap: z.number().int().min(0),
    revisions: z.number().int().min(0),
    wallClockMs: z.number().int().min(1),
  });

/** Per-model counters — mirrors `ModelCallUsage` in packages/db (W1-E), minus cost. */
export interface BudgetModelUsage {
  readonly calls: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheHits: number;
}

/** Consumed budget so far. */
export interface BudgetUsage {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheHits: number;
  readonly toolCalls: number;
  readonly revisions: number;
  readonly wallClockMs: number;
}

/** What each dimension still allows (null when the tier has no token budget). */
export interface BudgetRemaining {
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly toolCalls: number;
  readonly revisions: number;
  readonly wallClockMs: number;
}

/** §5.2 soft-stop report: a feature, not an error. */
export interface BudgetExceeded {
  /** Which dimension hit its cap. */
  readonly kind: BudgetKind;
  /** What was left of `kind`'s cap when the report fired (≥ 0; 0 = spent). */
  readonly remaining: number;
  /** User-surfaceable sentence telling what was cut (§5.2: "tell the user what was cut"). */
  readonly message: string;
}

/** Point-in-time counters for SSE progress and the run row. */
export interface BudgetSnapshot {
  readonly used: BudgetUsage;
  readonly remaining: BudgetRemaining;
  readonly modelUsage: Readonly<Record<string, BudgetModelUsage>>;
  /** cacheHits / model calls so far (§5.3 ≥60% target); null before the first call. */
  readonly cacheHitRate: number | null;
  readonly exceeded: BudgetExceeded | null;
}

const defaultClock: Clock = () => Date.now();

/** Provider-usage numbers can be flaky (NaN/undefined); never let them corrupt counters. */
function sanitizeCount(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Hard-cap counter for one §5.2 tier. Not thread-safe by design: the run loop
 * is single-owner (one worker owns a run); snapshots hand out frozen copies.
 */
export class BudgetTracker {
  private readonly limits: BudgetLimits;
  private readonly clock: Clock;
  private readonly startedAt: number;
  private readonly modelUsage: Record<string, BudgetModelUsage> = {};

  private tokensIn = 0;
  private tokensOut = 0;
  private cacheHits = 0;
  private modelCalls = 0;
  private toolCalls = 0;
  private revisions = 0;

  constructor(limits: BudgetLimits, clock: Clock = defaultClock) {
    this.limits = budgetLimitsSchema.parse(limits); // fail fast on hand-built limits
    this.clock = clock;
    this.startedAt = clock();
  }

  /** Builds the tracker from a §5.2 tier via @studio/config (multiplied tiers resolved). */
  static fromTier(tier: RunTierId, clock: Clock = defaultClock): BudgetTracker {
    const resolved = resolveTierConfig(tier);
    return new BudgetTracker(
      {
        tokenBudgetIn: resolved.tokenBudgetIn,
        tokenBudgetOut: resolved.tokenBudgetOut,
        toolCallCap: resolved.toolCallCap,
        revisions: resolved.revisions,
        wallClockMs: resolved.wallClockMs,
      },
      clock,
    );
  }

  /**
   * Records usage from one model response. `model` is the routed model id
   * (§5.3); `cacheHits` count cached static-prefix responses (§5.3 ≥60% target).
   * Invalid numbers (NaN/negative) are treated as 0 — never throw on flaky telemetry.
   */
  trackTokens(model: string, tokensIn: number, tokensOut: number, cacheHits = 0): void {
    const key = model.trim() || 'unknown';
    const inTokens = sanitizeCount(tokensIn);
    const outTokens = sanitizeCount(tokensOut);
    const hits = sanitizeCount(cacheHits);

    const current = this.modelUsage[key] ?? { calls: 0, tokensIn: 0, tokensOut: 0, cacheHits: 0 };
    this.modelUsage[key] = {
      calls: current.calls + 1,
      tokensIn: current.tokensIn + inTokens,
      tokensOut: current.tokensOut + outTokens,
      cacheHits: current.cacheHits + hits,
    };

    this.tokensIn += inTokens;
    this.tokensOut += outTokens;
    this.cacheHits += hits;
    this.modelCalls += 1;
  }

  /** Records one executed tool call (§5.2 tool-call cap). */
  trackToolCall(): void {
    this.toolCalls += 1;
  }

  /** Records one started repair cycle (§5.2 revisions column = repair cycles). */
  trackRevision(): void {
    this.revisions += 1;
  }

  /** Wall-clock ms consumed so far (per the injected clock). */
  wallClockUsedMs(): number {
    return Math.max(0, this.clock() - this.startedAt);
  }

  /** Remaining headroom per dimension (mirrors `BudgetLimits` nullability). */
  remaining(): BudgetRemaining {
    return {
      tokensIn: this.limits.tokenBudgetIn === null ? null : Math.max(0, this.limits.tokenBudgetIn - this.tokensIn),
      tokensOut: this.limits.tokenBudgetOut === null ? null : Math.max(0, this.limits.tokenBudgetOut - this.tokensOut),
      toolCalls: Math.max(0, this.limits.toolCallCap - this.toolCalls),
      revisions: Math.max(0, this.limits.revisions - this.revisions),
      wallClockMs: Math.max(0, this.limits.wallClockMs - this.wallClockUsedMs()),
    };
  }

  /**
   * The §5.2 soft-stop report, or `null` while inside all caps.
   *
   * A dimension is exceeded once it has consumed its full budget
   * (`used > 0 && used ≥ cap`) — check before each expensive operation and stop
   * cleanly at the first report. Zero-cap dimensions (image tiers have no repair
   * cycles) only report after an illicit unit was actually tracked. Report
   * order is `BUDGET_KINDS` order (deterministic).
   */
  exceeded(): BudgetExceeded | null {
    if (this.limits.tokenBudgetIn !== null && this.spent(this.tokensIn, this.limits.tokenBudgetIn)) {
      return this.report('tokens_in', this.tokensIn, this.limits.tokenBudgetIn, 'input tokens');
    }
    if (this.limits.tokenBudgetOut !== null && this.spent(this.tokensOut, this.limits.tokenBudgetOut)) {
      return this.report('tokens_out', this.tokensOut, this.limits.tokenBudgetOut, 'output tokens');
    }
    if (this.spent(this.toolCalls, this.limits.toolCallCap)) {
      return this.report('tool_calls', this.toolCalls, this.limits.toolCallCap, 'tool calls');
    }
    if (this.spent(this.revisions, this.limits.revisions)) {
      return this.report('revisions', this.revisions, this.limits.revisions, 'repair cycles');
    }
    if (this.spent(this.wallClockUsedMs(), this.limits.wallClockMs)) {
      return this.report('wall_clock', this.wallClockUsedMs(), this.limits.wallClockMs, 'wall-clock time');
    }
    return null;
  }

  /** True when a tracked dimension has consumed its entire cap. */
  private spent(used: number, cap: number): boolean {
    return used > 0 && used >= cap;
  }

  private report(kind: BudgetKind, used: number, cap: number, unit: string): BudgetExceeded {
    return {
      kind,
      remaining: Math.max(0, cap - used),
      message: `${kind.replace('_', ' ')} budget reached (${used} of ${cap} ${unit}); the run stops cleanly and keeps committed work (§5.2).`,
    };
  }

  /** Frozen point-in-time counters for SSE progress and run persistence. */
  snapshot(): BudgetSnapshot {
    const modelUsage: Record<string, BudgetModelUsage> = {};
    for (const [model, usage] of Object.entries(this.modelUsage)) {
      modelUsage[model] = Object.freeze({ ...usage });
    }
    return Object.freeze({
      used: Object.freeze({
        tokensIn: this.tokensIn,
        tokensOut: this.tokensOut,
        cacheHits: this.cacheHits,
        toolCalls: this.toolCalls,
        revisions: this.revisions,
        wallClockMs: this.wallClockUsedMs(),
      }),
      remaining: Object.freeze(this.remaining()),
      modelUsage: Object.freeze(modelUsage),
      cacheHitRate: this.modelCalls > 0 ? this.cacheHits / this.modelCalls : null,
      exceeded: this.exceeded(),
    });
  }
}
