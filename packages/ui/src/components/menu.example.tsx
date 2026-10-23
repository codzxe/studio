import { Copy, Ellipsis, FileText, Pencil, Share, Trash } from "lucide-react";
/**
 * Menu — §7.6 example gallery (documentation-as-code).
 *
 * Radix DropdownMenu: 32px items, 16px icons, right-aligned mono shortcuts,
 * labels, separators, checkbox and radio items. Typecheck-only docs — never
 * run by vitest.
 */
import { useState } from "react";
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

const labelClass = "text-label uppercase tracking-[0.06em] text-muted";

export default function MenuExample() {
  const [follow, setFollow] = useState(true);
  const [density, setDensity] = useState("comfortable");

  return (
    <section
      aria-label="Menu examples"
      className="flex max-w-xl flex-col gap-8 rounded-md border border-border bg-panel p-6"
    >
      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Project menu — items, shortcuts, disabled (§7.6)</h3>
        <Menu>
          <MenuTrigger asChild>
            <Button size="iconSm" variant="ghost" aria-label="Project actions">
              <Ellipsis size={16} strokeWidth={1.75} aria-hidden="true" />
            </Button>
          </MenuTrigger>
          <MenuContent aria-label="Project actions">
            <MenuLabel>Project</MenuLabel>
            <MenuItem>
              <Pencil size={16} strokeWidth={1.75} aria-hidden="true" />
              Rename project
              <MenuItemShortcut>⌘R</MenuItemShortcut>
            </MenuItem>
            <MenuItem>
              <Copy size={16} strokeWidth={1.75} aria-hidden="true" />
              Duplicate
              <MenuItemShortcut>⌘D</MenuItemShortcut>
            </MenuItem>
            <MenuItem disabled>
              <Share size={16} strokeWidth={1.75} aria-hidden="true" />
              Share
            </MenuItem>
            <MenuSeparator />
            <MenuItem>
              <FileText size={16} strokeWidth={1.75} aria-hidden="true" />
              Open activity
            </MenuItem>
            <MenuSeparator />
            <MenuItem>
              <Trash size={16} strokeWidth={1.75} aria-hidden="true" />
              Delete project
              <MenuItemShortcut>⇧⌫</MenuItemShortcut>
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Radio + checkbox state</h3>
        <Menu>
          <MenuTrigger asChild>
            <Button variant="secondary">View options</Button>
          </MenuTrigger>
          <MenuContent aria-label="View options">
            <MenuLabel>Density</MenuLabel>
            <MenuRadioGroup value={density} onValueChange={setDensity}>
              <MenuRadioItem value="comfortable">Comfortable</MenuRadioItem>
              <MenuRadioItem value="compact">Compact</MenuRadioItem>
            </MenuRadioGroup>
            <MenuSeparator />
            <MenuCheckboxItem checked={follow} onCheckedChange={setFollow}>
              <MenuItemIndicator aria-hidden="true">✓</MenuItemIndicator>
              Follow comments
            </MenuCheckboxItem>
          </MenuContent>
        </Menu>
      </div>
    </section>
  );
}
