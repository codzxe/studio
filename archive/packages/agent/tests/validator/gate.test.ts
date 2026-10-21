// W6-D — §5.1 gate tests: the decision table (blockers repair / majors critique
// / minors proceed / clean proceed), repair-target filtering (§11.2), and the
// §23.3 critic input variants. Pure: reports are built directly, no tool.

import type { ValidationIssue } from "@studio/tools";
import { describe, expect, it } from "vitest";
import {
  BLOCKERS_GATE_RULE,
  CLEAN_PROCEED_RULE,
  GATE_RULES,
  MAJORS_CRITIQUE_RULE,
  MAX_REPAIR_TARGETS,
  MINORS_PROCEED_RULE,
  criticValidatorReport,
  renderRepairFixes,
  repairTargetsFor,
  validateGate,
} from "../../src/validator/gate.js";
import type { ValidatorReport } from "../../src/validator/service.js";

const DOC_ID = "d0a1b2c3-1111-4222-8333-444455556666";
const TEMPLATE_PIN = "instagram-post@3";

// ---------------------------------------------------------------------------
// Report fixtures
// ---------------------------------------------------------------------------

function issue(level: "blocker" | "major" | "minor", code: string, layer?: string): ValidationIssue {
  const base: ValidationIssue = { level, code, message: `${code} message`, fix: `${code} fix` };
  return layer === undefined ? base : { ...base, layer };
}

function issuesOf(count: number, level: "blocker" | "major" | "minor", prefix: string): ValidationIssue[] {
  return Array.from({ length: count }, (_, index) => issue(level, `${prefix}_${index}`, `Layer ${index}`));
}

interface ReportSpec {
  readonly blockers?: number;
  readonly majors?: number;
  readonly minors?: number;
  /** Overrides the per-level totals (truncation direction: counts > rows). */
  readonly countsOverride?: { readonly blocker: number; readonly major: number; readonly minor: number };
  readonly truncated?: boolean;
  readonly template?: string;
  readonly summary?: string;
  readonly stale?: boolean;
}

/** A ValidatorReport shaped exactly like the service would classify it. */
function makeReport(spec: ReportSpec = {}): ValidatorReport {
  const blockers = issuesOf(spec.blockers ?? 0, "blocker", "blocker_code");
  const majors = issuesOf(spec.majors ?? 0, "major", "major_code");
  const minors = issuesOf(spec.minors ?? 0, "minor", "minor_code");
  const counts = spec.countsOverride ?? {
    blocker: blockers.length,
    major: majors.length,
    minor: minors.length,
  };
  let verdict: ValidatorReport["verdict"] = "pass";
  if (counts.blocker > 0) verdict = "blockers";
  else if (counts.major + counts.minor > 0) verdict = "warnings";
  return {
    verdict,
    documentId: DOC_ID,
    revision: 7,
    expectedRevision: spec.stale === true ? 9 : 7,
    staleRevision: spec.stale === true,
    blockers,
    majors,
    minors,
    counts,
    warnings: [],
    truncated: spec.truncated === true,
    template: spec.template,
    summary:
      spec.summary ??
      `{"ok":${counts.blocker === 0},"issueCounts":${JSON.stringify(counts)},"issues":[],"truncated":false}`,
  };
}

// ---------------------------------------------------------------------------
// The decision table (§5.1) — first match wins
// ---------------------------------------------------------------------------

