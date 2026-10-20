// @studio/storage — the `objects` service seam (spec §3.1: S3 AWS or R2 Cloudflare —
// uploaded originals, generated images, previews, exports, `.pcraft` backups).
//
// The Storage interface is STRUCTURAL and injected everywhere (docs/AGENTS.md
// "Zod at every boundary", §4 repository layout): gateway, worker and engine-pool
// consume the interface, never a concrete driver.
//
// Error surface (docs/AGENTS.md "typed result envelopes"):
//   * Pure helpers (keys.ts, createStorageFromEnv) return `StorageResult<T>` —
//     either `{ ok: true, value }` or a `StorageFailure` envelope
//     `{ ok: false, code, message, hint?, retryable? }`.
//   * Driver methods keep their task-mandated plain signatures
//     (`get(key): Promise<Uint8Array | null>`, …) and REJECT with `StorageError` —
//     a typed error class that IS the failure envelope (plus `toFailure()`).
//     Never a thrown string; `isStorageError()` narrows at the call site.
//     §13.3: messages never leak stack traces, absolute paths or internal ids.
//
// License policy (§16.5): S3/R2 only — MinIO and Garage are AGPL and forbidden;
// the optional `aws4fetch` signer is MIT (licenses.overrides.json).

import { z } from "zod";

// ---------------------------------------------------------------------------
// Typed error envelope (self-contained; structurally compatible with the
// fleet's Failure shape — this package depends on zod only, task W2-M)
// ---------------------------------------------------------------------------

/** Every error this package can produce. Codes are stable strings (§13.3). */
export const STORAGE_ERROR_CODES = [
  /** Malformed/unsafe object key (traversal, charset, length, layout). */
  "storage_invalid_key",
  /** Cross-tenant access — key belongs to another organization (§15.1). */
  "cross_tenant_key",
  /** Misconfiguration: missing/invalid env or driver options. */
  "storage_config_invalid",
  /** sign() ttlSeconds outside 1..900 (§15.1 signed URLs ≤ 15 min). */
  "storage_invalid_ttl",
  /** Bad method argument (put options, non-Uint8Array data, …). */
  "storage_invalid_argument",
  /** The optional aws4fetch signer is not installed at runtime. */
  "storage_driver_unavailable",
  /** Transport/filesystem failure (network, non-2xx, node errno). Retryable. */
  "storage_io_error",
  /** put() contentSha256 does not match the bytes actually stored. */
  "storage_checksum_mismatch",
] as const satisfies readonly string[];

export type StorageErrorCode = (typeof STORAGE_ERROR_CODES)[number];

export interface StorageFailure {
  readonly ok: false;
  readonly code: StorageErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly retryable?: boolean;
}

export type StorageResult<T> = { readonly ok: true; readonly value: T } | StorageFailure;

interface FailureOptions {
  readonly hint?: string;
  readonly retryable?: boolean;
}

/** Build a failure envelope (fields are omitted unless explicitly set). */
export function storageFailure(
  code: StorageErrorCode,
  message: string,
  options: FailureOptions = {},
): StorageFailure {
  const failure: {
    ok: false;
    code: StorageErrorCode;
    message: string;
    hint?: string;
    retryable?: boolean;
  } = { ok: false, code, message };
  if (options.hint !== undefined) {
    failure.hint = options.hint;
  }
  if (options.retryable !== undefined) {
    failure.retryable = options.retryable;
  }
  return failure;
}

/** Narrow an unknown value to a StorageFailure envelope. */
export function isStorageFailure(value: unknown): value is StorageFailure {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { ok?: unknown; code?: unknown; message?: unknown };
  return (
    candidate.ok === false &&
    typeof candidate.code === "string" &&
    (STORAGE_ERROR_CODES as readonly string[]).includes(candidate.code) &&
    typeof candidate.message === "string"
  );
}

/**
 * The typed error drivers reject with. Carries the full failure envelope, so a
 * `catch` block can either read `err.code` / `err.hint` directly or call
 * `toFailure()` for the plain `{ ok: false, … }` shape (gateway error-mapper).
 */
export class StorageError extends Error {
  readonly ok: false = false;
  readonly code: StorageErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly retryable?: boolean;

