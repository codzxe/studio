# layout_cmds.rs — `layout.*` commands (spec §9)

**File goes to `crates/engine/src/layout_cmds.rs` when merged upstream.**
Authored here (Wave 3) as `engine-patches/layout_cmds/layout_cmds.rs`; applied to the
local pinned clone only by `engine-patches/scripts/apply-engine-patches.sh`.
Registered via `pub fn specs() -> Vec<CommandSpec>`; the registry insert lives in
`registration/commands-registry.patch.txt`.

## Command surface (spec §9.4, verbatim)

| Command | Params | Returns |
|---|---|---|
| `layout.apply` | `{ root, options? }` | `{ moved: [{layer, from, to}], warnings: [] }` |
| `layout.fitText` | `{ layer, bounds, minSize, maxSize, lineHeight, maxLines }` | `{ size, lines, overflow, bounds }` |
| `layout.measure` | `{ layer?, bounds?, text? }` | metrics for planning (no mutation) |

`layout.apply` node types (§9.2): `stack`, `row`, `grid { columns, gap }`, `absolute`,
`center`, `spacer`, `text`, `image`, `component`, `divider`. Sizing: `fixed`, `grow`,
`hug`, `aspect`, `min/max`, `percent`. Anchors: 9-point plus `baseline`. Options:
`coordinateSpace: document | parent`, `safeArea`. **All output is clamped to the canvas
and the safe area; `layout.apply` never produces out-of-bounds layers.**

`layout.fitText` algorithm (§9.3): measure at requested size with the engine's text
metrics → binary search down to `minSize` tracking wrapped lines → condensed tracking
(±2%) → ellipsis with a warning (single-line) → else report `text_overflow` with exact
overflow in px and characters; **never clip silently**. Return chosen size, line count,
used bounds, overflow flag; the caller writes back via `type.edit`.

Numeric limits (§9.5, hard-validate before any math): grid columns 1–24; gaps 0–256 px;
padding 0–2048 px; every integer or float checked for NaN/inf before use. Alignment is
logical (`start`/`end`), never bare `left`/`right`, unless a template explicitly needs
physical sides.

Suggested `CommandSpec` shape (cf. `notes_cmds.rs`):

```rust
CommandSpec {
    id: "layout.apply",
    label: "Apply Layout",
    menu: &[],
    shortcut: None,
    params: r##"{"root":{node},"options":{"coordinateSpace":"document"|"parent"="document","safeArea":px?}?}"##,
    enabled: has_doc,
    run: apply,
    journal: true,
}
```

(`layout.measure` is a pure query: `journal: false`, `enabled: has_doc` — metrics need a
document for fonts/units.)

## Golden-rules checklist (merge blockers — upstream AGENTS.md + §1.5 rule 4)

- [ ] No `unwrap` / `expect` / `panic!` / `unreachable!` / `todo!` / `unimplemented!`
      outside tests.
- [ ] No `unsafe`.
- [ ] **This module is pure math on hostile numbers** — every input-derived index via
      `get()`; validate every float (`is_finite()`) before use; `checked_*` division /
      casts; reject absurd sizes before allocating (a `grid` with 24 columns of
      1e9-px cells must `Err`, not allocate).
- [ ] Bound recursion: `root` trees are user/LLM input — enforce a depth limit and a
      node cap (and reject cycles); `within` layer references resolved via `get()`,
      ambiguity = `Err` + candidates.
- [ ] Empty `children` arrays, zero/negative `columns`, NaN `gap`/`padding`,
      `bounds` outside canvas → `Err` with a fix hint, never a panic or silent
      out-of-bounds layer.
- [ ] Graceful-failure tests: empty / wrong-type / out-of-range params → `Err`.
- [ ] Panic-hunt survives adversarial params (obligations: `../tests/README.md`).

## Panic-hunt test obligations (this module)

`layout.apply/fitText/measure` are the highest-risk numeric surface of the four
modules — they must each return `Err`, never panic/hang, for at least: `columns: 0`,
`columns: -5`, `columns: 1e9`, `gap: NaN`, `padding: [Infinity, 0, -Infinity, 1e18]`,
`safeArea: -1`, empty `children`, deeply nested `root` (100+ levels), cyclic layer
references, `minSize > maxSize`, `maxLines: 0`, empty strings for `layer`/`text`.
Full table + how to run: `../tests/README.md`.
