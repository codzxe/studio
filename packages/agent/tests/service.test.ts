// W6-E — critic service: §5.3 tier skip, §23.3 blockers-only input mode, §23.3
// verdict/score-rule passthrough, §11.2 blocker/major repair feed, §5.1 cycle
// counter (injected factory, max 2), typed failure mapping for the tool seam.
import { MAX_REPAIR_CYCLES } from "@studio/config";
import type { ToolErr, ToolResult } from "@studio/tools";
import { describe, expect, it } from "vitest";
import { cycleGateForOutcome } from "../src/critic/cycle-gate.js";
import {
  CRITIC_TOOL_FAILURE_CODE,
  CRITIC_VALIDATOR_REPORT_CHARS,
  type CriticSeverity,
  type CriticToolArgs,
  type CriticToolLike,
  type CritiqueIssue,
  type CritiqueRequest,
  type CritiqueResult,
  type CritiqueScores,
  type RepairCycleCounter,
  RunCritic,
  blockersOnlyValidatorReport,
  createRepairCycleCounter,
  criticRouteEnabled,
  parseCritiqueSummary,
  repairPlanIssues,
} from "../src/critic/service.js";

// --- Fakes + fixtures ------------------------------------------------------------

type ToolBehavior = (args: CriticToolArgs, call: number) => Promise<ToolResult> | ToolResult;

/** The fake critic tool: records every run(args) call, plays a scripted behavior. */
class FakeCriticTool implements CriticToolLike {
  readonly calls: CriticToolArgs[] = [];

  constructor(private readonly behavior: ToolBehavior) {}

  async run(args: CriticToolArgs): Promise<ToolResult> {
    this.calls.push({ ...args });
    return this.behavior(args, this.calls.length - 1);
  }
}

function callAt(tool: FakeCriticTool, index: number): CriticToolArgs {
  const call = tool.calls.at(index);
  if (call === undefined) {
    throw new Error(`no tool call #${index} recorded`);
  }
  return call;
}

/** Unwraps a service AgentResult for hand-typed flow tests (failures rethrow). */
function unwrap(
  outcome: { ok: true; value: CritiqueResult } | { ok: false; code: string },
): CritiqueResult {
  if (!outcome.ok) {
    throw new Error(`critique failed: ${outcome.code}`);
  }
  return outcome.value;
}

const SCORES_CLEAN: CritiqueScores = {
  hierarchy: 4,
  balance: 4,
  contrast: 5,
  brief_adherence: 4,
  brand_fit: 4,
  editability: 5,
};

/** tools buildCritiqueSummary shape: {verdict, scores, issues, avg}. */
function critiqueSummary(
  verdict: "accept" | "revise",
  scores: CritiqueScores,
  issues: readonly CritiqueIssue[],
  avg = 4.5,
): string {
  return JSON.stringify({ verdict, scores, issues, avg });
}

function criticIssue(severity: CriticSeverity, code: string, layer = "Headline"): CritiqueIssue {
  return {
    severity,
    code,
    layer,
    observation: "What is wrong, concretely",
    fix: "The minimal concrete change",
  };
}

function okResult(summary: string, warnings?: readonly string[]): ToolResult {
  return warnings === undefined ? { ok: true, summary } : { ok: true, summary, warnings };
}

function errResult(code: ToolErr["code"], message: string, hint?: string): ToolErr {
  return hint === undefined ? { ok: false, code, message } : { ok: false, code, message, hint };
}

/** A validate_document summary row (§11.1: level/code/layer?/message/fix). */
function validatorRow(level: "blocker" | "major" | "minor", code: string, layer?: string) {
  return {
    level,
    code,
    ...(layer === undefined ? {} : { layer }),
    message: `validator says ${code}`,
    fix: `validator fix for ${code}`,
  };
}

const BASE_REQUEST: CritiqueRequest = {
  brief: "Coffee shop promo post, warm and cozy",
  previewUrl: "https://cdn.example.test/previews/run-42.png",
  layerSummary: "Headline (text); Subhead (text); Photo (image)",
  palette: ["#F4E7D3", "#3B2A20", "#D96C3B"],
  validatorReport: "",
  tier: "standard",
};

