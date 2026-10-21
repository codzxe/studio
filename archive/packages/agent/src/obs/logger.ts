// packages/agent/src/obs/logger.ts — W9-D observability kit: correlated logger (§22).
//
// §22: every log line carries request_id → workspace_id → run_id → step_seq,
// and prompts are redacted unless the workspace opted in (§15.3, fail-closed).
//
// ZERO HARD DEPS (W9-D brief): pino is loaded via a dynamic-optional import —
// a non-literal specifier so both tsc and bundlers leave it to the runtime.
// When pino is absent the factory falls back to a plain-JSON console logger
// with the SAME surface and the SAME redaction; apps that install pino pass
// `pinoModule` (or add the dependency to this package later) and get the real
// backend with no code change here. Tracing never breaks the caller: logging
// must never take the product down (§22 durability posture).
//
// Conventions (mirrors apps/gateway/src/middleware: request-context.ts +
// logger.ts, the W1-H seams this kit generalizes):
//  - correlation ids are camelCase in the TS API (requestId, workspaceId,
//    runId, stepSeq — task brief) and snake_case on the wire (request_id,
//    workspace_id, run_id, step_seq — §22 names the wire fields and the
//    gateway already emits request_id).
//  - markers "[redacted]" / "[truncated]" match the gateway constants.
//  - redaction is key-based and deep (pino's path-based `redact` cannot cover
//    unknown nesting of prompt-ish payloads); it runs in THIS wrapper so both
//    backends behave identically. Correlation ids are never redacted
//    (ADR-0005 #6: "correlation ids are kept — only content is redacted").

/** Marker substituted for prompt-ish values (§22 redaction, gateway parity). */
export const REDACTED_MARKER = "[redacted]";

/** Marker for values deeper than the redaction recursion cap (cycle-safe). */
export const TRUNCATED_MARKER = "[truncated]";

/** §22 prompt-ish keys redacted by default (task brief: prompt/content/body). */
export const DEFAULT_REDACT_KEYS: readonly string[] = ["prompt", "content", "body"];

/** Prompt-logging policy per §15.3: fail-closed "redacted", opted-in "raw". */
export type PromptLoggingMode = "redacted" | "raw";

/** pino-style levels, lowest → highest (§22; .env.example LOG_LEVEL). */
export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** pino's "silent" pseudo-level: suppresses every backend. */
export const SILENT_LEVEL = "silent";

/** Anything a caller may merge into a line (redaction runs over this). */
export type LogFields = Record<string, unknown>;

/** §22 correlation chain, camelCase API / snake_case wire (see header). */
export interface CorrelationBindings {
  readonly requestId?: string;
  readonly workspaceId?: string;
  readonly runId?: string;
  readonly stepSeq?: number;
}

const LEVEL_VALUE: Readonly<Record<LogLevel, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const MAX_REDACT_DEPTH = 8;

/** Env source shape (process.env satisfies this; injectable for tests). */
type EnvSource = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// Correlation + redaction (pure, testable)
// ---------------------------------------------------------------------------

/** Map camelCase correlation bindings to §22 snake_case wire fields. */
export function correlationFields(
  bindings: CorrelationBindings,
): Record<string, string | number> {
  const fields: Record<string, string | number> = {};
  if (bindings.requestId !== undefined) fields.request_id = bindings.requestId;
  if (bindings.workspaceId !== undefined) fields.workspace_id = bindings.workspaceId;
  if (bindings.runId !== undefined) fields.run_id = bindings.runId;
  if (bindings.stepSeq !== undefined) fields.step_seq = bindings.stepSeq;
  return fields;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-redact §22 prompt-ish keys from a JSON-shaped value. Returns a
 * sanitized copy — the input is never mutated. "raw" mode (workspace opted
 * in, §15.3) passes the value through untouched (same reference). Exact key
 * match, case-insensitive; depth-capped so cyclic values stay cycle-safe.
 * Over-redaction is the safe direction (§15.2: secrets never in logs).
 */
export function redactDeep<T>(value: T, mode: PromptLoggingMode, keys?: readonly string[]): T {
  if (mode === "raw") {
    return value;
  }
  const keySet = new Set((keys ?? DEFAULT_REDACT_KEYS).map((key) => key.toLowerCase()));
  return redactNode(value, 0, keySet) as T;
}

function redactNode(value: unknown, depth: number, keySet: Set<string>): unknown {
  if (depth > MAX_REDACT_DEPTH) {
    return TRUNCATED_MARKER;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactNode(item, depth + 1, keySet));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = keySet.has(key.toLowerCase()) ? REDACTED_MARKER : redactNode(child, depth + 1, keySet);
    }
    return out;
  }
  return value;
}

