// apps/web/src/components/flows/flows-model.ts (W8-P)
//
// Pure logic + wire schemas for the undo/redo + export flows. No React, no
// DOM, no network — everything here is unit-testable (flows-model.test.ts).
//
// Spec anchors:
//   §13.1  POST /v1/documents/:id/undo / redo — ONE step (an agent run undoes
//          as one step); POST /v1/documents/:id/exports
//          `{ format, width?, height?, quality? }` → 202 job → URL.
//   §10.3  Formats: `.pcraft` primary (lossless, round-trip-perfect); PNG
//          exact render; JPG quality-configurable; PSD best-effort with a
//          fidelity report — never promised perfect.
//   §2.3   PSD experimental warning (engine issues #1281, #2469).
//   §20-#7 One undo reverts the entire agent run; redo restores it.
//
// Wire mirrors (byte-compatible, kept in sync by tests + contract drift throws):
//   apps/gateway/src/services/exports.ts (W4-L) — EXPORT_FORMATS,
//   EXPORT_JOB_STATUSES, ExportApiView, EXPORT_CREATE_BODY_SCHEMA bounds.
//   apps/gateway/src/routes/commands.ts (W4-K) — undo/redo command reply.
// The client (lib/api.ts, W1-K) unwraps `{ ok:false, … }` envelopes into
// thrown ApiError before any of this code runs.

import { z } from "zod";
import { isApiError } from "../../lib/api";

// ---------------------------------------------------------------------------
// Undo / redo — §13.1 one step, §20-#7 one run = one step
// ---------------------------------------------------------------------------

/**
 * POST /documents/:id/{undo,redo} reply (gateway routes/commands.ts
 * `toCommandReply`). Only the fields the flows consume are declared; unknown
 * fields pass through so additive server changes are not contract drift.
 */
export const undoRedoReplySchema = z
  .object({
    ok: z.literal(true),
    command: z.string(),
    revision_after: z.number().int().nonnegative(),
    revision_before: z.number().int().nonnegative().nullish(),
  })
  .passthrough();

export type UndoRedoReply = z.infer<typeof undoRedoReplySchema>;

/** Toast text (task-mandated) — §20-#7: one undo reverts the whole agent run. */
export const UNDO_NOTICE_TEXT = "Run undone — one step";
/** §20-#7: redo restores the run that undo reverted. */
export const REDO_NOTICE_TEXT = "Run restored — one step";

/** `Run undone — one step · revision 4` — revision is a detail, never the star. */
export function formatRevisionNotice(text: string, revision: number | null): string {
  return revision === null ? text : `${text} · revision ${revision}`;
}

// ---------------------------------------------------------------------------
// Exports — §13.1 / §10.3 wire mirrors (gateway services/exports.ts, W4-L)
// ---------------------------------------------------------------------------

/** §13.1 export formats — mirrors `EXPORT_FORMATS` in the gateway/worker. */
export const EXPORT_FORMATS = ["pcraft", "png", "jpg", "psd"] as const satisfies readonly string[];

export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Wire-stable export job lifecycle the gateway records (ExportJobStatus, W4-L). */
export const EXPORT_JOB_STATUSES = ["queued", "running", "succeeded", "failed"] as const satisfies
  readonly string[];

export type ExportJobStatus = (typeof EXPORT_JOB_STATUSES)[number];

/** §10.3 default export format — `.pcraft` is the primary, round-trip-perfect output. */
export const DEFAULT_EXPORT_FORMAT: ExportFormat = "pcraft";

/** Per-side pixel bound — mirrors MAX_EXPORT_SIDE_PX in the gateway/worker. */
export const MAX_EXPORT_SIDE_PX = 8192;

/** JPEG quality bounds — mirrors the gateway's 1..100 schema (§10.3 JPG). */
export const EXPORT_QUALITY_MIN = 1;
export const EXPORT_QUALITY_MAX = 100;

/** Slider default — high quality without maxing file size. */
export const DEFAULT_EXPORT_QUALITY = 90;

/** Task-mandated poll cadence for the export status loop (2 s interval). */
export const EXPORT_POLL_INTERVAL_MS = 2_000;

/**
 * Bounded poll loop: 150 polls × 2 s = 5 min — the §20-#5 "finishes in ≤ 5 min"
 * wall clock. After the budget the loop stops polling and the job row says
 * "still processing"; the history refreshes on the next dialog open.
 */
export const MAX_EXPORT_POLLS = 150;

/** GET /documents/:id/exports?limit= — mini-history page (gateway max 100). */
export const EXPORT_HISTORY_LIMIT = 20;

