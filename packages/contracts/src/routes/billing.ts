// @studio/contracts — Stripe billing (PRODUCT_ARCHITECTURE.md §7.2, §10.3).
//
// M6 wire (BUILD_PLAN §M6 tasks 1-2+5, DECISIONS D-4/D-12):
//  - Checkout is SUBSCRIPTION-ONLY and takes a paid plan id: the schema union
//    `PAID_PLAN_ID_SCHEMA` IS the D-4 pricing-page display list (trial is a
//    subscription state, never a checkout target). Credit packs moved to
//    `POST /v1/billing/topup`.
//  - Top-up packs: `TOP_UP_PACKS` is the purchasable catalog (display credit
//    units; prices live in Stripe, never on the wire). Ledger amounts are
//    integer MICROcredits (D-12); the packs themselves carry whole credits and
//    the service converts at the boundary.
//  - `GET /v1/billing/state` is the ONE billing read the UI consumes — plan,
//    subscription status (incl. grace/trialing), entitlements and the credit
//    summary. The UI reads entitlements from here; it never hardcodes plans.
//  - Law #4: every POST below requires an `Idempotency-Key` header (8-128
//    chars) — enforced by the gateway's idempotency middleware, attached by
//    the api-client on every mutation; replays return the original result.
//  - Webhook handling stays service-side (§10.3: signature + event-id
//    idempotency); it is not part of these wire contracts.

import { z } from "zod";

import { PAID_PLAN_ID_SCHEMA, type PlanId } from "../models.js";
import { type Id, PAGINATION_QUERY_SCHEMA } from "./common.js";

/** `POST /v1/billing/checkout` body: the paid plan to subscribe to (D-4). */
export const CHECKOUT_SCHEMA = z.strictObject({
  planId: PAID_PLAN_ID_SCHEMA,
});

export type CheckoutRequest = z.infer<typeof CHECKOUT_SCHEMA>;

/**
 * `POST /v1/billing/checkout` → a Stripe Checkout session, or an immediate
 * server-side plan change when the workspace already has a live subscription
 * (`planChanged: true` — no hosted session is created in that arm).
 */
export interface CheckoutResponse {
  readonly sessionId: string;
  readonly url: string;
  /** true when an existing subscription was switched server-side instead. */
  readonly planChanged?: boolean;
}

// ---------------------------------------------------------------------------
// Top-up packs (BP §M6 task 2 "top-up packs"; D-12)
// ---------------------------------------------------------------------------

/** Pack ids accepted by `POST /v1/billing/topup { packId }`. */
export const TOP_UP_PACK_IDS = ["credits100", "credits500", "credits2000"] as const;

export type TopUpPackId = (typeof TOP_UP_PACK_IDS)[number];

export const TOP_UP_PACK_ID_SCHEMA = z.enum(TOP_UP_PACK_IDS);

/** One purchasable credit pack (credits are DISPLAY units; prices in Stripe). */
export interface TopUpPack {
  readonly packId: TopUpPackId;
  /** Whole credits granted by the pack (µc at the ledger, converted D-12). */
  readonly credits: number;
}

/**
 * The credit-pack catalog. BUSINESS-PENDING: the 100/500/2000 volumes are the
 * M6 pick; Stripe holds the actual prices.
 */
export const TOP_UP_PACKS = [
  { packId: "credits100", credits: 100 },
  { packId: "credits500", credits: 500 },
  { packId: "credits2000", credits: 2000 },
] as const satisfies readonly TopUpPack[];

/** `POST /v1/billing/topup` body: exactly one pack. */
export const TOPUP_SCHEMA = z.strictObject({
  packId: TOP_UP_PACK_ID_SCHEMA,
});

export type TopUpRequest = z.infer<typeof TOPUP_SCHEMA>;

/** `POST /v1/billing/topup` → a one-time-payment Checkout session. */
export type TopUpResponse = CheckoutResponse;

// ---------------------------------------------------------------------------
// Customer portal
// ---------------------------------------------------------------------------

/** `POST /v1/billing/portal` body. */
export const PORTAL_SCHEMA = z.strictObject({
  returnUrl: z.url().optional(),
});

export type PortalRequest = z.infer<typeof PORTAL_SCHEMA>;

/** `POST /v1/billing/portal` → Stripe customer portal session. */
export interface PortalResponse {
  readonly url: string;
}

