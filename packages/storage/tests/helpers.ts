// Shared vitest helpers (typed result envelopes — fleet style, billing/tests).

import type { StorageFailure, StorageResult } from "../src/types.js";

export function expectOk<T>(result: StorageResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.code}: ${result.message}`);
  }
  return result.value;
}

export function expectErr<T>(result: StorageResult<T>): StorageFailure {
  if (result.ok) {
    throw new Error(`expected failure, got ok: ${JSON.stringify(result.value)}`);
  }
  return result;
}

/** Assert a driver rejection carries the expected typed code, return it. */
export async function expectStorageErrorCode(
  promise: Promise<unknown>,
  code: string,
): Promise<{ readonly message: string; readonly hint?: string; readonly retryable?: boolean }> {
  try {
    await promise;
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: unknown }).code === code &&
      "message" in err &&
      typeof (err as { message?: unknown }).message === "string"
    ) {
      const typed = err as { message: string; hint?: string; retryable?: boolean };
      return typed;
    }
    throw new Error(`expected a typed error with code ${code}, got: ${String(err)}`);
  }
  throw new Error(`expected a rejection with code ${code}, but the promise resolved`);
}
