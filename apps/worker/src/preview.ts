/**
 * Preview pipeline (W2-N): render a downscaled document PNG through the engine's
 * `doc.render`, validate it against the §2.2 reply budgets, store it under the
 * deterministic preview key, and return a short-lived signed URL.
 *
 * Spec anchors:
 *   - §5.1 "observe after act": after each execution phase the agent loop renders
 *     a ≤1024 px PNG and feeds ONLY that downscaled render (+ the layer summary)
 *     back to the models — this module is that render's machinery.
 *   - §13.1 `GET /v1/documents/:id/preview?w=1024` — a cached PNG behind a signed
 *     URL; the (document, width, revision) triple IS the cache identity, so the
 *     same request always maps to the same storage key (idempotent re-put).
 *   - §2.2 reply budgets (vendor crates/automation/src/budgets.rs): PNG ≤ 5 MiB,
 *     preview edge ≤ 2048 px, requested edge validated before compositing.
 *
 * Purity: no BullMQ, no engine-client, no storage-SDK imports — the engine and
 * object-storage seams below are injected; unit tests run on fakes only
 * (apps/worker/tests/preview.test.ts). The Wave-6 agent loop composes this
 * pipeline with the engine pool session and the @studio/storage adapter.
 */

import {
  AGENT_OBSERVE_PREVIEW_PX,
  ENGINE_PNG_MAX_BYTES,
  ENGINE_PREVIEW_MAX_PX,
} from "@studio/config";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** §13: signed preview URLs live at most 15 minutes. */
export const PREVIEW_URL_TTL_SECONDS = 900;

/** PNG signature — the first 8 bytes of every PNG payload. */
export const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---------------------------------------------------------------------------
// Error surface — typed result envelopes, never throws (docs/AGENTS.md)
// ---------------------------------------------------------------------------

/** Preview-surface error codes. Add-only, stable strings (§13.3 discipline). */
export const PREVIEW_ERROR_CODES = [
  "invalid_preview_request", // the request failed its Zod schema (Zod at every boundary).
  "invalid_preview_side", // the requested width is not a finite non-negative number.
  "engine_render_failed", // the engine render or write-root read failed.
  "invalid_png", // the reply is not a decodable PNG payload.
  "png_too_large", // the PNG exceeds the 5 MiB §2.2 engine budget.
  "preview_store_failed", // object storage rejected the put.
  "preview_sign_failed", // the signed URL could not be produced.
] as const satisfies readonly string[];

export type PreviewErrorCode = (typeof PREVIEW_ERROR_CODES)[number];

export interface PreviewFailure {
  readonly ok: false;
  readonly code: PreviewErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly retryable?: boolean;
  /** Verbatim cause (§5.7: engine output is data, never interpreted). */
  readonly data?: unknown;
}

export type PreviewOutcome<T> = { readonly ok: true; readonly value: T } | PreviewFailure;

interface PreviewFailOptions {
  readonly hint?: string;
  readonly retryable?: boolean;
  readonly data?: unknown;
}

