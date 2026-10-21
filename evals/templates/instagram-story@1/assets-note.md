# instagram-story@1 — synthetic demo assets (fixture generator spec)

Spec §7.4: every template ships a synthetic demo asset + a golden render. **No binary files are
committed** — the eval fixture generator materializes the PNGs below at test/CI time into
`evals/fixtures/assets/` (deterministic, no network, no randomness — `evals/fixtures/README.md`
rules). **No font files ever** (`CRAFT_FONTS_DIR`); text layers resolve fonts from the workspace
registry at render time.

The story shares its slots with `instagram-post@3` (photo/headline/subhead), so the
`packages/evals` `resize-story` case can reapply it as the smallest path (§23.2).

## photo (slot `photo`, bounds [0, 0, 1080, 1280] — top two-thirds, `fit: cover`, `minPixels` [1080, 1280])

Generate `asset_photo_1080x1280.png`, 1080×1280 RGB, opaque:

- Vertical linear gradient from `#FFF7EE` (top, canvas background colour) to `#D96C3B`
  (bottom, accent): `t = y / 1279`; `c = lerp(#FFF7EE, #D96C3B, t)` per pixel, sRGB channel-wise.
- Deterministic structure so the similarity gate has edges to see: three opaque circles of
  `#3B2A20` at 25% screen blend, centres `(270, 340) r=150`, `(540, 640) r=180`,
  `(810, 380) r=130`. Thresholded circle membership is fine (no anti-aliasing required).

PNG encoding: any pure-Node zero-dependency writer (manual IHDR/IDAT/IEND chunks + `zlib`
deflate, 8-bit RGB, no interlace). Fixed filter byte 0 per scanline. Byte-identical across runs
on the same zlib build is nice but not required — the golden gate compares renders, not asset
bytes.

## swipeUp (slot `swipeUp`, `component: offer-badge@2`, bounds [816, 1648, 136, 136], optional)

No raster asset: the component placeholder group is instantiated from the component registry by
`component.place` (vars `{ "label": "SWIPE UP" }` — 8 chars, within the badge's 12-char
`label` variable). If a fixture case needs a rendered badge before the component registry ships,
generate `asset_badge_136x136.png` (136×136 RGBA): solid `#D96C3B` circle (centre 68,68, radius
62, thresholded), transparent elsewhere.

## Golden render

`template.apply instagram-story@1` + `template.fill` with the assets above → render once, store
as the golden under `evals/fixtures/renders/instagram-story@1/` per `evals/fixtures/README.md`
(downscaled ≤ 1024 px, §5.4; perceptual distance, never pixel equality, §11.4). **Wave 7 wires
rendering** — nothing here renders at fixture-generation time.

## License note

These assets are authored programmatically by this repo (synthetic, no PII, no third-party
source), so they carry no ATTRIBUTION.md row; any *real* asset placed under `evals/fixtures/`
must add one in the same change (§1.5 constraint 9).
