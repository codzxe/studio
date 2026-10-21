// Credits + usage routes tests — deterministic fakes, no network, no DB
// (AGENTS.md test rules). Covers:
//   - GET /v1/credits: balance ≡ Σ ledger deltas (table-driven), newest-first
//     cursor pagination ordering (incl. same-timestamp id tiebreak), the
//     balance_after audit pairing, 422s, tenant guard, viewer-ok, 429 buckets
//   - GET /v1/credits/summary: 30d window anchor (frozen clock), passthrough,
//     tenant scoping
//   - GET /v1/usage: default window, UTC day-bucket edges, zero-fill, run
//     stats + totals, snake_case wire, window validation, tenant guard
//   - services/usage.ts pure math: dayKeyUtc tz-UTC bucket edges (table),
//     window helpers, fold functions; service-level Result validation
//
// The ledger fake derives `balanceAfter` as the Σ of the org's deltas — the
// §12.2 invariant itself — so the route's balance is exercised, not echoed.

import { err, isFailure, ok, type Result } from "@studio/config";
import type { CreditLedger, CreditLedgerKind } from "@studio/db";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { gatewayTransportSchema } from "../src/env.js";
import {
  creditRoutes,
  mountCreditsRoutes,
  SUMMARY_WINDOW_DAYS,
  type BillingSummaryLike,
  type CreditsAuthLike,
  type CreditsCaller,
  type CreditsDeps,
  type LedgerEntryApiView,
  type LedgerLike,
  type LedgerPage,
  type LedgerPageCursor,
  type UsageApiView,
  type WorkspaceBillingSummary,
} from "../src/routes/credits.js";
import { InMemoryKV, RateLimiter } from "../src/services/limiter.js";
import {
  USAGE_MAX_DAYS,
  addDays,
  dailyUsage,
  dayKeyRange,
  dayKeyUtc,
  emptyRunDayStats,
  foldLedgerDailyRows,
  foldRunDailyRows,
  runStats,
  startOfUtcDay,
  type LedgerDailyRow,
  type RunDailyRow,
  type UsageQueryInput,
  type UsageQueryLike,
} from "../src/services/usage.js";

// --- fixtures -------------------------------------------------------------------

const ORG_A = "11111111-2222-3333-4444-555566667777";
const ORG_B = "99999999-8888-7777-6666-555544443333";
const TOKEN_A = "token-a";
const TOKEN_VIEWER = "token-viewer";
const TOKEN_B = "token-b";
const USER_A = "user-a";

/** Frozen clock anchor: 2023-11-14T22:13:20.000Z (UTC day '2023-11-14'). */
const FROZEN_MS = 1_700_000_000_000;
const FROZEN_DAY = "2023-11-14";

/** §13.3 flat error envelope (W1-H error mapper shape). */
interface Envelope {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly hint?: string;
  readonly retryable: boolean;
}

async function errorBody(res: Response): Promise<Envelope> {
  expect(res.status >= 400).toBe(true);
  return (await res.json()) as Envelope;
}

