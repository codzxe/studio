// @studio/agent — the §5.1 validation gate: what the loop does AFTER the
// deterministic validator runs. Owner: W6-D (docs/AGENTS.md).
//
// Spec anchors:
//   §5.1   validating → critiquing | repairing | finalizing. This module owns
//          that CHOICE as a decision table — data, not vibes:
//            blockers > 0            → repair; the critic is skipped or, if it
//                                      runs at all, gets the blockers-only
//                                      report (§23.3 "focus only on blockers");
//            blockers = 0, majors > 0 → the critic runs on the full report;
//                                      repair stays OPTIONAL (critic decides);
//            only minors              → proceed; warnings recorded for the
//                                      user (§11.1 suggestions never revise);
//            nothing                  → proceed clean.
//   §5.1   "Validate before critique" is enforced structurally: validateGate
//          consumes a ValidatorReport (service.ts is the only producer), so
//          the critic's report variant can only be derived AFTER validation.
//   §23.3  Critic input variants: "full" (verbatim §6.1 summary) vs
//          "blockers" (same shape, blocker rows only).
//   §11.2  Only blocker/major issues may appear in the repair plan (max 5).
//   §23.4  The repair prompt's FIXES array = repairTargets rendered as JSON
//          (renderRepairFixes).
//   §11.3  Whether the critic runs DESPITE blockers (blocker-focused) or is
//          skipped entirely ("skip the critic if the cycle only fixed
//          validator blockers") needs run history (aesthetics already
//          passed?) — that stays with the run manager; this pure gate just
//          hands it the blockers-only variant for the case it runs.
//   §22    `reason` carries issue COUNTS only — never document content.

import type { ValidationIssue } from "@studio/tools";
import type { ValidatorReport } from "./service.js";

// ---------------------------------------------------------------------------
// Decision types
// ---------------------------------------------------------------------------

/** The §5.1 next step after `validating`: critique, repair, or proceed. */
export type GateAction = "proceed" | "critique" | "repair";

/**
 * Which validator-report variant the critic receives (§23.3):
 *   - "full": the tool's verbatim §6.1 summary;
 *   - "blockers": same shape, blocker rows only ("focus only on blockers").
 */
export type CriticReportVariant = "full" | "blockers";

