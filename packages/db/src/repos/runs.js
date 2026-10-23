import { and, asc, desc, eq, isNotNull, isNull, lt, ne, or } from "drizzle-orm";
import { clampLimit, decodeCursor, encodeCursor } from "../cursor.js";
import { DbError } from "../errors-lite.js";
import { createId } from "../ids.js";
import { agentRuns, agentSteps, agentThreads, projectVersions, projects, user, } from "../schema.js";
import { assertRunTransition, isTerminalRunStatus } from "../statuses.js";
import { isUniqueViolation, requireNonEmpty } from "./shared.js";
const SHA256_HEX = /^[a-f0-9]{64}$/;
function requireBatchSha256(value, field) {
    const sha = requireNonEmpty(value, field);
    if (!SHA256_HEX.test(sha)) {
        throw DbError.validation(`${field} must be exactly 64 lowercase hex characters`);
    }
    return sha;
}
/** Pure projection of the apply/undo columns onto the plan lifecycle. */
export function toPlanState(run) {
    const status = run.appliedAt === null ? "proposed" : run.undoneAt === null ? "applied" : "undone";
    return {
        status,
        appliedAt: run.appliedAt,
        appliedBatchSha256: run.appliedBatchSha256,
        appliedVersionId: run.appliedVersionId,
        baseVersionId: run.baseVersionId,
        undoneAt: run.undoneAt,
    };
}
export function createRunsRepo(db) {
    async function requireRun(workspaceId, runId) {
        const [row] = await db
            .select({ run: agentRuns })
            .from(agentRuns)
            .innerJoin(projects, eq(agentRuns.projectId, projects.id))
            .where(and(eq(agentRuns.id, runId), eq(projects.workspaceId, workspaceId)))
            .limit(1);
        if (!row)
            throw DbError.notFound("run");
        return row.run;
    }
    /** A version id that must exist AND belong to the run's project (§9.3 scope). */
    async function requireProjectVersion(projectId, versionId, what) {
        const [row] = await db
            .select({ id: projectVersions.id })
            .from(projectVersions)
            .where(and(eq(projectVersions.id, versionId), eq(projectVersions.projectId, projectId)))
            .limit(1);
        if (!row)
            throw DbError.notFound(what);
    }
    return {
        async create(workspaceId, input) {
            requireNonEmpty(input.threadId, "threadId");
            requireNonEmpty(input.projectId, "projectId");
            const model = requireNonEmpty(input.model, "model");
            // tenancy: thread must belong to a project in this workspace
            const [thread] = await db
                .select({ id: agentThreads.id })
                .from(agentThreads)
                .innerJoin(projects, eq(agentThreads.projectId, projects.id))
                .where(and(eq(agentThreads.id, input.threadId), eq(projects.workspaceId, workspaceId)))
                .limit(1);
            if (!thread)
                throw DbError.notFound("thread");
            const [project] = await db
                .select({ id: projects.id })
                .from(projects)
                .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, workspaceId)))
                .limit(1);
            if (!project)
                throw DbError.notFound("project");
            const [run] = await db
                .insert(agentRuns)
                .values({
                id: createId("run"),
                threadId: input.threadId,
                projectId: input.projectId,
                model,
                status: "queued",
                planJson: input.planJson,
                reservedCredits: input.reservedCredits ?? 0,
                committedCredits: 0,
                baseVersionId: input.baseVersionId ?? null,
            })
                .returning();
            if (!run)
                throw DbError.conflict("Could not create run");
            return run;
        },
        async update(workspaceId, runId, input) {
            const run = await requireRun(workspaceId, runId);
            const values = {};
            if (input.status !== undefined && input.status !== run.status) {
                assertRunTransition(run.status, input.status);
                values.status = input.status;
                if (isTerminalRunStatus(input.status))
                    values.completedAt = new Date();
            }
            if (input.planJson !== undefined)
                values.planJson = input.planJson;
            if (input.reservedCredits !== undefined)
                values.reservedCredits = input.reservedCredits;
            if (input.committedCredits !== undefined)
                values.committedCredits = input.committedCredits;
            if (input.resultVersionId !== undefined)
                values.resultVersionId = input.resultVersionId;
            if (input.errorCode !== undefined)
                values.errorCode = input.errorCode;
            if (Object.keys(values).length === 0)
                return run;
            const [updated] = await db
                .update(agentRuns)
                .set(values)
                .where(eq(agentRuns.id, run.id))
                .returning();
            if (!updated)
                throw DbError.notFound("run");
            return updated;
        },
        async addStep(workspaceId, input) {
            requireNonEmpty(input.runId, "runId");
            const tool = requireNonEmpty(input.tool, "tool");
            if (!Number.isInteger(input.seq) || input.seq < 0) {
                throw DbError.validation("seq must be a non-negative integer");
            }
            const run = await requireRun(workspaceId, input.runId);
            try {
                const [step] = await db
                    .insert(agentSteps)
                    .values({
                    id: createId("stp"),
                    runId: run.id,
                    seq: input.seq,
                    tool,
                    argsJson: input.argsJson,
                    resultJson: input.resultJson,
                    commandBatchJson: input.commandBatchJson,
                    status: input.status ?? "pending",
                    durationMs: input.durationMs ?? null,
                })
                    .returning();
                if (!step)
                    throw DbError.conflict("Could not insert step");
                return step;
            }
            catch (error) {
                // UNIQUE(run_id, seq) — 23505 arrives WRAPPED in drizzle's `.cause`
                // chain, so the check must walk it (shared.ts isUniqueViolation).
                if (isUniqueViolation(error)) {
                    throw DbError.conflict(`Step ${input.seq} already exists for this run`);
                }
                throw error;
            }
        },
        async get(workspaceId, runId) {
            const run = await requireRun(workspaceId, runId);
            const steps = await db
                .select()
                .from(agentSteps)
                .where(eq(agentSteps.runId, run.id))
                .orderBy(asc(agentSteps.seq));
            return { run, steps };
        },
        async listByThread(workspaceId, threadId, options) {
            const limit = clampLimit(options?.limit);
            const cursor = decodeCursor(options?.cursor ?? null);
            const rows = await db
                .select({ run: agentRuns })
                .from(agentRuns)
                .innerJoin(projects, eq(agentRuns.projectId, projects.id))
                .where(and(eq(agentRuns.threadId, threadId), eq(projects.workspaceId, workspaceId), cursor
                ? or(lt(agentRuns.createdAt, new Date(cursor.t)), and(eq(agentRuns.createdAt, new Date(cursor.t)), lt(agentRuns.id, cursor.id)))
                : undefined))
                .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
                .limit(limit + 1);
            const items = rows.map((row) => row.run).slice(0, limit);
            const last = items.at(-1);
            const hasMore = rows.length > limit;
            return {
                items,
                nextCursor: hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null,
            };
        },
        async recordApplied(workspaceId, input) {
            const runId = requireNonEmpty(input.runId, "runId");
            const versionId = requireNonEmpty(input.versionId, "versionId");
            const batchSha256 = requireBatchSha256(input.batchSha256, "batchSha256");
            // tenant filter FIRST (law #3): cross-tenant run ids read as 404.
            const run = await requireRun(workspaceId, runId);
            if (run.status === "cancelled") {
                throw DbError.conflict("A cancelled run cannot be applied");
            }
            if (run.appliedAt !== null) {
                throw DbError.conflict("This run was already applied");
            }
            // The applied version must be a version of THIS run's project.
            await requireProjectVersion(run.projectId, versionId, "version");
            // Base version: verify/backfill, never silently rewrite (§9.3).
            let baseVersionId;
            if (input.baseVersionId !== undefined && input.baseVersionId !== null) {
                const claimed = requireNonEmpty(input.baseVersionId, "baseVersionId");
                await requireProjectVersion(run.projectId, claimed, "base version");
                if (run.baseVersionId !== null && run.baseVersionId !== claimed) {
                    throw DbError.versionConflict({
                        expectedVersionId: run.baseVersionId,
                        currentVersionId: claimed,
                    });
                }
                baseVersionId = claimed;
            }
            const values = {
                appliedAt: new Date(),
                appliedBatchSha256: batchSha256,
                appliedVersionId: versionId,
                ...(baseVersionId !== undefined ? { baseVersionId } : {}),
                // First applied version doubles as the run's result version; never
                // overwrite an already-recorded result (immutability at the column).
                ...(run.resultVersionId === null ? { resultVersionId: versionId } : {}),
            };
            // Guarded update: concurrent applies/late cancels lose the race here.
            const [updated] = await db
                .update(agentRuns)
                .set(values)
                .where(and(eq(agentRuns.id, run.id), isNull(agentRuns.appliedAt), ne(agentRuns.status, "cancelled")))
                .returning();
            if (updated)
                return updated;
            const [current] = await db.select().from(agentRuns).where(eq(agentRuns.id, run.id)).limit(1);
            if (current?.appliedAt != null) {
                throw DbError.conflict("This run was already applied");
            }
            throw DbError.conflict("A cancelled run cannot be applied");
        },
        async recordUndone(workspaceId, input) {
            const runId = requireNonEmpty(input.runId, "runId");
            const userId = requireNonEmpty(input.userId, "userId");
            const run = await requireRun(workspaceId, runId);
            if (run.appliedAt === null) {
                throw DbError.conflict("This run has not been applied yet");
            }
            if (run.undoneAt !== null) {
                throw DbError.conflict("This run was already undone");
            }
            const [actor] = await db
                .select({ id: user.id })
                .from(user)
                .where(eq(user.id, userId))
                .limit(1);
            if (!actor)
                throw DbError.notFound("user");
            const [updated] = await db
                .update(agentRuns)
                .set({ undoneAt: new Date(), undoneBy: userId })
                .where(and(eq(agentRuns.id, run.id), isNotNull(agentRuns.appliedAt), isNull(agentRuns.undoneAt)))
                .returning();
            if (updated)
                return updated;
            const [current] = await db.select().from(agentRuns).where(eq(agentRuns.id, run.id)).limit(1);
            if (current && current.appliedAt === null) {
                throw DbError.conflict("This run has not been applied yet");
            }
            throw DbError.conflict("This run was already undone");
        },
        async getPlanState(workspaceId, runId) {
            const run = await requireRun(workspaceId, requireNonEmpty(runId, "runId"));
            return toPlanState(run);
        },
    };
}
//# sourceMappingURL=runs.js.map