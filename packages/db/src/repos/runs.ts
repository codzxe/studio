import { and, asc, desc, eq, lt, or } from "drizzle-orm";

import { type Page, clampLimit, decodeCursor, encodeCursor } from "../cursor.js";
import type { StudioDb } from "../db.js";
import { DbError } from "../errors-lite.js";
import { createId } from "../ids.js";
import {
  type AgentRun,
  type AgentStep,
  type RunStatus,
  type StepStatus,
  agentRuns,
  agentSteps,
  agentThreads,
  projects,
} from "../schema.js";
import { assertRunTransition, isTerminalRunStatus } from "../statuses.js";
import { type WorkspaceId, requireNonEmpty } from "./shared.js";

/** Runs repository — one agent turn from prompt to applied result (§3.1, §7.4). */
export interface RunCreateInput {
  readonly threadId: string;
  readonly projectId: string;
  readonly model: string;
  readonly baseVersionId?: string | null;
  readonly reservedCredits?: number;
  readonly planJson?: unknown;
}

export interface RunUpdateInput {
  readonly status?: RunStatus;
  readonly planJson?: unknown;
  readonly reservedCredits?: number;
  readonly committedCredits?: number;
  readonly resultVersionId?: string | null;
  readonly errorCode?: string | null;
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
}

export function createRunsRepo(db: StudioDb): RunsRepo {
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
          id: createId("run"),
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
        if (
          typeof error === "object" &&
          error !== null &&
          (error as { code?: unknown }).code === "23505"
        ) {
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
  };
}
