# Engine command surface — audit + design for FULL agent coverage

Task ID: 12-w1-a1 · AUDIT + DESIGN DOC ONLY (no product code changed).
Goal: the AI chat agent must drive the ENTIRE EffectCraft engine "like a coding agent drives VS
Code" — from `layer.newText` to 3D cameras, puppet pins, rotoscoping and the render queue. Today
it has 13 curated tools + a 37-command allowlist. This document audits how the real surface is
built and recommends how to expose ~all of it safely.

Sources read (pinned): `editor/docs/control-protocol.md`, `agents.md`, `mcp.md`,
`scripting-parity.md`, `architecture.md` §6, `web.md`; `editor/crates/engine/src/commands/mod.rs`,
`batch.rs`, `query.rs`, `create.rs`, `comp.rs`, `anim.rs`, `key_transform.rs`, `text_edit.rs`,
`scripts.rs`, `file_more.rs`, `frontend.rs`, `stubs.rs`; `editor/apps/effectcraft-web/src/api.rs`,
`app.rs`; `packages/contracts/src/{command-registry,tools,write-tools,engine-batch}.ts`;
`packages/contracts/scripts/extract-engine-registry.mjs`;
`packages/contracts/fixtures/engine-command-ids.json`;
`packages/editor-bridge/src/bridge.ts`; `apps/web/src/lib/chat/tool-executor.ts`;
`services/gateway/src/{plan-compiler,auto-apply}.ts`; `services/gateway/src/litellm/runner.ts`.

---

## 1. How commands are defined and registered

