#!/usr/bin/env bash
# =============================================================================
# infra/scripts/verify-backup.sh — automated half of the §17.4 restore drill
# =============================================================================
# Spec §17.3 nightly: "backup restore test into a scratch DB". This script:
#   1. resolves the NEWEST backup (26 h freshness marker → prefix listing →
#      local dir, in that order),
#   2. downloads it (+ .sha256 sidecar) and verifies checksum + gzip integrity,
#   3. restores into a THROWAWAY Postgres container — same image as the prod db
#      (no version skew), no ports published, trust auth inside only, always
#      removed on exit. NEVER touches a real database (§17.5),
#   4. row-count sanity: every group in VERIFY_TABLES must exist in the
#      restored public schema — users, orgs|workspaces, runs, ledger,
#      reservations, subscriptions by default — and prints row counts,
#   5. prints `RESULT: PASS` / `RESULT: FAIL` and exits 0 / 1.
#
# Usage:
#   infra/scripts/verify-backup.sh [local-dump.gz]   # arg skips discovery/download
#
# Env: S3_BACKUP_BUCKET, S3_BACKUP_PREFIX (postgres), STORAGE_ENDPOINT_URL (R2),
#      BACKUP_DIR (/var/backups/studio), VERIFY_TABLES, FRESHNESS_CHECK=1
#      (FAIL if the newest backup is > 26 h old, §22), COMPARE_SOURCE=0|1
#      (also diff restored counts vs the live db; drill-restore sets 1),
#      STRICT_COUNTS=0 (with COMPARE_SOURCE=1: 1 = any count mismatch FAILs;
#      default only FAILs when restored > live, which is impossible cleanly),
#      VERIFY_PG_IMAGE (default: prod db container image, else postgres:16-alpine),
#      ALLOW_LOCAL_ONLY=0 (1 = a local-only newest backup is a PASS).
# No secrets: credentials from the environment only (§15.2); the throwaway
# container uses POSTGRES_HOST_AUTH_METHOD=trust and is never reachable off-host.
# Exit codes: 0 = PASS, 1 = FAIL (page per §17.4 — this is the nightly gate).
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/../../.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$SCRIPT_DIR/../compose/docker-compose.yml}"
compose() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

env_get() {
  grep -m1 -E "^$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- \
    | sed -e 's/^"//g' -e 's/"$//g' -e "s/^'//g" -e "s/'\$//g" || true
}

