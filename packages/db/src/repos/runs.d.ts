import { type Page } from "../cursor.js";
import type { StudioDb } from "../db.js";
import { type AgentRun, type AgentStep, type RunStatus, type StepStatus } from "../schema.js";
import { type WorkspaceId } from "./shared.js";
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
    listByThread(workspaceId: WorkspaceId, threadId: string, options?: ListOptions): Promise<Page<AgentRun>>;
    /** M5.4: mark the run applied — the apply created `versionId` (ONE version). */
    recordApplied(workspaceId: WorkspaceId, input: RecordAppliedInput): Promise<AgentRun>;
    /** M5.5: mark the run undone — the version row is never deleted (§9.3). */
    recordUndone(workspaceId: WorkspaceId, input: RecordUndoneInput): Promise<AgentRun>;
    /** Plan lifecycle projection of a run — cross-tenant reads as NOT_FOUND. */
    getPlanState(workspaceId: WorkspaceId, runId: string): Promise<PlanState>;
}
/** Pure projection of the apply/undo columns onto the plan lifecycle. */
export declare function toPlanState(run: Pick<AgentRun, "appliedAt" | "appliedBatchSha256" | "appliedVersionId" | "baseVersionId" | "undoneAt">): PlanState;
export declare function createRunsRepo(db: StudioDb): RunsRepo;
