/**
 * apply-harness (M5-L) — the failure-injection harness for the client apply
 * engine (`@/lib/chat/apply`), BUILD_PLAN §M5 task 8 ("Failure injection …
 * → rollback/no charge"; exit criterion "A failed step never leaves a
 * partial edit").
 *
 * Everything REAL except the seams apply.ts itself consumes as ports:
 *   REAL  the fake EDITOR ENGINE (`@studio/editor-bridge/fake`) — `engine.batch`
 *         runs the real batch semantics (step execution, `$N.key` refs, atomic
 *         rollback, ONE folded undo step) and the real upstream error strings
 *         ("unknown command …", "nothing to undo", "…can't run inside a batch"),
 *   REAL  `attachFakeBridge` (the same zod-validating adapter production code
 *         talks to — including the genuine `dispose()` → EDITOR_DISCONNECTED
 *         vocabulary) + `createApplyController` (the controller under attack),
 *   FAKE  only the ports: `ApplyAutosavePort` (scripted `saveNow` outcomes) and
 *         `ApplyApiClient` (scripted `applyRun`/`undoRun` failures). No network,
 *         no DOM, deterministic microtask-orderable flow.
 *
 * Fault vocabulary (all three layers of the §M5 failure list are injectable):
 *   - ENGINE poisons: `failOn` (fake editor: command id → rejection message —
 *     a MID-BATCH failure at step k, with the engine's own atomic rollback),
 *   - BRIDGE faults: `faults.rejectExecute/rejectQuery` (a connection-lost
 *     style `BridgeError` — codes EDITOR_DISCONNECTED / EDITOR_NOT_READY /
 *     EDITOR_LOAD_FAILED / EDITOR_TIMEOUT) and `disposeInner()` (the REAL
 *     disposed-bridge disconnect), `faults.rejectBatchAttempt(n, …)` for
 *     call-counted mid-flight failures,
 *   - WIRE scripts: `applyRunError` / `undoRunError` (409 / 402 / 429 /
 *     NETWORK_ERROR status-0 shapes) + `saveModes` (save error / conflict /
 *     not-dirty / saved — the D-6 `saveNow` seam).
 *
 * Every port records into one ordered `timeline` so tests can prove
 * "NOTHING posted to the gateway / autosave never ran" byte-exactly:
 *   `query:comp.info` → `execute:engine.batch` → `markDirty:agent-apply` →
 *   `saveNow:agent-apply` → `applyRun`.
 */

import {
  type ApplicablePlan,
  type ApplyApiClient,
  type ApplyAutosavePort,
  type ApplyEngineEvent,
  type ApplyOutcome,
  type UndoOutcome,
  createApplyController,
} from "@/lib/chat/apply";
import type { SaveOutcome } from "@/lib/editor-session";
import type { EditorBridge } from "@studio/editor-bridge";
import { attachFakeBridge, createFakeEditor } from "@studio/editor-bridge/fake";
import type { FakeEditor } from "@studio/editor-bridge/fake";

// ---------------------------------------------------------------------------
// Options + records
// ---------------------------------------------------------------------------

/** One scripted autosave answer (the D-6 `saveNow` seam). */
export type SaveMode = "saved" | "conflict" | "error" | "not-dirty";

export interface FailureHarnessOptions {
  /** Engine poison (fake `failOn`): command id → rejection message. A step carrying the id fails MID-BATCH and the engine rolls back atomically. */
  readonly failOn?: Readonly<Record<string, string>>;
  /** Per-attempt save answers (attempt i → entry i, last repeats). Default: one "saved". */
  readonly saveModes?: readonly SaveMode[];
  /** Single save answer for every attempt (overridden by `saveModes`). */
  readonly saveMode?: SaveMode;
  /** Thrown by the FIRST `applyRun` call (409 / 402 / NETWORK_ERROR …). */
  readonly applyRunError?: unknown;
  /** Thrown by the FIRST `undoRun` call. */
  readonly undoRunError?: unknown;
  /** The session port's answer for the reapply gate. Present key ⇒ the port exists; `null` ⇒ the session has no version. */
  readonly currentVersionId?: string | null;
  /** Seed the "Hello" text layer (default true). `false` ⇒ a pristine editor with an empty undo stack. */
  readonly seed?: boolean;
  /** Explicit version ids per SUCCESSFUL save (models the real autosave's identical-content dedupe when repeated). */
  readonly savedVersions?: readonly string[];
}

