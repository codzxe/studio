#!/usr/bin/env bash
# scripts/e2e-run.sh — e2e README §5b external-stack runner (single-invocation:
# the sandbox reaps background stacks between calls, so boot + test + teardown
# must live in ONE bash invocation). Usage: scripts/e2e-run.sh <spec...> [extra playwright args]
#
# W1-E hardening (2026-10-24), after a root-caused gateway crash-loop:
#   - The gateway now boots WATCH-FREE (`tsx src/index.ts`, not the package's
#     `dev` = `tsx watch src/index.ts`). Root cause of the wave's flaky runs:
#     tsx watch registers an inotify watch on EVERY file under node_modules,
#     and this box caps a user at 8192 watches (fs.inotify.max_user_watches)
#     — a single watch-boot blew the budget, the gateway crashed with
#     ENOSPC mid-boot, and tsx respawned watcher-heavy children (six strays
#     observed from ONE boot), starving every later stack on the box. An
#     e2e run never edits gateway sources, so watch mode adds nothing.
#   - Teardown now kills the whole process GROUP of each setsid'd stack
#     leader (the old port-listener kill orphaned pnpm/tsx wrappers, which
#     kept burning watchers after the listener died).
#   - Pre-boot orphan sweep: any process whose /proc environ carries
#     PORT=8787 (the gateway tree inherits it) or whose cmdline is this
#     stack's `next dev --port 3000` is reaped, plus the port listeners.
set -uo pipefail
# Portable toolchain paths ($HOME, not a hardcoded user) + repo root derived
# from this script's own location, so the stack boots from any checkout.
export PATH="$HOME/.npm-global/bin:$HOME/.cargo/bin:$PATH"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# orphan cleanup (a previous run's gateway/next can hold :8787/:3000 or burn
# inotify watchers as crash-loop strays — environ/cmdline matched, never by
# bare "tsx" so sibling stacks on other ports stay untouched)
killed=0
for proc in /proc/[0-9]*; do
  pid=${proc#/proc/}
  [ "$pid" = "$$" ] && continue
  reason=""
  if [ -r "$proc/environ" ] && tr '\0' '\n' < "$proc/environ" 2>/dev/null | grep -qx 'PORT=8787'; then
    reason="gateway-stack stray (PORT=8787)"
  else
    cmd=$(tr '\0' ' ' < "$proc/cmdline" 2>/dev/null)
    case "$cmd" in
      *"next dev --port 3000"*) reason="web-stack stray (next dev :3000)";;
    esac
  fi
  if [ -n "$reason" ]; then
    kill -9 "$pid" 2>/dev/null && killed=$((killed + 1)) && echo "[boot] reaped pid $pid: $reason"
  fi
done
for port in 3000 8787; do
  pid=$(ss -tlnp "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | grep -o '[0-9]*')
  [ -n "$pid" ] && { kill -9 "$pid" 2>/dev/null; echo "[boot] killed orphan listener pid $pid on :$port"; }
done
echo "[boot] orphan sweep done ($killed environ/cmdline strays)"

export DATABASE_URL="file:$REPO/.local/e2e.db" \
  APP_URL=http://localhost:3000 NEXT_PUBLIC_APP_URL=http://localhost:3000 \
  APP_ENV=local MOCK_MODEL=true GATEWAY_INTERNAL_URL=http://127.0.0.1:8787 \
  AUTH_SECRET="dev-local-secret-0123456789abcdef0123456789abcdef" \
  AUTH_GOOGLE_ID=replace-me AUTH_GOOGLE_SECRET=replace-me \
  AUTH_GITHUB_ID=replace-me AUTH_GITHUB_SECRET=replace-me \
  STRIPE_WEBHOOK_SECRET=whsec_replace_me \
  STRIPE_PRICE_IDS='{"starter":"price_starter","pro":"price_pro","studio":"price_studio"}' \
  LITELLM_BASE_URL=http://localhost:4000 LITELLM_API_KEY=sk-litellm-replace-me \
  ASSET_MAX_BYTES=524288000 PROJECT_MAX_BYTES=262144000 CHAT_MAX_STEPS=50

# setsid ⇒ each leader's PGID == its pid; teardown kills the groups whole.
setsid bash -c "cd $REPO && PORT=8787 pnpm --filter @studio/gateway exec tsx src/index.ts" >/tmp/e2e-gw.log 2>&1 &
GW_LEADER=$!
setsid bash -c "cd $REPO && pnpm --filter @studio/web exec next dev --port 3000" >/tmp/e2e-web.log 2>&1 &
WEB_LEADER=$!

booted=0
for i in $(seq 1 90); do
  curl -sf http://127.0.0.1:3000/sign-in >/dev/null 2>&1 || { sleep 2; continue; }
  # any HTTP answer (even 404) proves the gateway is live — -f would
  # misread a 404-on-/ as "down"
  curl -s --max-time 2 -o /dev/null http://127.0.0.1:8787/ >/dev/null 2>&1 || { sleep 2; continue; }
  booted=1; break
done
if [ "$booted" != 1 ]; then
  echo "[boot] FAILED — gateway log tail:"; tail -20 /tmp/e2e-gw.log; echo "--- web log tail:"; tail -20 /tmp/e2e-web.log
  kill -9 -- -"$GW_LEADER" -"$WEB_LEADER" 2>/dev/null
  exit 90
fi
echo "[boot] stack up (gw :8787 + web :3000)"

cd "$REPO/apps/web"
E2E_BASE_URL=http://localhost:3000 pnpm exec playwright test "$@" --reporter=line
rc=$?

# teardown regardless of result: whole process groups, not just listeners
kill -9 -- -"$GW_LEADER" -"$WEB_LEADER" 2>/dev/null
for port in 3000 8787; do
  pid=$(ss -tlnp "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | grep -o '[0-9]*')
  [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null
done
echo "[teardown] stack down; playwright exit=$rc"
exit $rc
