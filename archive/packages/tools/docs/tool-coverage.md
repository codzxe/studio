# Tool coverage audit — the §6 surface vs. the tree

Snapshot taken during task **W5-S** (tool contract + coverage docs). Status legend:

- **implemented** — file committed at HEAD `1182b2a` ("W5-H: layer_ops tool").
- **in-flight** — file present in the working tree, *uncommitted at snapshot time*
  (parallel Wave 5 agents were landing files while this audit ran; the fleet's
  `git add -A` sync sweeps them into the next push).
- **pending** — no file yet; the row's owning agent has not landed it.

The task's expectation is that the §6 table ends with **no pending rows once W5-R
and the remaining wave agents land**; this audit records the live state so the
delta is explicit. `brief_to_plan` is the one §6-surface name with no §6 table row
(model-orchestrated, planner wave owns it).

## The §6 table, row by row

| §6 row | Tool(s) | Status | Implementation | Engine commands underneath (as actually emitted) | Tests |
| --- | --- | --- | --- | --- | --- |
| 1 | `workspace_snapshot` | implemented | `src/tools/workspace-snapshot.ts` (W5-A) | `document.inspect` (via `ctx.engine.inspect()`), `layer.list` (via `listLayers()`), `variables.list`, `layerComp.list` (via `execute`) | `tests/workspace-snapshot.test.ts` |
| 2 | `template_list` | implemented | `src/tools/template-list.ts` (W5-B) | none directly — catalog seam `ctx.templates.list()` / `.get()` (the gateway/repo catalog fronts `template.list`); cards capped at 16, compact JSON-in-string summary | `tests/template-list.test.ts` |
| 3 | `template_inspect` | implemented | `src/tools/template-inspect.ts` (W5-B) | none directly — `ctx.templates.get(id@version)` + validated §7.2 manifest probes (bounds, rules, layerMap, canvas, palette); degrades L0→L4 to fit the 2000-char summary | `tests/template-list.test.ts` |
| 4 | `template_apply` | implemented | `src/tools/template-apply.ts` (W5-C) | `template.apply` (single command; engine-patches template_cmds) — engine reply read structurally or as message-JSON | `tests/template-apply.test.ts` |
| 5 | `template_fill` | implemented | `src/tools/template-fill.ts` (W5-D) | `template.fill` — ONE command; the parenthetical in §6 row 5 (`type.edit`, `doc.place`, `layer.fill.solidColor.set`, `edit.transform`) is what the engine's fill does internally (engine-patches `template_cmds/fill.rs`), not commands the tool emits | `tests/template-fill.test.ts` |
| 6 | `asset_search` | implemented | `src/tools/asset-search.ts` (W5-E) | none — workspace asset store seam `ctx.assets.search()` (§20 uploads, tenant-scoped); compact table of id/name/dims only | `tests/asset-tools.test.ts` |
| 6 | `asset_place` | implemented | `src/tools/asset-place.ts` (W5-E) | `doc.place {path, scale, center, smartObject:true}` → `edit.transform {scaleX%, scaleY%, dx, dy}` (cover/contain/fill fit) → `layer.smartObjects.convertToSmartObject` (best-effort; refusal = warning). §6's "masks" are intentionally NOT emitted — slot clipping rides on the template's own slot mask (W5-E decision, §7.2) | `tests/asset-tools.test.ts` |
| 7 | `image_generate` | implemented | `src/tools/image-generate.ts` (W5-F) | external provider seam (`ImageProviderLike`) → PNG validation → `doc.place` → `edit.transform` → `layer.setProps` (§10.2 rename "Photo — Generated") → `layer.smartObjects.convertToSmartObject` (best-effort); credit charge BEFORE generation (`CreditSpender`, draft 1 / final 2) | `tests/image-generate.test.ts` |
| 8 | `text_set` | implemented | `src/tools/text-set.ts` (W5-G) | create: `type.create` + `layout.fitText`; edit: `type.edit` + `type.setStyle` (align carrier); one transactional batch per mode | `tests/text-set.test.ts` |
| 9 | `layer_ops` | implemented | `src/tools/layer-ops.ts` (W5-H) | 7 ops → `layer.select`, `layer.new.group`, `layer.groupLayers`, `layer.duplicate`, `layer.setProps` (rename/visible/opacity/locked), `layer.arrange.{bringToFront,sendToBack,bringForward,sendBackward}`, `layer.align.{leftEdges,horizontalCenters,rightEdges,topEdges,verticalCenters,bottomEdges}` — ids pinned verbatim from engine-client `LAYER_COMMANDS` | `tests/layer-ops.test.ts` |
| 10 | `style_apply` | implemented | `src/tools/style-apply.ts` (W5-I) | `layer.layerStyle.{dropShadow,stroke,colorOverlay,gradientOverlay,innerShadow,outerGlow,bevelEmboss,clear}` + `layer.newAdjustmentLayer.{levels,curves,hueSaturation,brightnessContrast}` + `layer.select` (multi-target). §6 row 10 also lists `edit.fill` — **not emitted** by the current implementation (the style union carries no fill op); flag for the row's owner if a fill style is product-wanted | `tests/style-apply.test.ts` |
| 11 | `layout_apply` | implemented | `src/tools/layout-apply.ts` | `layout.apply` (engine-patches layout_cmds); node tree depth ≤ 32 / ≤ 256 nodes; missing-command façade detection → `engine_unavailable` | `tests/layout-apply.test.ts` (in-flight edits on both files) |
| 12 | `component_list` | **pending** | — (W5-K expected) | `component.list` planned | — |
| 12 | `component_place` | **pending** | — (W5-K expected) | `component.place` (+ smart-object sharing) planned; `component-set-vars.ts` already reuses its `vars` union shape | — |
| 13 | `component_set_vars` | **in-flight** | `src/tools/component-set-vars.ts` (W5-L) | `component.setVars {instance, vars}` (merge semantics) + optional `component.updateInstance` (§8.4 opt-in reapply; failure = warning); preflight via `ctx.components` (`ComponentRegistryLike`) | none yet |
| 14 | `render_preview` | **pending** | — | `doc.render` (≤ 1024 px longest edge) planned; `EngineLike.render` seam already in `types.ts` | — |
| 15 | `validate_document` | **in-flight** | `src/tools/validate-document.ts` (W5-O) | generic arm: `document.inspect` + `layer.list` in-worker, §11.1 check table (bounds, safe area, contrast 4.5:1/3:1, overflow, fonts, editability, z-order); template arm adds `template.validate` via `execute`. "Render analysis" reads inspect-row probes defensively rather than issuing `doc.render` | none yet |
| 16 | `vision_critique` | **in-flight** | `src/tools/vision-critique.ts` (W5-O) | **no engine call** (§6 model-orchestrated): consumes `previewUrl` + `layerSummary` inputs, ships them to an external vision model via `ctx.critic` (`CriticModelLike`, worker-wired per §5.3), enforces the §23.3 rubric verdict IN CODE | `tests/vision-critique.test.ts` (in-flight) |
| 17 | `variant_create` | **pending** | — | `layerComp.*`, `image.applyDataSet`, `image.variables.*` planned | — |
| 18 | `export_document` | **pending** | — | `doc.save`, `doc.render`, PSD writer planned (§14 exports) | — |

