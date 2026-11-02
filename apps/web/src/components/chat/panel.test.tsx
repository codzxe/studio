/**
 * ChatPanel tests (M4-E) — the shell over the iframe, rendered with stub
 * slot children (peers own the real header/thread/composer): slot presence,
 * the `complementary` "Agent" landmark, mode variants (floating geometry,
 * sidebar rail + MIN floor, collapsed → null), the §9 Esc dismissal, and
 * the pointer wiring through the SHARED layout store (drag start, the
 * interactive-child exclusion, SE resize, sidebar width grip).
 *
 * jsdom (25) has no PointerEvent constructor and no setPointerCapture, so
 * the pointer tests install a minimal MouseEvent-based shim (only event
 * CONSTRUCTION is affected — handlers see button/clientX/pointerId) and
 * dispatch events directly on the grips, exactly like a captured drag.
 * All deterministic: no real mouse movement, no fake timers.
 */

import { type RenderResult, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ChatLayout, MIN_PANEL, loadLayout, saveLayout } from "./layout";
import { ChatPanel, type ChatPanelProps } from "./panel";

// ---------------------------------------------------------------------------
// jsdom PointerEvent shim (see file header)
// ---------------------------------------------------------------------------

type ShimInit = MouseEventInit & {
  pointerId?: number;
  pointerType?: string;
  isPrimary?: boolean;
};

