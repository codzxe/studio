import { and, eq, inArray } from "drizzle-orm";
import { DbError } from "../errors-lite.js";
import { createId } from "../ids.js";
import { organization, stripeCustomers, subscriptions, } from "../schema.js";
import { requireNonEmpty } from "./shared.js";
const PLAN_IDS = ["trial", "starter", "pro", "studio"];
const SUBSCRIPTION_STATUSES = [
    "trialing",
    "active",
    "past_due",
    "canceled",
    "incomplete",
    "grace",
];
/** Webhook/checkout input is external — validate enums at the repo boundary. */
function requirePlanId(value) {
    if (!PLAN_IDS.includes(value)) {
        throw DbError.validation("planId must be one of trial|starter|pro|studio");
    }
    return value;
}
function requireSubscriptionStatus(value) {
    if (!SUBSCRIPTION_STATUSES.includes(value)) {
        throw DbError.validation("status must be one of trialing|active|past_due|canceled|incomplete|grace");
    }
    return value;
}
/** Unknown workspace = NOT_FOUND (never leak whether the id shape is valid). */
async function requireOrganization(db, workspaceId) {
    const [row] = await db
        .select({ id: organization.id })
        .from(organization)
        .where(eq(organization.id, workspaceId))
        .limit(1);
    if (!row)
        throw DbError.notFound("workspace");
}
export function createSubscriptionsRepo(db) {
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
            const planId = requirePlanId(input.planId);
            const status = requireSubscriptionStatus(input.status);
            await requireOrganization(db, workspaceId);
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
            // Atomic upsert on the unique organization_id — concurrent upserts can
            // never produce two rows for one workspace.
            const [row] = await db
                .insert(subscriptions)
                .values({ id: createId("sub"), organizationId: workspaceId, ...set })
                .onConflictDoUpdate({ target: subscriptions.organizationId, set })
                .returning();
            if (!row)
                throw DbError.conflict("Could not upsert subscription");
            return row;
        },
        async transitionStatus(workspaceId, input) {
            const to = requireSubscriptionStatus(input.to);
            if (input.from.length === 0) {
                throw DbError.validation("from must list at least one allowed status");
            }
            for (const allowed of input.from)
                requireSubscriptionStatus(allowed);
            if (input.planId !== undefined)
                requirePlanId(input.planId);
            // tenant-first load: another workspace's subscription does not exist.
            const current = await db
                .select()
                .from(subscriptions)
                .where(eq(subscriptions.organizationId, workspaceId))
                .limit(1);
            const before = current[0] ?? null;
            if (!before)
                throw DbError.notFound("subscription");
            if (!input.from.includes(before.status)) {
                throw DbError.conflict(`Subscription is ${before.status}; expected one of ${input.from.join("|")}`);
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
            if (updated)
                return updated;
            const [fresh] = await db
                .select()
                .from(subscriptions)
                .where(eq(subscriptions.id, before.id))
                .limit(1);
            throw DbError.conflict(`Subscription is now ${fresh?.status ?? "unknown"}; expected one of ${input.from.join("|")}`);
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
            if (!row)
                throw DbError.conflict("Could not ensure Stripe customer");
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
    };
}
//# sourceMappingURL=subscriptions.js.map