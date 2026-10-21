"use client";

// apps/web/src/components/flows/use-exports.ts (W8-P)
//
// useExports — the §13.1 export flow client: enqueue → 202 → poll → URL.
//
//   POST /v1/documents/:id/exports  { format, width?, height?, quality? }
//        → 202 { export_id, status: "queued", revision, warnings }
//        (lib/api.ts injects the §13 Idempotency-Key — it becomes the queue
//        jobId, so a retried click cannot double-render, gateway W4-L/§3.4).
//
//   GET /v1/documents/:id/exports?limit=20  — the per-document job list IS
//        the status surface: the gateway exposes no per-job GET (W4-L routes),
//        so each poll tick reads the list and picks this job's row by
//        export_id. N active jobs → N list reads per tick; the mini-history
//        stays ≤ a few active jobs in practice (dialog-lifetime loop).
//
//   Poll loop: BOUNDED, 2 s interval (task), MAX_EXPORT_POLLS=150 (≈5 min —
//   the §20-#5 wall clock). The per-tick stop/continue decision is the pure
//   nextExportPollAction (flows-model.ts, unit-tested). Unmount aborts every
//   loop; jobs keep processing server-side and the history reloads (with
//   fresh ≤15-min signed URLs) the next time the dialog opens.
//
//   Ready job → fresh signed URL → auto-download (anchor click) + the §10.3
//   note the dialog renders: re-downloading an existing export is free.
//
//   Failed job → the wire list row carries no error payload (W4-L shape), so
//   the row shows a plain failure message; CREATE-call failures show the full
//   typed envelope (message — hint, §13.3, e.g. plan_limit "HD export
//   requires Pro", §10.3).

import { useCallback, useEffect, useRef, useState } from "react";
import type { GatewayClient } from "../../lib/api";
import {
  EXPORT_HISTORY_LIMIT,
  EXPORT_POLL_INTERVAL_MS,
  MAX_EXPORT_POLLS,
  compareExportJobsNewestFirst,
  buildExportRequest,
  exportFileName,
  exportListSchema,
  exportQueuedSchema,
  flowErrorText,
  nextExportPollAction,
  toExportJobView,
  upsertExportJob,
  type ExportJobView,
  type ExportListItem,
  type ExportRequestDraft,
} from "./flows-model";

export interface UseExportsOptions {
  /** Typed gateway client (apps/web/src/lib/api.ts). */
  readonly client: GatewayClient;
  readonly documentId: string;
  /** Poll cadence (default 2 000 ms — task-mandated 2 s interval). */
  readonly pollIntervalMs?: number;
  /** Poll budget per job (default 150 → ≈5 min at the default cadence). */
  readonly maxPolls?: number;
  /**
   * Replaces the default auto-download when a job turns ready (§10.3 free
   * re-download). The default clicks a hidden anchor on the signed URL.
   */
  readonly onExportReady?: (job: ExportJobView) => void;
}

export interface UseExportsResult {
  /** Validate → POST → 202 → add the job + start its poll loop. */
  readonly enqueueExport: (draft: ExportRequestDraft) => Promise<boolean>;
  /** Job mini-history, newest first, merged with live poll updates. */
  readonly jobs: readonly ExportJobView[];
  /** True while the initial history page is loading. */
  readonly historyBusy: boolean;
  /** Validation/creation/history error text (envelope-derived); null when none. */
  readonly error: string | null;
  readonly clearError: () => void;
}

type ListOutcome =
  | { readonly ok: true; readonly items: readonly ExportListItem[] }
  | { readonly ok: false; readonly error: unknown };

/** Aborts an in-flight poll loop on unmount (no setState after teardown). */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Default ready-action: click a hidden anchor on the signed URL. Cross-origin
 * URLs may ignore the `download` attribute — the storage layer's disposition
 * still downloads; the dialog's auto-download note covers the edge.
 */
