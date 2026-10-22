// M6-B — the Stripe seam proof pack (BUILD_PLAN §M6 task 2 + task 6; D-4:
// trial is a subscription state). Drives the PRODUCTION seam
// (src/stripe.ts createStripeSeam) against the in-process FakeStripe
// harness (tests/helpers/fake-stripe.ts) — no network, no real Stripe
// calls, deterministic wall clock (fixed epoch, never Date.now()).
//
// Covers: signature verification (valid / missing / tampered / wrong secret /
// stale timestamp / multi-v1), webhook idempotency (seenEvent + markEventSeen
// with replay), checkout/topUp/portal/customer happy paths, the typed error
// boundary (SDK failures → GatewayError on legacy members, {ok:false, code,
// reason} on extended members — no SDK text, keys or ids cross), the full
// subscription lifecycle via test clocks (trial → renewal → past_due grace →
// canceled, cancel-at-period-end), out-of-order delivery, and the
// fake.seam facade M6-C's route tests can inject as deps.stripe.

import { beforeEach, describe, expect, it } from "vitest";

import type { StudioEnv } from "@studio/config";

import type { StripeSeam } from "../src/context.js";
import { GatewayError } from "../src/errors.js";
import { createStripeSeam } from "../src/stripe.js";
import { testEnv } from "./helpers.js";
import {
  FAKE_NOW_MS,
  FAKE_STRIPE_SECRET_KEY,
  FAKE_WEBHOOK_SECRET,
  FakeStripe,
  FakeStripeSdkError,
  unwrapSeam,
} from "./helpers/fake-stripe.js";

const NOW_SECONDS = Math.floor(FAKE_NOW_MS / 1000);
const TRIAL_SECONDS = 14 * 86_400;
const PERIOD_SECONDS = 30 * 86_400;
const PRICE_STARTER = "price_test_starter";
const PRICE_PRO = "price_test_pro";
const PRICE_PACK = "price_test_pack_500";

function stripeEnv(overrides: Record<string, string | undefined> = {}): StudioEnv {
  return testEnv({
    STRIPE_SECRET_KEY: FAKE_STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET,
    ...overrides,
  });
}

function makeSeam(env: StudioEnv, fake: FakeStripe): StripeSeam {
  const seam = createStripeSeam(env, { sdk: fake.sdk });
  if (seam === null) throw new Error("makeSeam: seam unexpectedly null");
  return seam;
}

let fake: FakeStripe;
let seam: StripeSeam;

beforeEach(() => {
  fake = new FakeStripe();
  seam = makeSeam(stripeEnv(), fake);
});

/** A clocked trial subscription, exactly as M6-C's checkout flow will build it. */
async function clockedTrial(
  options: { frozenTime?: number } = {},
): Promise<{ customerId: string; clockId: string; sessionId: string; subscriptionId: string }> {
  const clock = unwrapSeam(
    await seam.createTestClock({ frozenTime: options.frozenTime ?? NOW_SECONDS, name: "trial" }),
  );
  const clocked = unwrapSeam(seam.withTestClock(clock.id));
  const customer = await clocked.createCustomer({
    email: "trial@w3gw.test",
    metadata: { organizationId: "org_fake_1" },
  });
  const session = await seam.checkout({
    mode: "subscription",
    priceId: PRICE_STARTER,
    customerId: customer.id,
    successUrl: "http://localhost:3000/billing?checkout=success",
    cancelUrl: "http://localhost:3000/billing?checkout=cancelled",
    metadata: { organizationId: "org_fake_1", kind: "subscription", planId: "starter" },
  });
  fake.completeCheckout(session.id);
  const sub = fake.subscriptions.get("sub_fake_1");
  if (sub === undefined) throw new Error("clockedTrial: subscription was not created");
  return {
    customerId: customer.id,
    clockId: clock.id,
    sessionId: session.id,
    subscriptionId: sub.id,
  };
}

