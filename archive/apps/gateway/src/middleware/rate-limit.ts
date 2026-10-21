// Rate-limit middleware (§1.5 rule 5, §15.2: rate limits per IP/user/workspace
// on auth, uploads, runs and exports; §13.3: 429 `rate_limited`).
//
// Factory, not singleton: every route family mounts its own policy
// (`scope` names the limit, e.g. "api.runs.create") against a shared
// `RateLimiter`. Decisions are made BEFORE the handler runs; the standard
// X-RateLimit headers are set on every limited response, and denials throw a
// typed AppError that the error-mapper (mounted first in buildApp) renders as
// the 429 envelope — plus a standards-compliant `Retry-After` header.
//
// Failure mode: KV/Valkey outages FAIL OPEN (the request proceeds, a warning
// is logged). Rationale: the limiter is abuse protection; a Valkey blip must
// not become a full-site outage. The money surface (credits, concurrent-run
// caps) is Postgres-backed and unaffected — §14.2 reserve/commit keeps that
// true. Fail-closed was rejected because it turns a cache outage into a 500
// storm for every customer.
//
// Auth seam (W4-B contract, src/middleware/auth-context.ts): the middleware
// reads `c.get("auth") → { organizationId, role }` when present. Until the
// auth middleware is mounted (or for unauthenticated surfaces), org-keyed
// policies degrade to IP buckets — never to a single global bucket one tenant
// could exhaust for everyone.

import type { Context, MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import type { Logger } from "pino";
import {
  subjectBucketKey,
  type RateLimitDecision,
  type RateLimiter,
  type RateLimitSubject,
} from "../services/limiter.js";
import type { AppEnv } from "../types.js";
import { AppError } from "./error-mapper.js";

/**
 * The W4-B auth-context contract this middleware consumes (subset): the
 * organization (workspace) the request acts in, and the member's role.
 * Fields are tolerant on purpose — `null`/`undefined` both mean "absent".
 */
export interface AuthContext {
  readonly organizationId?: string | null | undefined;
  readonly role?: string | null | undefined;
}

/**
 * Hono env required by rate-limit middleware: the app env plus the (optional
 * until auth-context mounts) `auth` variable. Once `types.ts` declares
 * `auth`, `app.use(rateLimit(...))` typechecks directly — Hono's bivariant
 * `get`/`set` accept the superset env either way.
 */
export type RateLimitEnv = {
  Variables: AppEnv["Variables"] & { auth?: AuthContext | undefined };
};

/** How the bucket subject is derived from the request. */
export type RateLimitKeyBy = "org" | "ip" | "org+ip";

/** Standard rate-limit headers set by this middleware. */
export const RATE_LIMIT_HEADERS = {
  /** The policy in force (burst capacity / window allowance). */
  limit: "X-RateLimit-Limit",
  /** Whole events still affordable right now. */
  remaining: "X-RateLimit-Remaining",
  /** Epoch seconds when one event is affordable again (denials only). */
  reset: "X-RateLimit-Reset",
} as const;

/**
 * Paths never rate-limited (default `skipPaths`): the §13.1 health probes.
 * Monitoring polls them constantly, and they touch no tenant state.
 */
export const DEFAULT_RATE_LIMIT_SKIP_PATHS: readonly string[] = [
  "/v1/health",
  "/v1/health/deep",
];

/** Per-mount policy for `rateLimit()`. */
export interface RateLimitOptions {
  /** Limit name — becomes the KV/table `scope`, e.g. "api.runs.create" (§15.2). */
  readonly scope: string;
  /** Burst capacity (token bucket) or window allowance (fixed window). */
  readonly limit: number;
  /** Window length in seconds — full refill window. */
  readonly windowSec: number;
  /** Bucket subject: workspace, client IP, or per-user (workspace+IP). */
  readonly keyBy: RateLimitKeyBy;
  /** Token bucket by default; "fixed-window" opts into the fallback counter. */
  readonly algorithm?: "token-bucket" | "fixed-window";
  /** Exact paths to skip. Defaults to the health probes. */
  readonly skipPaths?: readonly string[];
}

/** Injected dependencies for `rateLimit()`. */
export interface RateLimitDeps {
  /** Shared limiter service (owns the KV seam; wired in buildApp). */
  readonly limiter: RateLimiter;
}

// IPv4/IPv6 characters only — also the KV-key injection guard (no comma,
// space, slash or control chars can ride in from a spoofed header).
const IP_PATTERN = /^[0-9a-fA-F:.]{1,45}$/;

/**
 * Client IP for bucketing. Trusts the edge proxy's `X-Forwarded-For` first
 * hop (the §17 deployment terminates at a proxy that sets it) and falls back
 * to `X-Real-Ip`; header-less direct connections share the "unknown" bucket
 * — which only ever pools other header-less direct connections.
 */
export function clientIp(c: Context<RateLimitEnv>): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded !== undefined) {
    const first = forwarded.split(",")[0]?.trim() ?? "";
    if (IP_PATTERN.test(first)) {
      return first;
    }
  }
  const real = c.req.header("x-real-ip")?.trim() ?? "";
  if (IP_PATTERN.test(real)) {
    return real;
  }
  return "unknown";
}

