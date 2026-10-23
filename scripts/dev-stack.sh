#!/usr/bin/env bash
# W5-01 recipe — boot the REAL stack (gateway :8787 + web :3000) against the
# SQLite dev DB (.local/studio-dev.db; `bash scripts/dev-sqlite.sh start`
# first). Full env schema: packages/config/src/env.ts (AUTH_SECRET, not
# BETTER_AUTH_SECRET; MOCK_MODEL=true is legal only in APP_ENV=local; SQLite
# DATABASE_URL is local-only). Web needs GATEWAY_INTERNAL_URL (Next dev
# rewrite /v1/* → gateway, see apps/web/next.config.ts) + NEXT_PUBLIC_APP_URL.
# Usage: scripts/dev-stack.sh start|stop   (logs: .local/{gateway,web}-dev.log)
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.local/bin:$PATH"
export APP_URL=http://localhost:3000 APP_ENV=local MOCK_MODEL=true
export DATABASE_URL="file:$REPO/.local/studio-dev.db"
export AUTH_SECRET="${AUTH_SECRET:-dev-local-secret-0123456789abcdef0123456789abcdef}"
export AUTH_GOOGLE_ID=replace-me AUTH_GOOGLE_SECRET=replace-me
export AUTH_GITHUB_ID=replace-me AUTH_GITHUB_SECRET=replace-me
export STRIPE_WEBHOOK_SECRET=whsec_replace_me
export STRIPE_PRICE_IDS='{"starter":"price_starter","pro":"price_pro","studio":"price_studio"}'
export LITELLM_BASE_URL=http://localhost:4000 LITELLM_API_KEY=sk-litellm-replace-me
export ASSET_MAX_BYTES=524288000 PROJECT_MAX_BYTES=262144000 CHAT_MAX_STEPS=50
export NEXT_PUBLIC_APP_URL=http://localhost:3000 GATEWAY_INTERNAL_URL=http://127.0.0.1:8787
# NB: never export PORT here — `next dev` also honors PORT and would steal 8787.
# The gateway's own default port is 8787 (services/gateway/src/env.ts parsePort).
case "${1:-start}" in
start)
  (cd "$REPO/services/gateway" && nohup env PORT=8787 corepack pnpm dev >"$REPO/.local/gateway-dev.log" 2>&1 &)
  (cd "$REPO/apps/web" && nohup corepack pnpm dev >"$REPO/.local/web-dev.log" 2>&1 &)
  for _ in $(seq 1 60); do curl -sf -m 2 http://127.0.0.1:8787/v1/health >/dev/null && break; sleep 1; done
  echo "gateway: $(curl -sf -m 3 http://127.0.0.1:8787/v1/health)"
  for _ in $(seq 1 120); do code=$(curl -s -m 2 -o /dev/null -w '%{http_code}' http://localhost:3000/sign-in || true); [ "$code" = 200 ] && break; sleep 1; done
  echo "web: /sign-in -> $code"
  ;;
stop)
  pkill -f "tsx watch src/index.ts" 2>/dev/null || true
  pkill -f "next dev" 2>/dev/null || true
  sleep 2
  (ss -tln 2>/dev/null || netstat -tln 2>/dev/null) | grep -E ":3000 |:8787 " || echo "ports 3000/8787 free"
  ;;
esac
