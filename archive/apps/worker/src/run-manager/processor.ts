// apps/worker/src/run-manager/processor.ts — the §3.3/§5.1 run pipeline.
// Owner: W6-N (docs/AGENTS.md). THE PIPELINE HEART.
//
// `StudioRunProcessor` implements W1-I's `RunProcessor` (../processor.ts) and
// wires every Wave-6 service together, fully injected (`RunManagerDeps`,
// deps.ts): the loop constructs no infrastructure of its own.
//
// Lifecycle mapped to spec (§3.3 steps 3–7, §5.1 the loop):
//
//   load run row → idempotent terminal replay (§3.4 retries never double-apply)
//   → planning     PlannerService (§23.2; §5.1 plan-first) → emit run.plan
//   → transaction  TransactionManager.begin (§5.6 agent.begin) → emit run.started
//   → executing    ExecutorService walks plan.steps (§5.1 small steps)
//   → observing    ObserverService.afterAction (§5.1 observe-after-act); the
//                  ≤1024 px preview rides here → emit preview.updated
//   → rendering → validating   RunValidator (§11.1) → validateGate (§5.1 table)
//   → critiquing   RunCritic (§23.3; §5.3 quick tier skips) → cycleGate
//   → repairing    planRepairs (§23.4) → executor phase "repairing" → observing
//                  (× ≤ MAX_REPAIR_CYCLES, §5.1)
//   → finalizing   settlement (§5.2 computeSettlement) → agent.commit + .pcraft +
//                  checkpoint (§3.3 step 6) → ledger commit/partial →
//                  succeeded | succeeded_with_warnings → emit run.succeeded +
//                  credits.charged
//   ↘ any typed failure / cancel / crash: agent.rollback → §14.2 refund
//      (classifyRefund; §24.4 retry_grace hint) → run.failed | run.cancelled.
//
// Cancellation (W6-J contract) is OBSERVED at every stage boundary through
// `deps.cancellation` in addition to the BullMQ wall-clock AbortSignal; the
// internal signal aborts the moment either fires. Engine crashes (§3.4) are
// latched by the session adapters and handed to `deps.recovery` — resume ONCE.
//
// Deep-import note: see deps.ts (the @studio/agent barrel does not re-export
// the Wave-6 service directories yet; relative source imports follow the
// apps/gateway precedent).

import {
  MAX_MUTATING_COMMANDS_PER_RUN,
  MAX_REPAIR_CYCLES,
  type RunTierId,
  resolveTierConfig,
} from "@studio/config";
import {
  type Plan,
  type RunEventPayloadMap,
  type RunEventType,
  canTransition,
} from "@studio/agent";
import {
  classifyRefund,
  commitReservation,
  maxPartialFailureCharge,
  releaseReservation,
} from "@studio/billing";
import type { ToolListing } from "@studio/tools";
import {
  PlannerService,
  type PlannerSections,
} from "../../../../packages/agent/src/planner/planner.js";
import {
  EXECUTOR_DEFAULT_TOOL_CALL_TIMEOUT_MS,
  ExecutorService,
  type EmitExecutorStepEvent,
} from "../../../../packages/agent/src/executor/executor.js";
import {
  ObserverService,
  type Observation,
} from "../../../../packages/agent/src/observer/observer.js";
import {
  RunValidator,
  type ValidatorReport,
} from "../../../../packages/agent/src/validator/service.js";
import { validateGate } from "../../../../packages/agent/src/validator/gate.js";
import {
  RunCritic,
  type CritiqueIssue,
  type CritiqueResult,
  createRepairCycleCounter,
  criticRouteEnabled,
} from "../../../../packages/agent/src/critic/service.js";
import { cycleGateForOutcome } from "../../../../packages/agent/src/critic/cycle-gate.js";
import {
  buildRepairMiniPlan,
  planRepairs,
  type RepairIssueInput,
} from "../../../../packages/agent/src/repair/planner.js";
import {
  createBudgetTracker,
  type TierBudgetTracker,
} from "../../../../packages/agent/src/budgets-service/tracker-factory.js";
import {
  computeSettlement,
  partialChargeCredits,
  type Settlement,
} from "../../../../packages/agent/src/budgets-service/settlement.js";
import { TransactionManager } from "../../../../packages/agent/src/transactions/manager.js";
import type { Clock } from "../../../../packages/agent/src/budgets.js";
import type { TemplateCatalogLike } from "@studio/tools";
import type {
  EngineSessionHandle,
  RunManagerDeps,
  RunModelAdapters,
  RunRecord,
  ToolContextBundle,
} from "./deps.js";
import { EngineSessionCrashError } from "./crash.js";
import { EmissionError, emitRunEventOk, emitTerminalBestEffort } from "./emit.js";
import type {
  RunError,
  RunJobContext,
  RunOutcome,
  RunProcessor,
} from "../processor.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** §3.4: "restart, replay to checkpoint, resume once" — one resume per run. */
export const MAX_ENGINE_RESUMES_PER_RUN = 1;

/** §5.4 token discipline: catalog templates enriched with slots for the planner. */
export const MAX_PLANNER_TEMPLATE_ENTRIES = 25;

/** §5.6 history-entry label for the run's single undoable transaction. */
export function transactionNameFor(run: RunRecord): string {
  return `agent-run ${run.id.slice(0, 64)}`;
}

// ---------------------------------------------------------------------------
// Internal typed errors (never cross the RunProcessor seam)
// ---------------------------------------------------------------------------

/** Infra/pipeline bug — maps to an `internal_error` outcome (§13.3). */
export class RunPipelineError extends Error {
  constructor(message: string) {
    super(`[run-manager] ${message}`);
    this.name = "RunPipelineError";
  }
}

/** A typed terminal request: refund cause + user-safe error envelope. */
export class PlannedFailure extends Error {
  constructor(
    readonly cause: PipelineRefundCause,
    readonly error: RunError,
  ) {
    super(`[run-manager] planned failure (${cause}): ${error.code}`);
    this.name = "PlannedFailure";
  }
}

/** User cancellation or §3.4 wall-clock timeout, observed at a stage boundary. */
export class CancelledRun extends Error {
  constructor(
    readonly kind:
      | { readonly cause: "user_cancel"; readonly reason?: string }
      | { readonly cause: "engine_timeout" },
  ) {
    super(`[run-manager] run stopped (${kind.cause})`);
    this.name = "CancelledRun";
  }
}

