// M6-B — FakeStripe: an in-process harness for the Stripe seam (the M4-K
// FakeOpenAIServer pattern, applied at the SDK seam instead of the wire).
//
// NO network, NO real Stripe: every SDK call mutates an in-memory store, and
// webhook payloads are signed/verified locally with HMAC-SHA256 mirroring
// Stripe's `t=<unix>,v1=<hex>` header scheme (including the 300-second
// tolerance and multi-v1 list semantics) — verified against the production
// seam's verifyWebhook when tests drive the REAL seam through `fake.sdk`.
//
// Two consumption modes:
//   * `fake.sdk`  — inject into createStripeSeam(env, { sdk }) to exercise
//     the PRODUCTION seam implementation (src/stripe.ts) against this store.
//   * `fake.seam` — a ready-made StripeSeam facade over the same store, for
//     route-level tests that inject `deps.stripe` (M6-C's billing routes).
//
// Scripting API (deterministic — `now` is a fixed epoch, never Date.now()):
//   fake.scriptEvent(type, object)            author + queue a webhook event
//   fake.eventLog / fake.pendingWebhooks()    every emitted event, in order
//   fake.nextWebhook()                        pop the pending queue (FIFO)
//   fake.requeueWebhook(event)                re-queue for replay tests
//   fake.signWebhook(event, opts?)            signed wire form {payload, signature}
//   fake.signPayload(payload, opts?)           low-level signer (tamper tests)
//   fake.completeCheckout(sessionId)          pay a session; emits
//                                             checkout.session.completed (+
//                                             customer.subscription.created
//                                             for subscription mode)
//   fake.setPaymentFailing(customerId, bool)  make renewals fail → past_due
//   fake.advanceTestClock(clockId, seconds)   advance a clock; deterministic
//                                             trial→active / renewal /
//                                             past_due / cancel transitions
//   fake.queueSdkFailure({type, statusCode})  next SDK call throws (typed
//                                             error-boundary tests)

import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  StripeEventLike,
  StripeSdkLike,
  StripeSeam,
  StripeSeamResult,
  SubscriptionSnapshot,
} from "../../src/context.js";

/** Test-mode key shape the real seam accepts (test-clock gating). */
export const FAKE_STRIPE_SECRET_KEY = "sk_test_fake_stripe_seam";
/** Must equal the env's STRIPE_WEBHOOK_SECRET when driving the real seam. */
export const FAKE_WEBHOOK_SECRET = "whsec_test_fake_stripe";

/** Deterministic base time: 2025-01-01T00:00:00.000Z. */
export const FAKE_NOW_MS = 1_735_689_600_000;

const FAKE_API_VERSION = "2026-09-30.endive";
/** D-4 / BUILD_PLAN §M6: 14-day trial on the Starter row. */
const TRIAL_SECONDS = 14 * 86_400;
/** 30-day billing period. */
const PERIOD_SECONDS = 30 * 86_400;
/** Past-due dunning in the fake: one more 30-day cycle, then canceled. */
const GRACE_SECONDS = 30 * 86_400;
/** Stripe's default webhook signature tolerance. */
const SIGNATURE_TOLERANCE_SECONDS = 300;

// ───────────────────────────────────────────────────────────────────────────
// Wire shapes
// ───────────────────────────────────────────────────────────────────────────

export interface FakeStripeEvent {
  readonly id: string;
  readonly object: "event";
  readonly api_version: string;
  readonly created: number;
  readonly data: { readonly object: Record<string, unknown> };
  readonly livemode: false;
  readonly pending_webhooks: number;
  readonly request: { readonly id: string; readonly idempotency_key: null };
  readonly type: string;
}

export interface FakeCustomer {
  readonly id: string;
  readonly email: string | null;
  readonly metadata: Record<string, string>;
  readonly testClock: string | null;
}

