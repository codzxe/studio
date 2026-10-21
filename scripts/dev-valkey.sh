#!/usr/bin/env bash
# scripts/dev-valkey.sh — portable Valkey 8 for hosts with NO Docker and NO
# sudo (BUILD_PLAN M0 task 5). OPTIONAL service: VALKEY_URL is optional in the
# env schema — if this script cannot provide a server, the app still runs with
# queues and rate limits degraded gracefully.
#
# Valkey publishes NO official prebuilt Linux binary tarballs (their GitHub
# releases carry source only, and building from source is out of scope here).
# Strategy, in order:
#   1. Reuse an existing `valkey-server` or `redis-server` from PATH (distro
#      package, brew, …). Valkey speaks the Redis protocol, so the app's
#      redis:// URL works with either.
#   2. Else download the official `valkey/valkey:8-alpine` OCI image WITHOUT
#      Docker: anonymous registry pull of the manifest+layers via curl, then
#      extract valkey-server/valkey-cli plus the musl loader and libssl3 they
#      need. The binaries run on any Linux host via the bundled loader
#      (no root, no glibc version concerns). Needs curl + python3 + tar.
#      Verified in-sandbox: Valkey server v=8.1.10 (image digest pinned by tag).
#
# Usage:
#   scripts/dev-valkey.sh start     # download (if needed) + start + wait for PING
#   scripts/dev-valkey.sh stop      # idempotent
#   scripts/dev-valkey.sh restart
#   scripts/dev-valkey.sh status    # exit 0 running / 3 stopped
#   scripts/dev-valkey.sh cli ...    # valkey-cli/redis-cli passthrough
# Env overrides: VK_HOME VK_PORT VK_IMAGE
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VK_HOME="${VK_HOME:-$REPO_ROOT/.local/valkey}"
VK_PORT="${VK_PORT:-6379}"
VK_HOST="127.0.0.1"
VK_IMAGE="${VK_IMAGE:-valkey/valkey:8-alpine}"
VK_DATA="$VK_HOME/data"
VK_LOG="$VK_HOME/valkey.log"
VK_PID="$VK_HOME/valkey.pid"

log()  { printf 'dev-valkey: %s\n' "$*" >&2; }
die()  { printf 'dev-valkey: ERROR: %s\n' "$*" >&2; exit 1; }

find_system_server() {
  command -v valkey-server >/dev/null 2>&1 && { command -v valkey-server; return; }
  command -v redis-server  >/dev/null 2>&1 && { command -v redis-server;  return; }
  return 1
}

find_system_cli() {
  command -v valkey-cli >/dev/null 2>&1 && { command -v valkey-cli; return; }
  command -v redis-cli  >/dev/null 2>&1 && { command -v redis-cli;  return; }
  return 1
}

# ── OCI image pull without Docker ───────────────────────────────────────────
# Anonymous pull of $VK_IMAGE for this platform; extracts the server binary,
# cli, the musl loader and libssl/libcrypto. Requires python3 for JSON parsing.
install_from_image() {
  local SERVER=""
  if SERVER="$(find_system_server)"; then
    log "using existing server from PATH: $SERVER (no download needed)"
    printf 'system: %s\n' "$SERVER" > "$VK_HOME/SOURCE.txt"
    return 0
  fi
  if [ -x "$VK_HOME/bin/valkey-server" ]; then
    log "already installed at $VK_HOME ($( "$VK_HOME/bin/valkey-server" --version 2>&1 | head -1 || true ))"
    return 0
  fi
  command -v curl >/dev/null 2>&1 || die "curl is required"
  command -v python3 >/dev/null 2>&1 || \
    die "this download path needs python3 (manifest parsing). Alternative: install a distro valkey/redis server (Debian: sudo apt install valkey; macOS: brew install valkey) — this service is OPTIONAL."
  command -v tar >/dev/null 2>&1 || die "tar is required"

  local arch
  case "$(uname -m)" in
    x86_64)  arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) die "unsupported architecture $(uname -m) for the image pull" ;;
  esac

  local tmp="$VK_HOME/.download"
  rm -rf "$tmp"; mkdir -p "$tmp/rootfs" "$VK_HOME/bin" "$VK_DATA"

  log "pulling $VK_IMAGE ($arch) from registry.docker.io (anonymous)…"
  local token
  token="$(curl -fsSL --retry 2 --max-time 20 \
    "https://auth.docker.io/token?service=registry.docker.io&scope=repository:${VK_IMAGE%%:*}:pull" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')"

  local tag="${VK_IMAGE##*:}" repo="${VK_IMAGE%%:*}"
  local index_manifest="$tmp/index.json"
  curl -fsSL --retry 2 --max-time 30 \
    -H "Authorization: Bearer $token" \
    -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json" \
    "https://registry-1.docker.io/v2/$repo/manifests/$tag" -o "$index_manifest" \
    || die "manifest fetch failed for $VK_IMAGE"

  local manifest_digest
  manifest_digest="$(python3 - "$index_manifest" "$arch" <<'PY'
