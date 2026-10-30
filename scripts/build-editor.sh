#!/usr/bin/env bash
# Editor (EffectCraft) build chain — Wave 0 background job.
# Steps: wasm target -> wasm-bindgen-cli -> cargo fetch -> dev wasm build (pipeline proof)
#        -> release wasm build (the product editor) -> native CLI (worker renders)
set -x
export PATH="$HOME/.cargo/bin:$PATH"
# 2026-10-30 restructure: repo-relative (was hardcoded /home/z/my-project/studio/editor
# + /home/z/my-project/logs — unrunnable from any other checkout) and the
# vendored engine moved to apps/editor/.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO/apps/editor" || exit 1
LOG="$REPO/.local/logs"
mkdir -p "$LOG"
export CARGO_BUILD_JOBS=2

echo "=== [1/5] rustup target add wasm32-unknown-unknown ===" >> "$LOG/editor-build.log"
rustup target add wasm32-unknown-unknown >> "$LOG/editor-build.log" 2>&1

echo "=== [2/5] install wasm-bindgen-cli 0.2.129 ===" >> "$LOG/editor-build.log"
cargo install wasm-bindgen-cli --version 0.2.129 --locked >> "$LOG/editor-build.log" 2>&1 || echo "WASM_BINDGEN_INSTALL_FAILED" >> "$LOG/editor-build.log"

echo "=== [3/5] cargo fetch ===" >> "$LOG/editor-build.log"
cargo fetch --workspace >> "$LOG/editor-fetch.log" 2>&1 || echo "FETCH_FAILED" >> "$LOG/editor-build.log"

echo "=== [4/5] cargo xtask web --dev (pipeline proof) ===" >> "$LOG/editor-build.log"
cargo xtask web --dev >> "$LOG/editor-web-dev.log" 2>&1 && echo "DEV_BUILD_OK" >> "$LOG/editor-build.log" || echo "DEV_BUILD_FAILED" >> "$LOG/editor-build.log"

echo "=== [5/5] cargo xtask web (release) ===" >> "$LOG/editor-build.log"
cargo xtask web >> "$LOG/editor-web-release.log" 2>&1 && echo "RELEASE_BUILD_OK" >> "$LOG/editor-build.log" || echo "RELEASE_BUILD_FAILED" >> "$LOG/editor-build.log"

du -sh target/web/dist 2>/dev/null >> "$LOG/editor-build.log"
echo "=== BUILD CHAIN DONE ===" >> "$LOG/editor-build.log"
