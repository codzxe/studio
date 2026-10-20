// @studio/db — append-only audit log. Owner: W1-F (docs/AGENTS.md).
//
// Spec anchors:
//   §22   audit_log records auth events, role changes, API keys, exports,
//         deletes and credit adjustments; immutable (append-only) and
//         exportable per workspace — the org-scoped index below serves the
//         export query (WHERE organization_id = ? ORDER BY created_at DESC)
//   §12.1 audit_log table shape
//   §12.2 tenant rows carry organization_id
//
// Cross-file foreign keys (organizations / users, owned by other build agents)
// are intentionally not declared here; tenant scoping is enforced in the
// repository layer (§12.2), same as billing.ts / runs.ts.

import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * §22 — append-only security/compliance trail. Rows are never UPDATEd or
 * DELETEd. `target` is a stable "<type>:<id>" string (e.g. "document:<uuid>")
 * so exports stay readable even after the referenced row is gone.
 * `organizationId` is null for platform-level events (user signup before an
 * organization exists, system actions); `actorId` is null when no user
 * triggered the action (webhooks, cron).
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // §12.2 tenant column — null only for platform-level events (see above).
    organizationId: uuid("organization_id"),
    actorId: uuid("actor_id"), // null for system/webhook-actor entries
    action: text("action").notNull(), // e.g. 'auth.login' | 'role.changed' | 'credit.adjustment'
    target: text("target").notNull(), // "<type>:<id>" of the affected record
    metadata: jsonb("metadata").notNull().default({}), // export-safe context, never secrets
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // §22 exportable per workspace: org-scoped, newest-first.
    index("audit_log_org_created_idx").on(
      table.organizationId,
      table.createdAt.desc(),
    ),
  ],
);

export type AuditLog = typeof auditLog.$inferSelect;
export type NewAuditLog = typeof auditLog.$inferInsert;
