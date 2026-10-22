"use client";

/**
 * VersionTimeline — the §M7 task 4 "Versions" surface (UI_DESIGN_SYSTEM §8.6:
 * "timeline list with version number, label, author, time, size, 'Restore'.
 * Diff entry point. Restore is a new version, never a rewrite").
 *
 * Wire truth (PRODUCT_ARCHITECTURE §9.1/§9.3 + gateway routes/versions.ts):
 * - `GET /v1/projects/:id/versions` → newest-first `Page<VersionTimelineEntry>`
 *   (author display name, `isAgent` from `agentRunId ≠ null`, 12-char sha256
 *   prefix — full hashes never appear in user copy).
 * - `GET /v1/projects/:id/versions/:versionId/diff` — the structural summary
 *   vs the parent (size delta, time gap, authorship); no deep content diff v1.
 * - `POST …/versions/:versionId/restore` { confirmLabel } — §9.3: restore
 *   creates a NEW version (parent = the restored one); history is never
 *   rewritten. The typed confirmation NAMES the version (the gateway's
 *   confirm-with-confirmation semantics); a wrong label is rejected HERE,
 *   client-side, before the POST fires.
 * - `POST …/versions/:versionId/label` { label } — D-24 candidate: the label
 *   is the ONLY mutable version field (1–120 chars, non-empty).
 *
 * Restore and label edits are edit-lease gated SERVER-side (§M7 task 3):
 * typed `LEASE_HELD` errors ("{Name} is editing this project right now.")
 * surface in place, verbatim + hint + request id (§7.3/§14).
 *
 * Hostile-data safety (law #1 spirit): every wire string is bounded before it
 * reaches the DOM, ids never render, and there is no raw-HTML path. The
 * api-client supplies a FRESH idempotency key per mutation call by default
 * (§7.2) — a retry gesture is safe, a double-POST replays.
 */

