// apps/worker/tests/run-manager/fake-deps.ts — the reusable fake `RunManagerDeps`
// factory for the W6-N processor suite (W7-N, docs/AGENTS.md).
//
// The processor (apps/worker/src/run-manager/processor.ts) is DI-pure: every
// collaborator arrives through `RunManagerDeps`, so the WHOLE §3.3/§5.1
// pipeline (planner → transaction → executor → observer → validator → critic
// → repair → commit → settlement) runs on the fakes below — no engine
// process, no network, no database (docs/AGENTS.md test rules; <5 s units).
//
// What is real vs fake here (the boundary is deliberate):
//   REAL  (exercised verbatim): StudioRunProcessor, TransactionManager (W6-I),
//         PlannerService, ExecutorService, ObserverService, RunValidator +
//         validateGate, RunCritic + cycleGateForOutcome, planRepairs +
//         buildRepairMiniPlan, TierBudgetTracker, and @studio/billing's
//         commit/release/refund policy — the §14.2 math runs for real.
//   FAKE  (scripted per test): the engine session (agent.begin/commit/rollback
//         reply shapes pinned by engine-patches/docs/commands.md §5.6), the
//         four §5.3 model seams, the validate/vision-critique TOOLS, the run
//         row, the ledger rows (seeded with the §14.2 rule-1 hold the gateway
//         places before enqueue), the WAL/storage/checkpoint seams, the
//         §3.4 recovery hook and the W6-J cancellation source.
//
// Scripting model: every fake is a mutable, observable object handed back on
// the `Fakes` record — tests flip fields BEFORE `process()` (e.g.
// `fakes.models.planner.replies = [...]`) and read the call logs after.
// Reply queues REPEAT their last entry when they reach it, so a test only
// scripts the entries whose order matters.
//
// Style: TS strict, ESM, .js specifiers, no `any`, no non-null assertions.

import {
  type CriticToolArgs,
  type CriticToolLike,
  type EngineReply,
  type EngineTxLike,
  type ExecuteModelLike,
  type ExecutorBudgetView,
  type ExecutorEvent,
  type ExecutorTranscript,
  type Plan,
  type PlanModelCompletion,
  type PlanModelLike,
  type PreviewLike,
  type PublishResult,
  type RepairModelLike,
  type RepairModelResult,
  type RunEventPayloadMap,
  type RunEventType,
  type SnapshotLike,
  type ValidateToolLike,
  type WalAppendInput,
  type WalAppendLike,
} from "@studio/agent";
import { defaultPcraftStorageKey } from "@studio/agent";
import type { CheckpointInput, CheckpointLike, StorageLike } from "@studio/agent";
import type {
  AnyTool,
  CriticModelLike,
  EngineLike,
  TemplateCatalogLike,
  ToolContext,
  ToolListing,
  ToolResult,
  ValidateDocumentArgs,
} from "@studio/tools";
import { creditsForRun, reserveKey } from "@studio/billing";
import type { CreditLedgerEntry, LedgerStore } from "@studio/billing";
import type { RunTierId } from "@studio/config";
import { z } from "zod";
import type { LogFields, Logger } from "../../src/logger.js";
import type { PreviewEngine } from "../../src/preview.js";
import type { RunJobContext } from "../../src/processor.js";
import type { RunTier } from "../../src/queues.js";
import type {
  AcquireEngineSessionInput,
  CheckpointForRun,
  CreateModelAdaptersInput,
  CreateToolContextInput,
  EmitRunEvent,
  EngineCrashEvidence,
  EngineCrashRecovery,
  EngineRecoveryRequest,
  EngineRecoveryResult,
  EngineSessionFactory,
  EngineSessionHandle,
  FinalizeRunInput,
  ModelAdapterFactory,
  PreviewPipelineLike,
  RunCancellationSnapshot,
  RunCancellationSource,
  RunManagerDeps,
  RunModelAdapters,
  RunRecord,
  RunRecordStatus,
  RunRepository,
  RunUsageRecord,
  ToolContextBundle,
  ToolContextFactory,
  TransactionSeams,
} from "../../src/run-manager/deps.js";

// Re-exported so tests assert the checkpoint key against the same source of
// truth the TransactionManager uses (§3.3 step 6).
export { defaultPcraftStorageKey };

// ---------------------------------------------------------------------------
// Shared constants (§24.1 coffee trace, pinned)
// ---------------------------------------------------------------------------

/** Deterministic epoch (ms) — every Date the pipeline produces is this. */
export const FAKE_NOW_MS = 1_700_000_000_000;

/** The engine's doc.save reply bytes — PNG magic + a tail (§3.3 step 6). */
export const PCRAFT_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** §6.1-safe preview URL the fake observer seam reports (http(s) only). */
export const PREVIEW_URL = "https://cdn.example.com/previews/run-latest.png";

/** The §24.1 template pin + the document (a UUID — the validator args schema). */
export const INSTAGRAM_TEMPLATE = "instagram-post@3";
export const COFFEE_DOCUMENT_ID = "3f0d2a1c-8b4e-4f6a-9c2d-7e5b8a1f0d33";

