/**
 * Export job processor (W2-N): the BullMQ `exports` queue processor shape
 * (§3.1 worker; §13.1 `POST /v1/documents/:id/exports` → job → URL).
 *
 * Per-format behaviour (§2.3 known engine reality):
 *   - `pcraft` — the layered native form and the only format promised as
 *     round-trip-perfect: `doc.save` to the session write root, read back, store.
 *   - `png` / `jpg` — full-size raster exports. `doc.render` is NOT used: §2.2
 *     caps automation previews at a 2048 px edge, so a full-size raster goes
 *     through `doc.save { path: "….png"|"….jpg" }` (rpc.rs exports by extension)
 *     which works for any canvas inside the plan ceiling. The §14.1 plan MP
 *     ceiling (32/64/128 MP, @studio/config PLAN_LIMITS) is enforced BEFORE any
 *     engine work; the engine's own §2.2 budgets stay server-side.
 *   - `psd` — experimental upstream (engine issues #1281/#2469: PSD writes are
 *     not yet reliably accepted by Photoshop). §2.3 ships PSD behind a warning
 *     label + a fidelity report once enabled; until then this processor refuses
 *     it with the typed `experimental_psd` error.
 *
 * Purity: NO BullMQ import — `processExportJob` accepts a generic job context
 * (src/index.ts maps a BullMQ Job onto it at the composition root). Engine and
 * storage are injected seams; unit tests run on fakes only.
 */

import { PLAN_ID_SCHEMA, type PlanId, planLimits } from "@studio/config";
import { z } from "zod";
import { type ObjectStorage, type SignedObjectUrl, errorText, isPng } from "./preview.js";
import { EXPORT_FORMATS, type ExportFormat } from "./queues.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Signed export URLs live at most 15 minutes (mirrors the preview §13 ttl). */
export const EXPORT_URL_TTL_SECONDS = 900;

/** JPEG signature — the first 3 bytes of every JPEG payload. */
export const JPEG_MAGIC = new Uint8Array([0xff, 0xd8, 0xff]);

// ---------------------------------------------------------------------------
// Error surface — typed result envelopes, never throws (docs/AGENTS.md)
// ---------------------------------------------------------------------------

/** Export-surface error codes. Add-only, stable strings (§13.3 discipline). */
export const EXPORT_ERROR_CODES = [
  "invalid_export_request", // the job payload failed its Zod schema or dims are invalid.
  "experimental_psd", // §2.3: PSD export is experimental and not enabled.
  "canvas_exceeds_plan_limit", // §14.1 plan MP ceiling exceeded before any engine work.
  "export_engine_failed", // inspect / save / read-back against the engine failed.
  "invalid_export_bytes", // the exported payload is empty or has the wrong signature.
  "export_store_failed", // object storage rejected the put.
  "export_sign_failed", // the signed URL could not be produced.
] as const satisfies readonly string[];

export type ExportErrorCode = (typeof EXPORT_ERROR_CODES)[number];

export interface ExportFailure {
  readonly ok: false;
  readonly code: ExportErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly retryable?: boolean;
  /** Verbatim cause (§5.7: engine output is data, never interpreted). */
  readonly data?: unknown;
}

export type ExportOutcome<T> = { readonly ok: true; readonly value: T } | ExportFailure;

interface ExportFailOptions {
  readonly hint?: string;
  readonly retryable?: boolean;
  readonly data?: unknown;
}

function exportFailure(
  code: ExportErrorCode,
  message: string,
  options: ExportFailOptions = {},
): ExportFailure {
  const failure: {
    ok: false;
    code: ExportErrorCode;
    message: string;
    hint?: string;
    retryable?: boolean;
    data?: unknown;
  } = { ok: false, code, message };
  if (options.hint !== undefined) {
    failure.hint = options.hint;
  }
  if (options.retryable !== undefined) {
    failure.retryable = options.retryable;
  }
  if (options.data !== undefined) {
    failure.data = options.data;
  }
  return failure;
}

