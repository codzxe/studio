// Webhook idempotency integration tests (W9-A) — the harness drives the REAL
// W4-N service (services/stripe.ts) over NoopStripe + in-memory fakes: no
// network, no DB, deterministic clock (AGENTS.md law).
//
// The three contract cases from the W9-A task, plus the race + signature
// paths:
//   1. same event delivered twice → ONE grant (idempotency_keys claim +
//      `stripe:${eventId}` money key, §14.2 rule 6 / §15.2);
//   2. out-of-order invoice.paid + customer.subscription.deleted → final
//      state correct (money exactly once, lifecycle last-write-wins);
//   3. unknown price id → no-op + audit (W4-N's fallback pinned first, then
//      the ledger-bridge's stricter money gate: no grant, audit entry).

import pino from "pino";
import type { Logger } from "pino";
import { describe, expect, it } from "vitest";
import { StripeWebhookError, type StripeEvent } from "../../stripe.js";
import { createLedgerBridge } from "../ledger-bridge.js";
import {
  HARNESS_CUSTOMER,
  HARNESS_ORG_ID,
  HARNESS_PRICES,
  HARNESS_SUBSCRIPTION_ID,
  STRIPE_WEBHOOK_IDEMPOTENCY_SCOPE,
  checkoutSessionCompletedEvent,
  createWebhookHarness,
  invoicePaidEvent,
  stripeLedgerKeyForEvent,
  subscriptionDeletedEvent,
} from "../webhook-idempotency.js";

const FIXED_NOW = (): Date => new Date("2026-02-01T10:00:00.000Z");

function silentLogger(): Logger {
  return pino({ enabled: false });
}

/** The W4-N attach flow: checkout.session.completed wires the subscription row. */
function attachEvent(id: string, planCode = "pro"): StripeEvent {
  return checkoutSessionCompletedEvent({ id, organizationId: HARNESS_ORG_ID, planCode });
}

// ---------------------------------------------------------------------------
// Case 1 — replay: same event delivered twice → one grant
// ---------------------------------------------------------------------------

