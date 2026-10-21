// @ts-check
/**
 * render-golden.mjs — STUB for the §21 render-similarity goldens (§11.4).
 *
 * WHAT GOLDENS WILL BE
 *   Per template@version: `template.apply` + `template.fill` with the synthetic
 *   assets from `evals/fixtures/generated/`, rendered once, stored as the golden
 *   (`assets-note.md` → "Golden render": downscaled ≤ 1024 px, §5.4; §11.4
 *   perceptual distance, NEVER pixel equality).
 *
 * WHY THIS IS A STUB (TODO, later wave — this task's wave-10 TODO; the
 * assets-notes' line is "Wave 7 wires rendering")
 *   The only engine available in-repo today is `apps/mock-engine`, which is
 *   deliberately NOT render-faithful: `doc.render` always emits the same 8×8
 *   gray PNG (engine.mjs header: "Faked: no pixels"; README "What is faked (on
 *   purpose)"). Writing that as a golden would poison the §11.4 similarity
 *   gate, so this script NEVER writes goldens from an engine that has not been
 *   explicitly marked faithful (env `STUDIO_GOLDEN_ENGINE_FAITHFUL=1` + `--write`).
 *
 * WHAT IT DOES TODAY (useful, keeps CI wiring trivial)
 *   - Skips gracefully (exit 0) when the engine module is unavailable — the
 *     expected state in CI until the real render path ships.
 *   - When the engine IS available: dry-runs the full golden pipeline per
 *     template (manifest → doc.new at canvas size → doc.place each generated
 *     asset → doc.render) and reports the render shape, so wiring the real
 *     engine later is a matter of pointing `--engine` at it.
 *
 * USAGE
 *   node evals/fixtures/generator/src/render-golden.mjs [templates…] [--out DIR]
 *        [--engine PATH] [--write]
 *   --out DIR     golden root (default: evals/fixtures/goldens — see README for
 *                 the evals/fixtures/README.md `renders/` policy note)
 *   --engine PATH engine module exporting `MockEngine` (default:
 *                 apps/mock-engine/src/engine.mjs). Pass a real-engine adapter
 *                 here when the render path ships. (`index.mjs` is NOT used —
 *                 importing it starts a TCP server.)
 *   --write       actually write goldens (also requires
 *                 STUDIO_GOLDEN_ENGINE_FAITHFUL=1 as the faithfulness gate)
 *
 * EXIT CODES  0 = dry-run / graceful skip (always, this is a stub) · 2 = usage
 * error. Goldens are never written without the explicit faithfulness gate.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isPng, readPngSize } from "./png.mjs";

const SCRIPT_DIR = dirnameOf(import.meta.url);
const REPO_ROOT = resolve(SCRIPT_DIR, "../../../.."); // src → generator → fixtures → evals → root
const TEMPLATES_DIR = join(REPO_ROOT, "evals/templates");
const GENERATED_DIR = join(REPO_ROOT, "evals/fixtures/generated");
const DEFAULT_ENGINE = join(REPO_ROOT, "apps/mock-engine/src/engine.mjs");
const DEFAULT_OUT = join(REPO_ROOT, "evals/fixtures/goldens");

const PROG = "render-golden";
const log = (/** @type {string} */ s) => process.stdout.write(`${PROG}: ${s}\n`);
const fail = (/** @type {string} */ s) => {
  process.stderr.write(`${PROG}: ERROR ${s}\n`);
  process.exit(2);
};

/** @param {string} url @returns {string} */
function dirnameOf(url) {
  const p = fileURLToPath(url);
  return p.slice(0, p.lastIndexOf("/"));
}

/* ---------------- CLI ---------------- */

const args = process.argv.slice(2);
/** @type {string[]} */ const wanted = [];
/** @type {string | null} */ let outDir = null;
/** @type {string | null} */ let enginePath = null;
let write = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--out") outDir = args[++i] ?? fail("--out needs a directory argument");
  else if (a === "--engine") enginePath = args[++i] ?? fail("--engine needs a module path");
  else if (a === "--write") write = true;
  else if (a.startsWith("--")) fail(`unknown flag \`${a}\``);
  else wanted.push(a);
}
const OUT_ROOT = resolve(REPO_ROOT, outDir ?? DEFAULT_OUT);
const ENGINE_PATH = resolve(REPO_ROOT, enginePath ?? DEFAULT_ENGINE);

/* ---------------- graceful skip #1: nothing generated yet ---------------- */

