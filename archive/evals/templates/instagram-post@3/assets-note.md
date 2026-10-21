# instagram-post@3 — synthetic demo assets (fixture generator spec)

Spec §7.4: every template ships a synthetic demo asset + a golden render. **No binary files are
committed** — the eval fixture generator materializes the PNGs below at test/CI time into
`evals/fixtures/assets/` (deterministic, no network, no randomness — `evals/fixtures/README.md`
rules). **No font files ever** (`CRAFT_FONTS_DIR`); text layers resolve fonts from the workspace
registry at render time.

## photo (slot `photo`, bounds [0, 0, 1080, 700], `minPixels` [1080, 700])

Generate `asset_photo_1080x700.png`, 1080×700 RGB, opaque:

- Vertical linear gradient from `#F4E7D3` (top, canvas background colour) to `#D96C3B`
  (bottom, accent): `t = y / 699`; `c = lerp(#F4E7D3, #D96C3B, t)` per pixel, sRGB channel-wise.
- Deterministic structure so Wave 7's perceptual-similarity gate has edges to see: three
  opaque circles of `#3B2A20` at 25% screen blend, centres `(270, 200) r=140`,
  `(540, 400) r=170`, `(810, 230) r=120`. No anti-aliasing required (thresholded circle
  membership is fine and fully deterministic).

PNG encoding: any pure-Node zero-dependency writer (manual IHDR/IDAT/IEND chunks + `zlib`
deflate, 8-bit RGB, no interlace). Fixed filter byte 0 per scanline. Byte-identical across runs
on the same zlib build is nice but not required — the golden gate compares renders, not asset
bytes.

## logo (slot `logo`, bounds [888, 984, 120, 40], optional, `fit: contain`)

Generate `asset_logo_240x80.png`, 240×80 RGBA (2× the slot box for crisp `contain` fit):

- Transparent background.
- A wordmark bar: horizontal gradient `#3B2A20` → `#D96C3B` across the middle band
  `y ∈ [24, 56)`, `x ∈ [8, 232)`, alpha 255 inside the band, 0 outside.

## badge (slot `badge`, `component: offer-badge@2`)

No raster asset: the component placeholder group is instantiated from the component registry by
`component.place` (vars `{ "label": "20% OFF" }`). If a fixture case needs a rendered badge
before the component registry ships, generate `asset_badge_180x180.png` (180×180 RGBA):
solid `#D96C3B` rounded square (corner radius 24, thresholded), transparent elsewhere.

## Golden render

`template.apply instagram-post@3` + `template.fill` with the assets above → render once, store
as the golden under `evals/fixtures/renders/instagram-post@3/` per `evals/fixtures/README.md`
(downscaled ≤ 1024 px, §5.4; perceptual distance, never pixel equality, §11.4). **Wave 7 wires
rendering** — nothing here renders at fixture-generation time.

## License note

These assets are authored programmatically by this repo (synthetic, no PII, no third-party
source), so they carry no ATTRIBUTION.md row; any *real* asset placed under `evals/fixtures/`
must add one in the same change (§1.5 constraint 9).
