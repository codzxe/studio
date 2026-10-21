#!/usr/bin/env bash
# =============================================================================
# infra/scripts/smoke.sh — post-deploy smoke / §17.3 health gate
# =============================================================================
# Checks (each named; ANY failure → exit 1 listing WHICH checks failed):
#   1  gateway liveness   GET /v1/health
#   2  gateway deep       GET /v1/health/deep (§13: db, valkey, engine-pool and
#                         provider probes must all be green → 200)
#   3  web                GET /health (web app origin)
#   4  queue up           worker health endpoint (the queue consumer) AND a
#                         valkey PING (the queue backend, §17.2)
#   5  engine (OPTIONAL)  `session.list` via a SCRATCH (throwaway) engine serve;
#                         auto-enabled when the mock engine is the configured
#                         engine (ENGINE_MOCK=1 / MOCK_ENGINE=1 — local and
#                         staging) or via --engine. --roundtrip additionally
#                         asks for a doc roundtrip (create → inspect → dispose).
#
# Targets (first match): --base-url > $SMOKE_BASE_URL > https://$APP_DOMAIN >
# internal mode = `docker compose exec` + node fetch inside the container
# (Caddy is the only published port, §17.2). Checks 1–3 follow the mode;
# check 4 always goes through compose; check 5 runs $ENGINE_SMOKE_CMD.
#
# ENGINE SMOKE WIRING — the optional check executes $ENGINE_SMOKE_CMD (env or
# env file). The command must exercise a SCRATCH serve and exit non-zero on
# failure:
#   - default mode: `session.list` must return successfully
#   - SMOKE_DOC_ROUNDTRIP=1 is exported for the command when --roundtrip is
#     passed (deploy-v2.sh does this when the mock engine is enabled):
#     doc create → inspect → dispose.
# Protocol truth: vendor/photocraft/docs/control-protocol.md + rpc.rs +
# commands.rs; the engine serve surface is owned by apps/engine-pool
# (src/spawners). Examples:
#   ENGINE_SMOKE_CMD='docker compose --env-file ../../.env -f infra/compose/docker-compose.yml exec -T engine-pool node /app/scripts/engine-smoke.mjs'
#   ENGINE_SMOKE_CMD='node apps/mock-engine/tests/selftest.mjs'   # dev box, repo clone
# Until ENGINE_SMOKE_CMD is wired the step reports SKIPPED (with the wiring
# hint) — it never fails an otherwise-green smoke.
#
# Usage:
#   infra/scripts/smoke.sh [--base-url URL] [--engine|--skip-engine] [--roundtrip]
# Exit codes: 0 all green; 1 one or more checks failed (names listed).
# Env: ENV_FILE, COMPOSE_FILE, SMOKE_TIMEOUT (10s), SMOKE_BASE_URL,
#      APP_DOMAIN / GATEWAY_INTERNAL / WEB_INTERNAL (env file),
#      WORKER_HEALTH_URL | WORKER_HEALTH_PORT, ENGINE_SMOKE_CMD, NO_COLOR.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_DIR/.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$SCRIPT_DIR/../compose/docker-compose.yml}"
SMOKE_TIMEOUT="${SMOKE_TIMEOUT:-10}"

compose() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

# env_get KEY — one var from the env file without sourcing it (§15.2). Missing
# file/keys yield empty (remote smokes must not require the box env file).
env_get() {
  [ -r "$ENV_FILE" ] || return 0
  grep -m1 -E "^$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- \
    | sed -e 's/^"//g' -e 's/"$//g' -e "s/^'//g" -e "s/'\$//g" || true
}

# --- colored status output -------------------------------------------------------
if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then
  C_G=$'\033[32m' C_Y=$'\033[33m' C_R=$'\033[31m' C_B=$'\033[34m' C_D=$'\033[2m' C_0=$'\033[0m'
else
  C_G='' C_Y='' C_R='' C_B='' C_D='' C_0=''
fi
step() { printf '%s %s[smoke]%s %s\n' "$(date -u +%FT%TZ)" "$C_B" "$C_0" "$*" >&2; }
warn() { printf '    %s!%s %s\n' "$C_Y" "$C_0" "$*" >&2; }
die()  { printf '    %s✗%s FATAL: %s\n' "$C_R" "$C_0" "$*" >&2; exit 1; }

