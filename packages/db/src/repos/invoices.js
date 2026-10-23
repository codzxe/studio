import { and, desc, eq, lt, or } from "drizzle-orm";
import { clampLimit, decodeCursor, encodeCursor } from "../cursor.js";
import { DbError } from "../errors-lite.js";
import { createId } from "../ids.js";
import { invoices, organization } from "../schema.js";
import { requireNonEmpty, requireNonNegativeInt } from "./shared.js";
const INVOICE_STATUSES = [
    "draft",
    "open",
    "paid",
    "void",
    "uncollectible",
];
function requireInvoiceStatus(value) {
    if (!INVOICE_STATUSES.includes(value)) {
        throw DbError.validation("status must be one of draft|open|paid|void|uncollectible");
    }
    return value;
}
function requireCurrency(value) {
    const currency = requireNonEmpty(value, "currency");
    if (!/^[a-z]{3}$/.test(currency)) {
        throw DbError.validation("currency must be a 3-letter ISO 4217 code, e.g. 'usd'");
    }
    return currency;
}
/**
 * Postgres unique-violation (SQLSTATE 23505) — walks the cause chain because
 * drizzle wraps the PostgresError (`Failed query …`) in its own error type.
 */
function isUniqueViolation(error) {
    for (let e = error; e !== null && typeof e === "object";) {
        if (e.code === "23505")
            return true;
        e = e.cause;
    }
    return false;
}
export function createInvoicesRepo(db) {
    async function findByStripeInvoiceId(stripeInvoiceId) {
        const [row] = await db
            .select()
            .from(invoices)
            .where(eq(invoices.stripeInvoiceId, stripeInvoiceId))
            .limit(1);
        return row ?? null;
    }
    /** Mutable fields an out-of-order/replayed webhook may re-pin. */
    function mutableFields(input) {
        return {
            amountCents: input.amountCents,
            currency: input.currency,
            status: input.status,
            ...(input.periodStart !== undefined ? { periodStart: input.periodStart } : {}),
            ...(input.periodEnd !== undefined ? { periodEnd: input.periodEnd } : {}),
            ...(input.hostedUrl !== undefined ? { hostedUrl: input.hostedUrl } : {}),
            ...(input.pdfUrl !== undefined ? { pdfUrl: input.pdfUrl } : {}),
        };
    }
    return {
        async record(workspaceId, input) {
            const stripeInvoiceId = requireNonEmpty(input.stripeInvoiceId, "stripeInvoiceId");
            const amountCents = requireNonNegativeInt(input.amountCents, "amountCents");
            const currency = requireCurrency(input.currency);
            const status = requireInvoiceStatus(input.status);
            const [workspace] = await db
                .select({ id: organization.id })
                .from(organization)
                .where(eq(organization.id, workspaceId))
                .limit(1);
            if (!workspace)
                throw DbError.notFound("workspace");
            // Idempotent replay: same workspace → update-in-place, replayed: true.
            const existing = await findByStripeInvoiceId(stripeInvoiceId);
            if (existing) {
                if (existing.organizationId !== workspaceId) {
                    throw DbError.conflict("Invoice already recorded for another workspace");
                }
                const [updated] = await db
                    .update(invoices)
                    .set(mutableFields(input))
                    .where(eq(invoices.id, existing.id))
                    .returning();
                if (!updated)
                    throw DbError.conflict("Could not update invoice");
                return { invoice: updated, replayed: true };
            }
            try {
                const [row] = await db
                    .insert(invoices)
                    .values({
                    id: createId("inv"),
                    organizationId: workspaceId,
                    stripeInvoiceId,
                    amountCents,
                    currency,
                    status,
                    periodStart: input.periodStart ?? null,
                    periodEnd: input.periodEnd ?? null,
                    hostedUrl: input.hostedUrl ?? null,
                    pdfUrl: input.pdfUrl ?? null,
                })
                    .returning();
                if (!row)
                    throw DbError.conflict("Could not record invoice");
                return { invoice: row, replayed: false };
            }
            catch (error) {
                // Lost an insert race for the same id: return the winner's row.
                if (isUniqueViolation(error)) {
                    const winner = await findByStripeInvoiceId(stripeInvoiceId);
                    if (winner && winner.organizationId === workspaceId) {
                        const [updated] = await db
                            .update(invoices)
                            .set(mutableFields(input))
                            .where(eq(invoices.id, winner.id))
                            .returning();
                        return { invoice: updated ?? winner, replayed: true };
                    }
                    if (winner)
                        throw DbError.conflict("Invoice already recorded for another workspace");
                }
                throw error;
            }
        },
        async list(workspaceId, options) {
            const limit = clampLimit(options?.limit);
            const cursor = decodeCursor(options?.cursor ?? null);
            const rows = await db
                .select()
                .from(invoices)
                .where(and(eq(invoices.organizationId, workspaceId), cursor
                ? or(lt(invoices.createdAt, new Date(cursor.t)), and(eq(invoices.createdAt, new Date(cursor.t)), lt(invoices.id, cursor.id)))
                : undefined))
                .orderBy(desc(invoices.createdAt), desc(invoices.id))
                .limit(limit + 1);
            const items = rows.slice(0, limit);
            const last = items.at(-1);
            const hasMore = rows.length > limit;
            return {
                items,
                nextCursor: hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null,
            };
        },
    };
}
//# sourceMappingURL=invoices.js.map