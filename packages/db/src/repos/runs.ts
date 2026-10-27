import { and, asc, desc, eq, isNotNull, isNull, lt, ne, or } from "drizzle-orm";

import { type Page, clampLimit, decodeCursor, encodeCursor } from "../cursor.js";
import type { Executor, StudioDb } from "../db.js";
import { DbError } from "../errors-lite.js";
import { createId } from "../ids.js";
import type { AgentRun, AgentStep, RunStatus, StepStatus } from "../schema.js";
import { assertRunTransition, isTerminalRunStatus } from "../statuses.js";
import { tablesFor } from "../tables.js";
import {
  type WorkspaceId,
  isUniqueViolation,
  requireNonEmpty,
  requireNonNegativeInt,
  requirePositiveInt,
} from "./shared.js";

/** Runs repository — one agent turn from prompt to applied result (§3.1, §7.4). */
export interface RunCreateInput {
  readonly threadId: string;
  readonly projectId: string;
  readonly model: string;
  readonly baseVersionId?: string | null;
  readonly reservedCredits?: number;
  readonly planJson?: unknown;
  /**
   * Round 12 (client-driven loop): the CLIENT owns the run id — it must
   * mint it BEFORE the first turn's response so (runId, stepIndex) can key
   * turn idempotency. Optional: omitted = server-generated `run_` id (the
   * legacy /chat flow).
   */
  readonly runId?: string;
}

export interface RunUpdateInput {
  readonly status?: RunStatus;
  readonly planJson?: unknown;
  readonly reservedCredits?: number;
  readonly committedCredits?: number;
  readonly resultVersionId?: string | null;
  readonly errorCode?: string | null;
}

/**
 * M5.4 — record the apply of a proposed plan: the ONE atomic engine.batch the
 * run compiled to was executed client-side, `saveNow("agent-apply")` produced
 * `versionId`, and the gateway now pins the batch digest + base version on the
 * run row. Idempotency at this layer = rejection (a second apply is a CONFLICT;
 * the route layer turns a replayed idempotency key into the original answer).
 */
export interface RecordAppliedInput {
  readonly runId: string;
  /** sha256 of the executed compiled batch — exactly 64 lowercase hex chars. */
  readonly batchSha256: string;
  /** The version created by this apply (must belong to the run's project). */
  readonly versionId: string;
  /**
   * The version the client was on when the plan was proposed. Optional here: the
   * run already captured it at create time. If given it must MATCH the recorded
   * base (else PROJECT_VERSION_CONFLICT, §9.3) and is backfilled when the run
   * predates the column or was created without a base.
   */
  readonly baseVersionId?: string | null;
}

/** M5.5 — undo the whole run as ONE step. Requires the run to be applied. */
export interface RecordUndoneInput {
  readonly runId: string;
  readonly userId: string;
}

/** Plan lifecycle of a run (§M5.4/§M5.5): proposed → applied → undone. */
export type PlanLifecycleStatus = "proposed" | "applied" | "undone";

export interface PlanState {
  readonly status: PlanLifecycleStatus;
  readonly appliedAt: Date | null;
  readonly appliedBatchSha256: string | null;
  readonly appliedVersionId: string | null;
  readonly baseVersionId: string | null;
  readonly undoneAt: Date | null;
}

export interface StepCreateInput {
  readonly runId: string;
  readonly seq: number;
  readonly tool: string;
  readonly argsJson?: unknown;
  readonly resultJson?: unknown;
  readonly commandBatchJson?: unknown;
  readonly status?: StepStatus;
  readonly durationMs?: number | null;
}

// ── Round 12: client-driven agent loop (migration 0008) ───────────────────────
//
// The browser owns the turn loop; the gateway persists per turn. These seams
// are TRUSTED-INTERNAL and workspace-free by design (RendersRepo.claimNext /
// requeueStale precedent): the turn route resolves thread → workspace and
// authenticates BEFORE calling them, and run/thread ids are cross-checked
// against each other so a foreign pairing still reads as CONFLICT/404.

