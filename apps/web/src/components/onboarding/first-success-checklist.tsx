// components/onboarding/first-success-checklist.tsx — the 5-minute
// first-success path (§19 Phase 4; §20 #1): five steps where step 0 (trial
// credit grant) is verified via a GET /v1/credits check and "Create workspace"
// is pre-checked because the user is inside one. Progress bar + a
// once-per-browser celebration when all five complete.

"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  CHECKLIST_STEPS,
  type ChecklistStepMeta,
} from "./checklist-model";
import {
  getBrowserStorage,
  readCelebratedAt,
  writeCelebratedAt,
  type SafeStorage,
} from "./onboarding-storage";
import {
  defaultCheckTrialGrant,
  type TrialGrantCheck,
} from "./trial-grant";
import { useFirstSuccess } from "./use-first-success";

export interface FirstSuccessChecklistProps {
  /**
   * Injected completion overrides (win over storage + runtime checks), e.g.
   * real session signals from the host page. Unknown keys are dropped.
   */
  steps?: Readonly<Record<string, unknown>>;
  /** Injected step-0 check. Default: GET /v1/credits via fetch. */
  checkTrialGrant?: TrialGrantCheck;
  storage?: SafeStorage | null;
  /** The user is inside a workspace (default true). */
  workspaceReady?: boolean;
  /** Fired when a CTA link is clicked (analytics-friendly). */
  onStepClick?: (step: ChecklistStepMeta) => void;
  /** Fired exactly once when the checklist first reaches 5/5. */
  onCelebrated?: () => void;
  /** Fired when the user dismisses the card or the celebration. */
  onDismiss?: () => void;
  /** Show the small dismiss button in list mode. Default false. */
  dismissible?: boolean;
  className?: string;
}

