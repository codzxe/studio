// @studio/agent — the §23.4/§5.1 repair planner. Owner: W6-F (docs/AGENTS.md).
//
// Spec anchors:
//   §5.1  "Repair narrowly": a repair plan addresses ONLY the critic's
//         blocker/major issues, using the fewest tools; max 2 repair cycles
//         (worker-enforced via @studio/config MAX_REPAIR_CYCLES — this module
//         plans exactly ONE cycle per call and never counts cycles).
//   §11.2 "Only blocker/major issues may appear in the repair plan (max 5)."
//   §11.3 "One issue → one minimal fix; prefer parameter changes."
//   §23.3 severity filter + ≤5 cap source; the one formatting retry precedent
//         (invalid model output → ONE retry with the validation errors
//         attached → clear typed failure, §5.1 plan-retry pattern).
//   §23.4 prompt built verbatim (./prompt.js); rule 1 tool allow-list; rule 2
//         no restructure/rename*/add/delete; rule 4 impossible fixes become
//         documented warnings with the closest valid alternative — never a
//         hard fail, never a worse document. (*rename stays available: the
//         W6-F task pin hard-forbids only ADD/DELETE layer ops, §23.4's
//         "unless a fix explicitly requires it" covers the rest.)
//   §5.7  model output is untrusted: strict zod schemas, tool allow-list,
//         unknown issue codes dropped, no provider message ever echoed.
//
// W6-B contract: the emitted `steps` are §5.5 PlanStep-shaped (validated
// against plan.ts's planStepSchema at build time) so the executor service
// (src/executor — ExecuteInput.plan: Plan, phase "repairing") can run them;
// `buildRepairMiniPlan` wraps the steps into a full §5.5-validated Plan (the
// executor takes a whole plan, so the worker assembles
// { plan: buildRepairMiniPlan(plan.steps, run.tier), phase: "repairing" }).
// `stepIssues` keeps the issue-code traceability parallel to `steps` without
// polluting the executor-facing shape.
import { PLAN_RETRY_LIMIT } from "@studio/config";
import { z } from "zod";
import type { AgentErrorCode, AgentResult } from "../errors.js";
import { agentErr, agentOk } from "../errors.js";
import {
  type Plan,
  type PlanModelTier,
  type PlanStep,
  planStepSchema,
  validatePlan,
} from "../plan.js";
import {
  MAX_REPAIR_FIXES,
  type RepairContext,
  type RepairFix,
  buildRepairPrompt,
  repairContextSchema,
} from "./prompt.js";

// --- Swap-point error code (W5-E/W5-D/W5-K fleet precedent) ------------------------

/**
 * The agent error catalog (../errors.js) is add-only and carries no
 * repair-specific code yet, so invalid repair-model output maps to the closest
 * existing agent code — `plan_invalid`, "a plan failed schema validation".
 * errors.ts owner: add "repair_plan_invalid" to AGENT_ERROR_CODES +
 * AGENT_TO_WIRE_ERROR_CODE, then flip this one-line constant. Tests import it.
 */
export const REPAIR_PLAN_INVALID_CODE: AgentErrorCode = "plan_invalid";

/** §5.5 intent for a repair cycle: repairs edit existing layers, nothing else. */
export const REPAIR_MINI_PLAN_NOTE =
  "Repair cycle (§5.1): minimum fixes for the reported blocker/major issues, nothing else.";

// --- Input issues (validator §11.1 shape ∪ critic §23.3 shape) ---------------------

export const REPAIR_SEVERITIES = ["blocker", "major", "minor"] as const;
export type RepairSeverity = (typeof REPAIR_SEVERITIES)[number];

/** Validator cap is MAX_ISSUES = 25 (tools validate_document); critic cap is 5. */
export const MAX_REPAIR_INPUT_ISSUES = 30;

/** §11.1 validator issue: { level, code, layer?, message, fix }. Tolerant (caller is typed upstream). */
export const validatorRepairIssueSchema = z.object({
  level: z.enum(REPAIR_SEVERITIES),
  code: z.string().min(1).max(100),
  layer: z.string().min(1).max(200).optional(),
  message: z.string().max(2000).optional(),
  fix: z.string().min(1).max(500),
});

