# commands.md — the 18 new engine commands (reference)

Every command in the four Wave-3 modules, one reference for callers, reviewers and the
upstream PRs. Spec tables: §5.6 (`agent.*`, `document.diff`), §7.4 (`template.*`),
§8.3 (`component.*`), §9.4 (`layout.*`); the module surface is also stated in each
`engine-patches/<module>/README.md`. Tone and wire format follow the vendor's
`docs/control-protocol.md`: commands run through
`engine.execute {"command": id, "params": {…}}`, are listed by `engine.commands` /
`command.list` (label, menu `[]`, params doc, enabled), and journaling follows the
engine's rules (queries never journal; a mutating run journals).

**Abbreviation used in every example:** the request shows the `params` object of
`engine.execute` (so `template.list {"tags":["social"]}` means
`{"id":1,"method":"engine.execute","params":{"command":"template.list","params":{"tags":["social"]}}}`),
and the reply shows the reply's `result` (`{"id":1,"ok":true,"result":…}`) or, on
failure, the reply's `error` string verbatim (`{"id":1,"ok":false,"error":"…"}`).

**Error model.** Failures are `EngineError` values, never panics (§1.5 rule 4). On the
wire they stringify exactly as the engine's `Display` impls do (verified at the pin):

| This doc's code | EngineError | Wire string |
|---|---|---|
| `bad_params` | `BadParams { cmd, msg }` | `invalid parameters for `<cmd>`: <msg>` — the msg names the offending param and the allowed shape |
| `no_document` | `NoDocument` | `no active document` |
| `no_layer` | `UnknownLayer { id, known }` | `no such layer 14; have 1, 2, 7` — name ambiguity is an error with the candidate ids listed (§6.1) |
| `disabled` | `Disabled(cmd, reason)` | `command `<cmd>` is not available right now: <reason>` — `agent.*` and `component.publish` put their own snake_case token (`transaction_not_open`, `not yet available`) at the head of the reason |
| module codes (e.g. `unknown_template`, `unknown_version`, `transaction_*`, `revision_out_of_range`) | `Other(msg)` | the message verbatim; where a module guarantees a stable head token, the code column names it — match on that prefix |

Warning objects inside `Ok` replies are `{ "code", … , "message" }` — soft issues
never abort a batch.

**Status at HEAD** (this file documents contracts; the code owns the details):

| Command | Owning file (this repo) | Upstream path | Status |
|---|---|---|---|
| `template.list` / `.inspect` / `.apply` | `template_cmds/template_cmds.rs`, `template_cmds/manifest.rs` | `crates/engine/src/template_cmds.rs` (+ `template_cmds/manifest.rs`) | implemented (W3-A) |
| `template.fill` | `template_cmds/fill.rs` | `crates/engine/src/template_cmds/fill.rs` | implemented (W3-B) |
| `template.validate` | `template_cmds/validate.rs` | `crates/engine/src/template_cmds/validate.rs` | contract pinned (§7.4 + panic-hunt table); file in flight (W3-B) |
| `component.list` / `.inspect` / `.place` / `.setVars` / `.updateInstance` / `.publish` | `component_cmds/component_cmds.rs`, `component_cmds/component_manifest.rs` | `crates/engine/src/component_cmds.rs` (+ `component_cmds/component_manifest.rs`) | implemented (W3-C) |
| `layout.apply` | `layout_cmds/layout_apply.rs` | `crates/engine/src/layout_cmds/layout_apply.rs` | implemented (W3-D) |
| `layout.fitText` / `layout.measure` | `layout_cmds/fit_text.rs`, `layout_cmds/fit_specs.rs` | `crates/engine/src/layout_cmds/{fit_text,fit_specs}.rs` | implemented (W3-E) |
| `agent.begin` / `.commit` / `.rollback` | `agent_cmds/agent_cmds.rs` | `crates/engine/src/agent_cmds.rs` | implemented (W3-F) |
| `document.diff` | `agent_cmds/document_diff.rs` | `crates/engine/src/agent_cmds/document_diff.rs` | contract pinned (§5.6 + panic-hunt table); file in flight (W3-G) |

Registration: each module's `specs()` is wired by
`registration/commands-registry.patch.txt` (the single existing-file edit, §2.3). All
18 ids are agent-facing: `menu: &[]`, no shortcut, `enabled` = `always` (catalog
queries) or `has_doc` (everything touching a document).

---

## `template.*` — spec §7.4 · module `template_cmds` (W3-A/W3-B)

The catalog is a directory named by `PHOTOCRAFT_TEMPLATES_DIR`: one `<name>.json`
manifest (§7.2) with its `<name>.pcraft` document beside it; id and version come from
the manifest's content, never the file name. Every reply pins what it used as
`id@version`, so the command log always says which version ran. Caps: 256 templates,
4 MiB per manifest, 32 query tags; a broken manifest is skipped with its reason
remembered (like installed profiles), never hides the rest, and explains itself when
asked for by id.

### `template.list` — List Templates
Query · journal: no · enabled: always.

| Param | Type | Default | Notes |
|---|---|---|---|
| `tags` | `[string]` | — | non-empty strings, ≤ 32; a template matches when it carries **every** tag (case-insensitive) |
| `query` | `string` | — | case-insensitive substring over id, name and description |