/** The pure gate verdict over one ValidatorReport. */
export interface GateDecision {
  /** The §5.1 routing: proceed | critique | repair. */
  readonly action: GateAction;
  /** Which report the critic gets if it runs; null = the critic does not run. */
  readonly criticReportVariant: CriticReportVariant | null;
  /**
   * §11.2/§23.4 repair-plan rows: blockers first, then majors, capped at 5.
   * Populated even when `action` is "critique" — the worker merges these with
   * the critic's blocker/major issues before deciding the repair (§11.2).
   */
  readonly repairTargets: readonly ValidationIssue[];
  /** True only when blockers gate the pipeline; majors leave repair optional. */
  readonly repairRecommended: boolean;
  /** §11.1: issues were recorded to surface to the user as suggestions/warnings. */
  readonly warningsRecorded: boolean;
  /** Which table row fired — ids are stable for the run timeline / audit. */
  readonly ruleId: string;
  /** Counts-only sentence for the run timeline (§22: never content). */
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// The decision table (§21: table-as-data, first match wins)
// ---------------------------------------------------------------------------

/** One row of the §5.1 gate table. Order matters: blockers outrank majors. */
export interface GateRule {
  readonly id: string;
  readonly when: (report: ValidatorReport) => boolean;
  readonly action: GateAction;
  readonly criticReportVariant: CriticReportVariant | null;
  readonly repairRecommended: boolean;
  readonly warningsRecorded: boolean;
  readonly reason: (report: ValidatorReport) => string;
}

/** Row 1 — §5.1: a validation blocker gates the pipeline into repair. */
export const BLOCKERS_GATE_RULE: GateRule = {
  id: "blockers_gate",
  when: (report) => report.counts.blocker > 0,
  action: "repair",
  // If the critic runs in a blocker cycle at all, §23.3 narrows it to blockers.
  criticReportVariant: "blockers",
  repairRecommended: true,
  warningsRecorded: true,
  reason: (report) =>
    `validation blockers gate the pipeline: ${report.counts.blocker} blocker(s) — repair before critique (§5.1/§23.3)`,
};

/** Row 2 — no blockers, majors exist: the critic runs; repair stays optional. */
export const MAJORS_CRITIQUE_RULE: GateRule = {
  id: "majors_critique",
  when: (report) => report.counts.major > 0,
  action: "critique",
  criticReportVariant: "full",
  repairRecommended: false,
  warningsRecorded: true,
  reason: (report) =>
    `no blockers; ${report.counts.major} major(s) go to the critic; repair is optional (§5.1/§11.2)`,
};

/** Row 3 — only minors: never a revision on their own (§11.1); proceed. */
export const MINORS_PROCEED_RULE: GateRule = {
  id: "minors_proceed",
  when: (report) => report.counts.minor > 0,
  action: "proceed",
  criticReportVariant: null,
  repairRecommended: false,
  warningsRecorded: true,
  reason: (report) =>
    `only minors: ${report.counts.minor} suggestion(s) recorded for the user; minors never trigger a revision (§11.1)`,
};

/** Row 4 — unconditional fallback: a clean document proceeds. */
export const CLEAN_PROCEED_RULE: GateRule = {
  id: "clean_proceed",
  when: () => true,
  action: "proceed",
  criticReportVariant: null,
  repairRecommended: false,
  warningsRecorded: false,
  reason: () => "validation passed with no issues (§11.1)",
};

/**
 * The §5.1 gate table, in precedence order (first match wins). Blockers
 * outrank majors, majors outrank minors, and the last row is the
 * unconditional clean fallback.
 */
export const GATE_RULES: readonly GateRule[] = [
  BLOCKERS_GATE_RULE,
  MAJORS_CRITIQUE_RULE,
  MINORS_PROCEED_RULE,
  CLEAN_PROCEED_RULE,
];

/**
 * Applies the §5.1 gate table to one classified validation report.
 * Pure: no I/O, no history — the worker blends run history (revision caps,
 * aesthetics-already-passed) on top of this decision.
 */
export function validateGate(report: ValidatorReport): GateDecision {
  const rule = GATE_RULES.find((candidate) => candidate.when(report)) ?? CLEAN_PROCEED_RULE;
  return {
    action: rule.action,
    criticReportVariant: rule.criticReportVariant,
    repairTargets: repairTargetsFor(report),
    repairRecommended: rule.repairRecommended,
    warningsRecorded: rule.warningsRecorded,
    ruleId: rule.id,
    reason: rule.reason(report),
  };
}

// ---------------------------------------------------------------------------
// Repair targets (§11.2: blocker/major only, max 5)
// ---------------------------------------------------------------------------

/** §11.2: "Only blocker/major issues may appear in the repair plan (max 5)". */
export const MAX_REPAIR_TARGETS = 5;

/**
 * The rows a repair plan may address (§23.3/§11.2): blockers first (the tool
 * emits blocker→major→minor, and the service preserves that order), then
 * majors, capped at 5. Minors NEVER qualify (§11.1).
 */
export function repairTargetsFor(report: ValidatorReport): readonly ValidationIssue[] {
  return [...report.blockers, ...report.majors].slice(0, MAX_REPAIR_TARGETS);
}

// ---------------------------------------------------------------------------
// Critic input (§23.3 validator_report) + repair FIXES (§23.4)
// ---------------------------------------------------------------------------

/** renderSummary's exact row key order: level, code, layer?, message, fix. */
function issueRow(issue: ValidationIssue): Record<string, string> {
  const row: Record<string, string> = { level: issue.level, code: issue.code };
  if (issue.layer !== undefined) row.layer = issue.layer;
  row.message = issue.message;
  row.fix = issue.fix;
  return row;
}

/**
 * The `validator_report` string the critic receives (§23.3 input list).
 *   - "full": the tool's compact JSON verbatim (≤2000 chars, §6.1);
 *   - "blockers": same shape — ok/issueCounts/template/truncated echoed,
 *     but only blocker rows ("If a validator blocker is present, focus only
 *     on blockers"). A strict subset of the full summary's rows, so it stays
 *     within the §6.1 char budget.
 */
export function criticValidatorReport(
  report: ValidatorReport,
  variant: CriticReportVariant,
): string {
  if (variant === "full") {
    return report.summary;
  }
  const parts = [
    `"ok":${report.counts.blocker > 0 ? "false" : "true"}`,
    `"issueCounts":{"blocker":${report.counts.blocker},"major":${report.counts.major},"minor":${report.counts.minor}}`,
  ];
  if (report.template !== undefined) parts.push(`"template":${JSON.stringify(report.template)}`);
  parts.push(`"issues":${JSON.stringify(report.blockers.map(issueRow))}`);
  parts.push(`"truncated":${report.truncated}`);
  return `{${parts.join(",")}}`;
}

/**
 * The §23.4 repair prompt's `FIXES` array — one JSON row per repair target:
 * `{level, code, layer?, fix, message}`. Validator-native key names; the
 * worker unifies these with critic issue rows when it merges both sources
 * (§5.4 item 6: validator report + critic issues).
 */
export function renderRepairFixes(targets: readonly ValidationIssue[]): string {
  return JSON.stringify(
    targets.map((issue) => ({
      level: issue.level,
      code: issue.code,
      ...(issue.layer === undefined ? {} : { layer: issue.layer }),
      fix: issue.fix,
      message: issue.message,
    })),
  );
}
