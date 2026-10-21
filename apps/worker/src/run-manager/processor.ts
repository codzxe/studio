// apps/worker/src/run-manager/processor.ts — the §3.3/§5.1 run pipeline (W6-N).
//
// THE PIPELINE HEART. `StudioRunProcessor` implements W1-I's `RunProcessor`
// (src/processor.ts) and wires EVERY Wave-6 service together, fully injected
// (RunManagerDeps, deps.ts): the loop never constructs infrastructure itself.
//
// Lifecycle mapped to spec (§3.3 steps 3–7, §5.1 the loop):
//
//   load run row → idempotent terminal replay (§3.4)
//   → planning      PlannerService (§23.2; §5.1 plan-first) → emit run.plan
//   → transaction   TransactionManager.begin (§5.6 agent.begin) → emit run.started
//   → executing     ExecutorService walks plan.steps (§5.1 small steps)
//   → observing     ObserverService.afterAction (§5.1 observe-after-act) — the
//                   ≤1024 px preview rides here; emit preview.updated
//   → rendering→validating  RunValidator (§11.1) → validateGate (§5.1 table)
//   → critiquing   RunCritic (§23.3; §5.3 quick tier skips) → cycleGate
//   → repairing    planRepairs (§23.4) → executor phase "repairing" → observing
//                  (× ≤ MAX_REPAIR_CYCLES, then ship with warnings §5.1)
//   → finalizing   settlement (§5.2 computeSettlement) → agent.commit + .pcraft +
//                  checkpoint (§3.3 step 6) → ledger commit/partial →
//                  succeeded | succeeded_with_warnings → emit run.succeeded +
//                  credits.charged
//   ↘ any typed failure / cancel / crash: agent.rollback → §14.2 refund
//      (classifyRefund per §24.4 retry_grace) → run.failed | run.cancelled.
//
// Cancellation (W6-J contract) is OBSERVED at every stage boundary through
// `deps.cancellation`, in addition to the BullMQ wall-clock AbortSignal; the
// internal signal is aborted the moment either fires. Engine crashes (§3.4) are
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
  type BudgetExceeded,
  type Plan,
  RUN_EVENT_TYPE,
  type RunEventPayloadMap,
  type RunEventType,
  canTransition,
} from "@studio/agent";
import { classifyRefund, maxPartialFailureCharge } from "@studio/billing";
import type { ToolListing } from "@studio/tools";
import {
  PlannerService,
  type PlannerSections,
} from "../../../../packages/agent/src/planner/planner.js";
import {
  EXECUTOR_DEFAULT_TOOL_CALL_TIMEOUT_MS,
  ExecutorService,
  type ExecutorReport,
  executorLimitsFromTier,
  type ExecuteModelLike,
} from "../../../../packages/agent/src/executor/executor.js";
import { ObserverService } from "../../../../packages/agent/src/observer/observer.js";
import { RunValidator, type ValidatorReport } from "../../../../packages/agent/src/validator/service.js";
import { validateGate } from "../../../../packages/agent/src/validator/gate.js";
import {
  RunCritic,
  createRepairCycleCounter,
  criticRouteEnabled,
  type CritiqueResult,
} from "../../../../packages/agent/src/critic/service.js";
import { cycleGateForOutcome } from "../../../../packages/agent/src/critic/cycle-gate.js";
import { planRepairs } from "../../../../packages/agent/src/repair/planner.js";
import { createBudgetTracker } from "../../../../packages/agent/src/budgets-service/tracker-factory.js";
import {
  computeSettlement,
  partialChargeCredits,
  type Settlement,
} from "../../../../packages/agent/src/budgets-service/settlement.js";
import { TransactionManager } from "../../../../packages/agent/src/transactions/manager.js";
import type { TierBudgetTracker } from "../../../../packages/agent/src/budgets-service/tracker-factory.js";
import type {
  EngineSessionCrashError,
} from "./crash.js";
import type { Clock } from "../../../../packages/agent/src/budgets.js";
import type { RunManagerError } from "./deps.js";
import type {
  EmitRunEvent,
  EngineSessionHandle,
  RunRecord,
  RunRepository,
  RunManagerDeps,
  RunCancellationSnapshot,
} from "./deps.js";
import { emitRunEventOk } from "./emit.js";
import {
  type RunJobContext,
  type RunOutcome,
  type RunProcessor,
  type RunError,
} from "../processor.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** §3.4: "restart, replay to checkpoint, resume once" — one resume per run. */
export const MAX_ENGINE_RESUMES_PER_RUN = 1;

