// @studio/gateway — usage rollups: daily credit sums + run statistics.
// Owner: W4-M (docs/AGENTS.md).
//
// Spec anchors:
//   §13.1  GET /v1/usage?from=&to= — daily rollups for the workspace dashboard
//   §22    cost dashboards: "AI cost per run/workspace/day"; metrics include
//          credits reserved/committed, tokens in/out/cache
//   §12.2  every aggregation is scoped by the tenant root organization_id —
//          composite queries, never "aggregate then check"
//   §14.2  ledger kinds reserve/commit/refund/adjustment/grant/pack; the net
//          of one run's rows equals its charged credits (one append per
//          phase — packages/billing/src/ledger.ts)
//
// Design (money math is pure; only grouped reads touch storage):
//   - `UsageQueryLike` is the injected query seam: two GROUPED reads —
//     ledger delta sums by (day, kind) and run aggregates by
//     (day, status, tier). `drizzleUsageQueries` implements the seam over
//     the real Drizzle client; the SQL approach is documented inline and is
//     NEVER executed in unit tests (no DB on the build box; CI typechecks).
//   - Pure helpers (`dayKeyUtc`, `foldLedgerDailyRows`, `foldRunDailyRows`,
//     `dayKeyRange`, …) carry the day-bucketing and merging math so tests
//     drive them table-driven, including tz-UTC bucket edges.
//   - Day buckets are UTC calendar days ('YYYY-MM-DD'), matching the SQL
//     `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')` below exactly;
//     §22 dashboards report in UTC — the wire never claims a local timezone.
//   - Both rollups ZERO-FILL every day of the requested window so dashboards
//     chart a contiguous series; the window is capped (USAGE_MAX_DAYS).

import type { CreditLedgerKind } from "@studio/billing";
import { err, isFailure, ok, type Result } from "@studio/config";
import { agentRuns, creditsLedger, type Db } from "@studio/db";
import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants + wire schemas
// ---------------------------------------------------------------------------

/** Hard cap on a requested window (inclusive of both end days). */
export const USAGE_MAX_DAYS = 366;

/** Default dashboard window: `to` = today, `from` = today − 29 (inclusive). */
export const DEFAULT_USAGE_WINDOW_DAYS = 30;

const MS_PER_DAY = 86_400_000;

/** A UTC calendar day key, 'YYYY-MM-DD' (zero-padded, sortable). */
export type DayKey = string;

/** True when `day` names a real UTC calendar day (rejects 2025-02-30 etc.). */
function isCalendarDayKey(day: string): boolean {
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === day;
}

/** Boundary schema for `from` / `to` (§13: Zod at every boundary). */
export const DAY_KEY_SCHEMA = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected a YYYY-MM-DD UTC calendar day")
  .refine(isCalendarDayKey, { message: "expected a real UTC calendar day" });

const organizationIdSchema = z.string().trim().min(1).max(200);

// ---------------------------------------------------------------------------
// Pure day math (UTC — dashboards bucket in UTC, §22)
// ---------------------------------------------------------------------------

/** The UTC day bucket a timestamp falls into ('YYYY-MM-DD'). */
export function dayKeyUtc(at: Date): DayKey {
  return at.toISOString().slice(0, 10);
}

/** Start of the UTC day ('2025-07-01' → 2025-07-01T00:00:00.000Z). */
export function startOfUtcDay(day: DayKey): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/**
 * `day` shifted by `days` (negative allowed). UTC has no DST, so plain
 * 86_400_000 ms math is exact — never use local-date arithmetic here.
 */
export function addDays(day: DayKey, days: number): DayKey {
  return dayKeyUtc(new Date(startOfUtcDay(day).getTime() + days * MS_PER_DAY));
}

/**
 * Every UTC day from `from` to `to`, inclusive, ascending. Reversed ranges
 * yield an empty list (caller-facing validation happens in parseUsageWindow).
 */
