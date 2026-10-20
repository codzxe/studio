// @studio/gateway — credits + usage routes (§13.1 / §14 / §22). Owner: W4-M.
//
//   GET /v1/credits          balance + one ledger page (cursor-paged, newest
//                            first; rows are append-only §12.2/§14.2)
//   GET /v1/credits/summary  30-day spend, open reservation holds, trial flag
//   GET /v1/usage?from=&to=  daily rollups for the workspace dashboard:
//                            per-UTC-day credit sums by ledger kind + run
//                            stats (status/tier counts, cost, tokens)
//
// Spec anchors:
//   §13.1  GET /v1/credits "Balance + ledger page"; GET /v1/usage daily rollups
//   §12.2  the ledger is append-only; balance is the derived Σ of all deltas,
//                   cached per tenant and re-derived by a consistency job
//   §14.2  ledger kinds + the one-append-per-phase model (reserve/commit/refund)
//   §15.1  tenant scoping: every read is keyed by the caller's organization id
//   §22    cost dashboards — daily cost per workspace; request correlation via
//          the request-scoped child logger
//
// SUM SANITY NOTE (§12.2): the `balance` in GET /v1/credits is the derived
// balance — the exact sum of every `credit_ledger.delta` for the organization.
// The response pairs it with the newest ledger rows, each carrying its
// `balance_after` running total, so a client (or the consistency job) can
// audit the invariant in one place: the newest row's balance_after ≡ balance.
// Tests assert it by recomputing the sum from the seeded rows.
//
// RBAC (W4-C matrix): there is no billing READ permission — a workspace
// member reads their own balance/usage. VIEWER IS OK on all three routes:
// no role gate is applied; the auth seam's `role` field is informational
// (correlation/rate-limit keying only). Write-side billing (checkout/portal,
// Stripe webhooks) belongs to later waves.
//
// WIRING (routers are consts, per the wave contract):
//   import { mountCreditsRoutes } from "./routes/credits.js";
//   mountCreditsRoutes(v1, deps, { creditsPath: "/credits", usagePath: "/usage" });
//   // or on the root app: mountCreditsRoutes(app, deps);
// `deps` seams and their production adapters:
//   auth    — W4-B auth-context (requireAuth) or a Better Auth / API-key
//             adapter returning { userId, organizationId, role }
//   ledger  — the Drizzle-backed LedgerLike (sketch, ~15 lines):
//               balanceAfter: latest row's balance_after for the org, or
//                 SELECT sum(delta) … WHERE organization_id = :org
//               page: SELECT … WHERE organization_id = :org
//                 [AND keyset-guard] ORDER BY created_at DESC, id DESC
//                 LIMIT :limit+1  (credit_ledger_org_created_idx serves it);
//                 a LedgerStore from @studio/billing supplies balanceAfter
//                 shape-for-shape, so only `page` needs writing
//   summary — one composite read: spend since (below), open holds count
//             (credit_reservations WHERE organization_id = :org AND
//             status = 'held', §14.2 rule 1), trial flag (no active
//             subscription row, §14.3)
//   usage   — drizzleUsageQueries(db) from ../services/usage.js
//   limiter — RateLimiter over the shared Valkey KV (W4-D)

import { httpStatusFor, isFailure, type Failure, type Result } from "@studio/config";
import type { CreditLedger } from "@studio/db";
import { Hono, type Context } from "hono";
import { createMiddleware, type MiddlewareHandler } from "hono/factory";
import type { Logger } from "pino";
import { z } from "zod";
import { AppError } from "../middleware/error-mapper.js";
import { RATE_LIMIT_HEADERS } from "../middleware/rate-limit.js";
import { subjectBucketKey, type RateLimitDecision, type RateLimiter } from "../services/limiter.js";
import {
  DEFAULT_USAGE_WINDOW_DAYS,
  DAY_KEY_SCHEMA,
  USAGE_MAX_DAYS,
  addDays,
  dailyUsage,
  dayKeyUtc,
  emptyRunDayStats,
  runStats,
  startOfUtcDay,
  type CreditKindSums,
  type RunDayStats,
  type RunStatsTotals,
  type UsageQueryLike,
} from "../services/usage.js";
import type { AppEnv } from "../types.js";

