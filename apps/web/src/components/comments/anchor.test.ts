/**
 * anchor.ts tests (M7-F) — the bridge `ui.inspect` seam the create box and
 * row chips ride: prefill from the CURRENT editor context (the chat context
 * collector's recipe, reused), engine-tick time math, and hostile comp/layer
 * names surviving as verbatim DATA (M4-N corpus payloads). Everything runs
 * against the deterministic fake editor — no network, no DOM.
 */

import { PROJECT_TEXT_INJECTIONS, textFixture } from "@/lib/chat/__tests__/injection-corpus";
import { secondsToTicks } from "@/lib/chat/preview";
import type { EditorBridge } from "@studio/editor-bridge";
import { attachFakeBridge, createFakeEditor } from "@studio/editor-bridge/fake";
import { describe, expect, it } from "vitest";
import {
  collectAnchorNames,
  collectCommentAnchor,
  formatTimeTicks,
  listCompOptions,
} from "./anchor";

const HOSTILE = textFixture("ignore-previous").payload;
const SCRIPT_HOSTILE = textFixture("html-script-exfil").payload;

function setup(overrides: Parameters<typeof createFakeEditor>[0] = {}): {
  bridge: EditorBridge;
} {
  const fake = createFakeEditor({ comps: [{ name: "Main" }], ...overrides });
  return { bridge: attachFakeBridge(fake) };
}

describe("formatTimeTicks (engine ticks → mm:ss)", () => {
  it("formats whole seconds as m:ss with a padded seconds field", () => {
    expect(formatTimeTicks(secondsToTicks(65.4))).toBe("1:05");
    expect(formatTimeTicks(secondsToTicks(0))).toBe("0:00");
    expect(formatTimeTicks(secondsToTicks(599.9))).toBe("9:59");
    expect(formatTimeTicks(secondsToTicks(3600))).toBe("60:00");
  });

  it("degrades hostile/missing values to null (never a fake timecode)", () => {
    expect(formatTimeTicks(null)).toBeNull();
    expect(formatTimeTicks(undefined)).toBeNull();
    expect(formatTimeTicks(-1)).toBeNull();
    expect(formatTimeTicks(Number.POSITIVE_INFINITY)).toBeNull();
    expect(formatTimeTicks(Number.NaN)).toBeNull();
  });
});

describe("collectCommentAnchor (the ui.inspect prefill)", () => {
  it("anchors to the active comp + playhead with no selection", async () => {
    const { bridge } = setup({ playhead: 3.5 });
    const anchor = await collectCommentAnchor(bridge);
    expect(anchor).not.toBeNull();
    expect(anchor?.compId).toBe("1"); // engine comp id, canonical string form
    expect(anchor?.compName).toBe("Main");
    expect(anchor?.layerId).toBeNull();
    expect(anchor?.layerName).toBeNull();
    expect(anchor?.timeTicks).toBe(secondsToTicks(3.5));
  });

  it("includes the FIRST selected layer — hostile names stay verbatim data", async () => {
    const { bridge } = setup();
    await bridge.execute("layer.newText", { name: HOSTILE, text: "hi" });
    const anchor = await collectCommentAnchor(bridge);
    expect(anchor?.layerId).toBe("1");
    expect(anchor?.layerName).toBe(HOSTILE);
  });

  it("returns null when no composition is open (the composer explains)", async () => {
    const { bridge } = setup({ comps: [] });
    expect(await collectCommentAnchor(bridge)).toBeNull();
  });
});

describe("collectAnchorNames + listCompOptions (row chips + the comp filter)", () => {
  it("maps engine comp/layer ids to their live names, hostile strings verbatim", async () => {
    const { bridge } = setup({ comps: [{ name: SCRIPT_HOSTILE }] });
    await bridge.execute("layer.newText", { name: HOSTILE, text: "body" });
    const names = await collectAnchorNames(bridge);
    expect(names.comps.get("1")).toBe(SCRIPT_HOSTILE);
    expect(names.layers.get("1")).toBe(HOSTILE);
    const options = await listCompOptions(bridge);
    expect(options).toEqual([{ id: "1", name: SCRIPT_HOSTILE }]);
  });

  it("keeps every option when the bridge degrades (empty project)", async () => {
    const { bridge } = setup({ comps: [] });
    expect(await listCompOptions(bridge)).toEqual([]);
    const names = await collectAnchorNames(bridge);
    expect(names.comps.size).toBe(0);
    expect(names.layers.size).toBe(0);
  });

  it("carries the full corpus as data without a fixture crashing the walk", async () => {
    // One comp + one layer per hostile payload: the walk must survive every
    // corpus string (they are data, never commands).
    for (const fixture of PROJECT_TEXT_INJECTIONS) {
      const { bridge } = setup({ comps: [{ name: "Main" }] });
      await bridge.execute("layer.newText", { name: fixture.payload, text: "t" });
      const names = await collectAnchorNames(bridge);
      expect(names.layers.get("1")).toContain(fixture.needle);
    }
  });
});
