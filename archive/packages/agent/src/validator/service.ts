// @studio/agent — the validator half of the run lifecycle. Owner: W6-D
// (docs/AGENTS.md): this directory is the ONLY surface this task owns.
//
// Spec anchors:
//   §5.1  "Validate before critique": the deterministic validator runs FIRST
//         every cycle (cheap, exact); the vision critic runs only when
//         validation produced NO blocker — a blocker skips the critic or
//         narrows it to blockers (§23.3). This service classifies the tool
//         outcome; the routing itself is gate.ts (validateGate, §5.1 table).
//   §6.3  The validator is lint/typecheck: same document ⇒ same issues, same
//         order, no LLM. This file adds NO rules — the rule engine lives in
//         the validate_document tool (packages/tools/src/tools/
//         validate-document.ts, §11.1 check table); this service only BRIDGES
//         that tool's outcome into the run loop.
//   §5.4 item 6  The validator report from the previous cycle feeds the next
//         repair prompt: `ValidatorReport.summary` is the tool's §6.1 compact
//         JSON (guaranteed ≤2000 chars by the kit), passed through verbatim.
//   §11.1 Blockers gate the pipeline; blocker/major drive repair; minors are
//         user suggestions and never trigger a revision by themselves.
//   §6    validate_document is read-only: no budget charge, no idempotency
//         key, freely retryable — hence the one service-level retry below.
//   §21   Unit layer: the classification below is table-tested
//         (tests/validator/service.test.ts).
//
// Seams (minimal on purpose, fleet policy — cf. packages/tools types.ts):
//   - `ValidateToolLike`: ONE method. The worker wires the real §6 row 15
//     tool by closing over the tool context and abort signal:
//       run: (args) => validateDocument.run(ctx, args, signal)
//   - `ToolResult` / `ValidationIssue` / `ValidateDocumentArgs` come from
//     @studio/tools as TYPE-ONLY imports: this module stays runtime-pure
//     apart from zod, so tests fake the seam with plain objects.

import type { ToolOk, ToolResult, ValidateDocumentArgs, ValidationIssue } from "@studio/tools";
import { z } from "zod";
import { type AgentErrorCode, type AgentResult, agentErr, agentOk } from "../errors.js";

// ---------------------------------------------------------------------------
// The tool seam (§6 row 15 → run lifecycle)
// ---------------------------------------------------------------------------

/**
 * One-method structural seam over the validate_document tool. The worker
 * (run manager) supplies the real tool; tests supply fakes. `args` is exactly
 * the tool's strict §6.1 schema shape — `revision` deliberately has NO seat
 * here (the tool would reject an unknown key; §6.1 additionalProperties:false).
 */
