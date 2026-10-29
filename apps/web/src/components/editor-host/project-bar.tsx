"use client";

import {
  Badge,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  buttonVariants,
  cn,
} from "@studio/ui";
import { ArrowLeft, Share2 } from "lucide-react";
import Link from "next/link";
import { Suspense, lazy, useState } from "react";

import type { ShareClient } from "./share-dialog";

// Round-13 main-thread fix: the Share dialog (radix Dialog + ConfirmDialog +
// Input + Spinner — everything click-triggered) is a LAZY module fetched on
// the first Share click. While it lived inline in this file, its chunk graph
// sat in the editor route's eager bundle and competed for the main thread
// during the LCP render-delay window (185ms of Compile script + long
// EvaluateScript tasks on throttled machines). The dialog unmounts while
// closed — mounting it only while open both keeps state fresh (shown-once
// token) and guarantees the lazy chunk is only ever fetched on demand.
const ShareDialog = lazy(() =>
  import("./share-dialog").then((module) => ({ default: module.ShareDialog })),
);

/** Re-exported for the import sites that pin the structural seam (tests). */
export type { ShareClient } from "./share-dialog";

/**
 * The floating project bar (M3.5, BUILD_PLAN §M3 task 5) — auto-hide via CSS
 * ONLY (no JS polling, no pointer listeners): a 4px hover sliver at the top
 * edge reveals the bar (`group-hover`); hovering the bar keeps it open and
 * `focus-within` keeps it reachable by keyboard. When hidden the bar drops
 * its pointer events so it never occludes the editor's own menu bar.
 *
 * Contents: back to the workspace hub, project name, read-only badge (§9.3),
 * and the REAL Share button (W4-KILL, audit REPLACE-2): the share API is live
 * (POST /v1/projects/:id/share-links mints, GET lists, DELETE revokes), so
 * the button opens the lazily-imported ShareDialog — issue a link (token
 * shown ONCE, copy it), list the active links, revoke through ConfirmDialog.
 * When no share seam is passed (test sessions without an api client) the
 * button is simply not mounted — there is no "coming soon" chrome anywhere.
 */

/** The live share seam: projectId + a client with the `share` region. */
export interface ProjectBarShareProps {
  readonly projectId: string;
  readonly client: ShareClient;
}

export interface ProjectBarProps {
  readonly projectName: string;
  readonly readOnly: boolean;
  /** The workspace hub the back button returns to. */
  readonly backHref?: string;
  /**
   * Live share seam. Absent/null → the Share button is not mounted (never an
   * inert placeholder).
   */
  readonly share?: ProjectBarShareProps | null;
}

export function ProjectBar({ projectName, readOnly, backHref = "/w", share }: ProjectBarProps) {
  const [shareOpen, setShareOpen] = useState(false);

  return (
    <div className="group pointer-events-none absolute inset-x-0 top-0 z-30 flex flex-col items-center">
      {/* 4px reveal sliver — the only editor-visible chrome while hidden. */}
      <div
        data-testid="editor-bar-sliver"
        className="pointer-events-auto h-1 w-full"
        aria-hidden="true"
      />
      <div
        data-testid="editor-project-bar"
        className="pointer-events-none mt-1 mb-2 flex h-9 items-center gap-3 rounded-sm border border-border bg-panel/95 pr-1 pl-2 text-body text-primary opacity-0 shadow-pop transition-opacity duration-120 ease-out group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
      >
        <Link
          href={backHref}
          aria-label="Back to workspace"
          className="inline-flex h-7 w-7 items-center justify-center rounded-sm text-secondary transition-colors hover:bg-elevated hover:text-primary"
        >
          <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
        </Link>
        <span className="max-w-64 truncate font-medium" title={projectName}>
          {projectName}
        </span>
        {readOnly ? (
          <Badge data-testid="editor-readonly-badge" variant="warning">
            Read-only
          </Badge>
        ) : null}
        {share !== null && share !== undefined ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Share project"
                  data-testid="editor-share-button"
                  onClick={() => setShareOpen(true)}
                  className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "text-secondary")}
                >
                  <Share2 size={14} strokeWidth={1.75} aria-hidden="true" />
                  Share
                </button>
              </TooltipTrigger>
              <TooltipContent>Share this project</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
      </div>
      {share !== null && share !== undefined && shareOpen ? (
        // Mount-only-while-open: the lazy chunk is fetched on the FIRST Share
        // click (never with the page), and unmounting on close resets the
        // dialog's transient state — the shown-once token can never reappear.
        <Suspense fallback={null}>
          <ShareDialog
            open={shareOpen}
            onOpenChange={setShareOpen}
            projectName={projectName}
            projectId={share.projectId}
            client={share.client}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