  constructor(
    code: StorageErrorCode,
    message: string,
    options: FailureOptions & { readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "StorageError";
    this.code = code;
    this.message = message;
    if (options.hint !== undefined) {
      this.hint = options.hint;
    }
    if (options.retryable !== undefined) {
      this.retryable = options.retryable;
    }
  }

  /** The §13.3 envelope (no stack, no cause, safe to return to a client). */
  toFailure(): StorageFailure {
    return storageFailure(this.code, this.message, {
      hint: this.hint,
      retryable: this.retryable,
    });
  }
}

/** Narrow an unknown rejection/exception to a StorageError. */
export function isStorageError(value: unknown): value is StorageError {
  return value instanceof StorageError;
}

/** Wrap a failure envelope into the typed error drivers reject with. */
export function storageErrorFromFailure(failure: StorageFailure, cause?: unknown): StorageError {
  return new StorageError(failure.code, failure.message, {
    hint: failure.hint,
    retryable: failure.retryable,
    cause,
  });
}

// ---------------------------------------------------------------------------
// Object metadata + put/sign options (Zod at the boundary)
// ---------------------------------------------------------------------------

/** Metadata for one stored object, returned by put(). */
export interface StorageObject {
  /** Logical key (tenant-scoped key space, keys.ts). */
  readonly key: string;
  /** Object size in bytes. */
  readonly bytes: number;
  /** MIME type the object was stored with. */
  readonly contentType: string;
  /** Lowercase hex SHA-256 of the stored bytes (computed by the driver). */
  readonly sha256: string;
}

/** Lowercase hex SHA-256, 64 characters. */
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

const CONTENT_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;

export const PUT_OPTIONS_SCHEMA = z
  .strictObject({
    contentType: z.string().regex(CONTENT_TYPE_PATTERN, "contentType must be a MIME type"),
    contentSha256: z.string().regex(SHA256_HEX_PATTERN, "contentSha256 must be 64-char lowercase hex").optional(),
  });

/** Options for put(). `contentType` is required; `contentSha256` is verified when given. */
export interface PutOptions {
  readonly contentType: string;
  /** Expected lowercase-hex SHA-256; a mismatch fails the put (integrity check). */
  readonly contentSha256?: string;
}

/** Options for sign(). ttlSeconds is capped at 15 min (§15.1: no public buckets, short-lived URLs). */
export const MAX_SIGN_TTL_SECONDS = 900;

export const SIGN_OPTIONS_SCHEMA = z
  .strictObject({
    ttlSeconds: z
      .number()
      .int()
      .min(1)
      .max(MAX_SIGN_TTL_SECONDS, "signed URLs live at most 15 minutes (§15.1)"),
    download: z.boolean().optional(),
  });

/** Options for sign(): `ttlSeconds` 1..900; `download` forces a Content-Disposition attachment. */
export interface SignOptions {
  readonly ttlSeconds: number;
  readonly download?: boolean;
}

/** A short-lived URL + its expiry (epoch milliseconds). */
export interface SignedUrl {
  readonly url: string;
  readonly expiresAt: number;
}

// ---------------------------------------------------------------------------
// The Storage seam (structural, DI everywhere)
// ---------------------------------------------------------------------------

/**
 * Object storage for the `objects` service (§3.1). Implementations:
 * LocalFsStorage (dev/single-box) and S3Storage (AWS S3 / Cloudflare R2).
 *
 * Tenancy: keys embed `…/organizations/<orgId>/…` (keys.ts); callers MUST run
 * assertTenant() on any key derived from request input before touching storage
 * (§15.1 per-workspace prefixes, cross-tenant 404s). list() is prefix-scoped
 * only — callers keep applying the tenant guard to every yielded key.
 */
export interface Storage {
  /** Store bytes; returns the object metadata (sha256 always computed). */
  put(key: string, data: Uint8Array, options: PutOptions): Promise<StorageObject>;
  /** Read bytes; resolves null when the object does not exist. */
  get(key: string): Promise<Uint8Array | null>;
  /** Delete; idempotent (missing objects are not an error, like S3). */
  delete(key: string): Promise<void>;
  /** Mint a short-lived GET URL (§13 uploads/preview routes, ttlSeconds ≤ 900). */
  sign(key: string, options: SignOptions): Promise<SignedUrl>;
  /** Yield logical keys under a prefix, lexicographic per directory/page. */
  list(prefix: string): AsyncIterable<string>;
}
