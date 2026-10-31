/**
 * apply tests (M5-F, BUILD_PLAN §M5.4/§M5.5) — deterministic, no network:
 * the REAL fake editor bridge (`@studio/editor-bridge/fake` — same engine
 * semantics: `engine.batch` folds into ONE undo step, `edit.undo` with the
 * "nothing to undo" guard) + fake autosave + fake apply API.
 *
 * Pins the law-#6 flow: ONE `engine.batch` per apply → `saveNow("agent-apply")`
 * AWAITED BEFORE `applyRun` → one versionId; ambiguous layer names never touch
 * the engine; undo never tells the gateway when the editor has nothing to undo;
 * reapply is gated on the plan's base version; sha256 matches node:crypto over
 * the exact engine payload; dunder keys in plan params stay OWN data.
 */

import { createHash } from "node:crypto";

import { ApiError } from "@studio/api-client";
import type { EditorBridge } from "@studio/editor-bridge";
import { type FakeEditor, attachFakeBridge, createFakeEditor } from "@studio/editor-bridge/fake";
import { describe, expect, it } from "vitest";

import {
  type ApplicablePlan,
  type ApplyApiClient,
  type ApplyAutosavePort,
  type ApplyEngineEvent,
  type ApplyOutcome,
  type CreateApplyControllerOptions,
  type UndoOutcome,
  batchSha256Hex,
  createApplyController,
  engineBatchPayload,
} from "./apply";

// ---------------------------------------------------------------------------
// Harness (fake bridge recorder + fake autosave + fake api, one timeline)
// ---------------------------------------------------------------------------

interface RecordedBridge {
  bridge: EditorBridge;
  executeCalls: Array<{ command: string; params: unknown }>;
  queryCalls: Array<{ command: string; params: unknown }>;
}

/** Wraps a bridge so every execute/query is recorded (execute mutates!). */
function recordBridge(bridge: EditorBridge): RecordedBridge {
  const executeCalls: RecordedBridge["executeCalls"] = [];
  const queryCalls: RecordedBridge["queryCalls"] = [];
  const wrapped: EditorBridge = {
    ...bridge,
    execute: async <T>(command: string, params?: unknown) => {
      executeCalls.push({ command, params: structuredClone(params) });
      return await bridge.execute<T>(command, params);
    },
    query: <T>(command: string, params?: unknown) => {
      queryCalls.push({ command, params });
      return bridge.query<T>(command, params);
    },
  };
  return { bridge: wrapped, executeCalls, queryCalls };
}

interface HarnessOptions {
  /** Injected failure for the fake's `engine.batch` (the fake's own `failOn`). */
  failBatchWith?: string;
  /** The autosave outcome (default: a fresh saved version). */
  saveOutcome?: "saved" | "conflict" | "error" | "not-dirty";
  /** Injected ApiError for the first applyRun (default: success). */
  applyRunError?: ApiError;
  /** Injected ApiError for the first undoRun (default: success). */
  undoRunError?: ApiError;
  /** The session's current version id (reapply gate). */
  currentVersionId?: string | null;
  /** Round-12: wraps the (recorded) bridge the controller sees — the
   * client-special seam fakes (script.run / edit.pasteSvg). */
  wrapBridge?: (inner: EditorBridge, fake: FakeEditor) => EditorBridge;
}

interface Harness {
  fake: FakeEditor;
  recorded: RecordedBridge;
  controller: ReturnType<typeof createApplyController>;
  /** Ordered milestone log across every fake (bridge/autosave/api). */
  timeline: string[];
  autosaveReasons: string[];
  applyCalls: Array<{ runId: string; body: Record<string, unknown> }>;
  undoCalls: Array<{ runId: string; body: Record<string, unknown> }>;
  events: ApplyEngineEvent[];
  api: ApplyApiClient;
  autosave: ApplyAutosavePort;
}

const FAKE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const fake = createFakeEditor({
    comps: [{ name: "Main" }],
    ...(options.failBatchWith !== undefined
      ? { failOn: { "engine.batch": options.failBatchWith } }
      : {}),
  });
  // Layer 1 "Hello" (text) in comp 1 "Main"; journaled → selected, dirty.
  await fake.execute("layer.newText", { text: "Hello" });

  const recorded = recordBridge(attachFakeBridge(fake));
  const timeline: string[] = [];
  const autosaveReasons: string[] = [];
  const applyCalls: Harness["applyCalls"] = [];
  const undoCalls: Harness["undoCalls"] = [];
  const events: ApplyEngineEvent[] = [];
  let versionCounter = 0;

  const autosave: ApplyAutosavePort = {
    saveNow: async (reason: string) => {
      timeline.push(`saveNow:${reason}`);
      autosaveReasons.push(reason);
      if (options.saveOutcome === "conflict") return { saved: false, conflict: true };
      if (options.saveOutcome === "error")
        return { saved: false, error: new Error("upload failed") };
      if (options.saveOutcome === "not-dirty") return { saved: false };
      versionCounter += 1;
      return {
        saved: true,
        version: {
          id: `ver_applied_${versionCounter}`,
          label: null,
          sha256: FAKE_SHA,
          sizeBytes: 128,
        },
      };
    },
    markDirty: (reason?: string) => {
      timeline.push(`markDirty:${reason ?? "unnamed"}`);
    },
  };

  const api: ApplyApiClient = {
    runs: {
      applyRun: async (runId, body) => {
        timeline.push("applyRun");
        applyCalls.push({ runId, body: body as Record<string, unknown> });
        if (options.applyRunError !== undefined && applyCalls.length === 1) {
          throw options.applyRunError;
        }
        return { applied: true, versionId: body.versionId, creditsCommitted: 12 };
      },
      undoRun: async (runId, body) => {
        timeline.push("undoRun");
        undoCalls.push({ runId, body: body as Record<string, unknown> });
        if (options.undoRunError !== undefined && undoCalls.length === 1) {
          throw options.undoRunError;
        }
        return { undone: true };
      },
    },
  };

  // Round-12: the controller's bridge may be a wrapper over the recorded one
  // (the client-special seams script.run / edit.pasteSvg delegate through it, so
  // their calls stay recorded in execution order).
  const controllerBridge =
    options.wrapBridge === undefined ? recorded.bridge : options.wrapBridge(recorded.bridge, fake);

  const controllerOptions: CreateApplyControllerOptions = {
    bridge: controllerBridge,
    autosave,
    api,
    ...(options.currentVersionId !== undefined
      ? { session: { currentVersionId: () => options.currentVersionId ?? null } }
      : {}),
    onEvent: (event) => {
      events.push(event);
    },
  };

  return {
    fake,
    recorded,
    controller: createApplyController(controllerOptions),
    timeline,
    autosaveReasons,
    applyCalls,
    undoCalls,
    events,
    api,
    autosave,
  };
}

