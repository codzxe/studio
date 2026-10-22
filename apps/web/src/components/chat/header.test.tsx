/**
 * ChatHeader tests (M4-G2) — the Wave-2 pinned ChatHeaderProps surface:
 * status dot per run phase (§3.1), Context N button, compact action row, the
 * ⋯ more menu, and the entitlement-driven ModelPicker wiring inside the
 * header. Deterministic RTL + user-event against the real @studio/ui
 * primitives (Radix popover/menu behind them); no network, no fake timers.
 */

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunPhase } from "@/lib/chat/types";
import { ChatHeader } from "./header";
import type { ModelsListEntry } from "./model-picker";

afterEach(() => {
  cleanup();
});

const FAST: ModelsListEntry = {
  id: "studio-fast",
  tier: "fast",
  use: "Cheap planning, classification, quick edits",
  creditsPer1kInput: 0.01,
  creditsPer1kOutput: 0.03,
};

const SMART: ModelsListEntry = {
  id: "studio-smart",
  tier: "smart",
  use: "Main agent, multi-step edits, tool use",
  creditsPer1kInput: 0.1,
  creditsPer1kOutput: 0.4,
};

const TWO_MODELS: readonly ModelsListEntry[] = [FAST, SMART];

interface HeaderCallbacks {
  readonly onModelPick: ReturnType<typeof vi.fn>;
  readonly onContextClick: ReturnType<typeof vi.fn>;
  readonly onCycleMode: ReturnType<typeof vi.fn>;
  readonly onToggleDock: ReturnType<typeof vi.fn>;
  readonly onClose: ReturnType<typeof vi.fn>;
  readonly onNewChat: ReturnType<typeof vi.fn>;
  readonly onResetPosition: ReturnType<typeof vi.fn>;
  readonly onShortcuts: ReturnType<typeof vi.fn>;
}

function renderHeader(
  overrides: Partial<{
    phase: RunPhase;
    title: string;
    models: readonly ModelsListEntry[] | null;
    activeModelId: string | null;
    contextCount: number;
  }> = {},
): HeaderCallbacks {
  const callbacks: HeaderCallbacks = {
    onModelPick: vi.fn(),
    onContextClick: vi.fn(),
    onCycleMode: vi.fn(),
    onToggleDock: vi.fn(),
    onClose: vi.fn(),
    onNewChat: vi.fn(),
    onResetPosition: vi.fn(),
    onShortcuts: vi.fn(),
  };
  render(
    <ChatHeader
      phase={overrides.phase ?? "idle"}
      title={overrides.title ?? "Agent"}
      models={overrides.models === undefined ? TWO_MODELS : overrides.models}
      activeModelId={overrides.activeModelId ?? "studio-smart"}
      onModelPick={callbacks.onModelPick}
      contextCount={overrides.contextCount ?? 3}
      onContextClick={callbacks.onContextClick}
      onCycleMode={callbacks.onCycleMode}
      onToggleDock={callbacks.onToggleDock}
      onClose={callbacks.onClose}
      onNewChat={callbacks.onNewChat}
      onResetPosition={callbacks.onResetPosition}
      onShortcuts={callbacks.onShortcuts}
    />,
  );
  return callbacks;
}

/** The decorative dot is StatusDot's first child; the label follows it. */
function statusDot(): HTMLElement {
  const status = screen.getByTestId("chat-status");
  const dot = status.firstElementChild;
  if (!(dot instanceof HTMLElement)) throw new Error("status dot not rendered");
  return dot;
}

// ---------------------------------------------------------------------------
// Status dot per phase (§3.1: dim / pulse / ok / error — no spinners)
// ---------------------------------------------------------------------------

describe("ChatHeader — status dot", () => {
  it("idle: renders the title with a dim dot", () => {
    renderHeader({ phase: "idle", title: "Agent" });
    expect(screen.getByTestId("chat-title")).toHaveTextContent("Agent");
    expect(screen.getByTestId("chat-header")).toHaveAttribute("data-phase", "idle");
    expect(statusDot()).toHaveClass("bg-muted");
    expect(screen.queryByTestId("button-loading")).not.toBeInTheDocument();
  });

  it("streaming: animated pulse dot in the signal tone (no spinners in the header)", () => {
    renderHeader({ phase: "streaming" });
    const dot = statusDot();
    expect(dot).toHaveClass("bg-signal");
    expect(dot).toHaveClass("animate-pulse-dot");
    expect(screen.queryByTestId("button-loading")).not.toBeInTheDocument();
  });

  it("done: ok tone", () => {
    renderHeader({ phase: "done" });
    expect(statusDot()).toHaveClass("bg-success");
  });

  it("failed and cancelled: error tone", () => {
    renderHeader({ phase: "failed" });
    expect(statusDot()).toHaveClass("bg-danger");
    cleanup();
    renderHeader({ phase: "cancelled" });
    expect(statusDot()).toHaveClass("bg-danger");
  });

  it("renders the thread title when the run has one", () => {
    renderHeader({ title: "Springy headline pop-in" });
    expect(screen.getByTestId("chat-title")).toHaveTextContent("Springy headline pop-in");
  });
});

