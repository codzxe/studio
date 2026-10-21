// apps/worker/tests/recovery/drill-harness.ts — shared fixtures for the W10-D
// recovery-drill suites (drill-60s / replay-consistency / resume-once-gate).
//
// Two layers meet here:
//
//   1. PROCESS layer — reuse of the W2-J spine harness (../spine/harness.js):
//      real mock-engine child processes, the real @studio/engine-client facade
//      over loopback TCP, the pinned mock contract (batch executes its steps
//      in-process, faults fire on engine.execute dispatch only, doc.open
//      synthesizes). The drills perform the same moves as infra/tests/chaos/
//      kill-engine-midrun.mjs (W9-L) — kill -9, restart on a new port,
//      doc.open, replay, inspect — as vitest assertions instead of a printed
//      operator report.
//
//   2. DECISION layer — the REAL recovery code (../../src/recovery/
//      run-recovery.ts + job-retry.ts, W6-M) driven through its structural
//      seams. The seam implementations below do the real engine work AND
//      advance a FakeClock by each step's PRODUCTION time envelope (constants
//      below), so the suites assert the §20 #13 code-path latency —
//      crash-detection polls + WAL slice read + replacement restart + replay
//      of ≤50 commands — without sleeping: fake-clock acceleration. Real
//      elapsed wall-clock is measured alongside as a sanity bound; the fake
//      clock carries the production-budget claim.
//
// Spec anchors: §20 #13 (60 s gate), §3.4 (restart, replay to checkpoint,
// resume once; queue backoff ×3), §3.3 step 7 (fail clean + refund), §5.2
// (resume budgets are hard caps), §5.6 (the command log IS the WAL; marker /
// flagged / failed rows never replay), §14.2 (idempotent `${runId}:refund`
// ledger key — the seam, not this file, owns classification).
//
// Style: TS strict, ESM, .js extensions; no `any`, no non-null assertions.

import { isEngineError } from "@studio/engine-client";
import type { BatchStepInput, EngineClient } from "@studio/engine-client";
import type {
  AttachExecutorLike,
  AttachOutcome,
  MarkFailedCleanInput,
  PoolLike,
  ReallocationRequest,
  RecoveryAttachPlan,
  RefundLike,
  RefundOutcome,
  RefundRequest,
  ReplayCommand,
  ReplacementSession,
  RunManagerLike,
  WalReadLike,
  WorkerWalEntry,
} from "../../src/recovery/run-recovery.js";
import type { MockEngineHandle, SpineInspectLike } from "../spine/harness.js";
import {
  layerNamesOf,
  layerTextsOf,
  makeEngineClient,
  rawInspect,
  spawnMockEngine,
  unwrapOutcome,
} from "../spine/harness.js";

// ---------------------------------------------------------------------------
// §20 #13 envelope — production budgets the fake clock substitutes
// ---------------------------------------------------------------------------

/** §20 #13: "recovers within 60 s or fails cleanly with a refund". */
export const DECISION_BUDGET_MS = 60_000;

/**
 * Crash-detection polls (§3.4): the supervisor's session-death poll, interval
 * × attempts before the crash is confirmed and recoverRun is even called. The
 * engine-pool owns the real interval; the drill pins that the §20 #13
 * arithmetic survives this documented envelope.
 */
export const CRASH_DETECTION_POLL_MS = 2_000;
export const CRASH_DETECTION_POLLS = 3;

/** Replacement engine process cold start (§3.4 "restart"). */
export const REPLACEMENT_COLD_START_MS = 15_000;

/**
 * One control-protocol round trip — the spine client's read budget
 * (../spine/harness.js `timeouts.readMs`). A replay batch of ≤50 commands is
 * ONE round trip: the engine applies batches in-process (mock contract).
 */
export const PROTOCOL_ROUND_TRIP_MS = 4_000;

/** Round trips the attach executor performs: doc.open + inspect + replay batch. */
export const ATTACH_ROUND_TRIPS = 3;

/** DB envelopes: commands-table slice read, failed_clean row update, refund post. */
export const WAL_SLICE_READ_MS = 2_000;
export const DB_WRITE_MS = 2_000;
export const REFUND_POST_MS = 2_000;

/**
 * §5.2 resume budget as the composition root sets it — a hard cap on replayed
 * commands (the "replay of ≤50 commands"); 51 must be refused (drill-60s ›
 * resume budget is a hard cap).
 */
export const RESUME_REPLAY_CAP = 50;

/** §5.2 standard tier = 2 credits — the W9-L drill's reservation, mirrored. */
export const TIER_CREDITS = 2;

