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
 * Auto-apply (§7.3, off by default) is limited to low-risk, reversible, in-place
 * intents. `render` is never auto-applied (render/export), `create`/`organize`
 * are structural, `clarify`/`explain` change nothing anyway.
 */
export const AUTO_APPLYABLE_INTENTS = [
  "edit",
  "style",
  "animate",
] as const satisfies readonly PlanIntent[];

/** §7.3 gate: only low-risk, approval-free, non-render, in-place plans auto-apply. */
export function isAutoApplicable(plan: Readonly<EditPlan>): boolean {
  return (
    plan.risk === "low" &&
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
