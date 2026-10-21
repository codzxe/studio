// @studio/contracts — comments (PRODUCT_ARCHITECTURE.md §7.2, §9.1 `comments`, §11).
//
// Comments anchor to a project/composition/layer/time; resolve/unresolve only.

import { z } from "zod";

import { ID_SCHEMA, type Id, PAGINATION_QUERY_SCHEMA } from "./common.js";

/** `POST /v1/projects/:id/comments` body (comp anchor required, §9.1). */
export const CREATE_COMMENT_SCHEMA = z.strictObject({
  compId: ID_SCHEMA,
  layerId: ID_SCHEMA.optional(),
  timeTicks: z.number().int().nonnegative().optional(),
  body: z.string().min(1).max(2000),
});

export type CreateCommentRequest = z.infer<typeof CREATE_COMMENT_SCHEMA>;

/** `GET /v1/projects/:id/comments` query. */
export const COMMENTS_QUERY_SCHEMA = PAGINATION_QUERY_SCHEMA.extend({
  compId: ID_SCHEMA.optional(),
  resolved: z.boolean().optional(),
});

export type CommentsQuery = z.infer<typeof COMMENTS_QUERY_SCHEMA>;

/** Resolve/unresolve an existing comment. */
export const RESOLVE_COMMENT_SCHEMA = z.strictObject({
  resolved: z.boolean(),
});

export type ResolveCommentRequest = z.infer<typeof RESOLVE_COMMENT_SCHEMA>;

/** Comment row (§9.1). */
export interface Comment {
  readonly id: Id;
  readonly projectId: Id;
  readonly compId: Id;
  readonly layerId: Id | null;
  readonly timeTicks: number | null;
  readonly body: string;
  readonly authorId: Id;
  readonly resolvedAt: string | null;
  readonly createdAt: string;
}
