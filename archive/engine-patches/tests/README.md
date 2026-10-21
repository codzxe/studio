# tests — panic-hunt obligations for the four new modules (spec §2.3 + §1.5 rule 4)

The upstream rule (editor AGENTS.md, "Never crash" + Rule 9) and spec §1.5 rule 4:
**every command must return `Err` on bad input — never panic, never hang.** The
`panic_hunt` integration test fuzzes the whole registry with adversarial params on a
fresh 24×16 document (each command runs on its own thread with a wall-clock deadline;
panics are counted by a hook even when contained by `Session::execute`).

## The command (opt-in, slow)

```sh
cargo test -p photocraft-engine --test panic_hunt -- --ignored
```

Run it wherever the patched clone builds — the CI job
`infra/ci-staged/engine-patches.yml` — never on a starved dev box. It must be green for
every command the four new modules add; a panic anywhere in `run` (or anything it
calls), on *any* params or document state, is a merge blocker.

The existing harness (at the ADR-0001 pin) already fuzzes every registered command
with the generic parameter soup (a panic hook counts panics `Session::execute` contains;
a 4 s wall-clock deadline, retried once, catches hangs — one-time lazy setup like the
text engine's font scan is exempt). Wave 3's obligation is **command-specific adversarial
tables** plus the graceful-failure unit tests listed in each module README (authored as
in-module `#[cfg(test)]` blocks, upstream convention — e.g. `agent_cmds.rs`'s 13 tests).

## The 22 case classes (drive every row below through these)

Every NEW command (`template.*`, `component.*`, `layout.*`, `agent.*`, `document.diff`)
must survive all applicable classes below — the per-command table adds the
command-specific ones. 20+ minimum per command family:

1. `{}` — empty params (missing everything)
2. non-object params: `[]`, `0`, `""`, `null`, `true` as the whole params value
3. wrong type: string where a number is expected
4. wrong type: number where a string is expected (`"layer": 42`)
5. negative index / size / count / version
6. zero (size, count, `columns: 0`, `maxLines: 0`)
7. huge integers (`1e18`, `u64::MAX`-ish JSON)
8. NaN via the tolerated encodings (`null`, `"NaN"` — JSON has no NaN literal)
9. Infinity via `1e999` (serde_json parses it as inf) and via `-1e999`
10. empty string for ids/names/texts
11. oversized strings (1 MB text, 64 KB names, 4000-char transaction names)
12. Unicode edge cases: astral-plane (🦀), zero-width, combining marks — slice at char
    boundaries, never mid-code-point
13. huge arrays (`10⁵` entries; `tags` past its 32-entry cap)
14. deeply nested objects (100+ levels; recursion bounds)
15. duplicate names/keys (slots, layers, components)
16. unknown enum value (`"coordinateSpace": "diagonal"`, wrong `fit` mode)
17. extra unknown params
18. missing required param (vs wrong-typed)
19. cyclic references (`within` loops, self-referential nodes)
20. path traversal / ambient paths (`../`, absolute paths) — capability roots refuse
21. empty array where an object is expected and vice versa (`slots: []`)
22. adversarial document state: no document open, empty document, maximally deep
    groups, locked layers, history trimmed mid-transaction

## Adversarial param table (per command)

| Command | Must `Err` (not panic/hang) on |
|---|---|
| `template.list` | `tags: []`, `tags: "str"` (wrong type), `tags` with 33+ entries (cap 32), huge `tags` array, `query: ""`, astral-plane/combining `query`, extra params; dir-level: `PHOTOCRAFT_TEMPLATES_DIR` unset (typed Err, message never echoes paths), corrupt JSON manifest, manifest > 4 MiB (cap), catalog > 256 templates (cap), `<id>@<version>.json` naming oddities |
| `template.inspect` | missing `id`, `id: ""`, unknown id (error lists candidates, capped at 8 pins), malformed pins `id@` / `@3` / `a@@b` / `id@2x` (non-numeric version), `version: -1` / `0` / `1e18` / `null` / string-typed, id with path separators (`../`), corrupt `.pcraft` beside a good manifest, manifest missing required fields |
| `template.apply` | unknown/missing `id`, bad `version` pin, `asGroup: "yes"` / `1` (wrong type), `name: ""`, name with weird Unicode, canvas 0×0 / 64 MP+ (`MAX_DIMENSION`), manifest claiming 10⁶ slots, apply with no document open AND with one open (both legal paths), template whose `.pcraft` is corrupt, unknown optional params ignored |
| `template.fill` | `slots: {}` (nothing to fill / missing required → Err lists exactly what's needed §7.3), `slots: []` / `"str"` (wrong type), huge `slots` object (cap 128 slots), duplicate slot names, unknown slot names (Err lists the manifest's slots), slot name `""` / astral Unicode, text value > 65 536 chars (refused, not rendered), text trim at char boundary (warning, never silent), image slot: ambient `path` (capability roots refuse), corrupt/not-base64 `data`, upscale > 200% (hard Err) / > 125% (warning), `minPixels` warning, color slot: NaN/Inf/negative channels, wrong type; component slot: unknown id (Err + candidates); visibility slot wrong type; optional unfilled slots hidden, never deleted; NaN bounds |
| `template.validate` | both `template` and `document` absent, unknown ids, `version` adversarial (as `inspect`), document with 0 layers, maximally deep groups, manifest rules unachievable (`min_contrast`, `safeArea` > canvas) |
| `component.list` | as `template.list` (wrong types, huge tag arrays, empty query, unset components dir) |
| `component.inspect` | unknown `id`, `id: ""`, `version: -1` / `NaN` / huge, manifest with missing `variables`/`anchors` fields, anchors outside `[0,1]`, corrupt manifest file |
| `component.place` | unknown `id`, missing parent layer, ambiguous parent name (Err + candidates), `bounds: [NaN,0,0,0]`, `bounds: [-Inf,Inf,0,-1]`, NaN/zero/negative width-height, anchor outside the 9-point set, wrong `fit` mode enum, `vars` with unknown keys (Err + allowed list), `vars` values violating `maxChars`, visibility var as string, color var with NaN/Infinity channels, huge `vars` object |
| `component.setVars` | missing/unknown `instance`, ambiguous instance (Err + candidates), empty `vars`, unknown variable names (Err + allowed list), wrong-typed values per `VarKind` |
| `component.updateInstance` | missing/unknown `instance`, instance whose master vanished (deleted or unpublished) |
| `component.publish` | (later phase) missing `group`, unknown layers, `id` collisions with an existing component |
| `layout.apply` | `root: {}` / `[]` / missing / `"str"`, unknown node type (`"stackk"`), `columns: 0` / `-5` / `25` / `1e9` / `24.5` (float), `gap: NaN` / `-1` / `257`, `padding: [NaN,Inf,-Inf,1e18]`, padding array of wrong length / not an array, `safeArea: -1` / `NaN` / bigger than canvas, empty `children`, `children` with 10⁵ entries, `root` nested 100+ deep (recursion bound), cyclic `within` references, `grow: -1`, `percent: 400` / NaN, `aspect: 0` / NaN, `coordinateSpace: "diagonal"` (unknown enum), `fixed` negative size, `hug` with 10⁶ children — **output must clamp to canvas + safe area: no out-of-bounds layer ever** |
| `layout.fitText` | missing/ambiguous `layer` (name matches 2 layers → Err + candidates), `minSize: NaN` / `0` / negative / `1e18`, `maxSize: NaN` / `Inf` / `< minSize`, `lineHeight: 0` / `NaN` / negative / huge, `maxLines: 0` / huge (cap 10⁶), `bounds` with NaN/negative/zero-extent components, `bounds` > 10⁶ px (cap, bounds the probe layer), empty `text`, astral text at the ellipsis boundary, locked layer (fast typed Err), measurer returning non-finite metrics (→ overflow report, **never a NaN in a reply**) |
| `layout.measure` | neither `layer` nor `text` (one required), `text` 1 MB (cap, not unbounded allocation), `size` without a layer, `font` wrong type / unknown family, `bounds` as `fitText`, pure-query identity: no mutation on any path (journal: false) |
| `agent.begin` | no document open, `name: ""` / blank (defaulted, not a panic — cosmetic params default), `name: 42` (wrong type, defaulted), `name` 4000 chars (Err, message unechoed; 256 cap char-counted), astral 🦀 names, **nested begin → Err** (§1.5 rule 10), begin after the document closed, begin when a previous transaction leaked open |
| `agent.commit` | no document open, **no open transaction** (`not_open`), commit twice (second Err), interleaved with `agent.rollback`, empty run (no history entry, no revision bump), in-run undo then commit, checkpoint trimmed by the history budget (`max_states: 1` → record fallback), document closed mid-run, 20-round begin/commit/rollback wedge soak |
| `agent.rollback` | no document open, no open transaction, rollback twice (second Err), checkpoint gone (budget trim / run undid past it → snapshot-restore fallback, content restored), rollback after close Err, closed-doc never wedges the session (poisoned lock tolerated) |
| `document.diff` | no document open, `from`/`to` missing / negative / huge / `null` / string-typed, `from > to`, unknown revisions (Err with the valid range), empty document, maximally deep/cyclic group nesting (seen-set bound), diff while a nested transaction is open |

"NaN/Inf" arrive as JSON where impossible (JSON has no NaN) — test the engine's
tolerated encodings: `null`, strings (`"NaN"`), huge floats (`1e999` parses as inf in
serde_json), and arithmetic inside the command that can *produce* NaN/inf from finite
inputs (division by zero, overflow). Guard those before use (`is_finite()`,
`checked_*`).

## Registration coherence (fail loud, §2.2/§2.3)

A command that exists as a file but never reaches the registry is a silent failure.
`engine-patches/scripts/apply-engine-patches.sh` refuses to apply while any sibling
module with a `pub fn specs()` is registered nowhere (chained in its parent or carried
by `registration/commands-registry.patch.txt` — see its "Submodule specs merges"
notes). After the patch applies, the CI order below re-verifies: `command.list` /
`command_specs()` must contain every new id (`template.*`, `component.*`, `layout.*`,
`agent.*`, `document.diff`) — the SaaS side additionally fails loud at startup on a
missing engine-patch command family (§2.2: engine-patch families are checked by their
own wave's startup check, distinct from the engine-native REQUIRED list).

## Graceful-failure unit tests (merge gate, per upstream contributing rules)

Beyond the fuzz: each command gets deterministic tests asserting a typed `Err` (empty /
out-of-range / wrong-type params → `Err`, with a message that names the offending
param), plus a happy-path test on a synthetic small document. New crash fixes come with
a small synthetic regression test that panicked before the fix.

## Parity note (spec §2.3)

Adding commands triggers the upstream parity machinery — in the patched clone, run:

```sh
cargo xtask parity
```

and commit the regenerated `docs/parity-checklist.md` in the **upstream PR** (never in
this repo's `engine-patches/`; the checklist belongs to the editor repo). The four
modules are agent-facing (empty `menu: &[]`), so they do not change menu coverage
numbers, but the regeneration must be done and remain green — CI checks it.

## CI

`infra/ci-staged/engine-patches.yml` runs, in order: pin-exact clone →
`engine-patches/scripts/apply-engine-patches.sh` (refuses on pin drift, on a tree/patch
disagreement, or on an unregistered sibling `specs()`) →
`cargo check -p photocraft-engine` → the panic-hunt command above → parity
regeneration check. Any failure blocks the patch series; fix the patch, never the pin.