/** Resolve the bucket subject for the policy; org-keyed policies without an
 * authenticated workspace degrade to the client IP (never a global bucket). */
function resolveSubject(c: Context<RateLimitEnv>, keyBy: RateLimitKeyBy): RateLimitSubject {
  const auth = c.get("auth");
  const organizationId =
    typeof auth?.organizationId === "string" && auth.organizationId.length > 0
      ? auth.organizationId
      : undefined;
  const ip = clientIp(c);
  if (keyBy === "org") {
    return organizationId === undefined
      ? { kind: "ip", ip }
      : { kind: "org", organizationId };
  }
  if (keyBy === "org+ip") {
    return organizationId === undefined
      ? { kind: "ip", ip }
      : { kind: "org+ip", organizationId, ip };
  }
  return { kind: "ip", ip };
}

function assertOptions(options: RateLimitOptions): void {
  if (options.scope.length === 0) {
    throw new Error("[rateLimit] scope must be non-empty (names the limit)");
  }
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new Error(`[rateLimit] limit must be an integer >= 1 (got ${String(options.limit)})`);
  }
  if (
    typeof options.windowSec !== "number" ||
    !Number.isFinite(options.windowSec) ||
    options.windowSec <= 0
  ) {
    throw new Error(
      `[rateLimit] windowSec must be a finite number > 0 (got ${String(options.windowSec)})`,
    );
  }
}

/**
 * Rate-limit middleware factory.
 *
 * On every non-skipped request: decide against the bucket for
 * (scope, subject), set `X-RateLimit-Limit`/`-Remaining`, then either proceed
 * or throw a 429 `rate_limited` AppError carrying `Retry-After`.
 *
 * Mount AFTER `errorMapper` (it renders the 429 envelope) and AFTER the auth
 * middleware when `keyBy` uses the org (routes with no session — e.g.
 * POST /v1/auth/* — should mount `keyBy: "ip"`).
 */
export function rateLimit(
  deps: RateLimitDeps,
  options: RateLimitOptions,
): MiddlewareHandler<RateLimitEnv> {
  assertOptions(options);
  const skipPaths = options.skipPaths ?? DEFAULT_RATE_LIMIT_SKIP_PATHS;
  const policy = { limit: options.limit, windowSec: options.windowSec };

  return createMiddleware<RateLimitEnv>(async (c, next) => {
    if (skipPaths.includes(c.req.path)) {
      await next();
      return;
    }

    const subject = resolveSubject(c, options.keyBy);
    const key = subjectBucketKey(subject);

    let decision: RateLimitDecision;
    try {
      decision =
        options.algorithm === "fixed-window"
          ? await deps.limiter.fixedWindow(options.scope, key, policy)
          : await deps.limiter.tokenBucket(options.scope, key, policy);
    } catch (error) {
      // Fail open: a limiter outage must not become a site outage (see the
      // header comment). Real detail goes to logs only (§13.3).
      const log: Logger | undefined = c.get("logger");
      log?.warn(
        { err: error, rateLimitScope: options.scope, keyBy: options.keyBy },
        "rate_limit_kv_unavailable_failing_open",
      );
      await next();
      return;
    }

    c.header(RATE_LIMIT_HEADERS.limit, String(options.limit));
    c.header(RATE_LIMIT_HEADERS.remaining, String(decision.remaining));
    if (!decision.allowed) {
      // Retry-After (RFC 6585/9110) — whole seconds, from the bucket math.
      c.header("Retry-After", String(decision.retryAfterSec));
      c.header(
        RATE_LIMIT_HEADERS.reset,
        String(Math.ceil((Date.now() + decision.retryAfterSec * 1000) / 1000)),
      );
      const hint =
        `Limit is ${options.limit} per ${options.windowSec}s. ` +
        `Retry after ${decision.retryAfterSec}s.`;
      throw new AppError(
        429,
        "rate_limited",
        "Too many requests — slow down and retry shortly.",
        { hint, retryable: true },
      );
    }
    await next();
  });
}