function makeClock(startMs: number) {
  let now = startMs;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

// --- fakes ----------------------------------------------------------------------

class FakeAuth implements CreditsAuthLike {
  constructor(private readonly callers: ReadonlyMap<string, CreditsCaller>) {}

  async authenticate(request: Request): Promise<Result<CreditsCaller>> {
    const header = request.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const caller = this.callers.get(token);
    if (caller === undefined) {
      return err("unauthorized", "Missing or invalid credentials.", {
        hint: "Send Authorization: Bearer <token>.",
      });
    }
    return ok(caller);
  }
}

interface SeedLedgerInput {
  readonly organizationId: string;
  readonly delta: number;
  readonly kind: CreditLedgerKind;
  readonly createdAt: Date;
  readonly id?: string;
  readonly balanceAfter?: number;
}

/**
 * LedgerLike fake. `balanceAfter` DERIVES from the seeded deltas (§12.2) and
 * `page` mirrors the production walk: org filter, keyset guard, then
 * ORDER BY created_at DESC, id DESC with the limit+1 next-page probe.
 */
class FakeLedger implements LedgerLike {
  readonly #rows: CreditLedger[] = [];

  seed(input: SeedLedgerInput): CreditLedger {
    let running = 0;
    for (const row of this.#rows) {
      if (row.organizationId === input.organizationId) {
        running = row.balanceAfter; // rows are seeded in balance order
      }
    }
    const row: CreditLedger = {
      id: input.id ?? `row-${randomUUID()}`,
      organizationId: input.organizationId,
      delta: input.delta,
      kind: input.kind,
      idempotencyKey: `seed:${randomUUID()}`,
      runId: null,
      note: null,
      balanceAfter: input.balanceAfter ?? running + input.delta,
      createdBy: null,
      createdAt: input.createdAt,
    };
    this.#rows.push(row);
    return row;
  }

  rowsOf(organizationId: string): readonly CreditLedger[] {
    return this.#rows.filter((row) => row.organizationId === organizationId);
  }

  async balanceAfter(organizationId: string): Promise<number> {
    // §12.2 SUM SANITY: the balance IS the sum of the org's deltas.
    return this.rowsOf(organizationId).reduce((sum, row) => sum + row.delta, 0);
  }

  async page(query: {
    readonly organizationId: string;
    readonly limit: number;
    readonly before?: LedgerPageCursor;
  }): Promise<LedgerPage> {
    let rows = [...this.rowsOf(query.organizationId)];
    const before = query.before;
    if (before !== undefined) {
      rows = rows.filter(
        (row) =>
          row.createdAt.getTime() < before.createdAt.getTime() ||
          (row.createdAt.getTime() === before.createdAt.getTime() &&
            row.id < before.id),
      );
    }
    rows.sort((left, right) => {
      const delta = right.createdAt.getTime() - left.createdAt.getTime();
      return delta !== 0 ? delta : left.id < right.id ? 1 : -1;
    });
    const pageRows = rows.slice(0, query.limit);
    const last = pageRows.at(-1);
    return {
      rows: pageRows,
      ...(rows.length > query.limit && last !== undefined
        ? { next: { createdAt: last.createdAt, id: last.id } }
        : {}),
    };
  }
}

class FakeSummary implements BillingSummaryLike {
  readonly calls: { organizationId: string; since: Date }[] = [];
  next: WorkspaceBillingSummary = { spendCredits: 0, openHolds: 0, trial: false };

  async summary(query: {
    readonly organizationId: string;
    readonly since: Date;
  }): Promise<WorkspaceBillingSummary> {
    this.calls.push({ ...query });
    return this.next;
  }
}

interface SeedLedgerEvent {
  readonly organizationId: string;
  readonly at: Date;
  readonly kind: CreditLedgerKind;
  readonly delta: number;
}

interface SeedRunEvent {
  readonly organizationId: string;
  readonly at: Date;
  readonly status: string;
  readonly tier: string;
  readonly costMicroUsd?: number;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
}

/** A run event after seed-time defaulting — every numeric field required. */
interface SeededRunEvent {
  readonly organizationId: string;
  readonly at: Date;
  readonly status: string;
  readonly tier: string;
  readonly costMicroUsd: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
}

/**
 * UsageQueryLike fake: mirrors the production GROUP BY semantics — org + the
 * half-open [from, to) range, then (UTC day, kind) / (UTC day, status, tier)
 * groups with summed columns. Bucketing uses the SUT's dayKeyUtc, whose
 * tz-UTC edges are pinned by the direct table test below.
 */
class FakeUsageQueries implements UsageQueryLike {
  readonly #ledger: SeedLedgerEvent[] = [];
  readonly #runs: SeededRunEvent[] = [];

  seedLedger(event: SeedLedgerEvent): void {
    this.#ledger.push({ ...event });
  }

  seedRun(event: SeedRunEvent): void {
    this.#runs.push({
      ...event,
      costMicroUsd: event.costMicroUsd ?? 0,
      tokensIn: event.tokensIn ?? 0,
      tokensOut: event.tokensOut ?? 0,
    });
  }

  #inRange<T extends { readonly organizationId: string; readonly at: Date }>(
    events: readonly T[],
    query: UsageQueryInput,
  ): readonly T[] {
    return events.filter(
      (event) =>
        event.organizationId === query.organizationId &&
        event.at.getTime() >= query.from.getTime() &&
        event.at.getTime() < query.to.getTime(),
    );
  }

  async ledgerDailySums(query: UsageQueryInput): Promise<readonly LedgerDailyRow[]> {
    const groups = new Map<string, LedgerDailyRow>();
    for (const event of this.#inRange(this.#ledger, query)) {
      const day = dayKeyUtc(event.at);
      const key = `${day}\u0000${event.kind}`;
      const current = groups.get(key);
      groups.set(key, {
        day,
        kind: event.kind,
        deltaSum: (current?.deltaSum ?? 0) + event.delta,
      });
    }
    return [...groups.values()].sort((left, right) => (left.day < right.day ? -1 : 1));
  }

  async runDailyAggregates(query: UsageQueryInput): Promise<readonly RunDailyRow[]> {
    const groups = new Map<string, RunDailyRow>();
    for (const event of this.#inRange(this.#runs, query)) {
      const day = dayKeyUtc(event.at);
      const key = `${day}\u0000${event.status}\u0000${event.tier}`;
      const current = groups.get(key);
      groups.set(key, {
        day,
        status: event.status,
        tier: event.tier,
        runCount: (current?.runCount ?? 0) + 1,
        costMicroUsd: (current?.costMicroUsd ?? 0) + event.costMicroUsd,
        tokensIn: (current?.tokensIn ?? 0) + event.tokensIn,
        tokensOut: (current?.tokensOut ?? 0) + event.tokensOut,
      });
    }
    return [...groups.values()].sort((left, right) => (left.day < right.day ? -1 : 1));
  }
}

// --- harness ----------------------------------------------------------------------

interface Harness {
  readonly ledger: FakeLedger;
  readonly usage: FakeUsageQueries;
  readonly summary: FakeSummary;
  readonly clock: { now: () => number; advance: (ms: number) => void };
  readonly app: ReturnType<typeof buildApp>;
}

