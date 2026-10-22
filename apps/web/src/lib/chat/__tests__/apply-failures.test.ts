/**
 * M5-L — the WEB failure-injection suite for the client apply engine
 * (BUILD_PLAN §M5 task 8: "Failure injection: invalid command, mid-batch
 * failure, editor disconnect, version conflict, zero credits → rollback/no
 * charge"; exit criterion: "A failed step never leaves a partial edit").
 *
 * The controller under attack is `@/lib/chat/apply` (`createApplyController`)
 * and ITS outcome types are the oracle. Vocabulary note: the task brief's
 * "engine-rejected" is apply.ts's pinned `reason: "engine-failed"` arm; the
 * "typed disconnect outcome" is `reason: "editor-disconnected"`; the
 * explain-copy contracts below are asserted VERBATIM against apply.ts.
 *
 * What each injection proves (the M5 safety invariant, client-side half):
 *   1 invalid command    → the bridge execute REJECTS → typed engine-failed;
 *     NOTHING posts to the gateway, `saveNow` is never called, the editor
 *     state is untouched (the client never saves/persists a bad state — the
 *     engine's atomic rollback is its own guarantee, asserted here through
 *     the real fake engine).
 *   2 mid-batch failure  → a poisoned step k fails INSIDE engine.batch →
 *     the engine rolls back atomically → same client guarantees; every
 *     surfaced error is a typed, stack-free line (law #1).
 *   3 editor disconnect  → the bridge rejects with the connection-lost
 *     vocabulary (real `dispose()` + all four disconnect codes) → typed
 *     editor-disconnected; no autosave, no POST; a reconnect NEVER
 *     auto-replays the batch — only a fresh user gesture re-executes.
 *   4 version conflict   → applyRun 409 → conflict with the explain copy;
 *     the local editor keeps the applied batch; no re-execution happens
 *     without a fresh gesture (ticks prove no auto-retry) and `reapply` is
 *     blocked by the §M5.5 base-version gate.
 *   5 zero credits       → applyRun 402 → insufficient-credits; the edit +
 *     version ARE saved (money moved nowhere); no crash — the controller
 *     keeps processing gestures.
 *   6 saveNow failure    → a successful engine.batch whose version upload
 *     fails → save-failed/save-conflict; NO applyRun (the gateway never
 *     hears "applied" without a persisted version); the divergence (engine
 *     applied, version not) is SURFACED honestly — pinned + judged below.
 *   7 post-save network  → applyRun NETWORK_ERROR after saveNow succeeded →
 *     typed failed; exactly ONE POST per gesture (no client auto-retry).
 *     PIN + FINDING: the gesture's idempotencyKey is NOT retained — a retry
 *     gesture posts a FRESH key (the task expected reuse; see the worklog
 *     M5-L record + the header of this test group).
 *   8 undo failures      → nothing-to-undo / engine failure → NO undoRun
 *     POST; undoRun 409 / network → typed outcomes with the local undo's
 *     divergence surfaced honestly.
 *   9 panic sweep        → the M4-N corpus, dunder ids, 100k strings, deep
 *     nesting: the controller never throws (every outcome typed), never
 *     writes Object.prototype, and never sends engine.batch a step whose id
 *     is outside @studio/contracts AGENT_COMMAND_IDS.
 *
 * Boundary-law note (deliberate, documented deviation): this TEST file
 * runtime-imports `AGENT_COMMAND_IDS` from `@studio/contracts` because the
 * M5-L task explicitly mandates asserting against it. The apps/web boundary
 * law ("@studio/contracts is import type ONLY", provider.tsx) governs
 * PRODUCT modules — tests are never bundled, and @studio/contracts is
 * already in web's runtime graph transitively (@studio/api-client imports
 * its zod schemas). No src/ module gains a runtime import from this file.
 *
 * Deterministic, jsdom, no network. Real fake engine (`engine.batch` atomic
 * semantics + upstream error strings), real attachFakeBridge adapter, real
 * createApplyController; only the autosave/api ports are scripted.
 */

import { ApiError, networkError } from "@studio/api-client";
import { AGENT_COMMAND_IDS } from "@studio/contracts";
import { BridgeError } from "@studio/editor-bridge";
import { describe, expect, it } from "vitest";

import type { ApplicablePlan, ApplyOutcome, UndoOutcome } from "@/lib/chat/apply";
import { ALL_TEXT_FIXTURES } from "./injection-corpus";
import {
  dimPlan,
  makeFailureHarness,
  newTextPlan,
  poisonedMidBatchPlan,
  renameLayer,
  settle,
  stepsPlan,
  type FailureHarness,
  type RecordedExecuteCall,
} from "./apply-harness";

// ---------------------------------------------------------------------------
// Suite-wide helpers
// ---------------------------------------------------------------------------

/** Every step command the engine was asked to execute through engine.batch. */
function executedStepCommands(calls: readonly RecordedExecuteCall[]): string[] {
  const out: string[] = [];
  for (const call of calls) {
    if (call.command !== "engine.batch") continue;
    const params = call.params as { steps?: ReadonlyArray<{ command?: unknown }> };
    for (const step of params.steps ?? []) {
      if (typeof step?.command === "string") out.push(step.command);
    }
  }
  return out;
}

/** Task 9: the engine never sees a non-allowlisted command id. */
function expectAllCommandsAllowlisted(harness: FailureHarness): void {
  for (const command of executedStepCommands(harness.executeCalls)) {
    expect(AGENT_COMMAND_IDS, `engine.batch carried non-allowlisted id "${command}"`).toContain(
      command,
    );
  }
}

/** Task 9: no injection ever reached Object.prototype. */
function expectPrototypeClean(): void {
  for (const key of ["polluted", "r1", "ghost", "layer", "value", "steps"]) {
    expect(Object.hasOwn(Object.prototype, key), `Object.prototype.${key} was polluted`).toBe(
      false,
    );
    expect(({} as Record<string, unknown>)[key], `{} .${key} leaked`).toBeUndefined();
  }
  // Dunder survival check: the intrinsics themselves stay intact.
  expect(Object.prototype.toString.call({})).toBe("[object Object]");
  expect(typeof Object.prototype.constructor).toBe("function");
}

