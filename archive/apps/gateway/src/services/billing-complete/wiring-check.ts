// @studio/gateway — Stripe billing wiring audit (W9-A).
//
// A STARTUP audit over the landed W4-N billing surface (services/stripe.ts —
// read-only input, never modified here):
//   1. STRIPE_PRICE_STARTER/PRO/MAX env (plus the W1-B PLAN_*_CREDITS
//      aliases) → wire plan codes → @studio/config plan catalog must resolve,
//      each tier with its §14.1 monthly credit grant;
//   2. a NoopStripe provider in production is the typed `stripe_not_configured`
//      error with a setup hint — §4 fail-fast ("missing var = process refuses
//      to start"); a dev seam in prod is the same class of misconfiguration;
//   3. price-id ↔ plan-code dedup: every configured price id must map to
//      exactly one product (planCodeForPriceId returns the FIRST match, so a
//      shared price id silently grants the wrong plan's credits).
//
// Spec anchors: §4 (fail-fast env), §14.1 (plans/credits), §14.3 (plan
// mapping via STRIPE_PRICE_* env), §13.3 (typed codes + hints, never leaks).
//
// OWNERSHIP (docs/AGENTS.md): W9-A owns billing-complete/** only. The wire
// plan code `max` is the W4-N name of the $120 tier that @studio/config calls
// `business` (stripe.ts header note). W4-N keeps CONFIG_PLAN_BY_CODE private,
// so the mirror below is this layer's single mapping — wiring-check.test.ts
// fails if it ever drifts from the credits table.
//
// Pure + synchronous: takes the env source and the constructed provider, never
// touches process.env or the network itself, so tests stay hermetic.

import { PLANS, type PlanConfig, type PlanId } from "@studio/config";
import { AppError } from "../../middleware/error-mapper.js";
import {
  NoopStripe,
  type StripeLike,
  type StripePriceMap,
  type SubscriptionPlanCode,
  priceMapFromEnv,
} from "../stripe.js";

// ---------------------------------------------------------------------------
// Wire plan code → config plan id (mirror of stripe.ts's private mapping)
// ---------------------------------------------------------------------------

/**
 * Wire billing plan code → @studio/config PlanId. `max` is the W4-N wire name
 * of the tier config calls `business` (see the file header). Exported because
 * ledger-bridge.ts resolves §14.1 credit grants through the same mapping.
 */
export const WIRE_PLAN_TO_CONFIG_PLAN: Readonly<Record<SubscriptionPlanCode, PlanId>> = {
  starter: "starter",
  pro: "pro",
  max: "business",
};

/** Config plan for a wire plan code (the mapping this audit verifies). */
export function configPlanForWireCode(code: SubscriptionPlanCode): PlanId {
  return WIRE_PLAN_TO_CONFIG_PLAN[code];
}

/** §14.1 monthly credit grant for a wire plan code (100/250/600). */
export function monthlyCreditsForWireCode(code: SubscriptionPlanCode): number {
  return PLANS[configPlanForWireCode(code)].monthlyCredits;
}

// ---------------------------------------------------------------------------
// Findings (AGENTS.md: typed envelopes `{ ok:false, code, message, hint }`)
// ---------------------------------------------------------------------------

/** Stable audit codes. `stripe_not_configured` is the §4 fail-fast gate. */
export type StripeWiringCode =
  | "stripe_not_configured"
  | "price_env_missing"
  | "duplicate_price_id"
  | "plan_missing_in_config";

export interface StripeWiringFinding {
  readonly code: StripeWiringCode;
  readonly message: string;
  readonly hint: string;
  readonly planCode?: string;
  readonly priceId?: string;
}

export interface StripeWiringInput {
  /** Raw env source (process.env at startup; hermetic fixtures in tests). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The constructed provider seam (NoopStripe in dev/test; createStripeSdk in prod). */
  readonly stripe: StripeLike;
  /** Deployment environment; defaults to env.NODE_ENV, then "development". */
  readonly nodeEnv?: string;
}

export interface StripeWiringAudit {
  /** False when any finding is present — the caller must refuse to serve. */
  readonly ok: boolean;
  readonly findings: readonly StripeWiringFinding[];
  /** The parsed price map, or null when the env did not configure one. */
  readonly priceMap: StripePriceMap | null;
  /** §14.1 monthly credits per wire plan code, or null while unresolved. */
  readonly planCredits: Readonly<Record<SubscriptionPlanCode, number>> | null;
  /** True when the provider is the dev/test NoopStripe seam. */
  readonly noopProvider: boolean;
}

/** Node's production marker; anything else (dev, test, CI) allows NoopStripe. */
export function isProductionNodeEnv(nodeEnv: string): boolean {
  return nodeEnv === "production";
}

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

