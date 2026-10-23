#!/usr/bin/env bash
# scripts/dev-sqlite.sh — PG-free local dev database (W1-03: "add sqlite for
# dev server"). Postgres stays the control plane for staging/production and
# the full DB-gated test suite (scripts/dev-postgres.sh); this script is the
# zero-dependency alternative for local development on hosts with no Docker
# and no running PostgreSQL.
#
# Maintains a SQLite file at <repo>/.local/studio-dev.db (gitignored under
# .local/) through the dual-dialect @studio/db seam (createDb file:/sqlite:
# dialect switch + isSqliteUrl + bootstrapSqlite + tablesFor — task W1-02/W3-A):
#   * `start` bootstraps the control-plane schema and runs the demo seed
#     (packages/db/scripts/seed.ts via DATABASE_URL), both idempotently —
#     re-running start is always safe.
#   * The seed is sqlite-aware end-to-end since W3-A (tablesFor twin tables,
#     dialect-aware teardown); a failure is still a WARNING, not fatal — the
#     schema is bootstrapped and the dev server works without demo rows.
#
# Only Node built-ins are used on the client side: node:sqlite (DatabaseSync,
# Node >= 22.5) reads/inspects the file — no sqlite3 CLI, no native npm module.
#
# Usage:
#   scripts/dev-sqlite.sh start        # ensure file + bootstrap schema + seed
#   scripts/dev-sqlite.sh reset        # delete the dev file, then start fresh
#   scripts/dev-sqlite.sh status       # file + tables + row counts; exit 3 if absent
#   scripts/dev-sqlite.sh dump-schema  # print the CREATE TABLE/INDEX statements
# Env overrides: STUDIO_SQLITE_DB (file path), STUDIO_SQLITE_URL (full file: URL)
#
# Then run the gateway against it (env validation accepts file: URLs in local):
#   DATABASE_URL=file:<repo>/.local/studio-dev.db corepack pnpm dev:gateway
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_PATH="${STUDIO_SQLITE_DB:-$REPO_ROOT/.local/studio-dev.db}"
DB_URL="${STUDIO_SQLITE_URL:-file:$DB_PATH}"
DB_PKG="$REPO_ROOT/packages/db"
export STUDIO_SQLITE_URL="$DB_URL"
export W1_SQLITE_PATH="$DB_PATH"

log()  { printf 'dev-sqlite: %s\n' "$*" >&2; }
die()  { printf 'dev-sqlite: ERROR: %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,36p' "${BASH_SOURCE[0]}" >&2; exit 2; }

# ── inline node runners ──────────────────────────────────────────────────────
# Plain node:sqlite one-liners (no workspace imports). node:sqlite is a
# built-in on the Node this repo requires (>= 22), so there is no sqlite3 CLI
# or native npm dependency on the host.
sql_node() {
  node --input-type=module -e "$1"
}

# tsx one-liners that import the TypeScript @studio/db sources. cwd is
# packages/db so the self-referencing "@studio/db" package export resolves
# (its node_modules has tsx; --import tsx loads the TS loader).
db_node() {
  ( cd "$DB_PKG" && node --import tsx --input-type=module -e "$1" )
}

# ── schema bootstrap via the @studio/db seam ─────────────────────────────────
BOOTSTRAP_JS='
const url = process.env.STUDIO_SQLITE_URL ?? "";
const mod = await import("@studio/db");
const missing = ["createDb", "isSqliteUrl", "bootstrapSqlite"].filter(
  (k) => typeof mod[k] !== "function",
);
if (missing.length > 0) {
  console.error(
    "dev-sqlite: the @studio/db sqlite seam is missing exports: " +
      missing.join(", ") +
      " (packages/db is owned by task W1-02). Nothing was changed. Pull the latest main and retry once that seam lands.",
  );
  process.exit(2);
}
if (!mod.isSqliteUrl(url)) {
  console.error(
    "dev-sqlite: @studio/db isSqliteUrl() rejected the configured URL. Set STUDIO_SQLITE_URL to a file: or sqlite: URL.",
  );
  process.exit(2);
}
const db = mod.createDb(url);
let form = "url";
try {
  await mod.bootstrapSqlite(url);
} catch (e1) {
  if (!(e1 instanceof TypeError)) throw e1;
  // The seam takes the db handle, not the URL (TypeError = wrong arg shape).
  form = "handle";
  await mod.bootstrapSqlite(db);
}
console.log("dev-sqlite: bootstrap ok (bootstrapSqlite(" + form + "))");
'

