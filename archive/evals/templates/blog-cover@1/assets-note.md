# blog-cover@1 — synthetic demo assets (fixture generator spec)

Spec §7.4: every template ships a synthetic demo asset + a golden render. **No binary files are
committed** — the eval fixture generator materializes the PNGs below at test/CI time into
`evals/fixtures/assets/` (deterministic, no network, no randomness — `evals/fixtures/README.md`
rules). **No font files ever** (`CRAFT_FONTS_DIR`); text layers resolve fonts from the workspace
registry at render time.

This template has **no image slots** — every visual is type or a component instance, so the
fixture generator materializes component fallbacks only.

## badge (slot `badge`, `component: ribbon-banner@1`, bounds [64, 72, 420, 96])

No raster asset: the component placeholder group is instantiated from the component registry by
`component.place` (vars `{ "label": "Design", "bg": "#3B2A20", "textColor": "#FFF7EE",
"corner": true }` — the component's `dark` comp colours, ink band + cream label clearing
`rules.minContrast` 4.5:1 against the declared background). Fixture fallback if the component
registry has not shipped: generate `asset_badge_420x96.png` (420×96 RGBA): solid `#3B2A20` bar
`x ∈ [40, 380)`, `y ∈ [12, 72)` (thresholded rectangle), transparent elsewhere.

## avatar (slot `avatar`, `component: avatar-circle@1`, bounds [688, 480, 96, 96], optional)

No raster asset: the component placeholder group is instantiated from the component registry by
`component.place` (vars `{ "initials": "AC", "bg": "#3B2A20", "textColor": "#FFF7EE" }` — the
component's `dark` comp plate; the initials render from the workspace font registry). Optional
slot: unfilled instances stay present but hidden (§7.3). Fixture fallback if the component
registry has not shipped: generate `asset_avatar_96x96.png` (96×96 RGBA): solid `#3B2A20` circle
(thresholded), transparent elsewhere.

PNG encoding (fallbacks): any pure-Node zero-dependency writer (manual IHDR/IDAT/IEND chunks +
`zlib` deflate, 8-bit RGBA, no interlace). Fixed filter byte 0 per scanline.

## Golden render

`template.apply blog-cover@1` + `template.fill` with the fallbacks above → render once, store as
the golden under `evals/fixtures/renders/blog-cover@1/` per `evals/fixtures/README.md` (downscaled
≤ 1024 px, §5.4; perceptual distance, never pixel equality, §11.4). **Wave 7 wires rendering** —
nothing here renders at fixture-generation time.

## License note

These assets are authored programmatically by this repo (synthetic, no PII, no third-party
source), so they carry no ATTRIBUTION.md row; any *real* asset placed under `evals/fixtures/`
must add one in the same change (§1.5 constraint 9).
