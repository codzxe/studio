/**
 * read-only.test — the M7 client read-only gate (BUILD_PLAN §M7 task 3;
 * DECISIONS.md D-23): mutations die LOCALLY with the typed LEASE_HELD
 * outcome and never reach the engine; reads/inspects pass; the gate flips
 * live; the mutation-classification mirror is pinned.
 *
 * REAL bridge stack: `createFakeEditor` + `attachFakeBridge` (the same
 * zod-validating adapter production code talks to). Only the gate is
 * constructed here — no DOM, no network, deterministic.
 */

import {
  LEASE_HELD_ERROR_CODE,
  RAW_ENGINE_MUTATION_IDS,
  ReadOnlyLeaseError,
  createReadOnlyGate,
  isMutatingBridgeExecute,
  isMutatingBridgeRequestMethod,
  isReadOnlyLeaseError,
  wrapReadOnlyBridge,
} from "@/lib/editor-session";
import type { EditorBridge } from "@studio/editor-bridge";
import { BridgeError } from "@studio/editor-bridge";
import { attachFakeBridge, createFakeEditor } from "@studio/editor-bridge/fake";
import { describe, expect, it } from "vitest";

function layeredBridge(): { bridge: EditorBridge; layerCount: () => number } {
  const fake = createFakeEditor({ comps: [{ name: "Main" }] });
  const bridge = attachFakeBridge(fake);
  return {
    bridge,
    layerCount: () => fake.state.project.layers.length,
  };
}

async function rejectsLeaseHeld(promise: Promise<unknown>): Promise<ReadOnlyLeaseError> {
  try {
    await promise;
  } catch (error) {
    expect(isReadOnlyLeaseError(error)).toBe(true);
    return error as ReadOnlyLeaseError;
  }
  throw new Error("expected the call to reject");
}

describe("read-only gate — the typed LEASE_HELD outcome", () => {
  it("LEASE_HELD_ERROR_CODE mirrors the wire code and RAW_ENGINE_MUTATION_IDS mirrors the client classifications", () => {
    // The wire code (contracts routes/leases.ts) — the gateway's 409 answers
    // carry exactly this string.
    expect(LEASE_HELD_ERROR_CODE).toBe("LEASE_HELD");
    // The named mirror of tool-executor's RAW_ENGINE_TOOL_IDS + apply's seam.
    expect([...RAW_ENGINE_MUTATION_IDS]).toEqual([
      "engine.batch",
      "engine.execute",
      "edit.undo",
      "edit.redo",
    ]);
  });

  it("ReadOnlyLeaseError carries the holder NAME (never an id) and the catalog copy", () => {
    const error = new ReadOnlyLeaseError("Alex");
    expect(error.code).toBe("LEASE_HELD");
    expect(error.holderName).toBe("Alex");
    expect(error.message).toBe("Alex is editing this project right now.");
    const custom = new ReadOnlyLeaseError("Dana Flow", "custom copy");
    expect(custom.message).toBe("custom copy");
  });

  it("isReadOnlyLeaseError accepts only the typed rejection", () => {
    expect(isReadOnlyLeaseError(new ReadOnlyLeaseError("Alex"))).toBe(true);
    expect(isReadOnlyLeaseError(new BridgeError("EDITOR_CALL_FAILED", "x"))).toBe(false);
    expect(isReadOnlyLeaseError(new Error("LEASE_HELD"))).toBe(false);
    expect(isReadOnlyLeaseError("LEASE_HELD")).toBe(false);
    expect(isReadOnlyLeaseError(undefined)).toBe(false);
  });

  it("the gate view + update: last write wins, names optional", () => {
    const handle = createReadOnlyGate();
    expect(handle.gate.isBlocked()).toBe(false);
    expect(handle.gate.holderName()).toBeNull();
    handle.update(true, "Alex");
    expect(handle.gate.isBlocked()).toBe(true);
    expect(handle.gate.holderName()).toBe("Alex");
    handle.update(true, null); // blocked, holder unknown
    expect(handle.gate.holderName()).toBeNull();
    handle.update(false, "Alex");
    expect(handle.gate.isBlocked()).toBe(false);
  });

  it("isMutatingBridgeExecute: the journaled seam classifies EVERY id as a mutation", () => {
    // Reads never ride execute (query! ids go through query/request); the
    // seam-level rule means no per-command list can drift.
    for (const command of ["layer.newText", "engine.batch", "edit.undo", "edit.redo", ""]) {
      expect(isMutatingBridgeExecute(command)).toBe(true);
    }
  });

  it("isMutatingBridgeRequestMethod: only the raw engine mutation transport blocks", () => {
    expect(isMutatingBridgeRequestMethod("engine.execute")).toBe(true);
    expect(isMutatingBridgeRequestMethod("engine.batch")).toBe(true);
    expect(isMutatingBridgeRequestMethod("edit.undo")).toBe(true);
    expect(isMutatingBridgeRequestMethod("render.frame")).toBe(false);
    expect(isMutatingBridgeRequestMethod("ui.click")).toBe(false);
    expect(isMutatingBridgeRequestMethod("ui.playback")).toBe(false);
  });
});