export function dayKeyRange(from: DayKey, to: DayKey): readonly DayKey[] {
  const days: DayKey[] = [];
  const last = startOfUtcDay(to).getTime();
  for (let cursor = startOfUtcDay(from).getTime(); cursor <= last; cursor += MS_PER_DAY) {
    days.push(dayKeyUtc(new Date(cursor)));
  }
  return days;
}

// ---------------------------------------------------------------------------
// Typed grouped rows (the seam's row contracts)
// ---------------------------------------------------------------------------

/** One (UTC day, ledger kind) group: the sum of `credit_ledger.delta`. */
export interface LedgerDailyRow {
  readonly day: DayKey;
  readonly kind: CreditLedgerKind;
  readonly deltaSum: number;
}

/**
 * One (UTC day, status, tier) group over `agent_runs`: run count plus the
 * §5.3/§22 cost observability sums. `status`/`tier` are the free-text column
 * values (schema-typed enums arrive as strings on the wire).
 */
export interface RunDailyRow {
  readonly day: DayKey;
  readonly status: string;
  readonly tier: string;
  readonly runCount: number;
  readonly costMicroUsd: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
}

/** Half-open read range: rows with `from <= created_at < to` (§13.1 window). */
export interface UsageQueryInput {
  readonly organizationId: string;
  readonly from: Date;
  readonly to: Date;
}

// ---------------------------------------------------------------------------
// Folding (pure) — grouped rows → per-day rollups
// ---------------------------------------------------------------------------

/** Per-day credit sums, one field per §14.2 ledger kind, plus the net. */
export interface CreditKindSums {
  readonly grant: number;
  readonly pack: number;
  readonly reserve: number;
  readonly commit: number;
  readonly refund: number;
  readonly adjustment: number;
  /** Sum of every delta in the bucket — the day's balance movement. */
  readonly net: number;
}

function emptyKindSums(): CreditKindSums {
  return { grant: 0, pack: 0, reserve: 0, commit: 0, refund: 0, adjustment: 0, net: 0 };
}

/** A zeroed day (dashboards chart gaps as 0, never as missing data). */
export function emptyCreditKindSums(): CreditKindSums {
  return emptyKindSums();
}

/**
 * Folds grouped (day, kind) sums into per-day `CreditKindSums`.
 *
 * An unknown kind is a hard error, never a silent drop: this is money math —
 * a value the fold cannot attribute must never be quietly discarded (§25.8
 * "forensics week"). The seam types kinds as the closed union; a corrupt row
 * is a 500, not a wrong number.
 */
export function foldLedgerDailyRows(
  rows: readonly LedgerDailyRow[],
): ReadonlyMap<DayKey, CreditKindSums> {
  const byDay = new Map<DayKey, CreditKindSums>();
  for (const row of rows) {
    const sums = byDay.get(row.day) ?? emptyKindSums();
    let next: CreditKindSums;
    switch (row.kind) {
      case "grant":
        next = { ...sums, grant: sums.grant + row.deltaSum };
        break;
      case "pack":
        next = { ...sums, pack: sums.pack + row.deltaSum };
        break;
      case "reserve":
        next = { ...sums, reserve: sums.reserve + row.deltaSum };
        break;
      case "commit":
        next = { ...sums, commit: sums.commit + row.deltaSum };
        break;
      case "refund":
        next = { ...sums, refund: sums.refund + row.deltaSum };
        break;
      case "adjustment":
        next = { ...sums, adjustment: sums.adjustment + row.deltaSum };
        break;
      default: {
        // Exhaustiveness + runtime guard: the union is closed, but the column
        // is free text — refuse to report money we cannot attribute.
        const exhausted: never = row.kind;
        throw new Error(`[usage] unknown credit ledger kind: ${String(exhausted)}`);
      }
    }
    byDay.set(row.day, { ...next, net: next.net + row.deltaSum });
  }
  return byDay;
}

/** Per-day run statistics (§22: runs by status/tier, cost, token sums). */
export interface RunDayStats {
  readonly day: DayKey;
  readonly runs: number;
  readonly runsByStatus: Readonly<Record<string, number>>;
  readonly runsByTier: Readonly<Record<string, number>>;
  readonly costMicroUsd: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
}

