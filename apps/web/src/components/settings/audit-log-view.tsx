"use client";

/**
 * AuditLogView — the §8.9 "Audit" surface (PRODUCT_ARCHITECTURE §9.1
 * `audit_log`; W2-07, manifest "SETTINGS PART 2"): a filterable, paginated
 * workspace-wide log with a client-side CSV export.
 *
 * Wire truth (W3-G2's GET /v1/workspaces/:id/audit, viewer floor, mirroring
 * the project activity feed): newest-first cursor-paginated `Page<AuditEntry>`
 * with a SERVER-side `targetType` filter (`repos.audit.list`'s targetType).
 * The wire has NO action param — the action filter is CLIENT-side over the
 * loaded rows (same posture as the M7 activity feed), and says so.
 *
 * The export is real and bounded: it serializes the LOADED rows (never a
 * claim about the whole log) capped at {@link AUDIT_CSV_MAX_ROWS}, as honest
 * RFC-4180 CSV built by {@link auditRowsToCsv}. Rows come from the
 * user-facing feed — actor name, action, target, time; never emails, ips or
 * metadata (law #1 — those live in the admin-only project audit export).
 *
 * Hostile-data safety (law #1 spirit): every wire string is bounded before
 * the DOM, unknown actions/target types degrade to bounded data, hostile
 * timestamps degrade to "—", and there is no raw-HTML path.
 */

import { type AuditQueryInput, isApiError } from "@studio/api-client";
import type { AuditEntry } from "@studio/contracts";
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@studio/ui";
import { CircleAlert, Download } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";

import { type SettingsPort, createDefaultSettingsPort } from "./settings-port";

// ---------------------------------------------------------------------------
// Display bounds (law #1 spirit: wire strings bounded before the DOM)
// ---------------------------------------------------------------------------

const MAX_ACTOR_DISPLAY = 60;
const MAX_ACTION_DISPLAY = 40;
const MAX_TARGET_TYPE_DISPLAY = 24;

function truncateForDisplay(value: string, max: number): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/** Actor display name: null (system/deleted members) renders as "A member". */
export function actorDisplayName(name: string | null): string {
  if (typeof name !== "string" || name.trim().length === 0) return "A member";
  return truncateForDisplay(name, MAX_ACTOR_DISPLAY);
}

// ---------------------------------------------------------------------------
// Time formatting (§14; UTC-pinned, hostile ISO → "—")
// ---------------------------------------------------------------------------

