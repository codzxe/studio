/**
 * Focus management for modal-style overlays (W8-S).
 *
 * Follows the @studio/ui Dialog conventions (§16.3 shadcn-style kit,
 * packages/ui/src/components/dialog.tsx): on open, focus moves into the
 * dialog; Tab/Shift+Tab cycle inside it; Escape closes it; on close, focus
 * returns to the element that had it before opening. The ui primitives are
 * not yet transpiled into apps/web (see components/shell notes), so these
 * utilities give app-level dialogs, toasts and placement flows the same
 * behavior with zero kit imports.
 *
 * Client-only: call from effects and event handlers, never during render.
 */

import { isEscape, isTab } from "./keyboard";

/**
 * Elements that take keyboard focus in natural DOM order. One element may
 * match several selectors (e.g. `a[href][tabindex]`) — `getFocusableElements`
 * dedupes.
 */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
  "audio[controls]",
  "video[controls]",
  "details > summary",
].join(",");

function isActuallyFocusable(element: HTMLElement): boolean {
  // display:none subtrees report zero client rects; `visibility`/`opacity`
  // hidden elements are still focusable per spec and stay in — callers that
  // toggle with visibility need no special handling here.
  return !element.hasAttribute("disabled") && element.getClientRects().length > 0;
}

/** Keyboard-focusable descendants of `container`, in DOM order, deduped. */
export function getFocusableElements(container: ParentNode): HTMLElement[] {
  const candidates = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  const seen = new Set<HTMLElement>();
  const focusable: HTMLElement[] = [];
  for (const element of candidates) {
    if (seen.has(element) || !isActuallyFocusable(element)) {
      continue;
    }
    seen.add(element);
    focusable.push(element);
  }
  return focusable;
}

/**
 * Focus an element even when it is not naturally focusable — the Dialog
 * convention of giving the dialog container `tabindex="-1"` so it can receive
 * programmatic focus without joining the Tab order. Mutation-minimal: only
 * elements without any `tabindex` attribute are patched.
 */
export function focusElement(element: HTMLElement): void {
  if (element.getAttribute("tabindex") === null && element.tabIndex < 0) {
    element.tabIndex = -1;
  }
  element.focus();
}

/** Restore focus to the pre-open element (modal close path). */
export function restoreFocus(target: HTMLElement): void {
  focusElement(target);
}

export type FocusTrapOptions = {
  /**
   * Element (or resolver, evaluated at activate time) to focus on open.
   * Defaults to the first focusable descendant, else the container itself.
   * Use a resolver when the element only exists after open animations/render.
   */
  initialFocus?: HTMLElement | (() => HTMLElement | null);
  /** Invoked on Escape while active — Dialog convention: close the overlay. */
  onEscape?: () => void;
};

export type FocusTrap = {
  /** Remember the restore target, move focus in, start Tab cycling. Idempotent. */
  activate: () => void;
  /**
   * Stop cycling and restore focus to the pre-open element (pass
   * `{ restore: false }` when another flow already took focus over).
   * Idempotent.
   */
  deactivate: (options?: { restore?: boolean }) => void;
};

/**
 * Trap + restore focus inside `container` (Dialog/menu/drawer pattern):
 *
 *   const trap = createFocusTrap(ref.current, { onEscape: close });
 *   trap.activate();   // on open
 *   trap.deactivate(); // on close — focus returns to the trigger
 *
 * The Tab handler is document-level: it also recovers focus if it escapes
 * the container (e.g. an inner element unmounts while focused).
 */
export function createFocusTrap(container: HTMLElement, options: FocusTrapOptions = {}): FocusTrap {
  let active = false;
  let restoreTarget: HTMLElement | null = null;

  const cycleTab = (event: KeyboardEvent): void => {
    const focusable = getFocusableElements(container);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const current = document.activeElement;
    const inside = current !== null && container.contains(current);
    if (!first || !last) {
      // Nothing focusable inside — swallow Tab so focus cannot leave.
      event.preventDefault();
      focusElement(container);
      return;
    }
    const wrapForward = !inside || current === last;
    const wrapBackward = !inside || current === first || current === container;
    if (event.shiftKey && wrapBackward) {
      event.preventDefault();
      focusElement(last);
      return;
    }
    if (!event.shiftKey && wrapForward) {
      event.preventDefault();
      focusElement(first);
    }
    // otherwise: natural DOM order keeps focus inside the overlay
  };

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (isTab(event)) {
      cycleTab(event);
      return;
    }
    if (options.onEscape !== undefined && isEscape(event)) {
      options.onEscape();
    }
  };

  const resolveInitialFocus = (): HTMLElement => {
    const { initialFocus } = options;
    const resolved = typeof initialFocus === "function" ? initialFocus() : initialFocus;
    if (resolved !== null && resolved !== undefined && resolved.isConnected) {
      return resolved;
    }
    return getFocusableElements(container)[0] ?? container;
  };

  return {
    activate: () => {
      if (active || typeof document === "undefined") {
        return;
      }
      active = true;
      restoreTarget =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      document.addEventListener("keydown", handleKeyDown);
      focusElement(resolveInitialFocus());
    },
    deactivate: (deactivateOptions) => {
      if (!active) {
        return;
      }
      active = false;
      document.removeEventListener("keydown", handleKeyDown);
      const shouldRestore = deactivateOptions?.restore !== false;
      if (shouldRestore && restoreTarget !== null && restoreTarget.isConnected) {
        restoreFocus(restoreTarget);
      }
      restoreTarget = null;
    },
  };
}
