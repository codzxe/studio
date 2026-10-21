#!/usr/bin/env bash
# scripts/dev-postgres.sh — portable PostgreSQL 17 for hosts with NO Docker and
# NO sudo (BUILD_PLAN M0 task 5: "Local environment without Docker").
#
# Downloads a prebuilt binary distribution into <repo>/.local/pg (gitignored),
# runs initdb with PASSWORD auth (scram-sha-256 — mirrors production; never
# trust), starts the server via pg_ctl on 127.0.0.1:5432 and creates the
# `studio` database. Fully idempotent: re-running start is always safe.
#
# Download sources, in probe order (first HTTP 200 wins; see SOURCE notes):
#   1. EDB binaries (task-named canonical URL)
#      https://get.enterprisedb.com/postgresql/postgresql-17.6-1-linux-x64-binaries.tar.gz
#      PROBED 2026-10-21 → 403 AccessDenied for every 17.x build: EDB stopped
#      publishing Linux binary archives (their download page now lists only
#      Windows/macOS). Kept first so the script auto-heals if they return, but
#      expect source 2 on Linux today.
#   2. theseus-rs/postgresql-binaries 17.5.1 (WORKING — verified in-sandbox;
#      full toolset incl. psql, bundled libssl/libicu, SLSA provenance)
#      https://github.com/theseus-rs/postgresql-binaries/releases/download/17.5.1/postgresql-17.5.1-x86_64-unknown-linux-gnu.tar.gz
#   3. zonky embedded-postgres-binaries 17.6.0 (Maven Central; self-contained
#      but SERVER-ONLY — no psql; the system psql is used instead)
#      https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-linux-amd64/17.6.0/embedded-postgres-binaries-linux-amd64-17.6.0.jar
#
# Override the download with PG_TARBALL_URL=<url> (tar.gz layout like EDB/pgsql
# or theseus, or a zonky-style .jar containing postgres-*.txz).
#
# Usage:
#   scripts/dev-postgres.sh start     # install (if needed) + init + start + createdb
#   scripts/dev-postgres.sh stop      # fast shutdown (idempotent)
#   scripts/dev-postgres.sh restart
#   scripts/dev-postgres.sh status    # exit 0 running / 3 stopped
#   scripts/dev-postgres.sh install   # download only
#   scripts/dev-postgres.sh psql ...  # psql against the dev database
# Env overrides: PG_PORT PG_USER PG_PASSWORD PG_DB PG_HOME PG_TARBALL_URL
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_HOME="${PG_HOME:-$REPO_ROOT/.local/pg}"
PGDATA="$PG_HOME/data"
PG_LOG_DIR="$PG_HOME/log"
PG_LOG="$PG_LOG_DIR/postgres.log"
PG_HOST="127.0.0.1"
PG_PORT="${PG_PORT:-5432}"
PG_USER="${PG_USER:-studio}"
PG_PASSWORD="${PG_PASSWORD:-studio}"
PG_DB="${PG_DB:-studio}"
PG_HOME_BIN="$PG_HOME/bin"

THESEUS_VERSION="17.5.1"   # latest 17.x published by theseus-rs (verified working)
ZONKY_VERSION="17.6.0"      # zonky tracks upstream minors separately

log()  { printf 'dev-postgres: %s\n' "$*" >&2; }
die()  { printf 'dev-postgres: ERROR: %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,40p' "${BASH_SOURCE[0]}" >&2; exit 2; }

# ── platform ────────────────────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS-$ARCH" in
  Linux-x86_64)  THESEUS_TRIPLET="x86_64-unknown-linux-gnu";  ZONKY_ART="embedded-postgres-binaries-linux-amd64";  EDB_NAME="linux-x64" ;;
  Linux-aarch64) THESEUS_TRIPLET="aarch64-unknown-linux-gnu"; ZONKY_ART="embedded-postgres-binaries-linux-aarch64"; EDB_NAME="" ;;
  Darwin-arm64)  THESEUS_TRIPLET="aarch64-apple-darwin";      ZONKY_ART="" ;                                        EDB_NAME="" ;;
  Darwin-*)      die "macOS Intel: use 'brew install postgresql@17' or set PG_TARBALL_URL (apple-darwin x86_64 builds exist on theseus-rs)." ;;
  *)             die "unsupported platform: $OS $ARCH" ;;
