// @studio/agent — the critic phase of the §5.1 loop (validating → critiquing).
// Owner: W6-E (docs/AGENTS.md).
//
// Spec anchors:
//   §5.1  "Validate before critique" — this service runs AFTER the deterministic
//         validator (cheap, exact). "Max 2 repair cycles" — cycle COUNTING lives
//         here (injected counter factory, cap = @studio/config
//         MAX_REPAIR_CYCLES); the repair/finalize DECISION lives in
//         ./cycle-gate.js. When issues remain after the cap the run ships
//         `succeeded_with_warnings` with the remaining issues surfaced to the
//         user as suggested manual fixes (§5.1/§11.2).
//   §5.3  Model-class routing is the WORKER's job (router.ts resolves the
//         route, the worker wires `ctx.critic` on the vision_critique tool and
//         hands this service the wired tool via the CriticToolLike seam). The
//         quick tier — §5.3 economy row "—" — SKIPS the critic entirely:
//         `{ skipped: true, reason: "tier" }`, decided from the §5.3 table in
//         ../models.js (TIER_MODEL_CLASS + ROLE_ROUTES.critic) so any tier
//         without a critic route (quick today, image tiers by construction)
//         skips automatically, never as an error.
//   §23.3 The §23.3 prompt is sent verbatim by the WORKER; this service shapes
//         the INPUT. "If a validator blocker is present, focus only on
//         blockers" — blockers-only input mode: the validator report is rebuilt
//         to carry blocker rows/counts only. The verdict/score rules (any score
//         ≤ 2 → revise, average < 3.5 → revise, ≤ 5 issues, revise⇔blocker-major
//         invariants) are enforced IN THE TOOL (tools/vision-critique.ts
//         enforceCritiqueRules) — this service passes the enforced verdict
//         through and never re-implements them.
//   §11.2 "Only blocker/major issues may appear in the repair plan (max 5)."
//         `repairIssues` pre-computes that subset for the repair planner
//         (repair/planner.ts re-filters — defense in depth).
//   §3.4  A critique call aborted by the deadline surfaces as a typed
//         `run_timeout` envelope, never a throw; §6.2's defineTool boundary
//         already converts the real tool's throws to ToolErr values.
//
// Run-loop composition (worker / run manager):
//   const critic = new RunCritic({ tool, counterFactory });
//   const result = await critic.critique({ brief, previewUrl, layerSummary,
//     palette, validatorReport, tier });                     // AgentResult<…>
//   const gate = cycleGateForOutcome(result, critic.cycles()); // ./cycle-gate.js
//   if (gate.decision === "repair") { critic.noteRepairCycle(); …repairing… }

import { MAX_REPAIR_CYCLES, type RunTierId } from "@studio/config";
import type { ToolErr, ToolResult } from "@studio/tools";
import { z } from "zod";
import { type AgentErrorCode, type AgentResult, agentErr, agentOk } from "../errors.js";
import { type ModelClass, TIER_MODEL_CLASS, isRoleEnabled } from "../models.js";

// --- The §23.3 verdict types (parsed from the tool's compact summary) ------------

export type CriticSeverity = "blocker" | "major" | "minor";
export type CriticVerdictValue = "accept" | "revise";

/** The six §23.3 rubric scores, 1–5, in prompt order. */
export interface CritiqueScores {
  readonly hierarchy: number;
  readonly balance: number;
  readonly contrast: number;
  readonly brief_adherence: number;
  readonly brand_fit: number;
  readonly editability: number;
}

/**
 * One §23.3 critic issue. The tool's raw issue carries all five fields; its
 * ≤2000-char compact-summary ladder may clip prose or reduce rows to
 * {severity, code, layer} (buildCritiqueSummary L1–L3), so the service parses
 * the optional fields tolerantly instead of rejecting a legitimately compacted
 * summary. The repair planner (repair/planner.ts) requires layer+fix on critic
 * rows — seam note: L3-compacted rows cannot enter a repair plan (documented
 * for the planner owner; the common path never compacts).
 */
export interface CritiqueIssue {
  readonly severity: CriticSeverity;
  readonly code: string;
  readonly layer?: string;
  readonly observation?: string;
  readonly fix?: string;
}

/** §11.2 output: verdict + rubric scores + issues. */
export interface CritiqueVerdict {
  readonly verdict: CriticVerdictValue;
  readonly scores: CritiqueScores;
  readonly issues: readonly CritiqueIssue[];
}