export interface ValidateToolLike {
  run(args: ValidateDocumentArgs): Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// Input + output contracts
// ---------------------------------------------------------------------------

/** One validation cycle. Kept strict (§6.1 discipline) via `runValidateInputSchema`. */
export interface RunValidateInput {
  readonly documentId: string;
  /** `id@version` template pin; present ⇒ the engine's manifest-bound rules ran too (§7.4). */
  readonly template?: string;
  /**
   * The revision the caller is validating (the render's revision). NEVER sent
   * to the tool (its args schema has no such field); used to detect a stale
   * report when the tool reports the revision it actually linted.
   */
  readonly revision?: number;
}

/** §11.1 severity levels, as classified — identical strings to the tool's rows. */
export type ValidatorVerdict = "pass" | "blockers" | "warnings";

/** Per-level issue totals; the §5.1 gate reads these, not the visible row lists. */
export interface ValidatorIssueCounts {
  readonly blocker: number;
  readonly major: number;
  readonly minor: number;
}

/**
 * The classified §11.1 report the run loop consumes.
 *
 * `verdict` per §5.1: "blockers" gates the pipeline into repair; "warnings"
 * means nothing gates (critic runs on majors, minors recorded as suggestions);
 * "pass" is a clean document. A report with any blocker never says "pass".
 */
export interface ValidatorReport {
  readonly verdict: ValidatorVerdict;
  readonly documentId: string;
  /** Revision this verdict applies to: the tool-reported documentRevision, else the caller's pin. */
  readonly revision: number | undefined;
  /** The revision the caller asked to validate; kept for staleness detection. */
  readonly expectedRevision: number | undefined;
  /** Tool linted a different revision than the caller pinned — re-render + re-validate (§5.4). */
  readonly staleRevision: boolean;
  /** Actionable blocker rows (a capped subset of all blockers when truncated). */
  readonly blockers: readonly ValidationIssue[];
  /** Actionable major rows. */
  readonly majors: readonly ValidationIssue[];
  /** Minor rows — user suggestions, never gate, never revise alone (§11.1). */
  readonly minors: readonly ValidationIssue[];
  /**
   * Effective per-level totals: the larger of the tool's `issueCounts` (the
   * pre-cap truth) and the visible rows. Equal to the tool's counts in every
   * well-formed report; widened only under contract breach.
   */
  readonly counts: ValidatorIssueCounts;
  /** Tool + service notes (truncation, staleness, coherence); surfaced to the user. */
  readonly warnings: readonly string[];
  /** The tool capped/shed rows (§2.2 reply budgets): re-validate after repairs (§11.3). */
  readonly truncated: boolean;
  /** The template pin the tool echoed (undefined = generic arm). */
  readonly template: string | undefined;
  /** The tool's §6.1 compact JSON, verbatim — the §5.4 item 6 / §23.3 critic input. */
  readonly summary: string;
}

/** The tool's own input boundary (§6.1 strict, the fleet default here too). */
export const runValidateInputSchema = z.strictObject({
  documentId: z.string().uuid(),
  // Format (`id@version`) is the tool's zTemplateRef boundary — this service
  // passes the pin through and never second-guesses a tool-owned schema.
  template: z.string().min(1).optional(),
  revision: z.number().int().min(0).optional(),
});

// ---------------------------------------------------------------------------
// parseValidateSummary — the defensive reader for the §6.1 compact report
// ---------------------------------------------------------------------------

const summaryIssueRowSchema = z.object({
  level: z.enum(["blocker", "major", "minor"]),
  code: z.string().min(1),
  layer: z.string().optional(),
  message: z.string(),
  fix: z.string(),
});

const summaryCountsSchema = z.object({
  blocker: z.number().int().min(0),
  major: z.number().int().min(0),
  minor: z.number().int().min(0),
});

/**
 * The shape `renderSummary` (validate-document.ts) emits:
 * `{ ok, issueCounts, template?, issues, truncated }`. Loose object schemas on
 * purpose — unknown keys are stripped, never fatal (fleet defensive-reader
 * precedent: parseAskUserSummary, readValidateReport).
 */
export const validateSummarySchema = z.object({
  ok: z.boolean(),
  issueCounts: summaryCountsSchema,
  template: z.string().optional(),
  issues: z.array(summaryIssueRowSchema),
  truncated: z.boolean(),
});

/** The parsed tool summary — the §11.1 row/counts pair, schema-checked. */
export interface ParsedValidateSummary {
  readonly ok: boolean;
  readonly issueCounts: ValidatorIssueCounts;
  readonly issues: readonly ValidationIssue[];
  readonly truncated: boolean;
  readonly template: string | undefined;
}

/**
 * Recovers the §11.1 report from a tool result summary — for run-manager code
 * that only sees the §6.1 envelope. Anything malformed (or another tool's
 * summary) yields `undefined`; this never throws.
 */
export function parseValidateSummary(summary: string): ParsedValidateSummary | undefined {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(summary);
  } catch {
    return undefined;
  }
  const parsed = validateSummarySchema.safeParse(parsedJson);
  return parsed.success ? parsed.data : undefined;
}

// ---------------------------------------------------------------------------
// Classification (§5.1): rows → buckets, counts → verdict
// ---------------------------------------------------------------------------

/** The pure classification of one parsed summary (table-tested). */
export interface ClassifiedOutcome {
  readonly verdict: ValidatorVerdict;
  /** Effective per-level totals (see ValidatorReport.counts). */
  readonly counts: ValidatorIssueCounts;
  readonly blockers: readonly ValidationIssue[];
  readonly majors: readonly ValidationIssue[];
  readonly minors: readonly ValidationIssue[];
  /** False only under contract breach: visible rows exceed the reported counts. */
  readonly coherent: boolean;
}

/** §5.1 verdict ladder: any blocker gates; else any issue warns; else pass. */
function verdictFor(counts: ValidatorIssueCounts): ValidatorVerdict {
  if (counts.blocker > 0) return "blockers";
  if (counts.major + counts.minor > 0) return "warnings";
  return "pass";
}

