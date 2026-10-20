// Rate limiter service (§1.5 rule 5 "no abuse surface": per-workspace rate
// limits; §15.2 "rate limits per IP/user/workspace on auth, uploads, runs and
// exports"; §22.1 `rate_limit_buckets` state shape).
//
// Design:
//   - `RateLimiter` owns bucket math ONLY. It never touches a socket, env or
//     a global: all state goes through an injected `KVLike` (get/set with TTL,
//     optional compare-set), so `buildApp` can wire an ioredis/Valkey adapter
//     (ADR-0004: Valkey, not Redis — RSALv2/SSPL is forbidden, §16.5) while
//     tests use the deterministic in-memory implementation below.
//   - Two algorithms: a token bucket (burst-friendly default — a workspace
//     can fire a few parallel edits, then throttles to the sustained rate) and
//     a fixed-window counter as the simpler fallback (callers opt in via
//     `RateLimiter.fixedWindow`; window-edge bursts are its known weakness).
//   - Keys are composite per (scope, subject): `scope` names the limit
//     (e.g. "api.runs.create"), the subject is the bucket owner — per
//     workspace (org id), per IP, or the workspace+IP pair (§1.5/§15.2). The
//     pair maps 1:1 to the `rate_limit_buckets` (scope, bucket_key) unique
//     row when the adapter is Postgres-backed; the Valkey adapter uses the
//     same layout for cache-local buckets.

/**
 * Minimal key/value seam for rate-limit state.
 *
 * Wireable to ioredis/Valkey in `buildApp` (sketch — the adapter is owned by
 * the bootstrap, not this file):
 *
 * ```ts
 * const redis = new Redis(env.VALKEY_URL); // ioredis speaks the Valkey protocol
 * const kv: KVLike = {
 *   get: (key) => redis.get(key),
 *   set: async (key, value, ttlSec) => { await redis.set(key, value, "EX", ttlSec); },
 *   // One atomic step via a tiny Lua script (single node, so KEYS[1] is safe):
 *   //   local cur = redis.call("GET", KEYS[1])
 *   //   if (ARGV[1] == "" and not cur) or (ARGV[1] ~= "" and cur == ARGV[1]) then
 *   //     redis.call("SET", KEYS[1], ARGV[2], "EX", tonumber(ARGV[3])); return 1
 *   //   end
 *   //   return 0
 *   // ("" is the "was absent" sentinel — Lua gets no nil ARGV from ioredis.)
 *   compareSet: (key, expected, next, ttlSec) =>
 *     redis.eval(CAS_LUA, 1, key, expected ?? "", next, ttlSec).then((n) => Number(n) === 1),
 * };
 * ```
 */
export interface KVLike {
  /** Raw value stored under `key`, or `null` when absent or TTL-expired. */
  get(key: string): Promise<string | null>;

  /** Overwrite `key` with `value`, expiring after `ttlSec` seconds (> 0). */
  set(key: string, value: string, ttlSec: number): Promise<void>;

  /**
   * Compare-and-set: write `next` only if the value currently stored under
   * `key` is still byte-equal to `expected` (`null` means "only if absent").
   * Returns `true` when the write landed, `false` when another writer raced
   * us and the caller should re-read and re-decide.
   *
   * Compare-set semantics an adapter MUST guarantee:
   *   1. The compare and the write are ONE indivisible step (a Lua script,
   *      WATCH/MULTI/EXEC, or a synchronous in-process store). A write that
   *      happened between the caller's `get` and this call MUST fail the
   *      compare — never merge.
   *   2. The TTL is (re)applied on every successful write, exactly like
   *      `set` with the same `ttlSec`.
   *   3. "Value changed" is a `false` result, never an exception. Transport
   *      failures MAY throw; the middleware fails open on those (documented
   *      in middleware/rate-limit.ts).
   *
   * Optional on purpose: adapters with plain `get`+`set` still work — the
   * limiter falls back to unconditional writes. Cost: two racing requests can
   * consume the same token (drift bounded by the concurrent writers on one
   * hot key; the window cap still bounds abuse). Production SHOULD implement
   * CAS for exact counting.
   */
  compareSet?(
    key: string,
    expected: string | null,
    next: string,
    ttlSec: number,
  ): Promise<boolean>;
}

