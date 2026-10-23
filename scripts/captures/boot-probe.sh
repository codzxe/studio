#!/usr/bin/env bash
# W5-02 boot probe — boots the capture stack (edge :3100 → gateway :8787 +
# next :3000), times every stage, warms /sign-in + the editor route (Turbopack
# dev cache persists in .next/dev for the real capture run), then KILLS
# everything it started. Pure measurement — no captures.
set -u
cd "$(dirname "$0")/../.." || exit 1

EDGE_PORT=3100
WEB_PORT=3000
GATEWAY_PORT=8787
EDITOR_PATH=/w/demo-project/editor
ROOT="$(pwd)"
LOGS="$ROOT/scripts/captures/.logs"
mkdir -p "$LOGS"

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
  echo "[probe] killing ${#PIDS[@]} booted process groups"
  for pid in "${PIDS[@]:-}"; do
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  done
  sleep 1
  for pid in "${PIDS[@]:-}"; do
    kill -9 -- "-$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null || true
  done
  for p in 3100 3000 8787; do
    if (echo >/dev/tcp/127.0.0.1/$p) 2>/dev/null; then
      echo "[probe] WARN port $p still open"
    fi
  done
  echo "[probe] teardown complete"
}
trap cleanup EXIT TERM INT

T0=$(date +%s)
setsid node -e '
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

setsid bash -c 'cd services/gateway && exec corepack pnpm dev' >"$LOGS/gateway.log" 2>&1 &
PIDS+=($!)

setsid bash -c 'cd apps/web && exec corepack pnpm dev' >"$LOGS/web.log" 2>&1 &
PIDS+=($!)

wait_http() {
  local url="$1" name="$2" timeout="${3:-240}" start="$3"
  local t0; t0=$(date +%s)
  for _ in $(seq 1 "$timeout"); do
    if curl -sf -o /dev/null --max-time 2 "$url"; then
      echo "[probe] $name ready after $(( $(date +%s) - t0 ))s (wallclock +$(( $(date +%s) - T0 ))s)"
      return 0
    fi
    sleep 1
  done
  echo "[probe] $name NOT ready after ${timeout}s"
  return 1
}

wait_http "http://127.0.0.1:${GATEWAY_PORT}/v1/health" "gateway" 200 || {
  echo "[probe] gateway boot failed — log tail:"; tail -30 "$LOGS/gateway.log"; exit 1; }
wait_http "http://127.0.0.1:${WEB_PORT}/" "web(next)" 480 || {
  echo "[probe] web boot failed — log tail:"; tail -40 "$LOGS/web.log"; exit 1; }
wait_http "http://127.0.0.1:${EDGE_PORT}/" "edge" 60 || exit 1
echo "[probe] stack up"

echo "[probe] warming /sign-in …"
T=$(date +%s)
curl -sf -o /dev/null --max-time 300 "http://127.0.0.1:${EDGE_PORT}/sign-in" \
  && echo "[probe] /sign-in compiled in $(( $(date +%s) - T ))s" \
  || echo "[probe] WARN: /sign-in warmup failed"

JAR="$LOGS/warm-cookies.txt"
T=$(date +%s)
if curl -sf -c "$JAR" -o /dev/null --max-time 60 \
  -H "content-type: application/json" \
  -H "origin: http://127.0.0.1:${EDGE_PORT}" \
  -X POST "http://127.0.0.1:${EDGE_PORT}/v1/auth/sign-in/email" \
  -d '{"email":"demo@studio.test","password":"demo-password-12345"}'; then
  echo "[probe] API sign-in ok in $(( $(date +%s) - T ))s"
  T=$(date +%s)
  curl -s -b "$JAR" -o /dev/null -w "editor HTTP %{http_code} in %{time_total}s\n" --max-time 300 \
    "http://127.0.0.1:${EDGE_PORT}${EDITOR_PATH}"
  echo "[probe] editor warmup wallclock +$(( $(date +%s) - T0 ))s"
else
  echo "[probe] WARN: warmup sign-in failed — gateway log tail:"; tail -10 "$LOGS/gateway.log"
fi
rm -f "$JAR"

echo "[probe] web.log tail:"
tail -15 "$LOGS/web.log"
echo "[probe] TOTAL $(( $(date +%s) - T0 ))s"
