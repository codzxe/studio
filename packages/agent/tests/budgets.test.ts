// W1-P — §5.2 tier budgets: counters, soft-stop reports, injectable clock.
import { describe, expect, it } from "vitest";
import { BudgetTracker, type Clock } from "../src/budgets.js";

/** Deterministic injectable clock: returns epoch ms, advanced manually. */
function fakeClock(startAtMs = 0): { clock: Clock; set: (ms: number) => void } {
  let now = startAtMs;
  return {
    clock: () => now,
    set: (ms: number) => {
      now = ms;
    },
  };
}

describe("budgets: §5.2 tier construction (via @studio/config)", () => {
  it("standard: 80k in / 5k out / 12 tool calls / 2 revisions / 5 min wall clock", () => {
    const { clock } = fakeClock();
    const tracker = BudgetTracker.fromTier("standard", clock);
    expect(tracker.remaining()).toEqual({
      tokensIn: 80_000,
      tokensOut: 5_000,
      toolCalls: 12,
      revisions: 2,
      wallClockMs: 300_000,
    });
    expect(tracker.exceeded()).toBeNull();
  });

  it("premium resolves the §5.2 +50% multipliers over standard", () => {
    const { clock } = fakeClock();
    const tracker = BudgetTracker.fromTier("premium", clock);
    expect(tracker.remaining().tokensIn).toBe(120_000);
    expect(tracker.remaining().tokensOut).toBe(7_500);
    expect(tracker.remaining().toolCalls).toBe(18);
    expect(tracker.remaining().revisions).toBe(2);
    expect(tracker.remaining().wallClockMs).toBe(600_000);
  });

  it("image tiers have no token budget (n/a per §5.2) but keep hard tool-call caps", () => {
    const { clock } = fakeClock();
    const tracker = BudgetTracker.fromTier("image_gen", clock);
    expect(tracker.remaining().tokensIn).toBeNull();
    tracker.trackTokens("flux-2-schnell", 500, 800);
    expect(tracker.exceeded()).toBeNull(); // token usage never trips image tiers
    tracker.trackToolCall();
    expect(tracker.exceeded()?.kind).toBe("tool_calls");
  });

  it("refuses hand-built nonsense limits (zod at the boundary)", () => {
    expect(
      () =>
        new BudgetTracker({
          tokenBudgetIn: -1,
          tokenBudgetOut: 0,
          toolCallCap: 1,
          revisions: 0,
          wallClockMs: 0,
        }),
    ).toThrow();
  });
});

describe("budgets: counters", () => {
  it("accumulates tokens per model and totals them (§5.3 usage rollup)", () => {
    const tracker = BudgetTracker.fromTier("standard", fakeClock().clock);
    tracker.trackTokens("gemini-3.8-flash", 1_000, 200, 1);
    tracker.trackTokens("gemini-3.8-flash", 500, 100);
    tracker.trackTokens("deepseek-v4.1-flash", 300, 50, 1);

    const snapshot = tracker.snapshot();
    expect(snapshot.modelUsage["gemini-3.8-flash"]).toEqual({
      calls: 2,
      tokensIn: 1_500,
      tokensOut: 300,
      cacheHits: 1,
    });
    expect(snapshot.modelUsage["deepseek-v4.1-flash"]).toEqual({
      calls: 1,
      tokensIn: 300,
      tokensOut: 50,
      cacheHits: 1,
    });
    expect(snapshot.used.tokensIn).toBe(1_800);
    expect(snapshot.used.tokensOut).toBe(350);
    expect(snapshot.used.cacheHits).toBe(2);
    expect(snapshot.cacheHitRate).toBeCloseTo(2 / 3); // §5.3 ≥60% target observable
    expect(snapshot.exceeded).toBeNull();
  });

  it("ignores flaky provider telemetry (NaN / negative), never throws", () => {
    const tracker = BudgetTracker.fromTier("standard", fakeClock().clock);
    tracker.trackTokens("model-x", Number.NaN, -50, Number.NaN);
    const snapshot = tracker.snapshot();
    expect(snapshot.used.tokensIn).toBe(0);
    expect(snapshot.used.tokensOut).toBe(0);
    expect(snapshot.used.cacheHits).toBe(0);
    expect(snapshot.cacheHitRate).toBe(0); // 0 hits / 1 call
    expect(tracker.exceeded()).toBeNull();
  });

  it('falls back to the "unknown" model key for empty ids', () => {
    const tracker = BudgetTracker.fromTier("standard", fakeClock().clock);
    tracker.trackTokens("   ", 10, 5);
    expect(tracker.snapshot().modelUsage.unknown?.calls).toBe(1);
  });
});