/** A limit policy: how many events over how long a window. */
export interface RateLimitPolicy {
  /** Burst capacity (token bucket) or window allowance (fixed window) — >= 1. */
  readonly limit: number;
  /** Window length in seconds (> 0; fractional allowed). Full refill window. */
  readonly windowSec: number;
}

/** The limiter verdict the middleware turns into headers / a 429. */
export interface RateLimitDecision {
  /** True when the event is admitted and should proceed. */
  readonly allowed: boolean;
  /** Whole events still affordable right now (floor of spare tokens). */
  readonly remaining: number;
  /** 0 when allowed; otherwise seconds until one event is affordable (>= 1). */
  readonly retryAfterSec: number;
}

/** Constructor deps for RateLimiter. */
export interface RateLimiterDeps {
  /** State store — Valkey in production (ADR-0004), InMemoryKV in tests. */
  readonly kv: KVLike;
  /** Epoch-millis clock, injectable so tests are deterministic. Default Date.now. */
  readonly now?: () => number;
  /**
   * Compare-set races to retry before degrading to an unconditional write
   * (availability over exactness on a hot key). Default 3. 0 disables CAS.
   */
  readonly casAttempts?: number;
}

// --- Composite bucket keys (per-workspace / per-IP / both — §1.5 + §15.2) ---

/** Which subject a bucket counts for. */
export type RateLimitSubject =
  | { readonly kind: "org"; readonly organizationId: string }
  | { readonly kind: "ip"; readonly ip: string }
  | { readonly kind: "org+ip"; readonly organizationId: string; readonly ip: string };

/**
 * Charset/injection guard: bucket keys become KV keys AND the
 * `rate_limit_buckets.bucket_key` column, so subject fields are stripped to
 * identifier characters (uuid org ids, IPv4/IPv6 text) and length-capped.
 * Anything that fails validation collapses to "unknown" (an aggregated but
 * never-bypassable bucket).
 */
function subjectComponent(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9.:@_-]/g, "").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "unknown";
}

/**
 * Stable bucket key (the `rate_limit_buckets.bucket_key` value) for a subject:
 *
 *   org    → "org:<organizationId>"           per-workspace (§1.5)
 *   ip     → "ip:<ip>"                        pre-auth surfaces (§15.2)
 *   org+ip → "org:<organizationId>|ip:<ip>"    per-user inside a workspace
 */
export function subjectBucketKey(subject: RateLimitSubject): string {
  switch (subject.kind) {
    case "org":
      return `org:${subjectComponent(subject.organizationId)}`;
    case "ip":
      return `ip:${subjectComponent(subject.ip)}`;
    case "org+ip":
      return `org:${subjectComponent(subject.organizationId)}|ip:${subjectComponent(subject.ip)}`;
  }
}

// --- Local in-memory KV (tests + degraded local mode; never for prod) ---

interface InMemoryEntry {
  readonly value: string;
  readonly expiresAtMs: number;
}

/**
 * Deterministic single-process KVLike with TTL expiry and CAS. Expiry is lazy
 * (checked on read) plus a bounded-growth sweep on write, so a hammering
 * subject cannot grow the map forever.
 *
 * `compareSet` has NO internal await: its read-compare-write body runs to
 * completion inside one event-loop turn, which is what makes it atomic here —
 * an `await` between the read and the write would let a concurrent caller
 * interleave and turn the CAS into a lost update.
 */
export class InMemoryKV implements KVLike {
  readonly #entries = new Map<string, InMemoryEntry>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  #getSync(key: string): string | null {
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      return null;
    }
    if (this.#now() >= entry.expiresAtMs) {
      this.#entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async get(key: string): Promise<string | null> {
    return this.#getSync(key);
  }

  async set(key: string, value: string, ttlSec: number): Promise<void> {
    if (ttlSec <= 0) {
      throw new Error("[InMemoryKV] ttlSec must be > 0 (KVLike contract)");
    }
    if (this.#entries.size >= 10_000) {
      const nowMs = this.#now();
      for (const [k, entry] of this.#entries) {
        if (nowMs >= entry.expiresAtMs) {
          this.#entries.delete(k);
        }
      }
    }
    this.#entries.set(key, { value, expiresAtMs: this.#now() + ttlSec * 1000 });
  }

  compareSet(
    key: string,
    expected: string | null,
    next: string,
    ttlSec: number,
  ): Promise<boolean> {
    const current = this.#getSync(key); // atomic: no await before the write
    if (current !== expected) {
      return Promise.resolve(false);
    }
    this.#entries.set(key, { value: next, expiresAtMs: this.#now() + ttlSec * 1000 });
    return Promise.resolve(true);
  }

  /** Test helper: live key count (not part of the KVLike contract). */
  get size(): number {
    return this.#entries.size;
  }
}