/**
 * §2.3 PSD experimental warning — verbatim mirror of PSD_EXPERIMENTAL_WARNING
 * in apps/gateway/src/services/exports.ts (the response surface returns it in
 * `warnings` for every psd request; keep the two copies in sync).
 */
export const PSD_EXPERIMENTAL_WARNING =
  "PSD export is experimental: Photoshop acceptance is not yet reliable " +
  "(engine issues #1281, #2469), so it ships with a warning label and a fidelity " +
  "report. The layered .pcraft format is the primary output and the only format " +
  "promised as round-trip-perfect (§2.3).";

/** §10.3: PSD ships best-effort with a report listing unsupported features. */
export const PSD_FIDELITY_NOTE =
  "A fidelity report lists any features the export could not preserve — PSD is " +
  "best-effort and never promised round-trip-perfect.";

/** Format picker metadata (§10.3 table, one row per format). */
export interface ExportFormatOption {
  readonly format: ExportFormat;
  readonly label: string;
  readonly hint: string;
  /** `.pcraft` — the recommended, lossless primary output. */
  readonly recommended?: boolean;
  /** §2.3 — ships behind a feature flag with the warning + fidelity note. */
  readonly experimental?: boolean;
}

export const EXPORT_FORMAT_OPTIONS: readonly ExportFormatOption[] = [
  {
    format: "pcraft",
    label: ".pcraft",
    hint: "Native layered file — lossless, round-trip-perfect",
    recommended: true,
  },
  {
    format: "png",
    label: "PNG",
    hint: "Exact render at document size",
  },
  {
    format: "jpg",
    label: "JPG",
    hint: "Quality-configurable, for photos and web delivery",
  },
  {
    format: "psd",
    label: "PSD",
    hint: "Best-effort, with a fidelity report",
    experimental: true,
  },
];

/** Artifact suffix per format (§10.3) — used for the auto-download filename. */
export const EXPORT_FILE_SUFFIX: Readonly<Record<ExportFormat, string>> = Object.freeze({
  pcraft: ".pcraft",
  png: ".png",
  jpg: ".jpg",
  psd: ".psd",
});

// ---------------------------------------------------------------------------
// Wire schemas — POST 202 reply + GET list item (§13.1; gateway W4-L shapes)
// ---------------------------------------------------------------------------

/** POST /documents/:id/exports → 202 reply (routes/exports.ts). */
export const exportQueuedSchema = z
  .object({
    export_id: z.string().min(1),
    status: z.literal("queued"),
    revision: z.number().int().nonnegative(),
    /** §2.3: psd answers with the experimental warning; [] otherwise. */
    warnings: z.array(z.string()),
  })
  .passthrough();

export type ExportQueuedReply = z.infer<typeof exportQueuedSchema>;

/**
 * One GET /documents/:id/exports list item — mirror of `ExportApiView`
 * (gateway services/exports.ts). `url`/`expires_at` are nullish-tolerant so a
 * signing hiccup that omits them is drift we can survive.
 */
