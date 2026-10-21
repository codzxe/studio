# Component authoring — the §8 mirror

How to author a reusable, versioned, variable-driven component. Components are spec §8's
primitive for brand consistency and "more per token"; templates reference them
(`component` slots), agents place them (`component.place`), and the start library is
hard-coded data (§8.3). This doc mirrors `docs/authoring/template-authoring.md` and is
written against the shipped code:

| Truth source | File |
|---|---|
| Manifest contract (serde, caps) | `engine-patches/component_cmds/component_manifest.rs` |
| Command surface (`component.*`) | `engine-patches/component_cmds/component_cmds.rs`, `engine-patches/docs/commands.md` |
| Seed library + conventions | `evals/components/` (`README.md` + one dir per component) |
| Spec | `docs/BUILD_PROMPT.md` §8.1–§8.4, §10.1–§10.2, §1.5 rule 9 |

A component (§8.1) is a named, versioned, variable-driven **group of layers** that can be
placed in documents and updated across instances. The implementation reuses existing
primitives — that is the whole design:

- **Smart-object sharing** (`SmartContentsId`) gives shared pixel content.
- **Variables + data sets** (`image.variables.define`, `image.applyDataSet`) give
  per-instance values (text, colours, visibility, image).
- **Layer comps** (`layerComp.*`) give alternative states (light/dark, sizes).

## The flow at a glance

1. Write `component.json` — the §8.2 manifest: identity, `defaultSize`, `variables`,
   `anchors`, `comps`, `license`.
2. Write `layer.json` — the group stack + the variable→layer bindings (the master's
   authoring source).
3. Check the anchor math and comps.
4. Validate against the §8.4 rules + the engine caps.
5. Land as data in the registry; publishing (`component.publish`) is a later phase.

Seed layout (`evals/components/`):

```
evals/components/<id>/
  component.json   the §8.2 manifest — named for the engine's MANIFEST_FILE constant
  layer.json       the group layer structure component.place copies: the documented
                   source for the binary master <id>@<version>.pcraft the engine loads
```

---

## 1. `component.json` — the manifest (§8.2)

The §8.2 example ships verbatim as `evals/components/offer-badge/component.json`. Field
names are the law (`component_manifest.rs`, camelCase, strict `VariableSpec` with
`deny_unknown_fields`):

```json
{
  "id": "offer-badge",
  "version": 2,
  "name": "Offer Badge",
  "author": "studio",
  "tags": ["badge", "promo"],
  "defaultSize": { "width": 180, "height": 180 },
  "variables": {
    "label":      { "kind": "text", "default": "SALE", "maxChars": 12 },
    "bg":         { "kind": "color", "default": "#D96C3B" },
    "textColor":  { "kind": "color", "default": "#FFF7EE" },
    "showRibbon": { "kind": "visibility", "default": false }
  },
  "anchors": { "center": [0.5, 0.5], "topRight": [1, 0], "bottomLeft": [0, 1] },
  "comps": ["default", "light", "dark"],
  "license": "public"
}
```

Field reference, with the engine caps (`component_manifest.rs`):

| Field | Rule (cap) |
|---|---|
| `id` | `a-z0-9-`, 1..=64 chars, **starts with a letter or digit** (path characters refused — ids are never used to build paths) |
| `version` | ≥ 1; pins the master `<id>@<version>.pcraft`; immutable once shipped |
| `name` | 1..=128 chars; `component.place` groups the instance under this name |
| `tags` | ≤ 32 entries, each 1..=32 chars; `component.list` matches ALL given tags |
| `defaultSize` `{width,height}` | 1..=8192 px per side and ≤ 64 MP total (the §2.3 automation ceiling); the master is authored at this size |
| `variables` | map, ≤ 64 variables, names 1..=64 chars — see §2 |
| `anchors` | ≤ 16 named entries, each `[x,y]` fractions in 0..=1; names 1..=32 chars |
| `comps` | ≤ 32 unique non-empty names |
| `license` | **required** (`workspace` \| `public`) even though the printed §8.2 example omits it — §8.4: every component carries a license |
| `author` | tolerated top-level extra (serde allows schema growth at the top level only) |

