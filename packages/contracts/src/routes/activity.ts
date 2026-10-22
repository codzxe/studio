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

/**
 * One raw `audit_log` row in the ADMIN-ONLY export (M7 task 4).
 *
 * Law-#1 nuance: the general rule keeps internal ids out of UI copy, but an
 * audit export is compliance DATA for workspace admins, not UI copy — ids,
 * actor emails, recorded metadata and request ips are allowed HERE and nowhere
 * else. The user-facing feed (ActivityEntry) never carries them.
 */
export interface AuditExportRow {
  readonly id: Id;
  readonly actorId: Id | null;
  readonly actorName: string | null;
  readonly actorEmail: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: Id | null;
  /** The recorded metadata JSON (opaque, as persisted). */
  readonly metadata: unknown;
  readonly ip: string | null;
  readonly createdAt: string;
}

/** `GET /v1/projects/:id/audit-export` payload (bounded, newest-first). */
export interface AuditExport {
  readonly projectId: Id;
  readonly generatedAt: string;
  /** Hard row bound — exports never grow unbounded (see repos/audit.ts). */
  readonly maxRows: number;
  readonly rowCount: number;
  /** `true` when older rows exist beyond the bound. */
  readonly truncated: boolean;
  readonly rows: readonly AuditExportRow[];
}