/** A zeroed run day (no runs landed in this UTC bucket). */
export function emptyRunDayStats(day: DayKey): RunDayStats {
  return { day, runs: 0, runsByStatus: {}, runsByTier: {}, costMicroUsd: 0, tokensIn: 0, tokensOut: 0 };
}

function countInto(buckets: Record<string, number>, key: string, count: number): void {
  buckets[key] = (buckets[key] ?? 0) + count;
}

/** Folds grouped (day, status, tier) rows into per-day `RunDayStats`. */
export function foldRunDailyRows(rows: readonly RunDailyRow[]): ReadonlyMap<DayKey, RunDayStats> {
  const byDay = new Map<DayKey, RunDayStats>();
  for (const row of rows) {
    const current =
      byDay.get(row.day) ?? emptyRunDayStats(row.day);
    const byStatus = { ...current.runsByStatus };
    countInto(byStatus, row.status, row.runCount);
    const byTier = { ...current.runsByTier };
    countInto(byTier, row.tier, row.runCount);
    byDay.set(row.day, {
      day: row.day,
      runs: current.runs + row.runCount,
      runsByStatus: byStatus,
      runsByTier: byTier,
      costMicroUsd: current.costMicroUsd + row.costMicroUsd,
      tokensIn: current.tokensIn + row.tokensIn,
      tokensOut: current.tokensOut + row.tokensOut,
    });
  }
  return byDay;
}

// ---------------------------------------------------------------------------
// Window parsing (shared by dailyUsage + runStats; Result, never throws)
// ---------------------------------------------------------------------------

/** Rollup request: the UTC day range, inclusive on both ends (§13.1). */
export interface DailyUsageInput {
  readonly organizationId: string;
  readonly from: DayKey;
  readonly to: DayKey;
}

interface UsageWindow {
  readonly organizationId: string;
  readonly fromDay: DayKey;
  readonly toDay: DayKey;
  /** Inclusive lower bound (start of `fromDay`, UTC). */
  readonly from: Date;
  /** Exclusive upper bound (start of the day AFTER `toDay`, UTC). */
  readonly to: Date;
  /** Zero-fill list, ascending, inclusive. */
  readonly days: readonly DayKey[];
}

const USAGE_INPUT_SCHEMA = z
  .object({
    organizationId: organizationIdSchema,
    from: DAY_KEY_SCHEMA,
    to: DAY_KEY_SCHEMA,
  })
  .strict();

function parseUsageWindow(input: DailyUsageInput): Result<UsageWindow> {
  const parsed = USAGE_INPUT_SCHEMA.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    return err("validation_failed", "The usage window is malformed.", { hint: issues });
  }
  const { organizationId, from: fromDay, to: toDay } = parsed.data;
  const fromMs = startOfUtcDay(fromDay).getTime();
  const toMs = startOfUtcDay(toDay).getTime();
  if (fromMs > toMs) {
    return err("validation_failed", "The usage window start is after its end.", {
      hint: "`from` must be on or before `to` (UTC calendar days).",
    });
  }
  const dayCount = Math.round((toMs - fromMs) / MS_PER_DAY) + 1;
  if (dayCount > USAGE_MAX_DAYS) {
    return err("validation_failed", `The usage window is too wide (max ${USAGE_MAX_DAYS} days).`, {
      hint: "Narrow the range, or request it in monthly chunks.",
    });
  }
  return ok({
    organizationId,
    fromDay,
    toDay,
    from: new Date(fromMs),
    to: new Date(toMs + MS_PER_DAY),
    days: dayKeyRange(fromDay, toDay),
  });
}

// ---------------------------------------------------------------------------
// Rollup services (seam-first, mirroring @studio/billing's store-first style)
// ---------------------------------------------------------------------------

/** One day of the credit rollup: the day key + its per-kind sums. */
export interface LedgerDayUsage {
  readonly day: DayKey;
  readonly credits: CreditKindSums;
}

