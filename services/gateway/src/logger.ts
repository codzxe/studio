// @studio/gateway — structured JSON logger (§7.1, §12.3, §14).
//
// One JSON object per line to stdout. Never logs request bodies, prompts,
// or secrets: message text is a fixed constant and fields are allow-listed
// identifiers. If a secret env value ever reaches a field it is redacted
// against @studio/config's SECRET_ENV_VARS list.

import { type LogLevel, SECRET_ENV_VARS, type StudioEnv } from "@studio/config";

export type LogFields = Record<string, string | number | boolean | null | undefined>;

const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(base: LogFields): Logger;
}

export function createLogger(
  env: Pick<StudioEnv, "app">,
  secretValues: readonly string[] = [],
): Logger {
  const threshold = LEVELS.indexOf(env.app.logLevel === "error" ? "error" : env.app.logLevel);
  // Real secret values from this process's env, for redaction of accidental leaks.
  const redactions =
    secretValues.length > 0
      ? secretValues
      : SECRET_ENV_VARS.map((name) => process.env[name]).filter(
          (v): v is string => typeof v === "string" && v.length >= 8,
        );

  const write = (level: LogLevel, msg: string, fields: LogFields): void => {
    if (LEVELS.indexOf(level) < threshold) return;
    const line: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg,
    };
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

  function redact(text: string): string {
    let out = text;
    for (const secret of redactions) {
      if (out.includes(secret)) out = out.split(secret).join("«redacted»");
    }
    return out;
  }

  const make = (base: LogFields): Logger => ({
    debug: (msg, fields) => write("debug", msg, { ...base, ...fields }),
    info: (msg, fields) => write("info", msg, { ...base, ...fields }),
    warn: (msg, fields) => write("warn", msg, { ...base, ...fields }),
    error: (msg, fields) => write("error", msg, { ...base, ...fields }),
    child: (extra) => make({ ...base, ...extra }),
  });

  return make({});
}

/** Silent logger for tests and library use. */
export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};
