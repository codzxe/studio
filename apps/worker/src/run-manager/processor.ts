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
import { classifyRefund, commitReservation, maxPartialFailureCharge, releaseReservation } from "@studio/billing";
import type { ToolListing } from "@studio/tools";
import { PlannerService, type PlannerSections } from "../../../../packages/agent/src/planner/planner.js";
import {
  EXECUTOR_DEFAULT_TOOL_CALL_TIMEOUT_MS,
  ExecutorService,
  type ExecutorReport,
} from "../../../../packages/agent/src/executor/executor.js";
import { ObserverService } from "../../../../packages/agent/src/observer/observer.js";
import { RunValidator, type ValidatorReport } from "../../../../packages/agent/src/validator/service.js";
import { validateGate } from "../../../../packages/agent/src/validator/gate.js";
import {
  RunCritic,
  type CritiqueResult,
  createRepairCycleCounter,
  criticRouteEnabled,
} from "../../../../packages/agent/src/critic/service.js";
import type { CritiqueIssue } from "../../../../packages/agent/src/critic/service.js";
import { cycleGateForOutcome } from "../../../../packages/agent/src/critic/cycle-gate.js";
import { buildRepairMiniPlan, planRepairs } from "../../../../packages/agent/src/repair/planner.js";
import { createBudgetTracker, type TierBudgetTracker } from "../../../../packages/agent/src/budgets-service/tracker-factory.js";
import {
  computeSettlement,
  partialChargeCredits,
  type Settlement,
} from "../../../../packages/agent/src/budgets-service/settlement.js";
import { TransactionManager } from "../../../../packages/agent/src/transactions/manager.js";
import type { Clock } from "../../../../packages/agent/src/budgets.js";
import type { TemplateCatalogLike } from "@studio/tools";
import type { RunRecord, RunManagerDeps, RunManagerError } from "./deps.js";
import type { EngineSessionHandle } from "./deps.js";
import type { RunModelAdapters } from "./deps.js";
import type { ToolContextBundle } from "./deps.js";
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

/** §5.1/§3.3 step 4: the observe-loop preview edge (px, ≤1024 per §6 row 14). */
export const RUN_PREVIEW_EDGE_PX = 1024;

/** §5.4 token discipline: catalog templates enriched with slots for the planner. */
export const MAX_PLANNER_TEMPLATE_ENTRIES = 25;

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

/** A typed terminal request (refund cause + user-safe error envelope). */
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
    readonly kind: { readonly cause: "user_cancel"; readonly reason?: string } | { readonly cause: "engine_timeout" },
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

// ---------------------------------------------------------------------------
// §5.2 settlement for clean stops (pure, table-tested via the pipeline tests)
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
 * pricing, never an error), so it mirrors the table with the exact §5.2
 * partial formula (`partialChargeCredits`). Validation still gates: §5.2
 * commits only validator-passing work.
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
    const charge = partialChargeCredits(reservedCredits, report.phasesCompleted, report.phasesTotal);
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
  | "validation_failed";

/**
 * Credits charged when a failure rolls the document back (§14.2 rules 3–5):
 * full-refund causes release everything; §14.2 rule 4 partial causes charge at
 * most half the base AND only when mutating calls actually progressed — the
 * rollback restores the pre-run document either way (§3.4, policy.ts's "the
 * caller still passes 0 when no mutating command ran").
 */
export function refundChargeCredits(
  cause: PipelineRefundCause,
  reservedCredits: number,
  mutatingCallsExecuted: number,
): number {
  const policy = classifyRefund(cause);
  if (policy === "full_refund" || policy === "none") {
    return 0; // budget stops never route here (settlementForCleanStop owns them)
  }
  if (mutatingCallsExecuted <= 0) {
    return 0;
  }
  return maxPartialFailureCharge(reservedCredits);
}

// ---------------------------------------------------------------------------
// §23.2 planner-section assembly (pure-ish; catalog enrichment is async)
// ---------------------------------------------------------------------------

interface PlannerTemplateEntryLike {
  readonly id: string;
  readonly version: string;
  readonly slots?: readonly string[];
  readonly tags?: readonly string[];
  readonly title?: string;
}

async function enrichTemplateEntries(
  templates: TemplateCatalogLike,
): Promise<readonly PlannerTemplateEntryLike[]> {
  let summaries: readonly { readonly id: string; readonly version: string }[] = [];
  try {
    summaries = await templates.list({ limit: MAX_PLANNER_TEMPLATE_ENTRIES });
  } catch {
    return []; // catalog hiccup ⇒ plan freeform; the planner warns (§23.2)
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
 * manifest + template entries enriched with slot names — §23.2 "never invent
 * slot names" needs them verifiable), BUDGET (the §5.2 row), RULES (v1: the
 * §11.1 catalog rides the validator, not the prompt).
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

/** §5.1 "surface the remaining issues with suggested manual fixes". */
export function remainingIssueWarnings(issues: readonly CritiqueIssue[]): readonly string[] {
  return issues.map((issue) => {
    const where = issue.layer === undefined ? "" : ` (${issue.layer})`;
    const fix = issue.fix ?? issue.observation ?? "manual fix suggested";
    return `${issue.code}${where}: ${fix}`;
  });
}

// ---------------------------------------------------------------------------
// Run state (single-owner, §5.2; threaded through every phase)
// ---------------------------------------------------------------------------

interface PipelineState {
  readonly run: RunRecord;
  readonly log: RunManagerDeps["logger"];
  /** Internal cooperative signal: job wall clock + observed cancellation. */
  readonly signal: AbortSignal;
  abortRun(): void;
  session: EngineSessionHandle;
  /** §3.4 resume cursor after recovery replayed the WAL onto a fresh session. */
  resume: { readonly seq: number; readonly revision: number } | null;
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
    // can never double-apply or double-charge (the idempotent ledger keys of
    // §14.2 rule 6 sit on top of this).
    const replayed = recordedOutcome(row);
    if (replayed !== null) {
      log.info("run row already terminal — replaying the recorded outcome", { status: row.status });
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
          "internal_error",
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
      log,
      signal: runAbort.signal,
      abortRun: () => runAbort.abort(),
      session: null as unknown as EngineSessionHandle,
      resume: null,
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
            throw new PlannedFailure(
              "engine_crashed",
              runError(
                "engine_crashed",
                "The engine crashed again after the single recovery resume; the run was rolled back.",
                { hint: "The document stays at its last committed checkpoint (§3.4).", retryable: false },
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
            const error2 = runError(
              recovered.failure.code,
              recovered.failure.message,
              {
                hint: recovered.failure.hint,
                retryable: recovered.spentResume ? false : recovered.failure.retryable,
              },
            );
            throw new PlannedFailure("engine_crashed", error2);
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
  // The §5.1 state-machine walk (one pass; §3.4 recovery may re-enter)
  // -------------------------------------------------------------------------

  async #pipeline(state: PipelineState): Promise<RunOutcome> {
    const bundle = await this.deps.tools.create({
      run: state.run,
      session: state.session,
      budget: createBudgetTracker(state.run.tier, { clock: this.deps.clock }),
      signal: state.signal,
    });
    void bundle;
    throw new RunPipelineError("replaced below");
  }

  // -------------------------------------------------------------------------
  // Helpers (status machine, gates, emission, crash checks)
  // -------------------------------------------------------------------------

  ...
}