const TIGHT_LIMITS: NonNullable<CreditsDeps["rateLimits"]> = {
  credits: { scope: "test.credits.read", limit: 2, windowSec: 60 },
  usage: { scope: "test.usage.read", limit: 2, windowSec: 60 },
};

function makeHarness(rateLimits?: CreditsDeps["rateLimits"]): Harness {
  const clock = makeClock(FROZEN_MS);
  const limiter = new RateLimiter({ kv: new InMemoryKV(clock.now), now: clock.now });
  const ledger = new FakeLedger();
  const usage = new FakeUsageQueries();
  const summary = new FakeSummary();
  const auth = new FakeAuth(
    new Map<string, CreditsCaller>([
      [TOKEN_A, { userId: USER_A, organizationId: ORG_A, role: "editor" }],
      [TOKEN_VIEWER, { userId: "user-viewer", organizationId: ORG_A, role: "viewer" }],
      [TOKEN_B, { userId: "user-b", organizationId: ORG_B, role: "owner" }],
    ]),
  );
  const deps: CreditsDeps = {
    auth,
    ledger,
    summary,
    usage,
    limiter,
    now: clock.now,
    rateLimits,
  };
  const app = buildApp({
    env: gatewayTransportSchema.parse({}),
    logger: pino({ enabled: false }),
    version: "0.0.0-test",
    probes: [],
    startedAt: FROZEN_MS,
    mount: (root) => {
      mountCreditsRoutes(root, deps);
    },
  });
  return { ledger, usage, summary, clock, app };
}

