/**
 * StudioCommandPalette tests (W1-B — the chat-first ⌘K palette) — the grouped
 * open surface, the case-insensitive label filter, wrapped arrow navigation
 * (skipping disabled rows), the Enter/Escape/backdrop/✕ gestures, the clean
 * re-open, the disabled guard, the reduced-motion opt-out and the pure group
 * helper. Deterministic; no network; jsdom.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  type PaletteCommand,
  StudioCommandPalette,
  groupPaletteCommands,
} from "./studio-command-palette";

function command(
  id: string,
  label: string,
  group: PaletteCommand["group"],
  overrides: Partial<PaletteCommand> = {},
): PaletteCommand {
  return { id, label, group, onSelect: vi.fn(), ...overrides };
}

const baseCommands = () =>
  [
    command("new-chat", "New chat", "Chat", { hint: "⌘⇧O" }),
    command("search-chats", "Search chats", "Chat"),
    command("go-engine", "Go to Engine", "Navigate"),
    command("go-settings", "Open settings", "Settings"),
    command("export-film", "Export film", "Export", { disabled: true }),
  ] satisfies readonly PaletteCommand[];

function renderPalette(commands: readonly PaletteCommand[]) {
  const onClose = vi.fn();
  render(<StudioCommandPalette open onClose={onClose} commands={commands} />);
  return onClose;
}

/** The rendered row with the given data-command-id (throws if missing). */
function item(id: string): HTMLElement {
  const found = screen
    .getAllByTestId("studio-palette-item")
    .find((row) => row.getAttribute("data-command-id") === id);
  if (found === undefined) throw new Error(`No palette item with id "${id}" is rendered.`);
  return found;
}

function byId(commands: readonly PaletteCommand[], id: string): PaletteCommand {
  const found = commands.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`No command fixture with id "${id}".`);
  return found;
}

function mediaStub(matches: boolean): MediaQueryList {
  return {
    matches,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  };
}

describe("StudioCommandPalette — open surface", () => {
  it("renders nothing while closed", () => {
    render(<StudioCommandPalette open={false} onClose={vi.fn()} commands={baseCommands()} />);
    expect(screen.queryByTestId("studio-command-palette")).not.toBeInTheDocument();
  });

  it("groups every command Chat → Navigate → Settings → Export under uppercase headers", () => {
    renderPalette(baseCommands());
    expect(screen.getAllByRole("heading").map((heading) => heading.textContent)).toEqual([
      "Chat",
      "Navigate",
      "Settings",
      "Export",
    ]);
    expect(
      screen
        .getAllByTestId("studio-palette-item")
        .map((row) => row.getAttribute("data-command-id")),
    ).toEqual(["new-chat", "search-chats", "go-engine", "go-settings", "export-film"]);
  });

  it("renders the kbd hint chip and auto-focuses the search input", () => {
    renderPalette(baseCommands());
    expect(screen.getByText("⌘⇧O").tagName).toBe("KBD");
    expect(screen.getByTestId("studio-palette-input")).toHaveFocus();
  });

  it("wires aria-activedescendant to the first selectable row", () => {
    renderPalette(baseCommands());
    expect(screen.getByTestId("studio-palette-input")).toHaveAttribute(
      "aria-activedescendant",
      "studio-palette-option-new-chat",
    );
    expect(item("new-chat")).toHaveAttribute("data-active");
    expect(item("export-film")).not.toHaveAttribute("data-active");
  });
});

describe("StudioCommandPalette — filtering", () => {
  it("filters by case-insensitive label substring and collapses empty groups", async () => {
    const user = userEvent.setup();
    renderPalette(baseCommands());
    await user.type(screen.getByTestId("studio-palette-input"), "CHAT");
    expect(
      screen
        .getAllByTestId("studio-palette-item")
        .map((row) => row.getAttribute("data-command-id")),
    ).toEqual(["new-chat", "search-chats"]);
    expect(screen.getAllByRole("heading").map((heading) => heading.textContent)).toEqual(["Chat"]);
  });

  it("shows the no-match copy when nothing matches", async () => {
    const user = userEvent.setup();
    renderPalette(baseCommands());
    await user.type(screen.getByTestId("studio-palette-input"), "zzz");
    expect(screen.getByText("No matching commands")).toBeInTheDocument();
    expect(screen.queryByTestId("studio-palette-item")).not.toBeInTheDocument();
  });

  it("starts every open clean (query reset, whole list back)", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const view = render(<StudioCommandPalette open onClose={onClose} commands={baseCommands()} />);
    await user.type(screen.getByTestId("studio-palette-input"), "eng");
    expect(screen.getAllByTestId("studio-palette-item")).toHaveLength(1);

    view.rerender(
      <StudioCommandPalette open={false} onClose={onClose} commands={baseCommands()} />,
    );
    view.rerender(<StudioCommandPalette open onClose={onClose} commands={baseCommands()} />);
    expect(screen.getByTestId("studio-palette-input")).toHaveValue("");
    expect(screen.getAllByTestId("studio-palette-item")).toHaveLength(5);
  });
});

