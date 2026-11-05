"use client";

/**
 * StudioCommandPalette (W1-B) — the chat-first studio's ⌘K command palette
 * (ChatGPT-parity; the surface opens it, so this component stays purely
 * presentational + controlled: `open` / `onClose` / an owner-owned command
 * list — no wire calls, no router, no new deps).
 *
 * - **Backdrop** — a full-area `bg-black/50` scrim button (same pattern as the
 *   shortcuts modal / sidebar drawer) whose only job is dismissal.
 * - **Card** — a centered `max-w-lg rounded-md border-subtle bg-panel
 *   shadow-modal` panel: the search input (auto-focused on open) over the
 *   grouped command list.
 * - **Filtering** — case-insensitive substring on `label`; the empty query
 *   shows every command in the fixed Chat → Navigate → Settings → Export
 *   order under tiny uppercase group headers; no match shows
 *   "No matching commands".
 * - **Gestures** — ↑/↓ move the active row (wrapping, skipping disabled
 *   rows), Enter runs the active command then closes, a row click runs that
 *   row; Escape (window-level, so it wins over the surface — same contract
 *   as the shortcuts modal), the backdrop or the ✕ affordance close.
 *   Disabled rows render inert and are never selectable.
 * - **A11y** — combobox/listbox wiring: the input keeps focus and publishes
 *   the active row via `aria-activedescendant`; rows also carry `data-active`.
 * - **Motion** — the entrance animations are skipped when the user prefers
 *   reduced motion (jsdom-guarded `matchMedia` read; theme.css additionally
 *   neuters all keyframes under the media query, §6.2).
 */