describe("createStripeSeam configuration", () => {
  it("returns null when STRIPE_SECRET_KEY is unset (null-when-unconfigured)", () => {
    expect(createStripeSeam(testEnv({ STRIPE_WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET }))).toBeNull();
  });

  it("constructs the real seam over the injected SDK (raw exposes the injected client)", () => {
    expect(seam.raw).toBe(fake.sdk);
  });

  it("typed not_configured test clocks with a LIVE key — no SDK call is made", async () => {
    const liveSeam = makeSeam(stripeEnv({ STRIPE_SECRET_KEY: "sk_live_fake" }), fake);
    const clock = await liveSeam.createTestClock({ frozenTime: NOW_SECONDS });
    expect(clock).toEqual({
      ok: false,
      code: "not_configured",
      reason: "test clocks require a Stripe test-mode key",
    });
    expect(liveSeam.withTestClock("clock_fake_1")).toEqual({
      ok: false,
      code: "not_configured",
      reason: "test clocks require a Stripe test-mode key",
    });
    expect(fake.clocks.size).toBe(0);
  });
});

describe("webhook signature verification (real seam ← fake-signed payloads)", () => {
  it("accepts a validly signed event and surfaces its typed view", () => {
    const event = fake.scriptEvent("checkout.session.completed", {
      id: "cs_fake_1",
      object: "checkout_session",
      status: "complete",
      metadata: { organizationId: "org_fake_1", kind: "pack", credits: "500" },
    });
    const { payload, signature } = fake.signWebhook(event);
    const verified = seam.verifyWebhook(payload, signature);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.event.id).toBe(event.id);
      expect(verified.event.type).toBe("checkout.session.completed");
      expect(verified.event.data.object.metadata?.credits).toBe("500");
    }
  });

  it("rejects a missing stripe-signature header", () => {
    const event = fake.scriptEvent("checkout.session.completed", { id: "cs_fake_1" });
    const { payload } = fake.signWebhook(event);
    expect(seam.verifyWebhook(payload, null)).toEqual({
      ok: false,
      reason: "missing stripe-signature header",
    });
  });

  it("rejects a tampered payload (signature over different bytes)", () => {
    const signed = fake.scriptEvent("checkout.session.completed", { id: "cs_fake_1" });
    const other = fake.scriptEvent("checkout.session.completed", { id: "cs_fake_EVIL" });
    const { payload } = fake.signWebhook(signed);
    const { signature } = fake.signWebhook(other);
    const verified = seam.verifyWebhook(payload, signature);
    expect(verified.ok).toBe(false);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const event = fake.scriptEvent("checkout.session.completed", { id: "cs_fake_1" });
    const { payload } = fake.signWebhook(event);
    const signature = fake.signPayload(payload, { secret: "whsec_wrong_secret" });
    expect(seam.verifyWebhook(payload, signature).ok).toBe(false);
  });

  it("enforces Stripe's 300s tolerance: 299s old passes, 301s is rejected", () => {
    const event = fake.scriptEvent("checkout.session.completed", { id: "cs_fake_1" });
    const { payload } = fake.signWebhook(event);
    const fresh = fake.signPayload(payload, { timestampSeconds: NOW_SECONDS - 299 });
    expect(seam.verifyWebhook(payload, fresh).ok).toBe(true);
    const stale = fake.signPayload(payload, { timestampSeconds: NOW_SECONDS - 301 });
    const verified = seam.verifyWebhook(payload, stale);
    expect(verified).toEqual({
      ok: false,
      reason: "Timestamp outside the tolerance zone.",
    });
  });

  it("accepts a multi-v1 header when any entry matches (Stripe's v1 list)", () => {
    const event = fake.scriptEvent("checkout.session.completed", { id: "cs_fake_1" });
    const { payload } = fake.signWebhook(event);
    const [timePart, v1Part] = fake.signPayload(payload).split(",");
    const header = `${timePart},${v1Part},v1=${"0".repeat(64)}`;
    expect(seam.verifyWebhook(payload, header).ok).toBe(true);
  });

  it("signs byte-identically twice (deterministic harness, no Date.now())", () => {
    const event = fake.scriptEvent("checkout.session.completed", { id: "cs_fake_1" });
    const first = fake.signWebhook(event);
    const second = fake.signWebhook(event);
    expect(second.payload.equals(first.payload)).toBe(true);
    expect(second.signature).toBe(first.signature);
  });
});

