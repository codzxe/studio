/**
 * CommandPalette — §7.10 example gallery (documentation-as-code).
 *
 * 560px palette, top 20vh, search + fixed group order (Projects, Actions,
 * Navigation, Help), keyboard-first: ↑/↓ move, Home/End jump, Enter runs,
 * Esc closes. Bind ⌘K/Ctrl+K in the shell — not while the editor iframe has
 * focus. Typecheck-only docs — never run by vitest.
 */
import { useState } from "react";
import { Button } from "./button";
import { type CommandItem, CommandPalette } from "./command-palette";

const labelClass = "text-label uppercase tracking-[0.06em] text-muted";

const items: CommandItem[] = [
  { id: "p1", group: "projects", label: "Launch film", onSelect: () => {} },
  { id: "p2", group: "projects", label: "Teaser", onSelect: () => {} },
  { id: "a1", group: "actions", label: "New project", shortcut: "⌘N", onSelect: () => {} },
  { id: "a2", group: "actions", label: "Import .ecproj", onSelect: () => {} },
  { id: "n1", group: "navigation", label: "Billing", onSelect: () => {} },
  { id: "n2", group: "navigation", label: "Settings", onSelect: () => {} },
  { id: "h1", group: "help", label: "Keyboard shortcuts", onSelect: () => {} },
];

export default function CommandPaletteExample() {
  const [open, setOpen] = useState(false);

  return (
    <section
      aria-label="Command palette examples"
      className="flex max-w-xl flex-col gap-8 rounded-md border border-border bg-panel p-6"
    >
      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Bound to ⌘K — open on demand</h3>
        <p className="text-caption text-secondary">
          In the shell, listen for ⌘K/Ctrl+K and flip <code>open</code>. The palette resets its
          query on every open and never binds keys while the editor iframe has focus.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button onClick={() => setOpen(true)}>Open palette (⌘K)</Button>
        </div>
      </div>

      <CommandPalette open={open} onOpenChange={setOpen} items={items} />
    </section>
  );
}
