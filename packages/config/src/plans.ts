// @studio/config — plan & entitlement catalog (BUILD_PLAN §M6.1,
// PRODUCT_ARCHITECTURE §10.1, DECISIONS D-2/D-4/D-8/D-12).
//
// This module is the single source of truth for what each billing tier
// entitles: seats, model picker access, project count, storage, render
// minutes and the monthly credit allowance. Server-side checks read it
// through the helpers below; the UI reads entitlements, never hardcodes
// them (BP §M6.1).
//
// Binding rulings encoded here (docs/DECISIONS.md):
// - D-4  Trial is a subscription STATE on the Starter row, never a checkout
//        target. The pricing display list is exactly starter/pro/studio.
//        The catalog still defines trial entitlements (the state needs
//        numbers), but `trial` carries no price and no Stripe price key.
// - D-8  studio-vision is NOT offered in the v1 model picker (reserved for
//        the eval harness / vision critic) → no tier lists it.
// - D-12 Ledger math is integer microcredits: 1 credit = 1,000,000 µc.
//        Every allowance below is an integer; prices are integer cents.
//        No floats anywhere in this catalog.
// - D-2  v1 render formats are MP4 (H.264) + PNG sequence only; ProRes,
//        GIF and WAV stay declared but disabled.
//
// MONEY NOTE (ledger capacity): the Studio allowance is 10,000,000,000 µc,
// which EXCEEDS a signed 32-bit integer (max 2,147,483,647 µc ≈ 2,147
// credits). `credit_ledger.amount` is currently drizzle `integer` (int32) —
// a single monthly grant row for Studio would overflow. The M6 ledger wave
// must move `amount` to bigint (or grant in split rows) before Studio
// allowances are written. Flagged in the M6-A report/worklog.
//
// DRIFT NOTE (models): @studio/contracts `PLAN_MODEL_ENTITLEMENTS` is the
// pre-M6 illustrative map (starter→[fast], studio→[fast,smart,vision]). It
// does NOT match this catalog (starter→[fast,smart]; studio→[fast,smart],
// vision reserved per D-8). Consumers must gate the picker through
// `maxModelTier`/`entitlementsFor` here; the contracts map needs an M6
// follow-up edit by its owner (config cannot import contracts).

import { StudioError } from "./errors.js";

// ───────────────────────────────────────────────────────────────────────────
// Plan ids and types
// ───────────────────────────────────────────────────────────────────────────

const PLAN_ID_UNION = ["trial", "starter", "pro", "studio"] as const;

/** Machine ids of every billing tier, including the trial state (D-4). */
export type PlanId = (typeof PLAN_ID_UNION)[number];

/**
 * Every plan id this build can encounter from external systems (DB rows,
 * Stripe metadata, config files) — "plausible" until narrowed by
 * {@link isPlausiblePlanId}. Frozen; mirrors the catalog keys 1:1.
 */
export const PLAUSIBLE_PLAN_IDS: readonly PlanId[] = Object.freeze([...PLAN_ID_UNION]);

/** The purchasable tiers — also the D-4 pricing-page display list. */
export const PRICING_PAGE_PLANS = ["starter", "pro", "studio"] as const satisfies readonly PlanId[];

/** Paid plan ids (`PRICING_PAGE_PLANS[0] | …`). Trial is never one (D-4). */
export type PaidPlanId = (typeof PRICING_PAGE_PLANS)[number];

/** Type guard: narrows external strings (webhooks, DB) to {@link PlanId}. */
export function isPlausiblePlanId(value: string): value is PlanId {
  return (PLAUSIBLE_PLAN_IDS as readonly string[]).includes(value);
}

/** `true` only for starter/pro/studio — trial and unknown ids are not paid. */
export function isPaidPlan(id: string): boolean {
  return (PRICING_PAGE_PLANS as readonly string[]).includes(id);
}

