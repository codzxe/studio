import { and, eq, inArray, sql } from "drizzle-orm";

import { type Executor, type StudioDb, getDialect } from "../db.js";
import { DbError } from "../errors-lite.js";
import { createId } from "../ids.js";
import type { PlanId, StripeCustomer, Subscription, SubscriptionStatus } from "../schema.js";
import { tablesFor } from "../tables.js";
import { type WorkspaceId, requireNonEmpty } from "./shared.js";

/**
 * Billing repository — §M6 plans/entitlements persistence + abuse controls.
 *
 * House rules kept (documented for reviewers):
 * - Tenant-first: every read/mutation is keyed on `workspaceId` (law #3);
 *   a subscription that belongs to another workspace simply does not exist.
 * - One live subscription per workspace: UNIQUE(organization_id) — state is
 *   UPSERTED on that key, never duplicated (BP M6 task 1).
 * - `transitionStatus` is a GUARDED conditional update: the WHERE clause
 *   re-checks `status IN (from)` at the database level, so two concurrent
 *   webhook deliveries of the same state change can never both apply (law #4;
 *   the loser gets a typed CONFLICT, the winner's row is returned).
 * - NO work-deletion semantics anywhere (BP M6.2): cancellation writes
 *   status/cancel_at_period_end only; projects, versions and ledger rows are
 *   never touched from here.
 * - `cardFingerprintUsed` is deliberately NOT tenant-scoped — the
 *   one-trial-per-card rule (BP M6 task 5) is cross-workspace by definition;
 *   it returns only the organization id, never tenant content.
 * - Trial is a subscription STATE on the Starter row (D-4): trialing rows
 *   carry plan_id='starter'; plan_id='trial' is the pre-checkout placeholder.
 */

export interface SubscriptionUpsertInput {
  readonly planId: PlanId;
  readonly status: SubscriptionStatus;
  readonly stripeSubscriptionId?: string | null;
  readonly currentPeriodEnd?: Date | null;
  readonly trialEnd?: Date | null;
  readonly cancelAtPeriodEnd?: boolean;
  readonly graceEnd?: Date | null;
}

/**
 * Guarded transition: only applies when the current status is one of `from`
 * (checked in-process AND re-checked in the UPDATE's WHERE clause — races lose
 * with a typed CONFLICT, never a double-apply).
 */
export interface SubscriptionTransitionInput {
  readonly from: readonly SubscriptionStatus[];
  readonly to: SubscriptionStatus;
  /** Optional fields re-pinned by the webhook that drives the transition. */
  readonly planId?: PlanId;
  readonly currentPeriodEnd?: Date | null;
  readonly trialEnd?: Date | null;
  readonly cancelAtPeriodEnd?: boolean;
  readonly graceEnd?: Date | null;
}

export interface EnsureStripeCustomerInput {
  readonly stripeCustomerId: string;
  /**
   * Stripe card fingerprint (BP M6 task 5). Only a non-empty value is ever
   * written — the repo never clears a fingerprint (abuse memory is append-ish);
   * a new card overwrites the previous fingerprint.
   */
  readonly cardFingerprint?: string | null;
}

export interface SubscriptionsRepo {
  /** The workspace's live subscription row, or null when none exists yet. */
  getByOrganization(workspaceId: WorkspaceId): Promise<Subscription | null>;
  /** Insert-or-update the workspace's (single) subscription state. */
  upsertState(workspaceId: WorkspaceId, input: SubscriptionUpsertInput): Promise<Subscription>;
  /**
   * Guarded status transition — the webhook path's "never double-apply"
   * guarantee. Current status must be one of `from`, else typed CONFLICT.
   */
  transitionStatus(
    workspaceId: WorkspaceId,
    input: SubscriptionTransitionInput,
  ): Promise<Subscription>;
  /** The workspace's Stripe customer row, or null. */
  findStripeCustomer(workspaceId: WorkspaceId): Promise<StripeCustomer | null>;
  /** Create-or-update the workspace's (single) Stripe customer mapping. */
  ensureStripeCustomer(
    workspaceId: WorkspaceId,
    input: EnsureStripeCustomerInput,
  ): Promise<StripeCustomer>;
  /**
   * One-trial-per-card abuse rule (BP M6 task 5): which workspace already
   * registered this card fingerprint? null = unused. NOT tenant-scoped —
   * returns ONE workspace holding the fingerprint (any match answers the
   * abuse check; several workspaces may legitimately share a card).
   */
  cardFingerprintUsed(fingerprint: string): Promise<{ organizationId: string } | null>;
  /**
   * AUD-M5 (2026-10-30 deep audit): claim a trial on a payment method under
   * a FINGERPRINT-KEYED advisory lock — the check-then-upsert on the route
   * was racy: two workspaces presenting the same card in parallel both
   * passed `cardFingerprintUsed` and both got a 14-day trial. Returns
   * `{ claimed: false }` when the card (now) belongs to another workspace;
   * sqlite skips the advisory lock (single serialized connection).
   */
  claimTrial(
    workspaceId: WorkspaceId,
    input: {
      readonly fingerprint: string;
      readonly state: SubscriptionUpsertInput;
    },
  ): Promise<{ readonly claimed: boolean; readonly subscription: Subscription | null }>;
}

