// apps/worker/src/run-manager/deps.ts — the §3.3/§5.1 pipeline's injected seams.
// Owner: W6-N (docs/AGENTS.md). The processor (processor.ts) is DI-pure: every
// collaborator arrives here, so tests run the WHOLE pipeline (planner → executor
// → observer → validator → critic → repair → commit → settlement) on fakes only.
//
// Spec anchors:
//   §3.3  the worker's run lifecycle — every numbered step maps onto a seam here.
//   §3.2  engine sessions are per document/tenant; the factory below hands the
//         processor ONE handle per run and takes it back on release().
//   §3.4  crash recovery ("restart, replay to checkpoint, resume once") is a
//         hook, not an inline concern; cancellation is OBSERVED (W6-J contract)
//         through a pollable source so every stage can check it.
//   §5.3  model routing: the adapters per role arrive via a factory keyed by the
//         run (tier class, workspace plan) — the router/circuit breakers live in
//         the wiring (registry.ts), never in the loop.
//   §6.2  the ToolContext the executor's tools run in is assembled per run by the
//         tools factory (engine session, db, templates, assets, budgets, brand).
//   §14.2 the ledger store is @studio/billing's `LedgerStore` seam, unchanged.
//
// Deep-import note: the Wave-6 agent services (planner/executor/observer/
// validator/critic/repair/transactions/budgets-service) are NOT re-exported by
// the @studio/agent barrel yet (each owner flagged the one-line barrel add for
// the wiring wave), and the package exports map exposes only ".". Following the
// fleet precedent (apps/gateway/src/services/assets.ts imports
// ../../../../packages/storage/src/*), the run manager reaches the sources with
// relative paths. When the barrel adopts the directories, these imports can
// collapse to "@studio/agent" one-liners.

import type { RunTierId } from "@studio/config";
import type { LedgerStore } from "@studio/billing";
import type {
  BudgetTracker,
  Plan,
  PublishResult,
  RunEventPayloadMap,
  RunEventType,
} from "@studio/agent";
import type { Logger } from "../logger.js";
import type { Clock as RunClock } from "../../../../packages/agent/src/budgets.js";
import type { PlanModelLike } from "../../../../packages/agent/src/planner/planner.js";
import type { ExecuteModelLike } from "../../../../packages/agent/src/executor/executor.js";
import type { RepairModelLike } from "../../../../packages/agent/src/repair/planner.js";
import type { ValidateToolLike } from "../../../../packages/agent/src/validator/service.js";
import type { CriticToolLike } from "../../../../packages/agent/src/critic/service.js";
import type { ObserverSeams } from "../../../../packages/agent/src/observer/observer.js";
import type { SnapshotLike } from "../../../../packages/agent/src/observer/observer.js";
import type {
  CheckpointInput,
  CheckpointLike,
  EngineTxLike,
  StorageLike,
  WalAppendLike,
} from "../../../../packages/agent/src/transactions/manager.js";
import type { TierBudgetTracker } from "../../../../packages/agent/src/budgets-service/tracker-factory.js";
import type {
  AnyTool,
  CriticModelLike,
  TemplateCatalogLike,
  ToolContext,
  ToolListing,
} from "@studio/tools";
import type { ObjectStorage, PreviewEngine } from "../preview.js";

// ---------------------------------------------------------------------------
// Run row — the structural slice of `agent_runs` the loop needs (W1-E schema).
// Kept decoupled from @studio/db so tests (and the processor) never load drizzle.
// ---------------------------------------------------------------------------

/** Typed error envelope (§13.3 / processor.ts shape). */
export interface RunManagerError {
  readonly code: string;
  readonly message: string;
  readonly hint?: string;
  readonly retryable?: boolean;
}

/** §5.1 statuses, identical strings to `agent_runs.status` (state.ts union). */
export type RunRecordStatus =
  | "queued"
  | "planning"
  | "executing"
  | "observing"
  | "rendering"
  | "validating"
  | "critiquing"
  | "repairing"
  | "finalizing"
  | "succeeded"
  | "succeeded_with_warnings"
  | "failed"
  | "cancelled";