// --- §5.3 tier routing: quick SKIPS the critic ------------------------------------

describe("critic service: §5.3 tier routing (quick tier skips the critic)", () => {
  it("quick tier skips entirely — { skipped: true, reason: 'tier' }, zero tool calls", async () => {
    const tool = new FakeCriticTool(() => okResult(critiqueSummary("accept", SCORES_CLEAN, [])));
    const result = await new RunCritic({ tool }).critique({ ...BASE_REQUEST, tier: "quick" });
    expect(result).toEqual({ ok: true, value: { skipped: true, reason: "tier" } });
    expect(tool.calls.length).toBe(0); // §5.3 economy row: no critique, no model spend
  });

  it.each(["image_gen", "image_gen_hd"] as const)(
    "%s has no critic route (§5.3 routes image roles by role only) — skipped",
    async (tier) => {
      const tool = new FakeCriticTool(() => okResult(critiqueSummary("accept", SCORES_CLEAN, [])));
      const result = await new RunCritic({ tool }).critique({ ...BASE_REQUEST, tier });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.skipped).toBe(true);
      }
      expect(tool.calls.length).toBe(0);
    },
  );

  it.each(["standard", "complex", "premium", "max"] as const)(
    "%s routes a critic (§5.3 table) — the tool runs",
    async (tier) => {
      const tool = new FakeCriticTool(() => okResult(critiqueSummary("accept", SCORES_CLEAN, [])));
      const result = await new RunCritic({ tool }).critique({ ...BASE_REQUEST, tier });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.skipped).toBe(false);
      }
      expect(tool.calls.length).toBe(1);
    },
  );

  it("criticRouteEnabled mirrors the §5.3 table row for every tier", () => {
    expect(criticRouteEnabled("quick")).toBe(false); // economy row "— (skip for quick tier)"
    expect(criticRouteEnabled("standard")).toBe(true);
    expect(criticRouteEnabled("complex")).toBe(true);
    expect(criticRouteEnabled("premium")).toBe(true);
    expect(criticRouteEnabled("max")).toBe(true);
    expect(criticRouteEnabled("image_gen")).toBe(false);
    expect(criticRouteEnabled("image_gen_hd")).toBe(false);
  });
});

// --- §23.3 blockers-only input mode ------------------------------------------------

