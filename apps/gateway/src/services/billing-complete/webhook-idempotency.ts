// @studio/gateway — Stripe webhook idempotency harness (W9-A, test-grade).
//
// Replay protection for Stripe webhooks has TWO guards in the landed W4-N
// service (services/stripe.ts — read-only input here; this file never
// edits it):
//   1. the idempotency_keys claim: unique (key, scope) where scope is
//      "stripe.webhook" and key is the Stripe event id — a replayed or
//      concurrently redelivered event folds into a duplicate no-op
//      (§15.2, §14.2 rule 6);
//   2. the money-side key: every webhook-driven ledger grant carries
//      idempotencyKey `stripe:${eventId}` — the ledger's unique
//      (idempotencyKey, kind) index is the last line of defence, so a replay
//      after a half-committed transaction can never mint credits twice.
//
// This module pins BOTH contracts (scope + key format constants below are the
// parity seam the integration tests assert against the real W4-N service) and
// ships the in-memory fakes + harness those tests drive:
//   - InMemoryBillingDb mirrors idempotency_keys unique (key, scope) by
//     throwing IdempotencyConflictError exactly like the Drizzle adapter;
//   - InMemoryLedger mirrors credit_ledger unique (idempotencyKey, kind);
//   - createWebhookHarness wires the REAL createStripeBillingService over
//     NoopStripe (real HMAC signature verification, no network) + the fakes,
//     and can simulate the concurrent-claim race on demand.
//
// Spec anchors: §14.2 rule 6, §14.3 (webhooks = source of truth), §15.2
// (signature over the raw body; idempotent by event id).

import type { IdempotencyKey, Plan, Subscription } from "@studio/db";
import pino from "pino";
import type { Logger } from "pino";
import {
  IdempotencyConflictError,
  NoopStripe,
  createStripeBillingService,
  signWebhookPayload,
  type AuditEntry,
  type AuditLike,
  type BillingDbLike,
  type BillingMemberRow,
  type IdempotencyClaim,
  type LedgerGrantInput,
  type LedgerLike,
  type StripeBillingService,
  type StripeEvent,
  type StripePriceMap,
  type SubscriptionUpsert,
  type WebhookOutcome,
} from "../stripe.js";

// ---------------------------------------------------------------------------
// Parity constants — MUST match the private W4-N contract in stripe.ts
// ---------------------------------------------------------------------------

/** idempotency_keys scope for Stripe webhook events (W4-N IDEMPOTENCY_SCOPE). */
export const STRIPE_WEBHOOK_IDEMPOTENCY_SCOPE = "stripe.webhook";

/** §14.2 rule 6 money-key prefix — W4-N grants carry `stripe:${eventId}`. */
export const STRIPE_LEDGER_KEY_PREFIX = "stripe:";

/** The money-side idempotency key for a Stripe event's ledger grant. */
export function stripeLedgerKeyForEvent(eventId: string): string {
  return `${STRIPE_LEDGER_KEY_PREFIX}${eventId}`;
}

// ---------------------------------------------------------------------------
// Harness fixtures (§14.1 catalog shapes; uuid-shaped ids per §12.1)
// ---------------------------------------------------------------------------

export const HARNESS_ORG_ID = "11111111-1111-4111-8111-111111111111";
export const HARNESS_CUSTOMER = "cus_harness_a";
export const HARNESS_SUBSCRIPTION_ID = "sub_harness_a";
export const HARNESS_PLAN_STARTER_ID = "22222222-2222-4222-8222-222222222222";
export const HARNESS_PLAN_PRO_ID = "33333333-3333-4333-8333-333333333333";
export const HARNESS_PLAN_BUSINESS_ID = "44444444-4444-4444-8444-444444444444";
export const HARNESS_WEBHOOK_SECRET = "whsec_harness_w9a";
export const HARNESS_APP_URL = "https://app.studio.test";

