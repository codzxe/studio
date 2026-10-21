// Ledger-bridge tests (W9-A) — table-driven over the thin adapter: Stripe
// events → LedgerLike.grant / AuditLike notes, with NoopStripe-era in-memory
// fakes (the harness db/ledger/audit) and a deterministic clock (AGENTS.md).

import pino from "pino";
import type { Logger } from "pino";
import { describe, expect, it } from "vitest";
import type {
  StripeEvent,
  SubscriptionPlanCode,
  SubscriptionUpsert,
} from "../../stripe.js";
import {
  HARNESS_CUSTOMER,
  HARNESS_ORG_ID,
  HARNESS_PLAN_BUSINESS_ID,
  HARNESS_PLAN_PRO_ID,
  HARNESS_PLAN_STARTER_ID,
  HARNESS_PRICES,
  HARNESS_SUBSCRIPTION_ID,
  checkoutSessionCompletedEvent,
  createWebhookHarness,
  invoicePaidEvent,
  subscriptionDeletedEvent,
  type WebhookHarness,
} from "../webhook-idempotency.js";
import {
  createLedgerBridge,
  type LedgerBridge,
  type LedgerBridgeSkipReason,
} from "../ledger-bridge.js";

const FIXED_NOW = (): Date => new Date("2026-02-01T10:00:00.000Z");

type SeededPlan = "starter" | "pro" | "business";

function planRowId(plan: SeededPlan): string {
  if (plan === "starter") {
    return HARNESS_PLAN_STARTER_ID;
  }
  return plan === "pro" ? HARNESS_PLAN_PRO_ID : HARNESS_PLAN_BUSINESS_ID;
}

function attachedRow(plan: SeededPlan): SubscriptionUpsert {
  return {
    organizationId: HARNESS_ORG_ID,
    planId: planRowId(plan),
    stripeCustomerId: HARNESS_CUSTOMER,
    stripeSubscriptionId: HARNESS_SUBSCRIPTION_ID,
    status: "active",
  };
}

interface BridgeFixture {
  readonly h: WebhookHarness;
  readonly bridge: LedgerBridge;
}

function makeBridge(subscriptions?: readonly SubscriptionUpsert[]): BridgeFixture {
  const h = createWebhookHarness({ clock: FIXED_NOW, subscriptions });
  const logger: Logger = pino({ enabled: false });
  const bridge = createLedgerBridge({
    db: h.db,
    ledger: h.ledger,
    audit: h.audit,
    prices: h.prices,
    logger,
  });
  return { h, bridge };
}

// ---------------------------------------------------------------------------
// invoice.paid → LedgerLike.grant with the plan's §14.1 monthlyCredits
// ---------------------------------------------------------------------------

interface InvoiceCase {
  readonly name: string;
  readonly priceId: string | undefined;
  readonly attachedPlan: SeededPlan;
  readonly expect:
    | {
        readonly action: "granted";
        readonly planCode: SubscriptionPlanCode;
        readonly credits: number;
      }
    | {
        readonly action: "skipped";
        readonly reason: LedgerBridgeSkipReason;
        readonly audited: boolean;
      };
}

const invoiceCases: readonly InvoiceCase[] = [
  {
    name: "known pro price grants the 250 §14.1 monthly credits",
    priceId: HARNESS_PRICES.pro,
    attachedPlan: "pro",
    expect: { action: "granted", planCode: "pro", credits: 250 },
  },
  {
    name: "known max price maps the wire code to config business (600 credits)",
    priceId: HARNESS_PRICES.max,
    attachedPlan: "starter",
    expect: { action: "granted", planCode: "max", credits: 600 },
  },
  {
    name: "known starter price grants 100 credits",
    priceId: HARNESS_PRICES.starter,
    attachedPlan: "pro",
    expect: { action: "granted", planCode: "starter", credits: 100 },
  },
  {
    name: "no line-item price falls back to the attached row's plan (W4-N parity)",
    priceId: undefined,
    attachedPlan: "business",
    expect: { action: "granted", planCode: "max", credits: 600 },
  },
  {
    name: "unknown price id → no grant + audit (money never moves, unresolved)",
    priceId: "price_not_mapped",
    attachedPlan: "pro",
    expect: { action: "skipped", reason: "unresolvable_price", audited: true },
  },
  {
    name: "a pack price on a subscription invoice is not a monthly grant",
    priceId: HARNESS_PRICES.pack,
    attachedPlan: "pro",
    expect: { action: "skipped", reason: "unresolvable_price", audited: true },
  },
];

