// Middleware tests for W4-D — rate limiting + request caps, deterministic
// (no network): a fake auth seam sets the W4-B contract variable from a test
// header, an InMemoryKV + injected clock drive the limiter, and the caps are
// exercised at the exact §13/§20.2/§14.1 boundaries.
//
// Note: Node's undici does NOT auto-set the Content-Length header on
// `app.request(...)`-constructed Requests (it is added at send time), so the
// upload tests pass an explicit `content-length` header — exactly the
// header-only signal `uploadCap()` is designed to police.

import { Hono } from "hono";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES, PLAN_LIMITS, type PlanId } from "@studio/config";
import { checkUploadSize, enforceRunCaps, uploadCap } from "../src/middleware/caps.js";
import { AppError, errorMapper } from "../src/middleware/error-mapper.js";
import {
  RATE_LIMIT_HEADERS,
  rateLimit,
  type RateLimitEnv,
  type RateLimitOptions,
} from "../src/middleware/rate-limit.js";
import { InMemoryKV, RateLimiter, type KVLike } from "../src/services/limiter.js";
import type { AppEnv } from "../src/types.js";

const logger = pino({ enabled: false });
const ORG_A = "11111111-2222-3333-4444-555566667777";
const ORG_B = "99999999-8888-7777-6666-555544443333";

