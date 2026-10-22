/**
 * use-layout.ts tests (M4-E) — the shared layout store: clamped mutations
 * (move/resize/reset), the setMode geometry memory ("sidebar/collapsed keep
 * the last floating geometry; floating restores it"), persistence, the live
 * window-resize re-clamp + dispose, and the pinned shortcut-bus wiring via
 * `nextLayoutAction` + a fake bus (the exact mapping M4-J installs).
 * All deterministic — injectable viewport, no fake timers, no network.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatShortcutBus } from "../editor-host/chat-shortcut-bus";
import {
  type ChatLayout,
  DEFAULT_LAYOUT,
  clampLayout,
  nextLayoutAction,
  saveLayout,
} from "./layout";
import { type ChatLayoutStore, createChatLayoutStore, useChatLayout } from "./use-layout";

const VP = { w: 1280, h: 800 };

function layout(overrides: Partial<ChatLayout> = {}): ChatLayout {
  return { mode: "floating", x: 100, y: 50, w: 400, h: 500, ...overrides };
}

/** A store with the injected viewport + explicit initial (no localStorage). */
function fresh(initial: ChatLayout = layout()): ChatLayoutStore {
  return createChatLayoutStore({ viewport: () => VP, initial });
}

beforeEach(() => {
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// Store initialization
// ---------------------------------------------------------------------------

describe("createChatLayoutStore", () => {
  it("initializes from DEFAULT_LAYOUT (clamped to the viewport) when nothing is stored", () => {
    const store = createChatLayoutStore({ viewport: () => VP });
    expect(store.getSnapshot()).toEqual(clampLayout(DEFAULT_LAYOUT, VP));
    expect(store.getSnapshot().mode).toBe("floating");
  });

  it("clamps an explicit initial layout (mode preserved, geometry in-bounds)", () => {
    const store = createChatLayoutStore({
      viewport: () => VP,
      initial: { mode: "sidebar", x: 9999, y: 9999, w: 5000, h: 5000 },
    });
    const snap = store.getSnapshot();
    expect(snap.mode).toBe("sidebar");
    expect(snap.w).toBe(720); // 720×900 cap < 90% of 1280×800 (921/720)
    expect(snap.h).toBe(720);
    expect(snap.x).toBe(VP.w - snap.w);
    expect(snap.y).toBe(VP.h - snap.h);
  });

  it("initializes from localStorage when no initial layout is given", () => {
    saveLayout(layout()); // in-bounds for the jsdom window too
    const store = createChatLayoutStore({ viewport: () => VP });
    expect(store.getSnapshot()).toEqual(layout());
  });
});

// ---------------------------------------------------------------------------
// Mutations: setMode geometry memory, clamped move/resize, reset
// ---------------------------------------------------------------------------

describe("ChatLayoutStore mutations", () => {
  it("setMode keeps the last floating geometry across sidebar/collapsed and back", () => {
    const store = fresh();
    store.setMode("sidebar");
    expect(store.getSnapshot()).toEqual(layout({ mode: "sidebar" }));
    store.setMode("collapsed");
    expect(store.getSnapshot()).toEqual(layout({ mode: "collapsed" }));
    store.setMode("floating");
    expect(store.getSnapshot()).toEqual(layout());
  });

  it("setMode to the current mode is a silent no-op (no subscriber notify)", () => {
    const store = fresh();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const before = store.getSnapshot();
    store.setMode("floating");
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBe(before);
    unsubscribe();
  });

  it("move clamps out-of-viewport positions (negative → 0, overshoot → edge)", () => {
    const store = fresh();
    store.move(-500, -500);
    expect(store.getSnapshot()).toEqual(layout({ x: 0, y: 0 }));
    store.move(9999, 9999);
    const snap = store.getSnapshot();
    expect(snap.x).toBe(VP.w - snap.w);
    expect(snap.y).toBe(VP.h - snap.h);
  });

  it("resize enforces MIN_PANEL and the §2.1 caps; position re-clamps", () => {
    const store = fresh();
    store.resize(10, 10);
    expect(store.getSnapshot()).toEqual(layout({ w: 280, h: 320 }));
    store.resize(9999, 9999);
    const snap = store.getSnapshot();
    expect(snap.w).toBe(720);
    expect(snap.h).toBe(720);
    // 100×50 still fits the smaller allowed position range → untouched.
    expect(snap.x).toBe(100);
    expect(snap.y).toBe(50);
  });

  it("reset restores the default geometry but KEEPS the mode (D-18 'Reset chat position')", () => {
    const store = fresh();
    store.setMode("sidebar");
    store.move(200, 300);
    store.resize(600, 700);
    store.reset();
    expect(store.getSnapshot()).toEqual(clampLayout({ ...DEFAULT_LAYOUT, mode: "sidebar" }, VP));
  });

  it("persists every mutation to localStorage", () => {
    const store = fresh(layout()); // 100,50 — inside the jsdom window too
    store.move(120, 60);
    let persisted: ChatLayout | null = null;
    const raw = localStorage.getItem("studio.chat.layout.v1");
    persisted = raw === null ? null : (JSON.parse(raw) as ChatLayout);
    expect(persisted).toEqual(layout({ x: 120, y: 60 }));
    store.setMode("collapsed");
    const raw2 = localStorage.getItem("studio.chat.layout.v1");
    expect(raw2 && JSON.parse(raw2).mode).toBe("collapsed");
  });
});

// ---------------------------------------------------------------------------
// Live window-resize re-clamp + dispose
// ---------------------------------------------------------------------------

describe("window resize re-clamp", () => {
  function setInnerWidth(px: number): void {
    Object.defineProperty(window, "innerWidth", { value: px, configurable: true });
  }

  afterEach(() => {
    // Drop the own property so the prototype getter is visible again.
    Reflect.deleteProperty(window, "innerWidth");
  });

  it("re-clamps the snapshot when the window shrinks, and dispose stops it", () => {
    // Real-window store: jsdom defaults to 1024×768.
    const store = createChatLayoutStore();
    let snap = store.getSnapshot();
    expect(snap.x).toBe(1024 - snap.w);
    expect(snap.y).toBe(768 - snap.h);

    setInnerWidth(600);
    window.dispatchEvent(new Event("resize"));
    snap = store.getSnapshot();
    expect(snap.x).toBe(600 - snap.w);
    expect(snap.y + snap.h).toBeLessThanOrEqual(768);

    store.dispose();
    setInnerWidth(300);
    window.dispatchEvent(new Event("resize"));
    expect(store.getSnapshot()).toBe(snap); // no listener → untouched
  });

  it("notifies subscribers on commit and stops after unsubscribe", () => {
    const store = fresh();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.setMode("sidebar");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.setMode("floating");
    expect(listener).toHaveBeenCalledTimes(1);
    store.dispose();
  });
});

// ---------------------------------------------------------------------------
// useChatLayout — the pinned hook
// ---------------------------------------------------------------------------

describe("useChatLayout", () => {
  it("subscribes React to a store: setMode/move/reset re-render with fresh layout", () => {
    const store = fresh();
    const { result } = renderHook(() => useChatLayout(store));
    expect(result.current.layout).toEqual(layout());
    expect(result.current.setMode).toBe(store.setMode);

    act(() => {
      result.current.setMode("sidebar");
    });
    expect(result.current.layout.mode).toBe("sidebar");
    expect(result.current.layout).toEqual(layout({ mode: "sidebar" }));

    act(() => {
      result.current.move(10, 20);
    });
    expect(result.current.layout).toEqual(layout({ mode: "sidebar", x: 10, y: 20 }));

    act(() => {
      result.current.reset();
    });
    expect(result.current.layout).toEqual(clampLayout({ ...DEFAULT_LAYOUT, mode: "sidebar" }, VP));
    store.dispose();
  });

  it("useChatLayout() with no store shares ONE app singleton across consumers", async () => {
    localStorage.clear();
    vi.resetModules();
    const mod = await import("./use-layout");
    const first = renderHook(() => mod.useChatLayout());
    const second = renderHook(() => mod.useChatLayout());
    expect(first.result.current.layout.mode).toBe("floating");

    act(() => {
      first.result.current.setMode("sidebar");
    });
    // The panel's internal useChatLayout() sees the same mutation M4-J does.
    expect(second.result.current.layout.mode).toBe("sidebar");
  });
});

// ---------------------------------------------------------------------------
// The M4-J wiring pattern: bus → nextLayoutAction → store.setMode
// ---------------------------------------------------------------------------

describe("shortcut bus wiring (the mapping M4-J installs)", () => {
  it("maps bus events through nextLayoutAction deterministically", () => {
    const store = createChatLayoutStore({
      viewport: () => VP,
      initial: { mode: "collapsed", x: 100, y: 50, w: 400, h: 500 },
    });
    const bus = createChatShortcutBus();
    bus.subscribe((event) => {
      const action = nextLayoutAction(store.getSnapshot(), event.shortcut);
      if (action.type === "setMode") {
        store.setMode(action.mode);
      }
    });

    bus.publish("toggleChat", "l");
    expect(store.getSnapshot().mode).toBe("floating");
    // Geometry memory survived the collapsed → floating restore:
    expect(store.getSnapshot()).toMatchObject({ x: 100, y: 50, w: 400, h: 500 });

    bus.publish("toggleChat", "l");
    expect(store.getSnapshot().mode).toBe("sidebar");
    bus.publish("toggleChat", "l");
    expect(store.getSnapshot().mode).toBe("collapsed");

    // agent expands a collapsed panel; escape is a shell-level noop.
    bus.publish("agent", "i");
    expect(store.getSnapshot().mode).toBe("floating");
    bus.publish("escape", "Escape");
    expect(store.getSnapshot().mode).toBe("floating");

    // Non-layout shortcuts never touch the store through this mapping.
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    for (const shortcut of ["inlineEdit", "stop", "newChat", "undoAgentRun", "send"] as const) {
      bus.publish(shortcut, "x");
    }
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
    store.dispose();
  });
});