/**
 * Classifies a parsed §11.1 report per §5.1:
 *   - any blocker ⇒ verdict "blockers" (gates the pipeline);
 *   - else any major/minor ⇒ "warnings" (nothing gates; the critic may run on
 *     majors, minors are recorded as user suggestions);
 *   - else "pass".
 * Counts are the pre-cap truth (`issueCounts`), so a truncated report still
 * classifies as blockers even when the visible rows were shed. Visible rows
 * widen the counts (never shrink them) as a determinism guard (§6.3).
 */
export function classifyOutcome(parsed: ParsedValidateSummary): ClassifiedOutcome {
  const blockers = parsed.issues.filter((issue) => issue.level === "blocker");
  const majors = parsed.issues.filter((issue) => issue.level === "major");
  const minors = parsed.issues.filter((issue) => issue.level === "minor");
  const counts: ValidatorIssueCounts = {
    blocker: Math.max(parsed.issueCounts.blocker, blockers.length),
    major: Math.max(parsed.issueCounts.major, majors.length),
    minor: Math.max(parsed.issueCounts.minor, minors.length),
  };
  const coherent =
    blockers.length <= parsed.issueCounts.blocker &&
    majors.length <= parsed.issueCounts.major &&
    minors.length <= parsed.issueCounts.minor;
  return { verdict: verdictFor(counts), counts, blockers, majors, minors, coherent };
}

// ---------------------------------------------------------------------------
// Tool-failure mapping (§13.3 stable codes; no stack, no internal ids)
// ---------------------------------------------------------------------------

/**
 * Tool failure code → agent error code. Documented choices:
 *   - engine_timeout → run_timeout (§3.4 tool timeout, not the run clock);
 *   - engine_unavailable/crashed/session_lost → engine_session_lost;
 *   - rate_limited/provider_unhealthy → provider_unhealthy;
 *   - not_found (template pin) → plan_invalid: the pin came from the §5.5
 *     plan payload, so an unknown pin is a plan defect, not a document one.
 * Everything else (validation_failed on an empty/unreadable document,
 * internal_error, arg failures) is a tool interaction that retrying THIS call
 * cannot repair: `tool_retry_exhausted` (§6.3 retry budget spent).
 */
const TOOL_FAILURE_TO_AGENT: Readonly<Record<string, AgentErrorCode>> = {
  engine_timeout: "run_timeout",
  engine_unavailable: "engine_session_lost",
  engine_crashed: "engine_session_lost",
  engine_session_lost: "engine_session_lost",
  rate_limited: "provider_unhealthy",
  provider_unhealthy: "provider_unhealthy",
  not_found: "plan_invalid",
};

const DEFAULT_TOOL_FAILURE_AGENT_CODE: AgentErrorCode = "tool_retry_exhausted";

/** ToolErr narrowed structurally: `{ ok: false, code, message, hint?, retryable? }`. */
interface ToolFailureShape {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly hint?: string;
  readonly retryable?: boolean;
}

function toolFailure(failure: ToolFailureShape): AgentResult<never> {
  const code = TOOL_FAILURE_TO_AGENT[failure.code] ?? DEFAULT_TOOL_FAILURE_AGENT_CODE;
  return agentErr(code, `Document validation failed: ${failure.message}`, {
    hint:
      failure.hint ??
      "The validator could not run; stop cleanly (§5.1 rollback) rather than critiquing an unvalidated document.",
    // Retryability passes through: the service already spent its own small
    // retry budget, but the LOOP owner (worker) still owns the run-level
    // retry budget (§6.3) and the §5.2 clean-stop rules.
    retryable: failure.retryable,
  });
}

// ---------------------------------------------------------------------------
// Report assembly (pure, over one ok tool result)
// ---------------------------------------------------------------------------