describe("StudioCommandPalette — keyboard", () => {
  it("moves the active row with ↓ and wraps forward past the disabled row", async () => {
    const user = userEvent.setup();
    renderPalette(baseCommands());
    screen.getByTestId("studio-palette-input").focus();
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(item("go-settings")).toHaveAttribute("data-active");
    await user.keyboard("{ArrowDown}"); // the export row is disabled → wrap to the first
    expect(item("new-chat")).toHaveAttribute("data-active");
    expect(item("export-film")).not.toHaveAttribute("data-active");
  });

  it("wraps backwards with ↑ (skipping the disabled row)", async () => {
    const user = userEvent.setup();
    renderPalette(baseCommands());
    screen.getByTestId("studio-palette-input").focus();
    await user.keyboard("{ArrowUp}");
    expect(item("go-settings")).toHaveAttribute("data-active");
  });

  it("runs the active command on Enter, then closes", async () => {
    const user = userEvent.setup();
    const commands = baseCommands();
    const onClose = renderPalette(commands);
    screen.getByTestId("studio-palette-input").focus();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(byId(commands, "search-chats").onSelect).toHaveBeenCalledOnce();
    expect(byId(commands, "new-chat").onSelect).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on Escape without running anything", async () => {
    const user = userEvent.setup();
    const commands = baseCommands();
    const onClose = renderPalette(commands);
    screen.getByTestId("studio-palette-input").focus();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
    for (const entry of commands) expect(entry.onSelect).not.toHaveBeenCalled();
  });
});

describe("StudioCommandPalette — pointer", () => {
  it("runs a row on click, then closes", async () => {
    const user = userEvent.setup();
    const commands = baseCommands();
    const onClose = renderPalette(commands);
    await user.click(item("go-engine"));
    expect(byId(commands, "go-engine").onSelect).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes from the backdrop, not from clicks inside the card", async () => {
    const user = userEvent.setup();
    const onClose = renderPalette(baseCommands());
    await user.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("studio-palette-backdrop"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes from the ✕ affordance", async () => {
    const user = userEvent.setup();
    const onClose = renderPalette(baseCommands());
    await user.click(screen.getByTestId("studio-palette-close"));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("StudioCommandPalette — disabled rows", () => {
  it("renders disabled rows inert and unreachable by the arrows", async () => {
    const user = userEvent.setup();
    const commands = baseCommands();
    const onClose = renderPalette(commands);
    const row = item("export-film");
    expect(row).toBeDisabled();
    expect(row).toHaveAttribute("aria-disabled", "true");
    await user.click(row);
    expect(byId(commands, "export-film").onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    screen.getByTestId("studio-palette-input").focus();
    await user.keyboard("{ArrowDown}".repeat(4));
    expect(item("new-chat")).toHaveAttribute("data-active");
    expect(item("export-film")).not.toHaveAttribute("data-active");
  });
});

describe("StudioCommandPalette — motion", () => {
  it("animates the entrance by default (jsdom matchMedia never matches)", () => {
    renderPalette(baseCommands());
    expect(screen.getByTestId("studio-command-palette").className).toContain("animate-overlay-in");
    expect(screen.getByRole("dialog").className).toContain("animate-pop-in");
  });

  it("skips the entrance animations when the user prefers reduced motion", () => {
    const spy = vi.spyOn(window, "matchMedia").mockImplementation(() => mediaStub(true));
    try {
      renderPalette(baseCommands());
      expect(screen.getByTestId("studio-command-palette").className).not.toContain(
        "animate-overlay-in",
      );
      expect(screen.getByRole("dialog").className).not.toContain("animate-pop-in");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("groupPaletteCommands (pure)", () => {
  it("filters case-insensitively on label and keeps the fixed group order", () => {
    const commands = baseCommands();
    const grouped = groupPaletteCommands(commands, "CHAT");
    expect(grouped.map((group) => group.label)).toEqual(["Chat"]);
    expect(grouped[0]?.items.map((entry) => entry.id)).toEqual(["new-chat", "search-chats"]);

    expect(groupPaletteCommands(commands, "  film ").map((group) => group.label)).toEqual([
      "Export",
    ]);
    expect(groupPaletteCommands(commands, "").map((group) => group.label)).toEqual([
      "Chat",
      "Navigate",
      "Settings",
      "Export",
    ]);
    expect(groupPaletteCommands(commands, "zzz")).toEqual([]);
  });
});