// ---------------------------------------------------------------------------
// Engine seam — mirrors `EngineClient.inspectDocument`/`saveDocument`
// (packages/engine-client, W2-D) + the engine-pool's `readRootFile`, bound to one
// session at the composition root. Implementations throw on failure; the
// processor converts every throw into a typed envelope.
// ---------------------------------------------------------------------------

/** The `doc.inspect` subset an export needs (rpc.rs: width/height/revision). */
export interface EngineDocumentSummary {
  readonly width: number;
  readonly height: number;
  readonly revision: number;
}

/** `doc.save` request subset (rpc.rs: path + export-by-extension options). */
export interface EngineSaveInput {
  readonly path: string;
  readonly format?: string;
  readonly quality?: number;
}

/** `doc.save` reply (rpc.rs): the path written + any export warnings. */
export interface EngineSaveResult {
  readonly path: string;
  readonly warnings: readonly string[];
}

export interface ExportEngine {
  inspectDocument(): Promise<EngineDocumentSummary>;
  saveDocument(input: EngineSaveInput): Promise<EngineSaveResult>;
  readRootFile(path: string): Promise<Uint8Array>;
}

// ---------------------------------------------------------------------------
// Job request schema — Zod at every boundary (docs/AGENTS.md)
// ---------------------------------------------------------------------------

const keySegmentSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, "expected a key-segment-safe identifier");

/**
 * Export job payload. Extends `exportJobPayloadSchema` (src/queues.ts, W1-I:
 * format/width/height/quality/idempotencyKey with identical bounds) with the
 * worker-side context the processor needs: `organizationId` + `idempotencyKey`
 * become storage-key segments (so they are regex-guarded here), `plan` selects
 * the §14.1 MP ceiling, and `revision` is a required caller parameter — the
 * caller owns it (from `doc.inspect`/the version row); never guessed.
 */
export const exportJobRequestSchema = z.object({
  organizationId: keySegmentSchema,
  documentId: keySegmentSchema,
  format: z.enum(EXPORT_FORMATS),
  revision: z.number().int().min(0),
  plan: PLAN_ID_SCHEMA,
  width: z.number().int().min(1).max(8192).optional(),
  height: z.number().int().min(1).max(8192).optional(),
  quality: z.number().int().min(1).max(100).optional(),
  idempotencyKey: keySegmentSchema,
});

export type ExportJobRequest = z.infer<typeof exportJobRequestSchema>;

/**
 * Generic job context — the BullMQ processor shape without the BullMQ import.
 * `payload` is validated here (schema above); `signal` is forwarded by the
 * composition root's engine adapter (this processor performs no long waits of
 * its own).
 */
export interface ExportJobContext {
  readonly jobId: string;
  readonly payload: unknown;
  readonly attempt: number;
  readonly signal?: AbortSignal;
}

export interface ExportJobDependencies {
  readonly engine: ExportEngine;
  readonly storage: ObjectStorage;
}

// ---------------------------------------------------------------------------
// Storage keys — the documented export key-space
// ---------------------------------------------------------------------------

const KEY_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function keySegment(kind: string, value: string): string {
  if (!KEY_SEGMENT_PATTERN.test(value)) {
    throw new Error(`invalid ${kind} segment for a storage key`);
  }
  return value;
}

