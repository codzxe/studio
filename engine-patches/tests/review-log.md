# review-log.md — W3-L golden-rules review of `engine-patches/*/*.rs`

Reviewer: W3-L (review-only pass; fix violations in place, never redesign).
Vendor law applied: `vendor/photocraft/AGENTS.md` §3 (Never crash, hostile numbers,
bounded recursion, no `unsafe`), engine crate `#![deny(clippy::unwrap_used, expect_used,
panic, unimplemented, todo, unreachable)]`, `clippy.toml` `allow-*-in-tests = true`
(tests may `unwrap`/index — upstream parity kept). Checklist: crash-safety, typed
errors, determinism, NaN/inf guards, overflow caps, serde-vs-README coherence.
No `cargo` ran (2-CPU box); CI (`infra/ci-staged/engine-patches.yml`) owns builds.

16 violations fixed across 4 files; 5 files PASS. Absent/skipped (per task):
`document_diff.rs` (W3-G), `template_cmds/validate.rs` + `fill_specs.rs` (W3-B template
side) are not in the tree. Non-test regions only; `#[cfg(test)]` blocks verified as
vendor-convention test code (unwrap/index allowed there).

## Report per file

| File (non-test lines reviewed) | Verdict | Violations found → fixed |
|---|---|---|
| `agent_cmds/agent_cmds.rs` (1–400) | **PASS** | — |
| `template_cmds/template_cmds.rs` (1–568) | **FIXED(4)** | V1–V4 |
| `template_cmds/manifest.rs` (1–591) | **PASS** | — |
| `template_cmds/fill.rs` (1–1121) | **FIXED(2)** | V5–V6 |
| `component_cmds/component_cmds.rs` (1–1290) | **FIXED(4)** | V7–V9, V16 |
| `component_cmds/component_manifest.rs` (1–306) | **PASS** | — |
| `layout_cmds/layout_apply.rs` (1–1665) | **FIXED(5)** | V10–V14 |
| `layout_cmds/fit_text.rs` (1–564) | **FIXED(1)** | V15 |
| `layout_cmds/fit_specs.rs` (1–353) | **PASS** | — |

## Fixes

| # | File:line | Rule | Fix (minimal) |
|---|---|---|---|
| V1–V4 | `template_cmds.rs` `scan()` (4 skipped-record sites) | cap allocations sized by input (untrusted templates dir); vendor `installed_profiles` never accumulates files it passes over | record `skipped` only while `len() < MAX_TEMPLATES`; scan keeps walking for servable templates — behavior identical for sane catalogs, `skipped` no longer sizes with a runaway folder |
| V5 | `fill.rs` `compile_text_slot` (`max as usize`) | truncating cast of input-derived `maxChars` on 32-bit targets (wasm32 is a first-class target) → silently trims to the wrong length (e.g. `2³²+5` → 5) | `max.min(usize::MAX as u64) as usize` — the upstream `brush_preset_cmds` index-cast idiom; identical behavior on 64-bit, no wrong trim on wasm32 (texts are already capped at `MAX_TEXT_CHARS`) |
| V6 | `fill.rs` `FitPlan` midpoint (`(min_size + max_size) / 2.0`) | NaN/inf: JSON-derived finite sizes can sum to inf → `current_size = inf` | overflow-free midpoint `min_size + (max_size - min_size) / 2.0` (exact for all finite min ≤ max) |
| V7 | `component_cmds.rs` `bind_instance_variables` | silent host-document corruption: `data_sets.last_mut().map(push …)` wrote the instance's `DataValue`s into whatever set was last — the host's or another instance's — contradicting the fn's own contract ("leaving every other variable and data set of the host document alone") | deleted the stray push; instance values ride only the instance's own data set (created complete below). The loop binding became `(name, layer, kind, _)` (else `value` unused). Tests assert set names/counts only — unaffected. `applyDataSet` reads by name, which always had the full rows |
| V8 | `component_cmds.rs` `diff_layer` position gap | overflow/crash: the `cmpn` instance record is file data; a hostile scale/offset maps to a point saturating at i64::MIN/MAX, where `(want - got)` overflows (debug panic) and `i64::MIN.abs()` panics in release too | `want.checked_sub(..).and_then(i64::checked_abs).is_none_or(|d| d > 1)` — unrepresentable gap counts as "moved", never a crash |
| V9 | `component_cmds.rs` `list_core` dirs collection | cap allocations sized by input: `dirs` collected unbounded before `.take(MAX_COMPONENTS)` — a runaway components root sized the Vec; vendor's profile walk caps its collection | `.take(MAX_COMPONENTS)` moved into the collection; membership follows OS listing order (as vendor), reply stays sorted |
| V10–V13 | `layout_apply.rs` `sizing()`, `layer_ref()`, `align_or()`, dead match in `parse_node` | compile blockers: or-patterns `Stack(n) \| Row(n) [\| Grid(n)] if false` bind `n` across the distinct serde structs — a binding must have one type in every alternative (E0308 "mismatched types within the `\|` pattern"); an `if false` guard does not lift that | deleted the four dead arms (provably never taken) + the `unreachable_sizing`/`unreachable_layer` shims + the no-op match; remaining matches are exhaustive over all 10 kinds; comment explains why per-kind arms are required |
| V14 | `layout_apply.rs` `parse_within` | compile blocker: `finite_px(a.get(i).ok_or_else(g)? as Option<&Value>, …)` — `as Option<&Value>` is an invalid non-primitive cast (E0605) | `finite_px(Some(a.get(i).ok_or_else(g)?), "within")` |
| V15 | `fit_text.rs` `EngineTextMeasurer::measure` guard | NaN/inf hardening: a finite-but-huge `size` (e.g. 1e300) passed the `is_finite` guard and overflowed to inf in `size as f32` before reaching the text engine — undermining the documented "hostile probe ⇒ ceiling metrics, never a panic" contract | `size > MAX_BOX_PX` joins the hostile guard (1e6 pt ≫ `TYPE_SIZE_MAX_PT` 1296; every validated caller is far below) |
| V16 | `component_cmds.rs` `list_core` tags param | capacity hint sized by input before the cap check: `Vec::with_capacity(a.len())` ran on the raw JSON array, then the `MAX_TAGS` refusal — a 10⁶-entry `tags` allocated first | cap check moved above the `with_capacity` (behavior identical for every accepted input) |

