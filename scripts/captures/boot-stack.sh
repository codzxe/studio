#!/usr/bin/env bash
# W3-I THROWAWAY capture boot — the e2e/README.md recipe, hand-booted
# (§5 "Hand-booted stack"): edge :3100 → gateway :8787 + next dev :3000,
# MOCK_MODEL=true on the SEEDED sqlite dev DB (.local/studio-dev.db).
# Kills EVERYTHING it started on exit (trap — the repo's kill-0 lesson).
set -u
cd "$(dirname "$0")/../.." || exit 1

EDGE_PORT=3100
WEB_PORT=3000
GATEWAY_PORT=8787
ROOT="$(pwd)"
LOGS="$ROOT/scripts/captures/.logs"
mkdir -p "$LOGS"

# ── env (the 34-var contract; secrets are placeholders — local only) ──
export APP_URL="http://127.0.0.1:${EDGE_PORT}"
export NEXT_PUBLIC_APP_URL="http://127.0.0.1:${EDGE_PORT}"
export APP_ENV=local
export LOG_LEVEL=warn
export MOCK_MODEL=true
export DATABASE_URL="file:${ROOT}/.local/studio-dev.db"
export VALKEY_URL=""
export S3_ENDPOINT=""
export S3_REGION=auto
export S3_ACCESS_KEY_ID=minioadmin
export S3_SECRET_ACCESS_KEY=minioadmin
export S3_BUCKET=studio-local
export ASSET_MAX_BYTES=524288000
export PROJECT_MAX_BYTES=262144000
export STRIPE_SECRET_KEY=sk_test_replace_me
export STRIPE_WEBHOOK_SECRET=whsec_replace_me
export STRIPE_PRICE_IDS='{"starter":"price_starter","pro":"price_pro","studio":"price_studio"}'
export AUTH_SECRET="$(openssl rand -base64 32)"
export AUTH_GOOGLE_ID=replace-me.apps.googleusercontent.com
export AUTH_GOOGLE_SECRET=replace-me
export AUTH_GITHUB_ID=replace-me
export AUTH_GITHUB_SECRET=replace-me
export LITELLM_BASE_URL=http://127.0.0.1:4000
export LITELLM_API_KEY=sk-litellm-replace-me
export LITELLM_VIRTUAL_KEY=sk-virtual-replace-me
export EDITOR_PUBLIC_PATH=/editor
export EDITOR_WASM_MAX_MB=18
export CHAT_MAX_STEPS=50
export RENDER_WORKER_ENABLED=false
export OTEL_EXPORTER_OTLP_ENDPOINT=""

PIDS=()
cleanup() {
  echo "[boot] killing ${#PIDS[@]} processes"
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  echo "[boot] all booted ports released"
}
trap cleanup EXIT TERM INT

# ── edge proxy (the playwright.config.ts inline node:http shape) ──
node -e '
const http = require("http");
const targets = { api: 8787, web: 3000 };
http.createServer((req, res) => {
  const port = req.url.startsWith("/v1") ? targets.api : targets.web;
  const upstream = http.request({ host: "127.0.0.1", port, method: req.method, path: req.url,
    headers: { ...req.headers, host: "127.0.0.1:" + port } }, (up) => {
    res.writeHead(up.statusCode || 502, up.headers);
    up.pipe(res);
  });
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("e2e edge: upstream not reachable yet");
  });
  req.pipe(upstream);
}).listen(3100, "127.0.0.1", () => console.log("e2e edge on 3100"));
' >"$LOGS/edge.log" 2>&1 &
PIDS+=($!)

# ── gateway (MOCK_MODEL=true; sqlite dev DB) ──
(cd services/gateway && corepack pnpm dev) >"$LOGS/gateway.log" 2>&1 &
PIDS+=($!)

# ── next dev (apps/web) ──
(cd apps/web && corepack pnpm dev) >"$LOGS/web.log" 2>&1 &
PIDS+=($!)

# ── readiness: edge answers (502 until upstreams live) + gateway + web ──
wait_http() {
  local url="$1" name="$2" timeout="${3:-240}"
  for _ in $(seq 1 "$timeout"); do
    if curl -sf -o /dev/null --max-time 2 "$url"; then
      echo "[boot] $name ready"
      return 0
    fi
    sleep 1
  done
  echo "[boot] $name NOT ready after ${timeout}s"
  return 1
}

wait_http "http://127.0.0.1:${GATEWAY_PORT}/v1/models" "gateway" 120 || exit 1
wait_http "http://127.0.0.1:${WEB_PORT}/" "web(next)" 240 || exit 1
wait_http "http://127.0.0.1:${EDGE_PORT}/" "edge" 60 || exit 1

echo "[boot] stack up: edge=${EDGE_PORT} gateway=${GATEWAY_PORT} web=${WEB_PORT}"
echo "[boot] logs at $LOGS"

# Stay up until signalled; the EXIT trap kills all three.
wait
