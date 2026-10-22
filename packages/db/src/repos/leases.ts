import { and, eq, lt, or } from "drizzle-orm";

import type { StudioDb } from "../db.js";
import { DbError } from "../errors-lite.js";
import {
  DEFAULT_LEASE_TTL_MS,
  LEASE_REQUEST_QUEUE_CAP,
  type LeaseDecision,
  type LeaseRequestEntry,
  isLeaseHeld,
  leaseDecision,
  nextHolderOf,
  queueRequestDecision,
} from "../lease-logic.js";
import { type ProjectLease, projectLeases, projects } from "../schema.js";
import { type WorkspaceId, requireNonEmpty } from "./shared.js";

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
  acquire(
    workspaceId: WorkspaceId,
    projectId: string,
    input: LeaseAcquireInput,
  ): Promise<LeaseAcquireResult>;
  renew(
    workspaceId: WorkspaceId,
    projectId: string,
    input: LeaseAcquireInput,
  ): Promise<LeaseRenewResult>;
  release(
    workspaceId: WorkspaceId,
    projectId: string,
    input: { userId: string; force?: boolean },
  ): Promise<{ released: boolean }>;
  get(workspaceId: WorkspaceId, projectId: string): Promise<LeaseSnapshot | null>;
  /** §M7 task 3: pending edit requests, oldest first (position 1 = next). */
  requestQueue(workspaceId: WorkspaceId, projectId: string): Promise<readonly LeaseRequestEntry[]>;
  /** §M7 task 3: join the queue (dedupe per user; typed full at the cap). */
  queueRequest(workspaceId: WorkspaceId, input: QueueRequestInput): Promise<QueueRequestResult>;
  /** §M7 task 3: leave the queue (`cancelled: false` when never queued). */
  cancelRequest(
    workspaceId: WorkspaceId,
    input: QueueRequestInput,
  ): Promise<{ cancelled: boolean }>;
  /**
   * §M7 task 3 takeover: pop the OLDEST queued requester after a release or
   * expiry — they become the notified next holder. `null` when nobody waits.
   */
  electNextHolder(workspaceId: WorkspaceId, projectId: string): Promise<LeaseRequestEntry | null>;
}

/**
 * Edit-request queue, projectId → entries oldest-first (module-level; see the
 * header's single-instance note). Copies in/out so callers can never mutate
 * the live ordering.
 */
const requestQueues = new Map<string, LeaseRequestEntry[]>();

function queueOf(projectId: string): LeaseRequestEntry[] {
  let entries = requestQueues.get(projectId);
  if (entries === undefined) {
    entries = [];
    requestQueues.set(projectId, entries);
  }
  return entries;
}

function removeFromQueue(projectId: string, userId: string): boolean {
  const entries = requestQueues.get(projectId);
  if (entries === undefined) return false;
  const index = entries.findIndex((entry) => entry.userId === userId);
  if (index === -1) return false;
  entries.splice(index, 1);
  if (entries.length === 0) requestQueues.delete(projectId);
  return true;
}

async function assertProjectInWorkspace(
  db: StudioDb,
  workspaceId: WorkspaceId,
  projectId: string,
): Promise<void> {
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
    .limit(1);
  if (rows.length === 0) throw DbError.notFound("project");
}

async function currentLease(db: StudioDb, projectId: string): Promise<ProjectLease | null> {
  const [row] = await db
    .select()
    .from(projectLeases)
    .where(eq(projectLeases.projectId, projectId))
    .limit(1);
  return row ?? null;
}

