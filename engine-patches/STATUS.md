# STATUS.md — engine-patches final review (W10-S)

Owned by the final-review pass (`W10-S`). One glance answers the only merge question:
**is the patch series appliable at the ADR-0001 pin, and what is still owed before the
upstream PRs?** Nothing here overrides `README.md` / ADR-0001; it records state.

- **Pin (ADR-0001):** `872748fb5b2a53e09dd4e385e31968d985c0515b` — verified, vendor tree
  pristine (`git -C vendor/photocraft status --porcelain` empty).
- **Patch-apply status: GREEN.**
  `engine-patches/scripts/apply-engine-patches.sh --check` → exit 0:
  *"pin OK … tree coherent with the patch series; registration patch pending at the
  pin; all module files present"* (run W10-S, dev box; the script only reads —
  `--check` copies nothing and `git apply --check` mutates nothing).
- Authored tree: **14 `.rs` files, 13,167 lines, 187 `#[test]`s** across the four
  module dirs; every file is a NEW upstream file except the two registry anchors
  touched by `registration/commands-registry.patch.txt`.

## W10-S fixes that made `--check` green

Before this pass the pre-flight refused with 4 problems (the exact gaps W3-L/W4-S
flagged for their owners; W10-S wired them, keeping the sanctioned shapes):

1. `template_cmds/template_cmds.rs` now declares its W3-B siblings:
   `mod fill; mod validate;` and `pub mod fill_specs;` (the registry line
   `v.extend(crate::template_cmds::fill_specs::specs());` reaches it from
   `commands.rs`, so it is `pub` — same as `pub mod document_diff;` in `agent_cmds.rs`).
   Plus two comment lines corrected to name `fill_specs.rs` as the specs owner.
2. `registration/commands-registry.patch.txt` now carries the two submodule specs
   merges (commands-registry.patch.md § "Submodule specs merges", **shape (b)** —
   what W3-B/W3-G asked for): `template_cmds::fill_specs::specs()` after the
   `template_cmds` parent line and `agent_cmds::document_diff::specs()` after the
   `agent_cmds` parent line. Header/counts in the `.txt` and the `.md` companion
   updated together (`+6 lines`, hunk `@@ -1537,6 +1537,12 @@`).

`layout_cmds` (all 4 siblings declared, `fit_specs::specs()` chained in the parent —
shape (a)) and `agent_cmds`' `pub mod document_diff;` declaration were already green
— no edit needed. No script changes were required: the sibling-copy glob
(`engine-patches/<m>/*.rs` → `crates/engine/src/<m>/<sib>.rs`, Rust 2018 layout)
already covers all 14 files, and the revert header's `rm -rf` of the four module
dirs covers the siblings.

### Throwaway dry-run of the registration patch (commands-registry.patch.md step 2)

Run against a `/tmp` copy of the pin's `lib.rs` + `commands.rs` (never vendor):

- `git apply --check` PASS; `git apply` PASS.
- `lib.rs`: the four `pub mod` lines landed in alphabetical slots — `agent_cmds` @14,
  `component_cmds` @33, `layout_cmds` @77, `template_cmds` @121.
- `commands.rs`: the six `v.extend` lines landed at 1540–1545, after
  `actions_cmds::specs()` @1539 and before the REL-3 `test_panic_command()` anchor.