type ViewMode = "list" | "celebrating" | "hidden";

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="h-3.5 w-3.5">
      <path
        fillRule="evenodd"
        d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 9.7a1 1 0 1 1 1.4-1.4l3.8 3.8 6.8-6.8a1 1 0 0 1 1.4 0Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export function FirstSuccessChecklist({
  steps,
  checkTrialGrant = defaultCheckTrialGrant,
  storage,
  workspaceReady = true,
  onStepClick,
  onCelebrated,
  onDismiss,
  dismissible = false,
  className = "",
}: FirstSuccessChecklistProps) {
  const store = storage !== undefined ? storage : getBrowserStorage();
  const {
    steps: completed,
    progress,
    nextStep,
    complete,
    trialGrantPending,
    trialGrantFailure,
    retryTrialGrant,
  } = useFirstSuccess({ storage, checkTrialGrant, workspaceReady, overrides: steps });

  const [view, setView] = useState<ViewMode>("list");
  const celebratedRef = useRef(onCelebrated);
  useEffect(() => {
    celebratedRef.current = onCelebrated;
  }, [onCelebrated]);

  // Celebration fires exactly once per browser profile; after that the card
  // stays out of the way.
  useEffect(() => {
    if (!complete) return;
    if (readCelebratedAt(store) !== null) {
      setView("hidden");
      return;
    }
    writeCelebratedAt(store, new Date().toISOString());
    setView("celebrating");
    celebratedRef.current?.();
  }, [complete, store]);

  const dismiss = () => {
    setView("hidden");
    onDismiss?.();
  };

  if (view === "hidden") return null;

  if (view === "celebrating") {
    return (
      <section
        aria-labelledby="first-success-title"
        className={`relative overflow-hidden rounded-2xl border border-emerald-200 bg-emerald-50/60 p-6 text-left dark:border-emerald-400/20 dark:bg-emerald-400/10 ${className}`}
      >
        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
          <span className="absolute left-[12%] top-3 h-2 w-2 animate-bounce rounded-full bg-emerald-400/70 motion-reduce:animate-none" />
          <span className="absolute right-[16%] top-6 h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400/80 motion-reduce:animate-none" />
          <span className="absolute bottom-4 left-[24%] h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400/80 motion-reduce:animate-none" />
          <span className="absolute bottom-6 right-[12%] h-2 w-2 animate-bounce rounded-full bg-emerald-400/70 motion-reduce:animate-none" />
          <span className="absolute left-[48%] top-8 h-1 w-1 animate-ping rounded-full bg-emerald-500/60 motion-reduce:animate-none" />
        </div>
        <div className="relative">
          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
            Five for five
          </p>
          <h2 id="first-success-title" className="mt-1 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            First design, shipped.
          </h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            That&apos;s the whole loop — template, prompt, export. Everything you made stays
            editable, layer by layer.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Link
              href="/templates"
              className="inline-flex h-9 items-center rounded-lg bg-zinc-900 px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              Explore templates
            </Link>
            <button
              type="button"
              onClick={dismiss}
              className="inline-flex h-9 items-center rounded-lg px-4 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              Dismiss
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="first-success-title"
      className={`rounded-2xl border border-zinc-200 bg-white p-5 text-left shadow-sm dark:border-zinc-800 dark:bg-zinc-900 ${className}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="first-success-title" className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            From zero to your first export
          </h2>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            The 5-minute path — follow it once and you know the whole product.
          </p>
        </div>
        {dismissible ? (
          <button
            type="button"
            aria-label="Dismiss checklist"
            onClick={dismiss}
            className="-m-1 rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
          >
            <span aria-hidden="true" className="text-base leading-none">
              ×
            </span>
          </button>
        ) : null}
      </div>

      <div className="mt-4">
        <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
          <span>
            {progress.done} of {progress.total} steps
          </span>
          <span aria-hidden="true">about 5 minutes</span>
        </div>
        <div
          role="progressbar"
          aria-label="First-success progress"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.done}
          className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
        >
          <div
            className="h-full rounded-full bg-gradient-to-r from-amber-500 to-emerald-500 transition-all duration-500 motion-reduce:transition-none"
            style={{ width: `${Math.round(progress.ratio * 100)}%` }}
          />
        </div>
      </div>

      <ol className="mt-4 space-y-3" role="list">
        {CHECKLIST_STEPS.map((meta, index) => {
          const done = completed[meta.id];
          const current = nextStep?.id === meta.id && !done;
          const pending =
            meta.id === "trial-grant" && trialGrantPending && !done;
          const failed = meta.id === "trial-grant" && !done && trialGrantFailure !== null;

          const circleClasses = done
            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
            : current
              ? "bg-amber-100 text-amber-700 ring-2 ring-amber-400 dark:bg-amber-950 dark:text-amber-300"
              : "bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500";

          const detail = pending
            ? "Checking your trial credits…"
            : failed && trialGrantFailure
              ? trialGrantFailure.message
              : meta.detail;

          const showLink = current && meta.href.length > 0;

          return (
            <li
              key={meta.id}
              aria-current={current ? "step" : undefined}
              className="flex items-start justify-between gap-3"
            >
              <div className="flex items-start gap-3">
                <span
                  aria-hidden={done || pending ? true : undefined}
                  className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${circleClasses}`}
                >
                  {done ? (
                    <CheckIcon />
                  ) : pending ? (
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-amber-500/40 border-t-amber-500 motion-reduce:animate-none" />
                  ) : (
                    index + 1
                  )}
                </span>
                <div>
                  <p
                    className={`text-sm ${
                      done
                        ? "text-zinc-400 line-through decoration-zinc-300 dark:text-zinc-500"
                        : "font-medium text-zinc-900 dark:text-zinc-100"
                    }`}
                  >
                    {meta.title}
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{detail}</p>
                  {failed ? (
                    <p className="mt-0.5 text-xs text-zinc-400 dark:text-zinc-500">
                      {trialGrantFailure.hint}
                    </p>
                  ) : null}
                </div>
              </div>
              {showLink ? (
                <Link
                  href={meta.href}
                  onClick={() => onStepClick?.(meta)}
                  className="shrink-0 self-center rounded-lg px-2 py-1 text-xs font-medium text-amber-600 transition-colors hover:bg-amber-50 hover:text-amber-700 dark:text-amber-400 dark:hover:bg-amber-400/10"
                >
                  {meta.cta}
                </Link>
              ) : failed ? (
                <button
                  type="button"
                  onClick={retryTrialGrant}
                  className="shrink-0 self-center rounded-lg px-2 py-1 text-xs font-medium text-amber-600 transition-colors hover:bg-amber-50 hover:text-amber-700 dark:text-amber-400 dark:hover:bg-amber-400/10"
                >
                  Retry
                </button>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
