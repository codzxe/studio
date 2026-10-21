// @studio/gateway — exports + preview service (§13.1). Owner: W4-L.
//
// Spec anchors:
//   §13.1 POST /v1/documents/:id/exports  { format: pcraft|png|jpg|psd,
//          width?, height?, quality? } → job → URL (202 { export_id, status })
//   §13.1 GET  /v1/documents/:id/exports  past exports for the document
//   §13.1 GET  /v1/documents/:id/preview?w=1024 — cached preview PNG behind a
//          signed URL; the (document, width, revision) triple IS the cache
//          identity (apps/worker/src/preview.ts, W2-N)
//   §2.3   PSD export ships experimental (engine issues #1281/#2469) —
//          PSD requests are accepted with the §2.3 warning text in the
//          response; the worker (render-jobs.ts, W2-N) currently refuses psd
//          with the typed `experimental_psd` error, so the job will land as
//          failed until that flag flips — surfaced here as a warning, never
//          as a silent success
//   §14.1  plan MP ceiling 32/64/128 (@studio/config PLAN_LIMITS) — enforced
//          BEFORE any enqueue, mirroring the worker's gate (§3.1 worker)
//   §15.1  cross-tenant lookups are 404 == missing (composite org+id queries)
//   §3.4   jobId = idempotencyKey so duplicate enqueues cannot double-render
//
// SEAMS (all injectable; routes/exports.ts only maps HTTP):
//   ExportDocumentsLike — composite org+id document lookup (documents table)
//   ExportsLike         — queue producer seam (BullMQ `exports` queue); wrap
//                         real adapters in withIdempotentEnqueue() below
//   PreviewCacheLike    — cached-preview lookup; cache WRITES happen in the
//                         worker (W2-N PreviewPipeline), never here — the seam
//                         is read-only by design
//   ObjectUrlSignerLike — storage adapter's `sign` (mirrors @studio/storage
//                         Storage.sign { ttlSeconds } structurally; preview.ts
//                         precedent)
//   ExportStatusLike    — export job status/history rows. TODO(worker wiring):
//                         NO exports table exists in @studio/db (W1-D/F own the
//                         schema; DO NOT invent tables), so the production
//                         implementation is deferred to the wave that lands the
//                         worker-side export lifecycle store. Until then the
//                         route answers 200 with an empty list.
//
// Purity: no BullMQ / storage-SDK imports — everything is injected; unit tests
// run on fakes only (apps/gateway/tests/exports.test.ts).

import { err, ok, type PlanId, planLimits, type Result } from "@studio/config";
import { type Db, documents as documentsTable } from "@studio/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Mirrored worker contract (apps/worker/src/queues.ts, W1-I/W2-N — gateway
// must not import across apps; byte-for-byte mirrors like services/runs.ts)
// ---------------------------------------------------------------------------

/** §13.1 export formats — mirrors `EXPORT_FORMATS` in apps/worker/src/queues.ts. */
export const EXPORT_FORMATS = ["pcraft", "png", "jpg", "psd"] as const satisfies readonly string[];

export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Runtime guard: is `value` one of the wire-stable export formats? */
export function isExportFormat(value: unknown): value is ExportFormat {
  return typeof value === "string" && (EXPORT_FORMATS as readonly string[]).includes(value);
}

/** §3.1 queue name — mirrors `QUEUE_NAMES.exports` in apps/worker/src/queues.ts. */
export const EXPORTS_QUEUE_NAME = "exports";

/**
 * Signed export/preview URLs live at most 15 minutes (§13; mirrors
 * PREVIEW_URL_TTL_SECONDS / EXPORT_URL_TTL_SECONDS in apps/worker).
 */
export const PREVIEW_URL_TTL_SECONDS = 900;

/** §13.1 default preview width: `GET /v1/documents/:id/preview?w=1024`. */
export const DEFAULT_PREVIEW_WIDTH = 1024;

/** Preview key edge bound — mirrors MAX_PREVIEW_WIDTH in packages/storage keys.ts. */
export const MAX_PREVIEW_WIDTH = 4096;

/** Per-side pixel bound — mirrors exportJobPayloadSchema width/height max. */
export const MAX_EXPORT_SIDE_PX = 8192;

