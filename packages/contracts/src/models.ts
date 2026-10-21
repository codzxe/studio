// @studio/contracts — model routing surface (PRODUCT_ARCHITECTURE.md §8.2)
// and plan entitlements (§10.1).
//
// LiteLLM exposes stable aliases; the wire contracts only need the ids and the
// plan-gating map. Illustrative credit rates live here so every service shares
// one constant; final pricing is a business decision owned by billing (§10.2).

import { z } from "zod";

// ---------------------------------------------------------------------------
// Model ids (§8.2 aliases)
// ---------------------------------------------------------------------------

export const MODEL_IDS = [
  "studio-fast",
  "studio-smart",
  "studio-vision",
] as const satisfies readonly string[];

export const MODEL_ID_SCHEMA = z.enum(MODEL_IDS);

export type ModelId = z.infer<typeof MODEL_ID_SCHEMA>;

export type ModelTier = "fast" | "smart" | "vision";

export interface ModelDescriptor {
  readonly id: ModelId;
  readonly tier: ModelTier;
  /** Use cases, mirrored from §8.2 for model-facing prompts. */
  readonly use: string;
  /** Illustrative metered rate (credits per 1k input tokens). */
  readonly creditsPer1kInput: number;
  /** Illustrative metered rate (credits per 1k output tokens). */
  readonly creditsPer1kOutput: number;
  /** Plans whose members may select this model (§10.1). */
  readonly allowedPlans: readonly PlanId[];
}

/**
 * Illustrative descriptor catalog (§8.2 + §10.1). `studio-vision` is metered
 * separately; LiteLLM budgets are a second guardrail, not the ledger (§8.8).
 */
export const MODEL_CATALOG: Readonly<Record<ModelId, ModelDescriptor>> = {
  "studio-fast": {
    id: "studio-fast",
    tier: "fast",
    use: "Cheap planning, classification, quick edits",
    creditsPer1kInput: 0.01,
    creditsPer1kOutput: 0.03,
    allowedPlans: ["trial", "starter", "pro", "studio"],
  },
  "studio-smart": {
    id: "studio-smart",
    tier: "smart",
    use: "Main agent, multi-step edits, tool use",
    creditsPer1kInput: 0.1,
    creditsPer1kOutput: 0.4,
    allowedPlans: ["pro", "studio"],
  },
  "studio-vision": {
    id: "studio-vision",
    tier: "vision",
    use: "Frame/screenshot understanding",
    creditsPer1kInput: 0.25,
    creditsPer1kOutput: 0.5,
    allowedPlans: ["studio"],
  },
};

// ---------------------------------------------------------------------------
// Plans (§10.1 illustrative: trial / starter / pro / studio)
// ---------------------------------------------------------------------------

export const PLAN_IDS = ["trial", "starter", "pro", "studio"] as const satisfies readonly string[];

export const PLAN_ID_SCHEMA = z.enum(PLAN_IDS);

export type PlanId = z.infer<typeof PLAN_ID_SCHEMA>;

/** Plans purchasable through Stripe Checkout (trial is never a checkout target). */
export const PAID_PLAN_IDS = ["starter", "pro", "studio"] as const satisfies readonly PlanId[];

export const PAID_PLAN_ID_SCHEMA = z.enum(PAID_PLAN_IDS);

/**
 * Plan → model entitlements (§8.2 "Plan gating" + §10.1 Models column):
 * trial→fast, starter→fast, pro→fast+smart, studio→all.
 */
export const PLAN_MODEL_ENTITLEMENTS: Readonly<Record<PlanId, readonly ModelId[]>> = {
  trial: ["studio-fast"],
  starter: ["studio-fast"],
  pro: ["studio-fast", "studio-smart"],
  studio: ["studio-fast", "studio-smart", "studio-vision"],
};

/** Models a plan member may select (§8.2). */
export function allowedModelsForPlan(plan: PlanId): readonly ModelId[] {
  return PLAN_MODEL_ENTITLEMENTS[plan];
}

/** `true` when `model` is selectable on `plan`. */
export function modelAllowedForPlan(model: ModelId, plan: PlanId): boolean {
  return PLAN_MODEL_ENTITLEMENTS[plan].includes(model);
}

/** Fallback order within a plan: the last allowed tier, most capable first. */
export function defaultModelForPlan(plan: PlanId): ModelId {
  const allowed = PLAN_MODEL_ENTITLEMENTS[plan];
  const last = allowed[allowed.length - 1];
  return last ?? "studio-fast";
}