describe("critic service: §23.3 blockers-only input mode", () => {
  const MIXED_REPORT = JSON.stringify({
    ok: false,
    issueCounts: { blocker: 1, major: 2, minor: 1 },
    issues: [
      validatorRow("blocker", "contrast", "Subhead"),
      validatorRow("major", "safe_area", "Photo"),
      validatorRow("major", "headline_largest", "Headline"),
      validatorRow("minor", "naming", "Group 3"),
    ],
    truncated: false,
  });

  it("validator blockers present → the tool receives ONLY the blocker rows", async () => {
    const tool = new FakeCriticTool(() => okResult(critiqueSummary("accept", SCORES_CLEAN, [])));
    const result = await new RunCritic({ tool }).critique({
      ...BASE_REQUEST,
      validatorReport: MIXED_REPORT,
    });
    const sent = JSON.parse(callAt(tool, 0).validatorReport) as {
      ok: boolean;
      issueCounts: { blocker: number; major: number; minor: number };
      issues: { level: string; code: string; layer?: string }[];
      truncated: boolean;
    };
    expect(sent.ok).toBe(false);
    expect(sent.issueCounts).toEqual({ blocker: 1, major: 0, minor: 0 }); // §23.3 focus: blockers
    expect(sent.issues.length).toBe(1);
    expect(sent.issues[0]?.level).toBe("blocker");
    expect(sent.issues[0]?.code).toBe("contrast");
    expect(sent.truncated).toBe(false);
    const value = unwrap(result);
    if (!value.skipped) {
      expect(value.warnings).toContain(
        "Validator blockers present — the critique ran in blockers-only input mode (§23.3).",
      );
    }
  });

  it("no blockers (majors/minors only) → the report passes through UNCHANGED", () => {
    const report = JSON.stringify({
      ok: true,
      issueCounts: { blocker: 0, major: 2, minor: 3 },
      issues: [validatorRow("major", "safe_area"), validatorRow("minor", "naming")],
      truncated: false,
    });
    expect(blockersOnlyValidatorReport(report)).toBe(report);
  });

  it.each([
    ["empty report", ""],
    ["blank report", "   "],
    ["not JSON", "validator says everything is fine"],
    ["JSON but not an object", "42"],
  ])("%s → passed through untouched", (_label, report) => {
    expect(blockersOnlyValidatorReport(report)).toBe(report);
  });

  it("counts declare blockers the visible list lost → true count kept, list empty", () => {
    const rebuilt = blockersOnlyValidatorReport(
      JSON.stringify({
        ok: false,
        issueCounts: { blocker: 7, major: 2, minor: 0 },
        issues: [validatorRow("major", "safe_area")], // the visible list was shed to majors
        truncated: true,
      }),
    );
    const sent = JSON.parse(rebuilt) as {
      issueCounts: { blocker: number };
      issues: unknown[];
      truncated: boolean;
    };
    expect(sent.issueCounts.blocker).toBe(7); // counts stay exact (validator convention)
    expect(sent.issues).toEqual([]);
    expect(sent.truncated).toBe(true);
  });

  it("blocker rows without counts → the count is derived from the rows", () => {
    const rebuilt = blockersOnlyValidatorReport(
      JSON.stringify({
        issues: [validatorRow("blocker", "in_bounds"), validatorRow("major", "z_order")],
      }),
    );
    const sent = JSON.parse(rebuilt) as { issueCounts: { blocker: number }; issues: unknown[] };
    expect(sent.issueCounts.blocker).toBe(1);
    expect(sent.issues.length).toBe(1);
  });

  it("oversized blocker lists shed tail rows to fit the tool's 2000-char cap", () => {
    const longMessage = "m".repeat(240);
    const rows = Array.from({ length: 12 }, (_unused, index) => ({
      ...validatorRow("blocker", `rule_${index}`, `Layer ${index}`),
      message: longMessage,
      fix: longMessage,
    }));
    const rebuilt = blockersOnlyValidatorReport(
      JSON.stringify({
        ok: false,
        issueCounts: { blocker: 12, major: 0, minor: 0 },
        issues: rows,
        truncated: false,
      }),
    );
    expect(rebuilt.length).toBeLessThanOrEqual(CRITIC_VALIDATOR_REPORT_CHARS);
    const sent = JSON.parse(rebuilt) as {
      issueCounts: { blocker: number };
      issues: { code: string }[];
    };
    expect(sent.issueCounts.blocker).toBe(12); // the count survives the shed
    expect(sent.issues.length).toBeGreaterThan(0);
    expect(sent.issues.length).toBeLessThan(12); // tail rows were shed
    expect(sent.issues[0]?.code).toBe("rule_0"); // model order kept, head row survives
  });
});

// --- Verdict passthrough + §11.2 repair feed --------------------------------------

describe("critic service: accept path (verdict passthrough)", () => {
  it("accept → skipped:false, verdict/scores/issues verbatim; minors stay as suggestions", async () => {
    const minor = criticIssue("minor", "empty_layers", "Spacer");
    const tool = new FakeCriticTool(() =>
      okResult(critiqueSummary("accept", SCORES_CLEAN, [minor])),
    );
    const value = unwrap(await new RunCritic({ tool }).critique({ ...BASE_REQUEST }));
    if (value.skipped) {
      throw new Error("unreachable");
    }
    expect(value.verdict).toEqual({
      verdict: "accept",
      scores: SCORES_CLEAN,
      issues: [minor],
    });
    expect(value.repairIssues).toEqual([]); // §11.2: minors never feed repair
    expect(value.warnings).toEqual([]);
  });

  it("args bridge: request fields are forwarded verbatim; absent palette stays absent", async () => {
    const tool = new FakeCriticTool(() => okResult(critiqueSummary("accept", SCORES_CLEAN, [])));
    await new RunCritic({ tool }).critique({ ...BASE_REQUEST });
    expect(callAt(tool, 0)).toEqual({
      brief: BASE_REQUEST.brief,
      previewUrl: BASE_REQUEST.previewUrl,
      layerSummary: BASE_REQUEST.layerSummary,
      palette: BASE_REQUEST.palette,
      validatorReport: "",
    });
    await new RunCritic({ tool }).critique({ ...BASE_REQUEST, palette: undefined });
    expect("palette" in callAt(tool, 1)).toBe(false);
  });
});