export function createLeasesRepo(db: StudioDb): LeasesRepo {
  return {
    async acquire(workspaceId, projectId, input) {
      requireNonEmpty(input.userId, "userId");
      requireNonEmpty(input.sessionId, "sessionId");
      const ttl = input.ttlMs ?? DEFAULT_LEASE_TTL_MS;
      if (!Number.isInteger(ttl) || ttl < 1000) {
        throw DbError.validation("ttlMs must be an integer ≥ 1000");
      }
      await assertProjectInWorkspace(db, workspaceId, projectId);

      const existing = await currentLease(db, projectId);
      const decision: LeaseDecision = leaseDecision(
        existing ? { userId: existing.userId, expiresAt: existing.expiresAt } : null,
        input.userId,
        new Date(),
      );
      if (decision.action === "refuse") {
        return {
          acquired: false,
          holderId: decision.state.userId,
          expiresAt: decision.state.expiresAt,
        };
      }

      const expiresAt = new Date(Date.now() + ttl);
      const upserted = await db
        .insert(projectLeases)
        .values({ projectId, userId: input.userId, sessionId: input.sessionId, expiresAt })
        .onConflictDoUpdate({
          target: projectLeases.projectId,
          set: { userId: input.userId, sessionId: input.sessionId, expiresAt },
          // only steal an expired lease (or refresh our own)
          setWhere: or(
            lt(projectLeases.expiresAt, new Date()),
            eq(projectLeases.userId, input.userId),
          ),
        })
        .returning();

      const row = upserted.at(0);
      if (row && row.userId === input.userId) {
        // §M7 task 3: winning the lease ends the winner's own wait — their
        // queue entry (if any) is consumed so the next election skips them.
        removeFromQueue(projectId, input.userId);
        return { acquired: true, holderId: row.userId, expiresAt: row.expiresAt };
      }

      // lost the race — report the actual holder
      const winner = await currentLease(db, projectId);
      return {
        acquired: false,
        holderId: winner?.userId ?? input.userId,
        expiresAt: winner?.expiresAt ?? expiresAt,
      };
    },

    async renew(workspaceId, projectId, input) {
      await assertProjectInWorkspace(db, workspaceId, projectId);
      const ttl = input.ttlMs ?? DEFAULT_LEASE_TTL_MS;
      const expiresAt = new Date(Date.now() + ttl);
      const renewed = await db
        .update(projectLeases)
        .set({ expiresAt, sessionId: input.sessionId })
        .where(and(eq(projectLeases.projectId, projectId), eq(projectLeases.userId, input.userId)))
        .returning();
      const row = renewed.at(0);
      if (row && isLeaseHeld({ userId: row.userId, expiresAt: row.expiresAt }, new Date())) {
        return { renewed: true, holderId: row.userId, expiresAt: row.expiresAt };
      }
      const existing = await currentLease(db, projectId);
      return {
        renewed: false,
        holderId: existing?.userId ?? input.userId,
        expiresAt: existing?.expiresAt ?? null,
      };
    },

    async release(workspaceId, projectId, input) {
      await assertProjectInWorkspace(db, workspaceId, projectId);
      const released = await db
        .delete(projectLeases)
        .where(
          input.force
            ? eq(projectLeases.projectId, projectId)
            : and(eq(projectLeases.projectId, projectId), eq(projectLeases.userId, input.userId)),
        )
        .returning();
      return { released: released.length > 0 };
    },

    async get(workspaceId, projectId) {
      await assertProjectInWorkspace(db, workspaceId, projectId);
      const lease = await currentLease(db, projectId);
      if (!lease) return null;
      return {
        lease,
        isHeld: isLeaseHeld({ userId: lease.userId, expiresAt: lease.expiresAt }, new Date()),
      };
    },

    async requestQueue(workspaceId, projectId) {
      await assertProjectInWorkspace(db, workspaceId, projectId);
      return [...queueOf(projectId)];
    },

    async queueRequest(workspaceId, input) {
      requireNonEmpty(input.projectId, "projectId");
      requireNonEmpty(input.userId, "userId");
      await assertProjectInWorkspace(db, workspaceId, input.projectId);
      const decision = queueRequestDecision(queueOf(input.projectId), input.userId, new Date());
      if (decision.action === "full") {
        throw DbError.quotaExceeded(
          `The edit queue for this project is full (${decision.cap} people are already waiting).`,
          { cap: decision.cap },
        );
      }
      if (decision.action === "queued") {
        queueOf(input.projectId).push(decision.entry);
      }
      return {
        queued: true,
        position: decision.position,
        queueLength: decision.queueLength,
        queuedAt: decision.entry.queuedAt,
        duplicate: decision.action === "duplicate",
      };
    },

    async cancelRequest(workspaceId, input) {
      requireNonEmpty(input.projectId, "projectId");
      requireNonEmpty(input.userId, "userId");
      await assertProjectInWorkspace(db, workspaceId, input.projectId);
      return { cancelled: removeFromQueue(input.projectId, input.userId) };
    },

    async electNextHolder(workspaceId, projectId) {
      await assertProjectInWorkspace(db, workspaceId, projectId);
      const entries = queueOf(projectId);
      const next = nextHolderOf(entries);
      if (next !== null) {
        entries.splice(0, 1);
        if (entries.length === 0) requestQueues.delete(projectId);
      }
      return next;
    },
  };
}
