// @studio/contracts — EditPlan schema (PRODUCT_ARCHITECTURE.md §8.6) exactly.
//
// The model returns a structured plan before any write; the gateway validates
// command ids/params/allowlist/limits server-side (§8.7) and the client shows
// the Plan card (risk, affected layers, credits — EDITOR_CHAT_UX §6.2).
//
// §8.6 note: the model may return `intent: "clarify"` with one question when
// the target is ambiguous. Never regenerate a whole composition when a
// targeted edit works.

import { z } from "zod";

import { BATCH_STEP_SCHEMA } from "./engine-batch.js";

// ---------------------------------------------------------------------------
// Leaf schemas (§8.6 exact)
// ---------------------------------------------------------------------------

export const PLAN_INTENT_SCHEMA = z.enum([
  "create",
  "edit",
  "animate",
  "style",
  "organize",
  "render",
  "explain",
  "clarify",
]);

export type PlanIntent = z.infer<typeof PLAN_INTENT_SCHEMA>;

/** Risk badge (EDITOR_CHAT_UX §6.2): low = reversible/no deletion, medium = many
 * layers/effects, high = delete, replace footage, render/export, high credit spend. */
export const PLAN_RISK_SCHEMA = z.enum(["low", "medium", "high"]);

export type PlanRisk = z.infer<typeof PLAN_RISK_SCHEMA>;

/** Affected-layer row of the Plan card (§8.6). */
export const AFFECTED_LAYER_SCHEMA = z.object({
  id: z.number().optional(),
  name: z.string(),
  change: z.string(),
});

export type AffectedLayer = z.infer<typeof AFFECTED_LAYER_SCHEMA>;

/** One plan step: a tool call plus the batch it proposes (§8.6). */
export const PLAN_STEP_SCHEMA = z.object({
  title: z.string(),
  tool: z.string(),
  args: z.unknown(),
  batch: z.object({
    label: z.string(),
    steps: z.array(BATCH_STEP_SCHEMA).min(1).max(100),
  }),
});

export type PlanStep = z.infer<typeof PLAN_STEP_SCHEMA>;

/** §8.6 exact shape. Bounds: summary ≤ 280, affectedLayers ≤ 50, steps 1..20. */
export const EDIT_PLAN_SCHEMA = z.object({
  intent: PLAN_INTENT_SCHEMA,
  summary: z.string().max(280),
  risk: PLAN_RISK_SCHEMA,
  requiresApproval: z.boolean(),
  affectedLayers: z.array(AFFECTED_LAYER_SCHEMA).max(50),
  estimatedCredits: z.number().nonnegative(),
  steps: z.array(PLAN_STEP_SCHEMA).min(1).max(20),
});

export type EditPlan = z.infer<typeof EDIT_PLAN_SCHEMA>;

export const MAX_PLAN_STEPS = 20;
export const MAX_PLAN_AFFECTED_LAYERS = 50;
export const MAX_PLAN_SUMMARY_LENGTH = 280;

// ---------------------------------------------------------------------------
// PlanRisk helpers (EDITOR_CHAT_UX §6.2, §7.3)
// ---------------------------------------------------------------------------

/** Ordinal for comparing risk levels. */
export const PLAN_RISK_ORDER: Readonly<Record<PlanRisk, number>> = {
  low: 0,
  medium: 1,
  high: 2,
};

/** `true` when `risk` is at least as severe as `floor` (e.g. gate UI on medium+). */
export function isRiskAtLeast(risk: PlanRisk, floor: PlanRisk): boolean {
  return PLAN_RISK_ORDER[risk] >= PLAN_RISK_ORDER[floor];
}

/** High risk renders a stronger border + an explicit confirm checkbox (§6.2). */
export function needsConfirmCheckbox(risk: PlanRisk): boolean {
  return risk === "high";
}

/**
 * Auto-apply (§7.3 v2 — round 10: the agent DOES the work by default) is
 * limited to reversible, in-place-or-additive intents. `render` is never
 * auto-applied (render/export), `organize` is structural review-worthy,
 * `clarify`/`explain` change nothing anyway. `create` became auto-applyable
 * because creating compositions/layers/keyframes is additive — one atomic
 * batch, one undo step — which is exactly the work users expect the agent
 * to just do.
 */
export const AUTO_APPLYABLE_INTENTS = [
  "create",
  "edit",
  "style",
  "animate",
] as const satisfies readonly PlanIntent[];

/**
 * §7.3 v2 gate (plan-shape predicate): reversible, approval-free,
 * non-render, non-reorganize plans. HIGH self-declared risk still waits;
 * the SERVER verdict (auto-apply.ts) re-judges every plan against the
 * RECOMPUTED values — this helper is the quick shape check, never authority.
 */
export function isAutoApplicable(plan: Readonly<EditPlan>): boolean {
  return (
    plan.risk !== "high" &&
    !plan.requiresApproval &&
    (AUTO_APPLYABLE_INTENTS as readonly string[]).includes(plan.intent)
  );
}

// ---------------------------------------------------------------------------
// Deterministic credit estimate (§8.8 reserve, §10.2)
// ---------------------------------------------------------------------------
//
// estimateCredits is a *deterministic pre-flight estimate* from the plan
// alone (no clocks, no model telemetry). The authoritative commit is the
// actual LiteLLM usage + render seconds + storage delta (§8.8); the reserve
// is this estimate × 1.2, minimum 1 (§8.8).
//
//   credits(plan) = round2((BASE + steps.length × PER_STEP) × RISK_MULTIPLIER[risk])
//
// Constants (documented; final pricing is a business decision, §10.1/§10.2):

