#!/usr/bin/env bash
# boot-and-measure.sh — ONE-invocation perf round for the §6 budget scripts
# (scripts/perf/{editor-ready,api-latency}.mjs).
#
# Why this wrapper exists: the sandbox reaps background processes between Bash
# calls, so boot → measure → kill MUST share one invocation (worklog W1-A2 /
# W2-B8). The stack recipe is apps/web/e2e/README.md §5b verbatim: gateway on
# :8787 (MOCK_MODEL=true, seeded sqlite .local/e2e.db) + `next dev --port
# 3000`, browser at http://localhost:3000 (Next 16 dev-origin rule: NEVER
# 127.0.0.1 for the browser).
#
# Parallel-fleet etiquette: if the target ports are held by ANOTHER agent's
# live stack, this script WAITS for them to free (PERF_WAIT_PORTS seconds,
# default 300) instead of killing them. Pick side ports via PERF_GW_PORT /
# PERF_WEB_PORT to run beside a colleague's stack, or set PERF_FORCE_CLEANUP=1
# (kills listeners like README §5b's orphan cleanup) only when truly stuck.
#
# Usage:
#   scripts/perf/boot-and-measure.sh api      # gateway only → api-latency.mjs
#   scripts/perf/boot-and-measure.sh editor   # gateway + next dev → editor-ready.mjs
#   scripts/perf/boot-and-measure.sh apply    # gateway + next dev → apply-timing.mjs
# Env knobs: PERF_RUNS (default: 30 api / 5 editor / 3 apply), PERF_WAIT_PORTS (s),
# PERF_GW_PORT/PERF_WEB_PORT (side ports to dodge a fleet race),
# PERF_SKIP_SEED=1 to skip the idempotent re-seed, PERF_FORCE_CLEANUP=1.
set -euo pipefail

# Box toolchain (worklog wave-2 law): corepack is broken on this box — plain
# pnpm 9.15.9 from ~/.npm-global, exactly like scripts/e2e-run.sh.
export PATH="/home/z/.npm-global/bin:/home/z/.cargo/bin:$PATH"

MODE="${1:-}"
case "$MODE" in
  api | editor | apply) ;;
  *)
    echo "usage: $0 {api|editor|apply}" >&2
    exit 2
    ;;
esac

ROOT="/home/z/my-project"
DB_FILE="$ROOT/.local/e2e.db"
LOG_DIR="$ROOT/.local"
GW_LOG="/tmp/perf-gw.log"
WEB_LOG="/tmp/perf-web.log"
PIDS=()
# Port knobs: defaults are the canonical :8787/:3000, but parallel fleet agents
# race for those two — PERF_GW_PORT/PERF_WEB_PORT let a round run beside a
# colleague's live stack (better-auth origin checks ride APP_URL, which the
# wrapper derives from the web port, so nothing else changes).
GW_PORT="${PERF_GW_PORT:-8787}"
WEB_PORT="${PERF_WEB_PORT:-3000}"
WEB_ORIGIN="http://localhost:${WEB_PORT}"

log() { echo "[perf-boot $(date +%H:%M:%S)] $*"; }

cleanup() {
  local rc=$?
  set +e
  for pid in "${PIDS[@]}"; do
    [ -n "$pid" ] || continue
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
  done
  sleep 2
  for pid in "${PIDS[@]}"; do
    [ -n "$pid" ] || continue
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
  done
  # Port hygiene check (informational only — never kills other agents' procs).
  for port in "$WEB_PORT" "$GW_PORT"; do
    if ss -tlnH "sport = :$port" 2>/dev/null | grep -q .; then
      echo "[perf-boot $(date +%H:%M:%S)] NOTE: :$port still held after cleanup" >&2
    fi
  done
  exit "$rc"
}
trap cleanup EXIT INT TERM

port_busy() { ss -tlnH "sport = :$1" 2>/dev/null | grep -q .; }

# Next 16 enforces ONE dev server per app directory (a second `next dev`
# defers to the survivor and exits — observed on-box, W3-C7): the gateway
# ports alone are not the resource. "stack busy" therefore also means ANY
# next dev instance on the conventional 3000-3010 range, or any live
# next-server process, is enough to make a fresh boot racy.
stack_busy() {
  local p
  for p in $(seq 3000 3010); do
    port_busy "$p" && return 0
  done
  pgrep -f "next-server" >/dev/null 2>&1 && return 0
  return 1
}

