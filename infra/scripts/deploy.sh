#!/usr/bin/env bash
# =============================================================================
# infra/scripts/deploy.sh — pull, migrate, restart, health-gate (spec §17.3)
# =============================================================================
# The §17.3 on-main deploy flow, on a single box, ONE SERVICE AT A TIME:
#   1. pull images (CI ships multi-arch images to GHCR; on-box `build` is the
#      pre-Wave-9 bootstrap fallback, toggle with BUILD_ON_BOX=1)
#   2. run Drizzle migrations FIRST (forward-only, §4/§12 — never after the
#      restart; old code must tolerate new schema for one deploy window)
#   3. `compose up -d --no-deps <service>` per service
#   4. health check loop; a service that never turns healthy aborts the run
#      → ROLLBACK (§17.3: previous two images are kept for instant rollback)
#
# Usage:
#   infra/scripts/deploy.sh [service ...]     # default: db valkey, then apps
#
# Rollback (§17.3, keep the previous TWO images):
#   images-from-GHCR: repin the tag in the image: field / env and rerun this
#   script for that service. On-box builds: `git checkout <last-good> &&
#   BUILD_ON_BOX=1 infra/scripts/deploy.sh <service>`.
#
# No secrets inline (§15.2): everything comes from ../../.env.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/../../.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$SCRIPT_DIR/../compose/docker-compose.yml}"
compose() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

# env_get KEY — read one var from $ENV_FILE without sourcing it (never let
# .env content hit a shell parser; values are plain or quoted KEY=VALUE).
env_get() {
  grep -m1 -E "^$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- \
    | sed -e 's/^"//g' -e 's/"$//g' -e "s/^'//g" -e "s/'\$//g" || true
}

POSTGRES_USER="${POSTGRES_USER:-$(env_get POSTGRES_USER)}"; POSTGRES_USER="${POSTGRES_USER:-studio}"

BUILD_ON_BOX="${BUILD_ON_BOX:-0}"   # 1 = build app images locally (bootstrap)
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"  # seconds per service to reach healthy

log() { printf '[deploy] %s %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
die() { log "FATAL: $*"; exit 1; }

[ -r "$ENV_FILE" ] || die "env file not readable: $ENV_FILE — see infra/README.md"

# Service set: explicit args win; default = infra (must be up first, §17.2),
# then the app/proxy stack in dependency order.
if [ "$#" -gt 0 ]; then
  SERVICES=("$@")
else
  SERVICES=(gateway worker engine-pool web caddy)
fi

# --- preflight: infra up (db + valkey healthy before anything touches them) --
log "ensuring infra: db + valkey"
compose up -d db valkey >/dev/null
for _ in $(seq 1 60); do
  compose exec -T db pg_isready -U "$POSTGRES_USER" >/dev/null 2>&1 && break
  sleep 2
done
compose exec -T db pg_isready -U "$POSTGRES_USER" >/dev/null \
  || die "db never became ready — aborting before any change (nothing was touched)"

# --- 1. images ----------------------------------------------------------------
if [ "$BUILD_ON_BOX" = "1" ]; then
  log "BUILD_ON_BOX=1: building app images locally (bootstrap mode; prod path is GHCR, §17.3)"
  compose build
else
  # §17.3: on main, CI builds and pushes to GHCR; the box only pulls.
  # --ignore-pull-failures: build-stanza services without a registry image
  # still proceed (they must have been built previously or deploy will fail
  # honestly at `up`).
  compose pull --ignore-pull-failures >&2 || true
fi

# --- 2. migrations FIRST (§17.3) ----------------------------------------------
if compose config --services 2>/dev/null | grep -qx migrate; then
  log "running Drizzle migrations (forward-only, §4) via one-off `migrate` service"
  compose run --rm --no-deps migrate
else
  log "NOTE: no `migrate` service defined yet — migrations NOT run."
  log "      TODO(Wave 9): add a one-off migrate service (drizzle-kit migrate,"
  log "      packages/db/drizzle.config.ts) and this step picks it up automatically."
  log "      Until then run migrations manually BEFORE the restart (§17.3)."
fi

# --- health-gate helper -------------------------------------------------------
wait_healthy() {
  local svc="$1" waited=0 id status
  local ids; ids="$(compose ps -q "$svc")"
  [ -n "$ids" ] || { log "no container found for $svc"; return 1; }
  for id in $ids; do  # worker has 2 replicas (§17.2) — gate each container
    waited=0
    while :; do
      status="$(docker inspect -f '{{.State.Status}}' "$id")"
      [ "$status" = "running" ] || { log "$svc container exited"; return 1; }
      [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id")" = "healthy" ] && break
      sleep 2
      waited=$((waited + 2))
      [ "$waited" -ge "$HEALTH_TIMEOUT" ] && { log "$svc not healthy after ${HEALTH_TIMEOUT}s"; return 1; }
    done
    log "$svc container ${id::12} healthy (${waited}s)"
  done
}

# --- 3+4. rolling restart, one service at a time (§17.3) -----------------------
FAILED=""
for svc in "${SERVICES[@]}"; do
  log "deploying: $svc"
  compose up -d --no-deps "$svc" >/dev/null
  if wait_healthy "$svc"; then
    log "OK: $svc"
  else
    # ROLLBACK NOTE (§17.3): stop here — do NOT continue onto later services.
    # Repin the previous image tag (or last-good commit with BUILD_ON_BOX=1)
    # and rerun this script for $svc only. Diagnose with:
    #   docker compose --env-file ../../.env logs --tail 100 "$svc"
    log "ROLLBACK REQUIRED for $svc (previous two images are kept, §17.3) — halting rollout"
    FAILED="$svc"
    break
  fi
done

if [ -n "$FAILED" ]; then
  log "deploy ABORTED at $FAILED; earlier services stay on the new version."
  exit 1
fi

log "deploy complete: ${SERVICES[*]}"
log "post-deploy smoke (§17.3 health gate):"
log "  curl -fsS https://\${APP_DOMAIN}/v1/health/deep   # all probes green"
log "watch engine-pool crash rate / provider breakers for the next hour (§17.4 runbooks)."