// ---------------------------------------------------------------------------
// Context N button (§3.1: opens the context popover; §3.2: hidden at 0)
// ---------------------------------------------------------------------------

describe("ChatHeader — Context button", () => {
  it("hidden when contextCount is 0", () => {
    renderHeader({ contextCount: 0 });
    expect(screen.queryByTestId("chat-context-button")).not.toBeInTheDocument();
  });

  it("visible with the count and fires onContextClick on click", async () => {
    const user = userEvent.setup();
    const callbacks = renderHeader({ contextCount: 3 });
    const button = screen.getByTestId("chat-context-button");
    expect(button).toHaveTextContent("Context 3");
    await user.click(button);
    expect(callbacks.onContextClick).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Action row (§3.1: ⤢ cycle, ⇥ dock, × close — 28px, tooltip-labelled)
// ---------------------------------------------------------------------------

describe("ChatHeader — actions", () => {
  it("cycle/dock/close buttons carry labels and fire their callbacks", async () => {
    const user = userEvent.setup();
    const callbacks = renderHeader();
    expect(screen.getByRole("button", { name: "Cycle panel mode" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Toggle sidebar dock" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close chat" })).toBeInTheDocument();

    await user.click(screen.getByTestId("chat-cycle-mode-button"));
    expect(callbacks.onCycleMode).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId("chat-dock-button"));
    expect(callbacks.onToggleDock).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId("chat-close-button"));
    expect(callbacks.onClose).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// More menu (§3.1 ⋯: New chat / Reset position / Keyboard shortcuts only —
// History + Clear context are M5/M4-H and stay out per the pinned props)
// ---------------------------------------------------------------------------

describe("ChatHeader — more menu", () => {
  it("opens and fires onNewChat / onResetPosition / onShortcuts", async () => {
    const user = userEvent.setup();
    const callbacks = renderHeader();

    await user.click(screen.getByTestId("chat-more-button"));
    const menu = screen.getByTestId("chat-more-menu");
    expect(within(menu).getByRole("menuitem", { name: "New chat" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Reset position" })).toBeInTheDocument();
    expect(
      within(menu).getByRole("menuitem", { name: "Keyboard shortcuts" }),
    ).toBeInTheDocument();
    // History / Clear context are M5/M4-H — absent per the pinned props.
    expect(within(menu).queryByText("History")).not.toBeInTheDocument();
    expect(within(menu).queryByText("Clear context")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("chat-menu-new-chat"));
    expect(callbacks.onNewChat).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId("chat-more-button"));
    await user.click(screen.getByTestId("chat-menu-reset-position"));
    expect(callbacks.onResetPosition).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId("chat-more-button"));
    await user.click(screen.getByTestId("chat-menu-shortcuts"));
    expect(callbacks.onShortcuts).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Model picker wiring (entitlement surface via props — M4-A2's wire)
// ---------------------------------------------------------------------------

describe("ChatHeader — model picker wiring", () => {
  it("renders the active model's name from the injected models list", () => {
    renderHeader();
    expect(screen.getByTestId("chat-model-button")).toHaveTextContent("Smart");
  });

  it("models===null shows the 'Model…' placeholder", () => {
    renderHeader({ models: null });
    expect(screen.getByTestId("chat-model-button")).toHaveTextContent("Model…");
  });

  it("models===[] hides the picker inside the header", () => {
    renderHeader({ models: [] });
    expect(screen.queryByTestId("chat-model-button")).not.toBeInTheDocument();
  });

  it("a popover pick propagates onModelPick with the model id", async () => {
    const user = userEvent.setup();
    const callbacks = renderHeader();
    await user.click(screen.getByTestId("chat-model-button"));
    await user.click(screen.getByTestId("chat-model-option-studio-fast"));
    expect(callbacks.onModelPick).toHaveBeenCalledTimes(1);
    expect(callbacks.onModelPick).toHaveBeenCalledWith("studio-fast");
  });
});