describe("webhook idempotency (seenEvent / markEventSeen)", () => {
  it("seenEvent claims an event id exactly once — a replayed webhook dedups", () => {
    const event = fake.scriptEvent("checkout.session.completed", {
      metadata: { organizationId: "org_fake_1", credits: "500" },
    });
    const { payload, signature } = fake.signWebhook(event);
    const first = seam.verifyWebhook(payload, signature);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(seam.seenEvent(first.event.id)).toBe(false); // first delivery claims
      const replay = seam.verifyWebhook(payload, signature);
      expect(replay.ok).toBe(true); // the signature itself is still valid…
      if (replay.ok) {
        expect(seam.seenEvent(replay.event.id)).toBe(true); // …but the id is seen
        expect(replay.event.id).toBe(first.event.id);
      }
    }
  });

  it("markEventSeen pre-marks an id without claiming (complement of seenEvent)", () => {
    const event = fake.scriptEvent("invoice.paid", { id: "in_fake_1" });
    seam.markEventSeen(event.id);
    expect(seam.seenEvent(event.id)).toBe(true);
    seam.markEventSeen(event.id); // idempotent
    expect(seam.seenEvent(event.id)).toBe(true);
    // unrelated ids are still claimable
    expect(seam.seenEvent("evt_fake_999")).toBe(false);
  });
});