import { isApiError } from "@studio/api-client";
import type { CallOptions } from "@studio/api-client";
import type {
  Page,
  ProjectVersion,
  RestoreVersionRequest,
  SetVersionLabelRequest,
  VersionDiffSummary,
  VersionTimelineEntry,
} from "@studio/contracts";
import {
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  EmptyState,
  Input,
  Skeleton,
} from "@studio/ui";
import { Bot, CircleAlert, Download, Pencil, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";

// ---------------------------------------------------------------------------
// Display bounds + formatters (UI_DS §14; all degrade hostile wire data)
// ---------------------------------------------------------------------------

/** Timeline labels render bounded; the upload path allows 280-char labels. */
const MAX_LABEL_DISPLAY = 140;

/** Any other wire-derived string (author names, diff summaries) is bounded. */
const MAX_META_DISPLAY = 200;

/** D-24 / TIMELINE_LABEL_SCHEMA mirror: labels are 1–120 chars, non-empty. */
export const TIMELINE_LABEL_MAX_CHARS = 120;

/** Hard string bound for anything rendered from wire data. */
export function truncateTimelineString(value: string, max: number): string {
  const text = value.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/**
 * §14 file sizes: `12.4 MB`, `20 GB`, `1 TB` (base 1024, one decimal above
 * bytes). Hostile numbers (negative, non-finite) render as "—".
 */
export function formatVersionBytes(bytes: number): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  const rounded = Math.round(value * 10) / 10;
  return `${rounded.toLocaleString("en-US", { maximumFractionDigits: 1 })} ${units[unit]}`;
}

/** Signed size delta for the diff panel: "+1.2 KB" / "-240 B" / "no change". */
export function formatSizeDeltaBytes(deltaBytes: number): string {
  if (typeof deltaBytes !== "number" || !Number.isFinite(deltaBytes)) return "—";
  if (deltaBytes === 0) return "no change";
  const body = formatVersionBytes(Math.abs(deltaBytes));
  return `${deltaBytes > 0 ? "+" : "-"}${body}`;
}

/**
 * Timeline timestamps: "Oct 21, 2026, 14:32" (UI_DS §14 — absolute dates on a
 * history surface; relative time stays on the activity feed). Pinned to UTC
 * so the display is deterministic everywhere; hostile ISO degrades to "—".
 */
const TIMELINE_DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatTimelineTimestamp(iso: string): string {
  if (typeof iso !== "string" || iso.length === 0) return "—";
  const date = new Date(iso.length > 100 ? iso.slice(0, 100) : iso);
  if (Number.isNaN(date.getTime())) return "—";
  return TIMELINE_DATE_FORMAT.format(date);
}

/** Creation gap between a version and its parent, as short copy. */
export function formatCreatedGap(gapMs: number): string {
  if (typeof gapMs !== "number" || !Number.isFinite(gapMs) || gapMs < 0) return "—";
  if (gapMs < 60_000) return "moments later";
  if (gapMs < 3_600_000) return `${Math.round(gapMs / 60_000)}m later`;
  if (gapMs < 86_400_000) {
    const hours = Math.floor(gapMs / 3_600_000);
    const minutes = Math.round((gapMs % 3_600_000) / 60_000);
    return minutes === 0 ? `${hours}h later` : `${hours}h ${minutes}m later`;
  }
  const days = Math.floor(gapMs / 86_400_000);
  if (days < 7) return `${days}d later`;
  return "more than a week later";
}

/**
 * The typed confirmation phrase for a restore (§M7 task 4 confirmation
 * semantics): the version's exact label, or its `v{N}` designation when it has
 * none. The user types THIS, exactly, before the POST is allowed to fire.
 */
export function restoreConfirmPhrase(entry: VersionTimelineEntry): string {
  const label = entry.label;
  if (typeof label === "string" && label.trim().length > 0) return label.trim();
  return `v${entry.version}`;
}

// ---------------------------------------------------------------------------
// Fetcher/caller seams (structurally the api-client methods; tests fake them)
// ---------------------------------------------------------------------------

export type VersionPageFetcher = (query: {
  readonly cursor?: string;
  readonly limit?: number;
}) => Promise<Page<VersionTimelineEntry>>;

export type RestoreVersionCaller = (
  versionId: string,
  body: RestoreVersionRequest,
  options?: CallOptions,
) => Promise<ProjectVersion>;

export type SetVersionLabelCaller = (
  versionId: string,
  body: SetVersionLabelRequest,
  options?: CallOptions,
) => Promise<ProjectVersion>;

export type FetchDiffCaller = (versionId: string) => Promise<VersionDiffSummary>;

/** §7.3-shaped action failure: message + hint + request id (§14). */
export interface TimelineActionError {
  readonly message: string;
  readonly hint?: string;
  readonly requestId?: string;
}

function toActionError(cause: unknown): TimelineActionError {
  if (isApiError(cause)) {
    return { message: cause.message, hint: cause.hint, requestId: cause.requestId };
  }
  return { message: "Something went wrong on our side.", hint: "Try again in a moment." };
}

function boundedErrorText(error: TimelineActionError): string {
  const message = truncateTimelineString(error.message, MAX_META_DISPLAY);
  return error.requestId === undefined ? message : `${message} (${error.requestId})`;
}

// ---------------------------------------------------------------------------
// useVersionPages — race-guarded, replay-safe cursor pagination
// ---------------------------------------------------------------------------

export interface VersionPagesState {
  readonly entries: readonly VersionTimelineEntry[];
  readonly nextCursor: string | null;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly error: string | null;
  readonly loadMore: () => void;
  readonly retry: () => void;
  readonly reload: () => void;
  /** Replaces one loaded row by id (inline label saves; no refetch needed). */
  readonly patchEntry: (next: VersionTimelineEntry) => void;
}

function fetchErrorMessage(cause: unknown): string {
  if (isApiError(cause)) return truncateTimelineString(cause.message, MAX_META_DISPLAY);
  return "The version timeline could not be loaded.";
}

export function useVersionPages(
  fetchPage: VersionPageFetcher,
  options?: { readonly pageSize?: number },
): VersionPagesState {
  const pageSize = options?.pageSize ?? 25;

  const [entries, setEntries] = useState<readonly VersionTimelineEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seq = useRef(0);
  // Synchronous in-flight guard for load-more: two calls before a re-render
  // (double click) can never double-fetch a page. fetchFirst (reload) never
  // blocks on it — a reload SUPERSEDES an in-flight load-more (seq guard).
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

  const patchEntry = useCallback((next: VersionTimelineEntry): void => {
    setEntries((current) => current.map((entry) => (entry.id === next.id ? next : entry)));
  }, []);

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
    patchEntry,
  };
}