/** JPEG quality bounds — mirrors exportJobPayloadSchema quality 1..100. */
export const EXPORT_QUALITY_MIN = 1;
export const EXPORT_QUALITY_MAX = 100;

// ---------------------------------------------------------------------------
// §2.3 PSD experimental warning — verbatim anchor for the response surface
// ---------------------------------------------------------------------------

/**
 * §2.3 warning text (quoted from the spec's known-engine-reality paragraph):
 * PSD writes are not yet reliably accepted by Photoshop (engine issues
 * #1281/#2469), so native `.pcraft` is the primary output and the only format
 * promised as round-trip-perfect; PSD export ships with a warning label and a
 * fidelity report. Returned in `warnings` for every psd request.
 */
export const PSD_EXPERIMENTAL_WARNING =
  "PSD export is experimental: Photoshop acceptance is not yet reliable " +
  "(engine issues #1281, #2469), so it ships with a warning label and a fidelity " +
  "report. The layered .pcraft format is the primary output and the only format " +
  "promised as round-trip-perfect (§2.3).";

// ---------------------------------------------------------------------------
// Format → MIME map (artifact content types for the storage adapter)
// ---------------------------------------------------------------------------

/** Content type per export format (`.pcraft` rides §10.3 octet-stream like documents). */
export const EXPORT_MIME_BY_FORMAT: Readonly<Record<ExportFormat, string>> = Object.freeze({
  pcraft: "application/octet-stream",
  png: "image/png",
  jpg: "image/jpeg",
  psd: "image/vnd.adobe.photoshop",
});

/** MIME for one format; throws never — callers pass a schema-validated format. */
export function exportMime(format: ExportFormat): string {
  return EXPORT_MIME_BY_FORMAT[format] ?? "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Plan MP ceiling (§14.1) — pure gate before any enqueue
// ---------------------------------------------------------------------------

export interface ExportMegapixelCheck {
  /** The same value in megapixels (§14.1 decimal MP units). */
  readonly megapixels: number;
}

/**
 * Gate export dimensions against the workspace plan ceiling (§14.1: 32/64/128 MP
 * from @studio/config PLAN_LIMITS). Each dimension is compared against the
 * ceiling too, which keeps `width * height` exact — dimensions that pass are
 * ≤ 128,000,000, so the product never leaves the exactly-representable range
 * of a double. Mirrors `checkExportMegapixels` in apps/worker/src/render-jobs.ts
 * (W2-N) — the worker re-checks with the same math, so the two gates cannot
 * disagree; catalog codes map plan_limit → HTTP 402 (§13.3).
 */
export function checkExportMegapixels(
  width: number,
  height: number,
  plan: PlanId,
  subject = "canvas",
): Result<ExportMegapixelCheck> {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    return err("validation_failed", `${subject} dimensions must be positive integers`, {
      hint: `width and height must be whole pixels between 1 and ${MAX_EXPORT_SIDE_PX}.`,
      retryable: false,
    });
  }
  const limits = planLimits(plan);
  const ceilingPixels = limits.maxCanvasMegapixels * 1_000_000; // §14.1 decimal MP
  const pixels = width * height;
  if (width > ceilingPixels || height > ceilingPixels || pixels > ceilingPixels) {
    return err(
      "plan_limit",
      `${subject} of ${width}×${height} px exceeds the ${limits.maxCanvasMegapixels} MP ` +
        `ceiling of the ${plan} plan`,
      {
        hint: "Export a smaller canvas or upgrade the workspace plan (§14.1).",
        retryable: false,
      },
    );
  }
  return ok({ megapixels: pixels / 1_000_000 });
}

// ---------------------------------------------------------------------------
// Wire schemas (Zod at every boundary, docs/AGENTS.md)
// ---------------------------------------------------------------------------

const idSchema = z.string().trim().min(1).max(200);

/** §13: every mutating endpoint requires an Idempotency-Key (or body field). */
export const IDEMPOTENCY_KEY_SCHEMA = z.string().trim().min(1).max(128);

/** GET /v1/documents/:id param — opaque document id. */
export const DOCUMENT_ID_SCHEMA = idSchema;

