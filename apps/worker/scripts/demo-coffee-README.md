# demo:coffee — the Phase-0 exit demo (§19 / §24.1)

`demo-coffee.mjs` executes the spec's §24.1 coffee-shop promo run END-TO-END
against the mock-engine (`apps/mock-engine`, the W2-F fake of the vendored
engine's headless control server) with **zero dependencies** — bare `node`, no
installs, no network, no model calls. It is the Phase-0 exit demo; W2-J's
`demo-spine.mjs` proved the mechanics, this wraps them in the template run.

§19 Phase 0 exit criteria (VERBATIM):

> `pnpm demo:coffee` produces a valid layered `.pcraft`, a PNG, a critic
> report, and a command log, deterministically, in `local` Compose.

## Run it

```sh
node apps/worker/scripts/demo-coffee.mjs
```

- **spawn mode (default)**: spawns TWO fresh mock-engine children on ephemeral
  ports; pass A keeps the artifacts, pass B is a replay used for the
  determinism assert; exit 0 on success (1 failure, 2 mock-engine missing).
- **connect mode ("local Compose")**: drive an already-running mock-engine
  instead of spawning one:

  ```sh
  MOCK_ENGINE_PORT=7800 MOCK_ENGINE_TOKEN=<64 hex> \
    node apps/worker/scripts/demo-coffee.mjs
  ```

  The replay-hash check needs fresh spawns, so it runs in spawn mode only.
  Connect mode tolerates an engine that already has documents open.

- Optional digest pin (CI hook): `DEMO_COFFEE_EXPECT_SHA256=<hex>` asserts the
  run's replay digest matches a previously recorded one.

## Artifacts — `apps/worker/.demo-output/` (regenerated every run)

| file | what it is |
| --- | --- |
| `coffee-promo.pcraft` | the layered save from `doc.save` (mock snapshot format `studio-mock-engine-snapshot`: 4 layers — Background, Photo, Headline, Subhead — revision 9, text preserved, zero flattening, §25.2). Read back, parsed and asserted by the script. |
| `coffee-promo.png` | the `doc.render {maxSide:1024}` preview; PNG magic bytes verified (the mock always emits its fixed 8×8 gray PNG — no pixels until the real engine lands). |
| `renders/coffee-promo.png` | the engine-side `doc.render {path}` write under the capability root (mock `MOCK_ENGINE_WRITE_ROOT`). |
| `command-log.jsonl` | the command log — 17 append-only rows shaped like the §5.6 WAL (`documentId, seq, commandName, params, revisionBefore, revisionAfter, flag`) plus demo annotations (`ts, kind, trace, stage, probe, error`); revision chain `1→9` asserted monotonic and re-asserted against `doc.inspect` at phase boundaries. |
| `critic-report.json` | the **MOCK CRITIC** report (see below). |
| `assets/asset_photo_1080x700.png` | the photo fixture copied into the run's write root — the repo's generated gradient (`evals/fixtures/generated/instagram-post@3/asset_photo_1080x700.png`, `asset_812`, built per `assets-note.md` by the fixture generator) when present; otherwise a synthetic in-code stand-in with the same spec (1080×700 RGB gradient + three ink circles). The script asserts the fixture is a real PNG at the slot's `minPixels`. |

## What it proves (per §19) — and what is mocked

| §19 requirement | status in this demo |
| --- | --- |
| template applies + fills and saves `.pcraft` + PNG (Phase 0 steps 2) | **proved end-to-end**: the compiled manifest `evals/templates/instagram-post@3/manifest.json` is read at runtime and its canvas/slots/rules drive every command; `template.apply`/`template.fill` are attempted first and refused gracefully by the mock (no `template_cmds.rs` until Phase 2 §2.3), so the apply/fill is **emulated** with the trace's own commands (`doc.place`, `type.create`, `type.edit`) and the exact `template.fill` slot payload is printed. Same for `layer.layerStyle.dropShadow` (not in the mock command set). |
| valid layered `.pcraft` | **proved for the mock**: layer tree, text, background fill, revision all asserted from the saved file. The *format* is the mock's JSON snapshot — a real `.pcraft` comes from the real engine (Phase 1+). |
| a PNG | **proved**: render round-trip + magic bytes. Pixel content is the mock's fixed gray (honest stand-in). |
| a critic report | **mocked, clearly labeled**: `critic-report.json` is a placeholder rubric (`MOCK CRITIC`, 0 model calls — §1.5-6 forbids free-tier LLMs on content, and Phase 0 step 4's vision call is not wired here). Scores mirror §24.1; **contrast is computed** (WCAG 11.19:1 for `#3B2A20` on `#F4E7D3`, ≥ the manifest's `minContrast 4.5`), editability is derived from document state. The §6/§23.3 validator+critic seams (W6 lineage) replace this in later waves. |
| a command log | **proved**: JSONL WAL-shaped rows, printed at the end (§19 step 5). |
| deterministically | **proved, asserted in-process**: the trace runs twice against two fresh engine spawns; `.pcraft`/PNG/critic bytes and timestamp-stripped WAL rows must hash identical (`sha256` printed; stable across runs on the same Node/zlib). AutoFit `96→88pt` is emulated via `edit.transform` because the mock's `type.edit` has no size param. |
| in `local` Compose | **connect mode** drives the Compose mock-engine via `MOCK_ENGINE_PORT`/`MOCK_ENGINE_TOKEN`; artifact paths resolve under that instance's write root. |
| LLM call path (Phase 0 step 3) | **mocked**: the brief→plan/fill JSON is hard-coded from §24.1; no network, no provider. |

The run's phase labels (`plan → apply → place → fill → style → render →
validate → critique → commit → save`) mirror the §24.1 trace; the WAL `stage`
field mirrors the W6-N processor statuses
(`planning/executing/rendering/validating/critiquing/finalizing`). The real
`StudioRunProcessor` pipeline (planner → executor → observer → validator →
critic → repair → settlement) is TypeScript with workspace imports, so like
W2-J the demo drives the same SEQUENCE directly against the protocol instead
of importing it.

## Notes for other owners (do NOT hand to this script's owner)

1. **package.json wiring** — to make the literal §19 command work, the
   `apps/worker/package.json` owner adds to `scripts`:

   ```json
   "demo:coffee": "node scripts/demo-coffee.mjs"
   ```

   (next to the existing `"demo:spine"`; this file intentionally does not edit
   package.json).

2. **.gitignore** — the output dir must be ignored: add `.demo-output/` to
   `apps/worker/.gitignore` (or the root `.gitignore`). Until then the dir is
   regenerated by each run and should be deleted before any `git-sync.sh`
   (which stages everything); only `*.pcraft` is covered by the root ignore
   today. The script wipes `.demo-output/` at startup, never reads prior state.

3. **Determinism digest** — current replay digest on this box (Node 22, with the
   W7-E generated fixture in place):
   `sha256:e03c017026f379caf04c5cf783f25533e65dec9dd4c799b9bc95b1b094270687`.
   It changes only if the script, the template manifest, the photo fixture, or
   the mock's task-model change — pin it in CI with `DEMO_COFFEE_EXPECT_SHA256`
   if wanted.
