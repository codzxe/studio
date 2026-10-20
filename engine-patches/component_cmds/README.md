# component_cmds.rs — `component.*` commands (spec §8)

**File goes to `crates/engine/src/component_cmds.rs` when merged upstream.**
Authored here (Wave 3) as `engine-patches/component_cmds/component_cmds.rs`; applied to
the local pinned clone only by `engine-patches/scripts/apply-engine-patches.sh`.
Registered via `pub fn specs() -> Vec<CommandSpec>`; the registry insert lives in
`registration/commands-registry.patch.txt`.

## Command surface (spec §8.3, verbatim)

| Command | Purpose |
|---|---|
| `component.list { tags?, query? }` | discover |
| `component.inspect { id, version? }` | manifest + layer map |
| `component.place { id, version?, parent?, bounds?, anchor?, vars? }` | instantiate |
| `component.setVars { instance, vars }` | per-instance overrides |
| `component.updateInstance { instance }` | pull latest component version |
| `component.publish { group, id?, version? }` | (later) promote a group to component |

Building blocks (§8.1) — reuse existing engine primitives, do not invent a parallel
system:

- Smart-object sharing (`SmartContentsId`) → shared pixel content; `layer.smartObjects.*`.
- Variables + data sets (`image.variables.define`, `image.applyDataSet`,
  `image.variables.dataSets`) → per-instance text / colour / visibility / image values.
- Layer comps (`layerComp.*`) → alternative states (light/dark, sizes).

Manifest fields (§8.2): `id`, `version`, `name`, `tags`, `defaultSize`, `variables`
(`kind` text|color|visibility, `default`, `maxChars`), `anchors` (normalized 9-point
`[x,y]`), `comps`. Start with the hard-coded 5–10 component library (logo lockup, offer
badge, star rating, price tag, button, quote block, avatar, wave divider, ribbon,
social handle); `license: workspace | public` on every component.

Rules that shape the code (§8.4): instance variables are schema-checked — unknown
variables are errors **with the allowed list attached**; placing never mutates the
master; updates across instances are opt-in per instance; anchors are normalized
coordinates, validate and clamp before use.

Suggested `CommandSpec` shape (cf. `notes_cmds.rs`):

```rust
CommandSpec {
    id: "component.place",
    label: "Place Component",
    menu: &[],
    shortcut: None,
    params: r##"{"id":str,"version":n?,"parent":layerRef?,"bounds":[x,y,w,h]?,"anchor":"center"|…?,"vars":{str:str}?}"##,
    enabled: has_doc,
    run: place,
    journal: true,
}
```

## Golden-rules checklist (merge blockers — upstream AGENTS.md + §1.5 rule 4)

- [ ] No `unwrap` / `expect` / `panic!` / `unreachable!` / `todo!` / `unimplemented!`
      outside tests.
- [ ] No `unsafe`.
- [ ] Input-derived indices via `get()`; layer/instance references resolved by the
      engine with ambiguity = `Err` + candidates (§6.1); strings sliced at char
      boundaries only.
- [ ] Validate `bounds` / anchor floats: reject NaN/inf, clamp negatives, cap sizes
      (64 MP ceiling context: automation budgets); `checked_*` math on sizes/counts.
- [ ] Cap `vars` object size and string lengths (`maxChars` per manifest); cap
      recursion when resolving instance chains (depth limit).
- [ ] Graceful-failure tests: empty / wrong-type / out-of-range params → `Err`.
- [ ] Panic-hunt survives adversarial params (obligations: `../tests/README.md`).

## Panic-hunt test obligations (this module)

`component.list/inspect/place/setVars/updateInstance` must each return `Err`, never
panic/hang, for at least: unknown ids, negative/huge versions, `NaN`/`±Infinity` in
`bounds`/anchors, unknown variable names, oversized `vars` (huge arrays, long
strings), empty strings, ambiguous/missing `instance` refs. Full table + how to run:
`../tests/README.md`.
