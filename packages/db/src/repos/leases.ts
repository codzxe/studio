import { and, eq, lt, or } from "drizzle-orm";

import type { StudioDb } from "../db.js";
import { DbError } from "../errors-lite.js";
import {
  DEFAULT_LEASE_TTL_MS,
  type LeaseDecision,
  isLeaseHeld,
  leaseDecision,
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
  };
}
