"use client";

/**
 * WorkspaceRail (W2-01, §8.4) — the shell's left navigation.
 *
 * - 240px expanded (`w-60`) → 64px icon-only collapsed (`w-16`); the state
 *   persists in localStorage under `studio.shell.rail.v1` (D-10: ECUX-literal
 *   key style; storage keys are not user-facing). The stored value is the
 *   string `"collapsed"` / `"expanded"` — anything else (or a full/unavailable
 *   store) means expanded. The first client render always matches the server
 *   (expanded); a stored collapse applies right after hydration.
 * - Active item: 2px `--signal` left border on `--bg-elevated` (§8.4) +
 *   `aria-current="page"` (§12 — never colour-only).
 * - Items are EXACTLY the four §8.4 destinations: Dashboard `/w`, Projects
 *   `/w/projects`, Billing `/w/billing`, Settings `/w/settings` (routes land
 *   from the sibling Wave-3 tasks; the links are safe).
 * - Collapsed items get a Tooltip (§7.6) — the accessible name is the link's
 *   aria-label; the tooltip is never the only source.
 * - The editor route NEVER mounts this rail (§8.7 hard rule — it lives
 *   outside the `(shell)` route group).
 */

import {
  Button,
  TOOLTIP_DELAY_MS,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@studio/ui";
import {
  CreditCard,
  FolderKanban,
  LayoutDashboard,
  type LucideIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";

/** D-10: ECUX-literal storage key for the rail collapse state. */
export const RAIL_STORAGE_KEY = "studio.shell.rail.v1";

interface RailItem {
  readonly label: string;
  readonly href: string;
  readonly icon: LucideIcon;
}

/**
 * §8.4 rail destinations — EXACTLY these four. `/w/[slug]/…` hub routes light
 * no item (they are project pages, not sections).
 */
const RAIL_ITEMS: readonly RailItem[] = [
  { label: "Dashboard", href: "/w", icon: LayoutDashboard },
  { label: "Projects", href: "/w/projects", icon: FolderKanban },
  { label: "Billing", href: "/w/billing", icon: CreditCard },
  { label: "Settings", href: "/w/settings", icon: Settings },
];

/** Stored form: the literal string `"collapsed"` or `"expanded"`. */
function readStoredCollapse(): boolean {
  try {
    return window.localStorage.getItem(RAIL_STORAGE_KEY) === "collapsed";
  } catch {
    // Full or unavailable storage (private mode) — expanded is the default.
    return false;
  }
}

function writeStoredCollapse(collapsed: boolean): void {
  try {
    window.localStorage.setItem(RAIL_STORAGE_KEY, collapsed ? "collapsed" : "expanded");
  } catch {
    // Best-effort persistence (quota-safe): the toggle still works in-memory.
  }
}

/** Dashboard is active only on `/w` itself; sections on their prefix. */
function isItemActive(pathname: string, href: string): boolean {
  if (href === "/w") return pathname === "/w";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function RailLink({
  item,
  active,
  collapsed,
}: {
  readonly item: RailItem;
  readonly active: boolean;
  readonly collapsed: boolean;
}): ReactNode {
  const Icon = item.icon;
  const link = (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      data-active={active || undefined}
      data-testid={`rail-${item.label.toLowerCase()}`}
      className={`flex h-9 items-center gap-2.5 rounded-sm pr-3 pl-[10px] text-body-s transition-colors duration-120 ${
        collapsed ? "justify-center px-0" : ""
      } ${
        active
          ? "border-l-2 border-signal bg-elevated font-medium text-primary"
          : "border-l-2 border-transparent text-secondary hover:bg-elevated hover:text-primary"
      }`}
    >
      <Icon size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
      {collapsed ? (
        <span className="sr-only">{item.label}</span>
      ) : (
        <span className="truncate">{item.label}</span>
      )}
    </Link>
  );

  if (!collapsed) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  );
}

export interface WorkspaceRailProps {
  /** Starting collapsed state (the shell keeps the persisted value). */
  readonly defaultCollapsed?: boolean;
  /** Controlled override (tests); when set the rail stops persisting. */
  readonly collapsed?: boolean;
  readonly onCollapsedChange?: (collapsed: boolean) => void;
}

export function WorkspaceRail({
  defaultCollapsed = false,
  collapsed: controlled,
  onCollapsedChange,
}: WorkspaceRailProps) {
  const pathname = usePathname();
  const [uncontrolled, setUncontrolled] = useState(defaultCollapsed);

  // Apply the persisted state right after hydration (the first client render
  // must match the server: expanded).
  useEffect(() => {
    if (readStoredCollapse()) setUncontrolled(true);
  }, []);

  const collapsed = controlled ?? uncontrolled;

  const toggle = (): void => {
    const next = !collapsed;
    if (controlled === undefined) {
      writeStoredCollapse(next);
      setUncontrolled(next);
    }
    onCollapsedChange?.(next);
  };

  const toggleLabel = collapsed ? "Expand sidebar" : "Collapse sidebar";

  return (
    <TooltipProvider delayDuration={TOOLTIP_DELAY_MS}>
      <nav
        aria-label="Workspace"
        data-testid="workspace-rail"
        data-collapsed={collapsed || undefined}
        className={`sticky top-14 flex h-[calc(100svh-3.5rem)] shrink-0 flex-col border-r border-border bg-app pb-3 transition-[width] duration-180 ${
          collapsed ? "w-16" : "w-60"
        }`}
      >
        <ul className="flex flex-1 flex-col gap-1 px-2 pt-3">
          {RAIL_ITEMS.map((item) => (
            <li key={item.href}>
              <RailLink
                item={item}
                active={isItemActive(pathname, item.href)}
                collapsed={collapsed}
              />
            </li>
          ))}
        </ul>
        <div className="flex justify-center px-2">
          <Button
            variant="ghost"
            size="iconSm"
            onClick={toggle}
            aria-label={toggleLabel}
            aria-expanded={!collapsed}
            data-testid="rail-toggle"
          >
            {collapsed ? (
              <PanelLeftOpen size={16} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <PanelLeftClose size={16} strokeWidth={1.75} aria-hidden="true" />
            )}
          </Button>
        </div>
      </nav>
    </TooltipProvider>
  );
}