esac

candidate_urls() {
  if [ -n "${PG_TARBALL_URL:-}" ]; then
    printf '%s\n' "$PG_TARBALL_URL"
    return
  fi
  # 1. EDB (see header note). 2. theseus (full toolset). 3. zonky (server-only).
  if [ -n "$EDB_NAME" ]; then
    printf 'https://get.enterprisedb.com/postgresql/postgresql-17.6-1-%s-binaries.tar.gz\n' "$EDB_NAME"
  fi
  printf 'https://github.com/theseus-rs/postgresql-binaries/releases/download/%s/postgresql-%s-%s.tar.gz\n' \
    "$THESEUS_VERSION" "$THESEUS_VERSION" "$THESEUS_TRIPLET"
  if [ -n "$ZONKY_ART" ]; then
    printf 'https://repo1.maven.org/maven2/io/zonky/test/postgres/%s/%s/%s-%s.jar\n' \
      "$ZONKY_ART" "$ZONKY_VERSION" "$ZONKY_ART" "$ZONKY_VERSION"
  fi
}

url_works() { curl -fsIL --max-time 20 -o /dev/null "$1" 2>/dev/null; }

# ── install ─────────────────────────────────────────────────────────────────
install_pg() {
  if [ -x "$PG_HOME_BIN/postgres" ]; then
    log "already installed at $PG_HOME ($( "$PG_HOME_BIN/postgres" --version 2>/dev/null || echo postgres ))"
    [ -f "$PG_HOME/SOURCE.txt" ] && log "source: $(sed -n 1p "$PG_HOME/SOURCE.txt")"
    return 0
  fi
  command -v curl >/dev/null 2>&1 || die "curl is required to download PostgreSQL"
  local url=""
  while IFS= read -r candidate; do
    if url_works "$candidate"; then url="$candidate"; break; fi
    log "probed (unavailable): $candidate"
  done < <(candidate_urls)
  [ -n "$url" ] || die "no downloadable PostgreSQL 17 binary distribution reachable — see header of this script for a direct URL, or set PG_TARBALL_URL"

  mkdir -p "$PG_HOME" "$PG_LOG_DIR"
  local tmp="$PG_HOME/.download"
  rm -rf "$tmp"; mkdir -p "$tmp"
  local archive="$tmp/dl.tar.gz"
  log "downloading $(basename "$url") …"
  curl -fSL --retry 3 --connect-timeout 15 -o "$archive" "$url" || die "download failed: $url"
  [ "$(wc -c < "$archive")" -gt 1000000 ] || die "download suspiciously small (<1MB): $url"

  # sha256 verification when the source publishes one (theseus does).
  if [[ "$url" == *"github.com/theseus-rs/"* ]]; then
    if curl -fsSL --retry 2 --max-time 60 -o "$tmp/dl.sha256" "$url.sha256"; then
      ( cd "$tmp" && cp dl.tar.gz "$( awk '{print $2}' dl.sha256 )" && sha256sum -c dl.sha256 >/dev/null ) \
        || die "sha256 mismatch for $url — delete $PG_HOME and retry"
      log "sha256 verified"
    fi
  fi

  log "extracting …"
  case "$archive" in
    *.jar)
      command -v unzip >/dev/null 2>&1 || die "unzip is required for the zonky .jar distribution"
      unzip -q "$archive" -d "$tmp/jar"
      local inner
      inner="$(find "$tmp/jar" -name 'postgres-*.txz' -print -quit)"
      [ -n "$inner" ] || die "no postgres-*.txz inside the downloaded jar"
      command -v xz >/dev/null 2>&1 || die "xz/tar with xz support is required"
      mkdir -p "$tmp/x" && tar -xJf "$inner" -C "$tmp/x"
      ;;
    *)
      mkdir -p "$tmp/x" && tar -xzf "$archive" -C "$tmp/x"
      ;;
  esac

  # Normalize: find the extracted directory that actually holds bin/postgres
  # (EDB → pgsql/, theseus → postgresql-<ver>-<triplet>/, zonky → ./).
  local pgbinary root d
  pgbinary="$(find "$tmp/x" -type f -path '*/bin/postgres' -print -quit)"
  [ -n "$pgbinary" ] || die "downloaded archive has no bin/postgres (unexpected layout)"
  root="$(cd "$(dirname "$(dirname "$pgbinary")")" && pwd)"
  for d in bin lib share include; do
    [ -d "$root/$d" ] && mv "$root/$d" "$PG_HOME/"
  done
  printf 'url: %s\nsha256: %s\ndate: %s\n' \
    "$url" "$(sha256sum "$archive" | awk '{print $1}')" "$(date -u +%FT%TZ)" > "$PG_HOME/SOURCE.txt"
  rm -rf "$tmp"
  chmod -R go-rwx "$PGDATA" 2>/dev/null || true

  check_deps
  log "installed: $($PG_HOME_BIN/postgres --version) from $(basename "$url")"
}

