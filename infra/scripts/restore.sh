#!/usr/bin/env bash
# =============================================================================
# infra/scripts/restore.sh — restore a pg_dump backup (spec §17.4)
# =============================================================================
# §17.4 runbook: backup/restore is a REAL, TESTED path — restore drills with
# RTO ≤ 4 h, tested MONTHLY (not "tested" once and forgotten). This script IS
# the drill. Record the actual RTO after every run.
#
# Usage:
#   infra/scripts/restore.sh <backup file> [database]
#   <backup file>  local .dump.gz path OR s3:// URI (fetched via awscli;
#                  AWS credentials come from the environment only)
#   [database]     target DB name (default: $POSTGRES_DB from ../../.env)
#
# Safety rails:
#   * Interactive confirmation — you must TYPE the target database name.
#   * Writers (gateway/worker/engine-pool/web) are stopped first; on success
#     they are brought back automatically. On restore FAILURE they stay
#     stopped (the DB is empty/partial — an explicit human decision, §17.4).
#   * Runbook pointer: §17.4 (backup/restore). NEVER test on production
#     first (§17.5) — drill against a scratch DB or the staging project.
#
# No secrets inline (§15.2): the restore runs inside the db container as the
# local superuser ($POSTGRES_USER), like backup.sh — no password crosses argv.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/../../.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$SCRIPT_DIR/../compose/docker-compose.yml}"
compose() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

# env_get KEY — read one var from $ENV_FILE without sourcing it (same rule as
# backup.sh: .env content never reaches a shell parser).
env_get() {
  grep -m1 -E "^$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- \
    | sed -e 's/^"//g' -e 's/"$//g' -e "s/^'//g" -e "s/'\$//g" || true
}

POSTGRES_USER="${POSTGRES_USER:-$(env_get POSTGRES_USER)}"; POSTGRES_USER="${POSTGRES_USER:-studio}"
POSTGRES_DB="${POSTGRES_DB:-$(env_get POSTGRES_DB)}"; POSTGRES_DB="${POSTGRES_DB:-studio}"
WRITERS="gateway worker engine-pool web"

log() { printf '[restore] %s %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
die() { log "FATAL: $*"; exit 1; }

[ "$#" -ge 1 ] || die "usage: $0 <backup file|s3:// URI> [database]"
SRC="$1"
DB_NAME="${2:-$POSTGRES_DB}"
[ -r "$ENV_FILE" ] || die "env file not readable: $ENV_FILE"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# --- fetch (s3:// handled transparently, creds from env only) ----------------
if [ "${SRC#s3://}" != "$SRC" ]; then
  command -v aws >/dev/null 2>&1 || die "awscli required for s3:// sources (credentials from env only)"
  aws s3 cp --only-show-errors "$SRC" "$TMP_DIR/backup.dump.gz" \
    || die "could not fetch $SRC"
  SRC="$TMP_DIR/backup.dump.gz"
fi
[ -r "$SRC" ] || die "backup file not readable: $SRC"
gzip -t "$SRC" || die "gzip integrity check failed on $SRC — do not proceed"
SRC_ABS="$(cd "$(dirname "$SRC")" && pwd)/$(basename "$SRC")"
log "source ok: $SRC_ABS ($(du -h "$SRC_ABS" | cut -f1))"

# --- confirmation (§17.4: drills are deliberate acts) ----------------------
cat >&2 <<EOF
  ============================================================
  RESTORE  — target DB:  ${DB_NAME}
  source:  ${SRC_ABS}
  Writes will be stopped: ${WRITERS}
  Downtime starts at confirmation — this is your RTO clock (§17.4).
  Runbook: spec §17.4 (backup/restore; RTO ≤ 4 h, drill monthly).
  ============================================================
EOF
read -r -p "Type the target database name (${DB_NAME}) to continue: " CONFIRM
[ "$CONFIRM" = "$DB_NAME" ] || die "confirmation mismatch — aborted, nothing touched"

RTO_START="$(date +%s)"
log "stopping writers: $WRITERS"
compose stop $WRITERS >/dev/null

# --- recreate the target DB (clean slate; forward-only migrations §4) -------
compose exec -T db psql -U "$POSTGRES_USER" -d postgres \
  -v "ON_ERROR_STOP=1" \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DB_NAME}' AND pid <> pg_backend_pid();" \
  -c "DROP DATABASE IF EXISTS \"${DB_NAME}\";" \
  -c "CREATE DATABASE \"${DB_NAME}\";"

# --- restore (inverse of backup.sh: gunzip → pg_restore) -------------------
if ! gunzip -c "$SRC_ABS" \
  | compose exec -T db pg_restore -U "$POSTGRES_USER" --dbname "$DB_NAME" --no-owner; then
  die "pg_restore failed — the DB is empty/partial and writers are left STOPPED (deliberate, §17.4).
  Inspect, then either retry or bring the stack back with:
    docker compose --env-file ../../.env up -d $WRITERS"
fi

# --- sanity check ------------------------------------------------------------
compose exec -T db psql -U "$POSTGRES_USER" -d "$DB_NAME" -v "ON_ERROR_STOP=1" -tAc \
  "SELECT 'restored public-schema objects: ' || count(*) FROM information_schema.tables WHERE table_schema='public'" >&2

# --- back online -------------------------------------------------------------
log "restore ok — bringing writers back up: $WRITERS"
compose up -d $WRITERS >/dev/null

RTO_SECS=$(( $(date +%s) - RTO_START ))
log "restore complete — recorded RTO: ${RTO_SECS}s (log it with the drill date, §17.4)."
log "next: rerun migrations if the backup predates head (packages/db, forward-only), then smoke:"
log "  curl https://\${APP_DOMAIN}/v1/health      (liveness, §13)"
log "  curl https://\${APP_DOMAIN}/v1/health/deep (dependencies, must be 200)"
log "reminder: nightly automated restore tests into a scratch DB run in CI (§17.3)."