/** `insertToolCallStep` input — one model-emitted tool call (round 12). */
export interface ToolCallStepInput {
  readonly runId: string;
  /** Optional cross-check: when given it must equal the run's thread_id. */
  readonly threadId?: string;
  /**
   * The turn's model-call index (idempotency-key component); validated but NOT
   * persisted as a column — one turn may emit several tool calls, so the step
   * row orders by a per-run allocation seq instead; the durable turn index is
   * agent_runs.last_step_index via `touchRunHeartbeat`.
   */
  readonly stepIndex: number;
  /** The model's stable tool call id — the key `completeToolStep` settles on. */
  readonly toolCallId: string;
  readonly tool: string;
  readonly argsJson?: unknown;
}

/** `completeToolStep` input — the locally-executed tool result. */
export interface CompleteToolStepInput {
  readonly toolCallId: string;
  readonly resultJson: unknown;
  /**
   * 12-w8 audit hardening: optional run cross-check — when given, the step's
   * run_id must match, so a client can never settle another run's toolCallId
   * by guessing ids (toolCallIds are model-generated, but the gate is free).
   */
  readonly runId?: string;
}

/** `touchRunHeartbeat` input — one turn's worth of run progress. */
export interface TouchRunHeartbeatInput {
  readonly runId: string;
  readonly lastStepIndex: number;
  readonly creditsCommitted?: number;
}

/** `markRunAbandoned` input. */
export interface MarkRunAbandonedInput {
  readonly runId: string;
}

/** A stale `running` run + the workspace it scopes to (sweep resolution). */
export interface StaleRun extends AgentRun {
  readonly workspaceId: WorkspaceId;
}

/** A `running` run whose heartbeat is older than this reads as abandoned. */
export const RUN_STALE_AFTER_MS = 5 * 60 * 1000;

/** errorCode written by `markRunAbandoned` (cancelled, not a model failure). */
export const RUN_ABANDONED_ERROR_CODE = "RUN_ABANDONED";

export interface ListOptions {
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface RunWithSteps {
  readonly run: AgentRun;
  readonly steps: readonly AgentStep[];
}

export interface RunsRepo {
  create(workspaceId: WorkspaceId, input: RunCreateInput): Promise<AgentRun>;
  update(workspaceId: WorkspaceId, runId: string, input: RunUpdateInput): Promise<AgentRun>;
  addStep(workspaceId: WorkspaceId, input: StepCreateInput): Promise<AgentStep>;
  get(workspaceId: WorkspaceId, runId: string): Promise<RunWithSteps>;
  listByThread(
    workspaceId: WorkspaceId,
    threadId: string,
    options?: ListOptions,
  ): Promise<Page<AgentRun>>;
  /** M5.4: mark the run applied — the apply created `versionId` (ONE version). */
  recordApplied(workspaceId: WorkspaceId, input: RecordAppliedInput): Promise<AgentRun>;
  /** M5.5: mark the run undone — the version row is never deleted (§9.3). */
  recordUndone(workspaceId: WorkspaceId, input: RecordUndoneInput): Promise<AgentRun>;
  /** Plan lifecycle projection of a run — cross-tenant reads as NOT_FOUND. */
  getPlanState(workspaceId: WorkspaceId, runId: string): Promise<PlanState>;

  // ── Round 12 client-driven agent loop (trusted-internal; see ToolCallStepInput) ──