/** §24.1 validate trace: "0 blockers, 1 minor: subhead 14px from safe area". */
export const VALIDATOR_MINOR_CODE = "safe_area_margin";
/** The blocker the repair-once scenario drives (§5.1 blocker → repair). */
export const VALIDATOR_BLOCKER_CODE = "text_overflow";
/** The major the 2-cycle-cap scenario keeps surfacing (§5.1/§11.2). */
export const CRITIC_MAJOR_CODE = "low_contrast_body";

/** The §6.1 compact JSON the fake validate_document tool summarizes with. */
export function validatorSummary(input: {
  readonly ok: boolean;
  readonly issues: ReadonlyArray<{
    readonly level: "blocker" | "major" | "minor";
    readonly code: string;
    readonly layer?: string;
    readonly message: string;
    readonly fix: string;
  }>;
}): string {
  const counts = { blocker: 0, major: 0, minor: 0 };
  for (const issue of input.issues) {
    counts[issue.level] += 1;
  }
  return JSON.stringify({
    ok: input.ok,
    issueCounts: counts,
    template: INSTAGRAM_TEMPLATE,
    issues: input.issues,
    truncated: false,
  });
}

/** The §23.3 critique JSON the fake vision_critique tool summarizes with. */
export function critiqueSummary(input: {
  readonly verdict: "accept" | "revise";
  readonly issues: ReadonlyArray<{
    readonly severity: "blocker" | "major" | "minor";
    readonly code: string;
    readonly layer?: string;
    readonly observation?: string;
    readonly fix?: string;
  }>;
}): string {
  return JSON.stringify({
    verdict: input.verdict,
    scores: {
      hierarchy: 4,
      balance: 4,
      contrast: 5,
      brief_adherence: 5,
      brand_fit: 4,
      editability: 5,
    },
    issues: input.issues,
  });
}

/** A clean validator pass carrying the §24.1 minor (§11.1: minors never gate). */
export function validatorPassResult(): ToolResult {
  return {
    ok: true,
    summary: validatorSummary({
      ok: true,
      issues: [
        {
          level: "minor",
          code: VALIDATOR_MINOR_CODE,
          layer: "Subhead",
          message: "Subhead sits 14px from the safe-area edge",
          fix: "Move the subhead at least 16px inside the safe area",
        },
      ],
    }),
  };
}

/** One blocker report — §5.1: blockers gate the pipeline into repair. */
export function validatorBlockerResult(): ToolResult {
  return {
    ok: true,
    summary: validatorSummary({
      ok: false,
      issues: [
        {
          level: "blocker",
          code: VALIDATOR_BLOCKER_CODE,
          layer: "Headline",
          message: "Headline text overflows its slot at 96pt",
          fix: "Refit the headline at 88pt over two lines",
        },
      ],
    }),
  };
}

/** §24.1 critique: scores 4/4/5/5/4/5, verdict accept, no issues. */
export function criticAcceptResult(): ToolResult {
  return {
    ok: true,
    summary: critiqueSummary({ verdict: "accept", issues: [] }),
  };
}

/** A revise verdict with one major — drives §5.1 repair cycles. */
export function criticReviseResult(): ToolResult {
  return {
    ok: true,
    summary: critiqueSummary({
      verdict: "revise",
      issues: [
        {
          severity: "major",
          code: CRITIC_MAJOR_CODE,
          layer: "Body",
          observation: "Body text contrasts at 2.9:1 against the background",
          fix: "Increase body text contrast to at least 4.5:1",
        },
      ],
    }),
  };
}

// ---------------------------------------------------------------------------
// §24.1 plan fixtures
// ---------------------------------------------------------------------------

/**
 * The §24.1 coffee plan, §5.5-valid and §23.2-checkable against the fake
 * CATALOG below (template + slots must exist; ids are never invented).
 * `assets` stays empty ON PURPOSE: `buildPlannerSections` ships no asset ids
 * (the §5.4 attachments wiring is the context owner's), so citing asset_812
 * would trip the §23.2 invented-asset check; the latte photo rides the
 * template_fill args instead — §5.5 passthrough jsonb validated at the tool
 * boundary, exactly like the shipped planner documents.
 */
export function coffeePlan(): Plan {
  return {
    intent: "create_post",
    template: INSTAGRAM_TEMPLATE,
    assets: [],
    slots: { headline: "Fresh roasted, every morning", subhead: "Open 7–5 · Main St" },
    palette: ["#6B4F3A", "#F4E7D3", "#D96C3B"],
    typography: {},
    steps: [
      { tool: "template_apply", args: { ref: INSTAGRAM_TEMPLATE } },
      {
        tool: "template_fill",
        args: {
          headline: "Fresh roasted, every morning",
          subhead: "Open 7–5 · Main St",
          photo: "asset_812",
        },
      },
    ],
    checks: ["in_bounds", "contrast_min_4_5", "safe_area"],
    model_tier: "standard",
    notes_for_user: "Reused the brand palette; headline shortened to fit two lines.",
  };
}

/** The planner model's raw completion for the coffee plan. */
export const COFFEE_PLAN_JSON = JSON.stringify(coffeePlan());