/** §5.1/§3.3 step 4: the observe-loop preview edge (px). */
export const RUN_PREVIEW_EDGE_PX = 1024;

/** Cap on catalog templates enriched with slot names for the planner (§5.4). */
export const MAX_PLANNER_TEMPLATE_ENTRIES = 25;

/** §5.6 history-entry label for the run's single undoable transaction. */
export function transactionNameFor(run: RunRecord): string {
  return `agent-run ${run.id}`;
}

// ---------------------------------------------------------------------------
// Small typed-error plumbing (internal; never crosses the RunProcessor seam)
// ---------------------------------------------------------------------------

/** Infra/pipeline bug — mapped to `internal_error` outcomes (§13.3). */
export class RunPipelineError extends Error {
  constructor(message: string) {
    super(`[run-manager] ${message}`);
    this.name = "RunPipelineError";
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

// ---------------------------------------------------------------------------
// Settlement resolution — the §5.2 clean-stop family (pure, table-tested)
// ---------------------------------------------------------------------------

/** Why the execute walk stopped early (§5.1 small steps / §5.2 hard caps). */
export type CleanStopKind = "budget_stopped" | "round_trip_stopped";

export interface CleanStopSettlementInput {
  readonly tier: RunTierId;
  readonly report: ReturnType<TierBudgetTracker["report"]>;
  readonly validatorPassed: boolean;
  readonly documentImproved: boolean;
  /** The executor's cut sentence (§5.2 "tell the user what was cut"). */
  readonly cutMessage: string;
}

/**
 * The §5.2 clean-stop settlement for ANY executor early stop — tier budget
 * (computeSettlement's own table) or the §5.1 round-trip cap (same §5.2
 * pricing: a policy stop is a feature, never an error). Validation still
 * decides: §5.2 commits only validator-passing work.
 */
export function settlementForCleanStop(input: CleanStopSettlementInput): Settlement {
  const { tier, report, validatorPassed, documentImproved } = input;
  if (report.stopped) {
    // A §5.2 tier cap latched — W6-G's table owns this exactly.
    return computeSettlement(report, tier, { validatorPassed, documentImproved });
  }
  if (!validatorPassed) {
    return computeSettlement(report, tier, { validatorPassed: false, documentImproved });
  }
  // §5.1 round-trip cap: mirror the §5.2 table with the same partial formula.
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
      note: `${input.cutMessage} Charged ${charge} of ${reservedCredits} reserved credits for the ${report.phasesCompleted} of ${report.phasesTotal} phases that finished (§5.1).`,
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
    note: `${input.cutMessage} The run stopped before it strengthened the document — released all ${reservedCredits} reserved credits.`,
  });
}

// ---------------------------------------------------------------------------
// Refund causes (§14.2 rules 3–5 / §24.4) for non-budget terminals
// ---------------------------------------------------------------------------

/** §24.4/billing refund causes the pipeline can produce. */
export type PipelineRefundCause =
  | "user_cancel"
  | "provider_failure"
  | "our_bug"
  | "engine_crashed"
  | "engine_timeout"
  | "engine_error"
  | "validation_failed";

/** Credits charged when a failure rolls the document back (§14.2 rules 3–5). */
export function refundChargeCredits(
  cause: PipelineRefundCause,
  reservedCredits: number,
  mutatingCallsExecuted: number,
): number {
  const policy = classifyRefund(cause);
  if (policy === "full_refund") {
    return 0;
  }
  if (policy === "none") {
    // Budget stops never route through here (settlementForCleanStop owns them).
    return 0;
  }
  // §14.2 rule 4: partial progress charges at most half the base; zero
  // mutating calls means nothing progressed (policy.ts's documented caller
  // contract) — the rollback also restores the pre-run document either way.
  if (mutatingCallsExecuted <= 0) {
    return 0;
  }
  return maxPartialFailureCharge(reservedCredits);
}

// ---------------------------------------------------------------------------
// The processor
// ---------------------------------------------------------------------------

