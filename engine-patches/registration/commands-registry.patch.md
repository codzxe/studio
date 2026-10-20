# The ONE existing-file edit — registry registration, documented line by line

Spec §2.3: *"Add each as a new module with a `specs()` function, registered in
`crates/engine/src/commands.rs` (never grow shared files chaotically; workspace rule)."*

Everything else in `engine-patches/` is a brand-new file. This is the only place we
touch existing upstream code, and only through the mechanical diff in
**`commands-registry.patch.txt`** (unified diff, applied with
`git -C vendor/photocraft apply` after `git apply --check`).

Pin context: all line numbers below are from the ADR-0001 pin
`872748fb5b2a53e09dd4e385e31968d985c0515b`. If your working copy differs, re-check the
anchors before validating — `engine-patches/scripts/apply-engine-patches.sh` refuses
to apply on a pin mismatch.

## How the upstream registry works (verified at the pin)

Registration of an existing command module is exactly two insertions:

### 1. `crates/engine/src/lib.rs` — the module declaration

The mod list is a flat, strictly alphabetical block of `pub mod <name>;` /
`mod <name>;` lines (lines 10–135 at the pin; e.g. line 83 `pub mod notes_cmds;`,
line 127 `mod variables_cmds;`). New modules slot in alphabetically. Nothing outside
the engine crate references a command module by Rust path (the automation crate sends
command-id strings), so no `pub use` line is needed and `pub mod` is the right
visibility (the upstream convention for `*_cmds` modules).

### 2. `crates/engine/src/commands.rs` — the registry insert

All commands live in `fn build() -> Vec<CommandSpec>` (line 526), which starts with
`let mut v = vec![ … ]` (line 527) and then registers every module through one line
each, lines 1439–1539 at the pin:

```rust
    v.extend(crate::layer_style::specs());        // line 1439
    v.extend(crate::layer_list_cmds::specs());
    v.extend(crate::filters::specs());
    …
    v.extend(crate::variables_cmds::specs());      // line 1532
    …
    v.extend(crate::actions_cmds::specs());       // line 1539  ← LAST registration
```

immediately followed by (lines 1540–1542, the unambiguous end anchor):

```rust
    // The dispatch guard's unit test needs a command that panics on purpose (REL-3).
    #[cfg(test)]
    v.push(test_panic_command());
```

The new registrations are appended directly after line 1539, before the REL-3 comment.

## The four insertions in `lib.rs` (alphabetical slots, verbatim context)

| Module | Insert after (line @ pin) | Insert before (line @ pin) |
|---|---|---|
| `agent_cmds` | `pub mod adjust_params;` (13) | `pub mod align_cmds;` (14) |
| `component_cmds` | `pub mod commands;` (31) | `pub mod comps_cmds;` (32) |
| `layout_cmds` | `pub mod layer_style;` (74) | `pub mod lens_cmds;` (75) |
| `template_cmds` | `pub mod symmetry_cmds;` (117) | `mod timeline_cmds;` (118) |

(`component_cmds` sorts *after* `commands` — "comm" < "comp"; `layout_cmds` after every
`layer_*` module — "laye" < "layo".)

Every hunk in `commands-registry.patch.txt` quotes exactly 3 context lines before and
after its insertion; the first hunk's context at the pin (lines 11–16):

```
pub mod actions_edit_cmds;
pub mod adjust_cmds;
pub mod adjust_params;
pub mod agent_cmds;          ← added
pub mod align_cmds;
mod allocation;
pub mod analysis_cmds;
```

## The insertion in `commands.rs` (verbatim context, lines 1537–1542)

```
    v.extend(crate::mask_view_cmds::specs());
    v.extend(crate::layer_mask_props_cmds::specs());
    v.extend(crate::actions_cmds::specs());
    v.extend(crate::template_cmds::specs());       ← added
    v.extend(crate::component_cmds::specs());      ← added
    v.extend(crate::layout_cmds::specs());         ← added
    v.extend(crate::agent_cmds::specs());          ← added
    // The dispatch guard's unit test needs a command that panics on purpose (REL-3).
    #[cfg(test)]
    v.push(test_panic_command());
```

(four added lines, in spec §2.3 order).

## Submodule specs merges (fill_specs / document_diff)

Three of the four modules are authored as **more than one file** (the upstream
multi-file-module precedent: `filters.rs` + `filters/validation.rs`). The apply script
copies `engine-patches/<mod>/<mod>.rs` → `crates/engine/src/<mod>.rs` and every sibling
`<sib>.rs` → `crates/engine/src/<mod>/<sib>.rs` (Rust 2018 subdirectory layout; a
`#[path]` attribute in the parent resolves to the same place). Sibling `mod`
declarations (`mod fill; mod validate; mod fill_specs;` in `template_cmds.rs`,
`mod document_diff;` in `agent_cmds.rs`, `pub mod fit_text; pub mod fit_specs; mod
layout_apply;` in `layout_cmds.rs`) live in the **parent module file** — a NEW file,
so they are NOT part of this patch.