describe("read-only gate — wrapReadOnlyBridge", () => {
  it("unblocked: mutations reach the engine and change its state", async () => {
    const { bridge, layerCount } = layeredBridge();
    const wrapped = wrapReadOnlyBridge(bridge, createReadOnlyGate().gate);
    const before = layerCount();
    await wrapped.execute("layer.newText", { text: "Hello" });
    expect(layerCount()).toBe(before + 1);
    expect(wrapped.version()).toBe(bridge.version());
  });

  it("blocked: execute() rejects LOCALLY — the engine state never changes", async () => {
    const { bridge, layerCount } = layeredBridge();
    const handle = createReadOnlyGate();
    const wrapped = wrapReadOnlyBridge(bridge, handle.gate);
    handle.update(true, "Alex");

    const before = layerCount();
    const error = await rejectsLeaseHeld(wrapped.execute("layer.newText", { text: "Nope" }));
    expect(error.message).toBe("Alex is editing this project right now.");
    expect(layerCount()).toBe(before); // never reached the engine
  });

  it("blocked: the engine.batch envelope (execute seam + batch member) is refused both ways", async () => {
    const { bridge, layerCount } = layeredBridge();
    const handle = createReadOnlyGate();
    const wrapped = wrapReadOnlyBridge(bridge, handle.gate);
    handle.update(true, "Dana Flow");

    const before = layerCount();
    await rejectsLeaseHeld(
      wrapped.execute("engine.batch", {
        label: "Agent: x",
        atomic: true,
        steps: [{ command: "layer.newText", params: { text: "Nope" } }],
      }),
    );
    await rejectsLeaseHeld(
      wrapped.batch({
        label: "Agent: x",
        atomic: true,
        steps: [{ command: "layer.newText", params: { text: "Nope" } }],
      }),
    );
    expect(layerCount()).toBe(before);
  });

  it("blocked: edit.undo / edit.redo (state mutations) are refused", async () => {
    const { bridge, layerCount } = layeredBridge();
    const handle = createReadOnlyGate();
    const wrapped = wrapReadOnlyBridge(bridge, handle.gate);
    await wrapped.execute("layer.newText", { text: "Seed" }); // journaled: an undo entry
    handle.update(true, "Alex");
    await rejectsLeaseHeld(wrapped.execute("edit.undo"));
    await rejectsLeaseHeld(wrapped.execute("edit.redo"));
    expect(layerCount()).toBe(1); // the undo never ran
  });

  it("blocked: request() refuses the raw engine mutation transport but passes control reads", async () => {
    const { bridge } = layeredBridge();
    const handle = createReadOnlyGate();
    const wrapped = wrapReadOnlyBridge(bridge, handle.gate);
    handle.update(true, "Alex");
    await rejectsLeaseHeld(
      wrapped.request("engine.execute", { command: "layer.newText", params: {} }),
    );
    await rejectsLeaseHeld(
      wrapped.request("engine.batch", {
        label: "Agent: x",
        atomic: true,
        steps: [{ command: "layer.newText", params: {} }],
      }),
    );
    // render.frame rides the request seam and is a read — it passes.
    await expect(
      wrapped.request("render.frame", { comp: "Main", base64: true }),
    ).resolves.toBeDefined();
    // Documented §9.3 posture: control methods pass the gate (the editor
    // iframe stays interactive). `ui.playback` resolves on the fake; `ui.click`
    // the fake itself rejects as unknown — either way the refusal is NOT the
    // gate's (no ReadOnlyLeaseError), which is what the posture pins.
    await expect(wrapped.request("ui.playback", { playing: false })).resolves.toBeDefined();
    await wrapped.request("ui.click", { panel: "Timeline" }).then(
      () => undefined,
      (error: unknown) => {
        expect(isReadOnlyLeaseError(error)).toBe(false);
      },
    );
  });

  it("blocked: saveToBrowser (the autosave write path) is refused", async () => {
    const { bridge } = layeredBridge();
    const handle = createReadOnlyGate();
    const wrapped = wrapReadOnlyBridge(bridge, handle.gate);
    handle.update(true, "Alex");
    await rejectsLeaseHeld(wrapped.saveToBrowser("project.ecproj"));
  });

  it("blocked (D-23): reads + inspects all pass — the chat/proposal surface stays alive", async () => {
    const { bridge } = layeredBridge();
    const handle = createReadOnlyGate();
    const wrapped = wrapReadOnlyBridge(bridge, handle.gate);
    await wrapped.execute("layer.newText", { text: "Hello" }); // seed while unblocked
    handle.update(true, "Alex");

    // The read tools' seam (tool-executor.ts) + the agent context collects.
    await expect(wrapped.query("project.summary", {})).resolves.toBeDefined();
    await expect(wrapped.query("comp.info", {})).resolves.toBeDefined();
    await expect(wrapped.query("layer.tree", { layer: 1, depth: 1 })).resolves.toBeDefined();
    await expect(
      wrapped.query("prop.get", { layer: 1, path: "transform/opacity" }),
    ).resolves.toBeDefined();
    await expect(wrapped.inspect()).resolves.toEqual(
      expect.objectContaining({ window: [expect.any(Number), expect.any(Number)] }),
    );
    await expect(wrapped.commands()).resolves.toBeInstanceOf(Array);
    await expect(wrapped.describe("layer.newText")).resolves.toEqual(
      expect.objectContaining({ command: "layer.newText" }),
    );
    await expect(wrapped.renderFrame({ comp: "Main" })).resolves.toEqual(
      expect.objectContaining({ pngBase64: expect.any(String) }),
    );
    await expect(wrapped.screenshot({})).resolves.toEqual(
      expect.objectContaining({ pngBase64: expect.any(String) }),
    );
    await expect(wrapped.addFile(new Blob(["x"]), "note.txt")).resolves.toBeTypeOf("string");
    await expect(
      wrapped.addAsset({ assetId: "ast_1", name: "logo.png", bytes: new Blob(["y"]) }),
    ).resolves.toBeTypeOf("string");
    await expect(wrapped.info()).toEqual(expect.objectContaining({ version: expect.any(String) }));
    expect(wrapped.version()).toBeTypeOf("string");
    await expect(wrapped.capabilities()).resolves.toBeDefined();
  });

  it("the SAME wrapper flips live with the gate (identity is call-time, not mount-time)", async () => {
    const { bridge, layerCount } = layeredBridge();
    const handle = createReadOnlyGate();
    const wrapped = wrapReadOnlyBridge(bridge, handle.gate);

    handle.update(true, "Alex");
    const before = layerCount();
    await rejectsLeaseHeld(wrapped.execute("layer.newText", { text: "Nope" }));

    handle.update(false, null); // the holder released — the poll flips the gate
    await wrapped.execute("layer.newText", { text: "Yes" });
    expect(layerCount()).toBe(before + 1);

    handle.update(true, "Dana Flow"); // another holder appeared
    await rejectsLeaseHeld(wrapped.execute("layer.newText", { text: "Nope again" }));
  });

  it("dispose forwards to the wrapped bridge (the host owns exactly one lifecycle)", async () => {
    const { bridge } = layeredBridge();
    const wrapped = wrapReadOnlyBridge(bridge, createReadOnlyGate().gate);
    wrapped.dispose();
    await expect(wrapped.inspect()).rejects.toMatchObject({ code: "EDITOR_DISCONNECTED" });
  });
});
