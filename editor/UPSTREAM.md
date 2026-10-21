# Editor — upstream pin

The editor is **EffectCraft** (MIT OR Apache-2.0), vendored here as a
self-contained Cargo workspace. Per ADR-0006 the editor UI is **frozen**: no
product change may touch `crates/ui-egui` for visual reasons. Only
build/integration patches are allowed, and each is recorded below.

## Pin

| Field | Value |
|---|---|
| Upstream | https://github.com/storytold/effectcraft |
| Pinned commit | `9db7f3b21700fd821f215782ed1c82afe077880f` |
| Upstream version | 0.13.0 (release 0.13.0) |
| Pinned by | studio Wave 0 · 2026-10-22 |
| Local reference clone | `/home/z/my-project/effectcraft-upstream` (with `origin` remote) |

Re-pin procedure:

```sh
git clone https://github.com/storytold/effectcraft.git effectcraft-upstream
cd effectcraft-upstream && git checkout <commit>
rsync -a --exclude=.git --exclude=target effectcraft-upstream/ ../studio/editor/
# then run the gates below and update this file
```

## Gates to run at every pin bump

- `cargo test --workspace`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `cargo xtask wasm` (wasm32 check of the full crate ladder)
- `cargo xtask web` (production wasm build → `target/web/dist`)
- Manual: open `/editor/?empty`, verify `window.effectcraft` methods
  (`request`, `execute`, `inspect`, `renderFrame`, `addFile`, `saveToBrowser`,
  `readFile`, `screenshot`) and that `engine.batch` is atomic with one-undo-step.

## Product patches

None. The tree is byte-identical to the pin. Any future patch lands in
`patches/` as a documented, upstreamable diff — never a direct edit of
`crates/ui-egui`.

## Build

```sh
cd editor
cargo xtask web --dev          # fast dev wasm build → target/web/dist
cargo xtask web                # release wasm build (≈58 MB wasm, ~10-17 MB compressed)
cargo xtask web --serve 8765   # build + serve with COOP/COEP on 127.0.0.1:8765
cargo build -p effectcraft-cli # native headless CLI (worker renders)
```

Requirements: Rust ≥ 1.95, `rustup target add wasm32-unknown-unknown`,
`wasm-bindgen-cli` exactly `0.2.129` (`cargo install wasm-bindgen-cli
--version 0.2.129 --locked`).

## Licence

MIT OR Apache-2.0. `LICENSE-MIT`, `LICENSE-APACHE` and `NOTICE` are kept in
this directory and surfaced in the product's licences page and
`ATTRIBUTION.md`. EffectCraft's marks and product name are never used in the
commercial UI (ADR-0006 decision 10).