/** §14.1 plan catalog as seeded plans-table rows (§12.1 shapes). */
export const HARNESS_PLANS: readonly Plan[] = [
  {
    id: HARNESS_PLAN_STARTER_ID,
    code: "starter",
    monthlyUsdCents: 3000,
    monthlyCredits: 100,
    extraSeatUsdCents: 800,
    maxConcurrentEngineSessions: 1,
    maxUploadMb: 25,
    features: {},
    createdAt: new Date("2026-02-01T10:00:00.000Z"),
  },
  {
    id: HARNESS_PLAN_PRO_ID,
    code: "pro",
    monthlyUsdCents: 6000,
    monthlyCredits: 250,
    extraSeatUsdCents: 800,
    maxConcurrentEngineSessions: 3,
    maxUploadMb: 25,
    features: {},
    createdAt: new Date("2026-02-01T10:00:00.000Z"),
  },
  {
    id: HARNESS_PLAN_BUSINESS_ID,
    code: "business",
    monthlyUsdCents: 12000,
    monthlyCredits: 600,
    extraSeatUsdCents: 800,
    maxConcurrentEngineSessions: 6,
    maxUploadMb: 25,
    features: {},
    createdAt: new Date("2026-02-01T10:00:00.000Z"),
  },
];

/** Price-id map matching the W4-N env mapping (STRIPE_PRICE_STARTER/PRO/MAX). */
export const HARNESS_PRICES: StripePriceMap = {
  starter: "price_harness_starter",
  pro: "price_harness_pro",
  max: "price_harness_max",
  pack: "price_harness_pack",
};

let idSeq = 0;
function harnessUuid(): string {
  idSeq += 1;
  return `00000000-0000-4000-8000-${String(idSeq).padStart(12, "0")}`;
}

/** Deterministic signing timestamp (NoopStripe skips tolerance checks). */
const HARNESS_SIGNING_AT_MS = 1_769_987_200_000;

// ---------------------------------------------------------------------------
// In-memory fakes (mirror the DB-side unique indexes, §14.2 rule 6)
// ---------------------------------------------------------------------------

export interface InMemoryBillingDbOptions {
  readonly memberships?: readonly BillingMemberRow[];
  readonly plans?: readonly Plan[];
  readonly subscriptions?: readonly SubscriptionUpsert[];
  readonly clock?: () => Date;
}

/**
 * BillingDbLike over in-memory rows. insertIdempotencyKey mirrors
 * idempotency_keys unique (key, scope) by throwing IdempotencyConflictError —
 * the same error the Drizzle adapter raises on Postgres 23505 — so the W4-N
 * claim flow's race handling is exercised for real.
 */
export class InMemoryBillingDb implements BillingDbLike {
  readonly memberships: BillingMemberRow[] = [];
  readonly plans: Plan[] = [];
  readonly subscriptions: Subscription[] = [];
  readonly idempotency: IdempotencyKey[] = [];
  private readonly clock: () => Date;

  constructor(options: InMemoryBillingDbOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    if (options.memberships !== undefined) {
      this.memberships.push(...options.memberships.map((m) => ({ ...m })));
    }
    if (options.plans !== undefined) {
      this.plans.push(...options.plans.map((p) => ({ ...p })));
    }
    if (options.subscriptions !== undefined) {
      // upsertSubscription's fake body is synchronous (no awaits inside), so
      // pre-attached rows are visible the moment the constructor returns.
      for (const row of options.subscriptions) {
        void this.upsertSubscription(row);
      }
    }
  }

  async findMembership(userId: string, workspaceId: string): Promise<BillingMemberRow | null> {
    return (
      this.memberships.find(
        (m) => m.userId === userId && m.organizationId === workspaceId,
      ) ?? null
    );
  }

  async findSubscriptionByOrganization(organizationId: string): Promise<Subscription | null> {
    return this.subscriptions.find((s) => s.organizationId === organizationId) ?? null;
  }

  async findSubscriptionByCustomerId(customerId: string): Promise<Subscription | null> {
    return this.subscriptions.find((s) => s.stripeCustomerId === customerId) ?? null;
  }

