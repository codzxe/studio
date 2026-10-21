# email-header@1 — synthetic demo assets (fixture generator spec)

Spec §7.4: every template ships a synthetic demo asset + a golden render. **No binary files are
committed** — the eval fixture generator materializes the PNGs below at test/CI time into
`evals/fixtures/assets/` (deterministic, no network, no randomness — `evals/fixtures/README.md`
rules). **No font files ever** (`CRAFT_FONTS_DIR`); text layers resolve fonts from the workspace
registry at render time.

## background gradient (design note — not a slot)

The banner's background is a **soft vertical gradient**. The §7.2 manifest schema carries a single
solid `canvas.background` (the gradient's base colour) and `deny_unknown_fields` forbids a gradient
field, so the gradient is this documented note: the shipped `Background` layer is a solid `#FFF7EE`
fill (deterministic for `template.validate`'s contrast pass), and the intended finish is
`paint.gradient` on that layer — vertical, `#FFF7EE` (top) → `#F4E7D3` (bottom):
`t = y / 399`; `c = lerp(#FFF7EE, #F4E7D3, t)` per pixel, sRGB channel-wise. If a fixture case
needs it as pixels, generate `asset_bg_1200x400.png` (1200×400 RGB, opaque) from that formula —
plain gradient, no structure.

## logo (slot `logo`, bounds [64, 160, 160, 80] left, `fit: contain`, required)

Generate `asset_logo_320x160.png`, 320×160 RGBA (2× the slot box for crisp `contain` fit):

- Transparent background.
- A wordmark bar: horizontal gradient `#3B2A20` → `#6B5748` across the middle band
  `y ∈ [56, 104)`, `x ∈ [16, 304)`, alpha 255 inside the band, 0 outside.

PNG encoding: any pure-Node zero-dependency writer (manual IHDR/IDAT/IEND chunks + `zlib`
deflate, 8-bit RGB/RGBA, no interlace). Fixed filter byte 0 per scanline. Byte-identical across
runs on the same zlib build is nice but not required — the golden gate compares renders, not asset
bytes.

## cta (slot `cta`, `component: button-cta@1`, bounds [900, 168, 240, 64])

No raster asset: the component placeholder group is instantiated from the component registry by
`component.place` (vars `{ "label": "Read the story", "bg": "#3B2A20", "textColor": "#FFF7EE",
"rounded": true }` — the component's `dark` comp colours, so the instance's label clears
`rules.minContrast` 4.5:1 against the declared background). Fixture fallback if the component
registry has not shipped: generate `asset_cta_480x128.png` (480×128 RGBA, 2× the slot box): solid
`#3B2A20` rounded square (corner radius 64 at 2×, thresholded), transparent elsewhere.

## Golden render

`template.apply email-header@1` + `template.fill` with the assets above (and the `paint.gradient`
note applied to `Background`) → render once, store as the golden under
`evals/fixtures/renders/email-header@1/` per `evals/fixtures/README.md` (downscaled ≤ 1024 px,
§5.4; perceptual distance, never pixel equality, §11.4). **Wave 7 wires rendering** — nothing
here renders at fixture-generation time.

## License note

These assets are authored programmatically by this repo (synthetic, no PII, no third-party
source), so they carry no ATTRIBUTION.md row; any *real* asset placed under `evals/fixtures/`
must add one in the same change (§1.5 constraint 9).
