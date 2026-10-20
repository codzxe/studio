#!/usr/bin/env bash
# =============================================================================
# infra/scripts/backup.sh — daily pg_dump → gzip → S3 (spec §17.1/§17.4)
# =============================================================================
# What: custom-format logical backup of the app Postgres, gzipped, uploaded
# to the VERSIONED backup bucket (S3_BACKUP_BUCKET, versioning + lifecycle
# policy handle retention — see RETENTION note at the bottom). A .sha256
# sidecar ships next to every dump.
#
# RPO: ≤ 24 h → cron this daily (example: `0 3 * * *` UTC).
#     0 3 * * *  /srv/studio/infra/scripts/backup.sh >> /var/log/studio-backup.log 2>&1
#
# Credentials: ONLY from the environment (AWS_* / ~/.aws profile) — this
# script never reads, echoes or inlines secrets (§15.2). No DATABASE_URL
# either: the dump runs inside the db container via pg_isready-known local
# trust, so the password never crosses the command line.
#
# Exit codes: 0 success (uploaded or, without a bucket, kept locally);
# non-zero = backup FAILED — treat as a paging incident (§17.4: this is the
# only data you cannot lose).
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/../../.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$SCRIPT_DIR/../compose/docker-compose.yml}"

# canonical invocation: interpolation + env_file both read ../../.env
compose() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

# env_get KEY — read one var from $ENV_FILE without sourcing it (never let
# .env content hit a shell parser; values are plain or quoted KEY=VALUE).
env_get() {
  grep -m1 -E "^$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- \
    | sed -e 's/^"//g' -e 's/"$//g' -e "s/^'//g" -e "s/'\$//g" || true
}

# precedence: shell env (cron may export) → ../../.env → safe default
POSTGRES_USER="${POSTGRES_USER:-$(env_get POSTGRES_USER)}"; POSTGRES_USER="${POSTGRES_USER:-studio}"
POSTGRES_DB="${POSTGRES_DB:-$(env_get POSTGRES_DB)}"; POSTGRES_DB="${POSTGRES_DB:-studio}"
S3_BACKUP_BUCKET="${S3_BACKUP_BUCKET:-$(env_get S3_BACKUP_BUCKET)}"   # empty = keep local only
BACKUP_DIR="${BACKUP_DIR:-/var/backups/studio}"   # local landing dir
STAMP="$(date -u +%Y%m%d-%H%M%S)"
BASE="studio-${POSTGRES_DB}-${STAMP}.dump.gz"

log() { printf '[backup] %s %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }

# --- preflight ---------------------------------------------------------------
[ -r "$ENV_FILE" ] || { log "FATAL: env file not readable: $ENV_FILE"; exit 1; }
mkdir -p "$BACKUP_DIR"
log "starting: db=${POSTGRES_DB} user=${POSTGRES_USER} dir=${BACKUP_DIR}"

# wait for the db to be healthy (deploy may be mid-roll)
for _ in $(seq 1 30); do
  if compose exec -T db pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
    break
  fi
  log "db not ready yet; retrying…"
  sleep 2
done
compose exec -T db pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null

# --- dump (docker exec → gzip) ----------------------------------------------
# -Fc = PostgreSQL custom format (§17.4: "pg_dump -Fc"): compressed,
# restorable with pg_restore, selective/parallel options later.
OUT="$BACKUP_DIR/$BASE"
START="$(date +%s)"
compose exec -T db pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" \
  | gzip -9 > "$OUT.part"
gzip -t "$OUT.part"   # integrity-check the stream before promoting it
mv "$OUT.part" "$OUT"
sha256sum "$OUT" > "$OUT.sha256"
SECONDS_SPENT=$(( $(date +%s) - START ))
log "dump ok: $OUT ($(du -h "$OUT" | cut -f1), ${SECONDS_SPENT}s)"

# --- upload (awscli placeholder — swap in your sync variant) ----------------
# PLACEHOLDER: the exact awscli flavor is a box-owner decision. Alternatives:
#   aws s3 cp "$OUT" "s3://$S3_BACKUP_BUCKET/postgres/$BASE"
#   aws s3 sync "$BACKUP_DIR" "s3://$S3_BACKUP_BUCKET/postgres/" --exclude "*.part"
# Credentials from env/AWS profile only (never flags, never the repo).
if [ -n "$S3_BACKUP_BUCKET" ]; then
  if command -v aws >/dev/null 2>&1; then
    aws s3 cp --only-show-errors "$OUT"      "s3://$S3_BACKUP_BUCKET/postgres/$BASE"
    aws s3 cp --only-show-errors "$OUT.sha256" "s3://$S3_BACKUP_BUCKET/postgres/$BASE.sha256"
    rm -f "$OUT" "$OUT.sha256"   # box disk is small (§17.4); bucket is truth
    log "uploaded to s3://${S3_BACKUP_BUCKET}/postgres/$BASE (bucket MUST be versioned, §17.1)"
  else
    log "WARN: awscli missing — backup KEPT LOCALLY at $OUT (install awscli or wire another sink)"
  fi
else
  log "WARN: S3_BACKUP_BUCKET unset — backup KEPT LOCALLY at $OUT"
fi

# --- RETENTION note (§17.4: RPO ≤ 24h, restore drill monthly) ---------------
# This script never deletes: retention belongs to the S3 lifecycle policy on
# the versioned bucket (e.g. current objects 90d, noncurrent 30d — your
# call, document it in infra/README.md). Nightly restore TESTING is CI's job
# (§17.3 nightly: restore into a scratch DB); the human drill is restore.sh.
log "done."