## The extra rows the audit was asked to cover

| Tool | Status | Implementation | Notes |
| --- | --- | --- | --- |
| `ask_user` (§6 note after row 18: "a client-side affordance, not an engine tool") | **in-flight** | `src/tools/ask-user.ts` (W5-R) | NO engine command, NO seam: validates question (≤ 300 chars) + 1–4 options (≤ 120 each), returns a JSON pause marker; the run manager keys off the tool name, marks the run `awaiting_user`, emits one `ask_user` SSE event, and appends the human answer as data (§5.7). One ask_user per run (§23.1 rule 10) is run-manager-enforced |
| `echo` (not §6; the §6.2 reference implementation) | implemented | `src/example/echo.ts` | never in `TOOLS`, never in production registries; included in W5-R's in-flight `buildDefaultToolRegistry()` only so dev/test contexts keep the reference exercisable (`{ includeEcho: false }` pins it out) |
| `brief_to_plan` (§6 preamble: model-orchestrated) | **pending** | — | name reserved in `TOOLS`; the planner wave owns the implementation — the only §6-surface name with no table row above |

## Registry & assembly status

- `src/registry.ts` (committed): `TOOLS` pins all 22 §6 names; `ToolRegistry` with
  allowed-list pinning, `duplicate_tool`/`invalid_tool_name` rejections, `get` →
  `unknown_tool` + allowed list, `list()`/`promptBlock()` = name + description only.
