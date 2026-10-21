"use client";

// components/shell/sidebar — left app navigation (W8-A).
//
// Desktop (md+): static rail. Mobile: off-canvas drawer behind the topbar
// hamburger; closed means display:none so its links leave the tab order
// (no hidden focus traps), and Escape or the labelled backdrop closes it.

import { useEffect, useRef, type KeyboardEvent } from "react";
import { APP_NAV_ITEMS } from "./nav-config";
import { NavItem } from "./nav-item";
import { WorkspaceSwitcher } from "./workspace-switcher";

const SIDEBAR_BASE_CLASS =
  "fixed inset-y-0 left-0 z-40 w-64 shrink-0 flex-col border-r border-border bg-surface outline-none md:static md:z-auto";

export interface SidebarProps {
  /** Mobile drawer state; desktop always renders. */
  readonly open: boolean;
  readonly onClose: () => void;
}

export function Sidebar({ open, onClose }: SidebarProps) {
  const containerRef = useRef<HTMLElement | null>(null);

  // Keyboard users land in the drawer when it opens (tabIndex -1 target).
  useEffect(() => {
    if (open) {
      containerRef.current?.focus();
    }
  }, [open]);

  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key === "Escape") {
      onClose();
    }
  }

  const sidebarClass = open ? `${SIDEBAR_BASE_CLASS} flex` : `${SIDEBAR_BASE_CLASS} hidden md:flex`;

  return (
    <>
      {open ? (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={onClose}
          className="fixed inset-0 z-30 cursor-default bg-foreground/30 md:hidden"
        />
      ) : null}
      <aside
        id="app-sidebar"
        ref={containerRef}
        tabIndex={-1}
        aria-label="Main navigation"
        onKeyDown={handleKeyDown}
        className={sidebarClass}
      >
        <div className="border-b border-border p-2">
          <WorkspaceSwitcher onSelect={onClose} />
        </div>
        <nav aria-label="Primary" className="flex-1 overflow-y-auto p-2">
          <ul className="flex flex-col gap-1">
            {APP_NAV_ITEMS.map((item) => (
              <li key={item.href}>
                <NavItem {...item} onNavigate={onClose} />
              </li>
            ))}
          </ul>
        </nav>
      </aside>
    </>
  );
}
