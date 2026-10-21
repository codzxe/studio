"use client";

// apps/web — step row (W8-E). Owner: W8-E (docs/AGENTS.md).
//
// Spec anchors:
//   §13.2  step.started / step.finished payloads — phase + tool + duration +
//          ok/err chips; deviationFromPlan is surfaced per step (§5.5).
//   §5.1   the 8 step phases; the ordinal is the rendered position (the SSE
//          stepSeq and the detail seq come from different writers, so the row
//          never labels itself with a raw seq number).
//   §20 #5 steps stream live — a started-but-unfinished row is the optimistic
//          state: a pulsing dot and a ticking duration, no invented result.

import { formatDuration, stepElapsedMs, type TimelineStep } from "./timeline-state";

export interface StepRowProps {
  readonly step: TimelineStep;
  /** 1-based rendered position (never the raw seq — see header note). */
  readonly ordinal: number;
  readonly nowMs: number;
}

function PhaseChip({ phase }: { readonly phase: string }) {
  return (
    <span className="rounded-full border border-border bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
      {phase}
    </span>
  );
}

function StatusChip(props: { readonly step: TimelineStep; readonly nowMs: number }) {
  const { step, nowMs } = props;
  if (step.finished) {
    return step.ok ? (
      <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
        ok
      </span>
    ) : (
      <span className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700">
        error{step.errorCode === null ? "" : ` · ${step.errorCode}`}
      </span>
    );
  }
  const liveMs = stepElapsedMs(step, nowMs);
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-sky-700">
      <span aria-hidden="true" className="relative flex size-2">
        <span className="absolute inline-flex size-2 animate-ping rounded-full bg-sky-400 opacity-75" />
        <span className="relative inline-flex size-2 rounded-full bg-sky-500" />
      </span>
      running{liveMs === null ? "" : ` · ${formatDuration(liveMs)}`}
    </span>
  );
}

export function StepRow({ step, ordinal, nowMs }: StepRowProps) {
  const duration =
    step.durationMs ?? (step.finished ? null : stepElapsedMs(step, nowMs));
  return (
    <li className="flex items-center gap-3 py-2.5">
      <span className="w-6 shrink-0 text-right font-mono text-xs text-muted-foreground">
        {ordinal}.
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate font-mono text-xs">
            {step.tool ?? <span className="text-muted-foreground">{step.phase} step</span>}
          </span>
          <PhaseChip phase={step.phase} />
          {step.deviation ? (
            <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
              deviation
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {duration === null ? null : (
          <span className="font-mono text-xs text-muted-foreground">
            {formatDuration(duration)}
          </span>
        )}
        <StatusChip step={step} nowMs={nowMs} />
      </div>
    </li>
  );
}

/** Per-step optimistic placeholder — the run is active but the next
 *  step.started has not arrived yet (§13.2 backfill or between steps). */
export function StepRowSkeleton() {
  return (
    <li aria-hidden="true" className="flex items-center gap-3 py-2.5">
      <span className="w-6 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="h-3 w-40 animate-pulse rounded bg-muted" />
        <div className="h-2 w-24 animate-pulse rounded bg-muted" />
      </div>
      <div className="h-5 w-16 animate-pulse rounded-full bg-muted" />
    </li>
  );
}
