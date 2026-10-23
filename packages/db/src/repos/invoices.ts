import { and, desc, eq, lt, or } from "drizzle-orm";

import { type Page, clampLimit, decodeCursor, encodeCursor } from "../cursor.js";
import type { StudioDb } from "../db.js";
import { DbError } from "../errors-lite.js";
import { createId } from "../ids.js";
import type { Invoice, InvoiceStatus } from "../schema.js";
import { tablesFor } from "../tables.js";
import { type WorkspaceId, requireNonEmpty, requireNonNegativeInt } from "./shared.js";

/**
 * Invoice repository — Stripe invoice persistence (§M6 task 2, billing page).
 *
 * Idempotency (law #4): `record` is keyed on `stripeInvoiceId`. A re-record
 * returns the EXISTING row (updated in place — same row identity) with
 * `replayed: true`, so a replayed webhook can never create a duplicate row.
 * Stripe invoice ids are globally unique, so an id that already exists under
 * ANOTHER workspace is a typed CONFLICT (mirrors the ledger's cross-workspace
 * idempotency-key rule). Races between two first-records of the same id are
 * settled by the UNIQUE(organization_id, stripe_invoice_id) index: the loser
 * re-reads the winner's row instead of inserting.
 *
 * `amountCents` is MONEY (Stripe minor units), never credits — the credit
 * ledger keeps its own D-12 microcredit entries.
 */

export interface RecordInvoiceInput {
  readonly stripeInvoiceId: string;
  /** Stripe minor units (e.g. US cents). */
  readonly amountCents: number;
  /** ISO 4217 lowercase 3-letter code, e.g. 'usd'. */
  readonly currency: string;
  readonly status: InvoiceStatus;
  readonly periodStart?: Date | null;
  readonly periodEnd?: Date | null;
  readonly hostedUrl?: string | null;
  readonly pdfUrl?: string | null;
}

export interface InvoiceResult {
  readonly invoice: Invoice;
  /** true when a row for this stripeInvoiceId already existed (row updated in place). */
  readonly replayed: boolean;
}

export interface InvoiceListOptions {
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface InvoicesRepo {
  /** Idempotent on stripeInvoiceId — re-records return the existing row. */
  record(workspaceId: WorkspaceId, input: RecordInvoiceInput): Promise<InvoiceResult>;
  list(workspaceId: WorkspaceId, options?: InvoiceListOptions): Promise<Page<Invoice>>;
}

const INVOICE_STATUSES: readonly InvoiceStatus[] = [
  "draft",
  "open",
  "paid",
  "void",
  "uncollectible",
];

function requireInvoiceStatus(value: InvoiceStatus): InvoiceStatus {
  if (!INVOICE_STATUSES.includes(value)) {
    throw DbError.validation("status must be one of draft|open|paid|void|uncollectible");
  }
  return value;
}

function requireCurrency(value: string): string {
  const currency = requireNonEmpty(value, "currency");
  if (!/^[a-z]{3}$/.test(currency)) {
    throw DbError.validation("currency must be a 3-letter ISO 4217 code, e.g. 'usd'");
  }
  return currency;
}

/**
 * Unique-violation check (pg SQLSTATE 23505; sqlite dev dialect:
 * SQLITE_CONSTRAINT_UNIQUE — W3-A) — walks the cause chain because drizzle
 * wraps the driver error in its own error type.
 */
function isUniqueViolation(error: unknown): boolean {
  for (let e = error; e !== null && typeof e === "object"; ) {
    const code = (e as { code?: unknown }).code;
    if (code === "23505" || code === "SQLITE_CONSTRAINT_UNIQUE") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

export function createInvoicesRepo(db: StudioDb): InvoicesRepo {
  // Dialect-aware tables (W3-A, tables.ts seam) — see createProjectsRepo.
  const { invoices, organization } = tablesFor(db);
  async function findByStripeInvoiceId(stripeInvoiceId: string): Promise<Invoice | null> {
    const [row] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.stripeInvoiceId, stripeInvoiceId))
      .limit(1);
    return row ?? null;
  }

  /** Mutable fields an out-of-order/replayed webhook may re-pin. */
  function mutableFields(input: RecordInvoiceInput) {
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
      if (!workspace) throw DbError.notFound("workspace");

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
        if (!updated) throw DbError.conflict("Could not update invoice");
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
        if (!row) throw DbError.conflict("Could not record invoice");
        return { invoice: row, replayed: false };
      } catch (error) {
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
          if (winner) throw DbError.conflict("Invoice already recorded for another workspace");
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
        .where(
          and(
            eq(invoices.organizationId, workspaceId),
            cursor
              ? or(
                  lt(invoices.createdAt, new Date(cursor.t)),
                  and(eq(invoices.createdAt, new Date(cursor.t)), lt(invoices.id, cursor.id)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(invoices.createdAt), desc(invoices.id))
        .limit(limit + 1);

      const items = rows.slice(0, limit);
      const last = items.at(-1);
      const hasMore = rows.length > limit;
      return {
        items,
        nextCursor:
          hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null,
      };
    },
  };
}
