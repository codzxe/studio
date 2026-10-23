// @studio/contracts — single-writer project lease + the M7 lease UX
// (PRODUCT_ARCHITECTURE.md §7.2, §9.1 `project_leases`, §11: 2-minute
// heartbeat, 5-minute expiry; BUILD_PLAN §M7 task 3).
//
// `POST /v1/projects/:id/lease` acquires OR renews (same body, §7.2);
// `DELETE /v1/projects/:id/lease` releases (and elects the next holder).
// A second editor opens read-only until the lease is released or expires
// (§9.3) — blocked writes answer with the `LEASE_HELD` error code below.
//
// M7 lease UX routes (§M7 task 3 "Alex is editing"):
//   POST   /v1/projects/:id/lease-request  join the edit queue (dedupe/cap)
//   DELETE /v1/projects/:id/lease-request  leave the queue
//   GET    /v1/projects/:id/lease-state    the banner endpoint (holder, queue,
//                                          youAre, canAcquire)
import { z } from "zod";
import { ID_SCHEMA, ISO8601_SCHEMA } from "./common.js";
/** Heartbeat cadence while holding the lease (§11: 2 minutes). */
export const LEASE_HEARTBEAT_MS = 120_000;
/** Lease expiry (§11: 5 minutes) — renew before this or lose the lease. */
export const LEASE_TTL_MS = 300_000;
/** §M7 task 3: distinct members that may queue for one project's lease. */
export const LEASE_REQUEST_QUEUE_CAP = 20;
export const LEASE_SESSION_ID_SCHEMA = z.string().min(8).max(128);
/** `POST /v1/projects/:id/lease` body (acquire + renew are identical, §7.2). */
export const ACQUIRE_LEASE_SCHEMA = z.strictObject({
    sessionId: LEASE_SESSION_ID_SCHEMA,
});
/** `DELETE /v1/projects/:id/lease` has no body. */
export const RELEASE_LEASE_SCHEMA = z.strictObject({});
/**
 * §M7 read-only enforcement (D-23): a project-scoped mutation by anyone but
 * the ACTIVE lease holder answers 409 with this code. In @studio/config's
 * catalog it maps to HTTP 409, message "Someone else is editing this project
 * right now." — the gateway replaces the copy with "{Name} is editing this
 * project right now." (display name, never an id — law #1). Chat stays
 * ALLOWED for non-holders (the agent may look and propose; only project
 * writes are gated), so no chat route emits this code.
 */
export const LEASE_HELD_ERROR_CODE = "LEASE_HELD";
export const LEASE_QUEUE_ENTRY_SCHEMA = z.object({
    userId: ID_SCHEMA,
    displayName: z.string().min(1),
    queuedAt: ISO8601_SCHEMA,
});
export const LEASE_STATE_RESPONSE_SCHEMA = z.object({
    holder: z
        .object({
        userId: ID_SCHEMA,
        displayName: z.string().min(1),
        acquiredAt: ISO8601_SCHEMA,
        expiresAt: ISO8601_SCHEMA,
    })
        .nullable(),
    queue: z.array(LEASE_QUEUE_ENTRY_SCHEMA),
    youAre: z.enum(["holder", "queued", "viewer"]),
    canAcquire: z.boolean(),
});
/** `POST /v1/projects/:id/lease-request` has no body (the session is the requester). */
export const LEASE_REQUEST_SCHEMA = z.strictObject({});
export const LEASE_REQUEST_RESPONSE_SCHEMA = z.object({
    queued: z.literal(true),
    position: z.number().int().positive(),
    queueLength: z.number().int().nonnegative(),
    queuedAt: ISO8601_SCHEMA,
    duplicate: z.boolean(),
});
export const LEASE_REQUEST_CANCELLED_RESPONSE_SCHEMA = z.object({
    cancelled: z.boolean(),
});
export const LEASE_RELEASE_RESPONSE_SCHEMA = z.object({
    released: z.boolean(),
    nextHolder: LEASE_QUEUE_ENTRY_SCHEMA.nullable(),
});
//# sourceMappingURL=leases.js.map