# youtube-thumbnail@1 — synthetic demo assets (fixture generator spec)

Spec §7.4: every template ships a synthetic demo asset + a golden render. **No binary files are
committed** — the eval fixture generator materializes the PNGs below at test/CI time into
`evals/fixtures/assets/` (deterministic, no network, no randomness — `evals/fixtures/README.md`
rules). **No font files ever** (`CRAFT_FONTS_DIR`); text layers resolve fonts from the workspace
registry at render time.

## photo (slot `photo`, bounds [0, 0, 1280, 720] full-bleed, `fit: cover`, `minPixels` [1280, 720])

Generate `asset_photo_1280x720.png`, 1280×720 RGB, opaque:

- Diagonal linear gradient from `#101418` (top-left, canvas background colour) to `#E5484D`
  (bottom-right, accent): `t = (x + y) / (1279 + 719)`; `c = lerp(#101418, #E5484D, t)` per
  pixel, sRGB channel-wise. `cover` fit with a same-size asset = no crop, so the gradient
  corners anchor the similarity check.
- Deterministic structure: two opaque `#FFFFFF` rectangles at 20% screen blend —
  `x ∈ [96, 288), y ∈ [480, 672)` and `x ∈ [320, 480), y ∈ [480, 672)` (echoes of the headline
  block, bottom-left). Thresholded, no anti-aliasing needed.

PNG encoding: any pure-Node zero-dependency writer (manual IHDR/IDAT/IEND chunks + `zlib`
deflate, 8-bit RGB, no interlace). Fixed filter byte 0 per scanline.

## badge (slot `badge`, `component: offer-badge@2`, corner [1088, 64, 128, 128], optional)

No raster asset: the component placeholder group is instantiated from the component registry by
`component.place` (vars `{ "label": "NEW" }`). Fixture fallback if the registry has not shipped:
generate `asset_badge_128x128.png` (128×128 RGBA): solid `#E5484D` rounded square (corner
radius 18, thresholded), transparent elsewhere.

## Golden render

`template.apply youtube-thumbnail@1` + `template.fill` with the asset above → render once,
store as the golden under `evals/fixtures/renders/youtube-thumbnail@1/` per
`evals/fixtures/README.md` (downscaled ≤ 1024 px, §5.4; perceptual distance, never pixel
equality, §11.4). **Wave 7 wires rendering** — nothing here renders at fixture-generation time.

## License note

These assets are authored programmatically by this repo (synthetic, no PII, no third-party
source), so they carry no ATTRIBUTION.md row; any *real* asset placed under `evals/fixtures/`
must add one in the same change (§1.5 constraint 9).
