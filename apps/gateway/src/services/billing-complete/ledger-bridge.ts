// @studio/gateway — Stripe event → billing-ledger bridge (W9-A).
//
// A thin, typed adapter over the SAME seams the W4-N service uses
// (BillingDbLike / LedgerLike / AuditLike — services/stripe.ts, read-only
// input here). It completes the §14.3 webhook surface where the W4-N handler
// stops at a logged skip:
//
//   - invoice.paid → LedgerLike.grant of the resolved plan's §14.1
//     monthlyCredits, money key `stripe:${eventId}` (§14.2 rule 6 — the
//     ledger's unique (idempotencyKey, kind) index makes replays duplicate
//     no-ops);
//   - an invoice whose price id is NOT in the STRIPE_PRICE_* map → NO grant +
//     an audit entry (`billing.webhook.unresolved_price`): money never moves
//     on an unresolved mapping, and operators get an auditable trail instead
//     of the W4-N handler's log-only fallback to the attached row's plan.
//     DELIBERATE DIVERGENCE (documented for the contract wave): W4-N's
//     handleInvoicePaid falls back to the row's plan on an unknown price id;
//     the bridge is the stricter money gate — a portal plan switch whose new
//     price is missing from our env should mint NOTHING until the env is
//     fixed, not stale-plan credits;
//   - customer.subscription.deleted → the §14 downgrade note: the paid seats
//     cap (§14.1 seats 1/3/10) is removed and the workspace drops toward the
//     §14.3 holding state (documents retained read-only); already-granted
//     credits are never revoked.
//
// Precondition: applyEvent runs at most once per event id — the W4-N claim
// flow (pinned by webhook-idempotency.ts) collapses replays before this
// bridge is reached; the grant path is additionally ledger-idempotent by key.
//
// Spec anchors: §14.1 (plans/credits/seats), §14.2 rule 6 (idempotency keys),
// §14.3 (webhooks = the only source of truth; grace ladder), §22 (audit).

import { PLANS, PLAN_ID_SCHEMA, PLAN_LIMITS } from "@studio/config";
import type { Subscription } from "@studio/db";
import type { Logger } from "pino";
import {
  planCodeForPriceId,
  type AuditLike,
  type BillingDbLike,
  type LedgerLike,
  type StripeEvent,
  type StripePriceMap,
  type SubscriptionPlanCode,
} from "../stripe.js";
import { stripeLedgerKeyForEvent } from "./webhook-idempotency.js";
import { configPlanForWireCode } from "./wiring-check.js";

// ---------------------------------------------------------------------------
// Outcomes (typed; never throws — callers get a result per AGENTS.md style)
// ---------------------------------------------------------------------------

export type LedgerBridgeSkipReason =
  | "unknown_event_type"
  | "invoice_without_customer"
  | "invoice_without_subscription_row"
  | "unresolvable_price"
  | "unresolvable_plan"
  | "subscription_not_found";

export type LedgerBridgeOutcome =
  | {
      readonly action: "granted";
      readonly organizationId: string;
      readonly planCode: SubscriptionPlanCode;
      readonly credits: number;
      /** True when the ledger already held this `stripe:${eventId}` grant (replay). */
      readonly duplicate: boolean;
    }
  | {
      readonly action: "downgrade_noted";
      readonly organizationId: string;
      readonly planCode: SubscriptionPlanCode | null;
      /** §14.1 seats cap the downgrade removes (1/3/10); null when the plan row vanished. */
      readonly seatsRemoved: number | null;
    }
  | {
      readonly action: "skipped";
      readonly reason: LedgerBridgeSkipReason;
      /** True when the skip was audit-logged (money-relevant skips only). */
      readonly audited: boolean;
    };

export interface LedgerBridgeDeps {
  readonly db: BillingDbLike;
  readonly ledger: LedgerLike;
  readonly audit: AuditLike;
  readonly prices: StripePriceMap;
  readonly logger: Logger;
}

