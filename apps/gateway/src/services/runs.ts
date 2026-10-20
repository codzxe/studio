// @studio/gateway — run service (§3.3 request lifecycle, §3.4 failure
// semantics, §13.1 runs endpoints, §14.2 deduction rules). Owner: W4-G.
//
// Spec anchors:
//   §3.3  create = auth → tenant → trial/plan checks → RESERVE credits →
//          insert agent_runs (status `queued`) → enqueue BullMQ (jobId=runId)
//          → return run_id
//   §3.4  idempotency — same idempotencyKey never double-charges or
//          double-applies; cancel + rollback + refund
//   §12.2 tenant scoping — every query is composite (org + id), never
//          "find by id then check"
//   §13.1 POST /v1/runs, GET /v1/runs/:id, GET /v1/runs, POST /v1/runs/:id/cancel
//   §14.2 rule 1 — reserve the tier base and check the balance; insufficient →
//          402 and the run never starts. rule 3 — cancel releases the full
//          reservation. rule 6 — reservation keys derive from run_id + phase.
//
// SEAMS (all injectable; apps/gateway/src/routes/runs.ts only maps HTTP):
//   AuthLike      — caller → (userId, organizationId); Better Auth + API keys
//                   wire this later (§13 auth tasks)
//   BillingLike   — balance / reserve / release; `billingFromLedger` adapts the
//                   pure @studio/billing functions over any LedgerStore
//   EnqueueLike   — BullMQ `queue.add` seam; jobId = runId so duplicate
//                   enqueues cannot double-apply (§3.4)
//   EventBusLike  — run.cancelled emission (§13.2); structurally adaptable to
//                   @studio/agent's RunEventBus.publish
//   RunsStore     — typed queries over the @studio/db runs schema (W1-E);
//                   `drizzleRunsStore` is the production implementation
//
// The worker (apps/worker) is the money/event writer during execution: it
// commits or releases the reservation and emits the run timeline. This module
// owns only the create/cancel edges — reserve-before-insert and the cancel
// flip + full release (§14.2 rule 3).

import { canTransition, isTerminal, NON_TERMINAL_RUN_STATUSES } from "@studio/agent";
import {
  canRunTier,
  creditsForRun,
  releaseReservation,
  reserveCredits,
} from "@studio/billing";
import type { LedgerStore, ReleaseOutcome, ReservationOutcome } from "@studio/billing";
import { err, isFailure, ok, type Result } from "@studio/config";
import {
  agentRuns,
  agentSteps,
  documents,
  type AgentRun,
  type AgentStep,
  type Db,
  type NewAgentRun,
  type RunError,
  type RunStatus,
} from "@studio/db";
import { and, asc, desc, eq, inArray, lt, or, type SQL } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";

// ---------------------------------------------------------------------------
// §5.2 enqueue contract — mirrored from apps/worker/src/queues.ts (W2 fleet).
//
// The worker serves `runs:<tier>` per model tier and its `runJobPayloadSchema`
// requires exactly { runId, organizationId, tier } (extra keys are stripped
// by its Zod object, so templateId/assetIds ride along for Wave 6). Its doc
// comment pins the producer contract: "Producers should pass runId as the
// BullMQ jobId so duplicate enqueues cannot double-apply (§3.4 idempotency)".
// Image tiers (image_gen, image_gen_hd) are NOT agent runs: they go through the
// images queue, so they are rejected here with a validation error instead of
// landing on a queue that does not exist (§5.2).
// ---------------------------------------------------------------------------

export const RUN_QUEUE_TIERS = [
  "quick",
  "standard",
  "complex",
  "premium",
  "max",
] as const satisfies readonly string[];

export type RunQueueTier = (typeof RUN_QUEUE_TIERS)[number];

/** Queue name per tier — mirrors `runQueueName` in apps/worker/src/queues.ts. */
export function runQueueName(tier: RunQueueTier): string {
  return `runs:${tier}`;
}

// ---------------------------------------------------------------------------
// Wire schemas (Zod at every boundary, docs/AGENTS.md)
// ---------------------------------------------------------------------------

const idSchema = z.string().trim().min(1).max(200);

/** §13: every mutating endpoint requires an Idempotency-Key (or body field). */
export const IDEMPOTENCY_KEY_SCHEMA = z.string().trim().min(1).max(128);

export const RUN_ID_SCHEMA = z.string().min(1).max(200);

