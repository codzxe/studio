// @studio/storage — upload validation (W2-O). Zero-dep, pure byte readers.
//
// Spec anchors:
// - §20 acceptance criterion 2: JPEG/PNG upload, 25 MB cap, EXIF stripped,
//   60 MP decompression bomb rejected with a clear error.
// - §15.2 uploads: MIME sniffing by magic bytes (never trust headers), size caps,
//   image decode validation, EXIF stripping (colour profiles kept).
// - §21 Security row: upload fuzzing — polyglot files, zip bombs, EXIF payloads.
//
// Security posture (deliberate, documented):
// - Dimensions come from HEADER PARSING ONLY (PNG IHDR / JPEG SOF). Pixel data
//   is never inflated or decoded here, so zip-bomb IDAT payloads cannot hurt
//   this module; the megapixel ceiling is enforced on the claimed dimensions
//   before any worker touches pixels (§20.2 "rejected with a clear error").
// - Polyglot policy: a PNG must terminate at IEND with nothing after it. The
//   whole-buffer scan only looks for signatures ≥ 8 bytes long (PNG signature,
//   RIFF…WEBP) because a 3-byte JPEG SOI is expected ~once per 16.7 MB of
//   compressed payload data. A JPEG SOI therefore only counts in a region that
//   must be empty (after PNG IEND); a JPEG's own nested SOI is legal (EXIF
//   thumbnails) and is removed by the strip plan instead.
// - All failures are typed envelopes `{ ok:false, code, message, hint,
//   retryable }` (AGENTS.md style). Nothing throws on malformed input; only a
//   caller passing nonsensical limit numbers (a programmer error) throws.

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Media types this module can recognise by magic bytes. */
export type ImageMime = "image/png" | "image/jpeg" | "image/webp";

/**
 * Stable error codes for the upload path (§13.3 add-only style).
 * Deliberately module-local: @studio/config's catalog does not carry upload
 * codes; the envelope shape is structurally identical to its `Failure`.
 */
export type UploadErrorCode =
  | "unsupported_media_type"
  | "upload_too_large"
  | "resolution_exceeds_ceiling"
  | "file_corrupt"
  | "polyglot_detected";

/** Typed failure envelope. Upload rejections are never retryable. */
export interface UploadFailure {
  readonly ok: false;
  readonly code: UploadErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly retryable: false;
}

/** Result of `sniffMime`. */
export type SniffResult = { readonly ok: true; readonly mime: ImageMime } | UploadFailure;

/** Successful dimension parse. `megapixels = width * height / 1e6`. */
export interface ImageDimensions {
  readonly ok: true;
  readonly width: number;
  readonly height: number;
  readonly megapixels: number;
}

export type DimensionResult = ImageDimensions | UploadFailure;

/** Fully validated upload (§20.2). */
export interface ValidUpload {
  readonly ok: true;
  readonly mime: ImageMime;
  readonly width: number;
  readonly height: number;
  readonly megapixels: number;
}

export type UploadValidation = ValidUpload | UploadFailure;

/**
 * Optional per-call limits for `validateUpload`. Defaults mirror
 * @studio/config `MAX_UPLOAD_BYTES` / `MAX_UPLOAD_MEGAPIXELS` (§20.2); they are
 * restated locally so this module stays zero-dependency.
 */
export interface UploadLimits {
  readonly maxBytes?: number;
  readonly maxMegapixels?: number;
  /** Stricter per-plan canvas ceiling (§14.1); the effective cap is the minimum. */
  readonly planCeiling?: number;
}

/** Half-open byte range `[start, end)` — `bytes.subarray(start, end)`. */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/** A segment the strip plan removes (marker name + half-open range). */
export interface RemovedSegment {
  readonly marker: "APP1" | "APP2" | "COM";
  readonly start: number;
  readonly end: number;
}