function keyNumber(kind: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid ${kind} number for a storage key`);
  }
  return value;
}

export interface ExportStorageKeyInput {
  readonly organizationId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly idempotencyKey: string;
  readonly format: ExportFormat;
}

/**
 * Object-storage key for one export artifact:
 *   - `pcraft` → `documents/organizations/<org>/documents/<doc>/export-<idem>-r<rev>.pcraft`
 *     (the layered document artifact)
 *   - `png`/`jpg` → `exports/organizations/<org>/documents/<doc>/export-<idem>-r<rev>.<ext>`
 *     (the raster deliverable)
 * Both share the `<kind>/organizations/<org>/documents/<doc>/<file>` prefix family
 * of the storage key-space (previewKey/exportKey in packages/storage, W2-M); the
 * idempotency key + revision make retries land on the same key (§3.4 idempotency:
 * a retried export overwrites, never duplicates).
 *
 * RECONCILIATION (packages/storage, W2-M — parallel): @studio/storage exports
 * `exportKey` with the same prefix family but a `<format>-<versionId>` file name;
 * when apps/worker adopts that builder, reconcile the suffix (versionId vs
 * idempotencyKey+revision) at the composition root.
 */
export function makeExportStorageKey(input: ExportStorageKeyInput): string {
  const organization = keySegment("organizationId", input.organizationId);
  const document = keySegment("documentId", input.documentId);
  const revision = keyNumber("revision", input.revision);
  const idempotencyKey = keySegment("idempotencyKey", input.idempotencyKey);
  const kind = input.format === "pcraft" ? "documents" : "exports";
  return `${kind}/organizations/${organization}/documents/${document}/export-${idempotencyKey}-r${revision}.${input.format}`;
}

// ---------------------------------------------------------------------------
// Plan MP ceiling (§14.1) — pure gate before any engine work
// ---------------------------------------------------------------------------

export interface CanvasBudgetCheck {
  /** The same value in megapixels (§14.1 decimal MP units). */
  readonly megapixels: number;
}

/**
 * Gate export dimensions against the workspace plan ceiling (§14.1: 32/64/128 MP
 * from @studio/config PLAN_LIMITS). Each dimension is compared against the
 * ceiling too, which keeps `width * height` exact — dimensions that pass are
 * ≤ 128,000,000, so the product never leaves the exactly-representable range of
 * a double. Mirrors the plan gate of `checkCanvasMegapixels`
 * (packages/engine-client budgets.ts, W2-B); the engine's own §2.2 budgets stay
 * server-side.
 */
export function checkExportMegapixels(
  width: number,
  height: number,
  plan: PlanId,
  subject = "canvas",
): ExportOutcome<CanvasBudgetCheck> {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    return exportFailure(
      "invalid_export_request",
      `${subject} dimensions must be positive integers`,
      {
        retryable: false,
      },
    );
  }
  const limits = planLimits(plan);
  const ceilingPixels = limits.maxCanvasMegapixels * 1_000_000; // §14.1 decimal MP
  const pixels = width * height;
  if (width > ceilingPixels || height > ceilingPixels || pixels > ceilingPixels) {
    return exportFailure(
      "canvas_exceeds_plan_limit",
      `${subject} of ${width}×${height} px exceeds the ${limits.maxCanvasMegapixels} MP ceiling of the ${plan} plan`,
      { hint: "export a smaller canvas or upgrade the workspace plan (§14.1)", retryable: false },
    );
  }
  return { ok: true, value: { megapixels: pixels / 1_000_000 } };
}

// ---------------------------------------------------------------------------
// processExportJob — pure orchestration over injected { engine, storage }
// ---------------------------------------------------------------------------

/**
 * The §13.1 export result the gateway returns once the job finishes: format,
 * signed URL (+ expiry), the storage key recorded on the export row (lifecycle /
 * retention), and every non-blocking warning surfaced to the user.
 */
export interface ExportResult {
  readonly format: ExportFormat;
  readonly url: string;
  readonly expiresAt: number;
  readonly storageKey: string;
  readonly warnings: readonly string[];
}

/** True only when the payload starts with the JPEG signature. */
export function isJpeg(bytes: Uint8Array): boolean {
  if (bytes.length < JPEG_MAGIC.length) {
    return false;
  }
  for (let index = 0; index < JPEG_MAGIC.length; index += 1) {
    if (bytes[index] !== JPEG_MAGIC[index]) {
      return false;
    }
  }
  return true;
}

/**
 * Process one export job. Never throws — every failure is a typed envelope
 * (BullMQ retries read `retryable`, §3.4). Flow:
 *
 *   zod-parse payload → refuse experimental psd (§2.3) → inspect canvas →
 *   plan MP gate (§14.1) → `doc.save` to the session write root (`save/…`) →
 *   read the bytes back → validate signature → storage put → signed URL.
 */
export async function processExportJob(
  deps: ExportJobDependencies,
  ctx: ExportJobContext,
): Promise<ExportOutcome<ExportResult>> {
  const parsed = exportJobRequestSchema.safeParse(ctx.payload);
  if (!parsed.success) {
    return exportFailure(
      "invalid_export_request",
      "the export job payload failed schema validation",
      {
        hint: parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
        retryable: false,
      },
    );
  }
  const request = parsed.data;

  if (request.format === "psd") {
    // §2.3: PSD export ships experimental (engine issues #1281/#2469) and, once
    // enabled, carries a warning label + a fidelity report. Refuse for now.
    return exportFailure(
      "experimental_psd",
      "PSD export is experimental and is not enabled for this job",
      {
        hint: "when enabled, PSD exports ship with a warning label and a fidelity report (§2.3); use the layered .pcraft format for a round-trip-perfect export",
        retryable: false,
      },
    );
  }

  const warnings: string[] = [];

  let canvas: EngineDocumentSummary;
  try {
    canvas = await deps.engine.inspectDocument();
  } catch (error) {
    return exportFailure(
      "export_engine_failed",
      "the engine document could not be inspected before export",
      {
        retryable: true,
        data: errorText(error),
      },
    );
  }

  const canvasCheck = checkExportMegapixels(canvas.width, canvas.height, request.plan);
  if (!canvasCheck.ok) {
    return canvasCheck;
  }

  if (request.width !== undefined || request.height !== undefined) {
    const targetCheck = checkExportMegapixels(
      request.width ?? canvas.width,
      request.height ?? canvas.height,
      request.plan,
      "requested export size",
    );
    if (!targetCheck.ok) {
      return targetCheck;
    }
    warnings.push(
      "requested export dimensions were validated against the plan ceiling; the engine exports at canvas size (resize ships with the resize tool)",
    );
  }

  // Full-size raster exports go through `doc.save` by extension (§2.2 caps
  // automation `doc.render` at a 2048 px edge); `save/` is a session capability
  // subdir (see @studio/engine-client capabilities.ts).
  const savePath = `save/export-${request.idempotencyKey}-r${request.revision}.${request.format}`;
  const saveInput: EngineSaveInput =
    request.format === "jpg" && request.quality !== undefined
      ? { path: savePath, quality: request.quality }
      : { path: savePath };
  if (request.quality !== undefined && request.format !== "jpg") {
    warnings.push("quality applies to JPEG exports only and was ignored for this lossless format");
  }

  let saved: EngineSaveResult;
  try {
    saved = await deps.engine.saveDocument(saveInput);
  } catch (error) {
    return exportFailure("export_engine_failed", "the engine failed to write the export file", {
      retryable: true,
      data: errorText(error),
    });
  }

  let bytes: Uint8Array;
  try {
    bytes = await deps.engine.readRootFile(saved.path);
  } catch (error) {
    return exportFailure(
      "export_engine_failed",
      "the export file could not be read back from the engine write root",
      { retryable: true, data: errorText(error) },
    );
  }

  if (bytes.byteLength === 0) {
    return exportFailure("invalid_export_bytes", "the export file was empty", { retryable: true });
  }
  if (request.format === "png" && !isPng(bytes)) {
    return exportFailure("invalid_export_bytes", "the PNG export did not carry the PNG signature", {
      retryable: false,
    });
  }
  if (request.format === "jpg" && !isJpeg(bytes)) {
    return exportFailure(
      "invalid_export_bytes",
      "the JPEG export did not carry the JPEG signature",
      {
        retryable: false,
      },
    );
  }
  // `.pcraft` is the engine's own layered format — no client-side magic to check.

  const storageKey = makeExportStorageKey(request);
  try {
    await deps.storage.put(storageKey, bytes);
  } catch (error) {
    return exportFailure("export_store_failed", "the export file could not be stored", {
      retryable: true,
      data: errorText(error),
    });
  }

  let signed: SignedObjectUrl;
  try {
    signed = await deps.storage.sign(storageKey, { ttlSeconds: EXPORT_URL_TTL_SECONDS });
  } catch (error) {
    return exportFailure("export_sign_failed", "the signed export URL could not be produced", {
      retryable: true,
      data: errorText(error),
    });
  }

  return {
    ok: true,
    value: {
      format: request.format,
      url: signed.url,
      expiresAt: signed.expiresAt,
      storageKey,
      warnings: [...saved.warnings, ...warnings],
    },
  };
}
