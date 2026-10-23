#!/usr/bin/env bash
# W3-I THROWAWAY runner — boots the e2e recipe stack, runs the real captures,
# post-processes the demo loop with ffmpeg, and KILLS EVERYTHING it started
# (trap; the repo's kill-0 lesson). One Bash invocation owns the whole run:
# the sandbox reaps background processes between tool calls, so the stack
# must live and die inside this single script.
set -u
cd "$(dirname "$0")/../.." || exit 1

# Dedicated ports (W5-02): the shared 3000/8787/3100 trio is contended by
# sibling fleet agents' runtime-verification boots (the 14:14 run lost 8787
# to a peer's `pnpm --filter @studio/gateway dev` and its warmup sign-in hit
# the PEER's DB/secret). 3001/8788/3101 are ours alone.
EDGE_PORT="${CAPTURE_EDGE_PORT:-3101}"
WEB_PORT="${CAPTURE_WEB_PORT:-3001}"
GATEWAY_PORT="${CAPTURE_GATEWAY_PORT:-8788}"
EDITOR_PATH=/w/demo-project/editor
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
# the gateway binds process.env.PORT (services/gateway/src/index.ts:44)
export PORT="$GATEWAY_PORT"
# the web app's SSR dials the gateway at GATEWAY_INTERNAL_URL (default
# 127.0.0.1:8787 — apps/web/src/lib/gateway.ts:32); without this the editor
# route's server-side session check gets ECONNREFUSED and 500s.
export GATEWAY_INTERNAL_URL="http://127.0.0.1:${GATEWAY_PORT}"
# ports for the edge's inline node payload (read via process.env at boot)
export GATEWAY_PORT_="$GATEWAY_PORT" WEB_PORT_="$WEB_PORT" EDGE_PORT_="$EDGE_PORT"

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
  # pnpm sometimes re-groups its grandchildren, so group-kill can miss the
  # actual listeners — reap anything still bound to OUR ports only (3000/8787
  # may legitimately belong to sibling agents and are never touched).
  sleep 1
  for p in "$EDGE_PORT" "$WEB_PORT" "$GATEWAY_PORT"; do
    if (echo >/dev/tcp/127.0.0.1/$p) 2>/dev/null; then
      owner=$(ss -tlnp 2>/dev/null | awk -v port=":$p\$" '$4 ~ port {print $NF}' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
      if [ -n "${owner:-}" ]; then
        echo "[runner] port $p still held by pid $owner — killing"
        kill "$owner" 2>/dev/null || true
        sleep 1
        kill -9 "$owner" 2>/dev/null || true
      else
        echo "[runner] WARN port $p still open (owner unknown)"
      fi
    fi
  done
  echo "[runner] teardown complete"
}
trap cleanup EXIT TERM INT

# ── fixture staging (idempotent, deterministic bytes) ─────────────────────
# The seeded object_keys are version-ID-keyed; build-fixture.mjs (re)stages
# the engine-openable project at those keys so the editor has real bytes to
# open. Deterministic: re-running produces byte-identical .ecproj files.
node scripts/captures/build-fixture.mjs || {
  echo "[runner] fixture staging failed"; exit 1; }

# ── boot: edge + gateway + web (playwright.config.ts shapes) ─────────────
# Each process gets its own session (setsid) so `kill -- -PGID` reaps the
# whole tree (pnpm → sh → tsx/next → node server children).
setsid node -e '
const http = require("http");
const targets = { api: process.env.GATEWAY_PORT_, web: process.env.WEB_PORT_ };
const port = Number(process.env.EDGE_PORT_);
http.createServer((req, res) => {
  const upstreamPort = req.url.startsWith("/v1") ? targets.api : targets.web;
  const upstream = http.request({ host: "127.0.0.1", port: upstreamPort, method: req.method, path: req.url,
    headers: { ...req.headers, host: "127.0.0.1:" + upstreamPort } }, (up) => {
    res.writeHead(up.statusCode || 502, up.headers);
    up.pipe(res);
  });
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("e2e edge: upstream not reachable yet");
  });
  req.pipe(upstream);
}).listen(port, "127.0.0.1", () => console.log(`capture edge on ${port}`));
' >"$LOGS/edge.log" 2>&1 &
PIDS+=($!)

