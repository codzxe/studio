"use client";

/**
 * RendersHubPanel — the project-hub renders surface (BUILD_PLAN §M8 task 2:
 * "Queue from … project hub; format, resolution, fps, range, quality; credit
 * estimate; progress; download" + "Render history with status, error,
 * credits, expiry"; UI_DESIGN_SYSTEM §8.6: "Renders: queue/history with
 * status, format, duration, credits, download").
 *
 * Mounted as the third tab of the `/w/:slug/history` surface (next to the
 * M7-H Versions/Activity tabs) — the ONE project-page wiring for this
 * surface is `history-view.tsx`'s additive `renders` tab.
 *
 * Wire truth (contracts routes/renders.ts v2 + api-client `client.renders`):
 * - `GET /v1/renders?projectId=…` → newest-first `Page<RenderJob>` (cursor
 *   pagination, the same house query as the activity feed).
 * - `POST /v1/renders/:id/cancel` — cooperative cancel for queued/running
 *   jobs; the response row patches in place (`cancelRequested: true`).
 * - Statuses are the D-11 DB vocabulary: queued | running | completed |
 *   failed | cancelled — "succeeded" is gone from the wire (the api-client
 *   runtime validator rejects it).
 * - `credits` is a whole-credit DISPLAY number (D-12 — µc never crosses the
 *   wire); `progress.percent` is the server-computed integer 0..100.
 * - The version pin: the server snapshots `versionId` at queue time; the row
 *   label resolves the number through `GET /v1/projects/:id/versions` (the
 *   same §M7.4 timeline the Versions tab reads) and degrades to the
 *   neutral "Pinned snapshot" copy when the id is not in the first page.
 *
 * Polling (house pattern — components/presence/use-presence.ts, the M7-B
 * cadence recipe): while ANY loaded row is queued|running and the tab is
 * visible, the first page re-fetches every `RENDERS_POLL_INTERVAL_MS` and
 * MERGES by id (loaded pages are preserved); hidden tabs pause the timer
 * and the Radix TabsContent unmount keeps inactive panels dark. Failures
 * are silent — the last list stays rendered.
 *
 * Hostile-data safety (law #1 spirit): every wire string is bounded before
 * the DOM, ids never render as copy (the comp picker uses the M7-F
 * `Comp <id>` house fallback label), and there is no raw-HTML path.
 */

