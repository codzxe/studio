/**
 * StudioShortcutsModal tests — the shortcut help overlay: hidden while
 * closed, every group + item rendered while open (Mac glyphs by default
 * under jsdom), Escape / backdrop / ✕ dismissal, focus landing on the ✕
 * affordance, and the per-platform re-tokenization of ⌘/⇧. Deterministic;
 * no network; jsdom.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SHORTCUT_GROUPS,
  StudioShortcutsModal,
  isMacPlatform,
  shortcutTokens,
} from "./studio-shortcuts-modal";

describe("StudioShortcutsModal — visibility", () => {
  it("renders nothing while open=false", () => {
    render(<StudioShortcutsModal open={false} onClose={vi.fn()} />);
    expect(screen.queryByTestId("studio-shortcuts-modal")).not.toBeInTheDocument();
  });

  it("mounts the dialog when open", () => {
    render(<StudioShortcutsModal open onClose={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    expect(screen.getByTestId("studio-shortcuts-modal")).toBeInTheDocument();
  });
});

describe("StudioShortcutsModal — rendered shortcuts", () => {
  it("renders every group heading in order", () => {
    render(<StudioShortcutsModal open onClose={vi.fn()} />);
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(SHORTCUT_GROUPS.map((group) => group.title));
  });

  it("renders every shortcut description from SHORTCUT_GROUPS", () => {
    render(<StudioShortcutsModal open onClose={vi.fn()} />);
    const items = SHORTCUT_GROUPS.flatMap((group) => group.items);
    expect(screen.getAllByRole("listitem")).toHaveLength(items.length);
    for (const item of items) {
      expect(screen.getByText(item.description)).toBeInTheDocument();
    }
  });

  it("renders one kbd chip per Mac token (jsdom defaults to the glyphs)", () => {
    const { container } = render(<StudioShortcutsModal open onClose={vi.fn()} />);
    const expectedChips = SHORTCUT_GROUPS.flatMap((group) => group.items)
      .map((item) => shortcutTokens(item.keys, true).length)
      .reduce((sum, count) => sum + count, 0);
    expect(container.querySelectorAll("kbd")).toHaveLength(expectedChips);

    // ⌘ appears in ⌘⇧O / ⌘B / ⌘K / ⌘.; "Enter" in Enter and Shift+Enter.
    expect(screen.getAllByText("⌘")).toHaveLength(4);
    expect(screen.getAllByText("⇧")).toHaveLength(1);
    expect(screen.getAllByText("Enter")).toHaveLength(2);
    expect(screen.getByText(".")).toBeInTheDocument();
    expect(screen.getByText("↓")).toBeInTheDocument();
    expect(screen.getByText("✎")).toBeInTheDocument();
    // Mac glyphs only: no Ctrl anywhere; "Shift" shows just for Shift+Enter.
    expect(screen.queryByText("Ctrl")).not.toBeInTheDocument();
    expect(screen.getAllByText("Shift")).toHaveLength(1);
  });
});

describe("StudioShortcutsModal — dismissal", () => {
  it("closes on Escape (and ignores other keys)", () => {
    const onCloseSpy = vi.fn();
    render(<StudioShortcutsModal open onClose={onCloseSpy} />);
    fireEvent.keyDown(window, { key: "b" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCloseSpy).toHaveBeenCalledOnce();
  });

  it("does not listen for Escape while closed", () => {
    const onCloseSpy = vi.fn();
    render(<StudioShortcutsModal open={false} onClose={onCloseSpy} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCloseSpy).not.toHaveBeenCalled();
  });

  it("closes on backdrop click", async () => {
    const user = userEvent.setup();
    const onCloseSpy = vi.fn();
    render(<StudioShortcutsModal open onClose={onCloseSpy} />);
    await user.click(screen.getByTestId("studio-shortcuts-backdrop"));
    expect(onCloseSpy).toHaveBeenCalledOnce();
  });

  it("closes from the ✕ affordance", async () => {
    const user = userEvent.setup();
    const onCloseSpy = vi.fn();
    render(<StudioShortcutsModal open onClose={onCloseSpy} />);
    await user.click(screen.getByTestId("studio-shortcuts-close"));
    expect(onCloseSpy).toHaveBeenCalledOnce();
  });

  it("moves focus to the close button on open", () => {
    render(<StudioShortcutsModal open onClose={vi.fn()} />);
    expect(screen.getByTestId("studio-shortcuts-close")).toHaveFocus();
  });
});

describe("StudioShortcutsModal — platform hint", () => {
  const originalPlatform = window.navigator.platform;

  afterEach(() => {
    Object.defineProperty(window.navigator, "platform", {
      value: originalPlatform,
      configurable: true,
    });
  });

  it("detects Mac from navigator.platform and defaults unknown (jsdom) to Mac", () => {
    Object.defineProperty(window.navigator, "platform", {
      value: "MacIntel",
      configurable: true,
    });
    expect(isMacPlatform()).toBe(true);

    Object.defineProperty(window.navigator, "platform", { value: "Win32", configurable: true });
    expect(isMacPlatform()).toBe(false);

    Object.defineProperty(window.navigator, "platform", { value: "", configurable: true });
    expect(isMacPlatform()).toBe(true);
  });

  it("swaps ⌘/⇧ for Ctrl/Shift words off-Mac, keeping the chip count", () => {
    Object.defineProperty(window.navigator, "platform", { value: "Win32", configurable: true });
    const { container } = render(<StudioShortcutsModal open onClose={vi.fn()} />);
    expect(screen.getAllByText("Ctrl")).toHaveLength(4);
    expect(screen.getAllByText("Shift")).toHaveLength(2);
    expect(container.querySelectorAll("kbd")).toHaveLength(14);
    expect(screen.queryByText("⌘")).not.toBeInTheDocument();
    expect(screen.queryByText("⇧")).not.toBeInTheDocument();
  });
});

describe("shortcutTokens (pure)", () => {
  it("tokenizes glyph runs and word combos per platform", () => {
    expect(shortcutTokens("⌘⇧O", true)).toEqual(["⌘", "⇧", "O"]);
    expect(shortcutTokens("⌘⇧O", false)).toEqual(["Ctrl", "Shift", "O"]);
    expect(shortcutTokens("⌘B", false)).toEqual(["Ctrl", "B"]);
    expect(shortcutTokens("Shift+Enter", true)).toEqual(["Shift", "Enter"]);
    expect(shortcutTokens("Shift+Enter", false)).toEqual(["Shift", "Enter"]);
    expect(shortcutTokens("⌘.", false)).toEqual(["Ctrl", "."]);
    expect(shortcutTokens("↓", false)).toEqual(["↓"]);
  });
});