/** A §5.5-valid probe plan with custom steps (the §5.2 budget-stop tests). */
export function multiStepPlan(
  steps: ReadonlyArray<{
    readonly tool: string;
    readonly args?: Readonly<Record<string, unknown>>;
  }>,
): Plan {
  return {
    intent: "create_post",
    template: INSTAGRAM_TEMPLATE,
    assets: [],
    slots: {},
    palette: [],
    typography: {},
    steps: steps.map((step) => ({ tool: step.tool, args: { ...(step.args ?? {}) } })),
    checks: [],
    model_tier: "standard",
    notes_for_user: "Budget-stop probe plan (§5.2).",
  };
}

/** The §23.4 planning reply: one minimal fix for the known issue code. */
export function repairReplyFor(issue: string): string {
  return JSON.stringify({
    applied: [{ issue, tool: "text_set", args: { text: "Fresh roasted, every morning" } }],
  });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Shifts the queue's head; the last entry repeats forever (script queues). */
function nextFrom<T>(queue: T[]): T {
  const head = queue[0];
  if (head === undefined) {
    throw new Error("fake script queue is empty — seed it before process()");
  }
  if (queue.length > 1) {
    queue.shift();
  }
  return head;
}

/** The §5.4 compact summary the fake snapshot seam returns (delta-parseable). */
function snapshotSummary(revision: number): string {
  return JSON.stringify({
    revision,
    canvas: { widthPx: 1080, heightPx: 1080 },
    layers: [
      { layerId: "layer_bg", name: "Background", kind: "fill", visible: true },
      { layerId: "layer_photo", name: "Photo", kind: "pixel", visible: true },
      { layerId: "layer_headline", name: "Headline", kind: "type", visible: true },
      { layerId: "layer_subhead", name: "Subhead", kind: "type", visible: true },
    ],
  });
}

function fakeLogger(): Logger {
  const make = (bindings: Record<string, unknown>): Logger => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: (more: LogFields) => make({ ...bindings, ...more }),
  });
  return make({});
}

// ---------------------------------------------------------------------------
// FakeEngineSession — one live engine session (§3.2/§5.6 reply shapes)
// ---------------------------------------------------------------------------

/**
 * The engine side of the §5.6 transaction protocol. Reply shapes are pinned
 * by engine-patches/docs/commands.md: `agent.begin` echoes the checkpoint
 * revision; the commit/rollback fold bumps the revision by exactly ONE over
 * the checkpoint (`revision_after ∈ [checkpoint, checkpoint+1]` — the manager
 * enforces that envelope, and nothing tracks commands through this seam in
 * these tests); `agent.rollback` restores. Content commands advance the
 * revision by one (§5.6 monotonic counters).
 */
export class FakeEngineSession implements EngineSessionHandle {
  readonly sessionId: string;
  revision: number;
  releaseCount = 0;
  readonly txCalls: Array<{
    command: string;
    params: Readonly<Record<string, unknown>>;
  }> = [];

  private transactionId = 0;
  private beginRevision = 0;
  private crashEvidence: EngineCrashEvidence | null = null;

  constructor(input: { readonly sessionId: string; readonly revision: number }) {
    this.sessionId = input.sessionId;
    this.revision = input.revision;
  }

  /** Latches crash evidence, as the real adapters do on crash-class failures. */
  armCrash(evidence: EngineCrashEvidence): void {
    this.crashEvidence = evidence;
  }

  crashed(): EngineCrashEvidence | null {
    return this.crashEvidence;
  }

  async release(): Promise<void> {
    this.releaseCount += 1;
  }

  /** One executed content command advances the revision (§5.6 monotonic +1). */
  bump(): number {
    this.revision += 1;
    return this.revision;
  }

  private bumpN(count: number): number {
    this.revision += count;
    return this.revision;
  }

  readonly tx: EngineTxLike = {
    execute: async (
      command: string,
      params: Readonly<Record<string, unknown>>,
    ): Promise<EngineReply<Readonly<Record<string, unknown>>>> => {
      this.txCalls.push({ command, params });
      if (command === "agent.begin") {
        this.transactionId += 1;
        this.beginRevision = this.revision;
        return {
          ok: true,
          result: { transaction_id: this.transactionId, revision_before: this.revision },
        };
      }
      if (command === "agent.commit") {
        return {
          ok: true,
          result: {
            transaction_id: this.transactionId,
            revision_before: this.beginRevision,
            revision_after: this.beginRevision + 1,
          },
        };
      }
      if (command === "agent.rollback") {
        return {
          ok: true,
          result: {
            transaction_id: this.transactionId,
            revision_before: this.beginRevision,
            revision_after: this.beginRevision + 1,
            restored: true,
          },
        };
      }
      this.revision += 1;
      return { ok: true, result: { revision: this.revision } };
    },
    save: async (): Promise<EngineReply<{ bytes: Uint8Array }>> => ({
      ok: true,
      result: { bytes: PCRAFT_BYTES.slice() },
    }),
  };

