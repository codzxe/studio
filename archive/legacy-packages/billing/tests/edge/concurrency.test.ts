// Ledger concurrency edges (§14.2 rules 1/6, §3.4, §12.2) — the races that must
// never over-commit, double-charge, or double-settle. Pure in-memory stores,
// table-driven, deterministic, no network (AGENTS.md test rules).
//
// Spec anchors:
//   §14.2 rule 1 — reserve checks the balance; the run never starts on a shortfall
//   §14.2 rule 6 — every phase carries an idempotency key; the ledger rejects duplicates
//   §12.2        — rows are append-only; balance derives from the sum; the store
//                  wraps "check balance + append" in ONE transaction
//   §3.4         — retries never double-charge
//   ledger.ts    — "commit and refund are mutually exclusive terminals"
//
// Three race families:
//   1. parallel reserves on a thin balance (the balance-race table) — the hold
//      is itself a ledger charge, so no interleaving can hold more credits
//      than the workspace ever had: exactly min(runs, ⌊balance/amount⌋) land.
//   2. double-commit — two settlements racing for one run land exactly one
//      commit row; the twin is an idempotent replay or a loud duplicate.
//   3. commit-vs-refund — the money terminals are mutually exclusive; with both
//      settlers in flight, one wins and the loser gets a typed `conflict`
//      (§13.3 → 409) once it observes the winner's row.

import type { Failure, Result } from "@studio/config";
import { describe, expect, it } from "vitest";

import {
  type CommitOutcome,
  type CreditLedgerEntry,
  type CreditLedgerKind,
  type LedgerStore,
  commitReservation,
  releaseReservation,
  reservationStatus,
  reserveCredits,
} from "../../src/index.js";
import { InMemoryLedgerStore, seedCredits } from "../fakes.js";

const ORG = "org-race";

