# facebook-cover@1 — synthetic demo assets (fixture generator spec)

Spec §7.4: every template ships a synthetic demo asset + a golden render. **No binary files are
committed** — the eval fixture generator materializes the PNGs below at test/CI time into
`evals/fixtures/assets/` (deterministic, no network, no randomness — `evals/fixtures/README.md`
rules). **No font files ever** (`CRAFT_FONTS_DIR`); text layers resolve fonts from the workspace
registry at render time.

## photo (slot `photo`, bounds [0, 0, 820, 312] full-bleed, `fit: cover`, `minPixels` [820, 312])

Generate `asset_photo_820x312.png`, 820×312 RGB, opaque:

- Diagonal linear gradient from `#101418` (top-left, canvas background colour) to `#D96C3B`
  (bottom-right, accent): `t = (x + y) / (819 + 311)`; `c = lerp(#101418, #D96C3B, t)` per pixel,
  sRGB channel-wise. `cover` fit with a same-size asset = no crop, so the gradient corners
  anchor the similarity check.
- Deterministic structure: two opaque `#FFFFFF` rectangles at 20% screen blend —
  `x ∈ [64, 192), y ∈ [144, 240)` and `x ∈ [208, 272), y ∈ [144, 240)` (echoes of the headline
  block, left-safe). Thresholded, no anti-aliasing needed.
- The headline/logo slots sit in the left band that survives Facebook's mobile crop; the
  gradient's dark end (where the white headline lives) keeps the §11.1 pixel contrast check
  above 4.5:1 in practice.

PNG encoding: any pure-Node zero-dependency writer (manual IHDR/IDAT/IEND chunks + `zlib`
deflate, 8-bit RGB, no interlace). Fixed filter byte 0 per scanline.

## logo (slot `logo`, bounds [48, 48, 64, 64], optional, `fit: contain`)

Generate `asset_logo_128x128.png`, 128×128 RGBA (2× the slot box for crisp `contain` fit):

- Transparent background.
- A wordmark bar: horizontal gradient `#FFFFFF` → `#D96C3B` across the middle band
  `y ∈ [40, 88), x ∈ [8, 120)`, alpha 255 inside the band, 0 outside.

## Golden render

`template.apply facebook-cover@1` + `template.fill` with the assets above → render once, store
as the golden under `evals/fixtures/renders/facebook-cover@1/` per `evals/fixtures/README.md`
(downscaled ≤ 1024 px, §5.4; perceptual distance, never pixel equality, §11.4). **Wave 7 wires
rendering** — nothing here renders at fixture-generation time.

## License note

These assets are authored programmatically by this repo (synthetic, no PII, no third-party
source), so they carry no ATTRIBUTION.md row; any *real* asset placed under `evals/fixtures/`
must add one in the same change (§1.5 constraint 9).
