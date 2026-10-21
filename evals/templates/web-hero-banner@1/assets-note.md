# web-hero-banner@1 — synthetic demo assets (fixture generator spec)

Spec §7.4: every template ships a synthetic demo asset + a golden render. **No binary files are
committed** — the eval fixture generator materializes the PNGs below at test/CI time into
`evals/fixtures/assets/` (deterministic, no network, no randomness — `evals/fixtures/README.md`
rules). **No font files ever** (`CRAFT_FONTS_DIR`); text layers resolve fonts from the workspace
registry at render time.

## crop-safe band (design note — not a slot)

The hero is authored 1920×1080, but web heroes are commonly cropped to the middle **1920×600 band
(`y ∈ [240, 840)`)**. Every essential slot (`headline` [96, 320, 744, 240], `subhead`
[96, 592, 640, 104], `cta` [96, 728, 240, 64]) sits inside that band and inside `rules.safeArea`
96, so a band crop keeps all the copy; the `photo` slot is decorative (role `photo`) and may bleed
the full canvas. The golden-render assertions should check band containment for the three
essential slots.

## photo (slot `photo`, bounds [960, 0, 960, 1080] right half, `fit: cover`, `minPixels` [960, 1080], `focal` [0.5, 0.5])

Generate `asset_photo_960x1080.png`, 960×1080 RGB, opaque:

- Vertical linear gradient from `#6B5748` (top) to `#F4E7D3` (bottom) — the palette's warm
  neutrals, so the right half reads like a lit lifestyle shot against the `#101418` canvas:
  `t = y / 1079`; `c = lerp(#6B5748, #F4E7D3, t)` per pixel, sRGB channel-wise.
- Deterministic structure so the similarity gate has edges to see: three opaque `#101418` circles
  at 20% screen blend, centres `(240, 270) r=140`, `(480, 540) r=170`, `(720, 810) r=120`.
  No anti-aliasing required (thresholded circle membership is fine and fully deterministic).

PNG encoding: any pure-Node zero-dependency writer (manual IHDR/IDAT/IEND chunks + `zlib`
deflate, 8-bit RGB, no interlace). Fixed filter byte 0 per scanline. Byte-identical across runs
on the same zlib build is nice but not required — the golden gate compares renders, not asset
bytes.

## cta (slot `cta`, `component: button-cta@1`, bounds [96, 728, 240, 64])

No raster asset: the component placeholder group is instantiated from the component registry by
`component.place` (vars `{ "label": "Start free trial", "bg": "#FFF7EE", "textColor": "#101418",
"rounded": true }` — an inverted cream-on-dark CTA, so the instance's label clears
`rules.minContrast` 4.5:1). Fixture fallback if the component registry has not shipped: generate
`asset_cta_720x192.png` (720×192 RGBA, 3× the slot box): solid `#FFF7EE` rounded square (corner
radius 96 at 3×, thresholded), transparent elsewhere.

## Golden render

`template.apply web-hero-banner@1` + `template.fill` with the assets above → render once, store
as the golden under `evals/fixtures/renders/web-hero-banner@1/` per `evals/fixtures/README.md`
(downscaled ≤ 1024 px, §5.4; perceptual distance, never pixel equality, §11.4). **Wave 7 wires
rendering** — nothing here renders at fixture-generation time.

## License note

These assets are authored programmatically by this repo (synthetic, no PII, no third-party
source), so they carry no ATTRIBUTION.md row; any *real* asset placed under `evals/fixtures/`
must add one in the same change (§1.5 constraint 9).