/** One critique pass: skipped (tier has no critic route) or a full verdict. */
export type CritiqueResult =
  | { readonly skipped: true; readonly reason: "tier" }
  | {
      readonly skipped: false;
      readonly verdict: CritiqueVerdict;
      /** Tool warnings (§23.3 enforcement/compaction notes) + service notes. */
      readonly warnings: readonly string[];
      /** §11.2: only blocker/major issues may feed the repair planner. */
      readonly repairIssues: readonly CritiqueIssue[];
    };

// --- Summary parsing (tools buildCritiqueSummary shape; tolerant, never throws) --

/** Parse headroom: the tool caps issues at 5 (§23.3); a seam may misbehave. */
export const MAX_PARSED_SUMMARY_ISSUES = 50;

const zScore = z.number().int().min(1).max(5);

const zSummaryIssue = z.object({
  severity: z.enum(["blocker", "major", "minor"]),
  code: z.string().min(1).max(80), // tools: short_snake_case ≤ 80
  layer: z.string().min(1).max(200).optional(),
  observation: z.string().max(500).optional(),
  fix: z.string().max(500).optional(),
});

const zCritiqueSummary = z.object({
  verdict: z.enum(["accept", "revise"]),
  scores: z.object({
    hierarchy: zScore,
    balance: zScore,
    contrast: zScore,
    brief_adherence: zScore,
    brand_fit: zScore,
    editability: zScore,
  }),
  // The tool always serializes the array (issues:[] on compaction L4); the
  // .default mirrors the tool's own omission tolerance (§23.3 "clean accept").
  issues: z.array(zSummaryIssue).max(MAX_PARSED_SUMMARY_ISSUES).default([]),
});

/**
 * Parses the vision_critique tool's compact JSON summary
 * ({verdict, scores, issues, avg}) into a CritiqueVerdict. `undefined` when the
 * summary is not that shape — a seam-contract violation, surfaced by the
 * service as a typed failure (never a throw, never echoing the raw text).
 */
export function parseCritiqueSummary(summary: string): CritiqueVerdict | undefined {
  let value: unknown;
  try {
    value = JSON.parse(summary);
  } catch {
    return undefined;
  }
  const parsed = zCritiqueSummary.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  return {
    verdict: parsed.data.verdict,
    scores: parsed.data.scores,
    issues: parsed.data.issues,
  };
}

// --- §23.3 blocker/major filter (repair-planner feed) ----------------------------

/** §23.3 "Maximum 5 issues" — mirrors repair/prompt.js MAX_REPAIR_FIXES. */
export const MAX_REPAIR_PLAN_ISSUES = 5;

/**
 * §11.2/§23.3: the repair plan may carry only blocker/major issues, at most 5.
 * The tool already truncates its issue list to 5; the cap here is a seam guard
 * (repair/planner.ts buildFixList re-filters and re-caps regardless).
 */
export function repairPlanIssues(critique: CritiqueVerdict): readonly CritiqueIssue[] {
  return critique.issues
    .filter((issue) => issue.severity === "blocker" || issue.severity === "major")
    .slice(0, MAX_REPAIR_PLAN_ISSUES);
}

// --- §5.3 tier routing (quick tier SKIPS the critic) ------------------------------

/**
 * True when §5.3 routes a critic for this tier's model class. The quick tier
 * maps to the economy row, whose critic entry is "— (skip for quick tier)"
 * (models.js ROLE_ROUTES.critic.economy === null); image tiers route by role
 * only (TIER_MODEL_CLASS null) and never reach this phase. An unknown tier id
 * from an untyped caller skips too — no route means no critique, never a crash.
 */
export function criticRouteEnabled(tier: RunTierId): boolean {
  const modelClass = TIER_MODEL_CLASS[tier] as ModelClass | null | undefined;
  return modelClass !== null && modelClass !== undefined && isRoleEnabled("critic", modelClass);
}

// --- §23.3 blockers-only input mode ------------------------------------------------

/** Mirrors MAX_VALIDATOR_REPORT_CHARS (tools/vision-critique.ts §6 row 16). */
export const CRITIC_VALIDATOR_REPORT_CHARS = 2000;

