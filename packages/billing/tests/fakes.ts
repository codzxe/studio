// In-memory LedgerStore fake for the billing domain tests (AGENTS.md: pure,
// deterministic, no network, no DB). Mirrors the invariants the real Postgres
// implementation must uphold (packages/db schema/billing.ts, W1-F):
//   - unique (idempotency_key, kind) — duplicates throw, like the DB index;
//   - append-only — no updates, no deletes;
//   - org-scoped balances — the sum of that org's deltas;
//   - the running balance never goes negative (§14.2) — enforced loudly here
//     so a domain bug fails the test, not a customer.

import type { CreditLedgerEntry, CreditLedgerKind, LedgerStore } from "../src/index.js";

let seedCounter = 0;

export class InMemoryLedgerStore implements LedgerStore {
  private readonly rows: CreditLedgerEntry[] = [];
  private readonly seen: Set<string> = new Set();

  async append(entry: CreditLedgerEntry): Promise<void> {
    if (!Number.isSafeInteger(entry.delta)) {
      throw new Error(`fake ledger: delta must be a safe integer, got ${entry.delta}`);
    }
    const composite = `${entry.idempotencyKey}\u0000${entry.kind}`;
    if (this.seen.has(composite)) {
      // Mirrors the DB's unique(idempotency_key, kind) — §14.2 rule 6.
      throw new Error(
        `fake ledger: duplicate append rejected (idempotencyKey=${entry.idempotencyKey}, kind=${entry.kind})`,
      );
    }
    const next = this.balanceOf(entry.organizationId) + entry.delta;
    if (next < 0) {
      throw new Error(
        `fake ledger: balance invariant violated — org ${entry.organizationId} would reach ${next}`,
      );
    }
    this.seen.add(composite);
    this.rows.push({ ...entry });
  }

  async balanceAfter(organizationId: string): Promise<number> {
    return this.balanceOf(organizationId);
  }

  async findByIdempotency(idempotencyKey: string, kind: CreditLedgerKind): Promise<boolean> {
    return this.seen.has(`${idempotencyKey}\u0000${kind}`);
  }

  // -- test inspection helpers ------------------------------------------------

  /** All rows for one org, in append order (never mutated afterwards). */
  entriesFor(organizationId: string): readonly CreditLedgerEntry[] {
    return this.rows.filter((row) => row.organizationId === organizationId);
  }

  /** Rows carrying the run id, in append order. */
  entriesForRun(runId: string): readonly CreditLedgerEntry[] {
    return this.rows.filter((row) => row.runId === runId);
  }

  size(): number {
    return this.rows.length;
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

/** Seeds a workspace with credits via a grant row (unique key per call). */
export async function seedCredits(
  store: LedgerStore,
  organizationId: string,
  credits: number,
): Promise<void> {
  seedCounter += 1;
  await store.append({
    organizationId,
    delta: credits,
    kind: "grant",
    idempotencyKey: `seed:${organizationId}:${seedCounter}`,
    note: "test seed",
  });
}
