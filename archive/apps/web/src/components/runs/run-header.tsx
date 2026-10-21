"use client";

// apps/web — run header (W8-E). Owner: W8-E (docs/AGENTS.md).
//
// Spec anchors:
//   §5.1   status badge over the run state machine (queued…cancelled).
//   §5.2   tier chip (quick/standard/complex/premium/max).
//   §14.2  credits reserved → charged (partial charge on rule-4 failures).
//   §5.6   revision before → after (the run is one undoable transaction).
//   §13.2  stream state — live / reconnecting / paused (sentinel, dedupe).
//   §3.4   cancel while the run is active (flip → rollback + refund).
//
// Styling note: this component deliberately uses the app's own globals.css
// utility vocabulary (surface/border/accent) + the stock Tailwind palette for
// status semantics (auth-form.tsx precedent). @studio/ui's status variants
// depend on tokens.css mappings (info/success/…) that globals.css does not
// map yet — adopting them is a global-styles owner decision, not a page-level
// one.

import { Clock, RefreshCw, X } from "lucide-react";
import {
  formatDuration,
  isTerminalRunStatus,
  runElapsedMs,
  statusLabel,
  tierLabel,
  type RunStatusName,
  type RunTimeline,
} from "./timeline-state";
import type { RunStreamState } from "./use-run-events";

// Status → stock-palette chip classes (§5.1 → visual semantics).
const STATUS_CHIP_CLASSES: Readonly<Record<RunStatusName, string>> = {
  queued: "border-zinc-300 bg-zinc-100 text-zinc-700",
  planning: "border-sky-200 bg-sky-50 text-sky-700",
  executing: "border-sky-200 bg-sky-50 text-sky-700",
  observing: "border-sky-200 bg-sky-50 text-sky-700",
  rendering: "border-sky-200 bg-sky-50 text-sky-700",
  validating: "border-sky-200 bg-sky-50 text-sky-700",
  critiquing: "border-sky-200 bg-sky-50 text-sky-700",
  repairing: "border-sky-200 bg-sky-50 text-sky-700",
  finalizing: "border-sky-200 bg-sky-50 text-sky-700",
  succeeded: "border-emerald-200 bg-emerald-50 text-emerald-700",
  succeeded_with_warnings: "border-amber-200 bg-amber-50 text-amber-700",
  failed: "border-red-200 bg-red-50 text-red-700",
  cancelled: "border-zinc-300 bg-zinc-100 text-zinc-600",
};

export interface RunHeaderProps {
  readonly timeline: RunTimeline;
  readonly nowMs: number;
  readonly streamState: RunStreamState;
  readonly streamMessage: string | null;
  /** §3.4 cancel — the button shows while the run is active. */
  readonly cancelling: boolean;
  readonly onCancel: () => void;
  /** Manual stream retry after the §13.2 reconnect budget is exhausted. */
  readonly onReconnect: () => void;
}

function StatusBadge({ status }: { readonly status: RunStatusName }) {
  const active = !isTerminalRunStatus(status) && status !== "queued";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS_CHIP_CLASSES[status]}`}
    >
      {active ? (
        <span aria-hidden="true" className="relative flex size-2">
          <span className="absolute inline-flex size-2 animate-ping rounded-full bg-sky-400 opacity-75" />
          <span className="relative inline-flex size-2 rounded-full bg-sky-500" />
        </span>
      ) : null}
      {statusLabel(status)}
    </span>
  );
}

function CreditLine({ timeline }: { readonly timeline: RunTimeline }) {
  const reserved = timeline.creditsReserved;
  const charged = timeline.creditsCharged;
  if (reserved === null) {
    return <span className="text-xs text-muted-foreground">Credits pending</span>;
  }
  if (charged === null || charged.charged === 0) {
    return (
      <span className="text-xs text-muted-foreground" data-testid="credits">
        {reserved} credit{reserved === 1 ? "" : "s"} reserved
      </span>
    );
  }
  const partial = charged.partial ? " (partial charge)" : "";
  return (
    <span className="text-xs text-muted-foreground" data-testid="credits">
      {reserved} credit{reserved === 1 ? "" : "s"} reserved → charged {charged.charged}
      {partial}
    </span>
  );
}

function RevisionLine({ timeline }: { readonly timeline: RunTimeline }) {
  if (timeline.revisionBefore === null) {
    return null;
  }
  const after = timeline.revisionAfter === null ? "—" : String(timeline.revisionAfter);
  return (
    <span className="text-xs text-muted-foreground">
      Revision {timeline.revisionBefore} → {after}
    </span>
  );
}

function StreamStateLine(props: {
  readonly streamState: RunStreamState;
  readonly streamMessage: string | null;
  readonly terminal: boolean;
  readonly onReconnect: () => void;
}) {
  const { streamState, streamMessage, terminal, onReconnect } = props;
  if (streamState === "live") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-emerald-600">
        <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
        Live
      </span>
    );
  }
  if (streamState === "error") {
    return (
      <span className="inline-flex flex-wrap items-center gap-2 text-xs text-red-600">
        <span>{streamMessage ?? "Lost the run event stream."}</span>
        <button
          type="button"
          onClick={onReconnect}
          className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-surface px-2 py-0.5 font-medium text-red-700 transition hover:bg-red-50"
        >
          <RefreshCw aria-hidden="true" className="size-3" />
          Reconnect
        </button>
      </span>
    );
  }
  if (streamState === "connecting" && !terminal) {
    return <span className="text-xs text-muted-foreground">Connecting…</span>;
  }
  if (streamState === "stopped" && !terminal) {
    // Clean close without a terminal event — the backfill-only case (the
    // worker publishes from another process); show that updates are paused.
    return <span className="text-xs text-muted-foreground">Updates paused</span>;
  }
  return null;
}

export function RunHeader(props: RunHeaderProps) {
  const { timeline, nowMs, streamState, streamMessage, cancelling, onCancel, onReconnect } = props;
  const elapsedMs = runElapsedMs(timeline, nowMs);
  const active = !timeline.terminal;

  return (
    <header className="rounded-lg border border-border bg-surface px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-base font-semibold">Agent run</h1>
        <StatusBadge status={timeline.status} />
        <span className="rounded-full border border-border bg-surface-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
          {tierLabel(timeline.tier)}
        </span>
        {elapsedMs === null ? null : (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Clock aria-hidden="true" className="size-3.5" />
            {formatDuration(elapsedMs)}
          </span>
        )}
        <CreditLine timeline={timeline} />
        <RevisionLine timeline={timeline} />
        <div className="ml-auto flex items-center gap-2">
          <StreamStateLine
            streamState={streamState}
            streamMessage={streamMessage}
            terminal={timeline.terminal}
            onReconnect={onReconnect}
          />
          {active ? (
            <button
              type="button"
              onClick={onCancel}
              disabled={cancelling}
              className="inline-flex items-center gap-1.5 rounded-md border border-red-200 bg-surface px-3 py-1.5 text-xs font-semibold text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <X aria-hidden="true" className="size-3.5" />
              {cancelling ? "Cancelling…" : "Cancel run"}
            </button>
          ) : null}
        </div>
      </div>
      {timeline.cancelledReason === null ? null : (
        <p className="mt-2 text-xs text-muted-foreground">
          Cancelled: {timeline.cancelledReason}. The document was rolled back to its pre-run state
          and the reservation released.
        </p>
      )}
    </header>
  );
}
