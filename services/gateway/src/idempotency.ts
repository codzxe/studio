// @studio/gateway — idempotency middleware backing (§7.2: mutations require
// an Idempotency-Key; replay returns the stored result; a key reused with a
// different payload is a VALIDATION_FAILED).
//
// In-memory store with a 10-minute TTL — the same seam a Valkey/Postgres
// implementation can replace for multi-instance deployments.

import { createHash } from "node:crypto";

export const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

export interface StoredIdempotentResult {
  readonly status: number;
  readonly body: unknown;
  readonly contentType: string;
  readonly payloadHash: string;
  readonly expiresAt: number;
  readonly complete: boolean;
}

export interface IdempotencyStore {
  /**
   * Look up a key. Returns the stored entry when present and not expired.
   * An in-flight entry (same key, handler still running) is returned with
   * `complete === false` so the caller can await the shared outcome.
   */
  lookup(key: string, now?: number): StoredIdempotentResult | null;
  /** Reserve the key; false when already taken (concurrent duplicate). */
  begin(key: string, payloadHash: string, now?: number): boolean;
  /** Store the final result. */
  complete(
    key: string,
    payloadHash: string,
    status: number,
    body: unknown,
    contentType: string,
    now?: number,
  ): void;
  /** Drop an in-flight reservation (handler failed before responding). */
  release(key: string): void;
  /** Resolve when the in-flight handler completes or releases the key. */
  waitFor(key: string): Promise<void>;
  /** Test/helper: drop everything. */
  reset(): void;
}

/** In-flight bookkeeping: the middleware awaits the original handler's result. */
interface Entry extends StoredIdempotentResult {
  readonly done: Promise<void> | null;
  resolve?: () => void;
}

export function createInMemoryIdempotencyStore(): IdempotencyStore {
  const entries = new Map<string, Entry>();

  function sweep(now: number): void {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(key);
    }
  }

  return {
    lookup(key, now = Date.now()) {
      sweep(now);
      const entry = entries.get(key);
      if (entry === undefined) return null;
      if (entry.expiresAt <= now) {
        entries.delete(key);
        return null;
      }
      return entry;
    },
    begin(key, payloadHash, now = Date.now()) {
      sweep(now);
      const existing = entries.get(key);
      if (existing !== undefined && existing.expiresAt > now) return false;
      let resolve: () => void = () => {};
      const done = new Promise<void>((res) => {
        resolve = res;
      });
      entries.set(key, {
        payloadHash,
        status: 0,
        body: null,
        contentType: "application/json",
        expiresAt: now + IDEMPOTENCY_TTL_MS,
        complete: false,
        done,
        resolve,
      });
      return true;
    },
    complete(key, payloadHash, status, body, contentType, now = Date.now()) {
      const existing = entries.get(key);
      if (existing === undefined) return;
      const entry: Entry = {
        payloadHash,
        status,
        body,
        contentType,
        expiresAt: now + IDEMPOTENCY_TTL_MS,
        complete: true,
        done: null,
      };
      entries.set(key, entry);
      existing.resolve?.();
    },
    release(key) {
      const existing = entries.get(key);
      if (existing !== undefined && !existing.complete) {
        entries.delete(key);
        existing.resolve?.();
      }
    },
    async waitFor(key) {
      const existing = entries.get(key);
      if (existing === undefined) return;
      if (existing.complete || existing.done === null) return;
      await existing.done;
    },
    reset() {
      entries.clear();
    },
  };
}

/**
 * Fingerprint the request payload. JSON bodies are hashed content-wise
 * (Hono caches parsed bodies, so this does not consume the stream); binary
 * uploads fall back to transport identifiers — the client-chosen key is
 * still unique per operation, and §7.2's requirement is replay-detection,
 * not adversarial dedup.
 */
export async function fingerprintPayload(request: Request): Promise<string> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const parsed = await (request as Request & { json(): Promise<unknown> }).clone().json();
      const hash = createHash("sha256");
      hash.update(JSON.stringify(parsed));
      return hash.digest("hex");
    } catch {
      // fall through to transport fingerprint
    }
  }
  const hash = createHash("sha256");
  hash.update(
    `${request.method} ${request.url} ${contentType} ${request.headers.get("content-length") ?? ""}`,
  );
  return hash.digest("hex");
}
