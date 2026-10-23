"use client";

/**
 * `ChatPanel` — the chat overlay SHELL (M4-E slice of Seam 7, pinned in
 * docs/phases/M4-SEAMS.md "Wave-2 UI contract"). Renders the chrome around
 * slot content owned by the wave-2 peers:
 *
 *   header  → M4-G2 ChatHeader      strip   → M4-H ContextStrip (optional)
 *   thread  → M4-F ChatThread       composer→ M4-G ChatComposer
 *   footer  → M4-G2 ChatFooter (optional)
 *
 * Modes (EDITOR_CHAT_UX.md §2, DECISIONS.md D-18):
 * - floating: absolutely-positioned box at `layout.x/y/w/h` with a 1px
 *   `--line-subtle` border (Tailwind `border-border` resolves to it),
 *   `--bg-panel` background, `--radius-md` (UI_DESIGN_SYSTEM §9 pins
 *   radius-md on the chat panel — never radius-lg), one soft elevation
 *   (`--elevation-modal`), a header drag region and an 8px SE resize grip.
 * - sidebar: right rail, 100% height, `width = max(MIN_PANEL.w, layout.w)`,
 *   with an internal width grip on its left edge (drag left = wider).
 *   The editor iframe is NEVER restyled here — M4-J pads its host.
 * - collapsed: renders NOTHING (`null`); M4-J mounts `ChatCollapsedPill`.
 *
 * Drag/resize mutate the SHARED `useChatLayout()` store (panel + page call
 * the same hook), so drags persist (localStorage) and re-render the panel
 * through M4-J's props. Window-resize re-clamping is owned by the store.
 *
 * STACKING (verified against editor-host chrome, 2026-10-23):
 *   z-20  non-blocking banners (read-only/lease/missing-assets/save chip)
 *   z-30  floating project bar (auto-hide)
 *   z-35  THIS panel — above host chrome, below blocking overlays (ECUX
 *         §2.1 "above the editor iframe, below modals, menus, dialogs")
 *   z-40  boot/load-failure overlays + conflict banner (must cover the chat)
 *   body  Radix popovers/menus/tooltips portal at z-50 — above the panel,
 *         which is what makes the §9 Esc dismissal order portal-first.
 *
 * a11y (ECUX §9.2): the <aside> carries the implicit `complementary`
 * landmark role labelled "Agent" (explicit role omitted — it is redundant
 * on aside per lint); focus ring is the global `:focus-visible` 2px
 * `--signal` outline (theme.css base); `aria-busy` reflects streaming; the
 * grips are pointer-only (keyboard users reach geometry through header
 * controls + shortcuts instead).
 */

import type { ReactElement, ReactNode, PointerEvent as ReactPointerEvent } from "react";
import { useRef, useState } from "react";
import { type ChatLayout, MIN_PANEL } from "./layout";
// Convenience re-export: M4-J's slot imports the pill from the panel module
// (the pinned canonical home is pill.tsx — both import paths work).
export { ChatCollapsedPill, type ChatCollapsedPillProps } from "./pill";
import { useChatLayout } from "./use-layout";

export interface ChatPanelProps {
  layout: ChatLayout;
  streaming: boolean;
  header: ReactNode;
  strip?: ReactNode;
  thread: ReactNode;
  composer: ReactNode;
  footer?: ReactNode;
  /**
   * Pinned contract seam — mode-cycle/close callbacks. The header SLOT
   * (M4-G2) renders its own buttons wired by M4-J; the shell consumes
   * `onClose` for the §9 Esc dismissal (popovers close first in their own
   * portal layer; an unclaimed Esc inside the panel collapses it).
   */
  onCycleMode(): void;
  onClose(): void;
}

/** Interactive descendants never start a header drag (ECUX §2.1). */
const INTERACTIVE_SELECTOR = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "summary",
  "[role='button']",
  "[role='menuitem']",
  "[role='option']",
  "[role='tab']",
  "[contenteditable='true']",
  "[data-no-chat-drag]",
].join(",");

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(INTERACTIVE_SELECTOR) !== null;
}

