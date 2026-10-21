# template_cmds.rs — `template.*` commands (spec §7)

**File goes to `crates/engine/src/template_cmds.rs` when merged upstream.**
Authored here (Wave 3) as `engine-patches/template_cmds/template_cmds.rs`; applied to
the local pinned clone only by `engine-patches/scripts/apply-engine-patches.sh`.
Registered via `pub fn specs() -> Vec<CommandSpec>`; the registry insert lives in
`registration/commands-registry.patch.txt`.

## Command surface (spec §7.4, verbatim)

| Command | Params | Returns |
|---|---|---|
| `template.list` | `{ tags?, query? }` | `{ templates: [{ id, name, version, tags, canvas, slots: string[] }] }` |
| `template.inspect` | `{ id, version? }` | full manifest + resolved template document info |
| `template.apply` | `{ id, version?, name?, asGroup?: true }` | `{ document_revision, group_id, slots }` |
| `template.fill` | `{ slots: { ... } }` | `{ applied: string[], warnings: [], errors: [] }` |
| `template.validate` | `{ template?, document? }` | `{ ok, issues: [{ level, code, layer, message, fix }] }` |

Implementation notes (§7.4): templates are `.pcraft` files + JSON manifests in a
directory discovered at startup (CLI flag/env; capability roots apply). `template.apply`
opens a copy, optionally groups layers, returns layer ids by slot. `template.fill`
compiles slot values to existing commands (`type.edit`, `doc.place`,
`layer.fill.solidColor.set`, `edit.transform`) and executes them as a batch. `id@version`
is always explicit in the command log. Reuse existing engine commands — do not
re-implement text/fill/transform.

Suggested `CommandSpec` shape (follows upstream convention, cf. `notes_cmds.rs`):

```rust
CommandSpec {
    id: "template.list",
    label: "List Templates",
    menu: &[],               // agent-facing; not a Photoshop menu item
    shortcut: None,
    params: r##"{"tags":[str]?,"query":str?}"##,
    enabled: always,         // queries need no document
    run: list,
    journal: false,          // queries never journal; apply/fill/validate mutating runs journal per upstream rules
}
```

Bad input → `EngineError::BadParams { cmd, msg }` (or a typed variant) with the allowed
options listed. Missing required slots is a validation error listing exactly what is
needed (§7.3); optional unfilled slots stay **present but hidden** — never delete
template layers.

## Golden-rules checklist (merge blockers — upstream AGENTS.md + §1.5 rule 4)

- [ ] No `unwrap` / `expect` / `panic!` / `unreachable!` / `todo!` / `unimplemented!`
      outside tests (provably-infallible literals need `#[allow]` + a why comment).
- [ ] No `unsafe` (crate forbids it).
- [ ] Every input-derived index via `get()`, never `[i]` or `[a..b]`; string slices at
      char boundaries only (slot names, layer names, queries may be any UTF-8).
- [ ] `checked_*` / `saturating_*` for sizes/counts; guard division by zero; reject
      NaN/inf; cap allocations sized by input (huge `slots` objects, huge tag arrays).
- [ ] Bound recursion when walking template manifests / document trees (depth limit).
- [ ] Filesystem access only through capability-scoped roots; refuse ambient paths
      (automation mode does this already — don't bypass).
- [ ] Graceful-failure tests: empty / out-of-range / wrong-type params → `Err`.
- [ ] Panic-hunt survives adversarial params (obligations: `../tests/README.md`).

## Panic-hunt test obligations (this module)

`template.list/inspect/apply/fill/validate` must each return `Err`, never panic/hang,
for at least: negative index/version numbers, `NaN`/`Infinity` numeric params, empty
strings, unknown ids, huge arrays, deeply nested `slots` objects, non-UTF-8-safe
boundary slices, and duplicate slot names. Full table + how to run:
`../tests/README.md`.

## Wave 3 file split, wiring and ownership (W3-A / W3-B coordination)

This module directory holds more than one source file, laid out exactly as upstream
does multi-file modules (cf. `filters.rs` + `filters/validation.rs`):

| File (here) | Upstream path (when applied) | Owner |
|---|---|---|
| `template_cmds.rs` | `crates/engine/src/template_cmds.rs` | **W3-A** — catalog commands + `specs()` |
| `manifest.rs` | `crates/engine/src/template_cmds/manifest.rs` | **W3-A** — shared §7.2 serde types + validation + `id@version` pin helpers |
| `fill.rs` | `crates/engine/src/template_cmds/fill.rs` | **W3-B** — `template.fill` (+ its `specs()`) |
| `validate.rs` | `crates/engine/src/template_cmds/validate.rs` | **W3-B** — `template.validate` (+ its `specs()`) |

- `template_cmds.rs` declares `mod manifest;` (Rust 2018 layout — resolves to the
  `template_cmds/` subdirectory upstream). W3-B's files are submodules of the same
  module: they reach the shared types via `use super::manifest::{…}` and the catalog
  helpers via `use super::{resolve, scan, templates_dir, version_param, layer_by_name,
  slot_ids, Catalog, TemplateFile}` (all `pub(crate)`; `MAX_SLOTS`, `MAX_TEMPLATES`,
  `MAX_MANIFEST_BYTES` caps live in `manifest.rs`/`template_cmds.rs`).
- **Registration**: W3-A's `specs()` returns only `template.list` / `template.inspect`
  / `template.apply` (the note in `specs()` documents this). W3-B's `template.fill` /
  `template.validate` register through their own `specs()` — either merged into
  `template_cmds::specs()` when B's files land (a 3-line addition to W3-A's file:
  `mod fill; mod validate;` + `v.extend(fill::specs()); v.extend(validate::specs());`)
  or via an extra `v.extend(crate::template_cmds::fill::specs())` line in the
  registration patch (W2-K's file). Nothing is stubbed for B here.
- **Applier gap (flagged for `engine-patches/scripts/apply-engine-patches.sh`, W2-K's
  file)**: the script currently copies only `engine-patches/<module>/<module>.rs` to
  `crates/engine/src/<module>.rs`. With this split it must also copy the sibling files
  into the module subdirectory (`engine-patches/template_cmds/*.rs` →
  `crates/engine/src/template_cmds/`), or `cargo check` fails on the missing
  `manifest`/`fill`/`validate` modules. Suggested loop change: for each module, `mkdir
  -p "$VENDOR_DIR/crates/engine/src/$m"` then `cp "$PATCHES_DIR/$m/"*.rs
  "$VENDOR_DIR/crates/engine/src/$m/"` with `<module>.rs` staying at the parent.
- **Config**: the templates directory is the `PHOTOCRAFT_TEMPLATES_DIR` env var (the
  engine's own run-time folder-setting precedent: `PHOTOCRAFT_NO_PRINT`,
  `installed_profiles`), read per call in `templates_dir()`. Each template is
  `<stem>.json` (the §7.2 manifest; id and version come from its content) with
  `<stem>.pcraft` beside it. The automation crate's ambient-path gate
  (`command_uses_ambient_path`) does not list `template.*` — the directory is
  deployment configuration, not a caller-supplied path; the automation owner may add
  the dir to its authorized roots if they want it capability-scoped.