import json, sys
index = json.load(open(sys.argv[1]))
arch = sys.argv[2]
for m in index.get("manifests", []):
    if m.get("platform", {}).get("architecture") == arch:
        print(m["digest"]); break
else:
    sys.exit(f"no {arch} manifest in image index")
PY
)" || die "no manifest for $arch in $VK_IMAGE"

  local manifest="$tmp/manifest.json"
  curl -fsSL --retry 2 --max-time 30 \
    -H "Authorization: Bearer $token" \
    -H "Accept: application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" \
    "https://registry-1.docker.io/v2/$repo/manifests/$manifest_digest" -o "$manifest" \
    || die "platform manifest fetch failed"

  local -a digests=()
  mapfile -t digests < <(python3 - "$manifest" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
for l in m.get("layers", []):
    print(l["digest"])
PY
)

  local digest
  for digest in "${digests[@]}"; do
    log "  layer ${digest#sha256:} …"
    curl -fsSL --retry 3 --max-time 300 \
      -H "Authorization: Bearer $token" \
      "https://registry-1.docker.io/v2/$repo/blobs/$digest" -o "$tmp/layer.tgz" \
      || die "layer download failed: $digest"
    tar -xzf "$tmp/layer.tgz" -C "$tmp/rootfs" 2>/dev/null || true
  done

  local server_bin cli_bin loader ssl_lib
  server_bin="$(find "$tmp/rootfs" -type f -path '*/bin/valkey-server' -print -quit || true)"
  cli_bin="$(find "$tmp/rootfs" -type f -path '*/bin/valkey-cli' -print -quit || true)"
  loader="$(find "$tmp/rootfs" -type f -name 'ld-musl-*.so.1' -print -quit || true)"
  [ -n "$server_bin" ] || die "no valkey-server found inside $VK_IMAGE — unexpected image layout"
  [ -n "$loader" ] || die "no musl loader found inside $VK_IMAGE — unexpected image layout"

  cp "$server_bin" "$VK_HOME/bin/valkey-server.bin"
  [ -n "$cli_bin" ] && cp "$cli_bin" "$VK_HOME/bin/valkey-cli.bin" || true
  cp "$loader" "$VK_HOME/bin/"
  # libssl3/libcrypto3 (musl builds) — copied wherever the image keeps them.
  for ssl_lib in $(find "$tmp/rootfs" -type f \( -name 'libssl.so.3' -o -name 'libcrypto.so.3' \) 2>/dev/null); do
    cp "$ssl_lib" "$VK_HOME/bin/"
  done

  # Wrapper scripts run the musl binary through the bundled loader.
  cat > "$VK_HOME/bin/valkey-server" <<WRAP
#!/bin/sh
# Runs the musl-linked valkey-server from the valkey/valkey OCI image via the
# bundled musl loader — works on any glibc/musl Linux without root.
dir="\$(cd "\$(dirname "\$0")" && pwd)"
exec "\$dir"/ld-musl-*.so.1 --library-path "\$dir" "\$dir/valkey-server.bin" "\$@"
WRAP
  if [ -f "$VK_HOME/bin/valkey-cli.bin" ]; then
    cat > "$VK_HOME/bin/valkey-cli" <<WRAP