bootstrap() {
  local existed=0
  [ -f "$DB_PATH" ] && existed=1
  if ! db_node "$BOOTSTRAP_JS"; then
    if [ "$existed" = "1" ]; then
      die "bootstrap failed on the existing dev file — run 'scripts/dev-sqlite.sh reset' to recreate it from scratch"
    fi
    die "bootstrap failed on a fresh file (see the error above)"
  fi
}

# The demo seed is the regular packages/db seed script, pointed at the sqlite
# URL. It is idempotent by design; a failure is a WARNING, not fatal — the
# schema is already bootstrapped and the dev server works without demo rows.
#
# pnpm resolution (W3-A): this box ships pnpm ONLY through corepack, so a bare
# `pnpm` is missing from PATH. Prefer a real pnpm if the host has one; fall
# back to `corepack pnpm` (pinned by the repo's packageManager field).
seed() {
  local pnpm_cmd
  pnpm_cmd="$(command -v pnpm || true)"
  if [ -z "$pnpm_cmd" ]; then
    pnpm_cmd="corepack pnpm"
  fi
  if DATABASE_URL="$DB_URL" $pnpm_cmd --filter @studio/db seed; then
    log "seed ok (demo user demo@studio.test, demo workspace/project, 1000 credits)"
  else
    log "WARNING: the demo seed failed on sqlite — the schema is bootstrapped and"
    log "the dev server works without demo data (see the seed output above for"
    log "the failing step; the seed is sqlite-aware since W3-A, so this is a bug)."
  fi
}

# ── commands ────────────────────────────────────────────────────────────────
start() {
  mkdir -p "$(dirname "$DB_PATH")"
  bootstrap
  seed
  log "ready: $DB_URL"
  log "for your .env:  DATABASE_URL=$DB_URL   (accepted because APP_ENV=local)"
}

reset() {
  rm -f "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm"
  log "deleted $DB_PATH"
  start
}

status() {
  if [ ! -f "$DB_PATH" ]; then
    log "no dev database at $DB_PATH (run scripts/dev-sqlite.sh start)"
    exit 3
  fi
  sql_node '
const { DatabaseSync } = await import("node:sqlite");
const { statSync } = await import("node:fs");
const Q = "\u0027"; // SQL string-literal quote (bash keeps this block single-quoted)
const path = process.env.W1_SQLITE_PATH ?? "";
console.log("file: " + path + " (" + statSync(path).size + " bytes)");
const db = new DatabaseSync(path);
const tables = db
  .prepare(
    "select name from sqlite_master where type = " +
      Q + "table" + Q +
      " and name not like " +
      Q + "sqlite_%" + Q +
      " order by name",
  )
  .all()
  .map((r) => r.name);
console.log("tables (" + tables.length + "): " + tables.join(", "));
let total = 0;
for (const t of tables) {
  const row = db.prepare("select count(*) as c from \"" + t + "\"").get();
  total += row.c;
}
console.log("rows across all tables: " + total);
db.close();
' || die "file exists but is not a readable sqlite database — run scripts/dev-sqlite.sh reset"
  log "DATABASE_URL=$DB_URL"
}

dump_schema() {
  [ -f "$DB_PATH" ] || die "no dev database yet — run scripts/dev-sqlite.sh start first"
  sql_node '
const { DatabaseSync } = await import("node:sqlite");
const Q = "\u0027"; // SQL string-literal quote (bash keeps this block single-quoted)
const db = new DatabaseSync(process.env.W1_SQLITE_PATH ?? "");
const rows = db
  .prepare(
    "select sql from sqlite_master where sql is not null and name not like " +
      Q + "sqlite_%" + Q +
      " order by type desc, name",
  )
  .all();
for (const r of rows) console.log(r.sql + ";");
db.close();
' || die "could not read the schema — is $DB_PATH a valid sqlite database?"
}

cmd="${1:-}"; shift || true
case "$cmd" in
  start)       start ;;
  reset)       reset ;;
  status)      status ;;
  dump-schema) dump_schema ;;
  *)           usage ;;
esac
