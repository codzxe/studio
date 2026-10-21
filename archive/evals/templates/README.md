# evals/templates — template seed data (spec §7.2/§7.4)

The templates, shipped **as data** (no recompile): the three §7.4 starters —
`instagram-post@3`, `youtube-thumbnail@1`, `presentation-slide@1` (§7.4: start with these three,
grow to 10 by beta) — plus the social set v1: `instagram-story@1`, `facebook-cover@1`,
`x-post@1`, `linkedin-banner@1`, `pinterest-pin@1`.
Each template must include a synthetic demo asset and a golden render in the eval fixtures.

## Layout conventions

One directory per pinned template, named `id@version`:

```
evals/templates/<id>@<version>/
  manifest.json    the §7.2 manifest (identity, canvas, slots, rules, layerMap, provenance)
  document.json    the source .pcraft equivalent as JSON — the layer list template.apply
                   hydrates (bottom-to-top, like Document.layers in the engine)
  assets-note.md   the synthetic demo-asset spec for the eval fixture generator
```

The engine's runtime catalog (`PHOTOCRAFT_TEMPLATES_DIR`, `engine-patches/template_cmds/`)
serves `<stem>.json` + `<stem>.pcraft` pairs; the fixture generator materializes each
`document.json` into a `.pcraft` beside a copy of the manifest (and the gradient PNGs from
`assets-note.md` into `evals/fixtures/assets/`) — that is why these files are data, not code.

## manifest.json — the contract

Field names are frozen by the serde types in `engine-patches/template_cmds/manifest.rs`
(`deny_unknown_fields`, camelCase, `kind`-tagged slot union). A manifest that fails its
validation is skipped by the catalog scan, so:

- ids are slugs (lowercase letters, digits, hyphens; no leading/trailing hyphen),
  versions start at 1, `license` ∈ `workspace | public`, hex colours `#rrggbb(/aa)`,
  `fit` ∈ `cover | contain | fill`, `align` ∈ `left | center | right | justify`;
- component references are `id@version` pins (e.g. `offer-badge@2`);
- layer names in slots MUST match `layerMap` keys and the named layers in `document.json`
  exactly — `template.apply`/`template.fill` resolve slots **by layer name**;
- slot `bounds` `[x, y, w, h]` and every geometry number must match `document.json`;
- every `rules.mustLayers` entry must exist as a named layer (`template.inspect` warns
  otherwise);
- keep templates under ~12 slots (§7.5: more is a component's job; 64 is the hard cap).

`instagram-post@3/manifest.json` is the §7.2 manifest reproduced verbatim (with
`"license": "public"`, `"author": "studio"` — the spec's `"workspace | public"` placeholder row
spells the allowed values, and `manifest.rs` only accepts one of them).

## document.json — the .pcraft equivalent

Bottom-to-top layer list (first layer = bottom, as `Document.layers`). Layer `kind` uses the
engine's `kind_name()` spellings: `Fill` (solid colour fill layers carry `fill`),
`Pixel` (image placeholders — `template.fill` replaces the placeholder with the placed image,
never deletes it), `Type` (text layers carry `text`: content/font/weight/size/lineHeight/
color/align), `Group` (component placeholders carry `component: { id, vars }`), plus
`Shape`/`Smart Object`/`Adjustment` if a future template needs them. Optional layers start
`visible: true` in the source document; `template.fill` hides unfilled optional slots
(present but hidden, §7.3 — never delete template layers).

## Versioning rules

- **A version is immutable once shipped.** Fix or change anything → **bump `version`** and add
  a NEW `id@<version+1>/` directory (new manifest + document + assets note). Never edit a
  shipped manifest in place — evals, goldens and pinned runs depend on it.
- `id@version` is always explicit in the command log (§7.4): every `template.apply` reply and
  log line pins the version it ran. `template.list` returns the newest version; older
  versions stay in the catalog for pinned runs.
- Versions start at 1. (`instagram-post` ships at version 3 because §7.2 specifies that
  manifest verbatim; versions 1–2 are intentionally not re-created.)

## Golden renders

Goldens live in `evals/fixtures/renders/<id>@<version>/` (per
`evals/fixtures/README.md`: downscaled ≤ 1024 px, §5.4; §11.4 perceptual distance, never pixel
equality). **Wave 7 wires rendering** — until then these seeds carry only the asset spec
(`assets-note.md`); nothing here generates or commits a render, and a template version bump
re-renders its goldens in one batch.

## License + assets reminder

- `license` rows: `workspace` (private to a workspace) or `public` (catalog-visible). All seed
  templates here are `public`.
- **No binary files committed** — assets are generated at fixture time from `assets-note.md`
  specs (deterministic, synthetic, no PII).
- **No font files, ever** (`CRAFT_FONTS_DIR`, §1.5 constraint 9); templates must not require
  fonts absent from the workspace registry — fail with an install hint (§7.5).
- Repo-authored synthetic assets need no `ATTRIBUTION.md` row; any real third-party asset
  added under `evals/fixtures/assets/` must add one **in the same change** (§1.5 constraint 9).
