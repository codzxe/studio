// @studio/gateway — durable `run_events` store for the SSE run-event bus.
// Owner: W4-H (docs/AGENTS.md).
//
// Spec anchors:
//   §13.2  `run_events` is the SSE backfill store: `sinceSeq` returns rows with
//          `seq > afterSeq` in ascending pages; clients dedupe by `seq` and
//          resume with Last-Event-ID. `seq` is allocated by the BUS (gap-guard
//          — packages/agent/src/eventbus.ts); the store never invents one.
//   §22    durability over latency: the bus awaits `append` BEFORE acking a
//          publish; rows carry the tenant root + the correlation timestamp.
//   §15.3  the durable record keeps the RAW payload; §22 redaction happens at
//          DELIVERY time in the bus, never here.
//   §3.4   idempotency: (run_id, seq) is the natural idempotency key — a
//          worker retry after a lost ack re-appends the same seq and must
//          ack, not wedge (onConflictDoNothing below).
//
// Structural mirror note (W3-M precedent): `StoredEventAppend`,
// `StoredEventRow` and `EventStoreLike` re-declare the EXACT shapes of W2-P's
// contracts in packages/agent/src/eventbus.ts because the gateway package
// does not depend on @studio/agent (no dep entry in apps/gateway/package.json
// — a package.json is a shared registry file, not ours to touch).
// `DrizzleEventStore` therefore satisfies the agent's `EventStoreLike`
// shape-for-shape, and once the wiring wave adds the `@studio/agent` dep the
// bootstrap can pass it straight into `new RunEventBus({ store })`. DO NOT let
// these mirrors drift — diff against packages/agent/src/eventbus.ts first.

import { runEvents, type RunEventType } from "@studio/db";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/** One durable append (W2-P `StoredEventAppend` mirror). `seq` comes from the bus. */
export interface StoredEventAppend {
  readonly seq: number;
  readonly type: RunEventType;
  /** Raw payload — the durable record is complete (§15.3). */
  readonly payload: unknown;
  /** §22 correlation timestamp as an ISO 8601 string. */
  readonly at: string;
  /** §12.2 tenant root on every `run_events` row. */
  readonly organizationId: string;
}

/** A persisted row as `sinceSeq` returns it (W2-P `StoredEventRow` mirror). */
export interface StoredEventRow extends StoredEventAppend {}

/**
 * The durable sink the run-event bus reads and writes (W2-P `EventStoreLike`
 * mirror): `append` inserts one row; `sinceSeq` returns rows with
 * `seq > afterSeq`, at most `limit`, ascending; the optional `maxSeq` is the
 * authoritative highest seq for a run (Last-Event-ID sanity clamp, §13.2).
 */
export interface EventStoreLike {
  append(runId: string, row: StoredEventAppend): Promise<void>;
  sinceSeq(runId: string, afterSeq: number, limit: number): Promise<readonly StoredEventRow[]>;
  maxSeq?(runId: string): Promise<number>;
}

/**
 * Structural seam over the Drizzle client as buildApp deps will carry it
 * (`db` from @studio/db's createDb): exactly the two query builders this store
 * needs. A real `Db` satisfies it structurally; the wiring wave passes
 * `new DrizzleEventStore(db)` — no adapter in between.
 */
export type DbLike = Pick<NodePgDatabase, "insert" | "select">;

/**
 * Drizzle-backed `EventStoreLike` over the `run_events` table (§12.1).
 * The table's unique (run_id, seq) index enforces §13.2 per-run monotonicity;
 * the (organization_id, created DESC) index serves the max-seq probe below.
 */
export class DrizzleEventStore implements EventStoreLike {
  readonly #db: DbLike;

  constructor(db: DbLike) {
    this.#db = db;
  }

  async append(runId: string, row: StoredEventAppend): Promise<void> {
    await this.#db
      .insert(runEvents)
      .values({
        organizationId: row.organizationId,
        runId,
        seq: row.seq,
        type: row.type,
        payload: row.payload,
        createdAt: new Date(row.at),
      })
      // §3.4: (run_id, seq) is the idempotency key. A publish retry after a
      // lost ack re-appends the same seq — the row is already durable, so the
      // retry acks and the timeline stays gapless. A genuine cross-process
      // seq race surfaces downstream as a gap → §13.2 resync, never a wedge.
      .onConflictDoNothing();
  }

  async sinceSeq(
    runId: string,
    afterSeq: number,
    limit: number,
  ): Promise<readonly StoredEventRow[]> {
    const pageSize = Math.max(1, Math.floor(limit));
    const rows = await this.#db
      .select({
        seq: runEvents.seq,
        type: runEvents.type,
        payload: runEvents.payload,
        organizationId: runEvents.organizationId,
        createdAt: runEvents.createdAt,
      })
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq)))
      .orderBy(asc(runEvents.seq))
      .limit(pageSize);
    // `at` is the ISO string form of the row's correlation timestamp (§22);
    // the bus's backfill turns it back into a Date for delivery envelopes.
    return rows.map((row) => ({
      seq: row.seq,
      type: row.type,
      payload: row.payload,
      at: row.createdAt.toISOString(),
      organizationId: row.organizationId,
    }));
  }

  async maxSeq(runId: string): Promise<number> {
    const rows = await this.#db
      .select({ seq: runEvents.seq })
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(desc(runEvents.seq))
      .limit(1);
    const top = rows[0];
    return top === undefined ? 0 : top.seq;
  }
}