/**
 * Resolve the effective level: explicit option > env LOG_LEVEL (.env.example
 * §22: trace|debug|info|warn|error, plus pino's "silent") > "info". An
 * unrecognized env value degrades to "info" — a bad LOG_LEVEL must not take
 * the service down over logging config.
 */
export function resolveLogLevel(
  explicit?: string,
  env: EnvSource = process.env,
): LogLevel | "silent" {
  const raw = explicit ?? env.LOG_LEVEL;
  if (raw === SILENT_LEVEL) {
    return SILENT_LEVEL;
  }
  if (raw !== undefined && (LOG_LEVELS as readonly string[]).includes(raw)) {
    return raw as LogLevel;
  }
  return "info";
}

// ---------------------------------------------------------------------------
// pino structural seam (NO import of pino — optional dep, see header)
// ---------------------------------------------------------------------------

/** The slice of a pino instance this wrapper needs (structural, no `any`). */
export interface PinoLoggerLike {
  child(bindings: LogFields): PinoLoggerLike;
  trace(fields: unknown, msg?: string): void;
  debug(fields: unknown, msg?: string): void;
  info(fields: unknown, msg?: string): void;
  warn(fields: unknown, msg?: string): void;
  error(fields: unknown, msg?: string): void;
  fatal(fields: unknown, msg?: string): void;
}

/** Options the wrapper forwards to the pino factory. */
export interface PinoOptionsLike {
  readonly level?: string;
  readonly base?: LogFields;
}

/** `pino` / `pino(options)` (apps inject their installed instance). */
export type PinoFactory = (options?: PinoOptionsLike) => PinoLoggerLike;

// Non-literal, widened to `string`: pino is OPTIONAL — a literal `import("pino")`
// would hard-fail tsc for every consumer that has not installed it.
const PINO_MODULE_ID: string = "pino";

async function loadPinoFactory(explicit?: PinoFactory): Promise<PinoFactory | undefined> {
  if (explicit !== undefined) {
    return explicit;
  }
  try {
    const loaded = (await import(PINO_MODULE_ID)) as unknown as { default?: unknown };
    const factory = loaded?.default;
    return typeof factory === "function" ? (factory as PinoFactory) : undefined;
  } catch {
    return undefined;
  }
}

/** Explicitly-requested backend could not be resolved — refuse to guess. */
export class LoggerSetupError extends Error {
  constructor(
    readonly code: "pino_unavailable",
    message: string,
  ) {
    super(`[obs/logger] ${message}`);
    this.name = "LoggerSetupError";
  }
}

// ---------------------------------------------------------------------------
// Logger surface
// ---------------------------------------------------------------------------

/** pino-style call shape: `log.info(fields, "msg")` or `log.info("msg")`. */
export interface ObsLogCall {
  (msg: string): void;
  (fields: LogFields, msg?: string): void;
}

/** Correlated logger — one child per request/run/step (§22). */
export interface ObsLogger {
  readonly backend: "pino" | "console";
  readonly level: LogLevel | "silent";
  child(bindings: CorrelationBindings): ObsLogger;
  readonly trace: ObsLogCall;
  readonly debug: ObsLogCall;
  readonly info: ObsLogCall;
  readonly warn: ObsLogCall;
  readonly error: ObsLogCall;
  readonly fatal: ObsLogCall;
}

export interface ObsLoggerOptions {
  /** Force a backend. "auto" (default): pino when resolvable, else console. */
  readonly backend?: "auto" | "pino" | "console";
  /** The app's installed pino (skips the dynamic-optional import). */
  readonly pinoModule?: PinoFactory;
  readonly level?: LogLevel | "silent";
  /** Env source for LOG_LEVEL (default process.env). */
  readonly env?: EnvSource;
  /** §15.3 workspace opt-in; default "redacted" (fail-closed). */
  readonly promptLogging?: PromptLoggingMode;
  /** Redaction keys; default DEFAULT_REDACT_KEYS (§22: prompt/content/body). */
  readonly redactKeys?: readonly string[];
  /** Base fields on every line (service, env…). Redacted once at creation. */
  readonly base?: LogFields;
  /** Line sink for the console backend (tests); default process.stdout. */
  readonly sink?: (line: string) => void;
}

