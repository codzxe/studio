/**
 * apply-lease-held.test — the M7 read-only enforcement wired into the APPLY
 * path (BUILD_PLAN §M7 task 3; DECISIONS.md D-23: "chat allowed, apply
 * gated"), additive to the M5-F apply suite:
 *
 *   * LOCAL gate (lib/editor-session read-only.ts wraps the bridge): an
 *     apply while ANOTHER member holds the active lease refuses with the
 *     typed `lease-held` outcome — NOTHING reaches the engine (D-23's read
 *     side stays alive: the same apply's resolution reads still run),
 *     nothing saves, the gateway is never told;
 *   * GATEWAY 409 LEASE_HELD (the server guard is AUTHORITATIVE): the
 *     conflict arm surfaces it honestly as `lease-held` + `batchApplied`
 *     (the batch + version DID land; only the report is refused), instead
 *     of the generic "already applied" conflict copy;
 *   * regression pin: a plain 409 (no LEASE_HELD code) still maps to
 *     `conflict`;
 *   * undo refuses locally while blocked; a gateway 409 LEASE_HELD on
 *     undoRun surfaces as `lease-held` while staying honest that the undo
 *     happened in the editor.
 */

import {
  type ApplicablePlan,
  type ApplyOutcome,
  type UndoOutcome,
  createApplyController,
} from "@/lib/chat/apply";
import { createReadOnlyGate, wrapReadOnlyBridge } from "@/lib/editor-session";
import type { SaveOutcome } from "@/lib/editor-session";
import { ApiError } from "@studio/api-client";
import type { EditorBridge } from "@studio/editor-bridge";
import { attachFakeBridge, createFakeEditor } from "@studio/editor-bridge/fake";
import type { FakeEditor } from "@studio/editor-bridge/fake";
import { describe, expect, it } from "vitest";
import { dimPlan, makeFailureHarness } from "./apply-harness";

function leaseHeldApiError(holderName: string): ApiError {
  // The gateway's real envelope shape (lease-guard.ts): the §7.3 body the
  // requireLeaseForMutation guard throws — status 409 + the wire code.
  return new ApiError({
    code: "LEASE_HELD",
    message: `${holderName} is editing this project right now.`,
    status: 409,
    hint: "Open the project read-only, or request edit access and take over when the current editor is done.",
    retryable: true,
  });
}

/** A minimal async apply harness over a GATE-WRAPPED bridge (the harness pattern). */
async function gatedHarness(): Promise<{
  readonly fake: FakeEditor;
  readonly bridge: EditorBridge;
  readonly setBlocked: (blocked: boolean, holderName?: string) => void;
  readonly applyCalls: string[];
  readonly undoCalls: string[];
  readonly saveReasons: string[];
  readonly apply: (plan: ApplicablePlan) => Promise<ApplyOutcome>;
  readonly undo: (runId: string) => Promise<UndoOutcome>;
}> {
  const fake = createFakeEditor({ comps: [{ name: "Main" }] });
  // Seed layer 1 "Hello" — dimPlan resolves it by name (the harness pattern).
  await fake.execute("layer.newText", { text: "Hello" });
  const inner = attachFakeBridge(fake);
  const handle = createReadOnlyGate();
  const bridge = wrapReadOnlyBridge(inner, handle.gate);
  const applyCalls: string[] = [];
  const undoCalls: string[] = [];
  const saveReasons: string[] = [];

  const controller = createApplyController({
    bridge,
    autosave: {
      saveNow: async (reason: string): Promise<SaveOutcome> => {
        saveReasons.push(reason);
        return {
          saved: true,
          version: { id: "ver_1", label: null, sha256: "0".repeat(64), sizeBytes: 1 },
        };
      },
    },
    api: {
      runs: {
        applyRun: async (runId: string) => {
          applyCalls.push(runId);
          return { applied: true, versionId: "ver_1", creditsCommitted: 12 };
        },
        undoRun: async (runId: string) => {
          undoCalls.push(runId);
          return { undone: true };
        },
      },
    },
  });

  return {
    fake,
    bridge,
    setBlocked: (blocked: boolean, holderName = "Alex") => handle.update(blocked, holderName),
    applyCalls,
    undoCalls,
    saveReasons,
    apply: (plan) => controller.apply(plan),
    undo: (runId) => controller.undo(runId),
  };
}

