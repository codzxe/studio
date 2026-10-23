import { and, desc, eq, lt, or } from "drizzle-orm";
import { clampLimit, decodeCursor, encodeCursor } from "../cursor.js";
import { DbError } from "../errors-lite.js";
import { createId } from "../ids.js";
import { agentMessages, agentThreads, projects, } from "../schema.js";
import { requireNonEmpty } from "./shared.js";
export function createThreadsRepo(db) {
    async function requireThread(exec, workspaceId, threadId) {
        const [thread] = await exec
            .select({ thread: agentThreads })
            .from(agentThreads)
            .innerJoin(projects, eq(agentThreads.projectId, projects.id))
            .where(and(eq(agentThreads.id, threadId), eq(projects.workspaceId, workspaceId)))
            .limit(1);
        if (!thread)
            throw DbError.notFound("thread");
        return thread.thread;
    }
    return {
        async create(workspaceId, input) {
            requireNonEmpty(input.projectId, "projectId");
            requireNonEmpty(input.createdBy, "createdBy");
            const rows = await db
                .select({ id: projects.id })
                .from(projects)
                .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, workspaceId)))
                .limit(1);
            if (rows.length === 0)
                throw DbError.notFound("project");
            const [thread] = await db
                .insert(agentThreads)
                .values({
                id: createId("thr"),
                projectId: input.projectId,
                createdBy: input.createdBy,
                title: input.title,
            })
                .returning();
            if (!thread)
                throw DbError.conflict("Could not create thread");
            return thread;
        },
        async listByProject(workspaceId, projectId, options) {
            const limit = clampLimit(options?.limit);
            const cursor = decodeCursor(options?.cursor ?? null);
            const rows = await db
                .select({ thread: agentThreads })
                .from(agentThreads)
                .innerJoin(projects, eq(agentThreads.projectId, projects.id))
                .where(and(eq(agentThreads.projectId, projectId), eq(projects.workspaceId, workspaceId), cursor
                ? or(lt(agentThreads.updatedAt, new Date(cursor.t)), and(eq(agentThreads.updatedAt, new Date(cursor.t)), lt(agentThreads.id, cursor.id)))
                : undefined))
                .orderBy(desc(agentThreads.updatedAt), desc(agentThreads.id))
                .limit(limit + 1);
            const items = rows.map((row) => row.thread).slice(0, limit);
            const last = items.at(-1);
            const hasMore = rows.length > limit;
            return {
                items,
                nextCursor: hasMore && last ? encodeCursor({ t: last.updatedAt.toISOString(), id: last.id }) : null,
            };
        },
        async get(workspaceId, threadId) {
            return requireThread(db, workspaceId, threadId);
        },
        async addMessage(workspaceId, input) {
            requireNonEmpty(input.threadId, "threadId");
            if (!["user", "assistant", "system", "tool"].includes(input.role)) {
                throw DbError.validation("Invalid message role");
            }
            return db.transaction(async (tx) => {
                const thread = await requireThread(tx, workspaceId, input.threadId);
                const [message] = await tx
                    .insert(agentMessages)
                    .values({
                    id: createId("msg"),
                    threadId: thread.id,
                    role: input.role,
                    contentJson: input.contentJson,
                    runId: input.runId ?? null,
                })
                    .returning();
                if (!message)
                    throw DbError.conflict("Could not insert message");
                await tx
                    .update(agentThreads)
                    .set({ updatedAt: new Date() })
                    .where(eq(agentThreads.id, thread.id));
                return message;
            });
        },
        async listMessages(workspaceId, threadId, options) {
            await requireThread(db, workspaceId, threadId);
            const limit = clampLimit(options?.limit);
            const cursor = decodeCursor(options?.cursor ?? null);
            const rows = await db
                .select()
                .from(agentMessages)
                .where(and(eq(agentMessages.threadId, threadId), cursor
                ? or(lt(agentMessages.createdAt, new Date(cursor.t)), and(eq(agentMessages.createdAt, new Date(cursor.t)), lt(agentMessages.id, cursor.id)))
                : undefined))
                .orderBy(desc(agentMessages.createdAt), desc(agentMessages.id))
                .limit(limit + 1);
            const items = rows.slice(0, limit);
            const last = items.at(-1);
            const hasMore = rows.length > limit;
            return {
                items,
                nextCursor: hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null,
            };
        },
    };
}
//# sourceMappingURL=threads.js.map