// @studio/api-client — internal helpers shared by client.ts and sse.ts.
// NOT exported from the package barrel.

/** `true` when the error is an abort (user cancelled the request/stream). */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/** Abort reason for a signal (browsers: DOMException; node: Error or custom). */
export function getAbortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

/**
 * Sleeps for `ms` via the injected `sleep` (the test seam — real timers,
 * fake timers or zero-delay stubs), rejecting immediately when `signal`
 * aborts — so backoff waits never outlive a cancelled request and never
 * ignore the seam. The abort error propagates as-is (never wrapped in an
 * ApiError: the caller asked for it).
 */
export function sleepWithAbort(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) return sleep(ms);
  if (signal.aborted) return Promise.reject(getAbortError(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      reject(getAbortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    let settled = false;
    const settle =
      (settleFn: (error?: unknown) => void): ((error?: unknown) => void) =>
      (error?: unknown) => {
        if (settled) return; // first settlement wins, the other is a no-op
        settled = true;
        signal.removeEventListener("abort", onAbort);
        settleFn(error);
      };
    sleep(ms).then(
      settle(() => resolve()),
      settle((error?: unknown) => reject(error)),
    );
  });
}
