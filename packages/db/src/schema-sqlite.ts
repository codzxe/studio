import { randomUUID } from "node:crypto";
import { relations, sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { createId } from "./ids.js";
import type {
  InvoiceStatus,
  LedgerKind,
  PlanId,
  RenderStatus,
  RunStatus,
  StepStatus,
  SubscriptionStatus,
} from "./schema.js";

/**
 * Studio schema (SQLite) — the DEV-dialect twin of `./schema.ts` (W1-02).
 *
 * CONTRACT (see README.md "Dual dialect"):
 * - This is a THROWAWAY-dev-database schema: `createSqliteDb()` /
 *   `createDb("file:…")` open it and `sqlite-bootstrap.ts` creates its tables.
 *   PRODUCTION stays Postgres with the canonical drizzle migrations in
 *   `drizzle/` — this file never feeds a migration.
 * - Same table names, same column names, same indexes/FKs as the pg twin, so
 *   the repos (which resolve their tables through `src/tables.ts`) run
 *   byte-identical against either dialect. Every block points at its pg twin.
 * - Column-type mapping (chosen so the TS inferred types are IDENTICAL to the
 *   pg schema — pinned by tests/sqlite/twin.test.ts two-way type checks):
 *     pg `timestamp(withTimezone, mode date)` → `integer({ mode: "timestamp_ms" })`
 *       (JS Date ↔ epoch-milliseconds integer)
 *     pg `jsonb`                    → `text({ mode: "json" })` (JSON codec in the column)
 *     pg `boolean`                  → `integer({ mode: "boolean" })` (0/1)
 *     pg `bigint({ mode: "number" })` and pg `integer` → `integer` (number)
 *     pg `text` / `char(n)`         → `text`
 * - Domain string-literal unions ($type<…>) are imported type-only from the
 *   pg schema (single source of truth, no runtime cycle).
 * - DO NOT add a column here without adding it to the pg twin first — the
 *   twin test fails the suite on drift.
 */

const ts = (name: string) => integer(name, { mode: "timestamp_ms" });
const jsonCol = (name: string) => text(name, { mode: "json" });

// ─────────────────────────────────────────────────────────────────────────────
// Section 1 — Better Auth core tables (pg twin: schema.ts Section 1)
// ─────────────────────────────────────────────────────────────────────────────

export const user = sqliteTable(
  "user",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
    image: text("image"),
    createdAt: ts("created_at").notNull().default(sql`(unixepoch('subsec') * 1000)`),
    updatedAt: ts("updated_at")
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`)
      .$onUpdate(() => new Date()),
    role: text("role"),
    banned: integer("banned", { mode: "boolean" }).default(false),
    banReason: text("ban_reason"),
    banExpires: ts("ban_expires"),
  },
  (t) => [index("user_email_idx").on(t.email)],
);

export const session = sqliteTable(
  "session",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    expiresAt: ts("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: ts("created_at").notNull().default(sql`(unixepoch('subsec') * 1000)`),
    updatedAt: ts("updated_at")
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`)
      .$onUpdate(() => new Date()),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references((): AnySQLiteColumn => user.id, { onDelete: "cascade" }),
    activeOrganizationId: text("active_organization_id"),
    impersonatedBy: text("impersonated_by"),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references((): AnySQLiteColumn => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: ts("access_token_expires_at"),
    refreshTokenExpiresAt: ts("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: ts("created_at").notNull().default(sql`(unixepoch('subsec') * 1000)`),
    updatedAt: ts("updated_at")
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`)
      .$onUpdate(() => new Date()),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull().default(sql`(unixepoch('subsec') * 1000)`),
    updatedAt: ts("updated_at").notNull().default(sql`(unixepoch('subsec') * 1000)`),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

// ─────────────────────────────────────────────────────────────────────────────
// Section 2 — Better Auth organization plugin (pg twin: schema.ts Section 2)
// ─────────────────────────────────────────────────────────────────────────────

export const organization = sqliteTable(
  "organization",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    logo: text("logo"),
    createdAt: ts("created_at").notNull().default(sql`(unixepoch('subsec') * 1000)`),
    metadata: text("metadata"),
  },
  (t) => [uniqueIndex("organization_slug_uniq").on(t.slug)],
);

export const member = sqliteTable(
  "member",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references((): AnySQLiteColumn => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references((): AnySQLiteColumn => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: ts("created_at").notNull().default(sql`(unixepoch('subsec') * 1000)`),
  },
  (t) => [
    index("member_organization_idx").on(t.organizationId),
    index("member_user_idx").on(t.userId),
  ],
);

export const invitation = sqliteTable(
  "invitation",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references((): AnySQLiteColumn => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").notNull().default("pending"),
    expiresAt: ts("expires_at").notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references((): AnySQLiteColumn => user.id, { onDelete: "cascade" }),
    createdAt: ts("created_at").notNull().default(sql`(unixepoch('subsec') * 1000)`),
  },
  (t) => [
    index("invitation_organization_idx").on(t.organizationId),
    index("invitation_email_idx").on(t.email),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Section 3 — Better Auth apiKey plugin (pg twin: schema.ts Section 3)
// `metadata` stays a PLAIN TEXT column in both dialects (better-auth
// serializes it itself) — the api-keys repo json path is a query-side shim.
// ─────────────────────────────────────────────────────────────────────────────

export const apiKey = sqliteTable(
  "apikey",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    configId: text("config_id").notNull().default("default"),
    name: text("name"),
    start: text("start"),
    referenceId: text("reference_id").notNull(),
    prefix: text("prefix"),
    key: text("key").notNull(),
    refillInterval: integer("refill_interval"),
    refillAmount: integer("refill_amount"),
    lastRefillAt: ts("last_refill_at"),
    enabled: integer("enabled", { mode: "boolean" }).default(true),
    rateLimitEnabled: integer("rate_limit_enabled", { mode: "boolean" }).default(true),
    rateLimitTimeWindow: integer("rate_limit_time_window").default(86_400_000),
    rateLimitMax: integer("rate_limit_max").default(10),
    requestCount: integer("request_count").default(0),
    remaining: integer("remaining"),
    lastRequest: ts("last_request"),
    expiresAt: ts("expires_at"),
    createdAt: ts("created_at").notNull().default(sql`(unixepoch('subsec') * 1000)`),
    updatedAt: ts("updated_at").notNull().default(sql`(unixepoch('subsec') * 1000)`),
    permissions: text("permissions"),
    metadata: text("metadata"),
  },
  (t) => [index("apikey_reference_idx").on(t.referenceId), index("apikey_key_idx").on(t.key)],
);

// ─────────────────────────────────────────────────────────────────────────────
// Section 4 — Projects, versions, leases (pg twin: schema.ts Section 4)
// `projects.current_version_id` / `project_versions.parent_version_id` stay
// plain text WITHOUT FKs (circular pair — same reasoning as the pg twin).
// ─────────────────────────────────────────────────────────────────────────────

export const projects = sqliteTable(
  "projects",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("prj")),
    workspaceId: text("workspace_id")
      .notNull()
      .references((): AnySQLiteColumn => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    thumbnailUrl: text("thumbnail_url"),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    currentVersionId: text("current_version_id"),
    createdBy: text("created_by")
      .notNull()
      .references((): AnySQLiteColumn => user.id),
    createdAt: ts("created_at").notNull().default(sql`(unixepoch('subsec') * 1000)`),
    updatedAt: ts("updated_at").notNull().default(sql`(unixepoch('subsec') * 1000)`),
    deletedAt: ts("deleted_at"),
  },
  (t) => [
    index("projects_workspace_updated_idx").on(t.workspaceId, sql`${t.updatedAt} desc`),
    uniqueIndex("projects_workspace_slug_uniq").on(t.workspaceId, t.slug),
    index("projects_current_version_idx").on(t.currentVersionId),
  ],
);

export const projectVersions = sqliteTable(
  "project_versions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("ver")),
    projectId: text("project_id")
      .notNull()
      .references((): AnySQLiteColumn => projects.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    parentVersionId: text("parent_version_id"),
    objectKey: text("object_key").notNull(),
    sha256: text("sha256").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    label: text("label"),
    agentRunId: text("agent_run_id"),
    createdBy: text("created_by")
      .notNull()
      .references((): AnySQLiteColumn => user.id),
    createdAt: ts("created_at").notNull().default(sql`(unixepoch('subsec') * 1000)`),
  },
  (t) => [
    index("project_versions_project_idx").on(t.projectId, sql`${t.version} desc`),
    index("project_versions_project_sha_idx").on(t.projectId, t.sha256),
    index("project_versions_parent_idx").on(t.parentVersionId),
  ],
);

export const projectLeases = sqliteTable("project_leases", {
  projectId: text("project_id")
    .primaryKey()
    .references((): AnySQLiteColumn => projects.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references((): AnySQLiteColumn => user.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull(),
  expiresAt: ts("expires_at").notNull(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 5 — Assets (pg twin: schema.ts Section 5)
// ─────────────────────────────────────────────────────────────────────────────

export const assets = sqliteTable(
  "assets",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("ast")),
    workspaceId: text("workspace_id")
      .notNull()
      .references((): AnySQLiteColumn => organization.id, { onDelete: "cascade" }),
    projectId: text("project_id").references((): AnySQLiteColumn => projects.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    objectKey: text("object_key").notNull(),
    width: integer("width"),
    height: integer("height"),
    durationTicks: integer("duration_ticks"),
    createdBy: text("created_by")
      .notNull()
      .references((): AnySQLiteColumn => user.id),
    createdAt: ts("created_at").notNull().default(sql`(unixepoch('subsec') * 1000)`),
  },
  (t) => [
    index("assets_workspace_created_idx").on(t.workspaceId, sql`${t.createdAt} desc`),
    index("assets_workspace_sha_idx").on(t.workspaceId, t.sha256),
    index("assets_project_idx").on(t.projectId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Section 6 — Agent threads / messages / runs / steps (pg twin: schema.ts §6)
// ─────────────────────────────────────────────────────────────────────────────

export const agentThreads = sqliteTable(
  "agent_threads",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("thr")),
    projectId: text("project_id")
      .notNull()
      .references((): AnySQLiteColumn => projects.id, { onDelete: "cascade" }),
    createdBy: text("created_by")
      .notNull()
      .references((): AnySQLiteColumn => user.id),
    title: text("title"),
    createdAt: ts("created_at").notNull().default(sql`(unixepoch('subsec') * 1000)`),
    updatedAt: ts("updated_at").notNull().default(sql`(unixepoch('subsec') * 1000)`),
  },
  (t) => [index("agent_threads_project_idx").on(t.projectId, sql`${t.updatedAt} desc`)],
);

export const agentMessages = sqliteTable(
  "agent_messages",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("msg")),
    threadId: text("thread_id")
      .notNull()
      .references((): AnySQLiteColumn => agentThreads.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    contentJson: jsonCol("content_json").notNull(),
    runId: text("run_id"),
    createdAt: ts("created_at").notNull().default(sql`(unixepoch('subsec') * 1000)`),
  },
  (t) => [
    index("agent_messages_thread_created_idx").on(t.threadId, sql`${t.createdAt} desc`),
    index("agent_messages_run_idx").on(t.runId),
  ],
);

export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("run")),
    threadId: text("thread_id")
      .notNull()
      .references((): AnySQLiteColumn => agentThreads.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references((): AnySQLiteColumn => projects.id, { onDelete: "cascade" }),
    model: text("model").notNull(),
    status: text("status").$type<RunStatus>().notNull().default("queued"),
    planJson: jsonCol("plan_json"),
    reservedCredits: integer("reserved_credits").notNull().default(0),
    committedCredits: integer("committed_credits").notNull().default(0),
    baseVersionId: text("base_version_id").references((): AnySQLiteColumn => projectVersions.id, {
      onDelete: "set null",
    }),
    resultVersionId: text("result_version_id"),
    appliedAt: ts("applied_at"),
    appliedBatchSha256: text("applied_batch_sha256"),
    appliedVersionId: text("applied_version_id").references(
      (): AnySQLiteColumn => projectVersions.id,
      { onDelete: "set null" },
    ),
    undoneAt: ts("undone_at"),
    undoneBy: text("undone_by").references((): AnySQLiteColumn => user.id, {
      onDelete: "set null",
    }),
    errorCode: text("error_code"),
    createdAt: ts("created_at").notNull().default(sql`(unixepoch('subsec') * 1000)`),
    completedAt: ts("completed_at"),
  },
  (t) => [
    index("agent_runs_thread_idx").on(t.threadId),
    index("agent_runs_project_idx").on(t.projectId, sql`${t.createdAt} desc`),
    index("agent_runs_status_idx").on(t.status),
  ],
);

export const agentSteps = sqliteTable(
  "agent_steps",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("stp")),
    runId: text("run_id")
      .notNull()
      .references((): AnySQLiteColumn => agentRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    tool: text("tool").notNull(),
    argsJson: jsonCol("args_json"),
    resultJson: jsonCol("result_json"),
    commandBatchJson: jsonCol("command_batch_json"),
    status: text("status").$type<StepStatus>().notNull().default("pending"),
    durationMs: integer("duration_ms"),
  },
  (t) => [uniqueIndex("agent_steps_run_seq_uniq").on(t.runId, t.seq)],
);

// ─────────────────────────────────────────────────────────────────────────────
// Section 7 — Credit ledger (pg twin: schema.ts Section 7) — append-only.
// amount / balance_after are pg bigint(mode number) → plain sqlite integer.
// ─────────────────────────────────────────────────────────────────────────────

export const creditLedger = sqliteTable(
  "credit_ledger",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("led")),
    workspaceId: text("workspace_id")
      .notNull()
      .references((): AnySQLiteColumn => organization.id, { onDelete: "cascade" }),
    kind: text("kind").$type<LedgerKind>().notNull(),
    amount: integer("amount").notNull(),
    balanceAfter: integer("balance_after").notNull(),
    runId: text("run_id"),
    renderId: text("render_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    metadata: jsonCol("metadata"),
    createdAt: ts("created_at").notNull().default(sql`(unixepoch('subsec') * 1000)`),
  },
  (t) => [
    uniqueIndex("credit_ledger_idempotency_uniq").on(t.idempotencyKey),
    index("credit_ledger_workspace_created_idx").on(t.workspaceId, sql`${t.createdAt} desc`),
    index("credit_ledger_run_idx").on(t.runId),
    index("credit_ledger_render_idx").on(t.renderId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Section 8 — Renders (pg twin: schema.ts Section 8) — the dev job queue.
// SKIP LOCKED has no sqlite equivalent — single serialized connection +
// claim-time status guard replaces it (repos/renders.ts claimNext).
// ─────────────────────────────────────────────────────────────────────────────

export const renders = sqliteTable(
  "renders",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("rdr")),
    projectId: text("project_id")
      .notNull()
      .references((): AnySQLiteColumn => projects.id, { onDelete: "cascade" }),
    versionId: text("version_id")
      .notNull()
      .references((): AnySQLiteColumn => projectVersions.id, { onDelete: "cascade" }),
    compId: text("comp_id").notNull(),
    format: text("format").notNull(),
    settingsJson: jsonCol("settings_json"),
    status: text("status").$type<RenderStatus>().notNull().default("queued"),
    objectKey: text("object_key"),
    error: text("error"),
    errorCode: text("error_code"),
    credits: integer("credits").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    heartbeatAt: ts("heartbeat_at"),
    framesDone: integer("frames_done").notNull().default(0),
    framesTotal: integer("frames_total").notNull().default(0),
    cancelRequested: integer("cancel_requested", { mode: "boolean" }).notNull().default(false),
    startedAt: ts("started_at"),
    expiresAt: ts("expires_at"),
    sizeBytes: integer("size_bytes"),
    createdBy: text("created_by")
      .notNull()
      .references((): AnySQLiteColumn => user.id),
    createdAt: ts("created_at").notNull().default(sql`(unixepoch('subsec') * 1000)`),
    completedAt: ts("completed_at"),
  },
  (t) => [
    index("renders_project_created_idx").on(t.projectId, sql`${t.createdAt} desc`),
    index("renders_status_idx").on(t.status),
    index("renders_version_idx").on(t.versionId),
    index("renders_running_heartbeat_idx").on(t.heartbeatAt).where(sql`${t.status} = 'running'`),
    index("renders_completed_expires_idx").on(t.expiresAt).where(sql`${t.status} = 'completed'`),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Section 9 — Comments (pg twin: schema.ts Section 9)
// ─────────────────────────────────────────────────────────────────────────────

export const comments = sqliteTable(
  "comments",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("cmt")),
    projectId: text("project_id")
      .notNull()
      .references((): AnySQLiteColumn => projects.id, { onDelete: "cascade" }),
    compId: text("comp_id").notNull(),
    layerId: text("layer_id"),
    timeTicks: integer("time_ticks"),
    body: text("body").notNull(),
    authorId: text("author_id").references((): AnySQLiteColumn => user.id),
    resolvedAt: ts("resolved_at"),
    parentId: text("parent_id"),
    resolvedBy: text("resolved_by"),
    guestName: text("guest_name"),
    guestEmail: text("guest_email"),
    shareTokenId: text("share_token_id"),
    createdAt: ts("created_at").notNull().default(sql`(unixepoch('subsec') * 1000)`),
  },
  (t) => [
    index("comments_project_resolved_idx").on(t.projectId, t.resolvedAt),
    index("comments_project_created_idx").on(t.projectId, sql`${t.createdAt} desc`),
    index("comments_parent_idx").on(t.parentId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Section 10 — Audit log (pg twin: schema.ts Section 10)
// ─────────────────────────────────────────────────────────────────────────────

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("aud")),
    workspaceId: text("workspace_id")
      .notNull()
      .references((): AnySQLiteColumn => organization.id, { onDelete: "cascade" }),
    actorId: text("actor_id").references((): AnySQLiteColumn => user.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonCol("metadata"),
    ip: text("ip"),
    createdAt: ts("created_at").notNull().default(sql`(unixepoch('subsec') * 1000)`),
  },
  (t) => [
    index("audit_log_workspace_created_idx").on(t.workspaceId, sql`${t.createdAt} desc`),
    index("audit_log_target_idx").on(t.targetType, t.targetId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Section 11 — Billing, user settings, webhook idempotency (pg twin: §11)
// ─────────────────────────────────────────────────────────────────────────────

export const stripeCustomers = sqliteTable(
  "stripe_customers",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("sc")),
    organizationId: text("organization_id")
      .notNull()
      .references((): AnySQLiteColumn => organization.id, { onDelete: "cascade" }),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    cardFingerprint: text("card_fingerprint"),
    createdAt: ts("created_at").notNull().default(sql`(unixepoch('subsec') * 1000)`),
  },
  (t) => [
    uniqueIndex("stripe_customers_organization_uniq").on(t.organizationId),
    index("stripe_customers_fingerprint_idx").on(t.cardFingerprint),
  ],
);

export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("sub")),
    organizationId: text("organization_id")
      .notNull()
      .references((): AnySQLiteColumn => organization.id, { onDelete: "cascade" }),
    planId: text("plan_id").$type<PlanId>().notNull(),
    status: text("status").$type<SubscriptionStatus>().notNull(),
    stripeSubscriptionId: text("stripe_subscription_id"),
    currentPeriodEnd: ts("current_period_end"),
    trialEnd: ts("trial_end"),
    cancelAtPeriodEnd: integer("cancel_at_period_end", { mode: "boolean" })
      .notNull()
      .default(false),
    graceEnd: ts("grace_end"),
    updatedAt: ts("updated_at")
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`)
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("subscriptions_organization_uniq").on(t.organizationId),
    index("subscriptions_status_idx").on(t.status),
  ],
);

