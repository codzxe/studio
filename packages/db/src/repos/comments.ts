import { and, desc, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";

import { type Page, clampLimit, decodeCursor, encodeCursor } from "../cursor.js";
import type { StudioDb } from "../db.js";
import { DbError } from "../errors-lite.js";
import { createId } from "../ids.js";
import type { Comment } from "../schema.js";
import { tablesFor } from "../tables.js";
import { type WorkspaceId, requireNonEmpty } from "./shared.js";

/**
 * Comments repository — review notes anchored to project/comp/layer/time (§11).
 * Replies thread through `parent_id` (depth ≤ 3); resolve/unresolve only
 * touches `resolved_at`/`resolved_by`; bodies are never edited. Every read is
 * tenant-scoped through the project join (§12.1).
 */

/** Max thread depth (§M7 task 1): root (1) → reply (2) → reply-to-reply (3). */
export const MAX_COMMENT_DEPTH = 3;

/** Guest display-name bound (mirrors the `guest_name` column width). */
const GUEST_NAME_MAX = 80;

/** Guest email bound (mirrors the `guest_email` column width). */
const GUEST_EMAIL_MAX = 200;

/** Basic email shape (hostile-input bound, not a deliverability claim). */
const GUEST_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface CommentCreateInput {
  readonly projectId: string;
  readonly compId: string;
  readonly layerId?: string | null;
  readonly timeTicks?: number | null;
  readonly body: string;
  readonly authorId: string;
}

/**
 * `createReply` input (pinned): the reply INHERITS the parent's
 * project/comp/layer/time anchor, so only the text + author ride the input.
 */
export interface CommentReplyInput {
  readonly commentId: string;
  readonly body: string;
  readonly authorId: string;
}

/**
 * Guest (share-link) comment input (pinned). The share token is verified and
 * resolved UPSTREAM (M7-E's share routes) — the repo only records which token
 * produced the row plus the guest's name/email; `authorId` lands as null.
 */
export interface GuestCommentCreateInput {
  readonly shareTokenId: string;
  readonly projectId: string;
  readonly compId: string;
  readonly layerId?: string | null;
  readonly timeTicks?: number | null;
  readonly body: string;
  readonly guestName: string;
  readonly guestEmail: string;
}

/** Threaded list options — D-15: `compId` is a SERVER-side filter. */
export interface ThreadedCommentListOptions {
  readonly compId?: string;
  readonly resolved?: boolean;
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface CommentListOptions {
  readonly resolved?: boolean;
  readonly limit?: number;
  readonly cursor?: string | null;
}

/** `resolve` input (pinned): who resolved it — recorded on `resolved_by`. */
export interface ResolveCommentInput {
  readonly commentId: string;
  readonly resolvedBy: string;
}

export interface CommentsRepo {
  create(workspaceId: WorkspaceId, input: CommentCreateInput): Promise<Comment>;
  /** Reply to a comment (parentId linkage; server-enforced depth ≤ 3). */
  createReply(workspaceId: WorkspaceId, input: CommentReplyInput): Promise<Comment>;
  /** Guest comment via a verified share token (authorId null; name/email recorded). */
  createGuest(workspaceId: WorkspaceId, input: GuestCommentCreateInput): Promise<Comment>;
  /**
   * Flat threaded list (parentCommentId on rows for client-side tree
   * building). D-15: `compId` is a server-side query filter — replies inherit
   * the parent's comp anchor, so a filter never splits a thread.
   */
  listThreaded(
    workspaceId: WorkspaceId,
    projectId: string,
    options?: ThreadedCommentListOptions,
  ): Promise<Page<Comment>>;
  list(
    workspaceId: WorkspaceId,
    projectId: string,
    options?: CommentListOptions,
  ): Promise<Page<Comment>>;
  get(workspaceId: WorkspaceId, commentId: string): Promise<Comment>;
  /**
   * Idempotent: resolving an already-resolved comment returns it unchanged —
   * the FIRST resolver stays recorded on `resolved_by`.
   */
  resolve(workspaceId: WorkspaceId, input: ResolveCommentInput): Promise<Comment>;
  unresolve(workspaceId: WorkspaceId, commentId: string): Promise<Comment>;
}

function requireGuestName(raw: string): string {
  const name = requireNonEmpty(raw, "guestName");
  if (name.length > GUEST_NAME_MAX) {
    throw DbError.validation(`guestName must be at most ${GUEST_NAME_MAX} characters`);
  }
  return name;
}

function requireGuestEmail(raw: string): string {
  const email = requireNonEmpty(raw, "guestEmail").toLowerCase();
  if (email.length > GUEST_EMAIL_MAX || !GUEST_EMAIL_PATTERN.test(email)) {
    throw DbError.validation("guestEmail must be a valid email address");
  }
  return email;
}

export function createCommentsRepo(db: StudioDb): CommentsRepo {
  // Dialect-aware tables (W3-A, tables.ts seam) — see createProjectsRepo.
  const { comments, projects } = tablesFor(db);
  // Thread-aware resolved filter (2026-10-24, first-live m7-collab finding):
  // a thread's resolved state is its ROOT's `resolvedAt` — the panel
  // root-gates its Resolve control, so only roots ever flip — and a filter
  // must never SPLIT a thread on fresh fetches (the pre-fix row-level
  // `isNotNull(resolvedAt)` returned a resolved root without its replies
  // under ?resolved=true, and orphaned unresolved replies under
  // ?resolved=false).
  //
  // The root walk lives in the WHERE clause as correlated subqueries over
  // aliased inner copies of the SAME table — deliberately NOT drizzle
  // self-joins: joining an aliased table collapses drizzle's builder
  // generics on the dual-dialect table union (tablesFor returns pg OR
  // sqlite tables), typing the result rows `never`. The raw inner
  // identifiers are pinned safe by the tables.ts seam contract (identical
  // table AND column names across both dialect schemas). Depth ≤ 3 bounds
  // the walk at two hops; a broken parent chain (data corruption) reads
  // NULL → unresolved, and the client tree is orphan-safe anyway.
  const threadRootResolvedAt = sql<Date | null>`
    CASE
      WHEN ${comments.parentId} IS NULL THEN ${comments.resolvedAt}
      WHEN (
        SELECT parent.parent_id IS NULL FROM ${comments} parent
        WHERE parent.id = ${comments.parentId}
      ) THEN (
        SELECT parent.resolved_at FROM ${comments} parent
        WHERE parent.id = ${comments.parentId}
      )
      ELSE (
        SELECT grandparent.resolved_at FROM ${comments} grandparent
        WHERE grandparent.id = (
          SELECT parent.parent_id FROM ${comments} parent
          WHERE parent.id = ${comments.parentId}
        )
      )
    END
  `;
  /** Thread-aware `resolved` condition for the flat list queries. */
  const threadResolvedCondition = (resolved: boolean) =>
    resolved ? sql`${threadRootResolvedAt} IS NOT NULL` : sql`${threadRootResolvedAt} IS NULL`;
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

    async createReply(workspaceId, input) {
      const body = requireNonEmpty(input.body, "body");
      requireNonEmpty(input.commentId, "commentId");
      requireNonEmpty(input.authorId, "authorId");

      const parent = await this.get(workspaceId, input.commentId);

      // Depth cap (§M7 task 1): the parent's own depth, walked up the (≤ 3
      // hop) ancestor chain. Replying under a depth-3 comment is refused.
      let parentDepth = 1;
      let cursor: Comment = parent;
      while (cursor.parentId !== null) {
        parentDepth += 1;
        if (parentDepth >= MAX_COMMENT_DEPTH) break;
        cursor = await this.get(workspaceId, cursor.parentId);
      }
      if (parentDepth >= MAX_COMMENT_DEPTH) {
        throw DbError.validation(`Comment threads are limited to ${MAX_COMMENT_DEPTH} levels`);
      }

      // The reply inherits the parent's full anchor (thread integrity).
      const [comment] = await db
        .insert(comments)
        .values({
          id: createId("cmt"),
          projectId: parent.projectId,
          compId: parent.compId,
          layerId: parent.layerId,
          timeTicks: parent.timeTicks,
          parentId: parent.id,
          body,
          authorId: input.authorId,
        })
        .returning();
      if (!comment) throw DbError.conflict("Could not create comment reply");
      return comment;
    },

    async createGuest(workspaceId, input) {
      const body = requireNonEmpty(input.body, "body");
      const compId = requireNonEmpty(input.compId, "compId");
      requireNonEmpty(input.shareTokenId, "shareTokenId");
      const guestName = requireGuestName(input.guestName);
      const guestEmail = requireGuestEmail(input.guestEmail);

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
          authorId: null, // guest rows carry no member author (§M7 task 1)
          parentId: null, // guests post top-level comments only
          guestName,
          guestEmail,
          shareTokenId: input.shareTokenId,
        })
        .returning();
      if (!comment) throw DbError.conflict("Could not create comment");
      return comment;
    },

    async listThreaded(workspaceId, projectId, options) {
      // Cross-tenant project ids read as 404 (§12.1, mirroring versions.list).
      const [project] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.id, projectId),
            eq(projects.workspaceId, workspaceId),
            isNull(projects.deletedAt),
          ),
        )
        .limit(1);
      if (!project) throw DbError.notFound("project");

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
            // D-15: the comp filter is a server-side query parameter.
            options?.compId === undefined ? undefined : eq(comments.compId, options.compId),
            // Thread-aware: the ROOT's resolvedAt decides the whole thread.
            options?.resolved === undefined ? undefined : threadResolvedCondition(options.resolved),
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
            // Thread-aware (same semantics as listThreaded): the ROOT's
            // resolvedAt decides the whole thread.
            options?.resolved === undefined ? undefined : threadResolvedCondition(options.resolved),
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

    async resolve(workspaceId, input) {
      requireNonEmpty(input.resolvedBy, "resolvedBy");
      const current = await this.get(workspaceId, input.commentId);
      if (current.resolvedAt) return current; // idempotent: first resolver wins
      const [updated] = await db
        .update(comments)
        .set({ resolvedAt: new Date(), resolvedBy: input.resolvedBy })
        .where(and(eq(comments.id, current.id), isNull(comments.resolvedAt)))
        .returning();
      // Lost a resolve race: re-read the winner's row instead of the stale copy.
      return updated ?? (await this.get(workspaceId, current.id));
    },

    async unresolve(workspaceId, commentId) {
      const current = await this.get(workspaceId, commentId);
      if (!current.resolvedAt) return current;
      const [updated] = await db
        .update(comments)
        .set({ resolvedAt: null, resolvedBy: null })
        .where(and(eq(comments.id, current.id), isNotNull(comments.resolvedAt)))
        .returning();
      return updated ?? (await this.get(workspaceId, current.id));
    },
  };
}
