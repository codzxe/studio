// @studio/db — content domain: documents, immutable versions, the command-log WAL,
// assets, canvas comments and workspace templates. Owner: W1-D (docs/AGENTS.md).
//
// Spec anchors:
//   §5.6   transactions & replay — `commands` IS the WAL: after an engine crash the
//          worker replays commands from the last checkpoint, and "duplicate this
//          document" copy-on-writes from the log. revision_before/revision_after are
//          the monotonic counters carried by every command.
//   §10    document model — linear history + named checkpoints (no branching);
//          the .pcraft file lives in object storage, never a full copy per version.
//   §12.1  content tables  §12.2 tenant scoping  §13 documents/versions/assets/comments
//   §3.2   sessions are never shared across tenants; `organization` == the workspace.
//
// Conventions: text uuid-ish ids (DB-defaulted), opaque jsonb payloads (validate with
// Zod at boundaries, §5.7), timestamptz throughout. User columns (created_by /
// uploader_id / author_id) point at the Better Auth `user` table (schema/auth.ts) as
// plain text — no DB-level FK, since users are auth-owned. The organization FKs use
// text references per the tenancy rules (§12.2: every query scoped by organization_id;
// composite queries only, never "find by id then check").

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";

/** Asset library kinds (§13.1 uploads / GET /v1/assets). Fonts are never committed (AGENTS.md). */
export const ASSET_KINDS = ["image", "font"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/** How an asset entered the library (§12.1 assets.origin). */
export const ASSET_ORIGINS = ["upload", "generated"] as const;
export type AssetOrigin = (typeof ASSET_ORIGINS)[number];

/** Catalog rows are public (organization_id null) or workspace-scoped (§12.1 templates). */
export const TEMPLATE_SOURCES = ["public", "workspace"] as const;
export type TemplateSource = (typeof TEMPLATE_SOURCES)[number];

/**
 * Documents (§10, §13.1): the current-pointer row for one canvas. The editable scene
 * lives in object storage (.pcraft, §10.3) plus the command log; `current_revision` is
 * the monotonic counter advanced by every committed mutating command (§5.6) and echoed
 * in `preview.updated` events (§13.2). `archived_at` is the soft-archive marker — a
 * hard-delete job owns true removal (§12.2 GDPR path).
 */
export const documents = pgTable(
  "documents",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
    // §12.2 tenant root — cascades so the GDPR purge removes tenant content wholesale.
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Canvas size in px (§10.3 render/export dimensions; engine caps at 64 MP).
    widthPx: integer("width_px").notNull(),
    heightPx: integer("height_px").notNull(),
    currentRevision: integer("current_revision").notNull().default(0),
    // Template ref like "instagram-post@3" (§5.5). Deliberately not an FK: it may
    // address the public catalog and must survive template unpublishing.
    templateId: text("template_id"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [index("documents_org_updated_idx").on(t.organizationId, t.updatedAt)],
);

/**
 * Immutable version history (§10.4): every committed run creates one version and
 * "restore" creates a new version from an old command log. Storage is command log +
 * periodic checkpoints — `checkpoint_ref` points at the engine snapshot used as the
 * replay base, `storage_key` at the .pcraft file in object storage.
 */
export const documentVersions = pgTable(
  "document_versions",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    revision: integer("revision").notNull(),
    // Engine snapshot reference (opaque; shape owned by the engine pool). Null when
    // the version is reconstructed purely from the command log (§5.6).
    checkpointRef: jsonb("checkpoint_ref").$type<Record<string, unknown>>(),
    // Object-store key of this version's .pcraft file (§10.3).
    storageKey: text("storage_key").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("document_versions_document_revision_uq").on(t.documentId, t.revision)],
);

/**
 * The command log — the write-ahead log for replay (§5.6). One row per executed engine
 * command, appended only: never update or delete. `seq` is the 1-based per-document
 * position; unique(document_id, seq) gives a strict total order for replay from the
 * last checkpoint. `run_id` is null for manual/API commands (§13.4 — the public API is
 * the agent API).
 */
export const commands = pgTable(
  "commands",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // agent_runs.id (schema/runs.ts); text pointer, no cross-file FK by design there.
    runId: text("run_id"),
    seq: integer("seq").notNull(),
    commandName: text("command_name").notNull(),
    params: jsonb("params").$type<Record<string, unknown>>().notNull().default({}),
    // Null when the command failed before producing a result; failures are audited
    // via agent_steps, they are never replayed.
    result: jsonb("result").$type<Record<string, unknown>>(),
    revisionBefore: integer("revision_before").notNull(),
    revisionAfter: integer("revision_after").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("commands_document_seq_uq").on(t.documentId, t.seq),
    // Explicit document_id index (the (document_id, seq) unique already serves
    // leftmost-prefix lookups); WAL scans are the hottest read path (§3.3 step 4).
    index("commands_document_idx").on(t.documentId),
  ],
);

/**
 * Asset library (§13.1 POST /v1/uploads, GET /v1/assets). Binaries live in object
 * storage at `storage_key`; `checksum` is the sha256 hex used for dedupe on
 * (organization, sha256) — dedupe itself is enforced by the service layer (§12.1).
 * EXIF is stripped on image upload (§15 security posture); `exif_stripped` records it.
 */
export const assets = pgTable(
  "assets",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    uploaderId: text("uploader_id").notNull(),
    kind: text("kind").$type<AssetKind>().notNull(),
    storageKey: text("storage_key").notNull(),
    // sha256 hex of the stored bytes.
    checksum: text("checksum").notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    // Pixel dimensions; null for fonts.
    widthPx: integer("width_px"),
    heightPx: integer("height_px"),
    mime: text("mime").notNull(),
    exifStripped: boolean("exif_stripped").notNull().default(false),
    origin: text("origin").$type<AssetOrigin>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("assets_org_created_idx").on(t.organizationId, t.createdAt)],
);

/**
 * Canvas-pinned review comments (§12.1): presence-light by design. `x`/`y` are canvas
 * coordinates of the pin; `resolved_at` marks resolution (no separate state column).
 * Comment bodies are user content — data, never instructions (§5.7).
 */
export const comments = pgTable("comments", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  documentId: text("document_id")
    .notNull()
    .references(() => documents.id, { onDelete: "cascade" }),
  authorId: text("author_id").notNull(),
  body: text("body").notNull(),
  // Canvas position (px) where the comment pin sits.
  x: integer("x").notNull(),
  y: integer("y").notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Template catalog rows (§7, §13.1 GET /v1/templates). `manifest` is the template
 * manifest fed to the planner and cached per version (§5.3/§5.4). Public catalog rows
 * carry `organization_id` null; workspace rows cascade with their organization.
 */
export const workspaceTemplates = pgTable("workspace_templates", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
  organizationId: text("organization_id").references(() => organization.id, {
    onDelete: "cascade",
  }),
  source: text("source").$type<TemplateSource>().notNull(),
  manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull(),
  version: integer("version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type DocumentVersion = typeof documentVersions.$inferSelect;
export type NewDocumentVersion = typeof documentVersions.$inferInsert;
export type CommandLogEntry = typeof commands.$inferSelect;
export type NewCommandLogEntry = typeof commands.$inferInsert;
export type Asset = typeof assets.$inferSelect;
export type NewAsset = typeof assets.$inferInsert;
export type Comment = typeof comments.$inferSelect;
export type NewComment = typeof comments.$inferInsert;
export type WorkspaceTemplate = typeof workspaceTemplates.$inferSelect;
export type NewWorkspaceTemplate = typeof workspaceTemplates.$inferInsert;
