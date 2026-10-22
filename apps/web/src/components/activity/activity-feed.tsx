"use client";

/**
 * ActivityFeed — the §M7 task 4 "Activity" surface (BUILD_PLAN §M7 task 4:
 * "Activity feed with actor, action, target, time; audit export";
 * UI_DESIGN_SYSTEM §8.6: "audit-style feed, grouped by day").
 *
 * Wire truth (gateway routes/activity.ts + contracts routes/activity.ts):
 * - `GET /v1/projects/:id/activity` → newest-first `Page<ActivityEntry>`
 *   (cursor pagination — `ACTIVITY_QUERY_SCHEMA` is PAGINATION ONLY: the wire
 *   has NO action filters, so the feed renders no filter chips; see the
 *   M7-H worklog note).
 * - The user-facing feed NEVER carries emails, metadata, ips or target ids
 *   (law #1) — those exist only in the admin-only `/audit-export` payload.
 *
 * Hostile-data safety: every wire string renders as bounded text (React text
 * nodes only — no raw HTML, no ids); unknown actions degrade to data, never
 * break the row; hostile timestamps degrade to "—".
 *
 * Time display (§14): relative "2h ago" for recent rows, absolute
 * "Oct 21, 2026" past a week. `nowIso` is stamped by the host (RSC) so the
 * relative math is deterministic per page load and in tests.
 */

import { isApiError } from "@studio/api-client";
import type { ActivityEntry, Page } from "@studio/contracts";
import { Button, EmptyState, Skeleton } from "@studio/ui";
import { CircleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";

// ---------------------------------------------------------------------------
// Display bounds (law #1 spirit: wire strings bounded before the DOM)
// ---------------------------------------------------------------------------

const MAX_ACTOR_DISPLAY = 60;
const MAX_ACTION_DISPLAY = 24;

export function truncateActivityString(value: string, max: number): string {
  const text = value.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// Copy tables (actor + action + target read as one sentence)
// ---------------------------------------------------------------------------

export interface ActivityRowCopy {
  /** Reads directly after the actor name ("Alex saved…"). */
  readonly verb: string;
  /** The target summary ("…a version"). */
  readonly target: string;
}

const ACTIVITY_COPY: Readonly<Record<string, ActivityRowCopy>> = {
  "project.created": { verb: "created", target: "the project" },
  "project.updated": { verb: "updated", target: "the project" },
  "project.deleted": { verb: "deleted", target: "the project" },
  "version.uploaded": { verb: "saved", target: "a version" },
  "version.restored": { verb: "restored", target: "an earlier version" },
  "version.labeled": { verb: "renamed", target: "a version" },
  "run.started": { verb: "started", target: "an agent run" },
  "run.completed": { verb: "finished", target: "an agent run" },
  "run.failed": { verb: "reported a failed", target: "agent run" },
  "run.cancelled": { verb: "cancelled", target: "an agent run" },
  "run.applied": { verb: "applied", target: "an agent edit" },
  "run.undone": { verb: "undid", target: "an agent edit" },
  "comment.created": { verb: "left", target: "a comment" },
  "comment.replied": { verb: "replied to", target: "a comment" },
  "comment.resolved": { verb: "resolved", target: "a comment" },
  "comment.reopened": { verb: "reopened", target: "a comment" },
  "lease.acquired": { verb: "started editing", target: "the project" },
  "lease.released": { verb: "finished editing", target: "the project" },
  "lease.requested": { verb: "requested", target: "edit access" },
  "member.invited": { verb: "invited", target: "a member" },
  "member.joined": { verb: "joined", target: "the workspace" },
  "asset.created": { verb: "added", target: "an asset" },
  "render.queued": { verb: "queued", target: "a render" },
};

/** Neutral target summary per `targetType` (no ids ever render). */
export function activityTargetSummary(targetType: string | null): string {
  switch (targetType) {
    case "project":
      return "the project";
    case "version":
      return "a version";
    case "comment":
      return "a comment";
    case "run":
      return "an agent run";
    case "lease":
      return "the edit lease";
    case "member":
    case "workspace":
      return "the workspace";
    case "asset":
      return "an asset";
    case "render":
      return "a render";
    default:
      return "this project";
  }
}

/**
 * Sentence fragments for one row. Known actions read naturally ("saved a
 * version"); unknown wire actions stay DATA ("did “weird.action”") — bounded,
 * escaped, never breaking the row.
 */
export function activityRowCopy(action: string, targetType: string | null): ActivityRowCopy {
  const known = ACTIVITY_COPY[action];
  if (known !== undefined) return known;
  return {
    verb: "did",
    target: `“${truncateActivityString(action, MAX_ACTION_DISPLAY)}”`,
  };
}

/** Actor display name: null (system/deleted members) renders as "A member". */
export function actorDisplayName(name: string | null): string {
  if (typeof name !== "string" || name.trim().length === 0) return "A member";
  return truncateActivityString(name, MAX_ACTOR_DISPLAY);
}

// ---------------------------------------------------------------------------
// Time formatting (§14; UTC-pinned, hostile ISO → "—")
// ---------------------------------------------------------------------------

const DAY_LABEL_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  year: "numeric",
});

