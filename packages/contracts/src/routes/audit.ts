// @studio/contracts — workspace audit feed (W3-G3, §7.2, §7.1): the wire for
// `GET /v1/workspaces/:id/audit` — the workspace-level view of `audit_log` at
// the VIEWER floor (any member reads their workspace's history; §12.1 hides
// existence from strangers — the gateway renders cross-tenant lookups as 404).
//
// Law #1: this is a UI feed, not compliance data — `metadata` and the request
// `ip` NEVER cross the wire here. They appear only in the admin-only project
// audit export (routes/activity.ts `AuditExportRow`); this surface carries
// `AuditEntry` only. No actor join in v1: `actorId` is the raw actor
// reference (null for system rows) — the project feed owns the actor-name
// join (`ActivityEntry.actorName`).

import { z } from "zod";

import { type Id, PAGINATION_QUERY_SCHEMA } from "./common.js";

/** `GET /v1/workspaces/:id/audit` query — pagination + optional target filter. */
export const AUDIT_QUERY_SCHEMA = PAGINATION_QUERY_SCHEMA.extend({
  /** Filter by the audit row's target type, e.g. "project", "member". */
  targetType: z.string().min(1).max(64).optional(),
});

export type AuditQuery = z.infer<typeof AUDIT_QUERY_SCHEMA>;

/** One workspace audit entry (viewer-floor feed; metadata/ip stripped). */
export interface AuditEntry {
  readonly id: Id;
  readonly actorId: Id | null;
  /** Stable action name, e.g. "member.role_changed", "workspace.ownership_transferred". */
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: Id | null;
  readonly createdAt: string;
}