#!/bin/sh
dir="\$(cd "\$(dirname "\$0")" && pwd)"
exec "\$dir"/ld-musl-*.so.1 --library-path "\$dir" "\$dir/valkey-cli.bin" "\$@"
WRAP
  fi
  chmod +x "$VK_HOME/bin/valkey-server" "$VK_HOME/bin/valkey-server.bin" 2>/dev/null || true
  [ -f "$VK_HOME/bin/valkey-cli" ] && chmod +x "$VK_HOME/bin/valkey-cli" "$VK_HOME/bin/valkey-cli.bin" || true

  printf 'image: %s\narch: %s\ndate: %s\n' "$VK_IMAGE" "$arch" "$(date -u +%FT%TZ)" > "$VK_HOME/SOURCE.txt"
  rm -rf "$tmp"
  log "installed: $("$VK_HOME/bin/valkey-server" --version 2>&1 | head -1)"
}

# ── run control ─────────────────────────────────────────────────────────────
# Prefer the local image-extracted server; fall back to a system binary.
server_cmd() {
  if [ -x "$VK_HOME/bin/valkey-server" ]; then
    printf '%s\n' "$VK_HOME/bin/valkey-server"
    return 0
  fi
  find_system_server
}

is_running() {
  [ -f "$VK_PID" ] && kill -0 "$(cat "$VK_PID")" 2>/dev/null
}

start() {
  install_from_image
  if is_running; then
    log "already running (pid $(cat "$VK_PID"))"
    return 0
  fi
  mkdir -p "$VK_DATA"
  local server
  server="$(server_cmd)"
  [ -n "$server" ] || die "no valkey-server available"
  log "starting $server on $VK_HOST:$VK_PORT (log: $VK_LOG)"
  nohup "$server" \
    --bind "$VK_HOST" \
    --port "$VK_PORT" \
    --daemonize no \
    --save '' \
    --appendonly no \
    --dir "$VK_DATA" \
    --pidfile "$VK_PID" \
    --logfile "$VK_LOG" \
    >/dev/null 2>&1 &
  local pid=$!
  disown "$pid" 2>/dev/null || true
  # daemonize no + shell &: the server writes its own pidfile on startup; but
  # keep the shell pid as a fallback if it never appears.
  local i
  for i in $(seq 1 30); do
    if [ -f "$VK_PID" ] && kill -0 "$(cat "$VK_PID")" 2>/dev/null; then break; fi
    kill -0 "$pid" 2>/dev/null || die "valkey-server exited during startup — see $VK_LOG"
    sleep 1
  done
  [ -f "$VK_PID" ] || echo "$pid" > "$VK_PID"
  # Wait for PING from the CLI (or system redis-cli).
  local cli
  cli="$(find_system_cli)" || cli="$VK_HOME/bin/valkey-cli"
  for i in $(seq 1 30); do
    if "$cli" -h "$VK_HOST" -p "$VK_PORT" ping 2>/dev/null | grep -q PONG; then
      log "ready: VALKEY_URL=redis://$VK_HOST:$VK_PORT (PONG received)"
      return 0
    fi
    sleep 1
  done
  die "server did not answer PING within 30s — see $VK_LOG"
}

stop() {
  if is_running; then
    local pid
    pid="$(cat "$VK_PID")"
    kill "$pid" 2>/dev/null || true
    local i
    for i in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    rm -f "$VK_PID"
    log "stopped"
  else
    log "not running (nothing to do)"
    rm -f "$VK_PID"
  fi
}

status() {
  local cli pong
  cli="$(find_system_cli)" || cli="$VK_HOME/bin/valkey-cli"
  pong="$("$cli" -h "$VK_HOST" -p "$VK_PORT" ping 2>/dev/null || true)"
  if [ "$pong" = "PONG" ]; then
    log "running on $VK_HOST:$VK_PORT (PONG) — VALKEY_URL=redis://$VK_HOST:$VK_PORT"
    exit 0
  fi
  log "not running"
  exit 3
}

resolve_cli() {
  if [ -x "$VK_HOME/bin/valkey-cli" ]; then printf '%s\n' "$VK_HOME/bin/valkey-cli"; return; fi
  find_system_cli
}

cmd="${1:-}"; shift || true
case "$cmd" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; start ;;
  status)  status ;;
  cli)
    cli_cmd="$(resolve_cli)" || die "no valkey-cli/redis-cli available (image not pulled yet — run 'start' first, or install redis-tools)"
    exec "$cli_cmd" -h "$VK_HOST" -p "$VK_PORT" "$@"
    ;;
  *) sed -n '2,40p' "${BASH_SOURCE[0]}" >&2; exit 2 ;;
esac