describe("ledger bridge — invoice.paid → grant (§14.1 / §14.2 rule 6)", () => {
  for (const c of invoiceCases) {
    it(c.name, async () => {
      const { h, bridge } = makeBridge([attachedRow(c.attachedPlan)]);
      const outcome = await bridge.applyEvent(
        invoicePaidEvent({
          id: "evt_bridge_invoice",
          customer: HARNESS_CUSTOMER,
          priceId: c.priceId,
        }),
      );

      const expected = c.expect;
      if (expected.action === "granted") {
        expect(outcome).toMatchObject({
          ...expected,
          organizationId: HARNESS_ORG_ID,
          duplicate: false,
        });
        expect(h.ledger.grants).toHaveLength(1);
        const grant = h.ledger.grants[0];
        // The money key matches the W4-N handler's `stripe:${eventId}` format.
        expect(grant?.idempotencyKey).toBe("stripe:evt_bridge_invoice");
        expect(grant?.kind).toBe("grant");
        expect(grant?.organizationId).toBe(HARNESS_ORG_ID);
        expect(grant?.note).toContain("§14.1");
        expect(h.audit.entries).toHaveLength(0);
      } else {
        expect(outcome).toEqual(expected);
        expect(h.ledger.grants).toHaveLength(0);
        const entries = h.audit.byAction("billing.webhook.unresolved_price");
        expect(entries).toHaveLength(1);
        expect(entries[0]?.organizationId).toBe(HARNESS_ORG_ID);
        expect(entries[0]?.actorId).toBeNull();
      }
    });
  }

  it("replays the same event id as a ledger duplicate — credits mint once", async () => {
    const { h, bridge } = makeBridge([attachedRow("pro")]);
    const event = invoicePaidEvent({
      id: "evt_bridge_dup",
      customer: HARNESS_CUSTOMER,
      priceId: HARNESS_PRICES.pro,
    });
    expect(await bridge.applyEvent(event)).toMatchObject({ action: "granted", duplicate: false });
    expect(await bridge.applyEvent(event)).toMatchObject({ action: "granted", duplicate: true });
    expect(h.ledger.grants).toHaveLength(1);
    expect(h.ledger.sumCredits()).toBe(250);
  });

  it("invoices without a customer or a subscription row skip unattributed (§12.2)", async () => {
    const { h, bridge } = makeBridge();
    const noCustomer: StripeEvent = {
      id: "evt_bridge_nocust",
      type: "invoice.paid",
      data: { object: {} },
    };
    expect(await bridge.applyEvent(noCustomer)).toEqual({
      action: "skipped",
      reason: "invoice_without_customer",
      audited: false,
    });
    const noRow = invoicePaidEvent({
      id: "evt_bridge_norow",
      customer: "cus_nobody",
      priceId: HARNESS_PRICES.pro,
    });
    expect(await bridge.applyEvent(noRow)).toEqual({
      action: "skipped",
      reason: "invoice_without_subscription_row",
      audited: false,
    });
    expect(h.audit.entries).toHaveLength(0);
    expect(h.ledger.grants).toHaveLength(0);
  });

  it("no price lines + a row whose plan left the catalog → audit, no grant", async () => {
    const { h, bridge } = makeBridge([
      {
        organizationId: HARNESS_ORG_ID,
        planId: "55555555-5555-4555-8555-555555555555", // not in the seeded plans table
        stripeCustomerId: HARNESS_CUSTOMER,
        stripeSubscriptionId: HARNESS_SUBSCRIPTION_ID,
        status: "active",
      },
    ]);
    const outcome = await bridge.applyEvent(
      invoicePaidEvent({ id: "evt_bridge_noplan", customer: HARNESS_CUSTOMER }),
    );
    expect(outcome).toEqual({ action: "skipped", reason: "unresolvable_plan", audited: true });
    expect(h.ledger.grants).toHaveLength(0);
    expect(h.audit.byAction("billing.webhook.unresolved_price")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// customer.subscription.deleted → §14 seats-cap downgrade note
// ---------------------------------------------------------------------------

interface DowngradeCase {
  readonly name: string;
  readonly attachedPlan: SeededPlan;
  readonly expectedPlanCode: SubscriptionPlanCode;
  readonly expectedSeats: number;
}

const downgradeCases: readonly DowngradeCase[] = [
  {
    name: "starter downgrade removes the 1-seat cap (§14.1)",
    attachedPlan: "starter",
    expectedPlanCode: "starter",
    expectedSeats: 1,
  },
  {
    name: "pro downgrade removes the 3-seat cap (§14.1)",
    attachedPlan: "pro",
    expectedPlanCode: "pro",
    expectedSeats: 3,
  },
  {
    name: "max (config business) downgrade removes the 10-seat cap (§14.1)",
    attachedPlan: "business",
    expectedPlanCode: "max",
    expectedSeats: 10,
  },
];

describe("ledger bridge — customer.subscription.deleted → seats-cap note (§14)", () => {
  for (const c of downgradeCases) {
    it(c.name, async () => {
      const { h, bridge } = makeBridge([attachedRow(c.attachedPlan)]);
      const outcome = await bridge.applyEvent(
        subscriptionDeletedEvent({
          id: "evt_bridge_gone",
          subscriptionId: HARNESS_SUBSCRIPTION_ID,
          customer: HARNESS_CUSTOMER,
        }),
      );
      expect(outcome).toEqual({
        action: "downgrade_noted",
        organizationId: HARNESS_ORG_ID,
        planCode: c.expectedPlanCode,
        seatsRemoved: c.expectedSeats,
      });

      // §14.3: already-granted credits are never revoked — ledger untouched.
      expect(h.ledger.grants).toHaveLength(0);

      const entries = h.audit.byAction("billing.subscription.seats_cap_removed");
      expect(entries).toHaveLength(1);
      const entry = entries[0];
      expect(entry?.organizationId).toBe(HARNESS_ORG_ID);
      expect(entry?.actorId).toBeNull();
      expect(entry?.target).toBe(`subscription:${h.db.subscriptions[0]?.id}`);
      const metadata = entry?.metadata as Record<string, unknown> | undefined;
      expect(metadata?.seatsRemoved).toBe(c.expectedSeats);
      expect(metadata?.planCode).toBe(c.expectedPlanCode);
      expect(String(metadata?.note)).toContain("§14.3");
      expect(String(metadata?.note)).toContain("never revoked");
    });
  }

  it("a deletion with no subscription row skips without an audit entry", async () => {
    const { h, bridge } = makeBridge();
    const outcome = await bridge.applyEvent(
      subscriptionDeletedEvent({
        id: "evt_bridge_gone_norow",
        subscriptionId: "sub_nobody",
        customer: "cus_nobody",
      }),
    );
    expect(outcome).toEqual({ action: "skipped", reason: "subscription_not_found", audited: false });
    expect(h.audit.entries).toHaveLength(0);
  });

  it("a deletion with an unknown subscription id resolves the row by customer (§14.3 fan-in)", async () => {
    const { h, bridge } = makeBridge([attachedRow("pro")]);
    const event: StripeEvent = {
      id: "evt_bridge_by_customer",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_reassigned", customer: HARNESS_CUSTOMER } },
    };
    // Mirror of the W4-N lookup order: subscription id misses, customer hits.
    expect(await bridge.applyEvent(event)).toEqual({
      action: "downgrade_noted",
      organizationId: HARNESS_ORG_ID,
      planCode: "pro",
      seatsRemoved: 3,
    });
    expect(h.audit.byAction("billing.subscription.seats_cap_removed")).toHaveLength(1);
  });

  it("a deletion with neither id nor customer cannot be resolved", async () => {
    const { h, bridge } = makeBridge([attachedRow("pro")]);
    const event: StripeEvent = {
      id: "evt_bridge_anon",
      type: "customer.subscription.deleted",
      data: { object: { status: "canceled" } },
    };
    expect(await bridge.applyEvent(event)).toEqual({
      action: "skipped",
      reason: "subscription_not_found",
      audited: false,
    });
    expect(h.audit.entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Events outside the bridge's surface stay with the W4-N handler
// ---------------------------------------------------------------------------

describe("ledger bridge — scope guard", () => {
  it("checkout.session.completed and unknown types are skipped (thin adapter)", async () => {
    const { h, bridge } = makeBridge();
    const outcome = await bridge.applyEvent(
      checkoutSessionCompletedEvent({
        id: "evt_bridge_attach",
        organizationId: HARNESS_ORG_ID,
        planCode: "pro",
      }),
    );
    expect(outcome).toEqual({ action: "skipped", reason: "unknown_event_type", audited: false });
    // The bridge never upserts — attach belongs to the W4-N handler.
    expect(h.db.subscriptions).toHaveLength(0);
    expect(h.db.idempotency).toHaveLength(0);
  });
});
