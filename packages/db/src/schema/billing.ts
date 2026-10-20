// @studio/db — credits, plans, subscriptions, idempotency and rate limiting.
// Owner: W1-F (docs/AGENTS.md).
//
// Spec anchors:
//   §3.3   request lifecycle — the gateway reserves credits before a run is
//           enqueued (step 2); finalization commits the reservation (step 6)
//   §3.4   failure semantics — retries never double-charge; failed runs refund
//   §14.1   plan catalog — $30→100 / $60→250 / $120→600 credits; packs $10/100
//   §14.2   deduction rules — reserve → commit | refund; each entry carries an
//           idempotency key derived from run_id + phase (rule 6) and the ledger
//           rejects duplicates; insufficient balance → 402, run never starts
//   §14.3   Stripe webhooks are the only source of truth for subscription state
//   §12.1   credit_ledger / subscriptions table shapes
//   §12.2   ledger rows are append-only; balance is derived, cached on the
//           tenant and checked by a consistency job
//   §25.8   credits are reserved/committed/refunded transactionally with
//           idempotency keys, or the first angry email becomes forensics week
//
// Cross-file foreign keys (organizations / users, owned by other build agents)
// are intentionally not declared here; tenant scoping is enforced in the
// repository layer (§12.2). run ids are stored as opaque text so the money
// tables outlive run-row retention with no dangling references. Only the
// intra-file reference (subscriptions → plans) is DB-enforced, mirroring the
// runs.ts precedent.

import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** §14.2 — one ledger append per money event; grants/packs/adjustments included. */
export const CREDIT_LEDGER_KINDS = [
  "reserve",
  "commit",
  "refund",
  "adjustment",
  "grant",
  "pack",
] as const;
export type CreditLedgerKind = (typeof CREDIT_LEDGER_KINDS)[number];

/** §3.3 step 2 (held) → step 6 (committed) | §14.2 rules 3-4 (released). */
export const CREDIT_RESERVATION_STATUSES = [
  "held",
  "committed",
  "released",
] as const;
export type CreditReservationStatus =
  (typeof CREDIT_RESERVATION_STATUSES)[number];

/**
 * §12.1 / §14.2 — append-only double-entry credits ledger; the source of truth
 * for every balance. Positive delta = credits in (grant, pack, refund);
 * negative = credits out (reserve, commit charge, adjustment).
 *
 * APPEND-ONLY (§12.2, §25.8): rows are never UPDATEd or DELETEd; corrections
 * are new `adjustment` rows. `unique(idempotency_key, kind)` rejects duplicate
 * reserve/commit/refund writes (§14.2 rule 6). `balance_after` carries the
 * running organization balance so any single row audits in isolation.
 */
export const creditsLedger = pgTable(
  "credit_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // §12.2 tenant root — every query on this table is scoped by organization_id.
    organizationId: uuid("organization_id").notNull(),
    delta: integer("delta").notNull(), // +grant / -spend
    kind: text("kind").$type<CreditLedgerKind>().notNull(),
    // §14.2 rule 6: derived from run_id + phase; duplicates rejected below.
    idempotencyKey: text("idempotency_key").notNull(),
    runId: text("run_id"), // null for grant / pack / adjustment entries
    note: text("note"), // human-readable annotation, never machine-parsed
    balanceAfter: integer("balance_after").notNull(), // running org balance (§12.2)
    createdBy: uuid("created_by"), // §12.1 user_id? — null for system/webhook entries
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // §14.2 rule 6 — the ledger rejects duplicate phase writes.
    uniqueIndex("credit_ledger_idempotency_kind_uq").on(
      table.idempotencyKey,
      table.kind,
    ),
    // Balance reads walk the newest row per org (§12.2 derived balance).
    index("credit_ledger_org_created_idx").on(
      table.organizationId,
      table.createdAt.desc(),
    ),
  ],
);

/**
 * §14.2 rule 1 / §3.3 step 2 — the hold taken on run creation. One row per run
 * (run_id UNIQUE): status transitions held → committed (success, §3.3 step 6)
 * or released (failure/cancel, §14.2 rules 3-4). This is working state, not
 * the source of truth — the ledger above is.
 */