function triggerDownload(job: ExportJobView): void {
  if (job.url === null || typeof document === "undefined") {
    return;
  }
  const anchor = document.createElement("a");
  anchor.href = job.url;
  anchor.rel = "noopener";
  anchor.download = exportFileName(job);
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

export function useExports(options: UseExportsOptions): UseExportsResult {
  const { client, documentId } = options;
  const pollIntervalMs = options.pollIntervalMs ?? EXPORT_POLL_INTERVAL_MS;
  const maxPolls = options.maxPolls ?? MAX_EXPORT_POLLS;

  const [jobs, setJobs] = useState<readonly ExportJobView[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pollsRef = useRef(new Map<string, AbortController>());
  const onReadyRef = useRef<((job: ExportJobView) => void) | undefined>(options.onExportReady);
  useEffect(() => {
    onReadyRef.current = options.onExportReady;
  }, [options.onExportReady]);

  const fetchList = useCallback(
    async (signal: AbortSignal): Promise<ListOutcome> => {
      try {
        const listing = await client.get(
          `/documents/${encodeURIComponent(documentId)}/exports?limit=${EXPORT_HISTORY_LIMIT}`,
          { schema: exportListSchema, signal },
        );
        return { ok: true, items: listing.exports };
      } catch (cause) {
        return { ok: false, error: cause };
      }
    },
    [client, documentId],
  );

  const patchJob = useCallback(
    (exportId: string, patch: (job: ExportJobView) => ExportJobView): void => {
      setJobs((current) => current.map((job) => (job.exportId === exportId ? patch(job) : job)));
    },
    [],
  );

  const pollJob = useCallback(
    (exportId: string): void => {
      const controller = new AbortController();
      pollsRef.current.set(exportId, controller);
      void (async (): Promise<void> => {
        let polls = 0;
        let item: ExportListItem | null = null;
        let lastError: unknown = null;
        let latest: ExportJobView | null = null;
        try {
          for (;;) {
            await wait(pollIntervalMs, controller.signal);
            if (controller.signal.aborted) {
              return;
            }
            const outcome = await fetchList(controller.signal);
            if (controller.signal.aborted) {
              return;
            }
            polls += 1;
            if (outcome.ok) {
              lastError = null;
              const found = outcome.items.find((row) => row.export_id === exportId) ?? null;
              if (found !== null) {
                item = found;
                latest = toExportJobView(found, latest ?? undefined);
                const snapshot = latest;
                patchJob(exportId, () => snapshot);
              }
            } else {
              lastError = outcome.error;
            }
            const decision = nextExportPollAction({ polls, maxPolls, item, error: lastError });
            if (decision === "continue") {
              continue;
            }
            if (decision === "stop-ready") {
              const ready = latest;
              if (ready !== null && ready.url !== null) {
                (onReadyRef.current ?? triggerDownload)(ready);
              }
            } else if (decision === "stop-failed") {
              const isPsd = latest?.format === "psd";
              patchJob(exportId, (job) => ({
                ...job,
                error: isPsd
                  ? "The export failed — PSD is experimental and the render service can refuse it (§2.3)."
                  : "The export failed — try again, or pick another format.",
              }));
            } else if (decision === "stop-budget") {
              patchJob(exportId, (job) => ({ ...job, pollBudgetExhausted: true }));
            } else {
              // stop-hard-error — the last list call failed hard (4xx ≠ 429).
              const text = flowErrorText(lastError, "The export status could not be checked.");
              patchJob(exportId, (job) => ({ ...job, error: text }));
            }
            return;
          }
        } finally {
          pollsRef.current.delete(exportId);
        }
      })();
    },
    [fetchList, maxPolls, patchJob, pollIntervalMs],
  );

  const enqueueExport = useCallback(
    async (draft: ExportRequestDraft): Promise<boolean> => {
      const request = buildExportRequest(draft);
      if (!request.ok) {
        setError(`${request.message} — ${request.hint}`);
        return false;
      }
      setError(null);
      try {
        const queued = await client.post(
          `/documents/${encodeURIComponent(documentId)}/exports`,
          { body: request.body, schema: exportQueuedSchema },
        );
        const job: ExportJobView = {
          exportId: queued.export_id,
          format: request.body.format,
          revision: queued.revision,
          phase: "queued",
          width: request.body.width ?? null,
          height: request.body.height ?? null,
          quality: request.body.quality ?? null,
          createdAt: new Date().toISOString(),
          url: null,
          expiresAt: null,
          error: null,
          pollBudgetExhausted: false,
          warnings: queued.warnings, // §2.3: psd answers with the warning text
        };
        setJobs((current) => upsertExportJob(current, job));
        pollJob(queued.export_id);
        return true;
      } catch (cause) {
        setError(flowErrorText(cause, "The export could not be started."));
        return false;
      }
    },
    [client, documentId, pollJob],
  );

  const clearError = useCallback((): void => {
    setError(null);
  }, []);

  // Mini-history page load — one GET on mount (the hook lives inside the
  // dialog content, so "mount" is "dialog opened": every open gets fresh
  // rows with fresh ≤15-min signed URLs, §13).
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void (async (): Promise<void> => {
      setHistoryBusy(true);
      try {
        const outcome = await fetchList(controller.signal);
        if (!active || controller.signal.aborted) {
          return;
        }
        if (outcome.ok) {
          const views = outcome.items.map((item) => toExportJobView(item));
          views.sort(compareExportJobsNewestFirst);
          setJobs(views);
        } else {
          setError(flowErrorText(outcome.error, "Past exports could not be loaded."));
        }
      } finally {
        if (active) {
          setHistoryBusy(false);
        }
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [fetchList]);

  // Unmount: abort every live poll loop (React state writes stop with them).
  useEffect(() => {
    const controllers = pollsRef.current;
    return () => {
      for (const controller of controllers.values()) {
        controller.abort();
      }
    };
  }, []);

  return { enqueueExport, jobs, historyBusy, error, clearError };
}