export interface FakeCheckoutSession {
  readonly id: string;
  readonly mode: "payment" | "subscription";
  readonly priceId: string;
  readonly quantity: number;
  readonly customerEmail: string | null;
  readonly metadata: Record<string, string>;
  status: "open" | "complete";
  customerId: string | null;
  subscriptionId: string | null;
  readonly createdAt: number;
}

export interface FakeSubscription {
  readonly id: string;
  readonly customerId: string;
  readonly itemId: string;
  priceId: string;
  readonly quantity: number;
  status: "trialing" | "active" | "past_due" | "canceled" | "incomplete";
  trialEnd: number | null;
  currentPeriodStart: number;
  currentPeriodEnd: number;
  cancelAtPeriodEnd: boolean;
  readonly metadata: Record<string, string>;
}

export interface FakeTestClock {
  readonly id: string;
  readonly name: string | null;
  frozenTime: number;
  status: string;
}

export interface ScriptedSdkFailure {
  /** Mirrors StripeError.type, e.g. "invalid_request_error" | "api_error". */
  readonly type: string;
  readonly statusCode?: number;
  readonly message?: string;
}

/** Mirrors the Stripe SDK's error shape for the seam's typed boundary. */
export class FakeStripeSdkError extends Error {
  readonly type: string;
  readonly statusCode: number | undefined;

  constructor(init: ScriptedSdkFailure) {
    super(init.message ?? `fake stripe failure: ${init.type}`);
    this.name = "FakeStripeSdkError";
    this.type = init.type;
    this.statusCode = init.statusCode;
  }
}

/** Stripe API 2026-09-30 shape: the period lives on the subscription item. */
type FakeSubscriptionWire = {
  readonly id: string;
  readonly object: "subscription";
  readonly customer: string;
  readonly status: string;
  readonly trial_end: number | null;
  readonly cancel_at_period_end: boolean;
  readonly cancel_at: null;
  readonly current_period_start: number;
  readonly current_period_end: number;
  readonly items: {
    readonly object: "list";
    readonly data: ReadonlyArray<{
      readonly id: string;
      readonly object: "subscription_item";
      readonly price: string;
      readonly quantity: number;
      readonly current_period_start: number;
      readonly current_period_end: number;
    }>;
    readonly has_more: boolean;
    readonly total_count: number;
    readonly url: string;
  };
  readonly metadata: Record<string, string>;
  readonly livemode: false;
};

interface ParsedSignature {
  readonly timestamp: number;
  readonly signatures: readonly string[];
}

// ───────────────────────────────────────────────────────────────────────────
// The harness
// ───────────────────────────────────────────────────────────────────────────

export class FakeStripe {
  /** The fake's wall clock in ms — settable for tolerance tests. Never Date.now(). */
  now: number;
  readonly webhookSecret: string;

  /** In-memory stores (inspectable for assertions). */
  readonly customers = new Map<string, FakeCustomer>();
  readonly subscriptions = new Map<string, FakeSubscription>();
  readonly sessions = new Map<string, FakeCheckoutSession>();
  readonly clocks = new Map<string, FakeTestClock>();
  /**
   * BIL-04: card fingerprints by Checkout session id — models what REAL
   * Stripe exposes through the session's payment chain (the fake's metadata
   * path stays available; tests choose which model to exercise).
   */
  readonly cardFingerprintBySession = new Map<string, string>();

  /** Every emitted event, in creation order (replay/ordering tests read this). */
  readonly eventLog: FakeStripeEvent[] = [];

  private readonly pending: FakeStripeEvent[] = [];
  private readonly failures: ScriptedSdkFailure[] = [];
  private readonly seenBySeam = new Set<string>();
  private readonly paymentFailing = new Set<string>();
  private counters = {
    customer: 0,
    session: 0,
    subscription: 0,
    item: 0,
    clock: 0,
    portal: 0,
    event: 0,
  };

  constructor(options: { webhookSecret?: string; now?: number } = {}) {
    this.webhookSecret = options.webhookSecret ?? FAKE_WEBHOOK_SECRET;
    this.now = options.now ?? FAKE_NOW_MS;
  }

