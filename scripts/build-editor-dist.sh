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

cd "$REPO/apps/editor"

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
log "stage2: dist built at apps/editor/target/web/dist"

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

# Stage 4 (WASM Phase 0, 2026-10-30 audit): precompress the big files and
# enforce the serving budget. brotli-11 (measured: 51.4 MB → 11.05 MB, −78.5%
# wire) is served directly by the Caddy edge (`file_server precompressed`),
# so wire size no longer depends on on-the-fly encoder quality, and the edge
# stops burning CPU compressing 50 MB per cold request. Brotli only — every
# current browser accepts it, and committing .gz siblings too would double
# the per-rebuild artifact bloat in git history.
WASM_MAX_MB="${EDITOR_WASM_MAX_MB:-18}"
for f in "$DEST"/*.wasm "$DEST"/*.js; do
  [ -f "$f" ] || continue
  if command -v brotli >/dev/null 2>&1; then
    brotli -q 11 -k -f -c "$f" > "$f.br"
    log "stage4: $(basename "$f") -> $(basename "$f").br ($(du -h "$f.br" | cut -f1))"
  else
    log "stage4: WARNING: brotli CLI missing — no .br (edge falls back to on-the-fly encode)"
  fi
done
WASM_BR="$DEST/studio_web_bg.wasm.br"
if [ -f "$WASM_BR" ]; then
  BR_MB=$(du -m "$WASM_BR" | cut -f1)
  if [ "$BR_MB" -gt "$WASM_MAX_MB" ]; then
    log "stage4: FAIL: studio_web_bg.wasm.br is ${BR_MB}MB > ${WASM_MAX_MB}MB wire budget (EDITOR_WASM_MAX_MB)"
    exit 1
  fi
  log "stage4: wasm.br ${BR_MB}MB within the ${WASM_MAX_MB}MB serving budget"
else
  log "stage4: WARNING: no .br to budget-check (brotli unavailable?)"
fi
log "EDITOR_BUILD_DONE"