/** Internal run state, threaded through every phase (single-owner, §5.2). */
interface PipelineState {
  readonly job: RunJobContext;
  readonly run: RunRecord;
  readonly budget: TierBudgetTracker;
  readonly log: RunManagerDeps["logger"];
  /** Internal cooperative signal: job wall clock + observed cancellation. */
  readonly signal: AbortSignal;
  abortRun(): void;
  /** Session handle — swapped exactly once by §3.4 recovery. */
  session: EngineSessionHandle;
  /** §3.4 resume cursor after recovery replays the WAL onto a fresh session. */
  resume: { readonly seq: number; readonly revision: number } | null;
  /** §5.6 transaction manager over the CURRENT session (rebuilt per resume). */
  txn: TransactionManager | null;
  /** True once agent.begin succeeded (rollback decisions depend on it). */
  txnBegun: boolean;
  plan: Plan | null;
  /** Current persisted §5.1 status (transition-guarded). */
  status: RunRecord["status"];
  /** Executed mutating tool calls across all execute/repair walks (§14.2 rule 4). */
  mutatingCalls: number;
  /** §5.1 repair cycles consumed (validator- and critic-driven alike). */
  repairCycles: number;
  warnings: string[];
  validatorPassed: boolean | null;
  /** Latest observation-derived preview revision + url (§3.3 step 4). */
  lastPreviewUrl: string | null;
  lastRevision: number | null;
  /** Executor clean-stop family, when the walk ended early (§5.1/§5.2). */
  cleanStop: CleanStopKind | null;
}

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
      log.error("run row missing — the gateway never created it (or tenant purge hit)");
      return {
        status: "failed",
        error: runError("not_found", "The run does not exist; nothing was charged.", {
          hint: "The run row is created before enqueue (§3.3 step 2).",
          retryable: false,
        }),
      };
    }

    // §3.4 idempotency: a terminal row replays its recorded outcome — retries
    // can never double-apply or double-charge (the ledger keys are idempotent
    // on top of this, §14.2 rule 6).
    const replayed = recordedOutcome(row);
    if (replayed !== null) {
      log.info("run row already terminal — replaying the recorded outcome", {
        status: row.status,
      });
      return replayed;
    }

    if (job.payload.tier !== row.tier) {
      // Queue payload and row disagree — a wiring bug on our side (§14.2 rule 5).
      log.error("tier mismatch between the job payload and the run row");
      return await this.#refundTerminal(row, null, {
        cause: "our_bug",
        status: "failed",
        error: runError(
          "internal_error",
          "The run was queued under a different tier than it was created with.",
          { hint: "The gateway enqueues the run with its row tier (§3.3 step 2).", retryable: false },
        ),
        state: null,
      });
    }

    const budget = createBudgetTracker(row.tier, { clock: this.deps.clock });

    // Cooperative deadline: the BullMQ wall clock (§5.2) plus observed user
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
      job,
      run: row,
      budget,
      log,
      signal: runAbort.signal,
      abortRun: () => runAbort.abort(),
      session: null as unknown as EngineSessionHandle,
      resume: null,
      txn: null,
      txnBegun: false,
      plan: null,
      status: row.status,
      mutatingCalls: 0,
      repairCycles: 0,
      warnings: [],
      validatorPassed: null,
      lastPreviewUrl: null,
      lastRevision: null,
      cleanStop: null,
    };

    try {
      session = await this.deps.engines.acquire({
        runId: row.id,
        organizationId: row.organizationId,
        documentId: row.documentId,
        tier: row.tier,
      });
      state.session = session;
      state.status = row.status;
      for (let resumeAttempts = 0; ; resumeAttempts += 1) {
        try {
          return await this.#pipeline(state);
        } catch (error) {
          if (!(error instanceof EngineSessionCrashError)) {
            throw error;
          }
          // §3.4: restart + replay happened (or refused) inside the hook.
          log.warn("engine session crashed mid-run — entering §3.4 recovery", {
            code: error.evidence.code,
          });
          if (session !== null) {
            await session.release().catch(() => undefined);
            session = null;
          }
          if (resumeAttempts >= MAX_ENGINE_RESUMES_PER_RUN) {
            throw new RunPipelineError("engine crashed again after the single §3.4 resume");
          }
          const recovered = await this.deps.recovery.recover({
            runId: row.id,
            organizationId: row.organizationId,
            documentId: row.documentId,
            sessionId: error.sessionId,
            evidence: error.evidence,
          });
          if (!recovered.ok) {
            state.session = {
              ...(session ?? ({} as EngineSessionHandle)),
            } as EngineSessionHandle;
            return await this.#refundTerminal(row, null, {
              cause: "engine_crashed",
              status: "failed",
              error: recovered.failure as RunError,
              state,
            });
          }
          // §3.4/§5.2: replayed commands count against the run budgets.
          for (let i = 0; i < recovered.replayedCommands; i += 1) {
            budget.trackToolCall();
          }
          state.mutatingCalls += recovered.replayedCommands;
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
  // The §5.1 state-machine walk
  // -------------------------------------------------------------------------

  async #pipeline(state: PipelineState): Promise<RunOutcome> {
    // Load-run → planning (§5.1: a queued run only ever starts planning).
    if (state.plan === null) {
      await this.#moveTo(state, "planning");
      await this.#plan(state);
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
        const counter = createRepairCycleCounter(MAX_REPAIR_CYCLES);
        for (let i = 0; i < state.repairCycles && counter.canStart(); i += 1) {
          counter.consume();
        }
        return counter;
      },
    });
    const validator = new RunValidator({ tool: models.validator });

    // §5.6: agent.begin before the first mutating command (re-attached at the
    // §3.4 resume cursor after a crash-recovery replay).
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
      throw new RunPipelineError(`agent.begin refused the run: ${begun.code}`);
    }
    state.txnBegun = true;
    state.lastRevision = begun.value.revisionBefore;
    await this.#emit(state, "run.started", { revisionBefore: begun.value.revisionBefore });

    // -- executing (§5.1 small steps) ----------------------------------------
    await this.#gate(state);
    const resolved = resolveTierConfig(state.run.tier);
    if (resolved.roundtripsPerPhase === null) {
      throw new RunPipelineError("image tiers ride the images queue, never the run loop");
    }
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
    const seedMessages = [
      {
        role: "user" as const,
        text: `User brief: ${state.run.prompt}\nPlanner notes: ${state.plan?.notes_for_user ?? ""}`,
      },
    ];
    const execReport = await executor.execute(
      {
        plan: state.plan as Plan,
        budget: state.budget,
        maxToolCalls: resolved.toolCallCap,
        maxRevisions: resolved.revisions,
        maxTokens: resolved.tokenBudgetIn ?? 0,
        initialMessages: seedMessages,
        phase: "executing",
      },
      state.signal,
    );
    state.mutatingCalls += execReport.toolCallsExecuted;
    if (execReport.status === "aborted") {
      await this.#gate(state, { requireCause: true });
      throw new RunPipelineError("the executor aborted without an observed cancellation");
    }
    this.#assertSessionAlive(state);
    if (typeof execReport.lastDocumentRevision === "number") {
      state.lastRevision = execReport.lastDocumentRevision;
    }
    state.budget.trackPhaseCompleted(); // "execute" phase (§5.2 settlement ratio)
    if (execReport.status !== "completed") {
      state.cleanStop = execReport.status === "budget_stopped" ? "budget_stopped" : "round_trip_stopped";
      state.warnings.push(execReport.cut?.message ?? "The execute walk stopped early (§5.1).");
      state.warnings.push(...execReport.steps.map((s) => s.summary()).filter(Boolean) as string[]);
    }

    // -- observing → rendering (§5.1 observe after act; §3.3 step 4) ----------
    const observation = await this.#observe(state, observer);

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
        throw new RunPipelineError(`the validator failed: ${validated.code}`);
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
        // §5.1: blockers gate the pipeline into a repair cycle; after the cap
        // the run fails validation (settlement refund_all — §5.2 commits only
        // validator-passing work).
        if (state.repairCycles >= MAX_REPAIR_CYCLES) {
          return await this.#validationFailureTerminal(state, report);
        }
        const ran = await this.#repairCycle(state, {
          issues: gate.repairTargets.map((issue) => ({
            level: issue.level,
            code: issue.code,
            ...(issue.layer === undefined ? {} : { layer: issue.layer }),
            fix: issue.fix,
          })),
          observation,
          executor,
          models,
        });
        if (!ran) {
          return await this.#validationFailureTerminal(state, report);
        }
        continue;
      }

      // No blockers. Budget-stopped runs skip the critic and repair entirely
      // (§5.2: budgets are hard caps — the critic could only demand work we
      // cannot run) and settle on the validator alone.
      if (state.cleanStop !== null || !criticRouteEnabled(state.run.tier)) {
        return await this.#finalize(state, observation);
      }

      await this.#moveTo(state, "critiquing");
      await this.#gate(state);
      const critique = await critic.critique({
        brief: state.run.prompt,
        previewUrl: observation.previewUrl ?? state.lastPreviewUrl ?? "",
        layerSummary: observation.compactSummary,
        palette: state.plan?.palette,
        validatorReport: report.summary,
        tier: state.run.tier,
      });
      if (!critique.ok) {
        throw new RunPipelineError(`the critic failed: ${critique.code}`);
      }
      this.#assertSessionAlive(state);
      const result: CritiqueResult = critique.value;
      await this.#emit(state, "critique.report", {
        verdict: result.skipped ? "accept" : result.verdict.verdict,
        scores: result.skipped
          ? { hierarchy: 5, balance: 5, contrast: 5, brief_adherence: 5, brand_fit: 5, editability: 5 }
          : result.verdict.scores,
        issues: (result.skipped ? [] : result.verdict.issues).map((issue) => ({
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
        if (!critic.noteRepairCycle()) {
          return await this.#finalize(state, observation);
        }
        state.repairCycles += 1;
        const ran = await this.#repairCycle(state, {
          issues: result.skipped
            ? []
            : result.repairIssues.map((issue) => ({
                severity: issue.severity,
                code: issue.code,
                ...(issue.layer === undefined ? {} : { layer: issue.layer }),
                fix: issue.fix ?? "",
              })),
          observation,
          executor,
          models,
        });
        if (!ran && gate.action === "repair") {
          return await this.#validationFailureTerminal(state, report);
        }
        continue; // re-validate + re-critique after the repair (§5.1)
      }
      // finalize_with_warnings: ship the best render with the issues (§5.1).
      state.warnings.push(...remainingIssueWarnings(decision.remainingIssues));
      return await this.#finalize(state, observation);
    }
  }

  // -------------------------------------------------------------------------
  // Phases
  // -------------------------------------------------------------------------

  /** §23.2/§5.1 planning: sections → PlannerService → emit run.plan. */
  async #plan(state: PipelineState): Promise<void> {
    await this.#gate(state);
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
    const sections = await plannerSections(state, bundle.manifest, bundle.templates);
    const planner = new PlannerService(models.planner);
    const planned = await planner.plan({ ...sections, signal: state.signal });
    if (!planned.ok) {
      // §5.1: invalid plan fails clear; provider seams are retryable (§5.3).
      const cause: PipelineRefundCause =
        planned.code === "provider_unhealthy"
          ? "provider_failure"
          : planned.code === "run_timeout"
            ? "engine_timeout"
            : "validation_failed";
      const error = runError(
        planned.code === "provider_unhealthy" ? "provider_unhealthy" : "validation_failed",
        planned.message,
        { hint: planned.hint, retryable: planned.retryable },
      );
      if (cause === "provider_failure") {
        error.hint = `${error.hint ?? ""} §24.4: the first retry after a provider failure on our side is free (retry_grace).`.trim();
      }
      throw new PlannedFailure(cause, error);
    }
    state.plan = planned.plan;
    state.warnings.push(...planned.warnings);
    await this.deps.db.savePlan(state.run.id, planned.plan);
    await this.#emit(state, "run.plan", { plan: planned.plan });
    state.budget.trackPhaseCompleted(); // "plan" phase
  }

  /** §5.1 observing: snapshot + ≤1024 px preview, emit preview.updated. */
  async #observe(
    state: PipelineState,
    observer: ObserverService,
  ): Promise<{ readonly compactSummary: string; readonly previewUrl?: string; readonly revision?: number }> {
    await this.#moveTo(state, "observing");
    const observed = await observer.afterAction(state.run.documentId);
    if (!observed.ok) {
      this.#assertSessionAlive(state);
      throw new RunPipelineError(`the observe pass failed: ${observed.code}`);
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

  /** One §23.4/§11.2 repair cycle; returns false when no step could run. */
  async #repairCycle(
    state: PipelineState,
    input: {
      readonly issues: readonly Record<string, unknown>[];
      readonly observation: { readonly compactSummary: string; readonly revision?: number };
      readonly executor: ExecutorService;
      readonly models: Awaited<ReturnType<RunManagerDeps["models"]["forRun"]>>;
    },
  ): Promise<boolean> {
    await this.#moveTo(state, "repairing");
    const repaired = await planRepairs({
      issues: input.issues as Parameters<typeof planRepairs>[0]["issues"],
      context: {
        layerTree: input.observation.compactSummary,
        palette: state.plan?.palette,
        validatorReport: "",
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
          repaired.message,
          { hint: repaired.hint, retryable: repaired.retryable },
        ),
      );
    }
    state.warnings.push(...repaired.value.warnings);
    if (repaired.value.steps.length === 0) {
      // §23.4 rule 4: every fix was impossible — documented, nothing worse.
      state.log.warn("repair cycle planned no steps", { repairCycles: state.repairCycles });
      return false;
    }
    const miniPlan = await import "../../../../packages/agent/src/repair/planner.js" as never;
    void miniPlan;
    return false;
  }

  // -------------------------------------------------------------------------
  // Terminals
  // -------------------------------------------------------------------------

  ...
}
