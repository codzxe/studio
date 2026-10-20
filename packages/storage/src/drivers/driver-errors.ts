// @studio/storage — driver-boundary helpers shared by the local-fs and s3
// drivers: unwrap typed failures into the StorageError drivers reject with,
// and parse put/sign option objects with zod (docs/AGENTS.md boundary rule).
// Issue summaries name paths and messages only — values are never echoed.

import {
  PUT_OPTIONS_SCHEMA,
  type PutOptions,
  SIGN_OPTIONS_SCHEMA,
  type SignOptions,
  StorageError,
  type StorageResult,
  storageErrorFromFailure,
} from "../types.js";

/** Unwrap a key/prefix validation result or reject with its typed failure. */
export function keyError(result: StorageResult<string>): string {
  if (!result.ok) {
    throw storageErrorFromFailure(result);
  }
  return result.value;
}

/** Unwrap a list-prefix validation result or reject with its typed failure. */
export function prefixError(result: StorageResult<string>): string {
  if (!result.ok) {
    throw storageErrorFromFailure(result);
  }
  return result.value;
}

function summarizeIssues(
  issues: ReadonlyArray<{ readonly path: ReadonlyArray<unknown>; readonly message: string }>,
): string {
  return issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

/** Parse put() options at the boundary; rejects with storage_invalid_argument. */
export function putOptionsError(options: unknown): PutOptions {
  const parsed = PUT_OPTIONS_SCHEMA.safeParse(options);
  if (!parsed.success) {
    throw new StorageError(
      "storage_invalid_argument",
      `put() options failed validation: ${summarizeIssues(parsed.error.issues)}`,
      { hint: "expected { contentType: <mime>, contentSha256?: <64-char lowercase hex> }" },
    );
  }
  return parsed.data;
}

/** Parsed sign() options. */
export interface ParsedSignOptions {
  readonly ttlSeconds: number;
  readonly download: boolean;
}

/** Parse sign() options at the boundary; rejects with storage_invalid_ttl (§15.1 ≤ 900 s). */
export function signOptionsError(options: unknown): ParsedSignOptions {
  const parsed = SIGN_OPTIONS_SCHEMA.safeParse(options);
  if (!parsed.success) {
    throw new StorageError(
      "storage_invalid_ttl",
      `sign() options failed validation: ${summarizeIssues(parsed.error.issues)}`,
      {
        hint: "ttlSeconds must be an integer between 1 and 900 (§15.1: signed URLs live ≤ 15 minutes)",
      },
    );
  }
  return { ttlSeconds: parsed.data.ttlSeconds, download: parsed.data.download === true };
}

/** Map a fetch Response failure to a typed storage error (S3 error code, no paths). */
export function httpStatusError(
  action: string,
  status: number,
  s3ErrorCode: string | null,
  bodySnippet: string | null,
): StorageError {
  const detail = s3ErrorCode === null ? "" : ` (S3 error ${s3ErrorCode})`;
  return new StorageError("storage_io_error", `${action} failed with HTTP ${status}${detail}`, {
    hint: bodySnippet === null ? undefined : bodySnippet,
    retryable: true,
  });
}
