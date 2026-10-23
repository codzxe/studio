// @studio/worker — entrypoint + the worker loop (BUILD_PLAN §M8 task 1).
//
//   startWorker(deps) → WorkerHandle: the long-lived claim loop.
//     - env.render.workerEnabled gates dequeueing entirely (feature-flag
//       family §2.3: jobs stay queued, never lost);
//     - env.render.workerConcurrency slots; claims are batched
//       (`renders.claimNext` is FOR UPDATE SKIP LOCKED — any number of worker
//       processes is safe);
//     - sweeps run on a slow cadence (every 10th poll tick) + once at start
//       (crash recovery is prompt for a freshly restarted worker);
//     - graceful shutdown: stop claiming, let RUNNING jobs finish (or the
//       stale sweep reclaims them on the next boot — "job survives worker
//       restart", §M8 exit criterion).
//   runOnce(deps) → TickResult: ONE sweep + ONE claim batch driven to
//     completion — tests and the E2E wave drive the queue deterministically.

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getEnv } from "@studio/config";
import { createDb, createRepos } from "@studio/db";

import type { ScopedRenderRow, WorkerDeps, WorkerLogger } from "./deps.js";
import { createWorkerLogger } from "./logger.js";
import { type RenderJobOutcome, runJob } from "./pipeline.js";
import { createWorkerStorage } from "./storage.js";
import { type SweepResult, runSweeps } from "./sweeps.js";

export type { RenderJobOutcome, RenderJobOutcome as JobOutcome } from "./pipeline.js";
export type { WorkerDeps, ScopedRenderRow, WorkerLogger, WorkerLogFields } from "./deps.js";
export { runJob } from "./pipeline.js";
export { runSweeps, type SweepResult } from "./sweeps.js";
export { createWorkerStorage, outputObjectKey, renderKey } from "./storage.js";
export { createWorkerLogger, nullLogger, recordingLogger } from "./logger.js";
export { resolveCliPath, buildRenderArgs, parseProgressLine } from "./cli.js";
export { zipStore, crc32 } from "./zip.js";

/** Sweeps cadence: every Nth poll tick (10 × pollIntervalMs ≈ 10 s by default). */
const SWEEP_EVERY_TICKS = 10;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    if (signal !== undefined) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

// ───────────────────────────────────────────────────────────────────────────
// runOnce — one deterministic tick (tests + the E2E wave drive this)
// ───────────────────────────────────────────────────────────────────────────

export interface TickResult {
  /** Rows claimed this tick. */
  readonly claimed: number;
  /** Terminal outcome per claimed job (order follows the claim batch). */
  readonly outcomes: readonly RenderJobOutcome[];
  readonly swept: SweepResult;
}

export async function runOnce(deps: WorkerDeps): Promise<TickResult> {
  if (!deps.env.render.workerEnabled) {
    deps.logger.warn("render_worker_disabled", {});
    return { claimed: 0, outcomes: [], swept: { requeuedOrFailed: 0, outputsExpired: 0 } };
  }
  const swept = await runSweeps(deps);
  const workerId = `wrk_once_${randomUUID().slice(0, 8)}`;
  const rows = await deps.repos.renders.claimNext(workerId, {
    limit: deps.env.render.workerConcurrency,
  });
  if (rows.length === 0) return { claimed: 0, outcomes: [], swept };

  const outcomes: RenderJobOutcome[] = [];
  await Promise.all(
    rows.map(async (row) => {
      const outcome = await runJob(deps, row);
      outcomes.push(outcome);
      logOutcome(deps.logger, outcome);
    }),
  );
  return { claimed: rows.length, outcomes, swept };
}

/** The one-line outcome event every driver (loop + runOnce) emits. */
function logOutcome(logger: WorkerLogger, outcome: RenderJobOutcome): void {
  if (outcome.outcome === "failed") {
    logger.info("render_outcome", {
      renderId: outcome.renderId,
      outcome: outcome.outcome,
      errorCode: outcome.errorCode,
    });
    return;
  }
  logger.info("render_outcome", { renderId: outcome.renderId, outcome: outcome.outcome });
}

