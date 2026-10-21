# evals/fixtures/generator — synthetic fixture generator

Zero-dependency Node generator for the eval fixtures (spec §7.4: every template
ships a synthetic demo asset + a golden render). Everything here is **§21
test-data policy, enforced**: synthetic only, deterministic, no network, no
randomness (`evals/fixtures/README.md` rules). Runs with bare `node` — no
installs, no workspace wiring.

```
evals/fixtures/generator/
  src/generate-assets.mjs   materializes the gradient PNGs from the template
                            assets-notes into evals/fixtures/generated/<id>@<version>/
  src/render-golden.mjs     STUB for the §21 render-similarity goldens (skips
                            gracefully — see "Golden renders" below)
  src/png.mjs               hand-rolled PNG encoder/inspector (IHDR/IDAT/IEND +
                            zlib deflate, 8-bit RGB/RGBA, filter byte 0) — same
                            approach as apps/mock-engine/src/engine.mjs `grayPng()`
  specs/<id>@<version>.json  machine-readable mirror of prose-only assets-notes
                            (see "Spec convention")
```

## Regenerating

```sh
node evals/fixtures/generator/src/generate-assets.mjs                 # all templates
node evals/fixtures/generator/src/generate-assets.mjs instagram-post  # one template
node evals/fixtures/generator/src/generate-assets.mjs --skip-missing-specs  # mid-wave
node evals/fixtures/generator/src/render-golden.mjs                   # stub dry-run
```

Output is byte-deterministic on a given Node/zlib build (same input → same
sha256; gradients are smooth so filter-0 scanlines deflate tiny). The generated
PNGs are **committed** — they ARE fixtures. Regenerate + commit together with any
spec change; CI and local runs must see identical bytes.

## Provenance & licensing

All generated assets are **authored programmatically by this repo**: gradients,
circles, rectangles — synthetic, no PII, no third-party sources. Per the
assets-notes' license note they carry **no `ATTRIBUTION.md` row**.

> **Reminder (§1.5 constraint 9, fixtures README rule 3):** any *non-synthetic*
> asset (public-domain/CC0/MIT-class image) added anywhere under
> `evals/fixtures/` MUST ship with a row in the repo-root `ATTRIBUTION.md`
> (path, title, author/source, license) **in the same change** — and is out of
> scope for this generator; `assets/` is the directory for such hand-placed
> files, `generated/` is only for generator output. **Never commit fonts**
> (`CRAFT_FONTS_DIR`); no `.pcraft` outputs (gitignored).

## Spec convention

Each `evals/templates/<id>@<version>/assets-note.md` is the human spec. The
generator reads it in one of two forms:

1. **Preferred (future notes):** the note carries fenced ```json blocks with
   spec objects (or arrays / `{ "assets": [...] }` wrappers) — the generator
   picks up every object that has a `kind` field:

   ```json
   {"kind":"gradient","file":"asset_photo_1080x700.png","w":1080,"h":700,
    "alpha":false,"from":"#F4E7D3","to":"#D96C3B","axis":"y",
    "shapes":[{"type":"circle","cx":270,"cy":200,"r":140,"color":"#3B2A20",
               "blend":"screen","amount":0.25}]}
   ```

2. **Fallback (the three Wave-7 notes are prose):** the mirror spec lives in
   `specs/<id>@<version>.json` here and **must stay in sync with the note
   prose**. The generator reports which source it used and prints a
   note-coverage diff (assets mentioned in the note but not generated — e.g.
   the conditional badge fallbacks — and vice versa) so drift is visible.

### Gradient spec schema (v1 — strict, unknown fields rejected)

| field | type | meaning |
| --- | --- | --- |
| `kind` | `"gradient"` | only kind today (extend the validator when adding one) |
| `file` | `asset_<name>.png` | output filename, lowercase, no directories |
| `w`, `h` | int 1..20000 | pixel dimensions |
| `alpha` | bool (default `false`) | `false` → 8-bit RGB (PNG color type 2); `true` → RGBA (type 6) |
| `from`, `to` | `#rrggbb` | sRGB endpoints, channel-wise lerp, no gamma |
| `axis` | `"x" \| "y" \| "xy"` | `t = u/(W-1)` · `v/(H-1)` · `(u+v)/((W-1)+(H-1))` — exactly the notes' `y/699`, `x/767`, `(x+y)/(1279+719)` |
| `band` | `{x,y,w,h}` | optional (needs `alpha:true`): RGBA wordmark case — alpha 255 inside the half-open band, 0 outside; the gradient spans the band (band-local `u/v`, clamped) |
| `shapes` | array | optional deterministic structure painted over the gradient |