/**
 * Verifies the Stripe billing wiring (§4 / §14.3). Pure: returns findings,
 * never throws, performs no IO — the caller decides whether to log, boot or
 * die. See guardStripeWiring for the §4 refuse-to-start variant.
 */
export function auditStripeWiring(input: StripeWiringInput): StripeWiringAudit {
  const nodeEnv = input.nodeEnv ?? input.env.NODE_ENV ?? "development";
  const noopProvider = input.stripe instanceof NoopStripe;
  const findings: StripeWiringFinding[] = [];

  // §4 fail-fast: the NoopStripe seam is for dev/tests only. Production must
  // build the service with createStripeSdk or refuse to start — a silent
  // no-op provider would accept checkout requests and never charge anyone.
  if (noopProvider && isProductionNodeEnv(nodeEnv)) {
    findings.push({
      code: "stripe_not_configured",
      message: "Production cannot start on the NoopStripe billing seam.",
      hint: "Set STRIPE_SECRET_KEY + STRIPE_PRICE_STARTER/PRO/MAX and construct the service with createStripeSdk (apps/gateway/src/services/stripe.ts); NoopStripe is the dev/test seam only (§4 fail-fast).",
    });
  }

  // STRIPE_PRICE_* env → price map (W4-N parser, aliases included).
  const parsed = priceMapFromEnv(input.env);
  if (!parsed.ok) {
    findings.push({
      code: "price_env_missing",
      message: parsed.message,
      hint: parsed.hint ?? "Set STRIPE_PRICE_STARTER, STRIPE_PRICE_PRO and STRIPE_PRICE_MAX.",
    });
    return { ok: false, findings, priceMap: null, planCredits: null, noopProvider };
  }
  const priceMap: StripePriceMap = parsed.value;

  // price-id ↔ plan-code dedup: the map must be injective. planCodeForPriceId
  // walks BILLING_PLAN_CODES in order and returns the first hit, so a shared
  // price id would resolve one plan's invoices to another plan's credits.
  const configured: ReadonlyArray<{ readonly planCode: string; readonly priceId: string }> = [
    { planCode: "starter", priceId: priceMap.starter },
    { planCode: "pro", priceId: priceMap.pro },
    { planCode: "max", priceId: priceMap.max },
    ...(priceMap.pack === undefined ? [] : [{ planCode: "pack", priceId: priceMap.pack }]),
    ...(priceMap.seat === undefined ? [] : [{ planCode: "seat", priceId: priceMap.seat }]),
  ];
  const ownerByPriceId = new Map<string, string>();
  for (const entry of configured) {
    const owner = ownerByPriceId.get(entry.priceId);
    if (owner === undefined) {
      ownerByPriceId.set(entry.priceId, entry.planCode);
      continue;
    }
    findings.push({
      code: "duplicate_price_id",
      message: `Stripe price id is mapped to two plans: '${owner}' and '${entry.planCode}'.`,
      hint: `Give every plan its own Stripe price — the shared price id would attribute invoices to the first matching plan (${owner}). Check the STRIPE_PRICE_* env vars.`,
      planCode: entry.planCode,
      priceId: entry.priceId,
    });
  }

  // env → plan codes → config: every subscription tier must resolve to a
  // config plan carrying a positive §14.1 monthly credit grant.
  const planCredits: Partial<Record<SubscriptionPlanCode, number>> = {};
  let planMissing = false;
  for (const code of ["starter", "pro", "max"] as const) {
    const configId = configPlanForWireCode(code);
    const plan: PlanConfig | undefined = PLANS[configId];
    if (plan === undefined || plan.monthlyCredits <= 0) {
      planMissing = true;
      findings.push({
        code: "plan_missing_in_config",
        message: `Plan code '${code}' does not resolve to a priced plan in @studio/config.`,
        hint: `Expected config plan '${configId}' with monthlyCredits > 0 (§14.1: $30/$60/$120 → 100/250/600).`,
        planCode: code,
      });
      continue;
    }
    planCredits[code] = plan.monthlyCredits;
  }

  const credits: Readonly<Record<SubscriptionPlanCode, number>> | null = planMissing
    ? null
    : (planCredits as Readonly<Record<SubscriptionPlanCode, number>>);

  return {
    ok: findings.length === 0,
    findings,
    priceMap,
    planCredits: credits,
    noopProvider,
  };
}

/**
 * §4 fail-fast gate: runs the audit and THROWS a typed AppError on the first
 * finding so a misconfigured process refuses to start. The thrown error carries
 * the finding's stable code + setup hint (never a stack trace or internal ids).
 * Call from gateway bootstrap before mountBillingRoutes wires the service.
 */
export function guardStripeWiring(input: StripeWiringInput): StripeWiringAudit {
  const audit = auditStripeWiring(input);
  const first = audit.findings[0];
  if (!audit.ok && first !== undefined) {
    throw new AppError(503, first.code, first.message, { hint: first.hint, retryable: false });
  }
  return audit;
}