# --- Wait for the fleet's ports (or optionally reclaim them) -----------------
WAITED=0
LIMIT="${PERF_WAIT_PORTS:-300}"
while stack_busy || port_busy "$GW_PORT"; do
  if [ "${PERF_FORCE_CLEANUP:-0}" = "1" ]; then
    for port in "$WEB_PORT" "$GW_PORT"; do
      pid=$(ss -tlnp "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | grep -o '[0-9]*' || true)
      if [ -n "$pid" ]; then
        log "FORCE_CLEANUP: killing :$port holder pid $pid"
        kill -9 "$pid" 2>/dev/null || true
      fi
    done
    sleep 2
    continue
  fi
  if [ "$WAITED" -ge "$LIMIT" ]; then
    log "ABORT: the shared dev stack (any next dev / :$GW_PORT) is still busy after ${LIMIT}s (raise PERF_WAIT_PORTS; side ports alone do NOT dodge the Next 16 one-server-per-dir lock)"
    exit 3
  fi
  [ "$WAITED" -eq 0 ] && log "dev stack busy (another agent's live next dev / gateway?) — waiting up to ${LIMIT}s"
  WAITED=$((WAITED + 5))
  sleep 5
done
log "dev stack quiet — ports :$WEB_PORT/:$GW_PORT free, no live next-server"

# --- Env block (e2e/README.md §5b; the two origins derive from the port knobs)
export DATABASE_URL="file:$DB_FILE" \
  APP_URL="$WEB_ORIGIN" NEXT_PUBLIC_APP_URL="$WEB_ORIGIN" \
  APP_ENV=local MOCK_MODEL=true GATEWAY_INTERNAL_URL="http://127.0.0.1:${GW_PORT}" \
  AUTH_SECRET="dev-local-secret-0123456789abcdef0123456789abcdef" \
  AUTH_GOOGLE_ID=replace-me AUTH_GOOGLE_SECRET=replace-me \
  AUTH_GITHUB_ID=replace-me AUTH_GITHUB_SECRET=replace-me \
  STRIPE_WEBHOOK_SECRET=whsec_replace_me \
  STRIPE_PRICE_IDS='{"starter":"price_starter","pro":"price_pro","studio":"price_studio"}' \
  LITELLM_BASE_URL=http://localhost:4000 LITELLM_API_KEY=sk-litellm-replace-me \
  ASSET_MAX_BYTES=524288000 PROJECT_MAX_BYTES=262144000 CHAT_MAX_STEPS=50

# --- Idempotent re-seed (packages/db/scripts/seed.ts replays cleanly) --------
if [ "${PERF_SKIP_SEED:-0}" != "1" ]; then
  log "re-seeding $DB_FILE (idempotent)"
  (cd "$ROOT" && pnpm --filter @studio/db seed >/tmp/perf-seed.log 2>&1) \
    || { log "seed FAILED (see /tmp/perf-seed.log)"; exit 4; }
  log "seed OK"
fi

# --- Boot the gateway ---------------------------------------------------------
# WATCH-FREE (`tsx src/index.ts`, not the package's `dev` = `tsx watch`): the
# W1-E e2e-run.sh hardening (2026-10-24) — tsx watch registers an inotify
# watch on EVERY file under node_modules and this box caps a user at 8192
# watches (ENOSPC crash-loop + watcher-heavy respawns). A perf round never
# edits gateway sources, and a watcher also adds CPU noise to the samples.
setsid bash -c "cd $ROOT && PORT=$GW_PORT pnpm --filter @studio/gateway exec tsx src/index.ts" \
  >"$GW_LOG" 2>&1 &
PIDS+=("$!")
log "gateway booting on :$GW_PORT (pgid ${PIDS[-1]}) — log $GW_LOG"
for i in $(seq 1 60); do
  curl -sf "http://127.0.0.1:${GW_PORT}/health" >/dev/null 2>&1 && break
  sleep 2
done
curl -sf "http://127.0.0.1:${GW_PORT}/health" >/dev/null 2>&1 \
  || { log "gateway never became healthy (see $GW_LOG)"; exit 5; }
log "gateway healthy: $(curl -sf "http://127.0.0.1:${GW_PORT}/health")"

# --- Boot next dev — browser modes (editor / apply) ---------------------------
if [ "$MODE" != "api" ]; then
  setsid bash -c "cd $ROOT && pnpm --filter @studio/web exec next dev --port $WEB_PORT" \
    >"$WEB_LOG" 2>&1 &
  PIDS+=("$!")
  log "next dev booting on :$WEB_PORT (pgid ${PIDS[-1]}) — log $WEB_LOG"
  # curl may use 127.0.0.1; only the BROWSER is bound to localhost (dev-origin rule).
  for i in $(seq 1 90); do
    curl -sf "http://127.0.0.1:${WEB_PORT}/sign-in" >/dev/null 2>&1 && break
    sleep 2
  done
  curl -sf "http://127.0.0.1:${WEB_PORT}/sign-in" >/dev/null 2>&1 \
    || { log "next dev never answered /sign-in (see $WEB_LOG)"; exit 6; }
  log "next dev ready on :$WEB_PORT"
fi

# --- Run the measurement -------------------------------------------------------
case "$MODE" in
  api)
    PERF_GATEWAY_URL="http://127.0.0.1:${GW_PORT}" PERF_RUNS="${PERF_RUNS:-30}" \
      node "$ROOT/scripts/perf/api-latency.mjs"
    ;;
  editor)
    PERF_BASE_URL="$WEB_ORIGIN" PERF_RUNS="${PERF_RUNS:-5}" \
      node "$ROOT/scripts/perf/editor-ready.mjs"
    ;;
  apply)
    PERF_BASE_URL="$WEB_ORIGIN" PERF_RUNS="${PERF_RUNS:-3}" \
      node "$ROOT/scripts/perf/apply-timing.mjs"
    ;;
esac
RC=$?
log "measurement script exit code: $RC — tearing down"
exit "$RC"
