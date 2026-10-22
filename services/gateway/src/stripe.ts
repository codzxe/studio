// @studio/gateway — Stripe seam (§10.3): the real SDK behind the structural
// interface in context.ts so tests never import Stripe. Null when
// STRIPE_SECRET_KEY is absent (local dev) — billing routes then return the
// typed "billing not configured in this environment" VALIDATION_FAILED.

import Stripe from "stripe";

import type { StudioEnv } from "@studio/config";
import type { StripeEventLike, StripeSeam } from "./context.js";

export function createStripeSeam(env: StudioEnv): StripeSeam | null {
  if (env.stripe.secretKey === undefined) return null;
  const stripe = new Stripe(env.stripe.secretKey);
  const seen = new Set<string>();

  return {
    raw: stripe,

    async checkout(params) {
      const session = await stripe.checkout.sessions.create({
        mode: params.mode,
        line_items: [{ price: params.priceId, quantity: params.quantity ?? 1 }],
        customer: params.customerId,
        customer_email: params.customerId === undefined ? params.customerEmail : undefined,
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        metadata: params.metadata,
        subscription_data:
          params.mode === "subscription" ? { metadata: params.metadata } : undefined,
        payment_intent_data: params.mode === "payment" ? { metadata: params.metadata } : undefined,
      });
      return { id: session.id, url: session.url ?? "" };
    },

    async portal(params) {
      const session = await stripe.billingPortal.sessions.create({
        customer: params.customerId,
        return_url: params.returnUrl,
      });
      return { id: session.id, url: session.url };
    },

    verifyWebhook(payload, signature) {
      if (signature === null || signature.length === 0) {
        return { ok: false as const, reason: "missing stripe-signature header" };
      }
      try {
        const event = stripe.webhooks.constructEvent(payload, signature, env.stripe.webhookSecret);
        return { ok: true as const, event: event as unknown as StripeEventLike };
      } catch (error) {
        return {
          ok: false as const,
          reason: error instanceof Error ? error.message : "signature verification failed",
        };
      }
    },

    async createCustomer(params) {
      const customer = await stripe.customers.create({
        email: params.email,
        metadata: params.metadata,
      });
      return { id: customer.id };
    },

    seenEvent(id) {
      if (seen.has(id)) return true;
      seen.add(id);
      return false;
    },
  };
}