/** §23.3 critic issue: { severity, code, layer, observation, fix }. */
export const criticRepairIssueSchema = z.object({
  severity: z.enum(REPAIR_SEVERITIES),
  code: z.string().min(1).max(100),
  layer: z.string().min(1).max(200),
  observation: z.string().max(2000).optional(),
  fix: z.string().min(1).max(500),
});

export const repairIssueSchema = z.union([validatorRepairIssueSchema, criticRepairIssueSchema]);
export type RepairIssueInput = z.infer<typeof repairIssueSchema>;

/** Internal normalized issue (severity folded, observation/message dropped). */
export interface NormalizedRepairIssue {
  readonly severity: RepairSeverity;
  readonly code: string;
  readonly layer?: string;
  readonly fix: string;
}

function normalizeIssue(issue: RepairIssueInput): NormalizedRepairIssue {
  // z.object strips unknown keys, so "severity" survives only on critic rows.
  if ("severity" in issue) {
    return { severity: issue.severity, code: issue.code, layer: issue.layer, fix: issue.fix };
  }
  return { severity: issue.level, code: issue.code, layer: issue.layer, fix: issue.fix };
}

// --- The fix list (§11.2 blocker/major only, ≤5, blockers first) -------------------

const SEVERITY_RANK: Readonly<Record<RepairSeverity, number>> = { blocker: 0, major: 1, minor: 2 };

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

export interface RepairFixList {
  /** The §23.4 FIXES payload: ≤5 blocker/major issues, blockers first, stable. */
  readonly fixes: readonly NormalizedRepairIssue[];
  /** Filter/cap notes that ride into the final plan's warnings. */
  readonly warnings: readonly string[];
  readonly droppedMinorCount: number;
  readonly deferredCount: number;
}

/**
 * §11.2/§23.3 fix-list policy, pure: drop minors (they never drive repair),
 * rank blockers before majors (stable within a level, validator sortIssues
 * precedent), cap at MAX_REPAIR_FIXES and document the overflow.
 */
export function buildFixList(issues: readonly NormalizedRepairIssue[]): RepairFixList {
  const actionable = issues.filter((issue) => issue.severity !== "minor");
  const droppedMinorCount = issues.length - actionable.length;
  const ranked = [...actionable].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
  const fixes = ranked.slice(0, MAX_REPAIR_FIXES);
  const deferredCount = ranked.length - fixes.length;
  const warnings: string[] = [];
  if (droppedMinorCount > 0) {
    warnings.push(
      `${droppedMinorCount} minor issue(s) dropped from the repair plan — minors never drive repair (§11.2).`,
    );
  }
  if (deferredCount > 0) {
    const deferred = ranked
      .slice(MAX_REPAIR_FIXES)
      .map((issue) => clip(issue.code, 40))
      .join(", ");
    warnings.push(
      `${ranked.length} blocker/major issues exceed the §23.3 cap of ${MAX_REPAIR_FIXES} per cycle; deferred to a later cycle: ${deferred}.`,
    );
  }
  return { fixes, warnings, droppedMinorCount, deferredCount };
}

function toPromptFix(issue: NormalizedRepairIssue): RepairFix {
  return issue.layer === undefined
    ? { code: issue.code, fix: issue.fix }
    : { code: issue.code, layer: issue.layer, fix: issue.fix };
}

// --- The repair tool allow-list (§23.4 rule 1) + add/delete ban (rule 2) -----------

/** §23.4 rule 1: exactly these four tools may appear in a repair plan. */
export const REPAIR_TOOLS = ["text_set", "layer_ops", "style_apply", "layout_apply"] as const;
export type RepairTool = (typeof REPAIR_TOOLS)[number];
export const repairToolSchema = z.enum(REPAIR_TOOLS);

/**
 * §23.4 rule 2 + W6-F pin: repair NEVER adds or deletes layers. These are the
 * layer_ops ops that create layers in the current §6 row 9 union; the regex
 * below guards future ops named like add/new/create/delete/remove.
 */
export const REPAIR_BLOCKED_LAYER_OPS: readonly string[] = ["create_group", "duplicate", "group"];

const BLOCKED_LAYER_OP_RE = /(?:^|_)(?:add|new|create|delete|remove)(?:_|$)/;

export function isBlockedLayerOp(op: string): boolean {
  if (REPAIR_BLOCKED_LAYER_OPS.includes(op)) {
    return true;
  }
  return BLOCKED_LAYER_OP_RE.test(op);
}

