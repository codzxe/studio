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
with the generic parameter soup. Wave 3's obligation is **command-specific adversarial
tables** plus the graceful-failure unit tests listed in each module README.

## Adversarial param table (per command)

General row (applies to every command below): `{}`; wrong-typed params (string where
number expected and vice versa); extra unknown params; `null` values; non-object
params (`[]`, `0`, `""`); Unicode, zero-width and astral-plane strings (slice at char
boundaries, never mid-code-point).

| Command | Must `Err` (not panic/hang) on |
|---|---|
| `template.list` | `tags: []`, `tags: [""…]` (huge array), `query: ""`, `query` with astral-plane/combining chars, `tags: "str"` (wrong type) |
| `template.inspect` | unknown `id: ""`, missing `id`, `version: -1`, `version: 0`, `version: 1e18`, `version: NaN` (JSON `null`/string), id with path separators (`../`) — capability roots must refuse, not traverse |
| `template.apply` | unknown/missing `id`, bad `version`, `asGroup: "yes"` (wrong type), template dir containing a corrupt `.pcraft`, a manifest claiming 10⁶ slots, `name: ""`, canvas 0×0 / 64 MP+ |
| `template.fill` | `slots: {}`, `slots: []` (wrong type), huge `slots` object (allocation cap), duplicate slot names, slot name with empty string / weird Unicode, values with NaN colour components, unknown slot names (error lists allowed slots) |
| `template.validate` | both `template` and `document` absent, unknown ids, document with 0 layers / maximally deep groups |
| `component.list` | as `template.list` |
| `component.inspect` | unknown `id`, `version: -1` / `NaN` / huge, manifest with missing `variables`/`anchors` fields, anchors outside `[0,1]` |
| `component.place` | unknown `id`, missing parent layer, ambiguous parent name, `bounds: [NaN, 0, 0, 0]`, `bounds: [-Inf, Inf, 0, -1]`, `bounds` with NaN width/height, anchor outside 9-point set, `vars` with unknown keys (error + allowed list), `vars` values violating `maxChars`, huge `vars` object |
| `component.setVars` | missing/unknown `instance`, ambiguous instance, empty `vars`, unknown variable names, visibility var given a string, colour var given `NaN`/`Infinity` channels |
| `component.updateInstance` | missing/unknown `instance`, instance whose master vanished |
| `component.publish` | (later phase) missing `group`, unknown layers, `id` collisions |
| `layout.apply` | `root: {}` / `root: []` / missing; `columns: 0` / `-5` / `25` / `1e9`; `gap: NaN` / `-1` / `257`; `padding: [NaN,Inf,-Inf,1e18]`, padding array of wrong length; `safeArea: -1` / `NaN` / bigger than canvas; empty `children`; `children` with 10⁵ entries; `root` nested 100+ deep (recursion bound); cyclic `within` references; `grow: -1`, `percent: 400`, `aspect: 0` / `NaN` |
| `layout.fitText` | missing/ambiguous `layer`, `minSize: NaN` / `0` / negative, `maxSize: NaN` / `Inf` / `< minSize`, `lineHeight: 0` / `NaN` / negative, `maxLines: 0` / huge, `bounds` with NaN/negative/zero-extent components, empty `text` |
| `layout.measure` | missing `layer` and missing `text` (one required), `bounds` as above, giant `text` (1 MB string) — must cap, not allocate unbounded |
| `agent.begin` | no document open, `name: ""`, `name` with weird Unicode / 64 KB string (cap), `name: 42` (wrong type) — default the name rather than panic on cosmetic params |
| `agent.commit` | no document open, **no open transaction** (idempotent refusal), transaction already committed, concurrent interleaving with `agent.rollback` |
| `agent.rollback` | no document open, no open transaction, rollback twice (second is `Err`), checkpoint whose history entry vanished (undo stack trimmed) |
| `document.diff` | no document open, `from`/`to` missing / negative / huge / `NaN`-ish (`null`, string), `from > to`, unknown revisions (error with valid range), empty document, maximally deep/cyclic group nesting (seen-set), diff while a nested transaction is open |

"NaN/Inf" arrive as JSON where impossible (JSON has no NaN) — test the engine's
tolerated encodings: `null`, strings (`"NaN"`), huge floats (`1e999` parses as inf in
serde_json), and arithmetic inside the command that can *produce* NaN/inf from finite
inputs (division by zero, overflow). Guard those before use (`is_finite()`,
`checked_*`).

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
`engine-patches/scripts/apply-engine-patches.sh` (refuses on pin drift) →
`cargo check -p photocraft-engine` → the panic-hunt command above → parity
regeneration check. Any failure blocks the patch series; fix the patch, never the pin.
