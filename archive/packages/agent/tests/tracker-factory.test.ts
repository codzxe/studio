// W6-G — §5.2 budget factory: tier caps table (premium ×2 / max ×4 multipliers),
// per-model usage breakdown, phase counters, the never-throwing soft-stop
// facade, and clock injection.
import { describe, expect, it } from "vitest";
import { type Clock } from "../src/budgets.js";
import { createBudgetTracker, defaultPhaseTotal } from "../src/budgets-service/tracker-factory.js";

/** Deterministic injectable clock: epoch ms, advanced manually. */
function fakeClock(startAtMs = 0): { clock: Clock; set: (ms: number) => void } {
  let now = startAtMs;
  return {
    clock: () => now,
    set: (ms: number) => {
      now = ms;
    },
  };
}

/**
 * The exact §5.2 table (multiplied tiers resolved): premium = standard ×1.5
 * tokens/tool calls, ×2 credits; max = standard ×2 tokens/tool calls, ×4
 * credits, 3 revisions, 15 min. Image tiers carry no token budget (n/a).
 */
const CAPS = [
  {
    tier: "quick",
    tokensIn: 20_000,
    tokensOut: 2_000,
    toolCalls: 6,
    revisions: 1,
    wallClockMs: 120_000,
    credits: 1,
    phases: 4,
  },
  {
    tier: "standard",
    tokensIn: 80_000,
    tokensOut: 5_000,
    toolCalls: 12,
    revisions: 2,
    wallClockMs: 300_000,
    credits: 2,
    phases: 6,
  },
  {
    tier: "complex",
    tokensIn: 200_000,
    tokensOut: 12_000,
    toolCalls: 24,
    revisions: 2,
    wallClockMs: 600_000,
    credits: 5,
    phases: 6,
  },
  {
    tier: "premium",
    tokensIn: 120_000,
    tokensOut: 7_500,
    toolCalls: 18,
    revisions: 2,
    wallClockMs: 600_000,
    credits: 4,
    phases: 6,
  },
  {
    tier: "max",
    tokensIn: 160_000,
    tokensOut: 10_000,
    toolCalls: 24,
    revisions: 3,
    wallClockMs: 900_000,
    credits: 8,
    phases: 7,
  },
  {
    tier: "image_gen",
    tokensIn: null,
    tokensOut: null,
    toolCalls: 1,
    revisions: 0,
    wallClockMs: 60_000,
    credits: 1,
    phases: 1,
  },
  {
    tier: "image_gen_hd",
    tokensIn: null,
    tokensOut: null,
    toolCalls: 1,
    revisions: 0,
    wallClockMs: 120_000,
    credits: 2,
    phases: 1,
  },
] as const;

describe("createBudgetTracker: the §5.2 caps table (multipliers resolved)", () => {
  for (const cap of CAPS) {
    it(`${cap.tier}: ${String(cap.tokensIn)} in / ${String(cap.tokensOut)} out / ${cap.toolCalls} tools / ${cap.revisions} revisions / ${cap.wallClockMs} ms`, () => {
      const { clock } = fakeClock(1_000);
      const tracker = createBudgetTracker(cap.tier, { clock });
      expect(tracker.remaining()).toEqual({
        tokensIn: cap.tokensIn,
        tokensOut: cap.tokensOut,
        toolCalls: cap.toolCalls,
        revisions: cap.revisions,
        wallClockMs: cap.wallClockMs,
      });
      expect(tracker.tier).toBe(cap.tier);
      expect(tracker.credits).toBe(cap.credits);
      expect(tracker.phasesTotal).toBe(cap.phases);
      expect(tracker.deadlineAt).toBe(1_000 + cap.wallClockMs);
      expect(tracker.shouldStop()).toBe(false);
      expect(tracker.stopReason()).toBeNull();
    });
  }

  it("premium = standard ×1.5 tokens/tool calls and ×2 credits (§5.2, §14.4 pins 4)", () => {
    const standard = createBudgetTracker("standard", { clock: fakeClock().clock });
    const premium = createBudgetTracker("premium", { clock: fakeClock().clock });
    expect(premium.credits).toBe(standard.credits * 2);
    expect(premium.remaining().tokensIn).toBe(80_000 * 1.5);
    expect(premium.remaining().tokensOut).toBe(5_000 * 1.5);
    expect(premium.remaining().toolCalls).toBe(12 * 1.5);
  });

  it("max = standard ×2 tokens/tool calls, ×4 credits (§14.4 pins 8), 3 revisions, 15 min", () => {
    const max = createBudgetTracker("max", { clock: fakeClock().clock });
    expect(max.credits).toBe(8);
    expect(max.remaining().tokensIn).toBe(160_000);
    expect(max.remaining().tokensOut).toBe(10_000);
    expect(max.remaining().toolCalls).toBe(24);
    expect(max.remaining().revisions).toBe(3);
    expect(max.remaining().wallClockMs).toBe(900_000);
  });
});

