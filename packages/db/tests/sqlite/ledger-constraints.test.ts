import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, getDialect } from "../../src/db.js";
import { createId } from "../../src/ids.js";
import { tablesFor } from "../../src/tables.js";

/**
 * BIL-07 (2026-10-30 audit): DB-level money invariants on `credit_ledger`.
 * Pre-fix the money table had NO CHECK constraints — a buggy writer could
 * mint a negative grant, a positive reserve, or an out-of-vocabulary kind and
 * the database would accept it silently. The pg migration 0009 + the sqlite
 * twin bootstrap enforce:
 *  - kind ∈ {grant, reserve, commit, refund, adjust}
 *  - grant > 0, refund > 0, reserve < 0, commit <= 0, adjust ± (staff true-ups)
 *  - |amount| <= 1e15 µc (the SEC-10 in-code ceiling, now also structural)
 *
 * balance_after is deliberately NOT floored at 0 — uncapped settles may drive
 * balances negative (BIL-08 product posture); a floor would 500 that path.
 *
 * Runs on the sqlite twin (the dev-server.test.ts recipe): raw drizzle
 * inserts bypass every repo-level validation, so ONLY the CHECK can refuse.
 */
describe("sqlite credit_ledger CHECK constraints (BIL-07)", { timeout: 30_000 }, () => {
  let db: ReturnType<typeof createDb>;
  let workspaceId: string;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "studio-bil07-"));
    db = createDb(`file:${join(tmpDir, "bil07.test.db")}`);
    expect(getDialect(db)).toBe("sqlite");

    const t = tablesFor(db);
    workspaceId = `ws_${randomUUID().slice(0, 8)}`;
    const userId = `usr_${randomUUID().slice(0, 8)}`;
    await db
      .insert(t.user)
      .values({
        id: userId,
        name: "BIL-07",
        email: `${userId}@studio.test`,
        emailVerified: true,
      })
      .onConflictDoNothing();
    await db
      .insert(t.organization)
      .values({ id: workspaceId, name: "BIL-07 WS", slug: workspaceId })
      .onConflictDoNothing();
  });

  afterAll(() => {
    (db.$client as unknown as { close: () => void }).close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * A raw ledger row insert — no repo validation, only the CHECKs judge.
   * `kind` arrives as a plain string DELIBERATELY: this helper exists to push
   * out-of-vocabulary kinds through, so the column's $type union is asserted
   * past (the CHECK, not the type system, is the thing under test).
   */
  async function rawEntry(overrides: {
    kind: string;
    amount: number;
    idempotencyKey: string;
  }): Promise<unknown> {
    const t = tablesFor(db);
    type LedgerInsert = typeof t.creditLedger.$inferInsert;
    const row: LedgerInsert = {
      id: createId("led"),
      workspaceId,
      kind: overrides.kind as LedgerInsert["kind"],
      amount: overrides.amount,
      balanceAfter: 0,
      idempotencyKey: overrides.idempotencyKey,
    };
    return db.insert(t.creditLedger).values(row);
  }

  it("accepts every LEGAL writer shape (grant/reserve/commit/refund/adjust)", async () => {
    await expect(
      rawEntry({ kind: "grant", amount: 50_000_000, idempotencyKey: "bil07-grant" }),
    ).resolves.toBeTruthy();
    await expect(
      rawEntry({ kind: "reserve", amount: -15_000_000, idempotencyKey: "bil07-reserve" }),
    ).resolves.toBeTruthy();
    await expect(
      rawEntry({ kind: "commit", amount: -12_000_000, idempotencyKey: "bil07-commit" }),
    ).resolves.toBeTruthy();
    await expect(
      rawEntry({ kind: "commit", amount: 0, idempotencyKey: "bil07-commit-zero" }),
    ).resolves.toBeTruthy(); // a zero-cost settle is legal
    await expect(
      rawEntry({ kind: "refund", amount: 3_000_000, idempotencyKey: "bil07-refund" }),
    ).resolves.toBeTruthy();
    await expect(
      rawEntry({ kind: "adjust", amount: -1_000_000, idempotencyKey: "bil07-adjust-neg" }),
    ).resolves.toBeTruthy();
    await expect(
      rawEntry({ kind: "adjust", amount: 1_000_000, idempotencyKey: "bil07-adjust-pos" }),
    ).resolves.toBeTruthy();
  });

  it("refuses a NEGATIVE grant (the money-printing direction)", async () => {
    await expect(
      rawEntry({ kind: "grant", amount: -500, idempotencyKey: "bil07-neg-grant" }),
    ).rejects.toThrow();
  });

  it("refuses a POSITIVE reserve (a hold that adds credits)", async () => {
    await expect(
      rawEntry({ kind: "reserve", amount: 500, idempotencyKey: "bil07-pos-reserve" }),
    ).rejects.toThrow();
  });

  it("refuses a NEGATIVE refund", async () => {
    await expect(
      rawEntry({ kind: "refund", amount: -500, idempotencyKey: "bil07-neg-refund" }),
    ).rejects.toThrow();
  });

  it("refuses a POSITIVE commit (a settle that mints credits)", async () => {
    await expect(
      rawEntry({ kind: "commit", amount: 500, idempotencyKey: "bil07-pos-commit" }),
    ).rejects.toThrow();
  });

  it("refuses out-of-vocabulary kinds", async () => {
    await expect(
      rawEntry({ kind: "mint", amount: 500, idempotencyKey: "bil07-kind-mint" }),
    ).rejects.toThrow();
    await expect(
      rawEntry({ kind: "steal", amount: -500, idempotencyKey: "bil07-kind-steal" }),
    ).rejects.toThrow();
  });

  it("refuses amounts beyond the 1e15 µc ceiling (SEC-10, now structural)", async () => {
    await expect(
      rawEntry({ kind: "grant", amount: 1_000_000_000_000_001, idempotencyKey: "bil07-over" }),
    ).rejects.toThrow();
    await expect(
      rawEntry({ kind: "adjust", amount: -1_000_000_000_000_001, idempotencyKey: "bil07-under" }),
    ).rejects.toThrow();
  });
});
