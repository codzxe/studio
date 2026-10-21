# Template authoring — the complete flow

How to author, validate, thumbnail, version and register a studio template. This is the
§19 Phase-2 authoring flow (spec §19: *"Template authoring flow (JSON manifest + source
`.pcraft`), validation, thumbnails"*), written against the shipped code, not aspiration:

| Truth source | File |
|---|---|
| Manifest contract (serde, caps) | `engine-patches/template_cmds/manifest.rs` |
| Fill-time slot rules | `engine-patches/template_cmds/fill.rs` |
| Validation issues | `engine-patches/template_cmds/validate.rs` |
| Command surface (`template.*`) | `engine-patches/docs/commands.md` |
| Registry (engine catalog) | `engine-patches/template_cmds/template_cmds.rs` |
| Registry (gateway loader) | `apps/gateway/src/services/catalog.ts` (W4-J) |
| Seed data + worked example | `evals/templates/`, esp. `evals/templates/instagram-post@3/` |
| Spec | `docs/BUILD_PROMPT.md` §7.1–§7.5, §10.1–§10.2, §11.1, §11.4, §21 |

A template is a real `.pcraft` document **plus** a JSON manifest naming its slots
(spec §7.1). `template.apply` instantiates the document; `template.fill` fills the slots.
Templates **ship as data** — no recompile, no engine patch (spec §7.4).

## The flow at a glance

1. Design the source document (`document.json`) — layer stack, §10.2 names.
2. Write `manifest.json` (§7.2) — every slot a model may fill, plus the rules.
3. Validate — strict manifest parse (`manifest.rs`) then `template.validate`.
4. Generate the thumbnail (≤512 px PNG via `doc.render`, at the `thumbnail` path).
5. Version — a bump is a **new** `id@version` directory, never an in-place edit (§7.4).
6. Synthetic demo asset + golden render in the eval fixtures (§7.4).
7. Pre-submit checklist (§7.5 anti-patterns), then land in the registry.
8. Register — `evals/templates/<id>@<version>/` is the catalog the loaders read.

---

## 1. Design the source document (`document.json`)

The seed format is a JSON description of the `.pcraft` the engine will hydrate. The
convention (`evals/templates/README.md`, `evals/templates/instagram-post@3/document.json`):

```json
{
  "format": "studio-template-document/1",
  "template": "instagram-post@3",
  "name": "Instagram Post — Promo",
  "width": 1080, "height": 1080, "background": "#F4E7D3",
  "layers": [ /* bottom-to-top, like Document.layers */ ]
}
```

**Layer list order is bottom-to-top** — the first entry in `layers` is the bottom of the
stack, matching `Document.layers` in the engine. Follow §10.1 z-order sanity:
background → photos → decoration → text → brand. Nothing opaque may cover a text layer.

**Every layer carries a §10.2 name.** Never `Layer 27`, never empty (§7.5 forbids
un-named layers; `template.validate` reports them as `naming` minors):

| Kind | Name pattern |
|---|---|
| Background | `Background` |
| Photo | `Photo` / `Photo — <subject>` |
| Text roles | `Headline`, `Subhead`, `Body`, `Caption`, `CTA` |
| Brand | `Logo`, `Badge`, `Watermark` |
| Groups | PascalCase role names (`Content`, `Brand`, `Effects`) |
| Components | `<ComponentName>` / `<ComponentName> — <variant>` |
| Variants | `… — <size/lang>` (em dash, one space each side) |

**Layer kinds** use the engine's spellings: `Fill` (solid colour fill layers carry
`fill`), `Pixel` (image placeholders), `Type` (text layers carry `text`:
content/font/weight/size/lineHeight/color/align), `Group` (component placeholders carry
`component: { id, vars }`; groups may nest children under `"layers"` — see
`evals/templates/event-flyer@1/document.json` for the first nested seeds).

Authoring rules that come back as validation issues if broken:

- **Slot geometry is the document's geometry.** A slot's `bounds` in the manifest must
  equal the named layer's bounds in `document.json` — `template.apply`/`template.fill`
  resolve slots **by layer name**, and `template.validate` checks the layer sits inside
  its declared box (code `slot_bounds`, 0.5 px tolerance).
- **Placeholder copy is legal fill data.** Every `Type` layer's `content` must fit its
  slot's `maxChars`/`maxLines` budget — the fill of a real run must be able to replace it.
- **Image placeholders are `Pixel` layers with a `placeholder` note**, never baked art.
  `template.fill` replaces the placeholder with the placed image (a smart object
  transformed into the slot bounds); it never deletes layers (§7.3).
