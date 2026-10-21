# upstream-pr-guide.md — turning the patch series into upstream PRs

`engine-patches/` exists to go **upstream** (spec §2.3, §16.1; ADR-0001): the four
modules are plain editor features — agent-facing command families with empty `menu:
&[]`, no SaaS names, no brand assets, no secrets — and the local pinned clone only
ever receives them mechanically via `engine-patches/scripts/apply-engine-patches.sh`.
This guide is the recipe for offering them to the editor repo as reviewable PRs.

## The unit of review: one PR per module

Four PRs, one per module directory, each self-contained (own command family, own
tests, own README-worthy docs). Suggested stacking order — each PR only *looks up*
earlier ones by command id at run time, so nothing hard-depends on the others, but
this order lands the primitives first:

| # | PR | Files (this repo → upstream) | Registers |
|---|---|---|---|
| 1 | `agent_cmds` — agent transactions + revision diff | `agent_cmds/agent_cmds.rs` → `crates/engine/src/agent_cmds.rs`; `agent_cmds/document_diff.rs` → `crates/engine/src/agent_cmds/document_diff.rs` | `agent.begin`, `agent.commit`, `agent.rollback`, `document.diff` |
| 2 | `layout_cmds` — constraints layout | `layout_cmds/layout_apply.rs`, `fit_text.rs`, `fit_specs.rs` → `crates/engine/src/layout_cmds/…` (parent `layout_cmds.rs` declares `pub mod fit_specs;` etc. and merges the `specs()`s) | `layout.apply`, `layout.fitText`, `layout.measure` |
| 3 | `component_cmds` — variable-driven components | `component_cmds/component_cmds.rs`, `component_manifest.rs` → `crates/engine/src/component_cmds.rs` + `component_cmds/component_manifest.rs` | `component.list/inspect/place/setVars/updateInstance/publish` |
| 4 | `template_cmds` — template catalog + slot filling | `template_cmds/template_cmds.rs`, `manifest.rs`, `fill.rs`, `validate.rs` → `crates/engine/src/template_cmds.rs` + `template_cmds/{manifest,fill,validate}.rs` | `template.list/inspect/apply/fill/validate` |