/**
 * §23.3 blockers-only input mode, pure. Given the validate_document summary
 * (compact JSON {ok, issueCounts, issues:[{level, code, layer?, message, fix}],
 * truncated}):
 *
 *   - no blockers (or an unparseable/non-JSON report) → returned UNCHANGED —
 *     the critic sees the full deterministic report;
 *   - blockers present → a rebuilt report carrying ONLY blocker rows and
 *     blocker counts, so the vision model is pointed at exactly the issues
 *     §23.3 tells it to focus on ("If a validator blocker is present, focus
 *     only on blockers").
 *
 * The rebuilt report keeps the validator's own conventions: `issueCounts`
 * carries the TRUE blocker total (counts stay exact even when the visible list
 * was capped/shed), `ok:false` (blockers present ⇒ validator ok === false),
 * and rows keep their §6.1-sized {level, code, layer?, message, fix} shape.
 * It always fits the tool's 2000-char input cap (tail rows shed first).
 */
export function blockersOnlyValidatorReport(validatorReport: string): string {
  if (validatorReport.trim().length === 0) {
    return validatorReport;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(validatorReport);
  } catch {
    return validatorReport; // not JSON: pass through untouched; the tool checks length
  }
  if (typeof parsed !== "object" || parsed === null) {
    return validatorReport;
  }
  const report = parsed as Record<string, unknown>;
  const rows = Array.isArray(report.issues) ? report.issues : [];
  const blockerRows = rows.filter(
    (row) =>
      typeof row === "object" &&
      row !== null &&
      (row as { readonly level?: unknown }).level === "blocker",
  );
  const countsRaw = report.issueCounts;
  const declared =
    typeof countsRaw === "object" && countsRaw !== null
      ? (countsRaw as { readonly blocker?: unknown }).blocker
      : undefined;
  const declaredBlockers = typeof declared === "number" && declared > 0 ? Math.floor(declared) : 0;
  if (blockerRows.length === 0 && declaredBlockers === 0) {
    return validatorReport; // §5.1: no blocker → the critic checks aesthetics freely
  }
  const blockerCount = Math.max(declaredBlockers, blockerRows.length);
  let issues: readonly unknown[] = blockerRows;
  let rebuilt = "";
  for (;;) {
    rebuilt = JSON.stringify({
      ok: false, // blockers present ⇒ the validator's own ok:false
      issueCounts: { blocker: blockerCount, major: 0, minor: 0 },
      issues,
      truncated: report.truncated === true,
    });
    if (rebuilt.length <= CRITIC_VALIDATOR_REPORT_CHARS || issues.length <= 1) {
      break;
    }
    issues = issues.slice(0, issues.length - 1); // shed tail rows, blockers stay first
  }
  if (rebuilt.length > CRITIC_VALIDATOR_REPORT_CHARS) {
    // Pathological single oversized row — ship the counts only (never over the cap).
    rebuilt = JSON.stringify({
      ok: false,
      issueCounts: { blocker: blockerCount, major: 0, minor: 0 },
      issues: [],
      truncated: true,
    });
  }
  return rebuilt;
}

// --- §5.1 repair-cycle counter (injected factory) --------------------------------

/**
 * One run's §5.1 repair-cycle tally. `max` defaults to MAX_REPAIR_CYCLES (2);
 * the GATE (./cycle-gate.js) enforces the §5.1 cap against MAX_REPAIR_CYCLES
 * regardless of what a custom counter reports — 2 is the spec, not a knob.
 */
export interface RepairCycleCounter {
  /** The cap this counter was built with (§5.1: 2). */
  readonly max: number;
  /** Repair cycles consumed so far. */
  used(): number;
  /** True while one more §5.1 repair cycle may start. */
  canStart(): boolean;
  /** Consumes one cycle; false when the cap is already reached. */
  consume(): boolean;
}

/** The injected seam: the worker may back the counter by persistent run state. */
export type RepairCycleCounterFactory = () => RepairCycleCounter;

/**
 * Default in-memory §5.1 counter factory (used when the worker injects none).
 * Construction-time nonsense fails fast — a wiring bug, not a budget event
 * (budgets-service precedent).
 */