CHECKS=0; SKIPPED=0; FAILED=()
pass_check() { CHECKS=$((CHECKS + 1)); printf '    %s✓%s %s — %s\n' "$C_G" "$C_0" "$1" "${2:-ok}" >&2; }
fail_check() { CHECKS=$((CHECKS + 1)); printf '    %s✗%s %s — %s\n' "$C_R" "$C_0" "$1" "${2:-failed}" >&2; FAILED+=("$1"); }
skip_check() { SKIPPED=$((SKIPPED + 1)); printf '    %s·%s %s — skipped (%s)\n' "$C_D" "$C_0" "$1" "${2:-not applicable}" >&2; }

usage() {
  cat <<'EOF'
infra/scripts/smoke.sh — §17.3 health gate: health endpoints + queue + optional engine smoke
Usage:
  infra/scripts/smoke.sh [--base-url URL] [--engine|--skip-engine] [--roundtrip]
    --base-url URL   target origin (else SMOKE_BASE_URL / https://$APP_DOMAIN /
                     internal compose-exec mode)
    --engine         force the optional engine smoke check on
    --skip-engine    force it off (even if the mock engine is enabled)
    --roundtrip      ask the engine smoke for a doc roundtrip (deploy-v2 uses
                     this when the mock engine is enabled)
Exit: 0 all green; 1 failed checks (names listed).
EOF
}

# --- args -------------------------------------------------------------------------
BASE_URL="${SMOKE_BASE_URL:-}"
OPT_ENGINE=0; OPT_SKIP_ENGINE=0; ROUNDTRIP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --base-url) [ $# -ge 2 ] || die "--base-url needs a URL"; BASE_URL="$2"; shift 2 ;;
    --engine) OPT_ENGINE=1; shift ;;
    --skip-engine) OPT_SKIP_ENGINE=1; shift ;;
    --roundtrip) ROUNDTRIP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; break ;;
    -*) die "unknown flag: $1 (see --help)" ;;
    *) die "unexpected argument: $1 (see --help)" ;;
  esac
done

# --- target resolution ---------------------------------------------------------------
if [ -z "$BASE_URL" ]; then
  d="$(env_get APP_DOMAIN)"
  if [ -n "$d" ]; then BASE_URL="https://$d"; fi
fi
INTERNAL=0
if [ -z "$BASE_URL" ]; then
  INTERNAL=1
  warn "no --base-url / SMOKE_BASE_URL / APP_DOMAIN — internal mode: compose exec + node fetch"
fi
step "target: ${BASE_URL:-<internal compose exec>}"

HAVE_COMPOSE=0
if command -v docker >/dev/null 2>&1 && [ -r "$COMPOSE_FILE" ]; then HAVE_COMPOSE=1; fi

# --- probes ----------------------------------------------------------------------------
curl_ok() { curl -fsS --max-time "$SMOKE_TIMEOUT" "$1" >/dev/null 2>&1; }

node_fetch_ok() { # svc url [timeout_s] — fetch inside <svc>'s container (node is
  # guaranteed in the app images; compose exec keeps us off published ports §17.2)
  compose exec -T "$1" node --input-type=module \
    -e "fetch(process.argv[1],{signal:AbortSignal.timeout(1*Number(process.argv[2]||3))}).then(r=>{if(!r.ok)throw new Error('HTTP '+r.status)}).then(()=>process.exit(0)).catch(()=>process.exit(1))" \
    "$2" "${3:-3}" >/dev/null 2>&1
}

gw() { # path — probe the gateway (mode-aware); §13 deep probes can be slow
  if [ "$INTERNAL" = "1" ]; then
    local gi="${GATEWAY_INTERNAL:-$(env_get GATEWAY_INTERNAL)}"; gi="${gi:-gateway:8787}"
    node_fetch_ok gateway "http://127.0.0.1:${gi##*:}$1" 20
  else
    curl_ok "$BASE_URL$1"
  fi
}

# --- 1..3: health endpoints ---------------------------------------------------------
step "check 1/5: gateway liveness — GET /v1/health"
if gw /v1/health; then
  pass_check "gateway /v1/health" "200"
else
  fail_check "gateway /v1/health" "no 200 — gateway down or not routed (Caddy)"
fi

step "check 2/5: gateway deep health — GET /v1/health/deep (§13 db/valkey/engine-pool/providers)"
if gw /v1/health/deep; then
  pass_check "gateway /v1/health/deep" "all probes green"
else
  fail_check "gateway /v1/health/deep" "non-200 — a §13 probe is degraded (triage: RB-02 queue / RB-03 engine / RB-04 provider)"
fi

