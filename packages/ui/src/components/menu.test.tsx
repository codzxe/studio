import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./button";
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuItemIndicator,
  MenuItemShortcut,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./menu";

function renderMenu(extra?: React.ReactNode) {
  const onOpenChange = vi.fn();
  const onSelectRename = vi.fn();
  const onSelectDelete = vi.fn();
  const view = render(
    <Menu onOpenChange={onOpenChange}>
      <MenuTrigger asChild>
        <Button variant="ghost">Project actions</Button>
      </MenuTrigger>
      <MenuContent aria-label="Project actions">
        <MenuLabel>Project</MenuLabel>
        <MenuItem onSelect={onSelectRename}>
          Rename project
          <MenuItemShortcut>⌘R</MenuItemShortcut>
        </MenuItem>
        <MenuItem disabled onSelect={onSelectDelete}>
          Delete project
        </MenuItem>
        <MenuSeparator />
        <MenuRadioGroup value="owner">
          <MenuRadioItem value="owner">Owner</MenuRadioItem>
          <MenuRadioItem value="editor">Editor</MenuRadioItem>
        </MenuRadioGroup>
        <MenuCheckboxItem checked>
          <MenuItemIndicator aria-hidden="true">✓</MenuItemIndicator>
          Follow comments
        </MenuCheckboxItem>
        {extra}
      </MenuContent>
    </Menu>,
  );
  return { onOpenChange, onSelectRename, onSelectDelete, ...view };
}

describe("Menu (§7.6 dropdown menu)", () => {
  it("opens a labelled menu with menu items on click", async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole("button", { name: "Project actions" }));
    const menu = screen.getByRole("menu");
    expect(menu).toHaveAttribute("data-state", "open");
    expect(screen.getByRole("menuitem", { name: "Rename project" })).toBeInTheDocument();
  });

  it("items are 32px tall with the shortcut right-aligned in mono (§7.6)", async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole("button", { name: "Project actions" }));
    const item = screen.getByRole("menuitem", { name: "Rename project" });
    expect(item.className).toContain("h-8");
    const shortcut = screen.getByText("⌘R");
    expect(shortcut.getAttribute("aria-hidden")).toBe("true");
    expect(shortcut.className).toContain("font-mono");
  });

  it("keyboard: arrows highlight items and Enter runs the selection", async () => {
    const user = userEvent.setup();
    const { onSelectRename } = renderMenu();
    const trigger = screen.getByRole("button", { name: "Project actions" });
    trigger.focus();
    await user.keyboard("{ArrowDown}"); // opens and highlights first item
    const highlighted = screen.getByRole("menu").querySelector("[data-highlighted]");
    expect(highlighted).toHaveTextContent("Rename project");
    await user.keyboard("{Enter}");
    expect(onSelectRename).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("Escape closes without selecting (§12)", async () => {
    const user = userEvent.setup();
    const { onOpenChange, onSelectRename } = renderMenu();
    await user.click(screen.getByRole("button", { name: "Project actions" }));
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSelectRename).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("disabled items are marked for assistive tech and cannot be selected", async () => {
    const user = userEvent.setup();
    const { onSelectDelete } = renderMenu();
    await user.click(screen.getByRole("button", { name: "Project actions" }));
    const deleteItem = screen.getByRole("menuitem", { name: "Delete project" });
    expect(deleteItem).toHaveAttribute("aria-disabled", "true");
    expect(deleteItem).toHaveAttribute("data-disabled", "");
    await user.click(deleteItem);
    expect(onSelectDelete).not.toHaveBeenCalled();
  });

  it("renders labels, separators, radio and checkbox items with state (§7.6)", async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole("button", { name: "Project actions" }));
    expect(screen.getByText("Project")).toBeInTheDocument(); // MenuLabel
    expect(screen.getByRole("separator")).toBeInTheDocument();
    const owner = screen.getByRole("menuitemradio", { name: "Owner" });
    expect(owner).toHaveAttribute("aria-checked", "true");
    const follow = screen.getByRole("menuitemcheckbox", { name: "Follow comments" });
    expect(follow).toHaveAttribute("aria-checked", "true");
  });
});