// ───────────────────────────────────────────────────────────────────────────
// Model ids (mirror of @studio/contracts MODEL_IDS / MODEL_CATALOG keys)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Model ids referenced by plan entitlements. MUST equal
 * `@studio/contracts` `MODEL_IDS` / `MODEL_CATALOG` keys
 * (studio-fast / studio-smart / studio-vision); the colocated test pins the
 * literals. Duplicated only because @studio/config deliberately has no
 * dependency on @studio/contracts.
 */
export const PLAN_MODEL_IDS = [
  "studio-fast",
  "studio-smart",
  "studio-vision",
] as const satisfies readonly string[];

/** One of the three model ids (mirror type — see {@link PLAN_MODEL_IDS}). */
export type PlanModelId = (typeof PLAN_MODEL_IDS)[number];

// ───────────────────────────────────────────────────────────────────────────
// Credit precision (D-12)
// ───────────────────────────────────────────────────────────────────────────

/** 1 credit = 1,000,000 µc — the ledger stores integer microcredits (D-12). */
export const MICROCREDITS_PER_CREDIT = 1_000_000 as const;

/**
 * Converts a credit amount to integer microcredits (D-12).
 * Accepts up to 6 decimals of a credit; rejects negative, non-finite or
 * sub-µc amounts with a typed StudioError ("no floats in ledger math").
 * The epsilon round-trip rejects sub-µc precision without breaking on
 * binary-float artifacts of legitimate 2-decimal amounts (0.01 → 10,000 µc).
 */
export function creditsToMicrocredits(credits: number): number {
  const micro = Math.round(credits * MICROCREDITS_PER_CREDIT);
  if (
    !Number.isFinite(credits) ||
    credits < 0 ||
    Math.abs(micro / MICROCREDITS_PER_CREDIT - credits) > 1e-9
  ) {
    throw new StudioError("VALIDATION_FAILED", {
      message: "Credit amounts must be whole microcredits.",
      hint: "Use at most 2 decimals of a credit; finer amounts are rejected.",
    });
  }
  return micro;
}

/**
 * Converts integer microcredits to whole credits with up to 2 decimals —
 * the D-12 rule for API/UI display at the route boundary. Non-integer or
 * negative inputs are rejected with a typed StudioError.
 */
export function microcreditsToCredits(microcredits: number): number {
  if (!Number.isInteger(microcredits) || microcredits < 0) {
    throw new StudioError("VALIDATION_FAILED", {
      message: "Microcredit amounts must be non-negative integers.",
      hint: "Ledger math is integer microcredits (DECISIONS D-12).",
    });
  }
  // Round to whole hundredths of a credit (2-decimal display, D-12).
  return Math.round(microcredits / 10_000) / 100;
}

// ───────────────────────────────────────────────────────────────────────────
// The catalog
// ───────────────────────────────────────────────────────────────────────────

/** Storage units in binary bytes, matching the env.ts byte-cap math (MiB). */
const GIB = 1024 ** 3;
const TIB = 1024 ** 4;

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
  readonly monthlyCreditAllowance: number;
}

const RAW_PLAN_CATALOG = {
  // D-4: trial is a subscription STATE (`status='trialing'`) on the Starter
  // row — 14 days, card required (BP §M6.1). Entitlements below are what a
  // trialing workspace gets; there is no checkout target and no price.
  trial: {
    id: "trial",
    name: "Trial",
    seats: 1,
    models: ["studio-fast"],
    maxProjects: 3,
    storageBytes: 1 * GIB,
    renderMinutesPerMonth: 5,
    monthlyCreditAllowance: 50 * MICROCREDITS_PER_CREDIT,
    trialDays: 14,
    monthlyPriceCents: 0,
    stripePriceKey: null,
  },
  starter: {
    id: "starter",
    name: "Starter",
    seats: 2,
    models: ["studio-fast", "studio-smart"],
    maxProjects: 10,
    storageBytes: 20 * GIB,
    renderMinutesPerMonth: 60,
    monthlyCreditAllowance: 500 * MICROCREDITS_PER_CREDIT,
    trialDays: null,
    monthlyPriceCents: 1200, // BUSINESS-PENDING: $12/mo placeholder
    stripePriceKey: "starter",
  },
  pro: {
    id: "pro",
    name: "Pro",
    seats: 5,
    models: ["studio-fast", "studio-smart"],
    maxProjects: 50,
    storageBytes: 200 * GIB,
    renderMinutesPerMonth: 600,
    monthlyCreditAllowance: 2000 * MICROCREDITS_PER_CREDIT,
    trialDays: null,
    monthlyPriceCents: 3900, // BUSINESS-PENDING: $39/mo placeholder
    stripePriceKey: "pro",
  },
  studio: {
    id: "studio",
    name: "Studio",
    seats: 15,
    models: ["studio-fast", "studio-smart"],
    maxProjects: 200,
    storageBytes: 1 * TIB,
    renderMinutesPerMonth: 3000,
    // 10,000 credits = 10,000,000,000 µc — EXCEEDS int32; see MONEY NOTE in
    // the module header: credit_ledger.amount needs bigint before this
    // allowance is written as a single grant row.
    monthlyCreditAllowance: 10_000 * MICROCREDITS_PER_CREDIT,
    trialDays: null,
    monthlyPriceCents: 9900, // BUSINESS-PENDING: $99/mo placeholder
    stripePriceKey: "studio",
  },
} as const satisfies Readonly<Record<PlanId, PlanDescriptor>>;

