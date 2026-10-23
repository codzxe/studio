import { DbError } from "../errors-lite.js";
import { createId } from "../ids.js";
import { webhookEvents } from "../schema.js";
import { requireNonEmpty } from "./shared.js";
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
export function createWebhookEventsRepo(db) {
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
                if (!row)
                    throw DbError.conflict("Could not record webhook event");
                return { seen: false };
            }
            catch (error) {
                // A racing first-delivery inserted the same (provider, event_id):
                // this delivery is a replay → seen, never an error.
                if (isUniqueViolation(error))
                    return { seen: true };
                throw error;
            }
        },
    };
}
//# sourceMappingURL=webhook-events.js.map