/**
 * §13.1/§22 — daily credit rollups for one workspace: every UTC day of
 * [from, to] inclusive, zero-filled, ascending, each carrying the summed
 * ledger deltas per §14.2 kind plus the day's net. Tenant-scoped: the seam
 * receives the caller's organization id and MUST scope every grouped read
 * by it (§12.2).
 */
export async function dailyUsage(
  queries: UsageQueryLike,
  input: DailyUsageInput,
): Promise<Result<readonly LedgerDayUsage[]>> {
  const window = parseUsageWindow(input);
  if (isFailure(window)) {
    return window;
  }
  const rows = await queries.ledgerDailySums({
    organizationId: window.organizationId,
    from: window.from,
    to: window.to,
  });
  const byDay = foldLedgerDailyRows(rows);
  return ok(
    window.days.map((day) => ({ day, credits: byDay.get(day) ?? emptyCreditKindSums() })),
  );
}

/** Window totals alongside the per-day series (§22 cost dashboard header). */
export interface RunStatsTotals {
  readonly runs: number;
  readonly costMicroUsd: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
}

export interface RunStats {
  readonly from: DayKey;
  readonly to: DayKey;
  readonly days: readonly RunDayStats[];
  readonly totals: RunStatsTotals;
}

/**
 * §13.1/§22 — run statistics for one workspace window: per-UTC-day runs by
 * status and by tier, summed `agent_runs.cost_micro_usd`, and token in/out
 * sums (§5.3/§22 observability counters). Buckets by `created_at` — the
 * run's request time — so a run lands in exactly one day even when it
 * straddles midnight.
 */
export async function runStats(
  queries: UsageQueryLike,
  input: DailyUsageInput,
): Promise<Result<RunStats>> {
  const window = parseUsageWindow(input);
  if (isFailure(window)) {
    return window;
  }
  const rows = await queries.runDailyAggregates({
    organizationId: window.organizationId,
    from: window.from,
    to: window.to,
  });
  const byDay = foldRunDailyRows(rows);
  const days = window.days.map((day) => byDay.get(day) ?? emptyRunDayStats(day));
  const totals = days.reduce<RunStatsTotals>(
    (acc, day) => ({
      runs: acc.runs + day.runs,
      costMicroUsd: acc.costMicroUsd + day.costMicroUsd,
      tokensIn: acc.tokensIn + day.tokensIn,
      tokensOut: acc.tokensOut + day.tokensOut,
    }),
    { runs: 0, costMicroUsd: 0, tokensIn: 0, tokensOut: 0 },
  );
  return ok({ from: window.fromDay, to: window.toDay, days, totals });
}

// ---------------------------------------------------------------------------
// The query seam + the Drizzle implementation (documented; NOT run here)
// ---------------------------------------------------------------------------

/**
 * Injected query seam for both rollups. Implementations MUST scope every
 * grouped read by `organizationId` (§12.2) and return typed rows — one per
 * group, sums already numeric. Tests fake this seam; production uses
 * `drizzleUsageQueries(db)` below.
 */
export interface UsageQueryLike {
  /** GROUP BY (UTC day, kind) → sum(delta), org-scoped, [from, to). */
  ledgerDailySums(query: UsageQueryInput): Promise<readonly LedgerDailyRow[]>;
  /** GROUP BY (UTC day, status, tier) → count + cost/token sums, org-scoped. */
  runDailyAggregates(query: UsageQueryInput): Promise<readonly RunDailyRow[]>;
}

/**
 * Structural seam over the Drizzle client as buildApp deps will carry it
 * (`db` from @studio/db's createDb): exactly the one query builder these
 * rollups need. A real `Db` satisfies it structurally; the wiring wave passes
 * `drizzleUsageQueries(db)` — no adapter in between (W4-H event-store
 * precedent).
 */
export type DbLike = Pick<Db, "select">;

