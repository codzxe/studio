"use client";

/**
 * `RenderHistoryDrawer` — the render history slide-over (BUILD_PLAN §M8 task 2
 * "render history with status, error, credits, expiry"; UI_DESIGN_SYSTEM §8.7
 * slide-over chrome; DECISIONS D-11/D-18).
 *
 * Chrome law (D-18, the CommentsPanel precedent): a document-level portal
 * (`document.body`) so the drawer escapes the chat panel's own box — a fixed
 * right-rail panel over the editor, tokens only, pointer-events isolated.
 * The editor iframe is never restyled, never blocked: polling is background
 * async and the editor keeps working while renders run (BP §M8 task 3).
 *
 * Polling lifecycle (the M7-G `use-presence` visibility recipe):
 * - ACTIVE rows (queued/running, D-11 vocabulary) poll `client.renders.get`
 *   every `pollIntervalMs` (default 3 s);
 * - the poller runs ONLY while the drawer is open OR an active render exists
 *   — nothing ticks on an idle editor page;
 * - `visibilitychange` hidden PAUSES the timer, visible resumes with an
 *   immediate beat (never a fake-fresh row);
 * - a job flipping terminal stops its polling (the active set shrank);
 *   closing the drawer with nothing active stops everything.
 *
 * Rows: progress bar (the server-computed `progress.percent` — never
 * re-derived), frames done/total, cancel on queued/running (cooperative —
 * `cancelRequested` shows the honest "Cancelling…" state), download on
 * completed (signed URL, sizeBytes + humanized expiry), typed errorCode copy
 * on failed, D-11 labels everywhere.
 */