/**
 * Pure description of an EXIF strip. `keepBytes` are the exact regions a worker
 * must concatenate to rebuild the file without EXIF/comment segments; `removed`
 * lists what was dropped. The ACTUAL re-slice happens in the worker with this
 * plan — this function never copies or modifies bytes (§15.2: strip EXIF, keep
 * colour profiles; ICC APP2 segments are preserved).
 */
export interface StripExifPlan {
  readonly ok: true;
  readonly needsStrip: boolean;
  readonly keepBytes: readonly ByteRange[];
  readonly removed: readonly RemovedSegment[];
}

export type StripExifResult = StripExifPlan | UploadFailure;

/** §20.2: hard cap per uploaded file — 25 MB (mirrors @studio/config). */
export const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** §20.2: megapixel bomb ceiling — 60 MP (mirrors @studio/config). */
export const DEFAULT_MAX_UPLOAD_MEGAPIXELS = 60;

// ---------------------------------------------------------------------------
// Internal failure helpers
// ---------------------------------------------------------------------------

const HINT_REEXPORT = "Re-export the image and try again.";
const HINT_SUPPORTED = "Only JPEG and PNG images are accepted.";

function fail(code: UploadErrorCode, message: string, hint?: string): UploadFailure {
  const failure: {
    ok: false;
    code: UploadErrorCode;
    message: string;
    hint?: string;
    retryable: false;
  } = { ok: false, code, message, retryable: false };
  if (hint !== undefined) {
    failure.hint = hint;
  }
  return failure;
}

function corrupt(message: string): UploadFailure {
  return fail("file_corrupt", message, HINT_REEXPORT);
}

function polyglot(): UploadFailure {
  return fail(
    "polyglot_detected",
    "File contains more than one image format (polyglot).",
    "Upload a plain single-format JPEG or PNG.",
  );
}

/** `width * height / 1e6`, kept in one place so the ceiling is never re-derived. */
function megapixelsOf(width: number, height: number): number {
  return (width * height) / 1_000_000;
}

/** Compact megapixel rendering for messages (61.44, not 61.44000000000001). */
function fmtMp(value: number): string {
  return String(Number(value.toFixed(3)));
}

// ---------------------------------------------------------------------------
// Internal byte reader (bounds-checked DataView; every read is pre-validated so
// malformed input can never throw — it fails with a typed envelope instead).
// ---------------------------------------------------------------------------

class ByteReader {
  private readonly view: DataView;

  constructor(readonly raw: Uint8Array) {
    this.view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  }

  get length(): number {
    return this.raw.byteLength;
  }

  /** True when `n` bytes are readable at `at` (and `at` is not negative). */
  has(at: number, n: number): boolean {
    return at >= 0 && at + n <= this.length;
  }

  u8(at: number): number {
    return this.view.getUint8(at);
  }

  u16be(at: number): number {
    return this.view.getUint16(at, false);
  }

  u32be(at: number): number {
    return this.view.getUint32(at, false);
  }
}

// ---------------------------------------------------------------------------
// Magic-byte helpers (hand-rolled; NO image libraries — AGENTS.md "no installs")
// ---------------------------------------------------------------------------

/** PNG signature: 89 50 4E 47 0D 0A 1A 0A. */
function isPngSignature(b: ByteReader, at: number): boolean {
  return (
    b.has(at, 8) &&
    b.u8(at) === 0x89 &&
    b.u8(at + 1) === 0x50 &&
    b.u8(at + 2) === 0x4e &&
    b.u8(at + 3) === 0x47 &&
    b.u8(at + 4) === 0x0d &&
    b.u8(at + 5) === 0x0a &&
    b.u8(at + 6) === 0x1a &&
    b.u8(at + 7) === 0x0a
  );
}

/** JPEG SOI plus the following marker's 0xFF: FF D8 FF. */
function isJpegSoi(b: ByteReader, at: number): boolean {
  return b.has(at, 3) && b.u8(at) === 0xff && b.u8(at + 1) === 0xd8 && b.u8(at + 2) === 0xff;
}