function reportFromToolResult(
  result: ToolOk,
  meta: { readonly documentId: string; readonly expectedRevision: number | undefined },
): AgentResult<ValidatorReport> {
  const parsed = parseValidateSummary(result.summary);
  if (parsed === undefined) {
    return agentErr(
      DEFAULT_TOOL_FAILURE_AGENT_CODE,
      "Document validation returned an unreadable report",
      {
        hint: "validate_document must summarize with the §6.1 compact JSON {ok, issueCounts, issues, truncated}.",
        retryable: false, // deterministic tool: a retry would reproduce it
      },
    );
  }
  const classified = classifyOutcome(parsed);

  const warnings = [...(result.warnings ?? [])];
  if (!classified.coherent) {
    warnings.push(
      "validator issue rows exceed the reported issueCounts; totals widened to the visible rows (§6.3 determinism guard)",
    );
  }
  const observed = result.documentRevision;
  const expected = meta.expectedRevision;
  const staleRevision = observed !== undefined && expected !== undefined && observed !== expected;
  if (staleRevision) {
    warnings.push(
      `validated revision ${observed} but the run expected ${expected}; re-render and re-validate before repairing (§5.4)`,
    );
  }

  return agentOk({
    verdict: classified.verdict,
    documentId: meta.documentId,
    revision: observed ?? expected,
    expectedRevision: expected,
    staleRevision,
    blockers: classified.blockers,
    majors: classified.majors,
    minors: classified.minors,
    counts: classified.counts,
    warnings,
    truncated: parsed.truncated,
    template: parsed.template,
    summary: result.summary,
  });
}

function firstIssueText(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue === undefined ? "payload rejected" : `${issue.path.join(".")}: ${issue.message}`;
}

// ---------------------------------------------------------------------------
// RunValidator — the §5.1 `validating` phase service
// ---------------------------------------------------------------------------

/**
 * Service-level retries for RETRYABLE tool failures within ONE validate()
 * call (§6: read-only, freely retryable). The worker may set 0 to own all
 * retries itself (§6.3 "the worker enforces a retry budget").
 */
export const DEFAULT_MAX_TOOL_RETRIES = 1;

export interface RunValidatorOptions {
  readonly tool: ValidateToolLike;
  readonly maxToolRetries?: number;
}

/**
 * Bridges the deterministic validate_document tool into the run lifecycle
 * (§5.1 `validating`). The validator runs BEFORE the critic every cycle:
 * this is the only service that produces `ValidatorReport`s, and the gate +
 * critic inputs (gate.ts) are derived from them — the worker structurally
 * cannot critique without first validating.
 */
export class RunValidator {
  private readonly tool: ValidateToolLike;
  private readonly maxToolRetries: number;

  constructor(options: RunValidatorOptions) {
    this.tool = options.tool;
    this.maxToolRetries = options.maxToolRetries ?? DEFAULT_MAX_TOOL_RETRIES;
    if (!Number.isInteger(this.maxToolRetries) || this.maxToolRetries < 0) {
      // Fail fast on hand-built deps (fleet precedent: BudgetTracker ctor).
      throw new RangeError("RunValidator: maxToolRetries must be a non-negative integer");
    }
  }

  /**
   * Runs one validation cycle and classifies the outcome per §5.1. Never
   * throws: tool failures come back as typed agent envelopes, tool successes
   * as `ValidatorReport`s feeding the gate, the critic (§23.3) and the next
   * repair prompt (§5.4 item 6).
   */
  async validate(input: RunValidateInput): Promise<AgentResult<ValidatorReport>> {
    const parsedInput = runValidateInputSchema.safeParse(input);
    if (!parsedInput.success) {
      return agentErr("plan_invalid", "The validator call payload failed schema validation", {
        hint: `${firstIssueText(parsedInput.error)} (§6.1 strict boundary)`,
        retryable: false,
      });
    }
    const { documentId, template, revision } = parsedInput.data;
    // `revision` is metadata for this service only — the tool's §6.1 args
    // schema rejects unknown keys, so it is never forwarded.
    const toolArgs: ValidateDocumentArgs =
      template === undefined ? { documentId } : { documentId, template };

    let attempt = 0;
    for (;;) {
      let outcome: ToolResult;
      try {
        outcome = await this.tool.run(toolArgs);
      } catch {
        // The defineTool boundary converts transport surprises to ToolErr
        // envelopes; a thrown error here means the SEAM broke, not the
        // document. The cause (stack/internal ids) never reaches the message.
        return agentErr(
          "engine_session_lost",
          "The validate_document tool call failed unexpectedly",
          {
            hint: "Check the worker's tool wiring (ctx/signal closure); the run must stop cleanly (§5.1).",
            retryable: false,
          },
        );
      }
      if (outcome.ok) {
        return reportFromToolResult(outcome, { documentId, expectedRevision: revision });
      }
      if (outcome.retryable === true && attempt < this.maxToolRetries) {
        attempt += 1;
        continue;
      }
      return toolFailure(outcome);
    }
  }
}
