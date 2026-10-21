// apps/web — client-side upload pre-validation & failure copy (W8-I).
//
// Spec anchors:
//   §20.2  upload JPEG/PNG, 25 MB cap, EXIF stripped on upload, a > 60 MP
//          bomb is rejected with a CLEAR error — the ENFORCING gates live in
//          @studio/storage validate.ts behind POST /v1/uploads; this module
//          is the browser-side MIRROR of those caps so most rejections cost
//          zero bytes and one friendly sentence instead of a 25 MB upload.
//   §15.2  headers lie: the client can only PRE-VALIDATE. Every file is
//          re-validated server-side by magic-byte sniffing; a file that
//          passes here can still be rejected there (and vice versa).
//   §13.3  every gateway failure arrives as a typed envelope
//          `{ ok:false, code, message, hint, retryable }` (unwrapped into
//          ApiError by src/lib/api.ts); the copy helpers below turn those
//          envelopes into user-facing text and ALWAYS surface the hint.
//
// Deliberately dependency-light: this module is imported by unit tests
// (guards.test.ts), so it must resolve under Vitest WITHOUT the "@/..."
// tsconfig alias — the ApiError contract is matched structurally (duck
// typing) instead of importing src/lib/api (same shape, no coupling).

import { MAX_UPLOAD_BYTES, MAX_UPLOAD_MEGAPIXELS, UPLOAD_MIME_TYPES } from "@studio/config";

// ---------------------------------------------------------------------------
// Limits (single source of truth: @studio/config — mirrors of the server caps)
// ---------------------------------------------------------------------------

/**
 * §20.2 JPEG/PNG whitelist. The gateway's sniffer additionally recognises
 * WEBP, but §20.2's product surface is JPEG/PNG — the UI stays strict on
 * purpose; widen here (and the accept attribute) if that ever changes.
 */
export const ACCEPTED_UPLOAD_MIME_TYPES: readonly string[] = UPLOAD_MIME_TYPES;

const ACCEPTED_MIME = new Set<string>(UPLOAD_MIME_TYPES);

/** `accept` attribute for the hidden file input (JPEG + PNG only). */
export const UPLOAD_ACCEPT_ATTRIBUTE = UPLOAD_MIME_TYPES.join(",");

/**
 * How many header bytes are read for the client dimension check. PNG IHDR
 * sits at a fixed offset; a JPEG's SOF marker follows the (≤ 64 KB) EXIF
 * thumbnail, so a 512 KiB window is far past any real-world SOF position.
 * When the marker is not found inside the window the pre-check abstains —
 * the server still rejects a bomb.
 */
export const HEADER_SCAN_LIMIT_BYTES = 512 * 1024;

// ---------------------------------------------------------------------------
// Minimal structural file shape (a DOM `File` satisfies it; tests fake it)
// ---------------------------------------------------------------------------

/** Structural subset of `File` used by pre-validation (no DOM type needed). */
export interface ClientUploadFile {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  slice(start?: number, end?: number): Blob;
}

// ---------------------------------------------------------------------------
// Header-only dimension parsing (PNG IHDR / JPEG SOF — mirrors @studio/storage
// validate.ts: dimensions from headers ONLY, pixels are never decoded here)
// ---------------------------------------------------------------------------

/** Successful header parse. */
export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

/** Bounds-checked big-endian reader (noUncheckedIndexedAccess-safe). */
class ByteView {
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get length(): number {
    return this.bytes.length;
  }

  has(at: number, n: number): boolean {
    return at >= 0 && at + n <= this.bytes.length;
  }

  u8(at: number): number {
    return this.view.getUint8(at);
  }

  u16(at: number): number {
    return this.view.getUint16(at, false);
  }