  /** Insert one model-emitted tool call as an agent_steps row, status "issued". */
  insertToolCallStep(input: ToolCallStepInput): Promise<AgentStep>;
  /** Settle an issued tool call by its toolCallId: status "success" + result. */
  completeToolStep(input: CompleteToolStepInput): Promise<AgentStep>;
  /** Per-turn heartbeat: status running + last_step_index + heartbeat_at. */
  touchRunHeartbeat(input: TouchRunHeartbeatInput): Promise<AgentRun>;
  /** Terminal cancel of a zombie run (errorCode RUN_ABANDONED); idempotent. */
  markRunAbandoned(input: MarkRunAbandonedInput): Promise<AgentRun>;
  /** running rows whose heartbeat is older than `staleAfterMs` (default 5min). */
  getStaleRunningRuns(staleAfterMs?: number): Promise<StaleRun[]>;
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

function requireBatchSha256(value: string, field: string): string {
  const sha = requireNonEmpty(value, field);
  if (!SHA256_HEX.test(sha)) {
    throw DbError.validation(`${field} must be exactly 64 lowercase hex characters`);
  }
  return sha;
}

/** Pure projection of the apply/undo columns onto the plan lifecycle. */
export function toPlanState(
  run: Pick<
    AgentRun,
    "appliedAt" | "appliedBatchSha256" | "appliedVersionId" | "baseVersionId" | "undoneAt"
  >,
): PlanState {
  const status: PlanLifecycleStatus =
    run.appliedAt === null ? "proposed" : run.undoneAt === null ? "applied" : "undone";
  return {
    status,
    appliedAt: run.appliedAt,
    appliedBatchSha256: run.appliedBatchSha256,
    appliedVersionId: run.appliedVersionId,
    baseVersionId: run.baseVersionId,
    undoneAt: run.undoneAt,
  };
}

export function createRunsRepo(db: StudioDb): RunsRepo {
  // Dialect-aware tables (W3-A, tables.ts seam) — see createProjectsRepo.
  const { agentRuns, agentSteps, agentThreads, projectVersions, projects, user } = tablesFor(db);
  async function requireRun(workspaceId: WorkspaceId, runId: string): Promise<AgentRun> {
    const [row] = await db
      .select({ run: agentRuns })
      .from(agentRuns)
      .innerJoin(projects, eq(agentRuns.projectId, projects.id))
      .where(and(eq(agentRuns.id, runId), eq(projects.workspaceId, workspaceId)))
      .limit(1);
    if (!row) throw DbError.notFound("run");
    return row.run;
  }

  /** Trusted-internal run lookup by id alone (round 12 — see ToolCallStepInput). */
  async function requireRunById(exec: Executor, runId: string): Promise<AgentRun> {
    const [run] = await exec.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
    if (!run) throw DbError.notFound("run");
    return run;
  }

  /** A version id that must exist AND belong to the run's project (§9.3 scope). */
  async function requireProjectVersion(
    projectId: string,
    versionId: string,
    what: string,
  ): Promise<void> {
    const [row] = await db
      .select({ id: projectVersions.id })
      .from(projectVersions)
      .where(and(eq(projectVersions.id, versionId), eq(projectVersions.projectId, projectId)))
      .limit(1);
    if (!row) throw DbError.notFound(what);
  }

  return {
    async create(workspaceId, input) {
      requireNonEmpty(input.threadId, "threadId");
      requireNonEmpty(input.projectId, "projectId");
      const model = requireNonEmpty(input.model, "model");

      // tenancy: thread must belong to a project in this workspace
      const [thread] = await db
        .select({ id: agentThreads.id })
        .from(agentThreads)
        .innerJoin(projects, eq(agentThreads.projectId, projects.id))
        .where(and(eq(agentThreads.id, input.threadId), eq(projects.workspaceId, workspaceId)))
        .limit(1);
      if (!thread) throw DbError.notFound("thread");
      const [project] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, workspaceId)))
        .limit(1);
      if (!project) throw DbError.notFound("project");

      const [run] = await db
        .insert(agentRuns)
        .values({
          id: input.runId !== undefined && input.runId !== "" ? input.runId : createId("run"),
          threadId: input.threadId,
          projectId: input.projectId,
          model,
          status: "queued",
          planJson: input.planJson,
          reservedCredits: input.reservedCredits ?? 0,
          committedCredits: 0,
          baseVersionId: input.baseVersionId ?? null,
        })
        .returning();
      if (!run) throw DbError.conflict("Could not create run");
      return run;
    },

