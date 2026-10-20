// @studio/tools — export_document (spec §6 row 18): save .pcraft / PNG / JPG
// with a fidelity report.
//
// The tool NEVER runs the export itself — it delegates over an injected seam to
// the worker export pipeline (W2-N `processExportJob`, apps/worker/src/
// render-jobs.ts — BullMQ `exports` queue behind §13.1 `POST /v1/documents/:id/
// exports`) and then waits for the job to finish. `ctx.exports` (enqueue/poll)
// and `ctx.exportEvents` (subscribe fast-path) are worker-injected structural
// seams; types.ts stays minimal by design, so this file declares them
// (`ExportToolContext`, structural superset of `ToolContext` — the composition
// root assembles it). The submission carries ONLY model-controlled fields;
// organization/document ids, revision and plan are appended worker-side and
// never come from the model (§15.1 tenancy).
//
// Format policy (§10.3, §2.3 known engine reality):
//   - `pcraft` — the native layered form, the ONLY format promised lossless and
//     round-trip-perfect → the tool's default. Checkpointed + replayable (§10.4).
//   - `png` / `jpg` — raster exports; `jpg` honours `quality` 1–100; for lossless
//     formats the pipeline warns (never silently degrades) when quality is sent.
//   - `psd` — experimental: Photoshop does not yet reliably accept engine-written
//     PSD (upstream issues #1281/#2469). NOT offered to the model — the args
//     schema rejects `psd` with a hint to use `pcraft`. The gateway/UI may still
//     offer PSD once §2.3 ships it with a warning label + fidelity report; those
//     surfaces reuse PSD_EXPERIMENTAL_WARNING, and the §2.3 warning branch in
//     `run` is kept for parity (unreachable through this tool by construction).
//
// Idempotency & billing (§3.4, §10.3, §14.2): exports are a plan-gated credit
// event at the gateway (§13.1) and plan MP ceilings gate inside the pipeline
// (§14.1) — this tool charges nothing. It derives a DETERMINISTIC idempotency
// key from the model-visible args, so identical requests land on the same job
// and storage key: a retried export overwrites (never duplicates), and
// re-downloading an existing export is free (§10.3).
//
// Waiting contract: bounded — at most POLL_MAX_ATTEMPTS status reads,
// POLL_INTERVAL_MS apart (≤ 60 s wall clock). When an event-subscribe seam is
// present the tool waits on it under the SAME budget instead of polling; when
// the budget is exhausted while the job still runs, the tool returns ok with
// the last status ("queued"/"active") and the model re-calls export_document
// (idempotent). The executor's §3.4 deadline (5 s default) stays the real
// bound: on abort the tool returns engine_timeout, retryable.

import { z } from "zod";
import { TOOLS } from "../registry.js";
import {
  MAX_ERROR_MESSAGE_CHARS,
  MAX_HINT_CHARS,
  MAX_SUMMARY_CHARS,
  MAX_WARNING_CHARS,
  MAX_WARNINGS,
  defineTool,
  err,
  ok,
  strictObject,
} from "../kit.js";
import type {
  EngineFailure,
  EngineOutcome,
  Tool,
  ToolContext,
  ToolErr,
  ToolErrorCode,
  ToolResult,
} from "../types.js";

// ---------------------------------------------------------------------------
// PSD policy (§2.3 experimental / §10.3 fidelity report)
// ---------------------------------------------------------------------------

/**
 * §2.3/§10.3 warning label for PSD exports. The tool itself can never produce a
 * `psd` export (the schema rejects it), but the gateway/UI surface that MAY offer
 * PSD reuses this constant, and `run` keeps the branch for parity so a PSD
 * result can never ship without its fidelity label.
 */
export const PSD_EXPERIMENTAL_WARNING =
  "psd export is experimental and best-effort: Photoshop does not yet reliably accept " +
  "engine-written PSD files (upstream issues #1281, #2469) and the round trip is not " +
  "lossless — prefer the .pcraft format for a round-trip-perfect export (§2.3, §10.3)";

/** The schema message when the model asks for `psd` (§2.3: not offered to it). */
export const PSD_NOT_OFFERED_HINT =
  'psd export is experimental (§2.3) and is not offered to the model — use "pcraft" ' +
  '(lossless, round-trip-perfect) or "png"';

