// @studio/contracts — Stripe billing (PRODUCT_ARCHITECTURE.md §7.2, §10.3).
//
// Checkout handles subscriptions (planId) and one-time credit packs (packId);
// the portal handles payment method / invoices / cancel. Webhook handling stays
// service-side; it is not part of these wire contracts.

import { z } from "zod";

import { PAID_PLAN_ID_SCHEMA } from "../models.js";

/** `POST /v1/billing/checkout` body: exactly one of planId (subscription) or packId (top-up). */
export const CHECKOUT_SCHEMA = z
  .strictObject({
    planId: PAID_PLAN_ID_SCHEMA.optional(), // trial is never a checkout target
    packId: z.string().min(1).max(64).optional(),
  })
  .refine(
    (body) => (body.planId !== undefined) !== (body.packId !== undefined),
    "exactly one of planId or packId is required",
  );

export type CheckoutRequest = z.infer<typeof CHECKOUT_SCHEMA>;

/** `POST /v1/billing/checkout` → Stripe Checkout session. */
export interface CheckoutResponse {
  readonly sessionId: string;
  readonly url: string;
}

/** `POST /v1/billing/portal` body. */
export const PORTAL_SCHEMA = z.strictObject({
  returnUrl: z.url().optional(),
});

export type PortalRequest = z.infer<typeof PORTAL_SCHEMA>;

/** `POST /v1/billing/portal` → Stripe customer portal session. */
export interface PortalResponse {
  readonly url: string;
}
