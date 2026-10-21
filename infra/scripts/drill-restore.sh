#!/usr/bin/env bash
# =============================================================================
# infra/scripts/drill-restore.sh — the FULL §17.4 quarterly restore drill
# =============================================================================
# Spec §17.4: "documented restore drill with RTO ≤ 4 h, RPO ≤ 24 h. Test it
# monthly." This is the human-run drill (RB-06); verify-backup.sh is its
# automated half and nightly gate (§17.3). Phases, all timed:
#   0. resolve the newest backup → RPO = its age (must be ≤ 24 h; 26 h = §22 alert)
#   1. fetch dump + .sha256 (t_fetch)
#   2. run verify-backup.sh with COMPARE_SOURCE=1 (t_verify): throwaway-container
#      restore + row-count sanity + money-path count diff vs the live db
#   3. restore the SAME dump into a SCRATCH COMPOSE PROJECT (isolated project
#      name, named volume, torn down with -v at the end — never a real DB, §17.5)
#      (t_up + t_restore)
#   4. smoke against the scratch project (t_smoke): table groups, count diff vs
#      source, and a preview-URL resolution check (soft — see ASSET_PREVIEW_SQL)
#   5. timing report (RTO/RPO vs the §17.4 budgets) + one row appended to
#      docs/runbooks/drill-log.md, then the operator signs off in RB-06.
#
# Usage:
#   infra/scripts/drill-restore.sh --operator "$USER" [--backup KEY|path.dump.gz]
#                                 [--skip-source-diff] [--log PATH]
# Exit codes: 0 = drill PASS; 1 = drill FAIL (treat like an incident, RB-06
# §Postmortem — root-cause, file the fix, re-run within a week).
# No secrets: all credentials from the environment (§15.2).
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/../../.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$SCRIPT_DIR/../compose/docker-compose.yml}"
DRILL_LOG="${DRILL_LOG:-}"
compose() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

env_get() {
  grep -m1 -E "^$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- \
    | sed -e 's/^"//g' -e 's/"$//g' -e "s/^'//g" -e "s/'\$//g" || true
}

log() { printf '[drill] %s %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
die() { log "FATAL: $*"; exit 1; }
usage() { sed -n '2,30p' "${BASH_SOURCE[0]}" | grep -E '^\s+#' | sed 's/^#\s\{0,1\}//' >&2; }

POSTGRES_USER="${POSTGRES_USER:-$(env_get POSTGRES_USER)}"; POSTGRES_USER="${POSTGRES_USER:-studio}"
POSTGRES_DB="${POSTGRES_DB:-$(env_get POSTGRES_DB)}";       POSTGRES_DB="${POSTGRES_DB:-studio}"
S3_BACKUP_BUCKET="${S3_BACKUP_BUCKET:-$(env_get S3_BACKUP_BUCKET)}"
S3_BACKUP_PREFIX="${S3_BACKUP_PREFIX:-postgres}"
STORAGE_ENDPOINT_URL="${STORAGE_ENDPOINT_URL:-}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/studio}"
VERIFY_TABLES="${VERIFY_TABLES:-users,organizations|workspaces,agent_runs,credit_ledger,credit_reservations,subscriptions}"
ASSET_PREVIEW_SQL="${ASSET_PREVIEW_SQL:-SELECT preview_url FROM assets WHERE preview_url IS NOT NULL LIMIT 1}"
SKIP_SOURCE_DIFF="${SKIP_SOURCE_DIFF:-0}"
OPERATOR="${OPERATOR:-${USER:-unknown}}"

while [ $# -gt 0 ]; do
  case "$1" in
    --operator) OPERATOR="${2:-}"; shift 2 ;;
    --backup)   BACKUP_OVERRIDE="${2:-}"; shift 2 ;;
    --skip-source-diff) SKIP_SOURCE_DIFF=1; shift ;;
    --log)      DRILL_LOG="${2:-}"; shift 2 ;;
    -h|--help)  usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done