/** WEBP container: "RIFF" …(4-byte size)… "WEBP". */
function isWebpSignature(b: ByteReader, at: number): boolean {
  return (
    b.has(at, 12) &&
    b.u8(at) === 0x52 &&
    b.u8(at + 1) === 0x49 &&
    b.u8(at + 2) === 0x46 &&
    b.u8(at + 3) === 0x46 &&
    b.u8(at + 8) === 0x57 &&
    b.u8(at + 9) === 0x45 &&
    b.u8(at + 10) === 0x42 &&
    b.u8(at + 11) === 0x50
  );
}

type MagicHit = "png" | "jpeg" | "webp";

/**
 * Strong signatures only (PNG sig, RIFF…WEBP — both ≥ 8 bytes, collision-safe
 * across the whole 25 MB cap). Used on the entire buffer where compressed
 * payload lives. Never returns early on a weak JPEG hit.
 */
function scanStrongMagic(b: ByteReader, from: number): "png" | "webp" | null {
  for (let i = from; i + 8 <= b.length; i++) {
    const v = b.u8(i);
    if (v === 0x89 && isPngSignature(b, i)) {
      return "png";
    }
    if (v === 0x52 && isWebpSignature(b, i)) {
      return "webp";
    }
  }
  return null;
}

/**
 * Any image magic, including the weak 3-byte JPEG SOI — only meaningful in a
 * region that must be empty (PNG post-IEND trailing bytes).
 */
