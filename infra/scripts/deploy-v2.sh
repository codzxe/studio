#!/usr/bin/env bash
# =============================================================================
# infra/scripts/deploy-v2.sh — the §17.3 on-main deploy: CI builds, box pulls
# =============================================================================
# Flow (spec §17.3 "build images in CI, deploy with compose pull"):
#
#   pre-flight  env file readable · image-tag pin (app:<sha>, never :latest)
#               · engine pin (ADR-0001) · disk headroom (§17.4 RB-05)
#   images      `docker compose pull` (CI pushed app:<sha> to GHCR)
#               OR on-box `compose build` (--build / BUILD_ON_BOX=1 — bootstrap)
#   migrate     Drizzle migrations FIRST via the one-shot runner:
#               infra/scripts/migrate.sh  (compose run --rm -e MIGRATE=1
#               gateway; forward-only §4 — old code tolerates the new schema
#               for one deploy window)
#   up          `docker compose up -d --remove-orphans`
#   smoke       infra/scripts/smoke.sh --roundtrip — health endpoints + queue +
#               a doc roundtrip via the mock engine when it is enabled
#   failure     prints exact rollback.sh instructions; the previous TWO
#               app:<sha> images are kept on the box for instant repin (§17.3)
#
# Tag scheme (shared with rollback.sh): CI tags every main build
#   ghcr.io/<owner>/<svc>:<git-sha>
# IMAGE_TAG resolution: env IMAGE_TAG > git HEAD of the box clone > FATAL.
# App services should interpolate ${IMAGE_TAG} in infra/compose (flagged for
# its owner); where pins are hardcoded, rollback.sh repins via `docker tag`.
#
# The DATABASE is never auto-rolled-back (forward-only migrations, §4) —
# manual psql / restore pointers live in rollback.sh.
#
# Usage:
#   infra/scripts/deploy-v2.sh [--build] [service ...]
#     --build      build app images on the box (bootstrap fallback; the prod
#                  path is CI → GHCR, §17.3)
#     service ...  restrict `up` to these services (default: whole stack);
#                  migrations still run first.
#
# Knobs: ENV_FILE, COMPOSE_FILE, IMAGE_TAG, ENGINE_PIN, ALLOW_LATEST=1,
#        MIN_FREE_MB (5120), APP_SERVICES, STATE_DIR, BUILD_ON_BOX, NO_COLOR.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_DIR/.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$SCRIPT_DIR/../compose/docker-compose.yml}"

STATE_DIR="${STATE_DIR:-/var/lib/studio-deploy}"   # box-local bookkeeping, never in the repo
MIN_FREE_MB="${MIN_FREE_MB:-5120}"                  # 5 GiB headroom for images + migrate (§17.4 RB-05)
ALLOW_LATEST="${ALLOW_LATEST:-0}"
BUILD_ON_BOX="${BUILD_ON_BOX:-0}"
APP_SERVICES="${APP_SERVICES:-gateway worker engine-pool web}"
ENGINE_PIN_EXPECTED="872748fb"                      # ADR-0001 engine pin (docs/adr/0001-editor-pin.md)