describe("critic service: §23.3 score-forcing rules passthrough (enforced in the tool)", () => {
  it("score-forced revise (hierarchy ≤ 2) passes the enforced verdict + warning verbatim", async () => {
    const scores = { ...SCORES_CLEAN, hierarchy: 2 };
    const forcedWarning = "Scores ≤ 2 on hierarchy — verdict forced to revise (§23.3).";
    const tool = new FakeCriticTool(() =>
      okResult(critiqueSummary("revise", scores, [criticIssue("major", "weak_hierarchy")]), [
        forcedWarning,
      ]),
    );
    const value = unwrap(await new RunCritic({ tool }).critique({ ...BASE_REQUEST }));
    if (value.skipped) {
      throw new Error("unreachable");
    }
    expect(value.verdict.verdict).toBe("revise"); // the tool's enforcement, passed through
    expect(value.verdict.scores).toEqual(scores);
    expect(value.warnings).toEqual([forcedWarning]); // verbatim, not recomputed
  });

  it("avg-forced revise passes through unchanged", async () => {
    const scores = { ...SCORES_CLEAN, balance: 2, contrast: 2 }; // avg < 3.5 (§23.3)
    const tool = new FakeCriticTool(() =>
      okResult(critiqueSummary("revise", scores, []), [
        "Average score 3.17 < 3.5 — verdict forced to revise (§23.3).",
      ]),
    );
    const value = unwrap(await new RunCritic({ tool }).critique({ ...BASE_REQUEST }));
    if (value.skipped) {
      throw new Error("unreachable");
    }
    expect(value.verdict.verdict).toBe("revise");
    expect(value.repairIssues).toEqual([]); // score-forced revise can carry zero issue rows
  });

  it("the service never re-applies the rules: a substance-free revise stays a revise", async () => {
    // The real tool DOWNGRADES this to accept (§11.2); the service must not
    // second-guess a wired tool — enforcement lives in tools/vision-critique.ts.
    const tool = new FakeCriticTool(() =>
      okResult(critiqueSummary("revise", SCORES_CLEAN, [criticIssue("minor", "naming")]), []),
    );
    const value = unwrap(await new RunCritic({ tool }).critique({ ...BASE_REQUEST }));
    if (value.skipped) {
      throw new Error("unreachable");
    }
    expect(value.verdict.verdict).toBe("revise");
  });
});

describe("critic service: §11.2 repair-planner feed", () => {
  it("repairIssues keeps blocker/major only, in model order", async () => {
    const issues = [
      criticIssue("blocker", "contrast", "Subhead"),
      criticIssue("minor", "naming", "Group 3"),
      criticIssue("major", "safe_area", "Photo"),
    ];
    const tool = new FakeCriticTool(() =>
      okResult(critiqueSummary("revise", SCORES_CLEAN, issues)),
    );
    const value = unwrap(await new RunCritic({ tool }).critique({ ...BASE_REQUEST }));
    if (value.skipped) {
      throw new Error("unreachable");
    }
    expect(value.repairIssues.map((issue) => issue.code)).toEqual(["contrast", "safe_area"]);
  });

  it("repairPlanIssues filters blocker/major and caps at §23.3's five", () => {
    const issues = Array.from({ length: 7 }, (_unused, index) =>
      criticIssue(index % 2 === 0 ? "blocker" : "major", `issue_${index}`),
    );
    issues.push(criticIssue("minor", "never_repair"));
    const planned = repairPlanIssues({ verdict: "revise", scores: SCORES_CLEAN, issues });
    expect(planned.length).toBe(5); // §23.3 "Maximum 5 issues"
    expect(planned.map((issue) => issue.code)).toEqual([
      "issue_0",
      "issue_1",
      "issue_2",
      "issue_3",
      "issue_4",
    ]);
  });
});