export interface RecordedExecuteCall {
  readonly command: string;
  readonly params: unknown;
}

export interface RecordedQueryCall {
  readonly command: string;
  readonly params: unknown;
}

export interface RecordedApplyRun {
  readonly index: number;
  readonly runId: string;
  readonly body: Record<string, unknown>;
  readonly options: { readonly idempotencyKey?: string } | undefined;
}

export interface RecordedUndoRun {
  readonly index: number;
  readonly runId: string;
  readonly body: Record<string, unknown>;
  readonly options: { readonly idempotencyKey?: string } | undefined;
}

export interface RecordedSave {
  readonly reason: string;
  readonly outcome: SaveOutcome;
}

/** A deep-comparable engine snapshot (the "editor state untouched" oracle). */
export interface EngineStateSnapshot {
  readonly layers: ReadonlyArray<{
    readonly id: number;
    readonly name: string;
    readonly opacity: unknown;
    readonly sourceText: unknown;
  }>;
  readonly undoLabels: readonly string[];
  readonly redoLabels: readonly string[];
  readonly selectedLayers: readonly number[];
  readonly dirty: boolean;
}

/** Mid-flight bridge fault control (the "connection lost" vocabulary). */
export interface BridgeFaultControl {
  /** Every (or the first `times`) `execute(command)` rejects with `error`. */
  rejectExecute(command: string, error: unknown, times?: number): void;
  /** Every (or the first `times`) `query(command)` rejects with `error`. */
  rejectQuery(command: string, error: unknown, times?: number): void;
  /** The `attempt`-th `execute("engine.batch")` rejects (1-based, call-counted). */
  rejectBatchAttempt(attempt: number, error: unknown): void;
  /** "Reconnect": drop every injected fault. */
  clear(): void;
}

export interface FailureHarness {
  readonly fake: FakeEditor;
  readonly controller: {
    apply(plan: ApplicablePlan): Promise<ApplyOutcome>;
    undo(runId: string): Promise<UndoOutcome>;
    reapply(plan: ApplicablePlan): Promise<ApplyOutcome>;
  };
  readonly faults: BridgeFaultControl;
  /** The REAL `attachFakeBridge` instance (dispose it for the genuine disconnect). */
  readonly inner: EditorBridge;
  readonly timeline: string[];
  readonly executeCalls: RecordedExecuteCall[];
  readonly queryCalls: RecordedQueryCall[];
  readonly applyCalls: RecordedApplyRun[];
  readonly undoCalls: RecordedUndoRun[];
  readonly saveReasons: string[];
  readonly markDirtyReasons: string[];
  readonly saves: RecordedSave[];
  readonly events: ApplyEngineEvent[];
  readonly api: ApplyApiClient;
  readonly autosave: ApplyAutosavePort;
  /** Deep-comparable engine state (read straight off the fake — no bridge traffic). */
  state(): EngineStateSnapshot;
  /** The genuine disposed-bridge path: later calls fail EDITOR_DISCONNECTED. */
  disposeInner(): void;
}

interface FaultEntry {
  readonly error: unknown;
  remaining: number;
}

