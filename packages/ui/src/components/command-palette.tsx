import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Search } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "../lib/cn.js";

/**
 * CommandPalette — ⌘K / Ctrl+K command surface for the editor's manual command
 * execution UI (§13.1 `POST /v1/documents/:id/commands` — power users get the same
 * allowlisted commands the agent uses, per §13.4). The palette is a pure registry
 * renderer: the app owns the command list (ids, labels, enablement) and passes it as
 * a prop; this component never fetches or knows engine ids.
 *
 * A11y: aria 1.2 combobox-with-listbox pattern —
 * - input has `role="combobox"` + `aria-expanded`/`aria-controls`/`aria-activedescendant`
 * - options are `role="option"` inside a `role="listbox"`, grouped via `role="group"`
 * - keyboard: ↑/↓ cycle (wrapping), Home/End jump, Enter runs, Esc closes
 * - focus stays on the input the whole time (aria-activedescendant carries selection)
 * Modal behaviour (focus trap, Escape, scroll lock, focus restore) comes from Radix Dialog.
 */

export interface Command {
  /** Stable id (registry key); also used for DOM ids — keep it whitespace-free. */
  readonly id: string;
  /** Visible, filterable label. */
  readonly label: string;
  /** Execute the command; the palette closes after a successful run. */
  readonly run: () => void;
  /** Optional section heading (commands keep registry order). */
  readonly group?: string;
  /** Extra filterable text (aliases, keywords) — never rendered. */
  readonly keywords?: string;
  /** Right-aligned affordance hint (e.g. a shortcut). */
  readonly hint?: ReactNode;
  readonly icon?: ReactNode;
  readonly disabled?: boolean;
}

export interface CommandPaletteProps {
  /** Command registry to render; source of truth is the app (live engine allowlist). */
  commands: readonly Command[];
  /** Controlled open state; omit to drive it internally (⌘K toggles). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Bind ⌘K (macOS) / Ctrl+K (Windows/Linux) to toggle (default). */
  bindHotkey?: boolean;
  placeholder?: string;
  emptyMessage?: string;
  className?: string;
}

/** Pure filter — case-insensitive substring over label + group + keywords. */
export function filterCommands(commands: readonly Command[], query: string): Command[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...commands];
  return commands.filter((command) =>
    `${command.label}\n${command.group ?? ""}\n${command.keywords ?? ""}`
      .toLowerCase()
      .includes(needle),
  );
}

interface CommandSection {
  group: string | undefined;
  groupId: string;
  items: { command: Command; index: number }[];
}

function optionId(listId: string, command: Command): string {
  return `${listId}-option-${command.id.replace(/\s+/g, "-")}`;
}