const DATETIME_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function parseInstant(iso: string): Date | null {
  if (typeof iso !== "string" || iso.length === 0) return null;
  const date = new Date(iso.length > 100 ? iso.slice(0, 100) : iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "Oct 21, 2026, 14:32" (§14 + time — this is a log). Hostile ISO → "—". */
export function formatAuditTimestamp(iso: string): string {
  const date = parseInstant(iso);
  return date === null ? "—" : DATETIME_FORMAT.format(date);
}

// ---------------------------------------------------------------------------
// CSV export (real, bounded, RFC-4180)
// ---------------------------------------------------------------------------

/** Hard row bound — the export serializes loaded rows, never an unbounded dump. */
export const AUDIT_CSV_MAX_ROWS = 500;

/** One cell: quote when needed, double embedded quotes (RFC-4180). */
export function csvCell(value: string): string {
  const text = value.length === 0 ? "" : value;
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

export interface AuditCsvResult {
  readonly csv: string;
  /** Rows the export actually carries (≤ rows.length, ≤ AUDIT_CSV_MAX_ROWS). */
  readonly rowCount: number;
  /** `true` when loaded rows exceeded the bound and were cut. */
  readonly truncated: boolean;
}

/**
 * Serialize audit rows to CSV. Columns: time, actor, action, targetType,
 * targetId (the user-facing feed's own data — no emails, ips or metadata).
 * Bounded by {@link AUDIT_CSV_MAX_ROWS}; `truncated` reports the cut.
 */
export function auditRowsToCsv(rows: readonly AuditEntry[]): AuditCsvResult {
  const bounded = rows.length > AUDIT_CSV_MAX_ROWS ? rows.slice(0, AUDIT_CSV_MAX_ROWS) : rows;
  const lines = ["time,actor,action,targetType,targetId"];
  for (const row of bounded) {
    lines.push(
      [
        csvCell(typeof row.createdAt === "string" ? row.createdAt : ""),
        csvCell(actorDisplayName(row.actorName)),
        csvCell(typeof row.action === "string" ? row.action : ""),
        csvCell(row.targetType ?? ""),
        csvCell(row.targetId ?? ""),
      ].join(","),
    );
  }
  return {
    csv: lines.join("\r\n"),
    rowCount: bounded.length,
    truncated: rows.length > AUDIT_CSV_MAX_ROWS,
  };
}

/**
 * Trigger a client-side CSV download (Blob + object URL + anchor click).
 * Wrapped per row in tests via a URL.createObjectURL stub — no network.
 */
export function downloadTextFile(filename: string, text: string): void {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Filter options
// ---------------------------------------------------------------------------

/** The audited target vocabulary (activity copy table's targetTypes). */
const TARGET_TYPE_OPTIONS: readonly string[] = [
  "project",
  "version",
  "run",
  "comment",
  "member",
  "lease",
  "asset",
  "render",
  "workspace",
];

const ALL_FILTER = "all";

// ---------------------------------------------------------------------------
// Cursor pages (race-guarded, replay-safe — the useActivityPages pattern,
// plus a reloadKey so a server-side filter change resets the list)
// ---------------------------------------------------------------------------

export type AuditPageFetcher = (
  query: AuditQueryInput,
) => Promise<{ items: readonly AuditEntry[]; nextCursor: string | null }>;

export interface AuditPagesState {
  readonly entries: readonly AuditEntry[];
  readonly nextCursor: string | null;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly error: string | null;
  readonly loadMore: () => void;
  readonly retry: () => void;
  readonly reload: () => void;
}

function auditErrorMessage(cause: unknown): string {
  if (isApiError(cause)) return truncateForDisplay(cause.message, 200);
  return "The audit log could not be loaded.";
}

export function useAuditPages(
  fetchPage: AuditPageFetcher,
  options?: { readonly pageSize?: number; readonly reloadKey?: string },
): AuditPagesState {
  const pageSize = options?.pageSize ?? 25;
  const reloadKey = options?.reloadKey ?? "";

  const [entries, setEntries] = useState<readonly AuditEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seq = useRef(0);
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
      setError(auditErrorMessage(cause));
    } finally {
      if (seq.current === mySeq) setLoading(false);
    }
  }, [pageSize]);

  const loadMore = useCallback((): void => {
    if (inFlight.current || loading || loadingMore) return;
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
        setEntries((current) => {
          const seen = new Set(current.map((entry) => entry.id));
          const fresh = result.items.filter((entry) => !seen.has(entry.id));
          return [...current, ...fresh];
        });
        setNextCursor(result.nextCursor);
      } catch (cause) {
        if (seq.current !== mySeq) return;
        setError(auditErrorMessage(cause));
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

  // Mount + reloadKey (the SERVER-side targetType filter) → fresh first page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey (the server-side targetType filter) is the deliberate refetch trigger — the body reads only the stable fetchFirst closure through fetchRef
  useEffect(() => {
    void fetchFirst();
  }, [fetchFirst, reloadKey]);

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
// The view
// ---------------------------------------------------------------------------

export interface AuditLogViewProps {
  readonly workspaceId: string;
  /** Injectable port (tests). Production leaves it undefined. */
  readonly api?: SettingsPort;
  /** ISO instant stamped by the RSC — pinned export filename + display math. */
  readonly nowIso: string;
}

const COLUMNS = 4;

export function AuditLogView({ workspaceId, api, nowIso }: AuditLogViewProps): ReactElement {
  const [port] = useState<SettingsPort>(() =>
    api === undefined ? createDefaultSettingsPort(workspaceId) : api,
  );

  // -- server-side targetType filter (rides every page fetch) ---------------
  const [targetType, setTargetType] = useState<string>(ALL_FILTER);

  const fetchPage = useCallback<AuditPageFetcher>(
    (query) =>
      port.listAudit(workspaceId, {
        ...query,
        ...(targetType === ALL_FILTER ? {} : { targetType }),
      }),
    [port, targetType, workspaceId],
  );

  const pages = useAuditPages(fetchPage, { pageSize: 25, reloadKey: targetType });

  // -- client-side action filter (over the loaded rows only) ----------------
  const [actionFilter, setActionFilter] = useState<string>(ALL_FILTER);

  const loadedActions = useMemo(() => {
    const seen = new Set<string>();
    for (const entry of pages.entries) {
      if (typeof entry.action === "string" && entry.action.length > 0) seen.add(entry.action);
    }
    return [...seen].sort();
  }, [pages.entries]);

  const visibleRows = useMemo(() => {
    if (actionFilter === ALL_FILTER) return pages.entries;
    return pages.entries.filter((entry) => entry.action === actionFilter);
  }, [actionFilter, pages.entries]);

  const csv = useMemo(() => auditRowsToCsv(visibleRows), [visibleRows]);

  function onExport(): void {
    if (csv.rowCount === 0) return;
    const stamp = parseInstant(nowIso);
    const fileStamp =
      stamp === null ? "audit" : `audit-${stamp.toISOString().slice(0, 10).replaceAll("-", "")}`;
    downloadTextFile(`${fileStamp}.csv`, csv.csv);
  }

  return (
    <section data-testid="audit-log-view" aria-label="Audit log">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div className="min-w-0">
            <CardTitle>Audit log</CardTitle>
            <CardDescription>
              Who did what across this workspace — members, keys, projects, renders. Target type
              filters the log as it loads; the action filter narrows the loaded rows.
            </CardDescription>
          </div>
          <Button
            variant="secondary"
            size="sm"
            data-testid="audit-export-csv"
            disabled={csv.rowCount === 0}
            onClick={onExport}
          >
            <Download size={14} strokeWidth={1.75} aria-hidden="true" />
            Export CSV
          </Button>
        </CardHeader>

        {/* Filters */}
        <div className="flex flex-wrap items-end gap-3 px-6 pb-4">
          <Select value={targetType} onValueChange={setTargetType}>
            <SelectTrigger
              label="Target type"
              triggerSize="sm"
              className="w-44"
              data-testid="audit-target-type-trigger"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent data-testid="audit-target-type-content">
              <SelectItem value={ALL_FILTER}>All target types</SelectItem>
              {TARGET_TYPE_OPTIONS.map((type) => (
                <SelectItem key={type} value={type}>
                  {type}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={actionFilter} onValueChange={setActionFilter}>
            <SelectTrigger
              label="Action"
              triggerSize="sm"
              className="w-56"
              helperText="Filters the loaded rows."
              data-testid="audit-action-trigger"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent data-testid="audit-action-content">
              <SelectItem value={ALL_FILTER}>All actions</SelectItem>
              {loadedActions.map((action) => (
                <SelectItem key={action} value={action}>
                  {truncateForDisplay(action, MAX_ACTION_DISPLAY)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p data-testid="audit-row-count" className="ml-auto text-caption text-muted">
            {`${visibleRows.length} of ${pages.entries.length} loaded rows`}
          </p>
        </div>

        {pages.error !== null ? (
          <div
            role="alert"
            data-testid="audit-error"
            className="mx-6 mb-2 flex items-center gap-2 rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-caption text-primary"
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
              data-testid="audit-error-retry"
              disabled={pages.loading}
              onClick={pages.retry}
            >
              Try again
            </Button>
          </div>
        ) : null}

        {pages.loading && pages.entries.length === 0 ? (
          <div className="flex flex-col gap-2 px-6 pb-6" data-testid="audit-loading">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-5/6" />
          </div>
        ) : pages.entries.length === 0 && pages.error === null ? (
          <div className="px-6 pb-6">
            <EmptyState data-testid="audit-empty" title="No audit entries for this filter." />
          </div>
        ) : (
          <div className="px-2 pb-4 sm:px-4">
            <Table aria-label="Audit log" data-testid="audit-table" stickyHeader>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Target type</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRows.map((entry, index) => (
                  <TableRow
                    key={`${entry.id}-${index}`}
                    data-testid="audit-row"
                    data-action={typeof entry.action === "string" ? entry.action : ""}
                    data-target-type={entry.targetType ?? ""}
                  >
                    <TableCell className="whitespace-nowrap">
                      <time
                        dateTime={
                          parseInstant(entry.createdAt) === null ? undefined : entry.createdAt
                        }
                        data-testid="audit-row-time"
                      >
                        {formatAuditTimestamp(entry.createdAt)}
                      </time>
                    </TableCell>
                    <TableCell data-testid="audit-row-actor">
                      {actorDisplayName(entry.actorName)}
                    </TableCell>
                    <TableCell>
                      <span
                        className="font-mono text-caption text-secondary"
                        data-testid="audit-row-action"
                      >
                        {truncateForDisplay(
                          typeof entry.action === "string" ? entry.action : "",
                          MAX_ACTION_DISPLAY,
                        ) || "—"}
                      </span>
                    </TableCell>
                    <TableCell>
                      {entry.targetType === null || entry.targetType.length === 0 ? (
                        <span className="text-muted">—</span>
                      ) : (
                        <Badge variant="neutral" data-testid="audit-row-target-type">
                          {truncateForDisplay(entry.targetType, MAX_TARGET_TYPE_DISPLAY)}
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {visibleRows.length === 0 ? (
                  <TableEmpty colSpan={COLUMNS} data-testid="audit-no-match">
                    No loaded rows match this action.
                  </TableEmpty>
                ) : null}
              </TableBody>
            </Table>
            <div className="mt-3 flex items-center justify-center gap-3">
              {pages.nextCursor !== null ? (
                <Button
                  variant="secondary"
                  size="sm"
                  data-testid="audit-load-more"
                  loading={pages.loadingMore}
                  disabled={pages.loading || pages.loadingMore}
                  onClick={pages.loadMore}
                >
                  Load more
                </Button>
              ) : pages.entries.length > 0 ? (
                <p data-testid="audit-end" className="text-caption text-muted">
                  That’s the whole log for this filter.
                </p>
              ) : null}
            </div>
          </div>
        )}
      </Card>
    </section>
  );
}