// ---------------------------------------------------------------------------
// Argument schema (§6.1 strict)
// ---------------------------------------------------------------------------

export type ExportFormat = "pcraft" | "png" | "jpg";

const EXPORT_FORMAT_ERROR_MAP: z.ZodErrorMap = (issue) => {
  if (issue.code === z.ZodIssueCode.invalid_enum_value && issue.received === "psd") {
    return { message: PSD_NOT_OFFERED_HINT };
  }
  return { message: 'format must be "pcraft", "png" or "jpg"' };
};

/** Offered formats only — `psd` is NOT here (§2.3; see PSD_NOT_OFFERED_HINT). */
export const EXPORT_FORMAT_SCHEMA = z.enum(["pcraft", "png", "jpg"], {
  errorMap: EXPORT_FORMAT_ERROR_MAP,
});

/**
 * §6 row 18 args. width/height mirror the worker's export-job request bounds
 * (apps/worker/src/render-jobs.ts `exportJobRequestSchema`, 1–8192 int) so the
 * delegation can never fail late on tool-side input; the pipeline still owns the
 * §14.1 plan-MP gate. `quality` is the JPEG knob (1–100) — lossless formats
 * ignore it and the pipeline warns.
 */
export const exportDocumentArgsSchema = strictObject({
  // §10.3: .pcraft is the primary output and the only format promised lossless,
  // round-trip-perfect — so it is the default.
  format: EXPORT_FORMAT_SCHEMA.default("pcraft"),
  width: z.number().int().min(1).max(8192).optional(),
  height: z.number().int().min(1).max(8192).optional(),
  quality: z.number().int().min(1).max(100).optional(),
});

export type ExportDocumentArgs = z.infer<typeof exportDocumentArgsSchema>;

// ---------------------------------------------------------------------------
// Delegation seams (worker wires W2-N's export pipeline behind these)
// ---------------------------------------------------------------------------

/** BullMQ-shaped job status vocabulary (the seam maps queue states onto it). */
export type ExportJobStatus = "queued" | "active" | "succeeded" | "failed";

/** True only for the statuses after which the tool must not wait any longer. */
export function isTerminalExportStatus(status: string): boolean {
  return status === "succeeded" || status === "failed";
}

/** What the tool sends: model-controlled fields + the idempotency token ONLY. */
export interface ExportSubmission {
  readonly format: ExportFormat;
  readonly width?: number;
  readonly height?: number;
  readonly quality?: number;
  /**
   * Deterministic key derived from the args (see deriveExportIdempotencyKey):
   * retries land on the same job/storage key (§3.4); the worker composes
   * organization/document/revision/plan server-side (§15.1).
   */
  readonly idempotencyKey: string;
}

/** enqueueExport reply — the job handle. */
export interface ExportJobHandle {
  readonly exportId: string;
  readonly status: ExportJobStatus;
}

/**
 * Terminal export record + fidelity report. `url` is the signed download URL
 * (absolute http(s), short-lived); `warnings` is the pipeline's fidelity report
 * (e.g. JPEG-quality-on-lossless notes); `errorCode`/`errorMessage` carry the
 * pipeline's own failure vocabulary (EXPORT_ERROR_CODES, render-jobs.ts) when
 * status is "failed".
 */
export interface ExportJobRecord {
  readonly exportId: string;
  readonly status: ExportJobStatus;
  readonly url?: string;
  readonly warnings?: readonly string[];
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly documentRevision?: number;
}

export interface ExportCallOptions {
  readonly signal?: AbortSignal;
}

/** The enqueue/poll seam — the worker maps it onto the exports queue + job rows. */
export interface ExportJobsLike {
  /** Enqueue one export job (idempotent per submission.idempotencyKey). */
  enqueueExport(
    submission: ExportSubmission,
    options?: ExportCallOptions,
  ): Promise<EngineOutcome<ExportJobHandle>>;
  /** Read the current job record (status, url, warnings, failure detail). */
  getExport(exportId: string): Promise<EngineOutcome<ExportJobRecord>>;
}

/**
 * Event-subscribe seam — when the injected context carries one, the tool waits
 * for the terminal record instead of polling (the worker maps run SSE /
 * queue events onto it). Resolves with the terminal record, or undefined when
 * the subscription closes or the seam's own wait gives up.
 */
export interface ExportEventsLike {
  waitForExport(
    exportId: string,
    options?: ExportCallOptions,
  ): Promise<ExportJobRecord | undefined>;
}