export interface LedgerBridge {
  /** Maps one Stripe event to billing-service calls. Never throws. */
  applyEvent(event: StripeEvent): Promise<LedgerBridgeOutcome>;
}

// ---------------------------------------------------------------------------
// Defensive field readers (local mirrors of stripe.ts's private helpers —
// kept here so this layer does not widen the W4-N export surface)
// ---------------------------------------------------------------------------

function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The first price id on an invoice's line items (the §14.3 plan lookup). */
function firstInvoicePriceId(invoice: Record<string, unknown>): string | undefined {
  const lines = invoice.lines;
  if (typeof lines !== "object" || lines === null) {
    return undefined;
  }
  const data = (lines as Record<string, unknown>).data;
  if (!Array.isArray(data)) {
    return undefined;
  }
  const first = data[0];
  if (typeof first !== "object" || first === null) {
    return undefined;
  }
  const price = (first as Record<string, unknown>).price;
  if (typeof price !== "object" || price === null) {
    return undefined;
  }
  return stringField(price as Record<string, unknown>, "id");
}

/**
 * The wire plan code of an attached subscription row, or null when the row's
 * plan is not in the config catalog. Config `business` is the wire `max`
 * (stripe.ts header note; the mapping lives in wiring-check.ts).
 */
async function wirePlanFromRow(
  db: BillingDbLike,
  row: Subscription,
): Promise<SubscriptionPlanCode | null> {
  const planRow = await db.findPlanById(row.planId);
  if (planRow === null) {
    return null;
  }
  const parsed = PLAN_ID_SCHEMA.safeParse(planRow.code);
  if (!parsed.success) {
    return null;
  }
  return parsed.data === "business" ? "max" : parsed.data;
}

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