## Verified clean (checklist items with no findings)

- Zero `unwrap(`/`expect(`/`panic!`/`todo!`/`unreachable!`/`unsafe` in all non-test
  regions; the only `unwrap_or*`s are message fallbacks after the value is known `Some`
  and the mandated `PoisonError::into_inner` lock idiom. Tests use `unwrap`/indexing
  exactly as upstream tests do (`clippy.toml` allowances) — parity kept.
- Input-derived indices via `.get()`/`first()`/`last()` throughout; string cuts only at
  `char_boundary`/`char_byte` (char indices, never mid-code-point); fixed-size-array
  literal indexing (`b[2]`, `bounds[0]`) matches upstream non-test precedent
  (`mode_cmds`, `layer_copy_cmds`).
- Recursion bounded: `zip_ids`/`clone_layer`/`layer_by_id_mut`/`diff_layer`
  (`MAX_GROUP_DEPTH`/`MAX_TREE_DEPTH`), `parse_node` (`MAX_DEPTH` 64 + `MAX_NODES`
  4096); every loop has an exit (`SEARCH_CAP` 64, `steps <` cap, `break` on failure).
- NaN/inf: every f64 from JSON is `is_finite`-checked before math (manifest `validate`,
  `Sizing::validate`, `parse_box`, `opt_number`, `version_param` — `1e999`→inf dies at
  the door); f64 `abs()` only (never `i64::MIN.abs()` post-V8); divisions guarded
  (`bw < 1.0` checks, `total_grow > 0.0`, `line_px.max(0.01)`, saturating vendor Rect).
- Determinism: BTreeMap/BTreeSet everywhere output-order matters; `HashMap` only as
  lookup tables never iterated for output (agent transactions, id remaps);
  `serde_json` built without `preserve_order` (Map = BTreeMap); scans sort;
  warnings/applied/placements built in input order; solver has no clock/randomness.
- Typed errors everywhere (`EngineError::BadParams/Disabled/Other/NoDocument/NoLayer`);
  no `let _ =` on fallible input paths (only unused-variable silencers on `dir`/`cmd`/`p`).
- Serde vs README: template manifest `deny_unknown_fields` on every struct (matches its
  "unknown fields are errors" claim); `layout.apply` hand-rejects unknown keys with the
  valid-key list (matches "never silently ignored"); component manifest's tolerant
  top level is a documented in-file deviation (nested structs strict);
  `InstanceRecord #[serde(default)]` is the upstream forward-compat convention for
  `.pcraft` round-trip data (AGENTS.md §8).

## Flags for module owners (not fixed — outside review scope)

1. **W3-B / `fill.rs` ↔ `manifest.rs` contract**: `fill.rs` codes against the
   reconciliation surface in its header (`Manifest`, `SlotKind`, `slot.raw`,
   `manifest::active/lookup`) which the landed `manifest.rs` does not export
   (`TemplateManifest`, tagged-enum `Slot`). It is not in the module tree yet
   (`template_cmds.rs` declares only `mod manifest;`), so nothing regresses today;
   wiring `mod fill;` will not compile until the two agree. Same for `validate.rs`
   (absent, W3-B) and `document_diff.rs` (absent, W3-G).
2. **W3-E / layout**: `layout_cmds.rs` (the parent module declaring
   `pub mod fit_text; pub mod fit_specs; mod layout_apply;` + merged `specs()`) does
   not exist yet — the three files reference `super::` paths; the registration patch
   expects it. V11–V15 removed the compile blockers inside `layout_apply.rs`, but
   `fit_text.rs` must implement `super::layout_apply::TextMeasurer for EngineTextMeasurer`
   per the seam doc (currently a `TextMeasurer` with a different `measure` signature).
3. **Applier gap** (already flagged in `template_cmds/README.md`):
   `scripts/apply-engine-patches.sh` copies only `<module>/<module>.rs`; multi-file
   module dirs need the sibling-copy loop or CI's `cargo check` misses the submodule
   files entirely.
4. `component_cmds.rs` `components_root()` defaults to the relative `./components`
   (deployment note only; golden rules unaffected).