  // ── seam + sdk surfaces ────────────────────────────────────────────────

  /** SDK-shaped fake: pass to createStripeSeam(env, { sdk }). */
  readonly sdk: StripeSdkLike = {
    checkout: {
      sessions: {
        create: (params) => {
          this.maybeFail();
          const item = params.line_items[0];
          if (item === undefined) {
            throw new FakeStripeSdkError({
              type: "invalid_request_error",
              message: "line_items required",
            });
          }
          if (params.customer === undefined && params.customer_email === undefined) {
            throw new FakeStripeSdkError({
              type: "invalid_request_error",
              message: "customer or customer_email required",
            });
          }
          if (params.customer !== undefined && !this.customers.has(params.customer)) {
            throw new FakeStripeSdkError({
              type: "invalid_request_error",
              statusCode: 404,
              message: "No such customer",
            });
          }
          this.counters.session += 1;
          const id = `cs_fake_${this.counters.session}`;
          const session: FakeCheckoutSession = {
            id,
            mode: params.mode,
            priceId: item.price,
            quantity: item.quantity ?? 1,
            customerEmail: params.customer_email ?? null,
            metadata: params.metadata ?? {},
            status: "open",
            customerId: params.customer ?? null,
            subscriptionId: null,
            createdAt: this.wallSeconds(),
          };
          this.sessions.set(id, session);
          return Promise.resolve({ id, url: `https://checkout.stripe.com/fake/${id}` });
        },
        // BIL-04: the session retrieve the seam's card-fingerprint read uses.
        // Unknown id → the SDK's 404 shape; a fingerprint set via
        // cardFingerprintBySession models the expanded payment chain.
        retrieve: (id: string) => {
          this.maybeFail();
          const session = this.sessions.get(id);
          if (session === undefined) {
            throw new FakeStripeSdkError({
              type: "invalid_request_error",
              statusCode: 404,
              message: "No such checkout session",
            });
          }
          const fingerprint = this.cardFingerprintBySession.get(id);
          const paymentMethod =
            fingerprint === undefined ? null : { id: `pm_fake_${id}`, card: { fingerprint } };
          return Promise.resolve({
            id: session.id,
            payment_status: session.status === "complete" ? "paid" : "unpaid",
            payment_method: null,
            payment_intent: {
              id: `pi_fake_${session.id}`,
              latest_charge:
                paymentMethod === null
                  ? null
                  : { id: `ch_fake_${session.id}`, payment_method: paymentMethod },
            },
          });
        },
      },
    },
    billingPortal: {
      sessions: {
        create: (params) => {
          this.maybeFail();
          if (!this.customers.has(params.customer)) {
            throw new FakeStripeSdkError({
              type: "invalid_request_error",
              statusCode: 404,
              message: "No such customer",
            });
          }
          this.counters.portal += 1;
          const id = `bps_fake_${this.counters.portal}`;
          return Promise.resolve({
            id,
            url: `https://billing.stripe.com/fake/session/${id}`,
          });
        },
      },
    },
    customers: {
      create: (params) => {
        this.maybeFail();
        if (params.test_clock !== undefined && !this.clocks.has(params.test_clock)) {
          throw new FakeStripeSdkError({
            type: "invalid_request_error",
            statusCode: 404,
            message: "No such test clock",
          });
        }
        const customer = this.createCustomerRecord({
          email: params.email ?? null,
          metadata: params.metadata ?? {},
          testClock: params.test_clock ?? null,
        });
        return Promise.resolve({ id: customer.id });
      },
    },
    subscriptions: {
      list: (params) => {
        this.maybeFail();
        const subs = [...this.subscriptions.values()]
          .filter((sub) => sub.customerId === params.customer)
          .reverse() // newest first (Stripe list order)
          .slice(0, params.limit ?? 10)
          .map((sub) => this.wireSubscription(sub));
        return Promise.resolve({ data: subs });
      },
      update: (id, params) => {
        this.maybeFail();
        const sub = this.subscriptions.get(id);
        if (sub === undefined) {
          throw new FakeStripeSdkError({
            type: "invalid_request_error",
            statusCode: 404,
            message: "No such subscription",
          });
        }
        if (sub.status === "canceled") {
          throw new FakeStripeSdkError({
            type: "invalid_request_error",
            message: "Cannot update a canceled subscription",
          });
        }
        const swap = params.items?.[0];
        if (swap !== undefined) {
          sub.priceId = swap.price;
        }
        if (params.cancel_at_period_end !== undefined) {
          sub.cancelAtPeriodEnd = params.cancel_at_period_end;
        }
        this.emit("customer.subscription.updated", this.wireSubscription(sub));
        return Promise.resolve(this.wireSubscription(sub));
      },
    },
    testHelpers: {
      testClocks: {
        create: (params) => {
          this.maybeFail();
          this.counters.clock += 1;
          const clock: FakeTestClock = {
            id: `clock_fake_${this.counters.clock}`,
            name: params.name ?? null,
            frozenTime: params.frozen_time,
            status: "ready",
          };
          this.clocks.set(clock.id, clock);
          if (params.customer !== undefined) {
            this.attachCustomerToClock(params.customer, clock.id);
          }
          return Promise.resolve(this.wireClock(clock));
        },
        advance: (id, params) => {
          this.maybeFail();
          const clock = this.clocks.get(id);
          if (clock === undefined) {
            throw new FakeStripeSdkError({
              type: "invalid_request_error",
              statusCode: 404,
              message: "No such test clock",
            });
          }
          if (params.frozen_time <= clock.frozenTime) {
            throw new FakeStripeSdkError({
              type: "invalid_request_error",
              message: "frozen_time must be after the current frozen time",
            });
          }
          this.transitionClock(id, params.frozen_time);
          const advanced = this.clocks.get(id);
          if (advanced === undefined) {
            throw new Error("fake stripe: clock vanished mid-advance");
          }
          return Promise.resolve(this.wireClock(advanced));
        },
      },
    },
    webhooks: {
      constructEvent: (payload, header, secret) => this.constructEvent(payload, header, secret),
    },
  };

