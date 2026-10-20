// Limiter unit tests — deterministic, no network, injected clock + in-memory
// KV (AGENTS.md: Vitest, <5 s units, table-driven for pure logic).
// Covers the task W4-D contract: bucket math (burst, refill, boundary),
// compare-set atomicity/fallback, fixed-window fallback, composite keys,
// per-scope/subject isolation and TTL semantics.

import { describe, expect, it } from "vitest";
import {
  InMemoryKV,
  RateLimiter,
  subjectBucketKey,
  type KVLike,
  type RateLimitDecision,
} from "../src/services/limiter.js";

const ORG_A = "11111111-2222-3333-4444-555566667777";
const ORG_B = "99999999-8888-7777-6666-555544443333";

// Deterministic clock. T0 is divisible by the test windows (10 s), so window
// boundaries land on round numbers for the fixed-window tests.
const T0 = 1_700_000_000_000;

function makeClock(startMs: number = T0) {
  let now = startMs;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** A KVLike that is guaranteed to implement CAS (InMemoryKV does). */
type WithCas = KVLike & Required<Pick<KVLike, "compareSet">>;

/** Wrapper whose compareSet fails (without writing) the first `failures` calls. */
function flakyCas(inner: WithCas, failures: number): KVLike {
  let remaining = failures;
  return {
    get: (key) => inner.get(key),
    set: (key, value, ttlSec) => inner.set(key, value, ttlSec),
    compareSet: (key, expected, next, ttlSec) => {
      if (remaining > 0) {
        remaining -= 1;
        return Promise.resolve(false);
      }
      return inner.compareSet(key, expected, next, ttlSec);
    },
  };
}

/** Strip CAS from a store — adapters without compareSet must still work. */
function withoutCas(inner: KVLike): KVLike {
  return { get: inner.get.bind(inner), set: inner.set.bind(inner) };
}

// ---------------------------------------------------------------------------
// Token bucket math — burst, refill, boundaries (scripted clock, table-driven)
// ---------------------------------------------------------------------------

type Step =
  | {
      readonly kind: "hit";
      readonly allowed: boolean;
      readonly remaining: number;
      readonly retryAfterSec?: number;
    }
  | { readonly kind: "advance"; readonly ms: number };

describe("tokenBucket math (limit 5 per 10s → refill 0.5 token/s)", () => {
  const POLICY = { limit: 5, windowSec: 10 };

  // The full behavior script: burst capacity, exhaustion, one-token refill,
  // two-token refill, full-window refill and capacity clamping.
  const SCRIPT: readonly Step[] = [
    // Burst: all 5 tokens spend instantly at T0.
    { kind: "hit", allowed: true, remaining: 4 },
    { kind: "hit", allowed: true, remaining: 3 },
    { kind: "hit", allowed: true, remaining: 2 },
    { kind: "hit", allowed: true, remaining: 1 },
    { kind: "hit", allowed: true, remaining: 0 },
    // 6th at the same instant: denied; 1 token costs windowSec/limit = 2 s.
    { kind: "hit", allowed: false, remaining: 0, retryAfterSec: 2 },
    // +2 s = exactly one token → allowed once, immediately empty again.
    { kind: "advance", ms: 2_000 },
    { kind: "hit", allowed: true, remaining: 0 },
    { kind: "hit", allowed: false, remaining: 0, retryAfterSec: 2 },
    // +4 s = exactly two tokens (0 → 2, rate is a binary-exact 0.5/s).
    { kind: "advance", ms: 4_000 },
    { kind: "hit", allowed: true, remaining: 1 },
    { kind: "hit", allowed: true, remaining: 0 },
    { kind: "hit", allowed: false, remaining: 0, retryAfterSec: 2 },
    // Idle a full window from empty → refilled to capacity (boundary).
    { kind: "advance", ms: 10_000 },
    { kind: "hit", allowed: true, remaining: 4 },
    { kind: "hit", allowed: true, remaining: 3 },
    { kind: "hit", allowed: true, remaining: 2 },
    { kind: "hit", allowed: true, remaining: 1 },
    { kind: "hit", allowed: true, remaining: 0 },
    { kind: "hit", allowed: false, remaining: 0, retryAfterSec: 2 },
    // Idle far beyond a window → tokens clamp at capacity (no hoarding).
    { kind: "advance", ms: 100_000 },
    { kind: "hit", allowed: true, remaining: 4 },
    { kind: "hit", allowed: true, remaining: 3 },
    { kind: "hit", allowed: true, remaining: 2 },
    { kind: "hit", allowed: true, remaining: 1 },
    { kind: "hit", allowed: true, remaining: 0 },
    { kind: "hit", allowed: false, remaining: 0, retryAfterSec: 2 },
  ];

  it("follows the burst/refill/boundary script exactly", async () => {
    const clock = makeClock();
    const kv = new InMemoryKV(clock.now);
    const limiter = new RateLimiter({ kv, now: clock.now });

    for (const step of SCRIPT) {
      if (step.kind === "advance") {
        clock.advance(step.ms);
        continue;
      }
      const decision: RateLimitDecision = await limiter.tokenBucket(
        "api.test.runs",
        `org:${ORG_A}`,
        POLICY,
      );
      expect(decision.allowed, `allowed at t+${clock.now() - T0}`).toBe(step.allowed);
      expect(decision.remaining).toBe(step.remaining);
      expect(decision.retryAfterSec).toBe(step.retryAfterSec ?? 0);
    }
  });

  it("is exact under burst concurrency (CAS): only `limit` of 10 parallel calls pass", async () => {
    const clock = makeClock();
    const kv = new InMemoryKV(clock.now);
    const limiter = new RateLimiter({ kv, now: clock.now });

    const decisions = await Promise.all(
      Array.from({ length: 10 }, () =>
        limiter.tokenBucket("api.test.runs", `org:${ORG_A}`, POLICY),
      ),
    );
    const allowed = decisions.filter((d) => d.allowed);
    expect(allowed.length).toBe(5);
    expect(allowed.every((d) => d.retryAfterSec === 0)).toBe(true);
    expect(decisions.filter((d) => !d.allowed).every((d) => d.retryAfterSec >= 1)).toBe(true);
  });

  it("works without CAS via unconditional set (sequential calls stay exact)", async () => {
    const clock = makeClock();
    const limiter = new RateLimiter({ kv: withoutCas(new InMemoryKV(clock.now)), now: clock.now });

    for (let i = 0; i < 5; i++) {
      const d = await limiter.tokenBucket("api.test.runs", `org:${ORG_A}`, POLICY);
      expect(d.allowed).toBe(true);
    }
    const sixth = await limiter.tokenBucket("api.test.runs", `org:${ORG_A}`, POLICY);
    expect(sixth.allowed).toBe(false);
    expect(sixth.retryAfterSec).toBe(2);
  });

  it("recovers when compare-set races succeed on retry", async () => {
    const clock = makeClock();
    const inner = new InMemoryKV(clock.now);
    const limiter = new RateLimiter({ kv: flakyCas(inner, 1), now: clock.now });

    const first = await limiter.tokenBucket("api.test.runs", `org:${ORG_A}`, POLICY);
    expect(first.allowed).toBe(true);
    // The failed CAS wrote nothing; the retry landed the real spend.
    const state = await inner.get(`api.test.runs:org:${ORG_A}`);
    expect(state).not.toBeNull();
  });

  it("degrades to an unconditional write after exhausting CAS attempts", async () => {
    const clock = makeClock();
    const limiter = new RateLimiter({ kv: flakyCas(new InMemoryKV(clock.now), 99), now: clock.now });

    // Every CAS attempt fails → the limiter still answers and persists state.
    const first = await limiter.tokenBucket("api.test.runs", `org:${ORG_A}`, POLICY);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(4);
    let spentCount = 0;
    for (let i = 0; i < 4; i++) {
      const d = await limiter.tokenBucket("api.test.runs", `org:${ORG_A}`, POLICY);
      spentCount += d.allowed ? 1 : 0;
    }
    expect(spentCount).toBe(4);
    const sixth = await limiter.tokenBucket("api.test.runs", `org:${ORG_A}`, POLICY);
    expect(sixth.allowed).toBe(false);
  });

  it("expires idle buckets after a full window (TTL) and refills to capacity", async () => {
    const clock = makeClock();
    const kv = new InMemoryKV(clock.now);
    const limiter = new RateLimiter({ kv, now: clock.now });
    const key = `api.test.runs:org:${ORG_A}`;

    for (let i = 0; i < 5; i++) {
      await limiter.tokenBucket("api.test.runs", `org:${ORG_A}`, POLICY);
    }
    expect(await kv.get(key)).not.toBeNull();

    clock.advance(10_001); // TTL is one window → gone
    expect(await kv.get(key)).toBeNull();

    const fresh = await limiter.tokenBucket("api.test.runs", `org:${ORG_A}`, POLICY);
    expect(fresh.allowed).toBe(true);
    expect(fresh.remaining).toBe(4);
  });

  it("treats corrupt bucket state as a fresh full bucket (never locks out)", async () => {
    const clock = makeClock();
    const kv = new InMemoryKV(clock.now);
    const limiter = new RateLimiter({ kv, now: clock.now });
    const key = `api.test.runs:org:${ORG_A}`;
    const policy = { limit: 2, windowSec: 60 };

    const cases: readonly string[] = [
      "not json at all",
      '{"t":"oops","u":123}',
      '{"t":-5,"u":123}',
      '{"t":1.5,"no_u":true}',
    ];
    for (const garbage of cases) {
      await kv.set(key, garbage, 60);
      const d = await limiter.tokenBucket("api.test.runs", `org:${ORG_A}`, policy);
      expect(d.allowed).toBe(true);
      expect(d.remaining).toBe(1);
    }
  });

  it("isolates buckets per subject and per scope", async () => {
    const clock = makeClock();
    const limiter = new RateLimiter({ kv: new InMemoryKV(clock.now), now: clock.now });
    const policy = { limit: 1, windowSec: 60 };

    const a1 = await limiter.tokenBucket("api.test.runs", `org:${ORG_A}`, policy);
    expect(a1.allowed).toBe(true);

    // Same subject, different scope → independent bucket.
    const a2 = await limiter.tokenBucket("api.test.uploads", `org:${ORG_A}`, policy);
    expect(a2.allowed).toBe(true);

    // Same scope, different subject → independent bucket.
    const b = await limiter.tokenBucket("api.test.runs", `org:${ORG_B}`, policy);
    expect(b.allowed).toBe(true);

    // Original bucket is now empty.
    const a1Again = await limiter.tokenBucket("api.test.runs", `org:${ORG_A}`, policy);
    expect(a1Again.allowed).toBe(false);
    expect(a1Again.retryAfterSec).toBe(60);
  });

  it("rejects invalid policies and names at the call boundary", () => {
    const clock = makeClock();
    const limiter = new RateLimiter({ kv: new InMemoryKV(clock.now), now: clock.now });
    const good = { limit: 1, windowSec: 10 };

    await expect(limiter.tokenBucket("", "org:x", good)).rejects.toThrow(/non-empty/);
    await expect(limiter.tokenBucket("api", "", good)).rejects.toThrow(/non-empty/);
    await expect(
      limiter.tokenBucket("api", "org:x", { limit: 0, windowSec: 10 }),
    ).rejects.toThrow(/limit/);
    await expect(
      limiter.tokenBucket("api", "org:x", { limit: 2.5, windowSec: 10 }),
    ).rejects.toThrow(/limit/);
    await expect(
      limiter.tokenBucket("api", "org:x", { limit: 1, windowSec: 0 }),
    ).rejects.toThrow(/windowSec/);
    await expect(
      limiter.fixedWindow("api", "org:x", { limit: 1, windowSec: -1 }),
    ).rejects.toThrow(/windowSec/);
  });
});

// ---------------------------------------------------------------------------
// Fixed-window fallback
// ---------------------------------------------------------------------------

describe("fixedWindow fallback (limit 3 per 10s window)", () => {
  const POLICY = { limit: 3, windowSec: 10 };

  it("counts per window slice and denies with the time to the next window", async () => {
    const clock = makeClock(T0); // T0 % 10_000 === 0 → exact window boundary
    const limiter = new RateLimiter({ kv: new InMemoryKV(clock.now), now: clock.now });
    const window = Math.floor(T0 / 10_000);

    const first = await limiter.fixedWindow("api.test.auth", "ip:203.0.113.7", POLICY);
    expect(first).toEqual({ allowed: true, remaining: 2, retryAfterSec: 0 });
    const second = await limiter.fixedWindow("api.test.auth", "ip:203.0.113.7", POLICY);
    expect(second).toEqual({ allowed: true, remaining: 1, retryAfterSec: 0 });
    const third = await limiter.fixedWindow("api.test.auth", "ip:203.0.113.7", POLICY);
    expect(third).toEqual({ allowed: true, remaining: 0, retryAfterSec: 0 });

    const denied = await limiter.fixedWindow("api.test.auth", "ip:203.0.113.7", POLICY);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterSec).toBe(10); // window ends at T0+10 s

    // 9.999 s in: same window, still denied, hint clamps to >= 1 s.
    clock.advance(9_999);
    const lateDenied = await limiter.fixedWindow("api.test.auth", "ip:203.0.113.7", POLICY);
    expect(lateDenied.allowed).toBe(false);
    expect(lateDenied.retryAfterSec).toBe(1);

    // 1 ms later: a fresh window, fresh counter.
    clock.advance(1);
    const freshWindow = await limiter.fixedWindow("api.test.auth", "ip:203.0.113.7", POLICY);
    expect(freshWindow.allowed).toBe(true);
    expect(freshWindow.remaining).toBe(2);
    expect(Math.floor(clock.now() / 10_000)).toBe(window + 1);
  });

  it("isolates subjects and scopes into separate window counters", async () => {
    const clock = makeClock();
    const limiter = new RateLimiter({ kv: new InMemoryKV(clock.now), now: clock.now });

    for (let i = 0; i < 3; i++) {
      const d = await limiter.fixedWindow("api.test.auth", "ip:198.51.100.4", POLICY);
      expect(d.allowed).toBe(true);
    }
    const sameIp = await limiter.fixedWindow("api.test.auth", "ip:198.51.100.4", POLICY);
    expect(sameIp.allowed).toBe(false);

    const otherScope = await limiter.fixedWindow("api.test.oauth", "ip:198.51.100.4", POLICY);
    expect(otherScope.allowed).toBe(true);
    const otherIp = await limiter.fixedWindow("api.test.auth", "ip:198.51.100.5", POLICY);
    expect(otherIp.allowed).toBe(true);
  });

  it("resets a corrupt window counter instead of locking the subject out", async () => {
    const clock = makeClock();
    const kv = new InMemoryKV(clock.now);
    const limiter = new RateLimiter({ kv, now: clock.now });
    const window = Math.floor(T0 / 10_000);
    const key = `api.test.auth:ip:198.51.100.4:w${window}`;

    await kv.set(key, "garbage", 60);
    const d = await limiter.fixedWindow("api.test.auth", "ip:198.51.100.4", POLICY);
    expect(d).toEqual({ allowed: true, remaining: 2, retryAfterSec: 0 });
    expect(await kv.get(key)).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// Composite bucket keys (per-workspace + per-IP, §1.5/§15.2)
// ---------------------------------------------------------------------------

describe("subjectBucketKey (composite keys)", () => {
  it("formats org, ip and org+ip subjects deterministically", () => {
    expect(subjectBucketKey({ kind: "org", organizationId: ORG_A })).toBe(`org:${ORG_A}`);
    expect(subjectBucketKey({ kind: "ip", ip: "2001:db8::1" })).toBe("ip:2001:db8::1");
    expect(subjectBucketKey({ kind: "org+ip", organizationId: ORG_A, ip: "203.0.113.7" })).toBe(
      `org:${ORG_A}|ip:203.0.113.7`,
    );
  });

  it("sanitizes unsafe characters and collapses empties (KV-key injection guard)", () => {
    expect(subjectBucketKey({ kind: "org", organizationId: "bad id/with:slashes" })).toBe(
      "org:badidwith:slashes",
    );
    expect(subjectBucketKey({ kind: "org", organizationId: "" })).toBe("org:unknown");
    expect(subjectBucketKey({ kind: "ip", ip: ", , ," })).toBe("ip:unknown");
  });

  it("caps component length at 64 (uuids and IPv6 fit; floods do not)", () => {
    expect(subjectBucketKey({ kind: "org", organizationId: "a".repeat(70) })).toBe(
      `org:${"a".repeat(64)}`,
    );
  });
});