/** ToolContext + the export seams; assembled by the agent runtime per call. */
export interface ExportToolContext extends ToolContext {
  readonly exports?: ExportJobsLike;
  readonly exportEvents?: ExportEventsLike;
}

// ---------------------------------------------------------------------------
// Idempotency key (§3.4 retries, §10.3 free re-downloads)
// ---------------------------------------------------------------------------

/**
 * Deterministic key from the model-visible args ONLY: identical requests derive
 * the same key, so retries/Re-exports land on the same job and storage key (the
 * worker appends revision + document ids server-side). Matches the worker's
 * key-segment pattern `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` (render-jobs.ts).
 */
export function deriveExportIdempotencyKey(args: ExportDocumentArgs): string {
  const width = args.width === undefined ? "auto" : String(args.width);
  const height = args.height === undefined ? "auto" : String(args.height);
  const quality = args.quality === undefined ? "" : `-q${args.quality}`;
  return `exp-${args.format}-${width}x${height}${quality}`;
}

// ---------------------------------------------------------------------------
// Bounded waiting (poll table + event fast-path)
// ---------------------------------------------------------------------------

/** §Task contract: at most 30 status reads. */
export const POLL_MAX_ATTEMPTS = 30;
/** §Task contract: 2 s between reads (30 × 2 s = 60 s wall-clock budget). */
export const POLL_INTERVAL_MS = 2000;
/** Total wait budget — identical on the poll and event paths. */
export const EXPORT_WAIT_BUDGET_MS = POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS;

/**
 * Test/injectable delay: resolves after `ms`, or IMMEDIATELY when `signal`
 * aborts (aborts are values here — every loop iteration re-checks the signal;
 * nothing in this module throws).
 */
export function sleepUntilResolved(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface AwaitExportDeps {
  readonly exportId: string;
  readonly getExport: (exportId: string) => Promise<EngineOutcome<ExportJobRecord>>;
  /** Present → event fast-path; absent → bounded poll. */
  readonly waitForExport?: (
    exportId: string,
    options?: ExportCallOptions,
  ) => Promise<ExportJobRecord | undefined>;
  readonly signal: AbortSignal;
  /** Injectable for tests; the shipped tool uses the real 2 s timer. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface AwaitExportOptions {
  /** Clamped to 1..POLL_MAX_ATTEMPTS (the bound is part of the contract). */
  readonly maxAttempts?: number;
  readonly intervalMs?: number;
}

export type AwaitedExport =
  | { readonly kind: "record"; readonly record: ExportJobRecord }
  | {
      readonly kind: "exhausted";
      readonly record?: ExportJobRecord;
      readonly lastFailure?: EngineFailure;
    }
  | { readonly kind: "aborted" };

/**
 * Wait for a terminal export record, bounded (≤ maxAttempts reads × intervalMs
 * wall clock). Event path: race the subscription against the same budget, then
 * one authoritative getExport decides. Poll path: read → sleep → repeat; read
 * blips (read-after-write lag) never fail the export. Never throws.
 */
export async function awaitExportTerminal(
  deps: AwaitExportDeps,
  options: AwaitExportOptions = {},
): Promise<AwaitedExport> {
  const maxAttempts = Math.min(
    Math.max(1, options.maxAttempts ?? POLL_MAX_ATTEMPTS),
    POLL_MAX_ATTEMPTS,
  );
  const intervalMs = Math.max(0, options.intervalMs ?? POLL_INTERVAL_MS);
  const sleep = deps.sleep ?? sleepUntilResolved;
  const budgetMs = maxAttempts * intervalMs;

  if (deps.waitForExport !== undefined) {
    // Losing promises get rejection handlers so a late worker error can never
    // surface as an unhandled rejection after the race is decided.
    const delivered = await Promise.race([
      deps.waitForExport(deps.exportId, { signal: deps.signal }).then(
        (record) => record ?? undefined,
        () => undefined,
      ),
      sleep(budgetMs, deps.signal).then(
        () => undefined,
        () => undefined,
      ),
    ]);
    if (deps.signal.aborted) {
      return { kind: "aborted" };
    }
    if (delivered !== undefined && isTerminalExportStatus(delivered.status)) {
      return { kind: "record", record: delivered };
    }
    // Subscription closed early or delivered a non-terminal record: one
    // authoritative read decides between a late terminal and "still processing".
    const outcome = await deps.getExport(deps.exportId);
    if (outcome.ok) {
      return isTerminalExportStatus(outcome.value.status)
        ? { kind: "record", record: outcome.value }
        : { kind: "exhausted", record: delivered ?? outcome.value };
    }
    return delivered !== undefined
      ? { kind: "exhausted", record: delivered }
      : { kind: "exhausted", lastFailure: outcome };
  }

  let lastRecord: ExportJobRecord | undefined;
  let lastFailure: EngineFailure | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (deps.signal.aborted) {
      return { kind: "aborted" };
    }
    const outcome = await deps.getExport(deps.exportId);
    if (outcome.ok) {
      lastRecord = outcome.value;
      if (isTerminalExportStatus(outcome.value.status)) {
        return { kind: "record", record: outcome.value };
      }
    } else {
      lastFailure = outcome;
    }
    if (attempt < maxAttempts) {
      await sleep(intervalMs, deps.signal);
    }
  }
  return deps.signal.aborted
    ? { kind: "aborted" }
    : { kind: "exhausted", record: lastRecord, lastFailure };
}