// --- The injected model seam (worker wires §5.3 routing; never a provider SDK here) -

export interface RepairUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface RepairModelResult {
  readonly raw: string;
  readonly usage?: RepairUsage;
}

/**
 * The external repair-model seam: `complete(prompt, signal)`. The WORKER wires
 * this per §5.3 with per-provider circuit breakers and same-class failover;
 * failures THROW (mapped below to typed envelopes, provider messages never
 * leaked); AbortError is rethrown for the caller's §3.4 deadline mapping.
 */
export interface RepairModelLike {
  complete(prompt: string, signal: AbortSignal): Promise<RepairModelResult>;
}

// --- Model output schema (§5.7: untrusted, strict) --------------------------------

/** Parse headroom: ≤5 fixes are sent, a chatty reply may echo a few more. */
export const MAX_PARSED_APPLIED = 10;

/**
 * One planned fix. The task-pinned planner contract is
 * { issue, tool, args }; §23.4 rule 3's reply field (`result`, `note`) is
 * tolerated (the applying phase uses it, planning ignores it), and §23.4
 * rule 4's impossible-fix path is { issue, impossible: true, alternative }.
 */
export const repairAppliedEntrySchema = z
  .strictObject({
    issue: z.string().min(1).max(100),
    tool: repairToolSchema.optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    impossible: z.boolean().optional(),
    alternative: z.string().max(1000).optional(),
    note: z.string().max(1000).optional(),
    result: z.enum(["ok", "failed"]).optional(),
  })
  .superRefine((entry, ctx) => {
    if (entry.impossible === true) {
      return; // §23.4 rule 4 — warning path, never a hard fail
    }
    if (entry.tool === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tool"],
        message:
          "tool is required (one of text_set, layer_ops, style_apply, layout_apply) unless impossible:true",
      });
      return;
    }
    if (entry.tool === "layer_ops") {
      const op = (entry.args as { op?: unknown } | undefined)?.op;
      if (typeof op === "string" && isBlockedLayerOp(op)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["args", "op"],
          message: `layer_ops op '${clip(op, 40)}' adds or deletes layers — §23.4 forbids structural ops in repair; use rename/reorder/align/set_props, or text_set/style_apply/layout_apply`,
        });
      }
    }
  });

export type RepairAppliedEntry = z.infer<typeof repairAppliedEntrySchema>;

export const repairModelOutputSchema = z.strictObject({
  applied: z.array(repairAppliedEntrySchema).max(MAX_PARSED_APPLIED).default([]),
});

export type RepairModelOutput = z.infer<typeof repairModelOutputSchema>;

// --- Raw-output extraction (fence/preamble-tolerant, strict on content) -----------

/**
 * Finds the first balanced JSON object in `raw`, honouring string escapes so
 * prose with braces cannot truncate the scan. `undefined` when there is none.
 */
function firstJsonObject(raw: string): string | undefined {
  const start = raw.indexOf("{");
  if (start < 0) {
    return undefined;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i] ?? "";
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return undefined;
}

export type RepairParseResult =
  | { readonly ok: true; readonly value: RepairModelOutput }
  | {
      readonly ok: false;
      readonly reason: "empty" | "not_json" | "schema";
      /** One readable string per violation; attached verbatim to the retry (§5.1). */
      readonly issues: readonly string[];
    };

function formatSchemaIssues(error: z.ZodError): string[] {
  const issues = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
    return `${path}: ${clip(issue.message, 160)}`;
  });
  return issues.slice(0, 10);
}

/**
 * Parses raw repair-model text into the planner contract. Accepts bare JSON,
 * a fenced ```json block, or JSON embedded in prose (models add preambles
 * despite "Return JSON only"); anything else fails, which drives the ONE
 * retry. Never throws; failure strings are safe to attach and log.
 */
