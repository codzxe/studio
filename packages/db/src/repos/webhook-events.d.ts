import type { StudioDb } from "../db.js";
/**
 * Webhook idempotency store — the durable "have I seen this event?" guard for
 * Stripe webhooks (law #4; BUILD_PLAN M6 task 2 "webhooks with signature
 * verification and idempotency").
 *
 * `seenOrRecord` records (provider, eventId) on first delivery and answers
 * `seen: true` for every replay — including a replay that races the original
 * delivery (the UNIQUE(provider, event_id) index arbitrates; the loser's
 * insert fails with 23505 and is reported as `seen`, never as an error).
 *
 * Deliberately NOT tenant-scoped: webhook event ids are provider-global and
 * the table stores no tenant content. The payload is kept as `payload_json`
 * for audit/reconciliation (BP M6 task 3).
 */
export interface WebhookSeenInput {
    /** Stripe event type, e.g. 'invoice.payment_succeeded'. */
    readonly type?: string | null;
    /** Raw (already signature-verified) event payload. */
    readonly payload?: unknown;
}
export interface WebhookEventsRepo {
    /**
     * Record-or-detect: returns { seen: false } exactly once per
     * (provider, eventId) — the first caller wins and the row is stored;
     * every later (or racing) call returns { seen: true }.
     */
    seenOrRecord(provider: string, eventId: string, input?: WebhookSeenInput): Promise<{
        seen: boolean;
    }>;
}
export declare function createWebhookEventsRepo(db: StudioDb): WebhookEventsRepo;