- **Optional layers start `visible: true` in the source document.** `template.fill`
  hides unfilled optional slots (present but hidden, §7.3 — the user can switch them
  on later). Never ship a template with pre-hidden slots.
- **Component placeholders are `Group` layers** carrying `component: { id, vars }` with
  a real `id@version` pin that exists in the component registry
  (`evals/components/`).
- **No fonts in the document.** Text layers name font *tokens* (`display`, `sans`,
  `serif`, `mono` roles, §5.5); fonts resolve from the workspace registry at render
  time. **Never commit font files** (`CRAFT_FONTS_DIR`; spec §1.5 rule 9) — a template
  requiring an external font absent at runtime is an §7.5 anti-pattern and must fail
  with an install hint.

## 2. Write `manifest.json` (§7.2)

The full §7.2 example ships verbatim as `evals/templates/instagram-post@3/manifest.json`
— copy it as the starting point. Field names are **frozen by the serde types** in
`manifest.rs` (`deny_unknown_fields`, camelCase, `kind`-tagged slot union): a manifest
with an unknown field or out-of-range value is **refused** by the catalog scan (the
template is skipped with its reason remembered — it never hides the rest of the catalog,
and explains itself when asked for by id).

### 2.1 Field reference (from `manifest.rs::validate`)

Every number that later becomes geometry is checked at parse time — no `template.*`
command ever has to defend against its own template.

