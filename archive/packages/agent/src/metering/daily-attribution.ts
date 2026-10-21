// @studio/agent — metering: daily workspace cost attribution. Owner: W9-C.
//
// Spec anchors:
//   §22    metrics/dashboards: "AI cost per run/workspace/day", cost dashboard
//          (per-workspace spend, top spenders), credits reserved/committed
//   §0     money note (margin targets checked elsewhere, see cost-model.ts)
//
// PURE bucketing — no clock reads (callers pass epoch ms), no I/O, no state.
// A run is attributed ENTIRELY to the UTC calendar day it STARTED in: runs that
// cross midnight never split cost across two rows (a run is the atomic billing
// event — §14 reserve/commit — so its COGS is atomic too).
//
// Cross-ref: UTC day boundaries are the SAME convention as the W4-M usage
// service (apps/web usage rollups). Keep the two in sync: if one changes day
// conventions, the §22 cost dashboard and the usage dashboard would otherwise
// disagree on the same workspace-day.
import { MeteringError, microToSafeNumber } from "./cost-model.js";

/** One run's cost summary, at attribution time (finished or in flight). */
export interface RunCostRecord {
  readonly runId: string;
  /** §12.2 tenant root — the workspace key of the §22 cost dashboard. */
  readonly organizationId: string;
  /** Epoch ms of run start — the attribution instant (see header note). */
  readonly startedAtMs: number;
  readonly costMicroUsd: number | bigint;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly cacheHits?: number;
  /** §14 credits held at run start (§22 "credits reserved" metric). */
  readonly creditsReserved?: number;
  /** §14 credits committed on success (§22 "credits committed" metric). */
  readonly creditsCharged?: number;
}

/** One (workspace, UTC-day) aggregation row for the §22 cost dashboards. */
export interface WorkspaceDayCostRow {
  readonly organizationId: string;
  /** UTC calendar day, "YYYY-MM-DD" (day boundaries are UTC-only). */
  readonly day: string;
  readonly runs: number;
  readonly costMicroUsd: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheHits: number;
  readonly creditsReserved: number;
  readonly creditsCharged: number;
}

/** Days are UTC-only; note the month is 1-based while the array index is 0. */
export function utcDayOf(epochMs: number): string {
  if (!Number.isSafeInteger(epochMs)) {
    throw new MeteringError(
      "invalid_usage",
      `startedAtMs must be a safe integer epoch (ms), got ${epochMs}`,
      "attribution instants come from run timestamps, never floats",
    );
  }
  const date = new Date(epochMs);
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

interface DayTally {
  runs: number;
  costMicro: bigint;
  tokensIn: number;
  tokensOut: number;
  cacheHits: number;
  creditsReserved: number;
  creditsCharged: number;
}

function nonNegativeInteger(value: number | undefined, field: string): number {
  const v = value ?? 0;
  if (!Number.isSafeInteger(v) || v < 0) {
    throw new MeteringError(
      "invalid_usage",
      `${field} must be a non-negative safe integer, got ${v}`,
      "§22 counters are whole numbers; sanitize provider telemetry upstream",
    );
  }
  return v;
}

function toBigIntMicro(value: number | bigint, field: string): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) {
      throw new MeteringError("invalid_usage", `${field} must be >= 0`, "costs are never negative");
    }
    return value;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new MeteringError(
      "invalid_usage",
      `${field} must be a finite non-negative number, got ${value}`,
      "micro-USD costs must arrive as integers; float micro-dollars are a wiring bug",
    );
  }
  return BigInt(Math.round(value));
}

/**
 * Buckets runs into (workspace, UTC day) cost rows for the §22 cost dashboard
 * ("AI cost per workspace/day", per-workspace spend, top spenders).
 *
 * Deterministic: rows are sorted by (organizationId, day) ascending. Costs sum
 * in bigint and convert to numbers only at row time (microToSafeNumber refuses
 * to exceed Number.MAX_SAFE_INTEGER — money never wraps through float64).
 */
export function attributeDailyCosts(
  records: Iterable<RunCostRecord>,
): readonly WorkspaceDayCostRow[] {
  const buckets = new Map<string, DayTally>();
  for (const record of records) {
    if (typeof record.runId !== "string" || record.runId.trim() === "") {
      throw new MeteringError(
        "invalid_usage",
        "runId must be a non-empty string",
        "attribution keys rows back to agent_runs.id (§12.1)",
      );
    }
    if (typeof record.organizationId !== "string" || record.organizationId.trim() === "") {
      throw new MeteringError(
        "invalid_usage",
        "organizationId must be a non-empty string",
        "the §12.2 tenant column is mandatory on every run",
      );
    }
    const day = utcDayOf(record.startedAtMs);
    const key = `${record.organizationId}\u0000${day}`;
    let tally = buckets.get(key);
    if (tally === undefined) {
      tally = {
        runs: 0,
        costMicro: 0n,
        tokensIn: 0,
        tokensOut: 0,
        cacheHits: 0,
        creditsReserved: 0,
        creditsCharged: 0,
      };
      buckets.set(key, tally);
    }
    tally.runs += 1;
    tally.costMicro += toBigIntMicro(record.costMicroUsd, "costMicroUsd");
    tally.tokensIn += nonNegativeInteger(record.tokensIn, "tokensIn");
    tally.tokensOut += nonNegativeInteger(record.tokensOut, "tokensOut");
    tally.cacheHits += nonNegativeInteger(record.cacheHits, "cacheHits");
    tally.creditsReserved += nonNegativeInteger(record.creditsReserved, "creditsReserved");
    tally.creditsCharged += nonNegativeInteger(record.creditsCharged, "creditsCharged");
  }
  const rows: WorkspaceDayCostRow[] = [];
  for (const [key, tally] of buckets.entries()) {
    const separator = key.indexOf("\u0000");
    rows.push(
      Object.freeze({
        organizationId: key.slice(0, separator),
        day: key.slice(separator + 1),
        runs: tally.runs,
        costMicroUsd: microToSafeNumber(tally.costMicro),
        tokensIn: tally.tokensIn,
        tokensOut: tally.tokensOut,
        cacheHits: tally.cacheHits,
        creditsReserved: tally.creditsReserved,
        creditsCharged: tally.creditsCharged,
      }),
    );
  }
  rows.sort((a, b) =>
    a.organizationId === b.organizationId
      ? a.day < b.day
        ? -1
        : a.day > b.day
          ? 1
          : 0
      : a.organizationId < b.organizationId
        ? -1
        : 1,
  );
  return Object.freeze(rows);
}
