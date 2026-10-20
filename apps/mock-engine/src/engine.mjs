// @studio/mock-engine — an in-memory fake of the vendor headless engine session
// (`photocraft-cli serve`; implementation `vendor/photocraft/crates/automation/src/rpc.rs`).
//
// Everything on the wire is copied from the protocol truth:
//   - docs/control-protocol.md (method table, reply shapes, transport limits)
//   - crates/automation/src/{rpc.rs,security.rs,budgets.rs,workspace.rs}
//   - crates/engine/src/{commands.rs,jobs.rs,inspect.rs,lib.rs}
// The model behind the wire is a fake: no pixels, no fonts, no real decode. README.md tables
// exactly what is faithful and what is invented.
//
// This file is plain .mjs with JSDoc types on purpose (README.md › Why plain JavaScript):
// the mock must run with bare `node` inside integration tests and compose dev, with zero
// installs and no TypeScript/tsx toolchain in the loop.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { FaultHooks } from "./faults.mjs";

// ---------------------------------------------------------------------------
// Transport limits — docs/control-protocol.md › Transport limits, security.rs
// ---------------------------------------------------------------------------

/** Maximum encoded JSON request line, including its newline (1 MiB). */
export const MAX_REQUEST_BYTES = 1 << 20;
/** Maximum encoded JSON reply, including its newline (8 MiB). */
export const MAX_RESPONSE_BYTES = 8 << 20;
/** Maximum simultaneously serviced TCP connections per listener. */
export const MAX_CONNECTIONS = 16;
/** Maximum commands or method calls in one batch. */
export const MAX_BATCH_STEPS = 256;
/** Idle/read+write timeout for loopback TCP connections (security.rs IO_TIMEOUT). */
export const IO_TIMEOUT_MS = 30_000;
/** A new TCP connection must complete `auth` within this window (#4965). */
export const AUTH_DEADLINE_MS = 10_000;
/** Maximum requested preview edge; 0 still means full size within this ceiling. */
export const MAX_PREVIEW_SIDE = 2048;
/** Maximum source pixels processed by a headless automation preview. */
export const MAX_RENDER_SOURCE_PIXELS = 64 << 20;
/** Maximum PNG bytes before base64 encoding or writing a rendered file. */
export const MAX_PNG_BYTES = 5 << 20;

/** Method names served by `MockEngine.handle` — the exact vendor list and order (rpc.rs METHODS). */
export const METHODS = Object.freeze([
  "engine.execute",
  "jobs.list",
  "jobs.cancel",
  "engine.commands",
  "session.list",
  "doc.open",
  "doc.place",
  "doc.new",
  "doc.save",
  "doc.exportLayers",
  "doc.exportDataSets",
  "doc.importDataSets",
  "doc.inspect",
  "doc.render",
  "doc.select",
  "doc.close",
  "batch",
  "methods",
]);

/** Mock-only methods (never listed by `methods`, which stays byte-identical to the vendor). */
export const MOCK_ONLY_METHODS = Object.freeze(["mock.faults"]);

// ---------------------------------------------------------------------------
// Errors — the wire error encoding is a flat string, exactly as the vendor sends it
// ({"id":…, "ok": false, "error": "…"}). `code` is a studio-internal typed name for
// tests and the spine; it never appears on the wire.
// ---------------------------------------------------------------------------

/** @typedef {"bad_params"|"unknown_command"|"unknown_method"|"no_document"|"no_layer"|"disabled"|"denied"|"path_rejected"|"io"|"not_found"|"budget"|"internal"} FailureCode */

export class EngineFailure extends Error {
  /**
   * @param {string} message the exact wire error string
   * @param {FailureCode} code studio-internal typed name (README.md › Error catalogue)
   */
  constructor(message, code) {
    super(message);
    this.name = "EngineFailure";
    this.code = code;
  }
}

/** AutomationError::BadRequest — a plain message, no command prefix. */
const plainBad = (message) => new EngineFailure(message, "bad_params");
/** EngineError::BadParams — "invalid parameters for `cmd`: msg". */
const bad = (cmd, msg) => new EngineFailure(`invalid parameters for \`${cmd}\`: ${msg}`, "bad_params");
/** EngineError::UnknownCommand — "unknown command `id`". */
const unknownCommand = (id) => new EngineFailure(`unknown command \`${id}\``, "unknown_command");
/** EngineError::Disabled — "command `id` is not available right now: reason". */
const disabled = (id, reason) =>
  new EngineFailure(`command \`${id}\` is not available right now: ${reason}`, "disabled");
const noDocument = () => new EngineFailure("no document open", "no_document");
const notFound = (message) => new EngineFailure(message, "not_found");
const io = (message) => new EngineFailure(message, "io");
const denied = (authority) =>
  new EngineFailure(`automation filesystem access is not granted: ${authority} authority is absent`, "denied");
const budget = (message) => new EngineFailure(message, "budget");
const internal = (message) => new EngineFailure(message, "internal");
const pathRejected = (reason, raw) =>
  new EngineFailure(`automation path rejected: ${reason}: \`${raw}\``, "path_rejected");

/** Engine commands that run as background jobs under `wait: false` (vendor: edit.transform). */
const JOB_COMMANDS = new Set(["edit.transform"]);

// Ambient-path engine commands automation refuses (workspace.rs authorize_engine_command /
// docs/control-protocol.md › Engine commands): use the capability-scoped doc.* methods
// instead. `file.new` and the path-free file.* commands are safe and stay runnable.
const SAFE_FILE_COMMANDS = new Set([
  "file.new",
  "file.newFromClipboard",
  "file.close",
  "file.closeAll",
  "file.closeOthers",
  "file.fileInfo",
  "file.automate.fitImage",
  "file.automate.conditionalModeChange",
  "file.automate.cropAndStraightenPhotos",
  "file.scripts.flattenAllLayerEffects",
  "file.scripts.flattenAllMasks",
  "file.scripts.deleteAllEmptyLayers",
  "file.export.exportPreferences",
]);
const AMBIENT_COMMANDS = new Set([
  "file.placeEmbedded",
  "file.placeLinked",
  "file.export.layersToFiles",
  "file.export.dataSetsAsFiles",
  "file.import.variableDataSets",
  "layer.exportAs",
  "filter.distort.displace",
  "brush.presets.importAbr",
  "actions.save",
]);
const ambientRefusal = (id) =>
  (id.startsWith("file.") && !SAFE_FILE_COMMANDS.has(id)) ||
  AMBIENT_COMMANDS.has(id) ||
  id.startsWith("image.mode.");
const ambientError = (id) =>
  new EngineFailure(
    `automation command \`${id}\` uses ambient filesystem paths and is disabled; use capability-scoped document methods`,
    "denied",
  );

// ---------------------------------------------------------------------------
// Minimal valid PNG encoder — zero deps (README.md › The fake render)
//
// An 8-bit grayscale PNG with stored (uncompressed) DEFLATE blocks: a valid PNG any
// decoder accepts, small enough to hand-roll (CRC-32 + Adler-32 + zlib stored blocks),
// and honest about being a fake — it is a uniform gray rectangle, not a composite.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** @param {Uint8Array} bytes */
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {Uint8Array} bytes */
function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * zlib stream of stored (BTYPE=00) DEFLATE blocks — every byte is passed through
 * uncompressed, so the encoded PNG is roughly the raw scanline size.
 * @param {Uint8Array} raw
 */
function zlibStored(raw) {
  const blocks = [];
  let offset = 0;
  do {
    const len = Math.min(65535, raw.length - offset);
    const isFinal = offset + len >= raw.length ? 1 : 0;
    const header = Buffer.alloc(5);
    header[0] = isFinal; // BFINAL + BTYPE(00); the rest of the byte is padding
    header.writeUInt16LE(len, 1);
    header.writeUInt16LE((~len) & 0xffff, 3);
    blocks.push(header, Buffer.from(raw.subarray(offset, offset + len)));
    offset += len;
  } while (offset < raw.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(adler32(raw), 0);
  return Buffer.concat([Buffer.from([0x78, 0x01]), ...blocks, checksum]);
}

/** @param {string} type @param {Uint8Array|Buffer} data */
function pngChunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  const crcInput = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
  out.writeUInt32BE(crc32(crcInput), 8 + data.length);
  return out;
}