  async findSubscriptionByStripeSubscriptionId(
    subscriptionId: string,
  ): Promise<Subscription | null> {
    return this.subscriptions.find((s) => s.stripeSubscriptionId === subscriptionId) ?? null;
  }

  async findPlanByCode(code: string): Promise<Plan | null> {
    return this.plans.find((p) => p.code === code) ?? null;
  }

  async findPlanById(id: string): Promise<Plan | null> {
    return this.plans.find((p) => p.id === id) ?? null;
  }

  async upsertSubscription(input: SubscriptionUpsert): Promise<Subscription> {
    const existing = this.subscriptions.find((s) => s.organizationId === input.organizationId);
    if (existing !== undefined) {
      // subscriptions.organizationId UNIQUE (§12.1) — one row per org.
      existing.planId = input.planId;
      existing.stripeCustomerId = input.stripeCustomerId;
      existing.stripeSubscriptionId = input.stripeSubscriptionId;
      existing.status = input.status;
      existing.currentPeriodEnd = input.currentPeriodEnd ?? null;
      existing.cancelAt = input.cancelAt ?? null;
      return { ...existing };
    }
    const created: Subscription = {
      id: harnessUuid(),
      organizationId: input.organizationId,
      planId: input.planId,
      stripeCustomerId: input.stripeCustomerId,
      stripeSubscriptionId: input.stripeSubscriptionId,
      status: input.status,
      currentPeriodEnd: input.currentPeriodEnd ?? null,
      cancelAt: input.cancelAt ?? null,
      createdAt: this.clock(),
      updatedAt: this.clock(),
    };
    this.subscriptions.push(created);
    return { ...created };
  }

  async findIdempotencyKey(key: string, scope: string): Promise<IdempotencyKey | null> {
    return this.idempotency.find((row) => row.key === key && row.scope === scope) ?? null;
  }

  async insertIdempotencyKey(input: IdempotencyClaim): Promise<void> {
    if (
      this.idempotency.some((row) => row.key === input.key && row.scope === input.scope)
    ) {
      // Mirrors idempotency_keys unique (key, scope): the concurrent-redelivery
      // loser becomes a duplicate no-op (§14.2 rule 6 / §15.2).
      throw new IdempotencyConflictError(input.key, input.scope);
    }
    this.idempotency.push({
      id: harnessUuid(),
      key: input.key,
      scope: input.scope,
      organizationId: input.organizationId,
      result: input.result ?? null,
      createdAt: this.clock(),
    });
  }
}

/** One recorded ledger grant (the fake's mirror of a credit_ledger row). */
export interface RecordedGrant {
  readonly organizationId: string;
  readonly credits: number;
  readonly idempotencyKey: string;
  readonly kind: "grant" | "pack";
  readonly note: string | undefined;
}

/**
 * LedgerLike mirroring credit_ledger unique (idempotencyKey, kind): the
 * second grant with the same key + kind reports `duplicate` and mints nothing
 * — the money-side guard §14.2 rule 6 requires.
 */
export class InMemoryLedger implements LedgerLike {
  readonly grants: RecordedGrant[] = [];

  async grant(input: LedgerGrantInput): Promise<{ readonly duplicate: boolean }> {
    const kind = input.kind ?? "grant";
    const duplicate = this.grants.some(
      (g) => g.idempotencyKey === input.idempotencyKey && g.kind === kind,
    );
    if (duplicate) {
      return { duplicate: true };
    }
    this.grants.push({
      organizationId: input.organizationId,
      credits: input.credits,
      idempotencyKey: input.idempotencyKey,
      kind,
      note: input.note,
    });
    return { duplicate: false };
  }

  /** Grants carrying a given idempotency key (usually `stripe:${eventId}`). */
  grantsForKey(idempotencyKey: string): readonly RecordedGrant[] {
    return this.grants.filter((g) => g.idempotencyKey === idempotencyKey);
  }

  /** Total credits minted through this fake. */
  sumCredits(): number {
    return this.grants.reduce((total, g) => total + g.credits, 0);
  }
}

