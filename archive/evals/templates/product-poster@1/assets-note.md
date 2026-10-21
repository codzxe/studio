# product-poster@1 — synthetic demo assets (fixture generator spec)

Spec §7.4: every template ships a synthetic demo asset + a golden render. **No binary files are
committed** — the eval fixture generator materializes the PNGs below at test/CI time into
`evals/fixtures/assets/` (deterministic, no network, no randomness — `evals/fixtures/README.md`
rules). **No font files ever** (`CRAFT_FONTS_DIR`); text layers resolve fonts from the workspace
registry at render time.

## dpi → px (the print math)

- 1 in = 25.4 mm exactly; at 300 dpi, 1 mm = 300 / 25.4 = **11.811 px**.
- A4 = 210 × 297 mm → 210 × 11.811 = 2480.31 → **2480 px**; 297 × 11.811 = 3507.87 →
  **3508 px**. Canvas 2480×3508 is A4 at 300 dpi (210 × 297 mm trim).
- `rules.safeArea` 200 px = 200 / 11.811 = **16.9 mm** — every essential slot sits inside it;
  the product photo is inset (440 px = 37.3 mm side margins) and image slots are never
  safe-area-checked anyway (decoration may bleed).

## photo (slot `photo`, bounds [440, 1120, 1600, 1600], `minPixels` [1600, 1600], `fit: cover`)

Generate `asset_photo_1600x1600.png`, 1600×1600 RGB, opaque:

- Vertical linear gradient from `#F4E7D3` (top, canvas background colour) to `#D96C3B`
  (bottom, accent): `t = y / 1599`; `c = lerp(#F4E7D3, #D96C3B, t)` per pixel, sRGB
  channel-wise. A square asset in a square frame means `cover` crops nothing — the gradient
  corners anchor the similarity check.
- Deterministic product echo: one opaque `#3B2A20` circle centred `(800, 800) r=420` at 25%
  screen blend, plus one `#3B2A20` rectangle `x ∈ [520, 1080), y ∈ [1180, 1420)` at 25%
  screen blend (thresholded, no anti-aliasing).

PNG encoding: any pure-Node zero-dependency writer (manual IHDR/IDAT/IEND chunks + `zlib`
deflate, 8-bit RGB, no interlace, fixed filter byte 0 per scanline) — the same recipe the
existing seed notes use.

## price (slot `price`, `component: price-tag@1`, [1050, 3060, 380, 228], optional)

No raster asset: the component placeholder group is instantiated from the component registry
by `component.place` with vars `{ "price": "129", "currency": "$" }` — both are `price-tag@1`'s
declared variables (`price` text 10 chars, `currency` text 3 chars; §7.3 overrides declared
variables only, so `bg`/`textColor` stay at the component's `#FFF7EE`/`#3B2A20` defaults,
which is why both are in `rules.palette`).

Fixture fallback if a case needs a rendered tag before the registry path runs: generate
`asset_pricetag_380x228.png` (380×228 RGBA): `#FFF7EE` rounded plate (corner radius 24,
thresholded) with a `#F4E7D3` punched-hole circle centred `(40, 60) r=20`, transparent
elsewhere (the component's own text layers are placed by the registry, not baked here).

## Golden render

`template.apply product-poster@1` + `template.fill` with the assets above → render once, store
as the golden under `evals/fixtures/renders/product-poster@1/` per `evals/fixtures/README.md`
(downscaled ≤ 1024 px, §5.4; perceptual distance, never pixel equality, §11.4). **Wave 7
wires rendering** — nothing here renders at fixture-generation time.

## License note

These assets are authored programmatically by this repo (synthetic, no PII, no third-party
source), so they carry no ATTRIBUTION.md row; any *real* asset placed under
`evals/fixtures/assets/` must add one in the same change (§1.5 constraint 9).