/** A `width`×`height` uniform gray (#808080) PNG. */
export function grayPng(width, height) {
  const stride = width + 1; // filter byte 0 (None) + `width` gray samples
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) raw.fill(0x80, y * stride + 1, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: grayscale
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: adaptive
  ihdr[12] = 0; // interlace: none
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlibStored(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Parse a PNG IHDR for dimensions (doc.place uses the natural size of a placed image). */
export function pngDimensions(bytes) {
  if (bytes.length < 24) return null;
  if (bytes.readUInt32BE(0) !== 0x89504e47) return null;
  if (bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// ---------------------------------------------------------------------------
// Capability-root path validation — workspace.rs (textual, no link resolution)
// ---------------------------------------------------------------------------

const WINDOWS_DEVICE = /^(CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])(\.|$)/i;

/** workspace.rs relative_path: refuse before any file effect. @param {string} raw */
function relativePath(raw) {
  if (raw.length === 0) throw pathRejected("path is empty", raw);
  if (raw.includes("\\")) throw pathRejected("alternate separators are not allowed; use `/`", raw);
  if (raw.startsWith("/")) throw pathRejected("absolute paths are not allowed", raw);
  if (raw.includes(":")) throw pathRejected("drive, device and stream prefixes are not allowed", raw);
  for (const component of raw.split("/")) {
    if (component.length === 0) throw pathRejected("empty path components are not allowed", raw);
    if (component === ".") throw pathRejected("`.` path components are not allowed", raw);
    if (component === "..") throw pathRejected("parent traversal is not allowed", raw);
    if (component.endsWith(".") || component.endsWith(" "))
      throw pathRejected("path components ending in a dot or space are not allowed", raw);
    if (WINDOWS_DEVICE.test(component)) throw pathRejected("reserved device names are not allowed", raw);
  }
  return raw;
}

/** Resolve a request path against the root: absolute paths must name a file beneath it. */
function resolveWithinRoot(raw, root) {
  if (raw.startsWith("/")) {
    const prefix = root.endsWith("/") ? root : `${root}/`;
    if (!raw.startsWith(prefix)) {
      throw pathRejected("absolute paths must be inside the automation root", raw);
    }
    return path.join(root, relativePath(raw.slice(prefix.length)));
  }
  return path.join(root, relativePath(raw));
}

/** Map a Node fs error to the Rust ErrorKind name the vendor prints. */
function ioKind(error) {
  if (error?.code === "ENOENT") return "NotFound";
  if (error?.code === "EISDIR") return "IsADirectory";
  if (error?.code === "ENOTDIR") return "NotADirectory";
  if (error?.code === "EEXIST") return "AlreadyExists";
  return "Other";
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** Vendor kind_name() values (crates/doc/src/lib.rs) for the internal kinds we model. */
const KIND_NAMES = Object.freeze({
  pixel: "Pixel",
  group: "Group",
  adjustment: "Adjustment",
  fill: "Fill",
  type: "Type",
  shape: "Shape",
  smart: "Smart Object",
});

const kindName = (layer) => KIND_NAMES[layer.kind] ?? layer.kind;
const article = (layer) => (layer.kind === "adjustment" ? "an" : "a");
const isGroup = (layer) => layer.kind === "group";

/**
 * @typedef {Object} MockLayer
 * @property {number} id
 * @property {string} name
 * @property {"pixel"|"group"|"adjustment"|"fill"|"type"|"shape"|"smart"} kind
 * @property {boolean} visible
 * @property {number} opacity 0..1
 * @property {number} fillOpacity 0..1
 * @property {string} blend
 * @property {string} labelColor
 * @property {boolean} clipped
 * @property {boolean} hasMask
 * @property {Array<Object>} effects
 * @property {number[]|null} bounds [x, y, w, h] content bounds; null when empty (vendor content_bounds)
 * @property {boolean} expanded
 * @property {Array<MockLayer>} children group children, bottom→top like the doc array
 * @property {Object|null} text {text, font, sizePt, color, box?, point?}
 * @property {string|null} fillColor last edit.fill colour ("#rrggbb")
 * @property {string|null} fileName smart-object source file name (doc.place)
 */

/** @returns {MockLayer} */
function newLayer(id, name, kind, extra = {}) {
  return {
    id,
    name,
    kind,
    visible: true,
    opacity: 1,
    fillOpacity: 1,
    blend: "Normal",
    labelColor: "none",
    clipped: false,
    hasMask: false,
    effects: [],
    bounds: null,
    expanded: true,
    children: [],
    text: null,
    fillColor: null,
    fileName: null,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Layer-tree helpers
// ---------------------------------------------------------------------------

/** All layers of the doc, top-down (the Layers panel's walk order). */
function walkTopDown(layers) {
  const out = [];
  const visit = (arr) => {
    for (let i = arr.length - 1; i >= 0; i -= 1) {
      out.push(arr[i]);
      if (arr[i].children.length > 0) visit(arr[i].children);
    }
  };
  visit(layers);
  return out;
}

/** Find a layer anywhere in the tree. */
function findLayer(doc, id) {
  const search = (arr) => {
    for (const layer of arr) {
      if (layer.id === id) return layer;
      const hit = search(layer.children);
      if (hit) return hit;
    }
    return null;
  };
  return search(doc.layers);
}

/** The array holding `layer` (doc root or a group's children). */
function siblingsOf(doc, layer) {
  const search = (arr) => {
    for (const candidate of arr) {
      if (candidate === layer) return arr;
      const hit = search(candidate.children);
      if (hit) return hit;
    }
    return null;
  };
  return search(doc.layers) ?? doc.layers;
}

/** Layer ids the document has, for the "no such layer" error (lib.rs UnknownLayer). */
function knownLayers(doc) {
  const ids = walkTopDown(doc.layers).map((layer) => layer.id);
  return ids.length > 0 ? ids.join(", ") : "no layers";
}

function noLayer(doc, id) {
  return new EngineFailure(`no such layer ${id}; the document has: ${knownLayers(doc)}`, "no_layer");
}

function noLayerByName(doc, name) {
  return new EngineFailure(`no layer named \`${name}\`; the document has: ${knownLayers(doc)}`, "no_layer");
}

/** The given layer, the active layer, or a typed failure (commands.rs layer_param). */
function layerParam(doc, p, cmd) {
  const raw = p.layer;
  if (raw === undefined || raw === null) {
    if (doc.activeLayer === null) throw bad(cmd, "no active layer");
    const active = findLayer(doc, doc.activeLayer);
    if (!active) throw noLayer(doc, doc.activeLayer);
    return active;
  }
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw bad(cmd, `\`layer\` must be a layer id, got ${JSON.stringify(raw)}`);
  }
  const layer = findLayer(doc, raw);
  if (!layer) throw noLayer(doc, raw);
  return layer;
}

/** next_layer_name: the first `Base N` not taken. */
function nextLayerName(doc, base) {
  const names = new Set(walkTopDown(doc.layers).map((layer) => layer.name));
  for (let n = 1; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!names.has(candidate)) return candidate;
  }
}

// --- small param helpers ----------------------------------------------------

const BLEND_MODES = new Set([
  "Normal",
  "Multiply",
  "Screen",
  "Overlay",
  "Darken",
  "Lighten",
  "Color Dodge",
  "Color Burn",
  "Hard Light",
  "Soft Light",
  "Difference",
  "Exclusion",
  "Hue",
  "Saturation",
  "Color",
  "Luminosity",
]);

function blendParam(cmd, value, { allowPassThrough = false } = {}) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw bad(cmd, `\`blend\` must be a blend mode name, got ${JSON.stringify(value)}`);
  }
  if (value === "Pass Through" && allowPassThrough) return value;
  if (!BLEND_MODES.has(value)) throw bad(cmd, `unknown blend mode \`${value}\``);
  return value;
}

/** Clamp-store a colour given as "#rrggbb" or [r,g,b(,a)] floats 0..1. */
function colorParam(cmd, value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string" && /^#([0-9a-fA-F]{6})$/.test(value)) return value.toLowerCase();
  if (
    Array.isArray(value) &&
    (value.length === 3 || value.length === 4) &&
    value.every((v) => typeof v === "number" && Number.isFinite(v))
  ) {
    const [r, g, b] = value.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255));
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
  }
  throw bad(cmd, "`color` must be a colour (\"#rrggbb\" or [r,g,b,a])");
}

const rgbaToHex = (rgba) => {
  const [r, g, b] = rgba.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
};

/** A 0..max unit param. Returns `fallback` when absent (commands.rs opacity/fill checks). */
function boundedUnit(value, max, key, cmd, fallback = undefined) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) {
    const range = max === 1 ? "0..1 (1 = 100 %)" : `0..${max}`;
    throw bad(cmd, `\`${key}\` must be a number in ${range}, got ${JSON.stringify(value)}`);
  }
  return value;
}

