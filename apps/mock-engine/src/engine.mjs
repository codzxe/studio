// @ts-check
/**
 * In-memory document model + headless method/command dispatch, protocol-faithful to
 * vendor/photocraft/crates/automation/src/rpc.rs: NDJSON envelope `{id, ok, result|error}`,
 * engine errors as plain strings, `methods`/`session.list`/`doc.*`/`batch` shapes.
 * Faked: no pixels — `doc.render` always emits the same valid 8×8 gray PNG.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";

/** Engine errors serialize as the plain string under `error` (protocol › Methods). */
export class EngineError extends Error {}

/* ---------- a tiny hardcoded-valid PNG (8×8 gray), built in code, no deps ---------- */
const CRC_TABLE = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1; return c; });
function crc32(/** @type {Buffer} */ buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ -1) >>> 0;
}
function pngChunk(type, data) {
  const t = Buffer.from(type, "latin1");
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); t.copy(out, 4); data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([t, data])), 8 + data.length);
  return out;
}
let cachedPng = null;
/** The 8×8 gray PNG `doc.render` always returns (a client must not assume dimensions match the document). */
export function grayPng() {
  if (cachedPng) return cachedPng;
  const ihdr = Buffer.alloc(13); // 8×8, bit depth 8, color type 0 (grayscale)
  ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(8, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.alloc(8 * 9, 0x80); // 8 scanlines × (filter byte + 8 gray pixels)
  cachedPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
  return cachedPng;
}

/* ---------- helpers ---------- */
const BLENDS = ["Normal", "Multiply", "Screen", "Overlay", "Darken", "Lighten"];
const MAX_BATCH_STEPS = 256; // protocol › Transport limits
/** Methods served by `handle` (the `methods` reply). */
export const METHOD_NAMES = ["engine.execute", "jobs.list", "engine.commands", "session.list", "doc.open", "doc.place", "doc.new", "doc.save", "doc.inspect", "doc.render", "doc.select", "doc.close", "batch", "methods"];
function num(p, k, min, max, dflt, label) {
  const v = p?.[k] ?? dflt;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new EngineError(`${label}: \`${k}\` must be a number in ${min}..${max}`);
  return Math.round(v); }
function hexColor(v, label) {
  if (typeof v !== "string" || !/^#[0-9a-fA-F]{6}$/.test(v)) throw new EngineError(`${label}: \`color\` must be #rrggbb`);
  return v.toLowerCase(); }
function relPath(s, key, label) {
  if (typeof s !== "string" || s.length === 0) throw new EngineError(`${label} needs \`${key}\``);
  if (isAbsolute(s)) throw new EngineError(`${label}: \`${key}\` must be relative to the automation root`);
  if (s.split(/[\\/]+/).includes("..")) throw new EngineError("path escapes the automation root");
  return s; }
/** The layer addressed by `ref` (id | name); the active layer when omitted. */
function layerOf(d, ref) {
  let l = null;
  if (ref === undefined || ref === null) l = d.layers.find((x) => x.id === d.activeLayer);
  else if (typeof ref === "number" && Number.isInteger(ref)) l = d.layers.find((x) => x.id === ref);
  else if (typeof ref === "string") l = d.layers.find((x) => x.name === ref);
  else throw new EngineError("`layer` must be a layer id or name");
  if (!l) throw new EngineError(ref === undefined || ref === null ? "no active layer" : "no such layer");
  return l;
}
function insertAbove(d, layer) {
  const i = d.layers.findIndex((l) => l.id === d.activeLayer);
  d.layers.splice(i < 0 ? d.layers.length : i + 1, 0, layer); }
function bump(d, label) {
  d.revision++; d.dirty = true; d.history.push(label);
  if (d.history.length > 64) d.history.shift(); }

/* ---------- command registry (engine.execute / engine.commands) ---------- */
const cmd = (id, label, menu, shortcut, paramsDoc, run) => ({ id, label, menu, shortcut, paramsDoc, run });
const COMMANDS = [
  cmd("layer.new.layer", "Layer…", ["Layer", "New"], "Cmd+Shift+N", '{"name":str?,"opacity":0..1=1}', (e, d, p) => {
    const l = { id: e.nextLayerId++, name: typeof p.name === "string" ? p.name : `Layer ${d.layers.length}`, kind: "Pixel", bounds: [0, 0, d.width, d.height], visible: true, opacity: num(p, "opacity", 0, 1, 1, "layer.new.layer"), fill: "#808080" };
    insertAbove(d, l); d.activeLayer = l.id; d.selected = [l.id]; bump(d, "New Layer");
    return { layer: l.id };
  }),
  cmd("layer.new.group", "Group…", ["Layer", "New"], null, '{"name":str?}', (e, d, p) => {
    const l = { id: e.nextLayerId++, name: typeof p.name === "string" ? p.name : `Group ${d.layers.length}`, kind: "Group", bounds: [0, 0, d.width, d.height], visible: true, opacity: 1, fill: null };
    insertAbove(d, l); d.activeLayer = l.id; d.selected = [l.id]; bump(d, "New Group");
    return { layer: l.id };
  }),
  cmd("layer.delete", "Delete Layer", ["Layer"], null, '{"layer":id?} (no layer: every selected layer)', (e, d, p) => {
    const ids = p.layer === undefined ? [...d.selected] : [layerOf(d, p.layer).id];
    if (d.layers.length - ids.length < 1) throw new EngineError("a document must keep at least one layer");
    d.layers = d.layers.filter((l) => !ids.includes(l.id)); d.selected = d.selected.filter((i) => !ids.includes(i));
    if (!d.layers.some((l) => l.id === d.activeLayer)) d.activeLayer = d.layers.at(-1)?.id ?? null;
    if (d.selected.length === 0 && d.activeLayer !== null) d.selected = [d.activeLayer];
    bump(d, "Delete Layer");
    return null;
  }),
  cmd("layer.setProps", "Layer Properties", ["Layer"], null, '{"layer":id?,"name":str?,"visible":bool?,"opacity":0..1?,"blend":str?}', (e, d, p) => {
    const l = layerOf(d, p.layer);
    if (p.name !== undefined) { if (typeof p.name !== "string") throw new EngineError("layer.setProps: `name` must be a string"); l.name = p.name; }
    if (p.visible !== undefined) { if (typeof p.visible !== "boolean") throw new EngineError("layer.setProps: `visible` must be a boolean"); l.visible = p.visible; }
    if (p.opacity !== undefined) l.opacity = num(p, "opacity", 0, 1, l.opacity, "layer.setProps");
    if (p.blend !== undefined) { if (typeof p.blend !== "string" || !BLENDS.includes(p.blend)) throw new EngineError(`unknown blend mode \`${String(p.blend)}\``); l.blend = p.blend; }
    bump(d, "Layer Properties");
    return null;
  }),
  cmd("layer.select", "Select Layer", [], null, '{"layer":id|str | "name":str,"occurrence":int?,"mode":"replace|toggle|add|remove"}', (e, d, p) => {
    let id;
    if (p.layer !== undefined) id = layerOf(d, p.layer).id;
    else if (typeof p.name === "string") {
      const m = d.layers.filter((l) => l.name === p.name)[p.occurrence ?? 0];
      if (!m) throw new EngineError(`layer.select: no layer named \`${p.name}\``);
      id = m.id;
    } else throw new EngineError("layer.select needs `layer` or `name`");
    const mode = p.mode ?? "replace";
    if (!["replace", "toggle", "add", "remove"].includes(mode)) throw new EngineError(`layer.select: unknown mode \`${String(mode)}\``);
    const has = d.selected.includes(id);
    if (mode === "replace") d.selected = [id];
    else if (!has && (mode === "toggle" || mode === "add")) d.selected = [...d.selected, id];
    else if (has && d.selected.length > 1 && (mode === "toggle" || mode === "remove")) d.selected = d.selected.filter((i) => i !== id);
    d.activeLayer = id;
    return null;
  }),
  cmd("type.create", "Type…", ["Type"], "T", '{"text":str,"x":int=0,"y":int=0,"size":number=32}', (e, d, p) => {
    if (typeof p.text !== "string") throw new EngineError("type.create needs `text`");
    const size = num(p, "size", 1, 10000, 32, "type.create");
    const x = num(p, "x", -1e6, 1e6, 0, "type.create"), y = num(p, "y", -1e6, 1e6, 0, "type.create");
    const l = { id: e.nextLayerId++, name: p.text.slice(0, 40) || "Type Layer", kind: "Type", text: p.text, sizePt: size, bounds: [x, y, Math.ceil(p.text.length * size * 0.6), Math.ceil(size * 1.25)], visible: true, opacity: 1, fill: null };
    insertAbove(d, l); d.activeLayer = l.id; d.selected = [l.id]; bump(d, "Add Type Layer");
    return { layer: l.id, bounds: [...l.bounds] };
  }),
  cmd("type.edit", "Edit Type", ["Type"], null, '{"text":str,"layer":id?}', (e, d, p) => {
    const l = layerOf(d, p.layer);
    if (l.kind !== "Type") throw new EngineError("type.edit: the active layer is not a text layer");
    if (typeof p.text !== "string") throw new EngineError("type.edit needs `text`");
    l.text = p.text; l.bounds = [l.bounds[0], l.bounds[1], Math.ceil(p.text.length * (l.sizePt ?? 32) * 0.6), l.bounds[3]];
    bump(d, "Edit Type");
    return { layer: l.id };
  }),
  cmd("edit.fill", "Fill…", ["Edit"], "Shift+F5", '{"contents":"color|foreground|background|black|gray|white","color":"#rrggbb"}', (e, d, p) => {
    const l = layerOf(d, p.layer);
    const map = { foreground: "#000000", background: "#ffffff", black: "#000000", gray: "#808080", white: "#ffffff" };
    const contents = p.contents ?? "color";
    if (contents === "color") l.fill = hexColor(p.color, "edit.fill");
    else if (typeof contents === "string" && contents in map) l.fill = map[/** @type {keyof typeof map} */ (contents)];
    else throw new EngineError(`edit.fill: unknown contents \`${String(contents)}\``);
    bump(d, "Fill");
    return null;
  }),
  cmd("layer.arrange.bringToFront", "Bring to Front", ["Layer", "Arrange"], "Cmd+Shift+]", '{"layer":id?}', (e, d, p) => {
    const l = layerOf(d, p.layer);
    d.layers = d.layers.filter((x) => x !== l).concat(l); bump(d, "Bring to Front");
    return null;
  }),
  cmd("layer.arrange.sendToBack", "Send to Back", ["Layer", "Arrange"], "Cmd+Shift+[", '{"layer":id?}', (e, d, p) => {
    const l = layerOf(d, p.layer);
    d.layers = [l, ...d.layers.filter((x) => x !== l)]; bump(d, "Send to Back");
    return null;
  }),
  cmd("edit.transform", "Free Transform", ["Edit", "Transform"], "Cmd+T", '{"layer":id?,"offset":[x,y]?,"scaleX":number?,"scaleY":number?}', (e, d, p) => {
    const l = layerOf(d, p.layer);
    if (p.offset !== undefined) {
      if (!Array.isArray(p.offset) || p.offset.length !== 2 || typeof p.offset[0] !== "number" || typeof p.offset[1] !== "number") throw new EngineError("edit.transform: `offset` must be [x, y]");
      l.bounds = [l.bounds[0] + p.offset[0], l.bounds[1] + p.offset[1], l.bounds[2], l.bounds[3]];
    }
    const sx = p.scaleX ?? 1, sy = p.scaleY ?? 1;
    if (typeof sx !== "number" || typeof sy !== "number") throw new EngineError("edit.transform: `scaleX`/`scaleY` must be numbers");
    l.bounds = [l.bounds[0], l.bounds[1], Math.max(1, Math.round(l.bounds[2] * sx)), Math.max(1, Math.round(l.bounds[3] * sy))]; bump(d, "Transform");
    return null;
  }),
  cmd("layer.layerMask.revealAll", "Reveal All", ["Layer", "Layer Mask"], null, '{"layer":id?}', (e, d, p) => {
    layerOf(d, p.layer).hasMask = true; bump(d, "Add Layer Mask");
    return null;
  }),
  cmd("agent.begin", "Begin Checkpoint", [], null, '{"name":str?}', (e, d, p) => {
    const name = typeof p.name === "string" ? p.name : `checkpoint-${d.checkpoints.length + 1}`;
    d.checkpoints.push({ name, revision: d.revision, layers: structuredClone(d.layers), activeLayer: d.activeLayer, selected: [...d.selected] });
    return { checkpoint: name };
  }),
  cmd("agent.commit", "Commit Checkpoint", [], null, '{"name":str?}', (e, d, p) => {
    const cp = findCheckpoint(d, p.name, "agent.commit");
    d.checkpoints.splice(d.checkpoints.indexOf(cp), 1);
    return { checkpoint: cp.name };
  }),
  cmd("agent.rollback", "Rollback Checkpoint", [], null, '{"name":str?}', (e, d, p) => {
    const cp = findCheckpoint(d, p.name, "agent.rollback");
    d.layers = structuredClone(cp.layers); d.activeLayer = cp.activeLayer; d.selected = [...cp.selected];
    bump(d, "Agent Rollback");
    return { checkpoint: cp.name };
  }),
];
function findCheckpoint(d, name, label) {
  const cp = typeof name === "string" ? d.checkpoints.findLast((c) => c.name === name) : d.checkpoints.at(-1);
  if (!cp) throw new EngineError(`${label}: no checkpoint`);
  return cp; }

/* ---------- the engine session (shared by all connections, like `serve`) ---------- */
export class MockEngine {
  constructor() {
    /** @type {any[]} */ this.docs = [];
    /** @type {any[]} */ this.jobs = [];
    this.active = null; this.nextLayerId = 1; this.nextJobId = 1;
    this.writeRoot = process.env.MOCK_ENGINE_WRITE_ROOT || process.cwd();
  }
  /** @param {string} method @param {any} params */
  handle(method, params) {
    const p = params ?? {};
    if (typeof p !== "object" || Array.isArray(p)) throw new EngineError(`params for \`${method}\` must be a JSON object`);
    if (method === "methods") return METHOD_NAMES;
    const fn = ({
      "engine.commands": (q) => this.commandList(q), "engine.execute": (q) => this.execute(q), "jobs.list": () => ({ jobs: this.jobs }),
      "session.list": () => this.sessionList(), "doc.new": (q) => this.docNew(q), "doc.open": (q) => this.docOpen(q),
      "doc.place": (q) => this.docPlace(q), "doc.inspect": (q) => this.docInspect(this.docAt(q.index)), "doc.render": (q) => this.docRender(q),
      "doc.save": (q) => this.docSave(q), "doc.select": (q) => this.docSelect(q), "doc.close": (q) => this.docClose(q), "batch": (q) => this.batch(q),
    })[method];
    if (!fn) throw new EngineError(`unknown method \`${method}\` (try \`methods\`)`);
    return fn(p);
  }
  docAt(index) {
    if (index === undefined || index === null) {
      if (this.active === null) throw new EngineError("no document open");
      return this.docs[this.active]; }
    if (!Number.isInteger(index) || index < 0) throw new EngineError("`index` must be a non-negative integer");
    const d = this.docs[index];
    if (!d) throw new EngineError(`no document at index ${index}`);
    return d;
  }
  makeDoc(name, width, height, mode, fill, path) {
    const d = { name, path, width, height, mode, depth: 8, dirty: false, revision: 1, layers: [], activeLayer: null, selected: [], history: ["New Document"], checkpoints: [] };
    const bg = { id: this.nextLayerId++, name: "Background", kind: "Pixel", bounds: [0, 0, width, height], visible: true, opacity: 1, fill };
    d.layers.push(bg); d.activeLayer = bg.id; d.selected = [bg.id];
    this.docs.push(d); this.active = this.docs.length - 1;
    return d;
  }
  docNew(p) {
    const width = num(p, "width", 1, 300000, 1920, "doc.new"), height = num(p, "height", 1, 300000, 1080, "doc.new");
    const mode = p.mode ?? "rgb"; if (!["rgb", "gray", "grayscale", "cmyk", "lab"].includes(mode)) throw new EngineError("doc.new: unknown `mode`");
    const bg = p.background ?? "white";
    const fill = bg === "transparent" ? null : bg === "black" ? "#000000" : bg === "white" ? "#ffffff" : hexColor(bg, "doc.new");
    const name = typeof p.name === "string" && p.name ? p.name : `Untitled-${this.docs.length + 1}`;
    this.makeDoc(name, width, height, mode, fill, null);
    return { document: this.active };
  }
  docOpen(p) {
    const path = relPath(p.path, "path", "doc.open");
    this.makeDoc(basename(path).replace(/\.[^.]+$/, "") || "Untitled", 1024, 1024, "rgb", "#ffffff", path);
    return { document: this.active, name: this.docs[this.active].name, path, warnings: [] };
  }
  docPlace(p) {
    const path = relPath(p.path, "path", "doc.place");
    const d = this.docAt(p.index);
    const okCenter = Array.isArray(p.center) && p.center.length === 2 && typeof p.center[0] === "number" && typeof p.center[1] === "number";
    const cx = okCenter ? p.center[0] : d.width / 2, cy = okCenter ? p.center[1] : d.height / 2;
    const bounds = [Math.round(cx - d.width / 4), Math.round(cy - d.height / 4), Math.round(d.width / 2), Math.round(d.height / 2)];
    const l = { id: this.nextLayerId++, name: basename(path) || "Placed", kind: "Smart", bounds, visible: true, opacity: 1, fill: null };
    insertAbove(d, l); d.activeLayer = l.id; bump(d, "Place");
    return { layer: l.id, scale: p.scale ?? 100, bounds: [...bounds] };
  }
  docRender(p) {
    this.docAt(p.index);
    const maxSide = p.maxSide ?? 1024;
    if (!Number.isInteger(maxSide) || maxSide < 0) throw new EngineError("maxSide must be an unsigned 32-bit integer");
    const png = grayPng();
    if (p.path === undefined || p.path === null) return { mime: "image/png", base64: png.toString("base64") };
    const rel = relPath(p.path, "path", "doc.render");
    const abs = resolve(this.writeRoot, rel);
    mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, png);
    return { path: rel, bytes: png.length };
  }
  docSave(p) {
    const d = this.docAt(p.index);
    const target = p.path ?? d.path;
    if (typeof target !== "string" || !target) throw new EngineError("doc.save: the document has no file; pass `path`");
    const rel = relPath(target, "path", "doc.save");
    const snapshot = { format: "studio-mock-engine-snapshot", version: 1, name: d.name, width: d.width, height: d.height, mode: d.mode, revision: d.revision, layers: d.layers.map(publicLayer) };
    const body = `${JSON.stringify(snapshot, null, 1)}\n`;
    const abs = resolve(this.writeRoot, rel);
    mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, body);
    d.path = rel; d.dirty = false; // a layered save clears `dirty` (protocol › doc.save)
    return { path: rel, bytes: Buffer.byteLength(body), warnings: [] };
  }
  docSelect(p) {
    if (p.index === undefined || p.index === null) throw new EngineError("doc.select needs `index`");
    this.docAt(p.index); this.active = p.index;
    return null;
  }
  docClose(p) {
    let i = this.active;
    if (p.index !== undefined && p.index !== null) { this.docAt(p.index); i = p.index; }
    if (i === null) throw new EngineError("no document open");
    this.docs.splice(i, 1); this.active = this.docs.length === 0 ? null : Math.min(i, this.docs.length - 1);
    return null;
  }
  sessionList() {
    return {
      active: this.active,
      documents: this.docs.map((d, i) => ({ index: i, name: d.name, path: d.path, width: d.width, height: d.height, dirty: d.dirty, revision: d.revision })),
      foreground: { mode: "Rgb", c: [0, 0, 0, 0], alpha: 1 }, background: { mode: "Rgb", c: [1, 1, 1, 0], alpha: 1 },
    };
  }
  docInspect(d) {
    return {
      name: d.name, path: d.path, width: d.width, height: d.height, mode: d.mode, depth: d.depth,
      activeLayer: d.activeLayer, selectedLayers: [...d.selected], hasSelection: false, selectionBounds: null,
      layers: [...d.layers].reverse().map((l) => ({
        id: l.id, name: l.name, kind: l.kind, visible: l.visible, opacity: l.opacity, fill: l.fill, blend: l.blend ?? "Normal",
        bounds: l.bounds ? [...l.bounds] : null, selected: d.selected.includes(l.id), hasMask: l.hasMask === true,
        ...(l.kind === "Group" ? { children: [], expanded: true } : {}), ...(l.text !== undefined ? { text: { text: l.text, font: "Mock Sans", sizePt: l.sizePt ?? 32 } } : {}),
      })),
      history: [...d.history], snapshots: [], canUndo: d.history.length > 1, canRedo: false, revision: d.revision,
    };
  }
  execute(p) {
    if (typeof p.command !== "string") throw new EngineError("engine.execute needs `command`");
    const c = COMMANDS.find((x) => x.id === p.command);
    if (!c) throw new EngineError(`unknown command \`${p.command}\``);
    const params = p.params ?? null;
    if (params !== null && (typeof params !== "object" || Array.isArray(params))) throw new EngineError(`params for \`${p.command}\` must be a JSON object`);
    const result = c.run(this, this.docAt(null), params ?? {});
    if (p.wait === false) { const job = this.nextJobId++; this.jobs.push({ id: job, state: "done", command: p.command }); return { job, pending: true }; }
    return result;
  }
  commandList(p) {
    const hasDoc = this.active !== null;
    const rows = COMMANDS.map((c) => ({ id: c.id, label: c.label, menu: c.menu, shortcut: c.shortcut, params: c.paramsDoc, enabled: hasDoc, disabledReason: hasDoc ? null : "no document open", needsDocument: !hasDoc }));
    return typeof p.filter === "string" ? rows.filter((r) => r.id.toLowerCase().includes(p.filter.toLowerCase())) : rows; }
  batch(p) {
    if (!Array.isArray(p.steps)) throw new EngineError("batch needs `steps`");
    if (p.steps.length > MAX_BATCH_STEPS) throw new EngineError(`batch contains ${p.steps.length} steps; maximum is ${MAX_BATCH_STEPS}`);
    const stop = p.stopOnError ?? true, results = [];
    let completed = 0, failed = 0;
    for (const s of p.steps) {
      try {
        if (s && typeof s === "object" && typeof s.command === "string") results.push({ ok: true, result: this.execute({ command: s.command, params: s.params ?? null, wait: s.wait }) });
        else if (s && typeof s === "object" && typeof s.method === "string") {
          if (s.method === "batch") throw new EngineError("nested batch");
          results.push({ ok: true, result: this.handle(s.method, s.params ?? null) });
        } else throw new EngineError("a step needs `command` or `method`");
        completed++;
      } catch (err) {
        results.push({ ok: false, error: err instanceof Error ? err.message : String(err) }); failed++;
        if (stop) break;
      }
    }
    return { completed, failed, results }; }
}

/** Public save-snapshot projection of a layer (task model: id/name/kind/text?/bounds/visible/opacity/fill). */
function publicLayer(l) {
  return { id: l.id, name: l.name, kind: l.kind, bounds: [...l.bounds], visible: l.visible, opacity: l.opacity, fill: l.fill, ...(l.text !== undefined ? { text: l.text } : {}) };
}