/** Deterministic "let the world tick" — no fake timers, bounded real macrotasks. */
export async function settle(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

const FAKE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

export async function makeFailureHarness(
  options: FailureHarnessOptions = {},
): Promise<FailureHarness> {
  const fake = createFakeEditor({
    comps: [{ name: "Main" }],
    ...(options.failOn === undefined ? {} : { failOn: options.failOn }),
  });
  // Seed: layer 1 "Hello" (a text layer with transform/opacity + text/sourceText).
  // Journaled ⇒ the seeded editor HAS an undo entry; `seed: false` keeps the
  // stack empty for the nothing-to-undo injection.
  if (options.seed !== false) {
    await fake.execute("layer.newText", { text: "Hello" });
  }

  const inner = attachFakeBridge(fake);
  const timeline: string[] = [];
  const executeCalls: RecordedExecuteCall[] = [];
  const queryCalls: RecordedQueryCall[] = [];
  const applyCalls: RecordedApplyRun[] = [];
  const undoCalls: RecordedUndoRun[] = [];
  const saveReasons: string[] = [];
  const markDirtyReasons: string[] = [];
  const saves: RecordedSave[] = [];
  const events: ApplyEngineEvent[] = [];

  const executeFaults = new Map<string, FaultEntry>();
  const queryFaults = new Map<string, FaultEntry>();
  const batchFaults = new Map<number, unknown>();
  let batchAttempts = 0;

  const takeFault = (map: Map<string, FaultEntry>, command: string): unknown => {
    const entry = map.get(command);
    if (entry === undefined) return undefined;
    if (entry.remaining > 0) entry.remaining -= 1;
    if (entry.remaining > 0) return entry.error;
    map.delete(command);
    return entry.error;
  };

  const faults: BridgeFaultControl = {
    rejectExecute(command, error, times = Number.POSITIVE_INFINITY) {
      executeFaults.set(command, { error, remaining: times });
    },
    rejectQuery(command, error, times = Number.POSITIVE_INFINITY) {
      queryFaults.set(command, { error, remaining: times });
    },
    rejectBatchAttempt(attempt, error) {
      batchFaults.set(attempt, error);
    },
    clear() {
      executeFaults.clear();
      queryFaults.clear();
      batchFaults.clear();
    },
  };

  // Recorded + fault-injecting bridge wrapper (the ONLY bridge apply sees).
  const bridge: EditorBridge = {
    ...inner,
    execute: async <T>(command: string, params?: unknown): Promise<T> => {
      executeCalls.push({ command, params: structuredClone(params) });
      timeline.push(`execute:${command}`);
      if (command === "engine.batch") {
        batchAttempts += 1;
        const batchFault = batchFaults.get(batchAttempts);
        if (batchFault !== undefined) throw batchFault;
      }
      const fault = takeFault(executeFaults, command);
      if (fault !== undefined) throw fault;
      return await inner.execute<T>(command, params);
    },
    query: async <T>(command: string, params?: unknown): Promise<T> => {
      queryCalls.push({ command, params });
      timeline.push(`query:${command}`);
      const fault = takeFault(queryFaults, command);
      if (fault !== undefined) throw fault;
      return await inner.query<T>(command, params);
    },
  };

  // Scripted autosave (the D-6 saveNow seam) — reasons + outcomes recorded.
  let successfulSaves = 0;
  const saveModeAt = (attempt: number): SaveMode => {
    const script = options.saveModes;
    if (script !== undefined && script.length > 0) {
      return script[Math.min(attempt, script.length - 1)] ?? "saved";
    }
    return options.saveMode ?? "saved";
  };
  const autosave: ApplyAutosavePort = {
    saveNow: async (reason: string): Promise<SaveOutcome> => {
      timeline.push(`saveNow:${reason}`);
      saveReasons.push(reason);
      const mode = saveModeAt(saves.length);
      let outcome: SaveOutcome;
      switch (mode) {
        case "conflict":
          outcome = { saved: false, conflict: true };
          break;
        case "error":
          outcome = { saved: false, error: new Error("upload failed") };
          break;
        case "not-dirty":
          outcome = { saved: false };
          break;
        default: {
          successfulSaves += 1;
          const id =
            options.savedVersions === undefined
              ? `ver_applied_${successfulSaves}`
              : (options.savedVersions[successfulSaves - 1] ?? `ver_applied_${successfulSaves}`);
          outcome = {
            saved: true,
            version: { id, label: null, sha256: FAKE_SHA, sizeBytes: 128 },
          };
        }
      }
      saves.push({ reason, outcome });
      return outcome;
    },
    markDirty: (reason?: string) => {
      timeline.push(`markDirty:${reason ?? "unnamed"}`);
      markDirtyReasons.push(reason ?? "unnamed");
    },
  };

  // Scripted apply API — the wire (409/402/429/network) lives HERE.
  const api: ApplyApiClient = {
    runs: {
      applyRun: async (runId, body, wireOptions) => {
        timeline.push("applyRun");
        const call: RecordedApplyRun = {
          index: applyCalls.length + 1,
          runId,
          body: structuredClone(body) as Record<string, unknown>,
          options: wireOptions,
        };
        applyCalls.push(call);
        if (options.applyRunError !== undefined && call.index === 1) {
          throw options.applyRunError;
        }
        return { applied: true, versionId: body.versionId, creditsCommitted: 12 };
      },
      undoRun: async (runId, body, wireOptions) => {
        timeline.push("undoRun");
        const call: RecordedUndoRun = {
          index: undoCalls.length + 1,
          runId,
          body: structuredClone(body) as Record<string, unknown>,
          options: wireOptions,
        };
        undoCalls.push(call);
        if (options.undoRunError !== undefined && call.index === 1) {
          throw options.undoRunError;
        }
        return { undone: true };
      },
    },
  };

  const hasCurrentVersion = typeof options === "object" && "currentVersionId" in options;
  const controller = createApplyController({
    bridge,
    autosave,
    api,
    ...(hasCurrentVersion
      ? { session: { currentVersionId: () => options.currentVersionId ?? null } }
      : {}),
    onEvent: (event) => {
      events.push(event);
    },
  });

  return {
    fake,
    controller,
    faults,
    inner,
    timeline,
    executeCalls,
    queryCalls,
    applyCalls,
    undoCalls,
    saveReasons,
    markDirtyReasons,
    saves,
    events,
    api,
    autosave,
    state() {
      return {
        layers: fake.state.project.layers.map((layer) => ({
          id: layer.id,
          name: layer.name,
          opacity: layer.props["transform/opacity"]?.value ?? null,
          sourceText: layer.props["text/sourceText"]?.value ?? null,
        })),
        undoLabels: fake.state.history.undo.map((entry) => entry.label),
        redoLabels: fake.state.history.redo.map((entry) => entry.label),
        selectedLayers: [...fake.state.selectedLayers],
        dirty: fake.state.dirty,
      };
    },
    disposeInner() {
      inner.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Plan fixtures (allowlisted command ids only — the sweep asserts the engine
// never receives anything else)
// ---------------------------------------------------------------------------

/** The default plan: resolve "Hello" by name → ONE prop.set (opacity 50). */
export function dimPlan(overrides: Partial<ApplicablePlan> = {}): ApplicablePlan {
  return {
    runId: "run_1",
    compiledBatch: {
      label: "Agent: dim the headline",
      atomic: true,
      steps: [
        {
          command: "prop.set",
          params: { layer: "$request:r1", path: "transform/opacity", value: 50 },
        },
      ],
    },
    resolutionRequests: [{ requestId: "r1", layerName: "Hello", disambiguation: [] }],
    ...overrides,
  };
}

/** An arbitrary-step plan (already-resolved layer id 1, no resolution traffic). */
export function stepsPlan(
  label: string,
  steps: ReadonlyArray<{ command: string; params: Record<string, unknown> }>,
  overrides: Partial<ApplicablePlan> = {},
): ApplicablePlan {
  return {
    runId: "run_1",
    compiledBatch: { label, atomic: true, steps: [...steps] },
    ...overrides,
  };
}

/** A NON-IDEMPOTENT plan (one layer.newText) — the retry-double-apply probe. */
export function newTextPlan(text: string, overrides: Partial<ApplicablePlan> = {}): ApplicablePlan {
  return {
    runId: "run_1",
    compiledBatch: {
      label: "Agent: add a text layer",
      atomic: true,
      steps: [{ command: "layer.newText", params: { text } }],
    },
    ...overrides,
  };
}

/**
 * The mid-batch poison fixture: step 1 (prop.set) JOURNALS, step 2
 * (layer.rename) is the poisoned step, step 3 never runs. With
 * `failOn: { "layer.rename": … }` the engine fails at step 2 and rolls the
 * whole atomic batch back — "a failed step never leaves a partial edit".
 */
export function poisonedMidBatchPlan(overrides: Partial<ApplicablePlan> = {}): ApplicablePlan {
  return stepsPlan(
    "Agent: rename the headline",
    [
      { command: "prop.set", params: { layer: 1, path: "text/sourceText", value: "STEP-1" } },
      { command: "layer.rename", params: { layer: 1, name: "Renamed" } },
      { command: "prop.set", params: { layer: 1, path: "transform/opacity", value: 50 } },
    ],
    overrides,
  );
}

/** Rename a layer directly in the engine (fixture seeding, bypasses the bridge). */
export async function renameLayer(fake: FakeEditor, layerId: number, name: string): Promise<void> {
  await fake.execute("layer.rename", { layer: layerId, name });
}
