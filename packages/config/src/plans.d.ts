declare const PLAN_ID_UNION: readonly ["trial", "starter", "pro", "studio"];
/** Machine ids of every billing tier, including the trial state (D-4). */
export type PlanId = (typeof PLAN_ID_UNION)[number];
/**
 * Every plan id this build can encounter from external systems (DB rows,
 * Stripe metadata, config files) — "plausible" until narrowed by
 * {@link isPlausiblePlanId}. Frozen; mirrors the catalog keys 1:1.
 */
export declare const PLAUSIBLE_PLAN_IDS: readonly PlanId[];
/** The purchasable tiers — also the D-4 pricing-page display list. */
export declare const PRICING_PAGE_PLANS: readonly ["starter", "pro", "studio"];
/** Paid plan ids (`PRICING_PAGE_PLANS[0] | …`). Trial is never one (D-4). */
export type PaidPlanId = (typeof PRICING_PAGE_PLANS)[number];
/** Type guard: narrows external strings (webhooks, DB) to {@link PlanId}. */
export declare function isPlausiblePlanId(value: string): value is PlanId;
/** `true` only for starter/pro/studio — trial and unknown ids are not paid. */
export declare function isPaidPlan(id: string): boolean;
/**
 * Model ids referenced by plan entitlements. MUST equal
 * `@studio/contracts` `MODEL_IDS` / `MODEL_CATALOG` keys
 * (studio-fast / studio-smart / studio-vision); the colocated test pins the
 * literals. Duplicated only because @studio/config deliberately has no
 * dependency on @studio/contracts.
 */
export declare const PLAN_MODEL_IDS: readonly ["studio-fast", "studio-smart", "studio-vision"];
/** One of the three model ids (mirror type — see {@link PLAN_MODEL_IDS}). */
export type PlanModelId = (typeof PLAN_MODEL_IDS)[number];
/** 1 credit = 1,000,000 µc — the ledger stores integer microcredits (D-12). */
export declare const MICROCREDITS_PER_CREDIT: 1000000;
/**
 * Converts a credit amount to integer microcredits (D-12).
 * Accepts up to 6 decimals of a credit; rejects negative, non-finite or
 * sub-µc amounts with a typed StudioError ("no floats in ledger math").
 * The epsilon round-trip rejects sub-µc precision without breaking on
 * binary-float artifacts of legitimate 2-decimal amounts (0.01 → 10,000 µc).
 */
export declare function creditsToMicrocredits(credits: number): number;
/**
 * Converts integer microcredits to whole credits with up to 2 decimals —
 * the D-12 rule for API/UI display at the route boundary. Non-integer or
 * negative inputs are rejected with a typed StudioError.
 */
export declare function microcreditsToCredits(microcredits: number): number;
/** One billing tier's full descriptor (identity + display + entitlements). */
export interface PlanDescriptor {
    /** Machine id (matches the catalog key). */
    readonly id: PlanId;
    /** Display name (UI_DS §14 — "Starter", "Pro", "Studio"; trial is a state). */
    readonly name: string;
    /** Seat limit enforced server-side on invite/accept. */
    readonly seats: number;
    /**
     * Model ids selectable in the picker. D-8: `studio-vision` is never
     * listed (reserved for the eval harness / vision critic).
     */
    readonly models: readonly PlanModelId[];
    /** Max projects per workspace. BUSINESS-PENDING — illustrative M6 numbers. */
    readonly maxProjects: number;
    /** Storage quota in bytes (binary GiB/TiB math). */
    readonly storageBytes: number;
    /** Cloud render minutes per billing month. */
    readonly renderMinutesPerMonth: number;
    /** Simultaneous queued/running renders per workspace (M8). */
    readonly maxConcurrentRenders: number;
    /** Long-edge px cap a plan may request (≤ 3840, the pricing ceiling). */
    readonly maxRenderLongEdgePx: number;
    /** Days finished render outputs are retained and downloadable (M8). */
    readonly renderRetentionDays: number;
    /**
     * Monthly credit allowance in INTEGER microcredits (D-12).
     * Round M6 numbers: 50 / 500 / 2,000 / 10,000 credits.
     */
    readonly monthlyCreditAllowance: number;
    /** Trial length in days — 14 on the trial row, `null` on paid plans (D-4). */
    readonly trialDays: number | null;
    /**
     * Monthly display price in integer cents. BUSINESS-PENDING — illustrative
     * placeholders (Starter $12, Pro $39, Studio $99); final pricing is a
     * business decision (PA §10.1). Annual discounts land with M6 Stripe work.
     */
    readonly monthlyPriceCents: number;
    /**
     * Key into the `STRIPE_PRICE_IDS` env map (env.ts documents the JSON
     * shape). `null` for trial — a state, never a checkout target (D-4).
     * Paid rows resolve their Stripe price id through this key at checkout.
     */
    readonly stripePriceKey: PaidPlanId | null;
}
/** The per-tier entitlement subset consumed by server-side checks. */
export interface Entitlements {
    readonly seats: number;
    readonly models: readonly PlanModelId[];
    readonly maxProjects: number;
    readonly storageBytes: number;
    readonly renderMinutesPerMonth: number;
    readonly maxConcurrentRenders: number;
    readonly maxRenderLongEdgePx: number;
    readonly renderRetentionDays: number;
    readonly monthlyCreditAllowance: number;
}
/** The four tiers keyed by machine id. Deep-frozen — never mutate. */
export declare const PLAN_CATALOG: Readonly<Record<PlanId, PlanDescriptor>>;
/**
 * Descriptor for a plan id. Runtime values from webhooks/DB may be unknown
 * strings — those throw a typed `StudioError` (`VALIDATION_FAILED`) whose
 * message never echoes the raw id.
 */
