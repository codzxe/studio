#!/usr/bin/env bash
# =============================================================================
# infra/scripts/backup-v2.sh — §17.4 daily backup, hardened (supersedes backup.sh)
# =============================================================================
# Pipeline (spec §17.4, hard requirements):
#   pg_dump -Fc (custom format) → sha256 sidecar + per-run manifest
#   → aws s3 sync to a DATED prefix  s3://$S3_BACKUP_BUCKET/postgres/YYYY/MM/DD/
#   → rolling 26 h FRESHNESS MARKER s3://$S3_BACKUP_BUCKET/postgres/_freshness.json
#     (the §22 "backup older than 26 h" alert reads `last_success_epoch` from it).
#
# Storage env: S3_BACKUP_BUCKET from shell env or ../../.env. R2 / any
# S3-compatible store: set STORAGE_ENDPOINT_URL (exported as AWS_ENDPOINT_URL_S3,
# AWS_DEFAULT_REGION=auto). aws cli is used when present; otherwise the exact
# rclone commands are printed and the dump is kept in staging. Credentials ONLY
# from the environment / aws / rclone config — never flags, never the repo (§15.2).
#
# .pcraft objects: already IN object storage — the assets bucket is NOT copied by
# default (§17.4). Rely on bucket VERSIONING (deletion protection) + lifecycle
# rules; opt into a one-way cross-bucket replica with S3_OBJECTS_REPLICA_BUCKET.
#
# Cron-ready — idempotent + lockfile (§17.4 RPO ≤ 24 h):
#   0 3 * * *  /srv/studio/infra/scripts/backup-v2.sh >> /var/log/studio-backup.log 2>&1
#   * flock on $LOCK_FILE; a second concurrent run exits 0 (never piles up)
#   * everything is written .part and atomically promoted on success
#   * re-runs just create a new timestamped dated prefix; the marker upload
#     overwrites in place, so the 26 h freshness contract stays intact
#
# restore.sh (W1-L) consumes these dumps unchanged (gunzip | pg_restore -Fc);
# verify-backup.sh + drill-restore.sh (W9-K) test the restore path.
# Exit codes: 0 = backup secured (uploaded, or kept-local by explicit config);
# non-zero = FAILED — page it (§17.4: "the only data you cannot lose").
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/../../.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$SCRIPT_DIR/../compose/docker-compose.yml}"
compose() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

# env_get KEY — read one var from $ENV_FILE without sourcing it (never let .env
# content reach a shell parser; values are plain or quoted KEY=VALUE).
env_get() {
  grep -m1 -E "^$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- \
    | sed -e 's/^"//g' -e 's/"$//g' -e "s/^'//g" -e "s/'\$//g" || true
}

