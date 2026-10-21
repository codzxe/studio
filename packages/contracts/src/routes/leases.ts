// @studio/contracts — single-writer project lease (PRODUCT_ARCHITECTURE.md §7.2,
// §9.1 `project_leases`, §11: 2-minute heartbeat, 5-minute expiry).
//
// `POST /v1/projects/:id/lease` acquires OR renews (same body, §7.2);
// `DELETE /v1/projects/:id/lease` releases. A second editor opens read-only
// until the lease is released or expires (§9.3).

import { z } from "zod";

import type { Id } from "./common.js";

/** Heartbeat cadence while holding the lease (§11: 2 minutes). */
export const LEASE_HEARTBEAT_MS = 120_000;

/** Lease expiry (§11: 5 minutes) — renew before this or lose the lease. */
export const LEASE_TTL_MS = 300_000;

export const LEASE_SESSION_ID_SCHEMA = z.string().min(8).max(128);

/** `POST /v1/projects/:id/lease` body (acquire + renew are identical, §7.2). */
export const ACQUIRE_LEASE_SCHEMA = z.strictObject({
  sessionId: LEASE_SESSION_ID_SCHEMA,
});

export type AcquireLeaseRequest = z.infer<typeof ACQUIRE_LEASE_SCHEMA>;

/** `DELETE /v1/projects/:id/lease` has no body. */
export const RELEASE_LEASE_SCHEMA = z.strictObject({});

/** Lease row (§9.1 `project_leases`). */
export interface ProjectLease {
  readonly projectId: Id;
  readonly userId: Id;
  readonly sessionId: string;
  readonly expiresAt: string;
}
