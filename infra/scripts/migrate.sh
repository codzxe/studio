#!/usr/bin/env bash
# =============================================================================
# infra/scripts/migrate.sh — one-shot Drizzle migration runner (§17.3, §4/§12)
# =============================================================================
# Migrations run FIRST in every deploy (§17.3) and are FORWARD-ONLY (§4):
# no down files, no manual prod edits; the drizzle journal
# (packages/db/migrations) is append-only. Old app code must tolerate the new
# schema for one deploy window (expand-contract discipline, §17.3).
#
# One-shot runner pattern — the documented contract for the gateway image:
#
#   docker compose --env-file ../../.env -f ../compose/docker-compose.yml \
#       run --rm --no-deps -e MIGRATE=1 gateway
#
# The gateway image ENTRYPOINT honors MIGRATE=1: instead of booting the API it
# runs `drizzle-kit migrate` (config: packages/db/drizzle.config.ts; SQL:
# packages/db/migrations; DATABASE_URL from the env file), then exits.
# `--rm` keeps it one-shot; `--no-deps` never restarts db/valkey. If the
# compose file defines a dedicated one-off `migrate` service, that wins
# (W1-L deploy.sh pattern).
#
# Usage:
#   infra/scripts/migrate.sh
# Env knobs: ENV_FILE, COMPOSE_FILE, POSTGRES_USER (readiness wait), NO_COLOR.
#
# Ordering rule (§17.5): never test a migration on production first —
# local → staging → prod; deploy-v2.sh always calls this before any restart.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_DIR/.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$SCRIPT_DIR/../compose/docker-compose.yml}"

compose() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

# env_get KEY — read one var from the env file without sourcing it (§15.2:
# env values never hit a shell parser; plain or quoted KEY=VALUE).
env_get() {
  grep -m1 -E "^$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- \
    | sed -e 's/^"//g' -e 's/"$//g' -e "s/^'//g" -e "s/'\$//g" || true
}

POSTGRES_USER="${POSTGRES_USER:-$(env_get POSTGRES_USER)}"; POSTGRES_USER="${POSTGRES_USER:-studio}"

# --- colored status output (NO_COLOR respected) --------------------------------
if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then
  C_G=$'\033[32m' C_Y=$'\033[33m' C_R=$'\033[31m' C_B=$'\033[34m' C_0=$'\033[0m'
else
  C_G='' C_Y='' C_R='' C_B='' C_0=''
fi
step() { printf '%s %s[migrate]%s %s\n' "$(date -u +%FT%TZ)" "$C_B" "$C_0" "$*" >&2; }
ok()   { printf '    %s✓%s %s\n' "$C_G" "$C_0" "$*" >&2; }
warn() { printf '    %s!%s %s\n' "$C_Y" "$C_0" "$*" >&2; }
err()  { printf '    %s✗%s %s\n' "$C_R" "$C_0" "$*" >&2; }
die()  { err "FATAL: $*"; exit 1; }

[ -r "$ENV_FILE" ] || die "env file not readable: $ENV_FILE — secrets are provisioned on the box only (infra/environments.md; ADR-0002)"
[ -r "$COMPOSE_FILE" ] || die "compose file not readable: $COMPOSE_FILE"

# --- pre-flight: the compose file must resolve ---------------------------------
compose config >/dev/null 2>&1 || die "compose config does not resolve (check ENV_FILE=$ENV_FILE / COMPOSE_FILE=$COMPOSE_FILE)"

# --- db must accept connections before drizzle touches schema ------------------
step "ensuring db is up (migrations never race a booting db)"
compose up -d db >/dev/null
ready=""
for _ in $(seq 1 60); do
  if compose exec -T db pg_isready -U "$POSTGRES_USER" >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
[ -n "$ready" ] || die "db never became ready (pg_isready -U $POSTGRES_USER) — aborting BEFORE touching schema"
ok "db ready"

# --- one-shot migration run ------------------------------------------------------
if compose config --services 2>/dev/null | grep -qx migrate; then
  step "running the one-off 'migrate' service (compose)"
  compose run --rm --no-deps migrate
else
  step "running the one-shot gateway runner (MIGRATE=1 → drizzle-kit migrate)"
  compose run --rm --no-deps -e MIGRATE=1 gateway
fi

ok "migrations applied — forward-only (§4): journal packages/db/migrations; NEVER delete journal rows, never hand-edit prod schema"
ok "next: restart the apps — infra/scripts/deploy-v2.sh runs this FIRST, then up -d --remove-orphans (§17.3)"
