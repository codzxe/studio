// @studio/gateway — rate limiting middleware backing (§7.1: per-IP/user/
// workspace limits; W2-b scope: per (ip, route-class) token buckets).
//
// Interface-first: a Valkey implementation can replace the in-memory one
// behind the same `RateLimiter` seam when the multi-instance deployment
// lands (§14.2 scale-out path). TODO(W4/queue agent): implement
// ValkeyRateLimiter against VALKEY_URL; the wire contract is check() only.

export type RouteClass = "auth" | "chat" | "mutation" | "read";

/** Requests per minute per (ip, route-class) — W2-b task spec. */
export const RATE_LIMITS: Readonly<Record<RouteClass, number>> = Object.freeze({
  auth: 10,
  chat: 20,
  mutation: 60,
  read: 240,
});

const WINDOW_MS = 60_000;
const SWEEP_THRESHOLD = 10_000;

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Seconds until the caller may retry (only meaningful when disallowed). */
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  check(ip: string, routeClass: RouteClass, now?: number): RateLimitDecision;
  /** Drop all buckets (graceful-shutdown/test helper). */
  reset(): void;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

/**
 * In-memory token bucket: capacity = per-minute limit, refilled linearly
 * (limit tokens per 60s). Keyed by (ip, route-class). Lazy sweep keeps the
 * map bounded under address-spoofing floods (single-instance posture only —
 * see the Valkey TODO above).
 */
export function createInMemoryRateLimiter(): RateLimiter {
  const buckets = new Map<string, Bucket>();

  function sweep(now: number): void {
    if (buckets.size < SWEEP_THRESHOLD) return;
    for (const [key, bucket] of buckets) {
      // A bucket idle for a full window is effectively full; drop it.
      if (now - bucket.lastRefill > WINDOW_MS) buckets.delete(key);
    }
  }

  return {
    check(ip, routeClass, now = Date.now()) {
      sweep(now);
      const limit = RATE_LIMITS[routeClass];
      const key = `${ip}::${routeClass}`;
      const existing = buckets.get(key);
      let tokens: number;
      if (existing === undefined) {
        tokens = limit;
      } else {
        const elapsed = Math.max(0, now - existing.lastRefill);
        tokens = Math.min(limit, existing.tokens + (elapsed * limit) / WINDOW_MS);
      }
      if (tokens >= 1) {
        buckets.set(key, { tokens: tokens - 1, lastRefill: now });
        return { allowed: true, retryAfterSeconds: 0 };
      }
      const neededMs = Math.ceil(((1 - tokens) * WINDOW_MS) / limit);
      buckets.set(key, { tokens, lastRefill: now });
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(neededMs / 1000)) };
    },
    reset() {
      buckets.clear();
    },
  };
}
