// W6-G — §5.2 clean-stop settlement: the full/partial/refund table, the exact
// partial-charge formula (ceil(credits × completed/total) clamped [1, credits]),
// money-path guards, and the factory→settlement flow the run manager drives.
import { resolveTierConfig, type RunTierId } from "@studio/config";
import { describe, expect, it } from "vitest";
import { type Clock } from "../src/budgets.js";
import type { BudgetReport } from "../src/budgets-service/tracker-factory.js";
import { createBudgetTracker } from "../src/budgets-service/tracker-factory.js";
import {
  computeSettlement,
  partialChargeCredits,
  type SettlementOutcome,
  type SettlementPolicy,
} from "../src/budgets-service/settlement.js";

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

type ReportOverrides = Partial<
  Pick<BudgetReport, "completed" | "stopped" | "exceeded" | "phasesCompleted" | "phasesTotal">
>;

/** A minimal valid §5.2 report; credits derive from the tier (single source). */
function makeReport(tier: RunTierId, overrides: ReportOverrides = {}): BudgetReport {
  return {
    used: { tokensIn: 0, tokensOut: 0, cacheHits: 0, toolCalls: 0, revisions: 0, wallClockMs: 0 },
    remaining: { tokensIn: null, tokensOut: null, toolCalls: 0, revisions: 0, wallClockMs: 0 },
    modelUsage: {},
    cacheHitRate: null,
    exceeded: null,
    tier,
    credits: resolveTierConfig(tier).credits,
    completed: false,
    stopped: false,
    phasesCompleted: 0,
    phasesTotal: 1,
    ...overrides,
  };
}

/** A realistic §5.2 tool-call stop (W1-P's exact message shape). */
const TOOL_CALL_STOP = {
  kind: "tool_calls",
  remaining: 0,
  message:
    "tool calls budget reached (12 of 12 tool calls); the run stops cleanly and keeps committed work (§5.2).",
} as const;

interface TableRow {
  readonly name: string;
  readonly tier: RunTierId;
  readonly report: ReportOverrides;
  readonly outcome: SettlementOutcome;
  readonly expected: { readonly policy: SettlementPolicy; readonly charge: number; readonly release: number };
}

const SETTLEMENT_TABLE: readonly TableRow[] = [
  {
    name: "completed within budget → full charge (§14.2 rule 2)",
    tier: "standard",
    report: { completed: true, stopped: false, phasesCompleted: 6, phasesTotal: 6 },
    outcome: { validatorPassed: true, documentImproved: true },
    expected: { policy: "full_charge", charge: 2, release: 0 },
  },
  {
    name: "budget-stopped 3/6, improved + validator passed → PARTIAL ceil(2×3/6)=1",
    tier: "standard",
    report: {
      completed: false,
      stopped: true,
      exceeded: TOOL_CALL_STOP,
      phasesCompleted: 3,
      phasesTotal: 6,
    },
    outcome: { validatorPassed: true, documentImproved: true },
    expected: { policy: "partial", charge: 1, release: 1 },
  },
  {
    name: "budget-stopped 4/6 → ceil(2×4/6)=2 (the tier price ceiling)",
    tier: "standard",
    report: {
      completed: false,
      stopped: true,
      exceeded: TOOL_CALL_STOP,
      phasesCompleted: 4,
      phasesTotal: 6,
    },
    outcome: { validatorPassed: true, documentImproved: true },
    expected: { policy: "partial", charge: 2, release: 0 },
  },
  {
    name: "premium stopped 3/6 → ceil(4×3/6)=2 of 4",
    tier: "premium",
    report: {
      completed: false,
      stopped: true,
      exceeded: TOOL_CALL_STOP,
      phasesCompleted: 3,
      phasesTotal: 6,
    },
    outcome: { validatorPassed: true, documentImproved: true },
    expected: { policy: "partial", charge: 2, release: 2 },
  },
  {
    name: "max stopped 1/7 → ceil(8×1/7)=2 of 8",
    tier: "max",
    report: {
      completed: false,
      stopped: true,
      exceeded: TOOL_CALL_STOP,
      phasesCompleted: 1,
      phasesTotal: 7,
    },
    outcome: { validatorPassed: true, documentImproved: true },
    expected: { policy: "partial", charge: 2, release: 6 },
  },
  {
    name: "quick stopped 0/4 → clamped to the 1-credit floor",
    tier: "quick",
    report: {
      completed: false,
      stopped: true,
      exceeded: TOOL_CALL_STOP,
      phasesCompleted: 0,
      phasesTotal: 4,
    },
    outcome: { validatorPassed: true, documentImproved: true },
    expected: { policy: "partial", charge: 1, release: 0 },
  },
  {
    name: "image_gen_hd stopped 0/1 → floor 1 of 2",
    tier: "image_gen_hd",
    report: {
      completed: false,
      stopped: true,
      exceeded: TOOL_CALL_STOP,
      phasesCompleted: 0,
      phasesTotal: 1,
    },
    outcome: { validatorPassed: true, documentImproved: true },
    expected: { policy: "partial", charge: 1, release: 1 },
  },
  {
    name: "budget-stopped, no improvement → refund all (nothing committed)",
    tier: "complex",
    report: {
      completed: false,
      stopped: true,
      exceeded: TOOL_CALL_STOP,
      phasesCompleted: 4,
      phasesTotal: 6,
    },
    outcome: { validatorPassed: true, documentImproved: false },
    expected: { policy: "refund_all", charge: 0, release: 5 },
  },
  {
    name: "validation failed while budget-stopped → refund all even if improved",
    tier: "max",
    report: {
      completed: false,
      stopped: true,
      exceeded: TOOL_CALL_STOP,
      phasesCompleted: 2,
      phasesTotal: 7,
    },
    outcome: { validatorPassed: false, documentImproved: true },
    expected: { policy: "refund_all", charge: 0, release: 8 },
  },
  {
    name: "validation failed on a completed run → refund all (§5.1 rollback)",
    tier: "standard",
    report: { completed: true, stopped: false, phasesCompleted: 6, phasesTotal: 6 },
    outcome: { validatorPassed: false, documentImproved: true },
    expected: { policy: "refund_all", charge: 0, release: 2 },
  },
];