export function parseRepairPlanRaw(raw: string): RepairParseResult {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, reason: "empty", issues: ["the reply was empty"] };
  }
  const candidates: string[] = [raw.trim()];
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(raw.trim());
  if (fenced?.[1] !== undefined) {
    candidates.unshift(fenced[1].trim());
  }
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      const parsed = repairModelOutputSchema.safeParse(value);
      if (parsed.success) {
        return { ok: true, value: parsed.data };
      }
      return { ok: false, reason: "schema", issues: formatSchemaIssues(parsed.error) };
    } catch {
      // try the next candidate
    }
  }
  const extracted = firstJsonObject(raw);
  if (extracted !== undefined) {
    try {
      const value: unknown = JSON.parse(extracted);
      const parsed = repairModelOutputSchema.safeParse(value);
      if (parsed.success) {
        return { ok: true, value: parsed.data };
      }
      return { ok: false, reason: "schema", issues: formatSchemaIssues(parsed.error) };
    } catch {
      return { ok: false, reason: "not_json", issues: ["the reply was not JSON"] };
    }
  }
  return { ok: false, reason: "not_json", issues: ["the reply was not JSON"] };
}

// --- Planning-phase reply contract (appended AFTER the verbatim §23.4 prompt) ------

/**
 * §23.4 rule 3 describes the APPLYING-phase reply ({"…","result":"ok|failed"}).
 * The planner phase cannot apply anything, so it appends this contract telling
 * the model to return the task-pinned planning shape
 * {"applied":[{"issue","tool","args"}]} plus §23.4 rule 4's impossible path.
 * prompt.ts stays the single source of the §23.4 text; the executor phase
 * (W6-B) reuses it WITHOUT this tail.
 */
export const REPAIR_PLANNING_CONTRACT = [
  "",
  "PLANNING CALL — do not apply anything and do not call tools. For the FIXES list, return JSON only, no fences, no prose:",
  '{"applied":[{"issue":"<fix code>","tool":"text_set|layer_ops|style_apply|layout_apply","args":{}}]}',
  'For a fix that is impossible with those four tools, return that entry as {"issue":"<fix code>","impossible":true,"alternative":"<closest valid alternative>"} instead.',
  "Never propose template_apply, component tools, or any add/delete layer operation (no create_group/duplicate/group).",
].join("\n");

/** §23.3 retry wording, identical to the critic's REPAIR_INSTRUCTION. */
export const REPAIR_RETRY_INSTRUCTION = "Return JSON only.";

function retryPrompt(base: string, issues: readonly string[]): string {
  return [
    base,
    "",
    `${REPAIR_RETRY_INSTRUCTION} Your previous reply failed schema validation:`,
    ...issues.map((issue) => `- ${issue}`),
    `Reply again with JSON only, every tool one of: ${REPAIR_TOOLS.join(", ")}.`,
  ].join("\n");
}

// --- The plan ----------------------------------------------------------------------

/** One repair cycle's plan — the W6-B executor contract + traceability. */
export interface RepairPlan {
  /** Mini plan.steps (§5.5 PlanStep-shaped, plan.ts-validated): executor input. */
  readonly steps: readonly PlanStep[];
  /** Issue code per step, parallel to `steps` (journaling/trace, §24 traces). */
  readonly stepIssues: readonly string[];
  /** Impossible fixes with their closest alternatives (§23.4 rule 4), plus
   *  filter/cap/dedup notes. The worker surfaces these on
   *  succeeded_with_warnings (§5.1 after 2 cycles). */
  readonly warnings: readonly string[];
  /** Model calls made (0 = short-circuited, 1 = happy, 2 = retried). */
  readonly modelCalls: number;
  /** §22 token usage, summed across the cycle's calls; logged, never echoed. */
  readonly usage?: RepairUsage;
}

export interface PlanRepairsInput {
  /** Validator (§11.1) and/or critic (§23.3) issues, mixed in one array. */
  readonly issues: readonly RepairIssueInput[];
  /** The four §23.4 context parts (layerTree, manifest?, palette?, validatorReport). */
  readonly context: RepairContext;
  /** Injected repair model seam (worker wires §5.3 routing + failover). */
  readonly model: RepairModelLike;
  /** Optional §3.4 deadline signal; passed through to every model call. */
  readonly signal?: AbortSignal;
}

function addUsage(
  total: RepairUsage | undefined,
  added: RepairUsage | undefined,
): RepairUsage | undefined {
  if (added === undefined) {
    return total;
  }
  if (total === undefined) {
    return added;
  }
  const sum = (a: number | undefined, b: number | undefined): number | undefined =>
    a === undefined ? b : b === undefined ? a : a + b;
  return {
    inputTokens: sum(total.inputTokens, added.inputTokens),
    outputTokens: sum(total.outputTokens, added.outputTokens),
    totalTokens: sum(total.totalTokens, added.totalTokens),
  };
}