// --- §5.1 cycle counter ------------------------------------------------------------

describe("critic service: §5.1 repair-cycle counter (injected factory, max 2)", () => {
  it("the config cap is 2 (§5.1 pin) and the default counter enforces it", () => {
    expect(MAX_REPAIR_CYCLES).toBe(2);
    const counter = createRepairCycleCounter();
    expect(counter.max).toBe(2);
    expect(counter.used()).toBe(0);
    expect(counter.canStart()).toBe(true);
    expect(counter.consume()).toBe(true);
    expect(counter.consume()).toBe(true);
    expect(counter.consume()).toBe(false); // §5.1: max 2 repair cycles
    expect(counter.used()).toBe(2);
    expect(counter.canStart()).toBe(false);
  });

  it("the factory is injected once per service and backs cycles()/noteRepairCycle()", async () => {
    let factoryCalls = 0;
    const factory = (): RepairCycleCounter => {
      factoryCalls += 1;
      return createRepairCycleCounter();
    };
    const tool = new FakeCriticTool(() => okResult(critiqueSummary("accept", SCORES_CLEAN, [])));
    const critic = new RunCritic({ tool, counterFactory: factory });
    expect(factoryCalls).toBe(1); // one counter per run, not per critique
    expect(critic.cycles()).toBe(0);
    expect(critic.remainingCycles()).toBe(2);
    expect(critic.noteRepairCycle()).toBe(true);
    expect(critic.cycles()).toBe(1);
    expect(critic.canRepair()).toBe(true);
    expect(critic.noteRepairCycle()).toBe(true);
    expect(critic.cycles()).toBe(2);
    expect(critic.remainingCycles()).toBe(0);
    expect(critic.canRepair()).toBe(false);
    expect(critic.noteRepairCycle()).toBe(false); // the cap refuses a third cycle
    await critic.critique({ ...BASE_REQUEST }); // critiques never touch the tally
    expect(critic.cycles()).toBe(2);
  });

  it("a worker-backed counter (e.g. persisted run state) plugs in via the factory", () => {
    let persisted = 1; // a resumed run that already repaired once
    const critic = new RunCritic({
      tool: new FakeCriticTool(() => okResult(critiqueSummary("accept", SCORES_CLEAN, []))),
      counterFactory: () => ({
        max: 2,
        used: () => persisted,
        canStart: () => persisted < 2,
        consume: () => {
          if (persisted >= 2) {
            return false;
          }
          persisted += 1;
          return true;
        },
      }),
    });
    expect(critic.cycles()).toBe(1);
    expect(critic.noteRepairCycle()).toBe(true);
    expect(critic.cycles()).toBe(2);
    expect(critic.noteRepairCycle()).toBe(false);
  });

  it("createRepairCycleCounter fails fast on wiring nonsense", () => {
    expect(() => createRepairCycleCounter(-1)).toThrow(/non-negative integer/);
    expect(() => createRepairCycleCounter(1.5)).toThrow(/non-negative integer/);
    expect(() => createRepairCycleCounter(Number.NaN)).toThrow(/non-negative integer/);
  });
});

// --- Tool-failure mapping (typed envelopes; no throws, no leaks) --------------------