step "check 3/5: web — GET /health"
if [ "$INTERNAL" = "1" ]; then
  wi="${WEB_INTERNAL:-$(env_get WEB_INTERNAL)}"; wi="${wi:-web:3000}"
  if node_fetch_ok web "http://127.0.0.1:${wi##*:}/health" 15; then
    pass_check "web /health" "200"
  else
    fail_check "web /health" "no 200 (web:$(env_get WEB_INTERNAL)) — container down or app erroring"
  fi
else
  if curl_ok "$BASE_URL/health"; then
    pass_check "web /health" "200"
  else
    fail_check "web /health" "no 200 at $BASE_URL/health"
  fi
fi

# --- 4: queue up (via worker health) ---------------------------------------------------
step "check 4/5: queue up — worker health + valkey PING"
if [ "$HAVE_COMPOSE" != "1" ]; then
  skip_check "queue up" "docker/compose unavailable from here — run smoke.sh on the box for this check"
else
  worker_health_detail=""
  worker_health_ok() {
    local url="${WORKER_HEALTH_URL:-$(env_get WORKER_HEALTH_URL)}"
    if [ -n "$url" ]; then
      if node_fetch_ok worker "$url" 5; then worker_health_detail="$url"; return 0; fi
      return 1
    fi
    local ports="${WORKER_HEALTH_PORT:-$(env_get WORKER_HEALTH_PORT)}" p
    [ -n "$ports" ] || ports="9101 9100 9090 8788 8787"
    for p in $ports; do
      if node_fetch_ok worker "http://127.0.0.1:$p/health" 3; then
        worker_health_detail="http://127.0.0.1:$p/health"
        return 0
      fi
    done
    return 1
  }
  w_ok=0; v_ok=0
  if worker_health_ok; then w_ok=1; fi
  pong="$(compose exec -T valkey valkey-cli ping 2>/dev/null || true)"
  if [ "$pong" = "PONG" ]; then v_ok=1; fi
  if [ "$w_ok" = "1" ] && [ "$v_ok" = "1" ]; then
    pass_check "queue up" "worker health ${worker_health_detail} + valkey PONG"
  else
    fail_check "queue up" "worker=${w_ok} (${worker_health_detail:-set WORKER_HEALTH_URL or WORKER_HEALTH_PORT — owner: apps/worker/src/health.ts}) valkey-PING=${v_ok}"
  fi
fi

# --- 5: optional engine smoke — session.list via a scratch serve ------------------------
step "check 5/5: engine smoke — session.list via a scratch serve (optional)"
mock_val="${ENGINE_MOCK:-$(env_get ENGINE_MOCK)}"; mock_val2="${MOCK_ENGINE:-$(env_get MOCK_ENGINE)}"
MOCK_ENGINE_ON=0
case "$mock_val" in 1|[Tt]rue|yes) MOCK_ENGINE_ON=1 ;; esac
case "$mock_val2" in 1|[Tt]rue|yes) MOCK_ENGINE_ON=1 ;; esac
ENGINE_SMOKE_CMD="${ENGINE_SMOKE_CMD:-$(env_get ENGINE_SMOKE_CMD)}"

if [ "$OPT_SKIP_ENGINE" = "1" ]; then
  skip_check "engine smoke" "--skip-engine"
elif [ "$OPT_ENGINE" != "1" ] && [ "$MOCK_ENGINE_ON" != "1" ]; then
  skip_check "engine smoke" "optional — pass --engine or set ENGINE_MOCK=1/MOCK_ENGINE=1 to enable"
elif [ -z "$ENGINE_SMOKE_CMD" ]; then
  skip_check "engine smoke" "enabled but ENGINE_SMOKE_CMD not wired — see the 'ENGINE SMOKE WIRING' section in this file's header"
else
  detail="session.list via scratch serve"
  if [ "$ROUNDTRIP" = "1" ]; then
    detail="doc roundtrip (create→inspect→dispose) + $detail"
    export SMOKE_DOC_ROUNDTRIP=1
  fi
  if sh -c "$ENGINE_SMOKE_CMD"; then
    pass_check "engine smoke" "$detail"
  else
    fail_check "engine smoke" "ENGINE_SMOKE_CMD exited non-zero ($detail)"
  fi
fi

# --- summary ---------------------------------------------------------------------------
if [ "${#FAILED[@]}" -gt 0 ]; then
  printf '    %s✗%s SMOKE FAILED — failed checks:\n' "$C_R" "$C_0" >&2
  printf '        %s\n' "${FAILED[@]}" >&2
  exit 1
fi
printf '    %s✓%s SMOKE GREEN — %d checks, %d skipped\n' "$C_G" "$C_0" "$CHECKS" "$SKIPPED" >&2
exit 0