import { RENDER_FORMATS } from "@studio/config";
import type { RenderJob } from "@studio/contracts";
import { Badge, Button } from "@studio/ui";
import { AlertTriangle, Clapperboard, Download, History, X } from "lucide-react";
import {
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { formatCreditsDisplay } from "./render-options";
import {
  formatAvailableUntil,
  formatBytes,
  formatFrames,
  formatWhen,
  isRenderActive,
  renderErrorCodeLabel,
  renderErrorCopy,
  renderStatusLabel,
} from "./render-status";
import type { RenderClient } from "./types";

/** Default ACTIVE-render poll cadence (BP §M8 task 2 "progress"; tests tighten). */
export const RENDER_POLL_INTERVAL_MS = 3_000;

const GENERIC_ERROR = "That didn’t work. Try again in a moment.";

export interface RenderHistoryDrawerProps {
  /** The drawer stays MOUNTED while closed so active renders keep polling. */
  readonly open: boolean;
  readonly onClose: () => void;
  /** Null while the region's scope resolves — the drawer idles (no calls). */
  readonly client: RenderClient | null;
  readonly projectId: string | null;
  /** ACTIVE-render poll cadence override (tests). */
  readonly pollIntervalMs?: number;
  /** Reports the ACTIVE render count (the header toggle badge). */
  readonly onActiveChange?: (count: number) => void;
  /** "New render" affordance → the region opens the queue dialog. */
  readonly onOpenRender?: () => void;
  /** Project display name for the header chip; absent → no chip. */
  readonly projectName?: string | null;
}

function failureMessage(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : GENERIC_ERROR;
}

/** Honest label for any historical format id (config labels; unknown → prettified id). */
function formatLabel(format: string): string {
  const known = RENDER_FORMATS.find((entry) => entry.id === format);
  if (known !== undefined) return known.label;
  return format;
}

/** Badge variant per D-11 status (the label text is always present — never colour-only). */
const STATUS_BADGE: Readonly<
  Record<RenderJob["status"], "neutral" | "signal" | "success" | "danger" | "warning">
> = {
  queued: "neutral",
  running: "signal",
  completed: "success",
  failed: "danger",
  cancelled: "warning",
};

/** One progress track: the server's percent (integer 0..100), never re-derived. */
function RenderProgress({ job }: { readonly job: RenderJob }): ReactElement {
  return (
    <div data-testid={`render-row-${job.id}-progress`} className="flex items-center gap-2">
      <div
        role="progressbar"
        tabIndex={-1}
        aria-label="Render progress"
        aria-valuenow={job.progress.percent}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-pill bg-input"
      >
        <div
          className="h-full rounded-pill bg-signal transition-[width] duration-300 ease-out"
          style={{ width: `${job.progress.percent}%` }}
        />
      </div>
      <span className="shrink-0 text-hint whitespace-nowrap text-muted">
        {job.progress.percent}% · {formatFrames(job.progress)}
      </span>
    </div>
  );
}

export function RenderHistoryDrawer({
  open,
  onClose,
  client,
  projectId,
  pollIntervalMs = RENDER_POLL_INTERVAL_MS,
  onActiveChange,
  onOpenRender,
  projectName = null,
}: RenderHistoryDrawerProps): ReactElement {
  const [rows, setRows] = useState<readonly RenderJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Readonly<Record<string, string>>>({});

  const generationRef = useRef(0);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const activeCount = useMemo(
    () => rows.filter((job) => isRenderActive(job.status)).length,
    [rows],
  );
  const hasActive = activeCount > 0;

  // Report the active count to the region (the header toggle's badge).
  useEffect(() => {
    onActiveChange?.(activeCount);
  }, [activeCount, onActiveChange]);

  // -- list (fresh on every open; generation-guarded against stale writes) ----
  const refresh = useCallback(async (): Promise<void> => {
    if (client === null || projectId === null) return;
    const generation = ++generationRef.current;
    setLoading(true);
    setListError(null);
    try {
      const page = await client.renders.list({ projectId });
      if (generationRef.current !== generation) return;
      setRows(page.items);
      setLoadedOnce(true);
    } catch (error) {
      if (generationRef.current !== generation) return;
      setRows([]);
      setListError(failureMessage(error));
    } finally {
      if (generationRef.current === generation) setLoading(false);
    }
  }, [client, projectId]);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  // -- ACTIVE-render poller (presence visibility recipe) -----------------------
  // Runs while (open || hasActive) && document visible; per-row get() replaces
  // the matching row. A generation counter keeps stale writes out.

  useEffect(() => {
    if (client === null) return; // dormant until the region resolves its scope
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let inFlight = false;
    const pollGenerationRef = { current: 0 };

    const poll = async (): Promise<void> => {
      if (cancelled || inFlight) return;
      const activeIds = rowsRef.current
        .filter((job) => isRenderActive(job.status))
        .map((job) => job.id);
      if (activeIds.length === 0) return;
      inFlight = true;
      const generation = ++pollGenerationRef.current;
      try {
        const updates = await Promise.all(
          activeIds.map((id) => client.renders.get(id).catch(() => null)),
        );
        if (cancelled || pollGenerationRef.current !== generation) return;
        setRows((current) =>
          current.map((row) => {
            if (!isRenderActive(row.status)) return row;
            const update = updates.find((entry) => entry !== null && entry.id === row.id);
            return update ?? row;
          }),
        );
      } finally {
        inFlight = false;
      }
    };

    const start = (): void => {
      if (timer !== null) return;
      void poll();
      timer = setInterval(() => void poll(), pollIntervalMs);
    };
    const stop = (): void => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const shouldRun = (): boolean => open || hasActive;

    if (document.visibilityState === "visible" && shouldRun()) start();

    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") stop();
      else if (shouldRun()) start();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [client, pollIntervalMs, open, hasActive]);

  // -- cancel (cooperative: the server flags cancelRequested, the job lands cancelled) --
  const cancel = useCallback(
    (job: RenderJob): void => {
      if (client === null) return;
      setCancelling((current) => new Set(current).add(job.id));
      setRowErrors((current) => {
        const next = { ...current };
        delete next[job.id];
        return next;
      });
      void client.renders.cancel(job.id, {}).then(
        (updated) => {
          setCancelling((current) => {
            const next = new Set(current);
            next.delete(job.id);
            return next;
          });
          setRows((current) => current.map((row) => (row.id === updated.id ? updated : row)));
        },
        () => {
          setCancelling((current) => {
            const next = new Set(current);
            next.delete(job.id);
            return next;
          });
          setRowErrors((current) => ({
            ...current,
            [job.id]: "Could not request the cancellation. Try again in a moment.",
          }));
        },
      );
    },
    [client],
  );

  // -- Esc dismissal (the §9 topmost-layer-first order: this drawer, not the chat) --
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  const drawer = open ? (
    <div data-testid="render-history-layer" className="pointer-events-none fixed inset-0 z-[36]">
      {/* The layer root swallows no editor clicks; the rail re-enables its own subtree. */}
      <aside
        aria-label="Render history"
        data-testid="render-history-drawer"
        data-open={open}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="pointer-events-auto absolute top-0 right-0 bottom-0 flex w-[380px] max-w-full flex-col overflow-hidden border-l border-border bg-panel shadow-modal"
      >
        <header
          data-testid="render-history-header"
          className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-panel px-3"
        >
          <History
            size={15}
            strokeWidth={1.75}
            aria-hidden="true"
            className="shrink-0 text-secondary"
          />
          <span data-testid="render-history-title" className="shrink-0 font-medium text-primary">
            Render history
          </span>
          {projectName !== null && projectName !== "" ? (
            <span className="min-w-0 flex-1 truncate text-caption text-muted" title={projectName}>
              {projectName}
            </span>
          ) : (
            <div aria-hidden="true" className="min-w-0 flex-1" />
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 shrink-0 p-0 text-secondary hover:text-primary"
            aria-label="Close render history"
            data-testid="render-history-close"
            onClick={onClose}
          >
            <X size={15} strokeWidth={1.75} aria-hidden="true" />
          </Button>
        </header>

        {/* List body. */}
        <div
          data-testid="render-history-list"
          className="min-h-0 flex-1 overflow-y-auto px-2 py-2 scrollbar-thin"
        >
          {loading && rows.length === 0 ? (
            <p
              data-testid="render-history-loading"
              className="px-1 py-6 text-center text-caption text-muted"
            >
              Loading renders…
            </p>
          ) : listError !== null ? (
            <div data-testid="render-history-error" className="px-1 py-6 text-center">
              <p className="text-caption text-primary">{listError}</p>
              <Button
                variant="secondary"
                size="sm"
                data-testid="render-history-retry"
                className="mt-3"
                onClick={() => void refresh()}
              >
                Try again
              </Button>
            </div>
          ) : client === null || projectId === null ? (
            <p
              data-testid="render-history-scope"
              className="px-1 py-6 text-center text-caption text-muted"
            >
              Resolving the project…
            </p>
          ) : rows.length === 0 ? (
            <div data-testid="render-history-empty" className="px-1 py-6 text-center">
              <p className="text-caption text-secondary">No renders yet.</p>
              {onOpenRender !== undefined ? (
                <Button
                  variant="secondary"
                  size="sm"
                  data-testid="render-history-new"
                  className="mt-3"
                  onClick={onOpenRender}
                >
                  <Clapperboard size={14} strokeWidth={1.75} aria-hidden="true" />
                  New render
                </Button>
              ) : null}
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {rows.map((job) => (
                <li
                  key={job.id}
                  data-testid={`render-row-${job.id}`}
                  data-status={job.status}
                  className="rounded-sm border border-border bg-app px-2.5 py-2"
                >
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={STATUS_BADGE[job.status]}
                      data-testid={`render-row-${job.id}-status`}
                    >
                      {renderStatusLabel(job.status)}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate text-body-s text-primary">
                      {formatLabel(job.format)}
                    </span>
                    {job.credits !== null ? (
                      <span
                        className="shrink-0 text-hint text-muted"
                        data-testid={`render-row-${job.id}-credits`}
                      >
                        {formatCreditsDisplay(job.credits)}
                      </span>
                    ) : null}
                  </div>

                  <p className="mt-1 truncate text-caption text-secondary" title={job.compId}>
                    {job.compId}
                  </p>

                  {isRenderActive(job.status) ? (
                    <div className="mt-2">
                      <RenderProgress job={job} />
                    </div>
                  ) : null}

                  {job.status === "failed" ? (
                    <div
                      data-testid={`render-row-${job.id}-error`}
                      className="mt-2 flex items-start gap-1.5 rounded-sm border border-danger/40 bg-danger/10 px-2 py-1.5"
                    >
                      <AlertTriangle
                        size={13}
                        strokeWidth={1.75}
                        aria-hidden="true"
                        className="mt-0.5 shrink-0 text-danger"
                      />
                      <p className="min-w-0 flex-1 text-hint text-primary">
                        {renderErrorCopy(job)}
                        {renderErrorCodeLabel(job) !== null ? (
                          <span className="text-muted"> ({renderErrorCodeLabel(job)})</span>
                        ) : null}
                      </p>
                    </div>
                  ) : null}

                  {job.status === "completed" && job.resultUrl !== null ? (
                    <div className="mt-2 flex items-center gap-2">
                      <a
                        data-testid={`render-row-${job.id}-download`}
                        href={job.resultUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-border bg-elevated px-2 text-body-s text-primary transition-colors duration-120 hover:border-border-strong hover:bg-input"
                      >
                        <Download
                          size={13}
                          strokeWidth={1.75}
                          aria-hidden="true"
                          className="shrink-0"
                        />
                        Download
                      </a>
                      <span
                        data-testid={`render-row-${job.id}-meta`}
                        className="min-w-0 flex-1 truncate text-hint text-muted"
                      >
                        {[
                          formatBytes(job.sizeBytes),
                          formatAvailableUntil(job.expiresAt),
                          formatWhen(job.createdAt),
                        ]
                          .filter((part): part is string => part !== null)
                          .join(" · ")}
                      </span>
                    </div>
                  ) : null}

                  {job.status === "completed" && job.resultUrl === null ? (
                    <p
                      data-testid={`render-row-${job.id}-expired`}
                      className="mt-2 text-hint text-muted"
                    >
                      The download link expired. Render again to get a new file.
                    </p>
                  ) : null}

                  {isRenderActive(job.status) ? (
                    <div className="mt-2 flex items-center gap-2">
                      {job.cancelRequested ? (
                        <span
                          data-testid={`render-row-${job.id}-cancelling`}
                          className="text-hint text-muted"
                        >
                          Cancelling…
                        </span>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          data-testid={`render-row-${job.id}-cancel`}
                          disabled={cancelling.has(job.id)}
                          className="h-6 px-2 text-caption text-secondary hover:text-danger"
                          onClick={() => cancel(job)}
                        >
                          Cancel
                        </Button>
                      )}
                      {rowErrors[job.id] !== undefined ? (
                        <span
                          data-testid={`render-row-${job.id}-cancel-error`}
                          className="min-w-0 flex-1 truncate text-hint text-danger"
                        >
                          {rowErrors[job.id]}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        {loadedOnce && onOpenRender !== undefined && rows.length > 0 ? (
          <div className="shrink-0 border-t border-border px-3 py-2.5">
            <Button
              variant="secondary"
              size="sm"
              className="w-full"
              data-testid="render-history-new"
              onClick={onOpenRender}
            >
              <Clapperboard size={14} strokeWidth={1.75} aria-hidden="true" />
              New render
            </Button>
          </div>
        ) : null}
      </aside>
    </div>
  ) : null;

  return createPortal(drawer, document.body);
}
