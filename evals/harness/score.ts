// evals/harness — the §7.2 SCORING HARNESS (skeleton, vitest-runnable).
//
// Six scoring dimensions per BUILD_PLAN §7.2:
//   plan validity · apply success · visual sanity · undo success ·
//   credits accuracy · latency
// Targets: ≥ 90% valid plans, ≥ 95% apply success on valid plans.
//
// Design: `scoreRun`/`aggregate` are PURE functions over an ObservedRun —
// a transcript of what actually happened for one golden prompt (plan event,
// apply result, frame compare, undo result, credit delta, timings). The
// transport that PRODUCES ObservedRuns is the live runner:
//
//   runLiveSuite() — LIVE MODEL SCORING. Requires a DEPLOYED LiteLLM
//   gateway (MOCK_MODEL=false, LITELLM_BASE_URL reachable; see
//   docker-compose.litellm.yml) plus a seeded project per fixture. It is
//   skip-guarded behind EVALS_LIVE=1 and, in this skeleton, returns a typed
//   NOT_IMPLEMENTED marker for the transport step — wiring the SSE chat →
//   plan event → apply route → render_preview → undo loop is owed to the
//   first live-model run (W3 hand-off; the gateway chat-loop harness
//   technique in services/gateway/tests/chat-loop.test.ts is the template).
//
// What runs GREEN today, on-box, with zero dependencies: the schema-integrity
// suite (manifest.test.ts) — every prompt parses, ids are unique, all §7.2
// categories are covered, ≥30 prompts, tool references resolve against the
// REAL contracts, and the scoring stubs behave deterministically on
// synthetic transcripts.

import { MANIFEST, PROMPTS, premiseFacts, validateManifest } from "./manifest";
import type { GoldenPrompt } from "./types";

// ---------------------------------------------------------------------------
// §7.2 scoring dimensions + targets
// ---------------------------------------------------------------------------

export type ScoreDimension =
  | "validity" // plan is schema-valid AND semantically golden for the prompt
  | "apply" // the approved plan applies atomically (batch succeeds end-to-end)
  | "visual" // a rendered frame matches the golden expectation (frame compare)
  | "undo" // one undo step reverts the whole applied run (law #6)
  | "credits" // charged credits match the server estimate (§8.8)
  | "latency"; // first token / plan validation within §6 budgets

export const SCORE_DIMENSIONS: readonly ScoreDimension[] = [
  "validity",
  "apply",
  "visual",
  "undo",
  "credits",
  "latency",
];

/** §7.2 targets. */
export const VALIDITY_TARGET = 0.9; // ≥ 90% valid plans
export const APPLY_TARGET = 0.95; // ≥ 95% apply success on valid plans

/** §6 budgets used by the latency stub (p75). */
export const FIRST_TOKEN_BUDGET_MS = 1500;
export const PLAN_VALIDATION_BUDGET_MS = 100;
export const APPLY_BUDGET_MS = 300;

/** Credits stub tolerance: charged must equal estimate ± this (float cents). */
export const CREDIT_TOLERANCE = 0.01;

// ---------------------------------------------------------------------------
// ObservedRun — what actually happened for one golden prompt
// ---------------------------------------------------------------------------

/** Transcript of one live run against one golden prompt. */
export interface ObservedRun {
  readonly promptId: string;

  // -- validity ------------------------------------------------------------
  /** A plan event arrived (false for clarify/refuse/explain runs by design). */
  readonly planEmitted: boolean;
  /** The emitted EditPlan passed EDIT_PLAN_SCHEMA + compiled (no fatal issue). */
  readonly planSchemaValid: boolean;
  /**
   * Semantic golden match vs expectedBehavior (tools proposed, intent,
   * clarify-question, refusal-without-plan, scope confirmation, …).
   * null = the dimension does not apply to this prompt's behavior type.
   */
  readonly behaviorMatch: boolean | null;

  // -- apply ---------------------------------------------------------------
  /** The plan applied atomically (all compiled commands succeeded). */
  readonly applied: boolean;
  readonly applyError: string | null;

  // -- visual --------------------------------------------------------------
  /** Frame compare against the golden expectation (null = not measured). */
  readonly frameComparePassed: boolean | null;

  // -- undo -----------------------------------------------------------------
  /** One undo step reverted the whole applied run (batch fold, law #6). */
  readonly undone: boolean;

