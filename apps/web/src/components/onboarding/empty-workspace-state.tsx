// components/onboarding/empty-workspace-state.tsx — the big friendly first
// screen for a workspace with zero documents (§19 Phase 4): the checklist,
// the guided tour, the coffee demo card and a create button, all in one place.

"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { DemoProjectCard } from "./demo-project-card";
import { FirstSuccessChecklist } from "./first-success-checklist";
import { GuidedTour } from "./guided-tour";
import { getBrowserStorage, type SafeStorage } from "./onboarding-storage";
import type { TrialGrantCheck } from "./trial-grant";

export interface EmptyWorkspaceStateProps {
  /** Shown in the headline when provided ("Acme Studio is empty —"). */
  workspaceName?: string;
  /** Passed to the demo card so the seeded document lands in the right project. */
  projectId?: string;
  storage?: SafeStorage | null;
  /** Injected step-0 check for the checklist (default: GET /v1/credits). */
  checkTrialGrant?: TrialGrantCheck;
  /** Injected checklist completion overrides (real session signals). */
  stepOverrides?: Readonly<Record<string, unknown>>;
  /** Where the primary "New document" button goes. Default "/documents?new=1". */
  createHref?: string;
  /** Wins over createHref — wire your create-document modal here. */
  onCreateClick?: () => void;
  /** Override the internal "restart the tour" behavior. */
  onTourStart?: () => void;
  /** Fired when the user dismisses the checklist card. */
  onChecklistDismiss?: () => void;
  className?: string;
}

const DEFAULT_CREATE_HREF = "/documents?new=1";

function LayeredCanvasIllustration() {
  return (
    <div aria-hidden="true" className="relative mx-auto h-28 w-44 select-none">
      <div className="absolute inset-x-3 top-1 bottom-2 -rotate-2 rounded-xl border border-amber-500/30 bg-amber-100/70 dark:bg-amber-400/10" />
      <div className="absolute inset-x-1 top-3 bottom-0 rotate-1 rounded-xl border border-zinc-300/60 bg-white shadow-sm dark:border-zinc-700 dark:bg-zinc-900" />
      <div className="absolute left-5 right-5 top-7 h-2 rounded-full bg-amber-500/70" />
      <div className="absolute left-5 right-10 top-11 h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-700" />
      <div className="absolute bottom-3 left-5 h-9 w-14 rounded-md bg-emerald-300/60 dark:bg-emerald-500/20" />
      <div className="absolute bottom-3 left-[92px] right-10 space-y-1.5">
        <div className="h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-700" />
        <div className="h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-700" />
      </div>
      <div className="absolute left-1 top-8 h-3 w-3 -translate-x-1 rounded-sm border border-emerald-500/60 bg-emerald-200/50 dark:bg-emerald-500/20" />
      <div className="absolute left-1 top-[42px] h-3 w-3 -translate-x-1 rounded-sm border border-emerald-500/50 bg-emerald-200/40 dark:bg-emerald-500/15" />
      <div className="absolute left-1 top-[58px] h-3 w-3 -translate-x-1 rounded-sm border border-emerald-500/40 bg-emerald-200/30 dark:bg-emerald-500/10" />
      <span className="absolute right-3 top-5 h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400 motion-reduce:animate-none" />
      <span className="absolute right-6 top-10 h-1 w-1 animate-ping rounded-full bg-amber-500/60 motion-reduce:animate-none" />
    </div>
  );
}

export function EmptyWorkspaceState({
  workspaceName,
  projectId,
  storage,
  checkTrialGrant,
  stepOverrides,
  createHref = DEFAULT_CREATE_HREF,
  onCreateClick,
  onTourStart,
  onChecklistDismiss,
  className = "",
}: EmptyWorkspaceStateProps) {
  const store = useMemo<SafeStorage | null>(
    () => (storage !== undefined ? storage : getBrowserStorage()),
    [storage],
  );
  const [tourKey, setTourKey] = useState(0);
  const [tourPolicy, setTourPolicy] = useState<"auto" | "always">("auto");

  const startTour = () => {
    setTourPolicy("always");
    setTourKey((key) => key + 1);
  };

  return (
    <section
      aria-labelledby="empty-workspace-title"
      className={`mx-auto max-w-xl text-center ${className}`}
    >
      <LayeredCanvasIllustration />
      <h1
        id="empty-workspace-title"
        className="mt-4 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100"
      >
        Make your first design
      </h1>
      <p className="mx-auto mt-2 max-w-md text-sm text-zinc-600 dark:text-zinc-400">
        {workspaceName ? `${workspaceName} is empty — ` : "A blank canvas — "}
        from nothing to an exported post in about five minutes. Follow the path, or
        cheat with the coffee demo.
      </p>

      <div className="mt-6 text-left">
        <FirstSuccessChecklist
          storage={store}
          checkTrialGrant={checkTrialGrant}
          steps={stepOverrides}
          onDismiss={onChecklistDismiss}
          dismissible={typeof onChecklistDismiss === "function"}
        />
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 sm:items-start">
        {onCreateClick ? (
          <button
            type="button"
            onClick={onCreateClick}
            className="inline-flex h-11 w-full items-center justify-center rounded-lg bg-zinc-900 px-5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            New document
          </button>
        ) : (
          <Link
            href={createHref}
            className="inline-flex h-11 w-full items-center justify-center rounded-lg bg-zinc-900 px-5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            New document
          </Link>
        )}
        <button
          type="button"
          onClick={onTourStart ?? startTour}
          className="inline-flex h-11 w-full items-center justify-center rounded-lg border border-zinc-200 px-5 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
        >
          Show me around
        </button>
      </div>

      <div className="mt-3">
        <DemoProjectCard projectId={projectId} storage={store} />
      </div>

      {/* Remount with key + "always" policy = the "Show me around" restart. */}
      <GuidedTour key={tourKey} storage={store} startPolicy={tourPolicy} />
    </section>
  );
}
