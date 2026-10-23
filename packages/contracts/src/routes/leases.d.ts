import { z } from "zod";
import { type Id } from "./common.js";
/** Heartbeat cadence while holding the lease (§11: 2 minutes). */
export declare const LEASE_HEARTBEAT_MS = 120000;
/** Lease expiry (§11: 5 minutes) — renew before this or lose the lease. */
export declare const LEASE_TTL_MS = 300000;
/** §M7 task 3: distinct members that may queue for one project's lease. */
export declare const LEASE_REQUEST_QUEUE_CAP = 20;
export declare const LEASE_SESSION_ID_SCHEMA: z.ZodString;
/** `POST /v1/projects/:id/lease` body (acquire + renew are identical, §7.2). */
export declare const ACQUIRE_LEASE_SCHEMA: z.ZodObject<{
    sessionId: z.ZodString;
}, z.core.$strict>;
export type AcquireLeaseRequest = z.infer<typeof ACQUIRE_LEASE_SCHEMA>;
/** `DELETE /v1/projects/:id/lease` has no body. */
export declare const RELEASE_LEASE_SCHEMA: z.ZodObject<{}, z.core.$strict>;
/** Lease row (§9.1 `project_leases`). */
export interface ProjectLease {
    readonly projectId: Id;
    readonly userId: Id;
    readonly sessionId: string;
    readonly expiresAt: string;
}
/**
 * §M7 read-only enforcement (D-23): a project-scoped mutation by anyone but
 * the ACTIVE lease holder answers 409 with this code. In @studio/config's
 * catalog it maps to HTTP 409, message "Someone else is editing this project
 * right now." — the gateway replaces the copy with "{Name} is editing this
 * project right now." (display name, never an id — law #1). Chat stays
 * ALLOWED for non-holders (the agent may look and propose; only project
 * writes are gated), so no chat route emits this code.
 */
export declare const LEASE_HELD_ERROR_CODE: "LEASE_HELD";
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
export declare const LEASE_QUEUE_ENTRY_SCHEMA: z.ZodObject<{
    userId: z.ZodString;
    displayName: z.ZodString;
    queuedAt: z.ZodString;
}, z.core.$strip>;
export declare const LEASE_STATE_RESPONSE_SCHEMA: z.ZodObject<{
    holder: z.ZodNullable<z.ZodObject<{
        userId: z.ZodString;
        displayName: z.ZodString;
        acquiredAt: z.ZodString;
        expiresAt: z.ZodString;
    }, z.core.$strip>>;
    queue: z.ZodArray<z.ZodObject<{
        userId: z.ZodString;
        displayName: z.ZodString;
        queuedAt: z.ZodString;
    }, z.core.$strip>>;
    youAre: z.ZodEnum<{
        queued: "queued";
        holder: "holder";
        viewer: "viewer";
    }>;
    canAcquire: z.ZodBoolean;
}, z.core.$strip>;
/** `POST /v1/projects/:id/lease-request` has no body (the session is the requester). */
export declare const LEASE_REQUEST_SCHEMA: z.ZodObject<{}, z.core.$strict>;
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
export declare const LEASE_REQUEST_RESPONSE_SCHEMA: z.ZodObject<{
    queued: z.ZodLiteral<true>;
    position: z.ZodNumber;
    queueLength: z.ZodNumber;
    queuedAt: z.ZodString;
    duplicate: z.ZodBoolean;
}, z.core.$strip>;
/** `DELETE /v1/projects/:id/lease-request` — leave outcome. */
export interface LeaseRequestCancelledResponse {
    /** `false` when the caller was never queued. */
    readonly cancelled: boolean;
}
export declare const LEASE_REQUEST_CANCELLED_RESPONSE_SCHEMA: z.ZodObject<{
    cancelled: z.ZodBoolean;
}, z.core.$strip>;
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
export declare const LEASE_RELEASE_RESPONSE_SCHEMA: z.ZodObject<{
    released: z.ZodBoolean;
    nextHolder: z.ZodNullable<z.ZodObject<{
        userId: z.ZodString;
        displayName: z.ZodString;
        queuedAt: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
