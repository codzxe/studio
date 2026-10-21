# cafe-menu@1 — synthetic demo assets (fixture generator spec)

Spec §7.4: every template ships a synthetic demo asset + a golden render. **No binary files are
committed** — the eval fixture generator materializes the PNGs below at test/CI time into
`evals/fixtures/assets/` (deterministic, no network, no randomness — `evals/fixtures/README.md`
rules). **No font files ever** (`CRAFT_FONTS_DIR`); text layers resolve fonts from the workspace
registry at render time.

## dpi → px (the print math)

- 1 in = 25.4 mm exactly; at 300 dpi, 1 mm = 300 / 25.4 = **11.811 px**.
- Canvas **1063 × 652 px = 3.543 × 2.173 in = 90.0 × 55.2 mm** at 300 dpi, **landscape**
  (width > height) — the same card-stock box as `business-card@1`, used here as a café
  table/tent card. Print note: a 3.5×2 in trim with 3 mm bleed exports at 1121 × 671 px; the
  canvas is the working art box, and export is the print flow's job.
- `rules.safeArea` 60 px = 60 / 11.811 = **5.08 mm** — header, all six item-name slots and
  the logo sit inside it.

## menu items — the slot/data-set split (per the brief)

- The menu-item pattern is **2 text slots (name + price) per item**; a full data-set page
  drives **4 items per column block**. To keep the manifest within §7.5's ~12-slot cap, this
  starter ships **two item-block groups with 3 items each**: 6 name slots
  (`item1`…`item6`) + `header` + optional `logo` = **8 slots**.
- **Prices are data-set-driven, not template slots** (the brief's "prices via data-set" note,
  mirrored in the manifest description): each item-block group carries six `Type` layers —
  `Item N — Name` (slot-filled by `template.fill`) and `Item N — Price` (filled by the
  workspace data-set merge, so a menu reprice never grows the slot count). The price layers
  are visible text the manifest does not cover, so once they have pixels `template.validate`
  safe-area-checks them too — all six sit inside the 60 px margin by construction.
- The `logo` slot is this template's §7.4 synthetic demo asset (the only image slot); it is
  optional and stays present but hidden when unfilled (§7.3).

## logo (slot `logo`, bounds [471, 548, 120, 40], optional, `fit: contain`)

Generate `asset_logo_240x80.png`, 240×80 RGBA (2× the slot box for crisp `contain` fit):

- Transparent background.
- A wordmark bar: horizontal gradient `#3B2A20` → `#D96C3B` across the middle band
  `y ∈ [24, 56), x ∈ [8, 232)`, alpha 255 inside the band, 0 outside.

PNG encoding: any pure-Node zero-dependency writer (manual IHDR/IDAT/IEND chunks + `zlib`
deflate, 8-bit RGBA, no interlace, fixed filter byte 0 per scanline) — the same recipe the
existing seed notes use.

## document.json note — item-block groups carry children

`Item Block — Left` / `Item Block — Right` are `Group` entries that carry a `layers` array of
children (bottom-to-top, like `Document.layers`): 14 text layers would be well past §10.1's
"~7 loose top-level layers", so the menu ships 5 top-level layers (Background, two item
blocks, Headline, Logo) with the 12 item text layers grouped. Slot layers inside groups
resolve by name through the engine's depth-bounded `walk()` (`template_cmds.rs`
`layer_by_name`). Flagged for the fixture-generator owner: materialize group children into
the `.pcraft` beside flat layers.

## Golden render

`template.apply cafe-menu@1` + `template.fill` with the asset above → render once, store as
the golden under `evals/fixtures/renders/cafe-menu@1/` per `evals/fixtures/README.md`
(downscaled ≤ 1024 px, §5.4; perceptual distance, never pixel equality, §11.4). **Wave 7
wires rendering** — nothing here renders at fixture-generation time.

## License note

These assets are authored programmatically by this repo (synthetic, no PII, no third-party
source), so they carry no ATTRIBUTION.md row; any *real* asset placed under
`evals/fixtures/assets/` must add one in the same change (§1.5 constraint 9).
