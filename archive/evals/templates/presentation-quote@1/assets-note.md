# presentation-quote@1 — synthetic demo assets (fixture generator spec)

Spec §7.4: every template ships a synthetic demo asset + a golden render. **No binary files are
committed** — the eval fixture generator materializes the PNGs below at test/CI time into
`evals/fixtures/assets/` (deterministic, no network, no randomness — `evals/fixtures/README.md`
rules). **No font files ever** (`CRAFT_FONTS_DIR`); text layers resolve fonts from the workspace
registry at render time.

This template has **no image slots** — the slide is two text slots, one component instance and
the background, so the fixture generator materializes a component fallback only. The palette is
deliberately minimal: three colours (`#FFF7EE` canvas, `#3B2A20` quote + wave, `#6B5748`
attribution).

## divider (slot `divider`, `component: wave-divider@1`, bounds [160, 848, 900, 120])

No raster asset: the component placeholder group is instantiated from the component registry by
`component.place` (vars `{ "color": "#3B2A20", "flip": false }` — the primary crest in ink on the
cream canvas, mirror crest left hidden). Fixture fallback if the component registry has not
shipped: generate `asset_divider_900x120.png` (900×120 RGBA, the slot's exact box): a thresholded
ink wave band — for each column `x`, fill `y ∈ [crest(x), 120)` with `#3B2A20` where
`crest(x) = 24 + 24 · cos(2π · x / 300)` (alpha 255 inside, 0 above), no anti-aliasing required.

PNG encoding (fallback): any pure-Node zero-dependency writer (manual IHDR/IDAT/IEND chunks +
`zlib` deflate, 8-bit RGBA, no interlace). Fixed filter byte 0 per scanline.

## Golden render

`template.apply presentation-quote@1` + `template.fill` with the fallback above → render once,
store as the golden under `evals/fixtures/renders/presentation-quote@1/` per
`evals/fixtures/README.md` (downscaled ≤ 1024 px, §5.4; perceptual distance, never pixel
equality, §11.4). **Wave 7 wires rendering** — nothing here renders at fixture-generation time.

## License note

These assets are authored programmatically by this repo (synthetic, no PII, no third-party
source), so they carry no ATTRIBUTION.md row; any *real* asset placed under `evals/fixtures/`
must add one in the same change (§1.5 constraint 9).