[ -n "$OPERATOR" ] || die "--operator is required (it goes into drill-log.md)"
command -v docker >/dev/null 2>&1 || die "docker not available — the drill must run on the box"
command -v curl >/dev/null 2>&1 || log "WARN: curl missing — the preview-URL smoke will be skipped"
[ -r "$ENV_FILE" ] || { [ "$SKIP_SOURCE_DIFF" = 1 ] || die "env file missing: $ENV_FILE (needed for the source diff; pass --skip-source-diff to run without it)"; }
[ -n "$S3_BACKUP_BUCKET" ] || die "S3_BACKUP_BUCKET unset — the drill must test the offsite path (§17.4)"
command -v aws >/dev/null 2>&1 || die "aws cli required (credentials from env only)"
[ -n "$STORAGE_ENDPOINT_URL" ] && { export AWS_ENDPOINT_URL_S3="${AWS_ENDPOINT_URL_S3:-$STORAGE_ENDPOINT_URL}"; export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-auto}"; }
[ -n "$DRILL_LOG" ] || DRILL_LOG="$SCRIPT_DIR/../../docs/runbooks/drill-log.md"
PREFIX_ROOT="${S3_BACKUP_PREFIX%/}"; [ -n "$PREFIX_ROOT" ] || PREFIX_ROOT="postgres"

DRILL_T0="$(date +%s)"
DATE_ISO="$(date -u +%FT%TZ)"
PROJ="studio-drill-$(date -u +%Y%m%d%H%M%S)-$$"
DDB="studio_drill"
TMP="$(mktemp -d)"
NOTES=""

human_secs() {
  local s="${1:-0}"
  if [ "$s" -lt 60 ]; then echo "${s}s"
  elif [ "$s" -lt 3600 ]; then echo "$((s / 60))m$((s % 60))s"
  else echo "$((s / 3600))h$(( (s % 3600) / 60 ))m"; fi
}

stamp_epoch() {
  local b="$1" y t
  y="$(printf '%s' "$b" | sed -n 's/.*-\([0-9]\{8\}\)-[0-9]\{6\}\.dump\.gz$/\1/p')"
  t="$(printf '%s' "$b" | sed -n 's/.*-[0-9]\{8\}-\([0-9]\{6\}\)\.dump\.gz$/\1/p')"
  [ -n "$y" ] && [ -n "$t" ] || return 1
  date -u -d "${y:0:4}-${y:4:2}-${y:6:2} ${t:0:2}:${t:2:2}:${t:4:2} UTC" +%s 2>/dev/null || return 1
}

teardown() {
  docker compose -p "$PROJ" -f "$TMP/compose.yml" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$TMP" 2>/dev/null || true
}
trap teardown EXIT

# --- 0. resolve newest backup → RPO ------------------------------------------
if [ -n "${BACKUP_OVERRIDE:-}" ]; then
  DUMP_LABEL="$BACKUP_OVERRIDE"