compose() { IMAGE_TAG="${IMAGE_TAG:-}" docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

env_get() {
  grep -m1 -E "^$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- \
    | sed -e 's/^"//g' -e 's/"$//g' -e "s/^'//g" -e "s/'\$//g" || true
}

app_images() { # services... → resolved image refs (one per line)
  local out
  out="$(compose config --images "$@" 2>/dev/null || true)"
  if [ -z "$out" ]; then
    out="$(compose config "$@" 2>/dev/null | sed -n 's/^ *image: *//p' | tr -d '"' || true)"
  fi
  printf '%s\n' "$out"
}

# --- colored status output (§17.3 deploy UX; NO_COLOR respected) ---------------------
if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then
  C_G=$'\033[32m' C_Y=$'\033[33m' C_R=$'\033[31m' C_B=$'\033[34m' C_0=$'\033[0m'
else
  C_G='' C_Y='' C_R='' C_B='' C_0=''
fi
step() { printf '%s %s[deploy-v2]%s %s\n' "$(date -u +%FT%TZ)" "$C_B" "$C_0" "$*" >&2; }
ok()   { printf '    %s✓%s %s\n' "$C_G" "$C_0" "$*" >&2; }
warn() { printf '    %s!%s %s\n' "$C_Y" "$C_0" "$*" >&2; }
err()  { printf '    %s✗%s %s\n' "$C_R" "$C_0" "$*" >&2; }
die()  { err "FATAL: $*"; exit 1; }

usage() {
  cat <<'EOF'
infra/scripts/deploy-v2.sh — §17.3 deploy: pre-flight → pull/build → migrate → up → smoke
Usage:
  infra/scripts/deploy-v2.sh [--build] [service ...]
    --build       build app images on the box (bootstrap; prod path is CI→GHCR)
    service ...   restrict `up` to these services (default: whole stack);
                  migrations still run first
Env knobs: ENV_FILE, COMPOSE_FILE, IMAGE_TAG, ENGINE_PIN, ALLOW_LATEST,
MIN_FREE_MB, APP_SERVICES, STATE_DIR, BUILD_ON_BOX, NO_COLOR
(see infra/environments.md).
EOF
}

rollback_help() {
  cat >&2 <<EOF
${C_R}── rollback (§17.3) ─────────────────────────────────────────────────${C_0}
The previous TWO app:<sha> images are kept on the box. Repin them with:
  infra/scripts/rollback.sh                    # back to the previous tag
  infra/scripts/rollback.sh --tag <sha>         # or any kept tag
  infra/scripts/rollback.sh gateway worker      # app tier only
The DATABASE is never auto-rolled-back (forward-only migrations, §4):
  • failed during 'migrate' → the running stack was NOT restarted; fix the
    migration and re-run (the drizzle journal skips applied files — never
    delete journal rows).
  • failed after 'migrate'  → old code must tolerate the new schema for one
    deploy window (§17.3 expand-contract discipline).
  • NEVER hand-edit the prod DB — manual psql/restore pointers: rollback.sh.
Logs:     docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" logs --tail 100 <svc>
Runbooks: docs/runbooks/ (§17.4).
EOF
}

CURRENT="startup"
on_err() {
  local code="$1" line="$2"
  err "deploy FAILED during '${CURRENT}' (line ${line}, exit ${code})"
  rollback_help
  exit "$code"
}
trap 'on_err $? "$LINENO"' ERR

# --- args -----------------------------------------------------------------------------
SERVICES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --build) BUILD_ON_BOX=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; while [ $# -gt 0 ]; do SERVICES+=("$1"); shift; done ;;
    -*) die "unknown flag: $1 (see --help)" ;;
    *) SERVICES+=("$1"); shift ;;
  esac
done

# --- state bookkeeping (rollback.sh reads this) -----------------------------------------
ensure_state_dir() {
  if ! mkdir -p "$STATE_DIR" 2>/dev/null; then
    STATE_DIR="$HOME/.cache/studio-deploy"
    mkdir -p "$STATE_DIR" 2>/dev/null || die "cannot create STATE_DIR ($STATE_DIR) — set STATE_DIR"
    warn "STATE_DIR fallback (not root): $STATE_DIR"
  fi
  STATE_FILE="$STATE_DIR/deploy-state.env"
  HISTORY_FILE="$STATE_DIR/tag-history.log"
}

record_state() {
  ensure_state_dir
  local prev="" scope="${SERVICES[*]:-ALL}"
  if [ -r "${STATE_FILE:-}" ]; then
    prev="$(grep -m1 -E '^IMAGE_TAG_CURRENT=' "$STATE_FILE" | cut -d= -f2- || true)"
  fi
  {
    echo "# box-local deploy bookkeeping — written by deploy-v2.sh, read by rollback.sh"
    echo "# tags/timestamps only; NEVER secrets. Outside the repo on purpose."
    echo "IMAGE_TAG_CURRENT=$IMAGE_TAG"
    if [ "$scope" = "ALL" ] && [ -n "$prev" ] && [ "$prev" != "$IMAGE_TAG" ]; then
      echo "IMAGE_TAG_PREVIOUS=$prev"
    elif [ -r "$STATE_FILE" ]; then
      grep -E '^IMAGE_TAG_PREVIOUS=' "$STATE_FILE" || true
    fi
    echo "DEPLOYED_AT=$(date -u +%FT%TZ)"
  } > "${STATE_FILE}.tmp"
  mv "${STATE_FILE}.tmp" "$STATE_FILE"
  printf '%s deploy %s scope=%s\n' "$(date -u +%FT%TZ)" "$IMAGE_TAG" "$scope" >> "$HISTORY_FILE"
  ok "state recorded: current=$IMAGE_TAG previous=${prev:-none} ($STATE_FILE)"
}

# --- pre-flight checks --------------------------------------------------------------------
free_mb_of() {
  local p="$1"
  [ -d "$p" ] || p="/"
  df -Pm "$p" | awk 'NR==2 {print $4}'
}