export const exportItemSchema = z
  .object({
    export_id: z.string().min(1),
    format: z.enum(EXPORT_FORMATS),
    status: z.enum(EXPORT_JOB_STATUSES),
    revision: z.number().int().nonnegative(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    quality: z.number().int().nullable(),
    created_at: z.string(),
    finished_at: z.string().nullable(),
    /** Fresh ≤15-minute signed URL for succeeded jobs with a stored artifact. */
    url: z.string().nullable().optional(),
    expires_at: z.string().nullable().optional(),
  })
  .passthrough();

export type ExportListItem = z.infer<typeof exportItemSchema>;

/** GET /documents/:id/exports body — `{ exports: […] }`. */
export const exportListSchema = z
  .object({
    exports: z.array(exportItemSchema),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Status machine — wire statuses → display phases (queued/processing/ready/failed)
// ---------------------------------------------------------------------------

/** Display phases for the job list (task: queued/processing/ready/failed). */
export const EXPORT_PHASES = ["queued", "processing", "ready", "failed"] as const satisfies
  readonly string[];

export type ExportPhase = (typeof EXPORT_PHASES)[number];

/** Map the wire lifecycle onto the display machine (§13.1 statuses → phases). */
export function exportPhase(status: ExportJobStatus): ExportPhase {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "processing";
    case "succeeded":
      return "ready";
    case "failed":
      return "failed";
  }
}

/** `ready` / `failed` — the poll loop stops on these (§13.1 job → URL). */
export function isTerminalExportPhase(phase: ExportPhase): boolean {
  return phase === "ready" || phase === "failed";
}

/** Human label per display phase (job list mini-history rows). */
export const EXPORT_PHASE_LABEL: Readonly<Record<ExportPhase, string>> = Object.freeze({
  queued: "Queued",
  processing: "Processing",
  ready: "Ready",
  failed: "Failed",
});

/**
 * Phase → @studio/ui Badge variant (packages/ui/src/components/badge.tsx).
 * Kept as a literal union (not imported) so the model stays dependency-free
 * and unit-testable; Badge accepts every one of these variant strings.
 */
export type ExportPhaseBadgeVariant = "secondary" | "running" | "succeeded" | "failed";

export const EXPORT_PHASE_BADGE_VARIANT: Readonly<Record<ExportPhase, ExportPhaseBadgeVariant>> =
  Object.freeze({
    queued: "secondary",
    processing: "running",
    ready: "succeeded",
    failed: "failed",
  });

// ---------------------------------------------------------------------------
// Request building — §13.1 POST body from the dialog's form draft
// ---------------------------------------------------------------------------

/** What the dialog form holds (strings so inputs stay simple). */
export interface ExportRequestDraft {
  readonly format: ExportFormat;
  /** Blank = document width (the gateway defaults missing sides, §10.3). */
  readonly width: string;
  readonly height: string;
  /** 1..100 (EXPORT_QUALITY_MIN..MAX) — slider value. */
  readonly quality: number;
  /** §2.3 feature flag — psd requests are refused client-side until enabled. */
  readonly psdEnabled: boolean;
}

/** §13.1 POST /documents/:id/exports body — exact field names, no extras. */
export interface ExportCreateRequestBody {
  readonly format: ExportFormat;
  readonly width?: number;
  readonly height?: number;
  readonly quality?: number;
}

export interface ExportRequestFailure {
  readonly ok: false;
  readonly code: "psd_disabled" | "invalid_width" | "invalid_height" | "invalid_quality";
  readonly message: string;
  readonly hint: string;
}

export type ExportRequestResult =
  | { readonly ok: true; readonly body: ExportCreateRequestBody }
  | ExportRequestFailure;

/** Digits only → safe integer in 1..MAX_EXPORT_SIDE_PX; "" → undefined. */
function parsePixelSide(
  raw: string,
): { readonly ok: true; readonly value: number | undefined } | { readonly ok: false } {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: true, value: undefined };
  }
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false };
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_EXPORT_SIDE_PX) {
    return { ok: false };
  }
  return { ok: true, value };
}

/**
 * Validate + build the enqueue body. Quality rides only for jpg — PNG is
 * lossless (§10.3), and .pcraft/psd have no raster quality knob. Dimension
 * errors quote the §13.1 bounds the gateway schema enforces.
 */
export function buildExportRequest(draft: ExportRequestDraft): ExportRequestResult {
  if (draft.format === "psd" && !draft.psdEnabled) {
    return {
      ok: false,
      code: "psd_disabled",
      message: "PSD export is experimental and currently disabled.",
      hint: "PSD ships best-effort with a fidelity report behind a feature flag.",
    };
  }
  const width = parsePixelSide(draft.width);
  if (!width.ok) {
    return {
      ok: false,
      code: "invalid_width",
      message: `Width must be a whole number of pixels between 1 and ${MAX_EXPORT_SIDE_PX}.`,
      hint: "Leave it empty to export at the document's width.",
    };
  }
  const height = parsePixelSide(draft.height);
  if (!height.ok) {
    return {
      ok: false,
      code: "invalid_height",
      message: `Height must be a whole number of pixels between 1 and ${MAX_EXPORT_SIDE_PX}.`,
      hint: "Leave it empty to export at the document's height.",
    };
  }
  if (
    draft.format === "jpg" &&
    (!Number.isSafeInteger(draft.quality) ||
      draft.quality < EXPORT_QUALITY_MIN ||
      draft.quality > EXPORT_QUALITY_MAX)
  ) {
    return {
      ok: false,
      code: "invalid_quality",
      message: `Quality must be between ${EXPORT_QUALITY_MIN} and ${EXPORT_QUALITY_MAX}.`,
      hint: "Use the slider — it stays inside the allowed range.",
    };
  }
  const body: ExportCreateRequestBody = { format: draft.format };
  if (width.value !== undefined) {
    body.width = width.value;
  }
  if (height.value !== undefined) {
    body.height = height.value;
  }
  if (draft.format === "jpg") {
    body.quality = draft.quality;
  }
  return { ok: true, body };
}