# Report unresolved shared libraries clearly (EDB links the system libicu/libssl).
check_deps() {
  command -v ldd >/dev/null 2>&1 || { log "ldd not found — skipping dependency check"; return 0; }
  local missing
  missing="$(ldd "$PG_HOME_BIN/postgres" 2>/dev/null | awk '/not found/ {print $1}' | sort -u || true)"
  if [ -n "$missing" ]; then
    log "the downloaded PostgreSQL needs system libraries that are missing:"
    printf '    %s\n' $missing >&2
    log "install them, e.g. Debian/Ubuntu: sudo apt install libicu72 libssl3   Fedora: sudo dnf install libicu libssl   Alpine: apk add icu-libs openssl"
    log "or rerun with PG_TARBALL_URL pointing at a self-contained build (default theseus/zonky builds bundle libssl+libicu)"
    die "cannot run postgres until the libraries above are present"
  fi
}

# ── cluster init ────────────────────────────────────────────────────────────
init_cluster() {
  if [ -f "$PGDATA/PG_VERSION" ]; then return 0; fi
  mkdir -p "$PGDATA" "$PG_LOG_DIR"
  chmod 700 "$PGDATA" 2>/dev/null || true
  local pwfile="$PG_HOME/.pwfile"
  umask 077
  printf '%s' "$PG_PASSWORD" > "$pwfile"
  log "initdb: creating cluster for user '$PG_USER' with scram-sha-256 password auth (mirrors production)"
  # -A scram-sha-256 → pg_hba uses password auth for host AND local connections.
  "$PG_HOME_BIN/initdb" -D "$PGDATA" -U "$PG_USER" --pwfile="$pwfile" \
    -A scram-sha-256 -E UTF8 > "$PG_LOG_DIR/initdb.log" 2>&1 \
    || { rm -f "$pwfile"; die "initdb failed — see $PG_LOG_DIR/initdb.log"; }
  rm -f "$pwfile"
  {
    printf '# added by scripts/dev-postgres.sh\n'
    printf "listen_addresses = '%s'\n" "$PG_HOST"
    printf 'port = %s\n' "$PG_PORT"
    printf "unix_socket_directories = '%s'\n" "$PG_HOME"
  } >> "$PGDATA/postgresql.conf"
  log "cluster created at $PGDATA"
}