function runError(
  code: string,
  message: string,
  options: { readonly hint?: string; readonly retryable?: boolean } = {},
): RunError {
  const error: { code: string; message: string; hint?: string; retryable?: boolean } = {
    code,
    message,
  };
  if (options.hint !== undefined) {
    error.hint = options.hint;
  }
  if (options.retryable !== undefined) {
    error.retryable = options.retryable;
  }
  return error;
}

const INTERNAL_ERROR = "internal_error";

// ---------------------------------------------------------------------------
// §5.2 settlement for clean stops (pure; exercised through the pipeline tests)
// ---------------------------------------------------------------------------

/** Why the execute walk ended early: a §5.2 tier cap or the §5.1 round-trip cap. */
export type CleanStopKind = "budget_stopped" | "round_trip_stopped";

export interface CleanStopSettlementInput {
  readonly tier: RunTierId;
  readonly report: ReturnType<TierBudgetTracker["report"]>;
  readonly validatorPassed: boolean;
  readonly documentImproved: boolean;
  /** The executor's §5.2 "what was cut" sentence. */
  readonly cutMessage: string;
}

/**
 * The §5.2 clean-stop settlement for ANY executor early stop. Tier-budget
 * stops delegate to W6-G's `computeSettlement` table verbatim; the §5.1
 * round-trip cap is the same FEATURE with the same pricing (predictable
 * pricing, never an error), so it mirrors the table with the exact §5.2 partial
 * formula (`partialChargeCredits`). Validation still gates: §5.2 commits only
 * validator-passing work.
 */
export function settlementForCleanStop(input: CleanStopSettlementInput): Settlement {
  const { tier, report, validatorPassed, documentImproved, cutMessage } = input;
  if (report.stopped) {
    return computeSettlement(report, tier, { validatorPassed, documentImproved });
  }
  if (!validatorPassed) {
    return computeSettlement(report, tier, { validatorPassed: false, documentImproved });
  }
  const reservedCredits = resolveTierConfig(tier).credits;
  if (documentImproved) {
    const charge = partialChargeCredits(
      reservedCredits,
      report.phasesCompleted,
      report.phasesTotal,
    );
    return Object.freeze({
      policy: "partial",
      tier,
      reservedCredits,
      chargeCredits: charge,
      releaseCredits: reservedCredits - charge,
      completed: false,
      stopped: false,
      validatorPassed: true,
      documentImproved: true,
      partialChargeCredits: charge,
      note: `${cutMessage} Charged ${charge} of ${reservedCredits} reserved credits for the ${report.phasesCompleted} of ${report.phasesTotal} phases that finished (§5.1/§5.2).`,
    });
  }
  return Object.freeze({
    policy: "refund_all",
    tier,
    reservedCredits,
    chargeCredits: 0,
    releaseCredits: reservedCredits,
    completed: false,
    stopped: false,
    validatorPassed: true,
    documentImproved: false,
    partialChargeCredits: null,
    note: `${cutMessage} The run stopped before it strengthened the document — released all ${reservedCredits} reserved credits.`,
  });
}

// ---------------------------------------------------------------------------
// §14.2/§24.4 refund classification for non-budget terminals
// ---------------------------------------------------------------------------

export type PipelineRefundCause =
  | "user_cancel"
  | "provider_failure"
  | "our_bug"
  | "engine_crashed"
  | "engine_timeout"
  | "engine_error"
  | "validation_failed"
  | "budget_stop";

/**
 * Credits charged when a failure rolls the document back (§14.2 rules 3–5):
 * full-refund causes release everything; §14.2 rule-4 partial causes charge at
 * most half the base AND only when mutating calls actually progressed — the
 * rollback restores the pre-run document either way (§3.4; policy.ts's own
 * "the caller still passes a partial charge of 0 when no mutating command ran").
 * Budget stops never route here (settlementForCleanStop owns them → "none").
 */
export function refundChargeCredits(
  cause: PipelineRefundCause,
  reservedCredits: number,
  mutatingCallsExecuted: number,
): number {
  const policy = classifyRefund(cause);
  if (policy === "full_refund" || policy === "none") {
    return 0;
  }
  if (mutatingCallsExecuted <= 0) {
    return 0;
  }
  return maxPartialFailureCharge(reservedCredits);
}

// ---------------------------------------------------------------------------
// §23.2 planner-section assembly
// ---------------------------------------------------------------------------

interface PlannerTemplateEntryLike {
  readonly id: string;
  readonly version: string;
  readonly slots?: readonly string[];
}

async function enrichTemplateEntries(
  templates: TemplateCatalogLike,
): Promise<readonly PlannerTemplateEntryLike[]> {
  let summaries: readonly { readonly id: string; readonly version: string }[] = [];
  try {
    summaries = await templates.list({ limit: MAX_PLANNER_TEMPLATE_ENTRIES });
  } catch {
    return []; // catalog hiccup ⇒ the planner may only go freeform (§23.2)
  }
  const entries: PlannerTemplateEntryLike[] = [];
  for (const summary of summaries.slice(0, MAX_PLANNER_TEMPLATE_ENTRIES)) {
    let slots: readonly string[] | undefined;
    try {
      const manifest = await templates.get(`${summary.id}@${summary.version}`);
      slots = manifest === undefined ? undefined : Object.keys(manifest.slots);
    } catch {
      slots = undefined;
    }
    entries.push({ id: summary.id, version: summary.version, slots });
  }
  return entries;
}

/**
 * The five §23.2 sections: BRIEF (the run prompt), SNAPSHOT/CATALOG (the §6.1
 * name+description manifest plus template entries enriched with slot names —
 * §23.2 "never invent slot names" needs them verifiable), BUDGET (the §5.2
 * row) and RULES (v1: the §11.1 catalog rides the validator, not the prompt).
 */
export async function buildPlannerSections(input: {
  readonly run: RunRecord;
  readonly manifest: readonly ToolListing[];
  readonly templates: TemplateCatalogLike;
}): Promise<PlannerSections> {
  const resolved = resolveTierConfig(input.run.tier);
  const entries = await enrichTemplateEntries(input.templates);
  return {
    brief: { prompt: input.run.prompt },
    snapshot: { templates: [...entries] },
    catalog: {
      tools: input.manifest.map((tool) => ({ name: tool.name, description: tool.description })),
      templates: [...entries],
    },
    budget: {
      tier: input.run.tier,
      tokenBudgetIn: resolved.tokenBudgetIn,
      tokenBudgetOut: resolved.tokenBudgetOut,
      toolCallCap: resolved.toolCallCap,
      revisions: resolved.revisions,
    },
    rules: {},
  };
}