export interface RunRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly documentId: string;
  readonly userId: string;
  readonly prompt: string;
  readonly tier: RunTierId;
  readonly status: RunRecordStatus;
  readonly idempotencyKey: string;
  /** §5.6 revision at run start (gateway captured it from the document row). */
  readonly revisionBefore: number;
  /** §14.2 rule 1 hold the gateway placed before enqueueing. */
  readonly creditsReserved: number;
  readonly creditsCharged: number;
  readonly error?: RunManagerError | null;
  /** §5.5 plan once the planner produced one (the resume path reuses it). */
  readonly plan?: Plan | null;
}

/** Terminal write at the end of the run (§3.3 steps 6/7). */
export interface FinalizeRunInput {
  readonly runId: string;
  readonly status: Extract<RunRecordStatus, "succeeded" | "succeeded_with_warnings" | "failed" | "cancelled">;
  readonly revisionAfter?: number;
  readonly creditsCharged: number;
  readonly error?: RunManagerError;
  readonly finishedAt: Date;
}

/** §22 usage rollup persisted with the terminal (numbers, never content). */
export interface RunUsageRecord {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheHits: number;
}

/**
 * Persistence seam over `agent_runs` (+ the usage columns). The drizzle
 * implementation lives in run-repository.ts; tests fake this whole interface.
 */
export interface RunRepository {
  loadRun(runId: string): Promise<RunRecord | undefined>;
  /** §5.1 state machine persistence; the processor guards transitions first. */
  updateStatus(runId: string, status: RunRecordStatus): Promise<void>;
  savePlan(runId: string, plan: Plan): Promise<void>;
  recordUsage(runId: string, usage: RunUsageRecord): Promise<void>;
  finalizeRun(input: FinalizeRunInput): Promise<void>;
}

// ---------------------------------------------------------------------------
// §13.2/§22 durable event emission
// ---------------------------------------------------------------------------

/**
 * One typed run-event publish. Structurally `RunEventBus.publish` (W2-P): the
 * processor awaits it (§22 durability over latency) and a failure at a stage
 * boundary fails the run — the timeline must never silently drop steps.
 */
export type EmitRunEvent = <T extends RunEventType>(
  runId: string,
  type: T,
  payload: RunEventPayloadMap[T],
  context: { readonly organizationId: string },
) => Promise<PublishResult<T>>;

// ---------------------------------------------------------------------------
// §3.2 engine session — one handle per run
// ---------------------------------------------------------------------------

/** Evidence that the engine died mid-run (§3.4 crash classification input). */
export interface EngineCrashEvidence {
  /** Sanitized code (engine_crashed / engine_unavailable / …); never a path. */
  readonly code: string;
  readonly detail?: string;
}

/**
 * One live engine session bound to the run's document. The adapters over the
 * engine client live in engine-session.ts; the handle stays opaque to the loop.
 */
export interface EngineSessionHandle {
  readonly sessionId: string;
  /** §5.6 surface for the TransactionManager (agent.begin/commit/rollback + save). */
  readonly tx: EngineTxLike;
  /** §6.2 ctx.engine surface the tools run against. */
  readonly commands: import("@studio/tools").EngineLike;
  /** preview.ts render seam (doc.render + write-root read), bound to the session. */
  readonly previewEngine: PreviewEngine;
  /** Crash classification, latched by the adapters on crash-class failures. */
  crashed(): EngineCrashEvidence | null;
  /** Returns the session to the pool (§3.2 idle keep-warm). Never throws. */
  release(): Promise<void>;
}

export interface AcquireEngineSessionInput {
  readonly runId: string;
  readonly organizationId: string;
  readonly documentId: string;
  readonly tier: RunTierId;
}

/** §3.2/§3.3 step 3: allocate or attach the engine session for one run. */
export interface EngineSessionFactory {
  acquire(input: AcquireEngineSessionInput): Promise<EngineSessionHandle>;
}

// ---------------------------------------------------------------------------
// §3.4 crash recovery — "restart, replay to checkpoint, resume once"
// ---------------------------------------------------------------------------

export interface EngineRecoveryRequest {
  readonly runId: string;
  readonly organizationId: string;
  readonly documentId: string;
  readonly sessionId: string;
  readonly evidence: EngineCrashEvidence;
}