const PLAN_IDS: readonly PlanId[] = ["trial", "starter", "pro", "studio"];
const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  "trialing",
  "active",
  "past_due",
  "canceled",
  "incomplete",
  "grace",
];

/** Webhook/checkout input is external — validate enums at the repo boundary. */
function requirePlanId(value: PlanId): PlanId {
  if (!PLAN_IDS.includes(value)) {
    throw DbError.validation("planId must be one of trial|starter|pro|studio");
  }
  return value;
}

function requireSubscriptionStatus(value: SubscriptionStatus): SubscriptionStatus {
  if (!SUBSCRIPTION_STATUSES.includes(value)) {
    throw DbError.validation(
      "status must be one of trialing|active|past_due|canceled|incomplete|grace",
    );
  }
  return value;
}

/** Unknown workspace = NOT_FOUND (never leak whether the id shape is valid). */
async function requireOrganization(db: StudioDb, workspaceId: WorkspaceId): Promise<void> {
  const { organization } = tablesFor(db);
  const [row] = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.id, workspaceId))
    .limit(1);
  if (!row) throw DbError.notFound("workspace");
}

/** The upsert body, shared by upsertState and claimTrial (tx-agnostic). */
async function upsertStateTx(
  exec: Executor,
  workspaceId: WorkspaceId,
  input: {
    readonly planId: PlanId;
    readonly status: SubscriptionStatus;
    readonly stripeSubscriptionId?: string | null;
    readonly currentPeriodEnd?: Date | null;
    readonly trialEnd?: Date | null;
    readonly cancelAtPeriodEnd?: boolean;
    readonly graceEnd?: Date | null;
  },
  subscriptionsTable: typeof import("../schema.js").subscriptions,
): Promise<Subscription> {
  const planId = requirePlanId(input.planId);
  const status = requireSubscriptionStatus(input.status);
  const set = {
    planId,
    status,
    updatedAt: new Date(),
    ...(input.stripeSubscriptionId !== undefined
      ? { stripeSubscriptionId: input.stripeSubscriptionId }
      : {}),
    ...(input.currentPeriodEnd !== undefined
      ? { currentPeriodEnd: input.currentPeriodEnd }
      : {}),
    ...(input.trialEnd !== undefined ? { trialEnd: input.trialEnd } : {}),
    ...(input.cancelAtPeriodEnd !== undefined
      ? { cancelAtPeriodEnd: input.cancelAtPeriodEnd }
      : {}),
    ...(input.graceEnd !== undefined ? { graceEnd: input.graceEnd } : {}),
  };
  const [row] = await exec
    .insert(subscriptionsTable)
    .values({ id: createId("sub"), organizationId: workspaceId, ...set })
    .onConflictDoUpdate({ target: subscriptionsTable.organizationId, set })
    .returning();
  if (!row) throw DbError.conflict("Could not upsert subscription");
  return row;
}

