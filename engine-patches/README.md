# engine-patches — SaaS engine additions, authored upstreamable

This directory owns every Rust addition the SaaS needs inside the editor engine
(spec `docs/BUILD_PROMPT.md` §2.3). It is the **only sanctioned place** where engine
code lives in this repo.

## Upstream policy (ADR-0001)

Authoritative record: `docs/adr/0001-editor-pin.md`.

- The engine is a shallow git clone OUTSIDE this repo at
  `/home/z/my-project/vendor/photocraft`, pinned to commit
  `872748fb5b2a53e09dd4e385e31968d985c0515b`.
- **Engine changes go UPSTREAM, never as in-place vendored edits.** We never hand-edit
  files under `vendor/photocraft/` directly. New behaviour is authored here as
  standalone new modules shaped exactly like upstream PRs, then offered upstream;
  the local clone only ever receives them mechanically via
  `engine-patches/scripts/apply-engine-patches.sh` (copy + `git apply`), so the diff is
  always visible in `git -C vendor/photocraft status` and revertible with
  `git -C vendor/photocraft apply --reverse` / `checkout --`.
- The ONLY existing upstream file we touch is the command registry
  (`crates/engine/src/commands.rs` + its `mod` list in `crates/engine/src/lib.rs`),
  and only through the explicit, reviewed patch in `registration/`
  (`§2.3`: "add each as a new module with a `specs()` function … never grow shared
  files chaotically"). Everything else is a brand-new `*_cmds.rs` file.
- Patches must compile against the pinned commit only. A re-pin (deliberate, after
  upstream's own gates pass) requires refreshing the registration patch if the
  anchor lines moved — re-run `engine-patches/scripts/apply-engine-patches.sh`,
  which refuses to apply on a pin mismatch.
- No secrets, no fonts, no brand assets here (§1.5). Module code never references the
  SaaS by name — these are plain upstream features.

## Layout

One directory per module, mirroring the vendor path the file will occupy
(`crates/engine/src/<name>.rs`):

```
engine-patches/
├── README.md                     ← this file
├── registration/
│   ├── commands-registry.patch.md  ← the ONE existing-file edit, documented line by line
│   └── commands-registry.patch.txt ← unified diff (lib.rs mod lines + commands.rs v.extend lines)
├── template_cmds/                ← template_cmds.rs (Wave 3) + README (surface §7.4)
├── component_cmds/                ← component_cmds.rs (Wave 3) + README (surface §8.3)
├── layout_cmds/                   ← layout_cmds.rs (Wave 3) + README (surface §9.4)
├── agent_cmds/                    ← agent_cmds.rs (Wave 3) + README (surface §5.6)
├── scripts/
│   └── apply-engine-patches.sh   ← mechanical applier (the repo-level scripts/ dir is
│                                    orchestrator-owned, so the applier lives HERE)
└── tests/
    └── README.md                 ← panic-hunt obligations + parity regeneration
```

Wave 3 agents drop `<name>.rs` into each module directory (one module per directory,
one `specs()` function per module, `pub fn specs() -> Vec<CommandSpec>`).

## How patches apply

Two mechanisms, both run by `engine-patches/scripts/apply-engine-patches.sh`:

1. **New-file copy** — `engine-patches/<module>/<module>.rs` is `cp`-ed to
   `vendor/photocraft/crates/engine/src/<module>.rs`. New files carry no upstream risk;
   they are additive modules.
2. **Registration patch** — `git -C vendor/photocraft apply` of
   `registration/commands-registry.patch.txt` (checked first with `git apply --check`),
   which adds the four `pub mod <name>;` lines to `crates/engine/src/lib.rs` and the
   four `v.extend(crate::<name>::specs());` lines to the registry builder in
   `crates/engine/src/commands.rs`. Exact anchors and quoted context live in
   `registration/commands-registry.patch.md`.

The script refuses to run if `git -C vendor/photocraft rev-parse HEAD` does not match
the ADR-0001 pin. See `registration/commands-registry.patch.md` for what the patch
contains and how Wave 3 validates it.

## The editor's golden rules (upstream AGENTS.md, summarized)

Every module authored here must obey the upstream repo's rules — these are merge
BLOCKERS, reviewed before any Wave 3 file is considered done:

- **Never crash** (outranks feature work; §1.5 rule 4). Non-test code never panics:
  no `unwrap()`, `expect()`, `panic!`, `unreachable!`, `todo!`, `unimplemented!`.
  Return `Err` (the crate's error type) and propagate with `?`; use `ok_or(..)?`,
  `let .. else { return Err(..) }`, `unwrap_or*` only where a fallback is truly
  correct. The only exception is a provably infallible literal with
  `#[allow(clippy::expect_used)]` + `.expect("why it can't fail")`.
- **No `unsafe`.** The workspace forbids it (`unsafe_code = "forbid"`).
- **Input-derived numbers are hostile.** Use `get()` rather than `[i]` / `[a..b]` for
  any index derived from params, files or selections; slice strings only at char
  boundaries; `checked_*` / `saturating_*` for lengths, offsets, counts; guard
  division by zero and NaN/inf; cap allocations sized by input.
- **Bound recursion** with depth limits or seen-sets (documents can be deep/cyclic).
- **Everything is a command.** Each action is a `CommandSpec` in a new
  `crates/engine/src/<area>_cmds.rs` module with `id`, `label`, `menu`, `shortcut`,
  `params` doc, `enabled`, `run`, `journal` — registered via `specs()`.
- **Tests are the gate.** Every command ships a graceful-failure test
  (empty / out-of-range / wrong-type params → `Err`, not a crash) and must survive the
  `panic_hunt` fuzz (adversarial params per `tests/README.md`).
- Enforced by clippy: the crate denies
  `clippy::unwrap_used, expect_used, panic, unimplemented, todo, unreachable`.

## CI

The Rust gate runs in the dedicated job **`infra/ci-staged/engine-patches.yml`**
(staged alongside the other CI jobs; NOT part of the TS pipeline). It:

1. Clones `storytold/photocraft` at the ADR-0001 pin (exact SHA, never a branch tip).
2. Runs `engine-patches/scripts/apply-engine-patches.sh` (which verifies the pin itself
   before touching anything).
3. `cargo check -p photocraft-engine` — the patch series must compile against the pin.
4. `cargo test -p photocraft-engine --test panic_hunt -- --ignored` — no command may
   panic or hang on adversarial params (obligations: `tests/README.md`).
5. Fails loudly on any registration-patch drift (`git apply --check` mismatch means the
   pin moved or the patch rotted — fix the patch, never force it).

No `cargo` commands run on dev boxes (2 CPUs, many agents); CI owns builds.

## Wave 3 checklist (per module)

1. Author `<module>.rs` in its `engine-patches/<module>/` directory (this repo).
2. Obey the golden rules above; params validated before use, errors via
   `EngineError::BadParams { cmd, msg }` / typed variants.
3. Add the graceful-failure + adversarial cases to the panic-hunt obligations
   (`tests/README.md`).
4. Validate the registration patch still applies:
   `engine-patches/scripts/apply-engine-patches.sh --check`.
5. Never edit `vendor/photocraft/**` by hand — apply/revert only via the script.