describe("computeSettlement: the §5.2 clean-stop table", () => {
  for (const row of SETTLEMENT_TABLE) {
    it(row.name, () => {
      const settlement = computeSettlement(makeReport(row.tier, row.report), row.tier, row.outcome);
      expect(settlement.policy).toBe(row.expected.policy);
      expect(settlement.chargeCredits).toBe(row.expected.charge);
      expect(settlement.releaseCredits).toBe(row.expected.release);
      expect(settlement.reservedCredits).toBe(resolveTierConfig(row.tier).credits);
      // Ledger invariant: every reservation resolves fully, in whole credits.
      expect(settlement.chargeCredits + settlement.releaseCredits).toBe(settlement.reservedCredits);
      expect(settlement.tier).toBe(row.tier);
      expect(settlement.completed).toBe(row.report.completed ?? false);
      expect(settlement.stopped).toBe(row.report.stopped ?? false);
      expect(settlement.validatorPassed).toBe(row.outcome.validatorPassed);
      expect(settlement.documentImproved).toBe(row.outcome.documentImproved);
      expect(settlement.partialChargeCredits).toBe(
        row.expected.policy === "partial" ? row.expected.charge : null,
      );
      expect(settlement.note.length).toBeGreaterThan(0);
    });
  }

  it("the partial note tells the user what was cut (§5.2)", () => {
    const settlement = computeSettlement(
      makeReport("standard", {
        stopped: true,
        exceeded: TOOL_CALL_STOP,
        phasesCompleted: 3,
        phasesTotal: 6,
      }),
      "standard",
      { validatorPassed: true, documentImproved: true },
    );
    expect(settlement.note).toContain("tool calls budget reached");
    expect(settlement.note).toContain("1 of 2 reserved credits");
    expect(settlement.note).toContain("3 of 6 phases");
  });

  it("a partial charge never exceeds the tier price nor drops below 1 credit", () => {
    for (const row of SETTLEMENT_TABLE) {
      if (row.expected.policy !== "partial") {
        continue;
      }
      const settlement = computeSettlement(
        makeReport(row.tier, row.report),
        row.tier,
        row.outcome,
      );
      expect(settlement.chargeCredits).toBeGreaterThanOrEqual(1);
      expect(settlement.chargeCredits).toBeLessThanOrEqual(settlement.reservedCredits);
    }
  });
});

