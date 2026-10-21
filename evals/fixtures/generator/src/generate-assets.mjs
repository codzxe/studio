// @ts-check
/**
 * generate-assets.mjs — the eval fixture generator (§7.4 synthetic demo assets).
 *
 * Zero dependencies (pure Node built-ins, PNG encoding hand-rolled in ./png.mjs
 * per the mock-engine precedent — no installs, `evals/fixtures/README.md` rules:
 * deterministic, no network, no randomness).
 *
 * WHAT IT DOES
 *   Reads every `evals/templates/<id>@<version>/assets-note.md` and materializes the
 *   synthetic demo PNGs described there into `evals/fixtures/generated/<id>@<version>/`.
 *   Generated PNGs ARE fixtures (small, synthetic, deterministic): they are
 *   committed to git — unlike fonts (never) or `.pcraft` (ignored).
 *
 * SPEC CONVENTION (documented fully in ../README.md)
 *   1. PREFERRED: the assets-note carries one or more fenced ```json blocks
 *      containing spec objects (or arrays of them), e.g.
 *        {"kind":"gradient","file":"asset_photo_1080x700.png","w":1080,"h":700,
 *         "alpha":false,"from":"#F4E7D3","to":"#D96C3B","axis":"y","shapes":[…]}
 *   2. FALLBACK: the note is prose-only (the three Wave-7 notes are) → the
 *      machine-readable mirror lives in ../specs/<id>@<version>.json and MUST
 *      stay in sync with the note prose (the generator reports the source it
 *      used and warns about assets mentioned in the note but not generated).
 *
 * USAGE
 *   node evals/fixtures/generator/src/generate-assets.mjs [templates…] [flags]
 *   templates   optional slugs ("instagram-post" or "instagram-post@3"); default: all
 *   --out DIR   output root (default: evals/fixtures/generated)
 *   --allow-oversize       do not fail when an asset exceeds the 50 KB commit cap
 *   --skip-missing-specs  warn + skip templates whose note has no spec yet
 *                          (mid-wave escape hatch; default is a loud failure so the
 *                          fixture set can never silently go incomplete)
 *
 * EXIT CODES  0 = ok · 1 = size-cap violation (asset still written — do NOT
 * commit it) · 2 = usage / spec error. Fails loudly, per §21 "fails loudly with
 * a message that says what to do".
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { encodePng } from "./png.mjs";

const SCRIPT_DIR = dirnameOf(import.meta.url);
const REPO_ROOT = resolve(SCRIPT_DIR, "../../../.."); // src → generator → fixtures → evals → root
const TEMPLATES_DIR = join(REPO_ROOT, "evals/templates");
const SPECS_DIR = resolve(SCRIPT_DIR, "..", "specs");
const DEFAULT_OUT = join(REPO_ROOT, "evals/fixtures/generated");
const MAX_COMMIT_BYTES = 50 * 1024; // fixture size cap — see ../README.md

const PROG = "generate-assets";
const log = (/** @type {string} */ s) => process.stdout.write(`${PROG}: ${s}\n`);
const warn = (/** @type {string} */ s) => process.stderr.write(`${PROG}: WARNING ${s}\n`);
const fail = (/** @type {string} */ s) => {
  process.stderr.write(`${PROG}: ERROR ${s}\n`);
  process.exit(2);
};

/** @param {string} url @returns {string} */
function dirnameOf(url) {
  const p = fileURLToPath(url);
  return p.slice(0, p.lastIndexOf("/"));
}

/* ============================ CLI ============================ */

function usage() {
  return [
    "usage: node evals/fixtures/generator/src/generate-assets.mjs [templates…] [--out DIR] [flags]",
    "  templates              slug filters, e.g. `instagram-post` or `instagram-post@3` (default: all)",
    "  --out DIR              output root (default: evals/fixtures/generated)",
    "  --allow-oversize       keep going when an asset exceeds the 50 KB commit cap",
    "  --skip-missing-specs   warn + skip templates whose assets-note has no spec yet",
    "  -h | --help            this message",
  ].join("\n");
}

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  process.stdout.write(usage() + "\n");
  process.exit(0);
}
/** @type {string[]} */ const wanted = [];
/** @type {string | null} */ let outDir = null;
let allowOversize = false;
let skipMissingSpecs = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--out") outDir = args[++i] ?? fail("--out needs a directory argument");
  else if (a === "--allow-oversize") allowOversize = true;
  else if (a === "--skip-missing-specs") skipMissingSpecs = true;
  else if (a.startsWith("--")) fail(`unknown flag \`${a}\`\n\n${usage()}`);
  else wanted.push(a);
}
const OUT_ROOT = resolve(REPO_ROOT, outDir ?? DEFAULT_OUT);