  /** The §6.2 `ctx.engine` surface the fake ToolContext hands the tools. */
  readonly commands: EngineLike = {
    batch: async (cmds) => ({
      ok: true,
      value: { revision: this.bumpN(cmds.length), outcomes: [] },
    }),
    execute: async () => ({ ok: true, value: { revision: this.bump() } }),
    render: async () => ({
      ok: true,
      value: {
        image: PCRAFT_BYTES.slice(),
        widthPx: 1024,
        heightPx: 1024,
        revision: this.revision,
      },
    }),
    inspect: async () => ({
      ok: true,
      value: {
        revision: this.revision,
        widthPx: 1080,
        heightPx: 1080,
        layers: [],
        palette: [],
        fonts: [],
      },
    }),
    listLayers: async () => ({ ok: true, value: [] }),
  };

  /** The §5.1 preview seam (doc.render + write-root read), bound per session. */
  readonly previewEngine: PreviewEngine = {
    renderDocument: async () => ({ path: "previews/run-latest.png", bytes: PCRAFT_BYTES.length }),
    readRootFile: async () => PCRAFT_BYTES.slice(),
  };
}

/** The §3.2 session factory: one fresh fake session per acquire. */
export class FakeEngineSessions implements EngineSessionFactory {
  readonly acquires: AcquireEngineSessionInput[] = [];
  readonly sessions: FakeEngineSession[] = [];

  constructor(private readonly firstRevision: number) {}

  async acquire(input: AcquireEngineSessionInput): Promise<EngineSessionHandle> {
    this.acquires.push(input);
    const session = new FakeEngineSession({
      sessionId: `sess_${this.acquires.length}`,
      revision: this.firstRevision,
    });
    this.sessions.push(session);
    return session;
  }
}

// ---------------------------------------------------------------------------
// §3.4 recovery hook (fake RecoveryLike)
// ---------------------------------------------------------------------------

export interface FakeRecoveryPlan {
  /** §3.4: replay counts against run budgets — the number the hook reports. */
  readonly replayedCommands: number;
  /** Where the replayed WAL left the fresh session (§5.6 cursor). */
  readonly resume: { readonly seq: number; readonly revision: number };
  /** Extra: pre-latch the replacement session (the second-crash scenario). */
  readonly crashImmediately?: { readonly code: string; readonly detail?: string };
  readonly sessionId?: string;
}

/**
 * The §3.4 "restart, replay to checkpoint, resume once" hook, scripted: hands
 * back a fresh session holding the replayed revision plus the resume cursor.
 * The default plan mirrors two replayed commands over the §24.1 checkpoint 41
 * (revisions 42–43), matching the WAL rows the crash scenario logged.
 */
export class FakeRecovery implements EngineCrashRecovery {
  readonly requests: EngineRecoveryRequest[] = [];
  plan: FakeRecoveryPlan = { replayedCommands: 2, resume: { seq: 3, revision: 43 } };

  async recover(request: EngineRecoveryRequest): Promise<EngineRecoveryResult> {
    this.requests.push(request);
    const session = new FakeEngineSession({
      sessionId: this.plan.sessionId ?? "sess_recovered",
      revision: this.plan.resume.revision,
    });
    if (this.plan.crashImmediately !== undefined) {
      session.armCrash(this.plan.crashImmediately);
    }
    return {
      ok: true,
      session,
      replayedCommands: this.plan.replayedCommands,
      resume: this.plan.resume,
    };
  }
}

// ---------------------------------------------------------------------------
// W6-J cancellation source
// ---------------------------------------------------------------------------

/** The pollable cancellation source: flat until armed, then cancelled. */
export class FakeCancellationSource implements RunCancellationSource {
  readonly observations: string[] = [];
  private snapshot: RunCancellationSnapshot = { cancelled: false };

  armCancel(reason: string): void {
    this.snapshot = { cancelled: true, reason };
  }

  async observe(runId: string): Promise<RunCancellationSnapshot> {
    this.observations.push(runId);
    return this.snapshot;
  }
}

// ---------------------------------------------------------------------------
// Run row + repository
// ---------------------------------------------------------------------------

type MutableRunRecord = { -readonly [K in keyof RunRecord]: RunRecord[K] };

/** In-memory `agent_runs` slice: the row mutates as the pipeline persists. */
export class FakeRunRepository implements RunRepository {
  private readonly current: MutableRunRecord;
  readonly loadCalls: string[] = [];
  readonly statusCalls: RunRecordStatus[] = [];
  readonly savedPlans: Array<{ runId: string; plan: Plan }> = [];
  readonly usage: Array<{ runId: string; usage: RunUsageRecord }> = [];
  readonly finalizations: FinalizeRunInput[] = [];
  /** Flip to true to test the "row missing" path (§3.3 step 2 invariant). */
  missing = false;

  constructor(row: RunRecord) {
    this.current = { ...row };
  }

  get row(): RunRecord {
    return this.current;
  }

  async loadRun(runId: string): Promise<RunRecord | undefined> {
    this.loadCalls.push(runId);
    return this.missing ? undefined : this.current;
  }

  async updateStatus(runId: string, status: RunRecordStatus): Promise<void> {
    this.statusCalls.push(status);
    this.current.status = status;
  }

  async savePlan(runId: string, plan: Plan): Promise<void> {
    this.savedPlans.push({ runId, plan });
    this.current.plan = plan;
  }