describe("gate: §5.1 decision table", () => {
  it.each([
    {
      blockers: 2,
      majors: 1,
      minors: 1,
      action: "repair",
      variant: "blockers",
      repairRecommended: true,
      warningsRecorded: true,
      ruleId: "blockers_gate",
      targets: 3,
    },
    {
      blockers: 0,
      majors: 2,
      minors: 1,
      action: "critique",
      variant: "full",
      repairRecommended: false,
      warningsRecorded: true,
      ruleId: "majors_critique",
      targets: 2,
    },
    {
      blockers: 0,
      majors: 0,
      minors: 3,
      action: "proceed",
      variant: null,
      repairRecommended: false,
      warningsRecorded: true,
      ruleId: "minors_proceed",
      targets: 0,
    },
    {
      blockers: 0,
      majors: 0,
      minors: 0,
      action: "proceed",
      variant: null,
      repairRecommended: false,
      warningsRecorded: false,
      ruleId: "clean_proceed",
      targets: 0,
    },
  ])("blockers=$blockers majors=$majors minors=$minors → $action ($ruleId)", (spec) => {
    const decision = validateGate(makeReport({ blockers: spec.blockers, majors: spec.majors, minors: spec.minors }));
    expect(decision.action).toBe(spec.action);
    expect(decision.criticReportVariant).toBe(spec.variant);
    expect(decision.repairRecommended).toBe(spec.repairRecommended);
    expect(decision.warningsRecorded).toBe(spec.warningsRecorded);
    expect(decision.ruleId).toBe(spec.ruleId);
    expect(decision.repairTargets.length).toBe(spec.targets);
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  it("keeps the table in §5.1 precedence order with an unconditional fallback last", () => {
    expect(GATE_RULES.map((rule) => rule.id)).toEqual([
      "blockers_gate",
      "majors_critique",
      "minors_proceed",
      "clean_proceed",
    ]);
    expect(CLEAN_PROCEED_RULE.when(makeReport({}))).toBe(true);
    expect(BLOCKERS_GATE_RULE.when(makeReport({ blockers: 1 }))).toBe(true);
    expect(MAJORS_CRITIQUE_RULE.when(makeReport({ majors: 1 }))).toBe(true);
    expect(MINORS_PROCEED_RULE.when(makeReport({ minors: 1 }))).toBe(true);
  });

  it("gates on the pre-cap counts, not the visible rows (§2.2 truncation)", () => {
    // Rows were shed by the reply cap, but the tool's counts survive.
    const report = makeReport({ countsOverride: { blocker: 1, major: 0, minor: 0 } });
    const decision = validateGate(report);
    expect(decision.action).toBe("repair");
    expect(decision.ruleId).toBe("blockers_gate");
    expect(decision.repairTargets).toEqual([]); // no actionable rows: re-render + re-validate (§11.3)
  });

  it("a stale revision does not change the gate decision (worker concern, §5.4)", () => {
    expect(validateGate(makeReport({ blockers: 1, stale: true })).action).toBe("repair");
    expect(validateGate(makeReport({ stale: true })).action).toBe("proceed");
  });

  it("reasons carry issue counts only, never document content (§22)", () => {
    const decision = validateGate(makeReport({ blockers: 1, majors: 2, minors: 3 }));
    expect(decision.reason).toContain("1 blocker");
    expect(decision.reason).not.toContain("blocker_code_0");
    expect(decision.reason).not.toContain("Layer 0");
  });
});

// ---------------------------------------------------------------------------
// Repair targets (§11.2: blocker/major only, max 5, blockers first)
// ---------------------------------------------------------------------------

describe("gate: repair-target filtering (§11.2/§23.3)", () => {
  it("targets blockers first, then majors; minors never qualify", () => {
    const report = makeReport({ blockers: 2, majors: 2, minors: 3 });
    expect(repairTargetsFor(report).map((target) => target.code)).toEqual([
      "blocker_code_0",
      "blocker_code_1",
      "major_code_0",
      "major_code_1",
    ]);
  });

  it("caps targets at 5, filling from blockers before majors", () => {
    const report = makeReport({ blockers: 3, majors: 4, minors: 1 });
    const targets = repairTargetsFor(report);
    expect(targets.length).toBe(MAX_REPAIR_TARGETS);
    expect(targets.map((target) => target.level)).toEqual([
      "blocker",
      "blocker",
      "blocker",
      "major",
      "major",
    ]);
  });

  it("a minors-only report yields no repair targets (§11.1)", () => {
    expect(repairTargetsFor(makeReport({ minors: 2 }))).toEqual([]);
  });

  it("the decision's targets match repairTargetsFor for every table row", () => {
    for (const spec of [
      { blockers: 1, majors: 1, minors: 1 },
      { blockers: 0, majors: 2, minors: 0 },
      { blockers: 0, majors: 0, minors: 4 },
      {},
    ]) {
      const report = makeReport(spec);
      expect(validateGate(report).repairTargets).toEqual(repairTargetsFor(report));
    }
  });
});

// ---------------------------------------------------------------------------
// Critic input variants (§23.3) + repair FIXES (§23.4)
// ---------------------------------------------------------------------------

interface CriticSummary {
  ok: boolean;
  issueCounts: { blocker: number; major: number; minor: number };
  template?: string;
  issues: { level: string; code: string; layer?: string; message: string; fix: string }[];
  truncated: boolean;
}

describe("gate: critic report variants (§23.3)", () => {
  it('"full" passes the tool summary through verbatim (§6.1)', () => {
    const report = makeReport({ blockers: 1, majors: 1, summary: "RAW-TOOL-SUMMARY" });
    expect(criticValidatorReport(report, "full")).toBe("RAW-TOOL-SUMMARY");
  });

  it('"blockers" narrows the critic input to blocker rows, keeping the full counts', () => {
    const report = makeReport({
      blockers: 2,
      majors: 1,
      minors: 1,
      template: TEMPLATE_PIN,
      truncated: true,
    });
    const parsed = JSON.parse(criticValidatorReport(report, "blockers")) as CriticSummary;
    expect(parsed.ok).toBe(false); // blockers present
    expect(parsed.issueCounts).toEqual({ blocker: 2, major: 1, minor: 1 }); // full picture kept
    expect(parsed.template).toBe(TEMPLATE_PIN);
    expect(parsed.truncated).toBe(true);
    expect(parsed.issues.map((row) => row.level)).toEqual(["blocker", "blocker"]);
    // renderSummary row key order preserved: level, code, layer, message, fix.
    expect(Object.keys(parsed.issues[0] ?? {})).toEqual(["level", "code", "layer", "message", "fix"]);
  });

  it("omits the layer key when a blocker row has no layer (renderSummary parity)", () => {
    const report: ValidatorReport = {
      ...makeReport({ blockers: 1 }),
      blockers: [issue("blocker", "in_bounds")],
    };
    const parsed = JSON.parse(criticValidatorReport(report, "blockers")) as CriticSummary;
    expect(Object.keys(parsed.issues[0] ?? {})).toEqual(["level", "code", "message", "fix"]);
  });

  it("renders an empty blockers variant gracefully when there is nothing to focus on", () => {
    const parsed = JSON.parse(criticValidatorReport(makeReport({}), "blockers")) as CriticSummary;
    expect(parsed.ok).toBe(true);
    expect(parsed.issues).toEqual([]);
  });
});

describe("gate: §23.4 repair FIXES rendering", () => {
  it("renders one row per target: {level, code, layer?, fix, message}", () => {
    const parsed = JSON.parse(
      renderRepairFixes([issue("blocker", "in_bounds", "Photo"), issue("major", "headline_largest")]),
    ) as Record<string, string>[];
    expect(parsed.length).toBe(2);
    expect(parsed[0]).toEqual({
      level: "blocker",
      code: "in_bounds",
      layer: "Photo",
      fix: "in_bounds fix",
      message: "in_bounds message",
    });
    expect(parsed[1]).toEqual({
      level: "major",
      code: "headline_largest",
      fix: "headline_largest fix",
      message: "headline_largest message",
    });
  });

  it("the worker feeds decision.repairTargets straight into the §23.4 FIXES", () => {
    const decision = validateGate(makeReport({ blockers: 1, majors: 1 }));
    const fixes = JSON.parse(renderRepairFixes(decision.repairTargets)) as Record<string, string>[];
    expect(fixes.map((row) => row.code)).toEqual(["blocker_code_0", "major_code_0"]);
  });
});
