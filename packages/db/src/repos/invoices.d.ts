import { type Page } from "../cursor.js";
import type { StudioDb } from "../db.js";
import { type Invoice, type InvoiceStatus } from "../schema.js";
import { type WorkspaceId } from "./shared.js";
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
export declare function createInvoicesRepo(db: StudioDb): InvoicesRepo;