export declare function getPlan(id: string): PlanDescriptor;
/**
 * Frozen entitlement bundle for a plan (the subset servers enforce).
 * Unknown ids throw the same typed error as {@link getPlan}. Each call
 * returns a fresh frozen object; the `models` array is the catalog's frozen
 * reference (safe to share).
 */
export declare function entitlementsFor(id: string): Entitlements;
/**
 * Remaining cloud-render minutes this billing month for a plan, clamped at
 * zero — the pure arithmetic half of the `renderMinutesPerMonth` gate. The
 * GATEWAY owns enforcement (it tracks each workspace's billed minutes and
 * refuses new renders at zero); this helper exists so the refusal threshold
 * and the UI's "minutes left" readout can never drift from the catalog.
 * Unknown plan ids throw the same typed error as {@link getPlan}; negative
 * or non-finite usage throws `VALIDATION_FAILED`.
 */
export declare function renderMinutesRemaining(planId: string, minutesUsedThisMonth: number): number;
/**
 * Picker gate: `true` iff `modelId` is selectable on `planId`.
 * Fails CLOSED — unknown plan ids and unknown model ids are `false`, never
 * a throw, so route guards can `if (!maxModelTier(...)) { … }`.
 * D-8: `studio-vision` is `false` on every tier in v1 (the models route
 * shows trial ⇒ exactly [studio-fast] through this gate).
 */
export declare function maxModelTier(planId: string, modelId: string): boolean;
declare const RENDER_FORMAT_IDS: readonly ["mp4", "png-seq", "prores", "gif", "wav"];
/** Wire format ids — mirror of `@studio/contracts` RENDER_FORMATS. */
export type RenderFormatId = (typeof RENDER_FORMAT_IDS)[number];
/** One render format on the entitlement side: enabled or reserved (D-2). */
export interface RenderFormatDescriptor {
    readonly id: RenderFormatId;
    /** UI label (UI_DS §14 wording). */
    readonly label: string;
    /**
     * D-2: v1 enables MP4 (H.264) + PNG sequence only. Reserved formats stay
     * declared (the wire union in contracts accepts them) but the worker
     * rejects them with a typed error until enabled here.
     */
    readonly enabled: boolean;
}
/** Render formats per D-2 — MP4 + PNG sequence enabled; ProRes/GIF/WAV reserved. */
export declare const RENDER_FORMATS: readonly RenderFormatDescriptor[];
/** The v1-enabled format ids, derived from {@link RENDER_FORMATS}. */
export declare const ENABLED_RENDER_FORMATS: readonly RenderFormatId[];
/** `true` iff the format id exists and is enabled (D-2). Fails closed. */
export declare function isRenderFormatEnabled(id: string): boolean;
/** Why a Stripe price lookup failed. Add-only; never rename or reuse. */
export type StripePriceIdProblemKind = "missing-env" | "invalid-json" | "invalid-map" | "unknown-plan" | "plan-not-purchasable" | "plan-without-price";
/** One typed lookup failure. `message` is log-safe; it never echoes raw env values. */
export interface StripePriceIdProblem {
    readonly kind: StripePriceIdProblemKind;
    readonly message: string;
}
/** Result of parsing the `STRIPE_PRICE_IDS` env value. */
export type StripePriceMapParse = {
    readonly ok: true;
    readonly priceIds: Readonly<Record<string, string>>;
} | {
    readonly ok: false;
    readonly problem: StripePriceIdProblem;
};
/** Result of {@link stripePriceIdFor}. */
export type StripePriceIdLookup = {
    readonly ok: true;
    readonly priceId: string;
} | {
    readonly ok: false;
    readonly problem: StripePriceIdProblem;
};
/**
 * Strictly parses a `STRIPE_PRICE_IDS` value — the JSON object mapping plan
 * names to Stripe price ids documented in env.ts
 * (`{"starter":"price_…","pro":"price_…","studio":"price_…"}`). Stricter
 * than the startup schema: values must be non-empty strings, because an
 * empty price id would only fail deep inside the Stripe SDK at checkout.
 * Never throws — failures come back as typed problems.
 */
export declare function parseStripePriceIds(envValue: string | undefined): StripePriceMapParse;
/**
 * Resolves the Stripe price id for a plan from the raw `STRIPE_PRICE_IDS`
 * env value. The catalog never hardcodes price ids — each paid plan carries
 * a `stripePriceKey` (its own machine id) that indexes this env map (D-4).
 * Trial and unknown ids fail with typed problems, never a throw:
 * - `unknown-plan` — not a plausible plan id.
 * - `plan-not-purchasable` — trial is a state, never a checkout target.
 * - `missing-env` / `invalid-json` / `invalid-map` — env value unusable.
 * - `plan-without-price` — valid map, no entry for the plan's key.
 */
export declare function stripePriceIdFor(planId: string, envValue: string | undefined): StripePriceIdLookup;
export {};
