import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type StudioDb, createDb } from "../../src/db.js";
import { DbError } from "../../src/errors-lite.js";
import { migrateDatabase } from "../../src/migrate.js";
import { type Repos, createRepos } from "../../src/repos/index.js";
import * as schema from "../../src/schema.js";

/**
 * Integration — ledger int64 range guard (M6-E; M6-A HIGH finding pin).
 * Requires a real Postgres: `DATABASE_URL=postgres://… pnpm --filter @studio/db test`.
 * Skipped (not failed) when DATABASE_URL is not a postgres URL.
 *
 * Before migration 0003, `credit_ledger.amount`/`balance_after` were PG
 * `integer` (int32 max 2_147_483_647). A Studio plan monthly allowance of
 * 10,000 credits is 10_000_000_000 µc under D-12 — ~4.7× the int32 ceiling —
 * so a single Studio monthly-grant row overflowed. These tests prove the
 * Studio-scale values now round-trip through the real DB with EXACT integer
 * arithmetic (JS numbers are exact integers ≤ 2^53 — µc balances stay far
 * below), and pin the wrapped-23505 recognition in runs.addStep (M6-D finding:
 * drizzle wraps the postgres.js PostgresError in its own `.cause` chain).
 *
 * Each test uses its own workspace so the pins stay independent.
 */
const pgUrl = process.env.DATABASE_URL ?? "";
const hasDb = /^postgres(ql)?:/.test(pgUrl);

const STUDIO_GRANT_MC = 10_000_000_000; // Studio monthly allowance (10,000 credits in D-12 µc)
const INT32_MAX = 2_147_483_647;