/**
 * DRIZZLE AGGREGATION APPROACH (production implementation — never executed
 * in unit tests; verified by CI typecheck and exercised against a real
 * database only in the integration environment):
 *
 *   Day bucketing — `to_char(<created_at> AT TIME ZONE 'UTC', 'YYYY-MM-DD')`.
 *   Both columns are `timestamptz`; `AT TIME ZONE 'UTC'` renders the UTC
 *   wall clock, and `to_char` emits the exact 'YYYY-MM-DD' shape the pure
 *   `dayKeyUtc` helper produces — SQL and TS agree on every bucket edge.
 *
 *   Ledger sums —
 *     SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
 *            kind,
 *            coalesce(sum(delta), 0) AS delta_sum
 *     FROM credit_ledger
 *     WHERE organization_id = :org AND created_at >= :from AND created_at < :to
 *     GROUP BY 1, kind
 *   served by credit_ledger_org_created_idx (organization_id, created_at DESC).
 *
 *   Run aggregates —
 *     SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
 *            status, tier,
 *            count(*) AS run_count,
 *            coalesce(sum(cost_micro_usd), 0) AS cost_micro_usd,
 *            coalesce(sum(tokens_in), 0) AS tokens_in,
 *            coalesce(sum(tokens_out), 0) AS tokens_out
 *     FROM agent_runs
 *     WHERE organization_id = :org AND created_at >= :from AND created_at < :to
 *     GROUP BY 1, status, tier
 *   served by agent_runs_org_created_idx (organization_id, created_at DESC).
 *
 *   Numeric mapping — Postgres sum() over int/bigint returns bigint (and
 *   count(*) is bigint), which the pg driver delivers as STRING; every
 *   aggregate below is therefore Number()-mapped once, here, at the seam.
 *   No ::int cast is used on cost_micro_usd: a workspace-month of micro-dollars
 *   can exceed int4 range; Number() keeps full precision for real values.
 */
export function drizzleUsageQueries(db: DbLike): UsageQueryLike {
  return {
    async ledgerDailySums(query) {
      const rows = await db
        .select({
          day: sql<string>`to_char(${creditsLedger.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`.as(
            "day",
          ),
          kind: creditsLedger.kind,
          deltaSum: sql<string>`coalesce(sum(${creditsLedger.delta}), 0)`.as("delta_sum"),
        })
        .from(creditsLedger)
        .where(
          and(
            eq(creditsLedger.organizationId, query.organizationId), // §12.2 tenant root
            gte(creditsLedger.createdAt, query.from),
            lt(creditsLedger.createdAt, query.to),
          ),
        )
        .groupBy(
          sql`to_char(${creditsLedger.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`,
          creditsLedger.kind,
        )
        .orderBy(
          asc(sql`to_char(${creditsLedger.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`),
        );
      return rows.map((row) => ({
        day: row.day,
        kind: row.kind,
        deltaSum: Number(row.deltaSum),
      }));
    },

    async runDailyAggregates(query) {
      const rows = await db
        .select({
          day: sql<string>`to_char(${agentRuns.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`.as(
            "day",
          ),
          status: agentRuns.status,
          tier: agentRuns.tier,
          runCount: sql<string>`count(*)`.as("run_count"),
          costMicroUsd: sql<string>`coalesce(sum(${agentRuns.costMicroUsd}), 0)`.as("cost_micro_usd"),
          tokensIn: sql<string>`coalesce(sum(${agentRuns.tokensIn}), 0)`.as("tokens_in"),
          tokensOut: sql<string>`coalesce(sum(${agentRuns.tokensOut}), 0)`.as("tokens_out"),
        })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.organizationId, query.organizationId), // §12.2 tenant root
            gte(agentRuns.createdAt, query.from),
            lt(agentRuns.createdAt, query.to),
          ),
        )
        .groupBy(
          sql`to_char(${agentRuns.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`,
          agentRuns.status,
          agentRuns.tier,
        )
        .orderBy(
          asc(sql`to_char(${agentRuns.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`),
        );
      return rows.map((row) => ({
        day: row.day,
        status: row.status,
        tier: row.tier,
        runCount: Number(row.runCount),
        costMicroUsd: Number(row.costMicroUsd),
        tokensIn: Number(row.tokensIn),
        tokensOut: Number(row.tokensOut),
      }));
    },
  };
}