  u32(at: number): number {
    return this.view.getUint32(at, false);
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** SOF0/1/2/… markers that carry dimensions (C4=DHT, C8=JPG, CC=DAC do not). */
function isJpegSofMarker(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

/**
 * Read pixel dimensions from PNG/JPEG header bytes. Returns null for anything
 * unparseable (truncated, unknown format, SOF beyond the read window) — null
 * NEVER means "reject", it means "the server decides".
 */
export function readImageDimensionsFromBytes(bytes: Uint8Array): ImageDimensions | null {
  const b = new ByteView(bytes);
  if (!b.has(0, 8)) {
    return null;
  }
  const isPng = PNG_SIGNATURE.every((byte, index) => b.u8(index) === byte);
  if (isPng) {
    // IHDR is required first: length(4) "IHDR" width(4) height(4).
    const hasIhdr =
      b.has(0, 24) &&
      b.u8(12) === 0x49 && // I
      b.u8(13) === 0x48 && // H
      b.u8(14) === 0x44 && // D
      b.u8(15) === 0x52; // R
    if (!hasIhdr) {
      return null;
    }
    const width = b.u32(16);
    const height = b.u32(20);
    if (width <= 0 || height <= 0) {
      return null;
    }
    return { width, height };
  }
  const isJpeg = b.u8(0) === 0xff && b.u8(1) === 0xd8 && b.u8(2) === 0xff;
  if (isJpeg) {
    // Walk marker segments: FF <marker> <len:2> <payload>. Standalone markers
    // (RSTn, TEM, SOI) carry no length; SOS/EOI end the header scan.
    let offset = 2;
    while (b.has(offset, 4)) {
      if (b.u8(offset) !== 0xff) {
        return null; // desynchronised — not a well-formed JPEG header
      }
      const marker = b.u8(offset + 1);
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) {
        return null; // EOI/SOS before any SOF — dimensions unavailable
      }
      const length = b.u16(offset + 2); // includes the two length bytes
      if (isJpegSofMarker(marker)) {
        // SOF payload: precision(1) height(2) width(2)
        if (length < 8 || !b.has(offset + 4, 5)) {
          return null;
        }
        const height = b.u16(offset + 5);
        const width = b.u16(offset + 7);
        if (width <= 0 || height <= 0) {
          return null;
        }
        return { width, height };
      }
      if (length < 2) {
        return null; // degenerate segment — would loop forever
      }
      offset += 2 + length;
    }
  }
  return null;
}

/** Read a file's header window and parse dimensions (null = unknown). */
export async function readImageDimensions(file: ClientUploadFile): Promise<ImageDimensions | null> {
  const header = file.slice(0, HEADER_SCAN_LIMIT_BYTES);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await header.arrayBuffer());
  } catch {
    return null;
  }
  return readImageDimensionsFromBytes(bytes);
}

// ---------------------------------------------------------------------------
// Formatting (shared by guard copy and the asset cards)
// ---------------------------------------------------------------------------

/** 26214400 → "25 MB", 512 → "512 B", 1536 → "1.5 KB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${withTenth(kb)} KB`;
  }
  return `${withTenth(kb / 1024)} MB`;
}

/** 64.02 → "64 MP", 95.28 → "95.3 MP". */
export function formatMegapixels(megapixels: number): string {
  return `${withTenth(megapixels)} MP`;
}

function withTenth(value: number): string {
  return String(Math.round(value * 10) / 10);
}

// ---------------------------------------------------------------------------
// Pre-validation (§20.2 client mirror — UX only, the server re-checks)
// ---------------------------------------------------------------------------

/** Rejection copy for a file that must not even be queued. */
export interface ClientUploadRejection {
  readonly ok: false;
  readonly title: string;
  readonly hint?: string;
}

/** All checks passed — the file may be queued for upload. */
export interface ClientUploadAcceptance {
  readonly ok: true;
  /** Dimensions when the header parse succeeded (drove the 60 MP pre-check). */
  readonly dimensions: ImageDimensions | null;
}

export type ClientUploadGuard = ClientUploadAcceptance | ClientUploadRejection;

const HINT_ONLY_JPEG_PNG = "Only JPEG and PNG images are accepted.";

/** §20.2 client-side pre-validation: type whitelist → size cap → 60 MP ceiling. */
export async function validateClientFile(file: ClientUploadFile): Promise<ClientUploadGuard> {
  const type = file.type.trim().toLowerCase();
  if (type === "") {
    // Some platforms report an empty MIME type — fall back to the extension,
    // the same list the file picker's `accept` attribute enforces. The
    // server sniffs magic bytes either way (§15.2).
    if (!/\.(jpe?g|png)$/i.test(file.name)) {
      return { ok: false, title: `"${file.name}" is not a JPEG or PNG.`, hint: HINT_ONLY_JPEG_PNG };
    }
  } else if (!ACCEPTED_MIME.has(type)) {
    return { ok: false, title: `"${file.name}" is not a JPEG or PNG.`, hint: HINT_ONLY_JPEG_PNG };
  }

  if (file.size === 0) {
    return {
      ok: false,
      title: `"${file.name}" is empty.`,
      hint: "Select a valid image file and try again.",
    };
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      title: `"${file.name}" is ${formatBytes(file.size)} — over the ${formatBytes(MAX_UPLOAD_BYTES)} per-file cap.`,
      hint: "Export a smaller copy (under 25 MB) and try again.",
    };
  }

  const dimensions = await readImageDimensions(file);
  if (dimensions !== null) {
    const megapixels = (dimensions.width * dimensions.height) / 1_000_000;
    if (megapixels > MAX_UPLOAD_MEGAPIXELS) {
      return {
        ok: false,
        // Friendly mirror of the server's resolution_exceeds_ceiling error:
        // rejected client-side so a 60 MP bomb never costs a full upload.
        title: `"${file.name}" is about ${formatMegapixels(megapixels)} — over the ${MAX_UPLOAD_MEGAPIXELS} MP cap, so it would be rejected.`,
        hint: "Downscale the image (or export a smaller version) and try again.",
      };
    }
  }

  return { ok: true, dimensions };
}