/** POST /v1/documents/:id/exports body (§13.1 exact field names, .strict()). */
export const EXPORT_CREATE_BODY_SCHEMA = z
  .object({
    format: z.enum(EXPORT_FORMATS),
    width: z.number().int().min(1).max(MAX_EXPORT_SIDE_PX).optional(),
    height: z.number().int().min(1).max(MAX_EXPORT_SIDE_PX).optional(),
    quality: z.number().int().min(EXPORT_QUALITY_MIN).max(EXPORT_QUALITY_MAX).optional(),
    /** Optional body twin of the Idempotency-Key header; both must agree. */
    idempotency_key: IDEMPOTENCY_KEY_SCHEMA.optional(),
  })
  .strict();

export type ExportCreateBody = z.infer<typeof EXPORT_CREATE_BODY_SCHEMA>;

/** GET /v1/documents/:id/exports query — non-strict: extra params are ignored. */
export const EXPORT_LIST_QUERY_SCHEMA = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** GET /v1/documents/:id/preview query — §13.1 `?w=1024`. */
export const PREVIEW_QUERY_SCHEMA = z.object({
  w: z.coerce.number().int().min(1).max(MAX_PREVIEW_WIDTH).default(DEFAULT_PREVIEW_WIDTH),
});

// ---------------------------------------------------------------------------
// Document lookup seam — composite org+id (§12.2, never find-then-check)
// ---------------------------------------------------------------------------

/** The document subset export/preview handling needs. */
export interface ExportDocument {
  readonly id: string;
  readonly organizationId: string;
  /** Canvas size in px (§10.3) — the export default dimensions. */
  readonly widthPx: number;
  readonly heightPx: number;
  /** §5.6 monotonic revision — pinned into the export job payload. */
  readonly currentRevision: number;
  readonly archived: boolean;
}

/**
 * §12.2 composite org+id lookup. Implementations MUST scope by organization so
 * a foreign document is indistinguishable from a missing one (§15.1: never
 * confirm existence across tenants).
 */
export interface ExportDocumentsLike {
  get(organizationId: string, documentId: string): Promise<ExportDocument | null>;
}