/** Fake-clock acceleration: now() only moves when a code-path step says so. */
export class FakeClock {
  #nowMs = 0;

  nowMs(): number {
    return this.#nowMs;
  }

  advance(ms: number): void {
    if (Number.isFinite(ms) && ms > 0) {
      this.#nowMs += ms;
    }
  }
}

/** The supervisor's crash-detection polls — latency before recoverRun is called. */
export function detectCrashUnderFakeClock(clock: FakeClock): void {
  for (let i = 0; i < CRASH_DETECTION_POLLS; i += 1) {
    clock.advance(CRASH_DETECTION_POLL_MS);
  }
}

/** Resume-path decision latency: polls + WAL read + restart + 3 round trips. */
export function expectedResumeDecisionMs(): number {
  return (
    CRASH_DETECTION_POLL_MS * CRASH_DETECTION_POLLS +
    WAL_SLICE_READ_MS +
    REPLACEMENT_COLD_START_MS +
    PROTOCOL_ROUND_TRIP_MS * ATTACH_ROUND_TRIPS
  );
}

/**
 * Fail-clean decision latency for a terminal verify/refusal: polls + WAL read
 * + failed_clean row update + refund post (no engine is ever started).
 */
export function expectedFailCleanDecisionMs(): number {
  return (
    CRASH_DETECTION_POLL_MS * CRASH_DETECTION_POLLS +
    WAL_SLICE_READ_MS +
    DB_WRITE_MS +
    REFUND_POST_MS
  );
}

/**
 * Fail-clean decision latency for the resume-already-spent gate: polls + row
 * update + refund post and NOT EVEN a WAL read (§3.4: the second crash fails
 * clean immediately — no reads, no restart, no replay).
 */
export function expectedResumeExhaustedDecisionMs(): number {
  return CRASH_DETECTION_POLL_MS * CRASH_DETECTION_POLLS + DB_WRITE_MS + REFUND_POST_MS;
}

// ---------------------------------------------------------------------------
// WAL fixtures (§5.6) — rows as the worker's command-log adapter returns them
// ---------------------------------------------------------------------------

export interface WalRowSpec {
  readonly commandName: string;
  readonly params: Readonly<Record<string, unknown>>;
  /** Overrides for marker/failed rows; defaults make a replayable data row. */
  readonly revisionBefore?: number;
  readonly revisionAfter?: number;
  readonly result?: Readonly<Record<string, unknown>> | null;
  readonly flag?: string | null;
}

function walRowOf(
  documentId: string,
  seq: number,
  revisionBefore: number,
  spec: WalRowSpec,
): WorkerWalEntry {
  return {
    documentId,
    seq,
    commandName: spec.commandName,
    params: spec.params,
    revisionBefore,
    revisionAfter: spec.revisionAfter ?? revisionBefore + 1,
    result: spec.result === undefined ? {} : spec.result,
    flag: spec.flag ?? null,
  };
}

/**
 * A dense, +1-chained slice: seq 1..n, each row advancing the revision by
 * exactly one (the §5.6 monotonic counter the verifier enforces).
 */
export function chainedRows(
  documentId: string,
  baseRevision: number,
  specs: readonly WalRowSpec[],
): WorkerWalEntry[] {
  const rows: WorkerWalEntry[] = [];
  let revision = baseRevision;
  for (const [index, spec] of specs.entries()) {
    const before = spec.revisionBefore ?? revision;
    const row = walRowOf(documentId, index + 1, before, spec);
    rows.push(row);
    revision = row.revisionAfter;
  }
  return rows;
}

/** A replayable slice of `layer.new.layer` rows — the scripted long run's WAL. */
export function replayableSlice(
  documentId: string,
  baseRevision: number,
  count: number,
  layerPrefix: string,
): WorkerWalEntry[] {
  const specs: WalRowSpec[] = [];
  for (let seq = 1; seq <= count; seq += 1) {
    specs.push({
      commandName: "layer.new.layer",
      params: { name: `${layerPrefix} ${String(seq).padStart(2, "0")}` },
    });
  }
  return chainedRows(documentId, baseRevision, specs);
}

// ---------------------------------------------------------------------------
// Recording seams for recoverRun (structural, per W6-M contracts)
// ---------------------------------------------------------------------------

/** A spawned engine the drill must stop in afterAll. */
export interface SpawnedEngineHandle {
  readonly mock: MockEngineHandle;
  readonly client: EngineClient;
}