is_running() { "$PG_HOME_BIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; }

# Portable psql/createdb/pg_isready — the zonky fallback distribution ships
# ONLY initdb/pg_ctl/postgres; client tools then come from the system PATH.
psql_bin() {
  if [ -x "$PG_HOME_BIN/psql" ]; then printf '%s\n' "$PG_HOME_BIN/psql"; return 0; fi
  command -v psql >/dev/null 2>&1 && { command -v psql; return 0; }
  return 1
}
createdb_bin() {
  if [ -x "$PG_HOME_BIN/createdb" ]; then printf '%s\n' "$PG_HOME_BIN/createdb"; return 0; fi
  command -v createdb >/dev/null 2>&1 && { command -v createdb; return 0; }
  return 1
}
pg_isready_bin() {
  if [ -x "$PG_HOME_BIN/pg_isready" ]; then printf '%s\n' "$PG_HOME_BIN/pg_isready"; return 0; fi
  command -v pg_isready >/dev/null 2>&1 && { command -v pg_isready; return 0; }
  return 1
}

ensure_db() {
  export PGPASSWORD="$PG_PASSWORD" # never prompt: password auth everywhere
  local psql createdb exists
  if ! psql="$(psql_bin)"; then
    log "WARNING: no psql available (zonky distribution is server-only) — database '$PG_DB' NOT auto-created; run: createdb -h $PG_HOST -p $PG_PORT -U $PG_USER $PG_DB"
    return 0
  fi
  exists="$("$psql" -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname = '$PG_DB'" 2>/dev/null || true)"
  if [ "$exists" != "1" ]; then
    if ! createdb="$(createdb_bin)"; then
      log "WARNING: no createdb — create '$PG_DB' via: $psql -h $PG_HOST -U $PG_USER -d postgres -c \"CREATE DATABASE $PG_DB;\""
      return 0
    fi
    "$createdb" -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" "$PG_DB" \
      || die "createdb $PG_DB failed"
    log "database '$PG_DB' created"
  else
    log "database '$PG_DB' already exists"
  fi
}

wait_ready() {
  local ready i
  ready="$(pg_isready_bin)" || { log "no pg_isready — relying on pg_ctl -w (it already waited for startup)"; return 0; }
  for i in $(seq 1 30); do
    if "$ready" -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

start() {
  install_pg
  init_cluster
  if is_running; then
    log "already running (pid $(head -1 "$PGDATA/postmaster.pid" 2>/dev/null || echo '?'))"
  else
    local ready
    if ready="$(pg_isready_bin)" && "$ready" -h "$PG_HOST" -p "$PG_PORT" >/dev/null 2>&1; then
      die "something is already answering on $PG_HOST:$PG_PORT but it is not this cluster (system PostgreSQL?). Stop it or set PG_PORT."
    fi
    log "starting postgres on $PG_HOST:$PG_PORT (log: $PG_LOG)"
    "$PG_HOME_BIN/pg_ctl" -D "$PGDATA" -l "$PG_LOG" \
      -o "-h $PG_HOST -p $PG_PORT" -w -t 90 start \
      || die "postgres failed to start — last log lines:\n$(tail -20 "$PG_LOG" 2>/dev/null)"
    wait_ready || die "postgres did not become ready within 30s — see $PG_LOG"
  fi
  ensure_db
  log "ready: postgresql://$PG_USER:***@$PG_HOST:$PG_PORT/$PG_DB  (DATABASE_URL=postgres://$PG_USER:$PG_PASSWORD@$PG_HOST:$PG_PORT/$PG_DB)"
}

stop() {
  if is_running; then
    "$PG_HOME_BIN/pg_ctl" -D "$PGDATA" -m fast -w stop
    log "stopped"
  else
    log "not running (nothing to do)"
  fi
}

status() {
  if ! is_running; then
    log "not running"
    exit 3
  fi
  "$PG_HOME_BIN/pg_ctl" -D "$PGDATA" status
  local ready
  ready="$(pg_isready_bin)" && "$ready" -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER"
  log "DATABASE_URL=postgres://$PG_USER:$PG_PASSWORD@$PG_HOST:$PG_PORT/$PG_DB"
}

cmd="${1:-}"; shift || true
case "$cmd" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; start ;;
  status)  status ;;
  install) install_pg ;;
  psql)
    [ -x "$PG_HOME_BIN/postgres" ] || install_pg
    if ! psql_tool="$(psql_bin)"; then
      die "no psql available (the zonky distribution ships none) — install postgresql-client or rerun with a full binary set"
    fi
    export PGPASSWORD="$PG_PASSWORD"
    exec "$psql_tool" -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" "$@"
    ;;
  *)       usage ;;
esac
