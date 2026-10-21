import * as DialogPrimitive from "@radix-ui/react-dialog";
import { CornerDownLeft, Search } from "lucide-react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/utils";
import { Kbd } from "./kbd";

export type CommandGroup = "projects" | "actions" | "navigation" | "help";

/** Fixed group order (§7.10): Projects, Actions, Navigation, Help. */
const GROUP_ORDER: CommandGroup[] = ["projects", "actions", "navigation", "help"];

const GROUP_LABEL: Record<CommandGroup, string> = {
  projects: "Projects",
  actions: "Actions",
  navigation: "Navigation",
  help: "Help",
};

export interface CommandItem {
  id: string;
  group: CommandGroup;
  label: string;
  /** Shortcut hint in mono (e.g. "⌘N"). Decorative — label carries the name. */
  shortcut?: string;
  onSelect?: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: CommandItem[];
  placeholder?: string;
  /** e.g. `No results for "x".` */
  emptyMessage?: string;
  className?: string;
}

/**
 * CommandPalette — §7.10. 560px wide, top 20vh, search + grouped results,
 * keyboard-first: ↑/↓ move, Home/End jump, Enter runs, Esc closes. Mouse
 * users can click an option. Bind `⌘K` / `Ctrl+K` in the shell (not while the
 * editor iframe has focus).
 */
export function CommandPalette({
  open,
  onOpenChange,
  items,
  placeholder = "Search projects, actions…",
  emptyMessage = "No results.",
  className,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => item.label.toLowerCase().includes(q));
  }, [items, query]);

  const activeId = filtered[activeIndex]
    ? `${listId}-option-${filtered[activeIndex].id}`
    : undefined;

  // Reset on open; clamp the active index when the result set shrinks.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
    }
  }, [open]);

  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(filtered.length - 1, 0)));
  }, [filtered.length]);

  // Keep the active option in view while arrowing (value-triggered effect:
  // the body reads the DOM, the deps are intentional change triggers).
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeIndex/filtered.length are deliberate triggers for a DOM side effect
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>('[data-active="true"]');
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, filtered.length, listRef]);

  const runItem = useCallback(
    (item: CommandItem | undefined) => {
      if (!item) return;
      onOpenChange(false);
      item.onSelect?.();
    },
    [onOpenChange],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (
        event.key === "ArrowDown" ||
        event.key === "ArrowUp" ||
        event.key === "Home" ||
        event.key === "End"
      ) {
        if (filtered.length === 0) return;
        event.preventDefault();
        setActiveIndex((index) => {
          const last = filtered.length - 1;
          if (event.key === "ArrowDown") return Math.min(index + 1, last);
          if (event.key === "ArrowUp") return Math.max(index - 1, 0);
          if (event.key === "Home") return 0;
          return last; // End
        });
      } else if (event.key === "Enter") {
        event.preventDefault();
        runItem(filtered[activeIndex]);
      }
    },
    [activeIndex, filtered, runItem],
  );

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-50 bg-overlay",
            "data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out",
          )}
        />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className={cn(
            "fixed top-[20vh] left-1/2 z-50 flex max-h-[60vh] w-[calc(100vw-32px)] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-border bg-panel shadow-modal",
            "data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out",
            "max-w-[var(--palette-w)]",
            className,
          )}
        >
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <div className="flex items-center gap-2 border-b border-border px-4">
            <Search
              size={16}
              strokeWidth={1.75}
              aria-hidden="true"
              className="shrink-0 text-muted"
            />
            <input
              // biome-ignore lint/a11y/noAutofocus: keyboard-first palette — focus must start in the search field (§7.10)
              autoFocus
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={activeId}
              aria-autocomplete="list"
              aria-label="Search commands"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder={placeholder}
              data-testid="command-input"
              className="h-12 w-full bg-transparent text-body text-primary outline-none placeholder:text-disabled"
            />
            <span aria-hidden="true" className="shrink-0">
              <Kbd>esc</Kbd>
            </span>
          </div>
          <div
            ref={listRef}
            id={listId}
            tabIndex={-1}
            // biome-ignore lint/a11y/useSemanticElements: combobox pattern — a grouped, styled palette cannot use <select>
            role="listbox"
            aria-label="Commands"
            className="flex-1 overflow-y-auto py-2 scrollbar-thin"
          >
            {filtered.length === 0 ? (
              <div className="px-4 py-8 text-center text-body-s text-muted">{emptyMessage}</div>
            ) : (
              GROUP_ORDER.map((group) => {
                const groupItems = filtered.filter((item) => item.group === group);
                if (groupItems.length === 0) return null;
                return (
                  <div key={group}>
                    <div className="px-4 pt-3 pb-1 text-label uppercase tracking-[0.06em] text-muted">
                      {GROUP_LABEL[group]}
                    </div>
                    <div>
                      {groupItems.map((item) => {
                        const globalIndex = filtered.indexOf(item);
                        const active = globalIndex === activeIndex;
                        return (
                          <div
                            key={item.id}
                            id={`${listId}-option-${item.id}`}
                            // biome-ignore lint/a11y/useSemanticElements: combobox pattern — <option> cannot carry the styled row layout
                            role="option"
                            aria-selected={active}
                            data-active={active || undefined}
                            tabIndex={-1}
                            onMouseMove={() => setActiveIndex(globalIndex)}
                            onMouseDown={(event) => {
                              event.preventDefault();
                              runItem(item);
                            }}
                            className={cn(
                              "flex h-10 w-full cursor-pointer items-center gap-3 px-4 text-body-s transition-colors duration-120",
                              active ? "bg-input text-primary" : "text-secondary",
                            )}
                          >
                            <span className="flex-1 truncate">{item.label}</span>
                            {item.shortcut ? (
                              <span
                                aria-hidden="true"
                                className="tabular font-mono text-hint text-muted"
                              >
                                {item.shortcut}
                              </span>
                            ) : active ? (
                              <CornerDownLeft
                                size={16}
                                strokeWidth={1.75}
                                aria-hidden="true"
                                className="text-muted"
                              />
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <div className="flex items-center gap-4 border-t border-border px-4 py-2 text-hint text-muted">
            <span className="flex items-center gap-1.5">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              navigate
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>↵</Kbd>
              run
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>esc</Kbd>
              close
            </span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