describe.skipIf(!hasDb)("ledger bigint range guard (integration)", { timeout: 30_000 }, () => {
  let db: StudioDb;
  let repos: Repos;
  const userId = `usr_test_${randomUUID().slice(0, 8)}`;

  /** Fresh isolated workspace per test — exact-arithmetic pins don't cascade. */
  async function newWorkspace(): Promise<string> {
    const id = `ws_test_${randomUUID().slice(0, 8)}`;
    await db
      .insert(schema.organization)
      .values({ id, name: "Range", slug: id })
      .onConflictDoNothing();
    return id;
  }

  beforeAll(async () => {
    const url = process.env.DATABASE_URL as string;
    db = createDb(url);
    await migrateDatabase(db);
    repos = createRepos(db);
    await db
      .insert(schema.user)
      .values({ id: userId, name: "T", email: `${userId}@studio.test`, emailVerified: true })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
  });

  it("Studio-scale monthly grant survives int32: insert, read back, balance, replay", async () => {
    const ws = await newWorkspace();
    // A value this large could never be stored pre-0003: it exceeds int32 by ~4.7×.
    expect(STUDIO_GRANT_MC).toBeGreaterThan(INT32_MAX);
    expect(Number.isSafeInteger(STUDIO_GRANT_MC)).toBe(true);

    const key = `m6e_${randomUUID().slice(0, 8)}:grant`;
    const granted = await repos.ledger.grant(ws, {
      amount: STUDIO_GRANT_MC,
      idempotencyKey: key,
      metadata: { plan: "studio", source: "monthly-allowance" },
    });
    expect(granted.replayed).toBe(false);
    expect(granted.entry.amount).toBe(STUDIO_GRANT_MC);
    expect(granted.entry.balanceAfter).toBe(STUDIO_GRANT_MC);

    // read back — exact int64 → number, no precision loss, no overflow
    expect(await repos.ledger.balance(ws)).toBe(STUDIO_GRANT_MC);

    const reread = await repos.ledger.getEntryByIdempotencyKey(ws, key);
    expect(reread?.amount).toBe(STUDIO_GRANT_MC);
    expect(reread?.balanceAfter).toBe(STUDIO_GRANT_MC);
    expect(reread?.kind).toBe("grant");

    const page = await repos.ledger.list(ws, { limit: 10 });
    const row = page.items.find((e) => e.idempotencyKey === key);
    expect(row?.amount).toBe(STUDIO_GRANT_MC);

    // idempotent replay never double-charges (law #4)
    const replay = await repos.ledger.grant(ws, {
      amount: STUDIO_GRANT_MC,
      idempotencyKey: key,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.entry.id).toBe(granted.entry.id);
    expect(await repos.ledger.balance(ws)).toBe(STUDIO_GRANT_MC);
  });

  it("reserve → settle cycle at Studio scale: exact arithmetic, D-20 full-hold release", async () => {
    const ws = await newWorkspace();
    const runId = `run_m6e_${randomUUID().slice(0, 8)}`;
    await repos.ledger.grant(ws, {
      amount: STUDIO_GRANT_MC,
      idempotencyKey: `${runId}:grant`,
    });

    // reserve = estimated × 1.2 (§8.8): 4_000_000_000 µc estimated → 4_800_000_000 held
    const hold = 4_800_000_000;
    const actualCost = 4_000_000_000;

    const reserve = await repos.ledger.reserve(ws, {
      runId,
      amount: hold,
      idempotencyKey: `${runId}:reserve`,
    });
    expect(reserve.entry.amount).toBe(-hold);
    expect(reserve.entry.balanceAfter).toBe(STUDIO_GRANT_MC - hold); // 5_200_000_000 — still > int32
    expect(await repos.ledger.balance(ws)).toBe(STUDIO_GRANT_MC - hold);

    const settled = await repos.ledger.settle(ws, {
      runId,
      actualCost,
      idempotencyKey: `${runId}:settle`,
    });
    // D-20: the FULL hold is released on top of the commit — run nets exactly −M
    expect(settled.replayed).toBe(false);
    expect(settled.commit?.amount).toBe(-actualCost);
    expect(settled.refund?.amount).toBe(hold);

    const expectedBalance = STUDIO_GRANT_MC - actualCost; // 6_000_000_000
    expect(await repos.ledger.balance(ws)).toBe(expectedBalance);
    expect(settled.refund?.balanceAfter).toBe(expectedBalance);

    // the run's hold is fully released — nothing left to refund
    const after = await repos.ledger.refundAll(ws, {
      runId,
      idempotencyKey: `${runId}:refund-all`,
    });
    expect(after.refunded).toBe(0);
    expect(await repos.ledger.balance(ws)).toBe(expectedBalance);

    // settle replay is a no-op (law #4)
    const replayed = await repos.ledger.settle(ws, {
      runId,
      actualCost,
      idempotencyKey: `${runId}:settle`,
    });
    expect(replayed.replayed).toBe(true);
    expect(await repos.ledger.balance(ws)).toBe(expectedBalance);
  });

  it("adjust at Studio scale stays exact; insufficient-credits sees the true bigint balance", async () => {
    const ws = await newWorkspace();
    await repos.ledger.grant(ws, {
      amount: STUDIO_GRANT_MC,
      idempotencyKey: `m6e_${randomUUID().slice(0, 8)}:grant`,
    });

    const corrected = await repos.ledger.adjust(ws, {
      amount: -(STUDIO_GRANT_MC - 1), // clawback down to 1 µc
      idempotencyKey: `m6e_${randomUUID().slice(0, 8)}:adjust`,
    });
    expect(corrected.entry.amount).toBe(-(STUDIO_GRANT_MC - 1));
    expect(corrected.entry.balanceAfter).toBe(1);
    expect(await repos.ledger.balance(ws)).toBe(1);

    // a reserve larger than the 1 µc balance is a typed INSUFFICIENT_CREDITS
    // carrying the exact bigint numbers (no int32 wrap in `available`)
    await expect(
      repos.ledger.reserve(ws, {
        runId: `run_m6e_${randomUUID().slice(0, 8)}`,
        amount: INT32_MAX + 1, // int32 max + 1 µc
        idempotencyKey: `m6e_${randomUUID().slice(0, 8)}:reserve-too-big`,
      }),
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_CREDITS",
      details: { required: INT32_MAX + 1, available: 1 },
    });
  });

  it("runs.addStep duplicate seq is a typed CONFLICT through drizzle's wrapped 23505 (M6-D)", async () => {
    const ws = await newWorkspace();
    const project = await repos.projects.create(ws, { name: "Wrapped", createdBy: userId });
    const thread = await repos.threads.create(ws, {
      projectId: project.id,
      createdBy: userId,
    });
    const run = await repos.runs.create(ws, {
      threadId: thread.id,
      projectId: project.id,
      model: "fast",
    });
    await repos.runs.update(ws, run.id, { status: "running" });

    const first = await repos.runs.addStep(ws, {
      runId: run.id,
      seq: 0,
      tool: "engine.batch",
      status: "success",
    });
    expect(first.seq).toBe(0);

    // The REAL drizzle wrap: the duplicate insert fails with the PostgresError
    // nested in `.cause` (code 23505 on the cause, NOT on the surface error).
    // Before the fix, addStep's shallow `.code === "23505"` check missed the
    // wrap and rethrew the raw driver error; shared.ts now walks the chain.
    await expect(
      repos.runs.addStep(ws, { runId: run.id, seq: 0, tool: "engine.batch" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      repos.runs.addStep(ws, { runId: run.id, seq: 0, tool: "engine.batch" }),
    ).rejects.toBeInstanceOf(DbError);

    // Pin the wrap shape itself (mirrors the billing.test.ts 23505-via-.cause
    // precedent): a RAW duplicate insert surfaces the code only on `.cause`.
    await expect(
      db
        .insert(schema.agentSteps)
        .values({
          id: `stp_raw_${randomUUID().slice(0, 8)}`,
          runId: run.id,
          seq: 0,
          tool: "engine.batch",
        })
        .returning(),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });
});
