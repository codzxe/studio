import pino from "pino";
import type { Logger, LogFields } from "./logger.js";

/**
 * Adapts pino (the §3.1 observability logger) to the local `Logger` interface.
 * Kept in its own module so every other file — and the tests — stays free of
 * pino imports.
 */
export function createPinoLogger(level: string, base: LogFields = {}): Logger {
  const root = pino({ level });
  return wrap(Object.keys(base).length > 0 ? root.child(base) : root);
}

type PinoLogger = pino.Logger;

function wrap(inner: PinoLogger): Logger {
  return {
    debug: (message, fields) => inner.debug(fields ?? {}, message),
    info: (message, fields) => inner.info(fields ?? {}, message),
    warn: (message, fields) => inner.warn(fields ?? {}, message),
    error: (message, fields) => inner.error(fields ?? {}, message),
    child: (bindings) => wrap(inner.child(bindings)),
  };
}