describe("webhook idempotency — replay (§14.2 rule 6 / §15.2)", () => {
  it("the same invoice.paid delivered twice grants exactly once", async () => {
    const h = createWebhookHarness({ clock: FIXED_NOW });
    expect((await h.deliver(attachEvent("evt_attach_replay"))).handled).toBe(true);

    const event = invoicePaidEvent({
      id: "evt_invoice_replay",
      customer: HARNESS_CUSTOMER,
      priceId: HARNESS_PRICES.pro,
    });
    const first = await h.deliver(event);
    expect(first).toMatchObject({ type: "invoice.paid", handled: true, duplicate: false });

    const replay = await h.deliver(event);
    expect(replay).toMatchObject({ type: "invoice.paid", handled: true, duplicate: true });

    // ONE grant — and its key is exactly the W4-N format `stripe:${eventId}`
    // (the parity this harness exists to pin).
    expect(h.ledger.grants).toHaveLength(1);
    const grant = h.ledger.grants[0];
    expect(grant?.idempotencyKey).toBe("stripe:evt_invoice_replay");
    expect(grant?.idempotencyKey).toBe(stripeLedgerKeyForEvent("evt_invoice_replay"));
    expect(grant?.credits).toBe(250); // §14.1 pro tier
    expect(grant?.organizationId).toBe(HARNESS_ORG_ID);

    // Exactly one idempotency_keys claim, in the W4-N scope.
    expect(h.db.idempotency.filter((row) => row.key === "evt_invoice_replay")).toHaveLength(1);
    expect(h.claimFor("evt_invoice_replay")?.scope).toBe(STRIPE_WEBHOOK_IDEMPOTENCY_SCOPE);
    expect(h.claimFor("evt_invoice_replay")?.organizationId).toBe(HARNESS_ORG_ID);
  });

  it("a concurrent redelivery winning the claim race is a duplicate no-op", async () => {
    const h = createWebhookHarness({ clock: FIXED_NOW });
    expect((await h.deliver(attachEvent("evt_attach_race"))).handled).toBe(true);

    const event = invoicePaidEvent({
      id: "evt_race",
      customer: HARNESS_CUSTOMER,
      priceId: HARNESS_PRICES.pro,
    });
    const outcome = await h.deliverWithConcurrentClaim(event);
    expect(outcome).toMatchObject({ type: "invoice.paid", handled: true, duplicate: true });

    // The race loser never applies: no grant, only the winner's claim row.
    expect(h.ledger.grants).toHaveLength(0);
    expect(h.db.idempotency.filter((row) => row.key === "evt_race")).toHaveLength(1);

    // And the event is durably claimed — a later replay stays a no-op.
    expect((await h.deliver(event)).duplicate).toBe(true);
    expect(h.ledger.grants).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Case 2 — out-of-order invoice.paid + subscription.deleted → final state
// ---------------------------------------------------------------------------

describe("webhook idempotency — out-of-order lifecycle events (§14.3)", () => {
  const orders: ReadonlyArray<{
    readonly name: string;
    readonly events: readonly ["invoice" | "deleted", "invoice" | "deleted"];
    readonly finalStatus: string;
  }> = [
    {
      name: "invoice_first",
      events: ["invoice", "deleted"],
      finalStatus: "canceled",
    },
    {
      name: "cancellation_first",
      events: ["deleted", "invoice"],
      // W4-N re-affirms an active period on a late PAID invoice (documented
      // edge — a final invoice at cancellation would resurrect `active`;
      // flagged for the contract wave, NOT changed by W9-A).
      finalStatus: "active",
    },
  ];

  for (const c of orders) {
    it(`${c.name} → money exactly once, lifecycle last-write-wins`, async () => {
      const h = createWebhookHarness({ clock: FIXED_NOW });
      expect((await h.deliver(attachEvent(`evt_attach_${c.name}`))).handled).toBe(true);

      const invoice = invoicePaidEvent({
        id: `evt_paid_${c.name}`,
        customer: HARNESS_CUSTOMER,
        priceId: HARNESS_PRICES.pro,
      });
      const deleted = subscriptionDeletedEvent({
        id: `evt_gone_${c.name}`,
        subscriptionId: HARNESS_SUBSCRIPTION_ID,
        customer: HARNESS_CUSTOMER,
      });

      for (const which of c.events) {
        const outcome = await h.deliver(which === "invoice" ? invoice : deleted);
        expect(outcome.handled).toBe(true);
        expect(outcome.duplicate).toBe(false);
      }

      // Money invariant (both orders): exactly one grant, keyed by event id.
      expect(h.grantsForEvent(`evt_paid_${c.name}`)).toHaveLength(1);
      expect(h.ledger.grants).toHaveLength(1);

      // Both lifecycle events claimed exactly once, W4-N scope.
      expect(h.claimFor(`evt_paid_${c.name}`)?.scope).toBe(STRIPE_WEBHOOK_IDEMPOTENCY_SCOPE);
      expect(h.claimFor(`evt_gone_${c.name}`)?.scope).toBe(STRIPE_WEBHOOK_IDEMPOTENCY_SCOPE);
      expect(h.db.idempotency).toHaveLength(3); // attach + invoice + deleted

      // Final state: cancellation is final (§14.3 — granted credits are
      // never revoked); the deletion is audited exactly once in both orders.
      const row = h.db.subscriptions[0];
      expect(row?.organizationId).toBe(HARNESS_ORG_ID);
      expect(row?.status).toBe(c.finalStatus);
      expect(h.audit.byAction("billing.subscription.downgraded")).toHaveLength(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Case 3 — unknown price id → no-op + audit
// ---------------------------------------------------------------------------

describe("webhook idempotency — unknown price id", () => {
  const unknown = invoicePaidEvent({
    id: "evt_unknown_price",
    customer: HARNESS_CUSTOMER,
    priceId: "price_not_in_map",
  });

  it("W4-N parity: the route's handler falls back to the attached row's plan", async () => {
    const h = createWebhookHarness({ clock: FIXED_NOW });
    expect((await h.deliver(attachEvent("evt_attach_unknown", "pro"))).handled).toBe(true);

    const outcome = await h.deliver(unknown);
    expect(outcome).toMatchObject({ type: "invoice.paid", handled: true, duplicate: false });
    // The fallback grants the ROW's plan (250 pro credits), not the unknown
    // price — pinned so the deliberate bridge divergence below is explicit.
    expect(h.ledger.grants).toHaveLength(1);
    expect(h.ledger.grants[0]?.credits).toBe(250);
  });

  it("the ledger-bridge refuses the unresolved mapping: no grant + audit entry", async () => {
    const h = createWebhookHarness({ clock: FIXED_NOW });
    expect((await h.deliver(attachEvent("evt_attach_bridge", "pro"))).handled).toBe(true);

    const bridge = createLedgerBridge({
      db: h.db,
      ledger: h.ledger,
      audit: h.audit,
      prices: h.prices,
      logger: silentLogger(),
    });
    const bridged = await bridge.applyEvent(unknown);
    expect(bridged).toEqual({ action: "skipped", reason: "unresolvable_price", audited: true });

    // Money never moved and the skip left an auditable trail (§22).
    expect(h.ledger.grants).toHaveLength(0);
    const entries = h.audit.byAction("billing.webhook.unresolved_price");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.organizationId).toBe(HARNESS_ORG_ID);
    expect(entries[0]?.actorId).toBeNull(); // system/webhook actor (§12.1)
    expect(entries[0]?.target).toBe("price:price_not_in_map");
  });
});

// ---------------------------------------------------------------------------
// The raw-body signature path (§15.2)
// ---------------------------------------------------------------------------

describe("webhook idempotency — signed deliveries (§15.2)", () => {
  it("verifies the HMAC over the raw body and processes the event", async () => {
    const h = createWebhookHarness({ clock: FIXED_NOW });
    const event = invoicePaidEvent({
      id: "evt_signed",
      customer: HARNESS_CUSTOMER,
      priceId: HARNESS_PRICES.starter,
    });

    // No subscription row yet → the verified event is a 200 no-op skip.
    expect(await h.deliverSigned(event)).toMatchObject({ type: "invoice.paid", handled: false });

    // Attach, redeliver the SAME event id: the skip claimed nothing, so the
    // delivery now processes (§14.2 rule 6: skips never burn the claim).
    expect((await h.deliver(attachEvent("evt_attach_signed"))).handled).toBe(true);
    expect(await h.deliverSigned(event)).toMatchObject({ handled: true, duplicate: false });
    expect(h.grantsForEvent("evt_signed")).toHaveLength(1);
    expect(h.ledger.grants[0]?.credits).toBe(100); // §14.1 starter tier

    // A wrong secret throws the typed error the route maps to a 400 — with
    // zero side effects (no claim, no grant).
    const badSignature = invoicePaidEvent({
      id: "evt_bad_sig",
      customer: HARNESS_CUSTOMER,
      priceId: HARNESS_PRICES.pro,
    });
    await expect(h.deliverSigned(badSignature, { secret: "whsec_wrong" })).rejects.toThrowError(
      StripeWebhookError,
    );
    expect(h.claimFor("evt_bad_sig")).toBeNull();
    expect(h.ledger.grants).toHaveLength(1);
  });
});
