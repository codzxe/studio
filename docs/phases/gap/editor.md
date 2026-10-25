# Editor integration gap — W-R5 (reader, 2026-10-22)

> **SUPERSEDED (W5-08, 2026-10-23):** this is a pre-landing read-wave audit
> snapshot. Waves W1–W5 have landed the product it maps — see the per-milestone
> evidence files (`docs/phases/M0.md`–`M8.md`), `docs/phases/m8-cli-spike.md`
> and the fleet `worklog.md` for current state. Every DONE/PARTIAL/MISSING
> verdict below is historical, not a statement about the tree today. Kept for
> the paper trail; do not cite it as a gap list.


Read-only survey of `editor/**` (vendored EffectCraft) and the studio serving
surface. No product code touched. Evidence paths are given inline.

## 1. Pin + licence status

- Pin (editor/UPSTREAM.md): upstream `storytold/effectcraft`, commit
  `9db7f3b21700fd821f215782ed1c82afe077880f`, version 0.13.0, pinned by
  studio Wave 0. Matches `editor/Cargo.toml` (version 0.13.0,
  license "MIT OR Apache-2.0", repository storytold/effectcraft).
- Licence files vendored and complete in `editor/`: `LICENSE-MIT`,
  `LICENSE-APACHE`, `NOTICE`, `ATTRIBUTION.md`. Surfaced in the product
  licences page (`apps/web/src/app/(marketing)/legal/licences/page.tsx`,
  component "EffectCraft"). ADR-0006 decision 10 respected.
- `editor/UPSTREAM.md` records the tree as byte-identical to the pin with no
  product patches. `editor/patches/` EXISTS and is EMPTY — consistent with the
  build/integration-only patch policy; nothing has been needed yet.
- The local reference clone `<repo-root>/effectcraft-upstream` named in
  UPSTREAM.md is NOT present on this box (informational; re-pin procedure only).

## 2. Prebuilt dist: DOES NOT EXIST (critical)

Verdict: there is NO built editor anywhere in the repo.
- `editor/target/` is absent, and `editor/.gitignore` ignores `target/`, so a
  build there is never committable as-is.
- Zero `.wasm` files exist in the repo (outside `node_modules`).
- `apps/web` has no `public/` directory; nothing at `/editor/` is servable.

What the dist would be (evidence: `editor/xtask/src/main.rs` `web()`,
lines 261-317; `editor/docs/web.md`):
- `cargo xtask web [--dev] [--serve PORT]` builds `-p effectcraft-web` for
  wasm32-unknown-unknown, runs `wasm-bindgen --target web` (CLI pinned
  exactly 0.2.129), optional `wasm-opt -O2`, copies `apps/effectcraft-web/web/*`
  (index.html, favicon.svg, manifest.webmanifest, sw.js, worker.js,
  audio-worklet.js) plus app icons into a FLAT `editor/target/web/dist/`
  containing `index.html`, `effectcraft_web.js`, `effectcraft_web_bg.wasm`
  (~58 MB uncompressed). The service worker precache list/version is injected.
- All URLs in `apps/effectcraft-web/web/index.html` are RELATIVE
  (`./effectcraft_web.js`, `effectcraft_web_bg.wasm`, `sw.js`), so the dist
  works mounted under any same-origin base path, including `/editor/`.

How it is supposed to be served today (expects the dist):
- `scripts/serve-editor.py` serves `editor/target/web/dist` on 127.0.0.1:8765
  with COOP/COEP + `application/wasm` (mirrors `cargo xtask web --serve`).
- `apps/web/next.config.ts`: sets COOP/COEP headers on `/editor/:path*`,
  `skipTrailingSlashRedirect: true` (protects the editor's relative URLs from
  the 308 `/editor/` -> `/editor`), and in dev rewrites `/editor/:path*` to
  `EDITOR_DEV_SERVER_URL`. Without the env var Next 404s `/editor/*`.

Build feasibility ON THIS BOX: impossible. Toolchain check: no `cargo`, no
`rustc`, no `wasm-bindgen` (only node and python3). Requirements per UPSTREAM.md:
Rust >= 1.95, `rustup target add wasm32-unknown-unknown`, wasm-bindgen-cli
0.2.129, optional binaryen `wasm-opt`.

Doc drift (fix in docs, not code): `next.config.ts` comments reference
`cargo xtask web --dist` (no such flag) and a "content-hashed
`/editor/<build>/assets/...`" layout. The real xtask emits a FLAT dist with no
hash segment; the immutable-cache rule for `/editor/:build*` is dead config
against the upstream layout.

Mitigation options (pick one, in order of preference):
a) Vendor a prebuilt dist committed to the repo, e.g. `apps/web/public/editor/`
   (next.config already notes "a public/editor/ directory would take
   precedence") or `editor/dist/` with a .gitignore exception. Cost: a large
   binary in git (~58 MB wasm, ~10-17 MB compressed). COOP/COEP headers already
   configured.
b) CI runs `cargo xtask web` and publishes the dist as an artifact; the deploy
   box (or Caddy, per next.config's production note) serves `/editor/*` from it.
c) Test-only stopgap already available: the deterministic fake editor
   (`packages/editor-bridge/src/fake.ts`) needs no editor bits at all.

## 3. window.effectcraft surface: upstream evidence vs bridge expectations

Wrapper: `editor/apps/effectcraft-web/web/index.html` lines 50-90 (the JS shim
installed on `window.effectcraft`), backed by wasm-bindgen exports in
`editor/apps/effectcraft-web/src/api.rs` and control-channel methods in
`editor/crates/ui-egui/src/control.rs`.

