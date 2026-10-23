import type { ContextSelection, PinnedContextItem } from "@studio/contracts";
import type { EditorBridge } from "@studio/editor-bridge";
import { type FakeEditor, attachFakeBridge, createFakeEditor } from "@studio/editor-bridge/fake";
import { describe, expect, it } from "vitest";

import {
  type ContextBlock,
  DEFAULT_FLAGS,
  type SelectedPropertiesBlockData,
  type SelectionBlockData,
  autoFlags,
  collectContextSnapshot,
  timecodeLabel,
} from "./context";
import { estimateTokens } from "./tokens";

/**
 * Seam 5 tests against the deterministic fake editor (`@studio/editor-bridge/fake`)
 * — the same typed surface the real dist exposes. No network, real timers only
 * (the fake resolves immediately; one test uses its `latencyMs` to observe the
 * bounded-concurrency limiter).
 */

function setup(overrides: Parameters<typeof createFakeEditor>[0] = {}): {
  fake: FakeEditor;
  bridge: EditorBridge;
} {
  const fake = createFakeEditor({ comps: [{ name: "Main" }], ...overrides });
  const bridge = attachFakeBridge(fake);
  return { fake, bridge };
}

const ALL_ON = {
  ...DEFAULT_FLAGS,
  selection: true,
  selectedProperties: true,
  currentFrame: true,
  recentCommands: true,
  comments: true,
} satisfies ContextSelection;

const ALL_OFF = {
  ...DEFAULT_FLAGS,
  projectSummary: false,
  activeComp: false,
  playhead: false,
  focusedPanel: false,
} satisfies ContextSelection;

function kinds(blocks: ContextBlock[]): string[] {
  return blocks.map((b) => b.kind);
}

function byKind(blocks: ContextBlock[], kind: ContextBlock["kind"]): ContextBlock {
  const block = blocks.find((b) => b.kind === kind);
  if (block === undefined) throw new Error(`missing block: ${kind}`);
  return block;
}