export function createRepairCycleCounter(max: number = MAX_REPAIR_CYCLES): RepairCycleCounter {
  if (!Number.isInteger(max) || max < 0) {
    throw new Error(`[agent/critic] repair-cycle cap must be a non-negative integer, got ${max}`);
  }
  let consumed = 0;
  return {
    max,
    used: () => consumed,
    canStart: () => consumed < max,
    consume: () => {
      if (consumed >= max) {
        return false;
      }
      consumed += 1;
      return true;
    },
  };
}

// --- The injected tool seam (worker wires vision_critique + §5.3 routing) ----------

/** The vision_critique tool's §6 row 16 argument shape, forwarded verbatim. */
export interface CriticToolArgs {
  readonly brief: string;
  readonly previewUrl: string;
  readonly layerSummary: string;
  readonly palette?: readonly string[];
  readonly validatorReport: string;
}

/**
 * The critic tool seam: `run(args)` only. The WORKER binds this to the real
 * `vision_critique` tool (defineTool's run, wired with ctx.critic per §5.3 and
 * the §3.4 deadline signal); tests bind fakes. Throwing is a seam violation —
 * the real tool's defineTool boundary converts throws to ToolErr values, so
 * the service still maps an unexpected throw to a typed envelope.
 */
export interface CriticToolLike {
  run(args: CriticToolArgs): Promise<ToolResult>;
}

// --- Tool-failure mapping (typed envelopes, §13.3-style; no leaks) -----------------

/**
 * Swap-point error code (W5-D/W6-F fleet precedent): the agent catalog
 * (../errors.js) is add-only and has no critic-specific code, so seam
 * violations, unreadable summaries and unmapped tool codes map to the closest
 * existing agent code — tool_retry_exhausted, "a tool exceeded its retry
 * budget (§6.3)". errors.ts owner: add "critique_unavailable" to
 * AGENT_ERROR_CODES + AGENT_TO_WIRE_ERROR_CODE and flip this one constant.
 */
export const CRITIC_TOOL_FAILURE_CODE: AgentErrorCode = "tool_retry_exhausted";

/** Tool code → agent code + retryability. §13.3 codes are stable strings. */
const TOOL_FAILURE_MAP: Readonly<
  Record<string, { readonly code: AgentErrorCode; readonly retryable: boolean }>
> = {
  // §5.3 provider failure — the worker may fail over and re-run the critique.
  provider_unhealthy: { code: "provider_unhealthy", retryable: true },
  // §3.4 deadline — retry within the run's remaining wall clock.
  engine_timeout: { code: "run_timeout", retryable: true },
  // tools CRITIQUE_PARSE_FAILED_CODE ("validation_failed" until the types.ts
  // owner adopts critique_parse_failed): the model reply was unparseable after
  // the tool's in-tool "Return JSON only." retry — one fresh critique may fix.
  validation_failed: { code: CRITIC_TOOL_FAILURE_CODE, retryable: true },
};

function mapToolFailure(failure: ToolErr): AgentResult<never> {
  const mapped = TOOL_FAILURE_MAP[failure.code] ?? {
    // Unmapped codes (invalid_args, internal_error, storage_error, …) are
    // wiring/contract bugs — the tool messages are §6.1-sanitized and ride
    // along; retrying identical args cannot help.
    code: CRITIC_TOOL_FAILURE_CODE,
    retryable: false,
  };
  return agentErr(mapped.code, `vision_critique failed: ${failure.message}`, {
    hint: failure.hint ?? "Fix the underlying tool failure, then critique again (§5.1).",
    retryable: mapped.retryable,
  });
}

// --- The service --------------------------------------------------------------------

/** The request the run loop hands the critic after the validating phase. */
export interface CritiqueRequest {
  /** The user brief the design is judged against (§23.3 brief_adherence). */
  readonly brief: string;
  /** http(s) URL of the ≤1024 px render (render_preview / doc.render). */
  readonly previewUrl: string;
  /** Compact layer-tree summary (workspace_snapshot / layer.list). */
  readonly layerSummary: string;
  /** Brand palette as hex colours, ≤ 10 entries. */
  readonly palette?: readonly string[];
  /** The deterministic validator report (validate_document summary JSON). */
  readonly validatorReport: string;
  /** §5.2/§5.3 tier id — drives the skip decision and the worker's routing. */
  readonly tier: RunTierId;
}

