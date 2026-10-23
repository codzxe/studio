// @studio/worker — the shared dependency contract (the E2E wave drives this).
//
// Kept in its own module (no imports from index/pipeline) so every worker
// module can reference it without cycles. `repos`/`ledger` are the REAL
// @studio/db repository interfaces (structural: fakes satisfying the same
// methods also type-check); `storage` is the gateway's StorageChoice — same
// env, same driver, same §9.2 keys as the API process.

import type { StudioEnv } from "@studio/config";
import type { Repos, StudioDb } from "@studio/db";
import type { StorageChoice } from "@studio/gateway/storage";

import type { WorkerLogger } from "./logger.js";

export type { WorkerLogger, WorkerLogFields } from "./logger.js";

/** The render row exactly as `renders.claimNext` returns it (Render + workspaceId). */
export type ScopedRenderRow = Awaited<ReturnType<Repos["renders"]["claimNext"]>>[number];

/** The full worker dependency set — see `startWorker` / `runOnce` in index.ts. */
export interface WorkerDeps {
  /** The lazy Postgres pool (kept for shutdown; repos encapsulate all queries). */
  readonly db: StudioDb;
  /** The tenant-scoped repo bundle (renders/versions/assets/subscriptions used). */
  readonly repos: Repos;
  /** The credit ledger (settle/refundAll — idempotency-keyed by the worker). */
  readonly ledger: Repos["ledger"];
  /** ONE StorageChoice for the whole process — same keys as the gateway. */
  readonly storage: StorageChoice;
  readonly env: StudioEnv;
  readonly logger: WorkerLogger;
  /** Optional external shutdown signal (tests + the E2E wave). */
  readonly signal?: AbortSignal | undefined;
}
