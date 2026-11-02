/**
 * layout.ts tests (M4-E) — the pinned layout math + persistence contract:
 * clamp vectors (off-screen restore, negative coords, viewport smaller than
 * DEFAULT), min/90%/720 caps, storage round-trip, corrupt JSON, quota-safe
 * save, the §9.1 mode cycle and the deterministic shortcut→layout mapping.
 * Pure functions only — deterministic, no timers, no network.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_MODES,
  type ChatLayout,
  DEFAULT_LAYOUT,
  LAYOUT_STORAGE_KEY,
  MIN_PANEL,
  clampLayout,
  cycleMode,
  loadLayout,
  nextLayoutAction,
  saveLayout,
} from "./layout";

const VP = { w: 1280, h: 800 };
const SMALL_VP = { w: 600, h: 400 };
const TINY_VP = { w: 250, h: 200 };

function layout(overrides: Partial<ChatLayout> = {}): ChatLayout {
  return { mode: "floating", x: 100, y: 100, w: 380, h: 520, ...overrides };
}

beforeEach(() => {
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// clampLayout
// ---------------------------------------------------------------------------

describe("clampLayout", () => {
  it("keeps an in-bounds layout untouched (values, mode)", () => {
    const out = clampLayout(layout(), VP);
    expect(out).toEqual({ mode: "floating", x: 100, y: 100, w: 380, h: 520 });
  });

  it("restores an off-screen layout to the viewport edge (never off-screen)", () => {
    const out = clampLayout(layout({ x: 5000, y: 5000 }), VP);
    expect(out.x).toBe(VP.w - 380);
    expect(out.y).toBe(VP.h - 520);
  });

  it("clamps negative coordinates to 0", () => {
    const out = clampLayout(layout({ x: -300, y: -50 }), VP);
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
  });

  it("pulls DEFAULT_LAYOUT into a viewport smaller than itself (ECUX §2.5)", () => {
    const out = clampLayout(DEFAULT_LAYOUT, SMALL_VP);
    // w 320 fits (cap 540); h 520 caps at 90% of 400 → 360; position shifts in.
    expect(out.w).toBe(320);
    expect(out.h).toBe(360);
    expect(out.x).toBe(SMALL_VP.w - out.w); // 280
    expect(out.y).toBe(SMALL_VP.h - out.h); // 40
    expect(out.x + out.w).toBeLessThanOrEqual(SMALL_VP.w);
    expect(out.y + out.h).toBeLessThanOrEqual(SMALL_VP.h);
  });

  it("enforces MIN_PANEL on shrink-sized writes", () => {
    const out = clampLayout(layout({ w: 50, h: 40, x: 0, y: 0 }), VP);
    expect(out.w).toBe(MIN_PANEL.w);
    expect(out.h).toBe(MIN_PANEL.h);
  });

  it("fits a tiny viewport even below MIN_PANEL (viewport wins over min)", () => {
    const out = clampLayout(DEFAULT_LAYOUT, TINY_VP);
    expect(out.w).toBeLessThanOrEqual(TINY_VP.w);
    expect(out.h).toBeLessThanOrEqual(TINY_VP.h);
    expect(out.x).toBe(TINY_VP.w - out.w);
    expect(out.y).toBe(TINY_VP.h - out.h);
  });

  it("caps size at 720×900 or 90% of the viewport, whichever is smaller (§2.1)", () => {
    const out = clampLayout(layout({ x: 0, y: 0, w: 5000, h: 5000 }), { w: 700, h: 600 });
    expect(out.w).toBe(630); // floor(700 × 0.9)
    expect(out.h).toBe(540); // floor(600 × 0.9)
    const capped = clampLayout(layout({ x: 0, y: 0, w: 5000, h: 5000 }), { w: 2000, h: 2000 });
    expect(capped.w).toBe(720);
    expect(capped.h).toBe(900);
  });

  it("falls back to DEFAULT fields for non-finite input (never throws)", () => {
    const out = clampLayout(
      layout({
        x: Number.NaN,
        y: Number.POSITIVE_INFINITY,
        w: Number.NEGATIVE_INFINITY,
        h: Number.NaN,
      }),
      VP,
    );
    // Geometry falls back to DEFAULT fields; the MODE comes from the input
    // (floating) — DEFAULT_LAYOUT now ships mode "sidebar" (round 16).
    expect(out).toEqual({ ...clampLayout(DEFAULT_LAYOUT, VP), mode: "floating" });
  });

  it("preserves the mode and returns a new object", () => {
    const input = layout({ mode: "sidebar" });
    const out = clampLayout(input, VP);
    expect(out.mode).toBe("sidebar");
    expect(out).not.toBe(input);
  });
});

// ---------------------------------------------------------------------------
// loadLayout / saveLayout
// ---------------------------------------------------------------------------

describe("loadLayout / saveLayout", () => {
  it("returns null when nothing is stored", () => {
    expect(loadLayout()).toBeNull();
  });

  it("round-trips a stored layout (in jsdom bounds)", () => {
    const stored = layout({ x: 100, y: 60, w: 400, h: 500 });
    saveLayout(stored);
    expect(loadLayout()).toEqual(stored);
    expect(localStorage.getItem(LAYOUT_STORAGE_KEY)).toBe(JSON.stringify(stored));
  });

  it("re-clamps an off-screen restore (never off-screen, §2.5)", () => {
    saveLayout(layout({ x: 99999, y: 99999 }));
    const restored = loadLayout();
    expect(restored).not.toBeNull();
    // jsdom viewport is 1024×768 by default.
    expect(restored?.x).toBe(1024 - 380);
    expect(restored?.y).toBe(768 - 520);
  });

  it("returns null for corrupt JSON", () => {
    localStorage.setItem(LAYOUT_STORAGE_KEY, "{not json");
    expect(loadLayout()).toBeNull();
  });

  it("returns null for well-formed JSON that is not a ChatLayout", () => {
    for (const bad of [
      '"hello"',
      "42",
      "null",
      "{}",
      '{"mode":"nope","x":1,"y":1,"w":2,"h":3}',
      '{"mode":"floating","x":"1","y":1,"w":2,"h":3}',
    ]) {
      localStorage.setItem(LAYOUT_STORAGE_KEY, bad);
      expect(loadLayout()).toBeNull();
    }
  });

  it("saveLayout is quota-safe (a throwing localStorage never propagates)", () => {
    const spy = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => saveLayout(layout())).not.toThrow();
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// cycleMode + nextLayoutAction
// ---------------------------------------------------------------------------

describe("cycleMode", () => {
  it("cycles collapsed → floating → sidebar → collapsed (ECUX §9.1)", () => {
    expect(cycleMode("collapsed")).toBe("floating");
    expect(cycleMode("floating")).toBe("sidebar");
    expect(cycleMode("sidebar")).toBe("collapsed");
  });
});

describe("nextLayoutAction", () => {
  it("toggleChat cycles all three modes from any starting mode", () => {
    for (const mode of CHAT_MODES) {
      const action = nextLayoutAction(layout({ mode }), "toggleChat");
      expect(action).toEqual({ type: "setMode", mode: cycleMode(mode) });
    }
  });

  it("agent expands a collapsed panel to floating (composer unreachable while collapsed)", () => {
    expect(nextLayoutAction(layout({ mode: "collapsed" }), "agent")).toEqual({
      type: "setMode",
      mode: "floating",
    });
    expect(nextLayoutAction(layout({ mode: "floating" }), "agent")).toEqual({ type: "noop" });
    expect(nextLayoutAction(layout({ mode: "sidebar" }), "agent")).toEqual({ type: "noop" });
  });

  it("maps every non-layout shortcut to noop in every mode", () => {
    const nonLayoutShortcuts = [
      "inlineEdit",
      "stop",
      "newChat",
      "undoAgentRun",
      "escape",
      "send",
    ] as const;
    for (const mode of CHAT_MODES) {
      for (const shortcut of nonLayoutShortcuts) {
        expect(nextLayoutAction(layout({ mode }), shortcut)).toEqual({ type: "noop" });
      }
    }
  });
});
