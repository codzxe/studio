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