| Method | Upstream | Evidence |
|---|---|---|
| request(method, params) | YES | index.html:51 -> api.rs `request()` |
| execute(command, params) | YES | index.html:52 -> `engine.execute` |
| commands() | YES | index.html:53 -> `engine.commands` |
| inspect() | YES | index.html:54 -> `ui.inspect` (control.rs:200) |
| screenshot(params) | YES | index.html:55 -> `ui.screenshot` (control.rs:439) |
| renderFrame(params) | YES | index.html:56 -> `render.frame` with base64:true (control.rs:446) |
| files() | YES | api.rs `files()` |
| readFile(path) | YES | api.rs `read_file()` |
| addFile(fileOrUrl, name) | YES | api.rs `add_file()` + fetch wrapper index.html:59-69 |
| info() | YES | api.rs `info()` + extras index.html:70-82 |
| saveToBrowser(path) | YES | api.rs `save_to_browser()` -> `file.saveAs` |
| listStored/removeStored/flush/workerFrameCheck | YES | api.rs (browser-storage/extras) |

All 8 methods required by ADR-0006 (request, execute, inspect, renderFrame,
addFile, saveToBrowser, readFile, screenshot) EXIST upstream. The bridge
package's `FakeEditor` interface (`packages/editor-bridge/src/fake.ts:154-185`)
mirrors the identical 15-method surface; `attachFake.ts` adapts it to the
`EditorBridge` contract with zod parsing. No bridge-only expectation is missing
upstream; nothing requires an editor patch.

Read-side command surface (all upstream, no gap for the curated Studio tools):
- control-channel methods (ui-egui/src/control.rs): `engine.execute`,
  `engine.commands`, `ui.inspect`, `ui.screenshot`, `render.frame`, plus
  `ui.set/click/key/type/drag/...` for test driving.
- engine commands (crates/engine/src/commands/): `command.list`,
  `command.describe`, `app.capabilities`, `project.summary` (query.rs:213),
  `comp.info` (query.rs:214), `layer.tree` (query.rs:215), `editor.state`
  (query.rs:216), `prop.get` (prop.rs:1302), `edit.undo`/`edit.redo`
  (edit.rs:862+), `edit.history.list`/`edit.history.goto` (edit.rs:926/932),
  `engine.batch` (batch.rs).
- The MCP/automation layer (crates/automation/src/tools.rs) wraps these same
  commands (get_project -> project.summary, get_layer -> layer.tree, get_prop
  -> prop.get, undo/redo -> edit.undo/edit.redo, history -> edit.history.list,
  ui_inspect -> ui.inspect passthrough, screenshot -> ui.screenshot).

## 4. engine.batch semantics — confirmed from source

File: `editor/crates/engine/src/commands/batch.rs` (with unit test at :128).
- Request: `{steps: [{command, params?}], label? (default "Batch"),
  atomic? (default true)}` -> `{steps: n, results: [...]}`.
- `$N` references: 1-based, `$1.layer` or nested `$N.key.0.key`, substituted
  recursively through arrays/objects; non-`$` strings pass through; a reference
  to a step that did not run errors "`$N` refers to step N, but only M step(s)
  ran before"; a missing key errors with the offending path.
- Atomicity: `atomic: true` (default). A failing step restores the project,
  history and state snapshots, then `sanitize_state()` + `bump()`; the error is
  "step {i} ({id}): ...; the batch was rolled back (nothing changed)".
  `atomic: false` keeps steps 1..i applied ("steps 1-i were applied").
- One undo step: `fold()` truncates the undo journal back to the pre-batch
  project snapshot (Arc::ptr_eq) and pushes a single entry labelled with the
  batch label; `merge_key` cleared.
- Nesting guard: `engine.batch`, `file.runScript`, `script.run` are
  NOT_IN_BATCH.
- Test `batch_refs_one_undo_step_and_rollback` asserts all of the above:
  3 steps -> exactly one undo step labelled "Build"; undo empties the layers;
  a failing step rolls back and names the step; a bad `$3` ref errors.
- `fake.ts` mirrors these semantics (NOT_IN_BATCH copied, $N resolution,
  rollback, one-undo-step fold) — the fleet's contract baseline is faithful.

## 5. What M3 (editor host) still needs to serve a working editor TODAY

1. The dist (the blocker). One of the mitigations in section 2: vendored
   prebuilt dist (`apps/web/public/editor/` is the lowest-friction option on
   this box since Next serves it and next.config already anticipates it) or a
   CI-built artifact. Without it, `/editor/` 404s in dev and production has
   nothing to serve. A build on this box is impossible (no Rust toolchain).
2. iframe host page: `apps/web/src/app/(app)/w/page.tsx` is a stub
   (WorkspaceStubPage, no editor). M3 needs the workspace layout with the
   same-origin editor iframe (`/editor/?empty` per ADR-0006 and the UPSTREAM.md
   manual gate).
3. Real bridge attach: `packages/editor-bridge` ships `attachFake.ts` only;
   there is no attach implementation that talks to a live iframe's
   `window.effectcraft` (same-origin `contentWindow` access). The
   `EditorBridge` interface, zod schemas and error mapping already exist and
   are exercised against the fake.
4. Serving plumbing polish (docs): fix the `--dist`/content-hash comments in
   `next.config.ts` to match the real flat upstream dist; drop or repurpose
   the dead `/editor/:build*` immutable-cache rule.
5. Everything else is already in place: COOP/COEP headers, trailing-slash
   handling, `scripts/serve-editor.py` for a locally built dist, the fake
   editor for tests, and a fully verified upstream API contract.
