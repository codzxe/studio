import { type Page } from "../cursor.js";
import type { StudioDb } from "../db.js";
import { type Comment } from "../schema.js";
import { type WorkspaceId } from "./shared.js";
/**
 * Comments repository — review notes anchored to project/comp/layer/time (§11).
 * Replies thread through `parent_id` (depth ≤ 3); resolve/unresolve only
 * touches `resolved_at`/`resolved_by`; bodies are never edited. Every read is
 * tenant-scoped through the project join (§12.1).
 */
/** Max thread depth (§M7 task 1): root (1) → reply (2) → reply-to-reply (3). */
export declare const MAX_COMMENT_DEPTH = 3;
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
    listThreaded(workspaceId: WorkspaceId, projectId: string, options?: ThreadedCommentListOptions): Promise<Page<Comment>>;
    list(workspaceId: WorkspaceId, projectId: string, options?: CommentListOptions): Promise<Page<Comment>>;
    get(workspaceId: WorkspaceId, commentId: string): Promise<Comment>;
    /**
     * Idempotent: resolving an already-resolved comment returns it unchanged —
     * the FIRST resolver stays recorded on `resolved_by`.
     */
    resolve(workspaceId: WorkspaceId, input: ResolveCommentInput): Promise<Comment>;
    unresolve(workspaceId: WorkspaceId, commentId: string): Promise<Comment>;
}
export declare function createCommentsRepo(db: StudioDb): CommentsRepo;