// ---------------------------------------------------------------------------
// Inline label editing (D-24 candidate: the label is the ONLY mutable field)
// ---------------------------------------------------------------------------

function validTimelineLabel(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= TIMELINE_LABEL_MAX_CHARS;
}

interface LabelEditorState {
  readonly editing: boolean;
  readonly draft: string;
  readonly saving: boolean;
  readonly error: string | null;
}

const LABEL_EDITOR_IDLE: LabelEditorState = {
  editing: false,
  draft: "",
  saving: false,
  error: null,
};

// ---------------------------------------------------------------------------
// Diff panel state (one expanded row at a time; fetched once per version)
// ---------------------------------------------------------------------------

type DiffState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly diff: VersionDiffSummary };

// ---------------------------------------------------------------------------
// One timeline row
// ---------------------------------------------------------------------------

function VersionRow({
  entry,
  parent,
  isCurrent,
  canRestore,
  canEditLabel,
  canDownload,
  diffState,
  onToggleDiff,
  onRetryDiff,
  onRestore,
  onDownload,
  onSaveLabel,
}: {
  readonly entry: VersionTimelineEntry;
  readonly parent: VersionTimelineEntry | null;
  readonly isCurrent: boolean;
  readonly canRestore: boolean;
  readonly canEditLabel: boolean;
  readonly canDownload: boolean;
  readonly diffState: DiffState | null;
  readonly onToggleDiff: (entry: VersionTimelineEntry) => void;
  readonly onRetryDiff: (entry: VersionTimelineEntry) => void;
  readonly onRestore: (entry: VersionTimelineEntry) => void;
  readonly onDownload: (entry: VersionTimelineEntry) => void;
  readonly onSaveLabel: (next: VersionTimelineEntry) => Promise<unknown>;
}): ReactElement {
  const [labelEdit, setLabelEdit] = useState<LabelEditorState>(LABEL_EDITOR_IDLE);

  const label =
    entry.label !== null && entry.label.trim().length > 0
      ? truncateTimelineString(entry.label, MAX_LABEL_DISPLAY)
      : null;
  const author =
    entry.createdByName !== null ? truncateTimelineString(entry.createdByName, 80) : null;

  const saveLabel = (): void => {
    if (!validTimelineLabel(labelEdit.draft)) return;
    const trimmed = labelEdit.draft.trim();
    setLabelEdit((state) => ({ ...state, saving: true, error: null }));
    void (async () => {
      try {
        await onSaveLabel({ ...entry, label: trimmed });
        setLabelEdit(LABEL_EDITOR_IDLE);
      } catch (cause) {
        const actionError = toActionError(cause);
        setLabelEdit((state) => ({
          ...state,
          saving: false,
          error: boundedErrorText(actionError),
        }));
      }
    })();
  };

  // §9.3 parent linkage: the rail caption names the parent version when it is
  // loaded, and stays honest when pagination has not reached it yet.
  const linkage =
    entry.parentVersionId === null
      ? "First version"
      : parent !== null
        ? `Follows v${parent.version}`
        : "Follows an earlier version";

  return (
    <li
      data-testid="version-row"
      data-version={entry.version}
      data-agent={entry.isAgent ? "true" : "false"}
      data-current={isCurrent ? "true" : "false"}
      className="relative border-l border-border pb-6 pl-5 last:pb-2"
    >
      {/* Timeline node: signal for current, ice for agent, muted otherwise. */}
      <span
        aria-hidden="true"
        data-testid="version-node"
        className={`absolute top-1.5 -left-[5px] h-[9px] w-[9px] rounded-full border border-border ${
          isCurrent ? "bg-signal" : entry.isAgent ? "bg-ice" : "bg-muted"
        }`}
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span
          className="text-body-s font-medium text-primary tabular-nums"
          data-testid="version-number"
        >
          v{entry.version}
        </span>
        {labelEdit.editing ? (
          <span
            className="flex min-w-[240px] flex-1 flex-col gap-1"
            data-testid="version-label-edit"
          >
            <Input
              value={labelEdit.draft}
              onChange={(event) =>
                setLabelEdit((state) => ({ ...state, draft: event.target.value }))
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") saveLabel();
                if (event.key === "Escape") setLabelEdit(LABEL_EDITOR_IDLE);
              }}
              aria-label={`Label for v${entry.version}`}
              placeholder="Version label"
              error={labelEdit.error}
              data-testid="version-label-input"
            />
            <span className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={!validTimelineLabel(labelEdit.draft) || labelEdit.saving}
                loading={labelEdit.saving}
                onClick={saveLabel}
                data-testid="version-label-save"
              >
                Save label
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={labelEdit.saving}
                onClick={() => setLabelEdit(LABEL_EDITOR_IDLE)}
                data-testid="version-label-cancel"
              >
                Cancel
              </Button>
              {!validTimelineLabel(labelEdit.draft) && labelEdit.draft.trim().length > 0 ? (
                <span className="text-caption text-warning" data-testid="version-label-hint">
                  Labels are 1–120 characters.
                </span>
              ) : null}
            </span>
          </span>
        ) : (
          <span
            className="min-w-0 flex-1 truncate text-body text-primary"
            data-testid="version-label"
          >
            {label === null ? <span className="text-muted">Untitled version</span> : label}
          </span>
        )}
        {entry.isAgent ? (
          <Badge variant="ice" data-testid="version-agent-badge">
            <Bot size={11} strokeWidth={2} aria-hidden="true" />
            Agent
          </Badge>
        ) : null}
        {isCurrent ? (
          <Badge variant="success" data-testid="version-current-badge">
            Current
          </Badge>
        ) : null}
      </div>

      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted">
        <span data-testid="version-author">{author === null ? "A member" : author}</span>
        <span aria-hidden="true">·</span>
        <span data-testid="version-created">{formatTimelineTimestamp(entry.createdAt)}</span>
        <span aria-hidden="true">·</span>
        <span className="tabular-nums" data-testid="version-size">
          {formatVersionBytes(entry.sizeBytes)}
        </span>
        <span aria-hidden="true">·</span>
        <span className="tabular text-hint" data-testid="version-sha">
          {entry.sha256Prefix}
        </span>
      </p>

      <p className="mt-1 text-caption text-muted" data-testid="version-linkage">
        {linkage}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onToggleDiff(entry)}
          aria-expanded={diffState !== null}
          data-testid="version-diff-toggle"
        >
          {diffState === null ? "View diff" : "Hide diff"}
        </Button>
        {canRestore ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onRestore(entry)}
            data-testid="version-restore"
          >
            <Undo2 size={14} strokeWidth={1.75} aria-hidden="true" />
            Restore
          </Button>
        ) : null}
        {canDownload && isCurrent ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onDownload(entry)}
            data-testid="version-download"
          >
            <Download size={14} strokeWidth={1.75} aria-hidden="true" />
            Download
          </Button>
        ) : null}
        {canEditLabel && !labelEdit.editing ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setLabelEdit({
                editing: true,
                draft: entry.label ?? "",
                saving: false,
                error: null,
              })
            }
            aria-label={`Edit label for v${entry.version}`}
            data-testid="version-label-edit-button"
          >
            <Pencil size={14} strokeWidth={1.75} aria-hidden="true" />
            Edit label
          </Button>
        ) : null}
      </div>

      {diffState === null ? null : (
        <div
          data-testid="version-diff"
          className="mt-3 rounded-sm border border-border bg-elevated/40 p-4"
        >
          {diffState.status === "loading" ? (
            <div className="flex flex-col gap-2" data-testid="version-diff-loading">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ) : diffState.status === "error" ? (
            <p
              role="alert"
              data-testid="version-diff-error"
              className="flex flex-wrap items-center gap-2 text-caption text-primary"
            >
              <CircleAlert
                size={16}
                strokeWidth={1.75}
                aria-hidden="true"
                className="shrink-0 text-danger"
              />
              <span className="min-w-0 flex-1">{diffState.message}</span>
              <Button
                variant="secondary"
                size="sm"
                data-testid="version-diff-retry"
                onClick={() => onRetryDiff(entry)}
              >
                Try again
              </Button>
            </p>
          ) : diffState.diff.fromParent === null ? (
            <p className="text-body-s text-secondary" data-testid="version-diff-summary">
              {truncateTimelineString(diffState.diff.summary, MAX_META_DISPLAY)}
            </p>
          ) : (
            <>
              <p className="text-body-s text-secondary" data-testid="version-diff-summary">
                {truncateTimelineString(diffState.diff.summary, MAX_META_DISPLAY)}
              </p>
              <dl className="mt-3 grid gap-x-6 gap-y-1 text-caption sm:grid-cols-2">
                <div className="flex justify-between gap-4 sm:block">
                  <dt className="text-muted">Compared with</dt>
                  <dd className="text-secondary" data-testid="version-diff-parent">
                    v{diffState.diff.fromParent.parentVersion}
                  </dd>
                </div>
                <div className="flex justify-between gap-4 sm:block">
                  <dt className="text-muted">Size</dt>
                  <dd className="text-secondary tabular-nums" data-testid="version-diff-size">
                    {formatSizeDeltaBytes(diffState.diff.fromParent.sizeDeltaBytes)}
                  </dd>
                </div>
                <div className="flex justify-between gap-4 sm:block">
                  <dt className="text-muted">Saved</dt>
                  <dd className="text-secondary" data-testid="version-diff-gap">
                    {formatCreatedGap(diffState.diff.fromParent.createdGapMs)}
                  </dd>
                </div>
                <div className="flex justify-between gap-4 sm:block">
                  <dt className="text-muted">Author</dt>
                  <dd className="text-secondary" data-testid="version-diff-author">
                    {diffState.diff.fromParent.authorChanged
                      ? "Changed since the parent"
                      : "Same as the parent"}
                  </dd>
                </div>
              </dl>
            </>
          )}
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// The restore confirmation dialog (§9.3 + §7.5 type-to-confirm)
// ---------------------------------------------------------------------------

function RestoreDialog({
  target,
  busy,
  error,
  onOpenChange,
  onConfirm,
}: {
  readonly target: VersionTimelineEntry | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: (confirmLabel: string) => void;
}): ReactElement | null {
  const [typed, setTyped] = useState("");
  const expected = target === null ? "" : restoreConfirmPhrase(target);
  // EXACT-label gate: the typed confirmation must match the version's label
  // (or its `v{N}` designation) verbatim — trimmed, case-sensitive. A wrong
  // label is rejected here, BEFORE the POST fires (§M7 task 4 confirmation).
  const matches = target !== null && typed.trim() === expected && expected.length > 0;
  const withinBounds = typed.trim().length <= TIMELINE_LABEL_MAX_CHARS;

  // Fresh input whenever a new target opens the dialog.
  useEffect(() => {
    if (target !== null) setTyped("");
  }, [target]);

  if (target === null) return null;

  const label =
    target.label !== null && target.label.trim().length > 0
      ? truncateTimelineString(target.label, MAX_LABEL_DISPLAY)
      : null;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle data-testid="restore-dialog-title">Restore v{target.version}?</DialogTitle>
        <DialogDescription asChild>
          <div data-testid="restore-dialog-description">
            <p>
              {label === null ? (
                "This version has no label. "
              ) : (
                <>
                  Labeled <span className="text-primary">{label}</span>.{" "}
                </>
              )}
              Restoring saves this snapshot as a new version — the version history is never
              rewritten, and nothing is lost.
            </p>
            <p className="mt-2">
              Type <span className="text-primary">{expected}</span> to confirm.
            </p>
          </div>
        </DialogDescription>
        <div className="mt-4">
          <Input
            label={`Type "${expected}" to confirm`}
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            aria-invalid={typed.length > 0 && !matches ? true : undefined}
            data-testid="restore-input"
          />
        </div>
        {error !== null ? (
          <p
            role="alert"
            data-testid="restore-error"
            className="mt-3 flex items-start gap-2 rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-caption text-primary"
          >
            <CircleAlert
              size={16}
              strokeWidth={1.75}
              aria-hidden="true"
              className="mt-0.5 shrink-0 text-danger"
            />
            <span className="min-w-0 flex-1">{error}</span>
          </p>
        ) : null}
        <DialogActions>
          <DialogClose asChild>
            <Button variant="secondary" disabled={busy} data-testid="restore-cancel">
              Cancel
            </Button>
          </DialogClose>
          <Button
            disabled={!matches || !withinBounds}
            loading={busy}
            onClick={() => onConfirm(typed.trim())}
            data-testid="restore-confirm"
          >
            Restore version
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// The timeline
// ---------------------------------------------------------------------------

export interface VersionTimelineProps {
  /** The version row the project currently points at (the "Current" marker). */
  readonly currentVersionId: string | null;
  /** Structurally `client.versions.list(projectId, query)` — timeline pages. */
  readonly fetchPage: VersionPageFetcher;
  /** Structurally `client.versions.diff(projectId, versionId)`. */
  readonly fetchDiff: FetchDiffCaller;
  /**
   * Structurally `client.versions.restore(projectId, versionId, body)`.
   * Absent (or the caller not authorized) → the Restore action is hidden.
   */
  readonly restore?: RestoreVersionCaller;
  /**
   * Structurally `client.versions.label(projectId, versionId, body)`.
   * Absent (or the caller not authorized) → inline label editing is hidden.
   */
  readonly setLabel?: SetVersionLabelCaller;
  /**
   * Download hook. The wire only exposes snapshot bytes for the CURRENT
   * version (the manifest's short-lived signed URL, §9.2) — the host passes
   * this only when that surface exists; the row renders it for the current
   * version only.
   */
  readonly onDownload?: (versionId: string) => void;
  /** Notifies the host that a restore made a new current version (§9.3). */
  readonly onCurrentVersionChange?: (versionId: string) => void;
  /** Deep link to the editor for the empty state's secondary action. */
  readonly editorHref?: string;
  readonly className?: string;
}

export function VersionTimeline({
  currentVersionId,
  fetchPage,
  fetchDiff,
  restore,
  setLabel,
  onDownload,
  onCurrentVersionChange,
  editorHref,
  className,
}: VersionTimelineProps): ReactElement {
  const pages = useVersionPages(fetchPage);
  const [restoreTarget, setRestoreTarget] = useState<VersionTimelineEntry | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [diffFor, setDiffFor] = useState<string | null>(null);
  const [diffStates, setDiffStates] = useState<Record<string, DiffState>>({});

  const byId = useMemo(() => {
    const map = new Map<string, VersionTimelineEntry>();
    for (const entry of pages.entries) map.set(entry.id, entry);
    return map;
  }, [pages.entries]);

  const fetchDiffFor = useCallback(
    (entry: VersionTimelineEntry): void => {
      setDiffStates((current) => ({ ...current, [entry.id]: { status: "loading" } }));
      void (async () => {
        try {
          const diff = await fetchDiff(entry.id);
          setDiffStates((current) => ({ ...current, [entry.id]: { status: "ready", diff } }));
        } catch (cause) {
          setDiffStates((current) => ({
            ...current,
            [entry.id]: { status: "error", message: boundedErrorText(toActionError(cause)) },
          }));
        }
      })();
    },
    [fetchDiff],
  );

  const toggleDiff = useCallback(
    (entry: VersionTimelineEntry): void => {
      if (diffFor === entry.id) {
        setDiffFor(null);
        return;
      }
      setDiffFor(entry.id);
      if (diffStates[entry.id] === undefined) fetchDiffFor(entry);
    },
    [diffFor, diffStates, fetchDiffFor],
  );

  const retryDiff = useCallback(
    (entry: VersionTimelineEntry): void => {
      fetchDiffFor(entry);
    },
    [fetchDiffFor],
  );

  const openRestore = useCallback((entry: VersionTimelineEntry): void => {
    setRestoreTarget(entry);
    setRestoreError(null);
  }, []);

  const closeRestore = useCallback(
    (open: boolean): void => {
      // A restore in flight is never dismissible — the POST must settle.
      if (!open && !restoreBusy) {
        setRestoreTarget(null);
        setRestoreError(null);
      }
    },
    [restoreBusy],
  );

  const confirmRestore = useCallback(
    (confirmLabel: string): void => {
      if (restoreTarget === null || restore === undefined) return;
      const target = restoreTarget;
      setRestoreBusy(true);
      setRestoreError(null);
      void (async () => {
        try {
          // §9.3: the response IS the newly created version; it becomes the
          // project's current version. History is never rewritten.
          const created = await restore(target.id, { confirmLabel });
          setRestoreBusy(false);
          setRestoreTarget(null);
          setRestoreError(null);
          onCurrentVersionChange?.(created.id);
          void pages.reload();
        } catch (cause) {
          setRestoreBusy(false);
          setRestoreError(boundedErrorText(toActionError(cause)));
        }
      })();
    },
    [onCurrentVersionChange, pages, restore, restoreTarget],
  );

  const saveLabel = useCallback(
    (next: VersionTimelineEntry): Promise<unknown> => {
      if (setLabel === undefined) return Promise.resolve();
      return setLabel(next.id, { label: next.label ?? "" }).then((saved) => {
        // The wire returns the updated row (D-24: only the label changes);
        // keep the timeline's display fields, adopt the saved label.
        pages.patchEntry({ ...next, label: saved.label });
        return saved;
      });
    },
    [pages, setLabel],
  );

  const handleDownload = useCallback(
    (entry: VersionTimelineEntry): void => {
      onDownload?.(entry.id);
    },
    [onDownload],
  );

  const canLoadMore = pages.nextCursor !== null;
  const atEnd = !pages.loading && pages.nextCursor === null && pages.entries.length > 0;

  return (
    <section data-testid="version-timeline" className={className} aria-label="Version timeline">
      {pages.error !== null ? (
        <div
          role="alert"
          data-testid="timeline-error"
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
            data-testid="timeline-error-retry"
            disabled={pages.loading}
            onClick={pages.retry}
          >
            Try again
          </Button>
        </div>
      ) : null}

      {pages.loading && pages.entries.length === 0 ? (
        <div className="flex flex-col gap-6 py-2 pl-5" data-testid="timeline-loading">
          <Skeleton className="h-16 w-full max-w-[720px]" />
          <Skeleton className="h-16 w-full max-w-[680px]" />
          <Skeleton className="h-16 w-full max-w-[700px]" />
        </div>
      ) : pages.entries.length === 0 ? (
        <EmptyState
          data-testid="timeline-empty"
          title="No versions yet."
          secondaryLink={
            editorHref === undefined ? undefined : { label: "Open the editor", href: editorHref }
          }
        />
      ) : (
        <ol data-testid="timeline-list" className="ml-2">
          {pages.entries.map((entry) => (
            <VersionRow
              key={entry.id}
              entry={entry}
              parent={
                entry.parentVersionId === null ? null : (byId.get(entry.parentVersionId) ?? null)
              }
              isCurrent={entry.id === currentVersionId}
              canRestore={restore !== undefined}
              canEditLabel={setLabel !== undefined}
              canDownload={onDownload !== undefined}
              diffState={diffFor === entry.id ? (diffStates[entry.id] ?? null) : null}
              onToggleDiff={toggleDiff}
              onRetryDiff={retryDiff}
              onRestore={openRestore}
              onDownload={handleDownload}
              onSaveLabel={saveLabel}
            />
          ))}
        </ol>
      )}

      {canLoadMore || atEnd ? (
        <div className="mt-2 flex items-center justify-center gap-3">
          {canLoadMore ? (
            <Button
              variant="secondary"
              size="sm"
              data-testid="timeline-load-more"
              loading={pages.loadingMore}
              disabled={pages.loading || pages.loadingMore}
              onClick={() => pages.loadMore()}
            >
              Load more
            </Button>
          ) : (
            <p data-testid="timeline-end" className="text-caption text-muted">
              That’s the whole history.
            </p>
          )}
        </div>
      ) : null}

      <RestoreDialog
        target={restoreTarget}
        busy={restoreBusy}
        error={restoreError}
        onOpenChange={closeRestore}
        onConfirm={confirmRestore}
      />
    </section>
  );
}