// --- RateLimiter ---

/** Serialized token-bucket state: `{"t":<tokens>,"u":<updatedAtMs>}`. */
interface BucketState {
  readonly t: number;
  readonly u: number;
}

function parseBucketState(raw: string | null): BucketState | null {
  if (raw === null || !raw.startsWith('{"t":')) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { t?: unknown }).t !== "number" ||
    typeof (parsed as { u?: unknown }).u !== "number" ||
    !Number.isFinite((parsed as { t: number }).t) ||
    !Number.isInteger((parsed as { u: number }).u) ||
    (parsed as { t: number }).t < 0
  ) {
    return null;
  }
  return { t: (parsed as { t: number }).t, u: (parsed as { u: number }).u };
}

function assertPolicy(policy: RateLimitPolicy, caller: string): void {
  if (!Number.isInteger(policy.limit) || policy.limit < 1) {
    throw new Error(`[${caller}] limit must be an integer >= 1 (got ${String(policy.limit)})`);
  }
  if (
    typeof policy.windowSec !== "number" ||
    !Number.isFinite(policy.windowSec) ||
    policy.windowSec <= 0
  ) {
    throw new Error(
      `[${caller}] windowSec must be a finite number > 0 (got ${String(policy.windowSec)})`,
    );
  }
}

function assertNames(scope: string, bucketKey: string, caller: string): void {
  if (scope.length === 0 || bucketKey.length === 0) {
    throw new Error(`[${caller}] scope and bucketKey must be non-empty`);
  }
}

/**
 * Token-bucket / fixed-window rate limiter over an injected KV store.
 *
 * Token bucket (default): capacity `limit` tokens, refilled continuously at
 * `limit / windowSec` tokens per second, so a full refill takes `windowSec`.
 * One token is charged per allowed event. An empty-bucket denial carries the
 * seconds until ONE token is affordable, so the middleware can hint
 * `Retry-After` without polling. State is a single JSON blob per bucket
 * (tokens + updatedAtMs), which is what lets one compare-set make the whole
 * read-modify-write atomic.
 *
 * Fixed window (`fixedWindow`): a counter per `floor(now / windowSec)` slice
 * of the subject; denial hints the time to the next window boundary. Denials
 * never write (the counter is unchanged), so the deny path is a pure read.
 */
export class RateLimiter {
  readonly #kv: KVLike;
  readonly #now: () => number;
  readonly #casAttempts: number;

  constructor(deps: RateLimiterDeps) {
    this.#kv = deps.kv;
    this.#now = deps.now ?? Date.now;
    const attempts = deps.casAttempts ?? 3;
    this.#casAttempts = Number.isInteger(attempts) && attempts >= 0 ? attempts : 0;
  }