- `src/registry-defaults.ts` (**in-flight**, W5-R): `buildDefaultToolRegistry()`
  registering every shipped tool in §6 table order + `echo`; fail-fast on a
  rejected registration.
- `src/index.ts` (**in-flight edit**, W5-R): barrel now re-exports every tool file
  plus the kit/types/registry/registry-defaults — with prefixed aliases for the
  three star-export collisions (`ENGINE_PATCH_HINT`, `MAX_QUERY_CHARS`,
  `ResolvedTarget`). Closes the "index.ts exports no tools" flag that ran through
  the W5 worklog.

## Test inventory (one row per suite)

| Test file | Pins |
| --- | --- |
| `tests/kit.test.ts` | kit envelopes, caps, `ok`/`err` contract, `parseToolArgs`, `defineTool` boundary, echo usage |
| `tests/registry.test.ts` | `TOOLS` surface, register/lookup rejections, listing = name+description only |
| `tests/registry-defaults.test.ts` **[in-flight]** | default assembly registers every shipped tool; echo toggling |
| `tests/workspace-snapshot.test.ts` | row whitelist, determinism, 2000-char budget shed, 7-code error mapping |
| `tests/template-list.test.ts` | `template_list` cards + filters + compact reply AND `template_inspect` (pin parsing, §7.2 fidelity, degrade ladder) |
| `tests/template-apply.test.ts` | pin grammar, §7.4 group apply, reply readers, engine failure mapping |
| `tests/template-fill.test.ts` | §6.2 schema strictness table, unknown-slot message, fill report readers, upscale mapping |
| `tests/asset-tools.test.ts` | `asset_search` compact table + `asset_place` fit math, upscale thresholds, tenancy, slot resolution |
| `tests/image-generate.test.ts` | credit table, provider failures, PNG validation, placement + slot targets |
| `tests/text-set.test.ts` | create/edit schemas, fit overflow hint math, style-run batches, ambiguity |
| `tests/layer-ops.test.ts` | per-op command mapping (ids checked against `LAYER_COMMANDS`), 15 bad-args table, transactions |
| `tests/style-apply.test.ts` | 9-style union, colour normalization (alpha drop), adjustment param bounds, command plans |
| `tests/layout-apply.test.ts` | node tree caps, command payload, façade failure mapping (in-flight edits) |
| `tests/vision-critique.test.ts` **[in-flight]** | rubric enforcement, issue caps, verdict forcing, provider failure mapping |

No test file yet for the in-flight `ask_user`, `validate_document`,
`component_set_vars` (owners were still writing at snapshot time — their tasks
include the suites).

## Audit findings

1. **No §6 tool is implemented outside the pinned surface** — every shipped tool
   registers under a `TOOLS` name; `echo` is the only non-§6 tool and is
   opt-out-able in the default assembly.
2. **Command ids are never invented**: tool files pin ids verbatim from
   `@studio/engine-client` command registries / vendor `commands.rs`
   (layer_ops even drift-checks them in tests against `LAYER_COMMANDS`).
3. **Row 5/10 wording vs. reality**: `template_fill` emits one command
   (`template.fill`) — §6's parenthetical is engine-internal work; `style_apply`
   does not emit `edit.fill`. Both are documented above, neither is a gap in the
   surface.
4. **`workspace_snapshot`** is listed with the model-orchestrated four in §6's
   preamble, but row 1 (and the implementation) are engine-backed read-only —
   four read commands, no mutation, no idempotency key, no budget charge.
5. **Remaining pending rows** at snapshot: `component_list`, `component_place`
   (W5-K), `render_preview`, `variant_create`, `export_document`, plus
   `brief_to_plan` (planner wave). Expected to be none after the wave completes.
6. **Registry assembly** (`registry-defaults.ts`, `index.ts` barrel) was landing
   in-flight from W5-R at snapshot time — the executor will dispatch through
   `buildDefaultToolRegistry()` once committed.
