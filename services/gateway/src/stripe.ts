// @studio/gateway — Stripe seam (§10.3): the real SDK behind the structural
// interface in context.ts so tests never import Stripe. Null when
// STRIPE_SECRET_KEY is absent (local dev) — billing routes then return the
// typed "billing not configured in this environment" VALIDATION_FAILED.
//
// M6-B surface: checkout / portal / verifyWebhook / createCustomer / seenEvent
// keep their original signatures (billing routes depend on them); the new
// members (topUpCheckout, subscription, updateSubscription, createTestClock,
// withTestClock, markEventSeen) return the typed StripeSeamResult envelope —
// raw SDK errors never cross the seam (law #1: no provider messages, keys,
// ids or stacks in any surfaced string).
//
// The SDK is injectable via `options.sdk` (a structural StripeSdkLike) so the
// in-process FakeStripe harness (tests/helpers/fake-stripe.ts) drives THIS
// production implementation with no network and no real Stripe calls. The
// legacy throwing members still reject — but only with a typed GatewayError
// whose `cause` keeps the original failure server-side.

import Stripe from "stripe";

import type { StudioEnv } from "@studio/config";
import type {
  StripeEventLike,
  StripeSdkLike,
  StripeSdkSubscriptionLike,
  StripeSeam,
  StripeSeamErrorCode,
  StripeSeamResult,
  SubscriptionSnapshot,
} from "./context.js";
import { GatewayError } from "./errors.js";

/** Injection point: an SDK-shaped client the seam drives instead of the real one. */
export interface StripeSeamOptions {
  readonly sdk?: StripeSdkLike;
}

