// @studio/web — render status vocabulary + failure copy (BUILD_PLAN §M8 task 2;
// DECISIONS D-11/D-12; law #1: typed codes surface honestly, never internals).
//
// D-11 pin: the render status vocabulary is the DB's — queued | running |
// completed | failed | cancelled. "succeeded" does not exist anywhere in this
// UI (a test pins it). Labels are short; the row's secondary line carries the
// detail (frames, error copy, expiry).

import { isApiError } from "@studio/api-client";
import type { RenderJob, RenderStatus } from "@studio/contracts";

/** Short status labels (§7.8 badge wording). */
const STATUS_LABELS: Readonly<Record<RenderStatus, string>> = {
  queued: "Queued",
  running: "Rendering",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** D-11 vocabulary ONLY — this map is the single source of status copy. */
export function renderStatusLabel(status: RenderStatus): string {
  return STATUS_LABELS[status];
}

/** True while the job can still be cancelled (the cancel seam's own rule). */
export function isRenderActive(status: RenderStatus): boolean {
  return status === "queued" || status === "running";
}

/**
 * Human copy for a FAILED job's stable machine code (M8-B's catalog). The
 * wire `error` text is human-safe by construction (the worker sanitizes CLI
 * output), so the fallback shows it verbatim.
 */
const ERROR_CODE_COPY: Readonly<Record<string, string>> = {
  RENDER_TIMEOUT:
    "The render ran past the time limit and was stopped. Try a shorter range or a lower resolution.",
  RENDER_FAILED: "The render failed while producing the output. Try again, or a smaller range.",
  RENDER_CLI_MISSING: "Rendering is temporarily unavailable on the server. Try again later.",
  RENDER_CLI_FAILED: "The render worker hit an error. Try again in a moment.",
  RENDER_ASSET_MISSING: "The project references a missing asset. Re-upload it, then render again.",
  RENDER_PROJECT_INVALID:
    "This project version could not be rendered. Restore a known-good version from history.",
  RENDER_CANCELLED: "The render was cancelled.",
  RENDER_INTERNAL: "The render worker hit an internal error. Try again in a moment.",
};

export function renderErrorCopy(job: RenderJob): string {
  if (job.errorCode !== null) {
    const copy = ERROR_CODE_COPY[job.errorCode];
    if (copy !== undefined) return copy;
  }
  return job.error !== null && job.error !== ""
    ? job.error
    : "The render failed. Try again in a moment.";
}

/** Stable machine code shown as small data next to the copy (never the only signal). */
export function renderErrorCodeLabel(job: RenderJob): string | null {
  return job.errorCode;
}

/**
 * Friendly copy for a QUEUE failure by typed code (§7.7: an inline banner, never
 * a toast). `INSUFFICIENT_CREDITS` (402) is special-cased by the dialog with a
 * billing link; everything else maps here. Unknown codes fall back to the
 * api-client's safe message (§7.3 guarantees it is sanitized).
 */
const QUEUE_CODE_COPY: Readonly<Record<string, string>> = {
  RENDER_UNSUPPORTED_FORMAT:
    "That format is not available yet. MP4 and PNG sequence are the formats available now.",
  RENDER_QUOTA_EXCEEDED: "This workspace reached its render-minutes limit for this billing period.",
  RENDER_CONCURRENCY_LIMIT:
    "Too many renders are already queued. Try again when the current ones finish.",
  INSUFFICIENT_CREDITS: "Not enough credits for this render.",
  UNAUTHORIZED: "Your session expired. Refresh the page and try again.",
  NOT_FOUND: "This project could not be found. Refresh the page and try again.",
};

export function queueErrorCopy(error: unknown): {
  readonly code: string | null;
  readonly message: string;
} {
  if (isApiError(error)) {
    const copy = QUEUE_CODE_COPY[error.code];
    if (copy !== undefined) return { code: error.code, message: copy };
    return {
      code: error.code,
      message:
        error.message !== ""
          ? error.message
          : "The render could not be queued. Try again in a moment.",
    };
  }
  return {
    code: null,
    message:
      error instanceof Error && error.message !== ""
        ? error.message
        : "The render could not be queued. Try again in a moment.",
  };
}

/** Estimate failure copy — honest, non-blocking (queueing stays available). */
export const ESTIMATE_ERROR_COPY =
  "Could not load the estimate. You can still queue the render — credits are only charged once it completes.";

// ---------------------------------------------------------------------------
// Small deterministic humanizers (UTC so tests never see a timezone)
// ---------------------------------------------------------------------------

/** "1.2 MB", "48.2 MB", "310 MB" (binary MiB units, one decimal under 10). */
export function formatBytes(sizeBytes: number | null): string | null {
  if (sizeBytes === null || sizeBytes <= 0) return null;
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = sizeBytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 || value >= 10 ? Math.round(value).toString() : value.toFixed(1);
  return `${text} ${units[unit]}`;
}

const EXPIRY_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** "available until Nov 9, 2026" for a completed row's signed-URL expiry. */
export function formatAvailableUntil(expiresAt: string | null): string | null {
  if (expiresAt === null || expiresAt === "") return null;
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return null;
  return `available until ${EXPIRY_FORMAT.format(date)}`;
}

/** Creation stamp ("Oct 14, 09:48") — UTC, mirroring the comments panel. */
const WHEN_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

export function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : WHEN_FORMAT.format(date);
}

/** Frame progress line "done/total" — the D-11 progress snapshot, never re-derived. */
export function formatFrames(progress: RenderJob["progress"]): string {
  if (progress.framesTotal <= 0) return "preparing…";
  return `${progress.framesDone}/${progress.framesTotal} frames`;
}
