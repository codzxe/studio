import { and, desc, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import { clampLimit, decodeCursor, encodeCursor } from "../cursor.js";
import { DbError } from "../errors-lite.js";
import { createId } from "../ids.js";
import { comments, projects } from "../schema.js";
import { requireNonEmpty } from "./shared.js";
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
function requireGuestName(raw) {
    const name = requireNonEmpty(raw, "guestName");
    if (name.length > GUEST_NAME_MAX) {
        throw DbError.validation(`guestName must be at most ${GUEST_NAME_MAX} characters`);
    }
    return name;
}
function requireGuestEmail(raw) {
    const email = requireNonEmpty(raw, "guestEmail").toLowerCase();
    if (email.length > GUEST_EMAIL_MAX || !GUEST_EMAIL_PATTERN.test(email)) {
        throw DbError.validation("guestEmail must be a valid email address");
    }
    return email;
}
export function createCommentsRepo(db) {
    return {
        async create(workspaceId, input) {
            const body = requireNonEmpty(input.body, "body");
            const compId = requireNonEmpty(input.compId, "compId");
            requireNonEmpty(input.authorId, "authorId");
            const [project] = await db
                .select({ id: projects.id })
                .from(projects)
                .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt)))
                .limit(1);
            if (!project)
                throw DbError.notFound("project");
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
            if (!comment)
                throw DbError.conflict("Could not create comment");
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
            let cursor = parent;
            while (cursor.parentId !== null) {
                parentDepth += 1;
                if (parentDepth >= MAX_COMMENT_DEPTH)
                    break;
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
            if (!comment)
                throw DbError.conflict("Could not create comment reply");
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
                .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt)))
                .limit(1);
            if (!project)
                throw DbError.notFound("project");
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
            if (!comment)
                throw DbError.conflict("Could not create comment");
            return comment;
        },
        async listThreaded(workspaceId, projectId, options) {
            // Cross-tenant project ids read as 404 (§12.1, mirroring versions.list).
            const [project] = await db
                .select({ id: projects.id })
                .from(projects)
                .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt)))
                .limit(1);
            if (!project)
                throw DbError.notFound("project");
            const limit = clampLimit(options?.limit);
            const cursor = decodeCursor(options?.cursor ?? null);
            const rows = await db
                .select({ comment: comments })
                .from(comments)
                .innerJoin(projects, eq(comments.projectId, projects.id))
                .where(and(eq(comments.projectId, projectId), eq(projects.workspaceId, workspaceId), 
            // D-15: the comp filter is a server-side query parameter.
            options?.compId === undefined ? undefined : eq(comments.compId, options.compId), options?.resolved === undefined
                ? undefined
                : options.resolved
                    ? isNotNull(comments.resolvedAt)
                    : isNull(comments.resolvedAt), cursor
                ? or(lt(comments.createdAt, new Date(cursor.t)), and(eq(comments.createdAt, new Date(cursor.t)), lt(comments.id, cursor.id)))
                : undefined))
                .orderBy(desc(comments.createdAt), desc(comments.id))
                .limit(limit + 1);
            const items = rows.map((row) => row.comment).slice(0, limit);
            const last = items.at(-1);
            const hasMore = rows.length > limit;
            return {
                items,
                nextCursor: hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null,
            };
        },
        async list(workspaceId, projectId, options) {
            const limit = clampLimit(options?.limit);
            const cursor = decodeCursor(options?.cursor ?? null);
            const rows = await db
                .select({ comment: comments })
                .from(comments)
                .innerJoin(projects, eq(comments.projectId, projects.id))
                .where(and(eq(comments.projectId, projectId), eq(projects.workspaceId, workspaceId), options?.resolved === undefined
                ? undefined
                : options.resolved
                    ? isNotNull(comments.resolvedAt)
                    : isNull(comments.resolvedAt), cursor
                ? or(lt(comments.createdAt, new Date(cursor.t)), and(eq(comments.createdAt, new Date(cursor.t)), lt(comments.id, cursor.id)))
                : undefined))
                .orderBy(desc(comments.createdAt), desc(comments.id))
                .limit(limit + 1);
            const items = rows.map((row) => row.comment).slice(0, limit);
            const last = items.at(-1);
            const hasMore = rows.length > limit;
            return {
                items,
                nextCursor: hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null,
            };
        },
        async get(workspaceId, commentId) {
            const [row] = await db
                .select({ comment: comments })
                .from(comments)
                .innerJoin(projects, eq(comments.projectId, projects.id))
                .where(and(eq(comments.id, commentId), eq(projects.workspaceId, workspaceId)))
                .limit(1);
            if (!row)
                throw DbError.notFound("comment");
            return row.comment;
        },
        async resolve(workspaceId, input) {
            requireNonEmpty(input.resolvedBy, "resolvedBy");
            const current = await this.get(workspaceId, input.commentId);
            if (current.resolvedAt)
                return current; // idempotent: first resolver wins
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
            if (!current.resolvedAt)
                return current;
            const [updated] = await db
                .update(comments)
                .set({ resolvedAt: null, resolvedBy: null })
                .where(and(eq(comments.id, current.id), isNotNull(comments.resolvedAt)))
                .returning();
            return updated ?? (await this.get(workspaceId, current.id));
        },
    };
}
//# sourceMappingURL=comments.js.map