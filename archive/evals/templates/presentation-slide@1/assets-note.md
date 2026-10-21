# presentation-slide@1 — synthetic demo assets (fixture generator spec)

Spec §7.4: every template ships a synthetic demo asset + a golden render. **No binary files are
committed** — the eval fixture generator materializes the PNGs below at test/CI time into
`evals/fixtures/assets/` (deterministic, no network, no randomness — `evals/fixtures/README.md`
rules). **No font files ever** (`CRAFT_FONTS_DIR`); text layers resolve fonts from the workspace
registry at render time.

## visual (slot `visual`, bounds [1056, 288, 768, 576] right half, `fit: cover`,
`minPixels` [768, 576], `focal` [0.5, 0.5])

Generate `asset_visual_768x576.png`, 768×576 RGB, opaque:

- Horizontal linear gradient from `#52504B` (left) to `#1A1A1A` (right) — the palette's two
  neutral text colours, so the visual reads "chart-like" against the `#F6F5F2` canvas:
  `t = x / 767`; `c = lerp(#52504B, #1A1A1A, t)` per pixel, sRGB channel-wise.
- Deterministic structure (a bar-chart silhouette): four opaque `#F6F5F2` bars at 100% —
  bar `i ∈ 0..4` at `x = 72 + i·180`, width 96, heights `[168, 288, 216, 360]` from the bottom
  (`y = 576 - h`). Thresholded rectangles, no anti-aliasing needed.

PNG encoding: any pure-Node zero-dependency writer (manual IHDR/IDAT/IEND chunks + `zlib`
deflate, 8-bit RGB, no interlace). Fixed filter byte 0 per scanline.

## logo (slot `logo`, footer bounds [96, 920, 160, 48], optional, `fit: contain`)

Generate `asset_logo_320x96.png`, 320×96 RGBA (2× the slot box for crisp `contain` fit):

- Transparent background.
- A wordmark bar: horizontal gradient `#1A1A1A` → `#52504B` across the middle band
  `y ∈ [32, 64)`, `x ∈ [16, 304)`, alpha 255 inside the band, 0 outside.

## Golden render

`template.apply presentation-slide@1` + `template.fill` with the assets above → render once,
store as the golden under `evals/fixtures/renders/presentation-slide@1/` per
`evals/fixtures/README.md` (downscaled ≤ 1024 px, §5.4; perceptual distance, never pixel
equality, §11.4). **Wave 7 wires rendering** — nothing here renders at fixture-generation time.

## License note

These assets are authored programmatically by this repo (synthetic, no PII, no third-party
source), so they carry no ATTRIBUTION.md row; any *real* asset placed under `evals/fixtures/`
must add one in the same change (§1.5 constraint 9).
