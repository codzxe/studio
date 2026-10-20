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
line 127 `mod variables_cmds;`). New modules slot in alphabetically.

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

immediately followed by (lines 1540–1544, the unambiguous end anchor):

```rust
    // The dispatch guard's unit test needs a command that panics on purpose (REL-3).
    #[cfg(test)]
    v.push(test_panic_command());
    v
}
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

Quoted context at the pin (lines 12–15):

```
pub mod adjust_cmds;
pub mod adjust_params;
pub mod align_cmds;
mod allocation;
```

## The insertion in `commands.rs` (verbatim context, lines 1537–1542)

```
    v.extend(crate::mask_view_cmds::specs());
    v.extend(crate::layer_mask_props_cmds::specs());
    v.extend(crate::actions_cmds::specs());
    // The dispatch guard's unit test needs a command that panics on purpose (REL-3).
    #[cfg(test)]
    v.push(test_panic_command());
```

becomes (four added lines, in spec §2.3 order):

```
    v.extend(crate::mask_view_cmds::specs());
    v.extend(crate::layer_mask_props_cmds::specs());
    v.extend(crate::actions_cmds::specs());
    v.extend(crate::template_cmds::specs());
    v.extend(crate::component_cmds::specs());
    v.extend(crate::layout_cmds::specs());
    v.extend(crate::agent_cmds::specs());
    // The dispatch guard's unit test needs a command that panics on purpose (REL-3).
    #[cfg(test)]
    v.push(test_panic_command());
```

## What the patch does NOT contain

- No menu paths, labels, `enabled` fns or `run` fns — those live inside each module's
  `specs()` (`CommandSpec` entries), not in the registry.
- No edits to any other upstream file (no `rpc.rs`, no `headless.rs`, no `Cargo.toml`:
  the `crates/*` glob picks up new modules automatically and no new dependencies are
  allowed without an ADR).
- No SaaS references: the four modules are plain upstream features
  (`template.*`, `component.*`, `layout.*`, `agent.*` / `document.diff` command ids do
  not exist anywhere in the engine at the pin — verified by grep).

## Wave 3 validation steps

1. `engine-patches/scripts/apply-engine-patches.sh --check` — pin verified +
   `git apply --check` passes against the pristine pin.
2. After writing all four `<module>.rs` files, run the full script (copy + apply), then
   in the vendor clone: `cargo check -p photocraft-engine` and
   `cargo test -p photocraft-engine --test panic_hunt -- --ignored`.
3. `cargo xtask parity` must still succeed; commit the regenerated
   `docs/parity-checklist.md` in the upstream PR (spec §2.3).
4. If `git apply --check` fails on a clean pin clone, the patch rotted — update the
   patch text AND this document together in the same change. Never hand-edit
   `vendor/photocraft/**` to make it fit.
