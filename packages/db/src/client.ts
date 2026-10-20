/**
 * @studio/db — Postgres client factory (postgres-js driver + Drizzle).
 *
 * Spec anchors:
 *   §4    fail fast on a missing env var; never default a secret
 *   §12.2 tenant scoping lives in the repository layer — this module only connects
 *   §15.2  errors never leak stack traces, absolute paths or secret values
 *
 * The DATABASE_URL read is deliberately local and minimal (a tiny zod check):
 * drizzle-kit, the seed script and tests must resolve the URL without importing
 * @studio/config, which other build agents land in parallel — a cross-package
 * import here would make db tooling unbootable in isolation. App code still
 * parses its full environment through @studio/config and passes the resulting
 * URL to createDb().
 *
 * The Drizzle instance is intentionally schema-less (`drizzle(postgres())`):
 * wiring the relational `db.query.*` API would couple this module to
 * src/schema/* files that other build agents own (docs/AGENTS.md ownership).
 * Build typed queries from the table objects re-exported by ./index.js instead.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { z } from "zod";

/** Drizzle database bound to a lazy postgres-js pool (`Db` is what apps share). */
export type Db = ReturnType<typeof createDb>;

const EXAMPLE_URL = "postgres://studio:changeme@localhost:5432/studio";
const URL_HINT = `Set DATABASE_URL in .env (see .env.example), e.g. DATABASE_URL=${EXAMPLE_URL}`;

/** postgres-js accepts both schemes (.env.example uses postgres://). */
const PG_SCHEME = /^postgres(?:ql)?:\/\//i;

/**
 * Host portion of a connection string (everything after optional userinfo),
 * or undefined when the URL has no usable host. Pure string surgery so this
 * module does not depend on the WHATWG `URL` global (no DOM lib / node types).
 */
function hostOf(value: string): string | undefined {
  const schemeEnd = value.indexOf("://");
  if (schemeEnd === -1) {
    return undefined;
  }
  const rest = value.slice(schemeEnd + 3);
  const authority = (rest.split(/[/?#]/, 1)[0] ?? "").trim();
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  // A host token with an optional port — rejects bare ports, empty hosts and
  // junk; the driver gives the final verdict at connect time.
  return /^[a-z0-9._-]+(:\d+)?$/i.test(host) || host.startsWith("[") ? host : undefined;
}

const connectionStringSchema = z
  .string()
  .trim()
  .min(1, "connection string is empty")
  .refine((value) => PG_SCHEME.test(value), {
    message: "connection string must start with postgres:// or postgresql://",
  })
  .refine((value) => hostOf(value) !== undefined, {
    message: "connection string must include a host, e.g. postgres://user@localhost:5432/studio",
  });

export type DbConfigErrorCode = "db_url_missing" | "db_url_invalid" | "db_options_invalid";

/**
 * Boot-time configuration failure (§4 fail fast). Carries the envelope fields
 * of docs/AGENTS.md (`code` / `message` / `hint`) and never embeds the rejected
 * value, so logs stay secret-free (§15.2).
 */
export class DbConfigError extends Error {
  readonly code: DbConfigErrorCode;
  readonly hint: string;

  constructor(code: DbConfigErrorCode, message: string, hint: string) {
    super(message);
    this.name = "DbConfigError";
    this.code = code;
    this.hint = hint;
  }
}

/** Pure result of validating a DATABASE_URL-style connection string. */
export type ConnectionStringCheck =
  | { readonly ok: true; readonly url: string }
  | {
      readonly ok: false;
      readonly code: "db_url_missing" | "db_url_invalid";
      readonly message: string;
      readonly hint: string;
    };

/**
 * Validate a Postgres connection string without touching the network. Pure on
 * purpose: tests drive it table-driven (tests/client.test.ts).
 */
export function validateConnectionString(raw: string | null | undefined): ConnectionStringCheck {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (trimmed.length === 0) {
    return { ok: false, code: "db_url_missing", message: "DATABASE_URL is not set.", hint: URL_HINT };
  }
  const parsed = connectionStringSchema.safeParse(trimmed);
  if (parsed.success) {
    return { ok: true, url: parsed.data };
  }
  const detail = parsed.error.issues[0]?.message ?? "connection string is invalid";
  return {
    ok: false,
    code: "db_url_invalid",
    message: `DATABASE_URL is invalid: ${detail}.`,
    hint: URL_HINT,
  };
}

type ProcessEnv = Record<string, string | undefined>;

/**
 * Node's process env, read through globalThis so this module typechecks with
 * or without @types/node installed (it is not a repo dependency in W1).
 */
function currentEnv(): ProcessEnv {
  const proc = (globalThis as typeof globalThis & { process?: { env?: ProcessEnv } }).process;
  return proc?.env ?? {};
}

/**
 * Read and validate DATABASE_URL. Throws DbConfigError on any problem —
 * §4 fail fast; a missing URL must never be defaulted.
 */
export function readDatabaseUrl(env: ProcessEnv = currentEnv()): string {
  const check = validateConnectionString(env["DATABASE_URL"]);
  if (!check.ok) {
    throw new DbConfigError(check.code, check.message, check.hint);
  }
  return check.url;
}

/** Pool sizing options, postgres-js names (timeouts are in seconds). */
const poolOptionsSchema = z.object({
  /** Max connections in the pool. Default 10 — matches DATABASE_POOL_MAX in .env.example. */
  max: z.number().int().positive().max(1_000).default(10),
  /** Seconds before an idle connection is dropped. Default 30. */
  idle_timeout: z.number().int().positive().default(30),
  /** Seconds to wait for a connection attempt before failing. Default 10. */
  connect_timeout: z.number().int().positive().default(10),
});

export type CreateDbOptions = z.input<typeof poolOptionsSchema>;

/**
 * Create a Drizzle database on a lazy postgres-js pool — no connection is made
 * until the first query, so this is safe to call from tests. Throws
 * DbConfigError when the connection string or options are unusable (§4).
 */
export function createDb(connectionString: string, options: CreateDbOptions = {}): Db {
  const check = validateConnectionString(connectionString);
  if (!check.ok) {
    throw new DbConfigError(check.code, check.message, check.hint);
  }
  const pool = poolOptionsSchema.safeParse(options);
  if (!pool.success) {
    const detail = pool.error.issues[0]?.message ?? "unknown";
    throw new DbConfigError(
      "db_options_invalid",
      `Invalid database pool options: ${detail}.`,
      "Pass a max connection count and idle_timeout/connect_timeout in seconds.",
    );
  }
  return drizzle(postgres(check.url, pool.data));
}

const closed = new WeakSet<object>();

/**
 * Graceful close: end the underlying postgres-js pool, waiting up to
 * `timeoutSeconds` for in-flight queries before terminating. Idempotent —
 * a second call is a no-op (postgres-js would otherwise complain).
 */
export async function closeDb(db: Db, timeoutSeconds = 5): Promise<void> {
  if (closed.has(db)) {
    return;
  }
  closed.add(db);
  await db.$client.end({ timeout: timeoutSeconds });
}
