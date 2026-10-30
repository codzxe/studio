# Compiler extension map — widening the agent write surface (13 tools → full engine)

Task ID: 12-w2-a5 · AUDIT ONLY (no product files changed). Companion to
`research/engine-command-surface.md` (12-w1-a1, the engine-side audit: ~731 live
command ids, 580 mutating + 63 read-only pinned in the fixture, `NOT_IN_BATCH`
denylist, scripting via boa). This document maps the TS pipeline — contracts →
plan compiler → auto-apply → client apply — and answers the five build
questions: (a) the seams for N new write tools, (b) server-side validation of
arbitrary command ids, (c) `studio.run_script`, (d) asset steps in the one
atomic batch, (e) the 13/8/37 count-pin inventory.

Sources read (pinned): `packages/contracts/src/{tools,write-tools,command-registry,engine-batch,edit-plan,models,events}.ts`,
`packages/contracts/scripts/extract-engine-registry.mjs`,
`packages/contracts/fixtures/engine-command-ids.json`,
`services/gateway/src/{plan-compiler,auto-apply,plan}.ts`,
`services/gateway/src/litellm/{runner,prompt}.ts`,
`apps/web/src/lib/chat/{apply,tool-executor}.ts`,
`packages/api-client/src/chat-tools.ts`, `evals/harness/manifest.ts`,
`packages/editor-bridge/src/{bridge,types,fake}.ts` (spot),
`editor/crates/engine/src/commands/{batch,edit,file,file_more,create}.rs` (spot:
`NOT_IN_BATCH`, `edit.pasteSvg`, `script.run`, `file.import`),
`editor/apps/effectcraft-web/src/{api,files}.rs` (virtual file table).

---

## 1. The exact contract shapes today (packages/contracts/src)

### tools.ts — the 13-tool catalog
- `TOOL_IDS` (lines 30–44): 13 literal ids — 5 read (`studio.get_context`,
  `studio.list_layers`, `studio.get_properties`, `studio.plan_edit`,
  `studio.render_preview`) + 8 write (`studio.create_composition`,
  `studio.create_text`, `studio.set_properties`, `studio.add_effect`,
  `studio.set_keyframes`, `studio.apply_preset`, `studio.undo_run`,
  `studio.save_version`). `TOOL_ID_SCHEMA = z.enum(TOOL_IDS)`.
- `ToolDefinition { id: ToolId; kind: "read"|"write"; risk: PlanRisk; description;
  args: z.ZodType<unknown>; returns: "data"|"proposed-batch" }`.
- `TOOL_LIST` = 5 inline read defs + `...WRITE_TOOL_DEFS` (line 105: WRITE_TOOLS
  mapped through `studioWriteToolId`, kind "write", returns "proposed-batch" —
  **the write half auto-registers from write-tools.ts**, no per-tool edit here).
- `TOOL_CATALOG` = Record<ToolId, ToolDefinition>; `getTool/isWriteTool/isReadTool`.

### write-tools.ts — the 8 write-tool contracts
- `WRITE_TOOL_IDS` (38–47): 8 unprefixed ids; `studioWriteToolId(id) → "studio.<id>"`
  keeps the two registries in lockstep.
- Bounds constants (61–102): name ≤ 120, text ≤ 2000, property path ≤ 200,
  layer refs ≤ 50, property updates ≤ 100, keyframes ≤ 500,
  `MAX_WRITE_TOOL_ARGS_BYTES = MAX_BATCH_BYTES` (§8.5 2 MB) applied via
  `withArgsSizeBound`.
- Shared guards exported for peers: `DUNDER_KEYS`, `isDunderKey`,
  `firstDunderKeyLocation`, `hasNoDunderKeys`, `hasNoDunderSegments`,
  `isJsonSerializableValue`, `PASSTHROUGH_RECORD_SCHEMA` (raw `z.preprocess`
  dunder/JSON check — Zod record rebuild would silently drop `__proto__`).
- Per-tool args: 8 exported `*_ARGS_SCHEMA` **STRICT ZodObjects** +
  `WRITE_TOOL_ARGS_SCHEMAS` record keyed by bare id (434–443).
- `WriteToolDefinition { id; kind:"write"; risk; description; inputSchema:
  z.ZodObject; returns:"proposed-batch" }`; `WRITE_TOOLS` (463–560) — 8 defs with
  risk badges (create_composition/add_effect/apply_preset/undo_run = medium;
  create_text/set_properties/set_keyframes/save_version = low).
- `WRITE_TOOL_RESULT_SCHEMA` (575–610): every write-tool RESULT is
  `{ proposedBatch: { label ≤ 280; steps: BATCH_STEP_SCHEMA[] 1..100 }, note }`,
  2 MB-bounded, dunder-guarded — proposal-only, never an execution.

### command-registry.ts — the 37-id curated allowlist (validation source today)
- `AGENT_COMMAND_SOURCES` (237–446): 37 hand-transcribed entries
  `{ source: "file.rs:line", title, params }` — params docs VERBATIM from the
  Rust `cmd!` registrations (comp.new…layer.newText…text.*…prop.set/addKey/
  toggleAnimation/toggleKey/reset…anim.addKeyframe/applyPreset/applyBuiltinPreset
  …keys.set/move/easyEase…effect.apply/remove/reorder/toggle/reset…
  layer.style.add/remove/toggle…edit.undo/redo).