/** A minimal plan: one prop.set on the resolved "Hello" layer. */
function helloPlan(overrides: Partial<ApplicablePlan> = {}): ApplicablePlan {
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
    resolutionRequests: [
      { requestId: "r1", layerName: "Hello", disambiguation: ["the text layer"] },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// apply — the law-#6 happy path
// ---------------------------------------------------------------------------

describe("createApplyController.apply", () => {
  it("resolves → patches → ONE engine.batch → saveNow(agent-apply) → applyRun, in order", async () => {
    const harness = await makeHarness();
    const outcome = await harness.controller.apply(helloPlan());

    expect(outcome).toMatchObject({ ok: true, versionId: "ver_applied_1", creditsCommitted: 12 });

    // Resolution reused the executor's list_layers path: ONE comp.info query.
    expect(harness.recorded.queryCalls).toEqual([{ command: "comp.info", params: {} }]);

    // ONE engine.batch (law #6), carrying the RESOLVED layer id (number, no token).
    const batches = harness.recorded.executeCalls.filter((call) => call.command === "engine.batch");
    expect(batches).toHaveLength(1);
    const batch = batches[0] as {
      params: { steps: Array<{ params: Record<string, unknown> }>; atomic: boolean; label: string };
    };
    expect(batch.params.steps[0]?.params).toEqual({
      layer: 1,
      path: "transform/opacity",
      value: 50,
    });
    // The wire payload is exactly the pinned params object {label, atomic, steps}.
    expect(Object.keys(batch.params).sort()).toEqual(["atomic", "label", "steps"]);
    expect(batch.params.atomic).toBe(true);

    // D-6: the version upload is AWAITED BEFORE the gateway report.
    expect(harness.timeline).toEqual(["markDirty:agent-apply", "saveNow:agent-apply", "applyRun"]);
    expect(harness.autosaveReasons).toEqual(["agent-apply"]);

    // applyRun body: the exact APPLY_REQUEST_SCHEMA fields, one gesture = one key.
    expect(harness.applyCalls).toHaveLength(1);
    const call = harness.applyCalls[0];
    if (call === undefined) throw new Error("no applyRun call");
    expect(call.runId).toBe("run_1");
    expect(Object.keys(call.body).sort()).toEqual([
      "batchSha256",
      "idempotencyKey",
      "resolvedLayers",
      "versionId",
    ]);
    expect(call.body.versionId).toBe("ver_applied_1");
    expect((call.body.idempotencyKey as string).length).toBeGreaterThanOrEqual(8);
    // §8.7/M5-E: the name→id bindings ride the body (auditable server-side).
    expect(call.body.resolvedLayers).toEqual([{ requestId: "r1", layerId: 1 }]);

    // The engine really changed + the whole batch is ONE undo step (law #6).
    expect(harness.fake.state.dirty).toBe(true);
    expect(harness.fake.state.history.undo.at(-1)?.label).toBe("Agent: dim the headline");
    const summary = await harness.recorded.bridge.query<{ selectedLayers?: number[] }>(
      "project.summary",
    );
    expect(summary?.selectedLayers).toEqual([1]);

    // Milestones for the host page, in order.
    expect(harness.events.map((event) => event.type)).toEqual([
      "apply.started",
      "apply.resolved",
      "apply.completed",
    ]);
  });

  it("sha256 is over the EXACT patched engine payload (node:crypto cross-check)", async () => {
    const payload = engineBatchPayload({
      label: "Agent: dim the headline",
      atomic: true,
      steps: [{ command: "prop.set", params: { layer: 1, path: "transform/opacity", value: 50 } }],
    });
    const digest = await batchSha256Hex(payload);
    expect(digest).toBe(createHash("sha256").update(JSON.stringify(payload)).digest("hex"));
    // And the digest the controller sent matches the payload it executed.
    const harness = await makeHarness();
    await harness.controller.apply(helloPlan());
    const batch = harness.recorded.executeCalls.find(
      (call) => call.command === "engine.batch",
    )?.params;
    const sent = harness.applyCalls[0]?.body.batchSha256 as string;
    expect(sent).toBe(await batchSha256Hex(batch));
    expect(sent).toMatch(/^[0-9a-f]{64}$/);
  });

  it("timeoutMs rides the payload as §8.5 metadata (inert upstream)", async () => {
    const harness = await makeHarness();
    await harness.controller.apply(
      helloPlan({
        compiledBatch: {
          label: "Agent: slow edit",
          atomic: true,
          steps: [{ command: "layer.newText", params: { text: "Planned" } }],
          timeoutMs: 5_000,
        },
        resolutionRequests: undefined,
      }),
    );
    const batch = harness.recorded.executeCalls.find((call) => call.command === "engine.batch")
      ?.params as { timeoutMs?: number };
    expect(batch?.timeoutMs).toBe(5_000);
    // No resolution requests → no resolvedLayers key on the wire body.
    const body = harness.applyCalls[0]?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["batchSha256", "idempotencyKey", "versionId"]);
    expect(body.batchSha256).toBe(
      createHash("sha256")
        .update(JSON.stringify({ ...batch, atomic: true }))
        .digest("hex"),
    );
  });
});

// ---------------------------------------------------------------------------
// apply — resolution failures never touch the engine
// ---------------------------------------------------------------------------

describe("createApplyController.apply — layer resolution", () => {
  it("ambiguous names → {ok:false, reason:'ambiguous', candidates} with ZERO engine mutations", async () => {
    const bridge = {
      // Two layers with the same name — the executor's list_layers path shape.
      query: async <T>(command: string): Promise<T> =>
        command === "comp.info"
          ? ({
              id: 1,
              name: "Main",
              layers: [
                { id: 1, name: "Twin", type: "text" },
                { id: 2, name: "Twin", type: "solid" },
              ],
            } as T)
          : ({} as T),
    } as unknown as EditorBridge;
    const controller = createApplyController({
      bridge,
      autosave: { saveNow: async () => ({ saved: true, version: undefined }) },
      api: {
        runs: {
          applyRun: async () => ({ applied: true, versionId: "ver_x", creditsCommitted: 0 }),
          undoRun: async () => ({ undone: true }),
        },
      },
    });

    const outcome = await controller.apply(
      helloPlan({
        resolutionRequests: [{ requestId: "r1", layerName: "Twin", disambiguation: [] }],
      }),
    );

    expect(outcome).toMatchObject({ ok: false, reason: "ambiguous" });
    if (outcome.ok || outcome.reason !== "ambiguous") {
      throw new Error("expected an ambiguous-resolution failure");
    }
    expect(outcome.candidates).toHaveLength(2);
    expect(outcome.candidates[0]).toBe("Twin (layer 1)");
    expect(outcome.message).toContain("2 layers");
  });

  it("unknown names → {ok:false, reason:'not-found'} without touching the engine", async () => {
    const harness = await makeHarness();
    const outcome = await harness.controller.apply(
      helloPlan({
        resolutionRequests: [{ requestId: "r1", layerName: "Missing", disambiguation: [] }],
      }),
    );
    expect(outcome).toMatchObject({ ok: false, reason: "not-found", layerName: "Missing" });
    expect(harness.recorded.executeCalls).toHaveLength(0);
    expect(harness.applyCalls).toHaveLength(0);
    expect(harness.autosaveReasons).toEqual([]);
    expect(harness.fake.state.dirty).toBe(true); // the setup newText only — nothing new
  });

  it("an unresolvable $request token in the batch → resolution-failed, nothing executes", async () => {
    const harness = await makeHarness();
    const outcome = await harness.controller.apply(
      helloPlan({
        compiledBatch: {
          label: "Agent: mystery layer",
          atomic: true,
          steps: [
            {
              command: "prop.set",
              params: { layer: "$request:ghost", path: "transform/opacity", value: 1 },
            },
          ],
        },
        resolutionRequests: [{ requestId: "r1", layerName: "Hello", disambiguation: [] }],
      }),
    );
    expect(outcome).toMatchObject({ ok: false, reason: "resolution-failed" });
    expect(harness.recorded.executeCalls).toHaveLength(0);
    expect(harness.applyCalls).toHaveLength(0);
  });

  it("batch-created layer names ride through as names — no live resolution, no comp.info (empty-project scene build applies)", async () => {
    const harness = await makeHarness({
      // An EMPTY project: comp.info throws (no active composition) — the
      // exact live state that made create-then-animate plans unappliable.
      wrapBridge: (inner) => ({
        ...inner,
        query: async <T>(command: string, params?: unknown) => {
          if (command === "comp.info") {
            throw new Error("no active composition");
          }
          return inner.query<T>(command, params);
        },
      }),
    });
    const outcome = await harness.controller.apply(
      helloPlan({
        compiledBatch: {
          label: "Agent: kinetic intro",
          atomic: true,
          steps: [
            { command: "comp.new", params: { name: "Main", width: 1920, height: 1080 } },
            {
              command: "layer.newText",
              params: { text: "STUDIO", name: "STUDIO", position: [960, 540] },
            },
            {
              command: "prop.set",
              params: { layer: "$request:r1", path: "transform/scale", value: [100, 100] },
            },
            {
              command: "prop.set",
              params: { layer: "$request:r2", path: "transform/opacity", value: 100 },
            },
          ],
        },
        resolutionRequests: [
          { requestId: "r1", layerName: "STUDIO", disambiguation: [] },
          { requestId: "r2", layerName: "STUDIO", disambiguation: [] },
        ],
      }),
    );
    expect(outcome).toMatchObject({ ok: true, versionId: "ver_applied_1" });
    // comp.info must NEVER be hit: both requests were batch-created.
    expect(harness.recorded.queryCalls).toHaveLength(0);
    const batch = harness.recorded.executeCalls.find((c) => c.command === "engine.batch");
    expect(batch).toBeDefined();
    const steps = (batch?.params as { steps: Array<{ params: Record<string, unknown> }> }).steps;
    const scaleStep = steps[2]?.params as { layer?: unknown } | undefined;
    const opacityStep = steps[3]?.params as { layer?: unknown } | undefined;
    expect(scaleStep?.layer).toBe("STUDIO"); // name string, not the token, not an id
    expect(opacityStep?.layer).toBe("STUDIO");
    expect(JSON.stringify(steps)).not.toContain("$request:");
  });

  it("live references still resolve against the comp even when other names are batch-created", async () => {
    const harness = await makeHarness(); // comp "Main" with layer "Hello"
    const outcome = await harness.controller.apply(
      helloPlan({
        compiledBatch: {
          label: "Agent: mixed scene",
          atomic: true,
          steps: [
            {
              command: "layer.newText",
              params: { text: "New", name: "Fresh", position: [10, 10] },
            },
            {
              command: "prop.set",
              params: { layer: "$request:r1", path: "transform/opacity", value: 50 },
            },
            {
              command: "prop.set",
              params: { layer: "$request:r2", path: "transform/opacity", value: 100 },
            },
          ],
        },
        resolutionRequests: [
          { requestId: "r1", layerName: "Hello", disambiguation: [] }, // live
          { requestId: "r2", layerName: "Fresh", disambiguation: [] }, // batch-created
        ],
      }),
    );
    expect(outcome).toMatchObject({ ok: true });
    const batch = harness.recorded.executeCalls.find((c) => c.command === "engine.batch");
    const steps = (batch?.params as { steps: Array<{ params: Record<string, unknown> }> }).steps;
    const liveStep = steps[1]?.params as { layer?: unknown } | undefined;
    const deferredStep = steps[2]?.params as { layer?: unknown } | undefined;
    expect(liveStep?.layer).toBe(1); // live-resolved id of "Hello"
    expect(deferredStep?.layer).toBe("Fresh"); // deferred name
    // The wire binding only carries the live id (deferred names ride the batch).
    expect(harness.applyCalls[0]?.body.resolvedLayers).toEqual([{ requestId: "r1", layerId: 1 }]);
  });

  it("a malformed compiled batch → invalid-batch, nothing executes", async () => {
    const harness = await makeHarness();
    const outcome = await harness.controller.apply(
      helloPlan({
        compiledBatch: {
          label: "",
          atomic: true,
          steps: [],
        } as unknown as ApplicablePlan["compiledBatch"],
      }),
    );
    expect(outcome).toMatchObject({ ok: false, reason: "invalid-batch" });
    expect(harness.recorded.executeCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// apply — engine/save/gateway failures
// ---------------------------------------------------------------------------

describe("createApplyController.apply — failure mapping", () => {
  it("engine.batch rejects → engine-failed, NO save, NO applyRun", async () => {
    const harness = await makeHarness({
      failBatchWith: "step 1 (prop.set): nope; the batch was rolled back",
    });
    const before = await harness.recorded.bridge.query<{ layers?: unknown[] }>("project.summary");
    const outcome = await harness.controller.apply(helloPlan());

    expect(outcome).toMatchObject({ ok: false, reason: "engine-failed" });
    expect(harness.autosaveReasons).toEqual([]);
    expect(harness.applyCalls).toHaveLength(0);
    // Atomic rollback: nothing changed in the editor.
    const after = await harness.recorded.bridge.query<{ layers?: unknown[] }>("project.summary");
    expect(after?.layers).toEqual(before?.layers);
  });

  it("save conflict → save-conflict (the autosave parked; the gateway is not told)", async () => {
    const harness = await makeHarness({ saveOutcome: "conflict" });
    const outcome = await harness.controller.apply(helloPlan());
    expect(outcome).toMatchObject({ ok: false, reason: "save-conflict" });
    expect(harness.applyCalls).toHaveLength(0);
    expect(harness.autosaveReasons).toEqual(["agent-apply"]);
  });

  it("save error / not-dirty → save-failed (no applyRun)", async () => {
    const errorHarness = await makeHarness({ saveOutcome: "error" });
    const errorOutcome = await errorHarness.controller.apply(helloPlan());
    expect(errorOutcome).toMatchObject({ ok: false, reason: "save-failed" });
    expect(errorHarness.applyCalls).toHaveLength(0);

    const notDirtyHarness = await makeHarness({ saveOutcome: "not-dirty" });
    const notDirtyOutcome = await notDirtyHarness.controller.apply(helloPlan());
    expect(notDirtyOutcome).toMatchObject({ ok: false, reason: "save-failed" });
    expect(notDirtyHarness.applyCalls).toHaveLength(0);
  });

  it("applyRun 409 → conflict (explains; never re-applies)", async () => {
    const harness = await makeHarness({
      applyRunError: new ApiError({
        code: "VERSION_CONFLICT",
        message: "already applied",
        status: 409,
      }),
    });
    const outcome = await harness.controller.apply(helloPlan());
    expect(outcome).toMatchObject({ ok: false, reason: "conflict" });
    // The edit + version DID land; only ONE applyRun gesture happened.
    expect(harness.applyCalls).toHaveLength(1);
    expect(harness.fake.state.history.undo.at(-1)?.label).toBe("Agent: dim the headline");
  });

  it("applyRun 402 → insufficient-credits", async () => {
    const harness = await makeHarness({
      applyRunError: new ApiError({
        code: "INSUFFICIENT_CREDITS",
        message: "out of credits",
        status: 402,
      }),
    });
    const outcome = await harness.controller.apply(helloPlan());
    expect(outcome).toMatchObject({ ok: false, reason: "insufficient-credits" });
  });

  it("other applyRun failures → typed failed with the wire code", async () => {
    const harness = await makeHarness({
      applyRunError: new ApiError({
        code: "RATE_LIMITED",
        message: "slow down",
        status: 429,
      }),
    });
    const outcome = await harness.controller.apply(helloPlan());
    expect(outcome).toMatchObject({ ok: false, reason: "failed", code: "RATE_LIMITED" });
  });
});

// ---------------------------------------------------------------------------
// round-12 CLIENT-SPECIAL compiled steps (script.run / asset.importSvg) + the
// ALLOWED_COMMAND_IDS gate — pinned by the gateway plan compiler (12-w3-i3):
// run_script compiles to EXACTLY ONE {command:"script.run", params:{code}};
// add_asset to EXACTLY ONE {command:"asset.importSvg", params:{name, svg}}.
// ---------------------------------------------------------------------------

/** A client-special bridge: delegates EVERYTHING to the recorded inner bridge
 * (so calls stay in `executeCalls` in order), but answers the two convention
 * seams the fake editor does not implement (the engine's real dist does). */
function clientSpecialBridge(inner: EditorBridge): EditorBridge {
  return {
    ...inner,
    execute: async <T>(command: string, params?: unknown) => {
      if (command === "script.run") {
        try {
          return await inner.execute<T>(command, params);
        } catch {
          return { ok: true, result: "script-ran" } as T;
        }
      }
      if (command === "edit.pasteSvg") {
        try {
          return await inner.execute<T>(command, params);
        } catch {
          return { layer: 7, skipped: 0 } as T;
        }
      }
      return await inner.execute<T>(command, params);
    },
  };
}

/** A plan whose compiled batch carries ONE script.run pre-step + ONE batch step. */
function scriptPlan(): ApplicablePlan {
  return {
    runId: "run_1",
    compiledBatch: {
      label: "Agent: script it",
      atomic: true,
      steps: [
        {
          command: "script.run",
          params: { code: 'app.run("layer.newText", {text: "From script"})' },
        },
        {
          command: "prop.set",
          params: { layer: "$request:r1", path: "transform/opacity", value: 10 },
        },
      ],
    },
    resolutionRequests: [
      { requestId: "r1", layerName: "Hello", disambiguation: ["the text layer"] },
    ],
  };
}

describe("createApplyController.apply — round-12 client-special steps", () => {
  it("script.run executes via bridge BEFORE engine.batch (NOT_IN_BATCH), wrapped in ONE undo group; ONE saveNow, one applyRun", async () => {
    const harness = await makeHarness({ wrapBridge: clientSpecialBridge });
    const outcome = await harness.controller.apply(scriptPlan());

    expect(outcome).toMatchObject({ ok: true, versionId: "ver_applied_1" });

    // Execution order: the script ran FIRST, then the (script-free) batch.
    expect(harness.recorded.executeCalls.map((call) => call.command)).toEqual([
      "script.run",
      "engine.batch",
    ]);

    // The code rode wrapped in ONE labeled undo group (the engine recipe:
    // beginUndoGroup/try/finally:app.endUndoGroup), closed even on throw.
    const scriptCall = harness.recorded.executeCalls[0];
    const scriptParams = scriptCall?.params as Record<string, unknown>;
    expect(Object.keys(scriptParams)).toEqual(["code"]); // no name: the plan named none
    const code = scriptParams.code as string;
    expect(code).toContain('app.beginUndoGroup("Agent: script it");');
    expect(code).toContain('app.run("layer.newText", {text: "From script"})');
    expect(code).toContain("} finally {");
    expect(code).toContain("app.endUndoGroup();");

    // The batch carries ONLY the prop.set step — the engine refuses script.run
    // inside engine.batch (NOT_IN_BATCH), so it must never ride it.
    const batch = harness.recorded.executeCalls[1] as {
      params: { steps: Array<{ command: string }> };
    };
    expect(batch.params.steps.map((step) => step.command)).toEqual(["prop.set"]);

    // Law #6 held: ONE saveNow(agent-apply), awaited BEFORE the applyRun.
    expect(harness.timeline).toEqual(["markDirty:agent-apply", "saveNow:agent-apply", "applyRun"]);
    expect(harness.autosaveReasons).toEqual(["agent-apply"]);
    expect(harness.applyCalls).toHaveLength(1);
  });

  it("asset.importSvg maps to the engine's edit.pasteSvg string import seam, before the batch", async () => {
    const harness = await makeHarness({ wrapBridge: clientSpecialBridge });
    const outcome = await harness.controller.apply({
      runId: "run_1",
      compiledBatch: {
        label: "Agent: badge it",
        atomic: true,
        steps: [
          {
            command: "asset.importSvg",
            params: {
              name: "Badge",
              svg: '<svg xmlns="http://www.w3.org/2000/svg"><circle/></svg>',
            },
          },
          {
            command: "prop.set",
            params: { layer: "$request:r1", path: "transform/opacity", value: 10 },
          },
        ],
      },
      resolutionRequests: [
        { requestId: "r1", layerName: "Hello", disambiguation: ["the text layer"] },
      ],
    });

    expect(outcome).toMatchObject({ ok: true, versionId: "ver_applied_1" });
    expect(harness.recorded.executeCalls.map((call) => call.command)).toEqual([
      "edit.pasteSvg",
      "engine.batch",
    ]);
    // The pinned import params: the inline svg STRING + name — never a path.
    expect(harness.recorded.executeCalls[0]?.params).toEqual({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><circle/></svg>',
      name: "Badge",
    });
    // The convention id never reaches the engine verbatim.
    expect(harness.recorded.executeCalls.some((call) => call.command === "asset.importSvg")).toBe(
      false,
    );
    expect(harness.autosaveReasons).toEqual(["agent-apply"]);
  });

  it("an editor dist without the string SVG import answers the honest svg-import-unavailable; nothing else runs", async () => {
    // NO wrapBridge: the fake editor lacks edit.pasteSvg → "unknown command".
    const harness = await makeHarness();
    const outcome = await harness.controller.apply({
      runId: "run_1",
      compiledBatch: {
        label: "Agent: badge it",
        atomic: true,
        steps: [
          { command: "asset.importSvg", params: { name: "Badge", svg: "<svg><circle/></svg>" } },
          {
            command: "prop.set",
            params: { layer: "$request:r1", path: "transform/opacity", value: 10 },
          },
        ],
      },
      resolutionRequests: [
        { requestId: "r1", layerName: "Hello", disambiguation: ["the text layer"] },
      ],
    });

    expect(outcome).toMatchObject({ ok: false, reason: "svg-import-unavailable" });
    if (!outcome.ok) expect(outcome.message).toContain("SVG_IMPORT_UNAVAILABLE");

    // The gesture leaves NOTHING: only the refused import was attempted — no
    // batch, no save, no report.
    expect(harness.recorded.executeCalls.map((call) => call.command)).toEqual(["edit.pasteSvg"]);
    expect(harness.timeline).toEqual([]);
    expect(harness.applyCalls).toHaveLength(0);
    expect(harness.fake.state.dirty).toBe(true); // only the harness setup's own edit
  });

  it("F-6 widened: a DENIED catalog id in a hand-built batch is refused by the client gate; NOTHING executes", async () => {
    const harness = await makeHarness();
    // file.import is a real catalog id, deny-tagged "filesystem" (paths) —
    // outside ALLOWED_COMMAND_IDS (tier-2, packages/contracts).
    const outcome = await harness.controller.apply({
      runId: "run_1",
      compiledBatch: {
        label: "Agent: smuggle a file import",
        atomic: true,
        steps: [
          {
            command: "prop.set",
            params: { layer: "$request:r1", path: "transform/opacity", value: 10 },
          },
          { command: "file.import", params: { paths: ["/etc/hosts"] } },
        ],
      },
      resolutionRequests: [
        { requestId: "r1", layerName: "Hello", disambiguation: ["the text layer"] },
      ],
    });

    expect(outcome).toMatchObject({ ok: false, reason: "invalid-batch" });
    if (!outcome.ok) {
      expect(outcome.message).toContain('"file.import"');
      expect(outcome.message).toContain("may not run");
    }

    // Zero engine traffic, no save, no report — the gate runs FIRST.
    expect(harness.recorded.executeCalls).toEqual([]);
    expect(harness.recorded.queryCalls).toEqual([]);
    expect(harness.timeline).toEqual([]);
    expect(harness.applyCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// undo — edit.undo THEN undoRun; nothing-to-undo never reaches the gateway
// ---------------------------------------------------------------------------

describe("createApplyController.undo", () => {
  it("applies then undoes: ONE edit.undo for the whole run, then undoRun", async () => {
    const harness = await makeHarness();
    const applied = await harness.controller.apply(helloPlan());
    expect(applied.ok).toBe(true);
    harness.timeline.length = 0; // the apply milestones are asserted above

    const outcome = await harness.controller.undo("run_1");
    expect(outcome).toEqual({ ok: true, undone: true });

    // edit.undo executed; the batch's undo entry popped.
    expect(harness.recorded.executeCalls.some((call) => call.command === "edit.undo")).toBe(true);
    const undoLabels = harness.fake.state.history.undo.map((entry) => entry.label);
    expect(undoLabels).not.toContain("Agent: dim the headline");

    // The gateway heard about it, exactly once, with a gesture-fresh key.
    expect(harness.undoCalls).toHaveLength(1);
    expect(harness.undoCalls[0]?.runId).toBe("run_1");
    expect(Object.keys(harness.undoCalls[0]?.body ?? {})).toEqual(["idempotencyKey"]);
    expect(harness.timeline).toEqual(["undoRun"]);
    expect(harness.events.at(-1)?.type).toBe("undo.completed");
  });

  it("nothing to undo → {ok:false, reason:'nothing-to-undo'} and undoRun is NEVER called", async () => {
    // A fresh editor: no journaled command → the upstream can_undo guard fires.
    const fake = createFakeEditor({ comps: [{ name: "Main" }] });
    const recorded = recordBridge(attachFakeBridge(fake));
    const undoCalls: Array<{ runId: string; body: Record<string, unknown> }> = [];
    const controller = createApplyController({
      bridge: recorded.bridge,
      autosave: { saveNow: async () => ({ saved: false }) },
      api: {
        runs: {
          applyRun: async () => ({ applied: true, versionId: "ver_x", creditsCommitted: 0 }),
          undoRun: async (runId, body) => {
            undoCalls.push({ runId, body: body as Record<string, unknown> });
            return { undone: true };
          },
        },
      },
    });

    const outcome = await controller.undo("run_1");
    expect(outcome).toMatchObject({ ok: false, reason: "nothing-to-undo" });
    expect(undoCalls).toHaveLength(0);
    expect(recorded.executeCalls.some((call) => call.command === "edit.undo")).toBe(true);
  });

  it("undoRun 409 → conflict; other failures → typed failed", async () => {
    const conflictHarness = await makeHarness({
      undoRunError: new ApiError({ code: "VERSION_CONFLICT", message: "not applied", status: 409 }),
    });
    await conflictHarness.controller.apply(helloPlan());
    const conflict = await conflictHarness.controller.undo("run_1");
    expect(conflict).toMatchObject({ ok: false, reason: "conflict" });

    const failedHarness = await makeHarness({
      undoRunError: new ApiError({ code: "INTERNAL_ERROR", message: "boom", status: 500 }),
    });
    await failedHarness.controller.apply(helloPlan());
    const failed = await failedHarness.controller.undo("run_1");
    expect(failed).toMatchObject({ ok: false, reason: "failed", code: "INTERNAL_ERROR" });
  });
});

// ---------------------------------------------------------------------------
// reapply — the §M5.5 base-version gate
// ---------------------------------------------------------------------------

describe("createApplyController.reapply", () => {
  it("BLOCKED on version drift: base-version-changed, zero engine calls", async () => {
    const harness = await makeHarness({ currentVersionId: "ver_newer" });
    const outcome = await harness.controller.reapply(helloPlan({ baseVersionId: "ver_base" }));
    expect(outcome).toMatchObject({ ok: false, reason: "base-version-changed" });
    expect(harness.recorded.executeCalls).toHaveLength(0);
    expect(harness.recorded.queryCalls).toHaveLength(0);
    expect(harness.applyCalls).toHaveLength(0);
    expect(harness.events.map((event) => event.type)).toEqual(["apply.failed"]);
  });

  it("allowed while the session sits on the plan's base version", async () => {
    const harness = await makeHarness({ currentVersionId: "ver_base" });
    const outcome = await harness.controller.reapply(helloPlan({ baseVersionId: "ver_base" }));
    expect(outcome).toMatchObject({ ok: true, versionId: "ver_applied_1" });
    expect(harness.applyCalls).toHaveLength(1);
  });

  it("a plan without a base version can never reapply (unverifiable gate)", async () => {
    const harness = await makeHarness({ currentVersionId: "ver_base" });
    const outcome = await harness.controller.reapply(helloPlan());
    expect(outcome).toMatchObject({ ok: false, reason: "base-version-changed" });
    expect(harness.recorded.executeCalls).toHaveLength(0);
  });

  it("no session port → the gate always explains base-version-changed", async () => {
    const harness = await makeHarness();
    const outcome = await harness.controller.reapply(helloPlan({ baseVersionId: "ver_base" }));
    expect(outcome).toMatchObject({ ok: false, reason: "base-version-changed" });
  });
});

// ---------------------------------------------------------------------------
// Safety sweep — M4-N F-1 posture at the write boundary
// ---------------------------------------------------------------------------

describe("createApplyController — dunder/name-injection safety", () => {
  it("own __proto__ keys in plan params stay OWN data through the patch; Object.prototype untouched", async () => {
    const harness = await makeHarness();
    // JSON-parsed own dunder key (F-3: plan args ride as inert data).
    const hostileParams = JSON.parse(
      '{"__proto__": {"polluted": "PWNED"}, "nested": {"constructor": {"polluted": 2}}, "layer": "$request:r1", "path": "transform/opacity", "value": 50}',
    );
    const outcome = await harness.controller.apply(
      helloPlan({
        compiledBatch: {
          label: "Agent: hostile params",
          atomic: true,
          steps: [{ command: "prop.set", params: hostileParams }],
        },
      }),
    );
    expect(outcome.ok).toBe(true);

    const batch = harness.recorded.executeCalls.find((call) => call.command === "engine.batch")
      ?.params as { steps: Array<{ params: Record<string, unknown> }> };
    const params = batch.steps[0]?.params;
    expect(Object.hasOwn(params as object, "__proto__")).toBe(true);
    // biome-ignore lint/complexity/useLiteralKeys: dot access would invoke the __proto__ SETTER (F-1).
    expect((params as Record<string, unknown>)["__proto__"]).toEqual({ polluted: "PWNED" });
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);

    const probe: Record<string, unknown> = {};
    expect(probe.polluted).toBeUndefined();
    expect(Object.getPrototypeOf(probe).polluted).toBeUndefined();
  });

  it("dunder REQUEST ids can never touch a prototype (null-prototype accumulator)", async () => {
    const harness = await makeHarness();
    const outcome = await harness.controller.apply(
      helloPlan({
        compiledBatch: {
          label: "Agent: dunder request",
          atomic: true,
          steps: [
            {
              command: "prop.set",
              params: { layer: "$request:r1", path: "transform/opacity", value: 1 },
            },
          ],
        },
        resolutionRequests: [{ requestId: "__proto__", layerName: "Hello", disambiguation: [] }],
      }),
    );
    // The token $request:r1 is unresolved (the request id was __proto__) — typed failure.
    expect(outcome).toMatchObject({ ok: false, reason: "resolution-failed" });
    expect(harness.recorded.executeCalls).toHaveLength(0);
    expect(Object.hasOwn(Object.prototype, "r1")).toBe(false);
    expect(({} as Record<string, unknown>).r1).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Type-level pins (compile-time seam guards)
// ---------------------------------------------------------------------------

describe("apply seam type pins", () => {
  it("ApplyOutcome/UndoOutcome stay discriminated unions the UI can narrow", () => {
    const outcomes: ApplyOutcome[] = [
      { ok: true, versionId: "v" },
      { ok: false, reason: "ambiguous", candidates: [], message: "m" },
      { ok: false, reason: "not-found", layerName: "L", message: "m" },
      { ok: false, reason: "resolution-failed", message: "m" },
      { ok: false, reason: "invalid-batch", message: "m" },
      { ok: false, reason: "engine-failed", message: "m" },
      { ok: false, reason: "editor-disconnected", message: "m" },
      { ok: false, reason: "save-failed", message: "m" },
      { ok: false, reason: "save-conflict", message: "m" },
      { ok: false, reason: "conflict", message: "m" },
      { ok: false, reason: "insufficient-credits", message: "m" },
      { ok: false, reason: "base-version-changed", message: "m" },
      { ok: false, reason: "failed", message: "m", code: "X" },
    ];
    for (const outcome of outcomes) {
      if (outcome.ok) expect(outcome.versionId).toBe("v");
      else expect(outcome.message.length).toBeGreaterThan(0);
    }
    const undos: UndoOutcome[] = [
      { ok: true, undone: true },
      { ok: false, reason: "nothing-to-undo", message: "m" },
      { ok: false, reason: "engine-failed", message: "m" },
      { ok: false, reason: "editor-disconnected", message: "m" },
      { ok: false, reason: "conflict", message: "m" },
      { ok: false, reason: "failed", message: "m" },
    ];
    for (const outcome of undos) {
      if (outcome.ok) expect(outcome.undone).toBe(true);
      else expect(outcome.reason.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// w8 live-apply — applyLive: per-turn execution, no gateway report, whole-run
// undo through the multi-pop ledger (one of the reasons it exists).
// ---------------------------------------------------------------------------

describe("createApplyController.applyLive (w8)", () => {
  it("executes + saves per turn but NEVER reports applyRun (the run is still streaming)", async () => {
    const h = await makeHarness();
    const outcome = await h.controller.applyLive?.(helloPlan());
    expect(outcome?.ok).toBe(true);
    if (outcome?.ok !== true) throw new Error("live apply failed");
    // The batch ran and a version saved — the work persists immediately.
    expect(
      h.recorded.executeCalls.some(
        (call) => call.command === "engine.batch" && call.params != null,
      ),
    ).toBe(true);
    expect(h.autosaveReasons).toContain("agent-apply");
    expect(outcome.versionId).toMatch(/^ver_applied_/);
    // THE defining property: the gateway's run-keyed report NEVER fired.
    expect(h.applyCalls).toHaveLength(0);
    // apply.completed rides the batch so the host reveals + plays the canvas.
    const completed = h.events.find((event) => event.type === "apply.completed");
    expect(completed).toBeDefined();
    expect(completed?.type === "apply.completed" && completed.batch?.label).toBe(
      "Agent: dim the headline",
    );
  });

  it("two turns: each saves its own version; undo pops BOTH top-first and skips undoRun", async () => {
    const h = await makeHarness();
    const first = await h.controller.applyLive?.(helloPlan({ runId: "run_live" }));
    expect(first?.ok).toBe(true);
    const second = await h.controller.applyLive?.(
      helloPlan({
        runId: "run_live",
        compiledBatch: {
          label: "Agent: nudge the headline",
          atomic: true,
          steps: [
            { command: "prop.set", params: { layer: "$request:r1", path: "transform/position", value: [120, 0] } },
          ],
        },
      }),
    );
    expect(second?.ok).toBe(true);
    // Two versions saved — nothing is ever rebuilt.
    expect(h.autosaveReasons.filter((reason) => reason === "agent-apply")).toHaveLength(2);
    // Undo reverts the WHOLE run through the multi-pop ledger, label-verified.
    const undone = await h.controller.undo("run_live", {
      batchLabel: "Agent: nudge the headline",
    });
    expect(undone.ok).toBe(true);
    // Never told the gateway — the run was never reported applied.
    expect(h.undoCalls).toHaveLength(0);
    expect(h.autosaveReasons.filter((reason) => reason === "agent-apply")).toHaveLength(3);
    const undoDone = h.events.at(-1);
    expect(undoDone?.type).toBe("undo.completed");
  });

  it("a live save failure keeps the batchApplied vocabulary (the edit is in the editor only)", async () => {
    const h = await makeHarness({ saveOutcome: "error" });
    const outcome = await h.controller.applyLive?.(helloPlan());
    expect(outcome).toMatchObject({ ok: false, reason: "save-failed", batchApplied: true });
    expect(h.applyCalls).toHaveLength(0);
  });
});