function parseInstant(iso: string): Date | null {
  if (typeof iso !== "string" || iso.length === 0) return null;
  const date = new Date(iso.length > 100 ? iso.slice(0, 100) : iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Day header: "Oct 21, 2026" (§14 date style, UTC). Hostile ISO → "—". */
export function formatDayLabel(iso: string): string {
  const date = parseInstant(iso);
  return date === null ? "—" : DAY_LABEL_FORMAT.format(date);
}

/**
 * Relative time ("just now", "3m ago", "2h ago", "5d ago"); past a week the
 * absolute §14 date ("Oct 21, 2026"). Clock-skewed futures read "just now".
 */
export function formatTimeAgo(iso: string, nowIso: string): string {
  const created = parseInstant(iso);
  const now = parseInstant(nowIso);
  if (created === null || now === null) return "—";
  const elapsedMs = now.getTime() - created.getTime();
  if (elapsedMs < 60_000) return "just now";
  if (elapsedMs < 3_600_000) return `${Math.floor(elapsedMs / 60_000)}m ago`;
  if (elapsedMs < 86_400_000) return `${Math.floor(elapsedMs / 3_600_000)}h ago`;
  if (elapsedMs < 7 * 86_400_000) return `${Math.floor(elapsedMs / 86_400_000)}d ago`;
  return DAY_LABEL_FORMAT.format(created);
}

/** UTC day key for grouping (hostile ISO buckets to "undated"). */
function dayKey(iso: string): string {
  const date = parseInstant(iso);
  return date === null ? "undated" : DAY_LABEL_FORMAT.format(date);
}

// ---------------------------------------------------------------------------
// useActivityPages — race-guarded, replay-safe cursor pagination
// ---------------------------------------------------------------------------

export type ActivityPageFetcher = (query: {
  readonly cursor?: string;
  readonly limit?: number;
}) => Promise<Page<ActivityEntry>>;

export interface ActivityPagesState {
  readonly entries: readonly ActivityEntry[];
  readonly nextCursor: string | null;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly error: string | null;
  readonly loadMore: () => void;
  readonly retry: () => void;
  readonly reload: () => void;
}

function fetchErrorMessage(cause: unknown): string {
  if (isApiError(cause)) return truncateActivityString(cause.message, 200);
  return "The activity feed could not be loaded.";
}

export function useActivityPages(
  fetchPage: ActivityPageFetcher,
  options?: { readonly pageSize?: number },
): ActivityPagesState {
  const pageSize = options?.pageSize ?? 25;

  const [entries, setEntries] = useState<readonly ActivityEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seq = useRef(0);
  // Synchronous in-flight guard for load-more (double-fire safe); fetchFirst
  // reloads supersede — the seq guard drops stale writes either way.
  const inFlight = useRef(false);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;

  const fetchFirst = useCallback(async (): Promise<void> => {
    seq.current += 1;
    const mySeq = seq.current;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    try {
      const result = await fetchRef.current({ limit: pageSize });
      if (seq.current !== mySeq) return;
      setEntries(result.items);
      setNextCursor(result.nextCursor);
    } catch (cause) {
      if (seq.current !== mySeq) return;
      setError(fetchErrorMessage(cause));
    } finally {
      if (seq.current === mySeq) setLoading(false);
    }
  }, [pageSize]);

  const loadMore = useCallback((): void => {
    if (inFlight.current) return;
    if (loading || loadingMore) return;
    const cursor = nextCursor;
    if (cursor === null) return;
    inFlight.current = true;
    seq.current += 1;
    const mySeq = seq.current;
    setLoadingMore(true);
    setError(null);
    void (async () => {
      try {
        const result = await fetchRef.current({ cursor, limit: pageSize });
        if (seq.current !== mySeq) return;
        setEntries((current) => [...current, ...result.items]);
        setNextCursor(result.nextCursor);
      } catch (cause) {
        if (seq.current !== mySeq) return;
        setError(fetchErrorMessage(cause));
      } finally {
        inFlight.current = false;
        if (seq.current === mySeq) setLoadingMore(false);
      }
    })();
  }, [loading, loadingMore, nextCursor, pageSize]);

  const retry = useCallback((): void => {
    if (entries.length === 0) void fetchFirst();
    else loadMore();
  }, [entries.length, fetchFirst, loadMore]);

  useEffect(() => {
    void fetchFirst();
  }, [fetchFirst]);

  return {
    entries,
    nextCursor,
    loading,
    loadingMore,
    error,
    loadMore,
    retry,
    reload: fetchFirst,
  };
}

// ---------------------------------------------------------------------------
// The feed
// ---------------------------------------------------------------------------

function ActivityRow({ entry, nowIso }: { entry: ActivityEntry; nowIso: string }): ReactElement {
  const actor = actorDisplayName(entry.actorName);
  const copy = activityRowCopy(
    typeof entry.action === "string" ? entry.action : "",
    entry.targetType,
  );
  const ago = formatTimeAgo(entry.createdAt, nowIso);
  const validIso = parseInstant(entry.createdAt) !== null;

  return (
    <li
      data-testid="activity-row"
      data-action={typeof entry.action === "string" ? entry.action : ""}
      className="flex flex-wrap items-baseline gap-x-2 py-2.5"
    >
      <span className="min-w-0">
        <span className="font-medium text-primary" data-testid="activity-actor">
          {actor}
        </span>{" "}
        <span className="text-secondary" data-testid="activity-verb">
          {copy.verb}
        </span>{" "}
        <span className="text-secondary" data-testid="activity-target">
          {copy.target}
        </span>
      </span>
      <time
        className="ml-auto text-caption text-muted"
        dateTime={validIso ? entry.createdAt : undefined}
        title={validIso ? formatDayLabel(entry.createdAt) : undefined}
        data-testid="activity-time"
      >
        {ago}
      </time>
    </li>
  );
}

export interface ActivityFeedProps {
  /** Structurally `client.activity.list(projectId, query)` — feed pages. */
  readonly fetchPage: ActivityPageFetcher;
  /** ISO instant stamped by the host (RSC) — pins the relative math. */
  readonly nowIso: string;
  readonly className?: string;
}

export function ActivityFeed({ fetchPage, nowIso, className }: ActivityFeedProps): ReactElement {
  const pages = useActivityPages(fetchPage);

  // §8.6 "grouped by day" — entries are newest-first, so the encountered day
  // keys descend naturally; one header per UTC day.
  const groups = useMemo(() => {
    const ordered: string[] = [];
    const buckets = new Map<string, ActivityEntry[]>();
    for (const entry of pages.entries) {
      const key = dayKey(entry.createdAt);
      const bucket = buckets.get(key);
      if (bucket === undefined) {
        buckets.set(key, [entry]);
        ordered.push(key);
      } else {
        bucket.push(entry);
      }
    }
    return ordered.map((key) => ({
      key,
      label: key === "undated" ? "—" : key,
      entries: buckets.get(key) ?? [],
    }));
  }, [pages.entries]);

  const canLoadMore = pages.nextCursor !== null;
  const atEnd = !pages.loading && pages.nextCursor === null && pages.entries.length > 0;

  return (
    <section data-testid="activity-feed" className={className} aria-label="Project activity">
      {pages.error !== null ? (
        <div
          role="alert"
          data-testid="activity-error"
          className="mb-4 flex items-center gap-2 rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-caption text-primary"
        >
          <CircleAlert
            size={16}
            strokeWidth={1.75}
            aria-hidden="true"
            className="shrink-0 text-danger"
          />
          <p className="min-w-0 flex-1">{pages.error}</p>
          <Button
            variant="secondary"
            size="sm"
            data-testid="activity-error-retry"
            disabled={pages.loading}
            onClick={pages.retry}
          >
            Try again
          </Button>
        </div>
      ) : null}

      {pages.loading && pages.entries.length === 0 ? (
        <div className="flex flex-col gap-3 py-2" data-testid="activity-loading">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-6 w-full max-w-[560px]" />
          <Skeleton className="h-6 w-full max-w-[520px]" />
          <Skeleton className="h-6 w-full max-w-[540px]" />
        </div>
      ) : pages.entries.length === 0 ? (
        <EmptyState data-testid="activity-empty" title="No activity yet." />
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map((group) => (
            <div key={group.key} data-testid="activity-day-group">
              <h4
                data-testid="activity-day"
                className="text-label uppercase tracking-[0.06em] text-muted"
              >
                {group.label}
              </h4>
              <ol className="mt-1 divide-y divide-border/60">
                {group.entries.map((entry, index) => (
                  <ActivityRow key={`${entry.id}-${index}`} entry={entry} nowIso={nowIso} />
                ))}
              </ol>
            </div>
          ))}
        </div>
      )}

      {canLoadMore || atEnd ? (
        <div className="mt-4 flex items-center justify-center gap-3">
          {canLoadMore ? (
            <Button
              variant="secondary"
              size="sm"
              data-testid="activity-load-more"
              loading={pages.loadingMore}
              disabled={pages.loading || pages.loadingMore}
              onClick={() => pages.loadMore()}
            >
              Load more
            </Button>
          ) : (
            <p data-testid="activity-end" className="text-caption text-muted">
              That’s the whole feed.
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}