// ---------------------------------------------------------------------------
// Env + deps seam
// ---------------------------------------------------------------------------

/**
 * The credits/usage router env: the app's shared variables plus the injected
 * service seam. `creditsServices` is optional in the type because a missing
 * injection is a wiring bug this module reports as a typed 500 (§13.3).
 */
export interface CreditsEnv {
  Variables: AppEnv["Variables"] & { creditsServices?: CreditsDeps };
}

/** The authenticated caller (§15.1 tenant root = the organization id). */
export interface CreditsCaller {
  readonly userId: string;
  readonly organizationId: string;
  /** Informational only — viewer reads are allowed (see the header note). */
  readonly role: string;
}

/**
 * Auth seam: resolves the caller. Failures use the §13.3 catalog —
 * `unauthorized` for missing/invalid credentials, `forbidden` for an
 * authenticated caller outside the workspace. Mirrors W4-G's AuthLike.
 */
export interface CreditsAuthLike {
  authenticate(request: Request): Promise<Result<CreditsCaller>>;
}

// ---------------------------------------------------------------------------
// Ledger seam — balance + cursor-paged rows over credit_ledger (§12.2/§14.2)
// ---------------------------------------------------------------------------

/** §12.2 index anchor: credit_ledger (organization_id, created_at DESC). */
export interface LedgerPageCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export interface LedgerPage {
  /** Newest first: ORDER BY created_at DESC, id DESC. */
  readonly rows: readonly CreditLedger[];
  /** Present when more rows follow; feed back as the `cursor` query param. */
  readonly next?: LedgerPageCursor;
}

/**
 * The ledger read seam for GET /v1/credits. `balanceAfter` matches the
 * @studio/billing `LedgerStore` method shape-for-shape (the derived balance,
 * §12.2) so the wiring wave can reuse a LedgerStore directly; `page` is the
 * keyset-paged history walk. Every call MUST scope by organizationId.
 */
export interface LedgerLike {
  /** The organization's current balance: the derived Σ of all deltas (§12.2). */
  balanceAfter(organizationId: string): Promise<number>;
  /**
   * One page of ledger rows, newest first, at most `limit` rows; `next` only
   * when a further page exists. `before` is the exclusive keyset anchor from
   * the previous page.
   */
  page(query: {
    readonly organizationId: string;
    readonly limit: number;
    readonly before?: LedgerPageCursor;
  }): Promise<LedgerPage>;
}

// ---------------------------------------------------------------------------
// Summary seam — GET /v1/credits/summary (30d spend, holds, trial)
// ---------------------------------------------------------------------------

export interface WorkspaceBillingSummary {
  /**
   * Credits consumed by run activity since `since` (positive): the negative of
   * Σ delta over kinds reserve/commit/refund — the one-append-per-phase model
   * (§14.2) makes that net equal the credits actually charged, plus holds
   * still open in the window. Grants/packs/adjustments are NOT spend.
   */
  readonly spendCredits: number;
  /** Open holds: credit_reservations rows with status 'held' (§14.2 rule 1). */
  readonly openHolds: number;
  /** True while the workspace has no active paid subscription (§14.1 trial). */
  readonly trial: boolean;
}

/**
 * One composite billing read for the summary card. `since` is the window
 * start (now − 30d, computed by the route with its injectable clock).
 */
export interface BillingSummaryLike {
  summary(query: {
    readonly organizationId: string;
    readonly since: Date;
  }): Promise<WorkspaceBillingSummary>;
}

// ---------------------------------------------------------------------------
// Rate-limit policies (§1.5 rule 5: per-workspace limits on abuse surfaces)
// ---------------------------------------------------------------------------

/** One read-side policy: scope names the limit (KV key + rate_limit_buckets). */
export interface ReadRateLimitPolicy {
  readonly scope: string;
  readonly limit: number;
  readonly windowSec: number;
}

/** Default GET /v1/credits(/summary) policy: 120 reads/min per workspace. */
export const CREDITS_READ_POLICY: ReadRateLimitPolicy = {
  scope: "api.credits.read",
  limit: 120,
  windowSec: 60,
};

