# evals/components — the §8.3 start library

The ten hard-coded start components (spec §8.3: logo lockup, offer badge, star rating,
price tag, button, quote block, avatar, wave divider, ribbon, social handle) as **eval
catalog data and master authoring source**. The engine's live registry is a components
root pointed at by `PHOTOCRAFT_COMPONENTS_DIR` (`engine-patches/component_cmds/component_cmds.rs`);
each directory here is drop-in compatible with that root, and the suite can diff this
catalog against `component.list` output to detect registry drift (§21; also the
`evals/fixtures/catalogs/` plan).

## Layout

```
<id>/component.json   the §8.2 manifest — named for the engine's MANIFEST_FILE constant
                      (component_cmds.rs reads `<root>/<id>/component.json`)
<id>/layer.json       the group layer structure `component.place` copies: the documented
                      source for the binary master `<id>@<version>.pcraft` the engine loads
```

## Manifest conventions (field names are the law)

Field names and nesting follow `engine-patches/component_cmds/component_manifest.rs`
exactly — camelCase top level: `id`, `version`, `name`, `tags`, `defaultSize`
(`{width,height}` only), `variables`, `anchors`, `comps`, `license`. `VariableSpec` is
strict (`deny_unknown_fields`): each variable is exactly `kind` (`text | color |
visibility`), `default` (must match the kind — a string for text, a bool for
visibility, `#rgb/#rgba/#rrggbb/#rrggbbaa` for colour) and, on text variables only,
`maxChars` (1..4096). A `license` (`workspace | public`) is **required** even though the
printed §8.2 example omits it — every entry here ships `license: "public"`,
`author: "studio"` (tolerated top-level extras; serde allows schema growth at the top
level only). The engine caps: id `a-z0-9-` ≤64 chars (no path characters), ≤32 tags of
≤32 chars, ≤16 anchors, ≤32 unique comps, `defaultSize` 1..8192 per side and ≤64 MP.

## Binding rules (engine reality, component_cmds.rs)

- **One variable binds exactly one layer** (`remapped_bindings` maps each manifest
  variable to a single master layer id via the master's `variables.defs`, §8.1). Every
  manifest variable must appear in `layer.json` `bindings` exactly once — an unbound
  variable is a data error at place time.
- `text` → `textReplacement` on a text layer (the value becomes the layer's whole
  content; `maxChars` is enforced in characters).
- `color` → recolours the bound layer's **solid** fill, shape fill or type colour.
  Gradient/pattern fills and pixel layers refuse with a warning, never clobber — so
  every colour-bound layer here is a solid shape or a text layer.
- `visibility` → the bound layer's visible flag. A hidden-by-default companion layer is
  the §7.3 present-but-hidden pattern; `defaultVisible` in `layer.json` must equal the
  variable's default.
- **Optional text variables encode as empty-string defaults** (the strict `VariableSpec`
  has no `optional` field): see `logo-lockup.tagline`.
- Companion decoration that must *not* track a colour variable is authored
  colour-neutral (translucent wash, fixed ink) so `component.setVars` recolouring stays
  coherent — see `wave-divider`'s mirrored crest and `ribbon-banner`'s tails; comps
  restyle them.

## Layer conventions (§10.1/§10.2)

- Names are semantic, stable, unique inside the group, never `Layer N`. Component
  groups carry the manifest name (`component.place` groups by `m.name`); variant
  layers use the `… — <variant>` pattern (`Wave — mirror`).
- `layers` is the stack **bottom→top**: background plate → decoration → text (§10.1
  z-order sanity). `bounds` are `[x, y, w, h]` integers in the component's design space
  (origin top-left of `defaultSize`; the master document is authored at `defaultSize`).
  Kinds are `text` (font tokens `display`/`sans`, weights, size, lineHeight, align,
  colour) and `shape` (`ellipse | rect | roundedRect | path`, solid fill). Paths may
  hold several subpaths so one visibility variable can drive a compound decoration.
- Fonts are workspace tokens only — no font files ever (§1.5-9). Colours come from the
  studio palette `#F4E7D3 #3B2A20 #6B5748 #D96C3B #FFF7EE` (§7.2 rules.palette). Demo
  identity is synthetic (`Acme Coffee`, `@acme.coffee`, `Main Street Coffee`).

## Versioning

Every component version is immutable: `component.json.version` names the current
master, `<id>@<version>.pcraft` files are append-only, and `id@version` is explicit in
every command log (§7.4 discipline). Instances pin the placed version;
`component.updateInstance` re-pulls the latest master **opt-in per instance** (§8.4).
Bumping a version = add the new master + update the manifest in one change; never
rewrite history.

## §8.4 rules (enforced, not advisory)

- **Instance variables are schema-checked**: unknown variables are errors with the
  allowed list attached (`check_var`/`UnknownVar`); kinds, `maxChars` and colour formats
  are validated, colours canonicalised to `#RRGGBB(AA)`.
- **Placing a component never mutates the master** — `component.place` copies the stack
  with fresh layer ids (smart-object contents stay shared, §8.1); masters change only
  via `component.publish` or authoring flows like this catalog.
- **Updates across instances are opt-in** — never silently restyle a user's document.
- **License on every component**; public components must be created by us or
  clean-room reproduced with `ATTRIBUTION.md` rows when third-party-inspired. All ten
  here are clean-room studio originals (synthetic demo identity, no third-party art).

## The library

| id@version | defaultSize | variables (kind) | anchors | comps |
|---|---|---|---|---|
| offer-badge@2 | 180×180 | label (text 12), bg, textColor, showRibbon | center, topRight, bottomLeft | default, light, dark |
| logo-lockup@1 | 320×96 | name (text 32), tagline (text 48, optional), color, onDark | left, center, topRight, bottomRight | default, light, dark |
| star-rating@1 | 240×48 | stars (text 3), color | left, center, right | default, light, dark |
| price-tag@1 | 200×120 | price (text 10), currency (text 3), bg, textColor | topLeft, topRight, bottomRight | default, light, dark |
| button-cta@1 | 240×64 | label (text 24), bg, textColor, rounded | left, center, right | default, light, dark |
| quote-block@1 | 640×320 | quote (text 280), author (text 48), accent | topLeft, center, bottomLeft | default, light, dark |
| avatar-circle@1 | 96×96 | initials (text 3), bg, textColor | topLeft, center, bottomRight | default, light, dark |
| wave-divider@1 | 600×80 | color, flip | top, center, bottom | default, light, dark |
| ribbon-banner@1 | 420×96 | label (text 16), bg, textColor, corner | topLeft, top, center, bottomRight | default, light, dark |
| social-handle@1 | 280×48 | handle (text 30), color, showIcon | left, center, right | default, light, dark |

`offer-badge@2` reproduces the §7.2/§8.2 example verbatim (vars, `defaultSize`,
anchors, comps) and is the §7.2 `instagram-post` template's `badge` slot target
(`offer-badge@2` + `vars.label`). Comps are the master's layer comps (`layerComp.*`,
§8.1) — every component ships `default` plus `light` and `dark` alternatives; the
per-comp restyles are described in each `layer.json`.
