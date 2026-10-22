#!/usr/bin/env bash
# scripts/dev-litellm.sh — boot the standalone LiteLLM stack
# (repo-root docker-compose.litellm.yml: litellm proxy + its dedicated
# PostgreSQL 17) on hosts that HAVE Docker.
#
# Docker-less hosts (like this repo's dev box — docs/AGENTS.md environment
# truth) are NOT an error: the script prints a pointer to the remote-deploy
# runbook and exits 0. Local chat development runs on the mock runner
# (MOCK_MODEL=true, the local .env default per D-16) and NEVER needs LiteLLM;
# tests never need it either.
#
# Usage:
#   scripts/dev-litellm.sh start   # compose up -d + wait for /health/liveliness
#   scripts/dev-litellm.sh stop    # compose down (keeps the DB volume)
#   scripts/dev-litellm.sh status  # probe /health/liveliness
#   scripts/dev-litellm.sh logs    # follow the litellm service logs
# Env: LITELLM_ENV_FILE (default: repo .env), LITELLM_URL (probe target),
#      plus the compose interpolation vars (LITELLM_MASTER_KEY, provider keys)
#      — see the header of docker-compose.litellm.yml and docs/deploy/LITELLM.md.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.litellm.yml"
RUNBOOK="docs/deploy/LITELLM.md"
LITELLM_URL="${LITELLM_URL:-http://127.0.0.1:4000}"
HEALTH_URL="$LITELLM_URL/health/liveliness"

log() { printf 'dev-litellm: %s\n' "$*" >&2; }
die() { printf 'dev-litellm: ERROR: %s\n' "$*" >&2; exit 1; }

# ── compose detection (v2 plugin or v1 binary) ───────────────────────────────
compose_cmd=()
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  compose_cmd=(docker compose)
elif command -v docker-compose >/dev/null 2>&1 && docker-compose version >/dev/null 2>&1; then
  compose_cmd=(docker-compose)
else
  printf 'Docker is not available on this machine — see docs/deploy/LITELLM.md for remote deployment.\n' >&2
  log "local chat dev is unaffected: the mock runner (MOCK_MODEL=true, the .env default per D-16) never needs LiteLLM;"
  log "optional no-Docker venv recipe: docs/deploy/LITELLM.md §Local dev without Docker."
  exit 0
fi

# Compose exists but the daemon may not be reachable (rootless box, stopped dockerd).
docker info >/dev/null 2>&1 \
  || die "Docker is installed but the daemon is not reachable — start it, or see $RUNBOOK."

[ -f "$COMPOSE_FILE" ] || die "missing $COMPOSE_FILE"
[ -f "$REPO_ROOT/deploy/litellm/config.yaml" ] || die "missing deploy/litellm/config.yaml"

ENV_FILE="${LITELLM_ENV_FILE:-$REPO_ROOT/.env}"
ENV_FILE_ARGS=()
if [ -f "$ENV_FILE" ]; then
  ENV_FILE_ARGS=(--env-file "$ENV_FILE")
  log "env file: $ENV_FILE"
else
  log "no env file found at $ENV_FILE — using exported environment only"
fi

# Fast, friendly pre-flight: the compose interpolation would also catch this,
# but the message below tells ops exactly what to generate.
if [ -z "${LITELLM_MASTER_KEY:-}" ] \
  && { [ ! -f "$ENV_FILE" ] || ! grep -Eq '^[[:space:]]*LITELLM_MASTER_KEY=' "$ENV_FILE"; }; then
  die "LITELLM_MASTER_KEY is not set — add it to $ENV_FILE (e.g. LITELLM_MASTER_KEY=\"sk-master-\$(openssl rand -hex 24)\"), then retry. See $RUNBOOK §Keys."
fi

# wait_healthy <seconds> — probe /health/liveliveness once per second.
wait_healthy() {
  local seconds="${1:-120}"
  command -v curl >/dev/null 2>&1 || { log "curl not found — cannot probe $HEALTH_URL; check: ${compose_cmd[*]} -f docker-compose.litellm.yml logs litellm"; return 0; }
  local i
  for i in $(seq 1 "$seconds"); do
    if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    if [ "$((i % 10))" -eq 0 ]; then
      log "waiting for $HEALTH_URL … ($i s; first boot migrates the LiteLLM DB)"
    fi
    sleep 1
  done
  return 1
}

start() {
  log "bringing up the LiteLLM stack (${compose_cmd[*]})"
  "${compose_cmd[@]}" -f "$COMPOSE_FILE" "${ENV_FILE_ARGS[@]}" up -d
  log "waiting for $HEALTH_URL …"
  wait_healthy || die "LiteLLM did not become healthy within 120s — inspect: ${compose_cmd[*]} -f docker-compose.litellm.yml logs litellm"
  print_summary
}

print_summary() {
  cat >&2 <<'SUMMARY'
LiteLLM is up — aliases: studio-fast · studio-smart · studio-vision

Set these in the APP env (packages/config/src/env.ts; runbook §Keys):
  LITELLM_BASE_URL=http://127.0.0.1:4000
  LITELLM_API_KEY=<platform key — mint via POST /key/generate with the MASTER key>
  LITELLM_VIRTUAL_KEY=<optional per-workspace budget key; unset in v1>

MOCK_MODEL=true (local .env default) keeps chat on the mock runner — set it
false to route the gateway through this proxy. Runbook: docs/deploy/LITELLM.md
SUMMARY
}

cmd="${1:-start}"
case "$cmd" in
  start) start ;;
  stop)
    "${compose_cmd[@]}" -f "$COMPOSE_FILE" "${ENV_FILE_ARGS[@]}" down
    log "stopped (DB volume kept — 'start' reuses it)"
    ;;
  status)
    if wait_healthy 5; then
      log "healthy: $HEALTH_URL"
    else
      die "not healthy: $HEALTH_URL (stack not up? run scripts/dev-litellm.sh start)"
    fi
    ;;
  logs)
    "${compose_cmd[@]}" -f "$COMPOSE_FILE" "${ENV_FILE_ARGS[@]}" logs -f litellm
    ;;
  *)
    printf 'usage: %s {start|stop|status|logs}\n' "${BASH_SOURCE[0]}" >&2
    sed -n '2,19p' "${BASH_SOURCE[0]}" >&2
    exit 2
    ;;
esac