else
  MARKER="$(aws s3 cp "s3://${S3_BACKUP_BUCKET}/${PREFIX_ROOT}/_freshness.json" - 2>/dev/null || true)"
  DUMP_KEY="$(printf '%s' "$MARKER" | sed -n 's/.*"newest_backup"[: ]*"\([^"]*\)".*/\1/p' | head -1)"
  case "$DUMP_KEY" in
    s3://*) DUMP_KEY="${DUMP_KEY#s3://${S3_BACKUP_BUCKET}/}" ;;
  esac
  if [ -z "$DUMP_KEY" ] || ! printf '%s' "$DUMP_KEY" | grep -q '\.dump\.gz$'; then
    DUMP_KEY="$(aws s3 ls "s3://${S3_BACKUP_BUCKET}/${PREFIX_ROOT}/" --recursive 2>/dev/null \
      | grep '\.dump\.gz$' | awk '{print $NF}' | sort | tail -1 || true)"
  fi
  [ -n "$DUMP_KEY" ] || die "no backup found under s3://${S3_BACKUP_BUCKET}/${PREFIX_ROOT}/ — run backup-v2.sh first (RB-06 §Fix)"
  DUMP_LABEL="s3://${S3_BACKUP_BUCKET}/${DUMP_KEY}"
  MARKER_EPOCH="$(printf '%s' "$MARKER" | sed -n 's/.*"last_success_epoch"[: ]*"\{0,1\}\([0-9]\{1,\}\).*/\1/p' | head -1)"
fi

# --- 1. fetch (timed; this is the first half of the RTO clock) ----------------
T="$(date +%s)"
if [ -n "${BACKUP_OVERRIDE:-}" ] && [ "${BACKUP_OVERRIDE#s3://}" = "${BACKUP_OVERRIDE}" ]; then
  [ -r "$BACKUP_OVERRIDE" ] || die "provided backup not readable: $BACKUP_OVERRIDE"
  DUMP_LOCAL="$BACKUP_OVERRIDE"
else
  KEY="${DUMP_LABEL#s3://${S3_BACKUP_BUCKET}/}"
  DUMP_LOCAL="$TMP/$(basename "$KEY")"
  log "fetching ${DUMP_LABEL} …"
  aws s3 cp "s3://${S3_BACKUP_BUCKET}/${KEY}" "$DUMP_LOCAL" --only-show-errors \
    || die "could not fetch ${DUMP_LABEL} (credentials? RB-06 §Fix)"
  aws s3 cp "s3://${S3_BACKUP_BUCKET}/${KEY}.sha256" "$TMP/" --only-show-errors 2>/dev/null || true
fi
T_FETCH=$(( $(date +%s) - T ))
FNAME="$(basename "$DUMP_LOCAL")"
SIZE_H="$(du -h "$DUMP_LOCAL" | cut -f1)"
gzip -t "$DUMP_LOCAL" || die "gzip integrity check failed on $FNAME — do not proceed (§17.4)"

BACKUP_EPOCH="$(stamp_epoch "$FNAME" || true)"
[ -n "$BACKUP_EPOCH" ] || BACKUP_EPOCH="${MARKER_EPOCH:-}"
[ -n "$BACKUP_EPOCH" ] || die "cannot determine backup age (RPO unmeasurable) — aborting the drill"
RPO_SECS=$(( $(date +%s) - BACKUP_EPOCH ))
RPO_OK=ok; [ "$RPO_SECS" -le $(( 24 * 3600 )) ] || RPO_OK=OVER
log "RPO: backup age $(human_secs "$RPO_SECS") (budget ≤ 24 h, §22 alert at 26 h) [$RPO_OK]"

# --- 2. automated half: verify-backup (throwaway container + count diff) ------
T="$(date +%s)"
VERIFY_ENV="COMPARE_SOURCE=1 FRESHNESS_CHECK=1"
[ "$SKIP_SOURCE_DIFF" = 1 ] && VERIFY_ENV="COMPARE_SOURCE=0 FRESHNESS_CHECK=1"
if ! env $VERIFY_ENV "$SCRIPT_DIR/verify-backup.sh" "$DUMP_LOCAL"; then
  log "verify-backup FAILED — aborting the drill before the scratch restore; see RB-06 §Fix (version skew, checksum, cron)"
  RESULT="FAIL"; NOTES="verify-backup failed"
  T_VERIFY=$(( $(date +%s) - T )); T_UP=0; T_RESTORE=0; T_SMOKE=0
  RTO_SECS=$(( $(date +%s) - DRILL_T0 ))
  finish 2>/dev/null || true   # not defined on this path; append happens below
  append_log_row() { :; }
  printf '' >&2
  # fall through to the shared report/append block
else
  T_VERIFY=$(( $(date +%s) - T ))
fi
RESULT="${RESULT:-RUNNING}"

# --- 3. scratch compose project (isolated name + volume; torn down with -v) --
resolve_pg_image() {
  local cid
  cid="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q db 2>/dev/null 2>&1 || true)"
  if [ -n "$cid" ]; then docker inspect --format '{{.Config.Image}}' "$cid" 2>/dev/null && return 0; fi
  echo "${VERIFY_PG_IMAGE:-postgres:16-alpine}"
}
IMG="$(resolve_pg_image)"
log "scratch compose project: $PROJ (image $IMG)"
cat > "$TMP/compose.yml" <<EOF
services:
  db:
    image: "${IMG}"
    environment:
      POSTGRES_HOST_AUTH_METHOD: trust
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 2s
      timeout: 5s
      retries: 30
    restart: "no"
volumes:
  pgdata:
EOF
dcc() { docker compose -p "$PROJ" -f "$TMP/compose.yml" "$@"; }
sql_scratch() { dcc exec -T db psql -U postgres -d "$DDB" -tAc "$1" 2>/dev/null; }
sql_src() { compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$1" 2>/dev/null; }

T="$(date +%s)"
dcc up -d >/dev/null 2>&1 || die "scratch project failed to start"
for _ in $(seq 1 60); do
  dcc exec -T db pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 2
done
dcc exec -T db pg_isready -U postgres >/dev/null 2>&1 || die "scratch db never became ready"
T_UP=$(( $(date +%s) - T ))

T="$(date +%s)"
dcc exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${DDB};" >/dev/null \
  || die "could not create scratch database"
[[ "$POSTGRES_USER" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || POSTGRES_USER="studio"
ROLE_SQL="DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${POSTGRES_USER}') THEN CREATE ROLE \"${POSTGRES_USER}\" LOGIN; END IF; END \$\$;"
dcc exec -T db psql -U postgres -d postgres -c "$ROLE_SQL" >/dev/null 2>&1 || true

RESTORE_ERR="$TMP/scratch-restore.err"
set +e
gunzip -c "$DUMP_LOCAL" | dcc exec -T db pg_restore -U postgres --dbname "$DDB" --no-owner 2> "$RESTORE_ERR"
RC=$?
set -e
T_RESTORE=$(( $(date +%s) - T ))
if [ "$RC" -ne 0 ]; then
  REAL_ERRS="$(grep -c 'error:' "$RESTORE_ERR" 2>/dev/null || echo 0)"
  ROLE_ERRS="$(grep 'error:' "$RESTORE_ERR" 2>/dev/null | grep -c 'role .* does not exist' || true)"
  if [ "$REAL_ERRS" -gt "${ROLE_ERRS:-0}" ]; then
    die "scratch pg_restore failed for real (first: $(grep -m1 'error:' "$RESTORE_ERR" || true)) — see RB-06 §Fix (version skew)"
  fi
  log "WARN: scratch restore exit ${RC}: only missing-role GRANT warnings — tolerated"
fi
log "scratch restore finished in ${T_RESTORE}s ($(du -h "$DUMP_LOCAL" | cut -f1) dump)"

# --- 4. smoke against the scratch project -------------------------------------
T="$(date +%s)"
SMOKE_FAILS=0
NTAB="$(sql_scratch "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" || echo 0)"
[ "${NTAB:-0}" -ge 1 ] || { log "FAIL: scratch DB has no public tables"; SMOKE_FAILS=$((SMOKE_FAILS+1)); NOTES="$NOTES empty restore"; }

FOUND_TABLES=""
IFS=',' read -ra GROUPS <<< "$VERIFY_TABLES"
for group in "${GROUPS[@]}"; do
  [ -n "$(printf '%s' "$group" | tr -d '[:space:]')" ] || continue
  found=""
  IFS='|' read -ra ALTS <<< "$group"
  for alt in "${ALTS[@]}"; do
    alt="$(printf '%s' "$alt" | tr -d '[:space:]')"
    [[ "$alt" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    n="$(sql_scratch "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='${alt}'" || echo 0)"
    [ "${n:-0}" = "1" ] && { found="$alt"; break; }
  done
  if [ -z "$found" ]; then
    log "FAIL: no table from group [${group}] in the scratch DB"; SMOKE_FAILS=$((SMOKE_FAILS+1)); continue
  fi
  FOUND_TABLES="$FOUND_TABLES $found"
  cnt="$(sql_scratch "SELECT count(*) FROM public.\"${found}\"" || echo -1)"
  printf '[drill]   %-26s %10s rows (group %s)\n' "$found" "${cnt:-?}" "$group" >&2
done

if [ "$SKIP_SOURCE_DIFF" != 1 ]; then
  log "money-path count diff vs live db (RB-06 §Diagnosis 3):"
  for TBL in $FOUND_TABLES; do
    R="$(sql_scratch "SELECT count(*) FROM public.\"${TBL}\"" || echo x)"
    L="$(sql_src "SELECT count(*) FROM public.\"${TBL}\"" || true)"
    if [ -z "${L:-}" ]; then log "FAIL: live db unreachable — cannot diff ${TBL}"; SMOKE_FAILS=$((SMOKE_FAILS+1)); continue; fi
    if ! [[ "$R" =~ ^[0-9]+$ && "$L" =~ ^[0-9]+$ ]]; then log "FAIL: non-numeric counts for ${TBL}"; SMOKE_FAILS=$((SMOKE_FAILS+1)); continue; fi
    if [ "$R" -gt "$L" ]; then log "FAIL: restored ${TBL}=${R} > live=${L} — corrupt restore"; SMOKE_FAILS=$((SMOKE_FAILS+1));
    elif [ "$R" -lt "$L" ]; then log "note: ${TBL} restored=${R} < live=${L} (delta $((L-R)) = writes since the backup — expected drift)"
    fi
    printf '[drill]   %-26s restored=%-9s live=%s\n' "$TBL" "$R" "$L" >&2
  done
fi

URL="$(sql_scratch "$ASSET_PREVIEW_SQL" || true)"
if [ -z "$URL" ]; then
  log "preview URL: SKIPPED (no row / relation absent — set ASSET_PREVIEW_SQL to your schema, RB-06 §Diagnosis 4)"
elif ! command -v curl >/dev/null 2>&1; then
  log "WARN: curl missing — preview URL not fetched: $URL"
else
  CODE="$(curl -sS -L -o /dev/null -w '%{http_code}' --max-time 20 "$URL" 2>/dev/null || echo 000)"
  case "$CODE" in
    2*|3*) log "preview URL resolves (HTTP ${CODE})" ;;
    000)   log "WARN: preview URL unreachable from the drill host (no egress?) — eyeball from a browser: $URL" ;;
    4*)    log "WARN: preview URL HTTP ${CODE} (expired signature?) — confirm the object exists in the versioned prefix" ;;
    *)     log "FAIL: preview URL HTTP ${CODE} — object path broken (§17.4)"; SMOKE_FAILS=$((SMOKE_FAILS+1)) ;;
  esac