A sibling that owns commands has its own `pub fn specs()`. It is merged ONE of the two
sanctioned ways — both keep the §2.3 rule (one registration site, no chaotic growth):

1. **Parent chains it** (the parent's `specs()` concatenates the child's). This is the
   `layout_cmds` design: `layout_cmds.rs` declares the three submodules and
   `pub fn specs()` merges `fit_specs::specs()` with the `layout.apply` spec, so
   registration stays the single line `v.extend(crate::layout_cmds::specs());` —
   nothing extra in this patch.
2. **Registered at the same site** — registration calls `template_cmds::specs()`
   concatenated with `fill_specs::specs()` (and `agent_cmds::specs()` with
   `document_diff::specs()`). When W3-B's `fill_specs.rs` (owning `template.fill` /
   `template.validate` CommandSpecs) and W3-G's `document_diff.rs` (owning
   `document.diff`) land, the registration hunk becomes:

```
    v.extend(crate::mask_view_cmds::specs());
    v.extend(crate::layer_mask_props_cmds::specs());
    v.extend(crate::actions_cmds::specs());
    v.extend(crate::template_cmds::specs());
    v.extend(crate::template_cmds::fill_specs::specs());
    v.extend(crate::component_cmds::specs());
    v.extend(crate::layout_cmds::specs());
    v.extend(crate::agent_cmds::specs());
    v.extend(crate::agent_cmds::document_diff::specs());
    // The dispatch guard's unit test needs a command that panics on purpose (REL-3).
```

   i.e. two added lines in `commands-registry.patch.txt` (one `v.extend` each, at the
   parent's side), and the hunk header grows `@@ -1537,6 +1537,12 @@`.

`engine-patches/scripts/apply-engine-patches.sh` enforces the invariant at apply
time: a sibling file that has `pub fn specs()` must be registered **one** of the two
ways — chained inside its parent's `specs()` (grep `<sib>::specs()` in the parent) or
carried as `v.extend(crate::<parent>::<sib>::specs());` in this patch — and the
script refuses (before touching the vendor tree) when a landed `specs()` is registered
nowhere, or when the patch references a sibling that has not landed yet. Either
failure names the exact line to add. A command that exists as a file but never reaches
`command_specs()` is a silent failure; the script makes it loud.

## What the patch does NOT contain

- No menu paths, labels, `enabled` fns or `run` fns — those live inside each module's
  `specs()` (`CommandSpec` entries), not in the registry.
- No `mod` declarations for sibling files — those live in the parent module file (a
  NEW file; see "Submodule specs merges" above).
- No edits to any other upstream file (no `rpc.rs`, no `headless.rs`, no `Cargo.toml`:
  the `crates/*` glob picks up new modules automatically and no new dependencies are
  allowed without an ADR).
- No SaaS references: the four modules are plain upstream features
  (`template.*`, `component.*`, `layout.*`, `agent.*` / `document.diff` command ids do
  not exist anywhere in the engine at the pin — verified by grep).

## Wave 3 validation steps

1. `engine-patches/scripts/apply-engine-patches.sh --check` — pin verified, the
   authored tree is coherent with the patch (no unregistered `specs()`, no patch
   reference to a missing file), and `git apply --check` passes — changing nothing.
2. Dry-run the patch itself against a **throwaway copy** of the two affected files —
   never vendor: copy `crates/engine/src/{lib.rs,commands.rs}` from the pristine pin
   to `/tmp/<dir>/crates/engine/src/`, then `git apply --check` **and** `git apply`
   there; verify the four `pub mod` lines land in alphabetical slots and the four
   `v.extend` lines land after `actions_cmds` (the numbers above); `git apply
   --reverse --check` proves the script's already-applied detection. Rot check:
   mutate one anchor line in the copy — `git apply --check` must fail.
3. After all module files land, run the full script (copy + apply), then in the vendor
   clone: `cargo check -p photocraft-engine` and
   `cargo test -p photocraft-engine --test panic_hunt -- --ignored`.
4. `cargo xtask parity` must still succeed; commit the regenerated
   `docs/parity-checklist.md` in the upstream PR (spec §2.3).
5. If `git apply --check` fails on a clean pin clone, the patch rotted — update the
   patch text AND this document together in the same change. Never hand-edit
   `vendor/photocraft/**` to make it fit.