/* ============================ specs ============================ */

/**
 * @param {string} text
 * @returns {object[]} spec objects (empty when the note carries none)
 */
function extractInlineSpecs(text) {
  /** @type {object[]} */ const specs = [];
  const fence = /```json[^\n]*\n([\s\S]*?)```/g;
  let m;
  let block = 0;
  while ((m = fence.exec(text)) !== null) {
    block++;
    let parsed;
    try {
      parsed = JSON.parse(m[1]);
    } catch (err) {
      fail(`malformed json spec block #${block} in assets-note (JSON.parse: ${err instanceof Error ? err.message : String(err)})`);
    }
    const candidates = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray(/** @type {any} */ (parsed).assets)
        ? /** @type {any} */ (parsed).assets
        : [parsed];
    for (const c of candidates) {
      if (c && typeof c === "object" && typeof (/** @type {any} */ (c).kind) === "string") {
        specs.push(/** @type {object} */ (c));
      } else {
        warn(`ignored json block #${block} in assets-note (no spec object with a \`kind\` field)`);
      }
    }
  }
  return specs;
}

/**
 * Validate one asset spec strictly (unknown fields rejected, like the template
 * manifests' `deny_unknown_fields`) — fail loudly with every problem found.
 *
 * @param {any} s @param {string} origin
 * @returns {void} exits 2 when invalid
 */