import { createApiClient, isApiError } from "@studio/api-client";
import type { ApiClient } from "@studio/api-client";
import type {
  EstimateResult,
  Page,
  QueueRenderRequest,
  RenderEstimateRequest,
  RenderFormat,
  RenderJob,
  RenderStatus,
  VersionTimelineEntry,
} from "@studio/contracts";
import { Badge, Button, EmptyState, Skeleton } from "@studio/ui";
import { CircleAlert, Download, Film, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";

import {
  formatTimelineTimestamp,
  formatVersionBytes,
  truncateTimelineString,
} from "@/components/versions/version-timeline";
import { QueueRenderCard, formatRenderCredits } from "./queue-render-card";

// ---------------------------------------------------------------------------
// Copy tables (D-2 formats, D-11 statuses, D-12 credits)
// ---------------------------------------------------------------------------

/** §14 display bound for any wire-derived string rendered here. */
const MAX_RENDER_TEXT = 200;

/** Format badge labels (D-2: MP4 + PNG sequence are the enabled two). */
export const RENDER_FORMAT_LABELS: Readonly<Record<RenderFormat, string>> = {
  mp4: "MP4",
  prores: "ProRes",
  "png-seq": "PNG sequence",
  gif: "GIF",
  wav: "WAV",
};

/**
 * Status chips — the D-11 vocabulary, verbatim meaning, sentence-cased labels
 * (§7.12): queued/running/completed/failed/cancelled. The badge tone carries
 * NO meaning on its own (§3.1): the label always names the state.
 */
export const RENDER_STATUS_CHIPS: Readonly<
  Record<
    RenderStatus,
    {
      readonly label: string;
      readonly tone: "neutral" | "signal" | "success" | "warning" | "danger";
    }
  >
> = {
  queued: { label: "Queued", tone: "warning" },
  running: { label: "Rendering", tone: "signal" },
  completed: { label: "Completed", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

/** Is this row still moving (progress + cancel surfaces + polling)? */
export function isActiveRender(job: RenderJob): boolean {
  return job.status === "queued" || job.status === "running";
}

/** UTC day label for expiry copy: "Nov 9, 2026" (§14, deterministic). */
const DAY_FORMAT = new Intl.DateTimeFormat("en-US", {
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

export type RenderExpiryState = "none" | "until" | "expired" | "unknown";

export interface RenderExpiryLabel {
  readonly state: RenderExpiryState;
  /** Ready-to-render copy; null for the none/unknown shapes. */
  readonly text: string | null;
}

/**
 * Expiry copy against the RSC-stamped `nowIso` (deterministic per page load,
 * the activity-feed house pattern): "Available until Nov 9, 2026" while the
 * signed download window is open, "Expired — the download window has
 * closed." once it is past. Null/invalid expiresAt degrade honestly.
 */
export function renderExpiryLabel(expiresAt: string | null, nowIso: string): RenderExpiryLabel {
  if (expiresAt === null) return { state: "none", text: null };
  const expires = parseInstant(expiresAt);
  const now = parseInstant(nowIso);
  if (expires === null || now === null) return { state: "unknown", text: null };
  if (expires.getTime() <= now.getTime()) {
    return { state: "expired", text: "Expired — the download window has closed." };
  }
  return { state: "until", text: `Available until ${DAY_FORMAT.format(expires)}` };
}

/**
 * Friendly explanation for the stable machine `errorCode` on failed rows
 * (the §7.3-safe human `error` message renders beside it; the code is
 * copy-mapped, never echoed as UI copy). Unknown codes → null (the server
 * message alone stays).
 */
export function renderErrorCodeCopy(code: string | null): string | null {
  switch (code) {
    case "RENDER_TIMEOUT":
      return "The render ran past its time budget and was stopped.";
    case "RENDER_ASSET_MISSING":
      return "An asset this composition needs could not be found.";
    case "RENDER_CLI_FAILED":
    case "RENDER_CLI_MISSING":
      return "The render engine could not run this job.";
    case "RENDER_CANCELLED":
      return "The render was cancelled before it finished.";
    case "RENDER_QUOTA_EXCEEDED":
      return "This render is past the plan's monthly render minutes.";
    case "RENDER_INTERNAL":
      return "Something went wrong on our side while rendering.";
    default:
      return null;
  }
}

/** True when the row can still be downloaded (completed + signed + live). */
export function canDownloadRender(job: RenderJob, nowIso: string): boolean {
  if (job.status !== "completed" || typeof job.resultUrl !== "string") return false;
  return renderExpiryLabel(job.expiresAt, nowIso).state !== "expired";
}

// ---------------------------------------------------------------------------
// The api seam — a narrow port the real ApiClient satisfies structurally
// ---------------------------------------------------------------------------

/**
 * The renders-hub `@studio/api-client` surface. Production builds it from
 * `createApiClient` (same-origin `/v1` + `x-workspace-id`); tests fake it —
 * the exact M7-H HistoryPort doctrine.
 */
export interface RendersHubPort {
  /** GET /v1/renders?projectId=… — this project's history (cursor pages). */
  readonly listRenders: (query: {
    readonly cursor?: string;
    readonly limit?: number;
  }) => Promise<Page<RenderJob>>;
  /** POST /v1/renders — queue (a fresh idempotencyKey rides the body). */
  readonly queueRender: (body: QueueRenderRequest) => Promise<RenderJob>;
  /** POST /v1/renders/:id/cancel — cooperative cancel. */
  readonly cancelRender: (id: string) => Promise<RenderJob>;
  /** POST /v1/renders/estimate — the pre-flight quote (a pure read). */
  readonly estimateRender: (body: RenderEstimateRequest) => Promise<EstimateResult>;
  /**
   * GET /v1/projects/:id/versions — resolves the pinned `versionId` to a
   * human "v{N}" label (the §M7.4 timeline the Versions tab already reads).
   */
  readonly listVersions: (query: { readonly limit?: number }) => Promise<
    Page<VersionTimelineEntry>
  >;
}

/** Same-origin API root (Caddy fronts `/v1` in production — README §Env). */
const API_BASE_URL = "/v1";

/** How many versions to scan for pin labels (§7.2 pages are 50 rows). */
const VERSION_LABEL_LIMIT = 50;

/** Builds the production port for one project hub load. */
export function createRendersHubPort(workspaceId: string, projectId: string): RendersHubPort {
  const client: ApiClient = createApiClient({
    baseUrl: API_BASE_URL,
    headers: { "x-workspace-id": workspaceId },
  });
  return {
    listRenders: (query) => client.renders.list({ projectId, ...query }),
    queueRender: (body) => client.renders.create(body),
    cancelRender: (id) => client.renders.cancel(id),
    estimateRender: (body) => client.renders.estimate(body),
    listVersions: (query) => client.versions.list(projectId, query),
  };
}

// ---------------------------------------------------------------------------
// Action failures (§7.3 shape; §14: message + hint + request id)
// ---------------------------------------------------------------------------

export interface RendersActionError {
  readonly message: string;
  readonly hint?: string;
  readonly requestId?: string;
}

function toActionError(cause: unknown): RendersActionError {
  if (isApiError(cause)) {
    return { message: cause.message, hint: cause.hint, requestId: cause.requestId };
  }
  return { message: "Something went wrong on our side.", hint: "Try again in a moment." };
}

function errorLine(error: RendersActionError): string {
  const message = truncateTimelineString(error.message, MAX_RENDER_TEXT);
  return error.requestId === undefined ? message : `${message} (${error.requestId})`;
}

function fetchErrorMessage(cause: unknown): string {
  if (isApiError(cause)) return truncateTimelineString(cause.message, MAX_RENDER_TEXT);
  return "The render history could not be loaded.";
}

// ---------------------------------------------------------------------------
// useRendersPages — race-guarded cursor pagination + the poller merge
// ---------------------------------------------------------------------------

export type RendersPageFetcher = RendersHubPort["listRenders"];

export interface RendersPagesState {
  readonly entries: readonly RenderJob[];
  readonly nextCursor: string | null;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly error: string | null;
  readonly loadMore: () => void;
  readonly retry: () => void;
  readonly reload: () => void;
  /** Replaces one loaded row by id (cancel responses; no refetch needed). */
  readonly patchEntry: (next: RenderJob) => void;
  /**
   * Polling refresh: re-fetches the FIRST page and merges by id (rows in
   * place, unseen rows prepended, loaded pages preserved). Silent on
   * failure — the last list stays rendered.
   */
  readonly mergeFirstPage: () => Promise<void>;
}

export function useRendersPages(
  fetchPage: RendersPageFetcher,
  options?: { readonly pageSize?: number },
): RendersPagesState {
  const pageSize = options?.pageSize ?? 25;

  const [entries, setEntries] = useState<readonly RenderJob[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seq = useRef(0);
  const inFlight = useRef(false);
  const mergeInFlight = useRef(false);
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

  const patchEntry = useCallback((next: RenderJob): void => {
    setEntries((current) => current.map((row) => (row.id === next.id ? next : row)));
  }, []);

  const mergeFirstPage = useCallback(async (): Promise<void> => {
    if (mergeInFlight.current) return;
    mergeInFlight.current = true;
    try {
      const result = await fetchRef.current({ limit: pageSize });
      setEntries((current) => {
        const next = [...current];
        const indexById = new Map(next.map((row, index) => [row.id, index] as const));
        const unseen: RenderJob[] = [];
        let changed = false;
        for (const row of result.items) {
          const at = indexById.get(row.id);
          if (at === undefined) {
            unseen.push(row);
          } else if (next[at] !== row) {
            next[at] = row;
            changed = true;
          }
        }
        if (unseen.length === 0) return changed ? next : current;
        return [...unseen, ...next];
      });
    } catch {
      /* Poll failures are silent (the presence poller posture): the last
       * list stays rendered and the next tick retries. */
    } finally {
      mergeInFlight.current = false;
    }
  }, [pageSize]);

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
    mergeFirstPage,
  };
}

// ---------------------------------------------------------------------------
// useRendersPolling — the active-row refresh (presence-cadence recipe)
// ---------------------------------------------------------------------------

/** UI refresh cadence while renders are active (not the worker's poll). */
export const RENDERS_POLL_INTERVAL_MS = 5_000;

/**
 * Re-fetches the first page on an interval WHILE `enabled` (any loaded row
 * queued|running for this project) and the tab is visible. Mirrors the M7-B
 * presence cadence recipe: `visibilitychange` → hidden PAUSES the timer;
 * → visible ticks IMMEDIATELY, then resumes; an in-flight guard collapses
 * overlapping ticks; unmount cancels. Never global — the enabled flag is
 * per-project and the Radix TabsContent unmounts inactive panels.
 */
export function useRendersPolling(options: {
  readonly enabled: boolean;
  readonly intervalMs?: number;
  readonly refresh: () => Promise<void>;
}): void {
  const enabled = options.enabled;
  const intervalMs = options.intervalMs ?? RENDERS_POLL_INTERVAL_MS;
  const refreshRef = useRef(options.refresh);
  refreshRef.current = options.refresh;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = async (): Promise<void> => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        await refreshRef.current();
      } finally {
        inFlight = false;
      }
    };

    const start = (): void => {
      if (timer !== null) return; // already ticking
      void tick();
      timer = setInterval(() => void tick(), intervalMs);
    };
    const stop = (): void => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    if (document.visibilityState === "visible") start();

    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") stop();
      else start();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, intervalMs]);
}

// ---------------------------------------------------------------------------
// One history row
// ---------------------------------------------------------------------------

const PROGRESS_FILL_BY_TONE = {
  neutral: "bg-muted",
  signal: "bg-signal",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  ice: "bg-ice",
} as const;

function RendersRow({
  job,
  nowIso,
  versionLabel,
  canQueue,
  cancelBusy,
  onDownload,
  onCancel,
}: {
  readonly job: RenderJob;
  readonly nowIso: string;
  readonly versionLabel: string;
  readonly canQueue: boolean;
  readonly cancelBusy: boolean;
  readonly onDownload: (job: RenderJob) => void;
  readonly onCancel: (job: RenderJob) => void;
}): ReactElement {
  const chip = RENDER_STATUS_CHIPS[job.status];
  const expiry = renderExpiryLabel(job.expiresAt, nowIso);
  const active = isActiveRender(job);
  const downloadable = canDownloadRender(job, nowIso);
  const codeCopy = renderErrorCodeCopy(job.errorCode);

  return (
    <li
      data-testid={`renders-hub-row-${job.id}`}
      data-status={job.status}
      className="flex flex-col gap-2 py-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant={chip.tone}
          data-testid={`renders-hub-row-${job.id}-status`}
          data-status={job.status}
        >
          {chip.label}
        </Badge>
        <Badge variant="neutral" data-testid={`renders-hub-row-${job.id}-format`}>
          <Film size={11} strokeWidth={2} aria-hidden="true" />
          {RENDER_FORMAT_LABELS[job.format]}
        </Badge>
        <span
          className="tabular-nums text-caption text-secondary"
          data-testid={`renders-hub-row-${job.id}-credits`}
        >
          {formatRenderCredits(job.credits)} credits
        </span>
        <time
          className="ml-auto text-caption text-muted"
          dateTime={parseInstant(job.createdAt) === null ? undefined : job.createdAt}
          data-testid={`renders-hub-row-${job.id}-created`}
        >
          {formatTimelineTimestamp(job.createdAt)}
        </time>
      </div>

      {active ? (
        <div className="flex flex-col gap-1" data-testid={`renders-hub-row-${job.id}-progress`}>
          <div
            role="progressbar"
            tabIndex={-1}
            aria-label="Render progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={job.progress.percent}
            data-percent={job.progress.percent}
            className="h-1.5 w-full max-w-[420px] overflow-hidden rounded-xs bg-elevated"
          >
            <div
              aria-hidden="true"
              className={PROGRESS_FILL_BY_TONE[chip.tone]}
              style={{ width: `${Math.min(100, Math.max(0, job.progress.percent))}%` }}
            />
          </div>
          <p className="tabular-nums text-caption text-muted">
            {job.progress.framesTotal === 0
              ? job.status === "queued"
                ? "Waiting in the queue…"
                : "Preparing frames…"
              : `${job.progress.framesDone} of ${job.progress.framesTotal} frames · ${job.progress.percent}%`}
          </p>
        </div>
      ) : null}

      {job.status === "failed" ? (
        <p
          role="alert"
          data-testid={`renders-hub-row-${job.id}-error`}
          className="flex flex-col gap-0.5 rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-caption text-primary"
        >
          {job.error !== null && job.error.length > 0 ? (
            <span>{truncateTimelineString(job.error, MAX_RENDER_TEXT)}</span>
          ) : null}
          {codeCopy !== null ? <span className="text-muted">{codeCopy}</span> : null}
          {job.error === null && codeCopy === null ? (
            <span className="text-muted">
              This render failed. Queue it again when you're ready.
            </span>
          ) : null}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-caption text-muted" data-testid={`renders-hub-row-${job.id}-version`}>
          {versionLabel}
        </span>
        {expiry.text !== null ? (
          <span
            className="text-caption text-muted"
            data-state={expiry.state}
            data-testid={`renders-hub-row-${job.id}-expires`}
          >
            {expiry.text}
          </span>
        ) : null}
        {job.sizeBytes !== null ? (
          <span
            className="tabular-nums text-caption text-muted"
            data-testid={`renders-hub-row-${job.id}-size`}
          >
            {formatVersionBytes(job.sizeBytes)}
          </span>
        ) : null}
        {job.cancelRequested && active ? (
          <span
            className="text-caption text-muted"
            data-testid={`renders-hub-row-${job.id}-cancelling`}
          >
            Cancelling…
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {downloadable ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onDownload(job)}
            data-testid={`renders-hub-row-${job.id}-download`}
          >
            <Download size={14} strokeWidth={1.75} aria-hidden="true" />
            Download
          </Button>
        ) : null}
        {canQueue && active ? (
          <Button
            variant="ghost"
            size="sm"
            loading={cancelBusy}
            disabled={cancelBusy || job.cancelRequested}
            onClick={() => onCancel(job)}
            data-testid={`renders-hub-row-${job.id}-cancel`}
          >
            <XCircle size={14} strokeWidth={1.75} aria-hidden="true" />
            Cancel
          </Button>
        ) : null}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/** One renderable composition for the queue card's picker. */
export interface HubCompOption {
  readonly id: string;
  readonly name: string;
}

export interface RendersHubPanelProps {
  readonly projectId: string;
  readonly workspaceId: string;
  /** Editor+ roles queue renders (the gateway re-checks; viewer+ reads). */
  readonly canQueue: boolean;
  /** ISO instant stamped by the RSC — pins the expiry math (deterministic). */
  readonly nowIso: string;
  /** Deep link to the editor (empty-state + queue-card fallbacks). */
  readonly editorHref: string;
  /** Host-known compositions (id + display name); history rows add more. */
  readonly comps?: readonly HubCompOption[];
  /** Injectable port (tests). Production leaves it undefined. */
  readonly api?: RendersHubPort;
  /** URL opener seam for completed downloads (tests spy it). */
  readonly openUrl?: (url: string) => void;
  /** Poll cadence override while renders are active (tests). */
  readonly pollIntervalMs?: number;
}

export function RendersHubPanel({
  projectId,
  workspaceId,
  canQueue,
  nowIso,
  editorHref,
  comps,
  api,
  openUrl,
  pollIntervalMs,
}: RendersHubPanelProps): ReactElement {
  const port = api ?? createRendersHubPort(workspaceId, projectId);
  const open = openUrl ?? ((url: string) => window.open(url, "_blank", "noopener,noreferrer"));

  const pages = useRendersPages(port.listRenders);
  const [cancelBusyId, setCancelBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<RendersActionError | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [versionNumbers, setVersionNumbers] = useState<ReadonlyMap<string, number> | null>(null);

  // Version pin labels: resolve the server-pinned versionId to a human
  // "v{N}" through the §M7.4 timeline; any failure degrades silently to the
  // neutral "Pinned snapshot" copy (labels never block the list).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const page = await port.listVersions({ limit: VERSION_LABEL_LIMIT });
        if (cancelled) return;
        const map = new Map<string, number>();
        for (const entry of page.items) map.set(entry.id, entry.version);
        setVersionNumbers(map);
      } catch {
        /* degrade to the neutral pin copy */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [port]);

  // Poll only while THIS project has queued/running rows (never global).
  useRendersPolling({
    enabled: pages.entries.some(isActiveRender),
    intervalMs: pollIntervalMs,
    refresh: pages.mergeFirstPage,
  });

  const runCancel = useCallback(
    (job: RenderJob): void => {
      setCancelBusyId(job.id);
      setActionError(null);
      void (async () => {
        try {
          const next = await port.cancelRender(job.id);
          pages.patchEntry(next);
        } catch (cause) {
          setActionError(toActionError(cause));
        } finally {
          setCancelBusyId(null);
        }
      })();
    },
    [pages, port],
  );

  const runDownload = useCallback(
    (job: RenderJob): void => {
      setDownloadError(null);
      const url = job.resultUrl;
      if (typeof url !== "string" || !(url.startsWith("http://") || url.startsWith("https://"))) {
        setDownloadError("The download link could not be opened.");
        return;
      }
      open(url);
    },
    [open],
  );

  // Queue-card options: host-known comps first, then every comp this project
  // has already rendered (the M7-F `Comp <id>` house fallback — compId is
  // engine data, never a secret, never raw UI copy).
  const compOptions = useMemo(() => {
    const byId = new Map<string, HubCompOption>();
    for (const comp of comps ?? []) byId.set(comp.id, comp);
    for (const job of pages.entries) {
      if (!byId.has(job.compId))
        byId.set(job.compId, { id: job.compId, name: `Comp ${job.compId}` });
    }
    return [...byId.values()];
  }, [comps, pages.entries]);

  const canLoadMore = pages.nextCursor !== null;
  const atEnd = !pages.loading && pages.nextCursor === null && pages.entries.length > 0;

  return (
    <section
      data-testid="renders-hub-panel"
      aria-label="Project renders"
      className="flex flex-col gap-4"
    >
      {canQueue ? (
        <QueueRenderCard
          projectId={projectId}
          comps={compOptions}
          editorHref={editorHref}
          api={port}
          onQueued={() => void pages.reload()}
        />
      ) : (
        <p
          data-testid="renders-hub-queue-readonly"
          className="rounded-sm border border-border bg-elevated/40 px-3 py-2 text-caption text-secondary"
        >
          You need edit access to queue renders. Everyone can watch the history below.
        </p>
      )}

      <p className="text-caption text-muted" data-testid="renders-hub-list-note">
        Every final output queued for this project, newest first.
      </p>

      {pages.error !== null ? (
        <div
          role="alert"
          data-testid="renders-hub-error"
          className="flex items-center gap-2 rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-caption text-primary"
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
            data-testid="renders-hub-error-retry"
            disabled={pages.loading}
            onClick={pages.retry}
          >
            Try again
          </Button>
        </div>
      ) : null}

      {actionError !== null ? (
        <div
          role="alert"
          data-testid="renders-hub-action-error"
          className="flex items-start gap-2 rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-caption text-primary"
        >
          <CircleAlert
            size={16}
            strokeWidth={1.75}
            aria-hidden="true"
            className="mt-0.5 shrink-0 text-danger"
          />
          <span className="min-w-0 flex-1">
            {errorLine(actionError)}
            {actionError.hint === undefined ? null : (
              <span className="block text-muted">
                {truncateTimelineString(actionError.hint, MAX_RENDER_TEXT)}
              </span>
            )}
          </span>
        </div>
      ) : null}

      {downloadError !== null ? (
        <p
          role="alert"
          data-testid="renders-hub-download-error"
          className="flex items-center gap-2 rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-caption text-primary"
        >
          <CircleAlert
            size={16}
            strokeWidth={1.75}
            aria-hidden="true"
            className="shrink-0 text-danger"
          />
          {downloadError}
        </p>
      ) : null}

      {pages.loading && pages.entries.length === 0 ? (
        <div className="flex flex-col gap-3 py-2" data-testid="renders-hub-loading">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-6 w-full max-w-[560px]" />
          <Skeleton className="h-6 w-full max-w-[520px]" />
          <Skeleton className="h-6 w-full max-w-[540px]" />
        </div>
      ) : pages.entries.length === 0 ? (
        <EmptyState
          data-testid="renders-hub-empty"
          title="No renders yet."
          secondaryLink={{ label: "Open the editor", href: editorHref }}
        />
      ) : (
        <ol
          data-testid="renders-hub-list"
          className="divide-y divide-border/60"
          aria-label="Render history"
        >
          {pages.entries.map((job) => (
            <RendersRow
              key={job.id}
              job={job}
              nowIso={nowIso}
              versionLabel={versionLabelFor(versionNumbers, job.versionId)}
              canQueue={canQueue}
              cancelBusy={cancelBusyId === job.id}
              onDownload={runDownload}
              onCancel={runCancel}
            />
          ))}
        </ol>
      )}

      {canLoadMore || atEnd ? (
        <div className="flex items-center justify-center gap-3">
          {canLoadMore ? (
            <Button
              variant="secondary"
              size="sm"
              data-testid="renders-hub-load-more"
              loading={pages.loadingMore}
              disabled={pages.loading || pages.loadingMore}
              onClick={() => pages.loadMore()}
            >
              Load more
            </Button>
          ) : (
            <p data-testid="renders-hub-end" className="text-caption text-muted">
              That’s every render so far.
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}

/** "Snapshot v{N}" once the timeline resolves the pin; neutral otherwise. */
function versionLabelFor(
  versionNumbers: ReadonlyMap<string, number> | null,
  versionId: string,
): string {
  const number = versionNumbers?.get(versionId);
  return number === undefined ? "Pinned snapshot" : `Snapshot v${number}`;
}