// ---------------------------------------------------------------------------
// Poll loop decision — bounded, pure (use-exports.ts owns the async plumbing)
// ---------------------------------------------------------------------------

export type ExportPollDecision =
  | "continue"
  | "stop-ready"
  | "stop-failed"
  | "stop-budget"
  | "stop-hard-error";

/** Everything the decision needs after one poll tick. */
export interface ExportPollState {
  /** Ticks consumed so far, including the one being decided on. */
  readonly polls: number;
  readonly maxPolls: number;
  /** Latest list hit for the export id; null when the row is not listed yet. */
  readonly item: ExportListItem | null;
  /** Latest list-call error, if any (ApiError envelope from lib/api.ts). */
  readonly error: unknown;
}

/**
 * One pure tick decision for the 2 s poll loop:
 *   - terminal wire statuses stop the loop (ready/failed);
 *   - 4xx (except 429) cannot get better with retries — stop with the error;
 *   - the poll budget bounds the loop (5 min) even if the job never lands;
 *   - transient 5xx/429/network misses keep polling while the budget lasts.
 */
export function nextExportPollAction(state: ExportPollState): ExportPollDecision {
  if (state.item !== null) {
    if (state.item.status === "succeeded") {
      return "stop-ready";
    }
    if (state.item.status === "failed") {
      return "stop-failed";
    }
  }
  if (
    isApiError(state.error) &&
    state.error.status >= 400 &&
    state.error.status < 500 &&
    state.error.status !== 429
  ) {
    return "stop-hard-error";
  }
  if (state.polls >= state.maxPolls) {
    return "stop-budget";
  }
  return "continue";
}

// ---------------------------------------------------------------------------
// Job views — client-side shape the dialog renders (mini-history + live polls)
// ---------------------------------------------------------------------------

export interface ExportJobView {
  readonly exportId: string;
  readonly format: ExportFormat;
  readonly revision: number;
  readonly phase: ExportPhase;
  readonly width: number | null;
  readonly height: number | null;
  readonly quality: number | null;
  readonly createdAt: string;
  /** Fresh signed URL once ready (§13.1; re-signed on every list read). */
  readonly url: string | null;
  readonly expiresAt: string | null;
  /** Envelope-derived text on failure; null otherwise. */
  readonly error: string | null;
  /** Poll budget exhausted while the job was still processing (bounded loop). */
  readonly pollBudgetExhausted: boolean;
  /** §2.3 psd warnings echoed by the enqueue reply; [] for other formats. */
  readonly warnings: readonly string[];
}

/** Map one wire list item onto the view, preserving loop-local flags. */
export function toExportJobView(
  item: ExportListItem,
  previous?: Readonly<ExportJobView>,
): ExportJobView {
  return {
    exportId: item.export_id,
    format: item.format,
    revision: item.revision,
    phase: exportPhase(item.status),
    width: item.width,
    height: item.height,
    quality: item.quality,
    createdAt: item.created_at,
    url: item.url ?? null,
    expiresAt: item.expires_at ?? null,
    error: previous?.error ?? null,
    pollBudgetExhausted: previous?.pollBudgetExhausted ?? false,
    warnings: previous?.warnings ?? [],
  };
}

/** Newest first (ISO strings compare lexically); stable tiebreak on export id. */
export function compareExportJobsNewestFirst(a: ExportJobView, b: ExportJobView): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? 1 : -1;
  }
  return a.exportId < b.exportId ? 1 : -1;
}

/** Upsert one job into the mini-history (replace in place, prepend new rows). */
export function upsertExportJob(
  jobs: readonly ExportJobView[],
  job: ExportJobView,
): ExportJobView[] {
  const without = jobs.filter((current) => current.exportId !== job.exportId);
  return [job, ...without].sort(compareExportJobsNewestFirst);
}

/** Suggested download filename — `export-r4.png` (revision + §10.3 suffix). */
export function exportFileName(job: Pick<ExportJobView, "format" | "revision">): string {
  return `export-r${job.revision}${EXPORT_FILE_SUFFIX[job.format] ?? ""}`;
}

// ---------------------------------------------------------------------------
// Envelope → user text (client-side twin of editor-model errorText, owned here
// so flows stay self-contained; never leaks codes/paths/stack)
// ---------------------------------------------------------------------------

/** ApiError → "message — hint"; anything else → the friendly fallback. */
export function flowErrorText(error: unknown, fallback: string): string {
  if (isApiError(error)) {
    return error.hint === undefined ? error.message : `${error.message} — ${error.hint}`;
  }
  return fallback;
}