Unknown values are errors, never silent defaults: an unknown variable kind, license, or a
default that does not match its kind **refuses the whole manifest** (a broken component
appears in `component.list`'s `problems` rows, it does not fail the list).

## 2. Variable kinds and their bindings

`variables` is the component's schema: `name → { kind, default, maxChars? }`. `VariableSpec`
is strict — exactly `kind`, `default`, and on **text variables only** `maxChars`
(1..=4096, defaulting to the cap). A `default` must match its kind: a string for `text`,
`#rgb/#rgba/#rrggbb/#rrggbbaa` for `color` (canonicalised to `#RRGGBB(AA)`), a bool for
`visibility`. Optional text variables encode as **empty-string defaults** (there is no
`optional` field — see `logo-lockup.tagline`).

The binding of a variable to a layer lives in the **master document** (its
`variables.defs`, the §8.1 primitive), recorded in `layer.json`. Engine rules
(`component_cmds.rs`, `evals/components/README.md`):

- **One variable binds exactly one layer.** Every manifest variable must appear in
  `layer.json` `bindings` exactly once — an unbound variable is a data error at place
  time.
- `text` → `textReplacement` on a text layer; the value becomes the layer's whole
  content; `maxChars` is enforced **in characters** (`chars().count()` — Unicode scalars,
  not bytes).
- `color` → recolours the bound layer's **solid** fill, shape fill or type colour.
  Gradient/pattern fills and pixel layers **refuse with a warning, never clobber** — so
  every colour-bound layer is a solid shape or a text layer.
- `visibility` → the bound layer's visible flag. A hidden-by-default companion layer is
  the §7.3 present-but-hidden pattern; `defaultVisible` in `layer.json` must equal the
  variable's default.
- Companion decoration that must *not* track a colour variable is authored
  colour-neutral (translucent wash, fixed ink) so `component.setVars` recolouring stays
  coherent; comps restyle it (see `wave-divider`'s mirrored crest, `ribbon-banner`'s tails).

At call time (`component.place`/`.setVars`): unknown variable names are errors **with the
allowed list attached** (§8.4), kinds and `maxChars` are enforced, and the merged
per-instance state is returned.

## 3. `layer.json` — the master stack

`layer.json` documents the group the engine copies on `component.place`
(`evals/components/offer-badge/layer.json` is the worked example):

```json
{
  "component": "offer-badge",
  "version": 2,
  "master": "offer-badge@2.pcraft",
  "designSize": { "width": 180, "height": 180 },
  "group": "Offer Badge",
  "layers": [ /* bottom→top */ ],
  "bindings": { "label": { "layer": "Label", "as": "textReplacement" }, "…": {} },
  "comps": { "default": "Authored state: …", "light": "…", "dark": "…" }
}
```

Conventions:

- `layers` is the stack **bottom→top** (§10.1 z-order: background plate → decoration →
  text). `bounds` are `[x, y, w, h]` integers in the component's **design space** —
  origin at the top-left of `defaultSize`; the master document is authored at
  `defaultSize`.
- Layer kinds here: `text` (font tokens `display`/`sans`, weight, size, lineHeight,
  align, colour) and `shape` (`ellipse | rect | roundedRect | path`, solid fill). Paths
  may hold several subpaths so one visibility variable can drive a compound decoration.
- Names are semantic, stable, unique inside the group, never `Layer N` (§10.2). The group
  carries the manifest `name`; variant layers use `… — <variant>` (`Wave — mirror`).
- Fonts are workspace tokens only — **no font files, ever** (§1.5 rule 9). Colours come
  from the studio palette (`#F4E7D3 #3B2A20 #6B5748 #D96C3B #FFF7EE`). Demo identity is
  synthetic (`Acme Coffee`, `@acme.kitchen`) — no PII.

## 4. Anchor math (the 9-point grid)

`anchors` names fractions of the **design box** on the classic 9-point grid:
`topLeft [0,0]`, `top [0.5,0]`, `topRight [1,0]`, `left [0,0.5]`, `center [0.5,0.5]`,
`right [1,0.5]`, `bottomLeft [0,1]`, `bottom [0.5,1]`, `bottomRight [1,1]`.
Default anchor is the centre `[0.5, 0.5]`. A call passes either a **declared name**
(undeclared names refuse with the declared list) or raw `[x, y]` fractions (finite,
clamped into 0..=1 — the one sanctioned clamp, §8.4).

The placement formula (`component_cmds.rs::anchored_rect`), when the call gives **no
explicit bounds** — the anchor point of the design box lands at the same relative point
of the canvas:

```text
x = fx · (W − w)      y = fy · (H − h)
# fx, fy = anchor fractions; W, H = canvas size; w, h = defaultSize
# [1, 0] (topRight) ⇒ flush top-right; a design bigger than the canvas
# overflows symmetrically (computed placements may go off-canvas).
```

Worked row (the engine's own test): design 180×180 on a 400×400 canvas →
`[0,0]→[0,0]`, `center→[110,110]`, `[1,1]→[220,220]`, `[0.25,0.75]→[55,165]`.

When the call **does** give `bounds [x,y,w,h]`, the engine uses them literally as the
target frame (`target_rect` ignores the anchor) — so the tool layer (W5-K,
`packages/tools/src/tools/component-place.ts`) converts anchor-style requests itself:

```text
x' = x − fx · w      y' = y − fy · h
# "place the topRight anchor at [900, 72]" with size 180×180 ⇒ x' = 900 − 1·180 = 720
# the adjusted frame is sent as bounds (engine takes explicit bounds literally)
```

Caps on explicit bounds: x/y ≥ 0, w/h ≥ 1 px, per-side and ≤ 64 MP (§2.3) — negative
user-passed offsets refuse; a collapsing transform is `degenerate_placement`.

## 5. Comps — alternative states

`comps` names the master's layer comps (§8.1 `layerComp.*`): alternative states of the
same component — light/dark, sizes. Every library component ships **`default` plus
`light` and `dark`**; `layer.json`'s `comps` object documents each restyle in prose
(plate/label/ribbon colour assignments). Comps restyle the layers the variables do not
cover — the manifest `variables` stay the same across comps.

## 6. §8.4 rules (enforced, not advisory)

- **Instance variables are schema-checked.** Unknown variables are errors with the
  allowed list attached; kinds, `maxChars` and colour formats are validated. This is
  `component.place`/`.setVars` behaviour, not a lint.
- **Placing never mutates the master.** `component.place` copies the stack with **fresh
  layer ids** (smart-object contents stay shared, §8.1); layer ids in
  `component.inspect` are the **master's** — an instance copy gets its own. Masters
  change only via `component.publish` (later phase) or this authoring flow.
- **Updates across instances are opt-in.** `component.updateInstance` pulls the latest
  version **per instance**, keeping the outer placement and the instance's variables;
  edits outside the declared variables are **reported in `userChanges`, never silently
  discarded**; dropped variables are warned. Never silently restyle a user's document.
- **License on every component**: `workspace | public`. Public components must be
  created by us or clean-room reproduced, with attribution in `ATTRIBUTION.md` when
  third-party-inspired. The ten library components are clean-room studio originals
  (synthetic demo identity, no third-party art).

## 7. Publishing flow (later phase, §8.3)

`component.publish { group, id?, version? }` — promoting a document group to a component
— is a **future** command. It is wired today only as a typed refusal:

```
→ component.publish {"group": "Hero badge"}
← "command `component.publish` is not available right now: not yet available —
   publishing lands in a later phase (spec §8.3). Planned semantics: validate the
   group, write a NEW <id>/component.json + <id>@N.pcraft into the components root,
   never mutating an existing component or its master (§8.4)"
```

Until it lands, the authoring flow **is** this data flow:

1. Author `component.json` + `layer.json` under `evals/components/<id>/` (the master
   `.pcraft` is materialized from `layer.json` beside the registry copy).
2. Validate: the manifest parses (`component.inspect { id }` returns the manifest +
   master summary; a bad manifest is `broken_manifest`, a missing id is
   `unknown_component` with candidates); every variable binds exactly one layer; `§8.4`
   rules above hold; `component.place` on a scratch document with each comp + defaults
   renders green.
3. Version: masters are append-only (`<id>@<version>.pcraft`); bumping = new master +
   updated manifest **in one change**; `id@version` is explicit in every command log
   (§7.4 discipline); instances pin the placed version, so a bump never restyles
   existing documents (opt-in `updateInstance` only).
4. Register: the components root is `PHOTOCRAFT_COMPONENTS_DIR` (engine) — each
   `evals/components/<id>/` dir is drop-in compatible — and the gateway catalog
   (W4-J) loads `evals/components/` at startup with the same Zod-at-the-boundary
   discipline as templates (`component.list` rows + `problems`).

## 8. Pre-submit checklist — copy, check, paste in the PR

```text
Component pre-submit checklist — id@version: ____

[ ] manifest parses: id slug, version ≥ 1, license "workspace"|"public", tags/anchors/comps
    within caps; VariableSpec strict (no unknown fields; maxChars on text only)
[ ] every variable binds exactly one layer in layer.json; defaults match their kinds
    (text/color #hex/visibility bool); optional text = empty-string default
[ ] colour-bound layers are solid shapes or text layers (gradient/pattern/pixel refuse)
[ ] defaultVisible == each visibility variable's default (§7.3 present-but-hidden)
[ ] anchors: ≤ 16 named, fractions in [0,1]; 9-point formula verified (worked row)
[ ] comps: default + light + dark, documented in layer.json; variables unchanged across comps
[ ] names semantic + unique (no Layer N); stack bottom→top (plate → decoration → text)
[ ] fonts are workspace tokens only — no font files committed (§1.5 rule 9)
[ ] synthetic demo identity only (no PII); clean-room provenance; ATTRIBUTION row if
    third-party-inspired
[ ] version bumped = new <id>@N.pcraft + manifest in ONE change; masters append-only
[ ] component.place smoke test green on a scratch doc (defaults + each comp);
    unknown-variable error path lists the allowed variables
```

## 9. The library

Ten components ship as the §8.3 start library (`evals/components/README.md`):
`offer-badge@2`, `logo-lockup@1`, `star-rating@1`, `price-tag@1`, `button-cta@1`,
`quote-block@1`, `avatar-circle@1`, `wave-divider@1`, `ribbon-banner@1`,
`social-handle@1`. `offer-badge@2` reproduces the §8.2/§7.2 example verbatim and is the
`instagram-post@3` template's `badge` slot target — the canonical worked example for
both flows.
