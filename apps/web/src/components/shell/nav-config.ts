// components/shell/nav-config — the (app) sidebar's primary nav (W8-A).
//
// Icons come from lucide-react (apps/web dependency). Every href must exist
// as a route — next.config.ts pins `experimental.typedRoutes: true`, and the
// literal union below is what <Link href> is checked against. The routes are
// the placeholder pages under src/app/(app)/*/page.tsx.

import {
  CreditCard,
  Files,
  Images,
  LayoutDashboard,
  LayoutTemplate,
  Settings,
  type LucideIcon,
} from "lucide-react";

/** Product routes this shell owns (each has a page under src/app/(app)). */
export type AppHref =
  | "/dashboard"
  | "/documents"
  | "/assets"
  | "/templates"
  | "/billing"
  | "/settings";

export interface AppNavItem {
  readonly href: AppHref;
  readonly label: string;
  readonly icon: LucideIcon;
}

const ITEMS = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/documents", label: "Documents", icon: Files },
  { href: "/assets", label: "Assets", icon: Images },
  { href: "/templates", label: "Templates", icon: LayoutTemplate },
  { href: "/billing", label: "Billing", icon: CreditCard },
  { href: "/settings", label: "Settings", icon: Settings },
] as const satisfies ReadonlyArray<AppNavItem>;

export const APP_NAV_ITEMS: readonly AppNavItem[] = ITEMS;