/** Spawns a healthy mock-engine + client pair on the given write root. */
export async function spawnDrillEngine(root: string): Promise<SpawnedEngineHandle> {
  const mock = await spawnMockEngine({ root });
  return { mock, client: makeEngineClient(mock.port, mock.token) };
}

/** Clocked WalReadLike: records the adapter boundary, returns the fixture slice. */
export class RecordingWalReader implements WalReadLike {
  readonly calls: { documentId: string; fromRevision: number }[] = [];

  constructor(
    private readonly rows: readonly WorkerWalEntry[],
    private readonly clock: FakeClock,
  ) {}

  async slice(documentId: string, fromRevision: number): Promise<readonly WorkerWalEntry[]> {
    this.calls.push({ documentId, fromRevision });
    this.clock.advance(WAL_SLICE_READ_MS);
    return this.rows;
  }
}

/** Clocked PoolLike: one restart envelope per reallocate; the spawn is injected. */
export class RecordingPool implements PoolLike {
  readonly calls: ReallocationRequest[] = [];

  constructor(
    private readonly clock: FakeClock,
    private readonly spawnSession: () => Promise<ReplacementSession>,
  ) {}

  async reallocate(request: ReallocationRequest): Promise<ReplacementSession> {
    this.calls.push(request);
    this.clock.advance(REPLACEMENT_COLD_START_MS);
    return this.spawnSession();
  }
}

/** Clocked RunManagerLike: §3.3 step 7 row update, recorded for assertions. */
export class RecordingRunManager implements RunManagerLike {
  readonly failedCleanCalls: MarkFailedCleanInput[] = [];

  constructor(private readonly clock: FakeClock) {}

  async markFailedClean(input: MarkFailedCleanInput): Promise<void> {
    this.failedCleanCalls.push(input);
    this.clock.advance(DB_WRITE_MS);
  }
}

/**
 * Clocked RefundLike with the §14.2 idempotency built in: the first release
 * per runId refunds the reservation; every later release is a no-op duplicate
 * (the ledger key `${runId}:refund` can never double-refund).
 */
export class FakeRefundLedger implements RefundLike {
  readonly releases: RefundRequest[] = [];
  readonly #refunded = new Map<string, number>();

  constructor(
    private readonly clock: FakeClock,
    private readonly amountReserved: number,
  ) {}

  async release(request: RefundRequest): Promise<RefundOutcome> {
    this.releases.push(request);
    this.clock.advance(REFUND_POST_MS);
    const already = this.#refunded.get(request.runId) ?? 0;
    if (already > 0) {
      return { ok: true, amountRefunded: 0, duplicate: true };
    }
    this.#refunded.set(request.runId, this.amountReserved);
    return { ok: true, amountRefunded: this.amountReserved, duplicate: false };
  }

  totalRefunded(runId: string): number {
    return this.#refunded.get(runId) ?? 0;
  }
}

/** One recorded replay decision of an AttachExecutorLike. */
export interface AttachJournalEntry {
  readonly sessionId: string;
  readonly planKind: string;
  readonly fromRevision: number;
  readonly openBaselineRevision: number;
  readonly appliedCommands: number;
}

/** The §5.6 batch steps of a WAL slice — verbatim replay inputs (§5.6). */
export function toReplaySteps(rows: readonly WorkerWalEntry[]): BatchStepInput[] {
  return rows.map((row) => ({ command: row.commandName, params: { ...row.params } }));
}

/**
 * The REAL §5.6 replay on a REAL replacement engine: doc.open the checkpoint
 * (restore base), inspect (the §3.4 inspect-first payoff), apply the VERIFIED
 * slice verbatim as one batch. Every protocol round trip advances the fake
 * clock by PROTOCOL_ROUND_TRIP_MS — the accelerated decision path.
 */
export class ProcessAttachExecutor implements AttachExecutorLike {
  readonly journal: AttachJournalEntry[] = [];

  constructor(
    private readonly clock: FakeClock,
    private readonly checkpointPath: string,
    private readonly clientOf: (sessionId: string) => EngineClient,
  ) {}