| Field | Type / shape | Rule (cap) |
|---|---|---|
| `id` | string | slug `a-z0-9-`, 1..=64 chars, no leading/trailing hyphen |
| `version` | integer | ≥ 1 (u64); pins the template (`id@version`) |
| `name` | string | 1..=128 chars |
| `description` | string? | ≤ 4096 chars; carries the §7.5 self-check (see checklist) |
| `tags` | string[] | ≤ 32 entries, each 1..=64 chars; `template.list` matches ALL given tags |
| `canvas.width/height` | integer | 1..=300 000 (`MAX_DIMENSION`) each |
| `canvas.background` | hex? | `#rrggbb` or `#rrggbbaa` |
| `slots` | map | ≤ 64 hard cap — **keep ≤ ~12** (§7.5: more is a component's job); names 1..=64 chars |
| `rules.safeArea` | number? | 0..=1e6 px |
| `rules.minContrast` | number? | 0..=21 (WCAG stops at 21:1) |
| `rules.mustLayers` | string[] | ≤ 32 layer names, each 1..=256 chars; must exist as named layers |
| `rules.maxTextLayers` | integer? | ≥ 1; counts hidden placeholders too (§7.3) |
| `rules.palette` | string[] | ≤ 32 colours, each `#rrggbb`/`#rrggbbaa` |
| `layerMap` | map | ≤ 128 entries; key = layer name (1..=256 chars) matching the document |
| `layerMap.*.role` | string | 1..=64 chars; drives naming checks + safe-area "essential" classification |
| `layerMap.*.fill` / `mask` / `maskRadius` / `component` | hex / string / number / pin | hex / 1..=64 / 0..=1e6 / `id` or `id@version` |
| `thumbnail` | string? | 1..=512 chars, a path **relative to the template** |
| `license` | enum? | `workspace` \| `public` (one of them, not the literal placeholder) |
| `author` | string? | ≤ 128 chars |

### 2.2 Slot kinds and their fill-time implications

Slots are a `kind`-tagged union: `text`, `image`, `component`, `color`, `visibility`.
Each field below has a **contract enforced by `template.fill`** (spec §7.3: enforced by
the engine, not the model) and a validation consequence — this is why the field exists:

| Slot field | `template.fill` behaviour (the implication of declaring it) |
|---|---|
| `layer` | The layer the slot fills **by name** — must be a `layerMap` key and a named layer in the document; `validate` reports a missing layer as `slot_layer_missing` (major). |
| `bounds` `[x,y,w,h]` | The design box. Image slots: the placed layer is transformed into it (with the slot's fit mode/focal). Text slots: the paragraph box. `validate` checks the layer inside its box (`slot_bounds`, major, 0.5 px eps). Numbers finite, within ±1e7, size 0..=1e7. **Must equal the document layer's bounds.** |
| `font` (text) | A workspace font role token (§5.5). `fill` compiles to `type.edit`/`type.setStyle`; a font absent from the registry at render time is a `missing_font` **blocker** with an install hint (§7.5) — never a silent substitution. 1..=256 chars. |
| `size` (text) | Declared type size in pt, 0 < size ≤ 1e5; clamped into the `autoFit` range when one is declared. |
| `autoFit` `{minSize, maxSize}` | The shrink range: `layout.fitText` (§9.3) shrinks within `[minSize, maxSize]` and wraps before overflowing; the chosen size is written back via `type.setStyle`. Parse rule: 0 < minSize ≤ maxSize ≤ 1e5. **Declare the declared `size` inside the range.** If `fitText` still cannot fit, it trims only at user-visible boundaries and warns — it never paints outside the box. |
| `maxChars` (text) | The character budget: longer text is trimmed at a user-visible boundary and reported as a `text_trimmed` **warning**, never silently (§7.3). ≥ 1. Placeholder copy in `document.json` must fit it. |
| `maxLines` (text) | Wrap budget, ≥ 1; overflow surfaces as the `text_overflow` warning relayed from `layout.fitText`. |
| `lineHeight`, `weight`, `align`, `color` (text) | Written via `type.setStyle` — `align` ∈ `left\|center\|right\|justify`, `color` `#rrggbb(/aa)`, `lineHeight` 0 < lh ≤ 100, `weight` 1..=64 chars. Declared colors must clear `rules.minContrast` against the declared background (`contrast`, **blocker**). |
| `fit` (image) | `cover` \| `contain` \| `fill` — how the placed image is fitted into `bounds`. |
| `minPixels` `[w,h]` (image) | The smallest acceptable source asset; a placed image below it warns `asset_below_min_pixels` (§11.1 `asset_resolution`). Sides ≥ 1. Set it to the slot box at native quality (§7.2's photo: `[1080, 700]`). |
| `focal` `[x,y]` (image) | Cover-crop focal point, each 0..=1. |
| — upscale guard (image) | Upscaling a small asset beyond 125% is a warning (`image_upscaled`); beyond 200% is a hard error (§7.3) — size `bounds` and `minPixels` together so real assets land under 125%. |
| `component` + `vars` (component) | An `id@version` pin (e.g. `offer-badge@2`) and the values its **declared** variables start from; `fill` compiles to `component.place`. `vars` ≤ 64 entries, names must be the component's declared variables (§7.3/§8.4). |
| `color` (color slot) | The seed value; filling compiles to `layer.fill.solidColor.set` on the named layer (a Solid Color Fill layer — see `linkedin-banner@1`'s `accent` slot). Color slots are never safe-area-essential. |
| `default` (visibility) | The layer's shown/hidden seed; filling compiles to `layer.setProps {visible}`. |
| `optional` | If `false`, a missing value at fill time is a hard error **listing exactly what is needed** (§7.3); if `true` and unfilled, the layer stays **present but hidden** — never delete template layers. |

## 3. Validation

Two layers, run in this order; both are deterministic and model-free.

### 3.1 The strict manifest parse (`manifest.rs`)

`TemplateManifest::from_value` parses with `deny_unknown_fields` then runs the field table
in §2.1. Anything failing is a `ManifestError` and the catalog **skips the template with
the reason remembered** — the file never reaches `template.list`. So every row in §2.1 is
a *hard* parse gate: fix it before anything else. Cross-file rules the loaders also
enforce (`evals/templates/README.md`):

- slot `layer` values == `layerMap` keys == named layers in `document.json`;
- slot `bounds` == the document layer bounds;
- every `rules.mustLayers` entry exists as a named layer (`template.inspect` warns);
- component pins resolve in the component registry;
- placeholder copy ≤ `maxChars`.

### 3.2 `template.validate` — the issues catalog (`validate.rs`)

```
template.inspect→apply→fill, then: template.validate {"template": "id@version"}
→ { ok, issues: [{ level, code, layer?, message, fix }], truncated }
```

`level` ∈ `blocker | major | minor`; **`ok` is true while there is no blocker and no
major** (minors are suggestions and never flip `ok` on their own — §11.1). The checks run
in a fixed order (same document + manifest ⇒ same issues, same order); the reply caps at
256 issues (`truncated: true`). Checking the template's **own** shipped document is the
authoring lint: call `template.validate {"template": "id@version"}` with **no document
open** — it validates the catalog's `.pcraft` as shipped.

| code | level | what it reads |
|---|---|---|
| `missing_must_layer` | **blocker** | every `rules.mustLayers` name exists in the document |
| `slot_layer_missing` | major | every slot's target layer exists (§7.3: template layers are never deleted) |
| `slot_bounds` | major | a slot's layer sits inside its declared `[x,y,w,h]` (0.5 px eps) |
| `safe_area` | major | essential content keeps `rules.safeArea` px clear of every canvas edge |
| `contrast` | **blocker** | visible text vs the **declared** background (the `background` role's `fill`, else `canvas.background`), WCAG relative-luminance ratio; threshold `rules.minContrast`, else 4.5:1 body / 3:1 large (≥ 18 pt) |
| `max_text_layers` | major | text-layer count (hidden placeholders included) within `rules.maxTextLayers` |
| `color_out_of_palette` | minor | visible text and solid-fill colours are in `rules.palette` (8-bit rgb compare; raster pixels exempt) |
| `naming` | minor | §10.2: machine names (`Layer 27`, `Group 3`, `Shape`), empty names, and role-pattern warnings (a `headline`-role layer should be named `Headline`…; one trailing ` — <variant>` segment is stripped first) |

Safe-area **essential** classification (a design decision, cite-checked): text and
component slots are always essential; image slots only when their `layerMap` role is
`logo`, `badge` or `watermark`; photos and backgrounds bleed on purpose (the §7.2
example's photo is full-bleed). A slot is checked **by its declared box** when it has no
pixels — whether or not it is filled (an unfilled optional still shows when the user
switches it on). Text over a photo is a render question owned by the worker's pixel-based
§11.1 pass, not this one.

Design-to-green recipe: put every visible text ≥ `minContrast` (or 4.5/3.0) **against the
declared background**, keep every essential slot's box inside `safeArea`, name layers per
§10.2, keep colours inside `palette`, and count hidden text placeholders against
`maxTextLayers`.

## 4. Thumbnails

The `thumbnail` field is a path **relative to the template** (1..=512 characters,
`manifest.rs`), e.g. `"thumbnails/instagram-post@3.png"` — a gallery-sized PNG beside the
template data. Generation note:

1. `template.apply` the template **with its synthetic demo fills** (§7.4, step 6 below).
2. Render once through the engine: `doc.render` at a preview scale of **≤ 512 px on the
   long edge**, PNG.
3. Store the PNG at the `thumbnail` path declared in the manifest (PNG is committable
   template data; the repo's no-binary rule is for *fixtures*, which generate at CI time).
4. **Never commit font files** (`CRAFT_FONTS_DIR`, §1.5 rule 9): the thumbnail embeds
   rendered pixels, but the template data itself must stay font-free; fonts come from the
   workspace registry at render time. If a workspace font changes, re-render the
   thumbnail in the same change as any visual bump.
5. A thumbnail is a preview, not truth: a **version bump re-renders its thumbnail** with
   the goldens, in one batch.

## 5. Versioning (§7.4)

- **A shipped version is immutable.** Any fix or change → **bump `version`** and add a
  NEW `evals/templates/<id>@<version+1>/` directory (new `manifest.json`,
  `document.json`, `assets-note.md`). Never edit a shipped manifest in place — evals,
  goldens and pinned runs depend on it.
- Versions start at 1. (`instagram-post` ships at 3 because §7.2 specifies that manifest
  verbatim; versions 1–2 are intentionally not re-created.)
- **`id@version` is always explicit in the command log** (§7.4): every `template.apply`
  reply and log line pins the version that ran; `template.inspect`/`.validate` echo the
  same pin. `template.list` returns every version of every id; callers without a pin get
  the newest, older versions stay in the catalog for pinned runs.
- A version bump re-renders goldens + thumbnails in one batch (step 4/6), and updates the
  fixtures generator's mirror spec (`evals/fixtures/generator/specs/<id>@<version>.json`)
  in the same change — the generator prints drift warnings both ways.

## 6. Synthetic demo asset + golden render (§7.4)

Spec §7.4: *each template must include a synthetic demo asset and a golden render in the
eval fixtures.* The shipped mechanism (W7-E generator + seed precedent):

- **`assets-note.md`** in the template dir is the demo-asset spec: **deterministic
  gradient geometry only** — explicit colour formulas (e.g. `t = y / 699; lerp(#F4E7D3,
  #D96C3B, t)`), shapes with centres/radii, sizes. No binaries, no randomness, no
  network, no PII, **no fonts**. Repo-authored synthetic assets need no
  `ATTRIBUTION.md` row; any *real* third-party asset under `evals/fixtures/` must add one
  **in the same change** (§1.5 rule 9).
- The fixture generator (`evals/fixtures/generator/`) materializes the PNGs into
  `evals/fixtures/generated/<id>@<version>/` at test/CI time (committed fixtures, ≤ 50 KB
  per PNG enforced; `--allow-oversize` is the escape hatch). A prose-only note means the
  generator keeps a machine mirror spec under `generator/specs/`; **new notes should
  embed the documented ```json spec block** so no mirror is needed.
- The **golden render** is `template.apply` + `template.fill` with the demo assets →
  render once → store under `evals/fixtures/renders/<id>@<version>/` (downscaled
  ≤ 1024 px, §5.4; compared by **perceptual distance, never pixel equality**, §11.4).
  Wave 7 wires rendering; a color/text-only template (e.g. `linkedin-banner@1`) documents
  its "demo asset" as the fill values and still owes the golden.

## 7. Registry — where templates live and who loads them

**Location:** `evals/templates/<id>@<version>/{manifest.json, document.json,
assets-note.md}` — one directory per pinned version, named `id@version`. This repo data
is the seed catalog for **two independent loaders**:

1. **The engine catalog** (`template_cmds.rs`): a directory named by
   `PHOTOCRAFT_TEMPLATES_DIR` holding `<stem>.json` manifest + `<stem>.pcraft` document
   pairs; id/version come from the manifest's content, never the file name. Caps: 256
   templates, 4 MiB per manifest, 32 query tags; a broken manifest is **skipped with its
   reason remembered** (like installed profiles), never hides the rest, and explains
   itself when asked for by id (`broken_template`). Fixture tooling materializes each
   `document.json` into the `.pcraft` beside a copy of the manifest.
2. **The gateway catalog loader** (W4-J, `apps/gateway/src/services/catalog.ts`): reads
   `evals/templates/` + `evals/components/` with `fs` **once at startup**, validates each
   manifest with **Zod at the boundary** (schema mirrors the engine's acceptance —
   lenient load, strict registration), and caches entries **immutably keyed by
   `id@version`**. It never writes manifest files. Boot **fails loud when zero valid
   manifests load** (an empty catalog is a wiring bug, not a state to serve 200s from);
   an invalid manifest is skipped with a warning. `STUDIO_CATALOG_DIR` overrides the
   repo-relative resolution for prod containers. `GET /v1/templates` /
   `POST /v1/workspaces/:id/templates` serve and register (`license: workspace`); row
   ids are SHA-256(org+id+version) so retried registrations dedupe.

Consequence: a template lands when its directory is complete and both loaders' schemas
agree — the strict `manifest.rs` table in §2.1 is the gate for both (the Zod schemas are
its mirror), plus the README cross-file rules.

## 8. Pre-submit checklist (§7.5 anti-patterns) — copy, check, paste in the PR

```text
Template pre-submit checklist (spec §7.5) — id@version: ____

[ ] ≤ 12 slots (64 is the hard parse cap; beyond ~12 it is a component's job)
[ ] No external fonts: font fields are workspace tokens; missing font ⇒ install
    hint, never silent substitution; NO font files committed anywhere
[ ] Every layer named per §10.2 — no `Layer N`/`Group N`/empty names, no hidden
    pixel dumps, no flattened/baked art (editability is the product, §25)
[ ] Slots make sense for any brand: palette + fonts default from workspace brand
    tokens, manifest values are fallbacks only
[ ] slot.layer == layerMap keys == document.json layer names, bounds identical
[ ] rules.mustLayers exist; visible text clears minContrast vs declared background;
    essential slots inside safeArea; palette covers visible text + fills
[ ] description carries the anti-pattern self-check (slot count + named-layers-only)
[ ] license is "workspace" or "public" (not the placeholder), author set
[ ] assets-note.md: deterministic synthetic demo asset spec only (no binaries,
    no fonts, no PII); fixtures generator mirror spec in sync (or ```json block)
[ ] version bumped to a NEW id@<version+1>/ dir (shipped versions untouched)
[ ] thumbnail path declared; PNG (≤512 px) rendered at the path; no fonts committed
[ ] template.validate on the shipped document: ok=true (zero blockers, zero majors)
[ ] golden render queued under evals/fixtures/renders/<id>@<version>/ (≤1024 px,
    perceptual, §11.4)
[ ] id@version explicit everywhere it appears (logs, goldens, fixtures, README index)
```

## 9. Worked example

`evals/templates/instagram-post@3/` is the §7.2 manifest **verbatim** (with
`"license": "public"`, `"author": "studio"`): 5 slots (photo/headline/subhead/badge/logo),
a component slot pinning `offer-badge@2` with `vars: { "label": "20% OFF" }`,
`rules.safeArea: 48`, `minContrast: 4.5`, a 3-colour palette, and a bottom-to-top
document stack `Background → Photo → Headline → Subhead → Badge → Logo`. The social set
(`instagram-story@1` … `pinterest-pin@1`) and the print set (`event-flyer@1` …
`cafe-menu@1`) show the pattern at other aspect ratios, with safe areas, color slots and
nested groups. When a template's note or manifest changes, sync the generator's mirror
spec in the same change.
