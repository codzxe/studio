// @studio/db — agent runs, steps and SSE run events. Owner: W1-E (docs/AGENTS.md).
//
// Spec anchors:
//   §5.1  run state machine (queued → … → succeeded|succeeded_with_warnings|failed|cancelled)
//   §5.5  planner output contract (schema-validated JSON plan)
//   §12.1 agent_runs / agent_steps / run_events tables
//   §13.2 SSE event types — seq + Last-Event-ID resume, run_events is the backfill store
//   §3.4  idempotency — every run has a key; retries never double-charge or double-apply
//
// Cross-file foreign keys (organizations / users / documents, owned by other build
// agents) are intentionally not declared here; tenant scoping is enforced in the
// repository layer (§12.2). Only the intra-file run references are DB-enforced.

// W2-Q id unification: every auth/content/billing table points at runs with TEXT
// columns (commands.run_id, credit_ledger.run_id, credit_reservations.run_id) and
// the auth tables own TEXT ids (Better Auth pattern), so the run tables use text
// ids with the same gen_random_uuid()::text default as content.ts — joins and
// FKs across tables never need uuid casts.

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

/** §5.1 — deterministic state machine: non-terminal phases + terminal states. */
export const RUN_STATUSES = [
  "queued",
  "planning",
  "executing",
  "observing",
  "rendering",
  "validating",
  "critiquing",
  "repairing",
  "finalizing",
  "succeeded",
  "succeeded_with_warnings",
  "failed",
  "cancelled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** §5.1 — phases an individual step can belong to (terminal states are run-level only). */
export const RUN_PHASES = [
  "planning",
  "executing",
  "observing",
  "rendering",
  "validating",
  "critiquing",
  "repairing",
  "finalizing",
] as const;
export type RunPhase = (typeof RUN_PHASES)[number];

/** §13.2 — event types carried on the run SSE stream; clients dedupe by seq. */
export const RUN_EVENT_TYPES = [
  "run.queued",
  "run.started",
  "run.plan",
  "step.started",
  "step.finished",
  "preview.updated",
  "validate.report",
  "critique.report",
  "credits.reserved",
  "credits.charged",
  "run.succeeded",
  "run.failed",
  "run.cancelled",
] as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

/** Typed error envelope (§13.3) — never a raw string, stack trace or internal id. */
export interface RunError {
  code: string;
  message: string;
  hint?: string;
  retryable?: boolean;
}

/** Per-model usage rollup for a run (§5.3 routing observability); keyed by model id. */
export interface ModelCallUsage {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  cacheHits: number;
  costMicroUsd: number;
}

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
    // §12.2 tenant root — every query on this table is scoped by organization_id.
    organizationId: text("organization_id").notNull(),
    documentId: text("document_id").notNull(),
    userId: text("user_id").notNull(),
    prompt: text("prompt").notNull(),
    tier: text("tier").notNull(), // §5.2 tier budgets (quick|standard|complex|premium|max|image)
    status: text("status").$type<RunStatus>().notNull().default("queued"), // §5.1
    // §3.4 / §13: unique per run; a retried create must map to the same run row.
    idempotencyKey: text("idempotency_key").notNull().unique(),
    plan: jsonb("plan"), // §5.5 planner output, schema-validated before any engine command
    revisionBefore: integer("revision_before").notNull(), // §5.6 revision at run start
    revisionAfter: integer("revision_after"), // set at finalization
    creditsReserved: integer("credits_reserved").notNull().default(0), // §14 hold
    creditsCharged: integer("credits_charged").notNull().default(0), // committed cost
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    cacheHits: integer("cache_hits").notNull().default(0), // §5.3 cache-hit target
    modelCalls: jsonb("model_calls")
      .$type<Record<string, ModelCallUsage>>()
      .notNull()
      .default({}),
    costMicroUsd: bigint("cost_micro_usd", { mode: "number" }).notNull().default(0),
    error: jsonb("error").$type<RunError>(), // terminal failures only (§13.3 envelope)
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("agent_runs_org_created_idx").on(table.organizationId, table.createdAt.desc()),
    index("agent_runs_document_created_idx").on(table.documentId, table.createdAt.desc()),
    index("agent_runs_status_idx").on(table.status), // §12.1 queue/dashboard sweeps
  ],
);

export const agentSteps = pgTable(
  "agent_steps",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
    organizationId: text("organization_id").notNull(), // §12.2 tenant column
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(), // 1-based position in the run timeline
    phase: text("phase").$type<RunPhase>().notNull(), // §5.1
    tool: text("tool"), // null for non-tool steps (plan validation, render, critique)
    args: jsonb("args"),
    resultSummary: jsonb("result_summary"), // compact outcome, never raw payloads
    error: jsonb("error").$type<RunError>(),
    durationMs: integer("duration_ms").notNull().default(0),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    costMicroUsd: bigint("cost_micro_usd", { mode: "number" }).notNull().default(0),
    // §5.5: every executor deviation from plan is logged and surfaced.
    deviationFromPlan: boolean("deviation_from_plan").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("agent_steps_run_seq_uq").on(table.runId, table.seq),
    index("agent_steps_org_created_idx").on(table.organizationId, table.createdAt.desc()),
  ],
);

export const runEvents = pgTable(
  "run_events",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
    organizationId: text("organization_id").notNull(), // §12.2 tenant column
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    // §13.2: monotonic per-run counter; clients dedupe by seq and resume with
    // Last-Event-ID (backfill: WHERE run_id = ? AND seq > ? ORDER BY seq).
    seq: bigint("seq", { mode: "number" }).notNull(),
    type: text("type").$type<RunEventType>().notNull(),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("run_events_run_seq_uq").on(table.runId, table.seq),
    index("run_events_org_created_idx").on(table.organizationId, table.createdAt.desc()),
  ],
);

export type AgentRun = typeof agentRuns.$inferSelect;
export type NewAgentRun = typeof agentRuns.$inferInsert;
export type AgentStep = typeof agentSteps.$inferSelect;
export type NewAgentStep = typeof agentSteps.$inferInsert;
export type RunEvent = typeof runEvents.$inferSelect;
export type NewRunEvent = typeof runEvents.$inferInsert;
