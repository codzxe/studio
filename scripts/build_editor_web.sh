#!/usr/bin/env bash
# Chunked release wasm build for the vendored EffectCraft editor (patched: studio de-brand).
#
# This box: 2 cores / 4 GB RAM / ~4.5 GB free disk. Upstream's [profile.release]
# (lto = "thin", codegen-units = 1) peaks ~2.5-3.5 GB per rustc and OOMs when two
# heavy crates compile together (boa_engine was SIGKILLed). These env overrides are
# build-machine-only (nothing committed): -j1 + codegen-units=16 keeps each rustc
# under ~1.5 GB while still using both cores during LLVM codegen. Thin LTO is kept
# (upstream intent); if the final link OOMs, re-run with CARGO_PROFILE_RELEASE_LTO=false.
#
# Resumable: cargo keeps completed crates in target/, so re-running this script in
# <10-minute chunks converges. Exit 0 = dependency graph complete.
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_BUILD_JOBS=1
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/editor"
exec cargo build --target wasm32-unknown-unknown -p studio-web --profile release
