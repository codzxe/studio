import { and, desc, eq, lt, or } from "drizzle-orm";

import { type Page, clampLimit, decodeCursor, encodeCursor } from "../cursor.js";
import type { Executor, StudioDb } from "../db.js";
import { DbError } from "../errors-lite.js";
import { createId } from "../ids.js";
import {
  type AgentMessage,
  type AgentThread,
} from "../schema.js";
import { tablesFor } from "../tables.js";
import { type WorkspaceId, requireNonEmpty } from "./shared.js";

/** Threads repository — chat conversations attached to a project (§3.1). */
export type ChatRole = "user" | "assistant" | "system" | "tool";

export interface ThreadCreateInput {
  readonly projectId: string;
  readonly createdBy: string;
  readonly title?: string;
}

export interface MessageInput {
  readonly threadId: string;
  readonly role: ChatRole;
  readonly contentJson: unknown;
  readonly runId?: string | null;
}

export interface ListOptions {
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface ThreadsRepo {
  create(workspaceId: WorkspaceId, input: ThreadCreateInput): Promise<AgentThread>;
  listByProject(
    workspaceId: WorkspaceId,
    projectId: string,
    options?: ListOptions,
  ): Promise<Page<AgentThread>>;
  get(workspaceId: WorkspaceId, threadId: string): Promise<AgentThread>;
  addMessage(workspaceId: WorkspaceId, input: MessageInput): Promise<AgentMessage>;
  listMessages(
    workspaceId: WorkspaceId,
    threadId: string,
    options?: ListOptions,
  ): Promise<Page<AgentMessage>>;
}

export function createThreadsRepo(db: StudioDb): ThreadsRepo {
  // Dialect-aware tables (W3-A, tables.ts seam) — see createProjectsRepo.
  const { agentMessages, agentThreads, projects } = tablesFor(db);
  async function requireThread(
    exec: Executor,
    workspaceId: WorkspaceId,
    threadId: string,
  ): Promise<AgentThread> {
    const [thread] = await exec
      .select({ thread: agentThreads })
      .from(agentThreads)
      .innerJoin(projects, eq(agentThreads.projectId, projects.id))
      .where(and(eq(agentThreads.id, threadId), eq(projects.workspaceId, workspaceId)))
      .limit(1);
    if (!thread) throw DbError.notFound("thread");
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
      if (rows.length === 0) throw DbError.notFound("project");

      const [thread] = await db
        .insert(agentThreads)
        .values({
          id: createId("thr"),
          projectId: input.projectId,
          createdBy: input.createdBy,
          title: input.title,
        })
        .returning();
      if (!thread) throw DbError.conflict("Could not create thread");
      return thread;
    },

    async listByProject(workspaceId, projectId, options) {
      const limit = clampLimit(options?.limit);
      const cursor = decodeCursor(options?.cursor ?? null);
      const rows = await db
        .select({ thread: agentThreads })
        .from(agentThreads)
        .innerJoin(projects, eq(agentThreads.projectId, projects.id))
        .where(
          and(
            eq(agentThreads.projectId, projectId),
            eq(projects.workspaceId, workspaceId),
            cursor
              ? or(
                  lt(agentThreads.updatedAt, new Date(cursor.t)),
                  and(
                    eq(agentThreads.updatedAt, new Date(cursor.t)),
                    lt(agentThreads.id, cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(agentThreads.updatedAt), desc(agentThreads.id))
        .limit(limit + 1);

      const items = rows.map((row) => row.thread).slice(0, limit);
      const last = items.at(-1);
      const hasMore = rows.length > limit;
      return {
        items,
        nextCursor:
          hasMore && last ? encodeCursor({ t: last.updatedAt.toISOString(), id: last.id }) : null,
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
        if (!message) throw DbError.conflict("Could not insert message");
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
        .where(
          and(
            eq(agentMessages.threadId, threadId),
            cursor
              ? or(
                  lt(agentMessages.createdAt, new Date(cursor.t)),
                  and(
                    eq(agentMessages.createdAt, new Date(cursor.t)),
                    lt(agentMessages.id, cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(agentMessages.createdAt), desc(agentMessages.id))
        .limit(limit + 1);

      const items = rows.slice(0, limit);
      const last = items.at(-1);
      const hasMore = rows.length > limit;
      return {
        items,
        nextCursor:
          hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null,
      };
    },
  };
}
