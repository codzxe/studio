/**
 * Worker bootstrap (§3.1): consumes run/export/image jobs from Valkey via
 * BullMQ.
 *
 * - one runs worker per model tier (§5.2) + one exports worker + one images worker
 * - processors are injected (`RunProcessor`, src/processor.ts) — Wave 6 swaps
 *   the stub for the real agent loop without touching this wiring
 * - graceful shutdown: workers → queues → health server → Valkey connection
 */
import { Queue, Worker } from "bullmq";
import type { Job, JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import type { ZodType } from "zod";
import { parseWorkerEnv, pickLogLevel, type WorkerEnv } from "./env.js";
import { startHealthServer, type QueueDepth, type QueueStatsSource } from "./health.js";
import type { Logger } from "./logger.js";
import { createPinoLogger } from "./pino-logger.js";
import {
  RetryableRunFailureError,
  StubRunProcessor,
  type RunJobContext,
  type RunJobPayload,
  type RunOutcome,
  type RunProcessor,
} from "./processor.js";
import {
  JOB_RETRY,
  QUEUE_NAMES,
  RUN_QUEUE_BY_TIER,
  RUN_TIERS,
  TIER_WALL_CLOCK_MS,
  WORKER_QUEUE_NAMES,
  exportJobPayloadSchema,
  imageJobPayloadSchema,
  parseJobPayload,
  runJobPayloadSchema,
  type ExportJobPayload,
  type ImageJobPayload,
} from "./queues.js";

async function bootstrap(logger: Logger): Promise<void> {
  let env: WorkerEnv;
  try {
    env = parseWorkerEnv(); // fail fast: bad/missing env refuses to start
  } catch (error) {
    logger.error("refusing to start: invalid environment", { issue: errorMessage(error) });
    process.exit(1);
  }

  // BullMQ requires maxRetriesPerRequest: null; it duplicates this instance
  // automatically for the workers' blocking connections.
  const connection = new Redis(env.VALKEY_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
  connection.on("error", (error) => logger.error("valkey connection error", { err: error }));

  const defaultJobOptions: JobsOptions = {
    attempts: JOB_RETRY.attempts, // §3.4: backoff retries, then the run is marked failed
    backoff: { ...JOB_RETRY.backoff },
    removeOnComplete: { age: 24 * 60 * 60 },
    removeOnFail: { age: 7 * 24 * 60 * 60 },
  };

  const queues = WORKER_QUEUE_NAMES.map((name) => {
    const queue = new Queue(name, { connection, defaultJobOptions });
    queue.on("error", (error) => logger.error("queue error", { queue: name, err: error }));
    return queue;
  });

  const concurrency = Math.max(1, Math.floor(env.WORKER_CONCURRENCY / WORKER_QUEUE_NAMES.length));
  const workerOptions = { connection, concurrency };

  const runProcessor: RunProcessor = new StubRunProcessor(logger); // ← Wave 6: real agent loop
  const workers: Worker[] = [];
  for (const tier of RUN_TIERS) {
    workers.push(
      new Worker<RunJobPayload, RunOutcome, string>(
        RUN_QUEUE_BY_TIER[tier],
        makeRunJobHandler(runProcessor, logger),
        workerOptions,
      ),
    );
  }
  workers.push(
    new Worker<ExportJobPayload, void, string>(
      QUEUE_NAMES.exports,
      makeStubJobHandler(exportJobPayloadSchema, "exports", logger),
      workerOptions,
    ),
    new Worker<ImageJobPayload, void, string>(
      QUEUE_NAMES.images,
      makeStubJobHandler(imageJobPayloadSchema, "images", logger),
      workerOptions,
    ),
  );
  for (const worker of workers) {
    attachWorkerEvents(worker, logger);
  }

  const stats: QueueStatsSource = { getQueueDepths: () => collectQueueDepths(queues) };
  const health = await startHealthServer({
    port: env.WORKER_HEALTH_PORT,
    host: env.WORKER_HEALTH_HOST,
    stats,
    logger: logger.child({ component: "health" }),
  });

  logger.info("worker ready", {
    queues: WORKER_QUEUE_NAMES,
    concurrencyPerWorker: concurrency,
    healthUrl: health.url,
  });

  let shuttingDown = false;
  const shutdown = async (exitCode: number, reason: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info("graceful shutdown started", { reason });
    // Drains in-flight jobs first, then queues (task-mandated order).
    await closeAll("worker", workers.map((worker) => worker.close()), logger);
    await closeAll("queue", queues.map((queue) => queue.close()), logger);
    await health
      .close()
      .catch((error: unknown) => logger.error("health server close failed", { err: error }));
    connection.disconnect();
    logger.info("shutdown complete", { exitCode });
    process.exit(exitCode);
  };

  process.once("SIGTERM", () => void shutdown(0, "SIGTERM"));
  process.once("SIGINT", () => void shutdown(0, "SIGINT"));
  process.on("uncaughtException", (error) => {
    logger.error("uncaught exception — shutting down", { err: error });
    void shutdown(1, "uncaughtException");
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled rejection — shutting down", { reason });
    void shutdown(1, "unhandledRejection");
  });
}

function makeRunJobHandler(
  processor: RunProcessor,
  logger: Logger,
): (job: Job<RunJobPayload, RunOutcome, string>) => Promise<RunOutcome> {
  return async (job) => {
    const payload = parseJobPayload(runJobPayloadSchema, job.data, {
      queue: job.queueName,
      jobId: job.id,
    });
    const context: RunJobContext = {
      jobId: job.id ?? "unknown",
      payload,
      attempt: job.attemptsMade + 1,
      // §5.2 tier wall clock as the cooperative deadline for the agent loop.
      signal: AbortSignal.timeout(TIER_WALL_CLOCK_MS[payload.tier]),
    };
    logger.debug("run job started", {
      queue: job.queueName,
      jobId: context.jobId,
      attempt: context.attempt,
    });
    const outcome = await processor.process(context);
    const runError = outcome.error;
    const retryable =
      outcome.status === "failed" &&
      runError?.retryable === true &&
      context.attempt < totalAttempts(job);
    if (retryable) {
      logger.warn("run failed — handing back to queue for backoff retry", {
        queue: job.queueName,
        jobId: context.jobId,
        attempt: context.attempt,
        code: runError.code,
      });
      throw new RetryableRunFailureError(runError);
    }
    logger.info("run job finished", {
      queue: job.queueName,
      jobId: context.jobId,
      status: outcome.status,
    });
    return outcome;
  };
}

function totalAttempts(job: Job<RunJobPayload, RunOutcome, string>): number {
  return job.opts.attempts ?? JOB_RETRY.attempts;
}

function makeStubJobHandler<T>(
  schema: ZodType<T>,
  label: string,
  logger: Logger,
): (job: Job<T, void, string>) => Promise<void> {
  return async (job) => {
    parseJobPayload(schema, job.data, { queue: job.queueName, jobId: job.id });
    logger.warn(`TODO: ${label} processor is a stub — real implementation arrives in Wave 6`, {
      queue: job.queueName,
      jobId: job.id,
    });
  };
}

function attachWorkerEvents(worker: Worker, logger: Logger): void {
  const log = logger.child({ queue: worker.name });
  worker.on("error", (error) => log.error("worker error", { err: error }));
  worker.on("failed", (job, error) => log.error("job failed", { jobId: job?.id, err: error }));
  worker.on("stalled", (jobId) => log.warn("job stalled", { jobId }));
}

async function collectQueueDepths(queues: readonly Queue[]): Promise<readonly QueueDepth[]> {
  return Promise.all(
    queues.map(async (queue): Promise<QueueDepth> => {
      const counts = await queue.getJobCounts(
        "waiting",
        "active",
        "delayed",
        "completed",
        "failed",
      );
      return {
        queue: queue.name,
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        completed: counts.completed ?? 0,
        failed: counts.failed ?? 0,
      };
    }),
  );
}

async function closeAll(
  kind: string,
  closing: readonly Promise<void>[],
  logger: Logger,
): Promise<void> {
  const results = await Promise.allSettled(closing);
  for (const result of results) {
    if (result.status === "rejected") {
      logger.error(`failed to close ${kind}`, { err: result.reason });
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const bootstrapLogger = createPinoLogger(pickLogLevel(process.env.LOG_LEVEL), {
  service: "worker",
});
void bootstrap(bootstrapLogger).catch((error: unknown) => {
  bootstrapLogger.error("worker bootstrap failed", { err: error });
  process.exit(1);
});
