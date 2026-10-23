# M8 CLI spike — the worker's `effectcraft-cli` contract

Evidence file for M8 (renders and export). Produced by the W6/M8-E spike
(integrator-run after the dispatch orphaned; binary built + verified 2026-10-23).
Everything below was **verified empirically** on this box against the vendored
pin (`editor/`, v0.13.0, built with rustc 1.99.1 `cargo build --release -p
effectcraft-cli`, wall ~45 min cold, binary 86.5 MB at
`editor/target/release/effectcraft-cli`).

## 1. Binary resolution order (worker)

`EFFECTCRAFT_CLI_PATH` env → else `<repo>/editor/target/release/effectcraft-cli`
if it exists → else `effectcraft-cli` on PATH. The binary is a **build
artifact, never committed** (only the wasm dist is a committed artifact per
D-17); CI/ops rebuild it with the cargo command above (git deps
`craft-pdf`/`craft-docpath` fetch from github).

## 2. The render argv (worker recipe)

```
effectcraft-cli --project <workdir>/project.ecproj render
  --comp <compId> --format <h264|png> --out <workdir>/out.<mp4|png>
  [--fps N] [--start S] [--end S] [--resolution full|half|K] [--quality best|draft]
  --json --progress
```

- v1 maps `mp4` → `--format h264`; `png-seq` → `--format png` (see §5).
- Resolution knobs: `--resolution full|half|third|quarter|<number>` scales the
  comp; the width/height settings in the render settings JSON map to
  `--resolution` factor computed by the worker, or default `full` at the comp's
  native size. Quality: comp quality `draft|good|best` → CLI `--quality
  draft|best` (`good` renders at default/best tier — the CLI has no `good`).
- **Never pass `prores|webm|gif|wav|av1|hevc`** — D-2 gates formats at the API
  before a job exists; ProRes was verified to WORK natively but stays disabled.

## 3. Progress + success + failure surfaces

- stderr (only when NOT a tty): banner line, then zero or more
  `progress <framesDone> <framesTotal> <secondsElapsed> <secondsLeft|->`
  lines (up to ~4/s), then `done: <compName> → <outPath> in <seconds>s`.
  The worker parses lines with the prefix `progress ` (4 space-separated
  numbers) → heartbeat `framesDone/framesTotal`.
- stdout with `--json`: **success** →
  `{"rendered":[{"comp":"<name>","output":"<abs path>","seconds":<wall>}]}`;
  **failure** → `{"error":"<message>"}` + exit 1. The plain `{"error":...}`
  shape is also echoed to stderr without `--json`.
- ⚠️ **Error messages may contain ABSOLUTE PATHS and engine internals** (e.g.
  `<path> is not a project Studio can open: <serde detail>`). Law #1: the
  worker NEVER forwards CLI error text across the API boundary — it maps to
  typed `RENDER_*` codes and stores a sanitized one-line reason.

## 4. Footage hydration — THE critical recipe (spike-proven)

- Projects saved from the **browser** reference footage as `/<asset-name>`
  (the web `path_for` keeps only the last path segment of the virtual
  `/assets/<id>/<name>` path; `sanitizeAssetName` in
  `packages/editor-bridge/src/bridge.ts` defines the name charset).
- **Proof (spike)**: with the stored path `/photo.png` and the real file
  present next to the project, the native render produced the
  MISSING-footage placeholder — byte-identical to rendering with the file
  removed. The leading-slash path does NOT resolve next to the project.
- **Proof (fix)**: rewriting the working copy's footage path `/photo.png` →
  `photo.png` (relative) makes `resolve_footage` (#652) find it next to the
  project; the rendered frame is byte-identical (md5) to the natively-imported
  baseline.
- **Worker recipe** (per job, inside the confined temp dir):
  1. fetch the pinned version's `.ecproj` bytes → write `<workdir>/project.ecproj`;
  2. fetch every manifest asset → write `<workdir>/<sanitized-name>` (the name
     the browser assigned at import);
  3. rewrite the working copy's JSON: every footage item `path` (and every
     `sequence[]` entry) that starts with `/` and has no deeper separator gets
     its leading slash stripped (browser virtual paths are single-segment by
     construction). Deep paths (`/a/b.png`) were never producible by the
     browser surface — leave them untouched and let the job fail honestly with
     `RENDER_PROJECT_INVALID` if they exist;
  4. render. **Never `--save`** (opening + saving rewrites stored paths to
     resolved absolute paths — the stored version bytes must stay untouched
     and the working copy is disposable anyway).
- **Missing assets**: the CLI renders missing footage as a placeholder frame
  and still exits 0 — success alone does NOT prove every referenced asset was
  present. The worker therefore pre-validates the manifest downloads (any
  failure → typed `RENDER_ASSET_MISSING`, job fails before spawning the CLI)
  and writes only manifest-sanctioned files into the confined dir.
- `.ecproj` footage items live in the JSON as `items{...}` with
  `kind:"Footage"` holding `path` + optional `sequence: [paths]` + `missing`.

## 5. PNG sequence output

`--format png --out <dir>/<stem>.png` writes `<stem>_00000.png …
<stem>_<05d>.png` (one per frame, verified 60 files). The worker zips the
directory into `output.zip` (single downloadable artifact, ext `zip`) — the
object key for `png-seq` uses `.zip`.

## 6. Timings on this box (the §M8 exit-criteria reference)

- Demo comp (10.01 s @ 1080p, 29.97 fps, 300 frames, complex layers + audio):
  H.264 MP4 in **59 s** wall (target < 5 min ✓). Output 11.2 MB, ffprobe:
  h264 1920×1080 30000/1001 fps, 10.01 s.
- Small 2 s @ 640×360 comp: 0.3 s per render.

## 7. Misc verified

- `info --json` → project + comp summary (duration, frameRate, size, layers)
  — used by tests, not the render path.
- `file.import` params: `{"paths":[…],"addToComp":true}` — `addToComp` is a
  **bool** adding to the ACTIVE comp.
- Exit codes: 0 success, 1 typed failure; a broken pipe on stdout never kills
  a `run … --save` sequence (upstream guarantee).
- ffmpeg is available on this box (used by nothing in the worker — the CLI
  encodes natively via its own encoders: x264-style H.264, ProRes, AV1, WebM).