/** The four tiers keyed by machine id. Deep-frozen — never mutate. */
export const PLAN_CATALOG: Readonly<Record<PlanId, PlanDescriptor>> = deepFreeze(RAW_PLAN_CATALOG);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Descriptor for a plan id. Runtime values from webhooks/DB may be unknown
 * strings — those throw a typed `StudioError` (`VALIDATION_FAILED`) whose
 * message never echoes the raw id.
 */
export function getPlan(id: string): PlanDescriptor {
  if (!isPlausiblePlanId(id)) {
    throw new StudioError("VALIDATION_FAILED", {
      message: "Unknown plan id.",
      hint: "Expected one of: trial, starter, pro, studio.",
    });
  }
  return PLAN_CATALOG[id];
}

/**
 * Frozen entitlement bundle for a plan (the subset servers enforce).
 * Unknown ids throw the same typed error as {@link getPlan}. Each call
 * returns a fresh frozen object; the `models` array is the catalog's frozen
 * reference (safe to share).
 */
export function entitlementsFor(id: string): Entitlements {
  const plan = getPlan(id);
  return Object.freeze({
    seats: plan.seats,
    models: plan.models,
    maxProjects: plan.maxProjects,
    storageBytes: plan.storageBytes,
    renderMinutesPerMonth: plan.renderMinutesPerMonth,
    monthlyCreditAllowance: plan.monthlyCreditAllowance,
  });
}

/**
 * Picker gate: `true` iff `modelId` is selectable on `planId`.
 * Fails CLOSED — unknown plan ids and unknown model ids are `false`, never
 * a throw, so route guards can `if (!maxModelTier(...)) { … }`.
 * D-8: `studio-vision` is `false` on every tier in v1 (the models route
 * shows trial ⇒ exactly [studio-fast] through this gate).
 */
export function maxModelTier(planId: string, modelId: string): boolean {
  if (!isPlausiblePlanId(planId)) {
    return false;
  }
  return (PLAN_CATALOG[planId].models as readonly string[]).includes(modelId);
}

// ───────────────────────────────────────────────────────────────────────────
// Render formats (D-2)
// ───────────────────────────────────────────────────────────────────────────

const RENDER_FORMAT_IDS = ["mp4", "png-seq", "prores", "gif", "wav"] as const;

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
export const RENDER_FORMATS: readonly RenderFormatDescriptor[] = deepFreeze([
  { id: "mp4", label: "MP4 (H.264)", enabled: true },
  { id: "png-seq", label: "PNG sequence", enabled: true },
  { id: "prores", label: "ProRes", enabled: false },
  { id: "gif", label: "GIF", enabled: false },
  { id: "wav", label: "WAV audio", enabled: false },
] as const satisfies readonly RenderFormatDescriptor[]);

