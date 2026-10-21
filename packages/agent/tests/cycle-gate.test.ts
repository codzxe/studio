// W6-E — §5.1 cycle gate: accept → finalize; revise + cycles<2 → repair;
// revise + cycles≥2 → finalize_with_warnings (→ run status succeeded_with_warnings)
// with the remaining issues surfaced for manual fixes; skipped → clean finalize.
import { MAX_REPAIR_CYCLES } from "@studio/config";
import { describe, expect, it } from "vitest";
import {
  type CycleGateDecision,
  cycleGate,
  cycleGateForOutcome,
} from "../src/critic/cycle-gate.js";
import type {
  CritiqueIssue,
  CritiqueResult,
  CritiqueScores,
  CritiqueVerdict,
} from "../src/critic/service.js";

const SCORES: CritiqueScores = {
  hierarchy: 4,
  balance: 4,
  contrast: 4,
  brief_adherence: 4,
  brand_fit: 5,
  editability: 5,
};

function issue(severity: "blocker" | "major" | "minor", code: string): CritiqueIssue {
  return {
    severity,
    code,
    layer: "Headline",
    observation: "What is wrong, concretely",
    fix: "The minimal concrete change",
  };
}

function critique(verdict: "accept" | "revise", issues: readonly CritiqueIssue[]): CritiqueVerdict {
  return { verdict, scores: SCORES, issues };
}

describe("cycle gate: §5.1 truth table (task pin)", () => {
  it("accept → 'finalize' at every cycle count (an accept never repairs)", () => {
    for (const cycles of [0, 1, 2, 7]) {
      expect(cycleGate(critique("accept", [issue("minor", "naming")]), cycles)).toEqual({
        decision: "finalize",
        remainingIssues: [issue("minor", "naming")],
      });
    }
  });

  it("revise & cycles < 2 → 'repair' with an empty remaining payload", () => {
    for (const cycles of [0, 1]) {
      const gate = cycleGate(critique("revise", [issue("blocker", "contrast")]), cycles);
      expect(gate.decision).toBe("repair");
      expect(gate.remainingIssues).toEqual([]); // being fixed — nothing remains yet
    }
  });

  it("revise & cycles == 2 → 'finalize_with_warnings' (§5.1 cap)", () => {
    const gate = cycleGate(critique("revise", [issue("blocker", "contrast")]), MAX_REPAIR_CYCLES);
    expect(gate.decision).toBe("finalize_with_warnings");
    expect(gate.remainingIssues.map((row) => row.code)).toEqual(["contrast"]);
  });

  it("revise & cycles overshoots the cap → still 'finalize_with_warnings', never a 3rd repair", () => {
    const gate = cycleGate(critique("revise", [issue("major", "safe_area")]), 3);
    expect(gate.decision).toBe("finalize_with_warnings");
  });
});

describe("cycle gate: §5.1 remainingIssues payload (surface to the user)", () => {
  it("finalize_with_warnings carries every remaining issue with its suggested manual fix", () => {
    const remaining = [
      issue("blocker", "contrast"),
      issue("major", "safe_area"),
      issue("minor", "naming"),
    ];
    const gate = cycleGate(critique("revise", remaining), 2);
    expect(gate.decision).toBe("finalize_with_warnings");
    expect(gate.remainingIssues).toEqual(remaining); // §5.1: surface for manual fixes
    expect(gate.remainingIssues[0]?.fix).toBe("The minimal concrete change");
  });

  it("accept surfaces its leftover issues as §11.2 suggestions (minors by tool invariant)", () => {
    const minors = [issue("minor", "empty_layers"), issue("minor", "naming")];
    const gate = cycleGate(critique("accept", minors), 0);
    expect(gate.decision).toBe("finalize"); // not succeeded_with_warnings
    expect(gate.remainingIssues).toEqual(minors); // shown to the user as suggestions
  });

  it("the payload is a copy — mutating it never touches the critique", () => {
    const critiqueInput = critique("revise", [issue("blocker", "contrast")]);
    const gate = cycleGate(critiqueInput, 2);
    expect(gate.remainingIssues).not.toBe(critiqueInput.issues); // a new array
    expect(critiqueInput.issues.length).toBe(1); // input untouched
  });

  it("the gate is pure: identical inputs → identical decisions", () => {
    const a: CycleGateDecision = cycleGate(critique("revise", [issue("major", "z_order")]), 1);
    const b: CycleGateDecision = cycleGate(critique("revise", [issue("major", "z_order")]), 1);
    expect(a).toEqual(b);
  });
});

describe("cycle gate: total gate over the service result (cycleGateForOutcome)", () => {
  it("skipped critique (§5.3 quick tier) → clean 'finalize', no warnings payload", () => {
    const skipped: CritiqueResult = { skipped: true, reason: "tier" };
    for (const cycles of [0, 1, 2]) {
      expect(cycleGateForOutcome(skipped, cycles)).toEqual({
        decision: "finalize",
        remainingIssues: [],
      });
    }
  });

  it("non-skipped outcomes delegate to cycleGate verbatim", () => {
    const outcome: CritiqueResult = {
      skipped: false,
      verdict: critique("revise", [issue("blocker", "contrast")]),
      warnings: [],
      repairIssues: [issue("blocker", "contrast")],
    };
    expect(cycleGateForOutcome(outcome, 1).decision).toBe("repair");
    expect(cycleGateForOutcome(outcome, 2).decision).toBe("finalize_with_warnings");
    const accepted: CritiqueResult = {
      skipped: false,
      verdict: critique("accept", []),
      warnings: [],
      repairIssues: [],
    };
    expect(cycleGateForOutcome(accepted, 0).decision).toBe("finalize");
  });

  it("the §5.1 pin: the cap is 2 (from @studio/config, MAX_REPAIR_CYCLES)", () => {
    expect(MAX_REPAIR_CYCLES).toBe(2);
    // cycles 0 and 1 repair; cycle 2 is the capped, warning-carrying finalize.
    const verdict = critique("revise", [issue("blocker", "in_bounds")]);
    expect(cycleGate(verdict, 0).decision).toBe("repair");
    expect(cycleGate(verdict, 1).decision).toBe("repair");
    expect(cycleGate(verdict, 2).decision).toBe("finalize_with_warnings");
  });
});