export interface RunCriticOptions {
  /** The wired vision_critique tool (worker) or a fake (tests). */
  readonly tool: CriticToolLike;
  /**
   * Injected counter factory (§5.1 "max 2 repair cycles"): called ONCE at
   * construction; the counter lives as long as the service (one per run).
   * Defaults to the in-memory createRepairCycleCounter().
   */
  readonly counterFactory?: RepairCycleCounterFactory;
}

/**
 * One critique pass through the §5.3-routed vision_critique tool:
 *
 *   quick tier / unrouted tier → { skipped: true, reason: "tier" } (§5.3);
 *   validator blockers present → §23.3 blockers-only input mode;
 *   tool ok                    → CritiqueVerdict + warnings passthrough +
 *                                repairIssues (§11.2 blocker/major feed);
 *   tool failure / bad seam    → typed AgentResult failure (never a throw).
 *
 * The §23.3 score-forcing rules (≤ 2 / avg < 3.5 → revise) are enforced in the
 * TOOL; the service passes the enforced verdict and the tool's warnings
 * through verbatim — it never second-guesses them.
 */
export class RunCritic {
  private readonly tool: CriticToolLike;
  private readonly counter: RepairCycleCounter;

  constructor(options: RunCriticOptions) {
    this.tool = options.tool;
    this.counter = (options.counterFactory ?? createRepairCycleCounter)();
  }

  async critique(request: CritiqueRequest): Promise<AgentResult<CritiqueResult>> {
    // §5.3 economy row: the quick tier (and any tier without a critic route)
    // skips the critic entirely — no tool call, no model spend, no warnings.
    if (!criticRouteEnabled(request.tier)) {
      return agentOk({ skipped: true, reason: "tier" });
    }

    // §23.3 blockers-only input mode: with validator blockers present the
    // critic is pointed at exactly those blockers.
    const validatorReport = blockersOnlyValidatorReport(request.validatorReport);
    const blockersOnly = validatorReport !== request.validatorReport;

    const args: CriticToolArgs = {
      brief: request.brief,
      previewUrl: request.previewUrl,
      layerSummary: request.layerSummary,
      ...(request.palette !== undefined ? { palette: request.palette } : {}),
      validatorReport,
    };

    let result: ToolResult;
    try {
      result = await this.tool.run(args);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        // §3.4 deadline — typed envelope, not a rethrow (the request seam has
        // no signal; the worker embeds the deadline in its adapter).
        return agentErr("run_timeout", "The critique call was aborted before it finished", {
          hint: "Retry the critique while the run's §3.4 wall clock still allows it.",
          retryable: true,
        });
      }
      return agentErr(
        CRITIC_TOOL_FAILURE_CODE,
        "The critic tool seam threw instead of returning a result",
        {
          hint: "Worker: bind CriticToolLike.run to the defineTool-wrapped vision_critique tool (§6.2 boundary converts throws to ToolErr).",
          retryable: false,
        },
      );
    }

    if (!result.ok) {
      return mapToolFailure(result);
    }

    const verdict = parseCritiqueSummary(result.summary);
    if (verdict === undefined) {
      return agentErr(
        CRITIC_TOOL_FAILURE_CODE,
        "The critique tool returned a summary that is not the §23.3 critique JSON",
        {
          hint: 'Expect the buildCritiqueSummary shape: {"verdict","scores","issues","avg"} (tools/vision-critique.ts).',
          retryable: false,
        },
      );
    }

    const warnings = [...(result.warnings ?? [])];
    if (blockersOnly) {
      warnings.unshift(
        "Validator blockers present — the critique ran in blockers-only input mode (§23.3).",
      );
    }

    return agentOk({
      skipped: false,
      verdict,
      warnings,
      repairIssues: repairPlanIssues(verdict), // §11.2: blocker/major only
    });
  }

  /** §5.1 repair cycles consumed so far — the input to ./cycle-gate.js. */
  cycles(): number {
    return this.counter.used();
  }

  /** §5.1 cycles still available (0 once the cap is reached). */
  remainingCycles(): number {
    return this.counter.max - this.counter.used();
  }

  /** True while the §5.1 cap allows one more repair cycle. */
  canRepair(): boolean {
    return this.counter.canStart();
  }

  /**
   * Marks one §5.1 repair cycle as consumed. Call exactly when the run manager
   * acts on a cycleGate(...)==="repair" decision; false at the cap (a gate that
   * saw cycles<2 never hits the false branch).
   */
  noteRepairCycle(): boolean {
    return this.counter.consume();
  }
}