/** §23.4 rule 4: an impossible fix is a documented warning, never a hard fail. */
function impossibleWarning(entry: RepairAppliedEntry): string {
  const alternative = entry.alternative ?? entry.note ?? "none proposed";
  return `fix for '${clip(entry.issue, 40)}' is impossible with the repair tools (§23.4) — closest valid alternative: ${clip(alternative, 300)}`;
}

/**
 * Folds validated model output into a RepairPlan:
 *   - impossible entries → warnings (§23.4 rule 4);
 *   - unknown issue codes → dropped with a warning (§23.4 "change nothing else");
 *   - duplicate codes → first fix kept (§11.3 one issue → one minimal fix);
 *   - every kept step re-validated against plan.ts planStepSchema so the
 *     executor receives exactly the §5.5 step shape (W6-B contract).
 */
function buildPlan(
  output: RepairModelOutput,
  fixList: RepairFixList,
  meta: { modelCalls: number; usage: RepairUsage | undefined },
): AgentResult<RepairPlan> {
  const sentCodes = new Set(fixList.fixes.map((fix) => fix.code));
  const steps: PlanStep[] = [];
  const stepIssues: string[] = [];
  const warnings = [...fixList.warnings];
  const seen = new Set<string>();
  for (const entry of output.applied) {
    if (entry.impossible === true) {
      warnings.push(impossibleWarning(entry));
      continue;
    }
    if (!sentCodes.has(entry.issue)) {
      warnings.push(
        `model proposed a fix for '${clip(entry.issue, 40)}' which is not in the planned FIXES list — dropped (§23.4 "change nothing else").`,
      );
      continue;
    }
    if (seen.has(entry.issue)) {
      warnings.push(
        `model proposed more than one fix for '${clip(entry.issue, 40)}' — the first one was kept (§11.3 one issue, one minimal fix).`,
      );
      continue;
    }
    const step = planStepSchema.safeParse({ tool: entry.tool, args: entry.args ?? {} });
    if (!step.success) {
      // Unreachable for the four enum tools; guards plan.ts drift instead of
      // silently shipping an executor-shaped mismatch.
      return agentErr(
        REPAIR_PLAN_INVALID_CODE,
        "a repair step failed the §5.5 plan-step schema (plan.ts contract drift?)",
        {
          hint: "Re-run with the current planStepSchema or report to the plan.ts owner.",
          retryable: false,
        },
      );
    }
    seen.add(entry.issue);
    steps.push(step.data);
    stepIssues.push(entry.issue);
  }
  const plan: RepairPlan = { steps, stepIssues, warnings, modelCalls: meta.modelCalls };
  return agentOk(meta.usage === undefined ? plan : { ...plan, usage: meta.usage });
}

/**
 * Plans ONE §5.1 repair cycle:
 *
 *   issues (validator §11.1 + critic §23.3 shapes, mixed)
 *     → blocker/major filter, blockers first, ≤5 per cycle (§23.3)
 *     → §23.4 prompt (verbatim skeleton, ./prompt.js) + planning reply contract
 *     → injected model (one call, ONE retry on invalid output, §5.1/§23.3)
 *     → strict zod validation (tool allow-list, no add/delete layer ops)
 *     → RepairPlan: mini plan.steps for the executor + warnings.
 *
 * Never throws except a rethrown AbortError (§3.4 deadline — the caller maps
 * engine_timeout, critic-seam precedent); every other failure is a typed
 * AgentResult envelope and no provider message is ever echoed.
 */
