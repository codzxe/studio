import type { StudioDb } from "../db.js";
import { type PlanId, type StripeCustomer, type Subscription, type SubscriptionStatus } from "../schema.js";
import { type WorkspaceId } from "./shared.js";
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
    transitionStatus(workspaceId: WorkspaceId, input: SubscriptionTransitionInput): Promise<Subscription>;
    /** The workspace's Stripe customer row, or null. */
    findStripeCustomer(workspaceId: WorkspaceId): Promise<StripeCustomer | null>;
    /** Create-or-update the workspace's (single) Stripe customer mapping. */
    ensureStripeCustomer(workspaceId: WorkspaceId, input: EnsureStripeCustomerInput): Promise<StripeCustomer>;
    /**
     * One-trial-per-card abuse rule (BP M6 task 5): which workspace already
     * registered this card fingerprint? null = unused. NOT tenant-scoped —
     * returns ONE workspace holding the fingerprint (any match answers the
     * abuse check; several workspaces may legitimately share a card).
     */
    cardFingerprintUsed(fingerprint: string): Promise<{
        organizationId: string;
    } | null>;
}
export declare function createSubscriptionsRepo(db: StudioDb): SubscriptionsRepo;
