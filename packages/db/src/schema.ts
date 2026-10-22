import { randomUUID } from "node:crypto";
import { relations } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  char,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { createId } from "./ids.js";

/**
 * Studio schema (Postgres, drizzle-orm) — PRODUCT_ARCHITECTURE §9.1 (all tables),
 * §9.3 (versions/conflict), §8.8 (credit ledger) + Better Auth 1.7 core/org/api-key/admin
 * plugin tables, verified against `getSchema()` of the installed better-auth.
 *
 * Conventions:
 * - text primary keys (`${prefix}_${uuid}`) generated app-side; timestamps with
 *   time zone (JS Date mode).
 * - Column names are snake_case; TS property names are camelCase.
 *   EXCEPTION: Better Auth tables — property names MUST match the plugin model
 *   field names exactly (the drizzle adapter addresses columns by property name).
 * - Tenant scoping: content tables carry `workspace_id` (or scope through
 *   `project_id` -> projects.workspace_id). Cross-tenant access must read as
 *   "not found" (§12.1) — enforced in `src/repos/*`, not here.
 *
 * Decisions (documented for reviewers):
 * - `project_versions` is NOT unique on (project_id, sha256): re-saving identical
 *   content is a legitimate action and §9.3 forbids rewriting history; the
 *   object store dedupes the blob itself (§9.2 content-addressed). The composite
 *   index exists for fast "is this content already stored" lookups.
 * - `credit_ledger` is append-only by convention; balance is SUM(amount) under a
 *   per-workspace advisory lock (see src/repos/ledger.ts). `amount` and
 *   `balance_after` are int64 (bigint, JS-number mode): D-12 keeps the units as
 *   integer µc, and a Studio monthly grant (10_000_000_000 µc) overflows int32
 *   (max 2_147_483_647) — migration 0003 widened both columns; JS numbers stay
 *   exact up to 2^53, far above any µc balance (M6-A HIGH finding).
 * - `renders`, `comments` and `agent_*` scope through `project_id` per §9.1; the
 *   repos join projects to enforce tenancy.
 * - `projects.current_version_id` and `project_versions.parent_version_id` are
 *   plain text columns WITHOUT FK constraints: they form a circular reference
 *   pair with `project_versions.project_id`, and both are written only inside
 *   repo transactions that hold the project row lock (src/repos/versions.ts),
 *   so integrity is enforced where the conflict rules live (§9.3) without
 *   making schema-level DELETE semantics impossible.
 * - M5 apply/undo (§M5.4/§M5.5): the plan lifecycle (proposed → applied →
 *   undone) lives on `agent_runs` — `applied_at`, `applied_batch_sha256`,
 *   `applied_version_id`, `undone_at`, `undone_by` — because `project_versions`
 *   is IMMUTABLE (§9.3): applying creates ONE version, undoing marks the run
 *   and NEVER deletes or rewrites a version row. Unlike the circular pair
 *   above, `agent_runs.base_version_id` / `applied_version_id` DO carry FKs to
 *   `project_versions.id` (no cycle: `project_versions.agent_run_id` stays a
 *   plain-text back-reference). All three FKs are `ON DELETE SET NULL` so a
 *   cascading project delete never trips over cross-reference ordering
 *   (mirrors `audit_log.actor_id` / `assets.project_id`). Same-project scope is
 *   enforced in repos (a version of another project reads as NOT_FOUND).
 */

const ts = (name: string) => timestamp(name, { withTimezone: true });

// ─────────────────────────────────────────────────────────────────────────────
// Section 1 — Better Auth core tables (user / session / account / verification)
// Property names are better-auth model field names (adapter requirement).
// ─────────────────────────────────────────────────────────────────────────────

export const user = pgTable(
  "user",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    // admin plugin (global/staff role — distinct from workspace roles):
    role: text("role"),
    banned: boolean("banned").default(false),
    banReason: text("ban_reason"),
    banExpires: ts("ban_expires"),
  },
  (t) => [index("user_email_idx").on(t.email)],
);