describe("§5.2 soft-stop: a feature, never an error (latched first cap)", () => {
  it("tokens_in: spending the cap latches { kind, remaining, message } without throwing", () => {
    const tracker = createBudgetTracker("standard", { clock: fakeClock().clock });
    expect(() => tracker.trackTokens("gemini-3.8-flash", 80_000, 0)).not.toThrow();
    expect(() => tracker.shouldStop()).not.toThrow();
    expect(tracker.shouldStop()).toBe(true);
    const stop = tracker.stopReason();
    expect(stop?.kind).toBe("tokens_in");
    expect(stop?.remaining).toBe(0);
    expect(typeof stop?.message).toBe("string");
  });

  it("tokens_out: spending the cap latches its own kind", () => {
    const tracker = createBudgetTracker("standard", { clock: fakeClock().clock });
    tracker.trackTokens("gemini-3.8-flash", 0, 5_000);
    expect(tracker.stopReason()?.kind).toBe("tokens_out");
  });

  it("tool_calls: the cap latches on every tier without throwing", () => {
    for (const cap of CAPS) {
      const tracker = createBudgetTracker(cap.tier, { clock: fakeClock().clock });
      for (let i = 0; i < cap.toolCalls; i++) {
        tracker.trackToolCall();
      }
      expect(() => tracker.shouldStop()).not.toThrow();
      expect(tracker.shouldStop()).toBe(true);
      expect(tracker.stopReason()?.kind).toBe("tool_calls");
    }
  });

  it("revisions: the §5.2 repair-cycle cap latches its own kind", () => {
    const tracker = createBudgetTracker("standard", { clock: fakeClock().clock });
    tracker.trackRevision();
    tracker.trackRevision();
    expect(tracker.stopReason()?.kind).toBe("revisions");
  });

  it("wall_clock: the injected clock past the deadline latches the stop (deterministic)", () => {
    const { clock, set } = fakeClock(0);
    const tracker = createBudgetTracker("standard", { clock });
    expect(tracker.deadlineAt).toBe(300_000);
    set(299_999);
    expect(tracker.shouldStop()).toBe(false);
    set(300_000);
    expect(tracker.shouldStop()).toBe(true);
    expect(tracker.stopReason()?.kind).toBe("wall_clock");
  });

  it("latches the FIRST cap that fired; later caps never rewrite the story", () => {
    const tracker = createBudgetTracker("standard", { clock: fakeClock().clock });
    tracker.trackTokens("gemini-3.8-flash", 80_000, 0); // tokens_in fires first
    for (let i = 0; i < 12; i++) {
      tracker.trackToolCall(); // tool_calls also spent later
    }
    expect(tracker.stopReason()?.kind).toBe("tokens_in");
  });

  it("flaky provider telemetry (NaN/negative/∞) never throws and never trips a cap", () => {
    const tracker = createBudgetTracker("standard", { clock: fakeClock().clock });
    expect(() =>
      tracker.trackTokens("gemini-3.8-flash", Number.NaN, -5, Number.POSITIVE_INFINITY),
    ).not.toThrow();
    expect(() => tracker.trackTokens("", 10, 1)).not.toThrow(); // blank model → "unknown"
    expect(tracker.shouldStop()).toBe(false);
    const usage = tracker.report({ completed: true }).modelUsage;
    expect(usage["unknown"]?.tokensIn).toBe(10);
    expect(usage["gemini-3.8-flash"]?.calls).toBe(1);
  });

  it("image tiers: token usage never stops them; the single tool call does", () => {
    const tracker = createBudgetTracker("image_gen", { clock: fakeClock().clock });
    tracker.trackTokens("flux-2-schnell", 10_000_000, 1_000_000);
    expect(tracker.shouldStop()).toBe(false);
    tracker.trackToolCall();
    expect(tracker.stopReason()?.kind).toBe("tool_calls");
  });

  it("a revision tracked against a 0-revision tier reports `revisions` (defence)", () => {
    const tracker = createBudgetTracker("image_gen_hd", { clock: fakeClock().clock });
    tracker.trackRevision();
    expect(tracker.stopReason()?.kind).toBe("revisions");
  });
});