  async recordUsage(runId: string, usage: RunUsageRecord): Promise<void> {
    this.usage.push({ runId, usage });
  }

  async finalizeRun(input: FinalizeRunInput): Promise<void> {
    this.finalizations.push(input);
    this.current.status = input.status;
    this.current.creditsCharged = input.creditsCharged;
    this.current.error = input.error ?? null;
  }
}

// ---------------------------------------------------------------------------
// §14.2 ledger (in-memory rows; seeded with the gateway's rule-1 hold)
// ---------------------------------------------------------------------------

export class FakeLedgerStore implements LedgerStore {
  readonly rows: CreditLedgerEntry[] = [];

  constructor(seed: { organizationId: string; runId: string; reserved: number }) {
    // §14.2 rule 1: the gateway holds the tier price BEFORE enqueueing, so
    // commitReservation/releaseReservation find their reservation (§3.3 step 2).
    this.rows.push({
      organizationId: seed.organizationId,
      delta: -seed.reserved,
      kind: "reserve",
      idempotencyKey: reserveKey(seed.runId),
      runId: seed.runId,
      note: "gateway hold before enqueue (§14.2 rule 1)",
    });
  }

  async append(entry: CreditLedgerEntry): Promise<void> {
    const duplicate = this.rows.some(
      (row) => row.idempotencyKey === entry.idempotencyKey && row.kind === entry.kind,
    );
    if (duplicate) {
      throw new Error(`fake ledger: duplicate (${entry.kind}) ${entry.idempotencyKey}`);
    }
    this.rows.push(entry);
  }

  async balanceAfter(organizationId: string): Promise<number> {
    return this.rows
      .filter((row) => row.organizationId === organizationId)
      .reduce((sum, row) => sum + row.delta, 0);
  }

  async findByIdempotency(
    idempotencyKey: string,
    kind: CreditLedgerEntry["kind"],
  ): Promise<boolean> {
    return this.rows.some((row) => row.idempotencyKey === idempotencyKey && row.kind === kind);
  }

  ofKind(kind: CreditLedgerEntry["kind"]): CreditLedgerEntry[] {
    return this.rows.filter((row) => row.kind === kind);
  }
}

// ---------------------------------------------------------------------------
// §13.2/§22 durable emit (recorder)
// ---------------------------------------------------------------------------

interface RecordedEvent {
  readonly runId: string;
  readonly type: RunEventType;
  readonly payload: unknown;
  readonly organizationId: string;
}

/** Records every publish; `failOn` simulates a broken event store (§22). */
export class EmitRecorder {
  readonly events: RecordedEvent[] = [];
  failOn: RunEventType | null = null;

  readonly emit: EmitRunEvent = async <T extends RunEventType>(
    runId: string,
    type: T,
    payload: RunEventPayloadMap[T],
    context: { readonly organizationId: string },
  ): Promise<PublishResult<T>> => {
    if (this.failOn === type) {
      return {
        ok: false,
        code: "event_persist_failed",
        message: "the fake event store refused the append",
        retryable: true,
      };
    }
    this.events.push({ runId, type, payload, organizationId: context.organizationId });
    return {
      ok: true,
      event: {
        seq: this.events.length,
        runId,
        at: new Date(FAKE_NOW_MS),
        type,
        payload,
        organizationId: context.organizationId,
      },
    };
  };

  /** Event types in publish order (the §13.2 timeline). */
  types(): RunEventType[] {
    return this.events.map((event) => event.type);
  }

  count(type: RunEventType): number {
    return this.events.filter((event) => event.type === type).length;
  }

  /** Payloads of one type, in order. */
  of<T extends RunEventType>(type: T): RunEventPayloadMap[T][] {
    return this.events
      .filter((event) => event.type === type)
      .map((event) => event.payload as RunEventPayloadMap[T]);
  }
}

// ---------------------------------------------------------------------------
// Deterministic clock (§5.2 wall clock stays at zero consumption)
// ---------------------------------------------------------------------------

export class FakeClock {
  private nowMs = FAKE_NOW_MS;
  readonly now = (): number => this.nowMs;

  advance(ms: number): void {
    this.nowMs += ms;
  }
}

// ---------------------------------------------------------------------------
// §5.6 transaction seams (WAL / object storage / checkpoint)
// ---------------------------------------------------------------------------

export class FakeWal implements WalAppendLike {
  readonly rows: WalAppendInput[] = [];

  async append(input: WalAppendInput): Promise<void> {
    this.rows.push(input);
  }
}

export class FakeStorage implements StorageLike {
  readonly puts: Array<{ key: string; bytes: Uint8Array }> = [];

  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.puts.push({ key, bytes });
  }
}

export class FakeCheckpoint implements CheckpointLike {
  readonly saved: CheckpointInput[] = [];

  async save(input: CheckpointInput): Promise<void> {
    this.saved.push(input);
  }
}

// ---------------------------------------------------------------------------
// §5.3 model seams — planner / executor / repair / validator / critic
// ---------------------------------------------------------------------------