export function CommandPalette({
  commands,
  open,
  onOpenChange,
  bindHotkey = true,
  placeholder = "Type a command or search…",
  emptyMessage = "No matching commands.",
  className,
}: CommandPaletteProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listId = useId().replaceAll(":", "");
  const openRef = useRef(false);
  const activeOptionRef = useRef<HTMLDivElement | null>(null);

  const isOpen = open ?? internalOpen;
  // Mirror the open state for the window-level hotkey listener (avoids stale
  // closures without re-binding the listener on every toggle).
  useEffect(() => {
    openRef.current = isOpen;
  }, [isOpen]);

  const setOpen = useCallback(
    (next: boolean) => {
      setInternalOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  // ⌘K / Ctrl+K toggles the palette (read via ref → no stale-closure re-binds).
  useEffect(() => {
    if (!bindHotkey) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(!openRef.current);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [bindHotkey, setOpen]);

  // Fresh query + selection on every open.
  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setActiveIndex(0);
    }
  }, [isOpen]);

  const filtered = useMemo(() => filterCommands(commands, query), [commands, query]);
  const activeCommand = activeIndex >= 0 && activeIndex < filtered.length
    ? filtered[activeIndex]
    : undefined;

  const sections = useMemo<CommandSection[]>(() => {
    const out: CommandSection[] = [];
    let seq = 0;
    for (const command of filtered) {
      const last = out[out.length - 1];
      if (last !== undefined && last.group === command.group) {
        last.items.push({ command, index: seq });
      } else {
        out.push({ group: command.group, groupId: `${listId}-group-${out.length}`, items: [{ command, index: seq }] });
      }
      seq += 1;
    }
    return out;
  }, [filtered, listId]);

  // Keep the active option visible while navigating.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the ref only ever points
  // at the active option, so the effect must re-run on navigation and filter changes.
  useEffect(() => {
    activeOptionRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, filtered]);

  const runCommand = useCallback(
    (command: Command) => {
      command.run();
      setOpen(false);
    },
    [setOpen],
  );

  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (filtered.length === 0) return;
    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault();
        setActiveIndex((i) => (i + 1) % filtered.length);
        break;
      }
      case "ArrowUp": {
        event.preventDefault();
        setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length);
        break;
      }
      case "Home": {
        event.preventDefault();
        setActiveIndex(0);
        break;
      }
      case "End": {
        event.preventDefault();
        setActiveIndex(filtered.length - 1);
        break;
      }
      case "Enter": {
        if (activeCommand !== undefined && !activeCommand.disabled) {
          event.preventDefault();
          runCommand(activeCommand);
        }
        break;
      }
    }
  };

  return (
    <DialogPrimitive.Root open={isOpen} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className={cn(
            "fixed left-1/2 top-[12%] z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg outline-none",
            className,
          )}
        >
          {/* sr-only title keeps Radix's a11y contract without visible chrome. */}
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={activeCommand === undefined ? undefined : optionId(listId, activeCommand)}
              aria-autocomplete="list"
              aria-label="Search commands"
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
                setActiveIndex(0);
              }}
              onKeyDown={handleInputKeyDown}
              placeholder={placeholder}
              className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          {filtered.length === 0 ? (
            <output className="block px-4 py-8 text-center text-sm text-muted-foreground">
              {emptyMessage}
            </output>
          ) : (
            // biome-ignore lint/a11y/useSemanticElements: the aria 1.2 combobox pattern
            // requires a listbox container; a native <select> cannot render grouped,
            // styled command entries driven by aria-activedescendant.
            <div
              id={listId}
              role="listbox"
              aria-label="Commands"
              className="max-h-72 overflow-y-auto p-1"
            >
              {sections.map((section) => (
                // biome-ignore lint/a11y/useSemanticElements: <fieldset> is a form
                // control; role="group" is the APG grouping for listbox sections.
                <div key={section.groupId} role="group" aria-labelledby={section.groupId}>
                  {section.group === undefined ? null : (
                    <div
                      id={section.groupId}
                      className="px-2 py-1.5 text-xs font-medium text-muted-foreground"
                    >
                      {section.group}
                    </div>
                  )}
                  {section.items.map(({ command, index }) => (
                    // biome-ignore lint/a11y/useSemanticElements: <option> only exists
                    // inside <select>; the combobox pattern renders div options whose
                    // focus stays with the input (tabIndex -1 satisfies keyboard focus
                    // bookkeeping without joining the tab order).
                    <div
                      key={command.id}
                      role="option"
                      id={optionId(listId, command)}
                      tabIndex={-1}
                      aria-selected={index === activeIndex}
                      aria-disabled={command.disabled ?? undefined}
                      ref={index === activeIndex ? activeOptionRef : undefined}
                      onMouseMove={() => {
                        if (index !== activeIndex) setActiveIndex(index);
                      }}
                      onClick={() => {
                        if (!command.disabled) runCommand(command);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          if (!command.disabled) runCommand(command);
                        }
                      }}
                      className={cn(
                        "flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
                        index === activeIndex && "bg-accent text-accent-foreground",
                        command.disabled && "pointer-events-none opacity-50",
                      )}
                    >
                      {command.icon === undefined ? null : (
                        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">
                          {command.icon}
                        </span>
                      )}
                      <span className="flex-1 truncate">{command.label}</span>
                      {command.hint === undefined ? null : (
                        <span className="shrink-0 text-xs text-muted-foreground">{command.hint}</span>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          <div
            aria-hidden="true"
            className="flex items-center justify-end gap-3 border-t border-border px-3 py-2 text-xs text-muted-foreground"
          >
            <span>↑↓ navigate</span>
            <span>↵ run</span>
            <span>esc close</span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
