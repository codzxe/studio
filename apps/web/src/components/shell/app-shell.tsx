"use client";

// components/shell/app-shell — the (app) group's client container (W8-A).
//
// Owns the mobile drawer state shared by the topbar hamburger and the
// sidebar, plus the skip-to-content link. Sidebar + topbar styling follows
// the vendor/next-saas-stripe-starter dashboard-shell pattern (fixed rail,
// header rail, main content offset) adapted to this app's tokens.

import { useState, type ReactNode } from "react";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

export interface AppShellProps {
  readonly children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const [navigationOpen, setNavigationOpen] = useState(false);

  return (
    <div className="flex min-h-svh bg-background text-foreground">
      <a
        href="#app-main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:shadow-md"
      >
        Skip to content
      </a>
      <Sidebar open={navigationOpen} onClose={() => setNavigationOpen(false)} />
      <div className="flex min-h-svh min-w-0 flex-1 flex-col">
        <Topbar
          navigationOpen={navigationOpen}
          onToggleNavigation={() => setNavigationOpen((open) => !open)}
        />
        <main
          id="app-main-content"
          tabIndex={-1}
          className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-6 lg:px-8"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