/** Drizzle-backed production implementation over the @studio/db documents table. */
export function drizzleExportDocuments(db: Db): ExportDocumentsLike {
  return {
    async get(organizationId, documentId) {
      const rows = await db
        .select({
          id: documentsTable.id,
          organizationId: documentsTable.organizationId,
          widthPx: documentsTable.widthPx,
          heightPx: documentsTable.heightPx,
          currentRevision: documentsTable.currentRevision,
          archivedAt: documentsTable.archivedAt,
        })
        .from(documentsTable)
        .where(
          and(
            eq(documentsTable.organizationId, organizationId),
            eq(documentsTable.id, documentId),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      return {
        id: row.id,
        organizationId: row.organizationId,
        widthPx: row.widthPx,
        heightPx: row.heightPx,
        currentRevision: row.currentRevision,
        archived: row.archivedAt !== null,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Enqueue seam — BullMQ `exports` queue producer (§3.1, jobId = §3.4 key)
// ---------------------------------------------------------------------------

/**
 * Export job payload. The first seven fields are the W4-L task contract; the
 * last three satisfy the worker contract and are REQUIRED there:
 *   - `idempotencyKey` — apps/worker exportJobPayloadSchema (queues.ts) REQUIRES
 *     it in the payload, and W2-N's exportJobRequestSchema (render-jobs.ts)
 *     additionally requires `revision` + `plan` (the processor re-checks the
 *     §14.1 ceiling and keys the artifact `export-<idem>-r<revision>`).
 * Unknown extras (none today) are stripped by the worker's Zod objects.
 */
export interface ExportJobPayload {
  readonly documentId: string;
  readonly format: ExportFormat;
  readonly width?: number;
  readonly height?: number;
  readonly quality?: number;
  readonly organizationId: string;
  /** §22 correlation — echoes X-Request-Id into the job for worker-side logs. */
  readonly requestId: string;
  readonly idempotencyKey: string;
  /** §5.6 document revision at enqueue time (W2-N caller-owned parameter). */
  readonly revision: number;
  /** §14.1 caller plan — the worker's own MP gate reads it (§3.1 defense in depth). */
  readonly plan: PlanId;
}

export interface EnqueueOptions {
  /** §3.4 idempotency: the BullMQ jobId — duplicate adds cannot double-render. */
  readonly jobId: string;
}

export interface EnqueuedJob {
  readonly jobId: string;
}

export interface ExportsLike {
  /**
   * Adds one job to a queue. Producers pass `jobId: idempotencyKey` (the
   * worker contract comment in queues.ts) so retries cannot double-render or
   * double-charge. Failures are typed results, never throws.
   */
  enqueue(
    queue: string,
    payload: ExportJobPayload,
    options: EnqueueOptions,
  ): Promise<Result<EnqueuedJob>>;
}

/** Memo entries beyond this many fall off oldest-first (bounded memory). */
export const EXPORT_ENQUEUE_MEMO_LIMIT = 10_000;

interface MemoizedEnqueue {
  readonly organizationId: string;
  readonly result: Promise<Result<EnqueuedJob>>;
}

/**
 * Idempotent enqueue wrapper (§3.4): the same (queue, jobId) returns the same
 * job — concurrent replays share one in-flight promise, and settled successes
 * are memoized so a retried POST with the same key never re-adds. Failures are
 * evicted so a retry can re-enqueue once the broker recovers; a key reused by
 * a DIFFERENT organization is rejected with `conflict` (BullMQ jobIds are
 * per-queue unique, i.e. global across tenants — same discipline as the
 * agent_runs idempotency_key UNIQUE, W4-G). The broker's own jobId dedupe
 * remains the durable backstop for replays that cross process boundaries.
 */
export function withIdempotentEnqueue(inner: ExportsLike): ExportsLike {
  const memo = new Map<string, MemoizedEnqueue>();
  return {
    async enqueue(queue, payload, options) {
      const memoKey = `${queue}\u0000${options.jobId}`;
      const existing = memo.get(memoKey);
      if (existing !== undefined) {
        if (existing.organizationId !== payload.organizationId) {
          return err("conflict", "This idempotency key is already in use.", {
            hint: "Idempotency keys are global; generate a fresh unique key.",
            retryable: false,
          });
        }
        return existing.result;
      }
      if (memo.size >= EXPORT_ENQUEUE_MEMO_LIMIT) {
        const oldest = memo.keys().next();
        if (!oldest.done) {
          memo.delete(oldest.value);
        }
      }
      const pending = inner.enqueue(queue, payload, options);
      memo.set(memoKey, { organizationId: payload.organizationId, result: pending });
      const settled = await pending;
      if (!settled.ok) {
        // Retryable broker failure: forget the key so the next attempt can add.
        memo.delete(memoKey);
      }
      return settled;
    },
  };
}

// ---------------------------------------------------------------------------
// Preview cache + signer seams — cache WRITES happen in the worker (W2-N)
// ---------------------------------------------------------------------------

/** One cached preview: the stored PNG's key + the revision it was rendered at. */
export interface CachedPreview {
  readonly storageKey: string;
  readonly revision: number;
}

/**
 * Read-only preview cache seam. The cache identity is the (document, width,
 * revision) triple (§13 preview.ts): the WORKER (W2-N PreviewPipeline) renders
 * and stores `renders/organizations/<org>/documents/<doc>/preview-<w>-<rev>.png`
 * after runs/opens; the gateway only LOOKS UP. Implementations MUST scope rows
 * to the caller's organization (worker-side wiring TODO) — resolvePreview()
 * additionally re-guards the returned storage key before signing.
 */
export interface PreviewCacheLike {
  get(documentId: string, width: number): Promise<CachedPreview | null>;
}

/** A signed object URL exactly as the storage adapter produces it. */
export interface SignedObjectUrl {
  readonly url: string;
  /** Epoch ms at which the signature stops being accepted. */
  readonly expiresAt: number;
}

/**
 * Storage signing seam — structural mirror of @studio/storage `Storage.sign`
 * (SignOptions { ttlSeconds } → { url, expiresAt }); the composition root
 * adapts the real adapter (preview.ts ObjectStorage precedent). Signing is
 * per-request (15-minute TTL, §13) so URLs are never persisted.
 */
export interface ObjectUrlSignerLike {
  sign(
    storageKey: string,
    options: { readonly ttlSeconds: number },
  ): Promise<Result<SignedObjectUrl>>;
}

/**
 * §15.1 tenant guard for a cache-returned preview key: the documented preview
 * key layout is `renders/organizations/<org>/documents/<doc>/preview-…` (packages/
 * storage src/keys.ts), so the key must sit inside the caller's own prefix.
 * Pure string prefix check — no storage import (gateway package has no
 * @studio/storage dep; mirror documented in the header).
 */
export function previewKeyPrefix(organizationId: string, documentId: string): string {
  return `renders/organizations/${organizationId}/documents/${documentId}/`;
}

// ---------------------------------------------------------------------------
// Export status seam — list past exports (worker-side TODO wiring)
// ---------------------------------------------------------------------------

/** Wire-stable export job lifecycle (POST answers `queued`; BullMQ maps onto it). */
export const EXPORT_JOB_STATUSES = ["queued", "running", "succeeded", "failed"] as const satisfies
  readonly string[];

export type ExportJobStatus = (typeof EXPORT_JOB_STATUSES)[number];

/**
 * One export job row as the (future) worker-side lifecycle store records it.
 * `storageKey` is present once the artifact exists (succeeded) — it enables
 * fresh 15-minute signed URLs on read; the raw key itself never leaves the box.
 */
export interface ExportRecord {
  readonly exportId: string;
  readonly documentId: string;
  readonly organizationId: string;
  readonly format: ExportFormat;
  readonly status: ExportJobStatus;
  readonly revision: number;
  readonly width?: number;
  readonly height?: number;
  readonly quality?: number;
  readonly storageKey?: string;
  readonly createdAt: Date;
  readonly finishedAt?: Date;
}

/**
 * Export job status/history seam. TODO(worker wiring): there is NO exports
 * table in @studio/db today (schema owned by W1-D/F; tables are not invented
 * by route owners), so the production implementation — over the table the
 * export-lifecycle wave lands — is deliberately deferred. Until then callers
 * inject an empty in-memory implementation and GET /exports answers 200 [].
 * Implementations MUST scope rows by organization (§12.2 composite queries).
 */
export interface ExportStatusLike {
  list(
    organizationId: string,
    documentId: string,
    options: { readonly limit: number },
  ): Promise<readonly ExportRecord[]>;
}

// ---------------------------------------------------------------------------
// Service aggregate injected into the route
// ---------------------------------------------------------------------------

export interface ExportsDeps {
  /** Composite org+id document lookup (drizzleExportDocuments in production). */
  readonly documents: ExportDocumentsLike;
  /** Queue producer — wrap the real adapter in withIdempotentEnqueue(). */
  readonly enqueue: ExportsLike;
  /** Read-only preview cache (worker W2-N writes it; gateway reads it). */
  readonly previewCache: PreviewCacheLike;
  /** Storage adapter `sign` (fresh ≤15-min URLs, never persisted). */
  readonly signer: ObjectUrlSignerLike;
  /** Export history (worker-side TODO wiring; see ExportStatusLike). */
  readonly status: ExportStatusLike;
}

// ---------------------------------------------------------------------------
// POST — validate → tenant lookup → §14.1 gates → enqueue (jobId = §3.4 key)
// ---------------------------------------------------------------------------

export interface CreateExportInput {
  readonly organizationId: string;
  readonly documentId: string;
  readonly body: ExportCreateBody;
  /** Resolved from the Idempotency-Key header / idempotency_key body field. */
  readonly idempotencyKey: string;
  /** §22 correlation id (X-Request-Id) — rides in the job payload. */
  readonly requestId: string;
  /** Caller plan — selects the §14.1 MP ceiling and is pinned into the job. */
  readonly plan: PlanId;
}

export interface ExportQueued {
  /** The job id — the §3.4 idempotency key, so replays echo the same value. */
  readonly exportId: string;
  readonly status: "queued";
  readonly revision: number;
  /** §2.3 PSD experimental warning for psd; empty for the other formats. */
  readonly warnings: readonly string[];
}

export async function createExportJob(
  deps: ExportsDeps,
  input: CreateExportInput,
): Promise<Result<ExportQueued>> {
  const { body } = input;

  if (!isExportFormat(body.format)) {
    // Defense in depth — the route schema already guards this (§4 boundary).
    return err("validation_failed", "The export format is not supported.", {
      hint: `format must be one of: ${EXPORT_FORMATS.join("|")}.`,
      retryable: false,
    });
  }

  // §12.2 composite org+id lookup: a foreign document is indistinguishable
  // from a missing one — never confirm existence across tenants (§15.1).
  const document = await deps.documents.get(input.organizationId, input.documentId);
  if (document === null) {
    return err("not_found", "Document not found.", {
      hint: "Check the document id within your workspace.",
      retryable: false,
    });
  }
  if (document.archived) {
    return err("conflict", "This document is archived; exports run on active documents only.", {
      hint: "Restore the document first (§10.1).",
      retryable: false,
    });
  }

  // §14.1 plan MP ceiling BEFORE any enqueue — mirrors the worker's own gate
  // (render-jobs.ts): the canvas itself, then the requested target when the
  // request overrides one or both dimensions (missing sides default to the
  // canvas side, exactly like processExportJob).
  const canvasCheck = checkExportMegapixels(
    document.widthPx,
    document.heightPx,
    input.plan,
    "canvas",
  );
  if (!canvasCheck.ok) {
    return canvasCheck;
  }
  if (body.width !== undefined || body.height !== undefined) {
    const targetCheck = checkExportMegapixels(
      body.width ?? document.widthPx,
      body.height ?? document.heightPx,
      input.plan,
      "requested export size",
    );
    if (!targetCheck.ok) {
      return targetCheck;
    }
  }

  const warnings =
    body.format === "psd"
      ? [PSD_EXPERIMENTAL_WARNING] // §2.3 — the worker refuses psd for now (W2-N)
      : [];

  // §3.1/§3.4: one job on the `exports` queue, jobId = idempotency key, so
  // duplicate enqueues cannot double-render. The payload satisfies BOTH the
  // worker's base schema (idempotencyKey required) and the W2-N processor's
  // request schema (organizationId/revision/plan required) — see ExportJobPayload.
  const enqueued = await deps.enqueue.enqueue(
    EXPORTS_QUEUE_NAME,
    {
      documentId: input.documentId,
      format: body.format,
      ...(body.width !== undefined ? { width: body.width } : {}),
      ...(body.height !== undefined ? { height: body.height } : {}),
      ...(body.quality !== undefined ? { quality: body.quality } : {}),
      organizationId: input.organizationId,
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      revision: document.currentRevision,
      plan: input.plan,
    },
    { jobId: input.idempotencyKey },
  );
  if (!enqueued.ok) {
    // No row was written, no artifact was minted — the client may retry with
    // the same key (failures are evicted from the idempotency memo).
    return enqueued;
  }

  const queued: ExportQueued = {
    exportId: enqueued.value.jobId,
    status: "queued",
    revision: document.currentRevision,
    warnings,
  };
  return ok(queued);
}

// ---------------------------------------------------------------------------
// GET preview — cached lookup → sign (§13.1; cache writes are worker-side)
// ---------------------------------------------------------------------------

export interface PreviewQuery {
  readonly organizationId: string;
  readonly documentId: string;
  /** §13.1 `?w=1024` — the cache identity's width component. */
  readonly width: number;
}

export type PreviewResolution =
  | {
      readonly found: true;
      readonly url: string;
      readonly revision: number;
      readonly expiresAt: number;
    }
  | {
      /** Cache miss — nothing has been rendered for this (document, width) yet. */
      readonly found: false;
      readonly reason: "not_cached";
    };

export async function resolvePreview(
  deps: ExportsDeps,
  query: PreviewQuery,
): Promise<Result<PreviewResolution>> {
  // §12.2/§15.1 composite lookup: unknown + cross-tenant both answer not_found.
  const document = await deps.documents.get(query.organizationId, query.documentId);
  if (document === null) {
    return err("not_found", "Document not found.", {
      hint: "Check the document id within your workspace.",
      retryable: false,
    });
  }
  // Note: archived documents still serve previews — archive hides a document
  // from listings (§12.2) but does not revoke direct reads of rendered bytes.

  const cached = await deps.previewCache.get(query.documentId, query.width);
  if (cached === null) {
    // Cache-write is the worker's job (W2-N PreviewPipeline after open/run) —
    // the route turns this into 404 preview_not_rendered with a hint.
    const miss: PreviewResolution = { found: false, reason: "not_cached" };
    return ok(miss);
  }

  // §15.1 defense in depth: the seam is org-scoped by contract, but the key is
  // re-guarded before it is signed so a buggy cache can never mint a URL for
  // another tenant's object.
  if (!cached.storageKey.startsWith(previewKeyPrefix(query.organizationId, query.documentId))) {
    return err("internal_error", "The preview cache returned a foreign object.", {
      hint: "The preview cache implementation is misconfigured; the incident is logged.",
      retryable: true,
    });
  }
  if (!Number.isSafeInteger(cached.revision) || cached.revision < 0) {
    return err("internal_error", "The preview cache returned an invalid revision.", {
      hint: "The preview cache implementation is misconfigured; the incident is logged.",
      retryable: true,
    });
  }

  const signed = await deps.signer.sign(cached.storageKey, {
    ttlSeconds: PREVIEW_URL_TTL_SECONDS, // §13: signed preview URLs live ≤15 min
  });
  if (!signed.ok) {
    return err("storage_error", "The signed preview URL could not be produced.", {
      hint: "Object storage rejected the signing request; retry shortly.",
      retryable: true,
    });
  }

  const hit: PreviewResolution = {
    found: true,
    url: signed.value.url,
    revision: cached.revision,
    expiresAt: signed.value.expiresAt,
  };
  return ok(hit);
}

// ---------------------------------------------------------------------------
// GET exports — list past export jobs (worker-side TODO wiring)
// ---------------------------------------------------------------------------

export interface ListExportsInput {
  readonly organizationId: string;
  readonly documentId: string;
  readonly limit: number;
}

/** §13.1 list item — snake_case wire fields; storage keys never leave the box. */
export interface ExportApiView {
  readonly export_id: string;
  readonly format: ExportFormat;
  readonly status: ExportJobStatus;
  readonly revision: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly quality: number | null;
  readonly created_at: string;
  readonly finished_at: string | null;
  /** Present for succeeded exports with a stored artifact (fresh 15-min sign). */
  readonly url: string | null;
  readonly expires_at: string | null;
}

export interface ExportListing {
  readonly exports: readonly ExportApiView[];
}

export async function listExports(
  deps: ExportsDeps,
  input: ListExportsInput,
): Promise<Result<ExportListing>> {
  // §12.2/§15.1 composite lookup first: unknown + cross-tenant both 404.
  const document = await deps.documents.get(input.organizationId, input.documentId);
  if (document === null) {
    return err("not_found", "Document not found.", {
      hint: "Check the document id within your workspace.",
      retryable: false,
    });
  }

  const records = await deps.status.list(input.organizationId, input.documentId, {
    limit: input.limit,
  });

  const views: ExportApiView[] = [];
  for (const record of records) {
    // Fresh 15-minute URL for finished artifacts (§13); a signing hiccup skips
    // the URL for that row rather than failing the whole listing.
    let url: string | null = null;
    let expiresAt: string | null = null;
    if (record.status === "succeeded" && record.storageKey !== undefined) {
      const signed = await deps.signer.sign(record.storageKey, {
        ttlSeconds: PREVIEW_URL_TTL_SECONDS,
      });
      if (signed.ok) {
        url = signed.value.url;
        expiresAt = new Date(signed.value.expiresAt).toISOString();
      }
    }
    views.push({
      export_id: record.exportId,
      format: record.format,
      status: record.status,
      revision: record.revision,
      width: record.width ?? null,
      height: record.height ?? null,
      quality: record.quality ?? null,
      created_at: record.createdAt.toISOString(),
      finished_at: record.finishedAt === undefined ? null : record.finishedAt.toISOString(),
      url,
      expires_at: expiresAt,
    });
  }
  return ok({ exports: views });
}