    async update(workspaceId, runId, input) {
      const run = await requireRun(workspaceId, runId);
      const values: Partial<typeof agentRuns.$inferInsert> = {};
      if (input.status !== undefined && input.status !== run.status) {
        assertRunTransition(run.status, input.status);
        values.status = input.status;
        if (isTerminalRunStatus(input.status)) values.completedAt = new Date();
      }
      if (input.planJson !== undefined) values.planJson = input.planJson;
      if (input.reservedCredits !== undefined) values.reservedCredits = input.reservedCredits;
      if (input.committedCredits !== undefined) values.committedCredits = input.committedCredits;
      if (input.resultVersionId !== undefined) values.resultVersionId = input.resultVersionId;
      if (input.errorCode !== undefined) values.errorCode = input.errorCode;

      if (Object.keys(values).length === 0) return run;

      const [updated] = await db
        .update(agentRuns)
        .set(values)
        .where(eq(agentRuns.id, run.id))
        .returning();
      if (!updated) throw DbError.notFound("run");
      return updated;
    },

    async addStep(workspaceId, input) {
      requireNonEmpty(input.runId, "runId");
      const tool = requireNonEmpty(input.tool, "tool");
      if (!Number.isInteger(input.seq) || input.seq < 0) {
        throw DbError.validation("seq must be a non-negative integer");
      }
      const run = await requireRun(workspaceId, input.runId);

      try {
        const [step] = await db
          .insert(agentSteps)
          .values({
            id: createId("stp"),
            runId: run.id,
            seq: input.seq,
            tool,
            argsJson: input.argsJson,
            resultJson: input.resultJson,
            commandBatchJson: input.commandBatchJson,
            status: input.status ?? "pending",
            durationMs: input.durationMs ?? null,
          })
          .returning();
        if (!step) throw DbError.conflict("Could not insert step");
        return step;
      } catch (error) {
        // UNIQUE(run_id, seq) — 23505 arrives WRAPPED in drizzle's `.cause`
        // chain, so the check must walk it (shared.ts isUniqueViolation).
        if (isUniqueViolation(error)) {
          throw DbError.conflict(`Step ${input.seq} already exists for this run`);
        }
        throw error;
      }
    },

    async get(workspaceId, runId) {
      const run = await requireRun(workspaceId, runId);
      const steps = await db
        .select()
        .from(agentSteps)
        .where(eq(agentSteps.runId, run.id))
        .orderBy(asc(agentSteps.seq));
      return { run, steps };
    },

