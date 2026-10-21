"use client";

// components/shell/use-menu — shared keyboard-navigable dropdown-menu
// controller (workspace switcher + user menu). The @studio/ui kit has no
// dropdown primitive yet, so this hand-rolls the WAI-ARIA menu pattern:
//   - trigger: aria-haspopup="menu" + aria-expanded; Enter/Space activate
//     the native click (which opens + focuses the first item), ArrowDown/
//     ArrowUp open focusing the first/last item;
//   - menu: role="menu"; Escape closes and restores focus to the trigger,
//     ArrowUp/Down cycle items, Home/End jump, Tab closes naturally;
//   - pointerdown outside the menu/trigger closes without stealing focus;
//   - disabled items are skipped by the arrow-key cycle (they never receive
//     focus natively).
//
// NOTE: @studio/ui components are NOT used by the shell because apps/web
// does not compile that package yet (next.config.ts transpilePackages lists
// only @studio/config) and apps/web/src/app/globals.css does not map the
// kit's token set (--primary/--secondary/--card/…). Shell styles therefore
// use the app's own surface/border/accent tokens — the auth-form.tsx
// precedent (W1-K). TODO(wiring wave): add "@studio/ui" to transpilePackages
// + import "@studio/ui/tokens.css", then adopt the kit primitives.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";

export interface UseMenuOptions {
  /** Runs on every menu close (e.g. closes the mobile nav drawer). */
  readonly onClose?: () => void;
}

export interface MenuController {
  readonly open: boolean;
  readonly openMenu: (focus?: "first" | "last") => void;
  readonly closeMenu: (returnFocus?: boolean) => void;
  readonly toggleMenu: () => void;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly menuRef: RefObject<HTMLDivElement | null>;
  readonly registerItem: (index: number, element: HTMLElement | null) => void;
  /** Spread onto the trigger <button>. */
  readonly triggerProps: {
    readonly "aria-haspopup": "menu";
    readonly "aria-expanded": boolean;
    readonly onClick: () => void;
    readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  };
  /** Spread onto the menu container <div>. */
  readonly menuProps: {
    readonly role: "menu";
    readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  };
}

export function useMenu(options: UseMenuOptions = {}): MenuController {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLElement | null>>([]);
  const pendingFocus = useRef<"first" | "last" | null>(null);

  const focusableItems = useCallback((): HTMLElement[] => {
    // Disabled buttons register but never join the keyboard cycle.
    return itemRefs.current.filter(
      (element): element is HTMLElement => element !== null && !element.hasAttribute("disabled"),
    );
  }, []);

  const focusItemAt = useCallback(
    (index: number): void => {
      const items = focusableItems();
      if (items.length === 0) {
        return;
      }
      const wrapped = ((index % items.length) + items.length) % items.length;
      items[wrapped]?.focus();
    },
    [focusableItems],
  );

  // Focus the requested item once the menu has mounted (openMenu sets the
  // intent; the DOM node only exists after the state flip).
  useEffect(() => {
    if (open && pendingFocus.current !== null) {
      const which = pendingFocus.current;
      pendingFocus.current = null;
      focusItemAt(which === "first" ? 0 : focusableItems().length - 1);
    }
  }, [open, focusItemAt, focusableItems]);

  const openMenu = useCallback((focus: "first" | "last" = "first"): void => {
    pendingFocus.current = focus;
    setOpen(true);
  }, []);

  const closeMenu = useCallback(
    (returnFocus = true): void => {
      setOpen(false);
      pendingFocus.current = null;
      if (returnFocus) {
        triggerRef.current?.focus();
      }
      options.onClose?.();
    },
    [options],
  );

  const toggleMenu = useCallback((): void => {
    if (open) {
      closeMenu(true);
    } else {
      openMenu("first");
    }
  }, [open, closeMenu, openMenu]);

  const registerItem = useCallback((index: number, element: HTMLElement | null): void => {
    itemRefs.current[index] = element;
  }, []);

  // Dismiss on outside pointerdown (focus is untouched).
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (
        target instanceof Node &&
        menuRef.current?.contains(target) !== true &&
        triggerRef.current?.contains(target) !== true
      ) {
        setOpen(false);
        options.onClose?.();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, options]);

  // Enter/Space are deliberately absent: native <button> fires click for
  // them, and the click handler already opens + focuses the first item.
  const onTriggerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>): void => {
      switch (event.key) {
        case "ArrowDown": {
          event.preventDefault();
          openMenu("first");
          break;
        }
        case "ArrowUp": {
          event.preventDefault();
          openMenu("last");
          break;
        }
        default: {
          break;
        }
      }
    },
    [openMenu],
  );

  const onMenuKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu(true);
        return;
      }
      if (event.key === "Tab") {
        setOpen(false); // let focus move naturally to the next tab stop
        options.onClose?.();
        return;
      }
      const items = focusableItems();
      if (items.length === 0) {
        return;
      }
      const currentIndex = items.findIndex((element) => element === document.activeElement);
      switch (event.key) {
        case "ArrowDown": {
          event.preventDefault();
          focusItemAt(currentIndex < 0 ? 0 : currentIndex + 1);
          break;
        }
        case "ArrowUp": {
          event.preventDefault();
          focusItemAt(currentIndex < 0 ? items.length - 1 : currentIndex - 1);
          break;
        }
        case "Home": {
          event.preventDefault();
          focusItemAt(0);
          break;
        }
        case "End": {
          event.preventDefault();
          focusItemAt(items.length - 1);
          break;
        }
        default: {
          break;
        }
      }
    },
    [focusableItems, focusItemAt, closeMenu, options],
  );

  return {
    open,
    openMenu,
    closeMenu,
    toggleMenu,
    triggerRef,
    menuRef,
    registerItem,
    triggerProps: {
      "aria-haspopup": "menu",
      "aria-expanded": open,
      onClick: toggleMenu,
      onKeyDown: onTriggerKeyDown,
    },
    menuProps: {
      role: "menu",
      onKeyDown: onMenuKeyDown,
    },
  };
}