describe("critic service: tool failures map to typed envelopes", () => {
  it.each([
    ["provider_unhealthy", "provider_unhealthy", true],
    ["engine_timeout", "run_timeout", true],
    ["validation_failed", CRITIC_TOOL_FAILURE_CODE, true],
    ["internal_error", CRITIC_TOOL_FAILURE_CODE, false],
    ["invalid_args", CRITIC_TOOL_FAILURE_CODE, false],
  ] as const)(
    "tool err %s → agent failure %s (retryable %s)",
    async (toolCode, agentCode, retryable) => {
      const tool = new FakeCriticTool(() =>
        errResult(toolCode, "the vision model call failed", "Retry the critique."),
      );
      const result = await new RunCritic({ tool }).critique({ ...BASE_REQUEST });
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("unreachable");
      }
      expect(result.code).toBe(agentCode);
      expect(result.retryable).toBe(retryable);
      expect(result.message).toContain("the vision model call failed"); // §6.1 message rides along
      expect(result.hint).toBe("Retry the critique.");
    },
  );

  it("a seam throw becomes a typed envelope and never leaks the thrown text", async () => {
    const tool = new FakeCriticTool(() => {
      throw new Error("secret /etc/passwd path from a mis-wired adapter");
    });
    const result = await new RunCritic({ tool }).critique({ ...BASE_REQUEST });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.code).toBe(CRITIC_TOOL_FAILURE_CODE);
    expect(result.retryable).toBe(false);
    expect(result.message).not.toContain("/etc/passwd"); // §6.1: no leaks
  });

  it("a seam AbortError maps to run_timeout (§3.4 deadline)", async () => {
    const tool = new FakeCriticTool(() => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    });
    const result = await new RunCritic({ tool }).critique({ ...BASE_REQUEST });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.code).toBe("run_timeout");
    expect(result.retryable).toBe(true);
  });
});

// --- Summary parsing tolerance (the tool's compaction ladder) -----------------------

describe("critic service: summary parsing (compaction-tolerant)", () => {
  it("L3-compacted rows ({severity, code, layer}) still parse", async () => {
    const tool = new FakeCriticTool(() =>
      okResult(
        JSON.stringify({
          verdict: "revise",
          scores: SCORES_CLEAN,
          issues: [{ severity: "blocker", code: "contrast", layer: "Subhead" }],
          avg: 4.33,
        }),
      ),
    );
    const value = unwrap(await new RunCritic({ tool }).critique({ ...BASE_REQUEST }));
    if (value.skipped) {
      throw new Error("unreachable");
    }
    expect(value.verdict.issues).toEqual([
      { severity: "blocker", code: "contrast", layer: "Subhead" },
    ]);
    expect(value.repairIssues.length).toBe(1);
  });

  it.each([
    ["issues omitted", { verdict: "accept", scores: SCORES_CLEAN, avg: 4.5 }],
    ["issues shed to [] (L4)", { verdict: "revise", scores: SCORES_CLEAN, issues: [], avg: 4.5 }],
  ])("%s parses to an empty issue list", async (_label, summaryObject) => {
    const tool = new FakeCriticTool(() => okResult(JSON.stringify(summaryObject)));
    const value = unwrap(await new RunCritic({ tool }).critique({ ...BASE_REQUEST }));
    if (value.skipped) {
      throw new Error("unreachable");
    }
    expect(value.verdict.issues).toEqual([]);
  });

  it.each([
    ["not JSON", "the design looks great, ship it"],
    ["JSON but wrong shape", '{"hello":"world"}'],
    ["verdict out of enum", { verdict: "ship_it", scores: SCORES_CLEAN, issues: [] }],
    [
      "score out of 1-5",
      { verdict: "accept", scores: { ...SCORES_CLEAN, contrast: 9 }, issues: [] },
    ],
    [
      "score not an int",
      { verdict: "accept", scores: { ...SCORES_CLEAN, balance: 3.5 }, issues: [] },
    ],
    ["missing scores", { verdict: "accept", issues: [] }],
    [
      "bad severity",
      { verdict: "accept", scores: SCORES_CLEAN, issues: [{ severity: "fatal", code: "x" }] },
    ],
    [
      "empty issue code",
      { verdict: "accept", scores: SCORES_CLEAN, issues: [{ severity: "minor", code: "" }] },
    ],
  ])("unreadable summary (%s) → typed failure, no raw echo", async (_label, badSummary) => {
    const tool = new FakeCriticTool(() =>
      okResult(typeof badSummary === "string" ? badSummary : JSON.stringify(badSummary)),
    );
    const result = await new RunCritic({ tool }).critique({ ...BASE_REQUEST });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.code).toBe(CRITIC_TOOL_FAILURE_CODE);
    expect(result.retryable).toBe(false);
    expect(result.message).not.toContain("hello"); // §6.1: raw model text never echoed
  });

  it("parseCritiqueSummary unit table", () => {
    expect(parseCritiqueSummary(critiqueSummary("accept", SCORES_CLEAN, []))?.verdict).toBe(
      "accept",
    );
    expect(
      parseCritiqueSummary(
        JSON.stringify({ verdict: "revise", scores: SCORES_CLEAN, issues: [], avg: 4, extra: 1 }),
      )?.verdict,
    ).toBe("revise"); // unknown keys are stripped
    expect(parseCritiqueSummary("")).toBeUndefined();
    expect(parseCritiqueSummary("{not json")).toBeUndefined();
    expect(
      parseCritiqueSummary(
        JSON.stringify({
          verdict: "accept",
          scores: SCORES_CLEAN,
          issues: Array.from({ length: 51 }, () => criticIssue("minor", "x")),
        }),
      ),
    ).toBeUndefined(); // > MAX_PARSED_SUMMARY_ISSUES
  });
});