/** Default GET /v1/usage policy: 30 reads/min per workspace (grouped scans). */
export const USAGE_READ_POLICY: ReadRateLimitPolicy = {
  scope: "api.usage.read",
  limit: 30,
  windowSec: 60,
};

/**
 * The service aggregate injected into the routes (one object, one variable).
 * `rateLimits` and `now` are optional test seams with the defaults above.
 */
export interface CreditsDeps {
  readonly auth: CreditsAuthLike;
  readonly ledger: LedgerLike;
  readonly summary: BillingSummaryLike;
  /** Grouped-read seam for the usage rollups (drizzleUsageQueries in prod). */
  readonly usage: UsageQueryLike;
  /** Shared limiter service (W4-D) — token buckets per (scope, org). */
  readonly limiter: RateLimiter;
  /** Policy overrides (tests pin tight limits); defaults above. */
  readonly rateLimits?: {
    readonly credits?: ReadRateLimitPolicy;
    readonly usage?: ReadRateLimitPolicy;
  };
  /** Injectable epoch-ms clock; deterministic tests freeze it. Default Date.now. */
  readonly now?: () => number;
}

function creditsPolicy(deps: CreditsDeps): ReadRateLimitPolicy {
  return deps.rateLimits?.credits ?? CREDITS_READ_POLICY;
}

function usagePolicy(deps: CreditsDeps): ReadRateLimitPolicy {
  return deps.rateLimits?.usage ?? USAGE_READ_POLICY;
}

// ---------------------------------------------------------------------------
// Wire schemas (Zod at every boundary)
// ---------------------------------------------------------------------------

/** GET /v1/credits query — non-strict: extra query params are ignored. */
export const CREDITS_PAGE_QUERY_SCHEMA = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().trim().min(1).max(1024).optional(),
});

export type CreditsPageQuery = z.infer<typeof CREDITS_PAGE_QUERY_SCHEMA>;

/** GET /v1/usage query: optional UTC calendar days; defaults fill below. */
export const USAGE_QUERY_SCHEMA = z.object({
  from: DAY_KEY_SCHEMA.optional(),
  to: DAY_KEY_SCHEMA.optional(),
});

export type UsageQuery = z.infer<typeof USAGE_QUERY_SCHEMA>;

// ---------------------------------------------------------------------------
// Keyset cursor codec (opaque to clients; mirrors services/runs.ts)
// ---------------------------------------------------------------------------

const CURSOR_JSON_SCHEMA = z
  .object({
    c: z.string().datetime(),
    i: z.string().min(1).max(64),
  })
  .strict();

/** Encodes a cursor as base64url JSON (no client-meaningful contents). */
export function encodeLedgerCursor(cursor: LedgerPageCursor): string {
  return Buffer.from(
    JSON.stringify({ c: cursor.createdAt.toISOString(), i: cursor.id }),
    "utf8",
  ).toString("base64url");
}