`shapes` entries: `{type:"circle",cx,cy,r}` · `{type:"rect",x,y,w,h}` ·
`{type:"rrect",x,y,w,h,radius}` — all with `color #rrggbb`,
`blend "normal"|"screen"` (default `normal`), `amount 0..1` (default `1`).
Membership is **thresholded** (integer pixel indices, half-open rectangles, no
anti-aliasing) exactly as the notes allow. Blend math (0..255 sRGB floats,
rounded once): `screen(a,b) = a + b − a·b/255`, then mixed at `amount`:
`out = base + amount·(blended − base)` — e.g. "circles at 25% screen blend".

The shipped specs transcribe their notes 1:1 (the note prose is the human
spec; the mirror is its machine form — the generator prints a note-coverage
diff so drift is visible). Assets a note marks **conditional** — "if a fixture
case needs it", "fallback if the component registry has not shipped" — are
**intentionally NOT generated**: the component registry (`evals/components/`)
has shipped, so those slots render via `component.place`, and the generator
lists every such mention as a note-coverage line. Templates whose notes
generate **no** unconditional asset (linkedin-banner@1, presentation-quote@1,
blog-cover@1) carry an explicit empty mirror `{ "template": …, "assets": [] }`
with a `comment` explaining why — the reviewed form of "no raster assets".
While parallel waves are still landing templates, `--skip-missing-specs`
turns the missing-mirror hard failure into warn+skip (default stays loud so
the fixture set can never silently go incomplete).

## Output & size caps

Emitted into `evals/fixtures/generated/<id>@<version>/` (not gitignored —
binary PNG fixtures are allowed; fonts and `.pcraft` are not). **Commit cap:
≤ 50 KB per PNG.** The generator enforces it: an oversize asset is written for
inspection but the script **exits 1** with the offending file(s) — do NOT
commit in that state; shrink the spec or move the asset out of git. `--allow-oversize`
overrides for local experiments only. Exit codes: `0` ok · `1` oversize ·
`2` usage/spec error (fails loudly, §21).

Current outputs (all deterministic, all ≤ 50 KB):

| template | asset | bytes |
| --- | --- | --- |
| instagram-post@3 | asset_photo_1080x700.png | 7 897 |
| instagram-post@3 | asset_logo_240x80.png | 906 |
| youtube-thumbnail@1 | asset_photo_1280x720.png | 22 864 |
| presentation-slide@1 | asset_visual_768x576.png | 8 031 |
| presentation-slide@1 | asset_logo_320x96.png | 719 |
| instagram-story@1 | asset_photo_1080x1280.png | 10 706 |
| x-post@1 | asset_photo_1600x900.png | 34 364 |
| email-header@1 | asset_logo_320x160.png | 872 |
| facebook-cover@1 | asset_photo_820x312.png | 8 499 |
| facebook-cover@1 | asset_logo_128x128.png | 692 |
| pinterest-pin@1 | asset_photo_1000x900.png | 8 286 |
| web-hero-banner@1 | asset_photo_960x1080.png | 10 001 |

(12 assets, ~111 KiB total. blog-cover@1, linkedin-banner@1 and
presentation-quote@1 generate none — see "Spec convention".)

## Golden renders (§21 render-similarity TODO)

`src/render-golden.mjs` is a **stub** on purpose. The §11.4 gate needs
render-faithful goldens (`template.apply` + `template.fill` → render, downscaled
≤ 1024 px per §5.4, compared by **perceptual distance, never pixel equality**);
the assets-notes line is "**Wave 7 wires rendering**", the similarity-gate wiring
itself is this task's **Wave-10 TODO**. The only engine in-repo today,
`apps/mock-engine`, is deliberately not render-faithful (`doc.render` always
emits a fixed 8×8 gray PNG — "Faked: no pixels"), so the stub:

- **skips gracefully (exit 0)** when the engine module is unavailable — the
  expected CI state until the real render path lands;
- dry-runs the full pipeline when it is available (manifest → `doc.new` at
  canvas size → `doc.place` per asset → `doc.render`), reporting render shape;
- **refuses to write** unless `--write` AND `STUDIO_GOLDEN_ENGINE_FAITHFUL=1`
  are both set, so a fake gray PNG can never poison the similarity gate.

Default golden root is `evals/fixtures/goldens/` (`--out` to change). Note for
the later wave: `evals/fixtures/README.md` (not this generator's file to edit)
documents goldens under `evals/fixtures/renders/<id>@<version>/` — align the
final location with that policy (or `--out evals/fixtures/renders`) when the
real goldens land; flagged in the worklog for that owner.
