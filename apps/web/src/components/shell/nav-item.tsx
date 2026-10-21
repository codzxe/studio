"use client";

// components/shell/nav-item — one sidebar nav link (W8-A).
//
// A11y contract: native <Link> (Tab reachable, Enter/Space activate);
// `aria-current="page"` on the active route; most-specific-wins matching so
// /dashboard stays active on its child routes only; visible focus ring via
// the app's --ring token.

import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { AppHref } from "./nav-config";

const NAV_ITEM_BASE_CLASS =
  "flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const NAV_ITEM_ACTIVE_CLASS = `${NAV_ITEM_BASE_CLASS} bg-surface-muted text-foreground`;

const NAV_ITEM_INACTIVE_CLASS =
  `${NAV_ITEM_BASE_CLASS} text-muted-foreground hover:bg-surface-muted hover:text-foreground`;

export interface NavItemProps {
  readonly href: AppHref;
  readonly label: string;
  readonly icon: LucideIcon;
  /** Fires on activation — closes the mobile drawer after navigating. */
  readonly onNavigate?: () => void;
}

export function NavItem({ href, label, icon: Icon, onNavigate }: NavItemProps) {
  const pathname = usePathname();
  // Exact match or a child route (never a prefix accident: "/doc" must not
  // light up for "/documents").
  const active = pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={active ? NAV_ITEM_ACTIVE_CLASS : NAV_ITEM_INACTIVE_CLASS}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </Link>
  );
}
