"use client";

/**
 * StudioShortcutsModal — the chat-first studio's keyboard-shortcut help
 * overlay (the "?" surface, ChatGPT-parity):
 *
 * - **Backdrop** — a full-area `bg-black/50` scrim (a real button, same
 *   pattern as the sidebar drawer) whose only job is dismissal.
 * - **Card** — centered `bg-panel border-subtle shadow-modal rounded-md`
 *   panel titled "Keyboard shortcuts"; the shortcut GROUPS flow in two
 *   columns on `sm+` (single column below), each row pairing a description
 *   with its kbd chips (`bg-input px-1.5 text-caption font-mono`).
 * - **Dismissal** — Escape (window-level, so it wins over the surface),
 *   backdrop click, or the ✕ affordance; focus moves to ✕ on open.
 *   Focus restore is deliberately NOT this component's job — the surface
 *   owns the trigger and keeps it.
 *
 * The shortcut data is exported (`SHORTCUT_GROUPS`) so tests, docs and any
 * future palette can share one source of truth. Keys are authored in the
 * compact Mac glyph language ("⌘⇧O") and re-tokenized per platform:
 * `navigator.platform` containing "Mac" (or an unknown/jsdom/SSR platform)
 * renders the glyphs; elsewhere ⌘→Ctrl and ⇧→Shift words.
 */

import { X } from "lucide-react";
import { type ReactElement, useEffect, useRef } from "react";

export interface ShortcutItem {
  /** Compact Mac-glyph combo, e.g. "⌘⇧O" — re-tokenized per platform. */
  readonly keys: string;
  /** What the shortcut does, e.g. "New chat". */
  readonly description: string;
}

export interface ShortcutGroup {
  readonly title: string;
  readonly items: readonly ShortcutItem[];
}

/** The one source of truth for the studio's chat-mode shortcuts. */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    title: "General",
    items: [
      { keys: "⌘⇧O", description: "New chat" },
      { keys: "⌘B", description: "Toggle sidebar" },
      { keys: "⌘K", description: "Command palette" },
    ],
  },
  {
    title: "Composing",
    items: [
      { keys: "Enter", description: "Send message" },
      { keys: "Shift+Enter", description: "New line" },
      { keys: "⌘.", description: "Stop streaming" },
      { keys: "✎", description: "Edit last message (hover a message → pencil)" },
    ],
  },
  {
    title: "Navigation",
    items: [{ keys: "↓", description: "Scroll to bottom (button)" }],
  },
];

/** Glyph → plain-key word for non-Apple platforms. */
const GLYPH_WORDS: Readonly<Record<string, string>> = {
  "⌘": "Ctrl",
  "⇧": "Shift",
  "⌥": "Alt",
};

/**
 * True on Apple platforms (⌘/⇧ glyphs). Detection is `navigator.platform`
 * containing "Mac"; an empty or missing platform (SSR, jsdom) defaults to
 * true — the glyphs are the studio's design language, so they win anywhere
 * we cannot honestly detect otherwise.
 */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.platform === "" || navigator.platform.includes("Mac");
}

/**
 * Split a compact combo into per-chip tokens ("⌘⇧O" → ["⌘","⇧","O"],
 * "Shift+Enter" → ["Shift","Enter"]); off-Mac, glyphs become their words
 * so the chip count stays identical across platforms.
 */
export function shortcutTokens(keys: string, isMac: boolean): readonly string[] {
  // Glyph runs match one character at a time; everything else is a word chunk.
  const parts = keys.match(/[⌘⇧⌥]|[^⌘⇧⌥]+/g) ?? [];
  const tokens: string[] = [];
  for (const part of parts) {
    const glyphWord = GLYPH_WORDS[part];
    if (glyphWord !== undefined) {
      tokens.push(isMac ? part : glyphWord);
      continue;
    }
    for (const chunk of part.split("+")) {
      const token = chunk.trim();
      if (token !== "") tokens.push(token);
    }
  }
  return tokens;
}

export interface StudioShortcutsModalProps {
  /** Whether the overlay is mounted (the surface owns the state). */
  readonly open: boolean;
  /** Any dismissal gesture: Escape, backdrop, the ✕ affordance. */
  readonly onClose: () => void;
}

export function StudioShortcutsModal({
  open,
  onClose,
}: StudioShortcutsModalProps): ReactElement | null {
  const isMac = isMacPlatform();
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // Escape dismisses, window-level so it wins over the surface's bindings.
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

  // Focus lands on the ✕ affordance on open (restore stays with the surface).
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div
      data-testid="studio-shortcuts-modal"
      // biome-ignore lint/a11y/useSemanticElements: the studio overlay pattern is a positioned div — a native <dialog> needs showModal()/top-layer semantics the surface-owned trigger must not take
      role="dialog"
      aria-modal="true"
      aria-labelledby="studio-shortcuts-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
    >
      {/* -- backdrop: a real button, same pattern as the sidebar drawer ----- */}
      <button
        type="button"
        aria-label="Close shortcuts"
        data-testid="studio-shortcuts-backdrop"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-black/50"
      />

      {/* -- card ------------------------------------------------------------ */}
      <div className="relative w-full max-w-xl rounded-md border border-subtle bg-panel shadow-modal">
        <div className="flex h-12 items-center gap-2 border-b border-subtle px-4">
          <h2 id="studio-shortcuts-title" className="text-label font-medium text-primary">
            Keyboard shortcuts
          </h2>
          <span className="flex-1" />
          <button
            ref={closeRef}
            type="button"
            aria-label="Close shortcuts"
            data-testid="studio-shortcuts-close"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-xs text-secondary duration-120 ease-out hover:bg-elevated hover:text-primary"
          >
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>

        <div className="grid grid-cols-1 gap-x-8 gap-y-5 p-4 sm:grid-cols-2 sm:p-5">
          {SHORTCUT_GROUPS.map((group) => {
            const headingId = `studio-shortcuts-group-${group.title.toLowerCase()}`;
            return (
              <section key={group.title} aria-labelledby={headingId}>
                <h3 id={headingId} className="pb-1 text-hint uppercase tracking-wide text-muted">
                  {group.title}
                </h3>
                <ul className="flex flex-col">
                  {group.items.map((item) => (
                    <li
                      key={item.description}
                      className="flex min-h-8 items-center justify-between gap-4 py-1"
                    >
                      <span className="text-body-s text-secondary">{item.description}</span>
                      <span className="flex shrink-0 items-center gap-1">
                        {shortcutTokens(item.keys, isMac).map((token) => (
                          <kbd
                            key={token}
                            className="rounded-xs border border-subtle bg-input px-1.5 py-0.5 font-mono text-caption text-secondary"
                          >
                            {token}
                          </kbd>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