export const invoices = sqliteTable(
  "invoices",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("inv")),
    organizationId: text("organization_id")
      .notNull()
      .references((): AnySQLiteColumn => organization.id, { onDelete: "cascade" }),
    stripeInvoiceId: text("stripe_invoice_id").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull(),
    status: text("status").$type<InvoiceStatus>().notNull(),
    periodStart: ts("period_start"),
    periodEnd: ts("period_end"),
    hostedUrl: text("hosted_url"),
    pdfUrl: text("pdf_url"),
    createdAt: ts("created_at").notNull().default(sql`(unixepoch('subsec') * 1000)`),
  },
  (t) => [
    uniqueIndex("invoices_workspace_stripe_uniq").on(t.organizationId, t.stripeInvoiceId),
    index("invoices_workspace_created_idx").on(t.organizationId, sql`${t.createdAt} desc`),
  ],
);

export const userSettings = sqliteTable("user_settings", {
  userId: text("user_id")
    .primaryKey()
    .references((): AnySQLiteColumn => user.id, { onDelete: "cascade" }),
  autoApplyEnabled: integer("auto_apply_enabled", { mode: "boolean" }).notNull().default(true),
  updatedAt: ts("updated_at")
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`)
    .$onUpdate(() => new Date()),
});

export const webhookEvents = sqliteTable(
  "webhook_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("whe")),
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    eventType: text("event_type"),
    payloadJson: jsonCol("payload_json"),
    processedAt: ts("processed_at").notNull().default(sql`(unixepoch('subsec') * 1000)`),
  },
  (t) => [uniqueIndex("webhook_events_provider_event_uniq").on(t.provider, t.eventId)],
);

// ─────────────────────────────────────────────────────────────────────────────
// Section 12 — Share links + presence (pg twin: schema.ts Section 12)
// ─────────────────────────────────────────────────────────────────────────────

export const shareTokens = sqliteTable(
  "share_tokens",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("shr")),
    projectId: text("project_id")
      .notNull()
      .references((): AnySQLiteColumn => projects.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    passwordHash: text("password_hash"),
    expiresAt: ts("expires_at"),
    revokedAt: ts("revoked_at"),
    createdBy: text("created_by")
      .notNull()
      .references((): AnySQLiteColumn => user.id),
    createdAt: ts("created_at").notNull().default(sql`(unixepoch('subsec') * 1000)`),
  },
  (t) => [
    uniqueIndex("share_tokens_token_hash_uniq").on(t.tokenHash),
    index("share_tokens_project_idx").on(t.projectId, sql`${t.createdAt} desc`),
  ],
);

export const presenceHeartbeats = sqliteTable(
  "presence_heartbeats",
  {
    projectId: text("project_id")
      .notNull()
      .references((): AnySQLiteColumn => projects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references((): AnySQLiteColumn => user.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    compId: text("comp_id"),
    playheadTicks: integer("playhead_ticks"),
    lastSeenAt: ts("last_seen_at").notNull().default(sql`(unixepoch('subsec') * 1000)`),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] })],
);

// ─────────────────────────────────────────────────────────────────────────────
// Section 13 — Drizzle relations (mirror of the pg twin Section 13; the twin
// test does not compare these — they exist so db.query.* works on sqlite too).
// ─────────────────────────────────────────────────────────────────────────────

export const userRelations = relations(user, ({ many, one }) => ({
  sessions: many(session),
  accounts: many(account),
  memberships: many(member),
  settings: one(userSettings, {
    fields: [user.id],
    references: [userSettings.userId],
  }),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));

export const organizationRelations = relations(organization, ({ many, one }) => ({
  members: many(member),
  invitations: many(invitation),
  projects: many(projects),
  assets: many(assets),
  ledgerEntries: many(creditLedger),
  auditEntries: many(auditLog),
  stripeCustomer: one(stripeCustomers, {
    fields: [organization.id],
    references: [stripeCustomers.organizationId],
  }),
  subscription: one(subscriptions, {
    fields: [organization.id],
    references: [subscriptions.organizationId],
  }),
  invoices: many(invoices),
}));

export const memberRelations = relations(member, ({ one }) => ({
  organization: one(organization, {
    fields: [member.organizationId],
    references: [organization.id],
  }),
  user: one(user, { fields: [member.userId], references: [user.id] }),
}));

export const invitationRelations = relations(invitation, ({ one }) => ({
  organization: one(organization, {
    fields: [invitation.organizationId],
    references: [organization.id],
  }),
  inviter: one(user, { fields: [invitation.inviterId], references: [user.id] }),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  workspace: one(organization, {
    fields: [projects.workspaceId],
    references: [organization.id],
  }),
  shareTokens: many(shareTokens),
  presence: many(presenceHeartbeats),
  currentVersion: one(projectVersions, {
    fields: [projects.currentVersionId],
    references: [projectVersions.id],
    relationName: "current",
  }),
  versions: many(projectVersions, { relationName: "history" }),
  lease: one(projectLeases, {
    fields: [projects.id],
    references: [projectLeases.projectId],
    relationName: "lease",
  }),
  assets: many(assets),
  threads: many(agentThreads),
  runs: many(agentRuns),
  renders: many(renders),
  comments: many(comments),
  creator: one(user, { fields: [projects.createdBy], references: [user.id] }),
}));

export const projectVersionsRelations = relations(projectVersions, ({ one, many }) => ({
  project: one(projects, {
    fields: [projectVersions.projectId],
    references: [projects.id],
    relationName: "history",
  }),
  parent: one(projectVersions, {
    fields: [projectVersions.parentVersionId],
    references: [projectVersions.id],
    relationName: "parent",
  }),
  currentFor: many(projects, { relationName: "current" }),
  creator: one(user, { fields: [projectVersions.createdBy], references: [user.id] }),
}));

export const projectLeasesRelations = relations(projectLeases, ({ one }) => ({
  project: one(projects, {
    fields: [projectLeases.projectId],
    references: [projects.id],
    relationName: "lease",
  }),
  holder: one(user, { fields: [projectLeases.userId], references: [user.id] }),
}));

export const assetsRelations = relations(assets, ({ one }) => ({
  workspace: one(organization, {
    fields: [assets.workspaceId],
    references: [organization.id],
  }),
  project: one(projects, { fields: [assets.projectId], references: [projects.id] }),
  creator: one(user, { fields: [assets.createdBy], references: [user.id] }),
}));

export const agentThreadsRelations = relations(agentThreads, ({ one, many }) => ({
  project: one(projects, {
    fields: [agentThreads.projectId],
    references: [projects.id],
  }),
  creator: one(user, { fields: [agentThreads.createdBy], references: [user.id] }),
  messages: many(agentMessages),
  runs: many(agentRuns),
}));

export const agentMessagesRelations = relations(agentMessages, ({ one }) => ({
  thread: one(agentThreads, {
    fields: [agentMessages.threadId],
    references: [agentThreads.id],
  }),
}));

export const agentRunsRelations = relations(agentRuns, ({ one, many }) => ({
  thread: one(agentThreads, {
    fields: [agentRuns.threadId],
    references: [agentThreads.id],
  }),
  project: one(projects, {
    fields: [agentRuns.projectId],
    references: [projects.id],
  }),
  steps: many(agentSteps),
  baseVersion: one(projectVersions, {
    relationName: "base",
    fields: [agentRuns.baseVersionId],
    references: [projectVersions.id],
  }),
  appliedVersion: one(projectVersions, {
    relationName: "applied",
    fields: [agentRuns.appliedVersionId],
    references: [projectVersions.id],
  }),
  undoneByUser: one(user, {
    fields: [agentRuns.undoneBy],
    references: [user.id],
  }),
}));

export const agentStepsRelations = relations(agentSteps, ({ one }) => ({
  run: one(agentRuns, { fields: [agentSteps.runId], references: [agentRuns.id] }),
}));

export const creditLedgerRelations = relations(creditLedger, ({ one }) => ({
  workspace: one(organization, {
    fields: [creditLedger.workspaceId],
    references: [organization.id],
  }),
}));

export const rendersRelations = relations(renders, ({ one }) => ({
  project: one(projects, { fields: [renders.projectId], references: [projects.id] }),
  version: one(projectVersions, {
    fields: [renders.versionId],
    references: [projectVersions.id],
  }),
  creator: one(user, { fields: [renders.createdBy], references: [user.id] }),
}));

export const commentsRelations = relations(comments, ({ one }) => ({
  project: one(projects, { fields: [comments.projectId], references: [projects.id] }),
  author: one(user, { fields: [comments.authorId], references: [user.id] }),
}));

export const shareTokensRelations = relations(shareTokens, ({ one }) => ({
  project: one(projects, {
    fields: [shareTokens.projectId],
    references: [projects.id],
  }),
  creator: one(user, { fields: [shareTokens.createdBy], references: [user.id] }),
}));

export const presenceHeartbeatsRelations = relations(presenceHeartbeats, ({ one }) => ({
  project: one(projects, {
    fields: [presenceHeartbeats.projectId],
    references: [projects.id],
  }),
  user: one(user, { fields: [presenceHeartbeats.userId], references: [user.id] }),
}));

export const auditLogRelations = relations(auditLog, ({ one }) => ({
  workspace: one(organization, {
    fields: [auditLog.workspaceId],
    references: [organization.id],
  }),
  actor: one(user, { fields: [auditLog.actorId], references: [user.id] }),
}));

export const stripeCustomersRelations = relations(stripeCustomers, ({ one }) => ({
  workspace: one(organization, {
    fields: [stripeCustomers.organizationId],
    references: [organization.id],
  }),
}));

export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
  workspace: one(organization, {
    fields: [subscriptions.organizationId],
    references: [organization.id],
  }),
}));

export const invoicesRelations = relations(invoices, ({ one }) => ({
  workspace: one(organization, {
    fields: [invoices.organizationId],
    references: [organization.id],
  }),
}));

export const userSettingsRelations = relations(userSettings, ({ one }) => ({
  user: one(user, { fields: [userSettings.userId], references: [user.id] }),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Section 14 — Inferred domain types (same names as the pg twin; the twin test
// in tests/sqlite/twin.test.ts asserts two-way structural equivalence with
// schema.ts so repos can run against either dialect with zero type drift).
// ─────────────────────────────────────────────────────────────────────────────

export type User = typeof user.$inferSelect;
export type Session = typeof session.$inferSelect;
export type Organization = typeof organization.$inferSelect;
export type Member = typeof member.$inferSelect;
export type Invitation = typeof invitation.$inferSelect;
export type ApiKey = typeof apiKey.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type ProjectVersion = typeof projectVersions.$inferSelect;
export type ProjectLease = typeof projectLeases.$inferSelect;
export type Asset = typeof assets.$inferSelect;
export type AgentThread = typeof agentThreads.$inferSelect;
export type AgentMessage = typeof agentMessages.$inferSelect;
export type AgentRun = typeof agentRuns.$inferSelect;
export type AgentStep = typeof agentSteps.$inferSelect;
export type LedgerEntry = typeof creditLedger.$inferSelect;
export type Render = typeof renders.$inferSelect;
export type Comment = typeof comments.$inferSelect;
export type AuditLogEntry = typeof auditLog.$inferSelect;
export type StripeCustomer = typeof stripeCustomers.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
export type Invoice = typeof invoices.$inferSelect;
export type UserSettings = typeof userSettings.$inferSelect;
export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type ShareToken = typeof shareTokens.$inferSelect;
export type PresenceHeartbeat = typeof presenceHeartbeats.$inferSelect;