function expectOk<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.code}: ${result.message}`);
  }
  return result.value;
}

function expectErr<T>(result: Result<T>): Failure {
  if (result.ok) {
    throw new Error(`expected failure, got ok: ${JSON.stringify(result.value)}`);
  }
  return result;
}

function rejectionMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Services the newest parked call first, so the LAST-launched domain call runs
 * to completion before the first-launched one takes a single step — a
 * deterministic model of the serializable transaction the production store
 * runs each reserve/commit/release inside (LedgerStore doc, §12.2).
 */
class GatedLedgerStore implements LedgerStore {
  private readonly pending: Array<() => Promise<void>> = [];

  constructor(private readonly inner: LedgerStore) {}

  append(entry: CreditLedgerEntry): Promise<void> {
    return this.park(() => this.inner.append(entry));
  }

  balanceAfter(organizationId: string): Promise<number> {
    return this.park(() => this.inner.balanceAfter(organizationId));
  }

  findByIdempotency(idempotencyKey: string, kind: CreditLedgerKind): Promise<boolean> {
    return this.park(() => this.inner.findByIdempotency(idempotencyKey, kind));
  }

  async drainNewestFirst(): Promise<void> {
    while (this.pending.length > 0) {
      const op = this.pending.pop();
      if (op === undefined) {
        break;
      }
      await op();
      // Yield once so the caller's continuation parks its NEXT store call
      // before we pick again (microtask FIFO already guarantees it).
      await Promise.resolve();
    }
  }

  private park<T>(exec: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push(async () => {
        try {
          resolve(await exec());
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }
}

/**
 * A ledger fake whose append is one fully synchronous critical section: it
 * checks the mutually-exclusive-terminal invariant (ledger.ts: "commit and
 * refund are mutually exclusive terminals") in the SAME tick as the row
 * landing. The plain fake only mirrors unique (idempotency_key, kind) and the
 * non-negative balance; production gets terminal exclusivity from wrapping
 * check+append in one transaction (§12.2) — this fake models that outcome so
 * the unscripted race below can prove no interleaving double-settles.
 */
class ExclusiveTerminalLedgerStore implements LedgerStore {
  private readonly rows: CreditLedgerEntry[] = [];
  private readonly seen = new Set<string>();
  private readonly terminals = new Map<string, CreditLedgerKind>();

  append(entry: CreditLedgerEntry): Promise<void> {
    // The promise executor runs synchronously → check + land are atomic (§12.2).
    return new Promise((resolve, reject) => {
      try {
        const composite = `${entry.idempotencyKey}\u0000${entry.kind}`;
        if (this.seen.has(composite)) {
          throw new Error(
            `fake ledger: duplicate append rejected (idempotencyKey=${entry.idempotencyKey}, kind=${entry.kind})`,
          );
        }
        if (this.isTerminal(entry) && entry.runId !== undefined) {
          const landed = this.terminals.get(entry.runId);
          if (landed !== undefined) {
            throw new Error(
              `fake ledger: terminal already landed for run ${entry.runId} (${landed}); ${entry.kind} rejected`,
            );
          }
        }
        const next = this.balanceOf(entry.organizationId) + entry.delta;
        if (next < 0) {
          throw new Error(
            `fake ledger: balance invariant violated — org ${entry.organizationId} would reach ${next}`,
          );
        }
        this.seen.add(composite);
        if (this.isTerminal(entry) && entry.runId !== undefined) {
          this.terminals.set(entry.runId, entry.kind);
        }
        this.rows.push({ ...entry });
        resolve();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async balanceAfter(organizationId: string): Promise<number> {
    return this.balanceOf(organizationId);
  }

  async findByIdempotency(idempotencyKey: string, kind: CreditLedgerKind): Promise<boolean> {
    return this.seen.has(`${idempotencyKey}\u0000${kind}`);
  }

  entriesForRun(runId: string): readonly CreditLedgerEntry[] {
    return this.rows.filter((row) => row.runId === runId);
  }

  private isTerminal(entry: CreditLedgerEntry): boolean {
    return entry.kind === "commit" || entry.kind === "refund";
  }

  private balanceOf(organizationId: string): number {
    let sum = 0;
    for (const row of this.rows) {
      if (row.organizationId === organizationId) {
        sum += row.delta;
      }
    }
    return sum;
  }
}

// ---------------------------------------------------------------------------
// §14.2 rule 1 / §12.2 — parallel reserves never over-commit
// ---------------------------------------------------------------------------

interface BalanceRaceRow {
  /** Credits granted before the race. */
  readonly balance: number;
  /** The tier's base cost every concurrent run tries to hold. */
  readonly amount: number;
  /** How many runs race for the balance. */
  readonly runs: number;
  /** min(runs, ⌊balance/amount⌋) — what a correct ledger must land. */
  readonly expectedOk: number;
}

const BALANCE_RACE: BalanceRaceRow[] = [
  // THE §14.2 race from the wave task: 5 concurrent 1-credit quick runs on a
  // 3-credit balance → exactly 3 succeed, 2 lose, 0 over-commit.
  { balance: 3, amount: 1, runs: 5, expectedOk: 3 },
  { balance: 3, amount: 1, runs: 3, expectedOk: 3 }, // exact fit — nobody loses
  { balance: 3, amount: 1, runs: 2, expectedOk: 2 }, // more credits than runs
  { balance: 4, amount: 2, runs: 3, expectedOk: 2 }, // standard-tier race
  { balance: 5, amount: 2, runs: 3, expectedOk: 2 }, // leftover 1 unusable by 2s
  { balance: 6, amount: 2, runs: 3, expectedOk: 3 },
  { balance: 8, amount: 5, runs: 5, expectedOk: 1 }, // complex tier: one fits
  { balance: 9, amount: 4, runs: 4, expectedOk: 2 }, // premium tier + stranded 1
  { balance: 1, amount: 2, runs: 3, expectedOk: 0 }, // no single run fits
  { balance: 0, amount: 1, runs: 5, expectedOk: 0 }, // empty wallet
];

describe("parallel reserves never over-commit (§14.2 rule 1, §12.2)", () => {
  it.each(BALANCE_RACE)(
    "$runs concurrent × $amount-credit holds on $balance credits → exactly $expectedOk succeed",
    async (row) => {
      // Shake the scheduler: a fresh store per attempt, and every interleaving
      // must land the same money.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const store = new InMemoryLedgerStore();
        await seedCredits(store, ORG, row.balance);

        const racing = Array.from({ length: row.runs }, (_, i) =>
          reserveCredits(store, {
            organizationId: ORG,
            runId: `race-${attempt}-run-${i}`,
            amount: row.amount,
          }),
        );
        const settled = await Promise.allSettled(racing);

        let succeeded = 0;
        for (const outcome of settled) {
          if (outcome.status === "fulfilled") {
            if (outcome.value.ok) {
              succeeded += 1;
              continue;
            }
            // Serialized loser (its check ran after enough holds landed): 402.
            expect(outcome.value.code).toBe("insufficient_credits");
            continue;
          }
          // Racy loser (its check passed, its append is over the line): the
          // store's non-negative balance guard fires LOUD — never a silent ok.
          expect(rejectionMessage(outcome.reason)).toMatch(/balance invariant violated/);
        }

        // Exactly the budget's worth of holds land — never more (§12.2).
        expect(succeeded).toBe(row.expectedOk);
        const holds = store.entriesFor(ORG).filter((entry) => entry.kind === "reserve");
        expect(holds).toHaveLength(row.expectedOk);
        expect(new Set(holds.map((hold) => hold.idempotencyKey)).size).toBe(row.expectedOk);
        expect(await store.balanceAfter(ORG)).toBe(row.balance - row.expectedOk * row.amount);
        for (const hold of holds) {
          expect(hold.delta).toBe(-row.amount);
        }
      }
    },
  );

  it("the same table under one-at-a-time reserves: losers are typed 402s and append nothing", async () => {
    for (const row of BALANCE_RACE) {
      const store = new InMemoryLedgerStore();
      await seedCredits(store, ORG, row.balance);

      let succeeded = 0;
      for (let i = 0; i < row.runs; i += 1) {
        const runId = `seq-${row.balance}-${row.amount}-${i}`;
        const result = await reserveCredits(store, {
          organizationId: ORG,
          runId,
          amount: row.amount,
        });
        if (result.ok) {
          succeeded += 1;
        } else {
          expect(result.code).toBe("insufficient_credits");
          // §14.2 rule 1: the run never starts — no row for the rejected run.
          expect(store.entriesForRun(runId)).toHaveLength(0);
        }
      }
      expect(succeeded).toBe(row.expectedOk);
      // The seed grant + the holds that landed, and nothing else.
      expect(store.size()).toBe(1 + row.expectedOk);
    }
  });
});

// ---------------------------------------------------------------------------
// §14.2 rule 6 — double-commit
// ---------------------------------------------------------------------------

describe("double-commit (§14.2 rule 6: duplicates rejected; §3.4: retries never double-charge)", () => {
  const RUN = "run-twice";

  it("two concurrent commits for one run land exactly one settlement row", async () => {
    const store = new InMemoryLedgerStore();
    await seedCredits(store, ORG, 10);
    await reserveCredits(store, { organizationId: ORG, runId: RUN, amount: 2 });

    const settled = await Promise.allSettled([
      commitReservation(store, { organizationId: ORG, runId: RUN, amount: 2 }),
      commitReservation(store, { organizationId: ORG, runId: RUN, amount: 2 }),
    ]);

    // Exactly one settlement row — the ledger charges once no matter the
    // interleaving (unique (idempotency_key, kind), §14.2 rule 6).
    const commitRows = store.entriesForRun(RUN).filter((entry) => entry.kind === "commit");
    expect(commitRows).toHaveLength(1);
    expect(await store.balanceAfter(ORG)).toBe(8); // 10 − 2 held − 0 released

    const fresh: CommitOutcome[] = [];
    for (const outcome of settled) {
      if (outcome.status === "rejected") {
        // The loser's append hit the unique index in flight — loud, no money.
        expect(rejectionMessage(outcome.reason)).toMatch(/duplicate append rejected/);
        continue;
      }
      const result: Result<CommitOutcome> = outcome.value;
      if (!result.ok) {
        throw new Error(`unexpected failure: ${result.code}: ${result.message}`);
      }
      if (result.value.duplicate) {
        continue; // the loser's check saw the landed row — idempotent replay
      }
      fresh.push(result.value);
    }
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.amountCharged).toBe(2);
    expect(await reservationStatus(store, RUN)).toBe("committed");
  });

  it("a replayed commit with different arguments never re-settles (Stripe-style replay)", async () => {
    const store = new InMemoryLedgerStore();
    await seedCredits(store, ORG, 10);
    await reserveCredits(store, { organizationId: ORG, runId: RUN, amount: 2 });
    expectOk(
      await commitReservation(store, {
        organizationId: ORG,
        runId: RUN,
        amount: 2,
        amountCharged: 2,
      }),
    );

    const replay = expectOk(
      await commitReservation(store, {
        organizationId: ORG,
        runId: RUN,
        amount: 2,
        amountCharged: 1,
      }),
    );
    expect(replay.duplicate).toBe(true);

    // The first settlement stands: no new row, no re-charge, no partial unwind.
    expect(store.entriesForRun(RUN).filter((entry) => entry.kind === "commit")).toHaveLength(1);
    expect(await store.balanceAfter(ORG)).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// commit-vs-refund race — mutually exclusive terminals
// ---------------------------------------------------------------------------

describe("commit-vs-refund race (one wins, the loser gets a typed conflict)", () => {
  const RUN = "run-settle";
  const AMOUNT = 2;
  const SEED = 10;

  async function heldLedger(): Promise<InMemoryLedgerStore> {
    const store = new InMemoryLedgerStore();
    await seedCredits(store, ORG, SEED);
    await reserveCredits(store, { organizationId: ORG, runId: RUN, amount: AMOUNT });
    return store;
  }

  it("both settlers in flight, commit completes first → release gets a typed conflict", async () => {
    const ledger = await heldLedger();
    const gates = new GatedLedgerStore(ledger);

    // Release enqueued first, commit second: the newest-first drain runs the
    // commit to completion, then the release's reads observe the landed row.
    const releasePromise = releaseReservation(gates, {
      organizationId: ORG,
      runId: RUN,
      amount: AMOUNT,
    });
    const commitPromise = commitReservation(gates, {
      organizationId: ORG,
      runId: RUN,
      amount: AMOUNT,
    });
    await gates.drainNewestFirst();

    const committed = expectOk(await commitPromise);
    expect(committed.amountCharged).toBe(AMOUNT);
    expect(committed.duplicate).toBe(false);

    const released = expectErr(await releasePromise);
    expect(released.code).toBe("conflict"); // §13.3 → 409
    expect(released.message).toMatch(/already committed/);

    expect(await reservationStatus(ledger, RUN)).toBe("committed");
    expect(ledger.entriesForRun(RUN).map((entry) => entry.kind)).toEqual(["reserve", "commit"]);
    expect(await ledger.balanceAfter(ORG)).toBe(SEED - AMOUNT);
  });

  it("both settlers in flight, refund completes first → commit gets a typed conflict", async () => {
    const ledger = await heldLedger();
    const gates = new GatedLedgerStore(ledger);

    // Commit enqueued first, release second: the release drains to completion,
    // then the commit's first read observes the landed refund row.
    const commitPromise = commitReservation(gates, {
      organizationId: ORG,
      runId: RUN,
      amount: AMOUNT,
    });
    const releasePromise = releaseReservation(gates, {
      organizationId: ORG,
      runId: RUN,
      amount: AMOUNT,
    });
    await gates.drainNewestFirst();

    const released = expectOk(await releasePromise);
    expect(released.amountCharged).toBe(0);
    expect(released.amountRefunded).toBe(AMOUNT);

    const conflicted = expectErr(await commitPromise);
    expect(conflicted.code).toBe("conflict"); // §13.3 → 409
    expect(conflicted.message).toMatch(/already released/);

    expect(await reservationStatus(ledger, RUN)).toBe("released");
    expect(ledger.entriesForRun(RUN).map((entry) => entry.kind)).toEqual(["reserve", "refund"]);
    expect(await ledger.balanceAfter(ORG)).toBe(SEED); // full release: zero charge
  });

  it("unscripted free-for-all: the store's terminal exclusivity still lands exactly one", async () => {
    const store = new ExclusiveTerminalLedgerStore();
    await seedCredits(store, ORG, SEED);
    await reserveCredits(store, { organizationId: ORG, runId: RUN, amount: AMOUNT });

    const [commitSettled, releaseSettled] = await Promise.allSettled([
      commitReservation(store, { organizationId: ORG, runId: RUN, amount: AMOUNT }),
      releaseReservation(store, { organizationId: ORG, runId: RUN, amount: AMOUNT }),
    ]);

    const commitWon = commitSettled.status === "fulfilled" && commitSettled.value.ok;
    const releaseWon = releaseSettled.status === "fulfilled" && releaseSettled.value.ok;
    // Exactly one terminal — never both (ledger.ts: terminals are mutually
    // exclusive) and never neither.
    expect(commitWon === releaseWon).toBe(false);

    const loser = commitWon ? releaseSettled : commitSettled;
    if (loser.status === "fulfilled") {
      // The loser's checks ran after the winner landed → typed conflict.
      expect(loser.value.ok).toBe(false);
      if (!loser.value.ok) {
        expect(loser.value.code).toBe("conflict");
      }
    } else {
      // The loser's checks passed before the winner landed → the store's
      // one-transaction exclusivity guard fires LOUD. No double settlement.
      expect(rejectionMessage(loser.reason)).toMatch(/terminal already landed/);
    }

    const terminals = store
      .entriesForRun(RUN)
      .filter((entry) => entry.kind === "commit" || entry.kind === "refund");
    expect(terminals).toHaveLength(1);
    expect(await reservationStatus(store, RUN)).toBe(commitWon ? "committed" : "released");
    expect(await store.balanceAfter(ORG)).toBe(commitWon ? SEED - AMOUNT : SEED);
  });
});
