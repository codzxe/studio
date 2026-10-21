# business-card@1 — synthetic demo assets (fixture generator spec)

Spec §7.4: every template ships a synthetic demo asset + a golden render. **No binary files are
committed** — the eval fixture generator materializes the PNGs below at test/CI time into
`evals/fixtures/assets/` (deterministic, no network, no randomness — `evals/fixtures/README.md`
rules). **No font files ever** (`CRAFT_FONTS_DIR`); text layers resolve fonts from the workspace
registry at render time.

## dpi → px (the print math, including the bleed note)

- 1 in = 25.4 mm exactly; at 300 dpi: `px = in × 300`, and 1 mm = 300 / 25.4 = **11.811 px**.
- US trim 3.5 × 2 in → **1050 × 600 px** at 300 dpi.
- Print bleed 3 mm = 3 × 11.811 = **35.43 px per side** (70.9 px for both sides) → a 3.5×2 in
  trim with 3 mm bleed exports at **1121 × 671 px** (1050 + 71, 600 + 71). That bleed box is
  the print shop's export; the canvas below is the working art box.
- The shipped canvas is **1063 × 652 px = 3.543 × 2.173 in = 90.0 × 55.2 mm** at 300 dpi (the
  W7-B brief's pinned figure — the 90×55 mm card stock the EU/JIS market uses; the
  description's "3.5×2 in + 3 mm bleed" note names the US trim the print shop cuts). Resize/
  export to the 1121×671 bleed box is the print flow's job, not the template's.
- `rules.safeArea` 60 px = 60 / 11.811 = **5.08 mm** — every essential slot sits inside it.
  The accent band bleeds off the left edge on purpose: decoration may bleed, and a `color`
  slot is never essential (`validate.rs` `essential_slot`), so the band's full-height crop is
  a design feature, not a violation.

## logo (slot `logo`, bounds [783, 60, 220, 80], optional, `fit: contain`)

Generate `asset_logo_440x160.png`, 440×160 RGBA (2× the slot box for crisp `contain` fit):

- Transparent background.
- A wordmark bar: horizontal gradient `#3B2A20` → `#D96C3B` across the middle band
  `y ∈ [48, 112), x ∈ [16, 424)`, alpha 255 inside the band, 0 outside.

PNG encoding: any pure-Node zero-dependency writer (manual IHDR/IDAT/IEND chunks + `zlib`
deflate, 8-bit RGBA, no interlace, fixed filter byte 0 per scanline) — the same recipe the
existing seed notes use.

## accent (slot `accent`, `kind: color`, layer "Accent Band")

No raster asset: `template.fill` compiles the colour to `layer.fill.solidColor.set` on the
band's solid Fill layer (`fill.rs` `compile_color_slot` requires `LayerContent::Fill(Solid)` —
which is exactly why the seed document models the band as a `Fill` layer). Unfilled, the band
keeps its default `#D96C3B`; a brand recolour fills this slot with a workspace palette token
(§7.5).

## Golden render

`template.apply business-card@1` + `template.fill` with the asset above → render once, store
as the golden under `evals/fixtures/renders/business-card@1/` per `evals/fixtures/README.md`
(downscaled ≤ 1024 px, §5.4; perceptual distance, never pixel equality, §11.4). **Wave 7
wires rendering** — nothing here renders at fixture-generation time.

## License note

These assets are authored programmatically by this repo (synthetic, no PII, no third-party
source), so they carry no ATTRIBUTION.md row; any *real* asset placed under
`evals/fixtures/assets/` must add one in the same change (§1.5 constraint 9).