async function get(
  harness: Harness,
  path: string,
  token: string | undefined = TOKEN_A,
): Promise<Response> {
  return harness.app.request(path, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

interface CreditsBody {
  readonly balance: number;
  readonly ledger: { readonly rows: readonly LedgerEntryApiView[]; readonly next_cursor?: string };
}

async function creditsBody(res: Response): Promise<CreditsBody> {
  expect(res.status).toBe(200);
  return (await res.json()) as CreditsBody;
}

const T0 = Date.parse("2025-07-01T10:00:00.000Z");

/** Seeds `count` rows for an org, one per second, newest last. */
function seedLedgerSeries(
  ledger: FakeLedger,
  organizationId: string,
  count: number,
  kind: CreditLedgerKind = "adjustment",
): void {
  for (let i = 0; i < count; i += 1) {
    ledger.seed({
      organizationId,
      kind,
      delta: -1,
      createdAt: new Date(T0 + i * 1000),
    });
  }
}

// ---------------------------------------------------------------------------
// Pure day math — tz-UTC bucket edges (§22: dashboards bucket in UTC)
// ---------------------------------------------------------------------------

describe("dayKeyUtc (UTC day bucketing)", () => {
  const TABLE: readonly { readonly at: string; readonly expected: string }[] = [
    { at: "2025-07-01T00:00:00.000Z", expected: "2025-07-01" }, // first ms of the day
    { at: "2025-06-30T23:59:59.999Z", expected: "2025-06-30" }, // last ms before the edge
    { at: "2025-01-01T07:59:59.999Z", expected: "2025-01-01" },
    { at: "2025-07-01T02:30:00.000+08:00", expected: "2025-06-30" }, // local Jul 1 = UTC Jun 30
    { at: "2025-12-31T23:30:00.000-05:00", expected: "2026-01-01" }, // UTC year rollover
    { at: "2024-02-29T23:59:59.999Z", expected: "2024-02-29" }, // leap day edge
    { at: "1970-01-01T00:00:00.000Z", expected: "1970-01-01" }, // epoch
  ];

  it.each(TABLE)("buckets $at into $expected", ({ at, expected }) => {
    expect(dayKeyUtc(new Date(at))).toBe(expected);
  });

  it("startOfUtcDay pins UTC midnight and round-trips through dayKeyUtc", () => {
    const start = startOfUtcDay("2025-07-09");
    expect(start.toISOString()).toBe("2025-07-09T00:00:00.000Z");
    expect(dayKeyUtc(start)).toBe("2025-07-09");
  });

  it("addDays rolls months/years, honours leap years, and goes backwards", () => {
    expect(addDays("2025-01-31", 1)).toBe("2025-02-01");
    expect(addDays("2025-12-31", 1)).toBe("2026-01-01");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29"); // leap year
    expect(addDays("2025-02-28", 1)).toBe("2025-03-01"); // non-leap year
    expect(addDays(FROZEN_DAY, -29)).toBe("2023-10-16"); // the default window
  });

  it("dayKeyRange is inclusive, ascending, and empty when reversed", () => {
    expect(dayKeyRange("2025-01-01", "2025-01-04")).toEqual([
      "2025-01-01",
      "2025-01-02",
      "2025-01-03",
      "2025-01-04",
    ]);
    expect(dayKeyRange("2025-01-02", "2025-01-02")).toEqual(["2025-01-02"]);
    expect(dayKeyRange("2025-01-04", "2025-01-01")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pure folds — grouped rows → per-day rollups
// ---------------------------------------------------------------------------

describe("foldLedgerDailyRows", () => {
  it("sums per day/kind and nets each day (§14.2 kinds)", () => {
    const byDay = foldLedgerDailyRows([
      { day: "2025-01-01", kind: "grant", deltaSum: 30 },
      { day: "2025-01-01", kind: "reserve", deltaSum: -5 },
      { day: "2025-01-01", kind: "commit", deltaSum: 2 }, // A−charge backflow
      { day: "2025-01-01", kind: "refund", deltaSum: 3 },
      { day: "2025-01-02", kind: "pack", deltaSum: 100 },
      { day: "2025-01-01", kind: "grant", deltaSum: 10 }, // second grant, same bucket
    ]);
    const day1 = byDay.get("2025-01-01");
    expect(day1?.grant).toBe(40);
    expect(day1?.reserve).toBe(-5);
    expect(day1?.commit).toBe(2);
    expect(day1?.refund).toBe(3);
    expect(day1?.pack).toBe(0);
    expect(day1?.net).toBe(40);
    const day2 = byDay.get("2025-01-02");
    expect(day2?.pack).toBe(100);
    expect(day2?.net).toBe(100);
  });
});

describe("foldRunDailyRows", () => {
  it("counts by status/tier and sums cost/tokens per day", () => {
    const byDay = foldRunDailyRows([
      {
        day: "2025-01-01",
        status: "succeeded",
        tier: "standard",
        runCount: 2,
        costMicroUsd: 10,
        tokensIn: 100,
        tokensOut: 200,
      },
      {
        day: "2025-01-01",
        status: "failed",
        tier: "quick",
        runCount: 1,
        costMicroUsd: 5,
        tokensIn: 10,
        tokensOut: 20,
      },
      {
        day: "2025-01-02",
        status: "succeeded",
        tier: "standard",
        runCount: 3,
        costMicroUsd: 30,
        tokensIn: 300,
        tokensOut: 600,
      },
    ]);
    const day1 = byDay.get("2025-01-01");
    expect(day1?.runs).toBe(3);
    expect(day1?.runsByStatus).toEqual({ succeeded: 2, failed: 1 });
    expect(day1?.runsByTier).toEqual({ standard: 2, quick: 1 });
    expect(day1?.costMicroUsd).toBe(15);
    expect(day1?.tokensIn).toBe(110);
    expect(day1?.tokensOut).toBe(220);
    const day2 = byDay.get("2025-01-02");
    expect(day2?.runs).toBe(3);
    const empty = emptyRunDayStats("2025-01-03");
    expect(empty.runs).toBe(0);
    expect(empty.runsByStatus).toEqual({});
    expect(empty.costMicroUsd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// dailyUsage / runStats services (over the fake query seam)
// ---------------------------------------------------------------------------

describe("dailyUsage (service)", () => {
  it("zero-fills every day ascending and buckets at the UTC edges", async () => {
    const usage = new FakeUsageQueries();
    usage.seedLedger({
      organizationId: ORG_A,
      at: new Date("2025-07-01T23:59:59.999Z"),
      kind: "grant",
      delta: 30,
    });
    usage.seedLedger({
      organizationId: ORG_A,
      at: new Date("2025-07-02T00:00:00.000Z"),
      kind: "reserve",
      delta: -2,
    });
    // §15.1 tenant guard: another org's money is invisible.
    usage.seedLedger({
      organizationId: ORG_B,
      at: new Date("2025-07-01T12:00:00.000Z"),
      kind: "grant",
      delta: 500,
    });

    const result = await dailyUsage(usage, {
      organizationId: ORG_A,
      from: "2025-07-01",
      to: "2025-07-03",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.map((day) => day.day)).toEqual([
      "2025-07-01",
      "2025-07-02",
      "2025-07-03",
    ]);
    expect(result.value[0]?.credits.grant).toBe(30); // 23:59:59.999Z → its own day
    expect(result.value[0]?.credits.net).toBe(30);
    expect(result.value[1]?.credits.reserve).toBe(-2); // 00:00:00.000Z → next day
    expect(result.value[1]?.credits.net).toBe(-2);
    expect(result.value[2]?.credits.net).toBe(0); // zero-filled
  });

  it("rejects malformed windows with validation_failed (table)", async () => {
    const usage = new FakeUsageQueries();
    const table: readonly {
      readonly from: string;
      readonly to: string;
      readonly organizationId?: string;
    }[] = [
      { from: "2025-07-03", to: "2025-07-01" }, // reversed
      { from: "2025-13-01", to: "2025-07-01" }, // impossible month
      { from: "2025-02-30", to: "2025-03-01" }, // not a calendar day
      { from: "2024-01-01", to: addDays("2024-01-01", USAGE_MAX_DAYS + 1) }, // too wide
      { from: "2024-01-01", to: "2024-01-01", organizationId: "" }, // no tenant
    ];
    for (const row of table) {
      const result = await dailyUsage(usage, {
        organizationId: row.organizationId ?? ORG_A,
        from: row.from,
        to: row.to,
      });
      expect(isFailure(result)).toBe(true);
      if (isFailure(result)) {
        expect(result.code).toBe("validation_failed");
      }
    }
  });
});

describe("runStats (service)", () => {
  it("aggregates by day/status/tier, zero-fills, and totals the window", async () => {
    const usage = new FakeUsageQueries();
    usage.seedRun({
      organizationId: ORG_A,
      at: new Date("2025-07-01T10:00:00.000Z"),
      status: "succeeded",
      tier: "standard",
      costMicroUsd: 56_000,
      tokensIn: 1000,
      tokensOut: 2000,
    });
    usage.seedRun({
      organizationId: ORG_A,
      at: new Date("2025-07-01T18:00:00.000Z"),
      status: "failed",
      tier: "quick",
      costMicroUsd: 5_000,
      tokensIn: 100,
      tokensOut: 200,
    });
    usage.seedRun({
      organizationId: ORG_A,
      at: new Date("2025-07-02T00:00:00.000Z"),
      status: "succeeded",
      tier: "standard",
      costMicroUsd: 60_000,
      tokensIn: 1200,
      tokensOut: 2400,
    });
    usage.seedRun({
      organizationId: ORG_B,
      at: new Date("2025-07-01T12:00:00.000Z"),
      status: "succeeded",
      tier: "max",
      costMicroUsd: 999_999,
      tokensIn: 99_999,
      tokensOut: 99_999,
    });

    const result = await runStats(usage, {
      organizationId: ORG_A,
      from: "2025-07-01",
      to: "2025-07-03",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.days).toHaveLength(3);
    const day1 = result.value.days[0];
    expect(day1?.runs).toBe(2);
    expect(day1?.runsByStatus).toEqual({ succeeded: 1, failed: 1 });
    expect(day1?.runsByTier).toEqual({ standard: 1, quick: 1 });
    expect(day1?.costMicroUsd).toBe(61_000);
    const day3 = result.value.days[2];
    expect(day3?.runs).toBe(0); // zero-filled
    expect(result.value.totals).toEqual({
      runs: 3,
      costMicroUsd: 121_000,
      tokensIn: 2300,
      tokensOut: 4600,
    });
  });
});

// ---------------------------------------------------------------------------
// GET /v1/credits — balance + ledger page
// ---------------------------------------------------------------------------

describe("GET /v1/credits", () => {
  it("serves the derived balance with the newest-first page and no internals", async () => {
    const harness = makeHarness();
    harness.ledger.seed({
      organizationId: ORG_A,
      kind: "grant",
      delta: 30,
      createdAt: new Date(T0),
    });
    harness.ledger.seed({
      organizationId: ORG_A,
      kind: "reserve",
      delta: -2,
      createdAt: new Date(T0 + 1000),
    });
    harness.ledger.seed({
      organizationId: ORG_A,
      kind: "refund",
      delta: 2,
      createdAt: new Date(T0 + 2000),
    });
    harness.ledger.seed({
      organizationId: ORG_B,
      kind: "grant",
      delta: 500,
      createdAt: new Date(T0 + 3000),
    });

    const body = await creditsBody(await get(harness, "/v1/credits"));

    // §12.2 SUM SANITY: balance ≡ Σ of the org's ledger deltas.
    expect(body.balance).toBe(30);
    expect(body.ledger.rows).toHaveLength(3);
    expect(body.ledger.rows.map((row) => row.kind)).toEqual(["refund", "reserve", "grant"]);
    // The audit pairing: the NEWEST row's balance_after equals the balance.
    expect(body.ledger.rows[0]?.balance_after).toBe(30);
    // §13.3: internal fields (idempotency keys, org ids) never leave the box.
    const first = body.ledger.rows[0] as Record<string, unknown>;
    expect("idempotency_key" in first).toBe(false);
    expect("organization_id" in first).toBe(false);
    expect(body.ledger.next_cursor).toBeUndefined();
  });

  it("derives the balance from the ledger rows (table)", async () => {
    // §14.2 one-append-per-phase nets: reserve −A + commit (A−charge) = −charge.
    const TABLE: readonly {
      readonly rows: readonly { readonly kind: CreditLedgerKind; readonly delta: number }[];
      readonly expected: number;
    }[] = [
      { rows: [], expected: 0 },
      { rows: [{ kind: "grant", delta: 30 }], expected: 30 }, // §1.4 trial grant
      {
        rows: [
          { kind: "grant", delta: 30 },
          { kind: "reserve", delta: -5 },
          { kind: "commit", delta: 2 },
        ],
        expected: 27, // charged 3: net −3 after the settle backflow
      },
      {
        rows: [
          { kind: "grant", delta: 100 },
          { kind: "pack", delta: 100 },
          { kind: "adjustment", delta: -50 },
          { kind: "reserve", delta: -2 },
          { kind: "refund", delta: 2 }, // released in full, §14.2 rule 3
        ],
        expected: 150,
      },
    ];
    for (const entry of TABLE) {
      const harness = makeHarness();
      entry.rows.forEach((row, index) => {
        harness.ledger.seed({
          organizationId: ORG_A,
          kind: row.kind,
          delta: row.delta,
          createdAt: new Date(T0 + index * 1000),
        });
      });
      const body = await creditsBody(await get(harness, "/v1/credits"));
      expect(body.balance).toBe(entry.expected);
    }
  });

  it("cursor-pages newest-first with a strict descending order", async () => {
    const harness = makeHarness();
    seedLedgerSeries(harness.ledger, ORG_A, 5); // rows at T0..T0+4s
    // A foreign-org decoy with a distinctive delta: it must NEVER appear.
    harness.ledger.seed({
      organizationId: ORG_B,
      kind: "adjustment",
      delta: -999,
      createdAt: new Date(T0 - 1000),
    });

    // Page 1 (limit 2): the two newest rows.
    const page1 = await creditsBody(await get(harness, "/v1/credits?limit=2"));
    expect(page1.ledger.rows.map((row) => row.created_at)).toEqual([
      new Date(T0 + 4000).toISOString(),
      new Date(T0 + 3000).toISOString(),
    ]);
    expect(page1.ledger.next_cursor).toBeDefined();

    // Page 2: strictly older than the page-1 anchor.
    const page2 = await creditsBody(
      await get(harness, `/v1/credits?limit=2&cursor=${page1.ledger.next_cursor ?? ""}`),
    );
    expect(page2.ledger.rows.map((row) => row.created_at)).toEqual([
      new Date(T0 + 2000).toISOString(),
      new Date(T0 + 1000).toISOString(),
    ]);
    expect(page2.ledger.next_cursor).toBeDefined();

    // Page 3: the last row, no further cursor.
    const page3 = await creditsBody(
      await get(harness, `/v1/credits?limit=2&cursor=${page2.ledger.next_cursor ?? ""}`),
    );
    expect(page3.ledger.rows.map((row) => row.created_at)).toEqual([
      new Date(T0).toISOString(),
    ]);
    expect(page3.ledger.next_cursor).toBeUndefined();

    // Cross-page ordering never ascends and no row repeats.
    const all = [...page1.ledger.rows, ...page2.ledger.rows, ...page3.ledger.rows];
    expect(new Set(all.map((row) => row.id)).size).toBe(5);
    for (let i = 1; i < all.length; i += 1) {
      const previous = all[i - 1];
      const current = all[i];
      expect(previous && current && previous.created_at >= current.created_at).toBe(true);
    }
    // The org B decoy never appears.
    expect(all.some((row) => row.delta === -999)).toBe(false);
  });

  it("breaks created_at ties by id, descending", async () => {
    const harness = makeHarness();
    const sameInstant = new Date(T0);
    harness.ledger.seed({
      organizationId: ORG_A,
      kind: "adjustment",
      delta: -1,
      createdAt: sameInstant,
      id: "row-aaa",
    });
    harness.ledger.seed({
      organizationId: ORG_A,
      kind: "adjustment",
      delta: -1,
      createdAt: sameInstant,
      id: "row-bbb",
    });

    const body = await creditsBody(await get(harness, "/v1/credits?limit=2"));
    expect(body.ledger.rows.map((row) => row.id)).toEqual(["row-bbb", "row-aaa"]);
  });

  it("rejects malformed cursors and limits with 422 envelopes", async () => {
    const harness = makeHarness();
    for (const query of ["cursor=%%%not-base64", "limit=0", "limit=101", "limit=abc"]) {
      const res = await get(harness, `/v1/credits?${query}`);
      expect(res.status).toBe(422);
      const body = await errorBody(res);
      expect(body.code).toBe("validation_failed");
      expect(body.ok).toBe(false);
    }
  });

  it("guards the tenant boundary and requires auth (§15.1)", async () => {
    const harness = makeHarness();
    seedLedgerSeries(harness.ledger, ORG_A, 2);
    harness.ledger.seed({
      organizationId: ORG_B,
      kind: "grant",
      delta: 7,
      createdAt: new Date(T0),
    });

    // No credentials → 401, never a partial body.
    const anon = await get(harness, "/v1/credits", undefined);
    expect(anon.status).toBe(401);
    expect((await errorBody(anon)).code).toBe("unauthorized");

    // Org B sees only org B's money.
    const bodyB = await creditsBody(await get(harness, "/v1/credits", TOKEN_B));
    expect(bodyB.balance).toBe(7);
    expect(bodyB.ledger.rows).toHaveLength(1);
    expect(bodyB.ledger.rows.every((row) => row.balance_after === 7)).toBe(true);

    // Org A's balance excludes org B entirely.
    const bodyA = await creditsBody(await get(harness, "/v1/credits"));
    expect(bodyA.balance).toBe(-2); // two −1 adjustments
  });

  it("allows the viewer role (no RBAC read gate on own workspace)", async () => {
    const harness = makeHarness();
    harness.ledger.seed({
      organizationId: ORG_A,
      kind: "grant",
      delta: 30,
      createdAt: new Date(T0),
    });
    const body = await creditsBody(await get(harness, "/v1/credits", TOKEN_VIEWER));
    expect(body.balance).toBe(30);
  });

  it("rate-limits per workspace and stays scoped (429 + headers)", async () => {
    const harness = makeHarness(TIGHT_LIMITS);
    const first = await get(harness, "/v1/credits");
    expect(first.status).toBe(200);
    expect(first.headers.get("x-ratelimit-limit")).toBe("2");
    expect(first.headers.get("x-ratelimit-remaining")).toBe("1");

    const second = await get(harness, "/v1/credits");
    expect(second.status).toBe(200);

    // Third request from the SAME workspace: 429 with Retry-After.
    const third = await get(harness, "/v1/credits");
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("30");
    expect(third.headers.get("x-ratelimit-remaining")).toBe("0");
    const denied = await errorBody(third);
    expect(denied.code).toBe("rate_limited");
    expect(denied.retryable).toBe(true);

    // The summary shares the credits scope → also denied.
    const summaryRes = await get(harness, "/v1/credits/summary");
    expect(summaryRes.status).toBe(429);

    // A different workspace has its own bucket — not punished.
    const otherOrg = await get(harness, "/v1/credits", TOKEN_B);
    expect(otherOrg.status).toBe(200);

    // Usage is a separate scope — still allowed.
    const usage = await get(harness, "/v1/usage");
    expect(usage.status).toBe(200);
  });

  it("answers a typed 500 when mounted without the injector (wiring bug)", async () => {
    const app = buildApp({
      env: gatewayTransportSchema.parse({}),
      logger: pino({ enabled: false }),
      version: "0.0.0-test",
      probes: [],
      startedAt: FROZEN_MS,
      mount: (root) => {
        root.route("/v1/credits", creditRoutes);
      },
    });
    const res = await app.request("/v1/credits", {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(res.status).toBe(500);
    const body = await errorBody(res);
    expect(body.code).toBe("internal_error");
  });
});

// ---------------------------------------------------------------------------
// GET /v1/credits/summary — 30d spend, open holds, trial flag
// ---------------------------------------------------------------------------

describe("GET /v1/credits/summary", () => {
  it("returns the composite card with a 30-day window anchored at the injected clock", async () => {
    const harness = makeHarness();
    harness.summary.next = { spendCredits: 42, openHolds: 1, trial: true };

    const res = await get(harness, "/v1/credits/summary");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      readonly window_days: number;
      readonly spend_credits: number;
      readonly open_holds: number;
      readonly trial: boolean;
    };
    expect(body).toEqual({
      window_days: SUMMARY_WINDOW_DAYS,
      spend_credits: 42,
      open_holds: 1,
      trial: true,
    });

    // The window anchor: since = now − 30d, computed from the frozen clock.
    expect(harness.summary.calls).toHaveLength(1);
    const call = harness.summary.calls[0];
    expect(call?.organizationId).toBe(ORG_A);
    expect(call?.since.getTime()).toBe(FROZEN_MS - SUMMARY_WINDOW_DAYS * 86_400_000);
  });

  it("scopes the summary to the caller's workspace", async () => {
    const harness = makeHarness();
    await get(harness, "/v1/credits/summary", TOKEN_B);
    expect(harness.summary.calls[0]?.organizationId).toBe(ORG_B);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/usage — daily rollups (§13.1 / §22)
// ---------------------------------------------------------------------------

describe("GET /v1/usage", () => {
  it("defaults to the last 30 UTC days ending today, zero-filled", async () => {
    const harness = makeHarness();
    const res = await get(harness, "/v1/usage");
    expect(res.status).toBe(200);
    const body = (await res.json()) as UsageApiView;
    expect(body.from).toBe("2023-10-16");
    expect(body.to).toBe(FROZEN_DAY);
    expect(body.days).toHaveLength(30);
    expect(body.days[0]?.day).toBe("2023-10-16");
    expect(body.days.at(-1)?.day).toBe(FROZEN_DAY);
    const first = body.days[0];
    expect(first?.credits).toEqual({
      grant: 0,
      pack: 0,
      reserve: 0,
      commit: 0,
      refund: 0,
      adjustment: 0,
      net: 0,
    });
    expect(first?.runs).toEqual({
      count: 0,
      by_status: {},
      by_tier: {},
      cost_micro_usd: 0,
      tokens_in: 0,
      tokens_out: 0,
    });
    expect(body.totals).toEqual({ runs: 0, cost_micro_usd: 0, tokens_in: 0, tokens_out: 0 });
  });

  it("rolls up ledger + run days at the UTC bucket edges, snake_case wire", async () => {
    const harness = makeHarness();
    harness.usage.seedLedger({
      organizationId: ORG_A,
      at: new Date("2025-07-01T23:59:59.999Z"),
      kind: "grant",
      delta: 30,
    });
    harness.usage.seedLedger({
      organizationId: ORG_A,
      at: new Date("2025-07-02T00:00:00.000Z"),
      kind: "reserve",
      delta: -2,
    });
    harness.usage.seedLedger({
      organizationId: ORG_B,
      at: new Date("2025-07-01T12:00:00.000Z"),
      kind: "grant",
      delta: 500,
    });
    harness.usage.seedRun({
      organizationId: ORG_A,
      at: new Date("2025-07-01T10:00:00.000Z"),
      status: "succeeded",
      tier: "standard",
      costMicroUsd: 56_000,
      tokensIn: 1000,
      tokensOut: 2000,
    });
    harness.usage.seedRun({
      organizationId: ORG_A,
      at: new Date("2025-07-02T00:00:00.000Z"),
      status: "failed",
      tier: "quick",
      costMicroUsd: 5_000,
      tokensIn: 100,
      tokensOut: 200,
    });
    harness.usage.seedRun({
      organizationId: ORG_B,
      at: new Date("2025-07-01T12:00:00.000Z"),
      status: "succeeded",
      tier: "max",
      costMicroUsd: 999_999,
    });

    const res = await get(harness, "/v1/usage?from=2025-07-01&to=2025-07-02");
    expect(res.status).toBe(200);
    const body = (await res.json()) as UsageApiView;
    expect(body.from).toBe("2025-07-01");
    expect(body.to).toBe("2025-07-02");
    expect(body.days).toHaveLength(2);

    const day1 = body.days[0];
    expect(day1?.day).toBe("2025-07-01");
    expect(day1?.credits.grant).toBe(30); // last ms of Jul 1 stays in Jul 1
    expect(day1?.credits.net).toBe(30);
    expect(day1?.runs).toEqual({
      count: 1,
      by_status: { succeeded: 1 },
      by_tier: { standard: 1 },
      cost_micro_usd: 56_000,
      tokens_in: 1000,
      tokens_out: 2000,
    });

    const day2 = body.days[1];
    expect(day2?.day).toBe("2025-07-02");
    expect(day2?.credits.reserve).toBe(-2); // first ms of Jul 2 starts Jul 2
    expect(day2?.credits.net).toBe(-2);
    expect(day2?.runs.by_status).toEqual({ failed: 1 });

    // Org B's ledger/run rows never reach org A's rollup or totals.
    expect(body.totals).toEqual({
      runs: 2,
      cost_micro_usd: 61_000,
      tokens_in: 1100,
      tokens_out: 2200,
    });
  });

  it("validates the window with 422 envelopes (table)", async () => {
    const harness = makeHarness();
    const cases: readonly { readonly query: string; readonly why: string }[] = [
      { query: "from=2025-07-03&to=2025-07-01", why: "reversed window" },
      { query: "from=2025-02-30&to=2025-03-01", why: "not a calendar day" },
      { query: "from=2025-1-1&to=2025-03-01", why: "not zero-padded" },
      { query: "from=2024-01-01&to=2025-12-31", why: "wider than the cap" },
      { query: "from=yesterday&to=2025-03-01", why: "not a date" },
    ];
    for (const testCase of cases) {
      const res = await get(harness, `/v1/usage?${testCase.query}`);
      expect(res.status).toBe(422);
      const body = await errorBody(res);
      expect(body.code).toBe("validation_failed");
    }
  });

  it("accepts the exact 366-day cap boundary but not one more", async () => {
    const harness = makeHarness();
    const to = addDays("2024-01-01", USAGE_MAX_DAYS - 1); // 366 days inclusive
    const okRes = await get(harness, `/v1/usage?from=2024-01-01&to=${to}`);
    expect(okRes.status).toBe(200);
    const okBody = (await okRes.json()) as UsageApiView;
    expect(okBody.days).toHaveLength(USAGE_MAX_DAYS);

    const tooWide = await get(
      harness,
      `/v1/usage?from=2024-01-01&to=${addDays("2024-01-01", USAGE_MAX_DAYS)}`,
    );
    expect(tooWide.status).toBe(422);
  });

  it("guards the tenant boundary and requires auth", async () => {
    const harness = makeHarness();
    harness.usage.seedLedger({
      organizationId: ORG_A,
      at: new Date("2025-07-01T12:00:00.000Z"),
      kind: "grant",
      delta: 30,
    });
    harness.usage.seedLedger({
      organizationId: ORG_B,
      at: new Date("2025-07-01T12:00:00.000Z"),
      kind: "grant",
      delta: 500,
    });

    const anon = await get(harness, "/v1/usage", undefined);
    expect(anon.status).toBe(401);

    const resA = await get(harness, "/v1/usage?from=2025-07-01&to=2025-07-01");
    const bodyA = (await resA.json()) as UsageApiView;
    expect(bodyA.days[0]?.credits.grant).toBe(30);
    const resB = await get(harness, "/v1/usage?from=2025-07-01&to=2025-07-01", TOKEN_B);
    const bodyB = (await resB.json()) as UsageApiView;
    expect(bodyB.days[0]?.credits.grant).toBe(500);
  });

  it("rate-limits usage reads on their own scope", async () => {
    const harness = makeHarness(TIGHT_LIMITS);
    expect((await get(harness, "/v1/usage")).status).toBe(200);
    expect((await get(harness, "/v1/usage")).status).toBe(200);
    const third = await get(harness, "/v1/usage");
    expect(third.status).toBe(429);
    expect((await errorBody(third)).code).toBe("rate_limited");
    // The credits scope is untouched by usage traffic.
    expect((await get(harness, "/v1/credits")).status).toBe(200);
  });
});
