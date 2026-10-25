#!/usr/bin/env bash
# scripts/build-editor-dist.sh — build the REAL EffectCraft wasm editor dist from the
# vendored pin (D-17: real editor only, no mocks) and stage it into apps/web/public/editor.
# Runs detached; logs to .editor-build.log. Idempotent per stage.
set -euo pipefail
# Portable: honor an existing RUSTUP/CARGO_HOME, else the user's $HOME.
export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
export PATH="$HOME/.cargo/bin:$PATH"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG=$REPO/.editor-build.log

log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }

cd "$REPO/editor"

# Stage 1: wasm-bindgen-cli must exactly match the crate (0.2.129).
if ! command -v wasm-bindgen >/dev/null 2>&1; then
  log "stage1: installing wasm-bindgen-cli 0.2.129 (cargo install — takes a while)"
  cargo install wasm-bindgen-cli --version 0.2.129 --locked >> "$LOG" 2>&1
  log "stage1: wasm-bindgen-cli installed: $(wasm-bindgen --version)"
else
  log "stage1: wasm-bindgen present: $(wasm-bindgen --version)"
fi

# Stage 2: build the web dist (release wasm + wasm-bindgen + static assets + service worker).
log "stage2: cargo xtask web (release) — the long pole"
cargo xtask web >> "$LOG" 2>&1
log "stage2: dist built at editor/target/web/dist"

# Stage 3: stage the dist into the web app public dir (same-origin /editor/).
DEST="$REPO/apps/web/public/editor"
mkdir -p "$DEST"
rm -rf "$DEST".tmp
cp -r target/web/dist "$DEST".tmp
rm -rf "$DEST"
mv "$DEST".tmp "$DEST"
SIZE=$(du -sh "$DEST" | cut -f1)
log "stage3: staged to apps/web/public/editor ($SIZE):"
ls -la "$DEST" >> "$LOG"
log "EDITOR_BUILD_DONE"