  // -- credits ----------------------------------------------------------------
  readonly estimatedCredits: number | null;
  readonly chargedCredits: number | null;

  // -- latency ------------------------------------------------------------------
  /** Chat first-token latency in ms (null = not measured). */
  readonly firstTokenMs: number | null;
  /** Plan validation (schema + compile) latency in ms. */
  readonly planValidationMs: number | null;
}

/** A blank transcript for a run that never reached the model (e.g. refusal). */
export function refusedRun(promptId: string): ObservedRun {
  return {
    promptId,
    planEmitted: false,
    planSchemaValid: false,
    behaviorMatch: null,
    applied: false,
    applyError: null,
    frameComparePassed: null,
    undone: false,
    estimatedCredits: null,
    chargedCredits: null,
    firstTokenMs: null,
    planValidationMs: null,
  };
}

// ---------------------------------------------------------------------------
// Per-dimension scoring functions (stubs — pure, deterministic)
// ---------------------------------------------------------------------------

/** Plan validity: schema-valid AND semantically golden (null = n/a). */
export function scoreValidity(run: ObservedRun): boolean | null {
  if (run.behaviorMatch === null) return null;
  // For plan-type prompts both must hold; for clarify/refuse/explain runs the
  // behaviorMatch already encodes "no invalid plan was produced".
  if (run.planEmitted) return run.planSchemaValid && run.behaviorMatch === true;
  return run.behaviorMatch === true;
}

/** Apply success: the plan applied atomically (null = no plan to apply). */
export function scoreApply(run: ObservedRun): boolean | null {
  if (!run.planEmitted || run.behaviorMatch === null) return null;
  if (!run.planSchemaValid) return false;
  return run.applied && run.applyError === null;
}

/** Visual sanity: rendered frame matches the golden expectation (null = n/a). */
export function scoreVisual(run: ObservedRun): boolean | null {
  return run.frameComparePassed;
}

/** Undo success: one undo step reverted the whole applied run (null = n/a). */
export function scoreUndo(run: ObservedRun): boolean | null {
  if (!run.applied) return null;
  return run.undone;
}

/** Credits accuracy: charged == estimated ± tolerance (null = n/a). */
export function scoreCredits(run: ObservedRun): boolean | null {
  if (run.estimatedCredits === null || run.chargedCredits === null) return null;
  return Math.abs(run.estimatedCredits - run.chargedCredits) <= CREDIT_TOLERANCE;
}

/** Latency: first token + plan validation within §6 budgets (null = n/a). */
export function scoreLatency(run: ObservedRun): boolean | null {
  if (run.firstTokenMs === null && run.planValidationMs === null) return null;
  if (run.firstTokenMs !== null && run.firstTokenMs > FIRST_TOKEN_BUDGET_MS) return false;
  if (run.planValidationMs !== null && run.planValidationMs > PLAN_VALIDATION_BUDGET_MS) {
    return false;
  }
  return true;
}

/** All six dimension scores for one run (null = not applicable). */
export interface DimensionScores {
  readonly validity: boolean | null;
  readonly apply: boolean | null;
  readonly visual: boolean | null;
  readonly undo: boolean | null;
  readonly credits: boolean | null;
  readonly latency: boolean | null;
}

/** Score one observed run across all six §7.2 dimensions. */
export function scoreRun(run: ObservedRun): DimensionScores {
  return {
    validity: scoreValidity(run),
    apply: scoreApply(run),
    visual: scoreVisual(run),
    undo: scoreUndo(run),
    credits: scoreCredits(run),
    latency: scoreLatency(run),
  };
}

// ---------------------------------------------------------------------------
// Aggregation (§7.2 targets)
// ---------------------------------------------------------------------------

export interface EvalSummary {
  readonly promptCount: number;
  readonly validityRate: number; // valid plans / scored
  readonly applyRate: number; // apply success / valid plans
  readonly visualRate: number | null;
  readonly undoRate: number | null;
  readonly creditsRate: number | null;
  readonly latencyRate: number | null;
  readonly meetsValidityTarget: boolean;
  readonly meetsApplyTarget: boolean;
}

function rate(passed: number, total: number): number {
  return total === 0 ? 0 : passed / total;
}

/**
 * Aggregate scored runs into the §7.2 report. The apply rate denominator is
 * VALID plans only (per §7.2: "apply success on valid plans").
 */
