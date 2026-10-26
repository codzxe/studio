#!/usr/bin/env bash
# scripts/army/bootstrap_box.sh — round-13 fresh-box bootstrap (no secrets).
# Idempotent; safe to re-run. End marker: BOOTSTRAP_DONE.
set -uo pipefail
LOG() { echo "[$(date +%H:%M:%S)] $*"; }

cd /home/z/my-project
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"

# 1) pnpm (corepack first, npm fallback)
if ! command -v pnpm >/dev/null 2>&1; then
  LOG "install pnpm@9.15.9 (corepack)"
  corepack enable >/dev/null 2>&1 || true
  corepack prepare pnpm@9.15.9 --activate >/dev/null 2>&1 || npm i -g pnpm@9.15.9 >/dev/null 2>&1 || true
fi
command -v pnpm >/dev/null 2>&1 && LOG "pnpm $(pnpm --version)" || LOG "WARN: pnpm unavailable"

# 2) workspace deps
if [ -z "$(ls -A node_modules/.pnpm 2>/dev/null | head -1)" ]; then
  LOG "pnpm install (this takes a while)"
  pnpm install --frozen-lockfile || pnpm install
else
  LOG "node_modules already present"
fi

# 3) web fonts (Instrument family, sha-verified, gitignored)
LOG "fonts:web"
pnpm fonts:web || LOG "WARN fonts:web failed"

# 4) rust stable + wasm32 target
if ! command -v cargo >/dev/null 2>&1; then
  LOG "rustup install (stable, minimal profile)"
  curl -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal
fi
# shellcheck disable=SC1091
. "$HOME/.cargo/env" 2>/dev/null || true
export PATH="$HOME/.cargo/bin:$PATH"
rustup target add wasm32-unknown-unknown || LOG "WARN: wasm32 target add failed"

# 5) binaryen 125 (prebuilt, user-local — xtask wasm-opt pass)
if ! command -v wasm-opt >/dev/null 2>&1; then
  LOG "binaryen 125 download"
  mkdir -p "$HOME/.local/bin"
  curl -sL https://github.com/WebAssembly/binaryen/releases/download/version_125/binaryen-version_125-x86_64-linux.tar.gz -o /tmp/binaryen.tgz \
    && tar xzf /tmp/binaryen.tgz -C /tmp \
    && cp /tmp/binaryen-version_125-x86_64-linux/bin/wasm-opt "$HOME/.local/bin/" \
    && chmod +x "$HOME/.local/bin/wasm-opt" \
    || LOG "WARN: binaryen download failed (wasm-opt pass will be skipped)"
fi

# 6) wasm-bindgen-cli 0.2.129 — SOURCE build (glibc); the official musl prebuilt
#    OOM-kills on the ~49MB wasm (recorded in editor/UPSTREAM.md).
if ! command -v wasm-bindgen >/dev/null 2>&1; then
  LOG "wasm-bindgen-cli 0.2.129 source build (long)"
  cargo install wasm-bindgen-cli --version 0.2.129 --locked || LOG "WARN: wasm-bindgen install failed"
fi

LOG "BOOTSTRAP_DONE"
echo "--- versions ---"
(command -v pnpm >/dev/null 2>&1 && pnpm --version) || echo "pnpm: MISSING"
(command -v cargo >/dev/null 2>&1 && cargo --version) || echo "cargo: MISSING"
(command -v wasm-bindgen >/dev/null 2>&1 && wasm-bindgen --version) || echo "wasm-bindgen: MISSING"
(command -v wasm-opt >/dev/null 2>&1 && wasm-opt --version) || echo "wasm-opt: MISSING"
ls apps/web/src/app/fonts/ 2>/dev/null || echo "web fonts: MISSING"
