// @studio/worker — maintenance sweeps (BUILD_PLAN §M8 tasks 1 & 4).
//
// Three trusted-internal, workspace-free repo operations, driven by the worker
// on a slow cadence (and once per `runOnce` tick):
//  1. requeueStale — crash recovery: running rows with a stale (or absent)
//     heartbeat go back to queued while attempts < maxAttempts, else fail
//     terminally (RENDER_INTERNAL, "worker lost mid-render"). Together with
//     the deterministic object key this gives "job survives worker restart;
//     no duplicate outputs on retry" (§M8 exit criteria).
//     BIL-02 (2026-10-30 audit): the terminal branch now ALSO refunds the
//     stranded credit hold — pre-fix a render killed past maxAttempts locked
//     the user's reserve forever (the worker's own fail() refunds; the sweep
//     never did, and reconciliation refuses to auto-release zombies).
//  1b. settle-replay (BIL-03, 2026-10-30 audit): a worker crash between
//     markCompleted and ledger.settle (or a settle failure — deliberately
//     never a row rollback) stranded the FULL hold on a COMPLETED render.
//     The sweep replays the exact settle the pipeline would have made, after
//     a grace window so a live worker's own settle always wins.
//  2. retention — completed rows whose output expired lose their stored
//     object (delete is log-only: a storage hiccup must never wedge the
//     sweep), then markOutputExpired clears objectKey/sizeBytes/expiresAt.

import type { WorkerDeps } from "./deps.js";

/** Grace before the BIL-03 settle-replay may touch a completed render. */
const SETTLE_REPLAY_GRACE_MS = 10 * 60 * 1000;

export interface SweepResult {
  /** Rows requeued by the stale sweep. */
  readonly requeued: number;
  /** Rows terminally failed by the stale sweep (their holds are refunded). */
  readonly failed: number;
  /** Stranded holds released: terminal refunds (BIL-02) + settle replays (BIL-03). */
  readonly holdsReleased: number;
  /** Completed rows whose expired output was deleted + marked. */
  readonly outputsExpired: number;
}

export async function runSweeps(deps: WorkerDeps): Promise<SweepResult> {
  const { env, repos, storage, logger } = deps;

  // ── 1. Stale sweep + BIL-02 terminal-failure refunds ────────────────────
  const stale = await repos.renders.requeueStale(
    env.render.heartbeatStaleSeconds,
    env.render.maxAttempts,
  );
  if (stale.requeued > 0) {
    logger.info("render_sweep_requeued", { count: stale.requeued });
  }

  let holdsReleased = 0;
  // BIL-02: refundAll is idempotent and recomputes outstanding under the
  // workspace lock, so racing a late worker refund is safe; the key mirrors
  // the pipeline's own (`render:refund:<id>`), making this a true replay
  // when both run.
  for (const row of stale.failed) {
    try {
      await deps.ledger.refundAll(row.workspaceId, {
        renderId: row.id,
        idempotencyKey: `render:refund:${row.id}`,
        metadata: { reason: "sweep-terminal-failure" },
      });
      holdsReleased += 1;
      logger.info("render_sweep_hold_refunded", { renderId: row.id });
    } catch (error) {
      // Log-only: never wedge the sweep; the next pass retries the refund.
      logger.warn("render_sweep_refund_failed", {
        renderId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── 1b. BIL-03: settle-replay for completed renders with open holds ─────
  const openScopes =
    deps.ledger.outstandingRenderScopes === undefined
      ? []
      : await deps.ledger.outstandingRenderScopes().catch((error: unknown) => {
          logger.warn("render_sweep_scope_query_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          return [];
        });
  for (const scope of openScopes) {
    const render = await repos.renders.get(scope.workspaceId, scope.renderId).catch(() => null);
    if (render === null || render.status !== "completed" || render.completedAt === null) continue;
    if (Date.now() - render.completedAt.getTime() < SETTLE_REPLAY_GRACE_MS) continue;
    try {
      // Same idempotency key as the pipeline's own settle — a true replay
      // when the original landed; actualCost = the outstanding hold (renders
      // reserve the full quote), capped at the hold by planSettlement.
      await deps.ledger.settle(scope.workspaceId, {
        renderId: scope.renderId,
        actualCost: scope.outstanding,
        idempotencyKey: `render:settle:${scope.renderId}`,
        metadata: { reason: "sweep-settle-replay" },
      });
      holdsReleased += 1;
      logger.info("render_sweep_settle_replayed", { renderId: scope.renderId });
    } catch (error) {
      logger.warn("render_sweep_settle_replay_failed", {
        renderId: scope.renderId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── 2. Retention ─────────────────────────────────────────────────────────
  let outputsExpired = 0;
  const expired = await repos.renders.listExpiredOutputs(new Date());
  for (const row of expired) {
    if (row.objectKey === null) {
      // Already purged (or a legacy row) — just clear the metadata markers.
      await repos.renders.markOutputExpired(row.workspaceId, row.id).catch(() => {});
      outputsExpired += 1;
      continue;
    }
    try {
      await storage.driver.delete(row.objectKey);
      await repos.renders.markOutputExpired(row.workspaceId, row.id);
      outputsExpired += 1;
    } catch (error) {
      // Log-only (dispatch): a storage failure must not wedge the sweep —
      // the row keeps its objectKey and is retried on the next pass.
      logger.warn("render_retention_delete_failed", {
        renderId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (outputsExpired > 0) {
    logger.info("render_sweep_expired", { count: outputsExpired });
  }

  return { requeued: stale.requeued, failed: stale.failed.length, holdsReleased, outputsExpired };
}