function scanAnyMagic(b: ByteReader, from: number): MagicHit | null {
  // Need i, i+1, i+2 readable → i + 3 <= length (a bare 3-byte SOI tail counts).
  for (let i = from; i + 3 <= b.length; i++) {
    const v = b.u8(i);
    if (v === 0x89 && isPngSignature(b, i)) {
      return "png";
    }
    if (v === 0xff && b.u8(i + 1) === 0xd8 && b.u8(i + 2) === 0xff) {
      return "jpeg";
    }
    if (v === 0x52 && isWebpSignature(b, i)) {
      return "webp";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// CRC-32 (PNG chunks). Bitwise, table-free: IHDR is 17 bytes, this is cheap and
// avoids a lookup table in a hot module. Same polynomial as zlib (0xEDB88320).
// ---------------------------------------------------------------------------

function crc32Range(bytes: Uint8Array, start: number, end: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let crc = 0xffff_ffff;
  for (let i = start; i < end; i++) {
    crc ^= view.getUint8(i);
    for (let k = 0; k < 8; k++) {
      crc = (crc >>> 1) ^ (0xedb8_8320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

// ---------------------------------------------------------------------------
// sniffMime
// ---------------------------------------------------------------------------

/**
 * Detect the media type from magic bytes (§15.2: sniff, never trust headers).
 * PNG → `image/png`, JPEG (FF D8 FF) → `image/jpeg`, WEBP (RIFF…WEBP) →
 * `image/webp`; anything else — including SVG, GIF and empty input — fails
 * with `unsupported_media_type` (SVG is deliberately not sniffable: §15.2 XSS
 * note — only sanitised SVG may ever be accepted, and never via this path).
 */
export function sniffMime(bytes: Uint8Array): SniffResult {
  const b = new ByteReader(bytes);
  if (isPngSignature(b, 0)) {
    return { ok: true, mime: "image/png" };
  }
  if (isJpegSoi(b, 0)) {
    return { ok: true, mime: "image/jpeg" };
  }
  if (isWebpSignature(b, 0)) {
    return { ok: true, mime: "image/webp" };
  }
  return fail(
    "unsupported_media_type",
    "Unsupported file type.",
    "Magic bytes must match PNG, JPEG or WebP.",
  );
}

// ---------------------------------------------------------------------------
// PNG dimensions — IHDR only, CRC verified (header parse, never pixels)
// ---------------------------------------------------------------------------

/**
 * Parse PNG width/height from the IHDR chunk (big-endian at offsets 16/20 —
 * first chunk, 13-byte data, CRC32 over `IHDR` + data verified). Zero
 * dimensions, a foreign first chunk, or a CRC mismatch → `file_corrupt`.
 * Structural tail checks (IEND/polyglot) live in `validateUpload`.
 */
export function pngDimensions(bytes: Uint8Array): DimensionResult {
  const b = new ByteReader(bytes);
  if (!isPngSignature(b, 0)) {
    return corrupt("PNG signature missing.");
  }
  // Signature(8) + length(4) + "IHDR"(4) + data(13) + crc(4) = 33 bytes minimum.
  if (!b.has(8, 25)) {
    return corrupt("PNG is truncated (IHDR chunk incomplete).");
  }
  const ihdrLength = b.u32be(8);
  if (ihdrLength !== 13) {
    return corrupt(`PNG IHDR length is ${ihdrLength}; expected 13.`);
  }
  const isIhdr = b.u8(12) === 0x49 && b.u8(13) === 0x48 && b.u8(14) === 0x44 && b.u8(15) === 0x52;
  if (!isIhdr) {
    return corrupt("PNG first chunk must be IHDR.");
  }
  const width = b.u32be(16);
  const height = b.u32be(20);
  if (width === 0 || height === 0) {
    return corrupt("PNG width or height is zero.");
  }
  const storedCrc = b.u32be(29);
  const computedCrc = crc32Range(b.raw, 12, 29);
  if (storedCrc !== computedCrc) {
    return corrupt("PNG IHDR CRC does not match.");
  }
  return { ok: true, width, height, megapixels: megapixelsOf(width, height) };
}

// ---------------------------------------------------------------------------
// JPEG segment walk (shared by dimensions / hasExif / stripExifPlan)
// ---------------------------------------------------------------------------

const MARKER_SOI = 0xd8;
const MARKER_EOI = 0xd9;
const MARKER_SOS = 0xda;
const MARKER_COM = 0xfe;
const MARKER_APP1 = 0xe1;
const MARKER_APP2 = 0xe2;
const MARKER_SOF0 = 0xc0;
const MARKER_SOF2 = 0xc2;

/** A length-bearing header segment (anything except SOI/EOI/SOS/RST/TEM). */
interface JpegSegment {
  readonly code: number;
  /** Offset of the first 0xFF of the marker (FF fill bytes included). */
  readonly start: number;
  /** Offset of the marker code byte. */
  readonly codeAt: number;
  /** First payload byte (after the 2-byte length field). */
  readonly payloadAt: number;
  /** Exclusive end of the segment. */
  readonly end: number;
}

type JpegProblem = "truncated" | "bad_marker" | "bad_length" | "second_soi" | "second_sof";

interface JpegHeader {
  readonly segments: readonly JpegSegment[];
  readonly sof: { readonly height: number; readonly width: number } | null;
  /** Where header parsing stopped (SOS/EOI = well-formed end of the header). */
  readonly stop: { readonly kind: "sos" | "eoi" | "eof" | "desync"; readonly at: number };
  /** First structural problem, if any (fatal for parsing). */
  readonly problem: JpegProblem | null;
}

function problemMessage(problem: JpegProblem): string {
  switch (problem) {
    case "truncated":
      return "JPEG is truncated.";
    case "bad_marker":
      return "JPEG marker structure is invalid.";
    case "bad_length":
      return "JPEG segment length is invalid.";
    case "second_soi":
      return "JPEG contains a second SOI marker (double header).";
    case "second_sof":
      return "JPEG contains multiple SOF markers (conflicting dimensions).";
  }
}

/**
 * Walk length-bearing header segments starting right after SOI, skipping the FF
 * fill bytes that may precede a marker code. Stops at SOS (scan data), EOI,
 * end-of-buffer, or the first structural problem. Never reads inside
 * entropy-coded data. A second SOI/SOF is recorded as a problem: it is the
 * classic double-header / dimension-mismatch polyglot trick (§21).
 */
function walkJpegHeader(b: ByteReader): JpegHeader {
  const segments: JpegSegment[] = [];
  let sof: { height: number; width: number } | null = null;
  let pos = 2; // after FF D8
  for (;;) {
    if (!b.has(pos, 1) || b.u8(pos) !== 0xff) {
      const outOfBytes = !b.has(pos, 1);
      return {
        segments,
        sof,
        stop: { kind: outOfBytes ? "eof" : "desync", at: pos },
        problem: outOfBytes ? "truncated" : "bad_marker",
      };
    }
    let codeAt = pos;
    while (b.has(codeAt, 1) && b.u8(codeAt) === 0xff) {
      codeAt++; // skip fill bytes
    }
    if (!b.has(codeAt, 1)) {
      return { segments, sof, stop: { kind: "eof", at: pos }, problem: "truncated" };
    }
    const code = b.u8(codeAt);
    if (code === MARKER_SOI) {
      return { segments, sof, stop: { kind: "desync", at: pos }, problem: "second_soi" };
    }
    if (code === MARKER_EOI) {
      return { segments, sof, stop: { kind: "eoi", at: pos }, problem: null };
    }
    if (code === MARKER_SOS) {
      return { segments, sof, stop: { kind: "sos", at: pos }, problem: null };
    }
    if (code === 0x01 || (code >= 0xd0 && code <= 0xd7)) {
      // TEM / RST markers have no length and are illegal before SOS.
      return { segments, sof, stop: { kind: "desync", at: pos }, problem: "bad_marker" };
    }
    if (!b.has(codeAt + 1, 2)) {
      return { segments, sof, stop: { kind: "eof", at: pos }, problem: "truncated" };
    }
    const length = b.u16be(codeAt + 1);
    if (length < 2) {
      return { segments, sof, stop: { kind: "desync", at: pos }, problem: "bad_length" };
    }
    const end = codeAt + 1 + length;
    if (end > b.length) {
      return { segments, sof, stop: { kind: "eof", at: pos }, problem: "truncated" };
    }
    const segment: JpegSegment = { code, start: pos, codeAt, payloadAt: codeAt + 3, end };
    if (code === MARKER_SOF0 || code === MARKER_SOF2) {
      if (sof !== null) {
        return { segments, sof, stop: { kind: "desync", at: pos }, problem: "second_sof" };
      }
      // Lf(2) P(1) Y(2) X(2) — need precision + height + width readable.
      if (length < 8 || !b.has(codeAt + 3, 5)) {
        return { segments, sof, stop: { kind: "desync", at: pos }, problem: "bad_length" };
      }
      sof = { height: b.u16be(codeAt + 4), width: b.u16be(codeAt + 6) };
    }
    segments.push(segment);
    pos = end;
  }
}

// ---------------------------------------------------------------------------
// JPEG dimensions — SOF0/SOF2 marker scan (handle FF padding), reject malformed
// ---------------------------------------------------------------------------

/**
 * Scan for the SOF0/SOF2 frame marker and read width/height from it (baseline
 * and progressive JPEG, §20.2's JPEG surface). Truncated files, files with no
 * SOF before SOS/EOI, a second SOI/SOF, or zero dimensions → `file_corrupt`.
 */
export function jpegDimensions(bytes: Uint8Array): DimensionResult {
  const b = new ByteReader(bytes);
  if (!b.has(0, 2) || b.u8(0) !== 0xff || b.u8(1) !== 0xd8) {
    return corrupt("JPEG SOI marker missing.");
  }
  const header = walkJpegHeader(b);
  if (header.problem !== null) {
    return corrupt(problemMessage(header.problem));
  }
  const frame = header.sof;
  if (frame === null) {
    return corrupt("JPEG has no SOF0/SOF2 frame marker.");
  }
  if (frame.height === 0 || frame.width === 0) {
    return corrupt("JPEG width or height is zero.");
  }
  return {
    ok: true,
    width: frame.width,
    height: frame.height,
    megapixels: megapixelsOf(frame.width, frame.height),
  };
}

// ---------------------------------------------------------------------------
// dimensions — dispatch
// ---------------------------------------------------------------------------

/**
 * Parse dimensions by sniffed type. PNG/JPEG are parsed header-only; WebP is
 * recognised by `sniffMime` but not dimension-parsed here (§20.2's upload
 * surface is JPEG/PNG), failing with `unsupported_media_type`.
 */
export function dimensions(bytes: Uint8Array): DimensionResult {
  const sniffed = sniffMime(bytes);
  if (!sniffed.ok) {
    return sniffed;
  }
  if (sniffed.mime === "image/png") {
    return pngDimensions(bytes);
  }
  if (sniffed.mime === "image/jpeg") {
    return jpegDimensions(bytes);
  }
  return fail("unsupported_media_type", "WebP dimension parsing is not supported.", HINT_SUPPORTED);
}

// ---------------------------------------------------------------------------
// EXIF detection (JPEG only — PNG has no EXIF standard, always false)
// ---------------------------------------------------------------------------

/**
 * True when an APP1/APP2 segment carries an EXIF payload: the `Exif\0\0`
 * identifier followed by a TIFF byte-order mark `II*\0` (little-endian) or
 * `MM\0*` (big-endian). XMP APP1 and ICC APP2 do not match. Malformed input
 * never throws — it simply reports no EXIF.
 */
function isExifSegment(b: ByteReader, segment: JpegSegment): boolean {
  if (segment.code !== MARKER_APP1 && segment.code !== MARKER_APP2) {
    return false;
  }
  const { payloadAt, end } = segment;
  // "Exif\0\0" (6 bytes) + byte-order mark (4 bytes).
  if (payloadAt + 10 > end) {
    return false;
  }
  const exifId =
    b.u8(payloadAt) === 0x45 &&
    b.u8(payloadAt + 1) === 0x78 &&
    b.u8(payloadAt + 2) === 0x69 &&
    b.u8(payloadAt + 3) === 0x66 &&
    b.u8(payloadAt + 4) === 0x00 &&
    b.u8(payloadAt + 5) === 0x00;
  if (!exifId) {
    return false;
  }
  const littleEndian =
    b.u8(payloadAt + 6) === 0x49 &&
    b.u8(payloadAt + 7) === 0x49 &&
    b.u8(payloadAt + 8) === 0x2a &&
    b.u8(payloadAt + 9) === 0x00;
  const bigEndian =
    b.u8(payloadAt + 6) === 0x4d &&
    b.u8(payloadAt + 7) === 0x4d &&
    b.u8(payloadAt + 8) === 0x00 &&
    b.u8(payloadAt + 9) === 0x2a;
  return littleEndian || bigEndian;
}

/**
 * Whether the bytes contain EXIF metadata. JPEG only: APP1/APP2 `Exif\0\0`
 * with an `II*`/`MM*` TIFF byte order. PNG has no EXIF standard → false; WebP
 * and anything unrecognised → false. Detector semantics — never throws.
 */
export function hasExif(bytes: Uint8Array): boolean {
  const b = new ByteReader(bytes);
  if (!b.has(0, 2) || b.u8(0) !== 0xff || b.u8(1) !== 0xd8) {
    return false;
  }
  const header = walkJpegHeader(b);
  for (const segment of header.segments) {
    if (isExifSegment(b, segment)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// stripExifPlan — pure description; the worker performs the re-slice
// ---------------------------------------------------------------------------

/** Marker label for a removed segment (only APP1/APP2/COM are ever dropped). */
function removedMarker(code: number): RemovedSegment["marker"] {
  if (code === MARKER_APP1) {
    return "APP1";
  }
  if (code === MARKER_APP2) {
    return "APP2";
  }
  return "COM";
}

/**
 * Describe which byte ranges to KEEP so the worker can rebuild the file with
 * EXIF removed (§15.2: strip EXIF, keep colour profiles). JPEG only: APP1/APP2
 * segments carrying EXIF and every COM (comment) segment are marked removed;
 * SOI, APP0 (JFIF), ICC APP2, DQT/DHT, SOF, SOS + entropy + EOI are kept, so
 * re-slicing `bytes.subarray(r.start, r.end)` over `keepBytes` yields the same
 * image with metadata gone. Non-JPEG input needs no strip and plans a whole-file
 * keep. A JPEG whose header cannot be walked fails `file_corrupt` (the worker
 * never strips a file `validateUpload` has not already accepted).
 */
export function stripExifPlan(bytes: Uint8Array): StripExifResult {
  const b = new ByteReader(bytes);
  const wholeFile: StripExifPlan = {
    ok: true,
    needsStrip: false,
    keepBytes: [{ start: 0, end: b.length }],
    removed: [],
  };
  if (!b.has(0, 2) || b.u8(0) !== 0xff || b.u8(1) !== 0xd8) {
    return wholeFile; // PNG (no EXIF standard) / WebP / unknown: nothing to strip.
  }
  const header = walkJpegHeader(b);
  if (header.problem !== null) {
    return fail("file_corrupt", problemMessage(header.problem), HINT_REEXPORT);
  }
  const keep: ByteRange[] = [];
  const removed: RemovedSegment[] = [];
  let cursor = 0; // SOI [0,2) is always kept; ranges stay contiguous.
  for (const segment of header.segments) {
    const isComment = segment.code === MARKER_COM;
    if (!isComment && !isExifSegment(b, segment)) {
      continue;
    }
    if (segment.start > cursor) {
      keep.push({ start: cursor, end: segment.start });
    }
    removed.push({ marker: removedMarker(segment.code), start: segment.start, end: segment.end });
    cursor = segment.end;
  }
  if (removed.length === 0) {
    return wholeFile;
  }
  if (cursor < b.length) {
    keep.push({ start: cursor, end: b.length });
  }
  return { ok: true, needsStrip: true, keepBytes: keep, removed };
}

// ---------------------------------------------------------------------------
// validateUpload — the §20.2 gate
// ---------------------------------------------------------------------------

/**
 * Structural PNG tail check: walk the chunk chain to IEND and reject anything
 * after it. A second IHDR anywhere is a dimension-mismatch trick → corrupt.
 * Trailing bytes containing an image signature → polyglot; other trailing junk
 * → corrupt. (Only reached for files that already parsed and sit under the
 * megapixel ceiling, so the walk is bounded by the 25 MB size cap.)
 */
function pngTailCheck(b: ByteReader): UploadFailure | null {
  let pos = 8;
  for (;;) {
    if (!b.has(pos, 8)) {
      return corrupt("PNG is truncated before IEND.");
    }
    const length = b.u32be(pos);
    const typeIs = (t0: number, t1: number, t2: number, t3: number): boolean =>
      b.u8(pos + 4) === t0 && b.u8(pos + 5) === t1 && b.u8(pos + 6) === t2 && b.u8(pos + 7) === t3;
    if (typeIs(0x49, 0x48, 0x44, 0x52) && pos !== 8) {
      return corrupt("PNG contains a duplicate IHDR chunk.");
    }
    // 4 length + 4 type + data + 4 crc must fit inside the file.
    const end = pos + 12 + length;
    if (end > b.length) {
      return corrupt("PNG chunk exceeds the file length.");
    }
    if (typeIs(0x49, 0x45, 0x4e, 0x44)) {
      if (length !== 0) {
        return corrupt("PNG IEND chunk is invalid.");
      }
      if (end < b.length) {
        // The trailing region must be empty; any image magic there = polyglot.
        if (scanAnyMagic(b, end) !== null) {
          return polyglot();
        }
        return corrupt("PNG has trailing data after IEND.");
      }
      return null;
    }
    pos = end;
  }
}

/**
 * Validate an upload against §20.2: MIME sniff by magic bytes, 25 MB cap
 * (default), EXIF handled downstream (never rejected — §20.2 says stripped),
 * 60 MP bomb ceiling enforced from header dimensions alone, and §21 polyglot
 * guards (PNG double headers, trailing second-format data, duplicate IHDR,
 * JPEG second SOI/SOF).
 *
 * Check order (cheap → expensive, and deliberate): size cap → sniff →
 * strong-signature polyglot scan → header dimensions → megapixel ceiling →
 * PNG structural tail walk. A 61 MP "header-only" stub therefore reports
 * `resolution_exceeds_ceiling` (the §20.2 clear error) instead of a truncation
 * detail; structural strictness applies to files under the ceiling.
 *
 * `planCeiling` (§14.1 per-plan canvas cap) narrows the megapixel ceiling when
 * present: the effective cap is `min(maxMegapixels, planCeiling)`.
 */
export function validateUpload(bytes: Uint8Array, limits: UploadLimits = {}): UploadValidation {
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  const maxMegapixels = limits.maxMegapixels ?? DEFAULT_MAX_UPLOAD_MEGAPIXELS;
  const { planCeiling } = limits;
  const positiveFinite = (n: number): boolean => Number.isFinite(n) && n > 0;
  if (!positiveFinite(maxBytes) || !positiveFinite(maxMegapixels)) {
    // Programmer error (limits come from config, not user input): fail loudly.
    throw new Error("[storage/validate] limits must be positive finite numbers");
  }
  if (planCeiling !== undefined && !positiveFinite(planCeiling)) {
    throw new Error("[storage/validate] planCeiling must be a positive finite number");
  }

  const b = new ByteReader(bytes);

  // 1. Size cap first — cheapest, and it stops all scans before they start.
  if (b.length > maxBytes) {
    return fail(
      "upload_too_large",
      `File is ${b.length} bytes; the upload cap is ${maxBytes} bytes.`,
      `max ${maxBytes} bytes`,
    );
  }

  // 2. Magic-byte sniff (§15.2: headers lie).
  const sniffed = sniffMime(bytes);
  if (!sniffed.ok) {
    return sniffed;
  }
  const { mime } = sniffed;
  if (mime === "image/webp") {
    // Recognised on the wire, but §20.2's upload surface is JPEG/PNG only.
    return fail("unsupported_media_type", "Unsupported upload type: image/webp.", HINT_SUPPORTED);
  }

  // 3. Polyglot scan for strong signatures (PNG sig, RIFF…WEBP — collision-safe
  //    inside compressed payload at the 25 MB cap). The weak JPEG SOI is
  //    handled by the PNG tail walk instead (see module header).
  const foreign = scanStrongMagic(b, 1);
  if (foreign !== null) {
    return polyglot();
  }

  // 4. Header dimensions (never pixels).
  const parsed = mime === "image/png" ? pngDimensions(bytes) : jpegDimensions(bytes);
  if (!parsed.ok) {
    return parsed;
  }

  // 5. Megapixel ceiling from header dimensions alone — the 60 MP bomb gate.
  const ceiling = planCeiling === undefined ? maxMegapixels : Math.min(maxMegapixels, planCeiling);
  if (parsed.megapixels > ceiling) {
    const detail =
      `Image is ${parsed.width}×${parsed.height} ` +
      `(${fmtMp(parsed.megapixels)} megapixels); the cap is ${ceiling} megapixels.`;
    return fail("resolution_exceeds_ceiling", detail, `max ${ceiling} MP per image`);
  }

  // 6. PNG structural tail: IEND termination, no duplicate IHDR, no trailing file.
  if (mime === "image/png") {
    const tail = pngTailCheck(b);
    if (tail !== null) {
      return tail;
    }
  }

  return {
    ok: true,
    mime,
    width: parsed.width,
    height: parsed.height,
    megapixels: parsed.megapixels,
  };
}

// ---------------------------------------------------------------------------
// checksum — sha256 via node:crypto (asset integrity/dedupe)
// ---------------------------------------------------------------------------

/** SHA-256 of the bytes as lowercase hex (64 chars). Used for asset dedupe and
 * integrity records; never a secret. */
export function checksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