/** The v1-enabled format ids, derived from {@link RENDER_FORMATS}. */
export const ENABLED_RENDER_FORMATS: readonly RenderFormatId[] = deepFreeze(
  RENDER_FORMATS.filter((format) => format.enabled).map((format) => format.id),
);

/** `true` iff the format id exists and is enabled (D-2). Fails closed. */
export function isRenderFormatEnabled(id: string): boolean {
  return (ENABLED_RENDER_FORMATS as readonly string[]).includes(id);
}

// ───────────────────────────────────────────────────────────────────────────
// Stripe price map (STRIPE_PRICE_IDS — consumed from env.ts, never edited)
// ───────────────────────────────────────────────────────────────────────────

/** Why a Stripe price lookup failed. Add-only; never rename or reuse. */
export type StripePriceIdProblemKind =
  | "missing-env"
  | "invalid-json"
  | "invalid-map"
  | "unknown-plan"
  | "plan-not-purchasable"
  | "plan-without-price";

/** One typed lookup failure. `message` is log-safe; it never echoes raw env values. */
export interface StripePriceIdProblem {
  readonly kind: StripePriceIdProblemKind;
  readonly message: string;
}

/** Result of parsing the `STRIPE_PRICE_IDS` env value. */
export type StripePriceMapParse =
  | { readonly ok: true; readonly priceIds: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly problem: StripePriceIdProblem };

/** Result of {@link stripePriceIdFor}. */
export type StripePriceIdLookup =
  | { readonly ok: true; readonly priceId: string }
  | { readonly ok: false; readonly problem: StripePriceIdProblem };

/**
 * Strictly parses a `STRIPE_PRICE_IDS` value — the JSON object mapping plan
 * names to Stripe price ids documented in env.ts
 * (`{"starter":"price_…","pro":"price_…","studio":"price_…"}`). Stricter
 * than the startup schema: values must be non-empty strings, because an
 * empty price id would only fail deep inside the Stripe SDK at checkout.
 * Never throws — failures come back as typed problems.
 */
export function parseStripePriceIds(envValue: string | undefined): StripePriceMapParse {
  if (envValue === undefined || envValue.trim().length === 0) {
    return {
      ok: false,
      problem: {
        kind: "missing-env",
        message: "STRIPE_PRICE_IDS is not set.",
      },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(envValue);
  } catch {
    return {
      ok: false,
      problem: {
        kind: "invalid-json",
        message: "STRIPE_PRICE_IDS must be valid JSON mapping plan names to Stripe price ids.",
      },
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      problem: {
        kind: "invalid-map",
        message: "STRIPE_PRICE_IDS must be a JSON object of plan name to price id.",
      },
    };
  }
  const record = parsed as Record<string, unknown>;
  for (const value of Object.values(record)) {
    if (typeof value !== "string" || value.trim().length === 0) {
      return {
        ok: false,
        problem: {
          kind: "invalid-map",
          message: "STRIPE_PRICE_IDS values must be non-empty Stripe price id strings.",
        },
      };
    }
  }
  return { ok: true, priceIds: Object.freeze({ ...record }) as Readonly<Record<string, string>> };
}

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
export function stripePriceIdFor(
  planId: string,
  envValue: string | undefined,
): StripePriceIdLookup {
  if (!isPlausiblePlanId(planId)) {
    return {
      ok: false,
      problem: {
        kind: "unknown-plan",
        message: "Unknown plan id — price lookups expect starter, pro or studio.",
      },
    };
  }
  if (!isPaidPlan(planId)) {
    return {
      ok: false,
      problem: {
        kind: "plan-not-purchasable",
        message:
          "Trial is a subscription state on the Starter row, never a checkout target (DECISIONS D-4).",
      },
    };
  }
  const parsed = parseStripePriceIds(envValue);
  if (!parsed.ok) {
    return parsed;
  }
  const priceId = parsed.priceIds[planId];
  if (priceId === undefined) {
    return {
      ok: false,
      problem: {
        kind: "plan-without-price",
        message: `The STRIPE_PRICE_IDS map has no price id for the "${planId}" plan.`,
      },
    };
  }
  return { ok: true, priceId };
}