/** One live pointer drag (header move or SE resize share this shape). */
interface DragState {
  pointerId: number;
  kind: "move" | "resize";
  startX: number;
  startY: number;
  /** The `layout` prop captured at drag start — deltas apply to it. */
  origin: ChatLayout;
}

/** Live sidebar width drag (origin = the RENDERED rail width). */
interface WidthDragState {
  pointerId: number;
  startX: number;
  originW: number;
}

/** ECUX §2.2 sidebar width bounds (min honors the pinned MIN_PANEL floor). */
const SIDEBAR_MAX_W = 560;

function capturePointer(el: HTMLElement, pointerId: number): void {
  // Progressive enhancement (all modern browsers); jsdom/tests skip it —
  // without capture the handle-level listeners still end the drag.
  if (typeof el.setPointerCapture === "function") {
    try {
      el.setPointerCapture(pointerId);
    } catch {
      // Stale/invalid pointer id — drag still tracks via its own listeners.
    }
  }
}

export function ChatPanel({
  layout,
  streaming,
  header,
  strip,
  thread,
  composer,
  footer,
  onClose,
}: ChatPanelProps): ReactElement | null {
  // Shared store actions: the panel mutates the SAME singleton M4-J reads.
  const { move, resize } = useChatLayout();
  const dragRef = useRef<DragState | null>(null);
  const widthDragRef = useRef<WidthDragState | null>(null);
  const [dragging, setDragging] = useState(false);

  // Hooks must run before the collapsed early-return — the panel unmounts
  // to `null` without changing hook order between modes.

  if (layout.mode === "collapsed") return null;

  const endDrag = (): void => {
    dragRef.current = null;
    widthDragRef.current = null;
    setDragging(false);
  };

  // --- floating: header drag + SE resize (shared pointer machinery) ------

  const onGripPointerDown =
    (kind: DragState["kind"]) =>
    (e: ReactPointerEvent<HTMLElement>): void => {
      // Interactive header children (model picker, buttons, …) never drag:
      // excluded by closest() AND by any child that stops propagation itself.
      if (layout.mode !== "floating" || e.button !== 0 || isInteractiveTarget(e.target)) return;
      dragRef.current = {
        pointerId: e.pointerId,
        kind,
        startX: e.clientX,
        startY: e.clientY,
        origin: layout,
      };
      setDragging(true);
      capturePointer(e.currentTarget, e.pointerId);
    };

  const onGripPointerMove = (e: ReactPointerEvent<HTMLElement>): void => {
    const d = dragRef.current;
    if (d === null || e.pointerId !== d.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (d.kind === "move") {
      move(d.origin.x + dx, d.origin.y + dy);
    } else {
      resize(d.origin.w + dx, d.origin.h + dy);
    }
  };

  const onGripPointerEnd = (e: ReactPointerEvent<HTMLElement>): void => {
    const d = dragRef.current;
    if (d !== null && e.pointerId !== d.pointerId) return;
    endDrag();
  };

  // --- sidebar: internal width grip on the rail's left edge --------------

  const onWidthPointerDown = (e: ReactPointerEvent<HTMLElement>): void => {
    if (layout.mode !== "sidebar" || e.button !== 0) return;
    widthDragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      originW: Math.max(MIN_PANEL.w, layout.w),
    };
    setDragging(true);
    capturePointer(e.currentTarget, e.pointerId);
  };

  const onWidthPointerMove = (e: ReactPointerEvent<HTMLElement>): void => {
    const d = widthDragRef.current;
    if (d === null || e.pointerId !== d.pointerId) return;
    // Dragging the left edge LEFT widens the rail; clamped to §2.2 bounds —
    // the store's viewport cap (D-18) still wins on narrow viewports.
    const nextW = Math.min(
      SIDEBAR_MAX_W,
      Math.max(MIN_PANEL.w, d.originW + (d.startX - e.clientX)),
    );
    resize(nextW, layout.h);
  };

  const onWidthPointerEnd = (e: ReactPointerEvent<HTMLElement>): void => {
    const d = widthDragRef.current;
    if (d !== null && e.pointerId !== d.pointerId) return;
    endDrag();
  };

  const floating = layout.mode === "floating";

  // --- Esc dismissal (ECUX §9.1, pinned order: popovers → panel) ---------
  // Peer popovers/menus portal to <body>, so their own Esc handling never
  // bubbles through this tree: they close FIRST by construction. Only an
  // unclaimed Esc inside the panel collapses it (stopPropagation keeps the
  // collapse from reaching page-level listeners).

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>): void => {
    if (e.key === "Escape" && !e.defaultPrevented) {
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <aside
      aria-label="Agent"
      aria-busy={streaming}
      tabIndex={-1}
      data-testid="chat-panel"
      data-chat-mode={layout.mode}
      data-streaming={streaming}
      data-dragging={dragging}
      onKeyDown={onKeyDown}
      className={
        floating
          ? // Floating: the §2.1 box — one soft elevation + hairline border
            // (§9 letter-spec: radius-md, 10px — not radius-lg).
            "absolute z-[35] flex flex-col overflow-hidden rounded-md border border-border bg-panel shadow-modal"
          : // Sidebar: the §2.2 right rail — docked flat, 100% height.
            "absolute top-0 right-0 bottom-0 z-[35] flex flex-col overflow-hidden border-l border-border bg-panel"
      }
      style={
        floating
          ? { left: layout.x, top: layout.y, width: layout.w, height: layout.h }
          : { width: Math.max(MIN_PANEL.w, layout.w) }
      }
    >
      {/* Header — doubles as the floating drag region (ECUX §2.1). */}
      <div
        data-testid="chat-panel-drag-handle"
        className={floating ? "shrink-0 cursor-move touch-none select-none" : "shrink-0"}
        onPointerDown={onGripPointerDown("move")}
        onPointerMove={onGripPointerMove}
        onPointerUp={onGripPointerEnd}
        onPointerCancel={onGripPointerEnd}
        onLostPointerCapture={onGripPointerEnd}
      >
        {header}
      </div>

      {/* Context strip (M4-H) — optional single-line row under the header. */}
      {strip ? (
        <div data-testid="chat-panel-strip" className="shrink-0">
          {strip}
        </div>
      ) : null}

      {/* Thread (M4-F) — flexible middle; peers own their scroll/virtualization.
       * flex+flex-col: ChatThread's root is `flex-1 min-h-0` and only fills
       * this slot if the slot is itself a flex column — as a plain block the
       * thread sized to its CONTENT (W5-07 e2e: the plan card's controls
       * rendered UNDER the composer, pointer-intercepted and unclickable, the
       * newest ~200px of the thread permanently hidden behind it). */}
      <div data-testid="chat-panel-thread" className="flex min-h-0 flex-1 flex-col">
        {thread}
      </div>

      {/* Composer (M4-G) — pinned to the bottom of the stack. */}
      <div data-testid="chat-panel-composer" className="shrink-0">
        {composer}
      </div>

      {/* Footer (M4-G2) — optional credits/shortcut hint row. */}
      {footer ? (
        <div data-testid="chat-panel-footer" className="shrink-0 border-t border-border">
          {footer}
        </div>
      ) : null}

      {floating ? (
        // SE resize grip — pinned 8px hit area (pointer-only affordance;
        // min size + caps enforced by the store's clampLayout).
        <div
          data-testid="chat-panel-resize-grip"
          aria-hidden="true"
          className="absolute right-0 bottom-0 h-2 w-2 cursor-se-resize transition-colors duration-120 ease-out hover:bg-elevated"
          onPointerDown={onGripPointerDown("resize")}
          onPointerMove={onGripPointerMove}
          onPointerUp={onGripPointerEnd}
          onPointerCancel={onGripPointerEnd}
          onLostPointerCapture={onGripPointerEnd}
        />
      ) : (
        // Sidebar width grip — internal left-edge handle (§2.2 divider).
        <div
          data-testid="chat-panel-width-grip"
          aria-hidden="true"
          className="absolute top-0 bottom-0 left-0 z-10 w-2 cursor-col-resize transition-colors duration-120 ease-out hover:bg-signal/40"
          onPointerDown={onWidthPointerDown}
          onPointerMove={onWidthPointerMove}
          onPointerUp={onWidthPointerEnd}
          onPointerCancel={onWidthPointerEnd}
          onLostPointerCapture={onWidthPointerEnd}
        />
      )}
    </aside>
  );
}
