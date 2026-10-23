// @studio/worker — maintenance sweeps (BUILD_PLAN §M8 tasks 1 & 4).
//
// Two trusted-internal, workspace-free repo operations, driven by the worker
// on a slow cadence (and once per `runOnce` tick):
//  1. requeueStale — crash recovery: running rows with a stale (or absent)
//     heartbeat go back to queued while attempts < maxAttempts, else fail
//     terminally (RENDER_INTERNAL, "worker lost mid-render"). Together with
//     the deterministic object key this gives "job survives worker restart;
//     no duplicate outputs on retry" (§M8 exit criteria).
//  2. retention — completed rows whose output expired lose their stored
//     object (delete is log-only: a storage hiccup must never wedge the
//     sweep), then markOutputExpired clears objectKey/sizeBytes/expiresAt.

import type { WorkerDeps } from "./deps.js";

export interface SweepResult {
  /** Rows requeued or terminally failed by the stale sweep. */
  readonly requeuedOrFailed: number;
  /** Completed rows whose expired output was deleted + marked. */
  readonly outputsExpired: number;
}

export async function runSweeps(deps: WorkerDeps): Promise<SweepResult> {
  const { env, repos, storage, logger } = deps;
  const requeuedOrFailed = await repos.renders.requeueStale(
    env.render.heartbeatStaleSeconds,
    env.render.maxAttempts,
  );
  if (requeuedOrFailed > 0) {
    logger.info("render_sweep_requeued", { count: requeuedOrFailed });
  }

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

  return { requeuedOrFailed, outputsExpired };
}