Result `{ templates: [{ id: string, name: string, version: number, tags: [string], canvas: { width, height }, slots: [string] }] }` — every version of every id, sorted by (id, version).

| Code | When | Hint |
|---|---|---|
| `bad_params` | `tags` not an array of non-empty strings, empty `tags: []`, > 32 tags, `query` not a string or empty | the message names the param and the allowed shape |
| `no_templates_dir` | `PHOTOCRAFT_TEMPLATES_DIR` unset or empty | "set PHOTOCRAFT_TEMPLATES_DIR to the folder that holds the templates (each is a JSON manifest with its .pcraft document beside it)" |

```json
→ {"tags": ["social"]}
← {"templates": [{"id": "instagram-post", "name": "Instagram Post — Promo", "version": 3,
      "tags": ["social", "promo", "square"], "canvas": {"width": 1080, "height": 1080},
      "slots": ["photo", "headline", "subhead", "badge", "logo"]}]}
→ {"tags": []}
← error: "invalid parameters for `template.list`: pass at least one tag in `tags`, or leave it out to list every template"
```

Relies on: `templates_dir()` + `scan()` over the manifest parser (`manifest.rs`), with
`MAX_TEMPLATES`/`MAX_MANIFEST_BYTES` caps and a skip-and-remember list for broken files.
Owned by: `engine-patches/template_cmds/template_cmds.rs` (helpers reused by `fill.rs`).

### `template.inspect` — Inspect Template
Query · journal: no · enabled: always.

| Param | Type | Default | Notes |
|---|---|---|---|
| `id` | `string` | required | a template id, or `id@version` to pin one |
| `version` | `number` | newest | whole number ≥ 1 (≤ 2^53); overrides the pin |

Result `{ id: "id@version", manifest: object (§7.2), document: { name, width, height, layers }, slotLayers: { slot: { layer, kind, optional } }, missing: [string], warnings: [string] }` — `slotLayers` maps each slot to the id in the template document; `missing` lists slots whose layer the document does not carry; `warnings` carries canvas mismatch (`"the manifest's canvas is 1080×1080 but the document is 64×48"`) and `rules.mustLayers` violations.

| Code | When | Hint |
|---|---|---|
| `bad_params` | `id` missing/empty, `version` not a whole number ≥ 1 | the message names the param |
| `no_templates_dir` | as `template.list` | as above |
| `unknown_template` | no such id | "no template `x` in <dir>; have a@1, b@2, …" — candidates attached |
| `unknown_version` | id exists, version does not | "no version 9 of template `x`; have @2, @3" |
| `broken_template` | the id names a manifest that failed to parse or lost its `.pcraft` | the remembered skip reason, e.g. "<file>: the manifest is unreadable or larger than 4194304 bytes" |

```json
→ {"id": "instagram-post@3"}
← {"id": "instagram-post@3", "manifest": {"id": "instagram-post", "version": 3, "…": "§7.2 manifest"},
      "document": {"name": "Instagram Post", "width": 1080, "height": 1080, "layers": 6},
      "slotLayers": {"photo": {"layer": 5, "kind": "image", "optional": false}, "headline": {"layer": 2, "kind": "text", "optional": false}},
      "missing": [], "warnings": []}
→ {"id": "instagram-post", "version": 9}
← error: "no version 9 of template `instagram-post`; have @3"
```

Relies on: `resolve()` (scan + version choice + skip-reason recall) and
`file_cmds::import` to read the `.pcraft`, then `slot_ids()` name resolution.
Owned by: `engine-patches/template_cmds/template_cmds.rs`.

### `template.apply` — Apply Template
Mutating · journal: yes · enabled: always (works with no document open).

| Param | Type | Default | Notes |
|---|---|---|---|
| `id` | `string` | required | template id or `id@version` pin |
| `version` | `number` | newest | overrides the pin |
| `name` | `string` | manifest name | the new group's, layer's or document's name; blank ignored |
| `asGroup` | `boolean` | `false` | with a document open, wrap the copy's layers in one group |