/** The §23.2 planner model: raw text replies, one per complete() call. */
export class FakePlannerModel implements PlanModelLike {
  replies: string[] = [COFFEE_PLAN_JSON];
  readonly prompts: string[] = [];

  async complete(prompt: string): Promise<PlanModelCompletion> {
    this.prompts.push(prompt);
    return {
      text: nextFrom(this.replies),
      usage: { tokensIn: 4_200, tokensOut: 900, cacheHits: 3_100 },
    };
  }
}

export interface ExecutorStepScript {
  /** Yielded first inside the stream (one per §5.1 model↔tool round trip). */
  readonly usage?: {
    readonly model: string;
    readonly tokensIn: number;
    readonly tokensOut: number;
    readonly cacheHits?: number;
  };
  /** Tool-call proposals of the planned tool (§23.1: one per step by default). */
  readonly calls: number;
  /** Override the proposed args (default: the plan step's args verbatim). */
  readonly args?: (
    index: number,
    planned: { readonly tool: string; readonly args: unknown },
  ) => unknown;
  readonly doneText?: string;
}

export type ExecutorScript = (input: {
  readonly streamIndex: number;
  readonly plannedTool: string;
  readonly plannedArgs: unknown;
}) => ExecutorStepScript;

export interface ExecutorInvocation {
  readonly plannedTool: string;
  readonly plannedArgs: unknown;
  readonly budget: ExecutorBudgetView;
}

const DEFAULT_EXECUTOR_SCRIPT: ExecutorScript = () => ({
  usage: { model: "fake-executor", tokensIn: 600, tokensOut: 150, cacheHits: 450 },
  calls: 1,
  doneText: "step complete",
});

/**
 * Pulls the planned step out of the executor's step directive (the last user
 * message): `Plan step N of M: call the "tool" tool now. Planned arguments
 * (JSON, adapt to the current document): {...}. Finish the turn when the
 * step is done.` — the §23.1 directive, so the fake proposes the plan's tool.
 */
function parseStepDirective(
  transcript: ExecutorTranscript,
): { tool: string; args: unknown } {
  const messages = transcript.messages();
  let text = "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message !== undefined && message.role === "user") {
      text = message.text;
      break;
    }
  }
  const tool = /call the "([^"]+)" tool now/.exec(text)?.[1] ?? "template_apply";
  const marker = ". Finish the turn when the step is done.";
  const end = text.lastIndexOf(marker);
  const start = text.indexOf(": ", text.indexOf("Planned arguments (JSON"));
  let args: unknown = {};
  if (end >= 0 && start >= 0) {
    args = JSON.parse(text.slice(start + 2, end)) as unknown;
  }
  return { tool, args };
}

/** The §23.1 executor model loop, scripted per stream (one stream per step). */
export class FakeExecutorModel implements ExecuteModelLike {
  script: ExecutorScript = DEFAULT_EXECUTOR_SCRIPT;
  readonly invocations: ExecutorInvocation[] = [];

  async *streamToolLoop(
    _system: string,
    messages: ExecutorTranscript,
    _tools: readonly ToolListing[],
    budget: ExecutorBudgetView,
    _signal: AbortSignal,
  ): AsyncGenerator<ExecutorEvent> {
    const planned = parseStepDirective(messages);
    const streamIndex = this.invocations.length;
    this.invocations.push({
      plannedTool: planned.tool,
      plannedArgs: planned.args,
      budget,
    });
    const step = this.script({
      streamIndex,
      plannedTool: planned.tool,
      plannedArgs: planned.args,
    });
    yield { type: "turn_started" };
    if (step.usage !== undefined) {
      yield { type: "usage", usage: step.usage };
    }
    for (let i = 0; i < step.calls; i += 1) {
      yield {
        type: "tool_call",
        callId: `call_${streamIndex}_${i}`,
        name: planned.tool,
        args: step.args === undefined ? planned.args : step.args(i, planned),
      };
    }
    yield { type: "step_done", text: step.doneText ?? "step complete" };
  }
}

/** The §23.4 repair model: raw {"applied":[…]} replies. */
export class FakeRepairModel implements RepairModelLike {
  replies: string[] = ['{"applied":[]}'];
  readonly prompts: string[] = [];

  async complete(prompt: string): Promise<RepairModelResult> {
    this.prompts.push(prompt);
    return {
      raw: nextFrom(this.replies),
      usage: { inputTokens: 500, outputTokens: 220, totalTokens: 720 },
    };
  }
}

/** The raw §23.3 vision seam — unused by the processor (criticTool rides instead). */
const THROWING_CRITIC_MODEL: CriticModelLike = {
  async critique() {
    throw new Error(
      "the raw criticModel seam is not used by StudioRunProcessor (§23.3 rides criticTool)",
    );
  },
};

/** §5.3 model adapter factory: builds the scripted seams per forRun call. */
export class FakeModelFactory implements ModelAdapterFactory {
  readonly planner = new FakePlannerModel();
  readonly executor = new FakeExecutorModel();
  readonly repair = new FakeRepairModel();
  readonly validatorResults: ToolResult[] = [validatorPassResult()];
  readonly criticResults: ToolResult[] = [criticAcceptResult()];
  readonly validatorArgs: ValidateDocumentArgs[] = [];
  readonly criticArgs: CriticToolArgs[] = [];
  readonly forRunCalls: CreateModelAdaptersInput[] = [];