/** Immutable per-logger state shared by children (children extend it). */
interface LoggerState {
  readonly mode: PromptLoggingMode;
  readonly redactKeys: readonly string[];
  readonly correlation: Record<string, string | number>;
  readonly base: LogFields;
}

const defaultSink = (line: string): void => {
  process.stdout.write(line);
};

/** Create a §22-correlated logger. Async: the pino probe is a dynamic import. */
export async function createObsLogger(options: ObsLoggerOptions = {}): Promise<ObsLogger> {
  const level = resolveLogLevel(options.level, options.env);
  const mode = options.promptLogging ?? "redacted";
  const redactKeys = options.redactKeys ?? DEFAULT_REDACT_KEYS;
  // Base is redacted ONCE here — §15.3 applies to boot-time fields too, and
  // child loggers then skip re-walking a (possibly large) static object.
  const base = redactDeep(options.base ?? {}, mode, redactKeys) as LogFields;
  const state: LoggerState = { mode, redactKeys, correlation: {}, base };
  const backend = options.backend ?? "auto";

  if (backend === "console") {
    return createConsoleLogger(state, level, options.sink ?? defaultSink);
  }
  const resolved =
    options.pinoModule !== undefined ? options.pinoModule : await loadPinoFactory();
  if (resolved === undefined) {
    if (backend === "pino") {
      throw new LoggerSetupError(
        "pino_unavailable",
        'backend "pino" requested but pino is not installed — pass pinoModule or use backend "auto"/"console"',
      );
    }
    return createConsoleLogger(state, level, options.sink ?? defaultSink);
  }
  const pinoLogger = resolved({ level, base });
  return createPinoLogger(state, level, pinoLogger);
}

function normalizeArgs(
  first: LogFields | string | undefined,
  second?: string,
): { fields: LogFields; msg: string | undefined } {
  if (typeof first === "string") {
    return { fields: {}, msg: first };
  }
  return { fields: first ?? {}, msg: second };
}

function createConsoleLogger(
  parent: LoggerState,
  level: LogLevel | "silent",
  sink: (line: string) => void,
  correlation: Record<string, string | number> = {},
): ObsLogger {
  const state: LoggerState = { ...parent, correlation };
  const threshold = level === SILENT_LEVEL ? Number.POSITIVE_INFINITY : LEVEL_VALUE[level];
  const call =
    (levelName: LogLevel): ObsLogCall =>
    (first: LogFields | string, second?: string) => {
      const { fields, msg } = normalizeArgs(first, second);
      if (LEVEL_VALUE[levelName] < threshold) {
        return;
      }
      const sanitized = redactDeep(fields, state.mode, state.redactKeys) as LogFields;
      const line: LogFields = {
        level: levelName,
        time: Date.now(),
        ...state.base,
        ...state.correlation,
        ...sanitized,
      };
      if (msg !== undefined) {
        line.msg = msg;
      }
      sink(`${JSON.stringify(line)}\n`);
    };
  return {
    backend: "console",
    level,
    child: (bindings) =>
      createConsoleLogger(state, level, sink, {
        ...state.correlation,
        ...correlationFields(bindings),
      }),
    trace: call("trace"),
    debug: call("debug"),
    info: call("info"),
    warn: call("warn"),
    error: call("error"),
    fatal: call("fatal"),
  };
}

function createPinoLogger(
  parent: LoggerState,
  level: LogLevel | "silent",
  pinoLogger: PinoLoggerLike,
  correlation: Record<string, string | number> = {},
): ObsLogger {
  const state: LoggerState = { ...parent, correlation };
  const call =
    (method: "trace" | "debug" | "info" | "warn" | "error" | "fatal"): ObsLogCall =>
    (first: LogFields | string, second?: string) => {
      const { fields, msg } = normalizeArgs(first, second);
      const sanitized = redactDeep(fields, state.mode, state.redactKeys) as LogFields;
      if (msg === undefined) {
        pinoLogger[method](sanitized);
      } else {
        pinoLogger[method](sanitized, msg);
      }
    };
  return {
    backend: "pino",
    level,
    child: (bindings) =>
      createPinoLogger(state, level, pinoLogger.child(correlationFields(bindings))),
    trace: call("trace"),
    debug: call("debug"),
    info: call("info"),
    warn: call("warn"),
    error: call("error"),
    fatal: call("fatal"),
  };
}
