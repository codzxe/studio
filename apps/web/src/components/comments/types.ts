/**
 * Shared types for the comments UI (M7-F — BUILD_PLAN §M7 task 1 over the
 * landed M7-A backend; PRODUCT_ARCHITECTURE §7.2 comments routes, §9.1
 * `comments`, §11; EDITOR_CHAT_UX §10 visual language; UI_DESIGN_SYSTEM §8.7
 * "the editor is the page", dark-only tokens).
 *
 * `Comment` is imported TYPE-ONLY from @studio/contracts (apps/web forbids
 * runtime imports of the NodeNext contracts barrel — lib/gateway.ts note).
 */

import type { CommentsQueryInput } from "@studio/api-client";
import type { Comment, LeaseStateResponse, MeResponse, Page } from "@studio/contracts";

/**
 * The narrow comments surface the panel needs. The production
 * `ApiClient` satisfies this STRUCTURALLY (same member shapes), so hosts pass
 * the real client while tests fake a small object — no `any`, no full-client
 * mocks. `me` + `leases` are optional ports: when absent (or failing) the
 * panel degrades — no "You" labels, no lease note — and NEVER blocks reading,
 * replying or commenting (review is the point of the read-only lease, D-23).
 */
export interface CommentsClient {
  readonly comments: {
    listThreadedComments(projectId: string, query?: CommentsQueryInput): Promise<Page<Comment>>;
    create(
      projectId: string,
      body: { compId: string; layerId?: string; timeTicks?: number; body: string },
    ): Promise<Comment>;
    replyComment(commentId: string, body: { body: string }): Promise<Comment>;
    resolveComment(commentId: string, body?: { resolved?: boolean }): Promise<Comment>;
  };
  /** `GET /v1/me` — viewer id for "You"/"by you" labels. Optional seam. */
  readonly me?: { get(): Promise<MeResponse> };
  /** `GET /v1/projects/:id/lease-state` — the M7-C lease snapshot. Optional seam. */
  readonly leases?: { leaseState(projectId: string): Promise<LeaseStateResponse> };
}

/**
 * The lease facts the panel renders (from M7-C's `lease-state`): when another
 * member holds the edit lease the panel PINS that commenting still works —
 * D-23's read-only scope gates project WRITES, never review.
 */
export interface LeaseSnapshot {
  /** Display name of the active holder; null when the lease is free/expired. */
  readonly holderName: string | null;
  /** The caller's standing per the lease-state wire. */
  readonly youAre: LeaseStateResponse["youAre"];
}

/** One comp-filter option: the engine comp id in its canonical string form. */
export interface CompOption {
  readonly id: string;
  readonly name: string;
}

/**
 * Anchor display names (comp/layer) resolved from the LIVE editor via the
 * bridge. Rows keep the raw anchor ids as data — a missing name (deleted or
 * renamed layer, closed comp) falls back to the truncated id, never "unknown
 * object" copy.
 */
export interface AnchorNames {
  readonly comps: ReadonlyMap<string, string>;
  readonly layers: ReadonlyMap<string, string>;
}

/** Row-count per list page (§7.2 cursor pagination; 20 keeps the panel light). */
export const COMMENTS_PAGE_LIMIT = 20;

/** Visual nesting cap (§M7 task 1: root → reply → reply-to-reply). */
export const COMMENT_MAX_VISUAL_DEPTH = 3;
