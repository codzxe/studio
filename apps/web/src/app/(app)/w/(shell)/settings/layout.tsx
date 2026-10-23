"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";

/**
 * The settings layout (W2-06, §8.9) — left sub-nav for `/w/settings/*`.
 *
 * A CLIENT layout on purpose: Next layouts receive neither the pathname nor
 * searchParams, and the sub-nav needs both — the active section (aria-current,
 * §12) and the `?ws=` workspace-switcher seam (sub-navigation must not drop
 * the workspace context the page resolved with). The shell layout above this
 * one is the async RSC that resolves the session and defaults; every settings
 * page stays page-authoritative for `?ws` exactly like `/w/billing`.
 *
 * Destinations (manifest W2-06, the §8.9 list this wave ships): General,
 * Members, API keys, Models, Audit, Licences — plus a Billing link back to
 * `/w/billing` (§8.8 is a top-level surface, not a settings sub-page).
 * API keys/Models/Audit are owned by the W2-07 sibling; the links stand ready
 * (a 404 until that page lands is the documented mid-wave state).
 *
 * Dark-only, tokens only; mobile collapses the left nav into a horizontal
 * scrollable strip (inner-container scroll — the §13 document-level
 * no-horizontal-scroll law still holds).
 */

interface NavItem {
  readonly key: string;
  readonly label: string;
  readonly href: string;
  /** General is `/w/settings` itself — exact match, never a prefix. */
  readonly exact?: boolean;
}

const NAV_ITEMS: readonly NavItem[] = [
  { key: "general", label: "General", href: "/w/settings", exact: true },
  { key: "members", label: "Members", href: "/w/settings/members" },
  { key: "api-keys", label: "API keys", href: "/w/settings/api-keys" },
  { key: "models", label: "Models", href: "/w/settings/models" },
  { key: "audit", label: "Audit", href: "/w/settings/audit" },
  { key: "licences", label: "Licences", href: "/w/settings/licences" },
];

/** Cross-surface: billing is §8.8's own page, linked from the sub-nav. */
const BILLING_LINK: NavItem = { key: "billing", label: "Billing", href: "/w/billing" };

/** Section active = exact (General) or prefix (the section owns its subtree). */
export function isNavActive(pathname: string, item: NavItem): boolean {
  if (item.exact === true) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export default function SettingsLayout({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // ?ws rides along: sub-navigation must not strand the user back on the
  // default workspace (the pages re-resolve ?ws server-side, hard rule 3).
  const ws = searchParams.get("ws");
  const hrefFor = (href: string): string =>
    ws === null ? href : `${href}?ws=${encodeURIComponent(ws)}`;

  const billingActive = isNavActive(pathname, BILLING_LINK);

  return (
    <main id="main" data-testid="settings-shell" className="min-h-svh bg-app">
      <div className="mx-auto w-full max-w-[1100px] px-5 py-10 md:px-8">
        <p className="text-label font-medium uppercase tracking-[0.06em] text-muted">Settings</p>
        <div className="mt-4 flex flex-col gap-8 lg:flex-row lg:gap-10">
          <nav aria-label="Settings" data-testid="settings-nav" className="lg:w-48 lg:shrink-0">
            <ul className="flex items-center gap-1 overflow-x-auto pb-1 lg:flex-col lg:items-stretch lg:gap-0.5 lg:overflow-visible lg:pb-0">
              {NAV_ITEMS.map((item) => {
                const active = isNavActive(pathname, item);
                return (
                  <li key={item.key} className="shrink-0 lg:shrink">
                    <Link
                      href={hrefFor(item.href)}
                      aria-current={active ? "page" : undefined}
                      data-active={active || undefined}
                      data-testid={`settings-nav-${item.key}`}
                      className={`flex h-9 items-center rounded-sm border-l-2 px-3 text-body-s whitespace-nowrap transition-colors duration-120 ${
                        active
                          ? "border-signal bg-elevated font-medium text-primary"
                          : "border-transparent text-secondary hover:bg-elevated hover:text-primary"
                      }`}
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              })}
              <li
                aria-hidden="true"
                className="mx-2 hidden h-px self-stretch bg-border lg:my-2 lg:block"
              />
              <li className="shrink-0 lg:shrink">
                <Link
                  href={hrefFor(BILLING_LINK.href)}
                  aria-current={billingActive ? "page" : undefined}
                  data-testid="settings-nav-billing"
                  className={`flex h-9 items-center rounded-sm border-l-2 px-3 text-body-s whitespace-nowrap transition-colors duration-120 ${
                    billingActive
                      ? "border-signal bg-elevated font-medium text-primary"
                      : "border-transparent text-secondary hover:bg-elevated hover:text-primary"
                  }`}
                >
                  {BILLING_LINK.label}
                </Link>
              </li>
            </ul>
          </nav>
          <div data-testid="settings-content" className="min-w-0 flex-1">
            {children}
          </div>
        </div>
      </div>
    </main>
  );
}
