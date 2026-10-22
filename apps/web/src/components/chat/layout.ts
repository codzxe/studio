/**
 * Chat panel layout model — M4-E slice of Seam 7, docs/phases/M4-SEAMS.md
 * "Wave-2 UI contract" (pinned; copy signatures exactly).
 *
 * Pure geometry + persistence for the chat overlay shell (EDITOR_CHAT_UX.md
 * §2 layout modes, §2.5 persistence, DECISIONS.md D-10/D-18):
 * - floating (default) / sidebar (right rail) / collapsed pill;
 * - clamped to the editor viewport — the host is `fixed inset-0`, so the
 *   window viewport IS the editor viewport (verified in editor-host.tsx);
 * - persisted per USER (not per project) in localStorage
 *   `studio.chat.layout.v1` (D-10: the key stays ECUX-literal);
 * - restored geometry is always re-clamped — never off-screen (§2.5).
 *
 * This module has NO React and never throws; components and the layout
 * store (use-layout.ts) are the only mutation paths. The editor/iframe is
 * NEVER restyled by any of this (D-18): sidebar mode only changes the width
 * the host pads its iframe container with — M4-J's job.
 */

import type { ChatShortcutName } from "../editor-host/chat-shortcut-bus";

export type ChatMode = "floating" | "sidebar" | "collapsed";

/** All valid modes, in cycle order (handy for tests + pickers). */
export const CHAT_MODES: readonly ChatMode[] = ["floating", "sidebar", "collapsed"];

export interface ChatLayout {
  mode: ChatMode;
  /** Absolute px inside the editor viewport (floating mode only). */
  x: number;
  y: number;
  /** Panel box. `w` also drives the sidebar rail width (pinned contract). */
  w: number;
  h: number;
}

/** D-10: keep the ECUX-literal localStorage key. */
export const LAYOUT_STORAGE_KEY = "studio.chat.layout.v1";

/**
 * Floating default ~380×520 near the bottom-right (pinned contract). The
 * coordinates target the design viewport (1440×900) with the §2.1 default
 * 16px edge margin; `clampLayout` pulls them toward the bottom-right of ANY
 * smaller viewport on first use, so the default never lands off-screen.
 */
export const DEFAULT_LAYOUT: ChatLayout = {
  mode: "floating",
  x: 1044,
  y: 364,
  w: 380,
  h: 520,
};

/** Pinned minimum panel size (brief/M4-SEAMS; also the resize floor). */
export const MIN_PANEL = { w: 280, h: 320 } as const;

/**
 * ECUX §2.1 floating max: 720×900 or 90% of the viewport, whichever is
 * smaller. Enforced inside `clampLayout` so every store write is capped.
 */
const MAX_PANEL = { w: 720, h: 900 } as const;
const VIEWPORT_SHARE = 0.9;

function finiteOr(value: number | undefined, fallback: number): number {
  // `Number.isFinite` is not a type predicate in lib.d.ts — assert the narrowed arm.
  return Number.isFinite(value) ? (value as number) : fallback;
}