export const creditReservations = pgTable(
  "credit_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(), // §12.2 tenant column
    // Opaque run id (text by design — decoupled from run-row retention).
    runId: text("run_id").notNull().unique(), // one open reservation per run
    amount: integer("amount").notNull(), // tier base cost held at run creation
    status: text("status")
      .$type<CreditReservationStatus>()
      .notNull()
      .default("held"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Set once the reservation leaves "held" (committed or released).
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  (table) => [
    // §14.2 rule 1 availability check: SUM(amount) WHERE status = 'held'.
    index("credit_reservations_org_status_idx").on(
      table.organizationId,
      table.status,
    ),
  ],
);

/**
 * §14.1 plan catalog — seeded via migration; money in integer US cents (§12.2,
 * never floats). code is free text ('starter' | 'pro' | 'max') so catalog
 * changes ship as data, not schema edits.
 */
export const plans = pgTable("plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(), // 'starter' | 'pro' | 'max' (§14.1)
  monthlyUsdCents: integer("monthly_usd_cents").notNull(), // 3000 | 6000 | 12000
  monthlyCredits: integer("monthly_credits").notNull(), // 100 | 250 | 600
  extraSeatUsdCents: integer("extra_seat_usd_cents").notNull(), // +$8 seat (§14.1)
  maxConcurrentEngineSessions: integer("max_concurrent_engine_sessions").notNull(),
  maxUploadMb: integer("max_upload_mb").notNull(),
  // §14.1 plan differences beyond credits/seats/runs: canvas MP, export
  // fidelity, retention, support. Shape owned by the pricing/billing service.
  features: jsonb("features").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * §12.1 — one subscription row per organization; Stripe webhooks are the only
 * source of truth (§14.3). status mirrors Stripe's vocabulary and may also
 * hold the internal 15-credit 'holding' state from the §14.3 grace ladder,
 * so it stays free text rather than a closed enum.
 */
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().unique(), // one per org (§12.1)
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id), // intra-file FK (runs.ts precedent)
    stripeCustomerId: text("stripe_customer_id").notNull(),
    stripeSubscriptionId: text("stripe_subscription_id").notNull(),
    status: text("status").notNull(), // Stripe status or internal 'holding' (§14.3)
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAt: timestamp("cancel_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // §14.3 webhook fan-in: customer.subscription.* events resolve by id.
    index("subscriptions_stripe_subscription_idx").on(table.stripeSubscriptionId),
    // §14.3 customer portal: billing pages resolve customer → subscription.
    index("subscriptions_stripe_customer_idx").on(table.stripeCustomerId),
  ],
);

/**
 * General request idempotency (§3.4): (key, scope) identifies a logical
 * operation; `result` replays the original response to safe retries. The money
 * path is additionally hardened inside the ledger itself (§14.2 rule 6).
 */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    scope: text("scope").notNull(),
    organizationId: uuid("organization_id").notNull(), // §12.2 tenant column
    result: jsonb("result"), // replay payload; null until first completion
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idempotency_keys_key_scope_uq").on(table.key, table.scope),
  ],
);

/**
 * Token-bucket rate limiting state for the gateway/worker (scope identifies
 * the limit, e.g. 'api.runs.create'; bucket_key the subject, e.g. the org id).
 * Upserted by the limiter on its hot path; tokens may go negative for
 * debt-style buckets, so no sign constraint is imposed.
 */
export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: text("scope").notNull(),
    bucketKey: text("bucket_key").notNull(),
    tokens: integer("tokens").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The limiter's hot path is an upsert on (scope, bucket_key).
    uniqueIndex("rate_limit_buckets_scope_bucket_key_uq").on(
      table.scope,
      table.bucketKey,
    ),
  ],
);

export type CreditLedger = typeof creditsLedger.$inferSelect;
export type NewCreditLedger = typeof creditsLedger.$inferInsert;
export type CreditReservation = typeof creditReservations.$inferSelect;
export type NewCreditReservation = typeof creditReservations.$inferInsert;
export type Plan = typeof plans.$inferSelect;
export type NewPlan = typeof plans.$inferInsert;
export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;
export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
export type NewIdempotencyKey = typeof idempotencyKeys.$inferInsert;
export type RateLimitBucket = typeof rateLimitBuckets.$inferSelect;
export type NewRateLimitBucket = typeof rateLimitBuckets.$inferInsert;