preflight_pin() {
  # a) the exact tag being deployed — app:<sha> scheme (rollback.sh depends on it)
  if [ -z "${IMAGE_TAG:-}" ]; then
    IMAGE_TAG="$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || true)"
  fi
  case "$IMAGE_TAG" in
    "")
      die "cannot resolve IMAGE_TAG (no git HEAD in $REPO_DIR) — CI tags app images app:<git-sha>; pass IMAGE_TAG=<sha>"
      ;;
    latest)
      if [ "$ALLOW_LATEST" != "1" ]; then
        die "refusing IMAGE_TAG=latest — deploys are pinned app:<sha> (§17.3); set ALLOW_LATEST=1 to override"
      fi
      warn "deploying :latest — rollback.sh cannot repin a moving tag"
      ;;
  esac
  ok "IMAGE_TAG=${IMAGE_TAG}"

  # b) app images in the resolved compose config must carry real pins
  local latest_refs
  latest_refs="$(app_images $APP_SERVICES | grep -E ':latest$' || true)"
  if [ -n "$latest_refs" ]; then
    if [ "$ALLOW_LATEST" = "1" ]; then
      warn "unpinned app images tolerated (ALLOW_LATEST=1): $(printf '%s ' $latest_refs)"
    else
      err "unpinned app images in compose config:"
      printf '      %s\n' $latest_refs >&2
      die "pin app services to app:<sha> tags (§17.3) or set ALLOW_LATEST=1"
    fi
  else
    ok "app image pins: $(app_images $APP_SERVICES | tr '\n' ' ')"
  fi

  # c) engine pin (ADR-0001) — warn loudly, never silently deploy a stale engine
  local engine_pin
  engine_pin="${ENGINE_PIN:-$(env_get ENGINE_PIN)}"
  if [ -n "$engine_pin" ]; then
    case "$engine_pin" in
      "$ENGINE_PIN_EXPECTED"*) ok "engine pin ok: $engine_pin (ADR-0001)" ;;
      *) warn "ENGINE_PIN=$engine_pin ≠ $ENGINE_PIN_EXPECTED… (ADR-0001) — engine image may be stale" ;;
    esac
  else
    warn "ENGINE_PIN not set in $ENV_FILE — engine image pin not verified (ADR-0001 expects $ENGINE_PIN_EXPECTED…)"
  fi
}

preflight_disk() {
  local root p free
  root="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"
  for p in "$root" "$REPO_DIR"; do
    free="$(free_mb_of "$p")"
    if [ "${free:-0}" -lt "$MIN_FREE_MB" ]; then
      die "low disk: ${free:-?}MiB free on $p — need ≥ ${MIN_FREE_MB}MiB (§17.4 RB-05: the engine pool is killed before Postgres starves)"
    fi
    ok "disk ${p}: ${free}MiB free"
  done
}

# --- 0. pre-flight (§17.3) ------------------------------------------------------------------
CURRENT="pre-flight"
step "pre-flight: env file"
[ -r "$ENV_FILE" ] || die "env file not readable: $ENV_FILE — secrets are provisioned on the box only (infra/environments.md; ADR-0002)"
[ -r "$COMPOSE_FILE" ] || die "compose file not readable: $COMPOSE_FILE"
ok "env file: $ENV_FILE"

step "pre-flight: pin check (app:<sha> tag scheme)"
preflight_pin

step "pre-flight: disk headroom (≥ ${MIN_FREE_MB}MiB)"
preflight_disk

# --- 1. images (§17.3: CI builds → GHCR; the box only pulls) ---------------------------------
CURRENT="images"
if [ "$BUILD_ON_BOX" = "1" ]; then
  step "on-box build (BUILD_ON_BOX bootstrap; prod path is CI → GHCR, §17.3)"
  compose build
  ok "app images built"
else
  step "docker compose pull (tag: ${IMAGE_TAG})"
  compose pull
  ok "images pulled"
fi

# --- 2. migrations FIRST (§17.3; forward-only §4) ---------------------------------------------
CURRENT="migrate"
step "migrations first — one-shot runner (drizzle-kit migrate)"
"$SCRIPT_DIR/migrate.sh"

# --- 3. up -------------------------------------------------------------------------------------
CURRENT="up"
step "docker compose up -d --remove-orphans ${SERVICES[*]:-<full stack>}"
if [ "${#SERVICES[@]}" -gt 0 ]; then
  compose up -d --remove-orphans "${SERVICES[@]}"
else
  compose up -d --remove-orphans
fi
ok "stack up"

# --- 4. post-deploy smoke (§17.3 health gate) ---------------------------------------------------
CURRENT="smoke"
step "post-deploy smoke (health endpoints + doc roundtrip via mock, if enabled)"
if ! "$SCRIPT_DIR/smoke.sh" --roundtrip; then
  err "post-deploy smoke FAILED (see the failed check names above)"
  rollback_help
  exit 2
fi
ok "smoke green"

# --- 5. record state (rollback.sh reads this) ----------------------------------------------------
CURRENT="state"
step "recording deploy state (for rollback.sh)"
record_state

step "deploy COMPLETE (tag ${IMAGE_TAG})"
warn "watch §17.4 for the next hour: engine crash rate (RB-03), provider breakers (RB-04), queue backlog (RB-02)"
