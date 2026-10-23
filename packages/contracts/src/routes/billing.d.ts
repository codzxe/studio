import { z } from "zod";
import { type PlanId } from "../models.js";
import { type Id } from "./common.js";
/** `POST /v1/billing/checkout` body: the paid plan to subscribe to (D-4). */
export declare const CHECKOUT_SCHEMA: z.ZodObject<{
    planId: z.ZodEnum<{
        starter: "starter";
        pro: "pro";
        studio: "studio";
    }>;
}, z.core.$strict>;
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
/** Pack ids accepted by `POST /v1/billing/topup { packId }`. */
export declare const TOP_UP_PACK_IDS: readonly ["credits100", "credits500", "credits2000"];
export type TopUpPackId = (typeof TOP_UP_PACK_IDS)[number];
export declare const TOP_UP_PACK_ID_SCHEMA: z.ZodEnum<{
    credits100: "credits100";
    credits500: "credits500";
    credits2000: "credits2000";
}>;
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
export declare const TOP_UP_PACKS: readonly [{
    readonly packId: "credits100";
    readonly credits: 100;
}, {
    readonly packId: "credits500";
    readonly credits: 500;
}, {
    readonly packId: "credits2000";
    readonly credits: 2000;
}];
/** `POST /v1/billing/topup` body: exactly one pack. */
export declare const TOPUP_SCHEMA: z.ZodObject<{
    packId: z.ZodEnum<{
        credits100: "credits100";
        credits500: "credits500";
        credits2000: "credits2000";
    }>;
}, z.core.$strict>;
export type TopUpRequest = z.infer<typeof TOPUP_SCHEMA>;
/** `POST /v1/billing/topup` → a one-time-payment Checkout session. */
export type TopUpResponse = CheckoutResponse;
/** `POST /v1/billing/portal` body. */
export declare const PORTAL_SCHEMA: z.ZodObject<{
    returnUrl: z.ZodOptional<z.ZodURL>;
}, z.core.$strict>;
export type PortalRequest = z.infer<typeof PORTAL_SCHEMA>;
/** `POST /v1/billing/portal` → Stripe customer portal session. */
export interface PortalResponse {
    readonly url: string;
}
/**
 * Subscription states on the wire: the persistence statuses plus `none` —
 * the workspace has no subscription row yet (never subscribed).
 */
export declare const BILLING_STATUSES: readonly ["none", "trialing", "active", "past_due", "grace", "canceled", "incomplete"];
export declare const BILLING_STATUS_SCHEMA: z.ZodEnum<{
    trialing: "trialing";
    active: "active";
    past_due: "past_due";
    canceled: "canceled";
    incomplete: "incomplete";
    grace: "grace";
    none: "none";
}>;
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
/** `POST /v1/billing/trial` body — the server derives everything else. */
export declare const TRIAL_REQUEST_SCHEMA: z.ZodObject<{}, z.core.$strict>;
export type TrialRequest = z.infer<typeof TRIAL_REQUEST_SCHEMA>;
/** `POST /v1/billing/trial` → the started trial (D-4: state on the Starter row). */
export interface TrialResponse {
    readonly trialStarted: true;
    /** When the trial ends (ISO-8601). */
    readonly trialEnd: string;
}
/** `invoice.status` on the wire — the `invoices.status` DB vocabulary (§9.1). */
export declare const INVOICE_STATUSES: readonly ["draft", "open", "paid", "void", "uncollectible"];
export declare const INVOICE_STATUS_SCHEMA: z.ZodEnum<{
    void: "void";
    draft: "draft";
    open: "open";
    paid: "paid";
    uncollectible: "uncollectible";
}>;
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
export declare const INVOICES_QUERY_SCHEMA: z.ZodObject<{
    cursor: z.ZodOptional<z.ZodString>;
    limit: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
}, z.core.$strip>;
export type InvoicesQuery = z.infer<typeof INVOICES_QUERY_SCHEMA>;