  async executePlan(
    session: ReplacementSession,
    _documentId: string,
    plan: RecoveryAttachPlan,
    commands: readonly ReplayCommand[],
  ): Promise<AttachOutcome> {
    if (plan.commandCount !== commands.length) {
      return {
        ok: false,
        code: "attach_slice_mismatch",
        message: "The verified slice and the attach plan disagree — refusing to apply",
        hint: "What was verified is what must be applied (§5.6).",
        retryable: false,
      };
    }
    const client = this.clientOf(session.sessionId);
    const opened = await client.call("doc.open", { path: this.checkpointPath }, { kind: "mutate" });
    this.clock.advance(PROTOCOL_ROUND_TRIP_MS);
    if (!opened.ok) {
      return {
        ok: false,
        code: "checkpoint_open_failed",
        message: "The replacement session could not restore the checkpoint",
        retryable: false,
      };
    }
    const baseline = await rawInspect(client);
    this.clock.advance(PROTOCOL_ROUND_TRIP_MS);
    if (plan.kind !== "replay" || commands.length === 0) {
      this.journal.push({
        sessionId: session.sessionId,
        planKind: plan.kind,
        fromRevision: plan.fromRevision,
        openBaselineRevision: baseline.revision,
        appliedCommands: 0,
      });
      return {
        ok: true,
        kind: plan.kind,
        fromRevision: plan.fromRevision,
        appliedCommands: 0,
        restoredFrom: plan.kind === "checkpoint" ? this.checkpointPath : undefined,
      };
    }
    const replayed = unwrapOutcome(await client.runBatch({ steps: toReplaySteps(commands) }));
    this.clock.advance(PROTOCOL_ROUND_TRIP_MS);
    if (replayed.failed > 0) {
      return {
        ok: false,
        code: "replay_step_failed",
        message: `The replay batch had ${replayed.failed} failed step(s) — the resume stops there`,
        hint: "A half-replayed resume is never retried (§3.4 resume once).",
        retryable: false,
      };
    }
    this.journal.push({
      sessionId: session.sessionId,
      planKind: plan.kind,
      fromRevision: plan.fromRevision,
      openBaselineRevision: baseline.revision,
      appliedCommands: replayed.completed,
    });
    return {
      ok: true,
      kind: plan.kind,
      fromRevision: plan.fromRevision,
      appliedCommands: replayed.completed,
      restoredFrom: this.checkpointPath,
    };
  }
}

/** No-engine attach executor for decision-level drives (latency-faithful). */
export class FakeAttachExecutor implements AttachExecutorLike {
  readonly calls: { sessionId: string; commandCount: number }[] = [];

  constructor(private readonly clock: FakeClock) {}

  async executePlan(
    session: ReplacementSession,
    _documentId: string,
    plan: RecoveryAttachPlan,
    commands: readonly ReplayCommand[],
  ): Promise<AttachOutcome> {
    this.calls.push({ sessionId: session.sessionId, commandCount: commands.length });
    this.clock.advance(PROTOCOL_ROUND_TRIP_MS * ATTACH_ROUND_TRIPS);
    return {
      ok: true,
      kind: plan.kind,
      fromRevision: plan.fromRevision,
      appliedCommands: commands.length,
    };
  }
}

// ---------------------------------------------------------------------------
// Process-level moves (spine-faithful)
// ---------------------------------------------------------------------------

export const DOC_WIDTH = 1080;
export const DOC_HEIGHT = 1080;

/** The committed pre-run state a checkpoint pins (§3.3 steps 3–6). */
export interface CommittedState {
  readonly name: string;
  readonly savePath: string;
  readonly docNewBaseRevision: number;
  /** Revision of the pre-run content (after the batch, before doc.save). */
  readonly preRunRevision: number;
  /** Revision measured after doc.save — the WAL chains from here. */
  readonly checkpointRevision: number;
  readonly preRunLayers: readonly string[];
  readonly preRunTexts: readonly string[];
  readonly preRunSteps: readonly BatchStepInput[];
}

export async function establishCheckpoint(
  client: EngineClient,
  options: { savePath: string; name: string; headline: string },
): Promise<CommittedState> {
  const preRunSteps: BatchStepInput[] = [
    { command: "layer.new.layer", params: { name: "Pre-run Base" } },
    { command: "type.create", params: { text: options.headline, x: 540, y: 420, size: 72 } },
  ];
  unwrapOutcome(
    await client.newDocument({ width: DOC_WIDTH, height: DOC_HEIGHT, name: options.name }),
  );
  const base = await rawInspect(client);
  const batch = unwrapOutcome(await client.runBatch({ steps: preRunSteps }));
  if (batch.failed > 0 || batch.completed !== preRunSteps.length) {
    throw new Error(`pre-run batch incomplete: ${batch.completed}/${preRunSteps.length}`);
  }
  const preRun = await rawInspect(client);
  if (preRun.revision !== base.revision + preRunSteps.length) {
    throw new Error(
      `pre-run revision advanced by ${preRun.revision - base.revision}, ` +
        `expected exactly ${preRunSteps.length} (§5.6 +1 per mutating command)`,
    );
  }
  const saved = unwrapOutcome(await client.saveDocument({ path: options.savePath }));
  if (saved.path !== options.savePath) {
    throw new Error(`doc.save replied with path ${saved.path}`);
  }
  const checkpoint = await rawInspect(client);
  return {
    name: options.name,
    savePath: options.savePath,
    docNewBaseRevision: base.revision,
    preRunRevision: preRun.revision,
    checkpointRevision: checkpoint.revision,
    preRunLayers: sortedLayerNames(preRun),
    preRunTexts: [...layerTextsOf(preRun)].sort(),
    preRunSteps,
  };
}