// ---------------------------------------------------------------------------
// Envelope → user copy (§13.3: show the hint, never internals)
// ---------------------------------------------------------------------------

/**
 * Structural ApiError match. src/lib/api.ts throws typed ApiErrors carrying
 * the gateway envelope; duck-typing here keeps this module importable by
 * Vitest without the "@/lib" alias (see the header note).
 */
interface ApiErrorShape {
  readonly code: string;
  readonly message: string;
  readonly status: number;
  readonly hint?: string;
}

function asApiErrorShape(error: unknown): ApiErrorShape | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const candidate = error as {
    code?: unknown;
    message?: unknown;
    status?: unknown;
    hint?: unknown;
  };
  if (
    typeof candidate.code !== "string" ||
    typeof candidate.message !== "string" ||
    typeof candidate.status !== "number"
  ) {
    return null;
  }
  return {
    code: candidate.code,
    message: candidate.message,
    status: candidate.status,
    hint: typeof candidate.hint === "string" ? candidate.hint : undefined,
  };
}

/** Failure copy: a short title plus the envelope's hint when one exists. */
export interface FailureCopy {
  readonly title: string;
  readonly hint?: string;
}

/**
 * Map an upload failure to friendly copy. Known §20.2/§15.2 codes get a
 * curated title; everything else falls back to the envelope's own (already
 * user-safe) message, and the envelope hint is ALWAYS surfaced.
 */
export function describeUploadFailure(error: unknown): FailureCopy {
  const envelope = asApiErrorShape(error);
  if (envelope === null) {
    // Contract drift (e.g. a ZodError) or a raw transport error — never leak
    // internals; a generic retry sentence is the honest copy.
    return { title: "The upload failed. Please try again." };
  }
  const hint = envelope.hint;
  switch (envelope.code) {
    case "upload_too_large":
      return {
        title: `This file is over the ${formatBytes(MAX_UPLOAD_BYTES)} cap.`,
        hint: hint ?? "Export a smaller copy and try again.",
      };
    case "resolution_exceeds_ceiling":
      return {
        title: `This image is over the ${MAX_UPLOAD_MEGAPIXELS} MP cap.`,
        hint: hint ?? "Downscale the image and try again.",
      };
    case "polyglot_detected":
      return {
        title: "This file hides more than one image format.",
        hint: hint ?? "Upload a plain single-format JPEG or PNG.",
      };
    case "file_corrupt":
      return {
        title: "This image file is damaged or incomplete.",
        hint: hint ?? "Re-export the image and try again.",
      };
    case "unsupported_media_type":
      return { title: "Only JPEG and PNG images are accepted.", hint };
    case "forbidden":
      return {
        title: "Your role does not allow uploads.",
        hint: hint ?? "Ask an editor or admin to add it for you.",
      };
    case "unauthorized":
      return { title: "Your session has expired. Sign in and try again.", hint };
    case "rate_limited":
      return { title: "Too many uploads at once. Wait a moment and try again.", hint };
    case "network_error":
      return {
        title: "Could not reach the server.",
        hint: hint ?? "Check your connection and try again.",
      };
    default:
      return { title: envelope.message, hint };
  }
}

/** Map a library (list/delete) failure to friendly copy. */
export function describeLibraryFailure(error: unknown): FailureCopy {
  const envelope = asApiErrorShape(error);
  if (envelope === null) {
    return { title: "Something went wrong. Please try again." };
  }
  const hint = envelope.hint;
  switch (envelope.code) {
    case "forbidden":
      return {
        title: "Your role does not allow this action.",
        hint: hint ?? "Ask an editor or admin to do it for you.",
      };
    case "unauthorized":
      return { title: "Your session has expired. Sign in and try again.", hint };
    case "rate_limited":
      return { title: "Too many requests. Wait a moment and try again.", hint };
    case "storage_error":
      return {
        title: "Object storage is unavailable right now.",
        hint: hint ?? "This is temporary — try again in a moment.",
      };
    case "network_error":
      return {
        title: "Could not reach the server.",
        hint: hint ?? "Check your connection and try again.",
      };
    default:
      return { title: envelope.message, hint };
  }
}

/** True when the failure is the §13.3 `not_found` envelope (asset already gone). */
export function isNotFoundFailure(error: unknown): boolean {
  return asApiErrorShape(error)?.code === "not_found";
}