/** A bridge whose inspect reports a multi-layer selection (upstream multi-select; the fake selects only the newest layer). */
function withSelection(bridge: EditorBridge, selectedLayers: number[]): EditorBridge {
  return {
    ...bridge,
    inspect: async () => ({ ...(await bridge.inspect()), selectedLayers }),
  };
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

describe("DEFAULT_FLAGS / autoFlags (§5.1)", () => {
  it("defaults to the always-on core; conditional blocks stay off", () => {
    expect(DEFAULT_FLAGS).toEqual({
      projectSummary: true,
      activeComp: true,
      selection: false,
      playhead: true,
      focusedPanel: true,
      selectedProperties: false,
      currentFrame: false,
      recentCommands: false,
      comments: false,
    });
  });

  it("autoFlags switches selection-derived blocks on only when a selection exists", () => {
    expect(autoFlags(null)).toEqual(DEFAULT_FLAGS);
    expect(autoFlags({ selectedLayers: [] })).toEqual(DEFAULT_FLAGS);
    const on = autoFlags({ selectedLayers: [3, 7] });
    expect(on.selection).toBe(true);
    expect(on.selectedProperties).toBe(true);
    expect(on.projectSummary).toBe(true);
    expect(on.playhead).toBe(true);
    expect(on.focusedPanel).toBe(true);
    expect(on.currentFrame).toBe(false);
    expect(on.recentCommands).toBe(false);
    expect(on.comments).toBe(false);
  });

  it("autoFlags accepts the bridge's own inspect result", async () => {
    const { fake, bridge } = setup();
    await fake.execute("layer.newText", { text: "Headline" });
    const flags = autoFlags(await bridge.inspect());
    expect(flags.selection).toBe(true);
    expect(flags.selectedProperties).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// collectContextSnapshot — presence, labels, estimates
// ---------------------------------------------------------------------------

describe("collectContextSnapshot", () => {
  it("collects every block with all flags on (selection exists)", async () => {
    const { fake, bridge } = setup({ playhead: 3.25, focusedPanel: "Timeline" });
    const text = (await fake.execute("layer.newText", { text: "Headline" })) as { layer: number };
    const pinned: PinnedContextItem[] = [
      { kind: "frame", label: "Frame at 00:03.3" },
      { kind: "composition", id: "c_main", label: "Main" },
    ];

    const snap = await collectContextSnapshot(bridge, { flags: ALL_ON, pinned });

    expect(snap.flags).toEqual(ALL_ON);
    expect(snap.pinned).toEqual(pinned);
    expect(kinds(snap.blocks)).toEqual([
      "projectSummary",
      "activeComp",
      "selection",
      "selectedProperties",
      "playhead",
      "focusedPanel",
      "currentFrame",
      "recentCommands",
      // No "comments" block: the §5.1 Comments context was never wired, so
      // the dormant flag is purged (W2-B1) — even ALL_ON grows no Comments
      // chip that would promise context the model never receives.
    ]);

    const labels = Object.fromEntries(snap.blocks.map((b) => [b.kind, b.label]));
    expect(labels.projectSummary).toBe("Project summary");
    expect(labels.activeComp).toBe("Comp: Main");
    expect(labels.selection).toBe("Selection: Headline");
    expect(labels.selectedProperties).toBe("Selected properties");
    expect(labels.playhead).toBe("Playhead 00:03.3");
    expect(labels.focusedPanel).toBe("Panel: Timeline");
    expect(labels.currentFrame).toBe("Frame preview");
    expect(labels.recentCommands).toBe("Recent commands");

    const summary = byKind(snap.blocks, "projectSummary").data as {
      items: Array<{ name: string }>;
    };
    expect(summary.items[0]?.name).toBe("Main");
    const comp = byKind(snap.blocks, "activeComp").data as { name: string; width: number };
    expect(comp.name).toBe("Main");
    expect(comp.width).toBe(1920);
    const selection = byKind(snap.blocks, "selection").data as SelectionBlockData;
    expect((selection.layers[0] as { name: string }).name).toBe("Headline");
    expect(selection.truncated).toBeUndefined();
    const props = byKind(snap.blocks, "selectedProperties").data as SelectedPropertiesBlockData;
    expect(props.layer).toBe(text.layer);
    expect(props.properties.map((p) => p.path)).toEqual([
      "transform/anchor",
      "transform/position",
      "transform/scale",
      "transform/rotation",
      "transform/opacity",
      "text/sourceText",
    ]);
    for (const entry of props.properties) {
      expect(entry.value).not.toBeNull();
    }
    expect(byKind(snap.blocks, "playhead").data).toEqual({ time: 3.25, playing: false });
    expect(byKind(snap.blocks, "focusedPanel").data).toEqual({ panel: "Timeline" });
    const history = byKind(snap.blocks, "recentCommands").data as { states: unknown[] };
    expect(history.states).toHaveLength(2); // "Original" + the journaled text layer

    // every data-carrying block estimates > 0; the frame placeholder estimates 0
    for (const block of snap.blocks) {
      if (block.kind === "currentFrame") {
        expect(block.tokenEstimate).toBe(0);
        expect(block.data).toBeUndefined();
      } else {
        expect(block.tokenEstimate).toBeGreaterThan(0);
        expect(block.tokenEstimate).toBe(estimateTokens(block.data));
      }
    }

    const blockSum = snap.blocks.reduce((n, b) => n + b.tokenEstimate, 0);
    expect(snap.totalTokenEstimate).toBe(
      blockSum + estimateTokens(pinned[0]) + estimateTokens(pinned[1]),
    );
  });

  it("omits blocks whose flags are off", async () => {
    const { bridge } = setup();
    const snap = await collectContextSnapshot(bridge, { flags: DEFAULT_FLAGS });
    expect(kinds(snap.blocks)).toEqual([
      "projectSummary",
      "activeComp",
      "playhead",
      "focusedPanel",
    ]);
  });

  it("returns no blocks at all when every flag is off", async () => {
    const { bridge } = setup();
    const snap = await collectContextSnapshot(bridge, { flags: ALL_OFF });
    expect(snap.blocks).toEqual([]);
    expect(snap.totalTokenEstimate).toBe(0);
  });

  it("drops selection-derived blocks when nothing is selected, even if flagged on", async () => {
    const { bridge } = setup();
    const snap = await collectContextSnapshot(bridge, { flags: ALL_ON });
    expect(kinds(snap.blocks)).not.toContain("selection");
    expect(kinds(snap.blocks)).not.toContain("selectedProperties");
  });

  it("reads one layer.tree per selected layer and only the FIRST layer's properties", async () => {
    const { fake, bridge } = setup();
    const a = (await fake.execute("layer.newText", { text: "Alpha" })) as { layer: number };
    await fake.execute("layer.newText", { text: "Beta" });

    const snap = await collectContextSnapshot(withSelection(bridge, [a.layer, 999]), {
      flags: { ...DEFAULT_FLAGS, selection: true, selectedProperties: true },
    });

    const selection = byKind(snap.blocks, "selection");
    expect(selection.label).toBe("Selection: Alpha"); // the unknown layer degrades to a null item
    const data = selection.data as SelectionBlockData;
    expect(data.layers).toHaveLength(2);
    expect(data.layers[0]).not.toBeNull();
    expect(data.layers[1]).toBeNull();
    expect(
      (byKind(snap.blocks, "selectedProperties").data as SelectedPropertiesBlockData).layer,
    ).toBe(a.layer);
  });

  it("caps selection reads and reports truncation beyond the cap", async () => {
    const { fake, bridge } = setup();
    const ids: number[] = [];
    for (let i = 0; i < 9; i++) {
      const r = (await fake.execute("layer.newSolid", { name: `L${i + 1}` })) as { layer: number };
      ids.push(r.layer);
    }
    const snap = await collectContextSnapshot(withSelection(bridge, ids), {
      flags: { ...DEFAULT_FLAGS, selection: true },
    });
    const data = byKind(snap.blocks, "selection").data as SelectionBlockData;
    expect(data.layers).toHaveLength(8);
    expect(data.truncated).toBe(true);
  });

  it("bounds property reads to 4 concurrent bridge calls", async () => {
    const { fake, bridge } = setup({ latencyMs: 4 });
    await fake.execute("layer.newText", { text: "Slow" });
    let inFlight = 0;
    let peak = 0;
    const counted: EditorBridge = {
      ...bridge,
      query<T = unknown>(command: string, params?: unknown): Promise<T> {
        if (command !== "prop.get") return bridge.query<T>(command, params);
        inFlight++;
        peak = Math.max(peak, inFlight);
        const p = bridge.query<T>(command, params);
        void p.then(
          () => {
            inFlight--;
          },
          () => {
            inFlight--;
          },
        );
        return p;
      },
    };
    const snap = await collectContextSnapshot(counted, {
      flags: { ...DEFAULT_FLAGS, selectedProperties: true },
    });
    expect(byKind(snap.blocks, "selectedProperties").tokenEstimate).toBeGreaterThan(0);
    expect(peak).toBe(4); // 6 candidate paths, limit 4
  });
});

// ---------------------------------------------------------------------------
// Degradation (missing context never breaks chat)
// ---------------------------------------------------------------------------

describe("collectContextSnapshot degradation", () => {
  it("prop.get misses become per-item nulls and never throw", async () => {
    const { fake, bridge } = setup();
    await fake.execute("layer.newSolid", { name: "Plate" }); // solids have no text/sourceText

    const snap = await collectContextSnapshot(bridge, {
      flags: { ...DEFAULT_FLAGS, selectedProperties: true },
    });

    const data = byKind(snap.blocks, "selectedProperties").data as SelectedPropertiesBlockData;
    const byPath = Object.fromEntries(data.properties.map((p) => [p.path, p.value]));
    expect((byPath["transform/opacity"] as { value: number }).value).toBe(100);
    expect(byPath["text/sourceText"]).toBeNull();
    expect(snap.totalTokenEstimate).toBeGreaterThan(0);
  });

  it("a rejecting query degrades its block to ' (unavailable)' while the snapshot resolves", async () => {
    const { bridge } = setup({ failOn: { "project.summary": "boom" } });
    const snap = await collectContextSnapshot(bridge, { flags: ALL_ON, pinned: [] });

    const ps = byKind(snap.blocks, "projectSummary");
    expect(ps.label).toBe("Project summary (unavailable)");
    expect(ps.data).toBeUndefined();
    expect(ps.tokenEstimate).toBe(0);
    expect(byKind(snap.blocks, "activeComp").label).toBe("Comp: Main");
    expect(snap.totalTokenEstimate).toBeGreaterThan(0);
  });

  it("a failed inspect degrades every ui-derived block; comp.info still resolves", async () => {
    const { bridge } = setup();
    const broken: EditorBridge = {
      ...bridge,
      inspect: () => Promise.reject(new Error("ui gone")),
    };
    const snap = await collectContextSnapshot(broken, { flags: ALL_ON });

    expect(byKind(snap.blocks, "playhead").label).toBe("Playhead (unavailable)");
    expect(byKind(snap.blocks, "focusedPanel").label).toBe("Panel (unavailable)");
    expect(byKind(snap.blocks, "selection").label).toBe("Selection (unavailable)");
    expect(byKind(snap.blocks, "selectedProperties").label).toBe(
      "Selected properties (unavailable)",
    );
    expect(byKind(snap.blocks, "activeComp").label).toBe("Comp: Main"); // engine's own active comp
  });

  it("marks the comp block unavailable when no composition is open", async () => {
    const fake = createFakeEditor(); // no comps
    const bridge = attachFakeBridge(fake);
    const snap = await collectContextSnapshot(bridge, {
      flags: { ...DEFAULT_FLAGS, selection: true, selectedProperties: true },
    });
    expect(byKind(snap.blocks, "activeComp").label).toBe("Comp (unavailable)");
    expect(kinds(snap.blocks)).toEqual([
      "projectSummary",
      "activeComp",
      "playhead",
      "focusedPanel",
    ]);
  });

  it("trims recent commands to the last 10 history entries", async () => {
    const { fake, bridge } = setup();
    for (let i = 0; i < 12; i++) {
      await fake.execute("layer.newSolid", { name: `S${i + 1}` });
    }
    const snap = await collectContextSnapshot(bridge, {
      flags: { ...DEFAULT_FLAGS, recentCommands: true },
    });
    const data = byKind(snap.blocks, "recentCommands").data as {
      states: Array<{ index: number }>;
      current: number;
      branches: number;
    };
    expect(data.states).toHaveLength(10); // 13 states total
    expect(data.states[0]?.index).toBe(3);
    expect(data.current).toBe(12);
    expect(data.branches).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Placeholders + pinned
// ---------------------------------------------------------------------------

describe("placeholders and pinned chips", () => {
  it("currentFrame is a data-free placeholder (the executor renders on demand)", async () => {
    const { bridge } = setup();
    const snap = await collectContextSnapshot(bridge, {
      flags: { ...DEFAULT_FLAGS, currentFrame: true },
    });
    expect(byKind(snap.blocks, "currentFrame")).toEqual({
      kind: "currentFrame",
      label: "Frame preview",
      tokenEstimate: 0,
    });
    expect("data" in byKind(snap.blocks, "currentFrame")).toBe(false);
  });

  it("the purged comments flag grows NO block — even switched on (W2-B1)", async () => {
    const { bridge } = setup();
    const snap = await collectContextSnapshot(bridge, {
      flags: { ...DEFAULT_FLAGS, comments: true },
    });
    expect(kinds(snap.blocks)).not.toContain("comments");
  });

  it("pinned chips count toward the total estimate", async () => {
    const { bridge } = setup();
    const pinned: PinnedContextItem[] = [
      { kind: "frame", label: "Frame at 00:00.0" },
      { kind: "comment", id: "cm_1", label: "Make the title pop" },
    ];
    const snap = await collectContextSnapshot(bridge, { flags: ALL_OFF, pinned });
    expect(snap.blocks).toEqual([]);
    expect(snap.pinned).toEqual(pinned);
    expect(snap.totalTokenEstimate).toBe(estimateTokens(pinned[0]) + estimateTokens(pinned[1]));
    expect(snap.totalTokenEstimate).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// timecodeLabel
// ---------------------------------------------------------------------------

describe("timecodeLabel", () => {
  it("formats comp seconds as mm:ss.d", () => {
    expect(timecodeLabel(null)).toBe("00:00.0");
    expect(timecodeLabel(undefined)).toBe("00:00.0");
    expect(timecodeLabel(0)).toBe("00:00.0");
    expect(timecodeLabel(3.25)).toBe("00:03.3");
    expect(timecodeLabel(65.06)).toBe("01:05.1");
    expect(timecodeLabel(125.949)).toBe("02:05.9");
    expect(timecodeLabel(60)).toBe("01:00.0");
  });

  it("degrades non-finite and negative values to zero", () => {
    expect(timecodeLabel(Number.NaN)).toBe("00:00.0");
    expect(timecodeLabel(Number.POSITIVE_INFINITY)).toBe("00:00.0");
    expect(timecodeLabel(-4)).toBe("00:00.0");
  });
});