log() { printf '[verify-backup] %s %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
FAILS=0; REASONS=""
fail() { FAILS=$((FAILS+1)); REASONS="${REASONS}
  - $*"; log "FAIL: $*"; }
warn() { log "WARN: $*"; }

VERIFY_T0="$(date +%s)"

POSTGRES_USER="${POSTGRES_USER:-$(env_get POSTGRES_USER)}"; POSTGRES_USER="${POSTGRES_USER:-studio}"
POSTGRES_DB="${POSTGRES_DB:-$(env_get POSTGRES_DB)}";       POSTGRES_DB="${POSTGRES_DB:-studio}"
S3_BACKUP_BUCKET="${S3_BACKUP_BUCKET:-$(env_get S3_BACKUP_BUCKET)}"
S3_BACKUP_PREFIX="${S3_BACKUP_PREFIX:-postgres}"
STORAGE_ENDPOINT_URL="${STORAGE_ENDPOINT_URL:-}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/studio}"
VERIFY_TABLES="${VERIFY_TABLES:-users,organizations|workspaces,agent_runs,credit_ledger,credit_reservations,subscriptions}"
FRESHNESS_CHECK="${FRESHNESS_CHECK:-1}"
COMPARE_SOURCE="${COMPARE_SOURCE:-0}"
STRICT_COUNTS="${STRICT_COUNTS:-0}"
ALLOW_LOCAL_ONLY="${ALLOW_LOCAL_ONLY:-0}"

command -v docker >/dev/null 2>&1 || { echo "RESULT: FAIL — docker not available"; exit 1; }
[ -n "$S3_BACKUP_BUCKET" ] && [ -z "$S3_BACKUP_PREFIX" ] && S3_BACKUP_PREFIX="postgres"
PREFIX_ROOT="${S3_BACKUP_PREFIX%/}"
if [ -n "$S3_BACKUP_BUCKET" ] && [ -n "$STORAGE_ENDPOINT_URL" ] && command -v aws >/dev/null 2>&1; then
  export AWS_ENDPOINT_URL_S3="${AWS_ENDPOINT_URL_S3:-$STORAGE_ENDPOINT_URL}"
  export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-auto}"
fi

TMP="$(mktemp -d)"
CNAME=""
cleanup() {
  if [ -n "$CNAME" ]; then docker rm -f "$CNAME" >/dev/null 2>&1 || true; fi
  rm -rf "$TMP" 2>/dev/null || true
}
trap cleanup EXIT

# stamp_epoch FILE — studio-<db>-YYYYMMDD-HHMMSS.dump.gz → epoch (UTC)
stamp_epoch() {
  local b="$1" y t
  y="$(printf '%s' "$b" | sed -n 's/.*-\([0-9]\{8\}\)-[0-9]\{6\}\.dump\.gz$/\1/p')"
  t="$(printf '%s' "$b" | sed -n 's/.*-[0-9]\{8\}-\([0-9]\{6\}\)\.dump\.gz$/\1/p')"
  [ -n "$y" ] && [ -n "$t" ] || return 1
  date -u -d "${y:0:4}-${y:4:2}-${y:6:2} ${t:0:2}:${t:2:2}:${t:4:2} UTC" +%s 2>/dev/null || return 1
}

# --- 1. resolve the newest backup --------------------------------------------
DUMP_LOCAL=""; DUMP_LABEL=""; BACKUP_EPOCH=""; SOURCE=""
if [ "${1:-}" != "" ]; then
  DUMP_LOCAL="$1"; DUMP_LABEL="$1"; SOURCE="provided"
  [ -r "$DUMP_LOCAL" ] || { echo "RESULT: FAIL — provided dump not readable: $DUMP_LOCAL"; exit 1; }
elif [ -n "$S3_BACKUP_BUCKET" ] && command -v aws >/dev/null 2>&1; then
  SOURCE="s3"
  MARKER="$(aws s3 cp "s3://${S3_BACKUP_BUCKET}/${PREFIX_ROOT}/_freshness.json" - 2>/dev/null || true)"
  DUMP_KEY="$(printf '%s' "$MARKER" | sed -n 's/.*"newest_backup"[: ]*"\([^"]*\)".*/\1/p' | head -1)"
  case "$DUMP_KEY" in
    s3://*) DUMP_KEY="${DUMP_KEY#s3://${S3_BACKUP_BUCKET}/}" ;;
  esac
  if [ -z "$DUMP_KEY" ] || ! printf '%s' "$DUMP_KEY" | grep -q '\.dump\.gz$'; then
    DUMP_KEY="$(aws s3 ls "s3://${S3_BACKUP_BUCKET}/${PREFIX_ROOT}/" --recursive 2>/dev/null \
      | grep '\.dump\.gz$' | awk '{print $NF}' | sort | tail -1 || true)"
  fi
  [ -n "$DUMP_KEY" ] || { echo "RESULT: FAIL — no backup found under s3://${S3_BACKUP_BUCKET}/${PREFIX_ROOT}/"; exit 1; }
  BACKUP_EPOCH="$(printf '%s' "$MARKER" | sed -n 's/.*"last_success_epoch"[: ]*"\{0,1\}\([0-9]\{1,\}\).*/\1/p' | head -1)"
  DUMP_LABEL="s3://${S3_BACKUP_BUCKET}/${DUMP_KEY}"
  DUMP_LOCAL="$TMP/$(basename "$DUMP_KEY")"
  log "downloading ${DUMP_LABEL} …"
  aws s3 cp "s3://${S3_BACKUP_BUCKET}/${DUMP_KEY}" "$DUMP_LOCAL" --only-show-errors \
    || { echo "RESULT: FAIL — could not download ${DUMP_LABEL}"; exit 1; }
  aws s3 cp "s3://${S3_BACKUP_BUCKET}/${DUMP_KEY}.sha256" "$TMP/" --only-show-errors 2>/dev/null || true
else
  SOURCE="local"
  DUMP_LOCAL="$(ls -1 "$BACKUP_DIR"/studio-*.dump.gz 2>/dev/null | sort | tail -1 || true)"
  [ -n "$DUMP_LOCAL" ] || { echo "RESULT: FAIL — no local backup in $BACKUP_DIR and no S3 path to test (S3_BACKUP_BUCKET/aws missing)"; exit 1; }
  DUMP_LABEL="$DUMP_LOCAL"
  [ "$ALLOW_LOCAL_ONLY" = 1 ] || fail "offsite copy NOT verified (no S3_BACKUP_BUCKET or no aws cli) — §17.4 requires the bucket path be the one tested; set ALLOW_LOCAL_ONLY=1 on dev boxes"
fi

FNAME="$(basename "$DUMP_LOCAL")"
STAMP_EPOCH="$(stamp_epoch "$FNAME" || true)"
if [ -n "$STAMP_EPOCH" ]; then BACKUP_EPOCH="$STAMP_EPOCH"; fi

# --- 2. checksum + gzip integrity --------------------------------------------
SHA_FILE="${DUMP_LOCAL}.sha256"
if [ -r "$SHA_FILE" ]; then
  EXPECTED="$(awk '{print $1}' "$SHA_FILE")"
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL="$(sha256sum "$DUMP_LOCAL" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL="$(shasum -a 256 "$DUMP_LOCAL" | awk '{print $1}')"
  else
    ACTUAL=""
  fi
  if [ -z "$ACTUAL" ]; then
    warn "no sha256 tool available — checksum not verified"
  elif [ "$ACTUAL" = "$EXPECTED" ]; then
    log "sha256 ok (${EXPECTED:0:16}…)"
  else
    fail "sha256 mismatch for $FNAME — the dump is corrupt; treat as an incident (§17.4)"
  fi
else
  warn "no .sha256 sidecar next to $FNAME — checksum not verified"
fi
gzip -t "$DUMP_LOCAL" || fail "gzip integrity check failed on $FNAME"
log "source ok: $DUMP_LABEL ($(du -h "$DUMP_LOCAL" | cut -f1))"

# --- 3. throwaway container (same image as prod db → no version skew) --------
resolve_pg_image() {
  local cid
  cid="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q db 2>/dev/null || true)"
  if [ -n "$cid" ]; then
    docker inspect --format '{{.Config.Image}}' "$cid" 2>/dev/null && return 0
  fi
  echo "${VERIFY_PG_IMAGE:-postgres:16-alpine}"
}
IMG="$(resolve_pg_image)"
CNAME="studio-verify-$(date -u +%Y%m%d%H%M%S)-$$"
log "starting throwaway container: $CNAME ($IMG)"
docker run -d --rm --name "$CNAME" --label studio.backup-verify=1 \
  -e POSTGRES_HOST_AUTH_METHOD=trust "$IMG" >/dev/null \
  || { echo "RESULT: FAIL — could not start throwaway container"; exit 1; }
for _ in $(seq 1 60); do
  docker exec "$CNAME" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 2
done
docker exec "$CNAME" pg_isready -U postgres >/dev/null 2>&1 \
  || fail "throwaway container never became ready ($IMG)"

VDB="studio_verify"
T_RESTORE_START="$(date +%s)"
# pre-create the app role the dump's GRANTs reference, so those warnings are
# the only restore noise (POSTGRES_USER is validated as a safe identifier).
[[ "$POSTGRES_USER" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || POSTGRES_USER="studio"
docker exec "$CNAME" psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE DATABASE studio_verify;' >/dev/null 2>&1 \
  || fail "could not create scratch database in the throwaway container"
ROLE_SQL="DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${POSTGRES_USER}') THEN CREATE ROLE \"${POSTGRES_USER}\" LOGIN; END IF; END \$\$;"
docker exec "$CNAME" psql -U postgres -d postgres -c "$ROLE_SQL" >/dev/null 2>&1 || true

RESTORE_ERR="$TMP/restore.err"
set +e
gunzip -c "$DUMP_LOCAL" \
  | docker exec -i "$CNAME" pg_restore -U postgres --dbname "$VDB" --no-owner 2> "$RESTORE_ERR"
RC=$?
set -e
T_RESTORE=$(( $(date +%s) - T_RESTORE_START ))
if [ "$RC" -ne 0 ]; then
  # tolerate only GRANT references to roles that do not exist locally;
  # anything else is a real restore error (§17.4: the restore path must be real)
  REAL_ERRS="$(grep -c 'error:' "$RESTORE_ERR" 2>/dev/null || true)"; REAL_ERRS="${REAL_ERRS:-0}"
  ROLE_ERRS="$(grep 'error:' "$RESTORE_ERR" 2>/dev/null | grep -c 'role .* does not exist' || true)"; ROLE_ERRS="${ROLE_ERRS:-0}"
  if [ "$REAL_ERRS" -gt "$ROLE_ERRS" ]; then
    fail "pg_restore reported real errors; first: $(grep -m1 'error:' "$RESTORE_ERR" || true)"
  else
    warn "pg_restore exit ${RC}: only ${ROLE_ERRS} missing-role GRANT warning(s) — tolerated"
  fi
fi
log "restore finished in ${T_RESTORE}s"

sql_verify() { docker exec "$CNAME" psql -U postgres -d "$VDB" -tAc "$1" 2>/dev/null; }

NTAB="$(sql_verify "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" || echo 0)"
[ "${NTAB:-0}" -ge 1 ] || fail "restored DB has no public-schema tables — the dump is empty/partial"

# --- 4. row-count sanity (users / orgs / runs / ledger …) --------------------
FOUND_TABLES=""
check_groups() {  # $1 = psql runner fn
  local runner="$1" group alt found n cnt
  local -a GROUPS ALTS
  IFS=',' read -ra GROUPS <<< "$VERIFY_TABLES"
  [ "${#GROUPS[@]}" -ge 1 ] || return 0
  for group in "${GROUPS[@]}"; do
    [ -n "$(printf '%s' "$group" | tr -d '[:space:]')" ] || continue
    found=""
    IFS='|' read -ra ALTS <<< "$group"
    for alt in "${ALTS[@]}"; do
      alt="$(printf '%s' "$alt" | tr -d '[:space:]')"
      [[ "$alt" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
      n="$("$runner" "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='${alt}'" || echo 0)"
      if [ "${n:-0}" = "1" ]; then found="$alt"; break; fi
    done
    if [ -z "$found" ]; then
      fail "no table from group [${group}] exists in the restored DB (schema drift or bad dump)"
      printf '  %-26s %10s   (group %s)\n' "MISSING" "-" "$group" >&2
      continue
    fi
    FOUND_TABLES="$FOUND_TABLES $found"
    cnt="$("$runner" "SELECT count(*) FROM public.\"${found}\"" || echo -1)"
    printf '  %-26s %10s rows (group %s)\n' "$found" "${cnt:-?}" "$group" >&2
  done
}
log "row-count sanity (groups: $VERIFY_TABLES):"
check_groups sql_verify

# --- optional source diff (drill-restore sets COMPARE_SOURCE=1) --------------
if [ "$COMPARE_SOURCE" = 1 ]; then
  [ -r "$ENV_FILE" ] || fail "COMPARE_SOURCE=1 but env file missing: $ENV_FILE"
  sql_src() { compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$1" 2>/dev/null; }
  log "count diff vs live db (money path, RB-06 §Diagnosis 3):"
  for T in $FOUND_TABLES; do
    R="$(sql_verify "SELECT count(*) FROM public.\"${T}\"" || echo x)"
    L="$(sql_src "SELECT count(*) FROM public.\"${T}\"" || true)"
    if [ -z "${L:-}" ]; then fail "live db unreachable — cannot diff table ${T}"; continue; fi
    if ! [[ "$R" =~ ^[0-9]+$ && "$L" =~ ^[0-9]+$ ]]; then fail "non-numeric counts for ${T} (restored=${R} live=${L})"; continue; fi
    if [ "$R" -gt "$L" ]; then
      fail "restored ${T}=${R} > live=${L} — impossible for a clean snapshot; the restore is corrupt"
    elif [ "$R" -lt "$L" ]; then
      if [ "$STRICT_COUNTS" = 1 ]; then
        fail "${T}: restored=${R} live=${L} mismatch (STRICT_COUNTS=1)"
      else
        warn "${T}: restored=${R} < live=${L} (delta $((L-R)) = writes since the backup — expected drift; STRICT_COUNTS=1 to enforce equality)"
      fi
    fi
    printf '  %-26s restored=%-9s live=%s\n' "$T" "$R" "$L" >&2
  done
fi

# --- 5. freshness (§22: backup older than 26 h) ------------------------------
if [ "$FRESHNESS_CHECK" = 1 ]; then
  if [ -n "$BACKUP_EPOCH" ] && [[ "$BACKUP_EPOCH" =~ ^[0-9]+$ ]]; then
    AGE_S=$(( $(date +%s) - BACKUP_EPOCH ))
    AGE_H=$(( AGE_S / 3600 ))
    log "newest backup age: ${AGE_H}h $(( (AGE_S % 3600) / 60 ))m (RPO evidence, §17.4)"
    [ "$AGE_S" -le $(( 26 * 3600 )) ] || fail "newest backup is ${AGE_H}h old — §22 alert threshold is 26 h (fix the nightly cron first)"
  else
    warn "could not determine backup age (no stamp in filename, no marker) — freshness not verified"
  fi
fi

T_TOTAL=$(( $(date +%s) - VERIFY_T0 ))
echo "------------------------------------------------------------------" >&2
printf '[verify-backup] backup: %s\n' "$DUMP_LABEL" >&2
printf '[verify-backup] throwaway restore: %s (%ss), tables in public: %s\n' "$IMG" "$T_RESTORE" "${NTAB:-0}" >&2
printf '[verify-backup] elapsed: %ss\n' "$T_TOTAL" >&2
if [ "$FAILS" -gt 0 ]; then
  printf '[verify-backup] RESULT: FAIL\n%s\n' "$REASONS" >&2
  echo "RESULT: FAIL"
  exit 1
fi
printf '[verify-backup] RESULT: PASS\n' >&2
echo "RESULT: PASS"
exit 0
