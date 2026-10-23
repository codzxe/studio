import type { StudioDb } from "../db.js";
import { DbError } from "../errors-lite.js";
import { createId } from "../ids.js";
import { tablesFor } from "../tables.js";
import { requireNonEmpty } from "./shared.js";

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
  seenOrRecord(
    provider: string,
    eventId: string,
    input?: WebhookSeenInput,
  ): Promise<{ seen: boolean }>;
}

export function createWebhookEventsRepo(db: StudioDb): WebhookEventsRepo {
  // Dialect-aware tables (W3-A, tables.ts seam) — see createProjectsRepo.
  const { webhookEvents } = tablesFor(db);
  return {
    async seenOrRecord(provider, eventId, input) {
      const p = requireNonEmpty(provider, "provider");
      const id = requireNonEmpty(eventId, "eventId");

      try {
        const [row] = await db
          .insert(webhookEvents)
          .values({
            id: createId("whe"),
            provider: p,
            eventId: id,
            eventType: input?.type ?? null,
            payloadJson: input?.payload ?? null,
            processedAt: new Date(),
          })
          .returning({ id: webhookEvents.id });
        if (!row) throw DbError.conflict("Could not record webhook event");
        return { seen: false };
      } catch (error) {
        // A racing first-delivery inserted the same (provider, event_id):
        // this delivery is a replay → seen, never an error.
        if (isUniqueViolation(error)) return { seen: true };
        throw error;
      }
    },
  };
}
