// @studio/agent — §5.2 tier-budget wiring for the run loop. Owner: W6-G.
//
// Built ON (not instead of) W1-P's counter core `BudgetTracker` (../budgets.js):
// this module maps the exact §5.2 tier table (@studio/config `TIER_CONFIG` via
// `resolveTierConfig` — premium ×2 / max ×4 credit multipliers, +50% / +100%
// token & tool-call multipliers, image tiers with n/a token budgets) onto a
// phase-aware tracker the run manager drives:
//
//   const budget = createBudgetTracker("standard", { clock });
//   if (budget.shouldStop()) { … §5.2 clean stop — a feature, not an error … }
//   const cut = budget.stopReason(); // { kind, remaining, message } | null
//   const settlement = computeSettlement(
//     budget.report({ completed }), tier, { validatorPassed, documentImproved },
//   ); // settlement.js — the §5.2 partial-charge rule
//
// §5.2: "Budgets are hard caps enforced by the worker (token counters +
// tool-call counters). Exceeding a budget is a FEATURE (predictable pricing),
// not an error: stop cleanly, commit what strengthened the document (…), charge
// partially at most, and tell the user what was cut."
//
// Hence the hot path NEVER throws: `shouldStop()` / `stopReason()` report the
// first §5.2 cap that fired, LATCHED so the "what was cut" sentence stays stable
// once the loop decides to stop. Invalid model telemetry (NaN/negative usage)
// is sanitized by the core — never thrown, never corrupting counters.
// Construction-time nonsense (unknown tier id, non-integer phase totals) fails
// fast: that is a wiring bug, not a budget event (W1-P's zod `budgetLimitsSchema`
// parses the limits inside the core constructor).
//
// Phase model (denominator of the §5.2 partial-charge ratio, see settlement.js):
// the §5.1 loop decomposes a run into plan → execute → validate → critique
// (skipped for quick, §5.3) → up to `revisions` repair cycles. The run manager
// records completions via `trackPhaseCompleted()` and may override the default
// total with `totalPhases` when it slices a run differently.
import { type RunTierId, resolveTierConfig } from "@studio/config";
import { BudgetTracker, type BudgetExceeded, type BudgetSnapshot, type Clock } from "../budgets.js";

/** The §5.1 run phases, in canonical order (repair repeats once per cycle). */
export const RUN_PHASES = ["plan", "execute", "validate", "critique", "repair"] as const;

export type RunPhase = (typeof RUN_PHASES)[number];

/**
 * Default phase total per tier — the §5.2 partial-charge denominator:
 *
 *   image tiers — 1 (a single generation step; tool-call cap 1, no revisions)
 *   quick       — 4 (plan + execute + validate + 1 repair; §5.3 skips the critic)
 *   interactive — 4 + revisions (plan + execute + validate + critique + one slot
 *                 per §5.2 repair cycle: standard/complex/premium 6, max 7)
 */
export function defaultPhaseTotal(tier: RunTierId): number {
  const resolved = resolveTierConfig(tier);
  switch (tier) {
    case "image_gen":
    case "image_gen_hd":
      return 1;
    case "quick":
      return 4;
    default:
      return 4 + resolved.revisions;
  }
}

/** Options for `createBudgetTracker`. */
export interface CreateBudgetTrackerOptions {
  /** Injectable wall clock (epoch ms) — deterministic tests and replays (§5.2). */
  readonly clock?: Clock;
  /**
   * Overrides the tier's default phase total (see `defaultPhaseTotal`). Must be
   * a positive integer; it is the §5.2 settlement ratio denominator.
   */
  readonly totalPhases?: number;
}

/**
 * §5.2 run-terminal report: W1-P's `BudgetSnapshot` plus tier identity, the
 * terminal classification and phase progress. Consumed by `computeSettlement`
 * (settlement.js), SSE progress and run persistence.
 *
 * Invariant: `stopped` ⟺ `!completed && exceeded !== null`. When `completed` is
 * true the counters may sit exactly at a cap — the run finished anyway, so the
 * §5.2 stop is not part of the story (`exceeded` reports null).
 */
export interface BudgetReport extends BudgetSnapshot {
  /** The tier this run was priced and capped at. */
  readonly tier: RunTierId;
  /** Resolved tier price in credits (§5.2/§14.4: premium 4, max 8). */
  readonly credits: number;
  /** True when every phase finished (§14.2 rule 2 settles this as a full charge). */
  readonly completed: boolean;
  /** True when a §5.2 hard cap stopped the run early — the §5.2 feature, not an error. */
  readonly stopped: boolean;
  /** Completed phase count for the §5.2 partial-charge ratio. */
  readonly phasesCompleted: number;
  /** Total phases the run was sliced into. */
  readonly phasesTotal: number;
}