/** Fixed per-run planning overhead (prompt + context assembly share). */
export const ESTIMATE_BASE_CREDITS = 1;

/** Marginal cost of each additional plan step. */
export const ESTIMATE_CREDITS_PER_STEP = 0.5;

/** Broader plans carry a review/context multiplier. */
export const ESTIMATE_RISK_MULTIPLIERS: Readonly<Record<PlanRisk, number>> = {
  low: 1,
  medium: 1.25,
  high: 1.5,
};

/** §8.8: reserve `estimatedCredits * 1.2`, minimum 1. */
export const CREDIT_RESERVE_MULTIPLIER = 1.2;
export const CREDIT_RESERVE_MINIMUM = 1;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Deterministic credit estimate for a plan (see constants above). */
export function estimateCredits(
  plan: Readonly<Pick<EditPlan, "risk"> & { steps: readonly unknown[] }>,
): number {
  const base = ESTIMATE_BASE_CREDITS + plan.steps.length * ESTIMATE_CREDITS_PER_STEP;
  return round2(base * ESTIMATE_RISK_MULTIPLIERS[plan.risk]);
}

/** §8.8 reserve rule: `max(estimatedCredits × 1.2, 1)`, rounded to 2 decimals. */
export function reserveFor(estimatedCredits: number): number {
  return round2(Math.max(estimatedCredits * CREDIT_RESERVE_MULTIPLIER, CREDIT_RESERVE_MINIMUM));
}

// ---------------------------------------------------------------------------
// Plan merging (round 12 — pure port of the gateway's mergedCarrierPlan)
// ---------------------------------------------------------------------------
//
// The client-driven loop (research/round12-design.md "TURN WIRE CONTRACT")
// accumulates one proposal carrier per write-tool call, then merges them into
// ONE plan and POSTs `/v1/runs/:id/apply { plan }` — the server RE-compiles
// authoritatively and re-judges the D-28 verdict, exactly like the existing
// apply drive. This is the EXACT semantics port of the gateway's
// `mergedCarrierPlan` (services/gateway/src/litellm/runner.ts, round-10 write-
// tool rescue — kept byte-identical so client and server can never disagree):
//   * undo_run carriers are EXCLUDED from additive batches (they compile to a
//     history command; the Undo gesture on an applied run's card is that
//     tool's real surface);
//   * `null` when nothing mergeable remains — fail-closed, the caller emits
//     nothing (the design doc's `mergeEditPlans(plans): EditPlan` shorthand
//     omits the server's null case; the server semantics win);
//   * `intent`: the first carrier's intent when ALL carriers agree, else
//     "edit";
//   * `summary`: the first carrier's, or `"<first> (+N more changes)"`,
//     clamped to MAX_PLAN_SUMMARY_LENGTH with an ellipsis;
//   * `risk`: the MAX across carriers (high wins, then medium);
//   * `requiresApproval`: false — no curated write tool is high-risk, the
//     compiler recomputes risk server-side anyway and the auto-apply policy
//     re-judges the COMPILED batch, never these self-declared fields;
//   * `affectedLayers`: dedup by name, §8.6-capped (≤ 50);
//   * `steps`: 1..20 (§8.6 — merged breadth is capped, never unbounded),
//     undo_run already excluded upstream;
//   * `estimatedCredits`: recomputed from the merged shape, never summed.

/** Clamp to §8.6's summary bound with an ellipsis (server parity). */
function clampSummary(value: string): string {
  return value.length <= MAX_PLAN_SUMMARY_LENGTH
    ? value
    : `${value.slice(0, MAX_PLAN_SUMMARY_LENGTH - 1)}…`;
}

/**
 * Merge accumulated proposal carriers into ONE EditPlan (pure; total, never
 * throws). `null` when nothing mergeable remains — every carrier is an
 * undo_run carrier or the list is empty (exact `mergedCarrierPlan` parity).
 */
export function mergeEditPlans(plans: readonly EditPlan[]): EditPlan | null {
  const mergeable = plans.filter((plan) => plan.steps[0]?.tool !== "studio.undo_run");
  if (mergeable.length === 0) return null;

  const intents = new Set(mergeable.map((plan) => plan.intent));
  const first = mergeable[0] as EditPlan;
  const intent: PlanIntent = intents.size === 1 ? first.intent : "edit";
  const summary =
    mergeable.length > 1
      ? clampSummary(`${first.summary} (+${mergeable.length - 1} more changes)`)
      : first.summary;

  let risk: PlanRisk = "low";
  for (const plan of mergeable) {
    if (plan.risk === "high") risk = "high";
    else if (plan.risk === "medium" && risk !== "high") risk = "medium";
  }

  // Dedup by name, §8.6-capped (≤ 50 rows for the card).
  const affectedLayers: Array<{ name: string; change: string }> = [];
  for (const plan of mergeable) {
    for (const layer of plan.affectedLayers) {
      if (affectedLayers.length >= MAX_PLAN_AFFECTED_LAYERS) break;
      if (!affectedLayers.some((row) => row.name === layer.name)) {
        affectedLayers.push({ name: layer.name, change: layer.change });
      }
    }
  }

  // §8.6: 1..20 steps — merged breadth is capped, never unbounded.
  const steps = mergeable.flatMap((plan) => [...plan.steps]).slice(0, MAX_PLAN_STEPS);

  const merged = {
    intent,
    summary,
    risk,
    requiresApproval: false,
    affectedLayers,
    estimatedCredits: estimateCredits({ risk, steps }),
    steps,
  };
  const parsed = EDIT_PLAN_SCHEMA.safeParse(merged);
  return parsed.success ? parsed.data : null;
}
