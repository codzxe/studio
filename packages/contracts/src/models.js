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
];
export const MODEL_ID_SCHEMA = z.enum(MODEL_IDS);
/**
 * Illustrative descriptor catalog (§8.2 + §10.1). `studio-vision` is metered
 * separately; LiteLLM budgets are a second guardrail, not the ledger (§8.8).
 */
export const MODEL_CATALOG = {
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
export const PLAN_IDS = ["trial", "starter", "pro", "studio"];
export const PLAN_ID_SCHEMA = z.enum(PLAN_IDS);
/** Plans purchasable through Stripe Checkout (trial is never a checkout target). */
export const PAID_PLAN_IDS = ["starter", "pro", "studio"];
export const PAID_PLAN_ID_SCHEMA = z.enum(PAID_PLAN_IDS);
/**
 * Plan → model entitlements (§8.2 "Plan gating" + §10.1 Models column),
 * ALIGNED with the M6-A catalog (D-4/D-8, 2026-10-24): trial is a state on
 * the Starter row (fast only — pinned by the models route + billing E2E);
 * every paid plan gets fast+smart; studio-vision is NOT in the v1 picker
 * (D-8: reserved for the eval harness / vision critic).
 */
export const PLAN_MODEL_ENTITLEMENTS = {
    trial: ["studio-fast"],
    starter: ["studio-fast", "studio-smart"],
    pro: ["studio-fast", "studio-smart"],
    studio: ["studio-fast", "studio-smart"],
};
/** Models a plan member may select (§8.2). */
export function allowedModelsForPlan(plan) {
    return PLAN_MODEL_ENTITLEMENTS[plan];
}
/** `true` when `model` is selectable on `plan`. */
export function modelAllowedForPlan(model, plan) {
    return PLAN_MODEL_ENTITLEMENTS[plan].includes(model);
}
/** Fallback order within a plan: the last allowed tier, most capable first. */
export function defaultModelForPlan(plan) {
    const allowed = PLAN_MODEL_ENTITLEMENTS[plan];
    const last = allowed[allowed.length - 1];
    return last ?? "studio-fast";
}
//# sourceMappingURL=models.js.map