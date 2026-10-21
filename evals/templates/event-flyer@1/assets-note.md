# event-flyer@1 — synthetic demo assets (fixture generator spec)

Spec §7.4: every template ships a synthetic demo asset + a golden render. **No binary files are
committed** — the eval fixture generator materializes the PNGs below at test/CI time into
`evals/fixtures/assets/` (deterministic, no network, no randomness — `evals/fixtures/README.md`
rules). **No font files ever** (`CRAFT_FONTS_DIR`); text layers resolve fonts from the workspace
registry at render time.

## dpi → px (the print math)

- 1 in = 25.4 mm exactly; at 300 dpi, 1 mm = 300 / 25.4 = **11.811 px**.
- A5 = 148 × 210 mm → 148 × 11.811 = 1748.03 → **1748 px**; 210 × 11.811 = 2480.31 →
  **2480 px**. Canvas 1748×2480 is A5 at 300 dpi (148 × 210 mm trim).
- `rules.safeArea` 150 px = 150 / 11.811 = **12.7 mm (0.5 in)** — every essential slot sits
  inside it. The photo is inset by the same margin and the footer strip runs full-bleed width
  on purpose: decoration may bleed, `template.validate` safe-areas essential slots only
  (text, component and brand-role image slots).

## photo (slot `photo`, bounds [150, 150, 1448, 980], `minPixels` [1448, 980], `fit: cover`)

Generate `asset_photo_1448x980.png`, 1448×980 RGB, opaque:

- Vertical linear gradient from `#F4E7D3` (top, canvas background colour) to `#D96C3B`
  (bottom, accent): `t = y / 979`; `c = lerp(#F4E7D3, #D96C3B, t)` per pixel, sRGB
  channel-wise.
- Deterministic structure so the §11.4 perceptual gate has edges to see: three opaque
  circles of `#3B2A20` at 25% screen blend, centres `(360, 240) r=200`, `(724, 480) r=250`,
  `(1090, 300) r=170`. Thresholded circle membership, no anti-aliasing — fully deterministic.

PNG encoding: any pure-Node zero-dependency writer (manual IHDR/IDAT/IEND chunks + `zlib`
deflate, 8-bit RGB, no interlace, fixed filter byte 0 per scanline) — the same recipe the
existing seed notes use. Byte-identical output is nice, not required: the golden gate compares
renders, not asset bytes.

## badge (slot `badge`, `component: qr-code@1`, corner [1168, 1690, 430, 430], optional)

No raster asset while the registry ships the component: the placeholder group is instantiated
from the component registry by `component.place`. **Registry flag:** `evals/components/` has
no `qr-code` master yet — this slot pins `qr-code@1` so the manifest validates today
(`manifest.rs` `parse_pin` checks pin format only), and `template.fill` will refuse the
placement with the registry's candidate list (`fill.rs` `guard_component`) until a
components-program change ships `qr-code@1` to the components root. No `vars` are declared
here on purpose: the QR payload binds at fill time through the component's **declared**
variables (§7.3 — override declared variables only), so inventing keys now would guarantee
unknown-var errors later (§8.4).

Fixture fallback until the registry ships: generate `asset_badge_430x430.png` (430×430 RGBA):
`#FFF7EE` quiet-zone plate (24 px border on every side), then a 21×21 module grid (module
⌊430/21⌋ = 20 px) with modules `#3B2A20` where `((i·i + 3·j·j + i·j) mod 5) < 2`, plus the
three 7×7 QR finder patterns at top-left, top-right, bottom-left (7×7 dark ring, 5×5 light
ring, 3×3 dark core, thresholded). Deterministic — no randomness, a real encoder is never
needed for the fixture.

## Golden render

`template.apply event-flyer@1` + `template.fill` with the assets above → render once, store
as the golden under `evals/fixtures/renders/event-flyer@1/` per `evals/fixtures/README.md`
(downscaled ≤ 1024 px, §5.4; perceptual distance, never pixel equality, §11.4). **Wave 7
wires rendering** — nothing here renders at fixture-generation time.

## document.json note — first structural group in the seed set

The flyer carries the seed set's first **structural group**: `Content` holds the four text
layers (`Headline`, `Subhead — Date`, `Body — Venue`, `Caption — Footer`), bottom-to-top like
`Document.layers` (§10.1 "group before you multiply": 8 loose top-level layers → 5 top-level +
grouped text). A `Group` entry may therefore carry a `layers` array of children, each child
shaped exactly like a top-level layer; slot layers inside groups resolve by name through the
engine's depth-bounded `walk()` (`template_cmds.rs` `layer_by_name`). Flagged for the
fixture-generator owner: materialize group children into the `.pcraft` beside flat layers.

## License note

These assets are authored programmatically by this repo (synthetic, no PII, no third-party
source), so they carry no ATTRIBUTION.md row; any *real* asset placed under
`evals/fixtures/assets/` must add one in the same change (§1.5 constraint 9).
