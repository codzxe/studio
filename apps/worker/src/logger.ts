/**
 * Minimal structured-logging seam for the worker.
 *
 * docs/AGENTS.md bans `console.*` in shipped paths; everything logs through
 * this interface so tests stay dependency-free (pino is wired only in
 * src/pino-logger.ts, used by the bootstrap in src/index.ts).
 */

/** Field bag for structured log lines. Values must be JSON-serializable. */
export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Returns a logger with the given bindings attached to every line. */
  child(bindings: LogFields): Logger;
}