    async listByThread(workspaceId, threadId, options) {
      const limit = clampLimit(options?.limit);
      const cursor = decodeCursor(options?.cursor ?? null);
      const rows = await db
        .select({ run: agentRuns })
        .from(agentRuns)
        .innerJoin(projects, eq(agentRuns.projectId, projects.id))
        .where(
          and(
            eq(agentRuns.threadId, threadId),
            eq(projects.workspaceId, workspaceId),
            cursor
              ? or(
                  lt(agentRuns.createdAt, new Date(cursor.t)),
                  and(eq(agentRuns.createdAt, new Date(cursor.t)), lt(agentRuns.id, cursor.id)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
        .limit(limit + 1);

      const items = rows.map((row) => row.run).slice(0, limit);
      const last = items.at(-1);
      const hasMore = rows.length > limit;
      return {
        items,
        nextCursor:
          hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null,
      };
    },

    async recordApplied(workspaceId, input) {
      const runId = requireNonEmpty(input.runId, "runId");
      const versionId = requireNonEmpty(input.versionId, "versionId");
      const batchSha256 = requireBatchSha256(input.batchSha256, "batchSha256");

      // tenant filter FIRST (law #3): cross-tenant run ids read as 404.
      const run = await requireRun(workspaceId, runId);
      if (run.status === "cancelled") {
        throw DbError.conflict("A cancelled run cannot be applied");
      }
      if (run.appliedAt !== null) {
        throw DbError.conflict("This run was already applied");
      }

      // The applied version must be a version of THIS run's project.
      await requireProjectVersion(run.projectId, versionId, "version");

      // Base version: verify/backfill, never silently rewrite (§9.3).
      let baseVersionId: string | undefined;
      if (input.baseVersionId !== undefined && input.baseVersionId !== null) {
        const claimed = requireNonEmpty(input.baseVersionId, "baseVersionId");
        await requireProjectVersion(run.projectId, claimed, "base version");
        if (run.baseVersionId !== null && run.baseVersionId !== claimed) {
          throw DbError.versionConflict({
            expectedVersionId: run.baseVersionId,
            currentVersionId: claimed,
          });
        }
        baseVersionId = claimed;
      }

      const values: Partial<typeof agentRuns.$inferInsert> = {
        appliedAt: new Date(),
        appliedBatchSha256: batchSha256,
        appliedVersionId: versionId,
        ...(baseVersionId !== undefined ? { baseVersionId } : {}),
        // First applied version doubles as the run's result version; never
        // overwrite an already-recorded result (immutability at the column).
        ...(run.resultVersionId === null ? { resultVersionId: versionId } : {}),
      };

      // Guarded update: concurrent applies/late cancels lose the race here.
      const [updated] = await db
        .update(agentRuns)
        .set(values)
        .where(
          and(
            eq(agentRuns.id, run.id),
            isNull(agentRuns.appliedAt),
            ne(agentRuns.status, "cancelled"),
          ),
        )
        .returning();
      if (updated) return updated;

      const [current] = await db.select().from(agentRuns).where(eq(agentRuns.id, run.id)).limit(1);
      if (current?.appliedAt != null) {
        throw DbError.conflict("This run was already applied");
      }
      throw DbError.conflict("A cancelled run cannot be applied");
    },

    async recordUndone(workspaceId, input) {
      const runId = requireNonEmpty(input.runId, "runId");
      const userId = requireNonEmpty(input.userId, "userId");

      const run = await requireRun(workspaceId, runId);
      if (run.appliedAt === null) {
        throw DbError.conflict("This run has not been applied yet");
      }
      if (run.undoneAt !== null) {
        throw DbError.conflict("This run was already undone");
      }

      const [actor] = await db
        .select({ id: user.id })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1);
      if (!actor) throw DbError.notFound("user");

      const [updated] = await db
        .update(agentRuns)
        .set({ undoneAt: new Date(), undoneBy: userId })
        .where(
          and(eq(agentRuns.id, run.id), isNotNull(agentRuns.appliedAt), isNull(agentRuns.undoneAt)),
        )
        .returning();
      if (updated) return updated;

      const [current] = await db.select().from(agentRuns).where(eq(agentRuns.id, run.id)).limit(1);
      if (current && current.appliedAt === null) {
        throw DbError.conflict("This run has not been applied yet");
      }
      throw DbError.conflict("This run was already undone");
    },

    async getPlanState(workspaceId, runId) {
      const run = await requireRun(workspaceId, requireNonEmpty(runId, "runId"));
      return toPlanState(run);
    },

    // ── Round 12 client-driven agent loop (trusted-internal) ──────────────────

    async insertToolCallStep(input) {
      const runId = requireNonEmpty(input.runId, "runId");
      const toolCallId = requireNonEmpty(input.toolCallId, "toolCallId");
      const tool = requireNonEmpty(input.tool, "tool");
      requireNonNegativeInt(input.stepIndex, "stepIndex");

      const run = await requireRunById(db, runId);
      if (input.threadId !== undefined && input.threadId !== run.threadId) {
        throw DbError.conflict("Run does not belong to this thread");
      }

      // seq: per-run monotonic allocation (UNIQUE(run_id, seq) stays intact —
      // one turn may emit SEVERAL tool calls, so stepIndex alone cannot key
      // the row). The client-driven loop is a single serial writer per run;
      // a racing duplicate insert still degrades to the typed CONFLICT below.
      const [last] = await db
        .select({ seq: agentSteps.seq })
        .from(agentSteps)
        .where(eq(agentSteps.runId, run.id))
        .orderBy(desc(agentSteps.seq))
        .limit(1);
      const seq = (last?.seq ?? -1) + 1;

      try {
        const [step] = await db
          .insert(agentSteps)
          .values({
            id: createId("stp"),
            runId: run.id,
            seq,
            tool,
            argsJson: input.argsJson,
            status: "issued",
            durationMs: null,
            toolCallId,
          })
          .returning();
        if (!step) throw DbError.conflict("Could not insert step");
        return step;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw DbError.conflict(`Step ${seq} already exists for this run`);
        }
        throw error;
      }
    },

    async completeToolStep(input) {
      const toolCallId = requireNonEmpty(input.toolCallId, "toolCallId");
      // 12-w8 audit hardening: an optional run scope rides the UPDATE's WHERE
      // clause — a foreign run's toolCallId simply matches no row (typed
      // NOT_FOUND), never a cross-run settle.
      const scope =
        input.runId !== undefined && input.runId !== ""
          ? and(eq(agentSteps.toolCallId, toolCallId), eq(agentSteps.runId, input.runId))
          : eq(agentSteps.toolCallId, toolCallId);
      const [settled] = await db
        .update(agentSteps)
        .set({ status: "success", resultJson: input.resultJson })
        .where(scope)
        .returning();
      if (settled) return settled;
      throw DbError.notFound("step");
    },

    async touchRunHeartbeat(input) {
      const runId = requireNonEmpty(input.runId, "runId");
      const lastStepIndex = requireNonNegativeInt(input.lastStepIndex, "lastStepIndex");
      const creditsCommitted =
        input.creditsCommitted === undefined
          ? undefined
          : requireNonNegativeInt(input.creditsCommitted, "creditsCommitted");

      const run = await requireRunById(db, runId);
      assertRunTransition(run.status, "running");
      const [updated] = await db
        .update(agentRuns)
        .set({
          status: "running",
          lastStepIndex,
          heartbeatAt: new Date(),
          ...(creditsCommitted === undefined ? {} : { committedCredits: creditsCommitted }),
        })
        .where(and(eq(agentRuns.id, run.id), eq(agentRuns.status, run.status)))
        .returning();
      if (!updated) throw DbError.conflict("Run state changed concurrently");
      return updated;
    },

    async markRunAbandoned(input) {
      const runId = requireNonEmpty(input.runId, "runId");
      const run = await requireRunById(db, runId);
      if (run.status === "cancelled") return run; // idempotent re-sweep
      assertRunTransition(run.status, "cancelled");
      const [updated] = await db
        .update(agentRuns)
        .set({
          status: "cancelled",
          errorCode: RUN_ABANDONED_ERROR_CODE,
          completedAt: new Date(),
        })
        .where(and(eq(agentRuns.id, run.id), eq(agentRuns.status, run.status)))
        .returning();
      if (updated) return updated;
      const [current] = await db.select().from(agentRuns).where(eq(agentRuns.id, run.id)).limit(1);
      if (current?.status === "cancelled") return current;
      throw DbError.conflict("Run state changed concurrently");
    },

    async getStaleRunningRuns(staleAfterMs) {
      const afterMs = staleAfterMs === undefined ? RUN_STALE_AFTER_MS : staleAfterMs;
      requirePositiveInt(afterMs, "staleAfterMs");
      const cutoff = new Date(Date.now() - afterMs);
      const rows = await db
        .select({ run: agentRuns, workspaceId: projects.workspaceId })
        .from(agentRuns)
        .innerJoin(projects, eq(agentRuns.projectId, projects.id))
        .where(and(eq(agentRuns.status, "running"), lt(agentRuns.heartbeatAt, cutoff)))
        .orderBy(asc(agentRuns.heartbeatAt), asc(agentRuns.id));
      return rows.map((row) => ({ ...row.run, workspaceId: row.workspaceId }));
    },
  };
}
