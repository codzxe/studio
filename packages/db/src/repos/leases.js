import { and, eq, lt, or } from "drizzle-orm";
import { DbError } from "../errors-lite.js";
import { DEFAULT_LEASE_TTL_MS, LEASE_REQUEST_QUEUE_CAP, isLeaseHeld, leaseDecision, nextHolderOf, queueRequestDecision, } from "../lease-logic.js";
import { projectLeases, projects } from "../schema.js";
import { requireNonEmpty } from "./shared.js";
/**
 * Edit-request queue, projectId → entries oldest-first (module-level; see the
 * header's single-instance note). Copies in/out so callers can never mutate
 * the live ordering.
 */
const requestQueues = new Map();
function queueOf(projectId) {
    let entries = requestQueues.get(projectId);
    if (entries === undefined) {
        entries = [];
        requestQueues.set(projectId, entries);
    }
    return entries;
}
function removeFromQueue(projectId, userId) {
    const entries = requestQueues.get(projectId);
    if (entries === undefined)
        return false;
    const index = entries.findIndex((entry) => entry.userId === userId);
    if (index === -1)
        return false;
    entries.splice(index, 1);
    if (entries.length === 0)
        requestQueues.delete(projectId);
    return true;
}
async function assertProjectInWorkspace(db, workspaceId, projectId) {
    const rows = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
        .limit(1);
    if (rows.length === 0)
        throw DbError.notFound("project");
}
async function currentLease(db, projectId) {
    const [row] = await db
        .select()
        .from(projectLeases)
        .where(eq(projectLeases.projectId, projectId))
        .limit(1);
    return row ?? null;
}
export function createLeasesRepo(db) {
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
            const decision = leaseDecision(existing ? { userId: existing.userId, expiresAt: existing.expiresAt } : null, input.userId, new Date());
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
                setWhere: or(lt(projectLeases.expiresAt, new Date()), eq(projectLeases.userId, input.userId)),
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
                .where(input.force
                ? eq(projectLeases.projectId, projectId)
                : and(eq(projectLeases.projectId, projectId), eq(projectLeases.userId, input.userId)))
                .returning();
            return { released: released.length > 0 };
        },
        async get(workspaceId, projectId) {
            await assertProjectInWorkspace(db, workspaceId, projectId);
            const lease = await currentLease(db, projectId);
            if (!lease)
                return null;
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
                throw DbError.quotaExceeded(`The edit queue for this project is full (${decision.cap} people are already waiting).`, { cap: decision.cap });
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
                if (entries.length === 0)
                    requestQueues.delete(projectId);
            }
            return next;
        },
    };
}
//# sourceMappingURL=leases.js.map