class PointerEventShim extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly isPrimary: boolean;
  constructor(type: string, init: ShimInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
    this.pointerType = init.pointerType ?? "mouse";
    this.isPrimary = init.isPrimary ?? true;
  }
}

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  Object.defineProperty(window, "PointerEvent", {
    value: PointerEventShim,
    writable: true,
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// Stub slot fixtures
// ---------------------------------------------------------------------------

const LAYOUT_FLOATING: ChatLayout = { mode: "floating", x: 120, y: 80, w: 400, h: 500 };

function renderPanel(
  overrides: Partial<ChatPanelProps> & { layout?: ChatLayout } = {},
): RenderResult & { props: ChatPanelProps } {
  const props: ChatPanelProps = {
    layout: LAYOUT_FLOATING,
    streaming: false,
    header: <div data-testid="stub-header">HDR</div>,
    thread: <div data-testid="stub-thread">THR</div>,
    composer: <div data-testid="stub-composer">COMP</div>,
    onCycleMode: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  return { ...render(<ChatPanel {...props} />), props };
}

// ---------------------------------------------------------------------------
// Rendering: slots, landmark, modes
// ---------------------------------------------------------------------------

describe("ChatPanel — floating shell", () => {
  it("renders every slot, the complementary 'Agent' landmark and the pinned geometry", () => {
    renderPanel({
      strip: <div data-testid="stub-strip">STRIP</div>,
      footer: <div data-testid="stub-footer">FOOT</div>,
    });
    const panel = screen.getByTestId("chat-panel");

    // a11y landmark (ECUX §9.2): role=complementary, labelled "Agent".
    expect(screen.getByRole("complementary", { name: "Agent" })).toBe(panel);
    expect(panel).toHaveAttribute("aria-busy", "false");
    expect(panel).toHaveAttribute("data-chat-mode", "floating");

    // Floating box at layout.x/y/w/h (§2.1).
    expect(panel.style.left).toBe("120px");
    expect(panel.style.top).toBe("80px");
    expect(panel.style.width).toBe("400px");
    expect(panel.style.height).toBe("500px");

    // §9 letter-spec (W2-09): the panel pins radius-md (10px) — never radius-lg.
    expect(panel).toHaveClass("rounded-md");
    expect(panel).not.toHaveClass("rounded-lg");

    // Slots: peers' nodes land in the shell's regions.
    expect(screen.getByTestId("stub-header")).toHaveTextContent("HDR");
    expect(screen.getByTestId("stub-strip")).toHaveTextContent("STRIP");
    expect(screen.getByTestId("stub-thread")).toHaveTextContent("THR");
    expect(screen.getByTestId("stub-composer")).toHaveTextContent("COMP");
    expect(screen.getByTestId("stub-footer")).toHaveTextContent("FOOT");

    // Floating affordances: header drag region + 8px SE grip, no width grip.
    expect(screen.getByTestId("chat-panel-drag-handle")).toBeInTheDocument();
    expect(screen.getByTestId("chat-panel-resize-grip")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-panel-width-grip")).toBeNull();
  });

  it("renders without the optional strip/footer regions", () => {
    renderPanel();
    expect(screen.queryByTestId("chat-panel-strip")).toBeNull();
    expect(screen.queryByTestId("chat-panel-footer")).toBeNull();
  });

  it("reflects streaming on the panel shell (aria-busy + data attr)", () => {
    renderPanel({ streaming: true });
    const panel = screen.getByTestId("chat-panel");
    expect(panel).toHaveAttribute("aria-busy", "true");
    expect(panel).toHaveAttribute("data-streaming", "true");
  });
});

describe("ChatPanel — sidebar rail", () => {
  it("docks right at width = max(MIN_PANEL.w, layout.w) with the width grip", () => {
    renderPanel({
      layout: { mode: "sidebar", x: 999, y: 999, w: 300, h: 100 },
      header: <div>H</div>,
    });
    const panel = screen.getByTestId("chat-panel");
    expect(panel).toHaveAttribute("data-chat-mode", "sidebar");
    expect(panel.style.width).toBe("300px");
    // The rail's position is pure CSS (top/right/bottom = 0) — no left/top.
    expect(panel.style.left).toBe("");
    expect(panel.style.top).toBe("");
    expect(screen.getByTestId("chat-panel-width-grip")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-panel-resize-grip")).toBeNull();
  });

  it("floors the rail at MIN_PANEL.w even for a narrower stored width", () => {
    renderPanel({
      layout: { mode: "sidebar", x: 0, y: 0, w: 200, h: 100 },
      header: <div>H</div>,
    });
    expect(screen.getByTestId("chat-panel").style.width).toBe(`${MIN_PANEL.w}px`);
  });
});

describe("ChatPanel — collapsed", () => {
  it("renders nothing in collapsed mode (the pill is M4-J's)", () => {
    const { container } = renderPanel({ layout: { mode: "collapsed", x: 0, y: 0, w: 0, h: 0 } });
    expect(screen.queryByTestId("chat-panel")).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });
});
// ---------------------------------------------------------------------------
// Keyboard: §9 Esc dismissal (popovers close first — they live in portals)
// ---------------------------------------------------------------------------

describe("ChatPanel — Esc dismissal", () => {
  it("collapses via onClose on an unclaimed Escape inside the panel", () => {
    const { props } = renderPanel();
    fireEvent.keyDown(screen.getByTestId("chat-panel"), { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onCycleMode).not.toHaveBeenCalled();
  });

  it("ignores non-Escape keys", () => {
    const { props } = renderPanel();
    fireEvent.keyDown(screen.getByTestId("chat-panel"), { key: "Enter" });
    expect(props.onClose).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Pointer wiring through the SHARED layout store (fresh registry per test —
// the store singleton must read the seeded localStorage exactly like it
// will on the real page after a reload)
// ---------------------------------------------------------------------------

describe("ChatPanel — drag/resize through the shared layout store", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  /** The M4-J wiring: useChatLayout() feeds the panel's layout prop. */
  async function renderHarness(): Promise<void> {
    const { useChatLayout } = await import("./use-layout");
    const { ChatPanel: Panel } = await import("./panel");
    function Harness() {
      const { layout } = useChatLayout();
      return (
        <Panel
          layout={layout}
          streaming={false}
          header={<span data-testid="hdr-area">h</span>}
          thread={<div>t</div>}
          composer={<div>c</div>}
          onCycleMode={() => {}}
          onClose={() => {}}
        />
      );
    }
    render(<Harness />);
  }

  it("header drag moves the panel (store → harness props → panel)", async () => {
    saveLayout({ mode: "floating", x: 100, y: 100, w: 380, h: 520 });
    await renderHarness();
    const handle = screen.getByTestId("chat-panel-drag-handle");

    fireEvent.pointerDown(handle, { button: 0, clientX: 300, clientY: 300, pointerId: 1 });
    expect(screen.getByTestId("chat-panel")).toHaveAttribute("data-dragging", "true");

    fireEvent.pointerMove(handle, { clientX: 360, clientY: 320, pointerId: 1 });
    const panel = screen.getByTestId("chat-panel");
    expect(panel.style.left).toBe("160px"); // 100 + 60
    expect(panel.style.top).toBe("120px"); // 100 + 20

    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(screen.getByTestId("chat-panel")).toHaveAttribute("data-dragging", "false");
  });

  it("interactive header children never start a drag (§2.1 exclusion)", async () => {
    saveLayout({ mode: "floating", x: 100, y: 100, w: 380, h: 520 });
    const { useChatLayout } = await import("./use-layout");
    const { ChatPanel: Panel } = await import("./panel");
    function Harness() {
      const { layout } = useChatLayout();
      return (
        <Panel
          layout={layout}
          streaming={false}
          header={
            <button type="button" data-testid="hdr-button">
              model
            </button>
          }
          thread={<div>t</div>}
          composer={<div>c</div>}
          onCycleMode={() => {}}
          onClose={() => {}}
        />
      );
    }
    render(<Harness />);

    fireEvent.pointerDown(screen.getByTestId("hdr-button"), {
      button: 0,
      clientX: 300,
      clientY: 300,
      pointerId: 1,
    });
    expect(screen.getByTestId("chat-panel")).toHaveAttribute("data-dragging", "false");

    // Dragging from the plain header area outside the button still works.
    fireEvent.pointerDown(screen.getByTestId("chat-panel-drag-handle"), {
      button: 0,
      clientX: 300,
      clientY: 300,
      pointerId: 2,
    });
    expect(screen.getByTestId("chat-panel")).toHaveAttribute("data-dragging", "true");
  });

  it("SE grip resizes the panel (MIN floor enforced by the store clamp)", async () => {
    saveLayout({ mode: "floating", x: 100, y: 100, w: 380, h: 520 });
    await renderHarness();
    const grip = screen.getByTestId("chat-panel-resize-grip");

    fireEvent.pointerDown(grip, { button: 0, clientX: 300, clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(grip, { clientX: 400, clientY: 360, pointerId: 1 });
    const panel = screen.getByTestId("chat-panel");
    expect(panel.style.width).toBe("480px"); // 380 + 100
    expect(panel.style.height).toBe("580px"); // 520 + 60

    // Shrink below MIN_PANEL → the store clamps to the pinned minimum.
    fireEvent.pointerMove(grip, { clientX: 150, clientY: 100, pointerId: 1 });
    expect(screen.getByTestId("chat-panel").style.width).toBe(`${MIN_PANEL.w}px`);
    expect(screen.getByTestId("chat-panel").style.height).toBe(`${MIN_PANEL.h}px`);
    fireEvent.pointerUp(grip, { pointerId: 1 });
  });

  it("sidebar width grip widens the rail, capped at the ECUX §2.2 max", async () => {
    saveLayout({ mode: "sidebar", x: 0, y: 0, w: 380, h: 520 });
    await renderHarness();
    const grip = screen.getByTestId("chat-panel-width-grip");

    // The jsdom window is 1024 wide → the rail's left edge sits at 644.
    fireEvent.pointerDown(grip, { button: 0, clientX: 644, clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(grip, { clientX: 584, clientY: 300, pointerId: 1 });
    expect(screen.getByTestId("chat-panel").style.width).toBe("440px"); // 380 + 60

    // A huge leftward drag caps at the sidebar maximum (560), then the
    // store's viewport cap still wins on narrow windows (D-18).
    fireEvent.pointerMove(grip, { clientX: 0, clientY: 300, pointerId: 1 });
    expect(screen.getByTestId("chat-panel").style.width).toBe("560px");
    fireEvent.pointerUp(grip, { pointerId: 1 });
    expect(screen.getByTestId("chat-panel")).toHaveAttribute("data-dragging", "false");
  });
});

// ---------------------------------------------------------------------------
// Drag & drop (the full gesture vocabulary): the visible grab bar, sidebar
// drag-out detach, and the right-edge drop-to-dock zone. jsdom window is
// 1024×768 and getBoundingClientRect returns zeros — so the detach placement
// math degrades to grab = client (baseX/baseY = 0/0 + the rebase deltas),
// which these tests pin deterministically.
// ---------------------------------------------------------------------------

describe("ChatPanel — drag & drop (grab bar, detach, drop-to-dock)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  async function renderHarness(): Promise<void> {
    const { useChatLayout } = await import("./use-layout");
    const { ChatPanel: Panel } = await import("./panel");
    function Harness() {
      const { layout } = useChatLayout();
      return (
        <Panel
          layout={layout}
          streaming={false}
          header={<span data-testid="hdr-area">h</span>}
          thread={<div>t</div>}
          composer={<div>c</div>}
          onCycleMode={() => {}}
          onClose={() => {}}
        />
      );
    }
    render(<Harness />);
  }

  it("shows the grab handle bar in BOTH open modes (the drag affordance)", async () => {
    saveLayout({ mode: "floating", x: 100, y: 100, w: 380, h: 520 });
    await renderHarness();
    const handle = screen.getByTestId("chat-panel-drag-handle");
    // The bar sits INSIDE the drag region and the region is movable in both
    // modes (cursor + touch-none — the sidebar rail is draggable OUT).
    expect(handle).toContainElement(screen.getByTestId("chat-drag-grip"));
    expect(handle).toHaveClass("cursor-move", "touch-none");
    cleanup();

    saveLayout({ mode: "sidebar", x: 0, y: 0, w: 380, h: 520 });
    await renderHarness();
    expect(screen.getByTestId("chat-drag-grip")).toBeInTheDocument();
    expect(screen.getByTestId("chat-panel-drag-handle")).toHaveClass("cursor-move");
    // No dock zone until a drag arms it.
    expect(screen.queryByTestId("chat-dock-zone")).toBeNull();
  });

  it("dragging the sidebar header DETACHES the rail into a floating panel under the pointer", async () => {
    saveLayout({ mode: "sidebar", x: 0, y: 0, w: 380, h: 520 });
    await renderHarness();
    const handle = screen.getByTestId("chat-panel-drag-handle");

    fireEvent.pointerDown(handle, { button: 0, clientX: 500, clientY: 300, pointerId: 1 });
    expect(screen.getByTestId("chat-panel")).toHaveAttribute("data-dragging", "true");

    // Sub-threshold jitter stays docked (no accidental detach on a click).
    fireEvent.pointerMove(handle, { clientX: 504, clientY: 300, pointerId: 1 });
    expect(screen.getByTestId("chat-panel")).toHaveAttribute("data-chat-mode", "sidebar");

    // Past the detach threshold: floating, placed under the pointer. jsdom's
    // zero rect makes grab = client, so base = (520-500, 316-300) = (20, 16).
    fireEvent.pointerMove(handle, { clientX: 520, clientY: 316, pointerId: 1 });
    const panel = screen.getByTestId("chat-panel");
    expect(panel).toHaveAttribute("data-chat-mode", "floating");
    expect(panel.style.left).toBe("20px");
    expect(panel.style.top).toBe("16px");
    expect(panel.style.width).toBe("380px"); // geometry memory carried over

    // The gesture continues as a normal floating move (rebased origin).
    fireEvent.pointerMove(handle, { clientX: 560, clientY: 356, pointerId: 1 });
    expect(panel.style.left).toBe("60px"); // 20 + 40
    expect(panel.style.top).toBe("56px"); // 16 + 40

    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(screen.getByTestId("chat-panel")).toHaveAttribute("data-chat-mode", "floating");
    expect(screen.getByTestId("chat-panel")).toHaveAttribute("data-dragging", "false");
  });

  // Chat UI v3: a plain header CLICK toggles the dock both ways — clicking
  // the top of a floating panel slides it into the sidebar (widening to the
  // comfortable rail), clicking the docked rail's chrome floats it back.
  // Drags past the slop never trigger the toggle (pinned above).
  it("a plain floating header CLICK (no travel) DOCKS to the sidebar at the comfortable width", async () => {
    saveLayout({ mode: "floating", x: 100, y: 100, w: 380, h: 520 });
    await renderHarness();
    const handle = screen.getByTestId("chat-panel-drag-handle");
    fireEvent.pointerDown(handle, { button: 0, clientX: 500, clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 502, clientY: 301, pointerId: 1 });
    expect(screen.getByTestId("chat-panel")).toHaveAttribute("data-chat-mode", "sidebar");
    // The dock widened the remembered geometry to the comfortable rail width.
    expect(loadLayout()?.w).toBe(460);
    expect(loadLayout()?.mode).toBe("sidebar");
  });

  it("a plain sidebar header CLICK (no travel) floats the panel back", async () => {
    saveLayout({ mode: "sidebar", x: 0, y: 0, w: 460, h: 520 });
    await renderHarness();
    const handle = screen.getByTestId("chat-panel-drag-handle");
    fireEvent.pointerDown(handle, { button: 0, clientX: 500, clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 502, clientY: 301, pointerId: 1 });
    expect(screen.getByTestId("chat-panel")).toHaveAttribute("data-chat-mode", "floating");
  });

  it("dropping a floating drag at the right edge DOCKS to the sidebar (zone preview armed)", async () => {
    saveLayout({ mode: "floating", x: 100, y: 100, w: 380, h: 520 });
    await renderHarness();
    const handle = screen.getByTestId("chat-panel-drag-handle");

    fireEvent.pointerDown(handle, { button: 0, clientX: 300, clientY: 300, pointerId: 1 });
    // Move to within 32px of the right edge (1024 - 1000 = 24): the drop
    // zone preview lights up and the panel keeps tracking (clamped on x).
    fireEvent.pointerMove(handle, { clientX: 1000, clientY: 300, pointerId: 1 });
    expect(screen.getByTestId("chat-dock-zone")).toBeInTheDocument();
    expect(screen.getByTestId("chat-panel").style.left).toBe("644px"); // 1024-380 clamp

    fireEvent.pointerUp(handle, { clientX: 1000, clientY: 300, pointerId: 1 });
    const panel = screen.getByTestId("chat-panel");
    expect(panel).toHaveAttribute("data-chat-mode", "sidebar");
    expect(screen.queryByTestId("chat-dock-zone")).toBeNull();
    expect(panel).toHaveAttribute("data-dragging", "false");
  });

  it("dropping away from the right edge just moves (no dock, no zone)", async () => {
    saveLayout({ mode: "floating", x: 100, y: 100, w: 380, h: 520 });
    await renderHarness();
    const handle = screen.getByTestId("chat-panel-drag-handle");

    fireEvent.pointerDown(handle, { button: 0, clientX: 300, clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 500, clientY: 340, pointerId: 1 });
    expect(screen.queryByTestId("chat-dock-zone")).toBeNull();
    const panel = screen.getByTestId("chat-panel");
    expect(panel.style.left).toBe("300px"); // 100 + 200
    expect(panel.style.top).toBe("140px"); // 100 + 40

    fireEvent.pointerUp(handle, { clientX: 500, clientY: 340, pointerId: 1 });
    expect(screen.getByTestId("chat-panel")).toHaveAttribute("data-chat-mode", "floating");
  });
});