  /** Ready-made StripeSeam facade over the same store (route-level tests). */
  readonly seam: StripeSeam = {
    raw: this,

    checkout: async (params) => {
      const session = await this.sdk.checkout.sessions.create({
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

    portal: async (params) => {
      const session = await this.sdk.billingPortal.sessions.create({
        customer: params.customerId,
        return_url: params.returnUrl,
      });
      return { id: session.id, url: session.url };
    },

    verifyWebhook: (payload, signature) => this.verifyWebhookInternal(payload, signature),

    createCustomer: async (params) => {
      const customer = await this.sdk.customers.create({
        email: params.email,
        metadata: params.metadata,
      });
      return { id: customer.id };
    },

    seenEvent: (id) => {
      if (this.seenBySeam.has(id)) return true;
      this.seenBySeam.add(id);
      return false;
    },

    markEventSeen: (id) => {
      this.seenBySeam.add(id);
    },

    topUpCheckout: async (params) => {
      const session = await this.sdk.checkout.sessions.create({
        mode: "payment",
        line_items: [{ price: params.packId, quantity: params.quantity }],
        customer: params.customerId,
        customer_email: params.customerId === undefined ? params.customerEmail : undefined,
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        metadata: params.metadata,
        payment_intent_data: { metadata: params.metadata },
      });
      return { ok: true as const, data: { id: session.id, url: session.url ?? "" } };
    },

    subscription: async (customerId) => {
      const page = await this.sdk.subscriptions.list({ customer: customerId });
      const sub = page.data[0];
      if (sub === undefined) {
        return {
          ok: false as const,
          code: "not_found" as const,
          reason: "no subscription found for customer",
        };
      }
      return { ok: true as const, data: this.snapshotOf(sub) };
    },

    // BIL-04: the card-fingerprint read route-level tests exercise through
    // the facade — same store the sdk retrieve walks. Typed failures mirror
    // the real seam's guarded() envelope (a scripted session id that is not
    // in the store reads as not_found, never a throw).
    checkoutSessionCardFingerprint: async (sessionId) => {
      let session: Awaited<ReturnType<typeof this.sdk.checkout.sessions.retrieve>>;
      try {
        session = await this.sdk.checkout.sessions.retrieve(sessionId);
      } catch {
        return {
          ok: false as const,
          code: "not_found" as const,
          reason: "no such checkout session in the fake store",
        };
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

    updateSubscription: async (customerId, params) => {
      const page = await this.sdk.subscriptions.list({ customer: customerId });
      const sub = page.data[0];
      if (sub === undefined) {
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
      const updated = await this.sdk.subscriptions.update(sub.id, {
        items: [{ id: item.id, price: params.planPriceKey }],
        cancel_at_period_end: params.cancelAtPeriodEnd,
      });
      return { ok: true as const, data: this.snapshotOf(updated) };
    },

    createTestClock: async (params) => {
      const clock = await this.sdk.testHelpers.testClocks.create({
        frozen_time: params.frozenTime,
        customer: params.customerId,
        name: params.name,
      });
      return {
        ok: true as const,
        data: { id: clock.id, frozenTime: clock.frozen_time, status: clock.status },
      };
    },

    withTestClock: (clockId) => {
      if (!this.clocks.has(clockId)) {
        return {
          ok: false as const,
          code: "not_found" as const,
          reason: "no test clock with that id",
        };
      }
      const base = this.seam;
      const clocked: StripeSeam = {
        ...base,
        createCustomer: async (params) => {
          const customer = await this.sdk.customers.create({
            email: params.email,
            metadata: params.metadata,
            test_clock: clockId,
          });
          return { id: customer.id };
        },
      };
      return { ok: true as const, data: clocked };
    },
  };

  // ── event scripting + signing ──────────────────────────────────────────

  /** Author + queue a webhook event of any type (arbitrary payload object). */
  scriptEvent(type: string, object: Record<string, unknown>): FakeStripeEvent {
    return this.emit(type, object);
  }

  /** Queued, undelivered events in FIFO order. */
  pendingWebhooks(): FakeStripeEvent[] {
    return [...this.pending];
  }

  /** Pop the next queued event (Stripe's async delivery stand-in). */
  nextWebhook(): FakeStripeEvent | null {
    return this.pending.shift() ?? null;
  }

  /** Re-queue a delivered event — replay tests re-deliver the same id. */
  requeueWebhook(event: FakeStripeEvent): void {
    this.pending.push(event);
  }

  /** Signed wire form of any event; signWebhook(e) twice is byte-identical. */
  signWebhook(
    event: FakeStripeEvent,
    options: { timestampSeconds?: number; secret?: string } = {},
  ): { payload: Buffer; signature: string } {
    const payload = Buffer.from(JSON.stringify(event), "utf8");
    return { payload, signature: this.signPayload(payload, options) };
  }

  /** Low-level Stripe-format signer (tamper/wrong-secret tests). */
  signPayload(
    payload: Buffer,
    options: { timestampSeconds?: number; secret?: string } = {},
  ): string {
    const timestamp = options.timestampSeconds ?? Math.floor(this.now / 1000);
    const secret = options.secret ?? this.webhookSecret;
    const digest = createHmac("sha256", secret)
      .update(`${timestamp}.${payload.toString("utf8")}`)
      .digest("hex");
    return `t=${timestamp},v1=${digest}`;
  }

  // ── lifecycle scripting ─────────────────────────────────────────────────

  /**
   * Pay an open session: marks it complete, resolves/creates the customer,
   * creates the subscription (trialing, D-4) for subscription mode, and emits
   * checkout.session.completed (+ customer.subscription.created) into the
   * pending webhook queue.
   */
  completeCheckout(sessionId: string): FakeStripeEvent[] {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`completeCheckout: unknown session ${sessionId}`);
    }
    if (session.status !== "open") {
      throw new Error(`completeCheckout: session ${sessionId} already ${session.status}`);
    }
    let customerId = session.customerId;
    if (customerId === null) {
      const email = session.customerEmail;
      if (email === null) {
        throw new Error(`completeCheckout: session ${sessionId} has no customer or email`);
      }
      customerId = this.ensureCustomer(email).id;
    }
    session.customerId = customerId;
    session.status = "complete";
    const events: FakeStripeEvent[] = [];
    if (session.mode === "subscription") {
      const nowSeconds = this.customerNowSeconds(customerId);
      this.counters.subscription += 1;
      this.counters.item += 1;
      const sub: FakeSubscription = {
        id: `sub_fake_${this.counters.subscription}`,
        customerId,
        itemId: `si_fake_${this.counters.item}`,
        priceId: session.priceId,
        quantity: session.quantity,
        status: "trialing",
        trialEnd: nowSeconds + TRIAL_SECONDS,
        currentPeriodStart: nowSeconds,
        currentPeriodEnd: nowSeconds + PERIOD_SECONDS,
        cancelAtPeriodEnd: false,
        metadata: session.metadata,
      };
      this.subscriptions.set(sub.id, sub);
      session.subscriptionId = sub.id;
      events.push(this.emit("customer.subscription.created", this.wireSubscription(sub)));
    }
    events.push(
      this.emit("checkout.session.completed", {
        id: session.id,
        object: "checkout_session",
        mode: session.mode,
        customer: customerId,
        subscription: session.subscriptionId,
        status: "complete",
        payment_status: "paid",
        metadata: session.metadata,
      }),
    );
    return events;
  }

  /** Make the customer's renewals fail (past_due) — `false` to heal. */
  setPaymentFailing(customerId: string, failing: boolean): void {
    if (failing) this.paymentFailing.add(customerId);
    else this.paymentFailing.delete(customerId);
  }

  /**
   * Advance a test clock (convenience over the sdk method): runs the
   * deterministic transitions for every subscription on that clock —
   * trialing→active at trialEnd, renewal at each period end, past_due on a
   * failing renewal, canceled at a cancel_at_period_end boundary or after the
   * past-due grace cycle — and returns the emitted events.
   */
  advanceTestClock(clockId: string, frozenTimeSeconds: number): FakeStripeEvent[] {
    return this.transitionClock(clockId, frozenTimeSeconds);
  }

  /** Queue the next SDK call to fail (popped once per call). */
  queueSdkFailure(failure: ScriptedSdkFailure): void {
    this.failures.push(failure);
  }

  reset(): void {
    this.customers.clear();
    this.subscriptions.clear();
    this.sessions.clear();
    this.clocks.clear();
    this.eventLog.length = 0;
    this.pending.length = 0;
    this.failures.length = 0;
    this.seenBySeam.clear();
    this.paymentFailing.clear();
    this.counters = {
      customer: 0,
      session: 0,
      subscription: 0,
      item: 0,
      clock: 0,
      portal: 0,
      event: 0,
    };
    this.now = FAKE_NOW_MS;
  }

  // ── internals ──────────────────────────────────────────────────────────

  private maybeFail(): void {
    const failure = this.failures.shift();
    if (failure !== undefined) throw new FakeStripeSdkError(failure);
  }

  private wallSeconds(): number {
    return Math.floor(this.now / 1000);
  }

  /** "Now" for a customer — its clock's frozen time when clocked. */
  private customerNowSeconds(customerId: string): number {
    const customer = this.customers.get(customerId);
    if (customer !== undefined && customer.testClock !== null) {
      const clock = this.clocks.get(customer.testClock);
      if (clock !== undefined) return clock.frozenTime;
    }
    return this.wallSeconds();
  }

  private createCustomerRecord(input: {
    email: string | null;
    metadata: Record<string, string>;
    testClock: string | null;
  }): FakeCustomer {
    this.counters.customer += 1;
    const customer: FakeCustomer = {
      id: `cus_fake_${this.counters.customer}`,
      email: input.email,
      metadata: input.metadata,
      testClock: input.testClock,
    };
    this.customers.set(customer.id, customer);
    if (input.testClock !== null) this.attachCustomerToClock(customer.id, input.testClock);
    return customer;
  }

  private attachCustomerToClock(customerId: string, clockId: string): void {
    const customer = this.customers.get(customerId);
    const clock = this.clocks.get(clockId);
    if (customer === undefined || clock === undefined) return;
    this.customers.set(customer.id, { ...customer, testClock: clock.id });
  }

  private ensureCustomer(email: string): FakeCustomer {
    const existing = [...this.customers.values()].find(
      (customer) => customer.email !== null && customer.email === email,
    );
    if (existing !== undefined) return existing;
    return this.createCustomerRecord({ email, metadata: {}, testClock: null });
  }

  private emit(type: string, object: Record<string, unknown>): FakeStripeEvent {
    this.counters.event += 1;
    const event: FakeStripeEvent = {
      id: `evt_fake_${this.counters.event}`,
      object: "event",
      api_version: FAKE_API_VERSION,
      created: this.wallSeconds(),
      data: { object },
      livemode: false,
      pending_webhooks: 1,
      request: { id: `req_fake_${this.counters.event}`, idempotency_key: null },
      type,
    };
    this.eventLog.push(event);
    this.pending.push(event);
    return event;
  }

  /** Deterministic transitions; returns the emitted events. */
  private transitionClock(clockId: string, frozenTime: number): FakeStripeEvent[] {
    const clock = this.clocks.get(clockId);
    if (clock === undefined) {
      throw new FakeStripeSdkError({
        type: "invalid_request_error",
        statusCode: 404,
        message: "No such test clock",
      });
    }
    const events: FakeStripeEvent[] = [];
    for (const sub of [...this.subscriptions.values()].reverse()) {
      const customer = this.customers.get(sub.customerId);
      if (customer?.testClock !== clockId) continue;
      this.transitionSubscription(sub, frozenTime, events);
    }
    clock.frozenTime = frozenTime;
    clock.status = "ready";
    return events;
  }

  private transitionSubscription(
    sub: FakeSubscription,
    frozenTime: number,
    events: FakeStripeEvent[],
  ): void {
    if (sub.status === "trialing" && sub.trialEnd !== null && frozenTime >= sub.trialEnd) {
      sub.status = "active";
      events.push(this.emit("customer.subscription.updated", this.wireSubscription(sub)));
    }
    let guard = 0;
    while (sub.status === "active" && frozenTime >= sub.currentPeriodEnd && guard < 24) {
      guard += 1;
      if (sub.cancelAtPeriodEnd) {
        sub.status = "canceled";
        events.push(this.emit("customer.subscription.deleted", this.wireSubscription(sub)));
        return;
      }
      if (this.paymentFailing.has(sub.customerId)) {
        sub.status = "past_due";
        events.push(this.emit("customer.subscription.updated", this.wireSubscription(sub)));
        return;
      }
      sub.currentPeriodStart = sub.currentPeriodEnd;
      sub.currentPeriodEnd += PERIOD_SECONDS;
      events.push(this.emit("customer.subscription.updated", this.wireSubscription(sub)));
    }
    if (sub.status === "past_due" && frozenTime >= sub.currentPeriodEnd + GRACE_SECONDS) {
      sub.status = "canceled";
      events.push(this.emit("customer.subscription.deleted", this.wireSubscription(sub)));
    }
  }

  /** Stripe API 2026-09-30 shape: the period lives on the subscription item. */
  private wireSubscription(sub: FakeSubscription): FakeSubscriptionWire {
    return {
      id: sub.id,
      object: "subscription",
      customer: sub.customerId,
      status: sub.status,
      trial_end: sub.trialEnd,
      cancel_at_period_end: sub.cancelAtPeriodEnd,
      cancel_at: null,
      current_period_start: sub.currentPeriodStart,
      current_period_end: sub.currentPeriodEnd,
      items: {
        object: "list",
        data: [
          {
            id: sub.itemId,
            object: "subscription_item",
            price: sub.priceId,
            quantity: sub.quantity,
            current_period_start: sub.currentPeriodStart,
            current_period_end: sub.currentPeriodEnd,
          },
        ],
        has_more: false,
        total_count: 1,
        url: `/v1/subscription_items?subscription=${sub.id}`,
      },
      metadata: sub.metadata,
      livemode: false,
    };
  }

  private wireClock(clock: FakeTestClock): { id: string; frozen_time: number; status: string } {
    return { id: clock.id, frozen_time: clock.frozenTime, status: clock.status };
  }

  /** Snapshot mapping for the facade seam — mirrors src/stripe.ts's mapping. */
  private snapshotOf(sub: {
    readonly id: string;
    readonly status: string;
    readonly trial_end: number | null;
    readonly cancel_at_period_end: boolean;
    readonly items: {
      readonly data: ReadonlyArray<{
        readonly price: string | { readonly id: string } | null;
        readonly current_period_end: number;
      }>;
    };
  }): SubscriptionSnapshot {
    const item = sub.items.data[0];
    const price = item?.price ?? null;
    return {
      status: sub.status as SubscriptionSnapshot["status"],
      currentPeriodEnd: item?.current_period_end ?? 0,
      trialEnd: sub.trial_end === null ? undefined : sub.trial_end,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      subscriptionId: sub.id,
      priceId: typeof price === "string" ? price : price === null ? null : price.id,
    };
  }

  /** Stripe's signature verification algorithm (t=...,v1=..., 300s tolerance). */
  private constructEvent(payload: Buffer, header: string, secret: string): unknown {
    const parsed = parseSignatureHeader(header);
    if (parsed === null) {
      throw new Error("Unable to parse the stripe-signature header.");
    }
    const age = Math.floor(this.now / 1000) - parsed.timestamp;
    if (Math.abs(age) > SIGNATURE_TOLERANCE_SECONDS) {
      throw new Error("Timestamp outside the tolerance zone.");
    }
    const expected = createHmac("sha256", secret)
      .update(`${parsed.timestamp}.${payload.toString("utf8")}`)
      .digest("hex");
    const matches = parsed.signatures.some((signature) => {
      if (signature.length !== expected.length) return false;
      return timingSafeEqual(Buffer.from(signature, "utf8"), Buffer.from(expected, "utf8"));
    });
    if (!matches) {
      throw new Error("No signatures found matching the expected signature.");
    }
    return JSON.parse(payload.toString("utf8")) as unknown;
  }

  /** Facade verifyWebhook — same contract as the real seam. */
  private verifyWebhookInternal(
    payload: Buffer,
    signature: string | null,
  ): { ok: true; event: StripeEventLike } | { ok: false; reason: string } {
    if (signature === null || signature.length === 0) {
      return { ok: false, reason: "missing stripe-signature header" };
    }
    try {
      const event = this.constructEvent(payload, signature, this.webhookSecret) as StripeEventLike;
      return { ok: true, event };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : "signature verification failed",
      };
    }
  }
}

/** Parses `t=<unix>,v1=<hex>(,v1=<hex>…)` — Stripe's header scheme. */
export function parseSignatureHeader(header: string): ParsedSignature | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    if (key === "t") {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed)) return null;
      timestamp = parsed;
    } else if (key === "v1") {
      signatures.push(value);
    }
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/** Test helper: unwraps a seam result arm or fails with the typed reason. */
export function unwrapSeam<T>(result: StripeSeamResult<T>): T {
  if (!result.ok) {
    throw new Error(`unwrapSeam: expected ok, got ${result.code}: ${result.reason}`);
  }
  return result.data;
}
