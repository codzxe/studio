"use client";

// apps/web/src/components/comments — data hooks for canvas review comments
// (W8-H). Spec anchors: §12.1 `comments` table (x/y px + resolved_at),
// §13.1 documents scope, §15.2 RBAC ("viewer (read + comment)"), §19 Phase 3
// ("comments with positions, notifications").
//
// EXPECTED API SURFACE (gateway-side — routes do not exist yet, see FLAG):
//
//   GET   /v1/documents/:id/comments
//         → { ok: true, comments: CommentDto[] }          (RBAC: viewer+)
//   POST  /v1/documents/:id/comments
//         body { body ≤2000 chars, x ≥ 0 int, y ≥ 0 int }
//         → { ok: true, comment: CommentDto }              (RBAC: viewer+)
//   POST  /v1/comments/:id/resolve
//         body { resolved?: boolean = true }              (false reopens)
//         → { ok: true, comment: CommentDto }
//
//   CommentDto = the shipped DB row (packages/db/src/schema/content.ts):
//   { id, document_id, author_id, body, x, y, resolved_at, created_at }
//   plus an optional `author_name` the gateway is expected to join from the
//   auth user table (the client cannot resolve ids to names — §13.1 exposes
//   no user-lookup endpoint).
//
// FLAG — OPENAPI AUDIT: comments are SCHEMA-ONLY today. §13.1's endpoint
// table does not list any comments routes, and apps/gateway/src/openapi.ts
// has NO comments paths at all — the W4-O audit's `x-studio-status` flags
// (`implemented` | `wired-in-W4-R` | `partial` | `not-implemented`) cover
// every other surface; comments are absent entirely, i.e. PARTIAL beyond
// the audit's own vocabulary. docs/devlog.md records the divergence
// verbatim: "comments table in schema (`4800ccf` W1-D — no routes yet)".
// Until the gateway wave lands, every hook below targets the contract in
// this header; the zod schemas here are the pin the gateway routes must
// mirror (§13 audit convention: zod-at-the-boundary, schemas mirrored in
// openapi.ts). Anything else the server adds (e.g. a future `thread_id`,
// §12.1's sketch) is stripped, not fatal — this client keeps working.
//
// §13 conventions honored: the mutating POSTs auto-carry an Idempotency-Key
// header (src/lib/api.ts request()), errors unwrap into typed ApiError
// envelopes, and success bodies are zod-validated at the boundary.
//
// Threading note: §12.1 sketches optional `thread_id?`/`layer_id?`; the
// shipped schema is flat (W1-D) — every comment is a single-item thread.
// The hooks below stay flat to match the schema, and the wire schemas
// tolerate the future columns landing server-side.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { createGatewayClientFromEnv, type GatewayClient } from "@/lib/api";
import { COMMENT_BODY_MAX, sortCommentsByCreation, type CanvasComment } from "./comment-utils";

// ---------------------------------------------------------------------------
// Wire schemas (the boundary — gateway routes must mirror these)
// ---------------------------------------------------------------------------

/** ISO-8601 instant; offsets accepted (`Z` or `±hh:mm`). */
const isoDateTime = z.string().datetime({ offset: true });

/** One comment row on the wire — mirrors schema/content.ts `comments`. */
export const commentDtoSchema = z.object({
  id: z.string().min(1),
  document_id: z.string().min(1),
  author_id: z.string().min(1),
  /** Gateway-side join with the auth user table (see header contract). */
  author_name: z.string().min(1).optional(),
  body: z.string().min(1).max(COMMENT_BODY_MAX),
  // Canvas px (§12.1) — int, never negative.
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  resolved_at: isoDateTime.nullable(),
  created_at: isoDateTime,
});

export type CommentDto = z.infer<typeof commentDtoSchema>;

/** `GET /v1/documents/:id/comments` success body. */
export const commentListResponseSchema = z.object({
  ok: z.literal(true),
  comments: z.array(commentDtoSchema),
});

/** `POST` create/resolve success body. */
export const commentResponseSchema = z.object({
  ok: z.literal(true),
  comment: commentDtoSchema,
});

/** `POST /v1/documents/:id/comments` request body. */
export const addCommentRequestSchema = z.object({
  body: z.string().min(1).max(COMMENT_BODY_MAX),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
});

export type AddCommentInput = z.infer<typeof addCommentRequestSchema>;

// ---------------------------------------------------------------------------
// Mapping + cache key
// ---------------------------------------------------------------------------

function mapCommentDto(dto: CommentDto): CanvasComment {
  return {
    id: dto.id,
    authorId: dto.author_id,
    authorName: dto.author_name,
    body: dto.body,
    x: dto.x,
    y: dto.y,
    resolvedAt: dto.resolved_at === null ? null : new Date(dto.resolved_at),
    createdAt: new Date(dto.created_at),
  };
}

/** React Query cache key — the panel and the pin overlay share one list. */
export function commentsQueryKey(documentId: string): readonly [string, string] {
  return ["comments", documentId] as const;
}

/** Lazily resolve the gateway client: an explicit client wins (tests, W8-F's
 * shared client); otherwise env-configured — never at render/SSR time, only
 * inside queryFn/mutationFn which run after mount in the browser. */
function resolveClient(client?: GatewayClient): GatewayClient {
  return client ?? createGatewayClientFromEnv();
}

// ---------------------------------------------------------------------------
// useComments — list by document
// ---------------------------------------------------------------------------