export async function planRepairs(input: PlanRepairsInput): Promise<AgentResult<RepairPlan>> {
  const issues = z.array(repairIssueSchema).max(MAX_REPAIR_INPUT_ISSUES).safeParse(input.issues);
  if (!issues.success) {
    return agentErr(
      REPAIR_PLAN_INVALID_CODE,
      `repair planning input failed schema validation: ${formatSchemaIssues(issues.error).join("; ")}`,
      {
        hint: "Pass §11.1 validator rows and/or §23.3 critic rows (level|severity, code, layer?, fix).",
        retryable: false,
      },
    );
  }
  const context = repairContextSchema.safeParse(input.context);
  if (!context.success) {
    return agentErr(
      REPAIR_PLAN_INVALID_CODE,
      `repair context failed schema validation: ${formatSchemaIssues(context.error).join("; ")}`,
      {
        hint: "CONTEXT = layerTree (required), manifest?, palette?, validatorReport (§23.4).",
        retryable: false,
      },
    );
  }

  const fixList = buildFixList(issues.data.map(normalizeIssue));
  if (fixList.fixes.length === 0) {
    // Deterministic short-circuit: no blocker/major issue → no model call at
    // all (§11.2 minors never drive repair; §5.1 repair is never free-form).
    return agentOk({
      steps: [],
      stepIssues: [],
      warnings: [
        ...fixList.warnings,
        "no blocker/major issues to repair — no repair steps planned (§11.2).",
      ],
      modelCalls: 0,
    });
  }

  const basePrompt =
    buildRepairPrompt({
      fixes: fixList.fixes.map(toPromptFix),
      context: context.data,
    }) + REPAIR_PLANNING_CONTRACT;
  const signal = input.signal ?? new AbortController().signal;

  let usage: RepairUsage | undefined;
  let modelCalls = 0;
  let lastIssues: readonly string[] = ["the reply was not JSON"];
  for (let attempt = 0; attempt <= PLAN_RETRY_LIMIT; attempt += 1) {
    const prompt = attempt === 0 ? basePrompt : retryPrompt(basePrompt, lastIssues);
    let result: RepairModelResult;
    try {
      result = await input.model.complete(prompt, signal);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error; // §3.4 deadline — the caller maps engine_timeout.
      }
      return agentErr(
        "provider_unhealthy",
        "the repair model call failed before any output was produced",
        {
          hint: "Worker: fail over to the next same-class provider (§5.3) and retry the cycle.",
          retryable: true,
        },
      );
    }
    modelCalls += 1;
    usage = addUsage(usage, result.usage);
    const parsed = parseRepairPlanRaw(result.raw);
    if (parsed.ok) {
      return buildPlan(parsed.value, fixList, { modelCalls, usage });
    }
    lastIssues = parsed.issues;
  }
  return agentErr(
    REPAIR_PLAN_INVALID_CODE,
    `the repair model output failed schema validation after ${PLAN_RETRY_LIMIT + 1} attempt(s): ${lastIssues
      .slice(0, 3)
      .map((issue) => clip(issue, 120))
      .join("; ")}`,
    {
      hint: `The model must reply with {"applied":[{"issue","tool","args"}]} where tool is one of ${REPAIR_TOOLS.join(", ")}; impossible fixes use impossible:true + alternative.`,
      retryable: false,
    },
  );
}

/**
 * Wraps validated repair steps into a FULL §5.5 Plan (W6-B's ExecutorService
 * takes `ExecuteInput.plan: Plan`, phase "repairing"): intent `edit_layers`,
 * template null, empty assets/slots/palette/typography/checks, the repair
 * steps, and the run's tier. Only meaningful with ≥1 step (§5.5 steps min 1);
 * the worker skips repair execution entirely when a cycle produced none.
 */
export function buildRepairMiniPlan(
  steps: readonly PlanStep[],
  modelTier: PlanModelTier,
): AgentResult<Plan> {
  const validated = validatePlan({
    intent: "edit_layers",
    template: null,
    assets: [],
    slots: {},
    palette: [],
    typography: {},
    steps: [...steps],
    checks: [],
    model_tier: modelTier,
    notes_for_user: REPAIR_MINI_PLAN_NOTE,
  });
  if (!validated.ok) {
    return agentErr(
      REPAIR_PLAN_INVALID_CODE,
      `repair mini-plan failed the §5.5 schema: ${validated.issues.join("; ")}`,
      {
        hint: "Repair steps come from planRepairs; check plan.ts contract drift (steps min 1, model_tier enum).",
        retryable: false,
      },
    );
  }
  return agentOk(validated.plan);
}

/**
 * DI convenience wrapper: pin the model once, plan many cycles. The task-pinned
 * entry point remains the standalone planRepairs({ issues, context, model }).
 */
export class RepairPlanner {
  constructor(private readonly model: RepairModelLike) {}

  planRepairs(input: Omit<PlanRepairsInput, "model">): Promise<AgentResult<RepairPlan>> {
    return planRepairs({ ...input, model: this.model });
  }
}