  private readonly validatorTool: ValidateToolLike = {
    run: async (args: ValidateDocumentArgs): Promise<ToolResult> => {
      this.validatorArgs.push(args);
      return nextFrom(this.validatorResults);
    },
  };

  private readonly criticTool: CriticToolLike = {
    run: async (args: CriticToolArgs): Promise<ToolResult> => {
      this.criticArgs.push(args);
      return nextFrom(this.criticResults);
    },
  };

  async forRun(input: CreateModelAdaptersInput): Promise<RunModelAdapters> {
    this.forRunCalls.push(input);
    return {
      planner: this.planner,
      executor: this.executor,
      repair: this.repair,
      criticModel: THROWING_CRITIC_MODEL,
      criticTool: this.criticTool,
      validator: this.validatorTool,
    };
  }
}

// ---------------------------------------------------------------------------
// §6.2 ToolContext bundle — fake tools, catalog, snapshot + preview seams
// ---------------------------------------------------------------------------

const FAKE_TOOLS: ReadonlyArray<{ name: string; description: string }> = [
  { name: "template_apply", description: "Instantiate a template onto the document (§6 row 4)." },
  { name: "template_fill", description: "Fill template slots with text and assets (§6 row 5)." },
  { name: "text_set", description: "Set the text of a type layer (§6 row 8)." },
  { name: "style_apply", description: "Apply a style to a layer (§6 row 11)." },
  { name: "layout_apply", description: "Apply a layout arrangement (§6 row 12)." },
  { name: "layer_ops", description: "Non-structural layer operations (§6 row 9)." },
];

/** The §7 template catalog the planner cross-checks refs and slots against. */
export const TEMPLATE_CATALOG: TemplateCatalogLike = {
  list: async () => [
    { id: "instagram-post", version: "3", title: "Instagram post", tags: ["social"], slotCount: 3 },
  ],
  get: async (ref: string) =>
    ref === INSTAGRAM_TEMPLATE
      ? {
          id: "instagram-post",
          version: "3",
          slots: {
            headline: { kind: "text", required: true },
            subhead: { kind: "text", required: true },
            photo: { kind: "image", required: true },
          },
          layerMap: { headline: "Headline", subhead: "Subhead", photo: "Photo" },
        }
      : undefined,
};

export type FakeToolHook = (info: {
  readonly session: FakeEngineSession;
  readonly run: RunRecord;
}) => void;

export interface FakeToolRun {
  readonly name: string;
  readonly args: unknown;
}

/** Per-run bundle: records tool runs; hooks fire mid-walk (crash/cancel latches). */
export class FakeToolContextFactory implements ToolContextFactory {
  readonly bundles: CreateToolContextInput[] = [];
  readonly toolRuns: FakeToolRun[] = [];
  private readonly hooks = new Map<string, FakeToolHook>();

  constructor(
    private readonly logger: Logger,
    private readonly clock: FakeClock,
  ) {}

  /** Registers a side effect fired when the named tool RUNS (mid-walk latch). */
  hook(toolName: string, hook: FakeToolHook): void {
    this.hooks.set(toolName, hook);
  }

  async create(input: CreateToolContextInput): Promise<ToolContextBundle> {
    this.bundles.push(input);
    const session = input.session as FakeEngineSession;
    const tools: Record<string, AnyTool> = {};
    for (const def of FAKE_TOOLS) {
      tools[def.name] = {
        name: def.name,
        description: def.description,
        args: z.unknown(),
        run: async (
          _ctx: ToolContext,
          args: unknown,
          _signal: AbortSignal,
        ): Promise<ToolResult> => {
          const hook = this.hooks.get(def.name);
          if (hook !== undefined) {
            hook({ session, run: input.run });
          }
          this.toolRuns.push({ name: def.name, args });
          return {
            ok: true,
            summary: `{"tool":"${def.name}","applied":true}`,
            documentRevision: session.bump(),
          };
        },
      };
    }
    const toolContext: ToolContext = {
      engine: session.commands,
      db: {
        getDocument: async () => ({
          documentId: input.run.documentId,
          organizationId: input.run.organizationId,
          currentRevision: session.revision,
        }),
        appendCommandLog: async () => undefined,
      },
      templates: TEMPLATE_CATALOG,
      assets: {
        search: async () => [],
        get: async (assetId: string) =>
          assetId === "asset_812"
            ? {
                assetId,
                organizationId: input.run.organizationId,
                filename: "latte.png",
                mimeType: "image/png",
                storageUrl: "assets://latte.png",
              }
            : undefined,
      },
      budgets: {
        remaining: () => ({
          msRemaining: input.budget.remaining().wallClockMs,
          commandsRemaining: input.budget.remaining().toolCalls,
        }),
        charge: (usage) => {
          for (let i = 0; i < (usage.commands ?? 0); i += 1) {
            input.budget.trackToolCall();
          }
          return input.budget.exceeded() === null;
        },
      },
      workspace: {
        organizationId: input.run.organizationId,
        brandTokens: { palette: {}, fonts: [] },
      },
      logger: this.logger.child({ component: "fake-tools" }),
      now: () => new Date(this.clock.now()),
    };
    const snapshot: SnapshotLike = {
      compact: async () => ({
        summary: snapshotSummary(session.revision),
        revision: session.revision,
      }),
    };
    const preview: PreviewLike = {
      render: async () => ({ previewUrl: PREVIEW_URL, revision: session.revision }),
    };
    return {
      tools,
      manifest: FAKE_TOOLS.map((def) => ({ name: def.name, description: def.description })),
      toolContext,
      templates: TEMPLATE_CATALOG,
      snapshot,
      preview,
    };
  }
}