/** The pinned failure vocabulary (apply.ts ApplyOutcome/UndoOutcome unions). */
const FAILURE_REASONS: ReadonlySet<string> = new Set([
  "ambiguous",
  "not-found",
  "resolution-failed",
  "invalid-batch",
  "engine-failed",
  "editor-disconnected",
  "save-failed",
  "save-conflict",
  "conflict",
  "insufficient-credits",
  "base-version-changed",
  "failed",
  "nothing-to-undo",
]);

/** Law #1: an outcome message is a safe, stack-free, path-free single line. */
function expectMessageHygienic(message: string, label: string): void {
  expect(typeof message, `${label}: message must be a string`).toBe("string");
  expect(message.length, `${label}: message must be non-empty`).toBeGreaterThan(0);
  expect(message.length, `${label}: message must be bounded`).toBeLessThan(5_000);
  expect(message, `${label}: no newlines/stack frames`).not.toMatch(/\n/);
  expect(message, `${label}: no stack frames`).not.toMatch(/\s+at\s/);
  expect(message, `${label}: no absolute paths`).not.toMatch(/\/home\//);
  expect(message, `${label}: no node internals`).not.toMatch(/node:/);
}

const BATCH_LABEL = "Agent: dim the headline";

// ---------------------------------------------------------------------------
// 1. Invalid command in the compiled batch → the engine REJECTS
// ---------------------------------------------------------------------------

describe("M5-L · engine rejects the compiled batch", () => {
  it("unknown command id → engine-failed (the brief's 'engine-rejected'); NOTHING posts/saves; editor untouched", async () => {
    const harness = await makeFailureHarness();
    const before = harness.state();

    const outcome = await harness.controller.apply(
      stepsPlan("Agent: bad command", [{ command: "layer.explode", params: { bang: true } }]),
    );

    expect(outcome).toMatchObject({ ok: false, reason: "engine-failed" });
    if (!outcome.ok) expectMessageHygienic(outcome.message, "unknown command");
    if (!outcome.ok) expect(outcome.message).toContain("unknown command");

    // The gateway never hears "applied"; autosave never runs; nothing is dirty.
    expect(harness.applyCalls).toHaveLength(0);
    expect(harness.saveReasons).toHaveLength(0);
    expect(harness.markDirtyReasons).toHaveLength(0);
    expect(harness.timeline).toEqual(["execute:engine.batch"]);

    // The engine's atomic rollback left NO partial edit (exit criterion).
    expect(harness.state()).toEqual(before);
    // The client never re-executes on its own (fresh gesture required).
    await settle();
    expect(harness.executeCalls).toHaveLength(1);

    expect(harness.events.map((event) => event.type)).toEqual(["apply.started", "apply.failed"]);
    // Not a curated id: the allowlist agrees with the engine.
    expect(AGENT_COMMAND_IDS).not.toContain("layer.explode");
  });

  it("hostile/dunder command ids (__proto__.pollute, constructor, nested engine.batch) → engine-failed each; never allowlisted", async () => {
    for (const command of ["__proto__.pollute", "constructor", "engine.batch"]) {
      const harness = await makeFailureHarness();
      const before = harness.state();
      const outcome = await harness.controller.apply(
        stepsPlan("Agent: hostile id", [{ command, params: {} }]),
      );

      expect(outcome, `command "${command}"`).toMatchObject({ ok: false, reason: "engine-failed" });
      // Nested engine.batch is the NOT_IN_BATCH rule ("can't run inside a batch").
      if (!outcome.ok && command === "engine.batch") {
        expect(outcome.message).toContain("inside a batch");
      }
      expect(harness.applyCalls).toHaveLength(0);
      expect(harness.saveReasons).toHaveLength(0);
      expect(harness.state()).toEqual(before);
      expectPrototypeClean();
      if (command !== "engine.batch") {
        // engine.batch is a META id (never batchable, never curated).
        expect(AGENT_COMMAND_IDS).not.toContain(command);
      }
    }
  });

  it("engine rejects bad step params (unknown property) → engine-failed; state untouched", async () => {
    const harness = await makeFailureHarness();
    const before = harness.state();
    const outcome = await harness.controller.apply(
      stepsPlan("Agent: bad params", [
        { command: "prop.set", params: { layer: 1, path: "bogus/path", value: 1 } },
      ]),
    );

    expect(outcome).toMatchObject({ ok: false, reason: "engine-failed" });
    if (!outcome.ok) {
      expect(outcome.message).toContain("no property");
      expectMessageHygienic(outcome.message, "bad params");
    }
    expect(harness.applyCalls).toHaveLength(0);
    expect(harness.saveReasons).toHaveLength(0);
    expect(harness.state()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// 2. Mid-batch failure (poisoned step k)
// ---------------------------------------------------------------------------

describe("M5-L · mid-batch failure (poisoned step k)", () => {
  it("step 2 of 3 fails → engine-failed; the atomic rollback leaves NO partial edit; no saveNow, no applyRun", async () => {
    const harness = await makeFailureHarness({
      failOn: { "layer.rename": "invalid parameters for `layer.rename`: the name is not allowed" },
    });
    const before = harness.state();

    const outcome = await harness.controller.apply(poisonedMidBatchPlan());

    expect(outcome).toMatchObject({ ok: false, reason: "engine-failed" });
    if (!outcome.ok) {
      // Step 1 (a journaled prop.set) ran, step 2 (layer.rename) failed — the
      // engine names the step and reports the rollback (upstream batch.rs).
      expect(outcome.message).toContain("step 2");
      expect(outcome.message).toContain("layer.rename");
      expect(outcome.message).toContain("rolled back");
      expectMessageHygienic(outcome.message, "mid-batch");
    }

    // Step 1's edit was rolled back with the whole batch: sourceText still
    // "Hello", no rename, no opacity change, no undo entry, dirty unchanged.
    expect(harness.state()).toEqual(before);
    expect(harness.state().undoLabels).not.toContain("Agent: rename the headline");

    // The client never persists a bad state: no saveNow, no gateway POST.
    expect(harness.saveReasons).toHaveLength(0);
    expect(harness.applyCalls).toHaveLength(0);
    expect(harness.markDirtyReasons).toHaveLength(0);
    expect(harness.timeline).toEqual(["execute:engine.batch"]);
    expect(harness.events.map((event) => event.type)).toEqual(["apply.started", "apply.failed"]);
  });

  it("a call-counted bridge fault (2nd engine.batch rejects mid-flight) is a typed engine failure too", async () => {
    const harness = await makeFailureHarness();
    harness.faults.rejectBatchAttempt(
      2,
      new BridgeError("EDITOR_CALL_FAILED", "execute engine.batch: connection reset mid-batch"),
    );

    const first = await harness.controller.apply(dimPlan());
    expect(first.ok).toBe(true);
    const before = harness.state();

    const second = await harness.controller.apply(stepsPlan("Agent: second", [
      { command: "prop.set", params: { layer: 1, path: "transform/opacity", value: 20 } },
    ]));
    expect(second).toMatchObject({ ok: false, reason: "engine-failed" });
    expect(harness.applyCalls).toHaveLength(1); // only the FIRST gesture posted
    expect(harness.saveReasons).toHaveLength(1); // only the FIRST gesture saved
    expect(harness.state()).toEqual(before); // the 2nd batch left nothing behind
  });
});

// ---------------------------------------------------------------------------
// 3. Editor disconnect (the connection-lost vocabulary)
// ---------------------------------------------------------------------------

const DISCONNECT_CODES = [
  "EDITOR_DISCONNECTED",
  "EDITOR_NOT_READY",
  "EDITOR_LOAD_FAILED",
  "EDITOR_TIMEOUT",
] as const;

describe("M5-L · editor disconnect", () => {
  it("real bridge dispose → engine.batch fails EDITOR_DISCONNECTED → typed editor-disconnected; no autosave, no POST", async () => {
    const harness = await makeFailureHarness();
    harness.disposeInner(); // the genuine attachFake disposed-bridge path

    const outcome = await harness.controller.apply(
      stepsPlan(BATCH_LABEL, [
        { command: "prop.set", params: { layer: 1, path: "transform/opacity", value: 50 } },
      ]),
    );

    expect(outcome).toMatchObject({ ok: false, reason: "editor-disconnected" });
    if (!outcome.ok) expect(outcome.message).toContain("disposed");
    expect(harness.saveReasons).toHaveLength(0);
    expect(harness.applyCalls).toHaveLength(0);
    expect(harness.markDirtyReasons).toHaveLength(0);
    expect(harness.timeline).toEqual(["execute:engine.batch"]);
    expect(harness.events.map((event) => event.type)).toEqual(["apply.started", "apply.failed"]);
  });

  it.each(DISCONNECT_CODES)("bridge code %s on engine.batch → editor-disconnected", async (code) => {
    const harness = await makeFailureHarness();
    harness.faults.rejectExecute(
      "engine.batch",
      new BridgeError(code, `execute engine.batch: simulated ${code}`),
    );

    const outcome = await harness.controller.apply(
      stepsPlan(BATCH_LABEL, [
        { command: "prop.set", params: { layer: 1, path: "transform/opacity", value: 50 } },
      ]),
    );

    expect(outcome).toMatchObject({ ok: false, reason: "editor-disconnected" });
    expect(harness.saveReasons).toHaveLength(0);
    expect(harness.applyCalls).toHaveLength(0);
  });

  it("EDITOR_CALL_FAILED stays engine-failed (vocabulary precision — only disconnect codes are disconnects)", async () => {
    const harness = await makeFailureHarness();
    harness.faults.rejectExecute(
      "engine.batch",
      new BridgeError("EDITOR_CALL_FAILED", "execute engine.batch: command failed"),
    );
    const outcome = await harness.controller.apply(
      stepsPlan(BATCH_LABEL, [
        { command: "prop.set", params: { layer: 1, path: "transform/opacity", value: 50 } },
      ]),
    );
    expect(outcome).toMatchObject({ ok: false, reason: "engine-failed" });
    expect(harness.applyCalls).toHaveLength(0);
  });

  it("disconnect during layer RESOLUTION → editor-disconnected BEFORE any engine call", async () => {
    const harness = await makeFailureHarness();
    harness.faults.rejectQuery(
      "comp.info",
      new BridgeError("EDITOR_DISCONNECTED", "query comp.info: bridge is disposed"),
    );

    const outcome = await harness.controller.apply(dimPlan());

    expect(outcome).toMatchObject({ ok: false, reason: "editor-disconnected" });
    // Zero engine.batch attempts — the batch was never even tried.
    expect(
      harness.executeCalls.filter((call) => call.command === "engine.batch"),
    ).toHaveLength(0);
    expect(harness.saveReasons).toHaveLength(0);
    expect(harness.applyCalls).toHaveLength(0);
    expect(harness.timeline).toEqual(["query:comp.info"]);

    // Contrast: a non-disconnect resolution failure is "resolution-failed".
    const other = await makeFailureHarness();
    other.faults.rejectQuery(
      "comp.info",
      new BridgeError("EDITOR_CALL_FAILED", "query comp.info: boom"),
    );
    const otherOutcome = await other.controller.apply(dimPlan());
    expect(otherOutcome).toMatchObject({ ok: false, reason: "resolution-failed" });
    expect(other.executeCalls).toHaveLength(0);
  });

  it("RECONNECT never auto-replays: ticks change nothing; only a fresh gesture re-executes", async () => {
    const harness = await makeFailureHarness();
    harness.faults.rejectExecute(
      "engine.batch",
      new BridgeError("EDITOR_DISCONNECTED", "execute engine.batch: bridge is disposed"),
      1,
    );
    const first = await harness.controller.apply(dimPlan());
    expect(first).toMatchObject({ ok: false, reason: "editor-disconnected" });

    harness.faults.clear(); // the editor "reconnects"
    await settle(12); // macrotasks + microtasks — no replay may ever fire
    expect(harness.executeCalls).toHaveLength(1);
    expect(harness.saveReasons).toHaveLength(0);
    expect(harness.applyCalls).toHaveLength(0);

    // A FRESH user gesture is the only thing that re-executes — and it works.
    const second = await harness.controller.apply(dimPlan());
    expect(second).toMatchObject({ ok: true, versionId: "ver_applied_1" });
    expect(harness.executeCalls).toHaveLength(2);
    expect(harness.saveReasons).toEqual(["agent-apply"]);
    expect(harness.applyCalls).toHaveLength(1);
    expect(harness.events.map((event) => event.type)).toEqual([
      "apply.started",
      "apply.resolved",
      "apply.failed",
      "apply.started",
      "apply.resolved",
      "apply.completed",
    ]);
  });

  it("undo across a disconnect → typed editor-disconnected; no undoRun POST", async () => {
    const harness = await makeFailureHarness();
    const applied = await harness.controller.apply(dimPlan());
    expect(applied.ok).toBe(true);

    harness.faults.rejectExecute(
      "edit.undo",
      new BridgeError("EDITOR_DISCONNECTED", "execute edit.undo: bridge is disposed"),
    );
    const outcome = await harness.controller.undo("run_1");

    expect(outcome).toMatchObject({ ok: false, reason: "editor-disconnected" });
    expect(harness.undoCalls).toHaveLength(0);
    // The engine still holds the applied batch (nothing popped).
    expect(harness.state().undoLabels).toContain(BATCH_LABEL);
    expect(harness.events.map((event) => event.type)).toEqual([
      "apply.started",
      "apply.resolved",
      "apply.completed",
      "undo.started",
      "undo.failed",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. Version conflict (gateway 409)
// ---------------------------------------------------------------------------

describe("M5-L · version conflict (applyRun 409)", () => {
  it("409 → {ok:false, reason:'conflict'} with the explain copy; the local editor keeps the applied batch", async () => {
    const harness = await makeFailureHarness({
      applyRunError: new ApiError({
        code: "RUN_ALREADY_APPLIED",
        message: "This run's plan was already applied.",
        status: 409,
        hint: "Undo it first, or start a new run to apply again.",
      }),
    });

    const outcome = await harness.controller.apply(dimPlan());

    expect(outcome).toMatchObject({ ok: false, reason: "conflict" });
    if (!outcome.ok) {
      expect(outcome.message).toBe(
        "This plan was already applied or the run changed on the server. Nothing was re-executed.",
      );
    }

    // The gesture DID execute + save (one engine.batch, one version upload),
    // and exactly ONE POST happened — the 409 is the server's answer to it.
    expect(harness.applyCalls).toHaveLength(1);
    expect(harness.saveReasons).toEqual(["agent-apply"]);
    // The LOCAL editor keeps the applied batch state honest.
    expect(harness.state().undoLabels).toContain(BATCH_LABEL);
    expect(harness.state().layers[0]?.opacity).toBe(50);
    expect(harness.timeline).toEqual([
      "query:comp.info",
      "execute:engine.batch",
      "markDirty:agent-apply",
      "saveNow:agent-apply",
      "applyRun",
    ]);
  });

  it("after the 409: no automatic re-execution (ticks), and reapply is BLOCKED by the base-version gate", async () => {
    const harness = await makeFailureHarness({
      applyRunError: new ApiError({
        code: "RUN_ALREADY_APPLIED",
        message: "This run's plan was already applied.",
        status: 409,
      }),
      // The session advanced past the plan's base when saveNow landed.
      currentVersionId: "ver_applied_1",
    });
    const conflict = await harness.controller.apply(dimPlan());
    expect(conflict).toMatchObject({ ok: false, reason: "conflict" });

    await settle(12); // nothing may re-run on its own
    expect(
      harness.executeCalls.filter((call) => call.command === "engine.batch"),
    ).toHaveLength(1);
    expect(harness.applyCalls).toHaveLength(1);

    // A reapply "retry" (the card's Re-apply) is gated: base ≠ current.
    const reapply = await harness.controller.reapply(dimPlan({ baseVersionId: "ver_base" }));
    expect(reapply).toMatchObject({ ok: false, reason: "base-version-changed" });
    if (!reapply.ok) {
      expect(reapply.message).toBe(
        "The project changed since this plan was made, so re-applying it is not safe. Ask the agent to plan again.",
      );
    }
    // Still exactly ONE engine execution and ONE POST — no double-apply.
    expect(
      harness.executeCalls.filter((call) => call.command === "engine.batch"),
    ).toHaveLength(1);
    expect(harness.applyCalls).toHaveLength(1);
    expect(harness.events.at(-1)?.type).toBe("apply.failed");
  });
});

// ---------------------------------------------------------------------------
// 5. Zero credits (gateway 402)
// ---------------------------------------------------------------------------

describe("M5-L · zero credits (applyRun 402)", () => {
  it("402 → {ok:false, reason:'insufficient-credits'}; the edit + version ARE saved; no crash", async () => {
    const harness = await makeFailureHarness({
      applyRunError: new ApiError({
        code: "INSUFFICIENT_CREDITS",
        message: "You need more credits to commit this run.",
        status: 402,
      }),
    });

    const outcome = await harness.controller.apply(dimPlan());

    expect(outcome).toMatchObject({ ok: false, reason: "insufficient-credits" });
    if (!outcome.ok) {
      expect(outcome.message).toBe(
        "The edit and its version are saved, but there were not enough credits to commit this run.",
      );
      expectMessageHygienic(outcome.message, "402");
    }

    // The 402 arrives AFTER the save: the edit and the version landed first.
    expect(harness.timeline).toEqual([
      "query:comp.info",
      "execute:engine.batch",
      "markDirty:agent-apply",
      "saveNow:agent-apply",
      "applyRun",
    ]);
    expect(harness.state().undoLabels).toContain(BATCH_LABEL);
    expect(harness.applyCalls).toHaveLength(1); // exactly one charge attempt
  });

  it("the controller keeps working after a 402 (composer/chat stay usable)", async () => {
    const harness = await makeFailureHarness({
      applyRunError: new ApiError({
        code: "INSUFFICIENT_CREDITS",
        message: "You need more credits to commit this run.",
        status: 402,
      }),
    });
    const broke = await harness.controller.apply(dimPlan());
    expect(broke).toMatchObject({ ok: false, reason: "insufficient-credits" });

    // A fresh gesture on a NEW plan still runs end-to-end…
    const next = await harness.controller.apply(
      stepsPlan(
        "Agent: second edit",
        [{ command: "prop.set", params: { layer: 1, path: "transform/opacity", value: 20 } }],
        { runId: "run_2" },
      ),
    );
    expect(next).toMatchObject({ ok: true, versionId: "ver_applied_2" });

    // …and undo still works through the same controller.
    const undone = await harness.controller.undo("run_2");
    expect(undone).toEqual({ ok: true, undone: true });
    expect(harness.undoCalls[0]?.runId).toBe("run_2");

    expect(harness.events.map((event) => event.type)).toEqual([
      "apply.started",
      "apply.resolved",
      "apply.failed",
      "apply.started",
      "apply.completed",
      "undo.started",
      "undo.completed",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 6. saveNow failure AFTER a successful engine.batch — THE DIVERGENCE PIN
//    (FINDING, worklog M5-L): the controller surfaces it honestly ("It is in
//    the editor only") and never tells the gateway — but a fresh "Try again"
//    gesture re-executes the batch on the already-applied engine state, so a
//    non-idempotent plan DOUBLES locally (pinned below).
// ---------------------------------------------------------------------------

describe("M5-L · saveNow failure after a successful engine.batch", () => {
  it("save error → save-failed; NO applyRun (no 'applied' without a persisted version); the engine state IS applied (divergence surfaced, not silent)", async () => {
    const harness = await makeFailureHarness({ saveMode: "error" });

    const outcome = await harness.controller.apply(dimPlan());

    expect(outcome).toMatchObject({ ok: false, reason: "save-failed" });
    if (!outcome.ok) {
      expect(outcome.message).toBe(
        "The edit was applied but could not be saved as a version. It is in the editor only.",
      );
    }

    // The engine DID apply the batch (the editor content stays live)…
    expect(harness.state().undoLabels).toContain(BATCH_LABEL);
    expect(harness.state().layers[0]?.opacity).toBe(50);
    expect(harness.state().dirty).toBe(true);
    // …but the gateway was NEVER told "applied" (no version → no report).
    expect(harness.applyCalls).toHaveLength(0);
    expect(harness.saveReasons).toEqual(["agent-apply"]); // the save was attempted
    expect(harness.markDirtyReasons).toEqual(["agent-apply"]);
    expect(harness.timeline).toEqual([
      "query:comp.info",
      "execute:engine.batch",
      "markDirty:agent-apply",
      "saveNow:agent-apply",
    ]);
  });

  it("parked-conflict save → save-conflict with the reload copy; engine applied; no applyRun", async () => {
    const harness = await makeFailureHarness({ saveMode: "conflict" });

    const outcome = await harness.controller.apply(dimPlan());

    expect(outcome).toMatchObject({ ok: false, reason: "save-conflict" });
    if (!outcome.ok) {
      expect(outcome.message).toBe(
        "The project changed elsewhere while the agent was working. Reload the latest version to continue — the edit is in the editor only.",
      );
    }
    expect(harness.state().undoLabels).toContain(BATCH_LABEL);
    expect(harness.applyCalls).toHaveLength(0);
  });

  it("RETRY HAZARD (pin + finding): after save-failed, a fresh 'Try again' gesture RE-EXECUTES the batch — a non-idempotent plan (layer.newText) DOUBLES locally", async () => {
    const harness = await makeFailureHarness({ saveModes: ["error", "saved"] });

    const first = await harness.controller.apply(newTextPlan("Dup"));
    expect(first).toMatchObject({ ok: false, reason: "save-failed" });
    expect(harness.state().layers).toHaveLength(2); // seed + first "Dup"

    // The plan card's failed state offers "Try again" — a fresh gesture.
    const second = await harness.controller.apply(newTextPlan("Dup"));
    expect(second).toMatchObject({ ok: true });

    // The engine re-executed the SAME batch: the text layer now exists TWICE.
    expect(
      harness.executeCalls.filter((call) => call.command === "engine.batch"),
    ).toHaveLength(2);
    expect(harness.state().layers).toHaveLength(3);
    expect(harness.state().layers.filter((layer) => layer.name.startsWith("Dup"))).toHaveLength(2);
    // …and the undo stack holds TWO entries for one logical edit.
    expect(harness.state().undoLabels.filter((label) => label === "Agent: add a text layer")).toHaveLength(
      2,
    );
    expectAllCommandsAllowlisted(harness);
  });
});

// ---------------------------------------------------------------------------
// 7. applyRun network failure AFTER saveNow succeeded
//    (FINDING, worklog M5-L): the brief expected the client to REUSE the
//    gesture's idempotencyKey on the retry — the landed controller has no
//    retry path and no key retention: each gesture mints a FRESH key and
//    re-executes the batch. Pinned as-landed below; the worklog records the
//    gap (the gateway's batchSha256+versionId replay dedupe is the only net).
// ---------------------------------------------------------------------------

describe("M5-L · applyRun network failure after saveNow", () => {
  it("NETWORK_ERROR (status 0) → typed {ok:false, reason:'failed', code:'NETWORK_ERROR'}; exactly ONE POST per gesture", async () => {
    const harness = await makeFailureHarness({
      applyRunError: networkError(new Error("fetch failed")),
    });

    const outcome = await harness.controller.apply(dimPlan());

    expect(outcome).toMatchObject({
      ok: false,
      reason: "failed",
      code: "NETWORK_ERROR",
      message: "Could not reach the server.",
    });
    // The edit + version landed BEFORE the network failure…
    expect(harness.state().undoLabels).toContain(BATCH_LABEL);
    expect(harness.saveReasons).toEqual(["agent-apply"]);
    // …and the client did NOT auto-retry: one POST, one engine.batch.
    expect(harness.applyCalls).toHaveLength(1);
    expect(
      harness.executeCalls.filter((call) => call.command === "engine.batch"),
    ).toHaveLength(1);
    expect(harness.timeline.at(-1)).toBe("applyRun");
  });

  it("idempotencyKey pin (ACTUAL, as-landed): a retry gesture posts a FRESH key — key reuse does NOT exist", async () => {
    // Models the REAL autosave on identical content (D-6 dedupe): the retry's
    // saveNow returns the SAME version the first gesture uploaded.
    const harness = await makeFailureHarness({
      applyRunError: networkError(new Error("fetch failed")),
      savedVersions: ["ver_applied_1", "ver_applied_1"],
    });

    const first = await harness.controller.apply(dimPlan());
    expect(first).toMatchObject({ ok: false, reason: "failed" });
    const second = await harness.controller.apply(dimPlan());
    expect(second).toMatchObject({ ok: true, versionId: "ver_applied_1" });

    const firstBody = harness.applyCalls[0]?.body;
    const secondBody = harness.applyCalls[1]?.body;
    expect(firstBody).toBeDefined();
    expect(secondBody).toBeDefined();
    if (firstBody === undefined || secondBody === undefined) return;

    // PIN (deviation from the brief's expectation): the key is NOT reused.
    expect(firstBody.idempotencyKey).not.toBe(secondBody.idempotencyKey);
    // What DOES make the retry safe for the server (M5-K's replay dedupe):
    // the batch sha256 is deterministic and — when the autosave dedupes —
    // the versionId matches, so the {batchSha256, versionId} pair is identical.
    expect(secondBody.batchSha256).toBe(firstBody.batchSha256);
    expect(secondBody.versionId).toBe(firstBody.versionId);
    // The engine re-executed the batch for the retry gesture (see finding 6).
    expect(
      harness.executeCalls.filter((call) => call.command === "engine.batch"),
    ).toHaveLength(2);
  });

  it("with a NON-deduped save the retry breaks the {batchSha256, versionId} pair the server dedupes on", async () => {
    const harness = await makeFailureHarness({
      applyRunError: networkError(new Error("fetch failed")),
    });
    const first = await harness.controller.apply(newTextPlan("Dup"));
    expect(first).toMatchObject({ ok: false, reason: "failed" });
    const second = await harness.controller.apply(newTextPlan("Dup"));
    expect(second).toMatchObject({ ok: true, versionId: "ver_applied_2" });

    const firstBody = harness.applyCalls[0]?.body;
    const secondBody = harness.applyCalls[1]?.body;
    if (firstBody === undefined || secondBody === undefined) return;
    expect(secondBody.batchSha256).toBe(firstBody.batchSha256); // same compiled batch
    expect(secondBody.versionId).not.toBe(firstBody.versionId); // NEW version → dedupe miss
    expect(secondBody.idempotencyKey).not.toBe(firstBody.idempotencyKey);
  });
});

// ---------------------------------------------------------------------------
// 8. Undo failures
// ---------------------------------------------------------------------------

describe("M5-L · undo failures", () => {
  it("edit.undo rejects 'nothing to undo' → {ok:false, reason:'nothing-to-undo'}; undoRun is NEVER called", async () => {
    const harness = await makeFailureHarness({ seed: false }); // pristine engine

    const outcome = await harness.controller.undo("run_1");

    expect(outcome).toMatchObject({ ok: false, reason: "nothing-to-undo" });
    if (!outcome.ok) expect(outcome.message).toBe("There is nothing to undo.");
    expect(harness.undoCalls).toHaveLength(0);
    // The upstream can_undo guard fired INSIDE the engine — the attempt ran.
    expect(harness.executeCalls.some((call) => call.command === "edit.undo")).toBe(true);
    expect(harness.events.map((event) => event.type)).toEqual(["undo.started", "undo.failed"]);
  });

  it("edit.undo hard-fails (non-'nothing to undo' shape) → engine-failed; NO undoRun", async () => {
    const harness = await makeFailureHarness({
      failOn: { "edit.undo": "command `edit.undo` is not available right now: journal is corrupt" },
    });
    await harness.controller.apply(dimPlan());
    const before = harness.state();

    const outcome = await harness.controller.undo("run_1");

    expect(outcome).toMatchObject({ ok: false, reason: "engine-failed" });
    expect(harness.undoCalls).toHaveLength(0);
    // The batch was NOT popped: the applied state is intact.
    expect(harness.state()).toEqual(before);
    expect(harness.state().undoLabels).toContain(BATCH_LABEL);
  });

  it("undoRun 409 → {ok:false, reason:'conflict'}; the LOCAL undo DID happen (divergence surfaced honestly)", async () => {
    const harness = await makeFailureHarness({
      undoRunError: new ApiError({
        code: "RUN_NOT_APPLIED",
        message: "This run has not been applied yet.",
        status: 409,
      }),
    });
    await harness.controller.apply(dimPlan());

    const outcome = await harness.controller.undo("run_1");

    expect(outcome).toMatchObject({ ok: false, reason: "conflict" });
    if (!outcome.ok) {
      expect(outcome.message).toBe(
        "The server says this run was not applied, so there is nothing to undo there.",
      );
    }
    // The editor DID undo (the batch entry popped) — the outcome says so.
    expect(harness.state().undoLabels).not.toContain(BATCH_LABEL);
    expect(harness.undoCalls).toHaveLength(1); // the POST was attempted once
    expect(harness.undoCalls[0]?.body).toEqual({
      idempotencyKey: expect.any(String),
    });
  });

  it("undoRun NETWORK_ERROR → {ok:false, reason:'failed', code:'NETWORK_ERROR'}; one POST, no auto-retry", async () => {
    const harness = await makeFailureHarness({
      undoRunError: networkError(new Error("fetch failed")),
    });
    await harness.controller.apply(dimPlan());

    const outcome = await harness.controller.undo("run_1");

    expect(outcome).toMatchObject({ ok: false, reason: "failed", code: "NETWORK_ERROR" });
    expect(harness.state().undoLabels).not.toContain(BATCH_LABEL); // local undo ran
    expect(harness.undoCalls).toHaveLength(1);
    await settle();
    expect(harness.undoCalls).toHaveLength(1); // nothing replays on its own
  });

  it("FINDING pin: undo is STACK-BLIND — undo(run_1) after run_2 applied reverts run_2's edit while the gateway records run_1 undone", async () => {
    const harness = await makeFailureHarness();
    const applied1 = await harness.controller.apply(dimPlan()); // opacity 50
    const applied2 = await harness.controller.apply(
      stepsPlan(
        "Agent: second edit",
        [{ command: "prop.set", params: { layer: 1, path: "transform/opacity", value: 20 } }],
        { runId: "run_2" },
      ),
    );
    expect(applied1.ok).toBe(true);
    expect(applied2.ok).toBe(true);
    expect(harness.state().layers[0]?.opacity).toBe(20);

    // The user asks to undo the FIRST run — the engine pops whatever is on
    // top: run_2's batch. The gateway records run_1 as the undone run.
    const outcome = await harness.controller.undo("run_1");
    expect(outcome).toEqual({ ok: true, undone: true });
    expect(harness.undoCalls[0]?.runId).toBe("run_1");
    // run_2's edit (opacity 20) is GONE; run_1's edit (opacity 50) remains.
    expect(harness.state().layers[0]?.opacity).toBe(50);
    expect(harness.state().undoLabels).toContain(BATCH_LABEL); // run_1 still applied locally
    expect(harness.state().undoLabels).not.toContain("Agent: second edit"); // run_2 reverted
  });
});

// ---------------------------------------------------------------------------
// 9. The panic sweep (M4-N corpus, dunder ids, 100k strings, deep nesting)
// ---------------------------------------------------------------------------

describe("M5-L · panic sweep", () => {
  it("hostile layer names (the M4-N corpus) resolve as exact-name DATA through the whole apply path", async () => {
    for (const fixture of ALL_TEXT_FIXTURES) {
      const harness = await makeFailureHarness();
      await renameLayer(harness.fake, 1, fixture.payload);

      const outcome = await harness.controller.apply(
        dimPlan({
          resolutionRequests: [
            { requestId: "r1", layerName: fixture.payload, disambiguation: [] },
          ],
        }),
      );

      // Exact-name match on ONE layer → the batch applies; never a throw.
      expect(outcome, `corpus fixture "${fixture.id}"`).toMatchObject({ ok: true });
      if (outcome.ok) expect(outcome.versionId).toBe("ver_applied_1");
      expect(harness.state().layers[0]?.opacity, `fixture "${fixture.id}"`).toBe(50);
      expect(harness.state().layers[0]?.name, `fixture "${fixture.id}"`).toBe(fixture.payload);
      expectPrototypeClean();
      expectAllCommandsAllowlisted(harness);
    }
  });

  it("an AMBIGUOUS hostile name (two layers renamed to the same corpus payload) fails TYPED before any engine call", async () => {
    const payload = ALL_TEXT_FIXTURES[0]?.payload ?? "IGNORE PREVIOUS";
    const harness = await makeFailureHarness();
    await renameLayer(harness.fake, 1, payload);
    await harness.fake.execute("layer.newText", { text: "second" }); // layer id 2
    await renameLayer(harness.fake, 2, payload);
    const before = harness.state();

    const outcome = await harness.controller.apply(
      dimPlan({
        resolutionRequests: [{ requestId: "r1", layerName: payload, disambiguation: [] }],
      }),
    );

    expect(outcome).toMatchObject({ ok: false, reason: "ambiguous" });
    if (!outcome.ok && outcome.reason === "ambiguous") {
      expect(outcome.candidates).toHaveLength(2);
      expectMessageHygienic(outcome.message, "ambiguous corpus name");
    }
    expect(harness.executeCalls).toHaveLength(0);
    expect(harness.applyCalls).toHaveLength(0);
    expect(harness.state()).toEqual(before);
  });

  it("dunder REQUEST ids ('constructor', 'toString') resolve as inert data; Object.prototype untouched", async () => {
    for (const requestId of ["constructor", "toString"]) {
      const harness = await makeFailureHarness();
      const outcome = await harness.controller.apply(
        dimPlan({
          compiledBatch: {
            label: "Agent: dunder request",
            atomic: true,
            steps: [
              {
                command: "prop.set",
                params: { layer: `$request:${requestId}`, path: "transform/opacity", value: 50 },
              },
            ],
          },
          resolutionRequests: [{ requestId, layerName: "Hello", disambiguation: [] }],
        }),
      );

      // Null-prototype accumulator: the dunder id is an OWN key, never a
      // prototype hit — the whole apply completes.
      expect(outcome, `requestId "${requestId}"`).toMatchObject({ ok: true });
      const batch = harness.executeCalls.find((call) => call.command === "engine.batch")
        ?.params as {
        steps: ReadonlyArray<{ params: Record<string, unknown> }>;
      };
      expect(batch.steps[0]?.params.layer, `requestId "${requestId}"`).toBe(1);
      expectPrototypeClean();
      expectAllCommandsAllowlisted(harness);
    }
  });

  it("100k-char strings (label + param value) → typed ok, no crash; client validation is shape-only (no §8.5 label cap — see finding)", async () => {
    const harness = await makeFailureHarness();
    const hugeLabel = `Agent: ${"x".repeat(100_000)}`;
    const hugeValue = "y".repeat(100_000);

    const outcome = await harness.controller.apply(
      stepsPlan(hugeLabel, [
        { command: "prop.set", params: { layer: 1, path: "text/sourceText", value: hugeValue } },
      ]),
    );

    // The client neither crashed nor rejected the oversized label locally —
    // the §8.5 bounds (280-char label, 2 MB) are enforced by the SSE wire
    // schema, not by apply.ts's hand-rolled re-validation. Pinned as-landed.
    expect(outcome).toMatchObject({ ok: true, versionId: "ver_applied_1" });
    expect(harness.state().layers[0]?.sourceText).toBe(hugeValue);
    expect(harness.state().undoLabels.at(-1)).toBe(hugeLabel);
    expectAllCommandsAllowlisted(harness);
  });

  it("99-deep nested args: a resolved token at the bottom applies; an unresolved one fails TYPED before the engine", async () => {
    const deep = (depth: number, leaf: unknown): Record<string, unknown> => {
      let node = leaf;
      for (let i = 0; i < depth; i += 1) node = { v: node };
      return node as Record<string, unknown>;
    };

    // (a) resolved token at the top level + a deep inert value
    const resolvedHarness = await makeFailureHarness();
    const resolvedValue = deep(99, 50);
    const resolved = await resolvedHarness.controller.apply(
      dimPlan({
        compiledBatch: {
          label: "Agent: deep args",
          atomic: true,
          steps: [
            {
              command: "prop.set",
              params: { layer: "$request:r1", path: "transform/opacity", value: resolvedValue },
            },
          ],
        },
      }),
    );
    expect(resolved).toMatchObject({ ok: true });
    expect(resolvedHarness.state().layers[0]?.opacity).toEqual(resolvedValue);
    expectAllCommandsAllowlisted(resolvedHarness);

    // (b) an unresolved token buried 99 levels deep never reaches the engine
    const ghostHarness = await makeFailureHarness();
    const ghost = await ghostHarness.controller.apply(
      dimPlan({
        compiledBatch: {
          label: "Agent: deep ghost",
          atomic: true,
          steps: [
            {
              command: "prop.set",
              params: {
                layer: "$request:r1",
                path: "transform/opacity",
                value: deep(99, "$request:ghost"),
              },
            },
          ],
        },
      }),
    );
    expect(ghost).toMatchObject({ ok: false, reason: "resolution-failed" });
    expect(ghostHarness.executeCalls).toHaveLength(0);
    expect(ghostHarness.applyCalls).toHaveLength(0);
  });

  it("a 150-step batch passes client validation and executes (§8.5 bounds live on the WIRE schema, not in apply.ts — finding)", async () => {
    const harness = await makeFailureHarness();
    const steps = Array.from({ length: 150 }, (_, index) => ({
      command: "prop.set",
      params: { layer: 1, path: "transform/opacity", value: index },
    }));

    const outcome = await harness.controller.apply(stepsPlan("Agent: bulk edit", steps));

    expect(outcome).toMatchObject({ ok: true });
    const batch = harness.executeCalls.find((call) => call.command === "engine.batch")
      ?.params as { steps?: ReadonlyArray<unknown> };
    expect(batch.steps).toHaveLength(150);
    // Still ONE folded undo step (law #6) — even a 150-step batch.
    expect(harness.state().undoLabels.at(-1)).toBe("Agent: bulk edit");
    expect(harness.state().layers[0]?.opacity).toBe(149);
    expectAllCommandsAllowlisted(harness);
  });
});

// ---------------------------------------------------------------------------
// 10. Law #1 matrix — every injected failure surfaces a typed, stack-free line
// ---------------------------------------------------------------------------

describe("M5-L · law #1 matrix (no raw error strings / stacks in user outcomes)", () => {
  it("every injection in the suite maps to a pinned reason + a hygienic message", async () => {
    const dimStep = [
      { command: "prop.set", params: { layer: 1, path: "transform/opacity", value: 50 } },
    ];

    const rows: ReadonlyArray<{ label: string; run: () => Promise<ApplyOutcome | UndoOutcome> }> =
      [
        {
          label: "unknown command",
          run: async () => {
            const h = await makeFailureHarness();
            return await h.controller.apply(
              stepsPlan("Agent: bad", [{ command: "layer.explode", params: {} }]),
            );
          },
        },
        {
          label: "mid-batch poison",
          run: async () => {
            const h = await makeFailureHarness({
              failOn: { "layer.rename": "invalid parameters for `layer.rename`: nope" },
            });
            return await h.controller.apply(poisonedMidBatchPlan());
          },
        },
        {
          label: "disposed bridge",
          run: async () => {
            const h = await makeFailureHarness();
            h.disposeInner();
            return await h.controller.apply(stepsPlan("Agent: d", dimStep));
          },
        },
        {
          label: "EDITOR_TIMEOUT",
          run: async () => {
            const h = await makeFailureHarness();
            h.faults.rejectExecute(
              "engine.batch",
              new BridgeError("EDITOR_TIMEOUT", "execute engine.batch: timed out after 15000ms"),
            );
            return await h.controller.apply(stepsPlan("Agent: d", dimStep));
          },
        },
        {
          label: "invalid batch",
          run: async () => {
            const h = await makeFailureHarness();
            return await h.controller.apply(
              dimPlan({
                compiledBatch: {
                  label: "",
                  atomic: true,
                  steps: [],
                } as unknown as ApplicablePlan["compiledBatch"],
              }),
            );
          },
        },
        {
          label: "unresolved token",
          run: async () => {
            const h = await makeFailureHarness();
            return await h.controller.apply(
              dimPlan({
                resolutionRequests: undefined,
                compiledBatch: {
                  label: "Agent: ghost",
                  atomic: true,
                  steps: [
                    {
                      command: "prop.set",
                      params: { layer: "$request:r1", path: "transform/opacity", value: 1 },
                    },
                  ],
                },
              }),
            );
          },
        },
        {
          label: "ambiguous name",
          run: async () => {
            const h = await makeFailureHarness();
            await h.fake.execute("layer.newText", { text: "second" });
            await renameLayer(h.fake, 2, "Hello");
            return await h.controller.apply(dimPlan());
          },
        },
        {
          label: "not-found name",
          run: async () => {
            const h = await makeFailureHarness();
            return await h.controller.apply(
              dimPlan({
                resolutionRequests: [{ requestId: "r1", layerName: "Missing", disambiguation: [] }],
              }),
            );
          },
        },
        {
          label: "save error",
          run: async () => {
            const h = await makeFailureHarness({ saveMode: "error" });
            return await h.controller.apply(dimPlan());
          },
        },
        {
          label: "save conflict",
          run: async () => {
            const h = await makeFailureHarness({ saveMode: "conflict" });
            return await h.controller.apply(dimPlan());
          },
        },
        {
          label: "applyRun 409",
          run: async () => {
            const h = await makeFailureHarness({
              applyRunError: new ApiError({
                code: "VERSION_CONFLICT",
                message: "The project changed while this plan was open.",
                status: 409,
              }),
            });
            return await h.controller.apply(dimPlan());
          },
        },
        {
          label: "applyRun 402",
          run: async () => {
            const h = await makeFailureHarness({
              applyRunError: new ApiError({
                code: "INSUFFICIENT_CREDITS",
                message: "You need more credits to commit this run.",
                status: 402,
              }),
            });
            return await h.controller.apply(dimPlan());
          },
        },
        {
          label: "applyRun 429",
          run: async () => {
            const h = await makeFailureHarness({
              applyRunError: new ApiError({
                code: "RATE_LIMITED",
                message: "Too many requests. Slow down for a moment, then retry.",
                status: 429,
              }),
            });
            return await h.controller.apply(dimPlan());
          },
        },
        {
          label: "applyRun network",
          run: async () => {
            const h = await makeFailureHarness({
              applyRunError: networkError(new Error("fetch failed")),
            });
            return await h.controller.apply(dimPlan());
          },
        },
        {
          label: "undo nothing",
          run: async () => {
            const h = await makeFailureHarness({ seed: false });
            return await h.controller.undo("run_1");
          },
        },
        {
          label: "undoRun 409",
          run: async () => {
            const h = await makeFailureHarness({
              undoRunError: new ApiError({
                code: "RUN_NOT_APPLIED",
                message: "This run has not been applied yet.",
                status: 409,
              }),
            });
            await h.controller.apply(dimPlan());
            return await h.controller.undo("run_1");
          },
        },
        {
          label: "undoRun network",
          run: async () => {
            const h = await makeFailureHarness({
              undoRunError: networkError(new Error("fetch failed")),
            });
            await h.controller.apply(dimPlan());
            return await h.controller.undo("run_1");
          },
        },
      ];

    expect(rows.length).toBeGreaterThanOrEqual(16);
    for (const row of rows) {
      const outcome = await row.run();
      expect(outcome.ok, `${row.label}: every injection is a typed failure`).toBe(false);
      if (!outcome.ok) {
        expect(FAILURE_REASONS, `${row.label}: reason is pinned vocabulary`).toContain(
          outcome.reason,
        );
        expectMessageHygienic(outcome.message, row.label);
      }
    }
  });
});