export function createLedgerBridge(deps: LedgerBridgeDeps): LedgerBridge {
  const { db, ledger, audit, prices, logger } = deps;

  /** Money-relevant skips leave an audit trail (§22) — W4-N only logs them. */
  async function auditUnresolvedPrice(
    event: StripeEvent,
    detail: { readonly reason: "unresolvable_price" | "unresolvable_plan"; readonly priceId?: string },
    organizationId: string,
  ): Promise<void> {
    const invoice = event.data.object;
    const invoiceId = stringField(invoice, "id") ?? event.id;
    await audit.append({
      organizationId,
      actorId: null, // system/webhook actor (audit_log.actor_id nullable, §12.1)
      action: "billing.webhook.unresolved_price",
      target: detail.priceId === undefined ? `invoice:${invoiceId}` : `price:${detail.priceId}`,
      metadata: {
        reason: detail.reason,
        eventId: event.id,
        eventType: event.type,
        invoiceId,
        priceId: detail.priceId ?? null,
        hint: "Map this Stripe price id in STRIPE_PRICE_* env, then reconcile the invoice manually.",
      },
    });
    logger.warn(
      { eventId: event.id, type: event.type, reason: detail.reason },
      "billing_bridge_unresolved_price",
    );
  }

  // --- invoice.paid → grant the resolved plan's §14.1 monthly credits -----
  async function applyInvoicePaid(event: StripeEvent): Promise<LedgerBridgeOutcome> {
    const invoice = event.data.object;
    const customer = stringField(invoice, "customer");
    if (customer === undefined) {
      return { action: "skipped", reason: "invoice_without_customer", audited: false };
    }
    const row = await db.findSubscriptionByCustomerId(customer);
    if (row === null) {
      // Cannot attribute to a workspace (§12.2) and the audit seam needs an
      // organizationId — W4-N's logged skip covers this path.
      return { action: "skipped", reason: "invoice_without_subscription_row", audited: false };
    }

    const priceId = firstInvoicePriceId(invoice);
    let planCode: SubscriptionPlanCode | null = null;
    if (priceId !== undefined) {
      const byPrice = planCodeForPriceId(prices, priceId);
      // Only subscription prices grant monthly credits; a pack price (or a
      // price missing from the env map) on a subscription invoice is a
      // mapping problem — mint nothing, audit it.
      planCode = byPrice !== null && byPrice !== "pack" ? byPrice : null;
      if (planCode === null) {
        await auditUnresolvedPrice(event, { reason: "unresolvable_price", priceId }, row.organizationId);
        return { action: "skipped", reason: "unresolvable_price", audited: true };
      }
    } else {
      // No line-item price: fall back to the attached row's plan (W4-N parity
      // — the row is §14.3's source of truth).
      planCode = await wirePlanFromRow(db, row);
      if (planCode === null) {
        await auditUnresolvedPrice(event, { reason: "unresolvable_plan" }, row.organizationId);
        return { action: "skipped", reason: "unresolvable_plan", audited: true };
      }
    }

    const credits = PLANS[configPlanForWireCode(planCode)].monthlyCredits;
    const outcome = await ledger.grant({
      organizationId: row.organizationId,
      credits,
      // §14.2 rule 6 money key — identical format to the W4-N handler
      // (`stripe:${eventId}`), pinned by webhook-idempotency.ts.
      idempotencyKey: stripeLedgerKeyForEvent(event.id),
      kind: "grant",
      note: `invoice.paid grant for plan ${planCode} (§14.1: ${credits} monthly credits)`,
    });
    if (outcome.duplicate) {
      logger.info({ eventId: event.id }, "billing_bridge_grant_duplicate");
    }
    return {
      action: "granted",
      organizationId: row.organizationId,
      planCode,
      credits,
      duplicate: outcome.duplicate,
    };
  }

  // --- customer.subscription.deleted → §14 seats-cap downgrade note -------
  async function applySubscriptionDeleted(event: StripeEvent): Promise<LedgerBridgeOutcome> {
    const object = event.data.object;
    const subscriptionId = stringField(object, "id") ?? stringField(object, "subscription");
    const customer = stringField(object, "customer");
    if (subscriptionId === undefined) {
      return { action: "skipped", reason: "subscription_not_found", audited: false };
    }
    let row = await db.findSubscriptionByStripeSubscriptionId(subscriptionId);
    if (row === null && customer !== undefined) {
      row = await db.findSubscriptionByCustomerId(customer);
    }
    if (row === null) {
      return { action: "skipped", reason: "subscription_not_found", audited: false };
    }

    const planCode = await wirePlanFromRow(db, row);
    // §14.1 seats cap 1/3/10 — the paid cap this downgrade removes.
    const seatsRemoved =
      planCode === null ? null : PLAN_LIMITS[configPlanForWireCode(planCode)].seats;

    await audit.append({
      organizationId: row.organizationId,
      actorId: null,
      action: "billing.subscription.seats_cap_removed",
      target: `subscription:${row.id}`,
      metadata: {
        reason: "customer.subscription.deleted",
        planCode,
        seatsRemoved,
        previousStatus: row.status,
        stripeSubscriptionId: subscriptionId,
        // §14.3: 7-day grace → 15-credit holding state, documents retained
        // read-only; granted credits are never revoked, documents never deleted.
        note: "paid seats cap removed on downgrade (§14.1); workspace drops toward the §14.3 15-credit holding state — documents retained read-only, granted credits never revoked",
      },
    });
    logger.info({ eventId: event.id, seatsRemoved }, "billing_bridge_downgrade_noted");
    return { action: "downgrade_noted", organizationId: row.organizationId, planCode, seatsRemoved };
  }

  return {
    async applyEvent(event: StripeEvent): Promise<LedgerBridgeOutcome> {
      switch (event.type) {
        case "invoice.paid":
          return applyInvoicePaid(event);
        case "customer.subscription.deleted":
          return applySubscriptionDeleted(event);
        default:
          // checkout.session.completed + unknown events are the W4-N
          // handler's territory — the bridge stays thin (§14.3).
          return { action: "skipped", reason: "unknown_event_type", audited: false };
      }
    },
  };
}
