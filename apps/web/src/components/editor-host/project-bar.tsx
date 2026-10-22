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

/**
 * The floating project bar (M3.5, BUILD_PLAN §M3 task 5) — auto-hide via CSS
 * ONLY (no JS polling, no pointer listeners): a 4px hover sliver at the top
 * edge reveals the bar (`group-hover`); hovering the bar keeps it open and
 * `focus-within` keeps it reachable by keyboard. When hidden the bar drops
 * its pointer events so it never occludes the editor's own menu bar.
 *
 * Contents: back to the workspace hub, project name, read-only badge (§9.3),
 * and a disabled Share placeholder (M7 — D-18/hard rule 12: no presence yet).
 */
export interface ProjectBarProps {
  readonly projectName: string;
  readonly readOnly: boolean;
  /** The workspace hub the back button returns to. */
  readonly backHref?: string;
}

export function ProjectBar({ projectName, readOnly, backHref = "/w" }: ProjectBarProps) {
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
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              {/* M7 placeholder: a real (focusable, hoverable) button that
                  activates nothing yet — `aria-disabled` marks it inert;
                  M7 replaces it with the real Share flow. */}
              <button
                type="button"
                aria-disabled="true"
                aria-label="Share (coming soon)"
                data-testid="editor-share-placeholder"
                className={cn(
                  buttonVariants({ variant: "ghost", size: "sm" }),
                  "cursor-not-allowed text-disabled opacity-45",
                )}
              >
                <Share2 size={14} strokeWidth={1.75} aria-hidden="true" />
                Share
              </button>
            </TooltipTrigger>
            <TooltipContent>Coming soon</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  );
}