describe("budgets: soft-stop reports (§5.2 — feature, not error)", () => {
  it.each([
    {
      name: "input tokens",
      tier: "standard" as const,
      spend: (t: BudgetTracker) => t.trackTokens("m", 80_000, 0),
      kind: "tokens_in",
      unitHint: "input tokens",
    },
    {
      name: "output tokens",
      tier: "standard" as const,
      spend: (t: BudgetTracker) => t.trackTokens("m", 10_000, 5_000),
      kind: "tokens_out",
      unitHint: "output tokens",
    },
    {
      name: "tool calls",
      tier: "standard" as const,
      spend: (t: BudgetTracker) => {
        for (let i = 0; i < 12; i += 1) t.trackToolCall();
      },
      kind: "tool_calls",
      unitHint: "tool calls",
    },
    {
      name: "repair cycles",
      tier: "standard" as const,
      spend: (t: BudgetTracker) => {
        t.trackRevision();
        t.trackRevision();
      },
      kind: "revisions",
      unitHint: "repair cycles",
    },
  ])("reports $name exhaustion exactly at the cap", ({ tier, spend, kind, unitHint }) => {
    const tracker = BudgetTracker.fromTier(tier, fakeClock().clock);
    expect(tracker.exceeded()).toBeNull(); // inside the budget before spending
    spend(tracker);
    const report = tracker.exceeded();
    expect(report, kind).not.toBeNull();
    expect(report?.kind).toBe(kind);
    expect(report?.remaining).toBe(0);
    expect(report?.message).toContain(unitHint);
    expect(report?.message).toContain("§5.2");
    // The report shape is exactly the contract: { kind, remaining, message }.
    expect(Object.keys(report ?? {}).sort()).toEqual(["kind", "message", "remaining"]);
  });

  it("keeps the last unit within budget and reports only once it is spent", () => {
    const tracker = BudgetTracker.fromTier("quick", fakeClock().clock); // toolCallCap 6
    for (let i = 0; i < 5; i += 1) tracker.trackToolCall();
    expect(tracker.exceeded()).toBeNull(); // 5 of 6: one call left
    tracker.trackToolCall(); // 6 of 6: budget fully spent
    const report = tracker.exceeded();
    expect(report?.kind).toBe("tool_calls");
    expect(report?.message).toContain("6 of 6");
  });

  it("reports dimensions in a deterministic order (BUDGET_KINDS)", () => {
    const tracker = BudgetTracker.fromTier("standard", fakeClock().clock);
    tracker.trackTokens("m", 80_000, 5_000); // trips tokens_in AND tokens_out
    tracker.trackToolCall();
    tracker.trackRevision();
    tracker.trackRevision();
    expect(tracker.exceeded()?.kind).toBe("tokens_in"); // first in BUDGET_KINDS wins
  });

  it("wall clock uses the injected clock and trips at the tier cap", () => {
    const { clock, set } = fakeClock(1_000);
    const tracker = BudgetTracker.fromTier("standard", clock);
    set(1_000 + 299_999);
    expect(tracker.exceeded()).toBeNull();
    set(1_000 + 300_000); // 5 min wall clock (§5.2)
    const report = tracker.exceeded();
    expect(report?.kind).toBe("wall_clock");
    expect(tracker.snapshot().used.wallClockMs).toBe(300_000);
  });

  it("exceeded() is idempotent and never mutates counters", () => {
    const tracker = BudgetTracker.fromTier("standard", fakeClock().clock);
    tracker.trackTokens("m", 80_000, 0);
    const first = tracker.exceeded();
    const second = tracker.exceeded();
    expect(second).toEqual(first);
    expect(tracker.snapshot().used.tokensIn).toBe(80_000);
  });
});

describe("budgets: snapshots for SSE progress", () => {
  it("hands out frozen, isolated copies", () => {
    const tracker = BudgetTracker.fromTier("standard", fakeClock().clock);
    tracker.trackTokens("m", 10, 2);
    const snapshot = tracker.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.used)).toBe(true);
    expect(Object.isFrozen(snapshot.modelUsage)).toBe(true);
    expect(Object.isFrozen(snapshot.modelUsage.m)).toBe(true);
  });

  it("carries remaining per dimension and a null cacheHitRate before any call", () => {
    const tracker = BudgetTracker.fromTier("standard", fakeClock().clock);
    const snapshot = tracker.snapshot();
    expect(snapshot.cacheHitRate).toBeNull();
    expect(snapshot.remaining.toolCalls).toBe(12);
    expect(snapshot.exceeded).toBeNull();
  });
});
