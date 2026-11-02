#!/usr/bin/env bash
# W5-01 recipe — boot the REAL stack (gateway :8787 + web :3000) on the SQLite
# dev DB. Prereq: `bash scripts/dev-sqlite.sh start` (seeded demo@studio.test /
# demo-password-12345). Full env schema: packages/config/src/env.ts — note it is
# AUTH_SECRET (not BETTER_AUTH_SECRET); MOCK_MODEL=true is legal only in
# APP_ENV=local; SQLite DATABASE_URL is local-only. Web needs
# GATEWAY_INTERNAL_URL (Next dev rewrites /v1/* → gateway, apps/web/next.config.ts).
# Usage: scripts/dev-stack.sh start|stop  (logs: .local/{gateway,web}-dev.log)
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.local/bin:$PATH"
# Model seam — pre-exported env wins so a real backend can be dropped in
# without editing this file (e.g. Token Harbor: MOCK_MODEL=false +
# LITELLM_BASE_URL=https://tokenharbor.ai + LITELLM_API_KEY=thk_live_… +
# LITELLM_MODEL_MAP='{"studio-fast":"…"}'; see packages/config/src/env.ts).
export APP_URL=http://localhost:3000 APP_ENV=local MOCK_MODEL="${MOCK_MODEL:-true}"
export DATABASE_URL="file:$REPO/.local/studio-dev.db"
# Same root for gateway + seed blobs (see scripts/dev-sqlite.sh — the demo
# .ecproj upload and the editor's download must resolve the SAME directory).
export STORAGE_FS_ROOT="${STORAGE_FS_ROOT:-$REPO/.local/storage}"
export AUTH_SECRET="${AUTH_SECRET:-dev-local-secret-0123456789abcdef0123456789abcdef}"
export AUTH_GOOGLE_ID=replace-me AUTH_GOOGLE_SECRET=replace-me AUTH_GITHUB_ID=replace-me AUTH_GITHUB_SECRET=replace-me
# better-auth trusted-origin wildcard for the sandbox Preview Panel (browser
# Origin https://preview-chat-<chat-id>.space-z.ai ≠ APP_URL). Pre-exported
# env wins; see packages/config/src/env.ts auth.trustedOrigins.
export AUTH_TRUSTED_ORIGINS="${AUTH_TRUSTED_ORIGINS:-https://*.space-z.ai}"
export STRIPE_WEBHOOK_SECRET=whsec_replace_me STRIPE_PRICE_IDS='{"starter":"price_starter","pro":"price_pro","studio":"price_studio"}'
export LITELLM_BASE_URL="${LITELLM_BASE_URL:-http://localhost:4000}" LITELLM_API_KEY="${LITELLM_API_KEY:-sk-litellm-replace-me}"
export LITELLM_MODEL_MAP="${LITELLM_MODEL_MAP:-}"
export ASSET_MAX_BYTES=524288000 PROJECT_MAX_BYTES=262144000 CHAT_MAX_STEPS=50
export NEXT_PUBLIC_APP_URL=http://localhost:3000 GATEWAY_INTERNAL_URL=http://127.0.0.1:8787
# NB: never export PORT — `next dev` honors it too and would steal 8787; the
# gateway default port is already 8787 (services/gateway/src/env.ts parsePort).
case "${1:-start}" in
start)
  # Web fonts (layout.tsx next/font/local) are NEVER committed (spec §1.5
  # rule 9) and are provisioned from the pinned google/fonts commit. dev:ready
  # does this in stage [3/4]; the stack script must too — pre-fix a FRESH
  # clone booted via dev-stack.sh 500'd on every page (next/font/local cannot
  # resolve the missing .ttf files). Idempotent + hash-verified, so this is a
  # no-op when the fonts are already present.
  node "$REPO/scripts/fetch-web-fonts.mjs" || \
    echo "dev-stack: WARN — web fonts missing and the fetch failed; the web app will 500 until 'corepack pnpm fonts:web' succeeds"
  (cd "$REPO/services/gateway" && nohup env PORT=8787 corepack pnpm dev >"$REPO/.local/gateway-dev.log" 2>&1 &)
  (cd "$REPO/apps/web" && nohup corepack pnpm dev >"$REPO/.local/web-dev.log" 2>&1 &)
  for _ in $(seq 1 60); do curl -sf -m 2 http://127.0.0.1:8787/v1/health >/dev/null && break; sleep 1; done
  echo "gateway: $(curl -sf -m 3 http://127.0.0.1:8787/v1/health)"
  for _ in $(seq 1 120); do code=$(curl -s -m 2 -o /dev/null -w '%{http_code}' http://localhost:3000/sign-in || true); [ "$code" = 200 ] && break; sleep 1; done
  echo "web: /sign-in -> $code" ;;
stop)
  pkill -f "tsx watch src/index.ts" 2>/dev/null || true; pkill -f "next dev" 2>/dev/null || true; sleep 2
  (ss -tln 2>/dev/null || netstat -tln 2>/dev/null) | grep -E ":3000 |:8787 " || echo "ports 3000/8787 free" ;;
esac
