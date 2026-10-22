/**
 * Fake editor tests: the deterministic in-memory surface — project commands,
 * batch atomicity + one-undo-step semantics, history, files, determinism —
 * plus `attachFakeBridge` end-to-end.
 */

import { describe, expect, it } from "vitest";
import { attachFakeBridge } from "../src/attachFake";
import { BridgeError } from "../src/errors";
import { FAKE_PNG_BASE64, type FakeEditor, createFakeEditor, fakePathFor } from "../src/fake";
import type { LayerNode, ProjectSummary } from "../src/types";

async function rejects(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e,
  );
}

// ---------------------------------------------------------------------------
// Project commands
// ---------------------------------------------------------------------------

describe("fake editor: comp / layer / prop commands", () => {
  it("comp.new creates a unique default-named comp and opens it", async () => {
    const fake = createFakeEditor();
    const a = (await fake.execute("comp.new", {})) as { comp: number };
    const b = (await fake.execute("comp.new", { name: "Spot" })) as { comp: number };
    expect(a.comp).toBe(1);
    expect(b.comp).toBe(2);
    expect(fake.state.project.comps.map((c) => c.name)).toEqual(["Comp 1", "Spot"]);
    expect(fake.state.activeComp).toBe(2);

    const dup = (await fake.execute("comp.new", { name: "Spot" })) as { comp: number };
    expect(fake.state.project.comps[2]?.name).toBe("Spot 2");
    expect(dup.comp).toBe(3);
  });

  it("comp.new honors width/height/duration/frameRate", async () => {
    const fake = createFakeEditor();
    await fake.execute("comp.new", {
      name: "HD",
      width: 1280,
      height: 720,
      duration: 5,
      frameRate: 25,
    });
    const comp = fake.state.project.comps[0];
    expect(comp).toMatchObject({ width: 1280, height: 720, duration: 5, frameRate: 25 });
  });

  it("comp.new → layer.newSolid → prop.set → layer.tree reflects the changes", async () => {
    const fake = createFakeEditor();
    const comp = (await fake.execute("comp.new", { name: "Main" })) as { comp: number };
    const solid = (await fake.execute("layer.newSolid", {
      name: "Background",
      color: "#0B0D10",
    })) as { layer: number };
    await fake.execute("prop.set", {
      layer: solid.layer,
      path: "transform/opacity",
      value: 40,
    });
    await fake.execute("layer.rename", { layer: solid.layer, name: "BG" });

    const tree = (await fake.execute("layer.tree", { layer: solid.layer })) as LayerNode;
    expect(tree.id).toBe(solid.layer);
    expect(tree.name).toBe("BG");
    expect(tree.type).toBe("solid");
    const children = (tree.properties?.children ?? []) as Array<{
      path: string;
      value: unknown;
      type: string;
    }>;
    const opacity = children.find((c) => c.path === "transform/opacity");
    expect(opacity?.value).toBe(40);
    const color = children.find((c) => c.path === "solid/color");
    expect(color?.value).toBe("#0B0D10");
    expect(children.find((c) => c.path === "transform/position")?.value).toEqual([
      1920 / 2,
      1080 / 2,
      0,
    ]);
    expect(comp.comp).toBe(1);

    const info = (await fake.execute("comp.info", {})) as {
      layers: Array<{ id: number; index: number; name: string }>;
    };
    expect(info.layers.map((l) => ({ id: l.id, index: l.index, name: l.name }))).toEqual([
      { id: solid.layer, index: 1, name: "BG" },
    ]);

    const prop = (await fake.execute("prop.get", {
      layer: solid.layer,
      path: "transform/opacity",
    })) as { value: unknown; animated: boolean };
    expect(prop.value).toBe(40);
    expect(prop.animated).toBe(false);
  });

  it("layer.newText seeds the source text and names the layer from it", async () => {
    const fake = createFakeEditor();
    await fake.execute("comp.new", {});
    const text = (await fake.execute("layer.newText", { text: "Hello" })) as { layer: number };
    const layer = fake.state.project.layers.find((l) => l.id === text.layer);
    expect(layer?.name).toBe("Hello");
    expect(layer?.kind).toBe("text");
    expect(layer?.props["text/sourceText"]?.value).toBe("Hello");
  });

  it("new layers are selected and stack at the top (index 1)", async () => {
    const fake = createFakeEditor();
    await fake.execute("comp.new", {});
    const first = (await fake.execute("layer.newSolid", {})) as { layer: number };
    const second = (await fake.execute("layer.newSolid", {})) as { layer: number };
    expect(fake.state.selectedLayers).toEqual([second.layer]);
    const info = (await fake.execute("comp.info", {})) as {
      layers: Array<{ index: number; id: number }>;
    };
    expect(info.layers.map((l) => [l.index, l.id])).toEqual([
      [1, second.layer],
      [2, first.layer],
    ]);
  });

  it("rejects edits without a comp/selection like upstream", async () => {
    const fake = createFakeEditor();
    const undoEmpty = await rejects(fake.execute("edit.undo", {})); // nothing has happened yet
    expect(String(undoEmpty)).toContain("edit.undo");
    expect(String(undoEmpty)).toContain("nothing to undo");

    const noComp = await rejects(fake.execute("layer.newSolid", {}));
    expect(String(noComp)).toContain("no composition is open");

    await fake.execute("comp.new", {});
    const noLayer = await rejects(
      fake.execute("prop.set", { path: "transform/opacity", value: 1 }),
    );
    expect(String(noLayer)).toContain("select a layer first");

    const unknown = await rejects(fake.execute("nope.command", {}));
    expect(String(unknown)).toContain("unknown command `nope.command`");
  });

  it("prop.set with a time records a keyframe; prop.get reports it", async () => {
    const fake = createFakeEditor();
    await fake.execute("comp.new", {});
    const solid = (await fake.execute("layer.newSolid", {})) as { layer: number };
    await fake.execute("prop.set", {
      layer: solid.layer,
      path: "transform/opacity",
      value: 0,
      time: 0,
    });
    await fake.execute("prop.set", {
      layer: solid.layer,
      path: "transform/opacity",
      value: 100,
      time: 1,
    });
    const prop = (await fake.execute("prop.get", {
      layer: solid.layer,
      path: "transform/opacity",
    })) as { animated: boolean; keys: Array<{ time: number; value: unknown }> };
    expect(prop.animated).toBe(true);
    expect(prop.keys).toEqual([
      { time: 0, value: 0, in: "Linear", out: "Linear" },
      { time: 1, value: 100, in: "Linear", out: "Linear" },
    ]);
    expect(fake.state.project.keyframes).toEqual([
      { layerId: solid.layer, path: "transform/opacity", time: 0, value: 0 },
      { layerId: solid.layer, path: "transform/opacity", time: 1, value: 100 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// engine.batch: references, atomicity, one undo step
// ---------------------------------------------------------------------------

describe("fake editor: engine.batch", () => {
  it("runs $N-referenced steps and folds into ONE undo step", async () => {
    const fake = createFakeEditor();
    await fake.execute("comp.new", { name: "B" });
    const undoBefore = fake.state.history.undo.length;

    const result = (await fake.execute("engine.batch", {
      label: "Build",
      steps: [
        { command: "layer.newSolid", params: { name: "Box", color: "#ff0000" } },
        {
          command: "prop.set",
          params: { layer: "$1.layer", path: "transform/opacity", value: 40 },
        },
        { command: "layer.rename", params: { layer: "$1.layer", name: "Red Box" } },
      ],
    })) as { steps: number; results: Array<{ layer?: number }> };

    expect(result.steps).toBe(3);
    const layerId = result.results[0]?.layer;
    const layer = fake.state.project.layers.find((l) => l.id === layerId);
    expect(layer?.name).toBe("Red Box");
    expect(layer?.props["transform/opacity"]?.value).toBe(40);
    expect(fake.state.history.undo.length).toBe(undoBefore + 1);
    expect(fake.state.history.undo.at(-1)?.label).toBe("Build");

    // ONE edit.undo reverts the whole batch
    const undone = (await fake.execute("edit.undo", {})) as { undone: string | null };
    expect(undone.undone).toBe("Build");
    expect(fake.state.project.layers).toEqual([]);
    expect(fake.state.history.undo.length).toBe(undoBefore);

    const redone = (await fake.execute("edit.redo", {})) as { redone: string | null };
    expect(redone.redone).toBe("Build");
    expect(fake.state.project.layers.length).toBe(1);
  });

  it("a failing atomic step rolls everything back and names the step", async () => {
    const fake = createFakeEditor();
    await fake.execute("comp.new", {});
    await fake.execute("layer.newSolid", {});
    const before = fake.state.project.layers.length;
    const undoBefore = fake.state.history.undo.length;

    const err = await rejects(
      fake.execute("engine.batch", {
        steps: [
          { command: "layer.newText", params: { text: "x" } },
          { command: "prop.set", params: { layer: "$1.layer", path: "transform/nope", value: 1 } },
        ],
      }),
    );
    expect(String(err).startsWith("step 2 (prop.set):")).toBe(true);
    expect(String(err)).toContain("rolled back (nothing changed)");
    expect(fake.state.project.layers.length).toBe(before); // nothing changed
    expect(fake.state.history.undo.length).toBe(undoBefore); // no undo entry for the batch

    // the rolled-back batch left no undo entry: undoing still reverts the
    // PREVIOUS step, not the batch
    const undone = (await fake.execute("edit.undo", {})) as { undone: string | null };
    expect(undone.undone).toBe("New Solid");
  });

  it("a bad $N reference is reported with the step count", async () => {
    const fake = createFakeEditor();
    await fake.execute("comp.new", {});
    const err = await rejects(
      fake.execute("engine.batch", {
        steps: [{ command: "layer.rename", params: { layer: "$3.layer", name: "x" } }],
      }),
    );
    expect(String(err)).toContain("refers to step 3");
    expect(String(err)).toContain("rolled back");
  });

  it("engine.batch cannot nest itself; a step missing its command is rejected", async () => {
    const fake = createFakeEditor();
    await fake.execute("comp.new", {});
    const nested = await rejects(
      fake.execute("engine.batch", { steps: [{ command: "engine.batch", params: {} }] }),
    );
    expect(String(nested)).toContain("can't run inside a batch");

    const missing = await rejects(fake.execute("engine.batch", { steps: [{}] }));
    expect(String(missing)).toContain("each step needs `command`");
  });

  it("non-atomic batches keep the applied steps (direct engine.execute)", async () => {
    const fake = createFakeEditor();
    await fake.execute("comp.new", {});
    const err = await rejects(
      fake.execute("engine.batch", {
        label: "Partial",
        atomic: false,
        steps: [
          { command: "layer.newSolid", params: {} },
          { command: "prop.set", params: { layer: "$1.layer", path: "nope", value: 1 } },
        ],
      }),
    );
    expect(String(err)).toContain("steps 1–1 were applied");
    expect(fake.state.project.layers.length).toBe(1); // the solid stayed
    expect(fake.state.history.undo.at(-1)?.label).toBe("Partial"); // one entry
  });
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

describe("fake editor: history", () => {
  it("edit.history.list walks states; undo/redo move the current marker", async () => {
    const fake = createFakeEditor();
    const empty = (await fake.execute("edit.history.list", {})) as {
      states: Array<{ index: number; label: string; current: boolean }>;
      current: number;
      branches: number;
    };
    expect(empty.states).toEqual([
      {
        index: 0,
        id: "s0",
        label: "Original",
        parent: null,
        depth: 0,
        current: true,
        line: true,
        future: false,
      },
    ]);
    expect(empty.current).toBe(0);
    expect(empty.branches).toBe(0);

    await fake.execute("comp.new", {});
    await fake.execute("layer.newSolid", {});
    const afterTwo = (await fake.execute("edit.history.list", {})) as {
      states: Array<{ index: number; label: string; current: boolean; future: boolean }>;
      current: number;
    };
    expect(afterTwo.states.map((s) => s.label)).toEqual([
      "Original",
      "New Composition",
      "New Solid",
    ]);
    expect(afterTwo.current).toBe(2);

    await fake.execute("edit.undo", {});
    const afterUndo = (await fake.execute("edit.history.list", {})) as {
      states: Array<{ index: number; label: string; current: boolean; future: boolean }>;
      current: number;
    };
    expect(afterUndo.current).toBe(1);
    expect(afterUndo.states[2]?.future).toBe(true);
    expect(afterUndo.states[1]?.current).toBe(true);
  });

  it("project.summary reports the undo labels and editor.state mirrors selection", async () => {
    const fake = createFakeEditor();
    await fake.execute("comp.new", { name: "S" });
    const solid = (await fake.execute("layer.newSolid", {})) as { layer: number };
    const summary = (await fake.execute("project.summary", {})) as ProjectSummary;
    expect(summary.items).toEqual([
      expect.objectContaining({ id: 1, name: "S", type: "Composition", layers: 1 }),
    ]);
    expect(summary.undo).toEqual(["New Composition", "New Solid"]);
    expect(summary.selectedLayers).toEqual([solid.layer]);
    expect(summary.dirty).toBe(true);

    const state = (await fake.execute("editor.state", {})) as {
      active_comp: number | null;
      selected_layers: number[];
      project_selection: number[];
    };
    expect(state.active_comp).toBe(1);
    expect(state.selected_layers).toEqual([solid.layer]);
    expect(state.project_selection).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// Files: addFile / readFile / saveToBrowser round-trip
// ---------------------------------------------------------------------------

describe("fake editor: file table", () => {
  it("path_for keeps only the last path segment (files.rs)", () => {
    expect(fakePathFor("/assets/abc123/photo.png")).toBe("/photo.png");
    expect(fakePathFor("C:\\\\thing\\\\clip.mp4")).toBe("/clip.mp4");
    expect(fakePathFor("name.ecproj")).toBe("/name.ecproj");
  });

  it("addFile stores bytes under the basename; readFile returns them", async () => {
    const fake = createFakeEditor();
    const path = await fake.addFile(
      new Blob(["hello"], { type: "text/plain" }),
      "assets/intro.txt",
    );
    expect(path).toBe("/intro.txt");
    const bytes = fake.readFile("/intro.txt");
    expect(bytes && new TextDecoder().decode(bytes)).toBe("hello");
    expect(fake.files()).toEqual([{ path: "/intro.txt", size: 5 }]);
    expect(fake.readFile("/missing")).toBeUndefined();
  });

  it("saveToBrowser → readFile → addFile restores the project", async () => {
    const fake = createFakeEditor();
    await fake.execute("comp.new", { name: "Cloud" });
    await fake.execute("layer.newSolid", { name: "Bg" });

    const saved = (await fake.saveToBrowser("/cloud/project.ecproj")) as {
      path: string;
      bytes: number;
    };
    expect(saved.path).toBe("/cloud/project.ecproj");
    expect(saved.bytes).toBeGreaterThan(0);
    expect(fake.state.dirty).toBe(false);
    expect(fake.state.projectPath).toBe("/cloud/project.ecproj");

    // simulate a reload: a fresh editor loads the saved bytes
    const reloaded = createFakeEditor();
    const bytes = fake.readFile("/cloud/project.ecproj");
    expect(bytes).toBeDefined();
    const copy = bytes === undefined ? new Uint8Array(0) : new Uint8Array(bytes);
    const path = await reloaded.addFile(new Blob([copy]), "/cloud/project.ecproj");
    expect(path).toBe("/project.ecproj");
    expect(reloaded.state.project.comps.map((c) => c.name)).toEqual(["Cloud"]);
    expect(reloaded.state.project.layers.map((l) => l.name)).toEqual(["Bg"]);
    expect(reloaded.state.projectPath).toBe("/project.ecproj");
    expect(reloaded.state.history.undo).toEqual([]); // loading resets history
  });

  it("removeStored / listStored / flush", async () => {
    const fake = createFakeEditor();
    await fake.addFile(new Blob(["abc"]), "f.txt");
    const stored = (await fake.listStored()) as {
      files: Array<{ path: string; size: number; modified: number }>;
    };
    expect(stored.files).toEqual([{ path: "/f.txt", size: 3, modified: 0 }]);
    expect(fake.removeStored("/f.txt")).toBe(true);
    expect(fake.removeStored("/f.txt")).toBe(false);
    await expect(fake.flush()).resolves.toBe(undefined);
  });

  it("renderFrame returns the 1×1 stub; max_side caps the reported size; path writes a file", async () => {
    const fake = createFakeEditor();
    await fake.execute("comp.new", { name: "A", width: 1920, height: 1080 });
    const frame = (await fake.renderFrame({ time: 2 })) as {
      comp: number;
      time: number;
      width: number;
      height: number;
      png: string;
    };
    expect(frame).toEqual({ comp: 1, time: 2, width: 1920, height: 1080, png: FAKE_PNG_BASE64 });

    const small = (await fake.renderFrame({ max_side: 480 })) as { width: number; height: number };
    expect(small.width).toBe(480);
    expect(small.height).toBe(270);

    const withPath = (await fake.request("render.frame", {
      base64: false,
      path: "/out/frame.png",
    })) as { path: string };
    expect(withPath.path).toBe("/out/frame.png");
    expect(fake.readFile("/out/frame.png")).toBeDefined();

    const shot = (await fake.screenshot({})) as { png: string; width: number; height: number };
    expect(shot.png).toBe(FAKE_PNG_BASE64);
    expect(shot.width).toBe(1280);
  });
});

// ---------------------------------------------------------------------------
// Registry, info, script, determinism
// ---------------------------------------------------------------------------

describe("fake editor: registry / info / script / determinism", () => {
  it("commands() lists the registry with upstream labels; describe() gives a JSON Schema", async () => {
    const fake = createFakeEditor();
    const all = (await fake.commands()) as Array<{
      id: string;
      label: string;
      menu: string[];
      shortcut: string | null;
      enabled: boolean;
    }>;
    expect(all.find((c) => c.id === "comp.new")).toMatchObject({
      label: "New Composition...",
      menu: ["Composition"],
      shortcut: "Cmd+N",
    });
    expect(all.find((c) => c.id === "engine.batch")?.label).toBe("Run Commands (Batch)");
    expect(all.find((c) => c.id === "edit.history.list")?.label).toBe("History");

    const filtered = (await fake.request("engine.commands", { filter: "solid" })) as Array<{
      id: string;
    }>;
    expect(filtered.map((c) => c.id)).toEqual(["layer.newSolid"]);

    const desc = (await fake.execute("command.describe", { command: "layer.rename" })) as {
      id: string;
      schema: { type: string; required: string[] };
      undoable: boolean;
    };
    expect(desc.id).toBe("layer.rename");
    expect(desc.schema.type).toBe("object");
    expect(desc.schema.required).toEqual(["name"]);
    expect(desc.undoable).toBe(true);

    const bad = await rejects(fake.execute("command.describe", { command: "nope" }));
    expect(String(bad)).toContain("unknown command `nope`");
  });

  it("info() carries the version and load timings; capabilities() reports counts", async () => {
    const fake = createFakeEditor({ version: "9.9.9-test" });
    const info = fake.info() as { version: string; load: { readyMs: number } };
    expect(info.version).toBe("9.9.9-test");
    expect(info.load.readyMs).toBe(64);
    const caps = (await fake.execute("app.capabilities", {})) as {
      version: string;
      commands: number;
      parity: { target: string };
    };
    expect(caps.version).toBe("9.9.9-test");
    expect(caps.commands).toBeGreaterThan(15);
    expect(caps.parity.target).toBe("Adobe After Effects 2026");
  });

  it("ui.inspect reports window size, playhead, playback, selection and focused panel", async () => {
    const fake = createFakeEditor({ windowSize: [800, 600], playhead: 3.5, playing: true });
    await fake.execute("comp.new", {});
    await fake.execute("layer.newSolid", {});
    const ui = (await fake.inspect()) as Record<string, unknown>;
    expect(ui.window).toEqual([800, 600]);
    expect(ui.playing).toBe(true);
    expect(ui.time).toBe(3.5);
    expect(ui.focused).toBeUndefined();
    expect((ui.ui as { focused: string }).focused).toBe("Viewer");
    expect(ui.selectedLayers).toEqual([1]);
    expect(ui.activeComp).toBe(1);
  });

  it("script() runs steps deterministically and collects errors", async () => {
    const fake = createFakeEditor();
    const results = await fake.script([
      ["comp.new", { name: "A" }],
      ["layer.newSolid", { name: "S" }],
      ["nope.command", {}],
      ["comp.new", { name: "B" }],
    ]);
    expect(results.map((r) => r.ok)).toEqual([true, true, false]);
    expect(results[2]?.error).toContain("unknown command `nope.command`");

    const all = await fake.script(
      [
        ["comp.new", { name: "A" }],
        ["nope.command", {}],
      ],
      { continueOnError: true },
    );
    expect(all.map((r) => r.ok)).toEqual([true, false]);
  });

  it("two fresh fakes evolve identically (determinism) and reset() restores seed state", async () => {
    const run = async (fake: FakeEditor): Promise<unknown> => {
      await fake.execute("comp.new", { name: "X" });
      await fake.execute("layer.newText", { text: "Hi" });
      await fake.execute("engine.batch", {
        label: "L",
        steps: [{ command: "layer.newSolid", params: {} }],
      });
      await fake.saveToBrowser("/p.ecproj");
      return {
        project: fake.state.project,
        history: fake.state.history,
        files: fake.files(),
        info: fake.info(),
      };
    };
    const a = await run(createFakeEditor());
    const b = await run(createFakeEditor());
    expect(a).toEqual(b);

    const fake = createFakeEditor({ comps: [{ name: "Seed" }] });
    await fake.execute("comp.new", {});
    fake.reset();
    expect(fake.state.project.comps.map((c) => c.name)).toEqual(["Seed"]);
    expect(fake.state.activeComp).toBe(1);
    expect(fake.state.history.undo).toEqual([]);
  });

  it("seeds comps from overrides", () => {
    const fake = createFakeEditor({
      comps: [
        { name: "Main", width: 1080, height: 1080 },
        { name: "Loop", duration: 2 },
      ],
    });
    expect(fake.state.project.comps).toEqual([
      {
        id: 1,
        name: "Main",
        width: 1080,
        height: 1080,
        duration: 10,
        frameRate: 29.97,
        background: "#000000",
      },
      {
        id: 2,
        name: "Loop",
        width: 1920,
        height: 1080,
        duration: 2,
        frameRate: 29.97,
        background: "#000000",
      },
    ]);
    expect(fake.state.activeComp).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// attachFakeBridge: the EditorBridge surface over the fake, synchronously
// ---------------------------------------------------------------------------

describe("attachFakeBridge", () => {
  it("adapts the fake to the EditorBridge interface (sync attach)", async () => {
    const fake = createFakeEditor();
    const bridge = attachFakeBridge(fake);
    const readyPayloads: unknown[] = [];
    bridge.on("ready", (p) => readyPayloads.push(p));
    expect(readyPayloads.length).toBe(1);
    await expect(bridge.ready()).resolves.toBe(undefined);

    const result = await bridge.batch({
      label: "Agent: build kinetic title",
      steps: [
        { command: "comp.new", params: { name: "Main", width: 1920, height: 1080 } },
        { command: "layer.newSolid", params: { name: "Background", color: "#0B0D10" } },
        { command: "layer.rename", params: { layer: "$2.layer", name: "Background" } },
      ],
    });
    expect(result.steps).toBe(3);

    const inspect = await bridge.inspect();
    expect(inspect.focusedPanel).toBe("Viewer");
    expect(inspect.selectedLayers).toEqual([1]);

    const frame = await bridge.renderFrame({ time: 0 });
    expect(frame.pngBase64).toBe(FAKE_PNG_BASE64);

    const errors: unknown[] = [];
    bridge.on("error", (e) => errors.push(e));
    const err = (await rejects(bridge.execute("nope.command"))) as BridgeError;
    expect(err).toBeInstanceOf(BridgeError);
    expect(err.code).toBe("EDITOR_CALL_FAILED");
    expect(String(err.cause)).toContain("unknown command `nope.command`");
    expect(errors.length).toBe(1);

    const saved = await bridge.saveToBrowser("/v.ecproj");
    expect(saved.path).toBe("/v.ecproj");
    const bytes = await bridge.readFile("/v.ecproj");
    expect(new TextDecoder().decode(bytes)).toContain("studio-fake-ecproj");
    expect(bridge.version()).toBe("0.13.0-fake");
    expect(bridge.info().load?.readyMs).toBe(64);
  });

  it("validates agent batches before they reach the engine", async () => {
    const bridge = attachFakeBridge(createFakeEditor());
    const err = (await rejects(
      bridge.batch({
        steps: Array.from({ length: 101 }, () => ({ command: "comp.new" })),
      }),
    )) as BridgeError;
    expect(err.code).toBe("EDITOR_CALL_FAILED");
    expect(err.message).toContain("invalid agent batch");

    const atomicErr = (await rejects(
      bridge.batch({ steps: [{ command: "comp.new" }], atomic: false as unknown as true }),
    )) as BridgeError;
    expect(atomicErr.message).toContain("atomic");
  });

  it("dispose() disconnects the bridge", async () => {
    const bridge = attachFakeBridge(createFakeEditor());
    bridge.dispose();
    const err = (await rejects(bridge.inspect())) as BridgeError;
    expect(err.code).toBe("EDITOR_DISCONNECTED");
  });
});