/** Default wall clock when none is injected (mirrors the core's private default). */
const defaultEpochClock: Clock = () => Date.now();

/**
 * `BudgetTracker` (W1-P core) bound to one §5.2 tier, plus the phase counter and
 * the latched soft-stop facade the run loop drives. Not thread-safe by design:
 * a run is single-owner (one worker); `report()` hands out a frozen copy.
 */
export class TierBudgetTracker extends BudgetTracker {
  readonly tier: RunTierId;
  /** Resolved tier price in credits (§5.2). */
  readonly credits: number;
  /** Total phases of the run slice (the §5.2 partial-charge denominator). */
  readonly phasesTotal: number;
  /** Wall-clock deadline in epoch ms per the injected clock (start + §5.2 cap). */
  readonly deadlineAt: number;

  private phasesDone = 0;
  private latchedStop: BudgetExceeded | null = null;
  private stopLatched = false;

  constructor(tier: RunTierId, options: CreateBudgetTrackerOptions = {}) {
    // resolveTierConfig throws on unknown ids — fail fast on wiring bugs.
    const resolved = resolveTierConfig(tier);
    super(
      {
        tokenBudgetIn: resolved.tokenBudgetIn,
        tokenBudgetOut: resolved.tokenBudgetOut,
        toolCallCap: resolved.toolCallCap,
        revisions: resolved.revisions,
        wallClockMs: resolved.wallClockMs,
      },
      options.clock,
    );
    this.tier = tier;
    this.credits = resolved.credits;
    const total = options.totalPhases ?? defaultPhaseTotal(tier);
    if (!Number.isSafeInteger(total) || total < 1) {
      throw new Error("[agent] totalPhases must be a positive integer");
    }
    this.phasesTotal = total;
    // Second clock() read may sit ≤1 ms after the core's startedAt on a live
    // clock; with an injected clock both reads are identical. Informational.
    const clock: Clock = options.clock ?? defaultEpochClock;
    this.deadlineAt = clock() + resolved.wallClockMs;
  }

  /** Records one finished run phase; clamped at `phasesTotal` (never over-report). */
  trackPhaseCompleted(): void {
    if (this.phasesDone < this.phasesTotal) {
      this.phasesDone += 1;
    }
  }

  /**
   * The latched §5.2 soft-stop report — the FIRST cap that fired, stable for the
   * rest of the run — or null while inside every cap. Never throws.
   */
  stopReason(): BudgetExceeded | null {
    if (!this.stopLatched) {
      const hit = this.exceeded();
      if (hit !== null) {
        this.latchedStop = hit;
        this.stopLatched = true;
      }
    }
    return this.latchedStop;
  }

  /** True once a §5.2 hard cap is spent — check before each expensive operation. */
  shouldStop(): boolean {
    return this.stopReason() !== null;
  }

  /**
   * Frozen terminal report. `completed: true` settles the run as finished
   * (§14.2 rule 2 full charge) even when counters sit exactly at a cap — the
   * user got the whole run; `completed: false` keeps the latched §5.2 stop that
   * cut it short.
   */
  report(terminal: { readonly completed: boolean }): BudgetReport {
    const snapshot = this.snapshot();
    const stop = terminal.completed ? null : this.stopReason();
    return Object.freeze({
      ...snapshot,
      exceeded: stop,
      tier: this.tier,
      credits: this.credits,
      completed: terminal.completed,
      stopped: stop !== null,
      phasesCompleted: this.phasesDone,
      phasesTotal: this.phasesTotal,
    });
  }
}

/**
 * Maps the §5.2 tier table (`TIER_CONFIG` via `resolveTierConfig`) onto a
 * `TierBudgetTracker`: token caps in/out (null on image tiers), tool-call cap,
 * revision cap, wall-clock deadline, per-model usage breakdown, phase counter
 * and the never-throwing `shouldStop()` / `stopReason()` soft-stop facade.
 */
export function createBudgetTracker(
  tier: RunTierId,
  options: CreateBudgetTrackerOptions = {},
): TierBudgetTracker {
  return new TierBudgetTracker(tier, options);
}