/** AuditLike over an array (§22) — readable by action for assertions. */
export class InMemoryAudit implements AuditLike {
  readonly entries: AuditEntry[] = [];

  async append(entry: AuditEntry): Promise<void> {
    this.entries.push({ ...entry });
  }

  byAction(action: string): readonly AuditEntry[] {
    return this.entries.filter((entry) => entry.action === action);
  }
}

// ---------------------------------------------------------------------------
// Event builders (Stripe shapes, only the fields the W4-N handlers read)
// ---------------------------------------------------------------------------

export function checkoutSessionCompletedEvent(input: {
  readonly id: string;
  readonly organizationId: string;
  readonly planCode: string;
  readonly mode?: "subscription" | "payment";
  readonly customer?: string;
  readonly subscription?: string;
}): StripeEvent {
  return {
    id: input.id,
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_${input.id}`,
        object: "checkout.session",
        mode: input.mode ?? "subscription",
        customer: input.customer ?? HARNESS_CUSTOMER,
        subscription: input.subscription ?? HARNESS_SUBSCRIPTION_ID,
        metadata: { organizationId: input.organizationId, planCode: input.planCode },
      },
    },
  };
}

export function invoicePaidEvent(input: {
  readonly id: string;
  readonly customer: string;
  /** First line-item price id — the §14.3 plan lookup; omit for no lines. */
  readonly priceId?: string;
  readonly subscription?: string;
}): StripeEvent {
  const invoice: Record<string, unknown> = {
    id: `in_${input.id}`,
    object: "invoice",
    customer: input.customer,
    subscription: input.subscription,
    status: "paid",
  };
  if (input.priceId !== undefined) {
    invoice.lines = { object: "list", data: [{ price: { id: input.priceId } }] };
  }
  return { id: input.id, type: "invoice.paid", data: { object: invoice } };
}

export function subscriptionDeletedEvent(input: {
  readonly id: string;
  readonly subscriptionId: string;
  readonly customer: string;
  readonly status?: string;
}): StripeEvent {
  return {
    id: input.id,
    type: "customer.subscription.deleted",
    data: {
      object: {
        id: input.subscriptionId,
        object: "subscription",
        status: input.status ?? "canceled",
        customer: input.customer,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// The harness — the real W4-N service over NoopStripe + the fakes above
// ---------------------------------------------------------------------------

export interface WebhookHarnessOptions {
  readonly webhookSecret?: string;
  readonly prices?: StripePriceMap;
  readonly plans?: readonly Plan[];
  /** Subscription rows pre-attached at construction (upserted into the fake). */
  readonly subscriptions?: readonly SubscriptionUpsert[];
  readonly memberships?: readonly BillingMemberRow[];
  readonly logger?: Logger;
  readonly clock?: () => Date;
}

export interface WebhookHarness {
  /** The REAL W4-N service (services/stripe.ts) over the fake seams. */
  readonly service: StripeBillingService;
  readonly stripe: NoopStripe;
  readonly db: InMemoryBillingDb;
  readonly ledger: InMemoryLedger;
  readonly audit: InMemoryAudit;
  readonly webhookSecret: string;
  readonly prices: StripePriceMap;
  /** Signs a raw payload in Stripe's t/v1 scheme (what NoopStripe verifies). */
  sign(payload: string, timestampMs?: number): string;
  /** Post-verification path: service.handleWebhookEvent directly. */
  deliver(event: StripeEvent): Promise<WebhookOutcome>;
  /**
   * Full raw-body path: JSON.stringify → sign → service.verifyWebhook →
   * handleWebhookEvent. A wrong `secret` throws the W4-N typed
   * StripeWebhookError("invalid_signature") exactly like the route's 400.
   */
  deliverSigned(
    event: StripeEvent,
    options?: { readonly secret?: string },
  ): Promise<WebhookOutcome>;
  /**
   * Simulates a concurrent redelivery winning the claim race: the injected
   * transaction runner claims (event.id, scope) BEFORE the handler's work
   * runs, so the handler's own claim insert hits the unique index →
   * IdempotencyConflictError → the losing delivery must be a duplicate no-op
   * with zero side effects.
   */
  deliverWithConcurrentClaim(event: StripeEvent): Promise<WebhookOutcome>;
  /** The idempotency_keys claim row for an event id, if claimed (sync read). */
  claimFor(eventId: string): IdempotencyKey | null;
  /** Ledger grants carrying the W4-N money key `stripe:${eventId}`. */
  grantsForEvent(eventId: string): readonly RecordedGrant[];
}

export function createWebhookHarness(options: WebhookHarnessOptions = {}): WebhookHarness {
  const clock = options.clock ?? (() => new Date());
  const logger = options.logger ?? pino({ enabled: false });
  const webhookSecret = options.webhookSecret ?? HARNESS_WEBHOOK_SECRET;
  const prices = options.prices ?? HARNESS_PRICES;
  const db = new InMemoryBillingDb({
    memberships: options.memberships,
    plans: options.plans ?? HARNESS_PLANS,
    subscriptions: options.subscriptions,
    clock,
  });
  const ledger = new InMemoryLedger();
  const audit = new InMemoryAudit();
  const stripe = new NoopStripe();

  const service = createStripeBillingService({
    stripe,
    db,
    ledger,
    audit,
    prices,
    webhookSecret,
    appUrl: HARNESS_APP_URL,
    withTransaction: async <T>(work: (tx: BillingDbLike) => Promise<T>): Promise<T> =>
      work(db),
    logger,
    clock,
  });

  const harness: WebhookHarness = {
    service,
    stripe,
    db,
    ledger,
    audit,
    webhookSecret,
    prices,
    sign(payload: string, timestampMs: number = HARNESS_SIGNING_AT_MS): string {
      return signWebhookPayload(webhookSecret, payload, timestampMs);
    },
    async deliver(event: StripeEvent): Promise<WebhookOutcome> {
      return service.handleWebhookEvent(event);
    },
    async deliverSigned(
      event: StripeEvent,
      deliverOptions?: { readonly secret?: string },
    ): Promise<WebhookOutcome> {
      const payload = JSON.stringify(event);
      const signature = signWebhookPayload(
        deliverOptions?.secret ?? webhookSecret,
        payload,
        HARNESS_SIGNING_AT_MS,
      );
      // verifyWebhook throws the typed StripeWebhookError the route maps to
      // a 400 — the harness lets it bubble so tests assert it.
      const verified = service.verifyWebhook(payload, signature);
      return service.handleWebhookEvent(verified);
    },
    async deliverWithConcurrentClaim(event: StripeEvent): Promise<WebhookOutcome> {
      const racing = createStripeBillingService({
        stripe,
        db,
        ledger,
        audit,
        prices,
        webhookSecret,
        appUrl: HARNESS_APP_URL,
        // The concurrent redelivery's claim lands between the handler's
        // fast pre-check and its own insert: the unique (key, scope) index
        // makes the handler's claim throw IdempotencyConflictError → the
        // losing side must fold into a duplicate no-op (§15.2).
        withTransaction: async <T>(
          work: (tx: BillingDbLike) => Promise<T>,
        ): Promise<T> => {
          await db.insertIdempotencyKey({
            key: event.id,
            scope: STRIPE_WEBHOOK_IDEMPOTENCY_SCOPE,
            organizationId: HARNESS_ORG_ID,
            result: { processed: true, concurrentClaim: true },
          });
          return work(db);
        },
        logger,
        clock,
      });
      return racing.handleWebhookEvent(event);
    },
    claimFor(eventId: string): IdempotencyKey | null {
      return (
        db.idempotency.find(
          (row) => row.key === eventId && row.scope === STRIPE_WEBHOOK_IDEMPOTENCY_SCOPE,
        ) ?? null
      );
    },
    grantsForEvent(eventId: string): readonly RecordedGrant[] {
      return ledger.grantsForKey(stripeLedgerKeyForEvent(eventId));
    },
  };
  return harness;
}