function clampNumber(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Clamp one panel dimension: enforce the minimum size, then cap at the
 * §2.1 maximum (fixed cap, 90% of the viewport, and the viewport itself —
 * whichever is smallest). When the viewport is smaller than `min`, fitting
 * the viewport WINS: "never restore off-screen" (§2.5) beats the minimum
 * size; the shell degrades gracefully on tiny viewports.
 */
function clampDimension(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
  viewportAxis: number,
): number {
  const wanted = Math.max(finiteOr(value, fallback), min);
  const cap = Math.min(max, Math.floor(viewportAxis * VIEWPORT_SHARE), Math.floor(viewportAxis));
  return Math.min(wanted, cap);
}

/**
 * Clamp a layout into the viewport: size first (min → caps), then position
 * (`[0, viewport - size]`, so the panel is always fully visible). Pure and
 * total — non-finite fields fall back to `DEFAULT_LAYOUT`'s; the mode is
 * passed through untouched. Returns a NEW object every call.
 */
export function clampLayout(l: ChatLayout, viewport: { w: number; h: number }): ChatLayout {
  const vw = Math.max(0, Math.floor(viewport.w));
  const vh = Math.max(0, Math.floor(viewport.h));
  const w = clampDimension(l.w, MIN_PANEL.w, MAX_PANEL.w, DEFAULT_LAYOUT.w, vw);
  const h = clampDimension(l.h, MIN_PANEL.h, MAX_PANEL.h, DEFAULT_LAYOUT.h, vh);
  const x = clampNumber(finiteOr(l.x, DEFAULT_LAYOUT.x), 0, Math.max(0, vw - w));
  const y = clampNumber(finiteOr(l.y, DEFAULT_LAYOUT.y), 0, Math.max(0, vh - h));
  return { mode: l.mode, x, y, w, h };
}

function isStoredLayout(value: unknown): value is ChatLayout {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Record<keyof ChatLayout, unknown>>;
  return (
    (candidate.mode === "floating" ||
      candidate.mode === "sidebar" ||
      candidate.mode === "collapsed") &&
    Number.isFinite(candidate.x) &&
    Number.isFinite(candidate.y) &&
    Number.isFinite(candidate.w) &&
    Number.isFinite(candidate.h)
  );
}

/**
 * Load the persisted layout. Parse + validate + clamp against the CURRENT
 * window viewport; `null` when absent or corrupt. Never throws (private
 * browsing, disabled storage, races — all degrade to `null`).
 */
export function loadLayout(): ChatLayout | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isStoredLayout(parsed)) return null;
    return clampLayout(parsed, { w: window.innerWidth, h: window.innerHeight });
  } catch {
    return null;
  }
}

/**
 * Persist the layout (quota-safe: a full/unavailable localStorage never
 * throws — persistence is best-effort, the in-memory store stays truth).
 */
export function saveLayout(l: ChatLayout): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(l));
  } catch {
    // Quota exceeded / storage disabled / private mode — never fatal.
  }
}

/**
 * The ECUX §9.1 "Toggle chat" cycle: collapsed → floating → sidebar →
 * collapsed. Pure; the geometry memory (x/y/w/h) is kept by the layout
 * STORE (use-layout.ts `setMode`), not by this function.
 */
export function cycleMode(m: ChatMode): ChatMode {
  switch (m) {
    case "collapsed":
      return "floating";
    case "floating":
      return "sidebar";
    case "sidebar":
      return "collapsed";
  }
}

/** One deterministic layout outcome for an incoming shortcut-bus event. */
export type ChatLayoutAction = { type: "setMode"; mode: ChatMode } | { type: "noop" };

/**
 * Map an incoming editor shortcut (M3.6 `chat-shortcut-bus`, D-5) to a
 * LAYOUT action. M4-J consumes this inside its bus subscription so the
 * mapping is deterministic and testable — the panel/store themselves never
 * touch the bus (props/store driven only).
 *
 * | shortcut      | layout action                                                |
 * |---------------|--------------------------------------------------------------|
 * | toggleChat    | `setMode(cycleMode(mode))` — §9.1 three-mode cycle           |
 * | agent         | collapsed → `setMode("floating")` (Cmd/Ctrl+I must reach a  |
 * |               | composer; expanding restores the remembered geometry),        |
 * |               | already open → `noop` (M4-J then focuses the composer)       |
 * | inlineEdit    | `noop` — Cmd/Ctrl+K shows the M5 notice chip (D-5, M5 work)  |
 * | escape        | `noop` AT THE SHELL LEVEL — the §9 dismissal order is        |
 * |               | popovers FIRST, panel collapse second; popovers are owned    |
 * |               | by header/context peers and close in their own portal        |
 * |               | layer, so M4-J applies the escalation itself: close the      |
 * |               | topmost popover, and only when none is open call             |
 * |               | `setMode("collapsed")`                                       |
 * | stop          | `noop` — composer/controller own the §8.3 stop               |
 * | newChat       | `noop` — header more-menu / thread lifecycle (M4-J)          |
 * | undoAgentRun  | `noop` — apply/undo is M5 (read-only agent in M4)             |
 * | send          | `noop` — composer (Cmd/Ctrl+Enter)                            |
 */
export function nextLayoutAction(
  current: ChatLayout,
  incoming: ChatShortcutName,
): ChatLayoutAction {
  switch (incoming) {
    case "toggleChat":
      return { type: "setMode", mode: cycleMode(current.mode) };
    case "agent":
      return current.mode === "collapsed"
        ? { type: "setMode", mode: "floating" }
        : { type: "noop" };
    default:
      return { type: "noop" };
  }
}
