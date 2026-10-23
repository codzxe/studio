/** Media types this module can recognise by magic bytes. */
export type ImageMime = "image/png" | "image/jpeg" | "image/webp";
/**
 * Stable error codes for the upload path (§13.3 add-only style).
 * Deliberately module-local: @studio/config's catalog does not carry upload
 * codes; the envelope shape is structurally identical to its `Failure`.
 */
export type UploadErrorCode = "unsupported_media_type" | "upload_too_large" | "resolution_exceeds_ceiling" | "file_corrupt" | "polyglot_detected";
/** Typed failure envelope. Upload rejections are never retryable. */
export interface UploadFailure {
    readonly ok: false;
    readonly code: UploadErrorCode;
    readonly message: string;
    readonly hint?: string;
    readonly retryable: false;
}
/** Result of `sniffMime`. */
export type SniffResult = {
    readonly ok: true;
    readonly mime: ImageMime;
} | UploadFailure;
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
export declare const DEFAULT_MAX_UPLOAD_BYTES: number;
/** §20.2: megapixel bomb ceiling — 60 MP (mirrors @studio/config). */
export declare const DEFAULT_MAX_UPLOAD_MEGAPIXELS = 60;
/**
 * Detect the media type from magic bytes (§15.2: sniff, never trust headers).
 * PNG → `image/png`, JPEG (FF D8 FF) → `image/jpeg`, WEBP (RIFF…WEBP) →
 * `image/webp`; anything else — including SVG, GIF and empty input — fails
 * with `unsupported_media_type` (SVG is deliberately not sniffable: §15.2 XSS
 * note — only sanitised SVG may ever be accepted, and never via this path).
 */
export declare function sniffMime(bytes: Uint8Array): SniffResult;
/**
 * Parse PNG width/height from the IHDR chunk (big-endian at offsets 16/20 —
 * first chunk, 13-byte data, CRC32 over `IHDR` + data verified). Zero
 * dimensions, a foreign first chunk, or a CRC mismatch → `file_corrupt`.
 * Structural tail checks (IEND/polyglot) live in `validateUpload`.
 */
export declare function pngDimensions(bytes: Uint8Array): DimensionResult;
/**
 * Scan for the SOF0/SOF2 frame marker and read width/height from it (baseline
 * and progressive JPEG, §20.2's JPEG surface). Truncated files, files with no
 * SOF before SOS/EOI, a second SOI/SOF, or zero dimensions → `file_corrupt`.
 */
export declare function jpegDimensions(bytes: Uint8Array): DimensionResult;
/**
 * Parse dimensions by sniffed type. PNG/JPEG are parsed header-only; WebP is
 * recognised by `sniffMime` but not dimension-parsed here (§20.2's upload
 * surface is JPEG/PNG), failing with `unsupported_media_type`.
 */
export declare function dimensions(bytes: Uint8Array): DimensionResult;
/**
 * Whether the bytes contain EXIF metadata. JPEG only: APP1/APP2 `Exif\0\0`
 * with an `II*`/`MM*` TIFF byte order. PNG has no EXIF standard → false; WebP
 * and anything unrecognised → false. Detector semantics — never throws.
 */
export declare function hasExif(bytes: Uint8Array): boolean;
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
export declare function stripExifPlan(bytes: Uint8Array): StripExifResult;
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
export declare function validateUpload(bytes: Uint8Array, limits?: UploadLimits): UploadValidation;
/** SHA-256 of the bytes as lowercase hex (64 chars). Used for asset dedupe and
 * integrity records; never a secret. */
export declare function checksum(bytes: Uint8Array): string;
