"use client";

// apps/web/src/components/realtime — workspace activity feed (W8-R).
//
// Spec anchors: §19 Phase 3 ("workspace activity feed"), §16.2 ("SSE first"),
// §25 rule 3 (NOTIFICATIONS ONLY — the feed lists "runs finished, exports
// ready, members joined"; it never renders document state).
//
// PURE PRESENTATIONAL: rows arrive via the `events` prop, mapped by the
// pure functions in activity-model.ts from the two documented sources —
// §13.2 run events (terminal types only) and the expected audit-tail route
// (zod mirror + TODO(gateway) in activity-model.ts).
//
// SSE WIRING TODO (W8-R deliberately stops at the presentational seam —
// mounting belongs to W8-F/dashboard):
//   • Run rows — subscribe the EXISTING §13.1 stream per active run:
//       const stream = client.streamRunEvents({ runId, onEvent: … });
//     (src/lib/api.ts `RunEventStream`, W1-K — backfill + dedupe by `seq`
//     already handled there), map terminal events through
//     `runEventToActivity`, and merge via `mergeActivity`.
//   • Audit rows — poll `GET /v1/workspaces/:id/audit?limit=50` (contract
//     pinned in activity-model.ts; route TODO(gateway)) with React Query
//     until a workspace realtime channel exists (§16.2: SSE first, then
//     Centrifugo comment/notification events), then invalidate on channel
//     events instead.
//   • `export.ready` rows currently link nowhere (href null) — wire to the
//     exports surface when one lands.

import { Check, Download, RotateCcw, UserPlus, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useMemo } from "react";
import { formatRelativeActivityTime } from "./activity-model";
import type { ActivityItem, ActivityKind } from "./activity-model";

const KIND_ICON: Record<ActivityKind, LucideIcon> = {
  run_finished: Check,
  run_failed: X,
  run_cancelled: RotateCcw,
  export_ready: Download,
  member_joined: UserPlus,
};

export interface ActivityFeedProps {
  /** Merged feed rows — `mergeActivity([...])` from activity-model.ts. */
  readonly events: readonly ActivityItem[];
  /**
   * Relative-time anchor. Fixed per render (the comments-panel precedent:
   * no ticking clock); defaults to "when this list snapshot arrived" so
   * hydration stays consistent via `suppressHydrationWarning` on <time>.
   */
  readonly now?: Date;
  readonly emptyMessage?: string;
  /** Rows rendered (feed is capped upstream too — `mergeActivity` cap). */
  readonly maxRows?: number;
  /** Row click when `onSelect` is provided (router navigation lives above). */
  readonly onSelect?: (event: ActivityItem) => void;
  readonly className?: string;
}

const ROW_BASE_CLASS =
  "flex w-full items-start justify-between gap-3 px-3 py-2.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring hover:bg-surface-muted";

export function ActivityFeed({
  events,
  now,
  emptyMessage = "No recent activity.",
  maxRows = 20,
  onSelect,
  className = "",
}: ActivityFeedProps) {
  const fallbackNow = useMemo(() => new Date(), [events]);
  const anchor = now ?? fallbackNow;
  const rows = events.slice(0, maxRows);

  if (rows.length === 0) {
    return (
      <section
        aria-label="Recent workspace activity"
        className={`rounded-lg border border-border bg-surface ${className}`}
      >
        <p className="px-3 py-6 text-center text-sm text-muted-foreground">{emptyMessage}</p>
      </section>
    );
  }

  return (
    <section
      aria-label="Recent workspace activity"
      className={`overflow-hidden rounded-lg border border-border bg-surface ${className}`}
    >
      <ul className="divide-y divide-border">
        {rows.map((event) => {
          const Icon = KIND_ICON[event.kind];
          const time = (
            <time
              dateTime={event.at.toISOString()}
              suppressHydrationWarning
              className="shrink-0 text-[11px] text-muted-foreground"
            >
              {formatRelativeActivityTime(event.at, anchor)}
            </time>
          );
          const body = (
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="truncate text-sm">{event.title}</span>
              </span>
              {event.detail !== null ? (
                <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                  {event.detail}
                </span>
              ) : null}
            </span>
          );
          return (
            <li key={event.id}>
              {onSelect !== undefined ? (
                <button type="button" onClick={() => onSelect(event)} className={ROW_BASE_CLASS}>
                  {body}
                  {time}
                </button>
              ) : event.href !== null ? (
                <a href={event.href} className={ROW_BASE_CLASS}>
                  {body}
                  {time}
                </a>
              ) : (
                <div className="flex items-start justify-between gap-3 px-3 py-2.5">
                  {body}
                  {time}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
