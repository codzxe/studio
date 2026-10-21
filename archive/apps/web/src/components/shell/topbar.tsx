"use client";

// components/shell/topbar — sticky product topbar (W8-A): mobile nav toggle,
// run-credit balance badge, user menu with sign-out. TODO(W8 follow-up):
// page breadcrumbs on the left once pages have hierarchy.

import { Menu } from "lucide-react";
import { CreditsBadge } from "./credits-badge";
import { UserMenu } from "./user-menu";

const MENU_BUTTON_CLASS =
  "inline-flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden";

export interface TopbarProps {
  /** Mobile drawer state — the hamburger toggles it (aria-expanded). */
  readonly navigationOpen: boolean;
  readonly onToggleNavigation: () => void;
}

export function Topbar({ navigationOpen, onToggleNavigation }: TopbarProps) {
  return (
    <header
      className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-3 md:px-4"
    >
      <button
        type="button"
        onClick={onToggleNavigation}
        aria-label={navigationOpen ? "Close navigation" : "Open navigation"}
        aria-expanded={navigationOpen}
        aria-controls="app-sidebar"
        className={MENU_BUTTON_CLASS}
      >
        <Menu className="size-5" aria-hidden="true" />
      </button>
      <div className="flex-1" />
      <CreditsBadge />
      <UserMenu />
    </header>
  );
}