function previewFailure(
  code: PreviewErrorCode,
  message: string,
  options: PreviewFailOptions = {},
): PreviewFailure {
  const failure: {
    ok: false;
    code: PreviewErrorCode;
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

/** §5.7 helper: a thrown cause as data-safe text — travels in `data`, never `message`. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Seams — injected at the composition root (src/index.ts / the Wave-6 loop)
// ---------------------------------------------------------------------------

/** A signed URL exactly as the storage adapter produces it; `expiresAt` is epoch ms. */
export interface SignedObjectUrl {
  readonly url: string;
  readonly expiresAt: number;
}

/**
 * Object-storage seam (§3.1 `objects`: S3/R2).
 * RECONCILIATION (packages/storage, W2-M — parallel): the real Storage interface
 * (put/get/sign) must satisfy this shape, or be adapted at the composition root.
 * Keys are plain `/`-separated relative strings (no leading `/`, no `..`).
 */
export interface ObjectStorage {
  put(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
  sign(key: string, options: { readonly ttlSeconds: number }): Promise<SignedObjectUrl>;
}

/** `doc.render` request subset the preview pipeline uses (verified against rpc.rs). */
export interface PreviewRenderInput {
  /** Preview edge in px; the engine defaults to 1024 and caps at 2048 (§2.2). */
  readonly maxSide: number;
  /** Write the PNG here (beneath the session write root) instead of replying inline. */
  readonly path?: string;
}

/**
 * `doc.render` reply (rpc.rs): PNG written to a write-root path, else inline
 * base64. `bytes` is the written file's byte count, not the payload itself.
 */
export type PreviewRenderReply =
  | { readonly path: string; readonly bytes: number }
  | { readonly mime: string; readonly base64: string };

/**
 * Engine seam: mirrors `EngineClient.renderDocument` (packages/engine-client,
 * W2-D) and the engine-pool's write-root read (`readRootFile`), bound to one
 * session at the composition root. Implementations throw on failure; this
 * pipeline converts every throw into a typed envelope.
 */
export interface PreviewEngine {
  renderDocument(input: PreviewRenderInput): Promise<PreviewRenderReply>;
  readRootFile(path: string): Promise<Uint8Array>;
}

// ---------------------------------------------------------------------------
// Preview width clamping (§5.1 observe loop ≤1024 px; §2.2 hard 2048 px)
// ---------------------------------------------------------------------------

/** Who the preview is for: the agent observe loop (§5.1) or interactive use (§13.1). */
export type PreviewPurpose = "agent" | "interactive";

/** Requested-edge ceiling per purpose. */
export function previewWidthCeiling(purpose: PreviewPurpose): number {
  return purpose === "agent" ? AGENT_OBSERVE_PREVIEW_PX : ENGINE_PREVIEW_MAX_PX;
}

export interface ClampedPreviewWidth {
  /** The `maxSide` actually sent to the engine (≥ 1, ≤ the purpose ceiling). */
  readonly width: number;
  /** True whenever the emitted width differs from the request. */
  readonly clamped: boolean;
}

/**
 * Clamp a requested preview width to the purpose ceiling: ≤1024 px for the agent
 * observe loop (§5.1 "feed only the downscaled render"), ≤2048 px hard for
 * interactive use (§2.2 budgets.rs MAX_PREVIEW_SIDE). Anything below 1 px means
 * "no explicit size" and clamps to the ceiling instead of ever sending 0
 * (`maxSide: 0` asks the engine for FULL size).
 *
 * RECONCILIATION (packages/engine-client budgets.ts, W2-B): this mirrors
 * `clampPreviewSide`/`previewCeiling` 1:1. The ceilings themselves live in
 * @studio/config (single source of truth, §4) and budgets.ts re-exports the same
 * constants, so the numbers cannot drift; once the W2-D barrel
 * (`packages/engine-client/src/index.ts`) lands, the composition root may swap
 * this local helper for `clampPreviewSide` from `@studio/engine-client` (the
 * package "exports" map blocks subpath imports, and the barrel does not exist at
 * the time of writing — hence the local mirror).
 */
export function clampPreviewWidth(
  requestedPx: number,
  purpose: PreviewPurpose = "agent",
): PreviewOutcome<ClampedPreviewWidth> {
  if (!Number.isFinite(requestedPx) || requestedPx < 0) {
    return previewFailure(
      "invalid_preview_side",
      "requested preview width must be a finite non-negative number",
      { retryable: false },
    );
  }
  const ceiling = previewWidthCeiling(purpose);
  if (requestedPx < 1) {
    return { ok: true, value: { width: ceiling, clamped: true } };
  }
  const width = Math.min(Math.floor(requestedPx), ceiling);
  return { ok: true, value: { width, clamped: width !== requestedPx } };
}

// ---------------------------------------------------------------------------
// Storage keys — the documented preview key-space
// ---------------------------------------------------------------------------

/**
 * Storage-key-safe identifier: non-empty, no `/`, no `..`, no NUL — a key segment
 * can never traverse out of its prefix. Schema-level (Zod) validation enforces
 * this for requests; the key builders below re-check for direct callers.
 */
const KEY_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function keySegment(kind: string, value: string): string {
  if (!KEY_SEGMENT_PATTERN.test(value)) {
    // No key echo in the message (docs/AGENTS.md: never leak ids in errors).
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

export interface PreviewKeyInput {
  readonly organizationId: string;
  readonly documentId: string;
  readonly width: number;
  readonly revision: number;
}

/**
 * Object-storage key for one cached preview:
 * `renders/organizations/<org>/documents/<doc>/preview-<w>-<revision>.png`.
 * The clamped width + the document revision make the key content-addressed, so
 * re-rendering the same revision is an idempotent overwrite (§13 "cached").
 *
 * RECONCILIATION (packages/storage, W2-M — parallel): built per the documented
 * key-space until @studio/storage exports its key builders; when it does, replace
 * this constructor with that import — same key-space, byte-identical output.
 */
export function makePreviewKey(input: PreviewKeyInput): string {
  const organization = keySegment("organizationId", input.organizationId);
  const document = keySegment("documentId", input.documentId);
  const width = keyNumber("width", input.width);
  const revision = keyNumber("revision", input.revision);
  return `renders/organizations/${organization}/documents/${document}/preview-${width}-${revision}.png`;
}

// ---------------------------------------------------------------------------
// Request schema (Zod at every boundary — docs/AGENTS.md)
// ---------------------------------------------------------------------------

const keySegmentSchema = z
  .string()
  .regex(KEY_SEGMENT_PATTERN, "expected a key-segment-safe identifier");

/**
 * Render-preview request. `revision` is a required caller parameter — the caller
 * owns it (from `doc.inspect`/the version row); this pipeline never guesses.
 * Endpoint defaults (§13.1 `?w=1024`) are the gateway's job; the pipeline only
 * clamps what it is given.
 */
export const renderPreviewRequestSchema = z.object({
  organizationId: keySegmentSchema,
  documentId: keySegmentSchema,
  /** Requested long edge; 0 or a fraction means "no explicit size" (clamped). */
  width: z.number().finite().min(0),
  revision: z.number().int().min(0),
  /** §5.1 agent observe (≤1024) or §13.1 interactive preview (≤2048 hard). */
  purpose: z.enum(["agent", "interactive"]).default("agent"),
});

export type RenderPreviewRequest = z.input<typeof renderPreviewRequestSchema>;
export type ParsedRenderPreviewRequest = z.output<typeof renderPreviewRequestSchema>;

// ---------------------------------------------------------------------------
// Payload helpers — PNG magic + RFC 4648 base64 (pure, table-testable)
// ---------------------------------------------------------------------------

/** True only when the payload starts with the PNG signature. */
export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_MAGIC.length) {
    return false;
  }
  for (let index = 0; index < PNG_MAGIC.length; index += 1) {
    if (bytes[index] !== PNG_MAGIC[index]) {
      return false;
    }
  }
  return true;
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** -1 marks a byte that is not part of the base64 alphabet. */
const SEXTET = new Int16Array(128).fill(-1);
for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
  SEXTET[BASE64_ALPHABET.charCodeAt(index)] = index;
}

/**
 * Strict RFC 4648 base64 decode of an inline `doc.render` reply. Returns
 * `undefined` for anything the engine could not have produced as canonical
 * base64 (empty string, non-multiple-of-4 length, `=` outside the tail, or a
 * foreign character). Hand-rolled on purpose: the pipeline stays free of Node
 * builtins so it is deterministic in any runtime.
 */
export function decodeBase64(encoded: string): Uint8Array | undefined {
  const length = encoded.length;
  if (length === 0 || length % 4 !== 0) {
    return undefined;
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const outLength = (length / 4) * 3 - padding;
  const out = new Uint8Array(outLength);
  let offset = 0;
  let buffer = 0;
  let bits = 0;
  for (let index = 0; index < length - padding; index += 1) {
    const code = encoded.charCodeAt(index);
    const sextet = code < 128 ? (SEXTET[code] ?? -1) : -1;
    if (sextet < 0) {
      return undefined;
    }
    buffer = (buffer << 6) | sextet;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[offset] = (buffer >> bits) & 0xff;
      offset += 1;
    }
  }
  return offset === outLength ? out : undefined;
}

// ---------------------------------------------------------------------------
// PreviewPipeline — render → validate → store → sign
// ---------------------------------------------------------------------------

/** §13.1 preview reply: a signed URL plus the identity that produced it. */
export interface PreviewUrlResult {
  readonly previewUrl: string;
  readonly storageKey: string;
  /** The clamped width actually rendered (the `w` of the key). */
  readonly width: number;
  readonly revision: number;
  readonly expiresAt: number;
}

export interface PreviewPipelineOptions {
  readonly storage: ObjectStorage;
}

export class PreviewPipeline {
  readonly #storage: ObjectStorage;

  constructor(options: PreviewPipelineOptions) {
    this.#storage = options.storage;
  }

  /**
   * Render one downscaled preview of a document (§5.1) and publish it as a
   * cached, signed object (§13.1). Never throws: every failure is a typed
   * envelope, so the idle observe path can never crash a run.
   */
  async renderPreview(
    engine: PreviewEngine,
    request: RenderPreviewRequest,
  ): Promise<PreviewOutcome<PreviewUrlResult>> {
    const parsed = renderPreviewRequestSchema.safeParse(request);
    if (!parsed.success) {
      return previewFailure(
        "invalid_preview_request",
        "the preview request failed schema validation",
        {
          hint: parsed.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; "),
          retryable: false,
        },
      );
    }
    const clamped = clampPreviewWidth(parsed.data.width, parsed.data.purpose);
    if (!clamped.ok) {
      return clamped;
    }
    const width = clamped.value.width;

    const storageKey = makePreviewKey({
      organizationId: parsed.data.organizationId,
      documentId: parsed.data.documentId,
      width,
      revision: parsed.data.revision,
    });

    const rendered = await this.#renderToBytes(engine, width, parsed.data.revision);
    if (!rendered.ok) {
      return rendered;
    }
    const bytes = rendered.value;

    if (!isPng(bytes)) {
      return previewFailure("invalid_png", "the rendered preview is not a PNG payload", {
        retryable: false,
      });
    }
    if (bytes.byteLength > ENGINE_PNG_MAX_BYTES) {
      return previewFailure(
        "png_too_large",
        `the rendered preview of ${bytes.byteLength} bytes exceeds the ${ENGINE_PNG_MAX_BYTES} byte engine budget`,
        {
          hint: "the engine caps previews at 2048 px and PNG payloads at 5 MiB (§2.2); request a smaller side",
          retryable: false,
        },
      );
    }

    try {
      await this.#storage.put(storageKey, bytes);
    } catch (error) {
      return previewFailure("preview_store_failed", "the rendered preview could not be stored", {
        retryable: true,
        data: errorText(error),
      });
    }

    let signed: SignedObjectUrl;
    try {
      signed = await this.#storage.sign(storageKey, { ttlSeconds: PREVIEW_URL_TTL_SECONDS });
    } catch (error) {
      return previewFailure("preview_sign_failed", "the signed preview URL could not be produced", {
        retryable: true,
        data: errorText(error),
      });
    }

    return {
      ok: true,
      value: {
        previewUrl: signed.url,
        storageKey,
        width,
        revision: parsed.data.revision,
        expiresAt: signed.expiresAt,
      },
    };
  }

  /**
   * `doc.render { maxSide, path }` → PNG bytes. The file arm writes beneath the
   * session write root (`renders/` is a session capability subdir, see
   * @studio/engine-client capabilities.ts) and is read back; the inline arm is
   * base64-decoded. Both arms validate identically downstream.
   */
  async #renderToBytes(
    engine: PreviewEngine,
    width: number,
    revision: number,
  ): Promise<PreviewOutcome<Uint8Array>> {
    const path = `renders/preview-${width}-r${revision}.png`;
    let reply: PreviewRenderReply;
    try {
      reply = await engine.renderDocument({ maxSide: width, path });
    } catch (error) {
      return previewFailure("engine_render_failed", "the engine failed to render the preview", {
        retryable: true,
        data: errorText(error),
      });
    }
    if ("mime" in reply) {
      if (reply.mime !== "image/png") {
        return previewFailure("invalid_png", "the engine rendered a payload other than PNG", {
          data: { mime: reply.mime },
          retryable: false,
        });
      }
      const decoded = decodeBase64(reply.base64);
      if (decoded === undefined) {
        return previewFailure("invalid_png", "the inline engine reply was not decodable base64", {
          retryable: false,
        });
      }
      return { ok: true, value: decoded };
    }
    try {
      return { ok: true, value: await engine.readRootFile(reply.path) };
    } catch (error) {
      return previewFailure(
        "engine_render_failed",
        "the rendered preview could not be read back from the engine write root",
        { retryable: true, data: errorText(error) },
      );
    }
  }
}