- A TS mirror of the engine's params-doc grammar (mod.rs:275–366) parses each
  doc into `CommandParamInfo[]` (alternatives optional, `name?` optional, `{}`
  = no params, parentheticals = descriptions).
- `AGENT_COMMAND_REGISTRY: CommandSchema` (frozen id → `CommandInfo {id,title,
  description?, params?}`); `AGENT_COMMAND_IDS` (sorted); `isAgentCommand`
  (own-property — dunder-safe); `AGENT_COMMAND_UNDOABLE` = Set(all 37);
  `META_COMMAND_IDS = ["command.describe","command.list","engine.batch"]`.

### engine-batch.ts — the batch wire the client executes
- Bounds: `MAX_BATCH_STEPS=100`, `MAX_BATCH_BYTES=2 MB`,
  `MAX_BATCH_TIMEOUT_MS=60_000`, `MAX_BATCH_LABEL_LENGTH=280`.
- `BATCH_STEP_SCHEMA = { command: string ≥1; params: Record<string, unknown> }`
  → `BatchStep`. **This is the compiled step shape: `step.command` is a bare
  engine command id, `step.params` an arbitrary JSON record.**
- `$N.key` refs: `REF_PATTERN = /\$(\d+)\.([A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*)/`
  (bare `$N` deliberately NOT a ref — currency safety); `collectRefs` walks the
  whole params tree; `validateBatchRefs` rejects forward/self/out-of-range.
- `AGENT_BATCH_SCHEMA = { label; atomic: z.literal(true); steps 1..100;
  timeoutMs? }` + superRefine (2 MB + backwards-only refs) → **`AgentBatch` is
  the compiled-batch wire type** (what PLAN_EVENT_SCHEMA.compiledBatch carries
  and what the client re-validates).
- `checkBatchCommands(batch, registry)` → issues `unknown_command |
  missing_required_param` — **THE pre-flight command-id/param validation hook**;
  it takes any `CommandSchema`, so a generated catalog slots straight in.

### edit-plan.ts — the plan schema
- `PLAN_INTENT_SCHEMA` (8 intents), `PLAN_RISK_SCHEMA` (low/medium/high),
  `PLAN_STEP_SCHEMA = { title; tool: string; args: unknown; batch: { label;
  steps: BATCH_STEP_SCHEMA[] 1..100 } }` (the per-step `batch` is ADVISORY — the
  compiler's translation wins), `EDIT_PLAN_SCHEMA` (steps 1..20, summary ≤ 280,
  affectedLayers ≤ 50) — **`MAX_PLAN_STEPS = 20` lives HERE** (contracts), not
  in the compiler.
- `estimateCredits = round2((1 + steps×0.5) × {low:1, medium:1.25, high:1.5})`;
  `AUTO_APPLYABLE_INTENTS = [create, edit, style, animate]`; `isAutoApplicable`.

### events.ts — the plan SSE event (the actual wire to the client)
`PLAN_EVENT_SCHEMA` carries `plan` + OPTIONAL compile enrichment:
`compiledBatch?: AGENT_BATCH_SCHEMA`, `resolutionRequests?: [{requestId,
layerName, disambiguation}]`, `risk?`, `estimatedCredits?`, `baseVersionId?`,
`autoApply?: {mode: "auto"|"propose", reason}`. All optional → additive
widening is backwards compatible by design.

### models.ts
`MODEL_IDS = [studio-fast, studio-smart, studio-vision]`; `MODEL_CATALOG` per
id: `{tier, use, creditsPer1kInput, creditsPer1kOutput, allowedPlans}`;
`PLAN_MODEL_ENTITLEMENTS` (trial=fast; paid=fast+smart; vision studio-only);
`allowedModelsForPlan`, `defaultModelForPlan`. (Irrelevant to tool widening
except that credits commit math reads MODEL_CATALOG.)

### fixtures + extractor (machine-readable surface)
- `fixtures/engine-command-ids.json`: `{ extractedAt, enginePin:
  9db7f3b2…, ids: [580 mutating], queries: [63 read-only] }` — **ids only, no
  params/labels**.
- `scripts/extract-engine-registry.mjs`: multiline-aware `cmd!`/`query!` scanner
  over `editor/crates/engine/src/commands/*.rs`, idempotent, pin-verified
  against `editor/UPSTREAM.md`. **This is the generator to extend** (it already
  parses argument lists; it currently discards the label + params strings).

---

## 2. The plan compiler (services/gateway/src/plan-compiler.ts, 1229 lines)

Flow of `compilePlan(plan, deps)` (never throws; typed issues):

0. **Pre-flight**: JSON-serializable, ≤ 8 MB internal plan cap; re-parse against
   `EDIT_PLAN_SCHEMA` (defense-in-depth) → fatal `plan_schema`/`plan_too_large`.
