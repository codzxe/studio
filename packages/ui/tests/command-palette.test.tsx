import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette, filterCommands, type Command } from "../src/components/command-palette.js";

const COMMANDS: Command[] = [
  {
    id: "layer.duplicate",
    label: "Duplicate layer",
    group: "Layers",
    keywords: "copy clone",
    run: vi.fn(),
  },
  {
    id: "layer.delete",
    label: "Delete layer",
    group: "Layers",
    run: vi.fn(),
  },
  {
    id: "doc.save",
    label: "Save version",
    group: "Document",
    hint: "⌘S",
    run: vi.fn(),
  },
];

describe("filterCommands (pure)", () => {
  it("returns all commands (copied) for a blank query", () => {
    const all = filterCommands(COMMANDS, "   ");
    expect(all).toHaveLength(3);
    expect(all).not.toBe(COMMANDS);
  });

  it.each([
    ["dup", ["layer.duplicate"]],
    ["DELETE", ["layer.delete"]],
    ["clone", ["layer.duplicate"]], // keywords are filterable but never rendered
    ["layer", ["layer.duplicate", "layer.delete"]],
    ["version", ["doc.save"]],
    ["zzz", []],
  ] as const)("%j → %j ids", (query, expected) => {
    expect(filterCommands(COMMANDS, query).map((c) => c.id)).toEqual(expected);
  });
});

describe("CommandPalette (render + keyboard)", () => {
  it("opens on ⌘K and Ctrl+K, closes on Escape", () => {
    render(<CommandPalette commands={COMMANDS} />);
    expect(screen.queryByRole("combobox")).toBeNull();

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByRole("combobox")).toBeDefined();
    expect(screen.getByRole("listbox", { name: "Commands" })).toBeDefined();

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(screen.queryByRole("combobox")).toBeNull();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByRole("combobox")).toBeDefined();
  });

  it("filters options as you type and shows an empty message when nothing matches", () => {
    render(<CommandPalette commands={COMMANDS} open />);
    expect(screen.getAllByRole("option")).toHaveLength(3);

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "delete" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: /Delete layer/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "zzz" } });
    expect(screen.queryByRole("option")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("No matching commands.");
  });

  it("resets the query each time it opens", () => {
    render(<CommandPalette commands={COMMANDS} />);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "delete" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByRole("combobox")).toHaveValue("");
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("moves the selection with ArrowDown/ArrowUp via aria-activedescendant", () => {
    render(<CommandPalette commands={COMMANDS} open />);
    const input = screen.getByRole("combobox");
    const options = screen.getAllByRole("option");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0]?.id);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(options[1]?.id);
    fireEvent.keyDown(input, { key: "ArrowUp" }); // back to the first option
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0]?.id);
    fireEvent.keyDown(input, { key: "ArrowUp" }); // wraps to the last option
    expect(input.getAttribute("aria-activedescendant")).toBe(options[2]?.id);
    fireEvent.keyDown(input, { key: "End" });
    expect(input.getAttribute("aria-activedescendant")).toBe(options[2]?.id);
    fireEvent.keyDown(input, { key: "Home" });
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0]?.id);
  });

  it("runs the active command on Enter, reports via onOpenChange, and closes", () => {
    const run = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <CommandPalette
        commands={[{ id: "doc.save", label: "Save version", run }]}
        onOpenChange={onOpenChange}
      />,
    );
    // uncontrolled: open via hotkey
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("skips disabled commands on Enter and marks them aria-disabled", () => {
    const run = vi.fn();
    render(
      <CommandPalette
        commands={[{ id: "doc.export", label: "Export", run, disabled: true }]}
        open
      />,
    );
    expect(screen.getByRole("option", { name: "Export" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox")).toBeDefined(); // stays open
  });

  it("renders groups as labelled option groups", () => {
    render(<CommandPalette commands={COMMANDS} open />);
    const groups = screen.getAllByRole("group");
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveAttribute("aria-labelledby");
    expect(screen.getByText("Layers")).toBeDefined();
    expect(screen.getByText("Document")).toBeDefined();
  });

  it("does not bind the hotkey when bindHotkey={false}", () => {
    render(<CommandPalette commands={COMMANDS} bindHotkey={false} />);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});