export const session = pgTable(
  "session",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    expiresAt: ts("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references((): AnyPgColumn => user.id, { onDelete: "cascade" }),
    // organization plugin: last active workspace for this session
    activeOrganizationId: text("active_organization_id"),
    // admin plugin:
    impersonatedBy: text("impersonated_by"),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references((): AnyPgColumn => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: ts("access_token_expires_at"),
    refreshTokenExpiresAt: ts("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

// ─────────────────────────────────────────────────────────────────────────────
// Section 2 — Better Auth organization plugin (workspaces)
// Workspace == organization (ADR-0003). Roles: owner | admin | editor | viewer.
// ─────────────────────────────────────────────────────────────────────────────

export const organization = pgTable(
  "organization",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    logo: text("logo"),
    createdAt: ts("created_at").notNull().defaultNow(),
    // better-auth serializes metadata objects to JSON strings itself
    metadata: text("metadata"),
  },
  (t) => [uniqueIndex("organization_slug_uniq").on(t.slug)],
);

export const member = pgTable(
  "member",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references((): AnyPgColumn => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references((): AnyPgColumn => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("member_organization_idx").on(t.organizationId),
    index("member_user_idx").on(t.userId),
  ],
);

export const invitation = pgTable(
  "invitation",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references((): AnyPgColumn => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").notNull().default("pending"),
    expiresAt: ts("expires_at").notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references((): AnyPgColumn => user.id, { onDelete: "cascade" }),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("invitation_organization_idx").on(t.organizationId),
    index("invitation_email_idx").on(t.email),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Section 3 — Better Auth apiKey plugin (hashed, revocable API keys)
// Table name is the plugin default `apikey`; `referenceId` is the user id.
// ─────────────────────────────────────────────────────────────────────────────

export const apiKey = pgTable(
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
    enabled: boolean("enabled").default(true),
    rateLimitEnabled: boolean("rate_limit_enabled").default(true),
    rateLimitTimeWindow: integer("rate_limit_time_window").default(86_400_000),
    rateLimitMax: integer("rate_limit_max").default(10),
    requestCount: integer("request_count").default(0),
    remaining: integer("remaining"),
    lastRequest: ts("last_request"),
    expiresAt: ts("expires_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    permissions: text("permissions"),
    metadata: text("metadata"),
  },
  (t) => [index("apikey_reference_idx").on(t.referenceId), index("apikey_key_idx").on(t.key)],
);

// ─────────────────────────────────────────────────────────────────────────────
// Section 4 — Projects, versions, leases (§9.1, §6.4, §9.3)
// ─────────────────────────────────────────────────────────────────────────────

export const projects = pgTable(
  "projects",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("prj")),
    workspaceId: text("workspace_id")
      .notNull()
      .references((): AnyPgColumn => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    thumbnailUrl: text("thumbnail_url"),
    currentVersionId: text("current_version_id"),
    createdBy: text("created_by")
      .notNull()
      .references((): AnyPgColumn => user.id),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    deletedAt: ts("deleted_at"), // soft delete
  },
  (t) => [
    index("projects_workspace_updated_idx").on(t.workspaceId, t.updatedAt.desc()),
    uniqueIndex("projects_workspace_slug_uniq").on(t.workspaceId, t.slug),
    index("projects_current_version_idx").on(t.currentVersionId),
  ],
);

export const projectVersions = pgTable(
  "project_versions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("ver")),
    projectId: text("project_id")
      .notNull()
      .references((): AnyPgColumn => projects.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    parentVersionId: text("parent_version_id"),
    objectKey: text("object_key").notNull(),
    sha256: text("sha256").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    label: text("label"),
    agentRunId: text("agent_run_id"),
    createdBy: text("created_by")
      .notNull()
      .references((): AnyPgColumn => user.id),
    createdAt: ts("created_at").notNull().defaultNow(),
    // IMMUTABLE: no update paths exist in the repository layer (§9.3).
  },
  (t) => [
    index("project_versions_project_idx").on(t.projectId, t.version.desc()),
    index("project_versions_project_sha_idx").on(t.projectId, t.sha256),
    index("project_versions_parent_idx").on(t.parentVersionId),
  ],
);

export const projectLeases = pgTable("project_leases", {
  projectId: text("project_id")
    .primaryKey()
    .references((): AnyPgColumn => projects.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references((): AnyPgColumn => user.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull(),
  expiresAt: ts("expires_at").notNull(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 5 — Assets (workspace library + optional project scope) (§9.1)
// ─────────────────────────────────────────────────────────────────────────────

export const assets = pgTable(
  "assets",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("ast")),
    workspaceId: text("workspace_id")
      .notNull()
      .references((): AnyPgColumn => organization.id, { onDelete: "cascade" }),
    projectId: text("project_id").references((): AnyPgColumn => projects.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    objectKey: text("object_key").notNull(),
    width: integer("width"),
    height: integer("height"),
    durationTicks: bigint("duration_ticks", { mode: "number" }),
    createdBy: text("created_by")
      .notNull()
      .references((): AnyPgColumn => user.id),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("assets_workspace_created_idx").on(t.workspaceId, t.createdAt.desc()),
    index("assets_workspace_sha_idx").on(t.workspaceId, t.sha256),
    index("assets_project_idx").on(t.projectId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Section 6 — Agent threads / messages / runs / steps (§9.1, §8)
// ─────────────────────────────────────────────────────────────────────────────

export const agentThreads = pgTable(
  "agent_threads",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("thr")),
    projectId: text("project_id")
      .notNull()
      .references((): AnyPgColumn => projects.id, { onDelete: "cascade" }),
    createdBy: text("created_by")
      .notNull()
      .references((): AnyPgColumn => user.id),
    title: text("title"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("agent_threads_project_idx").on(t.projectId, t.updatedAt.desc())],
);

export const agentMessages = pgTable(
  "agent_messages",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("msg")),
    threadId: text("thread_id")
      .notNull()
      .references((): AnyPgColumn => agentThreads.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    contentJson: jsonb("content_json").notNull(),
    runId: text("run_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("agent_messages_thread_created_idx").on(t.threadId, t.createdAt.desc()),
    index("agent_messages_run_idx").on(t.runId),
  ],
);

export type RunStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("run")),
    threadId: text("thread_id")
      .notNull()
      .references((): AnyPgColumn => agentThreads.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references((): AnyPgColumn => projects.id, { onDelete: "cascade" }),
    model: text("model").notNull(),
    status: text("status").$type<RunStatus>().notNull().default("queued"),
    planJson: jsonb("plan_json"),
    reservedCredits: integer("reserved_credits").notNull().default(0),
    committedCredits: integer("committed_credits").notNull().default(0),
    /** Version the client was on WHEN the plan was proposed (M5.5 re-apply rule). */
    baseVersionId: text("base_version_id").references((): AnyPgColumn => projectVersions.id, {
      onDelete: "set null",
    }),
    resultVersionId: text("result_version_id"),
    // M5 apply/undo (§M5.4/§M5.5) — plan lifecycle columns. A run is "proposed"
    // until appliedAt is set; undo marks undoneAt/undoneBy and NEVER touches the
    // (immutable, §9.3) project_versions row the apply created.
    appliedAt: ts("applied_at"),
    appliedBatchSha256: char("applied_batch_sha256", { length: 64 }),
    appliedVersionId: text("applied_version_id").references((): AnyPgColumn => projectVersions.id, {
      onDelete: "set null",
    }),
    undoneAt: ts("undone_at"),
    undoneBy: text("undone_by").references((): AnyPgColumn => user.id, {
      onDelete: "set null",
    }),
    errorCode: text("error_code"),
    createdAt: ts("created_at").notNull().defaultNow(),
    completedAt: ts("completed_at"),
  },
  (t) => [
    index("agent_runs_thread_idx").on(t.threadId),
    index("agent_runs_project_idx").on(t.projectId, t.createdAt.desc()),
    index("agent_runs_status_idx").on(t.status),
  ],
);

export type StepStatus = "pending" | "running" | "success" | "failed";

export const agentSteps = pgTable(
  "agent_steps",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("stp")),
    runId: text("run_id")
      .notNull()
      .references((): AnyPgColumn => agentRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    tool: text("tool").notNull(),
    argsJson: jsonb("args_json"),
    resultJson: jsonb("result_json"),
    commandBatchJson: jsonb("command_batch_json"),
    status: text("status").$type<StepStatus>().notNull().default("pending"),
    durationMs: integer("duration_ms"),
  },
  (t) => [uniqueIndex("agent_steps_run_seq_uniq").on(t.runId, t.seq)],
);

// ─────────────────────────────────────────────────────────────────────────────
// Section 7 — Credit ledger (§8.8, §10.2) — append-only
//   grant   +N   purchase / plan allowance / top-up pack
//   adjust  ±N   manual corrections, storage overage, promos (may be negative)
//   reserve −N   hold at run start (pessimistic: balance drops immediately)
//   commit  −M   actual cost at settle time (bounded by the run's hold)
//   refund  +R   release of an unspent hold (full refund on failure/cancel)
// balance = SUM(amount); writers serialize per workspace via pg_advisory_xact_lock.
// ─────────────────────────────────────────────────────────────────────────────

export type LedgerKind = "grant" | "reserve" | "commit" | "refund" | "adjust";

export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("led")),
    workspaceId: text("workspace_id")
      .notNull()
      .references((): AnyPgColumn => organization.id, { onDelete: "cascade" }),
    kind: text("kind").$type<LedgerKind>().notNull(),
    amount: bigint("amount", { mode: "number" }).notNull(), // signed µc — int64 (M6-E; int32 overflowed at Studio scale)
    balanceAfter: bigint("balance_after", { mode: "number" }).notNull(), // running SUM — int64 (widened with amount, migration 0003)
    runId: text("run_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    metadata: jsonb("metadata"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("credit_ledger_idempotency_uniq").on(t.idempotencyKey),
    index("credit_ledger_workspace_created_idx").on(t.workspaceId, t.createdAt.desc()),
    index("credit_ledger_run_idx").on(t.runId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Section 8 — Renders (§9.1) — queued→running→completed|failed|cancelled
// ─────────────────────────────────────────────────────────────────────────────

export type RenderStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export const renders = pgTable(
  "renders",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("rdr")),
    projectId: text("project_id")
      .notNull()
      .references((): AnyPgColumn => projects.id, { onDelete: "cascade" }),
    compId: text("comp_id").notNull(),
    format: text("format").notNull(),
    settingsJson: jsonb("settings_json"),
    status: text("status").$type<RenderStatus>().notNull().default("queued"),
    objectKey: text("object_key"),
    error: text("error"),
    credits: integer("credits").notNull().default(0),
    createdBy: text("created_by")
      .notNull()
      .references((): AnyPgColumn => user.id),
    createdAt: ts("created_at").notNull().defaultNow(),
    completedAt: ts("completed_at"),
  },
  (t) => [
    index("renders_project_created_idx").on(t.projectId, t.createdAt.desc()),
    index("renders_status_idx").on(t.status),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Section 9 — Comments (review notes anchored to comp/layer/time) (§9.1, §11)
// ─────────────────────────────────────────────────────────────────────────────

export const comments = pgTable(
  "comments",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("cmt")),
    projectId: text("project_id")
      .notNull()
      .references((): AnyPgColumn => projects.id, { onDelete: "cascade" }),
    compId: text("comp_id").notNull(),
    layerId: text("layer_id"),
    timeTicks: bigint("time_ticks", { mode: "number" }),
    body: text("body").notNull(),
    authorId: text("author_id")
      .notNull()
      .references((): AnyPgColumn => user.id),
    resolvedAt: ts("resolved_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("comments_project_resolved_idx").on(t.projectId, t.resolvedAt),
    index("comments_project_created_idx").on(t.projectId, t.createdAt.desc()),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Section 10 — Audit log (§7.1: every role change / invite / key event is audited)
// ─────────────────────────────────────────────────────────────────────────────

export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("aud")),
    workspaceId: text("workspace_id")
      .notNull()
      .references((): AnyPgColumn => organization.id, { onDelete: "cascade" }),
    actorId: text("actor_id").references((): AnyPgColumn => user.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata"),
    ip: text("ip"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("audit_log_workspace_created_idx").on(t.workspaceId, t.createdAt.desc()),
    index("audit_log_target_idx").on(t.targetType, t.targetId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Section 11 — Billing, user settings, webhook idempotency (§M6)
//
// Decisions (documented for reviewers):
// - One live subscription per workspace: UNIQUE(organization_id) on
//   `subscriptions` — state is UPSERTED on that key (repos/subscriptions.ts),
//   never duplicated per billing cycle; history lives in `invoices`.
// - D-4: the trial is a subscription STATE, not a plan row — a trialing
//   workspace carries plan_id='starter' + status='trialing'. plan_id='trial'
//   is the pre-checkout placeholder until Stripe confirms the Starter
//   subscription (BP M6 task 1 wording). Pricing/entitlements live in
//   `@studio/config`; this table stores only the persisted state.
// - BP M6.2: cancel NEVER deletes work. Cancellation is
//   status='canceled' / cancel_at_period_end=true — no cascade ever reaches
//   projects, versions or ledger rows from this section (all FKs cascade
//   FROM organization only, i.e. workspace deletion cleans billing rows).
// - `invoices.amount_cents` is MONEY (Stripe currency minor units, e.g. US
//   cents) — a different unit from the credit ledger's integer microcredits
//   (D-12); no conversion happens in this package.
// - One Stripe customer per workspace: UNIQUE(organization_id) on
//   `stripe_customers`. `card_fingerprint` is nullable and deliberately NOT
//   unique — the one-trial-per-card abuse rule (BP M6 task 5) is a lookup
//   (`cardFingerprintUsed`), not a DB constraint, because the same card may
//   legitimately pay for several workspaces.
// - `webhook_events` is the durable Stripe webhook idempotency store (law #4,
//   BP M6 task 2): UNIQUE(provider, event_id) makes replays and concurrent
//   deliveries resolve to `seen`. It is intentionally NOT tenant-scoped — it
//   stores no tenant content (only provider event ids + payloads for audit).
// - `user_settings` is per-USER (not per-workspace): auto_apply_enabled
//   defaults to FALSE (the M5-O seam — agent edits are propose-only until the
//   user opts in) and is enforced server-side by the apply route.
// ─────────────────────────────────────────────────────────────────────────────

export type PlanId = "trial" | "starter" | "pro" | "studio";

export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "incomplete"
  | "grace";

export type InvoiceStatus = "draft" | "open" | "paid" | "void" | "uncollectible";

export const stripeCustomers = pgTable(
  "stripe_customers",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("sc")),
    organizationId: text("organization_id")
      .notNull()
      .references((): AnyPgColumn => organization.id, { onDelete: "cascade" }),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    /** Stripe card fingerprint — the one-trial-per-card key (BP M6 task 5). */
    cardFingerprint: text("card_fingerprint"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("stripe_customers_organization_uniq").on(t.organizationId),
    index("stripe_customers_fingerprint_idx").on(t.cardFingerprint),
  ],
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("sub")),
    organizationId: text("organization_id")
      .notNull()
      .references((): AnyPgColumn => organization.id, { onDelete: "cascade" }),
    planId: text("plan_id").$type<PlanId>().notNull(),
    status: text("status").$type<SubscriptionStatus>().notNull(),
    stripeSubscriptionId: text("stripe_subscription_id"),
    currentPeriodEnd: ts("current_period_end"),
    trialEnd: ts("trial_end"),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    /** Set when a past-due subscription enters the dunning grace window. */
    graceEnd: ts("grace_end"),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("subscriptions_organization_uniq").on(t.organizationId),
    index("subscriptions_status_idx").on(t.status),
  ],
);

export const invoices = pgTable(
  "invoices",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("inv")),
    organizationId: text("organization_id")
      .notNull()
      .references((): AnyPgColumn => organization.id, { onDelete: "cascade" }),
    stripeInvoiceId: text("stripe_invoice_id").notNull(),
    /** Money, Stripe minor units (cents) — NOT credits; credit ledger is D-12 µc. */
    amountCents: integer("amount_cents").notNull(),
    /** ISO 4217 lowercase 3-letter code, e.g. 'usd'. */
    currency: char("currency", { length: 3 }).notNull(),
    status: text("status").$type<InvoiceStatus>().notNull(),
    periodStart: ts("period_start"),
    periodEnd: ts("period_end"),
    hostedUrl: text("hosted_url"),
    pdfUrl: text("pdf_url"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("invoices_workspace_stripe_uniq").on(t.organizationId, t.stripeInvoiceId),
    index("invoices_workspace_created_idx").on(t.organizationId, t.createdAt.desc()),
  ],
);

export const userSettings = pgTable("user_settings", {
  userId: text("user_id")
    .primaryKey()
    .references((): AnyPgColumn => user.id, { onDelete: "cascade" }),
  /** M5-O seam: OFF by default — agent edits stay propose-only until opt-in. */
  autoApplyEnabled: boolean("auto_apply_enabled").notNull().default(false),
  updatedAt: ts("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("whe")),
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    eventType: text("event_type"),
    payloadJson: jsonb("payload_json"),
    processedAt: ts("processed_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("webhook_events_provider_event_uniq").on(t.provider, t.eventId)],
);

// ─────────────────────────────────────────────────────────────────────────────
// Section 12 — Drizzle relations (main joins)
// `projects.currentVersionId` vs `project_versions.projectId` are two distinct
// edges between the same tables → disambiguated with relationName.
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
  // billing edges (§M6): unique-FK one-to-ones, house style = one() both sides
  // (mirrors projects.lease), invoices stay one-to-many.
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
  // M5 apply/undo edges (two edges to project_versions → relationName each).
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
  creator: one(user, { fields: [renders.createdBy], references: [user.id] }),
}));

export const commentsRelations = relations(comments, ({ one }) => ({
  project: one(projects, { fields: [comments.projectId], references: [projects.id] }),
  author: one(user, { fields: [comments.authorId], references: [user.id] }),
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
// Section 13 — Inferred domain types
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