export function aggregate(scorings: readonly DimensionScores[]): EvalSummary {
  let valid = 0;
  let validityScored = 0;
  let applied = 0;
  let applyScored = 0; // valid plans that could apply
  const counts = { visual: 0, undo: 0, credits: 0, latency: 0 };
  const totals = { visual: 0, undo: 0, credits: 0, latency: 0 };

  for (const scores of scorings) {
    if (scores.validity !== null) {
      validityScored += 1;
      if (scores.validity) valid += 1;
    }
    if (scores.apply !== null) {
      // Apply denominator = valid plans (an invalid plan cannot honestly apply).
      if (scores.validity === true) {
        applyScored += 1;
        if (scores.apply) applied += 1;
      }
    }
    for (const dim of ["visual", "undo", "credits", "latency"] as const) {
      const score = scores[dim];
      if (score !== null) {
        totals[dim] += 1;
        if (score) counts[dim] += 1;
      }
    }
  }

  const nullable = (dim: "visual" | "undo" | "credits" | "latency"): number | null =>
    totals[dim] === 0 ? null : rate(counts[dim], totals[dim]);

  return {
    promptCount: scorings.length,
    validityRate: rate(valid, validityScored),
    applyRate: applyScored === 0 ? 0 : rate(applied, applyScored),
    visualRate: nullable("visual"),
    undoRate: nullable("undo"),
    creditsRate: nullable("credits"),
    latencyRate: nullable("latency"),
    meetsValidityTarget: validityScored > 0 && rate(valid, validityScored) >= VALIDITY_TARGET,
    meetsApplyTarget: applyScored > 0 && rate(applied, applyScored) >= APPLY_TARGET,
  };
}

// ---------------------------------------------------------------------------
// Live runner — skip-guarded behind EVALS_LIVE=1 (requires LiteLLM)
// ---------------------------------------------------------------------------

export interface LiveSuiteResult {
  readonly skipped: boolean;
  readonly reason?: string;
  readonly summary?: EvalSummary;
}

/**
 * Run the whole corpus against a LIVE model through the deployed gateway.
 *
 * REQUIRES LITELLM: a running gateway with MOCK_MODEL=false and a reachable
 * LITELLM_BASE_URL (docker-compose.litellm.yml), plus a seeded project per
 * fixture (the harness stages comps/layers per manifest fixtures, sends each
 * prompt over the chat SSE route, captures the plan event, compiles +
 * applies, renders a comparison frame, undoes, and records credit deltas).
 *
 * Guarded behind EVALS_LIVE=1 so the default `vitest run` stays hermetic.
 */
export async function runLiveSuite(): Promise<LiveSuiteResult> {
  if (process.env.EVALS_LIVE !== "1") {
    return {
      skipped: true,
      reason:
        "EVALS_LIVE is not set — live scoring requires a deployed LiteLLM gateway " +
        "(MOCK_MODEL=false + LITELLM_BASE_URL). Run: EVALS_LIVE=1 pnpm exec vitest run.",
    };
  }

  // Transport not wired yet (W3-C10 skeleton): the chat-loop harness
  // technique (services/gateway/tests/chat-loop.test.ts) is the template.
  // Owed: SSE chat → plan event capture → compile → apply → frame compare →
  // undo → credit ledger read, per prompt, feeding ObservedRun + aggregate().
  throw new Error(
    "Live transport not implemented yet — requires LiteLLM; see evals/README.md " +
      "(current state: harness skeleton, live-model runs owed).",
  );
}

// ---------------------------------------------------------------------------
// Corpus sanity for callers: refuse to score a broken manifest
// ---------------------------------------------------------------------------

/** Throws when the manifest fails schema integrity (fail-closed). */
export function assertCorpusIntegrity(): readonly GoldenPrompt[] {
  const issues = validateManifest();
  if (issues.length > 0) {
    const first = issues
      .slice(0, 5)
      .map((issue) => `${issue.promptId}.${issue.field}: ${issue.problem}`)
      .join("; ");
    throw new Error(`Golden prompt corpus failed integrity (${issues.length} issues): ${first}`);
  }
  if (PROMPTS.length < 30) {
    throw new Error(`§7.2 requires ≥30 golden prompts; manifest has ${PROMPTS.length}`);
  }
  return PROMPTS;
}

/** Premise facts re-exported for the integrity suite (camera/delete/credits). */
export { premiseFacts, MANIFEST };