export function createStripeSeam(
  env: StudioEnv,
  options: StripeSeamOptions = {},
): StripeSeam | null {
  if (env.stripe.secretKey === undefined) return null;
  // The assignment proves the real SDK satisfies the structural seam type;
  // tests inject the FakeStripe harness through options.sdk instead.
  const stripe: StripeSdkLike = options.sdk ?? new Stripe(env.stripe.secretKey);
  const seen = new Set<string>();
  // Stripe test clocks exist only in test mode — a live key is typed
  // not_configured below without any SDK call.
  const testClocksEnabled = /^(?:sk|rk)_test_/.test(env.stripe.secretKey);

  // ── typed error boundary ────────────────────────────────────────────────
  /**
   * Static, id-free failure classification. Only the SDK error's `type` and
   * `statusCode` feed the mapping — never its message (which may carry object
   * ids) or stack.
   */
  function classifySdkFailure(
    op: string,
    error: unknown,
  ): { code: StripeSeamErrorCode; reason: string } {
    const record =
      typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
    const type = typeof record.type === "string" ? record.type : "";
    const statusCode = typeof record.statusCode === "number" ? record.statusCode : 0;
    if (type === "invalid_request_error") {
      if (statusCode === 404)
        return { code: "not_found", reason: `stripe ${op}: object not found` };
      return { code: "invalid_request", reason: `stripe ${op}: request rejected` };
    }
    return { code: "upstream_error", reason: `stripe ${op}: request failed` };
  }

  /** Enveloped variant for the extended members ({ok:false, code, reason}). */
  function guarded<T>(op: string, run: () => Promise<T>): Promise<StripeSeamResult<T>> {
    return run().then(
      (data) => ({ ok: true as const, data }),
      (error: unknown) => ({ ok: false as const, ...classifySdkFailure(op, error) }),
    );
  }

  /**
   * Typed re-throw for the legacy throwing members (signature-compat with the
   * existing billing routes): the raw SDK error stays server-side in `cause`;
   * the envelope never carries provider messages, keys, ids or stacks.
   */
  async function guardedThrow<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw new GatewayError(
        "SERVICE_UNAVAILABLE",
        "The billing provider is unavailable right now.",
        {
          retryable: true,
          hint: "We couldn't reach the billing provider. Try again in a moment.",
          cause: error,
        },
      );
    }
  }

  // ── mapping helpers ────────────────────────────────────────────────────
  function mapSubscriptionStatus(raw: string): SubscriptionSnapshot["status"] {
    switch (raw) {
      case "trialing":
      case "active":
      case "past_due":
      case "canceled":
      case "incomplete":
        return raw;
      case "unpaid":
        return "past_due"; // dunning continues — grace-period behavior (§M6 task 2)
      case "incomplete_expired":
      case "paused":
        return "canceled"; // terminal / outside the product vocabulary
      default:
        return "canceled"; // an unknown status never grants entitlements
    }
  }

  function snapshotOf(sub: StripeSdkSubscriptionLike): SubscriptionSnapshot {
    const item = sub.items.data[0];
    const price = item?.price ?? null;
    return {
      status: mapSubscriptionStatus(sub.status),
      currentPeriodEnd: item?.current_period_end ?? 0,
      trialEnd: sub.trial_end === null ? undefined : sub.trial_end,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      subscriptionId: sub.id,
      priceId: typeof price === "string" ? price : price === null ? null : price.id,
    };
  }

  /** Newest subscription for a customer (Stripe lists newest first). */
  async function latestSubscription(customerId: string): Promise<StripeSdkSubscriptionLike | null> {
    const page = await stripe.subscriptions.list({ customer: customerId, limit: 10 });
    return page.data[0] ?? null;
  }

  function createCustomerVia(params: {
    email: string;
    metadata: Record<string, string>;
    testClock?: string;
  }): Promise<{ id: string }> {
    return guardedThrow(() =>
      stripe.customers
        .create({
          email: params.email,
          metadata: params.metadata,
          test_clock: params.testClock,
        })
        .then((customer) => ({ id: customer.id })),
    );
  }

  const seam: StripeSeam = {
    raw: stripe,

    async checkout(params) {
      const session = await guardedThrow(() =>
        stripe.checkout.sessions.create({
          mode: params.mode,
          line_items: [{ price: params.priceId, quantity: params.quantity ?? 1 }],
          customer: params.customerId,
          customer_email: params.customerId === undefined ? params.customerEmail : undefined,
          success_url: params.successUrl,
          cancel_url: params.cancelUrl,
          metadata: params.metadata,
          subscription_data:
            params.mode === "subscription" ? { metadata: params.metadata } : undefined,
          payment_intent_data:
            params.mode === "payment" ? { metadata: params.metadata } : undefined,
        }),
      );
      return { id: session.id, url: session.url ?? "" };
    },

    async portal(params) {
      const session = await guardedThrow(() =>
        stripe.billingPortal.sessions.create({
          customer: params.customerId,
          return_url: params.returnUrl,
        }),
      );
      return { id: session.id, url: session.url };
    },

    verifyWebhook(payload, signature) {
      if (signature === null || signature.length === 0) {
        return { ok: false as const, reason: "missing stripe-signature header" };
      }
      try {
        const event = stripe.webhooks.constructEvent(payload, signature, env.stripe.webhookSecret);
        const like = toEventLike(event);
        if (like === null) {
          return { ok: false as const, reason: "verified payload is not a stripe event" };
        }
        return { ok: true as const, event: like };
      } catch (error) {
        return {
          ok: false as const,
          reason: error instanceof Error ? error.message : "signature verification failed",
        };
      }
    },

    createCustomer(params) {
      return createCustomerVia(params);
    },

    seenEvent(id) {
      if (seen.has(id)) return true;
      seen.add(id);
      return false;
    },

    markEventSeen(id) {
      seen.add(id);
    },

    async topUpCheckout(params) {
      return guarded("checkout.sessions.create", () =>
        stripe.checkout.sessions
          .create({
            mode: "payment",
            line_items: [{ price: params.packId, quantity: params.quantity }],
            customer: params.customerId,
            customer_email: params.customerId === undefined ? params.customerEmail : undefined,
            success_url: params.successUrl,
            cancel_url: params.cancelUrl,
            metadata: params.metadata,
            payment_intent_data: { metadata: params.metadata },
          })
          .then((session) => ({ id: session.id, url: session.url ?? "" })),
      );
    },

    async subscription(customerId) {
      const listed = await guarded("subscriptions.list", () => latestSubscription(customerId));
      if (!listed.ok) return listed;
      if (listed.data === null) {
        return {
          ok: false as const,
          code: "not_found" as const,
          reason: "no subscription found for customer",
        };
      }
      return { ok: true as const, data: snapshotOf(listed.data) };
    },

    // BIL-04: resolve a completed Checkout session's card fingerprint —
    // `payment_method` directly when present, else through the payment
    // intent's latest charge. Null when the chain carries no card (bank
    // transfers, free sessions); typed failures, never throws.
    async checkoutSessionCardFingerprint(sessionId) {
      const fetched = await guarded("checkout.sessions.retrieve", () =>
        stripe.checkout.sessions.retrieve(sessionId, {
          expand: ["payment_intent.latest_charge.payment_method"],
        }),
      );
      if (!fetched.ok) return fetched;
      const session = fetched.data;
      // Direct PM (payment-mode sessions, expanded): carry card details only
      // when the SDK expanded it — else fall through to the intent chain.
      const direct = session.payment_method;
      if (typeof direct === "object" && direct !== null && direct.card != null) {
        const fingerprint = direct.card.fingerprint;
        if (typeof fingerprint === "string" && fingerprint !== "") {
          return { ok: true as const, data: { fingerprint } };
        }
      }
      const intent = session.payment_intent;
      if (typeof intent === "object" && intent !== null) {
        const charge = intent.latest_charge;
        if (typeof charge === "object" && charge !== null) {
          const method = charge.payment_method;
          if (typeof method === "object" && method !== null && method.card != null) {
            const fingerprint = method.card.fingerprint;
            if (typeof fingerprint === "string" && fingerprint !== "") {
              return { ok: true as const, data: { fingerprint } };
            }
          }
        }
      }
      return { ok: true as const, data: { fingerprint: null } };
    },

    async updateSubscription(customerId, params) {
      const listed = await guarded("subscriptions.list", () => latestSubscription(customerId));
      if (!listed.ok) return listed;
      const sub = listed.data;
      if (sub === null) {
        return {
          ok: false as const,
          code: "not_found" as const,
          reason: "no subscription found for customer",
        };
      }
      const item = sub.items.data[0];
      if (item === undefined) {
        return {
          ok: false as const,
          code: "invalid_request" as const,
          reason: "subscription has no items to update",
        };
      }
      return guarded("subscriptions.update", async () => {
        const updated = await stripe.subscriptions.update(sub.id, {
          items: [{ id: item.id, price: params.planPriceKey }],
          cancel_at_period_end: params.cancelAtPeriodEnd,
        });
        return snapshotOf(updated);
      });
    },

    async createTestClock(params) {
      if (!testClocksEnabled) {
        return {
          ok: false as const,
          code: "not_configured" as const,
          reason: "test clocks require a Stripe test-mode key",
        };
      }
      return guarded("testHelpers.testClocks.create", () =>
        stripe.testHelpers.testClocks
          .create({
            frozen_time: params.frozenTime,
            customer: params.customerId,
            name: params.name,
          })
          .then((clock) => ({
            id: clock.id,
            frozenTime: clock.frozen_time,
            status: clock.status,
          })),
      );
    },

    withTestClock(clockId) {
      if (!testClocksEnabled) {
        return {
          ok: false as const,
          code: "not_configured" as const,
          reason: "test clocks require a Stripe test-mode key",
        };
      }
      // Decorator: only customer creation differs (Stripe propagates the
      // customer's clock to their subscriptions). Everything else — the
      // seen-event set included — is shared with the base seam.
      const clocked: StripeSeam = {
        ...seam,
        createCustomer: (params) => createCustomerVia({ ...params, testClock: clockId }),
      };
      return { ok: true as const, data: clocked };
    },
  };

  return seam;
}

/** Structural check of a verified webhook payload before it crosses the seam. */
function toEventLike(value: unknown): StripeEventLike | null {
  if (typeof value !== "object" || value === null) return null;
  const event = value as Record<string, unknown>;
  if (typeof event.id !== "string" || typeof event.type !== "string") return null;
  const data = event.data;
  if (typeof data !== "object" || data === null) return null;
  const object = (data as Record<string, unknown>).object;
  if (typeof object !== "object" || object === null) return null;
  return value as unknown as StripeEventLike;
}