// ---------------------------------------------------------------------------
// Billing state — the ONE read the UI consumes (BP §M6 tasks 1+4)
// ---------------------------------------------------------------------------

/**
 * Subscription states on the wire: the persistence statuses plus `none` —
 * the workspace has no subscription row yet (never subscribed).
 */
export const BILLING_STATUSES = [
  "none",
  "trialing",
  "active",
  "past_due",
  "grace",
  "canceled",
  "incomplete",
] as const satisfies readonly string[];

export const BILLING_STATUS_SCHEMA = z.enum(BILLING_STATUSES);

export type BillingStatus = z.infer<typeof BILLING_STATUS_SCHEMA>;

/**
 * The per-plan entitlement bundle the server enforces (mirrors the
 * `@studio/config` catalog — the UI reads it, it never hardcodes plans).
 */
export interface BillingEntitlements {
  readonly seats: number;
  readonly models: readonly string[];
  readonly maxProjects: number;
  readonly storageBytes: number;
  readonly renderMinutesPerMonth: number;
  /** Monthly allowance in INTEGER MICROcredits (D-12; 1 credit = 1,000,000 µc). */
  readonly monthlyCreditAllowance: number;
}

/** One credit pack as the billing page renders it. */
export interface BillingTopUpPack {
  readonly packId: TopUpPackId;
  readonly credits: number;
}

/** `GET /v1/billing/state` — subscription snapshot + entitlements + credits. */
export interface BillingState {
  /** The EFFECTIVE plan gating this workspace (a trialing row gates as trial, D-4). */
  readonly plan: PlanId;
  readonly status: BillingStatus;
  readonly currentPeriodEnd: string | null;
  readonly trialEnd: string | null;
  readonly cancelAtPeriodEnd: boolean;
  /** End of the past-due dunning window while status is `grace` (§M6 task 2). */
  readonly graceEnd: string | null;
  readonly entitlements: BillingEntitlements;
  /** Raw ledger numbers in µc — the same units as `GET /v1/credits` (D-12). */
  readonly credits: {
    readonly balance: number;
    readonly reserved: number;
  };
  readonly topUpPacks: readonly BillingTopUpPack[];
}

// ---------------------------------------------------------------------------
// Trial start (BP §M6 task 5: card required, one per workspace/card, domain rules)
// ---------------------------------------------------------------------------

/** `POST /v1/billing/trial` body — the server derives everything else. */
export const TRIAL_REQUEST_SCHEMA = z.strictObject({});

export type TrialRequest = z.infer<typeof TRIAL_REQUEST_SCHEMA>;

/** `POST /v1/billing/trial` → the started trial (D-4: state on the Starter row). */
export interface TrialResponse {
  readonly trialStarted: true;
  /** When the trial ends (ISO-8601). */
  readonly trialEnd: string;
}

// ---------------------------------------------------------------------------
// Invoices — the recorded Stripe invoice history (BP §M6 task 2; the F-J3
// wire read: rows are recorded by the invoice.paid / invoice.voided webhook
// handler through repos.invoices)
// ---------------------------------------------------------------------------

/** `invoice.status` on the wire — the `invoices.status` DB vocabulary (§9.1). */
export const INVOICE_STATUSES = [
  "draft",
  "open",
  "paid",
  "void",
  "uncollectible",
] as const satisfies readonly string[];

export const INVOICE_STATUS_SCHEMA = z.enum(INVOICE_STATUSES);

export type InvoiceStatusWire = z.infer<typeof INVOICE_STATUS_SCHEMA>;

/** One recorded Stripe invoice — a `GET /v1/billing/invoices` row. */
export interface InvoiceRecord {
  readonly id: Id;
  readonly stripeInvoiceId: string;
  /**
   * MONEY in Stripe minor units (e.g. US cents) — never credits; the credit
   * ledger is its own D-12 microcredit domain (§9.1 `invoices.amount_cents`).
   */
  readonly amountCents: number;
  /** ISO 4217 lowercase 3-letter code, e.g. 'usd'. */
  readonly currency: string;
  readonly status: InvoiceStatusWire;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly hostedUrl: string | null;
  readonly pdfUrl: string | null;
  readonly createdAt: string;
}

/** `GET /v1/billing/invoices` query — newest-first, cursor-paginated (§7.2). */
export const INVOICES_QUERY_SCHEMA = PAGINATION_QUERY_SCHEMA;

export type InvoicesQuery = z.infer<typeof INVOICES_QUERY_SCHEMA>;