/** Decodes a client cursor; null when malformed or expired-shaped. */
export function decodeLedgerCursor(encoded: string): LedgerPageCursor | null {
  try {
    const json = Buffer.from(encoded, "base64url").toString("utf8");
    const parsed = CURSOR_JSON_SCHEMA.parse(JSON.parse(json) as unknown);
    return { createdAt: new Date(parsed.c), id: parsed.i };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shared handler helpers
// ---------------------------------------------------------------------------

/** Reads the injected services; a missing injection is a typed 500 (§13.3). */
function services(c: Context<CreditsEnv>): CreditsDeps {
  const deps = c.get("creditsServices");
  if (deps === undefined) {
    throw new AppError(500, "internal_error", "The credits service is not wired.", {
      hint: "Mount credits/usage routes through mountCreditsRoutes() so services are injected.",
      retryable: false,
    });
  }
  return deps;
}

/** Maps a §13.3 failure envelope to the AppError the error mapper renders. */
function failureToAppError(failure: Failure): AppError {
  return new AppError(httpStatusFor(failure.code), failure.code, failure.message, {
    hint: failure.hint,
    retryable: failure.retryable,
  });
}

/** Resolves the caller; auth failures are typed envelopes (401/403, §15). */
async function requireCaller(deps: CreditsDeps, request: Request): Promise<CreditsCaller> {
  const result = await deps.auth.authenticate(request);
  if (isFailure(result)) {
    throw new AppError(result.code === "forbidden" ? 403 : 401, result.code, result.message, {
      hint: result.hint,
      retryable: result.retryable,
    });
  }
  return result.value;
}

/**
 * Charges one token against the caller's workspace bucket (§1.5 rule 5).
 * Post-auth so the bucket is org-keyed, never a shared IP pool. Fails OPEN on
 * a limiter outage — reads are not a money gate (W4-D rationale in
 * middleware/rate-limit.ts); the Postgres-backed §14.2 rules are unaffected.
 */
async function enforceReadLimit(
  c: Context<CreditsEnv>,
  deps: CreditsDeps,
  caller: CreditsCaller,
  policy: ReadRateLimitPolicy,
): Promise<void> {
  const bucketKey = subjectBucketKey({ kind: "org", organizationId: caller.organizationId });
  let decision: RateLimitDecision;
  try {
    decision = await deps.limiter.tokenBucket(policy.scope, bucketKey, {
      limit: policy.limit,
      windowSec: policy.windowSec,
    });
  } catch (error) {
    const log: Logger | undefined = c.get("logger");
    log?.warn(
      { err: error, scope: policy.scope },
      "credits_read_rate_limit_failing_open",
    );
    return;
  }
  c.header(RATE_LIMIT_HEADERS.limit, String(policy.limit));
  c.header(RATE_LIMIT_HEADERS.remaining, String(decision.remaining));
  if (!decision.allowed) {
    const nowMs = deps.now?.() ?? Date.now();
    c.header("Retry-After", String(decision.retryAfterSec));
    c.header(
      RATE_LIMIT_HEADERS.reset,
      String(Math.ceil((nowMs + decision.retryAfterSec * 1000) / 1000)),
    );
    throw new AppError(
      429,
      "rate_limited",
      "Too many requests — slow down and retry shortly.",
      {
        hint: `Limit is ${policy.limit} per ${policy.windowSec}s. Retry after ${decision.retryAfterSec}s.`,
        retryable: true,
      },
    );
  }
}

/** Route-level usage-window guard → 422 envelopes (service re-validates too). */
function assertUsageWindow(from: string, to: string): void {
  const fromMs = startOfUtcDay(from).getTime();
  const toMs = startOfUtcDay(to).getTime();
  if (fromMs > toMs) {
    throw new AppError(422, "validation_failed", "The usage window start is after its end.", {
      hint: "`from` must be on or before `to` (UTC calendar days, YYYY-MM-DD).",
      retryable: true,
    });
  }
  if (Math.round((toMs - fromMs) / 86_400_000) + 1 > USAGE_MAX_DAYS) {
    throw new AppError(
      422,
      "validation_failed",
      `The usage window is too wide (max ${USAGE_MAX_DAYS} days).`,
      {
        hint: "Narrow the range, or request it in monthly chunks.",
        retryable: true,
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Wire serializers (§13.1 shapes; snake_case like the spec tables)
// ---------------------------------------------------------------------------

/** One ledger row as GET /v1/credits serves it. Internal fields stay internal:
 *  the idempotency key and creator are support/audit surfaces (§22 audit_log),
 *  never the balance API. */
export interface LedgerEntryApiView {
  readonly id: string;
  readonly kind: string;
  readonly delta: number;
  readonly run_id: string | null;
  readonly note: string | null;
  readonly balance_after: number;
  readonly created_at: string;
}

export function ledgerRowToApi(row: CreditLedger): LedgerEntryApiView {
  return {
    id: row.id,
    kind: row.kind,
    delta: row.delta,
    run_id: row.runId,
    note: row.note,
    balance_after: row.balanceAfter,
    created_at: row.createdAt.toISOString(),
  };
}

/** Per-day credit sums by §14.2 kind (single-word keys stay as-is) + net. */
export interface CreditKindSumsApiView {
  readonly grant: number;
  readonly pack: number;
  readonly reserve: number;
  readonly commit: number;
  readonly refund: number;
  readonly adjustment: number;
  readonly net: number;
}

export function creditSumsToApi(sums: CreditKindSums): CreditKindSumsApiView {
  return {
    grant: sums.grant,
    pack: sums.pack,
    reserve: sums.reserve,
    commit: sums.commit,
    refund: sums.refund,
    adjustment: sums.adjustment,
    net: sums.net,
  };
}

/** Per-day run stats (§22: runs by status/tier, AI cost, token sums). */
export interface RunDayApiView {
  readonly count: number;
  readonly by_status: Readonly<Record<string, number>>;
  readonly by_tier: Readonly<Record<string, number>>;
  readonly cost_micro_usd: number;
  readonly tokens_in: number;
  readonly tokens_out: number;
}

export function runDayToApi(day: RunDayStats): RunDayApiView {
  return {
    count: day.runs,
    by_status: day.runsByStatus,
    by_tier: day.runsByTier,
    cost_micro_usd: day.costMicroUsd,
    tokens_in: day.tokensIn,
    tokens_out: day.tokensOut,
  };
}

export interface RunTotalsApiView {
  readonly runs: number;
  readonly cost_micro_usd: number;
  readonly tokens_in: number;
  readonly tokens_out: number;
}

export function runTotalsToApi(totals: RunStatsTotals): RunTotalsApiView {
  return {
    runs: totals.runs,
    cost_micro_usd: totals.costMicroUsd,
    tokens_in: totals.tokensIn,
    tokens_out: totals.tokensOut,
  };
}

/** One merged dashboard day: credit sums + run stats (§13.1/§22). */
export interface UsageDayApiView {
  readonly day: string;
  readonly credits: CreditKindSumsApiView;
  readonly runs: RunDayApiView;
}

/** GET /v1/usage response shape. */
export interface UsageApiView {
  readonly from: string;
  readonly to: string;
  readonly days: readonly UsageDayApiView[];
  readonly totals: RunTotalsApiView;
}

// ---------------------------------------------------------------------------
// Routers (consts, per the wave contract)
// ---------------------------------------------------------------------------

export const creditRoutes = new Hono<CreditsEnv>();
export const usageRoutes = new Hono<CreditsEnv>();

/** Default summary window (§22 business dashboard card). */
export const SUMMARY_WINDOW_DAYS = 30;

// ---------------------------------------------------------------------------
// GET /v1/credits — balance + one ledger page (§13.1)
// ---------------------------------------------------------------------------

creditRoutes.get("/", async (c) => {
  const deps = services(c);
  const caller = await requireCaller(deps, c.req.raw);
  await enforceReadLimit(c, deps, caller, creditsPolicy(deps));

  const query = CREDITS_PAGE_QUERY_SCHEMA.parse(c.req.query());
  const before = query.cursor !== undefined ? decodeLedgerCursor(query.cursor) : undefined;
  if (query.cursor !== undefined && before === undefined) {
    throw new AppError(422, "validation_failed", "The pagination cursor is malformed.", {
      hint: "Pass the next_cursor value from the previous page unmodified.",
      retryable: true,
    });
  }

  const page = await deps.ledger.page({
    organizationId: caller.organizationId,
    limit: query.limit,
    ...(before !== undefined ? { before } : {}),
  });
  // SUM SANITY (§12.2): balance ≡ Σ ledger deltas; the newest row's
  // balance_after equals it — see the module header note.
  const balance = await deps.ledger.balanceAfter(caller.organizationId);

  return c.json({
    balance,
    ledger: {
      rows: page.rows.map(ledgerRowToApi),
      ...(page.next !== undefined ? { next_cursor: encodeLedgerCursor(page.next) } : {}),
    },
  });
});

// ---------------------------------------------------------------------------
// GET /v1/credits/summary — 30d spend, open holds, trial flag
// ---------------------------------------------------------------------------

creditRoutes.get("/summary", async (c) => {
  const deps = services(c);
  const caller = await requireCaller(deps, c.req.raw);
  await enforceReadLimit(c, deps, caller, creditsPolicy(deps));

  const nowMs = deps.now?.() ?? Date.now();
  const since = new Date(nowMs - SUMMARY_WINDOW_DAYS * 86_400_000);
  const summary = await deps.summary.summary({
    organizationId: caller.organizationId,
    since,
  });

  return c.json({
    window_days: SUMMARY_WINDOW_DAYS,
    spend_credits: summary.spendCredits,
    open_holds: summary.openHolds,
    trial: summary.trial,
  });
});

// ---------------------------------------------------------------------------
// GET /v1/usage — daily rollups for the workspace dashboard (§13.1/§22)
// ---------------------------------------------------------------------------

usageRoutes.get("/", async (c) => {
  const deps = services(c);
  const caller = await requireCaller(deps, c.req.raw);
  await enforceReadLimit(c, deps, caller, usagePolicy(deps));

  const query = USAGE_QUERY_SCHEMA.parse(c.req.query());
  const nowMs = deps.now?.() ?? Date.now();
  const to = query.to ?? dayKeyUtc(new Date(nowMs));
  const from = query.from ?? addDays(to, -(DEFAULT_USAGE_WINDOW_DAYS - 1));
  assertUsageWindow(from, to);

  const credits = await dailyUsage(deps.usage, {
    organizationId: caller.organizationId,
    from,
    to,
  });
  if (isFailure(credits)) {
    throw failureToAppError(credits);
  }
  const runs = await runStats(deps.usage, {
    organizationId: caller.organizationId,
    from,
    to,
  });
  if (isFailure(runs)) {
    throw failureToAppError(runs);
  }

  // Merge per UTC day; both rollups zero-fill the same window, so the zip is
  // complete — the map lookup is belt-and-braces for seam implementations.
  const runByDay = new Map<string, RunDayStats>(
    runs.value.days.map((day): [string, RunDayStats] => [day.day, day]),
  );
  const days: UsageDayApiView[] = credits.value.map((creditDay) => {
    const runDay = runByDay.get(creditDay.day) ?? emptyRunDayStats(creditDay.day);
    return {
      day: creditDay.day,
      credits: creditSumsToApi(creditDay.credits),
      runs: runDayToApi(runDay),
    };
  });

  return c.json({
    from,
    to,
    days,
    totals: runTotalsToApi(runs.value.totals),
  });
});

// ---------------------------------------------------------------------------
// Injection seam — middleware + one-call wiring helper
// ---------------------------------------------------------------------------

/**
 * Middleware that injects the credits/usage service seam. Typed against the
 * shared AppEnv so it mounts on the standard app (buildApp / the /v1
 * registry); the single context variable it writes is declared by CreditsEnv.
 */
export function creditsServices(deps: CreditsDeps): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    (c as unknown as Context<CreditsEnv>).set("creditsServices", deps);
    await next();
  });
}

/**
 * Wires both routers in one call — the only supported mount:
 *
 *   mountCreditsRoutes(app, deps)                          // /v1/credits, /v1/usage
 *   mountCreditsRoutes(v1, deps, { creditsPath: "/credits",
 *                                   usagePath: "/usage" }) // inside the /v1 app
 *
 * The `use` registrations cover the bare path and every sub-path; they must
 * stay BEFORE the route call. Mount BEFORE the /v1 catch-all (routes/index.ts).
 */
export function mountCreditsRoutes(
  app: Hono<AppEnv>,
  deps: CreditsDeps,
  options?: {
    readonly creditsPath?: string;
    readonly usagePath?: string;
  },
): void {
  const creditsPath = options?.creditsPath ?? "/v1/credits";
  const usagePath = options?.usagePath ?? "/v1/usage";
  app.use(creditsPath, creditsServices(deps));
  app.use(`${creditsPath}/*`, creditsServices(deps));
  app.route(creditsPath, creditRoutes);
  app.use(usagePath, creditsServices(deps));
  app.use(`${usagePath}/*`, creditsServices(deps));
  app.route(usagePath, usageRoutes);
}
