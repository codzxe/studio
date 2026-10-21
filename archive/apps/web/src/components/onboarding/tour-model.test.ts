// tour-model tests — spotlight geometry math (table-driven, exact px) and
// guarded tour-state parsing. No DOM: the component feeds measured boxes in.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOUR_STEPS,
  INITIAL_TOUR_STATE,
  TOOLTIP_EST_HEIGHT,
  TOOLTIP_GAP,
  boxFromRect,
  computeSpotlightLayout,
  parseTourState,
  serializeTourState,
  type Box,
  type Viewport,
} from "./tour-model";

describe("DEFAULT_TOUR_STEPS", () => {
  it("walks composer → timeline → layers (§19 Phase 4 tour)", () => {
    expect(DEFAULT_TOUR_STEPS.map((step) => step.target)).toEqual([
      "composer",
      "timeline",
      "layers",
    ]);
    for (const step of DEFAULT_TOUR_STEPS) {
      expect(step.href.startsWith("/")).toBe(true);
      expect(step.linkLabel.length).toBeGreaterThan(0);
    }
  });
});

describe("parseTourState", () => {
  it.each([
    ["null", null],
    ["not JSON", "{nope"],
    ["JSON array", "[1]"],
    ["number payload", "42"],
  ])("degrades %s to the initial state", (_name, raw) => {
    expect(parseTourState(raw)).toEqual(INITIAL_TOUR_STATE);
  });

  it("keeps valid status and clamps junk stepIndex/timestamps", () => {
    expect(
      parseTourState('{"status":"active","stepIndex":2,"dismissedAt":"x","completedAt":null}'),
    ).toEqual({ status: "active", stepIndex: 2, dismissedAt: null, completedAt: null });
    expect(parseTourState('{"status":"active","stepIndex":-4}').stepIndex).toBe(0);
    expect(parseTourState('{"status":"active","stepIndex":2.5}').stepIndex).toBe(0);
    expect(parseTourState('{"status":"nonsense","stepIndex":9}').status).toBe("idle");
  });

  it("round-trips through serialize", () => {
    const state = {
      status: "done" as const,
      stepIndex: 1,
      dismissedAt: 123,
      completedAt: 456,
    };
    expect(parseTourState(serializeTourState(state))).toEqual(state);
  });
});

describe("boxFromRect", () => {
  it("maps a DOMRect to a viewport-relative box", () => {
    const rect = {
      top: 10,
      left: 20,
      width: 30,
      height: 40,
      right: 50,
      bottom: 50,
      x: 20,
      y: 10,
    } as unknown as DOMRect;
    expect(boxFromRect(rect)).toEqual({ top: 10, left: 20, width: 30, height: 40 });
  });
});

const vp = (width: number, height: number): Viewport => ({ width, height });
const box = (top: number, left: number, width: number, height: number): Box => ({
  top,
  left,
  width,
  height,
});

describe("computeSpotlightLayout", () => {
  it("places the tooltip below a centered target, arrow pointing up", () => {
    const layout = computeSpotlightLayout(box(100, 440, 400, 300), vp(1280, 800));
    expect(layout.hole).toEqual(box(100, 440, 400, 300));
    expect(layout.shades.top).toEqual(box(0, 0, 1280, 100));
    expect(layout.shades.bottom).toEqual(box(400, 0, 1280, 400));
    expect(layout.shades.left).toEqual(box(100, 0, 440, 300));
    expect(layout.shades.right).toEqual(box(100, 840, 440, 300));
    expect(layout.tooltip).toEqual({
      top: 100 + 300 + TOOLTIP_GAP,
      left: 440 + 200 - 160,
      width: 320,
      arrow: "up",
    });
  });

  it("flips above when there is no room below, arrow pointing down", () => {
    const layout = computeSpotlightLayout(box(600, 100, 300, 150), vp(1280, 800));
    expect(layout.tooltip.arrow).toBe("down");
    expect(layout.tooltip.top).toBe(600 - TOOLTIP_GAP - TOOLTIP_EST_HEIGHT);
    expect(layout.tooltip.left).toBe(90);
  });

  it("clamps into a cramped viewport without an arrow", () => {
    const layout = computeSpotlightLayout(box(40, 0, 320, 400), vp(320, 480));
    expect(layout.tooltip.arrow).toBe("none");
    expect(layout.tooltip.width).toBe(288);
    expect(layout.tooltip.top).toBe(294);
    expect(layout.tooltip.left).toBe(16);
    expect(layout.shades.left).toEqual(box(40, 0, 0, 400));
    expect(layout.shades.right).toEqual(box(40, 320, 0, 400));
  });

  it("dims everything and centers the tooltip when the target is absent", () => {
    const layout = computeSpotlightLayout(null, vp(1000, 600));
    expect(layout.shades.top).toEqual(box(0, 0, 1000, 600));
    expect(layout.shades.right).toEqual(box(0, 0, 0, 0));
    expect(layout.shades.bottom).toEqual(box(0, 0, 0, 0));
    expect(layout.shades.left).toEqual(box(0, 0, 0, 0));
    expect(layout.hole).toEqual(box(0, 0, 0, 0));
    expect(layout.tooltip).toEqual({
      top: (600 - TOOLTIP_EST_HEIGHT) / 2,
      left: (1000 - 320) / 2,
      width: 320,
      arrow: "none",
    });
  });

  it("clamps partially off-screen targets so the shades never invert", () => {
    const layout = computeSpotlightLayout(box(-20, -30, 200, 100), vp(800, 600));
    expect(layout.hole).toEqual(box(0, 0, 170, 80));
    expect(layout.shades.top).toEqual(box(0, 0, 800, 0));
    expect(layout.shades.bottom).toEqual(box(80, 0, 800, 520));
    expect(layout.shades.right).toEqual(box(0, 170, 630, 80));
    expect(layout.tooltip.left).toBe(16); // centered tooltip would spill left
  });

  it("keeps the tooltip inside the viewport for any target x", () => {
    const layout = computeSpotlightLayout(box(250, 330, 140, 100), vp(800, 600));
    expect(layout.tooltip.top).toBe(362);
    expect(layout.tooltip.left).toBe(240);
  });
});