/** Where the replayed WAL left the fresh session (§5.6 cursor shapes). */
export interface RecoveryResumeCursor {
  /** Last durable command-log seq applied by the replay. */
  readonly seq: number;
  /** Document revision after the replay (must match agent.begin's echo). */
  readonly revision: number;
}

export type EngineRecoveryResult =
  | {
      readonly ok: true;
      readonly session: EngineSessionHandle;
      /** Replay counts against run budgets (§3.4/§5.2). */
      readonly replayedCommands: number;
      readonly resume: RecoveryResumeCursor;
    }
  | {
      readonly ok: false;
      readonly failure: RunManagerError;
      /**
       * True when the resume-once budget was spent (terminal: engine_session_lost).
       * False = an infra failure the queue may retry (recovery-contract.md).
       */
      readonly spentResume: boolean;
    };

/** The §3.4 hook: reallocate + replay + hand the loop a fresh session. */
export interface EngineCrashRecovery {
  recover(request: EngineRecoveryRequest): Promise<EngineRecoveryResult>;
}

// ---------------------------------------------------------------------------
// Cancellation (W6-J contract) — observed at every stage boundary
// ---------------------------------------------------------------------------

export interface RunCancellationSnapshot {
  readonly cancelled: boolean;
  /** Curated, user-safe sentence (never a stack or internal id). */
  readonly reason?: string;
}

export interface RunCancellationSource {
  observe(runId: string): Promise<RunCancellationSnapshot>;
}

// ---------------------------------------------------------------------------
// §6.2 tools — the per-run ToolContext bundle
// ---------------------------------------------------------------------------

/** Everything the loop needs to run tools + observe the document. */
export interface ToolContextBundle {
  /** Executor dispatch map: §6 tool name → tool (TOOLS_DEFAULT by default). */
  readonly tools: Readonly<Record<string, AnyTool>>;
  /** Model-visible manifest: name + description ONLY (§6.1). */
  readonly manifest: readonly ToolListing[];
  /** The §6.2 context every tool run receives (engine, db, templates, assets…). */
  readonly toolContext: ToolContext;
  /** §7 template catalog — also the planner's CATALOG template source. */
  readonly templates: TemplateCatalogLike;
  /** §5.4/§6 row 1 compact summary seam (ObserverService input). */
  readonly snapshot: SnapshotLike;
  /** §5.1/§6 row 14 preview persist seam (ObserverService input). */
  readonly preview: ObserverSeams["preview"];
}

export interface CreateToolContextInput {
  readonly run: RunRecord;
  readonly session: EngineSessionHandle;
  /** The run's §5.2 tracker (the factory adapts it to ctx.budgets). */
  readonly budget: TierBudgetTracker;
  /** Cooperative deadline: run wall clock + user cancellation (aborted on cancel). */
  readonly signal: AbortSignal;
}

/** Per-run ToolContext assembly (registry.ts wires the real adapters). */
export interface ToolContextFactory {
  create(input: CreateToolContextInput): Promise<ToolContextBundle>;
}

// ---------------------------------------------------------------------------
// §5.3 model adapters per run (planner / executor / critic / repair + tool seams)
// ---------------------------------------------------------------------------

export interface RunModelAdapters {
  /** §23.2 planner model (route: planner row of the tier's class). */
  readonly planner: PlanModelLike;
  /** §23.1 executor model loop (route: executor row). */
  readonly executor: ExecuteModelLike;
  /** §23.4 repair model (route: executor-class; worker wires failover). */
  readonly repair: RepairModelLike;
  /** tools/vision-critique `ctx.critic` seam (§23.3 prompt + downscaled render). */
  readonly criticModel: CriticModelLike;
  /** agent RunCritic tool seam — vision_critique bound to the run's ToolContext. */
  readonly criticTool: CriticToolLike;
  /** agent RunValidator seam — validate_document bound to the ToolContext. */
  readonly validator: ValidateToolLike;
}

export interface CreateModelAdaptersInput {
  readonly run: RunRecord;
  readonly bundle: ToolContextBundle;
  readonly signal: AbortSignal;
}