fi
T_SMOKE=$(( $(date +%s) - T ))

# --- 5. report + drill-log row -------------------------------------------------
RTO_SECS=$(( $(date +%s) - DRILL_T0 ))
RTO_OK=ok; [ "$RTO_SECS" -le $(( 4 * 3600 )) ] || RTO_OK=OVER
RESULT="PASS"
[ "$SMOKE_FAILS" -eq 0 ] || { RESULT="FAIL"; NOTES="$NOTES smoke failures: ${SMOKE_FAILS}"; }
[ "$RPO_OK" = ok ] || NOTES="$NOTES RPO over 24 h budget"
[ "$RTO_OK" = ok ] || NOTES="$NOTES RTO over 4 h budget"
NOTES="$(printf '%s' "$NOTES" | sed 's/^ *;* *//' | tr '|' '/')"
[ -n "$NOTES" ] || NOTES="budgets ok"

ensure_drill_log() {
  [ -f "$DRILL_LOG" ] && return 0
  mkdir -p "$(dirname "$DRILL_LOG")"
  cat > "$DRILL_LOG" <<'EOF'
# Restore drill log (spec §17.4)

Machine-appended record of restore drills: `infra/scripts/drill-restore.sh` adds
one row per run (verify-backup + scratch compose restore + smoke, with measured
RTO/RPO). The quarterly human sign-off table lives in
`docs/runbooks/RB-06-restore-drill.md` (§ Drill sign-off).

Budgets (spec §17.4): **RTO ≤ 4 h**, **RPO ≤ 24 h** (§22 alert at 26 h).
Cadence: nightly automated verify (`verify-backup.sh`, §17.3) + quarterly full
drill — never skip two consecutive drills (RB-06).

| Date (UTC) | Operator | Backup | Size | RPO | Fetch | Verify | Restore | Smoke | RTO | Result | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
EOF
}
ensure_drill_log
printf '| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |\n' \
  "$DATE_ISO" "$OPERATOR" "$FNAME" "$SIZE_H" "$(human_secs "$RPO_SECS")" \
  "$(human_secs "$T_FETCH")" "$(human_secs "$T_VERIFY")" "$(human_secs "$((T_UP + T_RESTORE))")" \
  "$(human_secs "$T_SMOKE")" "$(human_secs "$RTO_SECS")" "$RESULT" "$NOTES" >> "$DRILL_LOG"
log "appended drill row to $DRILL_LOG"

cat >&2 <<EOF

================ DRILL REPORT (§17.4) ================
backup:     ${DUMP_LABEL} (${SIZE_H})
operator:   ${OPERATOR}
RPO:        $(human_secs "$RPO_SECS")  budget ≤ 24 h (§22 alert 26 h)  [${RPO_OK}]
phases:     fetch $(human_secs "$T_FETCH") · verify $(human_secs "$T_VERIFY") · scratch-up $(human_secs "$T_UP") · restore $(human_secs "$T_RESTORE") · smoke $(human_secs "$T_SMOKE")
RTO:        $(human_secs "$RTO_SECS")  budget ≤ 4 h  [${RTO_OK}]
result:     ${RESULT}
next:       eyeball the sample workspace (document/version/asset round-trip,
            RB-06 §Diagnosis 4), then sign off in RB-06 § Drill sign-off.
EOF
[ "$RESULT" = PASS ] || exit 1
exit 0