/** §5.1: surface the remaining issues as suggested manual fixes. */
export function remainingIssueWarnings(issues: readonly CritiqueIssue[]): readonly string[] {
  return issues.map((issue) => {
    const where = issue.layer === undefined ? "" : ` (${issue.layer})`;
    const fix = issue.fix ?? issue.observation ?? "manual fix suggested";
    return `${issue.code}${where}: ${fix}`;
  });
}

/** §3.4: the recorded outcome of a terminal row (idempotent reprocess). */
export function recordedOutcome(row: RunRecord): RunOutcome | null {
  switch (row.status) {
    case "succeeded":
    case "succeeded_with_warnings":
      return { status: row.status, creditsUsed: row.creditsCharged, warnings: [] };
    case "failed":
      return {
        status: "failed",
        creditsUsed: row.creditsCharged,
        error:
          row.error ??
          runError(INTERNAL_ERROR, "The run failed in a previous attempt.", {
            retryable: false,
          }),
      };
    case "cancelled":
      return {
        status: "failed",
        creditsUsed: row.creditsCharged,
        error:
          row.error ??
          runError("run_cancelled", "The run was cancelled in a previous attempt.", {
            retryable: false,
          }),
      };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Run state (single-owner, §5.2; threaded through every phase and §3.4 resumes)
// ---------------------------------------------------------------------------

interface PipelineState {
  readonly run: RunRecord;
  readonly budget: TierBudgetTracker;
  readonly log: RunManagerDeps["logger"];
  /** Internal cooperative signal: job wall clock + observed cancellation. */
  readonly signal: AbortSignal;
  abortRun(): void;
  session: EngineSessionHandle;
  /** §3.4 resume cursor after recovery replayed the WAL onto a fresh session. */
  resume: { readonly seq: number; readonly revision: number } | null;
  /** True when the resumed pass skips the execute walk (WAL already replayed). */
  resumedWithReplay: boolean;
  replayedCommandCount: number;
  txn: TransactionManager | null;
  /** True once agent.begin succeeded (rollback decisions depend on it). */
  txnBegun: boolean;
  revisionBefore: number | null;
  plan: Plan | null;
  /** Current persisted §5.1 status (transition-guarded). */
  status: RunRecord["status"];
  /** Executed mutating tool calls across execute/repair walks (§14.2 rule 4). */
  mutatingCalls: number;
  /** §5.1 repair cycles consumed (validator- and critic-driven alike). */
  repairCycles: number;
  /** True when the run must ship as succeeded_with_warnings (§5.1/§5.2). */
  shipWithWarnings: boolean;
  warnings: string[];
  validatorPassed: boolean | null;
  lastPreviewUrl: string | null;
  lastRevision: number | null;
  /** Executor clean-stop family, when the walk ended early (§5.1/§5.2). */
  cleanStop: CleanStopKind | null;
  cutMessage: string | null;
  emittedStarted: boolean;
}

// ---------------------------------------------------------------------------
// The processor
// ---------------------------------------------------------------------------

export class StudioRunProcessor implements RunProcessor {
  private readonly deps: RunManagerDeps;

  constructor(deps: RunManagerDeps) {
    this.deps = deps;
  }

  async process(job: RunJobContext): Promise<RunOutcome> {
    const runId = job.payload.runId;
    const log = this.deps.logger.child({ component: "run-manager", runId });
    const row = await this.deps.db.loadRun(runId);
    if (row === undefined) {
      log.error("run row missing — the gateway never created it (or a purge removed it)");
      return {
        status: "failed",
        error: runError("not_found", "The run does not exist; nothing was charged.", {
          hint: "The run row is created before enqueue (§3.3 step 2).",
          retryable: false,
        }),
      };
    }

    // §3.4 idempotency: a terminal row replays its recorded outcome; retries
    // can never double-apply or double-charge (§14.2 rule 6 keys sit on top).
    const replayed = recordedOutcome(row);
    if (replayed !== null) {
      log.info("run row already terminal — replaying the recorded outcome", {
        status: row.status,
      });
      return replayed;
    }

    if (job.payload.tier !== row.tier) {
      log.error("tier mismatch between the job payload and the run row");
      return await this.#refundTerminal({
        run: row,
        state: null,
        cause: "our_bug",
        status: "failed",
        error: runError(
          INTERNAL_ERROR,
          "The run was queued under a different tier than it was created with.",
          {
            hint: "The gateway enqueues the run with its row tier (§3.3 step 2).",
            retryable: false,
          },
        ),
      });
    }

    const budget = createBudgetTracker(row.tier, { clock: this.deps.clock });

    // Cooperative deadline: the BullMQ §5.2 wall clock plus observed user
    // cancellation (W6-J) share one internal signal every stage honours.
    const runAbort = new AbortController();
    const onWallClock = (): void => {
      runAbort.abort();
    };
    if (job.signal.aborted) {
      runAbort.abort();
    } else {
      job.signal.addEventListener("abort", onWallClock, { once: true });
    }

    let session: EngineSessionHandle | null = null;
    const state: PipelineState = {
      run: row,
      budget,
      log,
      signal: runAbort.signal,
      abortRun: () => runAbort.abort(),
      session: null as unknown as EngineSessionHandle,
      resume: null,
      resumedWithReplay: false,
      replayedCommandCount: 0,
      txn: null,
      txnBegun: false,
      revisionBefore: null,
      plan: row.plan ?? null, // §3.4 resume: the persisted plan replays
      status: row.status,
      mutatingCalls: 0,
      repairCycles: 0,
      shipWithWarnings: false,
      warnings: [],
      validatorPassed: null,
      lastPreviewUrl: null,
      lastRevision: null,
      cleanStop: null,
      cutMessage: null,
      emittedStarted: false,
    };

    try {
      session = await this.deps.engines.acquire({
        runId: row.id,
        organizationId: row.organizationId,
        documentId: row.documentId,
        tier: row.tier,
      });
      state.session = session;
      for (let resumeAttempts = 0; ; resumeAttempts += 1) {
        try {
          return await this.#pipeline(state);
        } catch (error) {
          if (!(error instanceof EngineSessionCrashError)) {
            throw error;
          }
          log.warn("engine session crashed mid-run — entering §3.4 recovery", {
            code: error.evidence.code,
            attempt: resumeAttempts + 1,
          });
          if (session !== null) {
            await session.release().catch(() => undefined);
            session = null;
          }
          if (resumeAttempts >= MAX_ENGINE_RESUMES_PER_RUN) {
            // §3.4: resume-once spent; the run dies cleanly at its checkpoint.
            throw new PlannedFailure(
              "engine_crashed",
              runError(
                "engine_crashed",
                "The engine crashed again after the single recovery resume; the document stays at its last committed checkpoint.",
                { hint: "Engine crash recovery resumes a run at most once (§3.4).", retryable: false },
              ),
            );
          }
          const recovered = await this.deps.recovery.recover({
            runId: row.id,
            organizationId: row.organizationId,
            documentId: row.documentId,
            sessionId: error.sessionId,
            evidence: error.evidence,
          });
          if (!recovered.ok) {
            throw new PlannedFailure(
              "engine_crashed",
              runError(recovered.failure.code, recovered.failure.message, {
                hint: recovered.failure.hint,
                retryable: recovered.spentResume ? false : recovered.failure.retryable,
              }),
            );
          }
          // §3.4/§5.2: replayed commands count against the run budgets.
          for (let i = 0; i < recovered.replayedCommands; i += 1) {
            budget.trackToolCall();
          }
          state.mutatingCalls += recovered.replayedCommands;
          state.resumedWithReplay = recovered.replayedCommands > 0;
          state.replayedCommandCount = recovered.replayedCommands;
          session = recovered.session;
          state.session = session;
          state.resume = recovered.resume;
          state.txn = null;
          state.txnBegun = false;
        }
      }
    } catch (error) {
      return await this.#failureFromThrow(error, state, row);
    } finally {
      job.signal.removeEventListener("abort", onWallClock);
      if (session !== null) {
        await session.release().catch(() => undefined);
      }
    }
  }

  // -------------------------------------------------------------------------
  // The §5.1 state-machine walk (one pass; §3.4 recovery may re-enter once)
  // -------------------------------------------------------------------------

  async #pipeline(state: PipelineState): Promise<RunOutcome> {
    // §3.4 resume re-anchor: the recovery replay already advanced the
    // document, and the walk continues from the observe→validate chain. The
    // §5.1 machine has no backward edges by design, so a resumed run
    // re-enters at "executing" (the phase the WAL replay just completed for
    // it) — loudly documented as the recovery seam, not a loop transition.
    if (state.resume !== null && state.status !== "executing") {
      state.status = "executing";
      await this.deps.db.updateStatus(state.run.id, "executing");
    }

    const bundle = await this.deps.tools.create({
      run: state.run,
      session: state.session,
      budget: state.budget,
      signal: state.signal,
    });
    const models = await this.deps.models.forRun({
      run: state.run,
      bundle,
      signal: state.signal,
    });
    const observer = new ObserverService({
      snapshot: bundle.snapshot,
      preview: bundle.preview,
    });
    const critic = new RunCritic({
      tool: models.criticTool,
      counterFactory: () => {
        // §3.4: cycles consumed before a crash still count after the resume.
        const counter = createRepairCycleCounter(MAX_REPAIR_CYCLES);
        for (let i = 0; i < state.repairCycles && counter.canStart(); i += 1) {
          counter.consume();
        }
        return counter;
      },
    });
    const validator = new RunValidator({ tool: models.validator });
    const resolved = resolveTierConfig(state.run.tier);
    if (resolved.roundtripsPerPhase === null) {
      // Image tiers ride the images queue (queues.ts RUN_TIERS), never here.
      throw new RunPipelineError("tier has no round-trip budget — not a run-loop tier");
    }

    // -- planning (§5.1 plan-first; skipped on §3.4 resume: the plan persisted)
    if (state.plan === null) {
      await this.#moveTo(state, "planning");
      await this.#plan(state, bundle, models);
    }

    // -- transaction (§5.6 agent.begin before the first mutating command) ----
    const txn = new TransactionManager({
      engine: state.session.tx,
      wal: this.deps.transactions.wal,
      storage: this.deps.transactions.storage,
      checkpoint: this.deps.transactions.checkpointFor(state.run),
      maxMutatingCommandsPerRun:
        this.deps.transactions.maxMutatingCommandsPerRun ?? MAX_MUTATING_COMMANDS_PER_RUN,
    });
    state.txn = txn;
    await this.#moveTo(state, "executing");
    const begun = await txn.begin(
      state.run.id,
      state.run.documentId,
      transactionNameFor(state.run),
      state.resume === null
        ? undefined
        : { seq: state.resume.seq, revision: state.resume.revision },
    );
    if (!begun.ok) {
      this.#assertSessionAlive(state);
      throw new PlannedFailure(
        "engine_error",
        runError(
          "engine_unavailable",
          "The engine refused to open the run's transaction; nothing was applied.",
          { hint: begun.hint, retryable: false },
        ),
      );
    }
    state.txnBegun = true;
    state.revisionBefore = begun.value.revisionBefore;
    if (!state.emittedStarted) {
      await this.#emit(state, "run.started", { revisionBefore: begun.value.revisionBefore });
      state.emittedStarted = true;
    }

    // -- executing (§5.1 small steps) ---------------------------------------
    const executor = new ExecutorService({
      model: models.executor,
      tools: bundle.tools,
      manifest: bundle.manifest,
      toolContext: bundle.toolContext,
      emit: (event) => this.#emitExecutorStep(state, event),
      clock: this.deps.clock as Clock | undefined,
      limits: {
        maxRoundTrips: resolved.roundtripsPerPhase,
        toolCallTimeoutMs: EXECUTOR_DEFAULT_TOOL_CALL_TIMEOUT_MS,
      },
    });
    const executorCaps = {
      maxToolCalls: resolved.toolCallCap,
      maxRevisions: resolved.revisions,
      maxTokens: resolved.tokenBudgetIn ?? 0,
    };

    if (state.resumedWithReplay) {
      // §3.4: the WAL replay re-applied the partial work; re-running the model
      // walk would double-apply. Unfinished plan steps are cut (§5.2 sentence).
      state.warnings.push(
        `the engine crashed mid-run; §3.4 recovery replayed ${state.replayedCommandCount} command(s) and the loop resumes at validation — unfinished plan steps were cut`,
      );
      state.shipWithWarnings = true;
    } else {
      await this.#gate(state);
      const execReport = await executor.execute(
        {
          plan: state.plan as Plan,
          budget: state.budget,
          ...executorCaps,
          initialMessages: [
            {
              role: "user",
              text: `User brief: ${state.run.prompt}\nPlanner notes: ${state.plan?.notes_for_user ?? ""}`,
            },
          ],
          phase: "executing",
        },
        state.signal,
      );
      state.mutatingCalls += execReport.toolCallsExecuted;
      if (execReport.status === "aborted") {
        await this.#gate(state); // throws CancelledRun with the observed cause
        throw new RunPipelineError("the executor aborted without an observed cancellation");
      }
      this.#assertSessionAlive(state);
      if (typeof execReport.lastDocumentRevision === "number") {
        state.lastRevision = execReport.lastDocumentRevision;
      }
      state.budget.trackPhaseCompleted(); // "execute" phase (§5.2 ratio)
      if (execReport.status !== "completed") {
        state.cleanStop =
          execReport.status === "budget_stopped" ? "budget_stopped" : "round_trip_stopped";
        state.cutMessage = execReport.cut?.message ?? "The execute walk stopped early (§5.1).";
        state.warnings.push(state.cutMessage);
        state.shipWithWarnings = true;
      }
    }

    // -- observing → rendering (§5.1 observe after act; §3.3 step 4) ----------
    let observation = await this.#observe(state, observer);

    // -- validating ⇄ critiquing ⇄ repairing (§5.1 gate table) ---------------
    for (let guard = 0; ; guard += 1) {
      if (guard > MAX_REPAIR_CYCLES + 4) {
        throw new RunPipelineError("the validate/critique loop failed to converge");
      }
      await this.#gate(state);
      await this.#moveTo(state, "validating");
      const validated = await validator.validate({
        documentId: state.run.documentId,
        template: state.plan?.template ?? undefined,
        revision: observation.revision,
      });
      if (!validated.ok) {
        this.#assertSessionAlive(state);
        const isWiring = validated.code === "plan_invalid";
        throw new PlannedFailure(
          isWiring ? "our_bug" : "engine_error",
          runError(
            isWiring ? INTERNAL_ERROR : "engine_unavailable",
            "The deterministic validator could not run on the document.",
            { hint: validated.hint, retryable: validated.retryable },
          ),
        );
      }
      const report: ValidatorReport = validated.value;
      state.validatorPassed = report.verdict !== "blockers";
      await this.#emit(state, "validate.report", {
        ok: report.verdict !== "blockers",
        blockers: report.blockers.map((issue) => issue.code),
        majors: report.majors.map((issue) => issue.code),
        minors: report.minors.map((issue) => issue.code),
      });
      state.budget.trackPhaseCompleted(); // "validate" phase
      state.warnings.push(...report.warnings);

      const gate = validateGate(report);
      if (gate.action === "repair") {
        // §5.1: blockers gate the pipeline into repair; past the cap the run
        // fails validation (§5.2 commits only validator-passing work).
        if (state.repairCycles >= MAX_REPAIR_CYCLES) {
          return await this.#validationFailureTerminal(state, report);
        }
        const repair = await this.#repairCycle(state, {
          issues: gate.repairTargets.map((issue) => ({
            level: issue.level,
            code: issue.code,
            ...(issue.layer === undefined ? {} : { layer: issue.layer }),
            fix: issue.fix,
          })),
          observation,
          validatorReport: report.summary,
          executor,
          models,
          critic,
          observer,
        });
        if (!repair.ran) {
          return await this.#validationFailureTerminal(state, report);
        }
        observation = repair.observation;
        continue;
      }

      // No blockers. §5.2-stopped runs skip critic + repair (budgets are hard
      // caps — the critic could only demand work the run cannot run) and
      // settle on the validator alone; §5.3 skips the critic for quick tier.
      if (state.cleanStop !== null || !criticRouteEnabled(state.run.tier)) {
        return await this.#finalize(state, observation);
      }

      await this.#moveTo(state, "critiquing");
      await this.#gate(state);
      const previewUrl = observation.previewUrl ?? state.lastPreviewUrl;
      if (previewUrl === null) {
        state.warnings.push("critique skipped — no preview render was available (§5.1)");
        return await this.#finalize(state, observation);
      }
      const critique = await critic.critique({
        brief: state.run.prompt,
        previewUrl,
        layerSummary: observation.compactSummary,
        palette: state.plan?.palette,
        validatorReport: report.summary,
        tier: state.run.tier,
      });
      if (!critique.ok) {
        this.#assertSessionAlive(state);
        const cause: PipelineRefundCause =
          critique.code === "provider_unhealthy"
            ? "provider_failure"
            : critique.code === "run_timeout"
              ? "engine_timeout"
              : "provider_failure";
        const hint =
          critique.code === "provider_unhealthy"
            ? `${critique.hint ?? ""} §24.4: the first retry caused by a provider failure on our side is free (retry_grace: 1).`.trim()
            : critique.hint;
        throw new PlannedFailure(
          cause,
          runError(
            critique.code === "run_timeout" ? "engine_timeout" : "provider_unhealthy",
            "The vision critic could not complete its review of the render.",
            { hint, retryable: critique.retryable },
          ),
        );
      }
      const result: CritiqueResult = critique.value;
      if (result.skipped) {
        throw new RunPipelineError("the critic skipped despite an enabled §5.3 route");
      }
      await this.#emit(state, "critique.report", {
        verdict: result.verdict.verdict,
        scores: result.verdict.scores,
        issues: result.verdict.issues.map((issue) => ({
          severity: issue.severity,
          code: issue.code,
          ...(issue.layer === undefined ? {} : { layer: issue.layer }),
          observation: issue.observation ?? "",
          fix: issue.fix ?? "",
        })),
      });
      state.budget.trackPhaseCompleted(); // "critique" phase
      const decision = cycleGateForOutcome(result, critic.cycles());
      if (decision.decision === "finalize") {
        state.warnings.push(...remainingIssueWarnings(decision.remainingIssues));
        return await this.#finalize(state, observation);
      }
      if (decision.decision === "repair") {
        const repair = await this.#repairCycle(state, {
          issues: result.repairIssues.map((issue) => ({
            severity: issue.severity,
            code: issue.code,
            layer: issue.layer ?? "document",
            fix: issue.fix ?? "apply the smallest fix that addresses the issue",
          })),
          observation,
          validatorReport: report.summary,
          executor,
          models,
          critic,
          observer,
        });
        if (!repair.ran) {
          state.warnings.push(
            "the repair cycle planned no steps — the remaining issues ship as warnings (§23.4 rule 4)",
          );
          state.shipWithWarnings = true;
          return await this.#finalize(state, observation);
        }
        observation = repair.observation;
        continue; // re-validate + re-critique after the repair (§5.1)
      }
      // finalize_with_warnings: ship the best render with the issues (§5.1).
      state.warnings.push(...remainingIssueWarnings(decision.remainingIssues));
      state.shipWithWarnings = true;
      return await this.#finalize(state, observation);
    }
  }

  // -------------------------------------------------------------------------
  // Phases
  // -------------------------------------------------------------------------

  /** §23.2/§5.1 planning: sections → PlannerService → persist + emit run.plan. */
  async #plan(
    state: PipelineState,
    bundle: ToolContextBundle,
    models: RunModelAdapters,
  ): Promise<void> {
    await this.#gate(state);
    const sections = await buildPlannerSections({
      run: state.run,
      manifest: bundle.manifest,
      templates: bundle.templates,
    });
    const planner = new PlannerService(models.planner);
    const planned = await planner.plan({ ...sections, signal: state.signal });
    if (!planned.ok) {
      // §5.1: an invalid plan fails clear; §5.3 provider seams stay retryable.
      const cause: PipelineRefundCause =
        planned.code === "provider_unhealthy"
          ? "provider_failure"
          : planned.code === "run_timeout"
            ? "engine_timeout"
            : "validation_failed";
      const code =
        planned.code === "provider_unhealthy"
          ? "provider_unhealthy"
          : planned.code === "run_timeout"
            ? "engine_timeout"
            : "validation_failed";
      const hint =
        planned.code === "provider_unhealthy"
          ? `${planned.hint ?? ""} §24.4: the first retry caused by a provider failure on our side is free (retry_grace: 1).`.trim()
          : planned.hint;
      throw new PlannedFailure(
        cause,
        runError(code, planned.message, { hint, retryable: planned.retryable }),
      );
    }
    state.plan = planned.plan;
    state.warnings.push(...planned.warnings);
    await this.deps.db.savePlan(state.run.id, planned.plan);
    await this.#emit(state, "run.plan", { plan: planned.plan });
    state.budget.trackPhaseCompleted(); // "plan" phase
  }

  /** §5.1 observing: snapshot + ≤1024 px preview → emit preview.updated. */
  async #observe(state: PipelineState, observer: ObserverService): Promise<Observation> {
    await this.#moveTo(state, "observing");
    const observed = await observer.afterAction(state.run.documentId);
    if (!observed.ok) {
      this.#assertSessionAlive(state);
      throw new PlannedFailure(
        "engine_error",
        runError(
          "engine_unavailable",
          "The document could not be observed mid-run (§5.1 observe-after-act).",
          { hint: observed.hint, retryable: true },
        ),
      );
    }
    this.#assertSessionAlive(state);
    state.warnings.push(...observed.value.warnings);
    if (typeof observed.value.revision === "number") {
      state.lastRevision = observed.value.revision;
    }
    // §5.1/§3.3 step 4: the render completed the phase — pass through rendering.
    await this.#moveTo(state, "rendering");
    if (observed.value.previewUrl !== undefined) {
      state.lastPreviewUrl = observed.value.previewUrl;
      await this.#emit(state, "preview.updated", {
        url: observed.value.previewUrl,
        revision: observed.value.revision ?? state.lastRevision ?? 0,
      });
    }
    return observed.value;
  }

  /** One §23.4/§11.2 repair cycle; reports whether any step actually ran. */
  async #repairCycle(
    state: PipelineState,
    input: {
      readonly issues: readonly RepairIssueInput[];
      readonly observation: Observation;
      readonly validatorReport: string;
      readonly executor: ExecutorService;
      readonly models: RunModelAdapters;
      readonly critic: RunCritic;
      readonly observer: ObserverService;
    },
  ): Promise<{ readonly ran: boolean; readonly observation: Observation }> {
    await this.#moveTo(state, "repairing");
    const repaired = await planRepairs({
      issues: input.issues,
      context: {
        layerTree: input.observation.compactSummary,
        palette: state.plan?.palette,
        validatorReport: input.validatorReport,
      },
      model: input.models.repair,
      signal: state.signal,
    });
    if (!repaired.ok) {
      const cause: PipelineRefundCause =
        repaired.code === "provider_unhealthy" ? "provider_failure" : "validation_failed";
      throw new PlannedFailure(
        cause,
        runError(
          repaired.code === "provider_unhealthy" ? "provider_unhealthy" : "validation_failed",
          "The repair cycle could not be planned from the reported issues.",
          { hint: repaired.hint, retryable: repaired.retryable },
        ),
      );
    }
    state.warnings.push(...repaired.value.warnings);
    if (repaired.value.steps.length === 0) {
      // §23.4 rule 4: every fix was impossible — documented, nothing worse.
      state.log.warn("repair cycle planned no steps", { repairCycles: state.repairCycles });
      return { ran: false, observation: input.observation };
    }
    const mini = buildRepairMiniPlan(repaired.value.steps, state.plan?.model_tier ?? "standard");
    if (!mini.ok) {
      throw new RunPipelineError(`repair mini-plan failed the §5.5 schema (${mini.code})`);
    }
    const resolved = resolveTierConfig(state.run.tier);
    const report = await input.executor.execute(
      {
        plan: mini.plan,
        budget: state.budget,
        maxToolCalls: resolved.toolCallCap,
        maxRevisions: resolved.revisions,
        maxTokens: resolved.tokenBudgetIn ?? 0,
        phase: "repairing",
      },
      state.signal,
    );
    state.mutatingCalls += report.toolCallsExecuted;
    if (report.status === "aborted") {
      await this.#gate(state); // throws CancelledRun with the observed cause
      throw new RunPipelineError("the repair walk aborted without an observed cancellation");
    }
    this.#assertSessionAlive(state);
    if (typeof report.lastDocumentRevision === "number") {
      state.lastRevision = report.lastDocumentRevision;
    }
    state.budget.trackPhaseCompleted(); // "repair" phase
    // §5.1 cycle accounting: one cycle per repair that ran steps, counted in
    // the critic's counter (drives cycleGate) AND the persisted state (drives
    // the §3.4 resume seed and the validator-blocker cap).
    if (!input.critic.noteRepairCycle()) {
      throw new RunPipelineError("the §5.1 repair-cycle cap was exceeded");
    }
    state.repairCycles += 1;
    const observation = await this.#observe(state, input.observer);
    return { ran: true, observation };
  }

  // -------------------------------------------------------------------------
  // Terminals
  // -------------------------------------------------------------------------

  /**
   * §3.3 step 6: settlement → agent.commit (.pcraft + checkpoint) → ledger
   * commit/partial → succeeded | succeeded_with_warnings → run.succeeded +
   * credits.charged. Refund-all settlements never commit (§5.2).
   */
  async #finalize(state: PipelineState, observation: Observation): Promise<RunOutcome> {
    void observation;
    const run = state.run;
    const reserved = Math.max(0, run.creditsReserved);
    const completed = state.cleanStop === null;
    const validatorPassed = state.validatorPassed ?? false;
    const documentImproved = state.mutatingCalls > 0;
    const report = state.budget.report({ completed });

    let settlement: Settlement;
    if (completed) {
      if (!validatorPassed) {
        throw new RunPipelineError("finalize reached without a validator verdict");
      }
      settlement = computeSettlement(report, run.tier, { validatorPassed: true, documentImproved });
    } else {
      settlement = settlementForCleanStop({
        tier: run.tier,
        report,
        validatorPassed,
        documentImproved,
        cutMessage: state.cutMessage ?? "The execute walk stopped early (§5.1).",
      });
    }

    if (settlement.policy === "refund_all") {
      // §5.2: nothing validator-passing strengthened the document — nothing
      // commits. Roll back and release the full reservation (W6-G's table).
      const error = validatorPassed
        ? runError(
            "budget_exceeded",
            state.cutMessage ??
              "The tier budget stopped the run before it strengthened the document.",
            { hint: settlement.note, retryable: false },
          )
        : runError(
            "validation_failed",
            "Validation failed, so nothing validator-passing was committed.",
            { hint: settlement.note, retryable: false },
          );
      return await this.#refundTerminal({
        run,
        state,
        cause: validatorPassed ? "budget_stop" : "validation_failed",
        status: "failed",
        error,
        chargeOverride: 0,
      });
    }

    // agent.commit → .pcraft to object storage → durable checkpoint row.
    await this.#moveTo(state, "finalizing");
    const committed = state.txn === null ? null : await state.txn.commit(run.id);
    if (committed === null || !committed.ok) {
      this.#assertSessionAlive(state);
      throw new PlannedFailure(
        "engine_error",
        runError(
          "engine_unavailable",
          "The engine transaction could not be committed; the run was rolled back.",
          {
            hint: committed !== null && !committed.ok ? committed.hint : undefined,
            retryable: false,
          },
        ),
      );
    }
    const charge = Math.max(0, Math.min(settlement.chargeCredits, reserved));
    const settled = await commitReservation(this.deps.ledger, {
      organizationId: run.organizationId,
      runId: run.id,
      amount: reserved,
      amountCharged: charge,
    });
    if (!settled.ok) {
      // §14.2 rule 5 posture: our infrastructure failed AFTER the engine
      // commit — release fully for review (the hold stays reconcilable via
      // reservationStatus; the work is already one undoable entry).
      throw new PlannedFailure(
        "our_bug",
        runError(
          INTERNAL_ERROR,
          "The credit settlement failed after the document was committed; the reservation is released and the run flagged for review.",
          { hint: settled.hint, retryable: false },
        ),
      );
    }
    await this.deps.db.recordUsage(run.id, {
      tokensIn: report.used.tokensIn,
      tokensOut: report.used.tokensOut,
      cacheHits: report.used.cacheHits,
    });
    const status = state.shipWithWarnings ? "succeeded_with_warnings" : "succeeded";
    await this.deps.db.finalizeRun({
      runId: run.id,
      status,
      revisionAfter: committed.value.revisionAfter,
      creditsCharged: charge,
      finishedAt: this.#now(),
    });
    await this.#emit(state, "credits.charged", {
      charged: charge,
      partial: settlement.policy === "partial",
    });
    await this.#emit(state, "run.succeeded", {
      revisionAfter: committed.value.revisionAfter,
      warnings: [...state.warnings],
    });
    return {
      status,
      creditsUsed: charge,
      documentCheckpointId: committed.value.storageKey,
      warnings: [...state.warnings],
    };
  }

  /**
   * §5.1: validation blockers survived the repair cap — the run fails, the
   * document rolls back, the settlement table releases everything (§5.2
   * commits only validator-passing work; classifyRefund is not consulted).
   */
  async #validationFailureTerminal(
    state: PipelineState,
    report: ValidatorReport,
  ): Promise<RunOutcome> {
    const settlement = computeSettlement(
      state.budget.report({ completed: false }),
      state.run.tier,
      { validatorPassed: false, documentImproved: true },
    );
    const codes = report.blockers.map((issue) => issue.code).slice(0, 5).join(", ");
    return await this.#refundTerminal({
      run: state.run,
      state,
      cause: "validation_failed",
      status: "failed",
      chargeOverride: settlement.chargeCredits, // refund_all ⇒ 0
      error: runError(
        "validation_failed",
        `Validation still reports ${report.counts.blocker} blocker(s) after ${MAX_REPAIR_CYCLES} repair cycles${codes.length > 0 ? `: ${codes}` : ""}.`,
        {
          hint: "The document was rolled back to its pre-run state and the full reservation released (§5.1/§5.2).",
          retryable: false,
        },
      ),
    });
  }

  /** Rollback + §14.2 refund + terminal persistence + terminal event. */
  async #refundTerminal(input: {
    readonly run: RunRecord;
    readonly state: PipelineState | null;
    readonly cause: PipelineRefundCause;
    readonly status: "failed" | "cancelled";
    readonly error: RunError;
    /** Settlement-owned charges (validation/budget terminals) override §14.2. */
    readonly chargeOverride?: number;
  }): Promise<RunOutcome> {
    const { run, state, cause, status, error } = input;
    const log = state?.log ?? this.deps.logger.child({ component: "run-manager", runId: run.id });
    const reserved = Math.max(0, run.creditsReserved);

    // §5.1: agent.rollback — restore the pre-run checkpoint. Best-effort after
    // a crash: the recovery hook already left the document at its checkpoint
    // (recovery-contract.md); a refusal is logged, never surfaced as content.
    if (state !== null && state.txnBegun && state.txn !== null) {
      const rolled = await state.txn.rollback(run.id);
      if (!rolled.ok) {
        log.warn("agent.rollback refused — the document keeps its last committed checkpoint", {
          code: rolled.code,
        });
      }
    }

    const charge =
      input.chargeOverride ?? refundChargeCredits(cause, reserved, state?.mutatingCalls ?? 0);
    const released = await releaseReservation(this.deps.ledger, {
      organizationId: run.organizationId,
      runId: run.id,
      amount: reserved,
      amountCharged: charge,
    });
    if (!released.ok) {
      log.error("reservation release failed — reconcile the hold via reservationStatus", {
        code: released.code,
      });
    }
    await this.deps.db.finalizeRun({
      runId: run.id,
      status,
      creditsCharged: charge,
      error,
      finishedAt: this.#now(),
    });
    if (status === "cancelled") {
      await emitTerminalBestEffort(this.deps.emit, {
        runId: run.id,
        organizationId: run.organizationId,
        type: "run.cancelled",
        payload: { reason: error.message },
        onError: (message) => log.error("terminal event lost", { message }),
      });
    } else {
      await emitTerminalBestEffort(this.deps.emit, {
        runId: run.id,
        organizationId: run.organizationId,
        type: "run.failed",
        payload: {
          error: {
            code: error.code,
            message: error.message,
            hint: error.hint,
            retryable: error.retryable,
          },
        },
        onError: (message) => log.error("terminal event lost", { message }),
      });
    }
    return { status: "failed", creditsUsed: charge, error };
  }

  /** Maps anything thrown inside the pipeline onto a typed refund terminal. */
  async #failureFromThrow(
    error: unknown,
    state: PipelineState,
    row: RunRecord,
  ): Promise<RunOutcome> {
    if (error instanceof CancelledRun) {
      if (error.kind.cause === "user_cancel") {
        return await this.#refundTerminal({
          run: row,
          state,
          cause: "user_cancel",
          status: "cancelled",
          error: runError(
            "run_cancelled",
            error.kind.reason ?? "The run was cancelled; the document was rolled back and the reservation released.",
            { hint: "§3.4: cancel, rollback, refund.", retryable: false },
          ),
        });
      }
      return await this.#refundTerminal({
        run: row,
        state,
        cause: "engine_timeout",
        status: "failed",
        error: runError(
          "engine_timeout",
          "The run exceeded its tier wall clock; it was cancelled, the document rolled back and the reservation released (§3.4).",
          { retryable: false },
        ),
      });
    }
    if (error instanceof PlannedFailure) {
      return await this.#refundTerminal({
        run: row,
        state,
        cause: error.cause,
        status: "failed",
        error: error.error,
      });
    }
    if (error instanceof EmissionError) {
      return await this.#refundTerminal({
        run: row,
        state,
        cause: "our_bug",
        status: "failed",
        error: runError(
          INTERNAL_ERROR,
          "The run timeline could not be persisted; the run was rolled back and refunded.",
          { hint: error.message, retryable: false },
        ),
      });
    }
    if (error instanceof EngineSessionCrashError) {
      // Unreachable (the resume loop owns crashes); kept for total safety.
      return await this.#refundTerminal({
        run: row,
        state,
        cause: "engine_crashed",
        status: "failed",
        error: runError(
          "engine_crashed",
          "The engine session died mid-run and recovery did not complete; the document stays at its last committed checkpoint.",
          { hint: "Engine crash recovery resumes a run at most once (§3.4).", retryable: false },
        ),
      });
    }
    state.log.error("unexpected pipeline failure", {
      message: error instanceof Error ? error.message : String(error),
    });
    return await this.#refundTerminal({
      run: row,
      state,
      cause: "our_bug",
      status: "failed",
      error: runError(
        INTERNAL_ERROR,
        "The run hit an internal error and was rolled back; the reservation was released.",
        { hint: "§14.2 rule 5: our failures refund fully and flag the run for review.", retryable: false },
      ),
    });
  }

  // -------------------------------------------------------------------------
  // Guards and plumbing
  // -------------------------------------------------------------------------

  /** Persists a §5.1 transition after checking the machine's table. */
  async #moveTo(state: PipelineState, to: RunRecord["status"]): Promise<void> {
    if (state.status === to) {
      return;
    }
    if (!canTransition(state.status, to)) {
      throw new RunPipelineError(`illegal §5.1 transition '${state.status}' → '${to}'`);
    }
    state.status = to;
    await this.deps.db.updateStatus(state.run.id, to);
  }

  /**
   * W6-J cancellation contract: observed at EVERY stage boundary — the
   * internal signal (already aborted by the wall clock) plus a poll of the
   * cancellation source, so a mid-run user cancel is honoured even while the
   * current stage is still finishing.
   */
  async #gate(state: PipelineState): Promise<void> {
    if (state.signal.aborted) {
      const snapshot = await this.deps.cancellation.observe(state.run.id);
      if (snapshot.cancelled) {
        throw new CancelledRun({ cause: "user_cancel", reason: snapshot.reason });
      }
      throw new CancelledRun({ cause: "engine_timeout" });
    }
    const snapshot = await this.deps.cancellation.observe(state.run.id);
    if (snapshot.cancelled) {
      state.abortRun();
      throw new CancelledRun({ cause: "user_cancel", reason: snapshot.reason });
    }
  }

  /** Durable §13.2 publish; a failed append fails the run (§22). */
  async #emit<T extends RunEventType>(
    state: PipelineState,
    type: T,
    payload: RunEventPayloadMap[T],
  ): Promise<void> {
    await emitRunEventOk(this.deps.emit, {
      runId: state.run.id,
      organizationId: state.run.organizationId,
      type,
      payload,
    });
  }

  /** The executor's §13.2 step.started/step.finished sink (§22 durability). */
  async #emitExecutorStep(state: PipelineState, event: Parameters<EmitExecutorStepEvent>[0]): Promise<void> {
    if (event.type === "step.started") {
      await this.#emit(state, "step.started", event.payload);
    } else if (event.type === "step.finished") {
      await this.#emit(state, "step.finished", event.payload);
    }
  }

  /** §3.4: converts a latched session crash into the recovery hand-off. */
  #assertSessionAlive(state: PipelineState): void {
    const crash = state.session.crashed();
    if (crash !== null) {
      throw new EngineSessionCrashError(state.session.sessionId, crash);
    }
  }

  #now(): Date {
    return new Date(this.deps.clock?.() ?? Date.now());
  }
}