Result `{ document_revision: number, group_id: number|null, slots: { slot: layerId }, missing: [string], warnings: [string] }`. No document open: the copy becomes a new untitled document (it never holds the template's path, so a later save cannot overwrite the template). With one open: the copy's layers land above the active layer, converted between documents exactly as a layer copy is (colour mode, bit depth), as one undoable step either way.

| Code | When | Hint |
|---|---|---|
| `bad_params` | missing `id`, `asGroup` not a boolean, bad `version` | message names the param |
| `no_templates_dir` / `unknown_template` / `unknown_version` / `broken_template` | as `template.inspect` | as above |
| `empty_template` | the template document has no layers | "<file>: the template document has no layers" |
| `template_not_layered` | the template or the open document is not a layered document | "<file>: the template document is a `Bitmap` document, whose layers cannot be copied" |
| `group_depth_exceeded` | the copy nests deeper than the engine group limit | "the template nests deeper than N groups" |

```json
→ {"id": "instagram-post", "asGroup": true, "name": "Spring promo"}
← {"document_revision": 12, "group_id": 7,
      "slots": {"photo": 8, "headline": 9, "subhead": 10, "badge": 11, "logo": 12},
      "missing": [], "warnings": ["the manifest's canvas is 1080×1080 but the document is 1024×1024"]}
→ {"id": "nope"}
← error: "no template `nope` in <templates dir>; have instagram-post@2, instagram-post@3, …"
```

Relies on: `file_cmds::import` + `layer_copy_cmds::adapt_copies` (cross-document copy)
+ `fresh_copies` id re-assignment + `layer_multi_cmds::check_group_depth`/`reselect`,
committed through `Session::edit` ("Apply Template", one history step).
Owned by: `engine-patches/template_cmds/template_cmds.rs`.

### `template.fill` — Fill Template Slots
Mutating · journal: yes (one coalesced step, "Fill Template") · enabled: a document is open **and** a template is applied to it (`template.apply` first).

| Param | Type | Default | Notes |
|---|---|---|---|
| `slots` | `object` | required | `{ slotName: value }`; ≤ 128 entries; slot names must exist in the applied manifest; every required slot must be present |

Slot values by kind (§7.3): **text** — a string (trimmed at a user-visible boundary past `maxChars`, never silently); **image** — `{"path": str}` (placed via `file.placeEmbedded`, capability roots apply) or `{"data": base64}` (no filesystem read); **color** — `"#rrggbb"`/`"#rrggbbaa"`; **visibility** — boolean; **component** — the `vars` object for `component.place`.

Result `{ applied: [string], warnings: [{ code, slot, message }], errors: [], template: "id@version" }`. `errors` is always empty in an `Ok` reply (hard failures are `Err`, the engine's convention; the field exists for §7.4 shape parity). The whole fill is one batch: any hard error restores the pre-fill document, history, selection and revision — all-or-nothing.

| Code | When | Hint |
|---|---|---|
| `bad_params` | `slots` not an object, > 128 entries, unknown slot names, missing required slots | "unknown slot(s): `subheadline`; this template's slots are: photo, headline, subhead…" / "missing required slot(s): headline (optional slots: badge, logo)" — exactly what is needed, allowed list attached |
| `no_template_applied` | no template applied to the active document | "run template.apply first: …" |
| `fill_aborted` | a compiled step failed mid-batch | "template.fill aborted, the document is unchanged: <cause>" — the snapshot restore already ran |
| `no_document` / `no_layer` / `bad_params` | propagated from the compiled commands (`type.edit`, `type.setStyle`, `file.placeEmbedded`, `layer.fill.solidColor.set`, `layer.setProps`, `component.place`) | each names its slot and param |

Soft issues land in `warnings`, never abort: `text_trimmed` (maxChars cut), `image_upscaled` (> 125%; past 200% is a hard error, §7.3), `asset_below_min_pixels` (§11.1), `optional_layer_missing` (an unfilled optional's layer is absent — nothing to hide), `text_overflow` (relayed from `layout.fitText` when that command is registered).

```json
→ {"slots": {"headline": "Spring drop — 20% off", "photo": {"data": "iVBORw0K…"}, "bg": "#F4E7D3"}}
← {"applied": ["bg", "photo", "headline"], "warnings": [{"code": "image_upscaled", "slot": "photo",
      "message": "slot `photo`: the image is placed at 160% (beyond 125%); consider a larger asset"}],
      "errors": [], "template": "instagram-post@3"}
→ {"slots": {"subheadline": "Spring drop"}}
← error: "invalid parameters for `template.fill`: unknown slot(s): subheadline; this template's slots are: photo, headline, subhead, badge, logo"
```

Relies on: internal `Session::execute` dispatch of existing commands (never a parallel
implementation), `extra_cmds::step_key` coalescing for the single undo step, a
pre-fill snapshot/restore for atomicity, and an id-lookup of `layout.fitText` for
pixel fitting (no hard dependency).
Owned by: `engine-patches/template_cmds/fill.rs` (spec §7.3/§7.4).

### `template.validate` — Validate a Filled Template
Query · journal: no · enabled: always. **Contract pinned by §7.4 and the panic-hunt
obligations (`../tests/README.md`); the implementation lands in `validate.rs` (W3-B).**

| Param | Type | Default | Notes |
|---|---|---|---|
| `template` | `string` | — | id or `id@version` to validate against |
| `document` | `number` | active | document index to check; with neither param: the active document's applied template |

Result `{ ok: boolean, issues: [{ level, code, layer, message, fix }] }` — `level` is `error`/`warning`; `code` is a snake_case check id; `fix` is the actionable next step. The rules checked come from the manifest's `rules` block (§7.2): `safe_area` (content inside the safe area), `min_contrast`, `must_layers` (required layers present), `max_text_layers`, `palette` (colours on-palette).

| Code | When | Hint |
|---|---|---|
| `bad_params` | both `template` and `document` absent with no applied template | message states what to pass |
| `no_templates_dir` / `unknown_template` / `unknown_version` | as `template.inspect` | as above |

```json
→ {"template": "instagram-post@3"}
← {"ok": false, "issues": [{"level": "error", "code": "min_contrast", "layer": "Subhead",
      "message": "Subhead (#F4E7D3 on #F4E7D3) is 1.2:1, below the template's 4.5:1 rule",
      "fix": "set the subhead colour to #6B5748"}]}
→ {}
← error: "invalid parameters for `template.validate`: nothing to validate: pass `template`, `document`, or run template.apply first"
```

Relies on: the shared `manifest.rs` rules types and the document walk (a pure check
run; no mutation, `journal: false`).
Owned by: `engine-patches/template_cmds/validate.rs` (upstream:
`crates/engine/src/template_cmds/validate.rs`).

---

## `component.*` — spec §8.3 · module `component_cmds` (W3-C)

Components are named, versioned, variable-driven layer groups, built on existing
primitives (§8.1): smart-object sharing for pixels, `image.variables.*` + data sets
for per-instance values, `layerComp.*` for alternative states. The library root is
`PHOTOCRAFT_COMPONENTS_DIR` (default `components`). Every manifest carries
`license: workspace | public` (§8.4). Placing never mutates the master; layer ids in
`component.inspect` are the **master's** — an instance copy gets fresh ids.

### `component.list` — List Components
Query · journal: no · enabled: always.

| Param | Type | Default | Notes |
|---|---|---|---|
| `tags` | `[string]` | — | a component matches when it has every tag |
| `query` | `string` | — | substring of the id or name |

Result `{ components: [{ id, name, version, tags, defaultSize, license, variables, comps }], problems: [{ id, error }] }`. A broken component does not fail the list: it is a `problems` row with its reason (an unreadable root is a problem row too: "the components root `…` cannot be read; set PHOTOCRAFT_COMPONENTS_DIR").

| Code | When | Hint |
|---|---|---|
| `bad_params` | `tags`/`query` malformed | message names the param |

```json
→ {"tags": ["badge"]}
← {"components": [{"id": "offer-badge", "name": "Offer Badge", "version": 2, "tags": ["badge", "promo"],
      "defaultSize": {"width": 180, "height": 180}, "license": "workspace",
      "variables": {"label": {"kind": "text", "default": "SALE", "maxChars": 12}}, "comps": ["default", "light", "dark"]}],
      "problems": []}
→ {"tags": "badge"}
← error: "invalid parameters for `component.list`: `tags` must be an array of non-empty strings"
```

Relies on: `components_root()` scan + `component_manifest.rs` parsing, with broken
entries reported, not hidden.
Owned by: `engine-patches/component_cmds/component_cmds.rs`.

### `component.inspect` — Inspect Component
Query · journal: no · enabled: always.

| Param | Type | Default | Notes |
|---|---|---|---|
| `id` | `string` | required | component id |
| `version` | `number` | current | the version to look at |

Result `{ manifest: object (§8.2), version: number, master: { size: {width, height}, layers, variables } }` — master layer ids, not instance ids.

| Code | When | Hint |
|---|---|---|
| `bad_params` | missing `id`, bad `version` | message names the param |
| `unknown_component` | no such id | "unknown component `x`" |
| `broken_manifest` | the manifest is present but invalid | "component `x` has an invalid manifest: …" |

```json
→ {"id": "offer-badge"}
← {"manifest": {"id": "offer-badge", "version": 2, "…": "§8.2 manifest"}, "version": 2,
      "master": {"size": {"width": 180, "height": 180}, "layers": [{"name": "Ribbon", "role": "ribbon"}],
      "variables": {"label": {"kind": "text", "default": "SALE", "maxChars": 12}}}}
→ {"id": "star-ratin"}
← error: "invalid parameters for `component.inspect`: unknown component `star-ratin`"
```

Relies on: `load_manifest` + master `.pcraft` import through the same file machinery
as template inspection.
Owned by: `engine-patches/component_cmds/component_cmds.rs`.

### `component.place` — Place Component
Mutating · journal: yes · enabled: a document is open.

| Param | Type | Default | Notes |
|---|---|---|---|
| `id` | `string` | required | component id |
| `version` | `number` | current | version to place |
| `parent` | layerRef | active layer's stack position | a group to place into (id or name; ambiguity = `Err` + candidates) |
| `bounds` | `[x, y, w, h]` | design box at the anchor | finite numbers; ≤ the 64 MP placement ceiling |
| `anchor` | `string` \| `[x,y]` | centre | a manifest-declared anchor name, or `[0..1, 0..1]` fractions |
| `vars` | `object` | manifest defaults | unknown names refused with the allowed list; kinds and `maxChars` enforced (§8.4) |

Result `{ instance: layerId, component, version, bounds: [x,y,w,h], anchor, vars, warnings }` — the instance is a group with its state recorded on it; the master is never touched.

| Code | When | Hint |
|---|---|---|
| `bad_params` | malformed `bounds`/`anchor`/`vars`, `vars` over the per-call cap | "`bounds` must be [x, y, w, h]" / "`bounds` exceeds the 64 MP placement ceiling (spec §2.3)" / "at most N variables can be set at once" |
| `unknown_component` | no such id | as `component.inspect` |
| `unknown_variable` | a `vars` key is not in the manifest | "unknown variable `nope`; allowed variables: label, bg, textColor, showRibbon" (§8.4) |
| `no_document` / `no_layer` | no document; `parent` missing or ambiguous | candidates listed |
| `degenerate_placement` | the computed transform collapses | "the placement transform collapses the component" |

```json
→ {"id": "offer-badge", "anchor": "topRight", "vars": {"label": "20% OFF"}}
← {"instance": 14, "component": "offer-badge", "version": 2, "bounds": [900, 72, 180, 180],
      "anchor": "topRight", "vars": {"label": "20% OFF", "bg": "#D96C3B", "textColor": "#FFF7EE", "showRibbon": false},
      "warnings": []}
→ {"id": "offer-badge", "vars": {"labl": "20% OFF"}}
← error: "invalid parameters for `component.place`: unknown variable `labl`; allowed variables: label, bg, textColor, showRibbon"
```

Relies on: master import + fresh-id group copy (as Duplicate Layer), the 9-point /
fraction anchor `Placement::map` (validated, clamped), and `image.variables.define` +
`image.applyDataSet` for per-instance values.
Owned by: `engine-patches/component_cmds/component_cmds.rs` (manifest:
`component_manifest.rs`).

### `component.setVars` — Set Component Variables
Mutating · journal: yes · enabled: a document is open.

| Param | Type | Default | Notes |
|---|---|---|---|
| `instance` | layerRef | required | the instance group (id or name); ambiguity = `Err` + candidates |
| `vars` | `object` | required | at least one; schema-checked against the manifest (kinds, `maxChars`) |

Result `{ instance: layerId, vars, warnings }` — the merged per-instance state after the change. Text and visibility apply through the instance's data set; colour variables recolour the layers they are bound to (solid fills, shape fills, type colours — gradient/pattern fills and pixel layers are refused with a warning, never clobbered).

| Code | When | Hint |
|---|---|---|
| `bad_params` | `vars` missing/empty/not an object, unknown names, kind violations | allowed list attached (§8.4) |
| `unknown_instance` | `instance` is no placed component | "layer 14 is not a component instance" / candidates on name clashes |
| `no_document` / `no_layer` | as ever | candidates listed |

```json
→ {"instance": 14, "vars": {"label": "SPRING", "showRibbon": true}}
← {"instance": 14, "vars": {"label": "SPRING", "bg": "#D96C3B", "textColor": "#FFF7EE", "showRibbon": true},
      "warnings": []}
→ {"instance": "Badge", "vars": {}}
← error: "invalid parameters for `component.setVars`: `vars` is empty; set at least one variable"
```

Relies on: the instance record kept on the group + variable rebinding through
`image.variables.*` / data sets; recolouring walks the recorded layer bindings.
Owned by: `engine-patches/component_cmds/component_cmds.rs`.

### `component.updateInstance` — Update Component Instance
Mutating · journal: yes · enabled: a document is open.

| Param | Type | Default | Notes |
|---|---|---|---|
| `instance` | layerRef | required | the instance group |

Result `{ instance, component, from, to, updated, userChanges, warnings, vars }` — pulls the latest version while keeping the outer placement and the instance's variables. Edits outside the declared variables are **reported, never silently discarded** (§8.4): `userChanges` lists them. Already current: `updated: false` with empty `userChanges`.

| Code | When | Hint |
|---|---|---|
| `unknown_instance` | `instance` is no placed component | as `component.setVars` |
| `master_gone` | the component or the placed version vanished from the library | message names the component and version |
| `no_document` / `no_layer` / `bad_params` | as ever | candidates listed |

```json
→ {"instance": 14}
← {"instance": 14, "component": "offer-badge", "from": 2, "to": 3, "updated": true,
      "userChanges": [{"layer": "Ribbon", "change": "moved outside the declared variables"}],
      "warnings": ["variable `ribbonText` is dropped: the new version removed it"],
      "vars": {"label": "SPRING", "bg": "#D96C3B"}}
→ {"instance": 999}
← error: "no such layer 999; have 1, 2, 4, 7, 14"
```

Relies on: a diff of the instance against the placed version of the same component
(the baseline), master re-import, fresh-id re-copy, variable/data-set rebinding, and
`Session::edit` as one undoable step ("Update Component \"…\"").
Owned by: `engine-patches/component_cmds/component_cmds.rs`.

### `component.publish` — Publish Component (later phase)
Refuses with a typed not-yet-available error (§8.3 marks publishing a later phase) ·
journal: no · enabled: a document is open.

| Param | Type | Default | Notes |
|---|---|---|---|
| `group` | layerRef | — | validated when the command exists |
| `id` | `string` | — | new component id |
| `version` | `number` | — | new version |

| Code | When | Hint |
|---|---|---|
| `disabled` | always, until the phase lands | "not yet available — publishing lands in a later phase (spec §8.3). Planned semantics: validate the group, write a NEW <id>/component.json + <id>@N.pcraft into the components root, never mutating an existing component or its master (§8.4)" |

```json
→ {"group": "Hero badge"}
← error: "command `component.publish` is not available right now: not yet available — publishing lands in a later phase (spec §8.3). Planned semantics: validate the group, write a NEW <id>/component.json + <id>@N.pcraft into the components root, never mutating an existing component or its master (§8.4)"
→ {}
← error: "command `component.publish` is not available right now: not yet available — publishing lands in a later phase (spec §8.3). Planned semantics: …"
```

Relies on: nothing yet, by design — a typed refusal instead of half-publishing or a
fake success shape.
Owned by: `engine-patches/component_cmds/component_cmds.rs`.

---

## `layout.*` — spec §9.4 · module `layout_cmds` (W3-D/W3-E)

Constraints, not coordinates: the caller supplies intent (stacks, rows, grids,
anchors, fit modes, safe areas); the module solves geometry. Two hard rules (§9.5):
**transactional** (any invalid child ⇒ nothing moves — all parse/resolve/solve work
happens before the single `Session::edit`) and **deterministic** (same input + same
revision ⇒ byte-identical output). Numeric limits validated before any math:
grid columns 1–24, gaps 0–256 px, padding/safe-area sides 0–2048 px, tree depth ≤ 64,
≤ 4096 nodes, ≤ 512 children per container, every dimension ≤ 1,048,576 px, and
`is_finite()` on every float. All output is clamped to the canvas and safe area;
`layout.apply` never produces out-of-bounds layers. Alignment is logical
(`start`/`end`), never bare `left`/`right` (§9.5 RTL/CJK), unless a template needs
physical sides.

### `layout.apply` — Apply Layout
Mutating · journal: yes (one step, "Apply Layout") · enabled: a document is open.

| Param | Type | Default | Notes |
|---|---|---|---|
| `root` | node object | required | the §9.2 tree; node types `stack, row, grid, absolute, center, spacer, text, image, component, divider`; sizing keys `width, height, grow, hug, percent, aspect, minWidth, maxWidth, minHeight, maxHeight`; unknown keys are `Err` with the allowed list |
| `options.coordinateSpace` | `"document" \| "parent"` | `"document"` | where `x`/`y` are measured from |
| `options.safeArea` | `number` | — | px inset clamped into range |

Result `{ moved: [{ layer, from: [x,y,w,h], to: [x,y,w,h] }], warnings: [string] }` — whole-pixel placements; layers already in place are skipped; degenerate targets are left untouched with a warning.

| Code | When | Hint |
|---|---|---|
| `bad_params` | `root` missing/not an object, unknown node keys, `columns` outside 1–24, `gap` outside 0–256, `padding` outside 0–2048 or wrong length, `safeArea` negative/oversized, NaN/inf in any number, `aspect` ≤ 0, `grow` negative/absurd | the message names the key and the allowed range ("`columns` must be between 1 and 24") |
| `bad_params` (structure) | tree deeper than 64, > 4096 nodes, > 512 children, cyclic `within` references | recursion is bounded; the message names the cap |
| `no_document` / `no_layer` | no document; `layer`/`within` refs missing or ambiguous | candidates listed |
| `bad_params` (empty content) | a target layer has no content bounds | "layer 12 has no content; it cannot be moved" |

```json
→ {"root": {"type": "stack", "gap": 24, "padding": [72, 72, 72, 72], "align": "start",
      "children": [{"type": "text", "layer": "Headline", "grow": 1},
                   {"type": "row", "gap": 16, "align": "center",
                    "children": [{"type": "component", "layer": "Badge"}, {"type": "text", "layer": "Subhead"}]}]},
      "options": {"safeArea": 48}}
← {"moved": [{"layer": 3, "from": [72, 64, 936, 96], "to": [72, 120, 936, 804]},
             {"layer": 7, "from": [80, 200, 180, 180], "to": [72, 948, 180, 180]}],
      "warnings": []}
→ {"root": {"type": "grid", "columns": 0, "children": []}}
← error: "invalid parameters for `layout.apply`: `columns` = 0 is outside 1–24 (§9.5)"
```

Relies on: the pure solver (parse → resolve → solve over injected `bounds`/`resolve`/
`TextMeasurer` seams), then `layer_multi_cmds::move_layers` +
`transform_cmds::transform_layer`/`refresh_text` inside one `Session::edit`.
Owned by: `engine-patches/layout_cmds/layout_apply.rs` (spec §9.1–§9.2, §9.5).

### `layout.fitText` — Fit Text to Box
Mutating (the fit is applied back; one `type.edit` step) · journal: yes · enabled: a document is open.

| Param | Type | Default | Notes |
|---|---|---|---|
| `layer` | id or name | active type layer | the type layer to fit |
| `bounds` | `[x, y, w, h]` | required | the fit box, document px; each side 1..1,000,000, finite; x/y ≤ 1e9 |
| `minSize` | `pt` | 12 | §11.1's body floor |
| `maxSize` | `pt` | the layer's current size | the "requested size" (§9.3 step 1) |
| `lineHeight` | ×size | the paragraph's auto leading (1.2) | leading as a multiplier |
| `maxLines` | `int` | how many `minSize` lines the box height holds | 1..1,000,000 |

Result `{ layer, size, lines, overflow, bounds: [x0,y0,x1,y1], warnings?: [{code, message}], overflowPx?, overflowChars?, applied? }`. §9.3: measure → binary-search down to `minSize` (bounded, ≤ 64 probe steps) tracking wrapped lines → condensed tracking (±2% em) → ellipsis with a warning for a single-line slot → else **report** `text_overflow` with the exact px and characters; never clip silently. On success the fit is written back with one `type.edit` (`{layer, box, text?, runs:[{start:0, end, size, tracking?}]}`) and the exact call is echoed in `applied`; on overflow **nothing is written**.

Warning codes: `text_condensed`, `text_ellipsized`, `text_overflow` (with `overflowPx`/`overflowChars`, feeding §11.1's blocker check).

| Code | When | Hint |
|---|---|---|
| `bad_params` | `bounds` missing/malformed/out of range, `minSize`/`maxSize`/`lineHeight` not finite, `maxLines` outside 1..1,000,000, `minSize > maxSize` | message names the param and range |
| `no_document` / `no_layer` | as ever; `layer` missing or ambiguous | candidates listed |
| `not_a_text_layer` | the layer is not a type layer | "layer 7 is a raster layer, not a type layer" |
| `layer_locked` | the type layer is locked | Photoshop's own lock message (checked before the expensive fit) |

```json
→ {"layer": "Headline", "bounds": [72, 732, 936, 176], "minSize": 56, "maxSize": 110}
← {"layer": 2, "size": 88.5, "lines": 2, "overflow": false, "bounds": [72, 732, 1008, 908],
      "applied": {"command": "type.edit", "params": {"layer": 2, "box": [72, 732, 936, 176],
      "runs": [{"start": 0, "end": 47, "size": 88.5}]}}}
→ {"layer": 2, "bounds": [72, 732, 936, 56], "minSize": 24, "maxSize": 96, "maxLines": 1}
← {"layer": 2, "size": 24, "lines": 3, "overflow": true, "bounds": [72, 732, 1008, 788],
      "overflowPx": 132.0, "overflowChars": 38}
```

Relies on: `fit_text::fit_text` (the §9.3 algorithm, bounded `SEARCH_CAP`) over
`EngineTextMeasurer` (the engine's real text metrics), `type_cmds` lock check +
`norm_text`, write-back through `type.edit`.
Owned by: `engine-patches/layout_cmds/fit_specs.rs` (command) + `fit_text.rs`
(algorithm), spec §9.3.

### `layout.measure` — Measure Text
Query · journal: no · enabled: a document is open (fonts, resolution, canvas width).

| Param | Type | Default | Notes |
|---|---|---|---|
| `layer` | id or name | active type layer | whose text to measure |
| `text` | `string` | the layer's | ad-hoc text; with no `layer`, `size` is required |
| `size` | `pt` | the layer's | for ad-hoc text |
| `font` | `string` | the layer's face / engine default | family for ad-hoc text |
| `lineHeight` | ×size | 1.2 | leading multiplier |
| `bounds` | `[x, y, w, h]` | the layer's box width, else the canvas width | `w` is the wrap width |

Result `{ layer?, text, size, pxPerPt, maxWidth, width, lines, lineHeight, bounds: [0, 0, width, height], warnings? }` — pure metrics for planning (§9.4); no mutation at all.

| Code | When | Hint |
|---|---|---|
| `bad_params` | `bounds` malformed, `text` given with neither `layer` nor `size`, giant `text` (over the cap) | message names the param; a 1 MB string is refused, not allocated against |
| `no_document` / `no_layer` / `not_a_text_layer` | as `layout.fitText` | as above |

```json
→ {"layer": "Subhead"}
← {"layer": 4, "text": "Spring drop — 20% off everything", "size": 36, "pxPerPt": 1.3333,
      "maxWidth": 936, "width": 512.5, "lines": 1, "lineHeight": 43.2, "bounds": [0, 0, 512.5, 43.2]}
→ {"text": "Ad hoc headline", "size": 64, "bounds": [0, 0, 0, 0]}
← error: "invalid parameters for `layout.measure`: `bounds` width and height must be between 1 and 1000000 px"
```

Relies on: `EngineTextMeasurer` metrics only (the same measure seam
`layout.apply`'s `hug` sizing uses); zero writes, `journal: false`.
Owned by: `engine-patches/layout_cmds/fit_specs.rs`.

---

## `agent.*` + `document.diff` — spec §5.6 · module `agent_cmds` (W3-F/W3-G)

One transaction per run (§1.5 rule 10): the whole agent run reverts with a single
undo or rollback, and the exact command log supports replay from the last checkpoint
(crash recovery §3.4, "duplicate this document" copy-on-write). Transactions are
per-document; a retried tool call is safe because `agent.begin` is the checkpoint.
The transaction id is the document's snapshot id — per-doc monotonic, never reused.

### `agent.begin` — Begin Agent Transaction
Mutating (takes a real, budget-accounted snapshot) · journal: yes · enabled: a document is open.

| Param | Type | Default | Notes |
|---|---|---|---|
| `name` | `string` | `"Agent Run"` | the marker name; blank/null/wrong-typed default silently (never `Err` on cosmetic params); ≤ 256 characters |

Result `{ transaction_id: number, revision_before: number }`.

| Code | When | Hint |
|---|---|---|
| `no_document` | no document open | open or create one first |
| `transaction_already_open` | a transaction is open on this document | "close it with agent.commit or agent.rollback first" (nested begin is refused, §1.5 rule 10) |
| `bad_params` | `name` over 256 characters | "at most 256 characters" |

```json
→ {"name": "Restyle headline"}
← {"transaction_id": 1, "revision_before": 6}
→ {}
← {"transaction_id": 2, "revision_before": 9}
```

Relies on: the engine's own snapshot machinery (`DocState::snapshots`, stable
`next_snapshot` ids, tiles budget-counted) plus a static per-doc transaction map
(lock poisoning handled with `PoisonError::into_inner`, upstream's no-cascade rule).
Owned by: `engine-patches/agent_cmds/agent_cmds.rs`.

### `agent.commit` — Commit Agent Transaction
Mutating (history panel only) · journal: yes · enabled: an open transaction.

Params: `{}`.

Result `{ transaction_id, revision_before, revision_after }` — every history step since `agent.begin` folds into **one** undoable entry named after the run; one undo returns the pre-run document, one redo brings the run back. A run that changed nothing leaves no entry. The revision advances (the panel moved; the pixels did not).

| Code | When | Hint |
|---|---|---|
| `transaction_not_open` | no transaction open (idempotent refusal, not a no-op) | "call agent.begin first" |
| `transaction_busy` | a background job is computing on this document | "the history can't move while a command is still running"; retry after the job ends |
| `transaction_checkpoint_gone` | the checkpoint snapshot was deleted (`history.deleteSnapshot`) | the session is unwedged: the transaction is closed; the caller replays from its own log |
| `no_document` | the document closed mid-run | reopen and replay |

```json
→ {}
← {"transaction_id": 1, "revision_before": 6, "revision_after": 13}
→ {}
← error: "command `agent.commit` is not available right now: transaction_not_open: no agent transaction is open on this document; call agent.begin first"
```

Relies on: an `Arc`-pointer walk to find the checkpoint in history, then
`History::purge_last` folds + `set_current_label` (fallback: `History::record` when
the budget trimmed the checkpoint) + `clear_redo`.
Owned by: `engine-patches/agent_cmds/agent_cmds.rs`.

### `agent.rollback` — Roll Back Agent Transaction
Mutating · journal: yes · enabled: an open transaction.

Params: `{}`.

Result `{ transaction_id, revision_before, revision_after, restored: true }` — the document is the checkpoint again (content, selection and cursor; the revision keeps its monotonic climb so callers can log it), and the run's steps are gone from history: nothing stays redoable, one revision bump, byte-identical panel to pre-begin.

| Code | When | Hint |
|---|---|---|
| `transaction_not_open` | no transaction, or the run was already committed/rolled back | "call agent.begin first" — a second rollback is `Err` |
| `transaction_busy` / `transaction_checkpoint_gone` / `no_document` | as `agent.commit` | as above |

```json
→ {}
← {"transaction_id": 1, "revision_before": 6, "revision_after": 14, "restored": true}
→ {}
← error: "command `agent.rollback` is not available right now: transaction_not_open: no agent transaction is open on this document; call agent.begin first"
```

Relies on: `History::undo` stepping to the checkpoint (the `selectState` one-revision
pattern) + `clear_redo`; fallback restores the snapshot as one undoable state via
`Session::edit` (identity preserved).
Owned by: `engine-patches/agent_cmds/agent_cmds.rs`.

### `document.diff` — Diff Two Revisions
Query · journal: no · enabled: a document is open. **Contract pinned by §5.6 and the
panic-hunt obligations; the implementation lands in `document_diff.rs` (W3-G, shares
`agent_cmds`' `Transaction` types).**

| Param | Type | Default | Notes |
|---|---|---|---|
| `from` | `number` | required | a revision id (every command logs `revision_before`/`revision_after`) |
| `to` | `number` | required | ditto; `from ≤ to` |

Result `{ added: [layerId], removed: [layerId], changed: [layerId], moved: [layerId] }` — per-layer, for the UI diff and the validator's "nothing was silently destroyed" check (§5.6). The layer-tree walk is recursion-bounded (documents can be deep/cyclic; a seen-set guards cycles).

| Code | When | Hint |
|---|---|---|
| `bad_params` | `from`/`to` missing, negative, huge, `from > to` | the message names the param |
| `revision_out_of_range` | a revision id no state holds | the error lists the valid bounds |
| `no_document` | no document open | open one first |

```json
→ {"from": 6, "to": 13}
← {"added": [8], "removed": [], "changed": [2, 4], "moved": [4]}
→ {"from": 99, "to": 13}
← error: "revision_out_of_range: revision 99 is unknown; valid revisions are 1..14 (illustrative — the string is pinned by document_diff.rs when it lands, W3-G)"
```

Relies on: the same history states `agent.commit`/`rollback` move (`History::state`,
revision ids) and the document layer walk with a depth bound + seen-set.
Owned by: `engine-patches/agent_cmds/document_diff.rs` (upstream:
`crates/engine/src/agent_cmds/document_diff.rs`).

---

## Cross-cutting guarantees (all 18)

- **Never crash** (§1.5 rule 4): every failure is an `Err`; each module's adversarial
  table (`../tests/README.md`) must survive `cargo test -p photocraft-engine --test
  panic_hunt -- --ignored` with zero panics and zero hangs.
- **Warnings over silent fixes**: trimmed text, upscale past 125%, sub-`minPixels`
  assets, condensed tracking, ellipsis, degenerate layout targets are reported, never
  hidden; the only deletions a fill performs are image placeholders it replaces.
- **Replayable logs**: every mutating reply carries revision ids; `id@version` pins
  are explicit in template replies; transactions name their checkpoint.
- **Automation-safe**: all filesystem access is deployment configuration
  (`PHOTOCRAFT_TEMPLATES_DIR`, `PHOTOCRAFT_COMPONENTS_DIR`) or capability-scoped
  (`file.placeEmbedded` path values through the untrusted-session authorize gate);
  no command takes an ambient caller path.
