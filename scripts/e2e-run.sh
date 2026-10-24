#!/usr/bin/env bash
# scripts/e2e-run.sh — e2e README §5b external-stack runner (single-invocation:
# the sandbox reaps background stacks between calls, so boot + test + teardown
# must live in ONE bash invocation). Usage: scripts/e2e-run.sh <spec...> [extra playwright args]
set -uo pipefail
export PATH="/home/z/.npm-global/bin:/home/z/.cargo/bin:$PATH"
REPO=/home/z/my-project

# orphan cleanup (a previous run's gateway/next can hold :8787/:3000)
for port in 3000 8787; do
  pid=$(ss -tlnp "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | grep -o '[0-9]*')
  [ -n "$pid" ] && { kill -9 "$pid" 2>/dev/null; echo "[boot] killed orphan pid $pid on :$port"; }
done

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

setsid bash -c "cd $REPO && PORT=8787 pnpm --filter @studio/gateway dev" >/tmp/e2e-gw.log 2>&1 &
setsid bash -c "cd $REPO && pnpm --filter @studio/web exec next dev --port 3000" >/tmp/e2e-web.log 2>&1 &

booted=0
for i in $(seq 1 90); do
  curl -sf http://127.0.0.1:3000/sign-in >/dev/null 2>&1 && { booted=1; break; }
  sleep 2
done
if [ "$booted" != 1 ]; then
  echo "[boot] FAILED — gateway log tail:"; tail -20 /tmp/e2e-gw.log; echo "--- web log tail:"; tail -20 /tmp/e2e-web.log
  exit 90
fi
echo "[boot] stack up (gw :8787 + web :3000)"

cd "$REPO/apps/web"
E2E_BASE_URL=http://localhost:3000 pnpm exec playwright test "$@" --reporter=line
rc=$?

# teardown regardless of result
for port in 3000 8787; do
  pid=$(ss -tlnp "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | grep -o '[0-9]*')
  [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null
done
echo "[teardown] stack down; playwright exit=$rc"
exit $rc