/** POST /v1/runs body (camelCase per the W4-G task contract; §13.1 wire names it
 *  POST /v1/documents/:id/runs with snake_case fields — the API-contract wave
 *  reconciles the two). Prompt cap §5.7: user content is capped, never trusted. */
export const CREATE_RUN_BODY_SCHEMA = z
  .object({
    documentId: idSchema,
    prompt: z
      .string()
      .min(1)
      .max(8000)
      .refine((value) => value.trim().length > 0, {
        message: "prompt must not be blank",
      }),
    tier: z.enum(RUN_QUEUE_TIERS),
    templateId: idSchema.optional(),
    assetIds: z.array(idSchema).max(16).optional(),
    idempotencyKey: IDEMPOTENCY_KEY_SCHEMA.optional(),
  })
  .strict();

export type CreateRunBody = z.infer<typeof CREATE_RUN_BODY_SCHEMA>;

/** POST /v1/runs/:id/cancel body — optional, reason is curated text (§22). */
export const CANCEL_RUN_BODY_SCHEMA = z
  .object({
    reason: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export type CancelRunBody = z.infer<typeof CANCEL_RUN_BODY_SCHEMA>;

/** GET /v1/runs query — non-strict: extra query params are ignored. */
export const LIST_RUNS_QUERY_SCHEMA = z.object({
  document_id: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().trim().min(1).max(1024).optional(),
});

export type ListRunsQuery = z.infer<typeof LIST_RUNS_QUERY_SCHEMA>;

/** Default cancel reason — §14.2 rule 3 vocabulary (user_cancel → full_refund). */
export const DEFAULT_CANCEL_REASON = "user_cancel";

// ---------------------------------------------------------------------------
// Keyset pagination cursor (opaque to clients)
// ---------------------------------------------------------------------------

/** §12.2 index: agent_runs(org, created_at desc) — the keyset cursor anchor. */
export interface RunPageCursor {
  readonly createdAt: Date;
  readonly id: string;
}

const CURSOR_JSON_SCHEMA = z
  .object({
    c: z.string().datetime(),
    i: z.string().min(1).max(200),
  })
  .strict();

/** Encodes a cursor as base64url JSON (no client-meaningful contents). */
export function encodeRunCursor(cursor: RunPageCursor): string {
  return Buffer.from(
    JSON.stringify({ c: cursor.createdAt.toISOString(), i: cursor.id }),
    "utf8",
  ).toString("base64url");
}

/** Decodes a client cursor; null when malformed or expired-shaped. */
export function decodeRunCursor(encoded: string): RunPageCursor | null {
  try {
    const json = Buffer.from(encoded, "base64url").toString("utf8");
    const parsed = CURSOR_JSON_SCHEMA.parse(JSON.parse(json) as unknown);
    return { createdAt: new Date(parsed.c), id: parsed.i };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Auth seam — the caller as resolved by Better Auth / API-key middleware
// ---------------------------------------------------------------------------

/** The authenticated principal making a run request (§15 tenant root). */
export interface RunCaller {
  readonly userId: string;
  readonly organizationId: string;
}

/**
 * Resolves the caller from a request. Failures use the §13.3 catalog —
 * `unauthorized` for missing/invalid credentials, `forbidden` for a caller
 * that is authenticated but not allowed to start runs. Implementations never
 * throw; unexpected faults surface as typed `internal_error` results.
 */
export interface AuthLike {
  authenticate(request: Request): Promise<Result<RunCaller>>;
}

// ---------------------------------------------------------------------------
// Billing seam — §14.2 reserve / release over the append-only ledger
// ---------------------------------------------------------------------------

export interface BillingLike {
  /** Available balance: grants − committed spends − open holds (§14.2). */
  balance(organizationId: string): Promise<number>;
  /**
   * §14.2 rule 1 hold. Idempotent per run: the ledger key derives from the
   * run id + phase (`${runId}:reserve`, rule 6), so a retried create with the
   * same run id can never double-charge — the run-level idempotency key in
   * createRun() is what maps requests → runs.
   */
  reserve(input: {
    readonly organizationId: string;
    readonly runId: string;
    readonly credits: number;
  }): Promise<Result<ReservationOutcome>>;
  /** §14.2 rules 3–4: release (fully or with a partial charge) on cancel/failure. */
  release(input: {
    readonly organizationId: string;
    readonly runId: string;
    readonly credits: number;
    readonly amountCharged?: number;
  }): Promise<Result<ReleaseOutcome>>;
}

/** Adapts the pure @studio/billing ledger functions to the BillingLike seam. */
export function billingFromLedger(store: LedgerStore): BillingLike {
  return {
    async balance(organizationId) {
      return store.balanceAfter(organizationId);
    },
    async reserve(input) {
      // amountCharged clamping and duplicate replay semantics live in billing.
      return reserveCredits(store, {
        organizationId: input.organizationId,
        runId: input.runId,
        amount: input.credits,
      });
    },
    async release(input) {
      return releaseReservation(store, {
        organizationId: input.organizationId,
        runId: input.runId,
        amount: input.credits,
        amountCharged: input.amountCharged,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Enqueue seam — BullMQ producer (one queue per tier, §5.2)
// ---------------------------------------------------------------------------

/** The worker's run payload core + the §13.1 create extras (stripped by its
 *  Zod schema until Wave 6 consumes them — additive keys never break it). */
export interface RunEnqueuePayload {
  readonly runId: string;
  readonly organizationId: string;
  readonly tier: RunQueueTier;
  readonly templateId?: string;
  readonly assetIds?: readonly string[];
}

export interface EnqueueLike {
  /**
   * Adds one job to a queue. The producer contract (apps/worker queues.ts):
   * `jobId = runId` so duplicate enqueues cannot double-apply (§3.4).
   * Failures are typed results, never throws.
   */
  enqueue(
    queue: string,
    payload: RunEnqueuePayload,
    options: { readonly jobId: string },
  ): Promise<Result<{ readonly jobId: string }>>;
}

// ---------------------------------------------------------------------------
// Event seam — run.cancelled emission (§13.2)
// ---------------------------------------------------------------------------

export interface EventBusLike {
  /**
   * Emits `run.cancelled` (§13.2 payload { reason }). Structurally adaptable
   * to @studio/agent's RunEventBus.publish(runId, "run.cancelled", { reason },
   * { organizationId }). Never throws; failures are typed results (§22 durable
   * append — a failed publish is retryable and leaves the sequence gapless).
   */
  runCancelled(input: {
    readonly organizationId: string;
    readonly runId: string;
    readonly reason: string;
  }): Promise<Result<{ readonly seq: number }>>;
}

// ---------------------------------------------------------------------------
// Store seam — typed queries over the runs schema (§12.2 tenant scoping)
// ---------------------------------------------------------------------------

/** A document row as run creation needs it (§12.2 composite org+id lookup). */
export interface DocumentRef {
  readonly currentRevision: number;
  readonly archived: boolean;
}

/** Keyset page anchor: the oldest row of the page just served (see listRuns). */
export interface RunPage {
  readonly rows: readonly AgentRun[];
  /** Present when more rows follow; feed back as the `cursor` query param. */
  readonly next?: RunPageCursor;
}

export interface RunsStore {
  /** The document's current revision + archive state, org-scoped (§12.2). */
  findDocument(
    organizationId: string,
    documentId: string,
  ): Promise<DocumentRef | null>;
  /** §3.4 replay lookup: the run row for (org, idempotency key). */
  findByIdempotency(organizationId: string, idempotencyKey: string): Promise<AgentRun | null>;
  /**
   * Inserts one run row. MUST throw a unique-violation error (postgres 23505)
   * when the idempotency_key unique index rejects a duplicate — that index is
   * the §3.4 backstop under concurrency; see isUniqueViolation.
   */
  insertRun(row: NewAgentRun): Promise<AgentRun>;
  /** The run row for (org, runId) — composite query, never find-then-check. */
  getRun(organizationId: string, runId: string): Promise<AgentRun | null>;
  /**
   * One page of runs, newest first, keyset-paged on (created_at, id).
   * `limit` is the page size; the store returns at most `limit` rows and
   * `next` only when a further page exists.
   */
  listRuns(query: {
    readonly organizationId: string;
    readonly documentId?: string;
    readonly limit: number;
    readonly before?: RunPageCursor;
  }): Promise<RunPage>;
  /** All steps of a run, org-scoped, ascending seq (§5.5 timeline). */
  listSteps(organizationId: string, runId: string): Promise<readonly AgentStep[]>;
  /**
   * Compare-and-swap status transition: applies `to` only while the row is in
   * one of `from`; returns the updated row or null when the guard failed.
   * Implementations MUST stamp `finishedAt` when `to` is terminal (§5.1) and
   * persist `error` when provided (terminal failure envelopes only, §13.3).
   */
  transitionStatus(input: {
    readonly organizationId: string;
    readonly runId: string;
    readonly from: readonly RunStatus[];
    readonly to: RunStatus;
    readonly error?: RunError;
  }): Promise<AgentRun | null>;
}

/**
 * True when an error chain carries a Postgres unique-violation (23505) —
 * drizzle wraps driver errors, so the code is searched along the cause chain.
 * Only insertRun callers use this (§3.4 idempotency backstop).
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current === null || typeof current !== "object") {
      return false;
    }
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === "23505") {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Drizzle-backed RunsStore — the production repository layer
// ---------------------------------------------------------------------------

function requireRow(rows: readonly AgentRun[], what: string): AgentRun {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`[runs] ${what} returned no row`);
  }
  return row;
}

/** Keyset guard: rows strictly before (createdAt, id) — §12.2 index order. */
function keysetGuard(before: RunPageCursor | undefined): SQL<unknown> | undefined {
  if (before === undefined) {
    return undefined;
  }
  return or(
    lt(agentRuns.createdAt, before.createdAt),
    and(eq(agentRuns.createdAt, before.createdAt), lt(agentRuns.id, before.id)),
  );
}

/** Typed queries over agent_runs / agent_steps / documents (§12.1/§12.2). */
export function drizzleRunsStore(db: Db): RunsStore {
  return {
    async findDocument(organizationId, documentId) {
      const rows = await db
        .select({
          currentRevision: documents.currentRevision,
          archivedAt: documents.archivedAt,
        })
        .from(documents)
        .where(and(eq(documents.organizationId, organizationId), eq(documents.id, documentId)))
        .limit(1);
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      return { currentRevision: row.currentRevision, archived: row.archivedAt !== null };
    },

    async findByIdempotency(organizationId, idempotencyKey) {
      const rows = await db
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.organizationId, organizationId),
            eq(agentRuns.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async insertRun(row) {
      const inserted = await db.insert(agentRuns).values(row).returning();
      return requireRow(inserted, "agent_runs insert");
    },

    async getRun(organizationId, runId) {
      const rows = await db
        .select()
        .from(agentRuns)
        .where(and(eq(agentRuns.organizationId, organizationId), eq(agentRuns.id, runId)))
        .limit(1);
      return rows[0] ?? null;
    },

    async listRuns(query) {
      const guard = keysetGuard(query.before);
      const filters: SQL[] = [eq(agentRuns.organizationId, query.organizationId)];
      if (query.documentId !== undefined) {
        filters.push(eq(agentRuns.documentId, query.documentId));
      }
      if (guard !== undefined) {
        filters.push(guard);
      }
      const rows = await db
        .select()
        .from(agentRuns)
        .where(and(...filters))
        .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
        .limit(query.limit + 1);
      const page = rows.length > query.limit ? rows.slice(0, query.limit) : rows;
      const last = page.at(-1);
      return {
        rows: page,
        next:
          rows.length > query.limit && last !== undefined
            ? { createdAt: last.createdAt, id: last.id }
            : undefined,
      };
    },

    async listSteps(organizationId, runId) {
      return db
        .select()
        .from(agentSteps)
        .where(and(eq(agentSteps.organizationId, organizationId), eq(agentSteps.runId, runId)))
        .orderBy(asc(agentSteps.seq));
    },

    async transitionStatus(input) {
      const values: { status: RunStatus; finishedAt?: Date; error?: RunError } = {
        status: input.to,
      };
      if (isTerminal(input.to)) {
        values.finishedAt = new Date();
      }
      if (input.error !== undefined) {
        values.error = input.error;
      }
      const updated = await db
        .update(agentRuns)
        .set(values)
        .where(
          and(
            eq(agentRuns.organizationId, input.organizationId),
            eq(agentRuns.id, input.runId),
            inArray(agentRuns.status, [...input.from]),
          ),
        )
        .returning();
      return updated[0] ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// The service aggregate injected into the route
// ---------------------------------------------------------------------------

export interface RunsDeps {
  readonly auth: AuthLike;
  readonly billing: BillingLike;
  readonly store: RunsStore;
  readonly enqueue: EnqueueLike;
  readonly events: EventBusLike;
}

// ---------------------------------------------------------------------------
// Wire serializers (§13.1 response shapes; snake_case like the spec tables)
// ---------------------------------------------------------------------------

export interface RunCostApiView {
  readonly credits_reserved: number;
  readonly credits_charged: number;
  readonly tokens_in: number;
  readonly tokens_out: number;
  readonly cache_hits: number;
  readonly cost_micro_usd: number;
}

export interface RunApiView {
  readonly run_id: string;
  readonly document_id: string;
  readonly status: RunStatus;
  readonly tier: string;
  readonly revision_before: number;
  readonly revision_after: number | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly error: RunError | null;
}

export interface RunStepApiView {
  readonly seq: number;
  readonly phase: string;
  readonly tool: string | null;
  readonly duration_ms: number;
  readonly ok: boolean;
  readonly error_code: string | null;
  readonly deviation_from_plan: boolean;
}

/** GET /v1/runs/:id body — "status + plan + steps summary + cost" (§13.1). */
export interface RunDetailApiView extends RunApiView {
  readonly plan: unknown;
  readonly cost: RunCostApiView;
  readonly steps: readonly RunStepApiView[];
}

export interface RunListItemApiView extends RunApiView {
  readonly credits: { readonly reserved: number; readonly charged: number };
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

export function runToApi(run: AgentRun): RunApiView {
  return {
    run_id: run.id,
    document_id: run.documentId,
    status: run.status,
    tier: run.tier,
    revision_before: run.revisionBefore,
    revision_after: run.revisionAfter,
    created_at: run.createdAt.toISOString(),
    started_at: iso(run.startedAt),
    finished_at: iso(run.finishedAt),
    error: run.error ?? null,
  };
}

export function runCostToApi(run: AgentRun): RunCostApiView {
  return {
    credits_reserved: run.creditsReserved,
    credits_charged: run.creditsCharged,
    tokens_in: run.tokensIn,
    tokens_out: run.tokensOut,
    cache_hits: run.cacheHits,
    cost_micro_usd: run.costMicroUsd,
  };
}

export function stepToApi(step: AgentStep): RunStepApiView {
  return {
    seq: step.seq,
    phase: step.phase,
    tool: step.tool,
    duration_ms: step.durationMs,
    ok: step.error === null,
    error_code: step.error?.code ?? null,
    deviation_from_plan: step.deviationFromPlan,
  };
}

export function runDetailToApi(run: AgentRun, steps: readonly AgentStep[]): RunDetailApiView {
  return {
    ...runToApi(run),
    plan: run.plan ?? null,
    cost: runCostToApi(run),
    steps: steps.map(stepToApi),
  };
}

export function runListItemToApi(run: AgentRun): RunListItemApiView {
  return {
    ...runToApi(run),
    credits: { reserved: run.creditsReserved, charged: run.creditsCharged },
  };
}

// ---------------------------------------------------------------------------
// §3.3 create — validate → authorize → plan checks → RESERVE → insert → enqueue
// ---------------------------------------------------------------------------

export interface CreateRunInput {
  readonly caller: RunCaller;
  readonly body: CreateRunBody;
  /** Resolved from the Idempotency-Key header / idempotencyKey body field. */
  readonly idempotencyKey: string;
}

export interface CreateRunOutcome {
  readonly run: AgentRun;
  /** True when an existing run was returned (§3.4 replay — no new charge). */
  readonly duplicate: boolean;
}

/** Best-effort §3.4 compensation: a stray hold is returned, never stranded. */
async function releaseQuietly(
  deps: RunsDeps,
  input: { readonly organizationId: string; readonly runId: string; readonly credits: number },
): Promise<void> {
  // Full release, zero charge. The ledger refund key is idempotent per run
  // (`${runId}:refund`), so the worker's own refund path cannot double-refund.
  // A failed compensation is left to the ledger consistency sweep (§12.2) —
  // never surfaced to the client as a success.
  await deps.billing.release({ ...input, amountCharged: 0 }).catch(() => undefined);
}

export async function createRun(deps: RunsDeps, input: CreateRunInput): Promise<Result<CreateRunOutcome>> {
  const { organizationId } = input.caller;
  const { body } = input;

  // §12.2 composite org+id lookup: a foreign document is indistinguishable
  // from a missing one — never confirm existence across tenants (§15.1).
  const document = await deps.store.findDocument(organizationId, body.documentId);
  if (document === null) {
    return err("not_found", "Document not found.", {
      hint: "Check the document id within your workspace.",
    });
  }
  if (document.archived) {
    return err("conflict", "This document is archived; runs start on active documents only.", {
      hint: "Restore the document first (§10.1).",
    });
  }

  // §3.4: same idempotency key + same org → the EXISTING run. Never a second
  // reserve, never a second insert, never a second enqueue.
  const existing = await deps.store.findByIdempotency(organizationId, input.idempotencyKey);
  if (existing !== null) {
    return ok({ run: existing, duplicate: true });
  }

  // §5.2/§14.1 tier cost + §14.2 rule 1 balance pre-check. The authoritative
  // balance check happens inside reserve (the hold is balance-checked
  // atomically); canRunTier keeps hopeless requests from minting run ids.
  const credits = creditsForRun(body.tier);
  const balance = await deps.billing.balance(organizationId);
  if (!canRunTier(balance, body.tier)) {
    return err(
      "insufficient_credits",
      `This run needs ${credits} credits but the workspace has ${balance} available.`,
      {
        hint: "Top up credits or upgrade your plan, then retry. The run was not started.",
      },
    );
  }

  // Fresh run id per attempt; the run-row idempotency key maps requests → runs
  // and the ledger phase keys derive from the run id (§14.2 rule 6).
  const runId = randomUUID();
  const reserve = await deps.billing.reserve({ organizationId, runId, credits });
  if (isFailure(reserve)) {
    return reserve;
  }

  let run: AgentRun;
  try {
    run = await deps.store.insertRun({
      id: runId,
      organizationId,
      documentId: body.documentId,
      userId: input.caller.userId,
      prompt: body.prompt,
      tier: body.tier,
      status: "queued",
      idempotencyKey: input.idempotencyKey,
      revisionBefore: document.currentRevision, // §5.6 revision at run start
      creditsReserved: credits,
    });
  } catch (error) {
    // §3.4 backstop: the unique index on idempotency_key rejected a duplicate
    // (a concurrent replay or another workspace holding the key).
    if (!isUniqueViolation(error)) {
      throw error; // unexpected → §13.3 internal_error via the error mapper
    }
    await releaseQuietly(deps, { organizationId, runId, credits });
    const winner = await deps.store.findByIdempotency(organizationId, input.idempotencyKey);
    if (winner !== null) {
      return ok({ run: winner, duplicate: true });
    }
    return err("conflict", "This idempotency key is already in use.", {
      hint: "Idempotency keys are global; generate a fresh unique key.",
    });
  }

  // §5.2: one queue per tier; jobId = runId (§3.4 — duplicate enqueues no-op).
  const enqueue = await deps.enqueue.enqueue(
    runQueueName(body.tier),
    {
      runId,
      organizationId,
      tier: body.tier,
      ...(body.templateId !== undefined ? { templateId: body.templateId } : {}),
      ...(body.assetIds !== undefined ? { assetIds: body.assetIds } : {}),
    },
    { jobId: runId },
  );
  if (isFailure(enqueue)) {
    // Compensate (§3.3 step 2 is atomic-ish): flip the fresh row to failed and
    // hand the hold back. Retry with the same key replays this failed run.
    const failed = await deps.store.transitionStatus({
      organizationId,
      runId,
      from: ["queued"],
      to: "failed",
      error: {
        code: "queue_unavailable",
        message: "The run could not be queued for processing.",
        retryable: true,
      },
    });
    if (failed !== null) {
      await releaseQuietly(deps, { organizationId, runId, credits });
      return err("engine_unavailable", "The run could not be queued and was not started.", {
        hint: "The reservation was released. Retry with a fresh idempotency key.",
        retryable: true,
      });
    }
    // The row raced to a terminal state on its own; leave the reservation to
    // the worker's refund path (idempotent by run id, §14.2 rule 6).
    return err("engine_unavailable", "The run could not be queued and was not started.", {
      retryable: true,
    });
  }

  return ok({ run, duplicate: false });
}

// ---------------------------------------------------------------------------
// §13.1 GET /v1/runs/:id — status + plan + steps summary + cost
// ---------------------------------------------------------------------------

export interface RunQuery {
  readonly organizationId: string;
  readonly runId: string;
}

export interface RunDetail {
  readonly run: AgentRun;
  readonly steps: readonly AgentStep[];
}

export async function getRun(deps: RunsDeps, query: RunQuery): Promise<Result<RunDetail>> {
  const run = await deps.store.getRun(query.organizationId, query.runId);
  if (run === null) {
    return err("not_found", "Run not found.", {
      hint: "Check the run id within your workspace.",
    });
  }
  const steps = await deps.store.listSteps(query.organizationId, query.runId);
  return ok({ run, steps });
}

// ---------------------------------------------------------------------------
// §13.1 GET /v1/runs — one page, org-scoped, optional document filter
// ---------------------------------------------------------------------------

export interface RunListQuery {
  readonly organizationId: string;
  readonly documentId?: string;
  readonly limit: number;
  readonly cursor?: RunPageCursor;
}

export interface RunListOutcome {
  readonly runs: readonly RunListItemApiView[];
  readonly next_cursor?: string;
}

export async function listRuns(deps: RunsDeps, query: RunListQuery): Promise<Result<RunListOutcome>> {
  const page = await deps.store.listRuns({
    organizationId: query.organizationId,
    ...(query.documentId !== undefined ? { documentId: query.documentId } : {}),
    limit: query.limit,
    ...(query.cursor !== undefined ? { before: query.cursor } : {}),
  });
  return ok({
    runs: page.rows.map(runListItemToApi),
    ...(page.next !== undefined ? { next_cursor: encodeRunCursor(page.next) } : {}),
  });
}

// ---------------------------------------------------------------------------
// §3.4 cancel — flip status (active states only), release, emit run.cancelled
// ---------------------------------------------------------------------------

/**
 * Every §5.1 status that may still move to `cancelled`, derived from the
 * shared state machine (@studio/agent, W1-P) — terminals never re-enter.
 */
export const CANCELLABLE_RUN_STATUSES: readonly RunStatus[] = NON_TERMINAL_RUN_STATUSES.filter(
  (status) => canTransition(status, "cancelled"),
);

export interface CancelRunInput {
  readonly organizationId: string;
  readonly runId: string;
  readonly reason: string;
}

export interface CancelRunOutcome {
  readonly run: AgentRun;
  /**
   * §14.2 rule 3 full release. Null when the release attempt failed — the
   * reservation survives and the worker's idempotent refund path (§3.4)
   * settles it; nothing is double-refunded (keys derive from run_id).
   */
  readonly release: ReleaseOutcome | null;
  /** §13.2 run.cancelled seq; null when the durable append failed (§22). */
  readonly eventSeq: number | null;
}

export async function cancelRun(deps: RunsDeps, input: CancelRunInput): Promise<Result<CancelRunOutcome>> {
  const run = await deps.store.getRun(input.organizationId, input.runId);
  if (run === null) {
    return err("not_found", "Run not found.", {
      hint: "Check the run id within your workspace.",
    });
  }

  // §5.1: only active (non-terminal) statuses may move to cancelled.
  if (!canTransition(run.status, "cancelled")) {
    return err("conflict", `This run already reached its final state ('${run.status}').`, {
      hint: "Only active runs can be cancelled; start a new run instead (§5.1).",
    });
  }

  // Compare-and-swap on the active-status set: a run that reached a terminal
  // state concurrently loses the race and reports a conflict.
  const updated = await deps.store.transitionStatus({
    organizationId: input.organizationId,
    runId: input.runId,
    from: CANCELLABLE_RUN_STATUSES,
    to: "cancelled",
  });
  if (updated === null) {
    return err("conflict", "The run finished while it was being cancelled.", {
      hint: "Refresh the run status.",
    });
  }

  // §14.2 rule 3: user cancel → full release. The route cannot know whether
  // mutating commands ran, and §24 policy classifies user_cancel as
  // full_refund regardless — the customer never pays for a cancelled run.
  const release = await deps.billing.release({
    organizationId: input.organizationId,
    runId: input.runId,
    credits: run.creditsReserved,
    amountCharged: 0,
  });

  // §13.2 run.cancelled — after the flip, so subscribers see the settled state.
  const event = await deps.events.runCancelled({
    organizationId: input.organizationId,
    runId: input.runId,
    reason: input.reason,
  });

  return ok({
    run: updated,
    release: isFailure(release) ? null : release.value,
    eventSeq: isFailure(event) ? null : event.value.seq,
  });
}