// ───────────────────────────────────────────────────────────────────────────
// startWorker — the long-lived claim loop
// ───────────────────────────────────────────────────────────────────────────

export interface WorkerHandle {
  readonly workerId: string;
  /** Stop claiming; in-flight jobs finish; resolves when the loop exits. */
  stop(): Promise<void>;
  /** Resolves when the loop has fully exited (after `stop`/signal abort). */
  readonly stopped: Promise<void>;
}

export async function startWorker(deps: WorkerDeps): Promise<WorkerHandle> {
  const workerId = `wrk_${randomUUID().slice(0, 8)}`;
  const { env, logger, signal } = deps;

  if (!env.render.workerEnabled) {
    logger.warn("render_worker_disabled", { workerId, hint: "jobs stay queued" });
    return { workerId, stop: async () => {}, stopped: Promise.resolve() };
  }

  const active = new Set<Promise<void>>();
  let stopRequested = false;
  let ticks = 0;
  const isAborted = (): boolean => signal?.aborted === true;

  const startJob = (row: ScopedRenderRow): void => {
    const tracked = (async (): Promise<void> => {
      try {
        logOutcome(logger, await runJob(deps, row));
      } catch (error) {
        // runJob never throws by contract — this is belt-and-suspenders.
        logger.error("render_job_crashed", {
          renderId: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })().finally(() => {
      active.delete(tracked);
    });
    active.add(tracked);
  };

  const tick = async (): Promise<void> => {
    ticks += 1;
    // Sweeps: once at start (prompt crash recovery after a restart), then on
    // the slow cadence — they are global sweeps, cheap and idempotent.
    if (ticks === 1 || (ticks - 1) % SWEEP_EVERY_TICKS === 0) {
      await runSweeps(deps).catch((error: unknown) => {
        logger.error("render_sweep_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    const free = env.render.workerConcurrency - active.size;
    if (free <= 0) return;
    const rows = await deps.repos.renders
      .claimNext(workerId, { limit: free })
      .catch((error: unknown) => {
        logger.error("render_claim_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      });
    for (const row of rows) startJob(row);
  };

  const stopped = (async (): Promise<void> => {
    logger.info("render_worker_started", {
      workerId,
      concurrency: env.render.workerConcurrency,
      pollIntervalMs: env.render.pollIntervalMs,
    });
    await tick();
    while (!stopRequested && !isAborted()) {
      await sleep(env.render.pollIntervalMs, signal);
      if (stopRequested || isAborted()) break;
      await tick();
    }
    // Graceful: no new claims; running jobs finish. Rows whose worker died
    // mid-render are reclaimed by the stale sweep on the next boot.
    await Promise.allSettled([...active]);
    logger.info("render_worker_stopped", { workerId, inFlight: active.size });
  })();

  return {
    workerId,
    stopped,
    stop: async () => {
      stopRequested = true;
      await stopped;
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// main — run as a service process (mirrors the gateway entry)
// ───────────────────────────────────────────────────────────────────────────

function isInvokedDirectly(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isInvokedDirectly()) {
  try {
    const env = getEnv();
    const logger = createWorkerLogger(env);
    const db = createDb(env.db.url);
    const repos = createRepos(db);
    const deps: WorkerDeps = {
      db,
      repos,
      ledger: repos.ledger,
      storage: createWorkerStorage(env),
      env,
      logger,
    };
    const handle = await startWorker(deps);
    const shutdown = (signalName: string): void => {
      logger.info("render_worker_shutdown", { signal: signalName });
      void handle
        .stop()
        .then(async () => {
          try {
            await db.$client.end({ timeout: 5 });
          } catch {
            // pool already gone
          }
        })
        .finally(() => {
          process.exit(0);
        });
    };
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));
  } catch (error) {
    // EnvFatalError prints safely on its own; anything else still never
    // echoes secret values (only names/messages).
    // biome-ignore lint/suspicious/noConsole: server entrypoint must print startup failures to stderr
    console.error(
      "[worker] failed to start:",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  }
}