function validateSpec(s, origin) {
  /** @type {string[]} */ const errs = [];
  const say = (msg) => errs.push(msg);
  if (!s || typeof s !== "object") {
    fail(`${origin}: spec must be a JSON object`);
  }
  const SPEC_KEYS = new Set([
    "kind", "file", "w", "h", "alpha", "from", "to", "axis", "band", "shapes",
  ]);
  for (const k of Object.keys(s)) {
    if (!SPEC_KEYS.has(k)) say(`unknown field \`${k}\``);
  }
  if (s.kind !== "gradient") say(`unsupported \`kind\` ${JSON.stringify(s.kind)} (only "gradient" exists today)`);
  if (typeof s.file !== "string" || !/^asset_[a-z0-9][a-z0-9_]*\.png$/.test(s.file)) {
    say(`\`file\` must match asset_<name>.png (lowercase), got ${JSON.stringify(s.file)}`);
  }
  for (const [k, max] of /** @type {[string, number][]} */ ([["w", 20000], ["h", 20000]])) {
    const v = s[k];
    if (!Number.isInteger(v) || v < 1 || v > max) say(`\`${k}\` must be an integer 1..${max}, got ${JSON.stringify(v)}`);
  }
  if (s.alpha !== undefined && typeof s.alpha !== "boolean") say(`\`alpha\` must be a boolean, got ${JSON.stringify(s.alpha)}`);
  for (const k of ["from", "to"]) {
    if (typeof s[k] !== "string" || !/^#[0-9a-fA-F]{6}$/.test(s[k])) say(`\`${k}\` must be #rrggbb, got ${JSON.stringify(s[k])}`);
  }
  if (s.axis !== "x" && s.axis !== "y" && s.axis !== "xy") say(`\`axis\` must be "x" | "y" | "xy", got ${JSON.stringify(s.axis)}`);
  if (s.band !== undefined && s.band !== null) {
    const b = s.band;
    if (!b || typeof b !== "object") {
      say("`band` must be an object {x,y,w,h}");
    } else {
      for (const k of ["x", "y", "w", "h"]) {
        if (!Number.isInteger(b[k]) || b[k] < 0) say(`band.${k} must be a non-negative integer, got ${JSON.stringify(b[k])}`);
      }
      if (Number.isInteger(b.x) && Number.isInteger(b.y) && Number.isInteger(b.w) && Number.isInteger(b.h)) {
        if (b.w < 1 || b.h < 1) say("band.w/band.h must be >= 1");
        if (s.w !== undefined && b.x + b.w > s.w) say(`band exceeds the canvas width (${b.x} + ${b.w} > ${s.w})`);
        if (s.h !== undefined && b.y + b.h > s.h) say(`band exceeds the canvas height (${b.y} + ${b.h} > ${s.h})`);
      }
      if (s.alpha !== true) say("`band` requires `alpha: true` (bands are the RGBA wordmark case)");
    }
  }
  if (s.shapes !== undefined && s.shapes !== null) {
    if (!Array.isArray(s.shapes)) {
      say("`shapes` must be an array");
    } else {
      s.shapes.forEach((/** @type {any} */ sh, /** @type {number} */ i) => {
        const at = `shapes[${i}]`;
        if (!sh || typeof sh !== "object") {
          say(`${at} must be an object`);
          return;
        }
        const keys = Object.keys(sh);
        const allowed = new Set(["type", "color", "blend", "amount", "cx", "cy", "r", "x", "y", "w", "h", "radius"]);
        for (const k of keys) {
          if (!allowed.has(k)) say(`${at}: unknown field \`${k}\``);
        }
        if (typeof sh.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(sh.color)) say(`${at}.color must be #rrggbb`);
        if (sh.blend !== undefined && sh.blend !== "normal" && sh.blend !== "screen") {
          say(`${at}.blend must be "normal" | "screen", got ${JSON.stringify(sh.blend)}`);
        }
        if (sh.amount !== undefined && (typeof sh.amount !== "number" || !(sh.amount >= 0 && sh.amount <= 1))) {
          say(`${at}.amount must be a number 0..1`);
        }
        const int = (/** @type {string} */ k, /** @type {number} */ min) =>
          Number.isInteger(sh[k]) && sh[k] >= min;
        if (sh.type === "circle") {
          for (const k of ["cx", "cy", "r"]) if (!(int(k, 0))) say(`${at}.${k} must be a non-negative integer`);
          if (int("r", 0) && sh.r < 1) say(`${at}.r must be >= 1`);
        } else if (sh.type === "rect" || sh.type === "rrect") {
          for (const k of ["x", "y", "w", "h"]) if (!(int(k, 0))) say(`${at}.${k} must be a non-negative integer`);
          if (int("w", 0) && sh.w < 1) say(`${at}.w must be >= 1`);
          if (int("h", 0) && sh.h < 1) say(`${at}.h must be >= 1`);
          if (sh.type === "rrect" && !(int("radius", 0))) say(`${at}.radius must be a non-negative integer`);
        } else {
          say(`${at}.type must be "circle" | "rect" | "rrect", got ${JSON.stringify(sh.type)}`);
        }
      });
    }
  }
  if (errs.length > 0) {
    fail(`${origin}: invalid spec (${errs.length} problem${errs.length === 1 ? "" : "s"}):\n  - ${errs.join("\n  - ")}`);
  }
}

/* ============================ rendering ============================ */

/** @param {string} hex @returns {[number, number, number]} */
function parseHex(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/**
 * Gradient parameter t for a pixel, exactly as the assets-notes define it
 * (instagram: t = y/699; youtube: t = (x+y)/(1279+719); presentation: t = x/767),
 * generalised: axis x → u/(W-1), y → v/(H-1), xy → (u+v)/((W-1)+(H-1)). With a
 * band the gradient spans the band (band-local u/v, clamped).
 *
 * @param {string} axis @param {number} x @param {number} y @param {any} band
 * @param {number} w @param {number} h @returns {number} t in [0, 1]
 */
function axisT(axis, x, y, band, w, h) {
  const bx = band ? band.x : 0;
  const by = band ? band.y : 0;
  const bw = band ? band.w : w;
  const bh = band ? band.h : h;
  let u = 0;
  let denom = 0;
  if (axis === "x") {
    u = x - bx;
    denom = bw - 1;
  } else if (axis === "y") {
    u = y - by;
    denom = bh - 1;
  } else {
    u = x - bx + (y - by);
    denom = bw - 1 + bh - 1;
  }
  const t = denom > 0 ? u / denom : 0;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * Thresholded membership tests (the notes explicitly allow "thresholded, no
 * anti-aliasing") — integer pixel indices, half-open rectangles.
 *
 * @param {any} shape @param {number} x @param {number} y @returns {boolean}
 */
function inside(shape, x, y) {
  if (shape.type === "circle") {
    const dx = x - shape.cx;
    const dy = y - shape.cy;
    return dx * dx + dy * dy <= shape.r * shape.r;
  }
  if (x < shape.x || y < shape.y || x >= shape.x + shape.w || y >= shape.y + shape.h) return false;
  if (shape.type === "rect") return true;
  // rrect: rounded-rect SDF test at pixel indices
  const r = shape.radius;
  if (r === 0) return true;
  const cx = Math.min(Math.max(x, shape.x + r), shape.x + shape.w - 1 - r);
  const cy = Math.min(Math.max(y, shape.y + r), shape.y + shape.h - 1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/**
 * Render one validated spec to PNG bytes.
 *
 * @param {any} spec
 * @returns {Buffer} PNG file bytes
 */
function renderAsset(spec) {
  const { w, h } = spec;
  const alpha = spec.alpha === true;
  const band = spec.band ?? null;
  const [fr, fg, fb] = parseHex(spec.from);
  const [tr, tg, tb] = parseHex(spec.to);
  const pixels = Buffer.alloc(w * h * 4); // RGBA scratch; the encoder drops A when !alpha

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (band && !(x >= band.x && x < band.x + band.w && y >= band.y && y < band.y + band.h)) {
        pixels[i + 3] = 0; // transparent wordmark padding — RGB left at 0
        continue;
      }
      const t = axisT(spec.axis, x, y, band, w, h);
      pixels[i] = Math.round(fr + (tr - fr) * t);
      pixels[i + 1] = Math.round(fg + (tg - fg) * t);
      pixels[i + 2] = Math.round(fb + (tb - fb) * t);
      pixels[i + 3] = 255;
    }
  }

  // Shapes paint over the gradient (sRGB channel-wise, all math in 0..255):
  //   screen(a,b) = a + b - a·b/255, then mixed at `amount`:
  //   out = base + amount · (screen(base, shape) − base)   ("25% screen blend")
  //   normal blend = out = base + amount · (shape − base)  (amount 1 = replace)
  for (const shape of spec.shapes ?? []) {
    const [sr, sg, sb] = parseHex(shape.color);
    const amount = shape.amount ?? 1;
    const screen = shape.blend !== "normal";
    const minX = shape.type === "circle" ? shape.cx - shape.r : shape.x;
    const maxX = shape.type === "circle" ? shape.cx + shape.r : shape.x + shape.w - 1;
    const minY = shape.type === "circle" ? shape.cy - shape.r : shape.y;
    const maxY = shape.type === "circle" ? shape.cy + shape.r : shape.y + shape.h - 1;
    for (let y = Math.max(0, minY); y <= Math.min(h - 1, maxY); y++) {
      for (let x = Math.max(0, minX); x <= Math.min(w - 1, maxX); x++) {
        if (!inside(shape, x, y)) continue;
        if (band && !(x >= band.x && x < band.x + band.w && y >= band.y && y < band.y + band.h)) continue;
        const i = (y * w + x) * 4;
        const sc = [sr, sg, sb];
        for (let c = 0; c < 3; c++) {
          const base = pixels[i + c];
          const s = sc[c];
          const mixed = screen ? base + s - (base * s) / 255 : s;
          const out = base + amount * (mixed - base);
          pixels[i + c] = Math.round(out < 0 ? 0 : out > 255 ? 255 : out);
        }
      }
    }
  }

  return encodePng({ width: w, height: h, pixels, hasAlpha: alpha });
}

/* ============================ main ============================ */

const templates = readdirSync(TEMPLATES_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && /@[0-9]+$/.test(e.name))
  .map((e) => e.name)
  .filter((name) => wanted.length === 0 || wanted.some((w1) => name === w1 || name.split("@")[0] === w1))
  .sort();
for (const want of wanted) {
  if (!templates.some((t) => t === want || t.split("@")[0] === want)) {
    fail(`no template directory matches \`${want}\` under ${relative(REPO_ROOT, TEMPLATES_DIR)}`);
  }
}
if (templates.length === 0) {
  fail(`no template directories found under ${TEMPLATES_DIR}`);
}

/** @type {{ file: string, bytes: number, over: boolean }[]} */ const oversizeRows = [];
/** @type {string[]} */ const missingSpecs = [];
let totalFiles = 0;
let totalBytes = 0;

for (const tmpl of templates) {
  const tmplDir = join(TEMPLATES_DIR, tmpl);
  let note;
  try {
    note = readFileSync(join(tmplDir, "assets-note.md"), "utf8");
  } catch {
    warn(`${tmpl}: no assets-note.md — skipped (see evals/templates/README.md layout)`);
    continue;
  }

  const specs = extractInlineSpecs(note);
  const specSource =
    specs.length > 0
      ? `inline json block(s) in assets-note.md (preferred convention)`
      : `mirror specs/${tmpl}.json (note has no inline json spec block — see evals/fixtures/generator/README.md)`;
  if (specs.length === 0) {
    const mirrorPath = join(SPECS_DIR, `${tmpl}.json`);
    let mirrorText = null;
    try {
      mirrorText = readFileSync(mirrorPath, "utf8");
    } catch {
      const why = `${tmpl}: assets-note.md has no inline json spec block and no mirror spec at ${relative(REPO_ROOT, mirrorPath)}`;
      if (skipMissingSpecs) {
        missingSpecs.push(tmpl);
        warn(`${why} — SKIPPED (--skip-missing-specs; add the spec before the wave closes)`);
        continue;
      }
      fail(`${why} — add one (evals/fixtures/generator/README.md documents the convention)`);
    }
    let mirror;
    try {
      mirror = JSON.parse(mirrorText);
    } catch (err) {
      fail(`specs/${tmpl}.json: invalid JSON (${err instanceof Error ? err.message : String(err)})`);
    }
    if (!mirror || !Array.isArray(mirror.assets)) fail(`specs/${tmpl}.json: top-level \`assets\` array missing`);
    if (mirror.template !== tmpl) {
      fail(`specs/${tmpl}.json: \`template\` is ${JSON.stringify(mirror.template)}, expected "${tmpl}"`);
    }
    specs.push(...mirror.assets);
  }
  specs.forEach((s, i) => validateSpec(s, `${tmpl} spec #${i + 1} (${specSource})`));
  const seen = new Set();
  for (const s of specs) {
    if (seen.has(s.file)) fail(`${tmpl}: duplicate spec file \`${s.file}\``);
    seen.add(s.file);
  }

  const outDir = join(OUT_ROOT, tmpl);
  mkdirSync(outDir, { recursive: true });
  log(`${tmpl} → ${relative(REPO_ROOT, outDir)}/ (specs: ${specSource})`);
  for (const spec of specs) {
    const png = renderAsset(spec);
    writeFileSync(join(outDir, spec.file), png);
    const bytes = png.length;
    const over = bytes > MAX_COMMIT_BYTES;
    totalFiles++;
    totalBytes += bytes;
    if (over) oversizeRows.push({ file: `${tmpl}/${spec.file}`, bytes, over });
    const dim = `${spec.w}×${spec.h} ${spec.alpha ? "RGBA" : "RGB"}`;
    const cap = over ? " ⚠ OVER 50 KB" : "";
    log(
      `  ${spec.file}  ${dim}  ${bytes} bytes  sha256:${createHash("sha256").update(png).digest("hex").slice(0, 12)}${cap}`,
    );
  }

  // Coverage report: every `asset_*.png` mentioned in the note vs generated —
  // catches mirror/prose drift and documents intentionally-skipped fallbacks.
  const mentioned = [...new Set(note.match(/asset_[A-Za-z0-9_]+\.png/g) ?? [])].sort();
  const missing = mentioned.filter((f) => !specs.some((s) => s.file === f));
  const extra = specs.map((s) => s.file).filter((f) => !mentioned.includes(f));
  for (const f of missing) {
    log(`  note-coverage: ${f} is mentioned in assets-note.md but NOT generated (conditional fallback or drift — check the note)`);
  }
  for (const f of extra) {
    warn(`${tmpl}: generated \`${f}\` is not mentioned in assets-note.md (mirror spec drift — sync the note or the spec)`);
  }
}

log(`done: ${totalFiles} assets, ${totalBytes} bytes total under ${relative(REPO_ROOT, OUT_ROOT)}/`);
if (missingSpecs.length > 0) {
  warn(`specs still missing for: ${missingSpecs.join(", ")} (skipped via --skip-missing-specs)`);
}
if (oversizeRows.length > 0) {
  for (const r of oversizeRows) {
    process.stderr.write(
      `${PROG}: ERROR ${r.file} is ${r.bytes} bytes > ${MAX_COMMIT_BYTES} (50 KB commit cap) — do NOT commit it; ` +
        `shrink the spec or move the asset out of git (see evals/fixtures/generator/README.md §size caps)\n`,
    );
  }
  if (!allowOversize) process.exit(1);
  warn(`--allow-oversize given: continuing despite ${oversizeRows.length} oversize asset(s)`);
}