Every action in EffectCraft — menus, shortcuts, panel buttons, viewer gestures, CLI, control
channel, MCP — is one engine command with a stable id and JSON params
(`architecture.md` §6: "The menu bar is a tree of command ids … so anything a person can do from
a menu, an agent can do too").

The registration pattern (`editor/crates/engine/src/commands/mod.rs:100–153`):

```rust
/// Metadata + implementation for one command.
pub struct CommandSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub menu: &'static [&'static str],   // e.g. ["Layer", "New"]; empty = not in menus
    pub shortcut: Option<&'static str>,
    pub alt_shortcuts: &'static [&'static str],
    pub params: &'static str,           // parameter description for agents + MCP schema
    pub enabled: Enabled,               // fn(&Session) -> Result<(), String> ("why" when disabled)
    pub run: Run,                        // fn(&mut Session, &Value) -> Result<Value>
    pub journal: bool,                   // false for pure queries
}

macro_rules! cmd {   // journal: true — mutating, undoable
    ($id:literal, $label:literal, [$($m:literal),*], $sc:expr, $params:literal, $en:expr, $run:expr) => { … };
}
macro_rules! query {  // journal: false — read-only, never batchable
    ($id:literal, $label:literal, $params:literal, $run:expr) => { … };
}
```

Each module exposes `pub fn specs() -> Vec<CommandSpec>`; e.g. `create.rs:200`:

```rust
pub fn specs() -> Vec<CommandSpec> {
    vec![cmd!("layer.create", "Create", [], None,
        "{op: editableText|shapesFromText|masksFromText|shapesFromVector, layers?}", has_layers, create)]
}
```

`command_specs()` (mod.rs:155–241) concatenates ~90 module `specs()` into one `OnceLock` table;
`find(id)` indexes it. The `params` string is a *machine-parsed doc*: `accepted_params()` and
`doc_pieces()` (mod.rs:275–366) extract the accepted top-level keys, `params_schema()` derives a
JSON Schema per command (served by `command.list {schemas:true}` and `command.describe`), and
`check_params()` **rejects unknown top-level params with the accepted-key list** (aliases
`layer↔layers`, `time↔frame`, `frameRate↔fps`; `comp`/`merge` always ok). Enablement fns
(`has_comp`, `has_layers`, `has_keys`…) give per-state "enabled / why" answers.

Frontend-only chrome (viewer zoom, panels, dialogs, quit) is registered too, via local wrapper
macros — `fe!` in `frontend.rs` (expands to `cmd!` with a `frontend()` runner that emits
`Event::Frontend`), `res!`/`fast!`/`chan!` in `view.rs`/`viewer_cmds.rs` — so the menu tree is
complete; headless sessions accept and ignore them.

Execution paths all converge on `Session::execute` (lib.rs:633) / `execute_checked` (lib.rs:659,
the agent path with param checking) / `execute_for_script` (script-issued commands can't change
script limits). `engine.batch` (batch.rs) runs `[{command, params}]` steps as ONE undo step with
`$N.key` result references, atomic rollback on failure, and its own denylist
`NOT_IN_BATCH = ["engine.batch", "file.runScript", "script.run"]`.

Transport: desktop TCP control channel (`{"method":"engine.execute","params":{command,params}}`,
`engine.commands`, `command.list`, `command.describe`, `render.frame`, `ui.*`); web build exposes
the SAME dispatcher as `window.effectcraft.request/execute` (`effectcraft-web/src/api.rs`), so
**the web editor accepts every engine command today**. MCP (`effectcraft-cli mcp`) adds
`list_commands`/`describe_command`/`execute_command`/`batch`/`run_script` on top, plus optional
`--automation-read-root/--automation-write-root` confinement that refuses file/script/UI tools.

---

## 2. Total command count

The registry is dynamic (`app.capabilities` → `command_specs().len()`, query.rs:186). Static
scan of the vendored engine at pin `9db7f3b2` (matches `editor/UPSTREAM.md`):

| Source | Count | Notes |
|---|---|---|
| `cmd!` in `commands/*.rs` (journal: true) | **580** | mutating, batchable |
| `query!` in `commands/*.rs` (journal: false) | **63** | read-only, never batchable |
| Direct `CommandSpec` literals | **3** | `engine.batch` (batch.rs:107), `contentFill.generate`, `layer.newContentAwareFill` (content_fill.rs:404/415) |
| UI wrapper macros `fe!`(42)/`res!`(5)/`fast!`(5)/`chan!`(7) | **59** | `app.*`, `playback.*`, `view.res|fastPreviews|channel.*`, panel/window chrome — incl. **`app.quit`** |
| Registered outside `commands/` | **26** | `models.rs`(10), `templates.rs`(6), `learn.rs`(5), `storage.rs`(3), `preview.rs`(2) — model install/download, template file ops, tutorials, storage manager |
| **Live registry total** | **≈ 731** | ≥ 63 read-only |

The committed fixture `packages/contracts/fixtures/engine-command-ids.json` (generated by
`scripts/extract-engine-registry.mjs`, multiline-aware, idempotent) pins exactly **580 + 63** at
pin `9db7f3b2` and deliberately scopes out the other rows (documented in the script header).
`mod.rs:260`'s "~2,000 ids" comment is stale/over-broad — the live `command.list` length is ~731.

Top-level id prefixes (macro-registered ids, 669 unique): `layer` 118, `file` 61, `view` 48,
`keys` 36, `comp` 29, `edit` 27, `track` 22, `essential` 22, `renderQueue` 20, `camera` 19,
`prop` 18, `effect` 18, `mask` 17, `time` 17, `roto` 14, `text` 13, `help` 13, `project` 12,
`footage` 12, `puppet` 10, `anim` 8, `shape` 8, `mediaBrowser` 7, `shortcuts` 7, `scriptui` 6,
`paint` 6, `path` 6, `learn` 5, `templates` 5, `face` 5, `prefs` 5, `objectMatte` 5, `markers` 5,
`material` 4, `script` 4, `render` 4, `storage` 3, `jobs` 3, `window` 3, `paths` 3, `light` 3,
`warp` 3, `playback` 2, `liquify` 2, `expr` 2, `command` 2, plus singles (`item`, `scopes`,
`contentFill`, `cache`, `motion`, `app.capabilities`, `editor.state`…). The wrapper macros add
~40 more `app.*`, 4 `playback.*`, 17 `view.res|fastPreviews|channel.*`.

Beyond commands, the surface includes: **307 effects** (`effect.list {filter?}` returns params
with id/type/default/min/max — PARITY string in query.rs:202), text animation presets
(`layer.applyTextPreset`, 8 named), built-in animation presets (`anim.applyBuiltinPreset`,
`anim.builtinPresets`), fonts (`list_fonts` MCP), and property trees addressed by path
(`transform/position`, `effects/#1/blurriness`, `@uid`).

---

## 3. The existing curated surface (what the model sees today)

`packages/contracts`:

- **13 tools** (`tools.ts` TOOL_IDS): reads `studio.get_context`, `studio.list_layers`,
  `studio.get_properties`, `studio.plan_edit`, `studio.render_preview`; writes `studio.create_composition`,
  `create_text`, `set_properties`, `add_effect`, `set_keyframes`, `apply_preset`, `undo_run`,
  `save_version` (proposal-only: they return a proposed `engine.batch`, never execute).
- **`AGENT_COMMAND_REGISTRY`** (`command-registry.ts`): **37 curated ids** — comp.new/open/close/addMarker;
  layer.newText/newSolid/newNull/newAdjustment/rename/arrange/setBlendMode/setText;
  text.insert/delete/addSelector; layer.applyTextPreset; prop.set/addKey/toggleAnimation/toggleKey/reset;
  anim.addKeyframe/applyPreset/applyBuiltinPreset; keys.set/move/easyEase;
  effect.apply/remove/reorder/toggle/reset; layer.style.add/remove/toggle; edit.undo/redo.
  Title+params transcribed verbatim from the Rust registrations (file:line pinned per entry),
  parsed by a TS mirror of the engine's grammar. Tests enforce curated ⊆ fixture (580+63).
  Deliberately NO destructive/reveal/import/render/file-system/UI-state commands;
  `META_COMMAND_IDS = [command.describe, command.list, engine.batch]`.
- **Wiring**: the gateway plan compiler is the only thing turning a plan into an
  `AgentBatch` (plan-compiler.ts; translation table in its header, e.g.
  `apply_preset` NEVER compiles to `anim.applyPreset` because it takes a filesystem `path` —
  law #5). `auto-apply.ts` allows only `AGENT_COMMAND_IDS` (fail-closed). The CLIENT executor
  (`apps/web/src/lib/chat/tool-executor.ts`) refuses the raw surface by name —
  `RAW_ENGINE_TOOL_IDS = {engine.batch, engine.execute, edit.undo, edit.redo}` → `TOOL_FORBIDDEN`,
  zero bridge calls — because a client-side batch/undo would bypass the ApplyController
  (law #6: one batch = one undo = one version). Writes resolve server-side; read tools hit the
  bridge (`project.summary`, `comp.info`, `layer.tree`, `prop.get`, `edit.history.list`,
  `renderFrame` ≤1200 px).

Coverage today: 37 of 580 mutating ids ≈ **6% of the mutating surface** (no masks, shapes,
cameras/lights/3D, parenting, mattes, time remap, tracking, roto, puppet, warp, paint, render
queue, expressions, text animators beyond presets, layer switches, time commands…).

---

## 4. Recommended design for full-surface agent access

### 4a. One generic write tool over `engine.batch` + on-demand catalog reads

A generic tool is not just feasible — **the whole substrate already exists and is battle-tested
by the engine's own MCP server**: `engine.execute {command, params}`, `command.list
{filter?, enabledOnly?, schemas?}` → `[{id,label,menu,shortcut,params,enabled,why}]`,
`command.describe {command}` → full params doc + JSON Schema + enabled/why, and `engine.batch
{steps, label, atomic}` with `$N.key` refs, atomic rollback and one undo step. The web bridge
already wraps all of it (`bridge.execute/query/batch/commands/describe`, bridge.ts:493–556).
Only the *curated policy layer* is narrow.

Recommended shape (keep the proposal→approval→apply pipeline; widen what may be PROPOSED):

1. **New read tools** (mirror MCP's proven pair; cheap, typed 1:1 over the bridge):
   - `studio.list_commands {filter?, enabledOnly?}` → the engine's `command.list` (ids + params
     docs, ~200 chars/command).
   - `studio.describe_command {command}` → `command.describe` (params doc + JSON Schema).
2. **New write tool** `studio.engine_commands {label, steps: [{command, params}]}` — the model's
   steps ARE the `engine.batch` payload. The plan compiler keeps its law-#6 role (one atomic
   batch = one undo = one version) but switches from a hand translation table to **validation
   against a machine-generated catalog**: `checkBatchCommands(batch, catalog)` (engine-batch.ts)
   + a **denylist filter** (4b). Result: coverage = the whole non-denied surface with zero
   per-command curation, and the engine itself remains the param validator (unknown keys are
   rejected with the accepted list; batch failures roll back and name the step).
3. **Catalog generation, not hand-curation**: extend
   `packages/contracts/scripts/extract-engine-registry.mjs` to also emit label+params per id
   (the parser already exists in `command-registry.ts`) into a generated
   `AGENT_COMMAND_CATALOG` with deny tags; regenerate on engine pin bump; keep tests
   (curated ⊆ catalog ⊆ live registry).
4. **How the model sees the catalog compactly** — never 731 tool definitions (context + provider
   tool-count limits) and never a 70 KB catalog in the system prompt:
   - System-prompt **digest (~2–3 KB)**: the category table from §2 (id-prefix, count, one-line
     description), the params-doc grammar rules ("`{layer?, path|prop, value}`; `?` optional;
     `|` alternatives; layers by id|name|#n; keyframe times default LAYER seconds — pass
     `timeBase:"comp"` for comp seconds"), and ~20 exemplar ids.
   - Then **discover on demand**: `studio.list_commands {filter:"puppet"}` →
     `studio.describe_command {command:"puppet.addPins"}` → use in `studio.engine_commands`.
     This is exactly how EffectCraft's MCP guides agents today
     ("Find the right command: list_commands {filter} → describe_command", agents.md cookbook).
   - Keep the existing 13 curated tools as the fast path / house style; the generic tool is the
     escape hatch — "shell access" for the coding agent.
5. **Batches compose with reads**: `$1.layer` references already let one batch create a layer,
   keyframe it and style it without round-trips; `effect.apply` returns instance paths
   (`effects/#n`) ready for `prop.set`.

### 4b. Commands that must stay BLOCKED

Deny-by-policy (server-side filter in the plan compiler; engine `NOT_IN_BATCH` already blocks
batch nesting + scripts):

- **Quit/app chrome**: `app.quit`, `app.hide*`, `app.settings`, `app.about`, `window.*`,
  `panel.*`, `view.res|fastPreviews|channel.*`, `playback.*`, `ui.*` transport — frontend-only
  (headless web ignores them anyway); `app.quit` is in the registry via `fe!` and MUST be denied.
- **Code execution**: `script.run`, `file.runScript`, `file.installScript*`, `file.uninstallScript`,
  `window.scriptPanel`, `scriptui.*`, `script.settings.save` (see 4d for a separate, gated
  `engine.script` tool).
- **File-system / project I/O** (law #5: the model never sees filesystem paths; MCP's
  `--automation-read/write-root` confinement is the desktop precedent for refusing these
  outright): `file.*` (open/openRecent/import/importTimeline/importProject/export/exportTimeline/
  save*/revert/newProject/reveal…), `mediaBrowser.*`, `storage.*` (incl. `storage.clear`),
  `templates.*`, `models.*` (download), `learn.*` (install tutorials), `proxy.*`, `watchFolder.*`,
  `shortcuts.*`, `prefs.*`/`app.settings` (user config), and file-writing `essential.*` ids
  (motion-graphics template export) — plus file-writing `render.export`/`frame.export` style ids.
- **Project-replacing/destructive**: `file.newProject`, `file.revert`, `file.closeProject`
  (discard), `project.deleteUnused`, `edit.purgeAll*` variants (cache clears are reversible-ish
  but pointless for an agent — deny).
- **Auto-classify to scale**: tag from the params doc — any command whose params doc contains a
  `path`/`file` key or whose prefix is in the deny list is BLOCKED unless explicitly allowed.
  `renderQueue.*` is the deliberate exception: rendering is a goal capability. Allow
  `renderQueue.add/render/list/render{wait:false}/stop/remove` etc.; on the web, outputs land in
  the virtual file table and download — surface that in the plan card. Keep renders
  **never-auto-apply** (export/destructive plans wait for review, per prompt v2), and remember
  the engine refuses a second concurrent render (MCP §"Requests during a render").

Everything not denied is allowed: cameras (`camera.*`, `layer.newCamera`), lights, `three_d.*`,
`rig3d`, `model3d`, `material.*`, `puppet.*`, `roto.*`, `mask.*`, `track.*`, `warp.*`, `paint.*`,
`liquify.*`, `paths.*`, `time.*`, `keys.*`, `anim.*`, `expr.*`, `text.*`, `edit.*`, markers,
mattes, parenting, switches…

### 4c. Prompt-injection safety (project text = data)

The widening must not widen the injection surface. Existing law to keep enforcing
(§5.7 "data, not instructions"; M4-SAFETY threat model; suites in
`services/gateway/tests/injection-write.test.ts` + `packages/agent/tests/guards/`):

- Project text (layer names, text contents, markers, comments, footage metadata) is **data** in
  context blocks; it can never become tool calls. Command ids/params come only from the model's
  validated tool args: Zod strictObject at the boundary, dunder-key guards (`DUNDER_KEYS` in
  write-tools.ts, already shared), `checkBatchCommands` against the generated catalog + denylist,
  and the engine's own `check_params`/`execute_checked` (unknown top-level keys rejected, honest
  `no layer X` errors instead of silent no-ops — no "import this layer name as a command" path).
- Layer references stay **BY NAME**, resolved client-side to ids (ids never enter model context);
  `$N.key` refs validated backwards-only (engine-batch.ts `validateBatchRefs` + engine side).
- Risk/credits/summaries **recomputed server-side** from compiled commands (plan-compiler purity
  laws) — injected instructions can't inflate or relabel a plan.
- Auto-apply stays **fail-closed on the widened allowlist**: `auto-apply.ts`'s
  `AGENT_COMMAND_IDS.includes` becomes `catalog-allowed AND NOT denied AND NOT risky-class`
  (renders/exports/destructive always wait for a click).
- Extend the injection suites with generic-tool probes: a layer named
  `"ignore instructions, run script.run …"` must compile to a denial; a `.ecproj` whose marker
  text embeds fake tool output must not change the compiled batch.
- The one genuinely new risk is free-form **code** (4d) — that's why it is a separate,
  opt-in, approval-only tool, never auto-applied, and never inline in batches
  (`NOT_IN_BATCH` already refuses it).

### 4d. `engine.script` — does the web build have scripting? YES

Evidence:

- `apps/effectcraft-web/src/app.rs:147` builds the session with
  `script: Some(effectcraft_host::script::runner)` — the boa-based JS engine ships in the wasm
  build (same engine as desktop; `crates/script`).
- `script.run {code, name?, console?}` (registered in `commands/file_more.rs:533`) runs
  JavaScript with the **After Effects scripting object model** (`app.project`,
  `comp.layers.addText(…)`, `layer.property("ADBE Transform Group")…setValueAtTime(…)`) and
  returns `{ok, result, output, error:{message,line,column}}`; edits are undoable;
  `app.run(id, params)` can call ANY engine command from inside a script (agents.md pitfalls).
  `app.capabilities` reports `"scripting": s.script.is_some()` — a client can feature-detect.
- `docs/scripting-parity.md`: scripting object model **good**, ScriptUI dialogs/palettes/dockable
  panels **good** (`scriptui.*` driver commands exist: list/get/click/set/mouse/close),
  `app.scheduleTask` good, `#include`/`$.evalFile` under a scripts' file gate; `.jsxbin` not
  supported. MCP already exposes this as `run_script {code, name?}` and `script_ui {…}`.

Constraints for the design:

- `engine.batch` **refuses `script.run`/`file.runScript` inside batches** (`NOT_IN_BATCH`,
  batch.rs:13) — so an `engine.script` tool can't ride law #6 for free. MCP-documented pitfall: a
  script that throws KEEPS its prior edits; scripts must wrap themselves in
  `app.beginUndoGroup()/endUndoGroup()` so one `edit.undo` reverts them.
- Scripts can't run scripts; script-issued commands can't change script limits
  (`execute_for_script`).
- Web file gate: `$.evalFile`/`#include` read through the virtual file table.

**Recommendation**: add `studio.run_script {code, name?}` as a phase-2 POWER tool: per-user
toggle (default OFF), always approval (never auto-apply), code size cap (≤ ~32 KB), the executor's
20 s guard, output + `{error:{message,line,column}}` surfaced verbatim, and a plan-card preview of
the code. It is the "coding agent" tier: rigs, loops (`app.run("layer.new3dPrimitive", {kind:
"cube", position:[x,y,z]})` in a loop), generators — capabilities the per-command tool can't
express compactly. Until then, `studio.engine_commands` covers 95% of use cases without code.

---

## 5. Events / state the client can snapshot for agent context

The engine is **pull-based** for agents: its `Event` enum (lib.rs:364 — `ProjectChanged{revision}`,
`Toast`, `OpenComp`, `OpenUrl`, `Frontend{command,params}`, `PurgeCaches`, `CopyImage`) is consumed
by the UI, not shipped over the bridge; there is no push subscription to the chat layer. Instead
the client assembles snapshots from query commands — `studio.get_context` today
(`apps/web/src/lib/chat/tool-executor.ts:267–344`):

- one `bridge.inspect()` (ui.inspect → `activeComp`, `selectedLayers`, `time`, `playing`,
  `focusedPanel`, open dialog…),
- `bridge.query("project.summary")` (items, dirty, activeComp, undo stack),
- `comp.info {comp}` (comp header + full layer list),
- `layer.tree {comp, layer, depth}` per layer,
- `prop.get {layer, path}` over the 6 default transform/text paths,
- `edit.history.list` → `recentCommands` (last 10 undo states).

All per-block degradation (a block nulls on bridge failure; user-removed blocks report
"removed by user"); flags-gated via `ContextSelection`.

Available for a widened context (all already query commands): `editor.state`, `app.capabilities`
(version, command/effect counts, export formats, `scripting: true/false`), `command.list`,
`command.describe`, `effect.list {filter}`, `jobs.list` (background jobs),
`renderQueue.list` (queue status), `layer.tree {depth}` at any depth, `prop.get` any path,
`render.frame`/`renderFrame` (PNG base64 ≤1200 px for visual checks). Design note: the engine
already bumps `Session.revision` on every change (`Event::ProjectChanged`) — exposing `revision`
in `ui.inspect` would give the context layer a cheap change token, though per-tool-call pulls
(the current model) are sufficient.

---

## 6. Suggested rollout

1. **Wave 1**: generated `AGENT_COMMAND_CATALOG` (extend the extractor; add labels + params +
   deny tags; tests). Add read tools `studio.list_commands` / `studio.describe_command`
   (typed 1:1 over the bridge; no policy risk).
2. **Wave 2**: write tool `studio.engine_commands` compiling straight to `engine.batch`
   (compiler = validate-against-catalog + denylist; keep 13 curated tools; auto-apply =
   allowlist minus risky classes; extend injection suites + golden plans with generic-tool
   cases; batch bounds stay 100 steps / 2 MB / 60 s).
3. **Wave 3**: `renderQueue.*` enablement with queue-status context (`renderQueue.list`) and
   never-auto-apply renders; plan-card output download UX on web.
4. **Wave 4 (opt-in power)**: `studio.run_script` per 4d; `scriptui.*` only if users need
   script-panel driving (MCP parity exists).

Open questions for the next decision: (a) whether `studio.engine_commands` replaces or wraps the
8 write tools in prompts (recommend: keep both, generic tool documented as escape hatch);
(b) auto-apply risk floor for analysis commands (`track.*`/`roto.*` run inline on wasm — budget
impact of `wait:true`); (c) catalog digest refresh cadence vs engine pin bumps (tie to
`editor/UPSTREAM.md` pin, as the fixture already does).