// ---------------------------------------------------------------------------
// URL validation — signed export URLs are absolute http(s), never file paths
// ---------------------------------------------------------------------------

/**
 * Cap strictly below the 2 000-char summary budget: the summary embeds the url
 * alongside the fact set, so a 2 048-char url (the kit preview ceiling) could
 * not fit. Real presigned URLs are far shorter; an oversized one is rejected as
 * a pipeline failure (retry re-signs, §10.3).
 */
export const MAX_EXPORT_URL_CHARS = 1500;

/**
 * Absolute http(s) only — stricter than the kit's previewUrl (root-relative is
 * fine for previews served by the web app, but the model cannot resolve a
 * relative path against the objects host, and signed export URLs are always
 * absolute). Blocks traversal, backslashes and non-http schemes (§6.1).
 */
export function isSafeExportUrl(url: string): boolean {
  if (url.length === 0 || url.length > MAX_EXPORT_URL_CHARS) {
    return false;
  }
  if (url.includes("\\") || url.includes("..")) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Compact summary (§6.1 small-reply rule; rides the kit's string envelope)
// ---------------------------------------------------------------------------

export interface ExportSummaryParts {
  readonly exportId: string;
  readonly format: ExportFormat;
  readonly status: ExportJobStatus;
  readonly url?: string;
  readonly warnings: readonly string[];
}

function stringifySummaryParts(
  parts: ExportSummaryParts,
  warnings: readonly string[],
): string {
  const payload: Record<string, string | readonly string[]> = {
    exportId: parts.exportId,
    format: parts.format,
    status: parts.status,
  };
  if (parts.url !== undefined) {
    payload.url = parts.url;
  }
  if (warnings.length > 0) {
    payload.warnings = warnings;
  }
  return JSON.stringify(payload);
}

/**
 * `{ exportId, format, url?, status, warnings }` as compact JSON — the task's
 * fact set, guaranteed ≤ MAX_SUMMARY_CHARS by halving the embedded warnings
 * (with a "+N more" marker) and finally dropping them; ok() would otherwise
 * reject the result (invalid_tool_result), which must never happen.
 */
export function buildExportSummary(parts: ExportSummaryParts): string {
  let embedded = parts.warnings.slice(0, MAX_WARNINGS);
  let summary = stringifySummaryParts(parts, embedded);
  while (summary.length > MAX_SUMMARY_CHARS && embedded.length > 0) {
    const keep = Math.floor(embedded.length / 2);
    const rest = embedded.length - keep;
    const trimmed =
      keep > 0 && rest > 0
        ? [...embedded.slice(0, keep), `(+${rest} more warnings)`]
        : embedded.slice(0, keep);
    embedded = trimmed.length < embedded.length ? trimmed : [];
    summary = stringifySummaryParts(parts, embedded);
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

function truncateText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}

/**
 * §13.3 add-only catalog gap (fleet precedent: "unknown_asset", "image_upscale_limit"):
 * "export_failed" is not yet in the shared catalog (@studio/config ERROR_CODES)
 * nor in TOOL_ONLY_ERROR_CODES (packages/tools/src/types.ts — not owned by this
 * file). Until the types.ts owner adds it, pipeline failures map to
 * `storage_error` (exports terminate as object-storage artifacts). Flip this ONE
 * constant to "export_failed" the day the catalog gains the code — the tests
 * import it, so the swap is a single line.
 */
export const EXPORT_FAILED_CODE: ToolErrorCode = "storage_error";

/**
 * A failed export job (or an invalid export URL), mapped from the pipeline's
 * own vocabulary (EXPORT_ERROR_CODES, render-jobs.ts). Default branch: ONE
 * retryable pipeline failure with the pipeline's code + reason in the hint.
 */
export function exportPipelineErr(
  pipelineCode: string | undefined,
  pipelineMessage: string | undefined,
): ToolErr {
  const message =
    typeof pipelineMessage === "string" && pipelineMessage.trim().length > 0
      ? pipelineMessage
      : "the export pipeline did not report a reason";
  const detail = `export pipeline reported ${pipelineCode ?? "unknown"}: ${message}`;
  switch (pipelineCode) {
    // §14.1/§10.3: plan ceilings gate before any engine work; retrying the same
    // size can never help.
    case "canvas_exceeds_plan_limit":
      return err("plan_limit", truncateText(message, MAX_ERROR_MESSAGE_CHARS), {
        hint: "export a smaller canvas or upgrade the workspace plan (§14.1)",
        retryable: false,
      });
    // §2.3: PSD is experimental and the worker refuses it. Unreachable through
    // this tool (the schema never yields "psd") — kept for defensive parity.
    case "experimental_psd":
      return err("validation_failed", truncateText(message, MAX_ERROR_MESSAGE_CHARS), {
        hint: PSD_NOT_OFFERED_HINT,
        retryable: false,
      });
    // The pipeline schema rejected a payload this tool built — a bug here.
    case "invalid_export_request":
      return err("validation_failed", "the export request was rejected by the pipeline", {
        hint: truncateText(detail, MAX_HINT_CHARS),
        retryable: false,
      });
    default:
      // export_engine_failed / invalid_export_bytes / export_store_failed /
      // export_sign_failed / unknown → one retryable pipeline failure.
      return err(EXPORT_FAILED_CODE, "the document export failed", {
        hint: truncateText(detail, MAX_HINT_CHARS),
        retryable: true,
      });
  }
}

/**
 * Seam-call failures already carry a shared-catalog code (§13.3 — the worker
 * maps queue/store codes onto it), so they pass through with code, message,
 * hint and retryable preserved (fleet precedent for engine failures).
 */
function seamFailureErr(failure: EngineFailure): ToolErr {
  const message =
    typeof failure.message === "string" && failure.message.trim().length > 0
      ? failure.message
      : "the export job service could not be reached";
  return err(failure.code, truncateText(message, MAX_ERROR_MESSAGE_CHARS), {
    hint: failure.hint === undefined ? undefined : truncateText(failure.hint, MAX_HINT_CHARS),
    retryable: failure.retryable,
  });
}

/** Warnings from the pipeline, clamped to the kit's §6.1 reply caps. */
function clampWarnings(raw: readonly string[] | undefined): string[] {
  if (raw === undefined) {
    return [];
  }
  const out: string[] = [];
  for (const warning of raw) {
    if (typeof warning === "string" && warning.trim().length > 0) {
      out.push(truncateText(warning, MAX_WARNING_CHARS));
    }
    if (out.length >= MAX_WARNINGS) {
      break;
    }
  }
  return out;
}

/** Only non-negative integers reach ok()'s documentRevision validation. */
function safeDocumentRevision(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export const exportDocumentTool: Tool<ExportDocumentArgs> = defineTool({
  name: TOOLS.export_document,
  description:
    "Export the document to object storage — lossless .pcraft (default), PNG or JPG — " +
    "via the export pipeline; returns the export id, a signed download URL and the " +
    "pipeline's fidelity warnings.",
  args: exportDocumentArgsSchema,
  async run(ctx, args, signal): Promise<ToolResult> {
    const ectx = ctx as ExportToolContext;
    const seam = ectx.exports;
    if (
      seam === undefined ||
      typeof seam.enqueueExport !== "function" ||
      typeof seam.getExport !== "function"
    ) {
      return err("internal_error", "the export job seam is not wired for this run", {
        hint: "the agent runtime must inject ctx.exports (worker export pipeline, §6 row 18)",
        retryable: false,
      });
    }
    const events = ectx.exportEvents;
    const waitForExport =
      events !== undefined && typeof events.waitForExport === "function"
        ? (exportId: string, options?: ExportCallOptions) =>
            events.waitForExport(exportId, options)
        : undefined;

    // §15.1: only model-controlled fields cross this boundary; the worker adds
    // organization/document ids, revision and plan from the session.
    const submission: ExportSubmission = {
      format: args.format,
      idempotencyKey: deriveExportIdempotencyKey(args),
      ...(args.width !== undefined ? { width: args.width } : {}),
      ...(args.height !== undefined ? { height: args.height } : {}),
      ...(args.quality !== undefined ? { quality: args.quality } : {}),
    };

    const enqueued = await seam.enqueueExport(submission, { signal });
    if (!enqueued.ok) {
      return seamFailureErr(enqueued);
    }
    const exportId = enqueued.value.exportId;
    if (typeof exportId !== "string" || exportId.length === 0 || exportId.length > 128) {
      return err("internal_error", "the export job service returned an invalid job handle", {
        hint: "retry export_document once; if it repeats the run should stop cleanly (§14.2)",
        retryable: false,
      });
    }

    let record: ExportJobRecord = { exportId, status: enqueued.value.status };
    if (!isTerminalExportStatus(record.status)) {
      const awaited = await awaitExportTerminal({
        exportId,
        getExport: (id) => seam.getExport(id),
        waitForExport,
        signal,
      });
      if (awaited.kind === "aborted") {
        return err("engine_timeout", "the export poll was cancelled before the job finished", {
          hint: "the export job keeps running in the background — re-run export_document " +
            "with the same arguments to re-check (re-downloads are idempotent, §10.3)",
          retryable: true,
        });
      }
      if (awaited.kind === "exhausted") {
        if (awaited.record === undefined) {
          return awaited.lastFailure !== undefined
            ? seamFailureErr(awaited.lastFailure)
            : err("internal_error", "the export status could not be read", {
                hint: "retry export_document; the idempotency key makes the retry safe (§3.4)",
                retryable: false,
              });
        }
        // Bounded wait exhausted while the job still runs: hand back the last
        // known status — the model (or the caller) re-checks by calling again.
        const stillProcessing = `the export is still processing after ${POLL_MAX_ATTEMPTS} ` +
          "status checks; re-run export_document with the same arguments to re-check " +
          "(re-downloads are idempotent, §10.3)";
        return ok({
          summary: buildExportSummary({
            exportId,
            format: args.format,
            status: awaited.record.status,
            warnings: [stillProcessing],
          }),
          documentRevision: safeDocumentRevision(awaited.record.documentRevision),
          warnings: [stillProcessing],
        });
      }
      record = awaited.record;
    }

    if (record.status === "failed") {
      return exportPipelineErr(record.errorCode, record.errorMessage);
    }

    // status === "succeeded": validate the signed URL (absolute http(s)).
    const url = record.url;
    if (url !== undefined && !isSafeExportUrl(url)) {
      // §6.1: never echo the rejected URL; signed export URLs are absolute http(s).
      return err(
        EXPORT_FAILED_CODE,
        "the export finished but the download URL was not a valid absolute http(s) URL",
        {
          hint: "retry export_document — the artifact is stored and re-signing is idempotent (§10.3)",
          retryable: true,
        },
      );
    }

    const warnings: string[] = clampWarnings(record.warnings);
    if (url === undefined) {
      warnings.push("the export finished but no download URL was returned; re-run " +
        "export_document to re-check (re-downloads are idempotent, §10.3)");
    }
    // §2.3/§10.3 fidelity label: PSD is experimental and never promised perfect.
    // Unreachable through this tool (the schema rejects "psd"); kept for parity
    // with the gateway/UI surface that may offer PSD.
    const format: string = args.format;
    if (format === "psd") {
      warnings.push(PSD_EXPERIMENTAL_WARNING);
    }

    return ok({
      summary: buildExportSummary({
        exportId,
        format: args.format,
        status: "succeeded",
        ...(url !== undefined ? { url } : {}),
        warnings,
      }),
      documentRevision: safeDocumentRevision(record.documentRevision),
      warnings: warnings.slice(0, MAX_WARNINGS),
    });
  },
});
