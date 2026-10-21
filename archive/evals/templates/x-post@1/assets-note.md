# x-post@1 — synthetic demo assets (fixture generator spec)

Spec §7.4: every template ships a synthetic demo asset + a golden render. **No binary files are
committed** — the eval fixture generator materializes the PNGs below at test/CI time into
`evals/fixtures/assets/` (deterministic, no network, no randomness — `evals/fixtures/README.md`
rules). **No font files ever** (`CRAFT_FONTS_DIR`); text layers resolve fonts from the workspace
registry at render time.

## photo (slot `photo`, bounds [0, 0, 1600, 900] full-bleed, `fit: cover`, `minPixels` [1600, 900])

Generate `asset_photo_1600x900.png`, 1600×900 RGB, opaque:

- Diagonal linear gradient from `#0A0A0A` (top-left, canvas background colour) to `#1D9BF0`
  (bottom-right, accent): `t = (x + y) / (1599 + 899)`; `c = lerp(#0A0A0A, #1D9BF0, t)` per
  pixel, sRGB channel-wise. `cover` fit with a same-size asset = no crop, so the gradient
  corners anchor the similarity check.
- Deterministic structure: one opaque `#FFFFFF` rectangle at 20% screen blend —
  `x ∈ [320, 1280), y ∈ [340, 560)` (echo of the headline band, centre). Thresholded, no
  anti-aliasing needed.
- The `Scrim` fill layer (document-only, opacity 0.55 over `#0A0A0A`) sits between the photo and
  the headline; it is a live editable layer, NOT an asset and NOT baked into the PNG — that is
  what keeps the white headline above 4.5:1 in the worker's pixel-based §11.1 pass for any photo
  a user places.

PNG encoding: any pure-Node zero-dependency writer (manual IHDR/IDAT/IEND chunks + `zlib`
deflate, 8-bit RGB, no interlace). Fixed filter byte 0 per scanline.

## Golden render

`template.apply x-post@1` + `template.fill` with the asset above → render once, store as the
golden under `evals/fixtures/renders/x-post@1/` per `evals/fixtures/README.md` (downscaled
≤ 1024 px, §5.4; perceptual distance, never pixel equality, §11.4). **Wave 7 wires rendering** —
nothing here renders at fixture-generation time.

## License note

These assets are authored programmatically by this repo (synthetic, no PII, no third-party
source), so they carry no ATTRIBUTION.md row; any *real* asset placed under `evals/fixtures/`
must add one in the same change (§1.5 constraint 9).
