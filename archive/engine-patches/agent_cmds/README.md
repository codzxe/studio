# agent_cmds.rs — `agent.*` + `document.diff` commands (spec §5.6)

**File goes to `crates/engine/src/agent_cmds.rs` when merged upstream.**
Authored here (Wave 3) as `engine-patches/agent_cmds/agent_cmds.rs`; applied to the
local pinned clone only by `engine-patches/scripts/apply-engine-patches.sh`.
Registered via `pub fn specs() -> Vec<CommandSpec>`; the registry insert lives in
`registration/commands-registry.patch.txt`.

## Command surface (spec §5.6, verbatim)

| Command | Params | Returns / meaning |
|---|---|---|
| `agent.begin` | `{ name }` | records a history checkpoint/marker with a stable id |
| `agent.commit` | `{}` | collapses the run into one undoable history entry |
| `agent.rollback` | `{}` | restores the checkpoint (the whole run disappears) |
| `document.diff` | `{ from, to }` | `{ added, removed, changed, moved }` per layer, for UI diff and the validator's "nothing was silently destroyed" check |

Implementation notes (§5.6): **prefer the existing history/snapshot machinery** —
`crates/engine/src/history_cmds.rs` / `history_select_cmds.rs` and the `Session`
history API at the pin; if snapshots are not yet exposed, add them. The command log
must support replay from the last checkpoint: store `revision_before` /
`revision_after` (monotonic counters) with each command. Replay is used on engine crash
and for "duplicate this document" (copy-on-write from the log).

Semantics that shape the code:

- One transaction per run (§1.5 rule 10): the whole agent run reverts with a single
  undo/rollback, and the exact command log is stored for replay and audit.
- A retried tool call must be safe — `agent.begin` marks the checkpoint (§3.4).
- `agent.begin` with no name / empty string: default the marker name, never `Err` on
  cosmetic params. `agent.commit` / `agent.rollback` with no open transaction:
  `Err` (idempotent *refusal*, not a no-op that journals garbage).
- `document.diff { from, to }` — `from`/`to` are revision ids; out-of-range or unknown
  revisions → `Err` listing valid bounds. Diff walks the layer tree with a recursion
  bound (documents can be deep/cyclic).

Suggested `CommandSpec` shape (cf. `notes_cmds.rs`):

```rust
CommandSpec {
    id: "agent.begin",
    label: "Begin Agent Transaction",
    menu: &[],
    shortcut: None,
    params: r##"{"name":str="run"}"##,
    enabled: has_doc,
    run: begin,
    journal: true,   // the checkpoint marker must be replayable
}
```

`document.diff` is a pure query: `journal: false`.

## Golden-rules checklist (merge blockers — upstream AGENTS.md + §1.5 rule 4)

- [ ] No `unwrap` / `expect` / `panic!` / `unreachable!` / `todo!` / `unimplemented!`
      outside tests.
- [ ] No `unsafe`.
- [ ] Input-derived indices (revision ids, marker ids, layer ids) via `get()`; no
      `[i]` / `[a..b]` on anything param-derived.
- [ ] Lock poisoning handled (`lock().unwrap_or_else(PoisonError::into_inner)`) —
      upstream "don't cascade" rule; thread joins treated as `Result`s.
- [ ] Bound recursion in `document.diff` tree walks (depth limit / seen-set).
- [ ] Graceful-failure tests: no document open, no open transaction, unknown
      revisions, wrong-type params → `Err`.
- [ ] Panic-hunt survives adversarial params (obligations: `../tests/README.md`).

## Panic-hunt test obligations (this module)

`agent.begin/commit/rollback` and `document.diff` must each return `Err`, never
panic/hang, for at least: no document open; `agent.commit`/`rollback` with no
transaction; negative/huge/mismatched `from`/`to` revisions; empty string `name`;
`document.diff` on an empty document and on a maximally deep layer tree; concurrent
begin/rollback interleavings (history state must never wedge). Full table + how to run:
`../tests/README.md`.