export function createSubscriptionsRepo(db: StudioDb): SubscriptionsRepo {
  // Dialect-aware tables (W3-A, tables.ts seam) — see createProjectsRepo.
  const { organization, stripeCustomers, subscriptions } = tablesFor(db);
  return {
    async getByOrganization(workspaceId) {
      const [row] = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.organizationId, workspaceId))
        .limit(1);
      return row ?? null;
    },

    async upsertState(workspaceId, input) {
      await requireOrganization(db, workspaceId);
      return upsertStateTx(db, workspaceId, input, subscriptions);
    },

    async transitionStatus(workspaceId, input) {
      const to = requireSubscriptionStatus(input.to);
      if (input.from.length === 0) {
        throw DbError.validation("from must list at least one allowed status");
      }
      for (const allowed of input.from) requireSubscriptionStatus(allowed);
      if (input.planId !== undefined) requirePlanId(input.planId);

      // tenant-first load: another workspace's subscription does not exist.
      const current = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.organizationId, workspaceId))
        .limit(1);
      const before = current[0] ?? null;
      if (!before) throw DbError.notFound("subscription");

      if (!input.from.includes(before.status)) {
        throw DbError.conflict(
          `Subscription is ${before.status}; expected one of ${input.from.join("|")}`,
        );
      }

      const set = {
        status: to,
        updatedAt: new Date(),
        ...(input.planId !== undefined ? { planId: input.planId } : {}),
        ...(input.currentPeriodEnd !== undefined
          ? { currentPeriodEnd: input.currentPeriodEnd }
          : {}),
        ...(input.trialEnd !== undefined ? { trialEnd: input.trialEnd } : {}),
        ...(input.cancelAtPeriodEnd !== undefined
          ? { cancelAtPeriodEnd: input.cancelAtPeriodEnd }
          : {}),
        ...(input.graceEnd !== undefined ? { graceEnd: input.graceEnd } : {}),
      };

      // Guarded conditional update: the status guard is re-checked INSIDE the
      // WHERE clause — a racing transition that landed first leaves this
      // matching zero rows, and we re-read to report the typed conflict.
      const [updated] = await db
        .update(subscriptions)
        .set(set)
        .where(and(eq(subscriptions.id, before.id), inArray(subscriptions.status, [...input.from])))
        .returning();
      if (updated) return updated;

      const [fresh] = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.id, before.id))
        .limit(1);
      throw DbError.conflict(
        `Subscription is now ${fresh?.status ?? "unknown"}; expected one of ${input.from.join("|")}`,
      );
    },

    async findStripeCustomer(workspaceId) {
      const [row] = await db
        .select()
        .from(stripeCustomers)
        .where(eq(stripeCustomers.organizationId, workspaceId))
        .limit(1);
      return row ?? null;
    },

    async ensureStripeCustomer(workspaceId, input) {
      const stripeCustomerId = requireNonEmpty(input.stripeCustomerId, "stripeCustomerId");
      await requireOrganization(db, workspaceId);

      const set = {
        stripeCustomerId,
        ...(input.cardFingerprint
          ? { cardFingerprint: requireNonEmpty(input.cardFingerprint, "cardFingerprint") }
          : {}),
      };

      // Atomic upsert on the unique organization_id — one customer per
      // workspace, safe under concurrent checkout completions.
      const [row] = await db
        .insert(stripeCustomers)
        .values({ id: createId("sc"), organizationId: workspaceId, ...set })
        .onConflictDoUpdate({ target: stripeCustomers.organizationId, set })
        .returning();
      if (!row) throw DbError.conflict("Could not ensure Stripe customer");
      return row;
    },

    async cardFingerprintUsed(fingerprint) {
      const cardFingerprint = requireNonEmpty(fingerprint, "cardFingerprint");
      const [row] = await db
        .select({ organizationId: stripeCustomers.organizationId })
        .from(stripeCustomers)
        .where(eq(stripeCustomers.cardFingerprint, cardFingerprint))
        .limit(1);
      return row ?? null;
    },

    async claimTrial(workspaceId, input) {
      const fingerprint = requireNonEmpty(input.fingerprint, "fingerprint");
      await requireOrganization(db, workspaceId);
      return db.transaction(async (tx) => {
        // AUD-M5: serialize every claimant of THIS card — the lock is keyed
        // on the fingerprint (cross-workspace), not the workspace, so the
        // used-check + upsert inside is one indivisible section. The sqlite
        // dev twin is one serialized connection — the lock is a no-op there.
        if (getDialect(db) === "postgres") {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`trial:${fingerprint}`}))`);
        }
        const { stripeCustomers: customersTx } = tablesFor(tx);
        const [used] = await tx
          .select({ organizationId: customersTx.organizationId })
          .from(customersTx)
          .where(eq(customersTx.cardFingerprint, fingerprint))
          .limit(1);
        if (used !== undefined && used.organizationId !== workspaceId) {
          return { claimed: false as const, subscription: null as Subscription | null };
        }
        const { subscriptions: subscriptionsTx } = tablesFor(tx);
        const subscription = await upsertStateTx(tx, workspaceId, input.state, subscriptionsTx);
        return { claimed: true as const, subscription };
      });
    },
  };
}