if (!existsSync(GENERATED_DIR)) {
  log(
    `skip: no generated assets under ${relative(REPO_ROOT, GENERATED_DIR)}/ — ` +
      `run generate-assets.mjs first (nothing to render, nothing written)`,
  );
  process.exit(0);
}
const templates = readdirSync(GENERATED_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((name) => wanted.length === 0 || wanted.some((w1) => name === w1 || name.split("@")[0] === w1))
  .sort();
if (templates.length === 0) {
  log(`skip: no template matches [${wanted.join(", ")}] under ${relative(REPO_ROOT, GENERATED_DIR)}/`);
  process.exit(0);
}

/* ---------------- graceful skip #2: engine unavailable (CI today) ---------------- */

let engineMod;
try {
  engineMod = await import(pathToFileURL(ENGINE_PATH).href);
} catch (err) {
  const reason = err instanceof Error ? (err.code ?? err.message) : String(err);
  log(
    `skip: render engine unavailable at ${relative(REPO_ROOT, ENGINE_PATH)} (${reason}).\n` +
      `  The §21 render-similarity goldens are a later-wave TODO (§11.4 perceptual distance,\n` +
      `  downscaled <= 1024 px per §5.4; assets-notes: "Wave 7 wires rendering"; similarity\n` +
      `  gate wiring is this task's wave-10 TODO). Nothing written — CI stays green.`,
  );
  process.exit(0);
}
const MockEngine = engineMod.MockEngine;
if (typeof MockEngine !== "function") {
  log(
    `skip: ${relative(REPO_ROOT, ENGINE_PATH)} exports no \`MockEngine\` class — the future\n` +
      `  real-engine adapter must export one (or point --engine at a module that does).`,
  );
  process.exit(0);
}

/* ---------------- dry-run the golden pipeline per template ---------------- */

const faithful = process.env.STUDIO_GOLDEN_ENGINE_FAITHFUL === "1";
if (write && !faithful) {
  log(
    `refusing --write: this engine is not marked render-faithful ` +
      `(STUDIO_GOLDEN_ENGINE_FAITHFUL != 1). The mock engine renders a fixed 8×8 gray PNG ` +
      `("Faked: no pixels" — apps/mock-engine/src/engine.mjs); committing that as a golden ` +
      `would poison the §11.4 similarity gate. Dry-run only.`,
  );
}

/** @type {{ tmpl: string, png: Buffer, bytes: number }[]} */ const written = [];
for (const tmpl of templates) {
  const manifestPath = join(TEMPLATES_DIR, tmpl, "manifest.json");
  if (!existsSync(manifestPath)) {
    log(`skip ${tmpl}: no manifest.json under ${relative(REPO_ROOT, TEMPLATES_DIR)}/${tmpl}/`);
    continue;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const canvas = manifest?.canvas;
  if (!canvas || !Number.isInteger(canvas.width) || !Number.isInteger(canvas.height)) {
    log(`skip ${tmpl}: manifest has no integer canvas width/height`);
    continue;
  }
  const assets = readdirSync(join(GENERATED_DIR, tmpl))
    .filter((f) => f.endsWith(".png"))
    .sort();
  if (assets.length === 0) {
    log(`skip ${tmpl}: no PNGs under ${relative(REPO_ROOT, join(GENERATED_DIR, tmpl))}/`);
    continue;
  }

  // asset sanity: real PNGs, note-mandated dimensions baked into the filenames
  const dims = assets.map((f) => {
    const buf = readFileSync(join(GENERATED_DIR, tmpl, f));
    if (!isPng(buf)) fail(`${tmpl}/${f} is not a PNG — regenerate (node …/generate-assets.mjs ${tmpl.split("@")[0]})`);
    return `${f} ${readPngSize(buf).width}×${readPngSize(buf).height}`;
  });

  const engine = new MockEngine();
  engine.handle("doc.new", { name: tmpl, width: canvas.width, height: canvas.height, background: canvas.background });
  for (const f of assets) {
    // relative path from the engine's write root (repo root); mock engine only
    // records the basename as the layer name — it never reads the bytes.
    engine.handle("doc.place", { path: join("evals/fixtures/generated", tmpl, f) });
  }
  const render = engine.handle("doc.render", {});
  const png = Buffer.from(String(render.base64 ?? ""), "base64");
  const size = readPngSize(png);
  log(
    `${tmpl}: pipeline OK (dry) — canvas ${canvas.width}×${canvas.height}, ${assets.length} assets placed ` +
      `[${dims.join(", ")}], render ${size.width}×${size.height} (${png.length} bytes)`,
  );
  if (size.width === 8 && size.height === 8) {
    log(
      `  ↳ 8×8 render = the mock engine's fixed gray PNG — NOT render-faithful; ` +
        `golden intentionally NOT written (see file header TODO)`,
    );
  }
  if (write && faithful) {
    written.push({ tmpl, png, bytes: png.length });
  }
}

if (!write || !faithful) {
  log(
    `dry-run complete, 0 goldens written. TODO (later wave): wire the real engine render path +\n` +
      `  §11.4 perceptual-distance assertions (SSIM/DISTS) in packages/evals; goldens then land under\n` +
      `  ${relative(REPO_ROOT, OUT_ROOT)}/ per this stub's --out (see evals/fixtures/generator/README.md\n` +
      `  for the evals/fixtures/README.md \`renders/\` policy note).`,
  );
} else {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  for (const w of written) {
    const dir = join(OUT_ROOT, w.tmpl);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "golden.png"), w.png);
    log(`${w.tmpl}: wrote ${join(relative(REPO_ROOT, OUT_ROOT), w.tmpl, "golden.png")} (${w.bytes} bytes)`);
  }
  log(`done: ${written.length} goldens written under ${relative(REPO_ROOT, OUT_ROOT)}/`);
}