describe("partialChargeCredits: the exact §5.2 formula", () => {
  const FORMULA: readonly {
    readonly credits: number;
    readonly completed: number;
    readonly total: number;
    readonly expected: number;
  }[] = [
    { credits: 8, completed: 0, total: 7, expected: 1 }, // floor: committed work owes ≥ 1
    { credits: 8, completed: 1, total: 7, expected: 2 }, // ceil(8/7)
    { credits: 8, completed: 3, total: 7, expected: 4 }, // ceil(24/7)
    { credits: 8, completed: 6, total: 7, expected: 7 }, // ceil(48/7)
    { credits: 8, completed: 7, total: 7, expected: 8 }, // ceiling: the tier price
    { credits: 2, completed: 1, total: 6, expected: 1 }, // ceil(1/3)
    { credits: 2, completed: 3, total: 6, expected: 1 }, // ceil(1)
    { credits: 2, completed: 4, total: 6, expected: 2 }, // ceil(4/3)
    { credits: 1, completed: 0, total: 4, expected: 1 }, // quick: any commit = full price
    { credits: 5, completed: 9, total: 6, expected: 5 }, // over-reported phases clamp
  ];

  for (const row of FORMULA) {
    it(`ceil(${row.credits}×${row.completed}/${row.total}) → ${row.expected}`, () => {
      expect(partialChargeCredits(row.credits, row.completed, row.total)).toBe(row.expected);
    });
  }

  it("rejects nonsense inputs (fail fast on a money path)", () => {
    expect(() => partialChargeCredits(0, 1, 6)).toThrow();
    expect(() => partialChargeCredits(1.5, 1, 6)).toThrow();
    expect(() => partialChargeCredits(2, -1, 6)).toThrow();
    expect(() => partialChargeCredits(2, 1, 0)).toThrow();
    expect(() => partialChargeCredits(Number.NaN, 1, 6)).toThrow();
  });
});

describe("end-to-end: factory report → settlement (the run manager's flow)", () => {
  it("standard run budget-stopped on tool calls after 3 phases, work committed → partial 1 of 2", () => {
    const tracker = createBudgetTracker("standard", { clock: fakeClock().clock });
    tracker.trackTokens("gemini-3.8-flash", 30_000, 1_200, 20);
    for (let i = 0; i < 3; i++) {
      tracker.trackPhaseCompleted();
    }
    expect(tracker.shouldStop()).toBe(false);
    for (let i = 0; i < 12; i++) {
      tracker.trackToolCall();
    }
    expect(tracker.shouldStop()).toBe(true);
    const settlement = computeSettlement(tracker.report({ completed: false }), "standard", {
      validatorPassed: true,
      documentImproved: true,
    });
    expect(settlement.policy).toBe("partial");
    expect(settlement.chargeCredits).toBe(1);
    expect(settlement.releaseCredits).toBe(1);
  });

  it("a run that finished exactly at cap settles at the full tier price", () => {
    const tracker = createBudgetTracker("max", { clock: fakeClock().clock });
    tracker.trackTokens("claude-opus-5.5", 160_000, 10_000);
    const settlement = computeSettlement(tracker.report({ completed: true }), "max", {
      validatorPassed: true,
      documentImproved: true,
    });
    expect(settlement.policy).toBe("full_charge");
    expect(settlement.chargeCredits).toBe(8);
    expect(settlement.releaseCredits).toBe(0);
  });

  it("a budget stop that improved nothing refunds the whole reservation", () => {
    const tracker = createBudgetTracker("image_gen", { clock: fakeClock().clock });
    tracker.trackToolCall();
    const settlement = computeSettlement(tracker.report({ completed: false }), "image_gen", {
      validatorPassed: true,
      documentImproved: false,
    });
    expect(settlement.policy).toBe("refund_all");
    expect(settlement.chargeCredits).toBe(0);
    expect(settlement.releaseCredits).toBe(1);
  });
});

describe("computeSettlement: money-path guards (fail fast)", () => {
  it("rejects a report priced for a different tier", () => {
    expect(() =>
      computeSettlement(makeReport("standard"), "complex", {
        validatorPassed: true,
        documentImproved: true,
      }),
    ).toThrow(/mismatch/);
  });

  it("rejects drifted reports (zod boundary: extra keys, bad credits, bad phases)", () => {
    const extraKey = { ...makeReport("standard", { completed: true }), surprise: 1 };
    expect(() =>
      computeSettlement(extraKey as unknown as BudgetReport, "standard", {
        validatorPassed: true,
        documentImproved: true,
      }),
    ).toThrow();
    const badCredits = makeReport("standard", { completed: true, credits: 99 });
    expect(() =>
      computeSettlement(badCredits, "standard", { validatorPassed: true, documentImproved: true }),
    ).toThrow(/drift/);
    const badPhases = makeReport("standard", { completed: true, phasesTotal: 0 });
    expect(() =>
      computeSettlement(badPhases, "standard", { validatorPassed: true, documentImproved: true }),
    ).toThrow();
  });

  it("refuses completed+stopped contradictions", () => {
    expect(() =>
      computeSettlement(makeReport("standard", { completed: true, stopped: true }), "standard", {
        validatorPassed: true,
        documentImproved: true,
      }),
    ).toThrow(/cannot be both/);
  });

  it("refuses non-budget terminals — that is @studio/billing classifyRefund's path (§14.2)", () => {
    expect(() =>
      computeSettlement(makeReport("standard"), "standard", {
        validatorPassed: true,
        documentImproved: true,
      }),
    ).toThrow(/classifyRefund/);
  });
});
