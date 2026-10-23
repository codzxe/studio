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

import { ID_SCHEMA, ISO8601_SCHEMA, type Id } from "./common.js";

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

/**
 * `POST /v1/projects/:id/lease` response (W5-09): the acquire/renew OUTCOME,
 * not the §9.1 lease row `ProjectLease` above — the row is server-private
 * (it leaks holder userId/sessionId); the wire answers whether WE hold, who
 * holds as a DISPLAY NAME (law #1: human copy, never an id), when their
 * window ends, and whether this session must open read-only (§9.3).
 */
export interface LeaseAcquireResponse {
  /** `true` = we hold (or just renewed) the lease. */
  readonly acquired: boolean;
  /** Display name of the current holder (the gateway resolves ids to names). */
  readonly holderName: string;
  readonly expiresAt: string;
  /** `true` = this session must open read-only (§9.3: a refused acquire). */
  readonly readOnly: boolean;
}

export const LEASE_ACQUIRE_RESPONSE_SCHEMA = z.object({
  acquired: z.boolean(),
  holderName: z.string().min(1),
  expiresAt: ISO8601_SCHEMA,
  readOnly: z.boolean(),
}) satisfies z.ZodType<LeaseAcquireResponse>;

/**
 * §M7 read-only enforcement (D-23): a project-scoped mutation by anyone but
 * the ACTIVE lease holder answers 409 with this code. In @studio/config's
 * catalog it maps to HTTP 409, message "Someone else is editing this project
 * right now." — the gateway replaces the copy with "{Name} is editing this
 * project right now." (display name, never an id — law #1). Chat stays
 * ALLOWED for non-holders (the agent may look and propose; only project
 * writes are gated), so no chat route emits this code.
 */
export const LEASE_HELD_ERROR_CODE = "LEASE_HELD" as const;

/** A member waiting for the edit lease, oldest first (position 1 = next). */
export interface LeaseQueueEntry {
  readonly userId: Id;
  /** Display name — human copy, never an id (law #1). */
  readonly displayName: string;
  readonly queuedAt: string;
}

/**
 * The active holder as the banner shows them. `acquiredAt` is DERIVED
 * (expiresAt − TTL = the start of the holder's current renewal window; the
 * lease row persists no tenure start) — countdowns must read `expiresAt`.
 */
export interface LeaseStateHolder {
  readonly userId: Id;
  readonly displayName: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

/** The caller's standing for this project. */
export type LeaseYouAre = "holder" | "queued" | "viewer";

/**
 * `GET /v1/projects/:id/lease-state` — the ONE endpoint the "Alex is editing"
 * banner renders from: who holds, who waits, who you are, and whether a
 * `POST /lease` right now would win (free, expired, or already yours).
 */
export interface LeaseStateResponse {
  /** `null` when no lease row exists or the row has expired (dead weight). */
  readonly holder: LeaseStateHolder | null;
  /** Pending edit requests, oldest first. */
  readonly queue: readonly LeaseQueueEntry[];
  readonly youAre: LeaseYouAre;
  readonly canAcquire: boolean;
}

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
}) satisfies z.ZodType<LeaseStateResponse>;

/** `POST /v1/projects/:id/lease-request` has no body (the session is the requester). */
export const LEASE_REQUEST_SCHEMA = z.strictObject({});

/**
 * `POST /v1/projects/:id/lease-request` — join outcome. A duplicate join keeps
 * the ORIGINAL position and queuedAt (re-requesting never jumps the line);
 * a full queue is typed QUOTA_EXCEEDED (429) upstream.
 */
export interface LeaseRequestResponse {
  readonly queued: true;
  /** 1-based; 1 = next to be elected. */
  readonly position: number;
  readonly queueLength: number;
  readonly queuedAt: string;
  /** `true` when the user was already queued (dedupe — nothing was inserted). */
  readonly duplicate: boolean;
}

export const LEASE_REQUEST_RESPONSE_SCHEMA = z.object({
  queued: z.literal(true),
  position: z.number().int().positive(),
  queueLength: z.number().int().nonnegative(),
  queuedAt: ISO8601_SCHEMA,
  duplicate: z.boolean(),
}) satisfies z.ZodType<LeaseRequestResponse>;

/** `DELETE /v1/projects/:id/lease-request` — leave outcome. */
export interface LeaseRequestCancelledResponse {
  /** `false` when the caller was never queued. */
  readonly cancelled: boolean;
}

export const LEASE_REQUEST_CANCELLED_RESPONSE_SCHEMA = z.object({
  cancelled: z.boolean(),
}) satisfies z.ZodType<LeaseRequestCancelledResponse>;

/**
 * `DELETE /v1/projects/:id/lease` — release outcome + the §M7 task 3
 * takeover: when a queue exists, the OLDEST requester is popped and returned
 * here as the notified next holder (their UI lets them acquire instantly).
 */
export interface LeaseReleaseResponse {
  readonly released: boolean;
  /** The elected next holder, or `null` when nobody had requested edit access. */
  readonly nextHolder: LeaseQueueEntry | null;
}

export const LEASE_RELEASE_RESPONSE_SCHEMA = z.object({
  released: z.boolean(),
  nextHolder: LEASE_QUEUE_ENTRY_SCHEMA.nullable(),
}) satisfies z.ZodType<LeaseReleaseResponse>;
