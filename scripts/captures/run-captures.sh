#!/usr/bin/env bash
# W3-I THROWAWAY runner — boots the e2e recipe stack, runs the real captures,
# post-processes the demo loop with ffmpeg, and KILLS EVERYTHING it started
# (trap; the repo's kill-0 lesson). One Bash invocation owns the whole run:
# the sandbox reaps background processes between tool calls, so the stack
# must live and die inside this single script.
set -u
cd "$(dirname "$0")/../.." || exit 1

EDGE_PORT=3100
WEB_PORT=3000
GATEWAY_PORT=8787
ROOT="$(pwd)"
LOGS="$ROOT/scripts/captures/.logs"
RAW="$ROOT/scripts/captures/.raw"
OUT="$ROOT/apps/web/public/marketing"
mkdir -p "$LOGS" "$RAW" "$OUT"

# ── env (the 34-var contract; placeholders are local-only) ────────────────
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
  echo "[runner] killing ${#PIDS[@]} booted process groups"
  for pid in "${PIDS[@]:-}"; do
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  done
  sleep 1
  for pid in "${PIDS[@]:-}"; do
    kill -9 -- "-$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null || true
  done
  for p in 3100 3000 8787; do
    if (echo >/dev/tcp/127.0.0.1/$p) 2>/dev/null; then
      echo "[runner] WARN port $p still open"
    fi
  done
  echo "[runner] teardown complete"
}
trap cleanup EXIT TERM INT

# ── boot: edge + gateway + web (playwright.config.ts shapes) ─────────────
# Each process gets its own session (setsid) so `kill -- -PGID` reaps the
# whole tree (pnpm → sh → tsx/next → node server children).
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
  local url="$1" name="$2" timeout="${3:-240}"
  for _ in $(seq 1 "$timeout"); do
    if curl -sf -o /dev/null --max-time 2 "$url"; then
      echo "[runner] $name ready"
      return 0
    fi
    sleep 1
  done
  echo "[runner] $name NOT ready after ${timeout}s"
  return 1
}

wait_http "http://127.0.0.1:${GATEWAY_PORT}/v1/health" "gateway" 150 || {
  echo "[runner] gateway boot failed — log tail:"; tail -30 "$LOGS/gateway.log"; exit 1; }
wait_http "http://127.0.0.1:${WEB_PORT}/" "web(next)" 240 || {
  echo "[runner] web boot failed — log tail:"; tail -30 "$LOGS/web.log"; exit 1; }
wait_http "http://127.0.0.1:${EDGE_PORT}/" "edge" 60 || exit 1
echo "[runner] stack up"

# Warm the sign-in page + editor route through the edge (first Turbopack
# compile happens here, not inside the capture's timeouts).
curl -sf -o /dev/null --max-time 90 "http://127.0.0.1:${EDGE_PORT}/sign-in" \
  && echo "[runner] /sign-in compiled" || echo "[runner] WARN: /sign-in warmup failed"

# ── the captures ──────────────────────────────────────────────────────────
node scripts/captures/capture.mjs
CAPTURE_RC=$?
echo "[runner] capture.mjs exit=$CAPTURE_RC"

# ── ffmpeg post: ≤8s muted VP9 loop + webp poster ────────────────────────
if compgen -G "$RAW/*.webm" >/dev/null; then
  RAWVIDEOD=$(ls -t "$RAW"/*.webm | head -1)
  echo "[runner] raw video: $RAWVIDEOD"
  DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$RAWVIDEOD")
  echo "[runner] raw duration: ${DUR}s"
  if [ "$CAPTURE_RC" = "0" ]; then
    # Deterministic tail trim: the interaction sequence is scripted to be the
    # video's final ~10s (stream settle → Space → slow timeline scrub).
    ffmpeg -hide_banner -loglevel error -y \
      -sseof -8.4 -i "$RAWVIDEOD" -t 8 \
      -an -c:v libvpx-vp9 -b:v 0 -crf 36 -deadline good -cpu-used 4 -row-mt 1 \
      -pix_fmt yuv420p "$OUT/demo-loop.webm" \
      && echo "[runner] demo-loop.webm encoded"
    # Poster: a real frame of the final loop (~1.5s in: answered chat + live
    # editor), scaled to 1280×720 webp (hero LCP-friendly).
    ffmpeg -hide_banner -loglevel error -y \
      -ss 1.5 -i "$OUT/demo-loop.webm" -frames:v 1 \
      -vf "scale=1280:720" -q:v 80 "$OUT/demo-loop-poster.webp" \
      && echo "[runner] demo-loop-poster.webp extracted"
  fi
fi

echo "[runner] assets:"
ls -la "$OUT" 2>/dev/null
for f in "$OUT"/*; do
  [ -f "$f" ] && echo "$(sha256sum "$f")"
done
echo "[runner] done (teardown via trap)"
