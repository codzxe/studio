"use client";

import { Brand } from "@studio/config";
import { buttonVariants, cn } from "@studio/ui";
import { ChevronRight, LayoutDashboard } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";

/**
 * EditorTopBar (w3-b05, seamless app+editor merge) — the PERSISTENT SaaS-brand
 * bar above the editor iframe.
 *
 * The product ask (round 13): the editor and the app felt like two different
 * products — from the editor there was not even a way back to the dashboard
 * (the M3.5 floating project bar auto-hides, so the escape hatch was
 * invisible). This bar is the fix, and it is HOST chrome, not editor chrome:
 * it never overlaps, restyles or injects into the iframe — the editor surface
 * below it is merely RESIZED, the same D-18 discipline the docked chat
 * sidebar already uses. (This supersedes the M3.5 "no top nav" line; the
 * other two halves of that rule — no injected CSS, no editor restyle — stay
 * in force.)
 *
 * Visual unification: the bar reuses the shell TopBar's exact markup pattern
 * and the semantic tokens only (`bg-app` + `border-b border-border` hairline,
 * the §2.3 signal-dot product mark, `font-display` name, Instrument Sans
 * body copy via `text-body-s`) — so `/w/:slug/editor` reads as the same
 * product as `/w`. The color bridge to the frozen dist: the editor's own
 * chrome background (#1b1c1f, close to the token ramp's `--bg-elevated`
 * surface tier) sits directly below the bar's `--border` hairline, the same
 * app-bar → hairline → elevated-surface grammar every dashboard page uses —
 * one product, one token ramp, zero new colors.
 *
 * Contents (dense, one row, 56px like the shell):
 *   `[• Studio] [/ Project name ›] Editor              [⌗ Dashboard]`
 * - product mark + name → the dashboard (`/w`), exactly like the shell's bar;
 * - breadcrumb: project name (→ its history hub `/w/:slug/history`) › Editor
 *   (`aria-current="page"`), so the editor always says WHERE you are;
 * - the explicit way back: a ghost "Dashboard" action through the app router
 *   (the same navigation pattern as the dashboard card's Open button).
 */

export interface EditorTopBarProps {
  /** The open project's name (the first breadcrumb crumb). */
  readonly projectName: string;
  /** The open project's slug (its history-hub route). */
  readonly projectSlug: string;
  /** The dashboard the brand mark + back action return to. */
  readonly dashboardHref?: string;
}

export function EditorTopBar({
  projectName,
  projectSlug,
  dashboardHref = "/w",
}: EditorTopBarProps) {
  const router = useRouter();
  const hubHref = `/w/${projectSlug}/history`;

  return (
    <header
      data-testid="editor-top-bar"
      className="relative z-40 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-app pr-3 pl-4 md:gap-4"
    >
      {/* §2.3 the product mark — signal dot + name, the shell TopBar's exact
          pattern: the name is the quiet, always-there way back to /w. */}
      <Link
        href={dashboardHref}
        aria-label={`${Brand.productName} — dashboard`}
        data-testid="editor-brand-link"
        className="flex shrink-0 items-center gap-2.5"
      >
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-pill bg-signal" />
        <span className="hidden font-display text-title-m leading-none text-primary sm:inline">
          {Brand.productName}
        </span>
      </Link>

      {/* Breadcrumb: the project (→ its history hub) › the current page. */}
      <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center">
        <ol className="flex min-w-0 items-center gap-2 text-body-s">
          <li className="min-w-0">
            <Link
              href={hubHref}
              data-testid="editor-breadcrumb-project"
              title={projectName}
              className="block max-w-48 truncate text-secondary transition-colors duration-120 hover:text-primary md:max-w-64"
            >
              {projectName}
            </Link>
          </li>
          <li aria-hidden="true" className="shrink-0 text-muted">
            <ChevronRight size={14} strokeWidth={1.75} />
          </li>
          <li
            aria-current="page"
            data-testid="editor-breadcrumb-editor"
            className="shrink-0 text-primary"
          >
            Editor
          </li>
        </ol>
      </nav>

      {/* The explicit way back — the product owner's ask. Same navigation
          pattern as the dashboard card's Open action (app-router push). */}
      <button
        type="button"
        data-testid="editor-dashboard-link"
        aria-label="Back to dashboard"
        onClick={() => router.push(dashboardHref)}
        className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "shrink-0 text-secondary")}
      >
        <LayoutDashboard size={14} strokeWidth={1.75} aria-hidden="true" />
        <span className="hidden sm:inline">Dashboard</span>
      </button>
    </header>
  );
}