Registration lines travel **with their PR**: each PR adds its own two upstream lines —
the `pub mod <name>;` in `crates/engine/src/lib.rs` (alphabetical slot) and the
`v.extend(crate::<name>::specs());` at the end of the registry builder in
`crates/engine/src/commands.rs` (before the REL-3 `test_panic_command()` comment).
That is the ONLY existing-file edit any PR makes (§2.3: "never grow shared files
chaotically"). In this repo the same lines live concatenated in
`registration/commands-registry.patch.txt` with the anchors documented in
`registration/commands-registry.patch.md` — a reviewer can diff the two to confirm
nothing else moved.

Suggested PR narrative (per module): the problem (LLM/scripted callers need intent-level
primitives, not pixel-forcing), the command table (spec §7.4 / §8.3 / §9.4 / §5.6 —
copy the tables, drop the SaaS framing), what engine machinery is reused rather than
re-implemented, and the tests: graceful-failure + adversarial table per command.

## The golden rules — a merge BLOCKER checklist (per file, per PR)

From the upstream AGENTS.md and spec §1.5 rule 4. Check every box before opening a PR;
a reviewer will check them again.

- [ ] **Never crash.** Non-test code never panics: no `unwrap()`, `expect()`, `panic!`,
  `unreachable!`, `todo!`, `unimplemented!`. Return `Err` and propagate with `?`; use
  `ok_or(..)?` / `let .. else { return Err(..) }` / `unwrap_or*` only where a fallback
  is truly correct. The only exception: a provably infallible literal with
  `#[allow(clippy::expect_used)]` + `.expect("why it can't fail")`. Lock poisoning is
  handled, never cascaded: `lock().unwrap_or_else(PoisonError::into_inner)`.
- [ ] **No `unsafe`** — the workspace forbids it (`unsafe_code = "forbid"`).
- [ ] **Input-derived numbers are hostile.** `get()` rather than `[i]` / `[a..b]` for
  any index derived from params, files or selections; slice strings only at char
  boundaries; `checked_*` / `saturating_*` for lengths, offsets, counts; guard division
  by zero and NaN/inf (`is_finite()` before use); cap allocations sized by input.
- [ ] **Bound recursion.** Depth limits and/or seen-sets on every document/manifest
  walk (documents can be deep/cyclic; `layout.apply`'s tree caps: depth 64, 4096 nodes,
  512 children; `document.diff` carries the seen-set).
- [ ] **Everything is a command.** Each action is a `CommandSpec` (id, label, menu,
  shortcut, params doc, enabled, run, journal) in the module's `specs()` — queries
  `journal: false`, mutations journal.
- [ ] **Tests are the gate.** Every command ships a graceful-failure test (empty /
  out-of-range / wrong-type params → `Err`, not a crash) plus its adversarial
  panic-hunt rows; new crash fixes come with a regression test that panicked before.
- [ ] Enforced upstream by clippy: the crate denies `clippy::unwrap_used,
  expect_used, panic, unimplemented, todo, unreachable` — non-test code must be clean.

## The gates, in order (run in the patched clone, never on a dev box)

No `cargo` runs on this box (2 CPUs, many agents); CI owns builds —
`infra/ci-staged/engine-patches.yml` runs exactly this sequence on a pin-exact clone.
Run the same commands in a patched upstream checkout before opening each PR:

```sh
# 0. the pin — the script refuses to touch anything on a pin mismatch
engine-patches/scripts/apply-engine-patches.sh          # copy + git apply
engine-patches/scripts/apply-engine-patches.sh --check  # pin + git apply --check only

# 1. the patch series must compile against the pinned commit
cargo check -p photocraft-engine

# 2. the module's own tests (graceful-failure + semantics)
cargo test -p photocraft-engine

# 3. no command may panic or hang on adversarial params (opt-in, slow)
cargo test -p photocraft-engine --test panic_hunt -- --ignored

# 4. clippy with the crate's denials (unwrap_used, expect_used, panic, …)
cargo clippy -p photocraft-engine --all-targets

# 5. command registry parity — adding commands regenerates the checklist
cargo xtask parity
```

Rules of engagement for the gates:

- **`panic_hunt` is the gate for "never crash"**: the obligations table lives in
  `engine-patches/tests/README.md` — each of the 18 commands has its adversarial rows
  there; the PR must keep them current and green. A panic anywhere in a `run` (or
  anything it calls), on *any* params, blocks the merge.
- **Parity regeneration belongs to the upstream PR**, not this repo: commit the
  regenerated `docs/parity-checklist.md` in the PR (spec §2.3). All four modules are
  agent-facing (`menu: &[]`), so menu coverage numbers don't move — but the
  regeneration must be done and green; upstream CI checks it.
- **Registration drift is loud**: if `git apply --check` fails on a pristine pin
  clone, the patch rotted (the pin moved or upstream shifted the anchors) — update
  the patch text AND `commands-registry.patch.md` together. Never hand-edit
  `vendor/photocraft/**` to make it fit, never force it.

## ADR-0001 pin policy (the ground rules for this dance)

Authoritative record: `studio/docs/adr/0001-editor-pin.md`.

1. The engine is a shallow git clone **outside** this repo
   (`/home/z/my-project/vendor/photocraft`), pinned to
   `872748fb5b2a53e09dd4e385e31968d985c0515b`. Pinned clones only — never ad-hoc
   folder snapshots (§16.1).
2. Engine changes go **upstream, never as in-place vendored edits**. New behaviour is
   authored here as standalone modules shaped like upstream PRs; the local clone only
   receives them mechanically (copy + `git apply`) via
   `engine-patches/scripts/apply-engine-patches.sh`, so the diff is always visible in
   `git -C vendor/photocraft status` and revertible with
   `git -C vendor/photocraft apply --reverse` / `checkout --`.
3. Patches must compile against the pinned commit **only**. A re-pin is deliberate:
   only after upstream's own gates (tests, clippy, parity, scorecard) pass at the new
   commit, and it updates the ADR + `ATTRIBUTION.md` in the same change. A moved pin
   may shift the registration anchors — re-run the applier, which refuses on pin
   mismatch, and refresh the patch if the anchors moved.
4. The ONLY upstream file any of this touches is the command registry
   (`crates/engine/src/commands.rs` + the `mod` list in `crates/engine/src/lib.rs`),
   and only through the reviewed patch in `registration/`. Everything else is a
   brand-new `*_cmds.rs` file (plus its module subdirectory files).
5. Never edit `vendor/photocraft/**` by hand — this doc, the modules and the applier
   are the only sanctioned writes on our side. If an upstream PR is merged, the
   corresponding patch lines come out of the series in the same change (the module
   copy becomes a no-op once upstream carries the file).

## Open-the-PR checklist (per module)

1. Module compiles clean, module tests green, clippy clean (denials above), panic-hunt
   rows green, `cargo xtask parity` regenerated and committed in the PR.
2. The two registry lines are the only existing-file diff; context matches the pin's
   anchors (`commands-registry.patch.md` documents them line by line).
3. No SaaS/product names, no secrets, no fonts, no brand assets; doc strings cite spec
   sections only where the reasoning matters (the upstream PR narrative cites none —
   it stands on its own problem statement).
4. `command.list` in the patched clone lists every new id with the intended label and
   params doc; `docs/commands.md` (this directory) is the caller-facing reference —
   carry its per-command tables into the PR description.
5. Panic-hunt obligations updated (`engine-patches/tests/README.md`) — same change,
   never a follow-up.
