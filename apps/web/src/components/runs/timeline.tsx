"use client";

// apps/web — run step timeline (W8-E). Owner: W8-E (docs/AGENTS.md).
//
// Spec anchors:
//   §20 #5 the timeline streams plan → steps → previews → verdicts; steps are
//          the spine (step.started/step.finished, §13.2).
//   §5.1   phases seen during the run, in first-seen order (honest: derived
//          from data, no invented ordering).
//
// Optimistic states: while the run is active, a trailing skeleton row stands
// in for the next step.started that has not arrived yet (§13.2 gap or the
// moment between steps); a run with no steps yet gets two placeholder rows.

import { StepRow, StepRowSkeleton } from "./step-row";
import type { RunTimeline } from "./timeline-state";

export interface TimelineProps {
  readonly timeline: RunTimeline;
  readonly nowMs: number;
}

function StepCounts({ timeline }: { readonly timeline: RunTimeline }) {
  const total = timeline.steps.length;
  const ok = timeline.steps.filter((step) => step.finished && step.ok).length;
  const errored = timeline.steps.filter((step) => step.finished && !step.ok).length;
  return (
    <span className="text-xs text-muted-foreground">
      {total} step{total === 1 ? "" : "s"} · {ok} ok
      {errored > 0 ? ` · ${errored} errored` : ""}
    </span>
  );
}

function PhasesStrip({ timeline }: { readonly timeline: RunTimeline }) {
  const seen: string[] = [];
  for (const step of timeline.steps) {
    if (!seen.includes(step.phase)) {
      seen.push(step.phase);
    }
  }
  if (seen.length <= 1) {
    return null;
  }
  const current = timeline.activeStepSeq === null ? null : timeline.status;
  return (
    <div className="flex flex-wrap gap-1.5">
      {seen.map((phase) => (
        <span
          key={phase}
          className={`rounded-full border px-2 py-0.5 text-[11px] ${
            phase === current
              ? "border-sky-200 bg-sky-50 font-medium text-sky-700"
              : "border-border bg-surface-muted text-muted-foreground"
          }`}
        >
          {phase}
        </span>
      ))}
    </div>
  );
}

export function Timeline({ timeline, nowMs }: TimelineProps) {
  const { steps, terminal, activeStepSeq } = timeline;
  const active = !terminal;

  // The optimistic trailing row: the run is working but no step.started is
  // in flight (before the first step, or between two steps).
  const showSkeleton = active && activeStepSeq === null;
  const skeletonCount = steps.length === 0 ? 2 : 1;

  return (
    <section aria-label="Run steps" className="rounded-lg border border-border bg-surface px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h2 className="text-sm font-semibold">Timeline</h2>
        <StepCounts timeline={timeline} />
      </div>

      {steps.length > 0 ? <PhasesStrip timeline={timeline} /> : null}

      {steps.length === 0 && !active ? (
        <p className="mt-3 text-sm text-muted-foreground">No steps were recorded.</p>
      ) : (
        <ol className="mt-2 divide-y divide-border">
          {steps.map((step, index) => (
            <StepRow key={step.stepSeq} step={step} ordinal={index + 1} nowMs={nowMs} />
          ))}
          {showSkeleton
            ? Array.from({ length: skeletonCount }, (_, index) => (
                <StepRowSkeleton key={`skeleton-${index}`} />
              ))
            : null}
        </ol>
      )}
    </section>
  );
}
