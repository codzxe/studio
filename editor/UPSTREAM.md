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

Gate status at patch 0001 (updated 2026-10-24): `cargo xtask web` is **proven twice
on this box**. Original 2026-10-22: the 656-crate wasm32 release graph compiled with
zero errors (cg16 env override, `wasm-opt` skipped — binaryen absent). Re-proven
2026-10-24 at the same pin `9db7f3b2` with the profile's true `lto="thin"` +
`codegen-units=1` plus the xtask's `wasm-opt -O2` pass (binaryen 125): the committed
dist is now a 49,353,339-byte wasm (47.1 MiB; 12.8 MiB brotli q8), boot-verified live
in Chromium (`window.effectcraft` present, `info().version` "0.13.0", zero console
errors, zero failed requests) — numbers in [docs/performance.md](../docs/performance.md).
`cargo test --workspace`, clippy and `xtask wasm` are still **owed on a bigger box** and
did NOT run here (the host debug+incremental ladder does not fit on this disk; filled
to 100% twice). Evidence and the reproduction recipe:
[docs/phases/M0.md](../docs/phases/M0.md).

## Product patches

Patches live in `patches/` as diff artifacts against the pin. **Single-repo policy
(user directive 2026-10-22, DECISIONS.md D-17): this vendored tree is the canonical
source of truth** — changes are made directly here and recorded below; the artifacts
are kept for provenance only. The `codzxe/effectcraft` fork used to produce patch
0001 is deprecated and flagged for deletion. `crates/ui-egui` is only touched where
a binding rule forces it (ADR-0006 decision 10 branding removal); every change is
listed below.

| Patch | Subject | Fork commit | Scope |
|---|---|---|---|
| [0001-debrand.patch](patches/0001-debrand.patch) | De-brand the editor for the commercial product (ADR-0006 decision 10) | `0afc18e` | 77 files |

**0001 de-brand (2026-10-22).** Renames the user-visible `EffectCraft`/`ArtCraft`
strings to `Studio` across the engine menus, the i18n catalogs (all 10 locales, keys and
values together so lookups stay aligned), the window title, the About dialog, the start
screen, the autosave folder and the default screenshot filenames. Feature-gates the
upstream promo chrome off by emptying the `crates/engine/src/links.rs` constants: the
header Discord pill and GitHub/website buttons, the Home community foot and sibling-app
rows, the About dialog link buttons, and the Help menu's upstream docs/community entries
(F1 included) all hide while their constant is empty. Swaps the upstream unicorn mark for
the original `Studio` keyframe-diamond mark (`docs/brand/studio-mark.png`, PWA icons
under `assets/app-icon/studio/`, rewritten `favicon.svg`); the upstream mark files stay
in-tree, untouched and credited. The Help menu keeps its in-app items (Animation
Presets, Keyboard Shortcuts, In-App Tutorials, System Compatibility Report, logging,
Open Demo Project, About). Technical identifiers are intentionally unchanged:
`window.effectcraft` (ADR-0006 §4 bridge contract), the `.ecproj` XML root
`<EffectCraftProject>`, lowercase crate/module/cache names. Attribution sidecars and
`ATTRIBUTION.md` are preserved and extended, never renamed.

## Build

```sh
cd editor
cargo xtask web --dev          # fast dev wasm build → target/web/dist
cargo xtask web                # release wasm build (measured 2026-10-24: 49.4 MB wasm, 12.8 MiB brotli q8 / 17.8 MB gzip)
cargo xtask web --serve 8765   # build + serve with COOP/COEP on 127.0.0.1:8765
cargo build -p effectcraft-cli # native headless CLI (worker renders)
```

Requirements: Rust ≥ 1.95, `rustup target add wasm32-unknown-unknown`,
`wasm-bindgen-cli` exactly `0.2.129` (`cargo install wasm-bindgen-cli
--version 0.2.129 --locked`). Build it from source on this box: the official musl
prebuilt OOM-killed on the 2026-10-22 76 MB wasm (musl allocator; untested against
the 49 MB re-tune); a glibc source build handles it. `wasm-opt` on PATH (binaryen
125 as of 2026-10-24) lets the xtask apply its `-O2` pass — skipped silently when
absent.

## Dist record (committed artifact, per DECISIONS.md D-17)

| Date | Profile | Source | Notes |
|---|---|---|---|
| 2026-10-22 | release (thin LTO kept; `codegen-units=16` env override — the 4 GB build box OOMs at upstream's `codegen-units=1`; `wasm-opt` skipped — binaryen absent) | pin `9db7f3b2` + patch 0001, built with Rust 1.99.1 + wasm-bindgen-cli 0.2.129 (glibc source build — the musl prebuilt OOMs on this wasm) | `apps/web/public/editor/`: 76.2 MB wasm (14.5 MB brotli q8 / 19.8 MB gzip), 76.4 MB dist total; superseded 2026-10-24 by the re-tuned row below — `docs/performance.md` |
| 2026-10-24 | release (the profile's true thin LTO + `codegen-units=1` — no cg16 override this time; xtask `wasm-opt -O2` applied — binaryen 125) | pin `9db7f3b2` + patch 0001, built with Rust 1.99.1 + wasm-bindgen-cli 0.2.129 (glibc source build) | **the committed dist**: `apps/web/public/editor/` — 49,353,339-byte wasm (47.1 MiB), 12.8 MiB brotli q8 (13,431,119 bytes) / 17.8 MB gzip — both under the §6 < 18 MB budget; dist total ≈49.6 MB; boot-verified in Chromium 2026-10-24 (version 0.13.0, zero console errors); ledger + re-measured transfer sizes in `docs/performance.md` |

## Licence

MIT OR Apache-2.0. `LICENSE-MIT`, `LICENSE-APACHE` and `NOTICE` are kept in
this directory and surfaced in the product's licences page and
`ATTRIBUTION.md`. EffectCraft's marks and product name are never used in the
commercial UI (ADR-0006 decision 10).
