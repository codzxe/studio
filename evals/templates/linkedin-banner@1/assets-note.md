# linkedin-banner@1 — synthetic demo assets (fixture generator spec)

Spec §7.4: every template ships a synthetic demo asset + a golden render. **No binary files are
committed** — the eval fixture generator materializes the PNGs below at test/CI time into
`evals/fixtures/assets/` (deterministic, no network, no randomness — `evals/fixtures/README.md`
rules). **No font files ever** (`CRAFT_FONTS_DIR`); text layers resolve fonts from the workspace
registry at render time.

## No raster slots — the demo asset is the demo fill values

This template has no image slots: its three slots are two text slots (`name`, `title`) and one
colour slot (`accent` — a Solid Color Fill layer, compiled by `template.fill` to
`layer.fill.solidColor.set`). §7.4's "synthetic demo asset" is therefore satisfied by the
synthetic demo *slot values* below, and **no PNG is generated** for this template:

- `name`    → `"Riley Acme"` (obviously-fake demo identity per `evals/fixtures/README.md` —
  no PII, RFC-2606-class naming)
- `title`   → `"Principal Designer, Acme Coffee"`
- `accent`  → `"#0A66C2"` (template default; the eval fill may use the workspace brand token)

The workspace font registry supplies `display`/`sans` at render time — the fixture generator
must NOT synthesize font files (§1.5-9).

If the fixtures owner later prefers a raster demo asset for uniformity, the sanctioned addition
is an optional logo slot in a `linkedin-banner@2/` directory (versions are immutable — §7.4
versioning; never edit a shipped manifest in place).

## Golden render

`template.apply linkedin-banner@1` + `template.fill` with the demo values above → render once,
store as the golden under `evals/fixtures/renders/linkedin-banner@1/` per
`evals/fixtures/README.md` (downscaled ≤ 1024 px, §5.4; perceptual distance, never pixel
equality, §11.4). **Wave 7 wires rendering** — nothing here renders at fixture-generation time.

## License note

These assets are authored programmatically by this repo (synthetic, no PII, no third-party
source), so they carry no ATTRIBUTION.md row; any *real* asset placed under `evals/fixtures/`
must add one in the same change (§1.5 constraint 9).