export interface ScriptedRunResult {
  /** The §5.6 command log of everything that ran — measured, not assumed. */
  readonly rows: readonly WorkerWalEntry[];
  readonly revisionAfterLast: number;
}

/**
 * Executes the scripted long run ONE command at a time, measuring each row's
 * revision live (+1 per mutating command, asserted) — the run's WAL as the
 * worker would have logged it. Stops after `count` commands; the drill kills
 * the engine here (the run's remaining commands never ran).
 */
export async function executeScriptedRun(
  client: EngineClient,
  options: {
    documentId: string;
    baseRevision: number;
    count: number;
    layerPrefix: string;
  },
): Promise<ScriptedRunResult> {
  const rows: WorkerWalEntry[] = [];
  let revision = options.baseRevision;
  for (let seq = 1; seq <= options.count; seq += 1) {
    const name = `${options.layerPrefix} ${String(seq).padStart(2, "0")}`;
    unwrapOutcome(
      await client.executeCommand(
        { command: "layer.new.layer", params: { name } },
        { kind: "mutate" },
      ),
    );
    const after = await rawInspect(client);
    if (after.revision !== revision + 1) {
      throw new Error(
        `scripted run step ${seq}: revision ${revision}→${after.revision}, expected exactly +1`,
      );
    }
    rows.push({
      documentId: options.documentId,
      seq,
      commandName: "layer.new.layer",
      params: { name },
      revisionBefore: revision,
      revisionAfter: after.revision,
      result: {},
      flag: null,
    });
    revision = after.revision;
  }
  return { rows, revisionAfterLast: revision };
}

/**
 * kill -9 the engine mid-run — the §21 chaos move (infra/tests/chaos/
 * kill-engine-midrun.mjs does the same at step 3 of its scripted run).
 */
export async function killNine(mock: MockEngineHandle): Promise<{
  code: number | null;
  signal: string | null;
}> {
  mock.child.kill("SIGKILL");
  return mock.exited;
}

/**
 * One mutating command against the dead engine: the client must surface a
 * typed engine error (the spine's §3.4 envelope contract) — never a silent
 * success, never a thrown string.
 */
export async function mutatingCallAgainstDeadEngine(client: EngineClient): Promise<void> {
  const outcome = await client.executeCommand(
    { command: "layer.new.layer", params: { name: "Post-mortem Probe" } },
    { kind: "mutate" },
  );
  if (outcome.ok) {
    throw new Error("a mutating command succeeded against a killed engine — the kill did not land");
  }
  if (!isEngineError(outcome)) {
    throw new Error("the dead-engine call did not surface a typed engine envelope");
  }
}

export const sortedLayerNames = (inspect: SpineInspectLike): string[] =>
  [...layerNamesOf(inspect)].sort();

export const sortedLayerTexts = (inspect: SpineInspectLike): string[] =>
  [...layerTextsOf(inspect)].sort();

/**
 * The §3.4 rollback proof: replay ONLY the committed (pre-run) WAL on a fresh
 * engine — the W9-L drill's engine#3 move — and inspect the result. The
 * returned revision delta must reproduce the original advancement exactly.
 */
export async function replayCommittedPreRunState(
  client: EngineClient,
  committed: CommittedState,
): Promise<{
  docNewBaseRevision: number;
  revision: number;
  layers: readonly string[];
  texts: readonly string[];
}> {
  unwrapOutcome(
    await client.newDocument({
      width: DOC_WIDTH,
      height: DOC_HEIGHT,
      name: `${committed.name} (rollback replay)`,
    }),
  );
  const base = await rawInspect(client);
  const batch = unwrapOutcome(await client.runBatch({ steps: [...committed.preRunSteps] }));
  if (batch.failed > 0) {
    throw new Error("the committed pre-run WAL failed to replay on a fresh engine");
  }
  const after = await rawInspect(client);
  return {
    docNewBaseRevision: base.revision,
    revision: after.revision,
    layers: sortedLayerNames(after),
    texts: sortedLayerTexts(after),
  };
}