// --- §5.1 flow pins (service + gate composition, the run-manager contract) ----------

describe("critic service + gate: §5.1 flow pins", () => {
  const reviseWithBlocker = [criticIssue("blocker", "contrast", "Subhead")];
  const acceptClean = () => okResult(critiqueSummary("accept", SCORES_CLEAN, []));

  it("accept path: critique → gate 'finalize', no cycle consumed", async () => {
    const critic = new RunCritic({ tool: new FakeCriticTool(acceptClean) });
    const outcome = await critic.critique({ ...BASE_REQUEST });
    expect(cycleGateForOutcome(unwrap(outcome), critic.cycles())).toEqual({
      decision: "finalize",
      remainingIssues: [],
    });
    expect(critic.cycles()).toBe(0);
  });

  it("revise → repair → accept: one §5.1 cycle consumed, run finalizes clean", async () => {
    const tool = new FakeCriticTool((_args, call) =>
      call === 0
        ? okResult(critiqueSummary("revise", SCORES_CLEAN, reviseWithBlocker))
        : acceptClean(),
    );
    const critic = new RunCritic({ tool });
    // Cycle 1: the critic wants a repair.
    let outcome = await critic.critique({ ...BASE_REQUEST });
    let gate = cycleGateForOutcome(unwrap(outcome), critic.cycles());
    expect(gate.decision).toBe("repair");
    expect(critic.noteRepairCycle()).toBe(true); // the run manager repairs…
    // Cycle 2: the repaired document passes.
    outcome = await critic.critique({ ...BASE_REQUEST });
    gate = cycleGateForOutcome(unwrap(outcome), critic.cycles());
    expect(gate.decision).toBe("finalize");
    expect(critic.cycles()).toBe(1);
  });

  it("2-cycle cap: a third revise finalizes WITH warnings + remaining issues (§5.1)", async () => {
    const tool = new FakeCriticTool(() =>
      okResult(critiqueSummary("revise", SCORES_CLEAN, reviseWithBlocker)),
    );
    const critic = new RunCritic({ tool });
    const decisions: string[] = [];
    for (let pass = 0; pass < 3; pass += 1) {
      const outcome = await critic.critique({ ...BASE_REQUEST });
      const gate = cycleGateForOutcome(unwrap(outcome), critic.cycles());
      if (gate.decision === "repair") {
        critic.noteRepairCycle(); // §5.1: consume exactly on a repair decision
      }
      decisions.push(gate.decision);
    }
    expect(decisions).toEqual(["repair", "repair", "finalize_with_warnings"]);
    expect(critic.cycles()).toBe(2); // §5.1: max 2 repair cycles
    expect(critic.noteRepairCycle()).toBe(false); // no third repair, ever
    // The capped gate surfaces the remaining blocker for manual fixes (§5.1) —
    // the run manager maps this to succeeded_with_warnings.
    const last = cycleGateForOutcome(
      unwrap(await critic.critique({ ...BASE_REQUEST })),
      critic.cycles(),
    );
    expect(last.decision).toBe("finalize_with_warnings");
    expect(last.remainingIssues.map((issue) => issue.code)).toEqual(["contrast"]);
    expect(last.remainingIssues[0]?.fix).toBe("The minimal concrete change"); // suggested manual fix
  });
});