// ---------------------------------------------------------------------------
// Previews seam (unused by the processor — §5.1 observing rides bundle.preview)
// ---------------------------------------------------------------------------

const previews: PreviewPipelineLike = {
  async renderPreview() {
    throw new Error(
      "previews seam is not exercised by StudioRunProcessor (§5.1 observing rides bundle.preview)",
    );
  },
};

// ---------------------------------------------------------------------------
// The factory
// ---------------------------------------------------------------------------

export interface MakeFakesOptions {
  readonly runId?: string;
  readonly tier?: RunTierId;
  readonly prompt?: string;
  readonly status?: RunRecordStatus;
  readonly revisionBefore?: number;
  readonly creditsReserved?: number;
}

export interface Fakes {
  readonly deps: RunManagerDeps;
  readonly row: RunRecord;
  readonly db: FakeRunRepository;
  readonly ledger: FakeLedgerStore;
  readonly emit: EmitRecorder;
  readonly engines: FakeEngineSessions;
  readonly recovery: FakeRecovery;
  readonly cancellation: FakeCancellationSource;
  readonly models: FakeModelFactory;
  readonly tools: FakeToolContextFactory;
  readonly wal: FakeWal;
  readonly storage: FakeStorage;
  readonly checkpoints: FakeCheckpoint;
  readonly clock: FakeClock;
}

/**
 * Assembles one fully-scripted `RunManagerDeps` plus every fake handle. The
 * row is a queued standard-tier §24.1 coffee run by default; the ledger starts
 * with the §14.2 rule-1 hold so the settlement functions find it.
 */
export function makeFakes(options: MakeFakesOptions = {}): Fakes {
  const tier = options.tier ?? "standard";
  const runId = options.runId ?? "run_coffee_1";
  const reserved = options.creditsReserved ?? creditsForRun(tier);
  const baseRow: RunRecord = {
    id: runId,
    organizationId: "org_main",
    documentId: COFFEE_DOCUMENT_ID,
    userId: "user_owner",
    prompt:
      options.prompt ??
      "Coffee shop promo post, warm and cozy, headline 'Fresh roasted, every morning', sub 'Open 7–5 · Main St', use the latte photo.",
    tier,
    status: options.status ?? "queued",
    idempotencyKey: `idem_${runId}`,
    revisionBefore: options.revisionBefore ?? 41,
    creditsReserved: reserved,
    creditsCharged: 0,
    error: null,
    plan: null,
  };

  const clock = new FakeClock();
  const logger = fakeLogger();
  const db = new FakeRunRepository(baseRow);
  const ledger = new FakeLedgerStore({
    organizationId: baseRow.organizationId,
    runId,
    reserved,
  });
  const emit = new EmitRecorder();
  const engines = new FakeEngineSessions(baseRow.revisionBefore);
  const recovery = new FakeRecovery();
  const cancellation = new FakeCancellationSource();
  const models = new FakeModelFactory();
  const tools = new FakeToolContextFactory(logger, clock);
  const wal = new FakeWal();
  const storage = new FakeStorage();
  const checkpoint = new FakeCheckpoint();
  const transactions: TransactionSeams = {
    wal,
    storage,
    checkpointFor: (): ReturnType<CheckpointForRun> => checkpoint,
  };

  const deps: RunManagerDeps = {
    logger,
    db,
    ledger,
    emit: emit.emit,
    engines,
    recovery,
    cancellation,
    models,
    tools,
    previews,
    transactions,
    clock: clock.now,
  };

  return {
    deps,
    row: db.row,
    db,
    ledger,
    emit,
    engines,
    recovery,
    cancellation,
    models,
    tools,
    wal,
    storage,
    checkpoints: checkpoint,
    clock,
  };
}

/** A §3.3 run job for the row; pass a signal to pre-abort (§3.4 wall clock). */
export function makeJob(
  fakes: Fakes,
  overrides: { signal?: AbortSignal; attempt?: number } = {},
): RunJobContext {
  return {
    jobId: `job_${fakes.row.id}`,
    payload: {
      runId: fakes.row.id,
      organizationId: fakes.row.organizationId,
      // Image tiers ride the images queue (queues.ts RUN_TIERS), never this
      // loop — the row type is the wider RunTierId, so narrow for the payload.
      tier: fakes.row.tier as RunTier,
    },
    attempt: overrides.attempt ?? 1,
    signal: overrides.signal ?? new AbortController().signal,
  };
}