function makeClock(startMs: number) {
  let now = startMs;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const FROZEN = 1_700_000_000_000; // token-bucket tests need no window alignment
const WINDOW_T0 = 1_700_004_000_000; // divisible by 60_000 → exact fixed-window edge

function makeLimitedApp(limiter: RateLimiter, options: RateLimitOptions): Hono<RateLimitEnv> {
  const app = new Hono<RateLimitEnv>();
  app.use(errorMapper(logger));
  // Fake auth-context seam (W4-B contract): x-test-org → c.set("auth").
  app.use(async (c, next) => {
    const org = c.req.header("x-test-org");
    if (org !== undefined) {
      c.set("auth", { organizationId: org, role: "editor" });
    }
    await next();
  });
  app.use(rateLimit({ limiter }, options));
  app.post("/v1/things", (c) => c.json({ ok: true }));
  app.get("/v1/things", (c) => c.json({ ok: true }));
  app.get("/v1/health", (c) => c.json({ ok: true }));
  return app;
}

function makeLimiter(clock: { now: () => number }): RateLimiter {
  return new RateLimiter({ kv: new InMemoryKV(clock.now), now: clock.now });
}

interface ErrorBody {
  readonly ok: boolean;
  readonly code: string;
  readonly message: string;
  readonly hint?: string;
  readonly retryable: boolean;
}

async function errorBody(res: Response): Promise<ErrorBody> {
  expect(res.status >= 400).toBe(true);
  return (await res.json()) as ErrorBody;
}

// ---------------------------------------------------------------------------
// rateLimit middleware — token bucket (default algorithm)
// ---------------------------------------------------------------------------

describe("rateLimit middleware (token bucket, 2 per 60s, keyBy org)", () => {
  const OPTIONS: RateLimitOptions = {
    scope: "api.test.things",
    limit: 2,
    windowSec: 60,
    keyBy: "org",
  };

  it("lets the burst through and stamps X-RateLimit headers on 200s", async () => {
    const clock = makeClock(FROZEN);
    const app = makeLimitedApp(makeLimiter(clock), OPTIONS);

    const first = await app.request("/v1/things", {
      method: "POST",
      headers: { "x-test-org": ORG_A },
    });
    expect(first.status).toBe(200);
    expect(first.headers.get(RATE_LIMIT_HEADERS.limit)).toBe("2");
    expect(first.headers.get(RATE_LIMIT_HEADERS.remaining)).toBe("1");

    const second = await app.request("/v1/things", {
      method: "POST",
      headers: { "x-test-org": ORG_A },
    });
    expect(second.status).toBe(200);
    expect(second.headers.get(RATE_LIMIT_HEADERS.remaining)).toBe("0");
  });

  it("429s with Retry-After, X-RateLimit-* and the typed rate_limited envelope", async () => {
    const clock = makeClock(FROZEN);
    const app = makeLimitedApp(makeLimiter(clock), OPTIONS);

    for (let i = 0; i < 2; i++) {
      const res = await app.request("/v1/things", {
        method: "POST",
        headers: { "x-test-org": ORG_A },
      });
      expect(res.status).toBe(200);
    }

    const denied = await app.request("/v1/things", {
      method: "POST",
      headers: { "x-test-org": ORG_A },
    });
    expect(denied.status).toBe(429);
    expect(denied.headers.get("retry-after")).toBe("30"); // 1 token = windowSec/limit
    expect(denied.headers.get(RATE_LIMIT_HEADERS.limit)).toBe("2");
    expect(denied.headers.get(RATE_LIMIT_HEADERS.remaining)).toBe("0");
    expect(denied.headers.get(RATE_LIMIT_HEADERS.reset)).toMatch(/^\d+$/);

    const body = await errorBody(denied);
    expect(body.ok).toBe(false);
    expect(body.code).toBe("rate_limited");
    expect(body.retryable).toBe(true);
    expect(body.hint).toContain("Retry after 30s");
    expect(body.message).not.toMatch(/[0-9a-f]{8}-/); // no internal ids (§13.3)
  });

  it("isolates buckets per workspace: exhausting A never throttles B", async () => {
    const clock = makeClock(FROZEN);
    const app = makeLimitedApp(makeLimiter(clock), OPTIONS);

    for (let i = 0; i < 2; i++) {
      const res = await app.request("/v1/things", {
        method: "POST",
        headers: { "x-test-org": ORG_A },
      });
      expect(res.status).toBe(200);
    }
    const exhaustedA = await app.request("/v1/things", {
      method: "POST",
      headers: { "x-test-org": ORG_A },
    });
    expect(exhaustedA.status).toBe(429);

    const orgB = await app.request("/v1/things", {
      method: "POST",
      headers: { "x-test-org": ORG_B },
    });
    expect(orgB.status).toBe(200);
    expect(orgB.headers.get(RATE_LIMIT_HEADERS.remaining)).toBe("1");
  });

  it("degrades org-keyed policies to the client IP when unauthenticated", async () => {
    const clock = makeClock(FROZEN);
    const app = makeLimitedApp(makeLimiter(clock), OPTIONS);

    for (let i = 0; i < 2; i++) {
      const res = await app.request("/v1/things", {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.7" },
      });
      expect(res.status).toBe(200);
    }
    const sameIp = await app.request("/v1/things", {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.7" },
    });
    expect(sameIp.status).toBe(429);

    const otherIp = await app.request("/v1/things", {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.8" },
    });
    expect(otherIp.status).toBe(200);
  });

  it("keys org+ip per user: same workspace, different IPs stay separate", async () => {
    const clock = makeClock(FROZEN);
    const app = makeLimitedApp(makeLimiter(clock), {
      ...OPTIONS,
      limit: 1,
      keyBy: "org+ip",
    });

    const ip1 = await app.request("/v1/things", {
      method: "POST",
      headers: { "x-test-org": ORG_A, "x-forwarded-for": "203.0.113.7" },
    });
    const ip2 = await app.request("/v1/things", {
      method: "POST",
      headers: { "x-test-org": ORG_A, "x-forwarded-for": "203.0.113.8" },
    });
    const orgB = await app.request("/v1/things", {
      method: "POST",
      headers: { "x-test-org": ORG_B, "x-forwarded-for": "203.0.113.7" },
    });
    expect(ip1.status).toBe(200);
    expect(ip2.status).toBe(200);
    expect(orgB.status).toBe(200);

    const again = await app.request("/v1/things", {
      method: "POST",
      headers: { "x-test-org": ORG_A, "x-forwarded-for": "203.0.113.7" },
    });
    expect(again.status).toBe(429);
  });

  it("admits again once the bucket refilled (clock advanced by Retry-After)", async () => {
    const clock = makeClock(FROZEN);
    const app = makeLimitedApp(makeLimiter(clock), OPTIONS);

    for (let i = 0; i < 3; i++) {
      await app.request("/v1/things", { method: "POST", headers: { "x-test-org": ORG_A } });
    }
    clock.advance(30_000); // exactly one token (60s / 2)
    const refilled = await app.request("/v1/things", {
      method: "POST",
      headers: { "x-test-org": ORG_A },
    });
    expect(refilled.status).toBe(200);
    expect(refilled.headers.get(RATE_LIMIT_HEADERS.remaining)).toBe("0");

    const next = await app.request("/v1/things", {
      method: "POST",
      headers: { "x-test-org": ORG_A },
    });
    expect(next.status).toBe(429);
  });

  it("skips /v1/health by default (monitoring probes are never throttled)", async () => {
    const clock = makeClock(FROZEN);
    const app = makeLimitedApp(makeLimiter(clock), { ...OPTIONS, limit: 1 });

    for (let i = 0; i < 5; i++) {
      const res = await app.request("/v1/health");
      expect(res.status).toBe(200);
      expect(res.headers.get(RATE_LIMIT_HEADERS.limit)).toBeNull();
    }
    // The policy still applies elsewhere.
    const first = await app.request("/v1/things", {
      method: "POST",
      headers: { "x-test-org": ORG_A },
    });
    expect(first.status).toBe(200);
    const second = await app.request("/v1/things", {
      method: "POST",
      headers: { "x-test-org": ORG_A },
    });
    expect(second.status).toBe(429);
  });

  it("honors custom skipPaths", async () => {
    const clock = makeClock(FROZEN);
    const app = makeLimitedApp(makeLimiter(clock), {
      ...OPTIONS,
      limit: 1,
      skipPaths: ["/v1/things"],
    });
    for (let i = 0; i < 3; i++) {
      const res = await app.request("/v1/things", {
        method: "POST",
        headers: { "x-test-org": ORG_A },
      });
      expect(res.status).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// rateLimit middleware — fixed-window algorithm + failure mode
// ---------------------------------------------------------------------------

describe("rateLimit middleware (fixed-window algorithm)", () => {
  it("counts per window and denies with the seconds to the next window", async () => {
    const clock = makeClock(WINDOW_T0);
    const app = makeLimitedApp(makeLimiter(clock), {
      scope: "api.test.auth",
      limit: 1,
      windowSec: 60,
      keyBy: "ip",
      algorithm: "fixed-window",
    });

    const first = await app.request("/v1/things", {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.7" },
    });
    expect(first.status).toBe(200);

    const second = await app.request("/v1/things", {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.7" },
    });
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("60");

    clock.advance(60_000); // next window
    const freshWindow = await app.request("/v1/things", {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.7" },
    });
    expect(freshWindow.status).toBe(200);
  });
});

describe("rateLimit middleware failure mode", () => {
  it("fails open when the KV store rejects (limiter outage ≠ site outage)", async () => {
    const brokenKv: KVLike = {
      get: () => Promise.reject(new Error("valkey down")),
      set: () => Promise.reject(new Error("valkey down")),
    };
    const limiter = new RateLimiter({ kv: brokenKv, now: () => FROZEN });
    const app = makeLimitedApp(limiter, {
      scope: "api.test.things",
      limit: 1,
      windowSec: 60,
      keyBy: "org",
    });

    for (let i = 0; i < 3; i++) {
      const res = await app.request("/v1/things", {
        method: "POST",
        headers: { "x-test-org": ORG_A },
      });
      expect(res.status).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// uploadCap — Content-Length vs the 25 MB cap, rejected pre-parse (§13/§20.2)
// ---------------------------------------------------------------------------

function makeUploadApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use(errorMapper(logger));
  app.use(uploadCap());
  app.post("/v1/uploads", (c) => c.json({ ok: true }));
  return app;
}

describe("uploadCap middleware (413 upload_too_large before body parse)", () => {
  it("rejects Content-Length above the cap with the typed 413 envelope", async () => {
    const app = makeUploadApp();
    const res = await app.request("/v1/uploads", {
      method: "POST",
      headers: { "content-length": String(MAX_UPLOAD_BYTES + 1) },
    });
    expect(res.status).toBe(413);
    const body = await errorBody(res);
    expect(body.ok).toBe(false);
    expect(body.code).toBe("upload_too_large");
    expect(body.retryable).toBe(false);
    expect(body.hint).toContain("25 MB");
  });

  it("allows a body exactly at the cap (comparison is inclusive)", async () => {
    const app = makeUploadApp();
    const res = await app.request("/v1/uploads", {
      method: "POST",
      headers: { "content-length": String(MAX_UPLOAD_BYTES) },
    });
    expect(res.status).toBe(200);
  });

  it("passes through requests without Content-Length (chunked bodies)", async () => {
    const app = makeUploadApp();
    const res = await app.request("/v1/uploads", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("checkUploadSize boundary table (pure decision, config cap)", () => {
    const rows: readonly { header: string | undefined; expected: number | null }[] = [
      { header: undefined, expected: null }, // chunked / not pre-checkable
      { header: "not-a-number", expected: null }, // malformed → HTTP layer owns it
      { header: "0", expected: 0 },
      { header: String(MAX_UPLOAD_BYTES - 1), expected: MAX_UPLOAD_BYTES - 1 },
      { header: String(MAX_UPLOAD_BYTES), expected: MAX_UPLOAD_BYTES }, // at cap: allowed
      { header: String(MAX_UPLOAD_BYTES + 1), expected: MAX_UPLOAD_BYTES + 1 },
    ];
    for (const row of rows) {
      const verdict = checkUploadSize(row.header, MAX_UPLOAD_BYTES);
      expect(verdict.contentLengthBytes).toBe(row.expected);
      expect(verdict.tooLarge).toBe(
        row.expected !== null && row.expected > MAX_UPLOAD_BYTES,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// enforceRunCaps — §14.1 concurrent-run ladder (1/3/6 from @studio/config)
// ---------------------------------------------------------------------------

async function caught(error: unknown): Promise<unknown> {
  return error;
}

describe("enforceRunCaps (§14.1 concurrent-run caps)", () => {
  it("admits below the cap and throws 429 run_cap_reached at/over it, per plan", async () => {
    const plans: readonly PlanId[] = ["starter", "pro", "business"];
    for (const plan of plans) {
      const cap = PLAN_LIMITS[plan].concurrentRuns;

      const below = await enforceRunCaps({ plan }, { activeRuns: cap - 1 }).catch(caught);
      expect(below).toBeUndefined();

      const atCap = await enforceRunCaps({ plan }, { activeRuns: cap }).catch(caught);
      expect(atCap).toBeInstanceOf(AppError);
      if (atCap instanceof AppError) {
        expect(atCap.status).toBe(429);
        expect(atCap.code).toBe("run_cap_reached");
        expect(atCap.hint).toContain(`${cap} concurrent run`);
      }

      const over = await enforceRunCaps({ plan }, { activeRuns: cap * 10 }).catch(caught);
      expect(over).toBeInstanceOf(AppError);
    }
  });

  it("accepts the injected counter as a number, sync resolver or async resolver", async () => {
    const numberForm = await enforceRunCaps({ plan: "starter" }, { activeRuns: 1 }).catch(caught);
    const syncForm = await enforceRunCaps({ plan: "starter" }, { activeRuns: () => 1 }).catch(
      caught,
    );
    const asyncForm = await enforceRunCaps(
      { plan: "starter" },
      { activeRuns: () => Promise.resolve(1) },
    ).catch(caught);
    for (const err of [numberForm, syncForm, asyncForm]) {
      expect(err).toBeInstanceOf(AppError);
    }

    const admitted = await enforceRunCaps({ plan: "starter" }, { activeRuns: () => 0 }).catch(
      caught,
    );
    expect(admitted).toBeUndefined();
  });

  it("clamps a broken counter to zero (internal bug ≠ user-facing 429)", async () => {
    const negative = await enforceRunCaps({ plan: "starter" }, { activeRuns: -3 }).catch(caught);
    const nan = await enforceRunCaps({ plan: "starter" }, {
      activeRuns: Number.NaN,
    }).catch(caught);
    expect(negative).toBeUndefined();
    expect(nan).toBeUndefined();
  });

  it("renders as the 429 envelope through the error mapper at the route level", async () => {
    const app = new Hono<RateLimitEnv>();
    app.use(errorMapper(logger));
    app.post("/v1/documents/:id/runs", async (c) => {
      await enforceRunCaps({ plan: "starter" }, { activeRuns: 1 });
      return c.json({ ok: true }, 200);
    });

    const res = await app.request("/v1/documents/doc-1/runs", { method: "POST" });
    expect(res.status).toBe(429);
    const body = await errorBody(res);
    expect(body.code).toBe("run_cap_reached");
    expect(body.retryable).toBe(true);
    expect(body.hint).toContain("1 concurrent run");
    expect(body.message).toContain("maximum number of concurrent runs");
  });
});
