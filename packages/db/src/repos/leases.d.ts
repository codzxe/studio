import type { StudioDb } from "../db.js";
import { type LeaseRequestEntry } from "../lease-logic.js";
import { type ProjectLease } from "../schema.js";
import { type WorkspaceId } from "./shared.js";
/**
 * Single-writer lease repository (§9.3, §11).
 *
 * The acquire path is atomic: the conditional upsert
 * `INSERT … ON CONFLICT (project_id) DO UPDATE … WHERE (expired OR same holder)`
 * guarantees that two concurrent acquirers can never both win; the loser
 * re-reads the row and reports the actual holder. Viewers of a leased project
 * open the editor read-only.
 *
 * ── M7 lease UX (§M7 task 3): the edit-request QUEUE ────────────────────────
 * `queueRequest`/`requestQueue`/`cancelRequest`/`electNextHolder` implement
 * "Alex is editing; request edit; release on close; expiry" around the same
 * invariant. The queue is held in MODULE-LEVEL state, mirroring the gateway's
 * documented single-instance posture (chat runs/SSE logs are in-memory too —
 * M2 gap finding #6): v1 deploys one gateway node, entries are keyed by
 * globally-unique project ids and every repo method still takes `workspaceId`
 * first and 404s on cross-tenant ids (law #3), so the queue can never leak
 * across workspaces. A process restart drops pending waiters — they re-request
 * from the banner on their next poll, and the LEASE itself (the thing that
 * actually blocks writers) stays fully durable in `project_leases`.
 * Follow-up for the schema owner (NOT this file's call): a durable
 * `project_lease_requests` table + migration when multi-instance lands.
 */
export interface LeaseAcquireInput {
    readonly userId: string;
    readonly sessionId: string;
    readonly ttlMs?: number;
}
export interface LeaseAcquireResult {
    readonly acquired: boolean;
    readonly holderId: string;
    readonly expiresAt: Date;
}
export interface LeaseRenewResult {
    readonly renewed: boolean;
    readonly holderId: string;
    readonly expiresAt: Date | null;
}
export interface LeaseSnapshot {
    readonly lease: ProjectLease;
    readonly isHeld: boolean;
}
export interface QueueRequestInput {
    readonly projectId: string;
    readonly userId: string;
}
export interface QueueRequestResult {
    readonly queued: true;
    /** 1-based; 1 = next to be elected. Re-joins keep their original position. */
    readonly position: number;
    readonly queueLength: number;
    readonly queuedAt: Date;
    /** `true` when the user was already queued (dedupe — nothing was inserted). */
    readonly duplicate: boolean;
}
export interface LeasesRepo {
    acquire(workspaceId: WorkspaceId, projectId: string, input: LeaseAcquireInput): Promise<LeaseAcquireResult>;
    renew(workspaceId: WorkspaceId, projectId: string, input: LeaseAcquireInput): Promise<LeaseRenewResult>;
    release(workspaceId: WorkspaceId, projectId: string, input: {
        userId: string;
        force?: boolean;
    }): Promise<{
        released: boolean;
    }>;
    get(workspaceId: WorkspaceId, projectId: string): Promise<LeaseSnapshot | null>;
    /** §M7 task 3: pending edit requests, oldest first (position 1 = next). */
    requestQueue(workspaceId: WorkspaceId, projectId: string): Promise<readonly LeaseRequestEntry[]>;
    /** §M7 task 3: join the queue (dedupe per user; typed full at the cap). */
    queueRequest(workspaceId: WorkspaceId, input: QueueRequestInput): Promise<QueueRequestResult>;
    /** §M7 task 3: leave the queue (`cancelled: false` when never queued). */
    cancelRequest(workspaceId: WorkspaceId, input: QueueRequestInput): Promise<{
        cancelled: boolean;
    }>;
    /**
     * §M7 task 3 takeover: pop the OLDEST queued requester after a release or
     * expiry — they become the notified next holder. `null` when nobody waits.
     */
    electNextHolder(workspaceId: WorkspaceId, projectId: string): Promise<LeaseRequestEntry | null>;
}
export declare function createLeasesRepo(db: StudioDb): LeasesRepo;
