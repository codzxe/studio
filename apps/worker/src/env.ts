import { z } from "zod";

/**
 * Worker environment, parsed exactly once at boot (Zod at every boundary,
 * docs/AGENTS.md). A missing/invalid variable refuses to start — no defaults
 * for secrets.
 *
 * TODO: migrate to `packages/config` once that package lands (owned by another
 * wave agent); this schema mirrors its contract until then.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const logLevelSchema = z.enum(LOG_LEVELS);

/** Bootstrap-friendly level pick: never throws, falls back to "info". */
export function pickLogLevel(raw: string | undefined): LogLevel {
  return logLevelSchema.catch("info").parse(raw);
}

export const workerEnvSchema = z.object({
  /** §3.1 queue/cache: Valkey connection string (BullMQ transport). Required. */
  VALKEY_URL: z.string().url(),
  /** Total worker concurrency across all queues; split evenly per queue. */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
  /** Internal ops health endpoint (src/health.ts). */
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(9876),
  /** Bind address; loopback by default — internal endpoint, never proxied. */
  WORKER_HEALTH_HOST: z.string().min(1).default("127.0.0.1"),
  LOG_LEVEL: logLevelSchema.default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export class EnvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvParseError";
  }
}

/**
 * Parses the worker environment. Throws `EnvParseError` listing field paths
 * and reasons only — raw env values are never echoed (they may hold secrets).
 */
export function parseWorkerEnv(
  source: Record<string, string | undefined> = process.env,
): WorkerEnv {
  const parsed = workerEnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new EnvParseError(`invalid worker environment: ${issues.join("; ")}`);
  }
  return parsed.data;
}