describe("M7 read-only gate — the LOCAL refusal (client gate is UX, nothing executes)", () => {
  it("a blocked apply refuses with the typed lease-held outcome; ZERO engine mutations, no save, no report", async () => {
    const harness = await gatedHarness();
    harness.setBlocked(true, "Dana Flow");

    const outcome = await harness.apply(dimPlan());

    expect(outcome).toEqual({
      ok: false,
      reason: "lease-held",
      message: expect.stringContaining("Dana Flow is editing this project right now."),
    });
    if (!outcome.ok) {
      expect(outcome.message).toContain("The plan was not applied");
    }
    // Never reached the engine: identical state, no NEW undo entries beyond
    // the seeded layer's own journal entry.
    expect(harness.fake.state.project.layers).toHaveLength(1);
    expect(harness.fake.state.history.undo).toHaveLength(1); // only the seed
    expect(harness.saveReasons).toHaveLength(0); // no D-6 save for a batch that never ran
    expect(harness.applyCalls).toHaveLength(0); // the gateway was never told
  });

  it("D-23 pin: while blocked the apply's READ steps still run — chat/proposal surfaces stay alive", async () => {
    const harness = await gatedHarness();
    harness.setBlocked(true, "Alex");

    // The read seam passes while blocked (the chat context + tool reads).
    await expect(harness.bridge.query("project.summary", {})).resolves.toBeDefined();
    await expect(harness.bridge.query("comp.info", {})).resolves.toBeDefined();

    // dimPlan resolves "Hello" by name through comp.info — the read RUNS,
    // then the mutating engine.batch is the thing the gate refuses.
    const outcome = await harness.apply(dimPlan());
    expect(outcome).toMatchObject({ ok: false, reason: "lease-held" });
    expect(harness.fake.state.project.layers).toHaveLength(1); // just the seed
  });

  it("undo refuses locally while blocked: the engine stack is untouched, the gateway is not told", async () => {
    const harness = await gatedHarness();
    // Apply while free (lands the batch), then lose the lease.
    const applied = await harness.apply(dimPlan());
    expect(applied.ok).toBe(true);
    expect(harness.undoCalls).toHaveLength(0);
    const undoLabelsAfterApply = [...harness.fake.state.history.undo];

    harness.setBlocked(true, "Alex");
    const undoLabelsBefore = [...harness.fake.state.history.undo];
    const outcome = await harness.undo("run_1");

    expect(outcome).toMatchObject({ ok: false, reason: "lease-held" });
    if (!outcome.ok) {
      expect(outcome.message).toContain("Alex is editing this project right now.");
      expect(outcome.message).toContain("The undo was not performed");
    }
    // The engine still holds the applied batch on its undo stack.
    expect(harness.fake.state.history.undo).toEqual(undoLabelsBefore);
    expect(harness.fake.state.history.undo).toHaveLength(undoLabelsAfterApply.length);
    expect(harness.undoCalls).toHaveLength(0);
  });
  it("the same controller applies cleanly once the gate opens (the flip is call-time)", async () => {
    const harness = await gatedHarness();
    harness.setBlocked(true, "Alex");
    const refused = await harness.apply(dimPlan());
    expect(refused).toMatchObject({ ok: false, reason: "lease-held" });

    harness.setBlocked(false);
    const applied = await harness.apply(dimPlan());
    expect(applied).toMatchObject({ ok: true });
    expect(harness.applyCalls).toEqual(["run_1"]);
  });
});

describe("M7 read-only gate — the GATEWAY 409 LEASE_HELD (server-authoritative)", () => {
  it("a 409 LEASE_HELD on applyRun maps to lease-held + batchApplied (honest: edit + version landed)", async () => {
    const harness = await makeFailureHarness({
      applyRunError: leaseHeldApiError("Alex"),
    });
    const before = harness.state();
    const outcome = await harness.controller.apply(dimPlan());
    await Promise.resolve(); // let the outcome settle

    expect(outcome).toMatchObject({ ok: false, reason: "lease-held", batchApplied: true });
    if (!outcome.ok && outcome.reason === "lease-held") {
      expect(outcome.message).toContain("Alex is editing this project right now.");
      expect(outcome.message).toContain("The edit and its version are saved");
    }
    // The server-side guard is authoritative about the REPORT only: the
    // batch executed and the D-6 save ran before applyRun was refused.
    expect(harness.executeCalls.some((call) => call.command === "engine.batch")).toBe(true);
    expect(harness.saveReasons).toContain("agent-apply");
    expect(harness.applyCalls).toHaveLength(1);
    expect(before.layers[0]?.opacity).not.toEqual(harness.state().layers[0]?.opacity); // applied
  });

  it("regression: a plain 409 (any other code) still maps to the generic conflict outcome", async () => {
    const harness = await makeFailureHarness({
      applyRunError: new ApiError({
        code: "RUN_NOT_APPLIED",
        message: "This plan was already applied or the run changed on the server.",
        status: 409,
      }),
    });
    const outcome = await harness.controller.apply(dimPlan());
    expect(outcome).toMatchObject({ ok: false, reason: "conflict" });
    if (!outcome.ok && outcome.reason === "conflict") {
      expect(outcome.message).not.toContain("is editing this project");
    }
  });

  it("a 409 LEASE_HELD on undoRun surfaces lease-held — honest that the editor DID undo", async () => {
    const harness = await makeFailureHarness({
      undoRunError: leaseHeldApiError("Alex"),
    });
    const applied = await harness.controller.apply(dimPlan());
    expect(applied.ok).toBe(true);
    const opacityApplied = harness.state().layers[0]?.opacity;

    const outcome = await harness.controller.undo("run_1");

    expect(outcome).toMatchObject({ ok: false, reason: "lease-held" });
    if (!outcome.ok && outcome.reason === "lease-held") {
      expect(outcome.message).toContain("Alex is editing this project right now.");
      expect(outcome.message).toContain("The undo happened in the editor");
    }
    // The engine actually reverted (the gateway row was not told — honest).
    expect(harness.state().layers[0]?.opacity).not.toBe(opacityApplied);
    expect(harness.undoCalls).toHaveLength(1);
  });
});