/** §5.3 routing per run: tier class → provider routes → the four model seams. */
export interface ModelAdapterFactory {
  forRun(input: CreateModelAdaptersInput): Promise<RunModelAdapters>;
}

// ---------------------------------------------------------------------------
// §5.6 transaction seams (the TransactionManager's injected collaborators)
// ---------------------------------------------------------------------------

/** Checkpoint row factory bound to one run (document_versions + run row). */
export type CheckpointForRun = (run: RunRecord) => CheckpointLike;

export interface TransactionSeams {
  /** Append-only command log (`commands` table adapter). */
  readonly wal: WalAppendLike;
  /** Object storage for the committed .pcraft (§3.3 step 6). */
  readonly storage: StorageLike;
  /** Durable checkpoint writer per run (document_versions, §5.6). */
  readonly checkpointFor: CheckpointForRun;
  /** §5.7 cap on mutating commands per run (config MAX_MUTATING_COMMANDS_PER_RUN). */
  readonly maxMutatingCommandsPerRun?: number;
}

/** Input of the checkpoint seam, re-exported for the registry adapters. */
export type { CheckpointInput, CheckpointLike, StorageLike, WalAppendLike, EngineTxLike };

// ---------------------------------------------------------------------------
// Previews — the §5.1 ≤1024 px render pipeline (apps/worker/src/preview.ts)
// ---------------------------------------------------------------------------

/** Structural slice of PreviewPipeline.renderPreview (the class satisfies it). */
export interface PreviewPipelineLike {
  renderPreview(
    engine: PreviewEngine,
    request: {
      readonly organizationId: string;
      readonly documentId: string;
      readonly width: number;
      readonly revision: number;
      readonly purpose?: "agent" | "interactive";
    },
  ): Promise<import("../preview.js").PreviewOutcome<import("../preview.js").PreviewUrlResult>>;
}

// ---------------------------------------------------------------------------
// The deps bundle
// ---------------------------------------------------------------------------

/** Env keys the default wiring reads (registry.ts parses; secrets never echoed). */
export interface RunManagerEnv {
  readonly [key: string]: string | undefined;
}

/**
 * The two runtime seams that cannot be wired from this repo's packages yet:
 * the engine-pool bridge (session allocation + §3.4 recovery) and the §5.3
 * provider implementations (AI SDK adapters per provider id). Everything else
 * in RunManagerDeps has a real default in registry.ts.
 */
export interface RunManagerRuntime {
  /** §3.2 session acquisition from the engine pool (apps/engine-pool bridge). */
  readonly engines: EngineSessionFactory;
  /** §3.4 recovery hook (engine-pool RecoveryCoordinator bridge). */
  readonly recovery: EngineCrashRecovery;
  /** §5.3 provider seam per id (registry adapts to the four model roles). */
  readonly providers: Readonly<Record<string, unknown>>;
  /** Object storage driver (§3.1) — @studio/storage instance. */
  readonly objects: ObjectStorage;
}

export interface RunManagerDeps {
  /** Structured logger (worker Logger; never console.*). */
  readonly logger: Logger;
  /** `agent_runs` persistence. */
  readonly db: RunRepository;
  /** §14.2 ledger (reserve/commit/refund idempotency lives in @studio/billing). */
  readonly ledger: LedgerStore;
  /** §13.2/§22 durable run-event publish. */
  readonly emit: EmitRunEvent;
  /** §3.2 engine sessions. */
  readonly engines: EngineSessionFactory;
  /** §3.4 crash recovery hook. */
  readonly recovery: EngineCrashRecovery;
  /** W6-J cancellation contract, polled at every stage. */
  readonly cancellation: RunCancellationSource;
  /** §5.3 model adapters per run. */
  readonly models: ModelAdapterFactory;
  /** §6.2 ToolContext assembly per run. */
  readonly tools: ToolContextFactory;
  /** §5.1 preview renders. */
  readonly previews: PreviewPipelineLike;
  /** §5.6 transaction collaborators. */
  readonly transactions: TransactionSeams;
  /** Deterministic clock for tests/replays (defaults to Date.now). */
  readonly clock?: RunClock;
}

export type { BudgetTracker, Plan };
