import { z } from "zod";
export declare const PLAN_INTENT_SCHEMA: z.ZodEnum<{
    render: "render";
    create: "create";
    edit: "edit";
    animate: "animate";
    style: "style";
    organize: "organize";
    explain: "explain";
    clarify: "clarify";
}>;
export type PlanIntent = z.infer<typeof PLAN_INTENT_SCHEMA>;
/** Risk badge (EDITOR_CHAT_UX §6.2): low = reversible/no deletion, medium = many
 * layers/effects, high = delete, replace footage, render/export, high credit spend. */
export declare const PLAN_RISK_SCHEMA: z.ZodEnum<{
    low: "low";
    medium: "medium";
    high: "high";
}>;
export type PlanRisk = z.infer<typeof PLAN_RISK_SCHEMA>;
/** Affected-layer row of the Plan card (§8.6). */
export declare const AFFECTED_LAYER_SCHEMA: z.ZodObject<{
    id: z.ZodOptional<z.ZodNumber>;
    name: z.ZodString;
    change: z.ZodString;
}, z.core.$strip>;
export type AffectedLayer = z.infer<typeof AFFECTED_LAYER_SCHEMA>;
/** One plan step: a tool call plus the batch it proposes (§8.6). */
export declare const PLAN_STEP_SCHEMA: z.ZodObject<{
    title: z.ZodString;
    tool: z.ZodString;
    args: z.ZodUnknown;
    batch: z.ZodObject<{
        label: z.ZodString;
        steps: z.ZodArray<z.ZodObject<{
            command: z.ZodString;
            params: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strip>;
export type PlanStep = z.infer<typeof PLAN_STEP_SCHEMA>;
/** §8.6 exact shape. Bounds: summary ≤ 280, affectedLayers ≤ 50, steps 1..20. */
export declare const EDIT_PLAN_SCHEMA: z.ZodObject<{
    intent: z.ZodEnum<{
        render: "render";
        create: "create";
        edit: "edit";
        animate: "animate";
        style: "style";
        organize: "organize";
        explain: "explain";
        clarify: "clarify";
    }>;
    summary: z.ZodString;
    risk: z.ZodEnum<{
        low: "low";
        medium: "medium";
        high: "high";
    }>;
    requiresApproval: z.ZodBoolean;
    affectedLayers: z.ZodArray<z.ZodObject<{
        id: z.ZodOptional<z.ZodNumber>;
        name: z.ZodString;
        change: z.ZodString;
    }, z.core.$strip>>;
    estimatedCredits: z.ZodNumber;
    steps: z.ZodArray<z.ZodObject<{
        title: z.ZodString;
        tool: z.ZodString;
        args: z.ZodUnknown;
        batch: z.ZodObject<{
            label: z.ZodString;
            steps: z.ZodArray<z.ZodObject<{
                command: z.ZodString;
                params: z.ZodRecord<z.ZodString, z.ZodUnknown>;
            }, z.core.$strip>>;
        }, z.core.$strip>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type EditPlan = z.infer<typeof EDIT_PLAN_SCHEMA>;
export declare const MAX_PLAN_STEPS = 20;
export declare const MAX_PLAN_AFFECTED_LAYERS = 50;
export declare const MAX_PLAN_SUMMARY_LENGTH = 280;
/** Ordinal for comparing risk levels. */
export declare const PLAN_RISK_ORDER: Readonly<Record<PlanRisk, number>>;
/** `true` when `risk` is at least as severe as `floor` (e.g. gate UI on medium+). */
export declare function isRiskAtLeast(risk: PlanRisk, floor: PlanRisk): boolean;
/** High risk renders a stronger border + an explicit confirm checkbox (§6.2). */
export declare function needsConfirmCheckbox(risk: PlanRisk): boolean;
/**
 * Auto-apply (§7.3, off by default) is limited to low-risk, reversible, in-place
 * intents. `render` is never auto-applied (render/export), `create`/`organize`
 * are structural, `clarify`/`explain` change nothing anyway.
 */
export declare const AUTO_APPLYABLE_INTENTS: readonly ["edit", "style", "animate"];
/** §7.3 gate: only low-risk, approval-free, non-render, in-place plans auto-apply. */
export declare function isAutoApplicable(plan: Readonly<EditPlan>): boolean;
/** Fixed per-run planning overhead (prompt + context assembly share). */
export declare const ESTIMATE_BASE_CREDITS = 1;
/** Marginal cost of each additional plan step. */
export declare const ESTIMATE_CREDITS_PER_STEP = 0.5;
/** Broader plans carry a review/context multiplier. */
export declare const ESTIMATE_RISK_MULTIPLIERS: Readonly<Record<PlanRisk, number>>;
/** §8.8: reserve `estimatedCredits * 1.2`, minimum 1. */
export declare const CREDIT_RESERVE_MULTIPLIER = 1.2;
export declare const CREDIT_RESERVE_MINIMUM = 1;
/** Deterministic credit estimate for a plan (see constants above). */
export declare function estimateCredits(plan: Readonly<Pick<EditPlan, "risk"> & {
    steps: readonly unknown[];
}>): number;
/** §8.8 reserve rule: `max(estimatedCredits × 1.2, 1)`, rounded to 2 decimals. */
export declare function reserveFor(estimatedCredits: number): number;
