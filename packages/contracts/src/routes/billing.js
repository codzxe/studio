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
import { PAID_PLAN_ID_SCHEMA } from "../models.js";
import { PAGINATION_QUERY_SCHEMA } from "./common.js";
/** `POST /v1/billing/checkout` body: the paid plan to subscribe to (D-4). */
export const CHECKOUT_SCHEMA = z.strictObject({
    planId: PAID_PLAN_ID_SCHEMA,
});
// ---------------------------------------------------------------------------
// Top-up packs (BP §M6 task 2 "top-up packs"; D-12)
// ---------------------------------------------------------------------------
/** Pack ids accepted by `POST /v1/billing/topup { packId }`. */
export const TOP_UP_PACK_IDS = ["credits100", "credits500", "credits2000"];
export const TOP_UP_PACK_ID_SCHEMA = z.enum(TOP_UP_PACK_IDS);
/**
 * The credit-pack catalog. BUSINESS-PENDING: the 100/500/2000 volumes are the
 * M6 pick; Stripe holds the actual prices.
 */
export const TOP_UP_PACKS = [
    { packId: "credits100", credits: 100 },
    { packId: "credits500", credits: 500 },
    { packId: "credits2000", credits: 2000 },
];
/** `POST /v1/billing/topup` body: exactly one pack. */
export const TOPUP_SCHEMA = z.strictObject({
    packId: TOP_UP_PACK_ID_SCHEMA,
});
// ---------------------------------------------------------------------------
// Customer portal
// ---------------------------------------------------------------------------
/** `POST /v1/billing/portal` body. */
export const PORTAL_SCHEMA = z.strictObject({
    returnUrl: z.url().optional(),
});
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
];
export const BILLING_STATUS_SCHEMA = z.enum(BILLING_STATUSES);
// ---------------------------------------------------------------------------
// Trial start (BP §M6 task 5: card required, one per workspace/card, domain rules)
// ---------------------------------------------------------------------------
/** `POST /v1/billing/trial` body — the server derives everything else. */
export const TRIAL_REQUEST_SCHEMA = z.strictObject({});
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
];
export const INVOICE_STATUS_SCHEMA = z.enum(INVOICE_STATUSES);
/** `GET /v1/billing/invoices` query — newest-first, cursor-paginated (§7.2). */
export const INVOICES_QUERY_SCHEMA = PAGINATION_QUERY_SCHEMA;
//# sourceMappingURL=billing.js.map