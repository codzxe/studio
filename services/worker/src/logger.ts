// @studio/worker — structured JSON logger (mirrors the gateway's §14 logger:
// one JSON object per line, fixed message constants, allow-listed fields,
// accidental secret values redacted against @studio/config's SECRET list).

import { type LogLevel, SECRET_ENV_VARS, type StudioEnv } from "@studio/config";

export type WorkerLogFields = Record<string, string | number | boolean | null | undefined>;

export interface WorkerLogger {
  debug(msg: string, fields?: WorkerLogFields): void;
  info(msg: string, fields?: WorkerLogFields): void;
  warn(msg: string, fields?: WorkerLogFields): void;
  error(msg: string, fields?: WorkerLogFields): void;
}

const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export function createWorkerLogger(
  env: Pick<StudioEnv, "app">,
  secretValues: readonly string[] = [],
): WorkerLogger {
  const threshold = LEVELS.indexOf(env.app.logLevel === "error" ? "error" : env.app.logLevel);
  const redactions =
    secretValues.length > 0
      ? secretValues
      : SECRET_ENV_VARS.map((name) => process.env[name]).filter(
          (v): v is string => typeof v === "string" && v.length >= 8,
        );

  const write = (level: LogLevel, msg: string, fields: WorkerLogFields): void => {
    if (LEVELS.indexOf(level) < threshold) return;
    const line: Record<string, unknown> = { ts: new Date().toISOString(), level, msg };
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      line[key] = typeof value === "string" ? redact(value) : value;
    }
    try {
      process.stdout.write(`${JSON.stringify(line)}\n`);
    } catch {
      // logging must never take the process down
    }
  };

  const redact = (text: string): string => {
    let out = text;
    for (const secret of redactions) {
      if (out.includes(secret)) out = out.split(secret).join("«redacted»");
    }
    return out;
  };

  return {
    debug: (msg, fields) => write("debug", msg, fields ?? {}),
    info: (msg, fields) => write("info", msg, fields ?? {}),
    warn: (msg, fields) => write("warn", msg, fields ?? {}),
    error: (msg, fields) => write("error", msg, fields ?? {}),
  };
}

/** Silent logger for tests and library use. */
export const nullLogger: WorkerLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Recording logger — integration tests assert on the emitted events. */
export function recordingLogger(): WorkerLogger & {
  readonly lines: readonly { level: string; msg: string }[];
} {
  const lines: { level: string; msg: string }[] = [];
  const make = (level: string) => (msg: string) => {
    lines.push({ level, msg });
  };
  return {
    debug: make("debug"),
    info: make("info"),
    warn: make("warn"),
    error: make("error"),
    get lines() {
      return lines;
    },
  };
}