describe("phase model (the §5.2 partial-charge denominator)", () => {
  it("defaultPhaseTotal: image 1, quick 4 (critic skipped §5.3), standard/complex/premium 6, max 7", () => {
    expect(defaultPhaseTotal("image_gen")).toBe(1);
    expect(defaultPhaseTotal("image_gen_hd")).toBe(1);
    expect(defaultPhaseTotal("quick")).toBe(4);
    expect(defaultPhaseTotal("standard")).toBe(6);
    expect(defaultPhaseTotal("complex")).toBe(6);
    expect(defaultPhaseTotal("premium")).toBe(6);
    expect(defaultPhaseTotal("max")).toBe(7);
  });

  it("totalPhases overrides the default; nonsense fails fast at construction", () => {
    expect(createBudgetTracker("standard", { totalPhases: 3 }).phasesTotal).toBe(3);
    expect(() => createBudgetTracker("standard", { totalPhases: 0 })).toThrow();
    expect(() => createBudgetTracker("standard", { totalPhases: 2.5 })).toThrow();
  });

  it("trackPhaseCompleted never over-reports the total", () => {
    const tracker = createBudgetTracker("standard", {
      totalPhases: 2,
      clock: fakeClock().clock,
    });
    tracker.trackPhaseCompleted();
    tracker.trackPhaseCompleted();
    tracker.trackPhaseCompleted(); // clamped at 2
    const report = tracker.report({ completed: false });
    expect(report.phasesCompleted).toBe(2);
    expect(report.phasesTotal).toBe(2);
  });
});

describe("report(): the frozen §5.2 terminal report", () => {
  it("carries the per-model usage breakdown (in/out/cacheHits per §5.3)", () => {
    const tracker = createBudgetTracker("standard", { clock: fakeClock().clock });
    tracker.trackTokens("gemini-3.8-flash", 1_000, 200, 1);
    tracker.trackTokens("claude-sonnet-5.5", 2_000, 400);
    tracker.trackTokens("gemini-3.8-flash", 500, 100, 1);
    const report = tracker.report({ completed: true });
    expect(report.modelUsage["gemini-3.8-flash"]).toEqual({
      calls: 2,
      tokensIn: 1_500,
      tokensOut: 300,
      cacheHits: 2,
    });
    expect(report.modelUsage["claude-sonnet-5.5"]).toEqual({
      calls: 1,
      tokensIn: 2_000,
      tokensOut: 400,
      cacheHits: 0,
    });
    expect(report.cacheHitRate).toBe(2 / 3);
    expect(Object.isFrozen(report)).toBe(true);
  });

  it("completed=true settles as finished even when counters sit exactly at cap", () => {
    const tracker = createBudgetTracker("standard", { clock: fakeClock().clock });
    for (let i = 0; i < 12; i++) {
      tracker.trackToolCall();
    }
    const report = tracker.report({ completed: true });
    expect(report.completed).toBe(true);
    expect(report.stopped).toBe(false);
    expect(report.exceeded).toBeNull();
  });

  it("completed=false latches the §5.2 stop that cut the run short", () => {
    const tracker = createBudgetTracker("standard", { clock: fakeClock().clock });
    for (let i = 0; i < 4; i++) {
      tracker.trackPhaseCompleted();
    }
    tracker.trackTokens("gemini-3.8-flash", 80_000, 0);
    const report = tracker.report({ completed: false });
    expect(report.completed).toBe(false);
    expect(report.stopped).toBe(true);
    expect(report.exceeded?.kind).toBe("tokens_in");
    expect(report.phasesCompleted).toBe(4);
    expect(report.phasesTotal).toBe(6);
    expect(report.credits).toBe(2);
    expect(report.tier).toBe("standard");
  });
});