log() { printf '[backup-v2] %s %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
die() { log "FATAL: $*"; exit 1; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else echo ""; fi
}

# --- config (shell env → ../../.env → safe default) --------------------------
POSTGRES_USER="${POSTGRES_USER:-$(env_get POSTGRES_USER)}"; POSTGRES_USER="${POSTGRES_USER:-studio}"
POSTGRES_DB="${POSTGRES_DB:-$(env_get POSTGRES_DB)}";       POSTGRES_DB="${POSTGRES_DB:-studio}"
S3_BACKUP_BUCKET="${S3_BACKUP_BUCKET:-$(env_get S3_BACKUP_BUCKET)}"   # empty = local only
S3_BACKUP_PREFIX="${S3_BACKUP_PREFIX:-postgres}"
STORAGE_ENDPOINT_URL="${STORAGE_ENDPOINT_URL:-}"           # R2 / S3-compatible endpoint
S3_ASSETS_BUCKET="${S3_ASSETS_BUCKET:-$(env_get S3_ASSETS_BUCKET)}"   # .pcraft objects
S3_OBJECTS_REPLICA_BUCKET="${S3_OBJECTS_REPLICA_BUCKET:-}"            # opt-in, see header
BACKUP_DIR="${BACKUP_DIR:-/var/backups/studio}"
KEEP_LOCAL_DAYS="${KEEP_LOCAL_DAYS:-1}"    # 1 = keep yesterday's dump for fast drills; 0 = v1 behaviour
ALLOW_LOCAL_ONLY="${ALLOW_LOCAL_ONLY:-0}"  # 1 = a kept-local backup is a PASS (dev boxes)
LOCK_FILE="${LOCK_FILE:-$BACKUP_DIR/.backup-v2.lock}"
LOCK_DIR="${LOCK_DIR:-$BACKUP_DIR/.backup-v2.lockdir}"

STAMP="$(date -u +%Y%m%d-%H%M%S)"
PREFIX_ROOT="${S3_BACKUP_PREFIX%/}"
[ -n "$PREFIX_ROOT" ] || die "S3_BACKUP_PREFIX must not be empty (set it to e.g. 'postgres')"
PREFIX="$PREFIX_ROOT/$(date -u +%Y/%m/%d)"                 # dated prefix (§17.4 layout)
BASE="studio-${POSTGRES_DB}-${STAMP}.dump.gz"
EPOCH="$(date +%s)"
CREATED_ISO="$(date -u +%FT%TZ)"
STAGE="$BACKUP_DIR/staging/${STAMP}-$$"

[ -r "$ENV_FILE" ] || die "env file not readable: $ENV_FILE"
[[ "$POSTGRES_USER" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "POSTGRES_USER is not a safe identifier"
[[ "$POSTGRES_DB" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "POSTGRES_DB is not a safe identifier"
mkdir -p "$BACKUP_DIR" || die "cannot create $BACKUP_DIR (run as the box admin user)"

# --- lockfile (cron-safe: a second concurrent run exits 0, idempotent) -------
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    log "another backup-v2 run holds $LOCK_FILE — exiting 0 (idempotent, cron-safe)"
    exit 0
  fi
else  # mkdir fallback with 6 h stale takeover (boxes without util-linux)
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    if [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +360 2>/dev/null)" ]; then
      log "stale lock (> 6 h) — taking over"; rm -rf "$LOCK_DIR"; mkdir "$LOCK_DIR" 2>/dev/null \
        || { log "another run is active — exiting 0 (idempotent, cron-safe)"; exit 0; }
    else
      log "another backup-v2 run is active — exiting 0 (idempotent, cron-safe)"
      exit 0
    fi
  fi
fi

# keep only .part temp files out of the tree on exit; a FAILED run deliberately
# preserves its staged dump (retry the upload — do NOT delete it).
cleanup() {
  rm -f "$STAGE"/*.part 2>/dev/null || true
  rmdir "$STAGE" 2>/dev/null || true
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

# sweep staging dirs abandoned by failed runs (older than 2 days)
find "$BACKUP_DIR/staging" -mindepth 1 -maxdepth 1 -type d -mtime +2 \
  -exec rm -rf {} \; 2>/dev/null || true

log "starting: db=${POSTGRES_DB} user=${POSTGRES_USER} dir=${BACKUP_DIR} prefix=${PREFIX_ROOT}"

# --- pre-run freshness check (§22: alert if the previous backup is > 26 h) ---
if [ -n "$S3_BACKUP_BUCKET" ] && command -v aws >/dev/null 2>&1; then
  PREV_JSON="$(aws s3 cp "s3://${S3_BACKUP_BUCKET}/${PREFIX_ROOT}/_freshness.json" - 2>/dev/null || true)"
  if [ -n "$PREV_JSON" ]; then
    PREV_EPOCH="$(printf '%s' "$PREV_JSON" | sed -n 's/.*"last_success_epoch"[: ]*"\{0,1\}\([0-9]\{1,\}\).*/\1/p' | head -1)"
    if [ -n "$PREV_EPOCH" ]; then
      AGE_H=$(( ( $(date +%s) - PREV_EPOCH ) / 3600 ))
      if [ "$AGE_H" -ge 26 ]; then
        log "WARN §22: previous successful backup is ${AGE_H}h old (alert threshold 26 h) — nightly cron slipped; fix that FIRST"
      fi
    fi
  fi
fi

# --- wait for the db (deploy may be mid-roll) --------------------------------
for _ in $(seq 1 30); do
  compose exec -T db pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1 && break
  log "db not ready yet; retrying…"
  sleep 2
done
compose exec -T db pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null \
  || die "db never became ready (stack up? disk pressure → RB-05)"

# --- dump: pg_dump -Fc (§17.4 custom format), gzipped for restore.sh parity --
mkdir -p "$STAGE"
START="$(date +%s)"
compose exec -T db pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" \
  | gzip -9 > "$STAGE/$BASE.part"
gzip -t "$STAGE/$BASE.part" || die "gzip integrity check failed — dump discarded"
mv "$STAGE/$BASE.part" "$STAGE/$BASE"

SHA="$(sha256_of "$STAGE/$BASE")"
[ -n "$SHA" ] || die "no sha256 tool available — refusing to ship an unverifiable backup"
printf '%s  %s\n' "$SHA" "$BASE" > "$STAGE/$BASE.sha256"
BYTES="$(wc -c < "$STAGE/$BASE" | tr -d '[:space:]')"
PG_VERSION="$(compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc 'SHOW server_version' 2>/dev/null | tr -d '[:space:]' || echo unknown)"
PGDUMP_VERSION="$(compose exec -T db pg_dump --version 2>/dev/null | awk '{print $3}' || echo unknown)"
log "dump ok: $BASE ($(du -h "$STAGE/$BASE" | cut -f1), $(( $(date +%s) - START ))s) sha256=${SHA:0:16}…"

# --- per-run sha256 manifest (§17.4) ------------------------------------------
cat > "$STAGE/manifest-${STAMP}.json" <<EOF
{
  "schema": 1,
  "type": "studio-pg-backup",
  "created_utc": "${CREATED_ISO}",
  "created_epoch": ${EPOCH},
  "database": "${POSTGRES_DB}",
  "pg_server_version": "${PG_VERSION}",
  "pg_dump_version": "${PGDUMP_VERSION}",
  "dump": {
    "file": "${BASE}",
    "bytes": ${BYTES},
    "sha256": "${SHA}",
    "format": "pg_dump -Fc | gzip"
  },
  "retention": "bucket lifecycle policy on the versioned bucket (§17.4)",
  "freshness_alert_hours": 26
}
EOF

# --- 26 h freshness marker object (§22 alert contract) -----------------------
cat > "$STAGE/_freshness.json" <<EOF
{
  "schema": 1,
  "last_success_utc": "${CREATED_ISO}",
  "last_success_epoch": "${EPOCH}",
  "newest_backup": "s3://${S3_BACKUP_BUCKET}/${PREFIX}/${BASE}",
  "alert_after_hours": 26,
  "alert": "§22 — page if now - last_success_epoch > 26 h"
}
EOF

# --- upload: dated-prefix sync via aws cli, else rclone note -----------------
UPLOADED=0
if [ -n "$S3_BACKUP_BUCKET" ]; then
  if command -v aws >/dev/null 2>&1; then
    if [ -n "$STORAGE_ENDPOINT_URL" ]; then
      export AWS_ENDPOINT_URL_S3="${AWS_ENDPOINT_URL_S3:-$STORAGE_ENDPOINT_URL}"
      export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-auto}"
    fi
    aws s3 sync "$STAGE" "s3://${S3_BACKUP_BUCKET}/${PREFIX}/" \
      --exclude '_freshness.json' --only-show-errors \
      || die "s3 sync failed — backup is still safe at $STAGE (retry; do NOT delete it)"
    aws s3 cp "$STAGE/_freshness.json" \
      "s3://${S3_BACKUP_BUCKET}/${PREFIX_ROOT}/_freshness.json" --only-show-errors \
      || die "backup uploaded but the 26 h marker failed — §22 alert will fire; re-run the cp by hand"
    UPLOADED=1
    log "uploaded to s3://${S3_BACKUP_BUCKET}/${PREFIX}/ (bucket MUST be versioned, §17.4)"
  else
    log "WARN: aws cli missing — rclone equivalent (configure the remote first; creds via env):"
    log "  rclone sync \"${STAGE}\" \"r2:${S3_BACKUP_BUCKET}/${PREFIX}/\" --exclude _freshness.json"
    log "  rclone copyto \"${STAGE}/_freshness.json\" \"r2:${S3_BACKUP_BUCKET}/${PREFIX_ROOT}/_freshness.json\""
    log "backup KEPT LOCALLY at ${STAGE}/${BASE} until you upload it"
  fi
else
  log "WARN: S3_BACKUP_BUCKET unset — backup KEPT LOCALLY at ${STAGE}/${BASE}"
fi

# --- .pcraft / assets bucket (§17.4: versioning advice; no copy by default) --
if [ -n "$S3_OBJECTS_REPLICA_BUCKET" ]; then
  command -v aws >/dev/null 2>&1 || die "S3_OBJECTS_REPLICA_BUCKET set but aws cli missing"
  [ -n "$S3_ASSETS_BUCKET" ] || die "S3_OBJECTS_REPLICA_BUCKET set but S3_ASSETS_BUCKET missing"
  log "opt-in: syncing assets bucket → replica (.pcraft objects; otherwise protected only by bucket versioning, §17.4)"
  aws s3 sync "s3://${S3_ASSETS_BUCKET}" "s3://${S3_OBJECTS_REPLICA_BUCKET}/" --only-show-errors \
    || die "assets replica sync failed (the pg backup above is already safe)"
else
  log "note: .pcraft/assets bucket NOT copied (§17.4) — confirm VERSIONING + lifecycle are ON (deletion protection)"
fi

# --- local retention (bucket is truth; local copies only speed drills) -------
if [ "$UPLOADED" = 1 ]; then
  if [ "$KEEP_LOCAL_DAYS" -gt 0 ]; then
    mv "$STAGE/$BASE" "$STAGE/$BASE.sha256" "$STAGE/manifest-${STAMP}.json" "$BACKUP_DIR/"
    find "$BACKUP_DIR" -maxdepth 1 -name 'studio-*.dump.gz' -mtime +"$KEEP_LOCAL_DAYS" -delete 2>/dev/null || true
    find "$BACKUP_DIR" -maxdepth 1 -name 'studio-*.dump.gz.sha256' -mtime +"$KEEP_LOCAL_DAYS" -delete 2>/dev/null || true
    find "$BACKUP_DIR" -maxdepth 1 -name 'manifest-*.json' -mtime +"$KEEP_LOCAL_DAYS" -delete 2>/dev/null || true
    log "local copy kept in $BACKUP_DIR (KEEP_LOCAL_DAYS=$KEEP_LOCAL_DAYS)"
  else
    rm -f "$STAGE/$BASE" "$STAGE/$BASE.sha256" "$STAGE/manifest-${STAMP}.json"
    log "local staging discarded (KEEP_LOCAL_DAYS=0) — bucket is truth"
  fi
elif [ "$ALLOW_LOCAL_ONLY" = 1 ]; then
  mv "$STAGE/$BASE" "$STAGE/$BASE.sha256" "$STAGE/manifest-${STAMP}.json" "$BACKUP_DIR/"
  log "ALLOW_LOCAL_ONLY=1 — local-only backup accepted at $BACKUP_DIR/$BASE (no offsite copy!)"
else
  die "backup not uploaded (bucket unset / tool missing) — FAILING so the §22 26 h freshness contract stays honest; set ALLOW_LOCAL_ONLY=1 on dev boxes. Dump kept at $STAGE/$BASE"
fi

log "§22 freshness check for monitors: aws s3 cp s3://${S3_BACKUP_BUCKET}/${PREFIX_ROOT}/_freshness.json -  → compare last_success_epoch to now (page at > 26 h)"
log "done (created_utc=${CREATED_ISO})."
