/**
 * Keyboard-event normalizers (W8-S) — shared by shell menus, modals and any
 * custom widget. Helpers accept any `{ key: string }`-shaped event (real
 * `KeyboardEvent`s and plain test objects alike) and normalize legacy
 * `event.key` values ("Esc", "Spacebar", "Up"…) to their modern names, so
 * call sites never branch on raw strings.
 */

export type KeyEventLike = { readonly key: string };

/** Legacy `event.key` spellings (old IE/Edge, some virtual keyboards) → modern. */
const LEGACY_KEY_ALIASES: Readonly<Record<string, string>> = {
  Esc: "Escape",
  Spacebar: " ",
  Up: "ArrowUp",
  Down: "ArrowDown",
  Left: "ArrowLeft",
  Right: "ArrowRight",
  Del: "Delete",
  Menu: "ContextMenu",
  Win: "Meta",
  OS: "Meta",
  Scroll: "ScrollLock",
};

/** Normalize an event's `key` to its modern name ("Esc" → "Escape", …). */
export function normalizeKey(event: KeyEventLike): string {
  const raw: string = event.key;
  return LEGACY_KEY_ALIASES[raw] ?? raw;
}

/** "Enter" — activate links/buttons/menu items from keyboard. */
export function isEnter(event: KeyEventLike): boolean {
  return normalizeKey(event) === "Enter";
}

/** "Escape" — close overlays, cancel placement modes (Dialog/menu convention). */
export function isEscape(event: KeyEventLike): boolean {
  return normalizeKey(event) === "Escape";
}

/** " " (space) — custom-widget activation; preventDefault to stop page scroll. */
export function isSpace(event: KeyEventLike): boolean {
  return normalizeKey(event) === " ";
}

/** "Tab" — focus traversal (see lib/a11y/focus.ts for the trap). */
export function isTab(event: KeyEventLike): boolean {
  return normalizeKey(event) === "Tab";
}

/** Arrow keys — menu/roving-tabindex navigation (WAI-ARIA patterns). */
export function isArrowKey(event: KeyEventLike): boolean {
  return normalizeKey(event).startsWith("Arrow");
}