setsid bash -c 'cd services/gateway && exec corepack pnpm dev' >"$LOGS/gateway.log" 2>&1 &
PIDS+=($!)

setsid bash -c "cd apps/web && exec corepack pnpm exec next dev -p $WEB_PORT" >"$LOGS/web.log" 2>&1 &
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

wait_http "http://127.0.0.1:${GATEWAY_PORT}/v1/health" "gateway" 200 || {
  echo "[runner] gateway boot failed — log tail:"; tail -30 "$LOGS/gateway.log"; exit 1; }
# 480s: cold Turbopack on this 2-CPU box (W5-02 probe measured 4s warm, but
# a cold .next/dev compile of the / route can take minutes).
wait_http "http://127.0.0.1:${WEB_PORT}/" "web(next)" 480 || {
  echo "[runner] web boot failed — log tail:"; tail -40 "$LOGS/web.log"; exit 1; }
wait_http "http://127.0.0.1:${EDGE_PORT}/" "edge" 60 || exit 1
echo "[runner] stack up"

# Warm the sign-in page + editor route through the edge (first Turbopack
# compile happens here, not inside the capture's timeouts). The editor tree
# needs an authenticated request to render/compile — sign in via the real
# better-auth endpoint (cookie jar), then GET the editor route.
curl -sf -o /dev/null --max-time 240 "http://127.0.0.1:${EDGE_PORT}/sign-in" \
  && echo "[runner] /sign-in compiled" || echo "[runner] WARN: /sign-in warmup failed"
JAR="$LOGS/warm-cookies.txt"
if curl -sf -c "$JAR" -o /dev/null --max-time 60 \
  -H "content-type: application/json" \
  -H "origin: http://127.0.0.1:${EDGE_PORT}" \
  -X POST "http://127.0.0.1:${EDGE_PORT}/v1/auth/sign-in/email" \
  -d '{"email":"demo@studio.test","password":"demo-password-12345"}'; then
  ED_CODE=$(curl -s -o "$LOGS/warm-editor.html" -w "%{http_code}" -b "$JAR" --max-time 420 \
    "http://127.0.0.1:${EDGE_PORT}${EDITOR_PATH}")
  if [ "$ED_CODE" = "200" ]; then
    echo "[runner] editor route compiled (authenticated warmup, 200)"
  else
    echo "[runner] WARN: editor warmup http=$ED_CODE (first compile happens in-session)"
  fi
else
  echo "[runner] WARN: warmup sign-in failed (first compile happens in-session)"
fi
rm -f "$JAR"

# WARMUP_ONLY=1: boot + compile everything (the .next cache persists on disk
# across invocations), then exit — a pre-flight that makes the real single-
# invocation run fast enough to fit the 600s tool-call deadline.
if [ "${WARMUP_ONLY:-0}" = "1" ]; then
  echo "[runner] warmup-only mode — exiting (stack torn down via trap)"
  exit 0
fi

# ── the captures ──────────────────────────────────────────────────────────
# CAPTURE_SCRIPT overrides the capture body (diagnostics probes) while
# keeping this runner's boot/env/teardown harness.
CAPTURE_BASE_URL="http://127.0.0.1:${EDGE_PORT}" node "${CAPTURE_SCRIPT:-scripts/captures/capture.mjs}"
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
    # 1280×720 VP9 (§11 web constraints; encodes fast enough on 2 CPUs and
    # keeps the committed asset well under the 1.5MB budget).
    ffmpeg -hide_banner -loglevel error -y \
      -sseof -8.4 -i "$RAWVIDEOD" -t 8 \
      -an -c:v libvpx-vp9 -b:v 0 -crf 36 -deadline good -cpu-used 5 -row-mt 1 \
      -vf "scale=1280:720" -pix_fmt yuv420p "$OUT/demo-loop.webm" \
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

# The capture's exit code is the runner's exit code (a failed capture must
# never look green). teardown runs via the EXIT trap.
exit "$CAPTURE_RC"