import { Search, X } from "lucide-react";
import {
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/** The palette's fixed sections (authored order, like the sidebar's buckets). */
export type PaletteCommandGroup = "Chat" | "Navigate" | "Settings" | "Export";

/** One runnable palette row — the owner owns the verbs, the palette the UI. */
export interface PaletteCommand {
  /** Stable row id (keys, aria ids and data-command-id derive from it). */
  readonly id: string;
  /** Human label; the filter matches this (case-insensitive substring). */
  readonly label: string;
  /** Optional kbd-style shortcut hint ("⌘⇧O"). */
  readonly hint?: string;
  /** The fixed group the row renders under. */
  readonly group: PaletteCommandGroup;
  /** Optional decorative glyph (a lucide icon); inherits the row colour. */
  readonly icon?: ReactNode;
  /** Run on Enter (the active row) or on click. */
  readonly onSelect: () => void;
  /** Disabled rows render inert and are never selectable. */
  readonly disabled?: boolean;
}

export interface StudioCommandPaletteProps {
  /** Controlled visibility — the surface owns the state (⌘K lives there). */
  readonly open: boolean;
  /** Close report: Escape, backdrop, ✕, or a run command. */
  readonly onClose: () => void;
  /** The owner-owned command list; filtered client-side on label. */
  readonly commands: readonly PaletteCommand[];
}

const GROUP_ORDER: readonly PaletteCommandGroup[] = ["Chat", "Navigate", "Settings", "Export"];

const LISTBOX_ID = "studio-palette-listbox";

const groupHeadingId = (label: string): string => `studio-palette-group-${label.toLowerCase()}`;

const optionId = (id: string): string => `studio-palette-option-${id}`;

/** §6.2 — reduced motion kills the entrance animations (jsdom-guarded read). */
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Case-insensitive label filter + fixed-order grouping (exported for tests). */
export function groupPaletteCommands(
  commands: readonly PaletteCommand[],
  query: string,
): readonly {
  readonly label: PaletteCommandGroup;
  readonly items: readonly PaletteCommand[];
}[] {
  const q = query.trim().toLowerCase();
  const filtered =
    q === "" ? commands : commands.filter((command) => command.label.toLowerCase().includes(q));
  return GROUP_ORDER.flatMap((label) => {
    const items = filtered.filter((command) => command.group === label);
    return items.length === 0 ? [] : [{ label, items }];
  });
}

/** The row the arrows/Enter act on: the first selectable row at/after `index` (wrapping). */
function resolveActiveCommand(
  items: readonly PaletteCommand[],
  index: number,
): PaletteCommand | null {
  const length = items.length;
  if (length === 0) return null;
  const start = Math.min(Math.max(index, 0), length - 1);
  for (let step = 0; step < length; step += 1) {
    const candidate = items[(start + step) % length];
    if (candidate !== undefined && !candidate.disabled) return candidate;
  }
  return null;
}

export function StudioCommandPalette({
  open,
  onClose,
  commands,
}: StudioCommandPaletteProps): ReactElement | null {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  // Motion is decided per mount; theme.css neuters keyframes globally too (§6.2).
  const reducedMotion = useMemo(() => prefersReducedMotion(), []);

  const groups = useMemo(() => groupPaletteCommands(commands, query), [commands, query]);
  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const active = resolveActiveCommand(flat, activeIndex);

  // Escape dismisses, window-level so it wins over the surface's bindings
  // (same contract as the shortcuts modal).
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  // Every open starts clean: empty query, first selectable row, input focus.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    inputRef.current?.focus();
  }, [open]);

  // Keep the active row visible while the arrows move it.
  useEffect(() => {
    if (active === null) return;
    rowRefs.current.get(active.id)?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const moveTo = (direction: 1 | -1): void => {
    if (flat.length === 0) return;
    const start = Math.min(Math.max(activeIndex, 0), flat.length - 1);
    for (let step = 1; step <= flat.length; step += 1) {
      const index = (start + step * direction + flat.length) % flat.length;
      const candidate = flat[index];
      if (candidate !== undefined && !candidate.disabled) {
        setActiveIndex(index);
        return;
      }
    }
  };

  const runCommand = (command: PaletteCommand | null): void => {
    if (command === null || command.disabled) return;
    command.onSelect();
    onClose();
  };

  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveTo(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveTo(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      runCommand(active);
    }
  };

  return (
    <div
      data-testid="studio-command-palette"
      className={`fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 ${
        reducedMotion ? "" : "animate-overlay-in"
      }`}
    >
      {/* -- backdrop: a real button, same pattern as the sidebar drawer ----- */}
      <button
        type="button"
        aria-label="Close command palette"
        data-testid="studio-palette-backdrop"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-black/50"
      />

      {/* -- card ------------------------------------------------------------ */}
      <div
        // biome-ignore lint/a11y/useSemanticElements: the studio overlay pattern is a positioned div — a native <dialog> needs showModal()/top-layer semantics the surface-owned trigger must not take
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className={`relative flex w-full max-w-lg flex-col overflow-hidden rounded-md border border-subtle bg-panel shadow-modal ${
          reducedMotion ? "" : "animate-pop-in"
        }`}
      >
        {/* -- header: search + close ----------------------------------------- */}
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-subtle px-4">
          <Search size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-muted" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleInputKeyDown}
            placeholder="Type a command…"
            aria-label="Search commands"
            role="combobox"
            aria-expanded={true}
            aria-autocomplete="list"
            aria-controls={LISTBOX_ID}
            aria-activedescendant={active === null ? undefined : optionId(active.id)}
            data-testid="studio-palette-input"
            className="min-w-0 flex-1 bg-transparent text-body text-primary outline-none placeholder:text-muted"
          />
          <button
            type="button"
            aria-label="Close command palette"
            data-testid="studio-palette-close"
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xs text-secondary duration-120 ease-out hover:bg-elevated hover:text-primary"
          >
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>

        {/* -- grouped command list ------------------------------------------- */}
        <div
          id={LISTBOX_ID}
          // biome-ignore lint/a11y/useSemanticElements: a rich grouped palette (icons, kbd hints, active row) cannot be a native <select> — this is the ARIA 1.2 combobox pattern
          role="listbox"
          aria-label="Commands"
          data-testid="studio-palette-list"
          tabIndex={-1}
          className="scrollbar-thin max-h-80 overflow-y-auto p-1.5"
        >
          {groups.map((group) => (
            <div
              key={group.label}
              // biome-ignore lint/a11y/useSemanticElements: a labeled option group, not a form <fieldset> — fieldset/legend would drag form semantics into the palette
              role="group"
              aria-labelledby={groupHeadingId(group.label)}
            >
              <h3
                id={groupHeadingId(group.label)}
                className="px-2 pt-2 pb-1 text-hint uppercase tracking-wide text-muted"
              >
                {group.label}
              </h3>
              {group.items.map((command) => {
                const isActive = command === active;
                return (
                  <button
                    key={command.id}
                    ref={(node) => {
                      if (node === null) rowRefs.current.delete(command.id);
                      else rowRefs.current.set(command.id, node);
                    }}
                    type="button"
                    // biome-ignore lint/a11y/useSemanticElements: rows are real buttons so a click runs them; <option> only exists inside a native <select> — the combobox pattern keeps focus on the input via aria-activedescendant
                    role="option"
                    id={optionId(command.id)}
                    aria-selected={isActive}
                    aria-disabled={command.disabled === true || undefined}
                    disabled={command.disabled === true}
                    data-testid="studio-palette-item"
                    data-command-id={command.id}
                    data-active={isActive || undefined}
                    onMouseMove={() => {
                      if (!command.disabled) setActiveIndex(flat.indexOf(command));
                    }}
                    onClick={() => runCommand(command)}
                    className={`flex h-9 w-full items-center gap-2 rounded-sm px-2 text-left text-body-s duration-120 ease-out disabled:cursor-not-allowed disabled:opacity-50 ${
                      isActive
                        ? "bg-elevated text-primary"
                        : "text-secondary hover:bg-elevated hover:text-primary"
                    }`}
                  >
                    {command.icon === undefined ? null : (
                      <span
                        aria-hidden="true"
                        className="flex h-4 w-4 shrink-0 items-center justify-center"
                      >
                        {command.icon}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate">{command.label}</span>
                    {command.hint === undefined ? null : (
                      <kbd className="shrink-0 rounded-xs border border-subtle bg-input px-1.5 py-0.5 font-mono text-caption text-secondary">
                        {command.hint}
                      </kbd>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {flat.length === 0 ? (
          <p
            data-testid="studio-palette-empty"
            className="px-4 pb-5 text-center text-caption text-muted"
          >
            No matching commands
          </p>
        ) : null}
      </div>
    </div>
  );
}