- `git apply --check --reverse` PASS (the script's already-applied detection works).
- Rot check: mutating one anchor line makes `git apply --check` fail — the rot
  detector is live.

## Per-module status

`#[test]` counts are in-file `#[cfg(test)]` unit tests (upstream convention);
`tests/README.md` owns the per-command panic-hunt obligation tables. W3-L verdicts
are from `tests/review-log.md` (golden-rules review; 16 violations fixed in 4 files).

### `template_cmds/` — 5 files, 5,342 lines, 87 tests (surface §7.4)

| File | Lines | Owns | Tests | W3-L verdict | Notes |
|---|---|---|---|---|---|
| `template_cmds.rs` | 970 | `template.list` / `template.inspect` / `template.apply` | 11 | FIXED(4) (V1–V4, scan caps) | W10-S added the 3 sibling `mod` decls; `mod manifest;` was already private-correct |
| `manifest.rs` | 863 | — (no specs) | 10 | PASS | `TemplateManifest`, serde-tagged enum `Slot`, `parse_pin` |
| `fill.rs` | 1,907 | — (run fns; specs owned by `fill_specs.rs`) | 34 | FIXED(2) (V5–V6, cast + midpoint) | ⚠ **compile debt, see obligation #2** |
| `validate.rs` | 1,467 | — (run fn; specs owned by `fill_specs.rs`) | 29 | not reviewed (landed after W3-L) | imports only `manifest::{Slot, TemplateManifest, parse_pin}` — coherent |
| `fill_specs.rs` | 141 | `template.fill` + `template.validate` (both CommandSpecs) | 3 | not reviewed (W3-B, post-W3-L) | registered by the patch line (shape (b), W10-S) |

### `component_cmds/` — 2 files, 2,335 lines, 22 tests (surface §8.3)

| File | Lines | Owns | Tests | W3-L verdict | Notes |
|---|---|---|---|---|---|
| `component_cmds.rs` | 1,813 | `component.list` / `.inspect` / `.publish` / `.place` / `.updateInstance` / `.setVars` | 11 | FIXED(4) (V7–V9, V16: host-set pollution, i64 gap, dirs cap, tags capacity) | sibling declared via `#[path = "component_cmds/component_manifest.rs"] mod manifest;` |
| `component_manifest.rs` | 522 | — (no specs) | 11 | PASS | deployment note: `components_root()` defaults to relative `./components` (obligation #7) |

### `layout_cmds/` — 5 files, 4,231 lines, 50 tests (surface §9.4)

| File | Lines | Owns | Tests | W3-L verdict | Notes |
|---|---|---|---|---|---|
| `layout_cmds.rs` | 90 | `layout.apply` (spec; run = `layout_apply::apply`) | 0 (parent) | not reviewed (landed post-W3-L) | chains `fit_specs::specs()` — shape (a); declares all four siblings `pub` |
| `layout_apply.rs` | 2,215 | `layout.apply` run/parser/solver/commit | 20 | FIXED(5) (V10–V14, dead arms + bad cast) | `MAX_DEPTH` 64 / `MAX_NODES` 4096 / `MAX_CHILDREN` 512 |
| `fit_text.rs` | 955 | §9.3/§9.4 fit + measure math | 14 | FIXED(1) (V15, hostile-size guard) | `SEARCH_CAP` 64; production measurer wraps `photocraft_text` |
| `fit_specs.rs` | 652 | `layout.fitText` + `layout.measure` | 11 | PASS | chained inside `layout_cmds::specs()` — no patch line for this family |
| `measure_impl.rs` | 319 | — (`impl TextMeasurer for EngineTextMeasurer`, the hug seam) | 5 | not reviewed (W4-S, post-W3-L) | closes the CI E0277 at `layout_apply::apply`'s coercion; delegates to `fit_text` |

### `agent_cmds/` — 2 files, 1,253 lines, 28 tests (surface §5.6)

| File | Lines | Owns | Tests | W3-L verdict | Notes |
|---|---|---|---|---|---|
| `agent_cmds.rs` | 628 | `agent.begin` / `agent.commit` / `agent.rollback` | 13 | PASS | ⚠ latent test-compile flag, obligation #3; upstream ask documented in-file (obligation #6) |
| `document_diff.rs` | 625 | `document.diff` | 15 | not reviewed (W3-G, post-W3-L) | declared `pub mod document_diff;` by W3-G; registered by the patch line (shape (b), W10-S) |

Five files carry no W3-L verdict because they landed after that review
(`layout_cmds.rs`, `fill_specs.rs`, `validate.rs`, `document_diff.rs`, `measure_impl.rs`);
the landing agents self-verified the golden rules (W4-S: 0× unwrap/expect/panic in
non-test code; W3-G: all panic-hunt rows unit-tested) — CI's cargo check + panic_hunt
are the gate that confirms.

## The full command list (18)

Registration = one `v.extend(crate::<m>::specs())` line per parent in the patch,
plus the two shape-(b) merges. Run-fn homes in brackets where different from the
specs owner.

| # | Command | Specs owner (run home) | Registered by |
|---|---|---|---|
| 1 | `template.list` | `template_cmds.rs` | `v.extend(crate::template_cmds::specs());` |
| 2 | `template.inspect` | `template_cmds.rs` | ″ |
| 3 | `template.apply` | `template_cmds.rs` | ″ |
| 4 | `template.fill` | `fill_specs.rs` (`fill.rs`) | `v.extend(crate::template_cmds::fill_specs::specs());` |
| 5 | `template.validate` | `fill_specs.rs` (`validate.rs`) | ″ |
| 6 | `component.list` | `component_cmds.rs` | `v.extend(crate::component_cmds::specs());` |
| 7 | `component.inspect` | `component_cmds.rs` | ″ |
| 8 | `component.publish` | `component_cmds.rs` | ″ |
| 9 | `component.place` | `component_cmds.rs` | ″ |
| 10 | `component.updateInstance` | `component_cmds.rs` | ″ |
| 11 | `component.setVars` | `component_cmds.rs` | ″ |
| 12 | `layout.apply` | `layout_cmds.rs` (`layout_apply.rs`) | `v.extend(crate::layout_cmds::specs());` |
| 13 | `layout.fitText` | `fit_specs.rs` | chained in `layout_cmds::specs()` (shape (a)) |
| 14 | `layout.measure` | `fit_specs.rs` | ″ |
| 15 | `agent.begin` | `agent_cmds.rs` | `v.extend(crate::agent_cmds::specs());` |
| 16 | `agent.commit` | `agent_cmds.rs` | ″ |
| 17 | `agent.rollback` | `agent_cmds.rs` | ″ |
| 18 | `document.diff` | `document_diff.rs` | `v.extend(crate::agent_cmds::document_diff::specs());` |

Reference docs: `docs/commands.md` (18-command wire reference), per-module
`README.md` (surfaces §7.4/§8.3/§9.4/§5.6), `docs/atn-crossref.md` (PS-action
mapping), `docs/upstream-pr-guide.md` (one PR per module; stacking order).

## Remaining pre-merge obligations

Ordered by who must act. **No `cargo` runs on dev boxes — CI owns builds**
(`infra/ci-staged/engine-patches.yml`; AGENTS.md 2-CPU rule).

1. **INFRA (blocking, still live as of W10-S):** the staged workflow's overlay step
   probes `engine-patches/apply.sh` (nonexistent) and falls back to
   `cp -a engine-patches/. engine-src/` — which copies the patch dir into the engine
   root and **never reaches `crates/engine/src/`**, so CI would cargo-check the
   *unpatched* tree (its green would be vacuous). The yml must run
   `PHOTOCRAFT_VENDOR_DIR=engine-src engine-patches/scripts/apply-engine-patches.sh`.
   Flagged by W4-S; verified unchanged at W10-S. The yml also lacks the parity step
   and lists clippy / wasm32 checks as TODO — its own header says so.
2. **Compile debt — `fill.rs` ↔ `manifest.rs` (template module owners, W3-L flag #1,
   still live — verified W10-S):** `fill.rs` imports
   `super::manifest::{self, Manifest, Slot, SlotKind}` and calls `manifest::active(s)`
   / `Manifest::from_value`, but `manifest.rs` exports `TemplateManifest`, the
   serde-tagged enum `Slot`, `parse_pin`/`from_value` — no `Manifest`/`SlotKind`/
   `active` (22 `SlotKind`/`.raw` uses in `fill.rs`). Declaring `mod fill;` (required
   for the pre-flight, this pass) makes CI's `cargo check` fail until W3-A/W3-B
   reconcile the two surfaces (fill.rs's header documents the expected contract).
   This is now the **only known reason** the CI cargo check will be red.
3. **Latent test-compile flag (agent owner / CI):** `agent_cmds.rs:458`
   `assert_eq!(r["restored"], json!(true))` compares `&Value` with `Value` —
   compiles only if serde_json 1.0.151 provides the `PartialEq` impl (W3-G's flag;
   W3-G's own tests avoid the pattern). CI cargo check adjudicates; cheap fix if red.
4. **CI gates (per the staged workflow, in order):** pin-exact clone →
   `apply-engine-patches.sh` (refuses on pin drift / tree-patch disagreement /
   unregistered sibling `specs()`) → `cargo check` (yml: `--workspace`) →
   `cargo test -p photocraft-engine --test panic_hunt -- --ignored` → parity check.
   Panic-hunt obligations: `tests/README.md` (22 case classes; per-command adversarial
   rows for all 18; every row authored as in-module tests — 187 total).
5. **Parity (spec §2.3):** after the patched clone builds, `cargo xtask parity` must
   regenerate `docs/parity-checklist.md` and the regenerated file is committed in
   the **upstream PR** (never in this repo). Agent-facing commands with empty
   `menu: &[]` do not change menu-coverage numbers, but the run must happen and stay
   green.
6. **Upstream asks to carry in the `agent.*` PR (W3-F, documented in
   `agent_cmds.rs`'s header TODO):** a first-class transaction concept —
   `DocState::open_transaction: Option<Transaction>` field replacing the crate-wide
   `static Mutex<HashMap<DocId, Transaction>>` registry, and a
   `History::fold_to(&Arc<Document>, label)` folding primitive replacing the
   top-down pointer walk in `checkpoint_anchor`. (Also in the file headers: the
   per-command `"coalesce"` key is documented as insufficient for run folding.)
   W3-D's atn note stands: mapping PS text events (`Tx`/`setd` on text layers) is an
   upstream bridge follow-up, not part of this series.
7. **Doc drift (non-blocking, flagged):** `docs/commands.md` still marks
   `template.validate` and `document.diff` as "file in flight (W3-B/W3-G)" (rows
   @38/@43) and its `document.diff` error string as illustrative "when it lands" —
   both files have landed; the commands.md owner should flip the status column.
   Deployment note: `component_cmds::components_root()` defaults to relative
   `./components`.

## Change history

- **W10-S** (this pass): `--check` 4 problems → 0 — sibling declarations wired in
  `template_cmds.rs`, the two shape-(b) merge lines added to the registration patch
  (`.txt` + `.md` updated together), throwaway apply/reverse/rot validation, vendor
  verified pristine, this STATUS.md.
- **W4-S:** `measure_impl.rs` landed (E0277 seam), layout family fully green in
  pre-flight; flagged the CI overlay step (obligation #1) and the then-4 problems.
- **W3-G:** `document_diff.rs` + `pub mod document_diff;` (asked for the patch line
  this pass added).
- **W3-L:** golden-rules review (16 fixes, 5 PASS); flagged the fill/manifest
  contract (obligation #2) and the sibling-copy gap since closed in the script.
- **W2-K:** applier + registration patch scaffold (pin cross-check, pre-flight,
  sibling-copy loop, both sanctioned merge shapes).
