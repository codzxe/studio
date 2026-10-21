import { and, desc, eq, isNotNull, isNull, lt, or } from "drizzle-orm";

import { type Page, clampLimit, decodeCursor, encodeCursor } from "../cursor.js";
import type { StudioDb } from "../db.js";
import { DbError } from "../errors-lite.js";
import { createId } from "../ids.js";
import { type Comment, comments, projects } from "../schema.js";
import { type WorkspaceId, requireNonEmpty } from "./shared.js";

/**
 * Comments repository — review notes anchored to project/comp/layer/time (§11).
 * Resolve/unresolve only touches `resolved_at`; bodies are never edited.
 * Every read is tenant-scoped through the project join (§12.1).
 */
export interface CommentCreateInput {
  readonly projectId: string;
  readonly compId: string;
  readonly layerId?: string | null;
  readonly timeTicks?: number | null;
  readonly body: string;
  readonly authorId: string;
}

export interface CommentListOptions {
  readonly resolved?: boolean;
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface CommentsRepo {
  create(workspaceId: WorkspaceId, input: CommentCreateInput): Promise<Comment>;
  list(
    workspaceId: WorkspaceId,
    projectId: string,
    options?: CommentListOptions,
  ): Promise<Page<Comment>>;
  get(workspaceId: WorkspaceId, commentId: string): Promise<Comment>;
  /** Idempotent: resolving an already-resolved comment returns it unchanged. */
  resolve(workspaceId: WorkspaceId, commentId: string): Promise<Comment>;
  unresolve(workspaceId: WorkspaceId, commentId: string): Promise<Comment>;
}

export function createCommentsRepo(db: StudioDb): CommentsRepo {
  return {
    async create(workspaceId, input) {
      const body = requireNonEmpty(input.body, "body");
      const compId = requireNonEmpty(input.compId, "compId");
      requireNonEmpty(input.authorId, "authorId");

      const [project] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.id, input.projectId),
            eq(projects.workspaceId, workspaceId),
            isNull(projects.deletedAt),
          ),
        )
        .limit(1);
      if (!project) throw DbError.notFound("project");

      const [comment] = await db
        .insert(comments)
        .values({
          id: createId("cmt"),
          projectId: project.id,
          compId,
          layerId: input.layerId ?? null,
          timeTicks: input.timeTicks ?? null,
          body,
          authorId: input.authorId,
        })
        .returning();
      if (!comment) throw DbError.conflict("Could not create comment");
      return comment;
    },

    async list(workspaceId, projectId, options) {
      const limit = clampLimit(options?.limit);
      const cursor = decodeCursor(options?.cursor ?? null);
      const rows = await db
        .select({ comment: comments })
        .from(comments)
        .innerJoin(projects, eq(comments.projectId, projects.id))
        .where(
          and(
            eq(comments.projectId, projectId),
            eq(projects.workspaceId, workspaceId),
            options?.resolved === undefined
              ? undefined
              : options.resolved
                ? isNotNull(comments.resolvedAt)
                : isNull(comments.resolvedAt),
            cursor
              ? or(
                  lt(comments.createdAt, new Date(cursor.t)),
                  and(eq(comments.createdAt, new Date(cursor.t)), lt(comments.id, cursor.id)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(comments.createdAt), desc(comments.id))
        .limit(limit + 1);

      const items = rows.map((row) => row.comment).slice(0, limit);
      const last = items.at(-1);
      const hasMore = rows.length > limit;
      return {
        items,
        nextCursor:
          hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null,
      };
    },

    async get(workspaceId, commentId) {
      const [row] = await db
        .select({ comment: comments })
        .from(comments)
        .innerJoin(projects, eq(comments.projectId, projects.id))
        .where(and(eq(comments.id, commentId), eq(projects.workspaceId, workspaceId)))
        .limit(1);
      if (!row) throw DbError.notFound("comment");
      return row.comment;
    },

    async resolve(workspaceId, commentId) {
      const current = await this.get(workspaceId, commentId);
      if (current.resolvedAt) return current;
      const [updated] = await db
        .update(comments)
        .set({ resolvedAt: new Date() })
        .where(and(eq(comments.id, current.id), isNull(comments.resolvedAt)))
        .returning();
      return updated ?? current;
    },

    async unresolve(workspaceId, commentId) {
      const current = await this.get(workspaceId, commentId);
      if (!current.resolvedAt) return current;
      const [updated] = await db
        .update(comments)
        .set({ resolvedAt: null })
        .where(and(eq(comments.id, current.id), isNotNull(comments.resolvedAt)))
        .returning();
      return updated ?? current;
    },
  };
}
