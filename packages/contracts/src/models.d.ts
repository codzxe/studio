import { z } from "zod";
export declare const MODEL_IDS: readonly ["studio-fast", "studio-smart", "studio-vision"];
export declare const MODEL_ID_SCHEMA: z.ZodEnum<{
    "studio-fast": "studio-fast";
    "studio-smart": "studio-smart";
    "studio-vision": "studio-vision";
}>;
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
export declare const MODEL_CATALOG: Readonly<Record<ModelId, ModelDescriptor>>;
export declare const PLAN_IDS: readonly ["trial", "starter", "pro", "studio"];
export declare const PLAN_ID_SCHEMA: z.ZodEnum<{
    trial: "trial";
    starter: "starter";
    pro: "pro";
    studio: "studio";
}>;
export type PlanId = z.infer<typeof PLAN_ID_SCHEMA>;
/** Plans purchasable through Stripe Checkout (trial is never a checkout target). */
export declare const PAID_PLAN_IDS: readonly ["starter", "pro", "studio"];
export declare const PAID_PLAN_ID_SCHEMA: z.ZodEnum<{
    starter: "starter";
    pro: "pro";
    studio: "studio";
}>;
/**
 * Plan → model entitlements (§8.2 "Plan gating" + §10.1 Models column),
 * ALIGNED with the M6-A catalog (D-4/D-8, 2026-10-24): trial is a state on
 * the Starter row (fast only — pinned by the models route + billing E2E);
 * every paid plan gets fast+smart; studio-vision is NOT in the v1 picker
 * (D-8: reserved for the eval harness / vision critic).
 */
export declare const PLAN_MODEL_ENTITLEMENTS: Readonly<Record<PlanId, readonly ModelId[]>>;
/** Models a plan member may select (§8.2). */
export declare function allowedModelsForPlan(plan: PlanId): readonly ModelId[];
/** `true` when `model` is selectable on `plan`. */
export declare function modelAllowedForPlan(model: ModelId, plan: PlanId): boolean;
/** Fallback order within a plan: the last allowed tier, most capable first. */
export declare function defaultModelForPlan(plan: PlanId): ModelId;
