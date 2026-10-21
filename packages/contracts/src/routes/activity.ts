// @studio/contracts — activity feed (PRODUCT_ARCHITECTURE.md §7.2, §9.1 `audit_log`).
//
// `GET /v1/projects/:id/activity`: project-scoped feed of audited actions.
// Every role change, invite, API-key create/revoke and destructive action is
// audited (§7.1); this is the user-facing view, not the compliance log.

import type { z } from "zod";

import { type Id, PAGINATION_QUERY_SCHEMA } from "./common.js";

/** `GET /v1/projects/:id/activity` query. */
export const ACTIVITY_QUERY_SCHEMA = PAGINATION_QUERY_SCHEMA;

export type ActivityQuery = z.infer<typeof ACTIVITY_QUERY_SCHEMA>;

/** One activity-feed entry (project-scoped audit view). */
export interface ActivityEntry {
  readonly id: Id;
  readonly projectId: Id | null;
  readonly actorId: Id;
  readonly actorName: string | null;
  /** Stable action name, e.g. "project.created", "version.restored", "run.applied". */
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: Id | null;
  readonly createdAt: string;
}
