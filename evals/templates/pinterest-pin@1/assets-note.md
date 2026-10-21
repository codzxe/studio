# pinterest-pin@1 — synthetic demo assets (fixture generator spec)

Spec §7.4: every template ships a synthetic demo asset + a golden render. **No binary files are
committed** — the eval fixture generator materializes the PNGs below at test/CI time into
`evals/fixtures/assets/` (deterministic, no network, no randomness — `evals/fixtures/README.md`
rules). **No font files ever** (`CRAFT_FONTS_DIR`); text layers resolve fonts from the workspace
registry at render time.

## photo (slot `photo`, bounds [0, 0, 1000, 900] — top 60%, `fit: cover`, `minPixels` [1000, 900])

Generate `asset_photo_1000x900.png`, 1000×900 RGB, opaque:

- Vertical linear gradient from `#FFF7EE` (top, canvas background colour) to `#D96C3B`
  (bottom, accent): `t = y / 899`; `c = lerp(#FFF7EE, #D96C3B, t)` per pixel, sRGB channel-wise.
- Deterministic food-plate structure so the similarity gate has edges to see: three opaque
  circles of `#3B2A20` at 25% screen blend, centres `(250, 260) r=120`, `(500, 450) r=150`,
  `(750, 300) r=110` (a stylized plate/ingredient trio). Thresholded circle membership is fine
  (no anti-aliasing required).

PNG encoding: any pure-Node zero-dependency writer (manual IHDR/IDAT/IEND chunks + `zlib`
deflate, 8-bit RGB, no interlace). Fixed filter byte 0 per scanline. Byte-identical across runs
on the same zlib build is nice but not required — the golden gate compares renders, not asset
bytes.

## footer (slot `footer`, `component: social-handle@1`, bounds [64, 1380, 280, 48], optional)

No raster asset: the component placeholder group is instantiated from the component registry by
`component.place` (vars `{ "handle": "@acme.kitchen" }` — 13 chars, within the component's
30-char `handle` variable; its default `color` #3B2A20 and `showIcon` true stand). If a fixture
case needs a rendered footer before the component registry ships, generate
`asset_footer_280x48.png` (280×48 RGBA): solid `#3B2A20` rounded bar (corner radius 8,
thresholded) across `y ∈ [8, 40), x ∈ [0, 280)`, transparent elsewhere.

## Golden render

`template.apply pinterest-pin@1` + `template.fill` with the assets above → render once, store as
the golden under `evals/fixtures/renders/pinterest-pin@1/` per `evals/fixtures/README.md`
(downscaled ≤ 1024 px, §5.4; perceptual distance, never pixel equality, §11.4). **Wave 7 wires
rendering** — nothing here renders at fixture-generation time.

## License note

These assets are authored programmatically by this repo (synthetic, no PII, no third-party
source), so they carry no ATTRIBUTION.md row; any *real* asset placed under `evals/fixtures/`
must add one in the same change (§1.5 constraint 9).