  /**
   * Charge one event against a token bucket.
   *
   * Atomicity: read → refill → charge → compare-set. A `compareSet` failure
   * means another request raced us; we re-read and re-decide up to
   * `casAttempts` times, then take an unconditional write so the hot path
   * never wedges (bounded drift, see KVLike.compareSet). State persists on
   * EVERY decision — allowed or denied — so the TTL only ever expires a
   * bucket that has been idle for a full window (and is therefore
   * legitimately full again).
   */
  async tokenBucket(
    scope: string,
    bucketKey: string,
    policy: RateLimitPolicy,
  ): Promise<RateLimitDecision> {
    assertPolicy(policy, "tokenBucket");
    assertNames(scope, bucketKey, "tokenBucket");

    // A bucket untouched for a full window refills to capacity, so a TTL of
    // one window is exact: expiry == "back to full", never more, never less.
    const kvKey = `${scope}:${bucketKey}`;
    const ttlSec = Math.max(1, Math.ceil(policy.windowSec));
    const refillPerSec = policy.limit / policy.windowSec;

    for (let attempt = 0; ; attempt++) {
      const raw = await this.#kv.get(kvKey);
      const nowMs = Math.floor(this.#now());
      const state = parseBucketState(raw);
      // Absent or corrupt state = a fresh full bucket (corruption must never
      // lock a workspace out; a new subject starts with its full burst).
      const elapsedSec = state === null ? 0 : Math.max(0, (nowMs - state.u) / 1000);
      const tokens = Math.min(
        policy.limit,
        (state?.t ?? policy.limit) + elapsedSec * refillPerSec,
      );

      const allowed = tokens >= 1;
      const nextTokens = allowed ? tokens - 1 : tokens;
      const next = `{"t":${nextTokens},"u":${nowMs}}`;

      if (this.#kv.compareSet === undefined || attempt >= this.#casAttempts) {
        // No CAS available, or too many races: last-write-wins and move on.
        await this.#kv.set(kvKey, next, ttlSec);
        return tokenDecision(policy, allowed, nextTokens, tokens);
      }
      if (await this.#kv.compareSet(kvKey, raw, next, ttlSec)) {
        return tokenDecision(policy, allowed, nextTokens, tokens);
      }
      // Raced: loop and re-decide on fresh state.
    }
  }

  /**
   * Count one event against a fixed window (the fallback algorithm).
   * Key layout: "<scope>:<bucketKey>:w<windowIndex>" — every window gets a
   * fresh counter with its own TTL, so no reset job ever runs.
   */
  async fixedWindow(
    scope: string,
    bucketKey: string,
    policy: RateLimitPolicy,
  ): Promise<RateLimitDecision> {
    assertPolicy(policy, "fixedWindow");
    assertNames(scope, bucketKey, "fixedWindow");

    const windowMs = policy.windowSec * 1000;
    const ttlSec = Math.max(1, Math.ceil(policy.windowSec));

    for (let attempt = 0; ; attempt++) {
      const nowMs = Math.floor(this.#now());
      const windowIndex = Math.floor(nowMs / windowMs);
      const kvKey = `${scope}:${bucketKey}:w${windowIndex}`;
      const raw = await this.#kv.get(kvKey);
      const count = raw === null ? 0 : Number.parseInt(raw, 10);
      const known = raw !== null && Number.isInteger(count) && count >= 0;

      if (!known) {
        // Corrupt counter: start the window over rather than lock the subject
        // out. Plain write — a corrupted key racing a live writer is not a
        // state anyone can abuse, and the next window self-heals anyway.
        await this.#kv.set(kvKey, "1", ttlSec);
        return { allowed: true, remaining: policy.limit - 1, retryAfterSec: 0 };
      }
      if (count >= policy.limit) {
        const windowEndMs = (windowIndex + 1) * windowMs;
        const retryAfterSec = Math.max(1, Math.ceil((windowEndMs - nowMs) / 1000));
        return { allowed: false, remaining: 0, retryAfterSec };
      }

      const next = String(count + 1);
      if (this.#kv.compareSet === undefined || attempt >= this.#casAttempts) {
        await this.#kv.set(kvKey, next, ttlSec);
        return { allowed: true, remaining: policy.limit - (count + 1), retryAfterSec: 0 };
      }
      if (await this.#kv.compareSet(kvKey, raw, next, ttlSec)) {
        return { allowed: true, remaining: policy.limit - (count + 1), retryAfterSec: 0 };
      }
      // Raced: re-read the fresh counter and re-decide.
    }
  }
}

/** Shared verdict math for tokenBucket (kept pure for table-driven tests). */
function tokenDecision(
  policy: RateLimitPolicy,
  allowed: boolean,
  nextTokens: number,
  refilledTokens: number,
): RateLimitDecision {
  if (allowed) {
    return { allowed: true, remaining: Math.floor(nextTokens), retryAfterSec: 0 };
  }
  // Seconds until ONE token: (deficit × window) / limit — multiply before
  // dividing so friendly ratios stay exact in floating point.
  const deficit = 1 - refilledTokens;
  const retryAfterSec = Math.max(1, Math.ceil((deficit * policy.windowSec) / policy.limit));
  return { allowed: false, remaining: Math.floor(nextTokens), retryAfterSec };
}