1. **Per step** (loop over `editPlan.steps`, 1-based position):
   - `lookupWriteTool(deps, planStep.tool)` — bare or `studio.`-prefixed id,
     own-property lookup in `deps.writeTools` (a Record of bare Zod schema OR
     `{args, risk}` WriteToolDef); missing → **fatal `unknown_tool`**
     (message: "not one of the 8 write tools" — a count-pin, see §10).
   - `tool.argsSchema.safeParse(planStep.args)` → fatal `invalid_args`
     (one §8.9 repair turn upstream).
   - `compiler.translate(position, tool.bareId, args)` — **THE per-tool
     translation switch** (case per write tool):
     - `create_composition` → `comp.new {name,width,height,frameRate,duration}`
       (durationSeconds→duration).
     - `create_text` → `layer.newText` (+ `engineColor`: [r,g,b] 0..255 arrays
       quantized to canonical #hex, F-S1); no text → fatal `empty_step`.
     - `set_properties` → cross-product `prop.set {layer, path, value}` per
       layer × property; path `"name"` → `layer.rename` (G-7).
     - `set_keyframes` → cross-product `prop.addKey {layer, path, time,
       value}` per layer × key; `interpolation` (editor state) → warn
       `uncompilable_arg`.
     - `add_effect` → single `effect.apply {effect: name, layers: [names]}`;
       effect instance `params` → warn `uncompilable_arg` (instance index is
       editor state).
     - `apply_preset` → `anim.applyBuiltinPreset {preset, layers}` — **NEVER
       `anim.applyPreset`** (it takes a filesystem `path`, law #5;
       `PRESET_PATH_LIKE` strings warn); no step layers → plan's
       affectedLayers names (D-21 selection-capture guard).
     - `undo_run` → `edit.undo {}` (+ warn if a runId was named).
     - `save_version` → **NO engine command**: sets the `saveVersion`
       annotation consumed by the apply flow; duplicates warn
       (`duplicate_save_version`). **This is the template for
       annotation-kind steps** (a step that compiles to zero commands without
       tripping the `empty_step` fatal).
     - `default:` → fatal `unknown_tool` (exhaustiveness guard).
     - Every layer NAME string passes through `addSite(param, name)` —
       placeholders, never fabricated ids.
   - `validateProposed(step, tool, planStep.batch.steps, translation.steps)` —
     the model's proposed batch is ADVISORY: warns `unknown_command`
     (registryHas), `missing_required_param` (checkBatchCommands),
     `unresolvable_ref` (validateBatchRefs), `batch_mismatch`
     (stableStringify comparison — the translation always wins).
   - `merge()` appends translation steps to the ONE compiled batch and the
     tool's risk to the risk floor.
2. **Bounds + registry gate on the COMPILED batch (fatal)**: `empty_batch`;
   `>100 → too_many_commands`; `checkBatchCommands(steps, deps.registry)` →
   `unknown_command` / `missing_required_param` fatal; `validateBatchRefs`
   fatal; batch ≤ 2 MB (`batch_too_large`).
3. **Layer-name resolution**: unique names (plan affectedLayers ∪ batch sites)
   ≤ 50 (`too_many_layer_names`); undeclared site names warn; optional
   `deps.layerResolver(name)` may substitute real ids server-side; otherwise
   `resolutionRequests: [{requestId: "lr-N", layerName, disambiguation}]` +
   `placeholders: [{step, param, layerName, requestId?|resolvedId?}]` — names
   STAY in the batch; the client rewrites them (§4).
4. **Assemble**: `AgentBatch = { label: "Agent: <summary>" (≤280), atomic: true,
   steps }`.
5. **Recompute (never the model's numbers)**:
   `risk = riskMax(recomputePlanRisk(steps, toolRiskFloor), editPlan.risk)` —
   the model's declared risk is a floor, never lowered; command floors:
   `DELETE_ISH /(?:^|\.)(delete|remove|purge)/`, `RENDER_ISH /^(render|export)\./`,
   `HISTORY_COMMANDS {edit.undo, edit.redo}` ⇒ ≥ medium. **Note the
   header comment (line 53): "high is currently unreachable via the curated
   tools — it becomes reachable when the registry widens past the eight write
   tools."**
   `estimatedCredits = estimateCredits({risk, steps: editPlan.steps})`.
6. Result `{ ok: true, batch, risk, estimatedCredits, resolutionRequests,
   placeholders, warnings, saveVersion? }` or `{ ok: false, issues }`.

`defaultCompileDeps()` = `{ registry: AGENT_COMMAND_REGISTRY, writeTools:
WRITE_TOOLS→{args, risk} }` — **the two knobs every widening must widen
together** (compiler gates compiled commands against `deps.registry`; unknown
ids are fatal at compile time). New step kinds hook in at: the `translate`
switch, `lookupWriteTool`'s deps, and (for annotation kinds) the
`saveVersion`-style state + `CompilePlanResult` additive field. §8.5/§8.6 caps
(Max 100 batch steps etc.) come from contracts and stay.

### services/gateway/src/plan.ts — NOT the risk policy
This file is the model-ENTITLEMENT seam (`resolvePlan`, subscription row →
PlanId, admin override `TOP_TIER_PLAN`, D-4 trialing gate). The §7.3 risk/verdict
policy is `auto-apply.ts` (below). No changes needed here for tool widening.

### services/gateway/src/auto-apply.ts — the verdict
`autoApplyDecision({plan, compiled, userAutoApplyEnabled})` — pure, ordered,
first-failure reason:
1. setting off → `setting-disabled`; 2. `!compiled.ok` → `compile-failed`;
3. **server-recomputed** risk === high → `risk-too-high`; 4. plan
requiresApproval → `approval-required`; 5. intent ∉ {create,edit,style,
animate} → `intent-not-auto-applyable`; 6. **every compiled step.command ∈
`REVERSIBLE_AUTO_COMMANDS`** (10 names: comp.new, prop.set, layer.rename,
text.insert, layer.newText, prop.addKey, anim.applyPreset,
anim.applyBuiltinPreset, effect.apply, layer.setBlendMode — filtered by
AGENT_COMMAND_IDS membership, fail-closed on registry drift) →
`command-not-reversible`; 7. credits ≤ 16 → `credits-above-ceiling`;
8. 1..60 compiled steps → `too-many-steps`. Verdict rides the plan SSE event as
`autoApply: {mode, reason}`; the client chat-controller `maybeAutoApply` fires
ONCE per runId at `run.completed` when mode === "auto" (engine present, no
unresolved layer requests, card idle). **Rule 6 is the wall a widened
catalog must re-express as a CLASS rule (allow-listed AND not-denied AND not
risky-class), not a 10-name Set.**

---

## 3. The client apply path (apps/web/src/lib/chat/apply.ts) — the wire

`createApplyController({bridge, autosave, api, session?, onEvent?})`;
`ApplicablePlan { runId, baseVersionId?, compiledBatch: AgentBatch,
resolutionRequests? }`. `apply(plan)`:

1. `validCompiledBatch(plan.compiledBatch)` — hand-rolled shape check (no zod
   in apps/web); `atomic: true` FORCED; `timeoutMs` preserved as metadata.
2. **F-6 client allowlist gate**: `compiled.steps.some(step => !
   isAgentCommand(step.command))` → typed `invalid-batch`, ZERO bridge
   traffic. `isAgentCommand` comes from `@studio/api-client/chat-tools`
   (re-export of contracts — the ONE runtime contracts touch apps/web is
   allowed). **A widened server catalog must widen THIS list too or every new
   command fails client-side.**
3. `resolveRequests` — ONE `bridge.query("comp.info", {})`; exact-name matches
   bind; ambiguous (`candidates`) / not-found fail BEFORE any mutation;
   resolved ids → `resolvedForWire` (posted with the apply) +
   `resolvedById` map.
4. `patchPlaceholders` — deterministic deep clone (null-prototype objects);
   whole-string `"$request:<id>"` params → the resolved numeric layer id;
   unresolved tokens → `resolution-failed`, nothing executes.
5. `engineBatchPayload(batch)` → `{ label, atomic: true, steps, timeoutMs? }`;
   `batchSha256Hex` over the EXACT payload (WebCrypto sha256).
6. **ONE `bridge.execute("engine.batch", payload)`** — law #6. Bridge passes
   the params object through `effectcraft.execute` → `engine.execute` →
   `batch.rs`, which reads `{steps, label?, atomic?}` (`timeoutMs` rides
   inert). Engine: NOT_IN_BATCH guard per step, `$N.key` substitution,
   atomic rollback, all steps fold into ONE undo entry labeled with the batch
   label.
7. `autosave.saveNow("agent-apply")` (D-6) → NEW immutable version →
   `api.runs.applyRun(runId, {batchSha256, versionId, idempotencyKey,
   resolvedLayers?})` — 409 conflict / LEASE_HELD / 402 insufficient-credits
   typed outcomes; `retrySave` re-runs 5+6 only; `undo` =
   `bridge.execute("edit.undo")` + `{undone: label}` F-L4 label verification →
   `api.runs.undoRun`. `reapply` gated on `baseVersionId`.

The client tool executor (`tool-executor.ts`) is the OTHER side:
`RAW_ENGINE_TOOL_IDS {engine.batch, engine.execute, edit.undo, edit.redo}` →
`TOOL_FORBIDDEN`, zero bridge calls (law #6); write tools → `TOOL_FORBIDDEN`
(server resolves them; the runs route 400s client tool.results for registered
server tools); `isClientTool` (the 4 bridge-read tools) executes under a 20 s
guard. `studio.plan_edit` is the runner's structured-output call. **New READ
tools (e.g. `studio.list_commands`, `studio.describe_command`) add entries to
`CLIENT_TOOL_IDS` + the `runReadTool` switch + `api-client` lists; new WRITE
tools need NOTHING here (server-side resolution stands).**

---

## 4. Where command-id VALIDATION lives (the catalog question)

- **Server**: `AGENT_COMMAND_REGISTRY` (hand-transcribed 37) — the only catalog
  with params today. The compiler's `deps.registry` and `checkBatchCommands`
  validate compiled ids/required params against it; `auto-apply.ts` derives its
  reversible subset from `AGENT_COMMAND_IDS`.
- **Client**: `isAgentCommand` (same registry via api-client) in apply.ts F-6.
- **Engine (backstop)**: `command_specs()` live table (~731), `check_params`
  rejects unknown top-level keys, `NOT_IN_BATCH = ["engine.batch",
  "file.runScript", "script.run"]` (batch.rs:13) rejects batch nesting/scripts
  inside batches.
- **Machine-readable**: ONLY `fixtures/engine-command-ids.json` (580+63 bare
  ids, pin-tagged, generated by `scripts/extract-engine-registry.mjs`).
  **No full catalog artifact (label+params+schemas) exists yet**; the live
  `command.list {schemas:true}` / `command.describe` are runtime queries over
  the bridge (packages/editor-bridge `bridge.commands()/describe()`), which
  the gateway cannot reach (engine is wasm in the browser). No extractor under
  editor/xtask; no catalog JSON under apps/web/public.

---

## 5. (a) The exact seams for adding N new write tools

Ordered checklist (every "N-tools" seam in one pass):

1. **contracts/src/write-tools.ts**: add ids to `WRITE_TOOL_IDS`; add
   `*_ARGS_SCHEMA` (STRICT z.strictObject + dunder guards + `withArgsSizeBound`);
   register in `WRITE_TOOL_ARGS_SCHEMAS`; add `WriteToolDefinition` to
   `WRITE_TOOLS` (risk badge, model-facing description that names the
   PROPOSED-batch contract); update the "eight" header comments.
2. **contracts/src/command-registry.ts**: add the engine command ids the
   translation emits to `AGENT_COMMAND_SOURCES` (verbatim title + params doc +
   file:line provenance) — `curated ⊆ fixture` tests enforce honesty. (If the
   generic catalog lands (§6), this step becomes "the id must be
   catalog-allowed" instead.)
3. **contracts/src/tools.ts**: NOTHING for write tools (WRITE_TOOL_DEFS derives
   from WRITE_TOOLS); update header/comment counts only.
4. **gateway/src/plan-compiler.ts**: a `case` per new tool in `Compiler.translate`
   (emit BatchSteps + `addSite` for layer-name params; follow the
   `save_version` case for annotation kinds); `lookupWriteTool` needs nothing
   (deps-driven); risk floors flow from the WRITE_TOOLS badge automatically
   (`toolRiskFloor`); update "the 8 write tools" comments/fatal message.
5. **gateway/src/auto-apply.ts**: decide per emitted command — add to
   `REVERSIBLE_AUTO_COMMAND_NAMES` (if additive/in-place) or rely on rule 6
   proposing. Update the pin tests that freeze the name list.
6. **gateway/src/litellm/runner.ts**: `RUNNER_WRITE_TOOLS` derives
   automatically; add `WRITE_TOOL_INTENTS[...]` (fallback "edit"); optional
   `writeToolSummary`/`writeToolAffectedLayers` cases (fallbacks exist);
   `mergedCarrierPlan`'s undo_run exclusion list only if the new tool is
   history-flavored.
7. **gateway/src/litellm/prompt.ts**: SYSTEM_PROMPT's "Write tools (8): …"
   enumeration is the model-facing list and is test-pinned — update in
   lockstep with RUNNER_TOOLS.
8. **apps/web**: apply path untouched (F-6 reads isAgentCommand); plan card /
   edit-cards / quick-actions render from plan data (generic); if the tool has
   client-state args (like add_effect params) keep them out of the translation
   (warn pattern) or add card affordances.
9. **evals/harness/manifest.ts**: `WRITE_TOOL_ID_SET` derives from
   WRITE_TOOL_IDS — automatic; comment updates only.
10. **Tests/goldens/e2e**: contracts tools/write-tools/barrel/command-registry
    tests (counts + order); gateway litellm-runner "registers exactly 13"
    (`.toBe(13)`), chat-loop, injection (CURATED_TOOL_WIRE_IDS), injection-write
    (43 fixtures), apply-flow (13-tool pin + compiled-batch golden), golden-plans
    / golden-prompts (tool-name fixtures), auto-apply matrix; web
    apply-failures/injection mirrors; e2e m5-agent-edits + m5-mock-create mock
    journeys (tool names in the fake model script); `pnpm build` regenerates
    the committed `apps/web/api/gateway.mjs` artifact.

Risk floor for new tools = the WRITE_TOOLS badge (compiler takes
riskMax(recomputePlanRisk, toolRiskFloor, plan.risk)); credits recompute is
generic (plan-step count). MAX_PLAN_STEPS=20 (plans) and 100 (batch) caps
already accommodate new tools without change.

---

## 6. (b) Validating arbitrary engine command ids server-side — options

The generic write tool `studio.engine_commands {label, steps: [{command,
params}]}` makes the MODEL choose command ids; the server must validate them
against a machine-generated catalog before they compile into the batch.

| Option | How | Pros | Cons |
|---|---|---|---|
| **A. Generated catalog as CODE** (extend extract-engine-registry.mjs → emit a `catalog.ts` with `AGENT_COMMAND_CATALOG: Record<id, {title, params, deny tags}>`) | build-time generation, `as const` typing | literal types, compile-time tests, no runtime parse | ~580 entries × label+params doc ≈ 150–250 KB of TS source → bundled verbatim into gateway AND (via api-client's isAgentCommand re-export) the WEB client bundle; churn-y diffs |
| **B. Generated catalog as JSON ARTIFACT + thin typed accessor** (extend the SAME extractor to also emit `fixtures/engine-command-catalog.json` {id, title, params, batchable, denied, denyReason}; contracts exposes a lazy-parsed `CommandSchema` + `ALLOWED_COMMAND_IDS`) | generation identical to today's fixture (idempotent, pin-tagged) | JSON import = data, reviewed as a diffable artifact; params parsed LAZILY by the EXISTING grammar mirror in command-registry.ts (parse-on-demand = no upfront parse cost); keeps `curated ⊆ catalog ⊆ fixture` testable | still bundled wherever imported (same bytes as A) unless split by tier |
| **C. Denylist regex ONLY** (no catalog: allow any id matching an allow-regex minus prefix denylist) | zero artifact | smallest bundle | UNSAFE alone: cannot see params (law #5 needs params-doc `path`/`file` detection), cannot verify the id EXISTS (typos surface only at engine execute time = failed batch), prefix denylists are brittle against ~731 ids incl. wrapper-macro chrome (`app.quit`!), and F-6's client gate has nothing to check |

**RECOMMENDATION: Option B, SPLIT IN TWO TIERS.**
- **Tier 1 (gateway-only)**: the full generated catalog JSON (id + title +
  params doc + journal flag + deny tag + deny reason), produced by the
  existing `extract-engine-registry.mjs` (extend: emit label + the params
  string it already isolates, plus deny classification from §4b of
  engine-command-surface.md — `app.*`/`window.*`/`panel.*`/`ui.*`/
  `playback.*`/`view.res|fastPreviews|channel.*` chrome, `file.*`/
  `mediaBrowser.*`/`storage.*`/`templates.*`/`models.*`/`learn.*`/
  `shortcuts.*`/`prefs.*` filesystem/user-config, `script*` code-exec, and
  params-doc-contains-`path|file|dir|folder` ⇒ denied; `renderQueue.*` the
  deliberate render exception). The plan compiler's `deps.registry` becomes
  `catalogToSchema(catalog)` (reuse `checkBatchCommands` UNCHANGED — it takes
  any CommandSchema); the compiler additionally runs `isDeniedCatalog(id)`
  → fatal `unknown_command`-class issue with the deny reason.
- **Tier 2 (client)**: generate an ids-ONLY allowlist array
  (`ALLOWED_COMMAND_IDS` — non-denied, batchable, sorted; ~500 ids × ~15
  bytes ≈ **8–10 KB** as a plain frozen array) exported through
  `@studio/api-client/chat-tools` for apply.ts's F-6 gate. **Bundle-size
  reasoning: the only place the catalog could leak into the client bundle is
  the api-client re-export path (apps/web cannot runtime-import contracts
  directly); shipping the full params catalog there would add ~200 KB minified
  to the browser bundle for zero client value — the client gate only needs
  membership.** The gateway (Vercel function bundle, api/gateway.mjs) absorbs
  the full catalog freely; ~250 KB JSON import parses in single-digit ms at
  cold start and can be lazy-imported.
- Keep the 37 curated ids as the fast path (unchanged `AGENT_COMMAND_REGISTRY`
  ⊂ catalog; tests: curated ⊆ catalog-allowed, catalog ids ⊆ fixture at pin,
  every denied id has a reason string). Regex deny rules REMAIN but as a
  classification pass AT GENERATION TIME (baked into the artifact), never as
  the runtime validator.

---

## 7. (c) How `studio.run_script` should flow

**Can it ride the atomic batch? NO.** `batch.rs:13`:
`NOT_IN_BATCH = ["engine.batch", "file.runScript", "script.run"]` — the engine
hard-refuses `script.run` inside `engine.batch` (a batch step naming it fails
the whole batch). Also scripts can't run scripts (`file.runScript` guard) and
script-issued commands can't change script limits (`execute_for_script`).

`script.run {code, name?, console?}` (file_more.rs:1024–1031) is a real `cmd!`
(journal: true) — the boa JS engine ships in the wasm web build
(`app.capabilities.scripting` reports it; MCP parity exists). Edits ARE
undoable, BUT the documented pitfall: a script that throws keeps its prior
edits — scripts must wrap themselves in `app.beginUndoGroup()/endUndoGroup()`
to fold into ONE undo step.

**Recommended flow — immediate-execute, approval-only, OUTSIDE the batch
machinery, but wrapped in the same ledger discipline:**
1. New tool `studio.run_script {code ≤ ~32 KB, name?}` — write-kind, risk
   HIGH by badge, never in `REVERSIBLE_AUTO_COMMANDS`, never auto-applied
   (auto-apply rules 3/6 both stop it), per-user opt-in toggle (default OFF).
2. Execution at APPROVAL time (the plan card's explicit Apply/Run click), NOT
   inside `engine.batch`: the client runs
   `bridge.execute("script.run", {code, name})` — the executor's
   `RAW_ENGINE_TOOL_IDS` refusal stays (it refuses it as a MODEL tool; the
   ApplyController path is the sanctioned executor).
3. One script = one undo: the gateway MANDATES the beginUndoGroup wrapper
   (plan-compiler-style translation injects it into the code string or refuses
   code without it), the engine folds the run into one undo entry, the client
   verifies `{undone: label}` exactly like batch apply (F-L4 pattern).
4. Output/`error {message, line, column}` surfaced verbatim in the card;
   `saveNow("agent-apply")` + a run-report afterwards so one script = one
   version (law #6 spirit preserved: one gesture = one undo = one version even
   though the mechanism is a single command, not a batch).
5. It stays deny-tagged in the catalog (never reachable via
   `studio.engine_commands`), because `NOT_IN_BATCH` already enforces it — the
   generic tool would only ever produce a failed batch.

So: **batch-refused (engine-enforced), immediate-execute on approval, undoable
via its own journal entry + undo group.** Phase-2 power tool per the 12-w1-a1
§4d recommendation.

---

## 8. (d) Asset steps riding the same batch (law #6 intact)

**SVG → vector asset: YES, fully batchable — the engine already has the
path-free command.** `edit.pasteSvg {svg: SVG markup, name?, comp?} → {layer,
skipped}` (edit.rs:552–580, registered edit.rs:895–901 as a `cmd!`, journal:
true) takes the SVG INLINE — no filesystem path anywhere, so it does NOT hit
the §4b file-system deny (which keys on `file.*` ids and params-doc
`path|file` keys). It IS in the 580-id fixture (verified). Bounds: batch 2 MB
cap curates the SVG size (engine's own ceiling is 64 MB). Later steps can
`$N.layer`-reference the created layer (it returns `{layer, skipped}`). New
curated tool shape: `studio.create_vector {name?, svg}` → one compiled step
`edit.pasteSvg` (+ `comp.open`/`layer.arrange` as needed) — rides the ONE
atomic batch, one undo, one version. Risk: additive ⇒ medium floor (badge),
auto-applyable if added to the reversible set (it isn't delete/render-ish).

**Generated audio file: batchable ONLY via the virtual-file-table placeholder
pattern.** Engine import is path-based (`file.import {paths: [string], …}`,
file.rs:735+ — `paths` are filesystem paths, so `file.import` stays DENIED for
the generic surface per law #5). BUT the web build's virtual file table gives
a sanctioned, path-free seam: `effectcraft.addFile(name, bytes)` (api.rs
`add_file`) puts bytes into the in-memory table AND imports them, returning
the table path; the editor-bridge already exposes
`bridge.addFile(blob|string, name?) → Promise<tablePath>` (+ an `addAsset`
helper) and `readFile`. Two viable designs:
- **Recommended (rides the batch):** a new curated tool
  `studio.import_generated_asset {name, kind: audio|image|vector, …}` compiles
  to `file.import {paths: ["$asset:1"], addToComp: true}` — a NEW placeholder
  KIND (`"$asset:<id>"`, exactly the `$request:` precedent) that the apply
  controller resolves AFTER calling `bridge.addFile(bytes)` and BEFORE
  `engine.execute("engine.batch", …)`. The model NEVER sees a real path (the
  placeholder is substituted client-side; the table path is engine-internal).
  The bytes themselves never cross the model boundary as engine params —
  they're either generated client/server-side and referenced by an asset id,
  or uploaded through the existing `/v1/assets` (M2) flow whose signed URL the
  apply step fetches. `file.import` remains deny-tagged in the generic
  catalog; ONLY this curated translation may emit it, with a placeholder-only
  `paths` value enforced at compile time (a literal path string in the model's
  args = fatal).
- Alternative (annotation pattern): compile to a `saveVersion`-style
  annotation consumed by the apply flow around the batch — simpler but breaks
  the one-atomic-batch guarantee (import would happen outside
  `engine.batch`), so NOT recommended.

Note `layer.create {op: shapesFromVector, …}` converts an EXISTING vector
footage layer to shapes (create.rs) — different capability, already
catalog-eligible.

---

## 9. (e) Count-pin inventory — everything that breaks when 13/8/37 moves

Grouped; **bold = hard behavioral pins** (tests/logic that FAIL on widening),
plain = comments/docs that drift.

**packages/contracts**
- src/tools.ts:30–44 **TOOL_IDS literal**; :7–8 "~12 curated tools… lists
  exactly 13" doc note; :14 "eight write-tool contracts"; :100 "eight write
  tools" comment.
- src/write-tools.ts:38–47 **WRITE_TOOL_IDS literal**; :1/:37/:462 "eight"
  headers.
- src/command-registry.ts:29 "37 ids" comment; :12 fixture-count comment
  (580/63); **AGENT_COMMAND_SOURCES content itself**.
- tests/tools.test.ts:114 **"exactly the 13 spec tools in spec order"**;
  tests/write-tools.test.ts:120 **"registers the 8 write tools with the SAME
  schemas"**; tests/barrel.test.ts (export surface);
  tests/command-registry.test.ts **(curated ⊆ fixture; 37-entry pins)**.

**services/gateway**
- src/plan-compiler.ts:53 "widens past the eight write tools"; :90/:964
  **fatal message "not one of the 8 write tools"** (user/model-visible string);
  :169 comment.
- src/auto-apply.ts:96–119 **REVERSIBLE_AUTO_COMMAND_NAMES (10 ids) +
  AGENT_COMMAND_IDS membership filter**.
- src/litellm/runner.ts:187–206 **RUNNER_READ_TOOLS/RUNNER_WRITE_TOOLS/
  RUNNER_TOOLS derivation** (auto-derives — safe; but :202 comment "5 read + 8
  write = 13"); :262 "complete for all 13 tools" comment; :374–383
  **WRITE_TOOL_INTENTS map** (fallback "edit" exists); :401–449/459–502
  writeToolSummary/writeToolAffectedLayers switches (defaults exist).
- src/litellm/prompt.ts:49–56 **SYSTEM_PROMPT enumerates every read tool and
  "Write tools (8): studio.…" verbatim** (test-pinned by
  litellm-runner.test.ts:1342); planInstruction:123 example tool names.
- src/routes/runs.ts:190 "the 8 write tools" comment.
- tests/litellm-runner.test.ts:1201/:1222 **`.toBe(13)` + set-size pin**,
  :1342/:1345 **prompt-truth pin "8 write tools"**; tests/chat-loop.test.ts
  :115/:767 **13-tool wire pin**; tests/injection.test.ts:10/:13/:260–282
  **CURATED_TOOL_WIRE_IDS + "EXACTLY the 13 curated tools"**, :316/:339/:342
  begging-outside-the-13 cases; tests/injection-write.test.ts:4/:68/:260/:950
  (8-write-tools corpus framing + allowlist prose); tests/apply-flow.test.ts
  :25/:158/:1399–1416 **"exactly 13 tools on the provider wire" safety pin**;
  tests/golden-prompts.test.ts:365 "one of the 8 curated write tools";
  tests/golden-plans.ts:111 comment; tests/plan-compiler.test.ts:4/:1326
  "the 8 write tools"; tests/auto-apply.test.ts **(reversible-name freeze)**.

**apps/web**
- src/lib/chat/apply.ts:90 **`isAgentCommand` F-6 gate** (widens only if the
  api-client export widens); :123 **`$request:` placeholder token**.
- src/lib/chat/tool-executor.ts:15 "the 8 write tools SERVER-SIDE" comment;
  :111–116 **RAW_ENGINE_TOOL_IDS** (must stay + gain script.run refusal);
  :230–247 **runReadTool switch over the 4 client tools**.
- src/lib/editor-session/read-only.ts:26/:76 comments (classification lists).
- src/lib/chat/__tests__/injection-corpus.ts (tool-id mirrors);
  __tests__/apply-failures.test.ts, __tests__/injection-write.test.tsx
  (mirrored allowlist pins).
- **apps/web/api/gateway.mjs** — the committed BUILT bundle artifact: regenerates
  via `pnpm build` on any contracts/gateway/prompt change (repo precedent).
- e2e/m5-agent-edits.spec.ts:63–64/:433–435 **studio.create_composition /
  studio.create_text pinned in the mock model journey**; e2e/m5-mock-create.spec.ts
  (mock journey tool calls); e2e/chat.spec.ts (mock tools).

**evals**
- evals/harness/manifest.ts:44–53 **TOOL_ID_SET (13) / WRITE_TOOL_ID_SET (8) /
  READ_TOOL_ID_SET (5)** (derived — safe) + "All 13 tool ids" comment;
  evals/README.md tool-count prose.

**docs**
- docs/phases/M5.md:12–13 ("8 write tools… 13 tools on the provider wire",
  "37-command"); docs/phases/M5-SAFETY.md:100 ("8 write tools… 8 mirrored
  tools"); docs/phases/M4-SEAMS.md + M5-SEAMS.md (seam tables);
  docs/BUILD_PLAN.md:3 status line ("8 write tools… 37-command proven
  registry"); PRODUCT_ARCHITECTURE.md §8.4 table ("~12 curated tools", 13
  rows) + §8.6/§8.7 tool enumerations. (worklog.md is historical record — do
  not rewrite.)

Anything reading `TOOL_IDS/WRITE_TOOL_IDS/AGENT_COMMAND_IDS` programmatically
is safe-by-construction (the counts that break are literals and prose);
anything enumerating the NAMES (prompt, tests, e2e mock journeys, docs) is a
manual edit.

---

## 10. Rollout order (synthesis with 12-w1-a1 §6)

1. **Wave 1**: extend the extractor → catalog JSON artifact + `ALLOWED_COMMAND_IDS`
   tier-2 array (§6); tests curated ⊆ catalog ⊆ fixture; read tools
   `studio.list_commands`/`studio.describe_command` (api-client lists +
   tool-executor switch + prompt).
2. **Wave 2**: `studio.engine_commands` generic write tool — compiler gains the
   catalog registry + deny gate; auto-apply rule 6 becomes class-based
   (catalog-allowed ∧ not-denied ∧ not risky-class); injection suites gain
   generic-tool probes; flip the count pins.
3. **Wave 3**: `studio.create_vector` (edit.pasteSvg) and
   `studio.import_generated_asset` ($asset placeholder + bridge.addFile).
4. **Wave 4**: `studio.run_script` power tool per §7 (opt-in, approval-only,
   undo-group-mandated).