describe("checkout / top-up / portal / customer happy paths (real seam ← fake SDK)", () => {
  it("checkout (subscription) creates an open session with metadata — no subscription until completion", async () => {
    const session = await seam.checkout({
      mode: "subscription",
      priceId: PRICE_STARTER,
      customerEmail: "buyer@w3gw.test",
      successUrl: "http://localhost:3000/billing?checkout=success",
      cancelUrl: "http://localhost:3000/billing?checkout=cancelled",
      metadata: { organizationId: "org_fake_1", kind: "subscription", planId: "starter" },
    });
    expect(session.id).toBe("cs_fake_1");
    expect(session.url).toBe(`https://checkout.stripe.com/fake/${session.id}`);
    const stored = fake.sessions.get(session.id);
    expect(stored).toMatchObject({
      mode: "subscription",
      priceId: PRICE_STARTER,
      status: "open",
      customerEmail: "buyer@w3gw.test",
      metadata: { organizationId: "org_fake_1", planId: "starter" },
    });
    expect(fake.subscriptions.size).toBe(0);
  });

  it("topUpCheckout (payment mode) honors quantity and links the customer when known", async () => {
    const customer = await seam.createCustomer({
      email: "topup@w3gw.test",
      metadata: { organizationId: "org_fake_1" },
    });
    expect(customer.id).toBe("cus_fake_1");
    const topUp = unwrapSeam(
      await seam.topUpCheckout({
        packId: PRICE_PACK,
        quantity: 3,
        customerId: customer.id,
        customerEmail: "ignored-when-customer-known@w3gw.test",
        successUrl: "http://localhost:3000/billing?checkout=success",
        cancelUrl: "http://localhost:3000/billing?checkout=cancelled",
        metadata: {
          organizationId: "org_fake_1",
          kind: "pack",
          packId: "pack_500",
          credits: "500",
        },
      }),
    );
    expect(topUp.id).toBe("cs_fake_1");
    expect(topUp.url).toContain("https://checkout.stripe.com/fake/");
    expect(fake.sessions.get(topUp.id)).toMatchObject({
      mode: "payment",
      priceId: PRICE_PACK,
      quantity: 3,
      customerId: customer.id,
      customerEmail: null,
      metadata: { kind: "pack", credits: "500" },
    });
  });

  it("portal returns a billing-portal session for a known customer", async () => {
    const customer = await seam.createCustomer({ email: "portal@w3gw.test", metadata: {} });
    const portal = await seam.portal({
      customerId: customer.id,
      returnUrl: "http://localhost:3000/billing",
    });
    expect(portal.id).toBe("bps_fake_1");
    expect(portal.url).toBe(`https://billing.stripe.com/fake/session/${portal.id}`);
  });

  it("typed boundary on a legacy throwing member: SDK failure → GatewayError, cause server-side only", async () => {
    fake.queueSdkFailure({ type: "api_error", message: "api key sk_live_SECRET rejected" });
    const failure = await seam
      .checkout({
        mode: "subscription",
        priceId: PRICE_STARTER,
        customerEmail: "buyer@w3gw.test",
        successUrl: "http://localhost:3000/s",
        cancelUrl: "http://localhost:3000/c",
        metadata: {},
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(GatewayError);
    const gatewayError = failure as GatewayError;
    expect(gatewayError.code).toBe("SERVICE_UNAVAILABLE");
    expect(gatewayError.message).toBe("The billing provider is unavailable right now.");
    expect(gatewayError.cause).toBeInstanceOf(FakeStripeSdkError);
    expect(gatewayError.message).not.toContain("sk_live_SECRET"); // no SDK text, keys or stacks
  });

  it("typed boundary on an extended member: SDK failure → {ok:false, code, reason}, no SDK text", async () => {
    fake.queueSdkFailure({
      type: "invalid_request_error",
      statusCode: 404,
      message: "No such customer: 'cus_leaked_id'",
    });
    const result = await seam.subscription("cus_nope");
    expect(result).toEqual({
      ok: false,
      code: "not_found",
      reason: "stripe subscriptions.list: object not found",
    });
  });
});

describe("subscription lifecycle via test clocks (real seam ← fake SDK)", () => {
  it("subscription() with no subscription → typed not_found", async () => {
    const result = await seam.subscription("cus_fake_never");
    expect(result).toEqual({
      ok: false,
      code: "not_found",
      reason: "no subscription found for customer",
    });
  });

  it("trial checkout completes → trialing snapshot (D-4: trial is a subscription state)", async () => {
    const { customerId } = await clockedTrial();
    const snapshot = unwrapSeam(await seam.subscription(customerId));
    expect(snapshot).toEqual({
      status: "trialing",
      currentPeriodEnd: NOW_SECONDS + PERIOD_SECONDS,
      trialEnd: NOW_SECONDS + TRIAL_SECONDS,
      cancelAtPeriodEnd: false,
      subscriptionId: "sub_fake_1",
      priceId: PRICE_STARTER,
    });
  });

  it("the clock's frozen time anchors the subscription (not the wall clock)", async () => {
    const { customerId } = await clockedTrial({ frozenTime: NOW_SECONDS + 86_400 });
    const snapshot = unwrapSeam(await seam.subscription(customerId));
    expect(snapshot.trialEnd).toBe(NOW_SECONDS + 86_400 + TRIAL_SECONDS);
    expect(snapshot.currentPeriodEnd).toBe(NOW_SECONDS + 86_400 + PERIOD_SECONDS);
  });

  it("trialing → active when the clock passes trial end", async () => {
    const { customerId, clockId } = await clockedTrial();
    const events = fake.advanceTestClock(clockId, NOW_SECONDS + TRIAL_SECONDS);
    expect(events.map((event) => event.type)).toEqual(["customer.subscription.updated"]);
    const snapshot = unwrapSeam(await seam.subscription(customerId));
    expect(snapshot.status).toBe("active");
  });

  it("a healthy renewal advances the billing period", async () => {
    const { customerId, clockId } = await clockedTrial();
    fake.advanceTestClock(clockId, NOW_SECONDS + TRIAL_SECONDS); // trial → active
    fake.advanceTestClock(clockId, NOW_SECONDS + PERIOD_SECONDS + 1); // renewal
    const snapshot = unwrapSeam(await seam.subscription(customerId));
    expect(snapshot.status).toBe("active");
    expect(snapshot.currentPeriodEnd).toBe(NOW_SECONDS + 2 * PERIOD_SECONDS);
  });

  it("a failing renewal → past_due (grace period), then canceled after the dunning cycle", async () => {
    const { customerId, clockId } = await clockedTrial();
    fake.advanceTestClock(clockId, NOW_SECONDS + TRIAL_SECONDS); // trial → active
    fake.setPaymentFailing(customerId, true);
    const dueEvents = fake.advanceTestClock(clockId, NOW_SECONDS + PERIOD_SECONDS + 1);
    expect(dueEvents.at(-1)?.type).toBe("customer.subscription.updated");
    expect(unwrapSeam(await seam.subscription(customerId)).status).toBe("past_due");

    const graceEnd = fake.advanceTestClock(clockId, NOW_SECONDS + 2 * PERIOD_SECONDS + 1);
    expect(graceEnd.at(-1)?.type).toBe("customer.subscription.deleted");
    expect(unwrapSeam(await seam.subscription(customerId)).status).toBe("canceled");
  });

  it("updateSubscription swaps the plan price and flags cancel-at-period-end; the clock then cancels at the boundary", async () => {
    const { customerId, clockId } = await clockedTrial();
    fake.advanceTestClock(clockId, NOW_SECONDS + TRIAL_SECONDS); // trial → active
    const updated = unwrapSeam(
      await seam.updateSubscription(customerId, {
        planPriceKey: PRICE_PRO,
        cancelAtPeriodEnd: true,
      }),
    );
    expect(updated).toMatchObject({
      status: "active",
      priceId: PRICE_PRO,
      cancelAtPeriodEnd: true,
    });
    const cancelEvents = fake.advanceTestClock(clockId, NOW_SECONDS + PERIOD_SECONDS + 1);
    expect(cancelEvents.at(-1)?.type).toBe("customer.subscription.deleted");
    const snapshot = unwrapSeam(await seam.subscription(customerId));
    expect(snapshot.status).toBe("canceled");
    // updating a canceled subscription is a typed invalid_request
    const rejected = await seam.updateSubscription(customerId, { planPriceKey: PRICE_PRO });
    expect(rejected).toMatchObject({ ok: false, code: "invalid_request" });
  });

  it("updateSubscription without a cancel flag leaves the flag unchanged", async () => {
    const { customerId } = await clockedTrial();
    const updated = unwrapSeam(
      await seam.updateSubscription(customerId, { planPriceKey: PRICE_PRO }),
    );
    expect(updated.priceId).toBe(PRICE_PRO);
    expect(updated.cancelAtPeriodEnd).toBe(false);
  });

  it("updateSubscription on an unknown customer → typed not_found", async () => {
    const result = await seam.updateSubscription("cus_fake_never", { planPriceKey: PRICE_PRO });
    expect(result).toEqual({
      ok: false,
      code: "not_found",
      reason: "no subscription found for customer",
    });
  });
});

describe("event delivery: out-of-order and replay controls", () => {
  it("signatures verify independently of delivery order; seenEvent dedups a replayed id", () => {
    const completed = fake.scriptEvent("checkout.session.completed", {
      id: "cs_fake_1",
      metadata: { organizationId: "org_fake_1", credits: "500", kind: "subscription" },
    });
    const updated = fake.scriptEvent("customer.subscription.updated", {
      id: "sub_fake_1",
      status: "active",
    });
    expect(fake.pendingWebhooks().length).toBe(2);

    // Deliver in REVERSE creation order (out-of-order events).
    const delivered = [updated, completed];
    for (const event of delivered) {
      const { payload, signature } = fake.signWebhook(event);
      const verified = seam.verifyWebhook(payload, signature);
      expect(verified.ok).toBe(true);
      if (verified.ok) expect(seam.seenEvent(verified.event.id)).toBe(false);
    }

    // Replay the already-delivered id: still signed validly, but seen.
    const { payload, signature } = fake.signWebhook(updated);
    const replay = seam.verifyWebhook(payload, signature);
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(seam.seenEvent(replay.event.id)).toBe(true);
  });

  it("completeCheckout emits subscription.created then checkout.session.completed, requeueable", async () => {
    const customer = await seam.createCustomer({ email: "events@w3gw.test", metadata: {} });
    const session = await seam.checkout({
      mode: "subscription",
      priceId: PRICE_STARTER,
      customerId: customer.id,
      successUrl: "http://localhost:3000/s",
      cancelUrl: "http://localhost:3000/c",
      metadata: { organizationId: "org_fake_1", kind: "subscription", planId: "starter" },
    });
    const events = fake.completeCheckout(session.id);
    expect(events.map((event) => event.type)).toEqual([
      "customer.subscription.created",
      "checkout.session.completed",
    ]);
    // Drain the delivery queue like real webhook deliveries, then replay.
    expect(fake.nextWebhook()?.type).toBe("customer.subscription.created");
    expect(fake.nextWebhook()?.type).toBe("checkout.session.completed");
    const completed = events[1];
    if (completed === undefined) throw new Error("checkout.session.completed not emitted");
    fake.requeueWebhook(completed);
    const requeued = fake.nextWebhook();
    if (requeued === null) throw new Error("event was not re-queued");
    expect(requeued.id).toBe(completed.id);
    const { payload, signature } = fake.signWebhook(requeued);
    const verified = seam.verifyWebhook(payload, signature);
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(seam.seenEvent(verified.event.id)).toBe(false);
  });
});

describe("FakeStripe.seam facade (the harness M6-C injects as deps.stripe)", () => {
  it("implements the full StripeSeam over the store", async () => {
    const facade = fake.seam;
    const customer = await facade.createCustomer({
      email: "facade@w3gw.test",
      metadata: { organizationId: "org_fake_1" },
    });
    const session = await facade.checkout({
      mode: "subscription",
      priceId: PRICE_STARTER,
      customerId: customer.id,
      successUrl: "http://localhost:3000/s",
      cancelUrl: "http://localhost:3000/c",
      metadata: { organizationId: "org_fake_1", kind: "subscription", planId: "starter" },
    });
    fake.completeCheckout(session.id);
    expect(unwrapSeam(await facade.subscription(customer.id))).toMatchObject({
      status: "trialing",
      priceId: PRICE_STARTER,
    });
    expect(
      unwrapSeam(
        await facade.topUpCheckout({
          packId: PRICE_PACK,
          quantity: 1,
          customerEmail: "facade@w3gw.test",
          successUrl: "http://localhost:3000/s",
          cancelUrl: "http://localhost:3000/c",
          metadata: { kind: "pack" },
        }),
      ).id,
    ).toBe("cs_fake_2");

    const clock = unwrapSeam(await facade.createTestClock({ frozenTime: NOW_SECONDS }));
    expect(unwrapSeam(facade.withTestClock(clock.id)).raw).toBe(fake);

    const event = fake.scriptEvent("checkout.session.completed", { id: "cs_fake_1" });
    const { payload, signature } = fake.signWebhook(event);
    const verified = facade.verifyWebhook(payload, signature);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(facade.seenEvent(verified.event.id)).toBe(false);
      facade.markEventSeen(verified.event.id);
      expect(facade.seenEvent(verified.event.id)).toBe(true);
    }
    expect(await facade.subscription("cus_fake_none")).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });
});