export interface UseCommentsOptions {
  readonly documentId: string;
  /** Injected gateway client; omit to use NEXT_PUBLIC_API_BASE_URL (src/lib/env.ts). */
  readonly client?: GatewayClient;
  /**
   * Interim notifications (§19 Phase 3): comment fan-out is designed for the
   * realtime layer (§16.2 — "SSE first", Centrifugo for "comment
   * notifications"), which has no comment events yet. Polling is opt-in here
   * so W8-F can keep panels fresh without waiting for realtime; remove when
   * the realtime wave lands (invalidate this key on the document channel).
   */
  readonly refetchIntervalMs?: number;
}

/** All comments for one document, oldest first (see sortCommentsByCreation). */
export function useComments(options: UseCommentsOptions) {
  const documentId = options.documentId;
  return useQuery({
    queryKey: commentsQueryKey(documentId),
    enabled: documentId.length > 0,
    refetchInterval: options.refetchIntervalMs,
    queryFn: async (): Promise<readonly CanvasComment[]> => {
      const response = await resolveClient(options.client).get(
        `/documents/${encodeURIComponent(documentId)}/comments`,
        { schema: commentListResponseSchema },
      );
      return sortCommentsByCreation(response.comments.map(mapCommentDto));
    },
  });
}

// ---------------------------------------------------------------------------
// useAddComment — optimistic insert with rollback
// ---------------------------------------------------------------------------

type CommentsCache = readonly CanvasComment[];

interface AddCommentContext {
  readonly previous: CommentsCache | undefined;
  /** Stand-in id swapped for the authoritative server row on success. */
  readonly tempId: string;
}

export interface UseMutationClientOptions {
  readonly documentId: string;
  /** Injected gateway client; omit for the env-configured default. */
  readonly client?: GatewayClient;
}

/**
 * Create a comment at a canvas position (§12.1 x/y px). Optimistic: a
 * stand-in row ("You", now, temp id) is appended the moment the POST fires
 * and is replaced by the server row on success. On error the previous list
 * is restored exactly — or the cache entry dropped when nothing had loaded
 * yet (rollback, never a half-state).
 */
export function useAddComment(options: UseMutationClientOptions) {
  const queryClient = useQueryClient();
  const queryKey = commentsQueryKey(options.documentId);

  return useMutation({
    mutationFn: async (input: AddCommentInput): Promise<CanvasComment> => {
      const request = addCommentRequestSchema.parse(input);
      const response = await resolveClient(options.client).post(
        `/documents/${encodeURIComponent(options.documentId)}/comments`,
        { body: request.body, x: request.x, y: request.y },
        { schema: commentResponseSchema },
      );
      return mapCommentDto(response.comment);
    },
    onMutate: async (input: AddCommentInput): Promise<AddCommentContext> => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<CommentsCache>(queryKey);
      const standIn: CanvasComment = {
        id: `optimistic-${crypto.randomUUID()}`,
        authorId: "you", // placeholder, never rendered — swapped on success
        authorName: "You",
        body: input.body.trim(),
        x: input.x,
        y: input.y,
        resolvedAt: null,
        createdAt: new Date(),
      };
      queryClient.setQueryData<CommentsCache>(queryKey, (old) => [
        ...(old ?? []),
        standIn,
      ]);
      return { previous, tempId: standIn.id };
    },
    onSuccess: (created: CanvasComment, _input, context?: AddCommentContext) => {
      if (context === undefined) {
        return;
      }
      queryClient.setQueryData<CommentsCache>(queryKey, (old) =>
        (old ?? []).map((comment) => (comment.id === context.tempId ? created : comment)),
      );
    },
    onError: (_error, _input, context?: AddCommentContext) => {
      // ROLLBACK — restore the exact pre-mutation list.
      if (context === undefined) {
        return;
      }
      if (context.previous === undefined) {
        queryClient.removeQueries({ queryKey });
      } else {
        queryClient.setQueryData<CommentsCache>(queryKey, context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });
}

// ---------------------------------------------------------------------------
// useResolveComment — optimistic resolve/reopen with rollback
// ---------------------------------------------------------------------------

export interface ResolveCommentInput {
  readonly commentId: string;
  /** true marks resolved (resolved_at = now); false reopens (resolved_at = null). */
  readonly resolved: boolean;
}

interface ResolveCommentContext {
  readonly previous: CommentsCache | undefined;
}

/**
 * Resolve or reopen a comment. Optimistic: the row's `resolvedAt` flips the
 * moment the POST fires; on error the previous list is restored exactly
 * (rollback), and the list refetches on settle either way.
 */
export function useResolveComment(options: UseMutationClientOptions) {
  const queryClient = useQueryClient();
  const queryKey = commentsQueryKey(options.documentId);

  return useMutation({
    mutationFn: async (input: ResolveCommentInput): Promise<CanvasComment> => {
      const response = await resolveClient(options.client).post(
        `/comments/${encodeURIComponent(input.commentId)}/resolve`,
        { resolved: input.resolved },
        { schema: commentResponseSchema },
      );
      return mapCommentDto(response.comment);
    },
    onMutate: async (input: ResolveCommentInput): Promise<ResolveCommentContext> => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<CommentsCache>(queryKey);
      queryClient.setQueryData<CommentsCache>(queryKey, (old) =>
        (old ?? []).map((comment) =>
          comment.id === input.commentId
            ? { ...comment, resolvedAt: input.resolved ? new Date() : null }
            : comment,
        ),
      );
      return { previous };
    },
    onError: (_error, _input, context?: ResolveCommentContext) => {
      // ROLLBACK — restore the exact pre-mutation list.
      if (context === undefined) {
        return;
      }
      if (context.previous === undefined) {
        queryClient.removeQueries({ queryKey });
      } else {
        queryClient.setQueryData<CommentsCache>(queryKey, context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });
}
