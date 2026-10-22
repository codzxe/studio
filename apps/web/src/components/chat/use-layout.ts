"use client";

/**
 * The chat layout store + `useChatLayout` hook — M4-E slice of Seam 7
 * (docs/phases/M4-SEAMS.md "Wave-2 UI contract", pinned).
 *
 * ONE module-level store backs the whole chat shell: `useChatLayout()` is
 * called BOTH by the page integration (M4-J — feeds `layout` into
 * `ChatPanel` as props, wires bus events through `nextLayoutAction`) AND
 * by `ChatPanel` itself for drag/resize mutations. `setMode` NEVER clears
 * x/y/w/h — "sidebar keeps the last floating geometry; collapsed remembers
 * it too; back to floating restores it" (the pinned contract).
 *
 * Every mutation is clamped (`clampLayout`, ECUX §2.5 "never off-screen"),
 * persisted to localStorage (best-effort, quota-safe) and re-clamped live
 * when the window resizes — the editor host is `fixed inset-0`, so the
 * window IS the editor viewport. The iframe/editor itself is NEVER touched
 * (D-18): sidebar mode only changes the width M4-J pads its host with.
 */

import { useSyncExternalStore } from "react";
import {
  DEFAULT_LAYOUT,
  type ChatLayout,
  type ChatMode,
  clampLayout,
  loadLayout,
  saveLayout,
} from "./layout";

// Convenience re-exports so consumers (M4-J's slot) can import the whole
// layout surface from one module; `layout.ts` stays the canonical owner.
export type { ChatLayout, ChatMode } from "./layout";

/** The clamp viewport (the editor host fills the window; verified M3-A). */
export interface ChatViewport {
  readonly w: number;
  readonly h: number;
}

/** The mutation surface shared by M4-J and the panel shell (pinned names). */
export interface ChatLayoutStore {
  getSnapshot(): ChatLayout;
  subscribe(listener: () => void): () => void;
  /** Switch mode; x/y/w/h (the "remembered" geometry) are preserved. */
  setMode(mode: ChatMode): void;
  /** Absolute-position write (floating drags); clamped to the viewport. */
  move(x: number, y: number): void;
  /** Size write (SE grip + sidebar width grip); min/max/clamp enforced. */
  resize(w: number, h: number): void;
  /** "Reset chat position" (D-18): default geometry, mode kept. */
  reset(): void;
  /** Drop the window-resize listener (tests / embedded stores). */
  dispose(): void;
}

export interface CreateChatLayoutStoreOptions {
  /** Injectable for tests; default = window (SSR-safe {0,0}). */
  readonly viewport?: () => ChatViewport;
  /** Injectable first layout; default = loadLayout() ?? DEFAULT_LAYOUT. */
  readonly initial?: ChatLayout;
}

function windowViewport(): ChatViewport {
  if (typeof window === "undefined") return { w: 0, h: 0 };
  return { w: window.innerWidth, h: window.innerHeight };
}

/**
 * Create a layout store. The app uses the module singleton (below); tests
 * create isolated stores with injectable viewport/initial. Stores created
 * on the server are inert — React only reads `getServerSnapshot` there
 * (see `useChatLayout`).
 */
export function createChatLayoutStore(
  options: CreateChatLayoutStoreOptions = {},
): ChatLayoutStore {
  const viewport = options.viewport ?? windowViewport;
  const listeners = new Set<() => void>();
  let current = clampLayout(options.initial ?? loadLayout() ?? DEFAULT_LAYOUT, viewport());

  const commit = (next: ChatLayout): void => {
    // Value equality (not reference): repeated clamps of the same geometry
    // stay silent — keeps useSyncExternalStore snapshot referentially stable.
    if (
      next.mode === current.mode &&
      next.x === current.x &&
      next.y === current.y &&
      next.w === current.w &&
      next.h === current.h
    ) {
      return;
    }
    current = next;
    saveLayout(current);
    for (const listener of [...listeners]) listener();
  };

  // Live re-clamp while the viewport shrinks (panel must never end up
  // off-screen, ECUX §2.5). Fires only when the clamped values change.
  const onWindowResize = (): void => {
    commit(clampLayout(current, viewport()));
  };
  if (typeof window !== "undefined") {
    window.addEventListener("resize", onWindowResize);
  }

  return {
    getSnapshot(): ChatLayout {
      return current;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setMode(mode: ChatMode): void {
      commit({ ...current, mode });
    },
    move(x: number, y: number): void {
      commit(clampLayout({ ...current, x, y }, viewport()));
    },
    resize(w: number, h: number): void {
      commit(clampLayout({ ...current, w, h }, viewport()));
    },
    reset(): void {
      commit(
        clampLayout(
          {
            mode: current.mode,
            x: DEFAULT_LAYOUT.x,
            y: DEFAULT_LAYOUT.y,
            w: DEFAULT_LAYOUT.w,
            h: DEFAULT_LAYOUT.h,
          },
          viewport(),
        ),
      );
    },
    dispose(): void {
      if (typeof window !== "undefined") {
        window.removeEventListener("resize", onWindowResize);
      }
      listeners.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// The app singleton — the ONE store the panel's drags mutate. M4-J MUST
// feed `ChatPanel`'s `layout` prop from this same hook (that is the pinned
// integration: both sides share the store, so drags re-render the panel).
// ---------------------------------------------------------------------------

let appStore: ChatLayoutStore | null = null;

function chatLayoutStore(): ChatLayoutStore {
  if (appStore === null) {
    appStore = createChatLayoutStore();
  }
  return appStore;
}

/** The pinned hook's return shape (pinned names; actions are stable). */
export interface UseChatLayout {
  layout: ChatLayout;
  setMode(mode: ChatMode): void;
  move(x: number, y: number): void;
  resize(w: number, h: number): void;
  reset(): void;
}

/**
 * `useChatLayout()` — subscribe to the shared chat layout store. The
 * optional `store` parameter is the test/embedding seam (the pinned call
 * shape `useChatLayout()` uses the module singleton). Hydration-safe via
 * `useSyncExternalStore`'s `getServerSnapshot` (server renders the
 * DEFAULT; React re-renders once on the client if the persisted layout
 * differs — no mismatch).
 */
export function useChatLayout(store?: ChatLayoutStore): UseChatLayout {
  const s = store ?? chatLayoutStore();
  const layout = useSyncExternalStore(s.subscribe, s.getSnapshot, () => DEFAULT_LAYOUT);
  return {
    layout,
    setMode: s.setMode,
    move: s.move,
    resize: s.resize,
    reset: s.reset,
  };
}