function numberParam(value, key, cmd, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw bad(cmd, `\`${key}\` must be a number, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Percent-style param (100 = identity). Returns undefined when absent. */
function percentParam(value, key, cmd) {
  if (value === undefined || value === null) return undefined;
  return numberParam(value, key, cmd, 100) / 100;
}

/** Approximate type bounds: point text from the baseline anchor, paragraph text = the box. */
function typeBounds(text) {
  const size = text.sizePt;
  if (text.box) {
    const [x, y, w, h] = text.box;
    return [Math.round(x), Math.round(y), Math.round(w), Math.round(h)];
  }
  const [x, y] = text.point ?? [0, 0];
  const width = Math.max(1, Math.round(size * 0.6 * [...text.text].length));
  const ascent = Math.round(size * 0.8);
  const descent = Math.round(size * 0.25);
  return [Math.round(x), Math.round(y - ascent), width, ascent + descent];
}

const cornersOf = (bounds) =>
  bounds === null ? null : [bounds[0], bounds[1], bounds[0] + bounds[2], bounds[1] + bounds[3]];

/** Layer name default for type.create (vendor: layer_name(&text)). */
function layerNameFromText(text) {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) return "Type Layer";
  return trimmed.length > 64 ? `${trimmed.slice(0, 61)}…` : trimmed;
}

/** Free Transform: affine from a source rect to a destination quad (three corners solve it). */
function affineFromRectQuad(rect, quad) {
  const [x0, y0, x1, y1] = rect;
  const width = x1 - x0 || 1;
  const height = y1 - y0 || 1;
  const [[ax, ay], [bx, by], [cx, cy]] = quad;
  const ux = (bx - ax) / width;
  const vx = (cx - ax) / height;
  const uy = (by - ay) / width;
  const vy = (cy - ay) / height;
  return [ux, uy, vx, vy, ax - ux * x0 - vx * y0, ay - uy * x0 - vy * y0];
}

/** Relative alternative: scale and rotate about the frame's centre, then move. */
function composeAffine(rect, sx, sy, rotate, dx, dy) {
  const cx = (rect[0] + rect[2]) / 2;
  const cy = (rect[1] + rect[3]) / 2;
  const cos = Math.cos(rotate);
  const sin = Math.sin(rotate);
  const a = cos * sx;
  const b = sin * sx;
  const c = -sin * sy;
  const d = cos * sy;
  return [a, b, c, d, cx - (a * cx + c * cy) + dx, cy - (b * cx + d * cy) + dy];
}

const sanitize = (name) =>
  name
    .replace(/[\\/:*?"<>|\n\r\t]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64) || "layer";

// ---------------------------------------------------------------------------
// Command registry — metadata copied verbatim from the vendor spec tables
// (crates/engine/src/{commands.rs,type_cmds.rs,transform_cmds.rs,layer_style.rs,
// layer_list_cmds.rs,jobs.rs}) so `engine.commands` rows look like the real ones.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} CommandSpec
 * @property {string} id
 * @property {string} label
 * @property {string[]} menu
 * @property {string|null} shortcut
 * @property {string} params
 * @property {(engine: MockEngine) => (string|undefined)} enabled reason string when disabled
 * @property {(engine: MockEngine, p: Object) => any} run
 */

/** @type {CommandSpec[]} */
const COMMANDS = [];
/** @type {Map<string, CommandSpec>} */
const COMMAND_INDEX = new Map();

/** Studio-only command ids (agent checkpoints, template no-ops) — README documents these. */
export const MOCK_COMMAND_IDS = new Set();

/**
 * @param {CommandSpec} spec
 * @param {Object} [opts]
 * @param {boolean} [opts.mockExtension] marks a studio-only command the vendor does not have
 */
function define(spec, opts = {}) {
  COMMANDS.push(spec);
  COMMAND_INDEX.set(spec.id, spec);
  if (opts.mockExtension) MOCK_COMMAND_IDS.add(spec.id);
}

// enablement closures, in the vendor's style (commands.rs has_doc / has_layer)

/** has_doc: "no document open" when nothing is open (mode_cmds.rs). */
const hasDoc = (engine) => (engine.activeDoc() === null ? "no document open" : undefined);
/** has_layer: layer_style.rs — needs a document, then an active layer. */
const hasLayer = (engine) => {
  const doc = engine.activeDoc();
  if (!doc) return "no document open";
  if (doc.activeLayer === null) return "no active layer";
  return undefined;
};
/** has_pixel_or_channel, approximated for the fake: the active layer must hold pixels. */
const hasPixelLayer = (engine) => {
  const doc = engine.activeDoc();
  if (!doc) return "no document open";
  if (doc.activeLayer === null) return "no active layer";
  const layer = engine.activeLayer();
  if (!layer || layer.kind === "group" || layer.kind === "adjustment") {
    return "the active layer has no pixels";
  }
  return undefined;
};

// --- File -------------------------------------------------------------------

define({
  id: "file.new",
  label: "New…",
  menu: ["File"],
  shortcut: "Cmd+N",
  params:
    '{"width":1..300000=1920,"height":1..300000=1080 (pixel counts are rounded),"mode":"rgb|gray|grayscale|cmyk|lab"="rgb","depth":8|16|32=8,"background":"white|black|backgroundColor|transparent|#rrggbb"="white","backgroundColor":[r,g,b]? (0..1; defaults to toolbox colour),"resolution":1..30000=72 (ppi),"name":str}',
  enabled: () => undefined,
  run: (engine, p) => engine.fileNew(p),
});

// --- Edit -------------------------------------------------------------------

define({
  id: "edit.fill",
  label: "Fill…",
  menu: ["Edit"],
  shortcut: "Shift+F5",
  params:
    '{"contents":"foreground|background|color|contentAware|pattern|history|black|gray|white"="color","color":"#rrggbb|[r,g,b,a]"=foreground (contents=color),"pattern":id|name (contents=pattern),"scale":%=100,"angle":deg,"state":index? (contents=history; default the oldest state),"colorAdaptation":bool=true (contents=contentAware),"mode":"normal|multiply|…"="normal","opacity":0..100=100,"preserveTransparency":bool=false,"target":"pixels"|"mask"|"quickMask"|{"channel":i}?}',
  enabled: hasPixelLayer,
  run: (engine, p) => engine.editFill(p),
});

define({
  id: "edit.transform",
  label: "Free Transform",
  menu: [],
  shortcut: null,
  params:
    '{"layer":id?,"rect":[x0,y0,x1,y1]? (source frame; default = layer content ∩ selection),"quad":[[x,y]×4]? (where the frame\'s corners go, clockwise from top-left),"matrix":[a,b,c,d,e,f]? (affine alternative),"scaleX":%?,"scaleY":%?,"rotate":deg?,"dx":px?,"dy":px? (relative alternative: scale and rotate about the frame\'s centre, then move, as a Photoshop action records a Free Transform),"interpolation":"bicubic|bilinear|nearest"="bicubic","target":"pixels"|"mask"|"quickMask"|{"channel":i}=Channels panel target (an unlinked mask, an alpha channel or the Quick Mask transforms alone; a linked mask moves with its layer)}',
  enabled: hasLayer,
  run: (engine, p) => engine.editTransform(p),
});

// --- Layer ------------------------------------------------------------------

define({
  id: "layer.new.layer",
  label: "Layer…",
  menu: ["Layer", "New"],
  shortcut: "Cmd+Shift+N",
  params:
    '{"name":str?,"clipToPrevious":bool=false (Use Previous Layer to Create Clipping Mask; inside a clip group the layer joins it anyway),"color":"none|red|orange|yellow|green|seafoam|blue|indigo|magenta|fuchsia|violet|gray"="none","mode":"Normal|Multiply|…"="Normal","opacity":0..1=1,"fillNeutral":bool=false (fill with the mode\'s neutral color: modes without one are an error),"position":"above|below"="above" (below: the Layers panel\'s Cmd/Ctrl-click; never under the Background)}',
  enabled: hasDoc,
  run: (engine, p) => engine.layerNewLayer(p),
});

define({
  id: "layer.new.group",
  label: "Group…",
  menu: ["Layer", "New"],
  shortcut: null,
  params: '{"name":str?}',
  enabled: hasDoc,
  run: (engine, p) => engine.layerNewGroup(p),
});

define({
  id: "layer.delete",
  label: "Delete Layer",
  menu: ["Layer", "Delete"],
  shortcut: null,
  params: '{"layer":id?} (no layer: every selected layer)',
  enabled: hasLayer,
  run: (engine, p) => engine.layerDelete(p),
});

define({
  id: "layer.select",
  label: "Select Layer",
  menu: [],
  shortcut: null,
  params:
    '{"layer":id|str | "name":str,"occurrence":index?,"mode":"replace|toggle|range|add|remove"="replace"} (name occurrence: zero-based document walk order; required for duplicate names; toggle = ⌘-click, range = ⇧-click, remove = deselect it, keeping at least one)',
  enabled: hasDoc,
  run: (engine, p) => engine.layerSelect(p),
});

define({
  id: "layer.setProps",
  label: "Layer Properties",
  menu: [],
  shortcut: null,
  params:
    '{"layer":id?,"layers":[id,…]? (the same change to each, one step: the Layers panel\'s controls with several layers selected),"name":str? (one layer only),"visible":bool?,"opacity":0..1?,"fill":0..1?,"blend":"Multiply|…"?,"clipped":bool?,"locked":bool?,"locks":{"transparency","pixels","position","artboard","all":bool}?,"channels":[bool,…]? (Advanced Blending: which colour channels blend, R G B / C M Y K / L a b)}',
  enabled: hasLayer,
  run: (engine, p) => engine.layerSetProps(p),
});

define({
  id: "layer.arrange.bringToFront",
  label: "Bring to Front",
  menu: ["Layer", "Arrange"],
  shortcut: "Cmd+Shift+]",
  params: '{"layer":id?}',
  enabled: hasLayer,
  run: (engine, p) => engine.layerArrange(p, "layer.arrange.bringToFront"),
});

define({
  id: "layer.arrange.sendToBack",
  label: "Send to Back",
  menu: ["Layer", "Arrange"],
  shortcut: "Cmd+Shift+[",
  params: '{"layer":id?}',
  enabled: hasLayer,
  run: (engine, p) => engine.layerArrange(p, "layer.arrange.sendToBack"),
});

define({
  id: "layer.layerMask.revealAll",
  label: "Reveal All",
  menu: ["Layer", "Layer Mask"],
  shortcut: null,
  params: '{"layer":id?} (no layer: every selected layer that can take a mask)',
  enabled: hasLayer,
  run: (engine, p) => engine.layerMaskRevealAll(p),
});

define({
  id: "layer.layerStyle.dropShadow",
  label: "Drop Shadow…",
  menu: ["Layer", "Layer Style"],
  shortcut: null,
  params:
    '{"color":"#rrggbb","opacity":0..100=75,"blend":str="multiply","angle":deg=120,"useGlobalLight":bool,"distance":px=5,"spread":0..100,"size":px=5,"contour":"Linear|Cone|Cone - Inverted|Cove - Deep|Cove - Shallow|Gaussian|Half Round|Ring|Ring - Double|Rolling Slope - Descending|Rounded Steps|Sawtooth 1"|{"name":str,"points":[[in 0..1,out 0..1],…],"corners":[bool,…]}="Linear","antiAlias":bool,"noise":0..100,"knocksOut":bool,"add":bool,"layer":id}',
  enabled: hasLayer,
  run: (engine, p) => engine.layerStyleDropShadow(p),
});

// --- Type -------------------------------------------------------------------

define({
  id: "type.create",
  label: "New Type Layer",
  menu: ["Layer", "New"],
  shortcut: null,
  params:
    '{"x":px,"y":px (baseline anchor of point text),"text":str,"box":[x,y,w,h]? (paragraph text),"name":str?,"align":"left|center|right|justify…"=?,"orientation":"horizontal|vertical"="horizontal", …character keys: "font","size":pt=12,"color",…}',
  enabled: hasDoc,
  run: (engine, p) => engine.typeCreate(p),
});

define({
  id: "type.edit",
  label: "Edit Type",
  menu: [],
  shortcut: null,
  params:
    '{"layer":id?,"text":str? (replace all, styles kept),"replace":{"start":char,"end":char,"text":str}?,"runs":[{"start":char,"end":char,…character keys}]?,"box":[x,y,w,h]? (to paragraph text),"point":[x,y]? (to point text),"move":[dx,dy]?,"transform":[a,b,c,d,e,f]?,"antialias":"none|sharp|crisp|strong|smooth"?,"name":str?,"kerning":1/1000em|"metrics"|"optical"|"off"? (with "range":[startChar,endChar]?, default all),"kernPair":{"at":caretChar,"by":1/1000em}? (Alt+←/→: the pair before the caret becomes manual, its current kerning + by)}',
  enabled: hasDoc,
  run: (engine, p) => engine.typeEdit(p),
});

// --- Inspect / registry -----------------------------------------------------

define({
  id: "document.inspect",
  label: "Inspect Document",
  menu: [],
  shortcut: null,
  params: '{"document":index?}',
  enabled: hasDoc,
  run: (engine, p) => engine.documentInspect(p),
});

define({
  id: "layer.list",
  label: "List Layers",
  menu: [],
  shortcut: null,
  params:
    '{"document":index?,"flat":bool=false} → {"layers":[{"id","name","kind","visible","bounds":[x,y,w,h]|null,"selected","active","children"?}],"activeLayer":id?} (top-down; groups list their "children", or with "flat" every layer is one row with its "depth" and "parent" group id)',
  enabled: hasDoc,
  run: (engine, p) => engine.layerList(p),
});

define({
  id: "command.list",
  label: "List Commands",
  menu: [],
  shortcut: null,
  params: "{}",
  enabled: () => undefined,
  run: (engine) => engine.commandList(null),
});

// --- Jobs -------------------------------------------------------------------

define({
  id: "jobs.list",
  label: "List Background Jobs",
  menu: [],
  shortcut: null,
  params: "{}",
  enabled: () => undefined,
  run: (engine) => ({ jobs: engine.jobs.map(jobInfo) }),
});

define({
  id: "jobs.cancel",
  label: "Cancel Background Job",
  menu: [],
  shortcut: null,
  params: '{"job":u64? (default: every running job)}',
  enabled: () => undefined,
  run: (engine, p) => engine.jobsCancel(p),
});

// --- Studio mock extensions (NOT vendor commands; README › Mock-only commands) --

define(
  {
    id: "agent.begin",
    label: "Begin Agent Checkpoint",
    menu: [],
    shortcut: null,
    params: '{"label":str?} — studio mock extension: marks a rollback checkpoint of the active document (no vendor counterpart)',
    enabled: hasDoc,
    run: (engine, p) => engine.agentBegin(p),
  },
  { mockExtension: true },
);

define(
  {
    id: "agent.commit",
    label: "Commit Agent Checkpoint",
    menu: [],
    shortcut: null,
    params: "{} — studio mock extension: drops the checkpoint begun by agent.begin",
    enabled: hasDoc,
    run: (engine) => engine.agentCommit(),
  },
  { mockExtension: true },
);

define(
  {
    id: "agent.rollback",
    label: "Roll Back Agent Checkpoint",
    menu: [],
    shortcut: null,
    params: "{} — studio mock extension: restores the checkpoint begun by agent.begin",
    enabled: hasDoc,
    run: (engine) => engine.agentRollback(),
  },
  { mockExtension: true },
);

define(
  {
    id: "template.apply",
    label: "Apply Template",
    menu: [],
    shortcut: null,
    params: '{"template":id,"slots":{layerName:assetRef}?} — studio mock extension: no-op marker for the template system',
    enabled: () => undefined,
    run: () => null,
  },
  { mockExtension: true },
);

define(
  {
    id: "template.fill",
    label: "Fill Template Slots",
    menu: [],
    shortcut: null,
    params: '{"slots":{layerName:assetRef}} — studio mock extension: no-op marker for the template system',
    enabled: () => undefined,
    run: () => null,
  },
  { mockExtension: true },
);

export { COMMANDS };

// ---------------------------------------------------------------------------
// JSON shapes (inspect.rs)
// ---------------------------------------------------------------------------

/** inspect.rs layer_sel — one layer node, top-down children for groups. */
function layerJson(doc, layer) {
  const v = {
    id: layer.id,
    name: layer.name,
    kind: kindName(layer),
    visible: layer.visible,
    labelColor: layer.labelColor,
    opacity: layer.opacity,
    fill: layer.fillOpacity,
    blend: layer.blend,
    clipped: layer.clipped,
    hasMask: layer.hasMask,
    hasVectorMask: false,
    vectorMaskEnabled: null,
    bounds: layer.bounds,
    selected: doc.selectedLayers.includes(layer.id),
    linkGroup: null,
  };
  if (isGroup(layer)) {
    v.children = [...layer.children].reverse().map((child) => layerJson(doc, child));
    v.expanded = layer.expanded;
  }
  if (layer.kind === "type" && layer.text) {
    v.text = { text: layer.text.text, font: layer.text.font, sizePt: layer.text.sizePt };
  }
  if (layer.kind === "smart") {
    v.smartSource = { kind: "embedded", fileName: layer.fileName ?? "placed.png" };
  }
  if (layer.effects.length > 0) v.effects = layer.effects.map((effect) => ({ ...effect }));
  return v;
}

/** inspect.rs document — the shape of doc.inspect / engine.execute document.inspect. */
function documentJson(doc) {
  return {
    name: doc.name,
    path: doc.path,
    width: doc.width,
    height: doc.height,
    mode: doc.mode,
    depth: doc.depth,
    resolution: doc.resolution,
    activeLayer: doc.activeLayer,
    selectedLayers: [...doc.selectedLayers],
    isolatedLayers: [],
    hasSelection: false,
    selectionBounds: null,
    layers: [...doc.layers].reverse().map((layer) => layerJson(doc, layer)),
    history: [...doc.history],
    snapshots: [],
    canUndo: doc.history.length > 0,
    canRedo: false,
    revision: doc.revision,
    channels: { composite: true, quickMask: false, target: "composite" },
    quickMask: false,
    symmetry: null,
    layerMaskView: null,
    layerComps: [],
    lastAppliedComp: null,
    measurement: { scale: "1:1", ruler: null, count: 0, countGroups: 0 },
    notes: [],
    timeline: null,
  };
}

/** inspect.rs session — the shape of session.list / doc.select / doc.close replies. */
function sessionJson(engine) {
  return {
    active: engine.activeIndex,
    documents: engine.documents.map((doc, index) => ({
      index,
      name: doc.name,
      path: doc.path,
      width: doc.width,
      height: doc.height,
      dirty: doc.revision !== doc.savedRevision,
      revision: doc.revision,
    })),
    foreground: [...engine.foreground],
    background: [...engine.background],
  };
}

/** jobs.rs JobInfo (camelCase; result/error omitted when absent). */
function jobInfo(job) {
  const v = {
    id: job.id,
    command: job.command,
    label: job.label,
    document: job.document,
    state: job.state,
    progress: job.progress,
    message: job.message,
    elapsedMs: job.elapsedMs,
  };
  if (job.result !== undefined) v.result = job.result;
  if (job.error !== undefined) v.error = job.error;
  return v;
}

// ---------------------------------------------------------------------------
// The engine session
// ---------------------------------------------------------------------------

export class MockEngine {
  /**
   * @param {Object} options
   * @param {string|null} options.root absolute automation read+write root, or null (fail closed)
   * @param {FaultHooks} [options.faults]
   */
  constructor({ root, faults = new FaultHooks() }) {
    if (root !== null && (!path.isAbsolute(root) || root.length === 0)) {
      throw new Error("MOCK_ENGINE_ROOT must be an absolute directory path");
    }
    this.root = root;
    this.faults = faults;
    /** @type {Array<import("./engine.mjs").MockLayer[]>} */
    this.documents = [];
    /** @type {number|null} */
    this.activeIndex = null;
    this.foreground = [0, 0, 0, 1];
    this.background = [1, 1, 1, 1];
    /** @type {Array<Object>} */
    this.jobs = [];
    this.jobCounter = 0;
    this.docCounter = 0;
    /** @type {{docIndex: number, state: Object}|null} */
    this.checkpoint = null;
  }

  // --- session plumbing ---------------------------------------------------

  /** The active document, or null. */
  activeDoc() {
    if (this.activeIndex === null) return null;
    return this.documents[this.activeIndex] ?? null;
  }

  /** The active layer of the active document, or null. */
  activeLayer() {
    const doc = this.activeDoc();
    if (!doc || doc.activeLayer === null) return null;
    return findLayer(doc, doc.activeLayer);
  }

  /** The active document or the commands' failure ("no document open"). */
  requireDoc() {
    const doc = this.activeDoc();
    if (!doc) throw noDocument();
    return doc;
  }

  /** rpc.rs doc_index: explicit index must exist; missing means the active document. */
  docIndex(index) {
    if (index === undefined || index === null) {
      if (this.activeIndex === null) throw noDocument();
      return this.activeIndex;
    }
    if (index >= this.documents.length) throw notFound(`no document at index ${index}`);
    return index;
  }

  /** Push an undo label + bump the revision (the whole "history" the mock keeps). */
  touch(doc, label) {
    doc.revision += 1;
    if (label !== null && label !== undefined) doc.history.push(label);
  }

  // --- capability-scoped files --------------------------------------------

  /** workspace.rs read, against the single mock root (read authority = write authority). */
  readRoot(raw) {
    if (this.root === null) throw denied("read");
    const resolved = resolveWithinRoot(raw, this.root);
    try {
      return { resolved, bytes: readFileSync(resolved) };
    } catch (error) {
      throw io(`automation read \`${raw}\` failed (${ioKind(error)}): ${error.message}`);
    }
  }

  writeRoot(raw, bytes, { create = true, overwrite = true } = {}) {
    if (this.root === null) throw denied("write");
    const resolved = resolveWithinRoot(raw, this.root);
    try {
      if (!overwrite && existsSync(resolved)) {
        throw Object.assign(new Error("file exists"), { code: "EEXIST" });
      }
      if (create) mkdirSync(path.dirname(resolved), { recursive: true });
      writeFileSync(resolved, bytes);
      return resolved;
    } catch (error) {
      throw io(`automation write \`${raw}\` failed (${ioKind(error)}): ${error.message}`);
    }
  }

  // --- control methods ----------------------------------------------------

  /**
   * Dispatch one control request (rpc.rs Headless::handle). Returns the reply `result`
   * value; failures throw EngineFailure with the exact wire string. Non-object params
   * behave like `{}` at the method level, exactly as serde_json's `Value::get` does.
   * @param {string} method
   * @param {any} params
   */
  handle(method, params) {
    const raw = params === null || params === undefined ? {} : params;
    const p = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {};
    switch (method) {
      case "engine.execute": {
        if (typeof p.command !== "string") throw plainBad("engine.execute needs `command`");
        const wait = typeof p.wait === "boolean" ? p.wait : true;
        return this.executeCommand(p.command, p.params === undefined ? null : p.params, wait);
      }
      case "jobs.list":
        return this.executeCommand("jobs.list", {}, true);
      case "jobs.cancel":
        return this.executeCommand("jobs.cancel", p, true);
      case "engine.commands": {
        if (p.filter !== undefined && p.filter !== null && typeof p.filter !== "string") {
          throw plainBad("`filter` must be a string");
        }
        return this.commandList(typeof p.filter === "string" ? p.filter : null);
      }
      case "session.list":
        return sessionJson(this);
      case "doc.open": {
        if (typeof p.path !== "string") throw plainBad("doc.open needs `path`");
        return this.docOpen(p.path);
      }
      case "doc.place": {
        if (typeof p.path !== "string") throw plainBad("doc.place needs `path`");
        const opts = { ...p };
        delete opts.path;
        delete opts.index;
        return this.docPlace(this.optionalIndex(p), p.path, opts);
      }
      case "doc.new":
        return this.executeCommand("file.new", raw, true);
      case "doc.save": {
        const filePath = typeof p.path === "string" ? p.path : undefined;
        const format = typeof p.format === "string" ? p.format : undefined;
        return this.docSave(this.optionalIndex(p), filePath, format);
      }
      case "doc.exportLayers": {
        if (typeof p.dir !== "string") throw plainBad("doc.exportLayers needs `dir`");
        return this.docExportLayers(this.optionalIndex(p), p.dir, p);
      }
      case "doc.exportDataSets": {
        if (typeof p.dir !== "string") throw plainBad("doc.exportDataSets needs `dir`");
        return this.docExportDataSets(this.optionalIndex(p), p.dir, p);
      }
      case "doc.importDataSets": {
        if (typeof p.path !== "string") throw plainBad("doc.importDataSets needs `path`");
        return this.docImportDataSets(this.optionalIndex(p), p.path);
      }
      case "doc.inspect":
        return documentJson(this.documents[this.docIndex(this.optionalIndex(p))]);
      case "doc.render": {
        let maxSide = 1024;
        if (p.maxSide !== undefined && p.maxSide !== null) {
          if (typeof p.maxSide !== "number" || !Number.isInteger(p.maxSide) || p.maxSide < 0 || p.maxSide > 0xffffffff) {
            throw plainBad("maxSide must be an unsigned 32-bit integer");
          }
          maxSide = p.maxSide;
        }
        return this.docRender(this.optionalIndex(p), maxSide, typeof p.path === "string" ? p.path : null);
      }
      case "doc.select": {
        const index = this.optionalIndex(p);
        if (index === undefined) throw plainBad("doc.select needs `index`");
        return this.docSelect(index);
      }
      case "doc.close":
        return this.docClose(this.optionalIndex(p));
      case "batch":
        return this.batch(p);
      case "methods":
        return [...METHODS];
      case "mock.faults":
        if ("config" in p) this.faults.set(p.config ?? null);
        return { faults: { ...this.faults.config } };
      default:
        throw new EngineFailure(`unknown method \`${method}\` (try \`methods\`)`, "unknown_method");
    }
  }

  /** rpc.rs index_of: missing/null means active; anything else must be a non-negative integer. */
  optionalIndex(p) {
    const raw = p.index;
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
      throw plainBad("`index` must be a non-negative integer");
    }
    return raw;
  }

  // --- engine.execute -----------------------------------------------------

  /**
   * Run one engine command (Session::execute order: params shape → unknown id → enabled →
   * run). With wait false on a job-capable command, register an immediate-complete job
   * instead (rpc.rs command_start → jobs).
   */
  executeCommand(id, params, wait) {
    const p = params === null || params === undefined ? {} : params;
    if (typeof p !== "object" || Array.isArray(p)) {
      throw bad(id, "params must be a JSON object");
    }
    if (this.faults.crashOn(id)) {
      // Fault hook: die like a crashed engine process; the client sees the socket drop.
      process.exit(1);
    }
    if (ambientRefusal(id)) throw ambientError(id);
    const spec = COMMAND_INDEX.get(id);
    if (!spec) throw unknownCommand(id);
    const reason = spec.enabled(this);
    if (reason !== undefined && reason !== null) throw disabled(id, reason);
    const result = spec.run(this, p);
    if (wait === false && JOB_COMMANDS.has(id)) {
      this.jobCounter += 1;
      const doc = this.activeDoc();
      this.jobs.push({
        id: this.jobCounter,
        command: id,
        label: spec.label,
        document: doc ? doc.id : null,
        state: "done",
        progress: 1,
        message: "",
        elapsedMs: 0,
        result: result ?? null,
      });
      return { job: this.jobCounter, pending: true };
    }
    return result;
  }

  /** The command registry with enablement (commands.rs list_entry shape, bare array). */
  commandList(filter) {
    const needle = filter === null ? null : filter.toLowerCase();
    const entries = COMMANDS.map((spec) => {
      const reason = spec.enabled(this) ?? null;
      const noDoc =
        this.activeDoc() === null && /^no (document|active document|open document)/.test(reason ?? "");
      return {
        id: spec.id,
        label: spec.label,
        menu: [...spec.menu],
        shortcut: spec.shortcut,
        params: spec.params,
        enabled: reason === null,
        disabledReason: reason,
        needsDocument: noDoc,
      };
    });
    if (needle === null) return entries;
    return entries.filter((entry) =>
      [entry.id, entry.label].some((field) => field.toLowerCase().includes(needle)),
    );
  }

  // --- batch (rpc.rs batch_with_budget) -----------------------------------

  /**
   * Vendor semantics: steps run in order, each step's result is retained, the first error
   * stops the batch unless stopOnError is false, and the reply budget stops later steps
   * even then. Earlier steps are NOT rolled back (docs/control-protocol.md › Transport
   * limits) — the README records where that differs from the studio task sketch.
   */
  batch(p) {
    if (!Array.isArray(p.steps)) throw plainBad("batch needs `steps`");
    if (p.steps.length > MAX_BATCH_STEPS) {
      throw plainBad(`batch contains ${p.steps.length} steps; maximum is ${MAX_BATCH_STEPS}`);
    }
    const stop = typeof p.stopOnError === "boolean" ? p.stopOnError : true;
    let remaining = MAX_RESPONSE_BYTES - MAX_REQUEST_BYTES - 4096;
    const results = [];
    let failed = 0;
    for (const [i, step] of p.steps.entries()) {
      if (typeof step !== "object" || step === null) {
        throw plainBad(`step ${i} needs \`command\` or \`method\``);
      }
      let result;
      if (typeof step.command === "string") {
        result = this.step(() =>
          this.executeCommand(step.command, step.params ?? null, typeof step.wait === "boolean" ? step.wait : true),
        );
      } else if (typeof step.method === "string") {
        result =
          step.method === "batch"
            ? { ok: false, error: "nested batch" }
            : this.step(() => this.handle(step.method, step.params ?? null));
      } else {
        throw plainBad(`step ${i} needs \`command\` or \`method\``);
      }
      const failedStep = result.ok !== true;
      const charge = Buffer.byteLength(JSON.stringify(result), "utf8");
      if (charge > remaining - 1) {
        failed += 1;
        results.push({
          ok: false,
          error: `batch response budget exceeded; current step may have completed: response exceeds ${remaining - 1} bytes`,
        });
        break;
      }
      remaining -= charge;
      results.push(result);
      if (failedStep) {
        failed += 1;
        if (stop) break;
      }
    }
    return { completed: results.length - failed, failed, results };
  }

  /** Wrap one batch step's outcome in the vendor's per-step envelope. */
  step(run) {
    try {
      return { ok: true, result: run() };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // --- file.new (commands.rs) ----------------------------------------------

  fileNew(p) {
    const dimension = (key, fallback) => {
      const raw = p[key];
      if (raw === undefined || raw === null) return fallback;
      if (typeof raw === "number" && Number.isFinite(raw)) {
        return Math.min(300000, Math.max(1, Math.round(raw)));
      }
      throw bad("file.new", `\`${key}\` must be a number from 1 to 300000`);
    };
    const width = dimension("width", 1920);
    const height = dimension("height", 1080);
    const MODES = { rgb: "Rgb", gray: "Gray", grayscale: "Gray", cmyk: "Cmyk", lab: "Lab" };
    const modeKey = typeof p.mode === "string" ? p.mode : "rgb";
    const mode = MODES[modeKey];
    if (mode === undefined) throw bad("file.new", `unknown colour mode \`${modeKey}\``);
    const depth = p.depth === undefined || p.depth === null ? 8 : p.depth;
    if (![8, 16, 32].includes(depth)) throw bad("file.new", "`depth` must be 8, 16 or 32");
    const background = typeof p.background === "string" ? p.background : "white";
    const isHex = /^#([0-9a-fA-F]{6})$/.test(background);
    if (!["white", "black", "backgroundColor", "transparent"].includes(background) && !isHex) {
      throw bad("file.new", `unknown background \`${background}\``);
    }
    const resolution =
      p.resolution === undefined || p.resolution === null
        ? 72
        : Math.min(30000, Math.max(1, Math.round(numberParam(p.resolution, "resolution", "file.new", 72))));
    const name = typeof p.name === "string" && p.name.length > 0 ? p.name : "Untitled";

    this.docCounter += 1;
    /** @type {any} */
    const doc = {
      id: this.docCounter,
      name,
      width,
      height,
      mode,
      depth,
      resolution,
      layers: [],
      activeLayer: null,
      selectedLayers: [],
      revision: 0,
      savedRevision: 0,
      path: null,
      history: [],
      layerCounter: 0,
    };
    const transparent = background === "transparent";
    doc.layerCounter += 1;
    const layer = newLayer(doc.layerCounter, transparent ? "Layer 1" : "Background", "pixel", {
      bounds: transparent ? null : [0, 0, width, height],
      fillColor: transparent
        ? null
        : background === "black"
          ? "#000000"
          : isHex
            ? background.toLowerCase()
            : "#ffffff",
    });
    doc.layers.push(layer);
    doc.activeLayer = layer.id;
    doc.selectedLayers = [layer.id];
    this.documents.push(doc);
    this.activeIndex = this.documents.length - 1;
    return { document: this.activeIndex };
  }

  // --- edit.fill (fill_cmds.rs) --------------------------------------------

  editFill(p) {
    const doc = this.requireDoc();
    const CONTENTS = [
      "foreground",
      "background",
      "color",
      "contentAware",
      "pattern",
      "history",
      "black",
      "gray",
      "white",
    ];
    const contents = typeof p.contents === "string" ? p.contents : "color";
    if (!CONTENTS.includes(contents)) {
      throw bad("edit.fill", `unknown contents \`${contents}\` (${CONTENTS.join("|")})`);
    }
    const color =
      contents === "foreground"
        ? rgbaToHex(this.foreground)
        : contents === "background"
          ? rgbaToHex(this.background)
          : contents === "black"
            ? "#000000"
            : contents === "gray"
              ? "#808080"
              : contents === "white"
                ? "#ffffff"
                : colorParam("edit.fill", p.color, rgbaToHex(this.foreground));
    const opacity = boundedUnit(p.opacity, 100, "opacity", "edit.fill", 100) / 100;
    if (p.preserveTransparency !== undefined && typeof p.preserveTransparency !== "boolean") {
      throw bad("edit.fill", "`preserveTransparency` must be true or false");
    }
    blendParam("edit.fill", p.mode);
    const layer = layerParam(doc, p, "edit.fill");
    layer.fillColor = color;
    layer.fillOpacity = Math.min(1, Math.max(0, opacity));
    if (layer.bounds === null) layer.bounds = [0, 0, doc.width, doc.height];
    this.touch(doc, "Fill");
    return { contents };
  }

  // --- edit.transform (transform_cmds.rs) ----------------------------------

  editTransform(p) {
    const doc = this.requireDoc();
    const layer = layerParam(doc, p, "edit.transform");
    let rect;
    if (p.rect !== undefined && p.rect !== null) {
      if (!Array.isArray(p.rect) || p.rect.length !== 4 || !p.rect.every((v) => typeof v === "number" && Number.isFinite(v))) {
        throw bad("edit.transform", "`rect` must be [x0,y0,x1,y1]");
      }
      rect = [...p.rect];
    } else {
      rect =
        layer.bounds === null
          ? [0, 0, doc.width, doc.height]
          : cornersOf(layer.bounds);
    }
    let m;
    if (p.matrix !== undefined && p.matrix !== null) {
      if (!Array.isArray(p.matrix) || p.matrix.length !== 6 || !p.matrix.every((v) => typeof v === "number" && Number.isFinite(v))) {
        throw bad("edit.transform", "`matrix` must be [a,b,c,d,e,f]");
      }
      m = [...p.matrix];
    } else if (p.quad !== undefined && p.quad !== null) {
      if (!Array.isArray(p.quad) || p.quad.length !== 4 || !p.quad.every((c) => Array.isArray(c) && c.length === 2 && c.every((v) => typeof v === "number" && Number.isFinite(v)))) {
        throw bad("edit.transform", "`quad` must be four [x,y] corners");
      }
      m = affineFromRectQuad(rect, p.quad);
    } else {
      const sx = percentParam(p.scaleX, "scaleX", "edit.transform") ?? 1;
      const sy = percentParam(p.scaleY, "scaleY", "edit.transform") ?? 1;
      const rotate = (numberParam(p.rotate, "rotate", "edit.transform", 0) * Math.PI) / 180;
      const dx = numberParam(p.dx, "dx", "edit.transform", 0);
      const dy = numberParam(p.dy, "dy", "edit.transform", 0);
      m = composeAffine(rect, sx, sy, rotate, dx, dy);
    }
    const corners = [
      [rect[0], rect[1]],
      [rect[2], rect[1]],
      [rect[2], rect[3]],
      [rect[0], rect[3]],
    ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    layer.bounds = [
      Math.round(Math.min(...xs)),
      Math.round(Math.min(...ys)),
      Math.round(Math.max(...xs) - Math.min(...xs)),
      Math.round(Math.max(...ys) - Math.min(...ys)),
    ];
    this.touch(doc, "Free Transform");
    return { rect };
  }

  // --- layer commands -------------------------------------------------------

  layerNewLayer(p) {
    const doc = this.requireDoc();
    if (p.clipToPrevious !== undefined && p.clipToPrevious !== null && typeof p.clipToPrevious !== "boolean") {
      throw bad("layer.new.layer", "`clipToPrevious` must be true or false");
    }
    if (p.fillNeutral !== undefined && p.fillNeutral !== null && typeof p.fillNeutral !== "boolean") {
      throw bad("layer.new.layer", "`fillNeutral` must be true or false");
    }
    if (p.fillNeutral === true) throw bad("layer.new.layer", "Normal has no neutral color to fill with");
    const blend = blendParam("layer.new.layer", p.mode) ?? "Normal";
    const opacity = boundedUnit(p.opacity, 1, "opacity", "layer.new.layer", 1);
    if (p.name !== undefined && p.name !== null && typeof p.name !== "string") {
      throw bad("layer.new.layer", "`name` must be a string");
    }
    if (p.position !== undefined && p.position !== null && !["above", "below"].includes(p.position)) {
      throw bad("layer.new.layer", "`position` must be above or below");
    }
    const below = p.position === "below";
    doc.layerCounter += 1;
    const name = typeof p.name === "string" && p.name.length > 0 ? p.name : nextLayerName(doc, "Layer");
    const layer = newLayer(doc.layerCounter, name, "pixel", { blend, opacity });
    insertAbove(doc, layer, below);
    this.touch(doc, "New Layer");
    return { layer: layer.id };
  }

  layerNewGroup(p) {
    const doc = this.requireDoc();
    if (p.name !== undefined && p.name !== null && typeof p.name !== "string") {
      throw bad("layer.new.group", "`name` must be a string");
    }
    doc.layerCounter += 1;
    const name = typeof p.name === "string" && p.name.length > 0 ? p.name : nextLayerName(doc, "Group");
    const group = newLayer(doc.layerCounter, name, "group");
    insertAbove(doc, group, false);
    this.touch(doc, "New Group");
    return { layer: group.id };
  }

  layerDelete(p) {
    const doc = this.requireDoc();
    const targets =
      p.layer === undefined || p.layer === null
        ? [...doc.selectedLayers]
        : [layerParam(doc, p, "layer.delete").id];
    if (targets.length === 0) throw internal("no layer to delete");
    if (doc.layers.length - countNodes(doc, new Set(targets)) < 1) {
      throw internal("a document must keep at least one layer");
    }
    removeLayers(doc, new Set(targets));
    if (doc.activeLayer !== null && !findLayer(doc, doc.activeLayer)) {
      const top = walkTopDown(doc.layers)[0];
      doc.activeLayer = top ? top.id : null;
      doc.selectedLayers = top ? [top.id] : [];
    }
    this.touch(doc, "Delete Layer");
    return null;
  }

  layerSelect(p) {
    const doc = this.requireDoc();
    const target = selectionTarget(doc, p);
    const mode = p.mode === undefined || p.mode === null ? "replace" : p.mode;
    if (!["replace", "toggle", "range", "add", "remove"].includes(mode)) {
      throw bad("layer.select", `unknown mode \`${mode}\``);
    }
    const selected = new Set(doc.selectedLayers);
    if (mode === "replace") {
      selected.clear();
      selected.add(target.id);
      doc.activeLayer = target.id;
    } else if (mode === "add") {
      selected.add(target.id);
      doc.activeLayer = target.id;
    } else if (mode === "toggle") {
      if (selected.has(target.id) && selected.size > 1) {
        selected.delete(target.id);
      } else {
        selected.add(target.id);
        doc.activeLayer = target.id;
      }
    } else if (mode === "remove") {
      if (selected.has(target.id) && selected.size > 1) selected.delete(target.id);
    } else {
      const order = walkTopDown(doc.layers).map((layer) => layer.id);
      const anchor = doc.activeLayer !== null && order.includes(doc.activeLayer) ? doc.activeLayer : target.id;
      const a = order.indexOf(anchor);
      const b = order.indexOf(target.id);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      for (const id of order.slice(lo, hi + 1)) selected.add(id);
      doc.activeLayer = target.id;
    }
    doc.selectedLayers = walkTopDown(doc.layers)
      .map((layer) => layer.id)
      .filter((id) => selected.has(id));
    return { selected: [...doc.selectedLayers] };
  }

  layerSetProps(p) {
    const doc = this.requireDoc();
    /** @type {Array<MockLayer>} */
    let layers;
    if (p.layers === undefined || p.layers === null) {
      layers = [layerParam(doc, p, "layer.setProps")];
    } else if (Array.isArray(p.layers) && p.layers.length > 0 && p.layers.length <= 10_000) {
      layers = p.layers.map((id) => {
        if (typeof id !== "number" || !Number.isInteger(id)) {
          throw bad("layer.setProps", `\`layers\` holds layer ids, got ${JSON.stringify(id)}`);
        }
        const layer = findLayer(doc, id);
        if (!layer) throw noLayer(doc, id);
        return layer;
      });
    } else {
      throw bad("layer.setProps", "`layers` is a non-empty list of layer ids");
    }
    if (p.name !== undefined && p.name !== null) {
      if (typeof p.name !== "string") throw bad("layer.setProps", "`name` must be a string");
      if (layers.length > 1) throw bad("layer.setProps", "`name` renames one layer, not several");
    }
    if (p.visible !== undefined && p.visible !== null && typeof p.visible !== "boolean") {
      throw bad("layer.setProps", "`visible` must be true or false");
    }
    if (p.clipped !== undefined && p.clipped !== null && typeof p.clipped !== "boolean") {
      throw bad("layer.setProps", "`clipped` must be true or false");
    }
    const opacity = boundedUnit(p.opacity, 1, "opacity", "layer.setProps");
    const fill = boundedUnit(p.fill, 1, "fill", "layer.setProps");
    const blend = blendParam("layer.setProps", p.blend, { allowPassThrough: true });
    if (blend === "Pass Through") {
      for (const layer of layers) {
        if (!isGroup(layer)) {
          throw bad("layer.setProps", `Pass Through applies to groups only; layer ${layer.id} isn't one`);
        }
      }
    }
    for (const layer of layers) {
      if (typeof p.name === "string") layer.name = p.name;
      if (typeof p.visible === "boolean") layer.visible = p.visible;
      if (opacity !== undefined) layer.opacity = opacity;
      if (fill !== undefined) layer.fillOpacity = fill;
      if (blend !== undefined) layer.blend = blend;
      if (typeof p.clipped === "boolean") layer.clipped = p.clipped;
    }
    this.touch(doc, "Layer Properties");
    return null;
  }

  layerArrange(p, id) {
    const doc = this.requireDoc();
    const layer = layerParam(doc, p, id);
    const siblings = siblingsOf(doc, layer);
    siblings.splice(siblings.indexOf(layer), 1);
    if (id === "layer.arrange.bringToFront") siblings.push(layer);
    else siblings.unshift(layer);
    this.touch(doc, id === "layer.arrange.bringToFront" ? "Bring to Front" : "Send to Back");
    return null;
  }

  layerMaskRevealAll(p) {
    const doc = this.requireDoc();
    const layer = layerParam(doc, p, "layer.layerMask.revealAll");
    if (isGroup(layer)) throw bad("layer.layerMask.revealAll", "a group cannot take a pixel mask");
    layer.hasMask = true;
    this.touch(doc, "Add Layer Mask");
    return null;
  }

  layerStyleDropShadow(p) {
    const doc = this.requireDoc();
    const layer = layerParam(doc, p, "layer.layerStyle.dropShadow");
    const effect = {
      kind: "dropShadow",
      params: {
        color: colorParam("layer.layerStyle.dropShadow", p.color, "#000000"),
        opacity: boundedUnit(p.opacity, 100, "opacity", "layer.layerStyle.dropShadow", 75),
        blend: blendParam("layer.layerStyle.dropShadow", p.blend) ?? "multiply",
        angle: numberParam(p.angle, "angle", "layer.layerStyle.dropShadow", 120),
        useGlobalLight: p.useGlobalLight === true,
        distance: numberParam(p.distance, "distance", "layer.layerStyle.dropShadow", 5),
        spread: boundedUnit(p.spread, 100, "spread", "layer.layerStyle.dropShadow", 0),
        size: numberParam(p.size, "size", "layer.layerStyle.dropShadow", 5),
        antiAlias: p.antiAlias === true,
        noise: boundedUnit(p.noise, 100, "noise", "layer.layerStyle.dropShadow", 0),
        knocksOut: p.knocksOut === true,
      },
    };
    const add = p.add === true;
    const existing = layer.effects.findIndex((e) => e.kind === "dropShadow");
    if (existing >= 0 && !add) layer.effects[existing] = effect;
    else layer.effects.push(effect);
    this.touch(doc, "Layer Style: Drop Shadow");
    return { layer: layer.id };
  }

  // --- type commands -------------------------------------------------------

  typeCreate(p) {
    const doc = this.requireDoc();
    for (const key of ["x", "y"]) {
      if (typeof p[key] !== "number" || !Number.isFinite(p[key])) {
        throw bad("type.create", `missing or non-number \`${key}\``);
      }
    }
    if (typeof p.text !== "string") throw bad("type.create", "missing `text`");
    let box = null;
    if (p.box !== undefined && p.box !== null) {
      if (!Array.isArray(p.box) || p.box.length !== 4 || !p.box.every((v) => typeof v === "number")) {
        throw bad("type.create", "`box` must be [x,y,w,h]");
      }
      box = [...p.box];
    }
    let size = 12;
    if (p.size !== undefined && p.size !== null) {
      size = numberParam(p.size, "size", "type.create", 12);
      if (size < 0.1 || size > 1296) throw bad("type.create", "`size` must be a number from 0.1 to 1296 pt");
    }
    const text = {
      text: p.text,
      font: typeof p.font === "string" ? p.font : "Helvetica",
      sizePt: size,
      color: colorParam("type.create", p.color, "#000000"),
      box,
      point: box === null ? [p.x, p.y] : null,
    };
    doc.layerCounter += 1;
    const name = typeof p.name === "string" && p.name.length > 0 ? p.name : layerNameFromText(p.text);
    const layer = newLayer(doc.layerCounter, name, "type", {
      text,
      bounds: typeBounds(text),
    });
    insertAbove(doc, layer, false);
    this.touch(doc, "New Type Layer");
    return { layer: layer.id, bounds: cornersOf(layer.bounds) };
  }

  typeEdit(p) {
    const doc = this.requireDoc();
    const layer = layerParam(doc, p, "type.edit");
    if (layer.kind !== "type" || !layer.text) {
      throw internal(`layer ${layer.id} is ${article(layer)} ${kindName(layer)} layer, not a type layer`);
    }
    const text = layer.text;
    if (p.text !== undefined && p.text !== null) {
      if (typeof p.text !== "string") throw bad("type.edit", "`text` must be a string");
      text.text = p.text;
    }
    if (p.name !== undefined && p.name !== null) {
      if (typeof p.name !== "string") throw bad("type.edit", "`name` must be a string");
      layer.name = p.name;
    }
    if (p.size !== undefined && p.size !== null) {
      const size = numberParam(p.size, "size", "type.edit", text.sizePt);
      if (size < 0.1 || size > 1296) throw bad("type.edit", "`size` must be a number from 0.1 to 1296 pt");
      text.sizePt = size;
    }
    if (p.color !== undefined && p.color !== null) text.color = colorParam("type.edit", p.color, text.color);
    if (p.font !== undefined && p.font !== null) {
      if (typeof p.font !== "string") throw bad("type.edit", "`font` must be a string");
      text.font = p.font;
    }
    if (Array.isArray(p.box) && p.box.length === 4) {
      text.box = [...p.box];
      text.point = null;
    }
    if (Array.isArray(p.point) && p.point.length === 2) {
      text.point = [...p.point];
      text.box = null;
    }
    if (Array.isArray(p.move) && p.move.length === 2) {
      const [dx, dy] = p.move.map((v) => numberParam(v, "move", "type.edit", 0));
      if (text.point) text.point = [text.point[0] + dx, text.point[1] + dy];
      if (text.box) text.box = [text.box[0] + dx, text.box[1] + dy, text.box[2], text.box[3]];
    }
    if (Array.isArray(p.transform) && p.transform.length === 6) {
      const [a, b, c, d, e, f] = p.transform;
      const bounds = layer.bounds ?? [0, 0, doc.width, doc.height];
      const [x, y, w, h] = bounds;
      const xs = [a * x + c * y + e, a * (x + w) + c * y + e, a * x + c * (y + h) + e, a * (x + w) + c * (y + h) + e];
      const ys = [b * x + d * y + f, b * (x + w) + d * y + f, b * x + d * (y + h) + f, b * (x + w) + d * (y + h) + f];
      layer.bounds = [
        Math.round(Math.min(...xs)),
        Math.round(Math.min(...ys)),
        Math.round(Math.max(...xs) - Math.min(...xs)),
        Math.round(Math.max(...ys) - Math.min(...ys)),
      ];
    } else {
      layer.bounds = typeBounds(text);
    }
    this.touch(doc, "Edit Type");
    // Simplified type info (vendor returns the full layout; README documents the cut).
    return { layer: layer.id, text: text.text, sizePt: text.sizePt, font: text.font, color: text.color, bounds: cornersOf(layer.bounds) };
  }

  // --- inspect commands ----------------------------------------------------

  documentInspect(p) {
    const doc = this.requireDoc();
    if (p.document === undefined || p.document === null) return documentJson(doc);
    if (typeof p.document !== "number" || !Number.isInteger(p.document)) {
      throw bad("document.inspect", "`document` must be an index");
    }
    const target = this.documents[p.document];
    if (!target) throw notFound(`no document at index ${p.document}`);
    return documentJson(target);
  }

  layerList(p) {
    let doc = this.requireDoc();
    if (p.document !== undefined && p.document !== null) {
      if (typeof p.document !== "number" || !Number.isInteger(p.document)) {
        throw bad("layer.list", "`document` must be an index");
      }
      doc = this.documents[p.document];
      if (!doc) throw notFound(`no document at index ${p.document}`);
    }
    if (p.flat !== undefined && p.flat !== null && typeof p.flat !== "boolean") {
      throw bad("layer.list", "`flat` must be true or false");
    }
    const rows = [];
    const row = (layer) => ({
      id: layer.id,
      name: layer.name,
      kind: kindName(layer),
      visible: layer.visible,
      bounds: layer.bounds,
      selected: doc.selectedLayers.includes(layer.id),
      active: doc.activeLayer === layer.id,
    });
    if (p.flat === true) {
      const visit = (layers, parent, depth) => {
        for (let i = layers.length - 1; i >= 0; i -= 1) {
          const layer = layers[i];
          rows.push({ ...row(layer), depth, parent: parent ? parent.id : null });
          if (isGroup(layer)) visit(layer.children, layer, depth + 1);
        }
      };
      visit(doc.layers, null, 0);
    } else {
      const visit = (layers) => {
        const out = [];
        for (let i = layers.length - 1; i >= 0; i -= 1) {
          const layer = layers[i];
          const entry = row(layer);
          if (isGroup(layer)) entry.children = visit(layer.children);
          out.push(entry);
        }
        return out;
      };
      rows.push(...visit(doc.layers));
    }
    return { layers: rows, activeLayer: doc.activeLayer };
  }

  // --- jobs -----------------------------------------------------------------

  jobsCancel(p) {
    if (p.job === undefined || p.job === null) {
      const running = this.jobs.filter((job) => job.state === "running");
      for (const job of running) job.state = "cancelled";
      return { cancelled: running.length };
    }
    if (typeof p.job !== "number" || !Number.isInteger(p.job)) {
      throw bad("jobs.cancel", "`job` must be a job id");
    }
    const job = this.jobs.find((entry) => entry.id === p.job);
    if (job && job.state === "running") {
      job.state = "cancelled";
      delete job.result;
      return { cancelled: 1 };
    }
    throw notFound(`no running job ${p.job}`);
  }

  // --- agent checkpoints (studio mock extension) ---------------------------

  agentBegin(p) {
    const doc = this.requireDoc();
    const label = typeof p.label === "string" ? p.label : null;
    this.checkpoint = { docIndex: this.activeIndex, state: structuredClone(doc), label };
    return { checkpoint: doc.revision, label };
  }

  agentCommit() {
    const doc = this.requireDoc();
    if (!this.checkpoint) throw bad("agent.commit", "no agent.begin checkpoint is open");
    const revision = doc.revision;
    this.checkpoint = null;
    return { committed: revision };
  }

  agentRollback() {
    const doc = this.requireDoc();
    if (!this.checkpoint) throw bad("agent.rollback", "no agent.begin checkpoint is open");
    if (this.checkpoint.docIndex !== this.activeIndex) {
      throw bad("agent.rollback", "the active document changed since agent.begin");
    }
    const revision = this.checkpoint.state.revision;
    this.documents[this.activeIndex] = structuredClone(this.checkpoint.state);
    this.checkpoint = null;
    return { rolledBack: revision };
  }

  // --- doc.* file-backed methods ------------------------------------------

  docOpen(rawPath) {
    const { bytes } = this.readRoot(rawPath);
    let state;
    try {
      state = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw io(`${rawPath}: not a valid .pcraft document (${error.message})`);
    }
    if (typeof state !== "object" || state === null || !Array.isArray(state.layers)) {
      throw io(`${rawPath}: not a valid .pcraft document (this mock reads the JSON .pcraft state it writes)`);
    }
    this.docCounter += 1;
    const doc = hydrateDocument(state, this.docCounter);
    doc.path = rawPath;
    doc.savedRevision = doc.revision;
    this.documents.push(doc);
    this.activeIndex = this.documents.length - 1;
    return {
      index: this.activeIndex,
      name: doc.name,
      width: doc.width,
      height: doc.height,
      layers: walkTopDown(doc.layers).length,
      warnings: [],
    };
  }

  docPlace(index, rawPath, opts) {
    this.docIndex(index); // missing/null means the active document
    const doc = this.requireDoc();
    let bytes;
    let fileName;
    if (rawPath.startsWith("data:")) {
      // Mock-only extension beyond the vendor's capability-root path: an inline data URL
      // (data:image/png;base64,…) registers the image without touching the filesystem.
      const comma = rawPath.indexOf(",");
      const meta = comma >= 0 ? rawPath.slice(5, comma) : "";
      if (!/base64/i.test(meta)) throw bad("doc.place", "data URLs must be base64");
      try {
        bytes = Buffer.from(rawPath.slice(comma + 1), "base64");
      } catch (error) {
        throw bad("doc.place", `invalid base64 payload (${error.message})`);
      }
      const mime = meta.split(";")[0];
      fileName = mime.startsWith("image/") ? `placed.${mime.slice("image/".length)}` : "placed.png";
    } else {
      bytes = this.readRoot(rawPath).bytes;
      fileName = path.posix.basename(rawPath.replace(/\\/g, "/"));
    }
    const dims = pngDimensions(bytes) ?? { width: 64, height: 64 };
    const scale = typeof opts.scale === "number" && Number.isFinite(opts.scale) ? opts.scale : null;
    const center = Array.isArray(opts.center) && opts.center.length === 2 ? opts.center : null;
    const fit = opts.fit === true || (scale === null && (dims.width > doc.width || dims.height > doc.height));
    const factor =
      scale !== null ? Math.max(scale, 0.01) / 100 : fit ? Math.min(doc.width / dims.width, doc.height / dims.height) : 1;
    const w = dims.width * factor;
    const h = dims.height * factor;
    const cx = center !== null ? center[0] : doc.width / 2;
    const cy = center !== null ? center[1] : doc.height / 2;
    const dx = Math.round(cx - w / 2);
    const dy = Math.round(cy - h / 2);
    doc.layerCounter += 1;
    const layer = newLayer(doc.layerCounter, fileName.replace(/\.[^.]+$/, ""), "smart", {
      bounds: [dx, dy, Math.round(w), Math.round(h)],
      fileName,
    });
    insertAbove(doc, layer, false);
    this.touch(doc, "Place Embedded");
    return {
      layer: layer.id,
      scale: factor * 100,
      bounds: [dx, dy, Math.round(dx + w), Math.round(dy + h)],
      smartObject: true,
    };
  }

  docSave(index, rawPath, format) {
    const doc = this.documents[this.docIndex(index)];
    const target = rawPath ?? doc.path;
    if (target === null || target === undefined) {
      throw plainBad("document has no path; pass `path`");
    }
    let ext = format ?? path.posix.extname(target).replace(/^\./, "");
    ext = typeof ext === "string" ? ext.toLowerCase() : "";
    if (ext === "") ext = "pcraft";
    if (ext === "pcraft") {
      // A .pcraft save is the mock's whole-document format: plain JSON with a .pcraft
      // extension (a real one is a directory or zip; README documents the difference).
      const state = serializeDocument(doc);
      this.writeRoot(target, Buffer.from(`${JSON.stringify(state, null, 2)}\n`, "utf8"));
      doc.path = target;
      doc.savedRevision = doc.revision;
      return { path: target, warnings: [] };
    }
    if (ext === "png") {
      // A flat export is a copy: it leaves the document dirty and its path alone (#1547).
      this.writeRoot(target, renderPng(doc, 0));
      return { path: target, warnings: [] };
    }
    throw plainBad(`this mock saves .pcraft or .png, not \`.${ext}\` (pass "format" or a recognised extension)`);
  }

  docExportLayers(index, dir, params) {
    this.docIndex(index);
    const doc = this.requireDoc();
    if (params.prefix !== undefined && params.prefix !== null && typeof params.prefix !== "string") {
      throw bad("doc.exportLayers", "`prefix` must be a string");
    }
    const visibleOnly = params.visibleOnly !== false;
    const prefix = typeof params.prefix === "string" && params.prefix.length > 0 ? params.prefix : doc.name;
    const layers = walkTopDown(doc.layers).filter((layer) => (visibleOnly ? layer.visible : true));
    /** @type {string[]} */
    const files = [];
    const seen = new Set();
    for (const layer of layers) {
      const base = `${sanitize(prefix)}_${sanitize(layer.name)}`;
      let name = `${base}.png`;
      let n = 2;
      while (seen.has(name)) name = `${base}_${n++}.png`;
      seen.add(name);
      // The write capability refuses to overwrite an existing file (workspace.rs).
      this.writeRoot(`${dir}/${name}`, renderPng(doc, 0), { overwrite: false });
      files.push(`${dir}/${name}`);
    }
    return { files, count: files.length };
  }

  docExportDataSets(index, dir, params) {
    this.docIndex(index);
    this.requireDoc();
    // Stub per the task: the data-set variable model is not part of the fake. The dir and
    // write authority are still validated before answering, like the real method, and a
    // naming that would collide is refused before any file is written, as the command does.
    if (params.naming === "{document}") {
      throw bad("doc.exportDataSets", "naming must include {index} (names would collide)");
    }
    return { files: [], count: 0 };
  }

  docImportDataSets(index, rawPath) {
    this.docIndex(index);
    const { bytes } = this.readRoot(rawPath);
    // Stub per the task: count the data rows of the CSV beneath the read root.
    const rows = bytes
      .toString("utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
    return { imported: Math.max(0, rows.length - 1) };
  }

  docRender(index, maxSide, target) {
    const doc = this.documents[this.docIndex(index)];
    // budgets.rs check_preview: reject before any file effect.
    if (doc.width * doc.height > MAX_RENDER_SOURCE_PIXELS) {
      throw budget(`automation preview source exceeds ${MAX_RENDER_SOURCE_PIXELS} pixels`);
    }
    const side = maxSide === 0 ? Math.max(doc.width, doc.height) : maxSide;
    if (side > MAX_PREVIEW_SIDE) {
      throw budget(`automation preview side exceeds ${MAX_PREVIEW_SIDE} pixels`);
    }
    const png = renderPng(doc, maxSide);
    if (png.length > MAX_PNG_BYTES) {
      throw budget(`automation PNG exceeds ${MAX_PNG_BYTES} bytes`);
    }
    if (target === null) {
      return { mime: "image/png", base64: png.toString("base64") };
    }
    this.writeRoot(target, png);
    return { path: target, bytes: png.length };
  }

  docSelect(index) {
    if (!this.documents[index]) throw notFound(`no document at index ${index}`);
    this.activeIndex = index;
    return sessionJson(this);
  }

  docClose(index) {
    const i = this.docIndex(index);
    this.documents.splice(i, 1);
    if (this.activeIndex !== null) {
      if (this.activeIndex === i) {
        this.activeIndex = this.documents.length > 0 ? Math.min(i, this.documents.length - 1) : null;
      } else if (this.activeIndex > i) {
        this.activeIndex -= 1;
      }
    }
    return sessionJson(this);
  }
}

// ---------------------------------------------------------------------------
// Model helpers (pure functions)
// ---------------------------------------------------------------------------

function insertAbove(doc, layer, below) {
  if (doc.activeLayer === null) {
    doc.layers.push(layer);
  } else {
    const active = findLayer(doc, doc.activeLayer);
    if (!active) {
      doc.layers.push(layer);
    } else {
      const siblings = siblingsOf(doc, active);
      const at = siblings.indexOf(active) + (below ? 0 : 1);
      siblings.splice(at, 0, layer);
    }
  }
  doc.activeLayer = layer.id;
  doc.selectedLayers = [layer.id];
}

function countNodes(doc, ids) {
  return walkTopDown(doc.layers).filter((layer) => ids.has(layer.id)).length;
}

function removeLayers(doc, ids) {
  const prune = (layers) => {
    const kept = [];
    for (const layer of layers) {
      if (!ids.has(layer.id)) {
        if (isGroup(layer)) layer.children = prune(layer.children);
        kept.push(layer);
      }
    }
    return kept;
  };
  doc.layers = prune(doc.layers);
  doc.selectedLayers = doc.selectedLayers.filter((id) => !ids.has(id));
}

/** layer.select target: `layer` id|str or `name`+`occurrence` (top-down walk order). */
function selectionTarget(doc, p) {
  const raw = p.layer;
  if (raw !== undefined && raw !== null) {
    if (typeof raw === "number") {
      if (!Number.isInteger(raw) || raw < 0) throw bad("layer.select", "`layer` must be a layer id or name");
      const layer = findLayer(doc, raw);
      if (!layer) throw noLayer(doc, raw);
      return layer;
    }
    if (typeof raw === "string") return layerByName(doc, raw, p.occurrence);
    throw bad("layer.select", "`layer` must be a layer id or name");
  }
  if (typeof p.name === "string") return layerByName(doc, p.name, p.occurrence);
  throw bad("layer.select", "missing `layer` or `name`");
}

function layerByName(doc, name, occurrence) {
  const matches = walkTopDown(doc.layers).filter((layer) => layer.name === name);
  if (matches.length === 0) throw noLayerByName(doc, name);
  if (matches.length > 1 && (occurrence === undefined || occurrence === null)) {
    throw bad("layer.select", `layer name \`${name}\` is ambiguous; pass \`occurrence\``);
  }
  let index = 0;
  if (occurrence !== undefined && occurrence !== null) {
    if (typeof occurrence !== "number" || !Number.isInteger(occurrence) || occurrence < 0) {
      throw bad("layer.select", "`occurrence` must be a non-negative integer");
    }
    index = occurrence;
  }
  const layer = matches[index];
  if (!layer) throw noLayerByName(doc, name);
  return layer;
}

// --- mock .pcraft state (plain JSON; README documents the format) ------------

function serializeDocument(doc) {
  return {
    mockPcraft: 1,
    name: doc.name,
    width: doc.width,
    height: doc.height,
    mode: doc.mode,
    depth: doc.depth,
    resolution: doc.resolution,
    revision: doc.revision,
    activeLayer: doc.activeLayer,
    selectedLayers: [...doc.selectedLayers],
    layers: doc.layers.map(serializeLayer),
  };
}

function serializeLayer(layer) {
  const out = {
    id: layer.id,
    name: layer.name,
    kind: layer.kind,
    visible: layer.visible,
    opacity: layer.opacity,
    fill: layer.fillOpacity,
    blend: layer.blend,
    bounds: layer.bounds,
    fillColor: layer.fillColor,
    hasMask: layer.hasMask,
    effects: layer.effects,
  };
  if (layer.text) out.text = { ...layer.text };
  if (layer.fileName) out.fileName = layer.fileName;
  if (isGroup(layer)) out.children = layer.children.map(serializeLayer);
  return out;
}

function hydrateDocument(state, id) {
  const doc = {
    id,
    name: typeof state.name === "string" ? state.name : "Untitled",
    width: typeof state.width === "number" ? state.width : 1920,
    height: typeof state.height === "number" ? state.height : 1080,
    mode: typeof state.mode === "string" ? state.mode : "Rgb",
    depth: typeof state.depth === "number" ? state.depth : 8,
    resolution: typeof state.resolution === "number" ? state.resolution : 72,
    layers: Array.isArray(state.layers) ? state.layers.map(hydrateLayer) : [],
    activeLayer: typeof state.activeLayer === "number" ? state.activeLayer : null,
    selectedLayers: Array.isArray(state.selectedLayers) ? state.selectedLayers : [],
    revision: typeof state.revision === "number" ? state.revision : 0,
    savedRevision: typeof state.revision === "number" ? state.revision : 0,
    path: null,
    history: [],
    layerCounter: 0,
  };
  const ids = walkTopDown(doc.layers).map((layer) => layer.id);
  doc.layerCounter = ids.length > 0 ? Math.max(...ids) : 0;
  if (doc.activeLayer === null) {
    const top = walkTopDown(doc.layers)[0];
    doc.activeLayer = top ? top.id : null;
  }
  if (doc.selectedLayers.length === 0 && doc.activeLayer !== null) doc.selectedLayers = [doc.activeLayer];
  return doc;
}

function hydrateLayer(state) {
  const layer = newLayer(state.id, state.name, state.kind, {
    visible: state.visible !== false,
    opacity: typeof state.opacity === "number" ? state.opacity : 1,
    fillOpacity: typeof state.fill === "number" ? state.fill : 1,
    blend: typeof state.blend === "string" ? state.blend : "Normal",
    bounds: Array.isArray(state.bounds) ? state.bounds : null,
    fillColor: state.fillColor ?? null,
    hasMask: state.hasMask === true,
    effects: Array.isArray(state.effects) ? state.effects : [],
  });
  if (state.text && typeof state.text === "object") layer.text = { ...state.text };
  if (typeof state.fileName === "string") layer.fileName = state.fileName;
  if (Array.isArray(state.children)) layer.children = state.children.map(hydrateLayer);
  return layer;
}

// --- the fake render ---------------------------------------------------------

/**
 * Render the document as the uniform gray PNG (README › The fake render). Previews never
 * upscale: a document whose longest edge fits maxSide renders at full size.
 */
function renderPng(doc, maxSide) {
  let width = doc.width;
  let height = doc.height;
  if (maxSide > 0) {
    const longest = Math.max(width, height);
    if (longest > maxSide) {
      const factor = maxSide / longest;
      width = Math.max(1, Math.round(width * factor));
      height = Math.max(1, Math.round(height * factor));
    }
  }
  return grayPng(width, height);
}
