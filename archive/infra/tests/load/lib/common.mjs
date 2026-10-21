// Shared zero-dependency helpers for the §21 load drills.
// Node 22+ only (repo baseline); no npm packages — spec §21 names k6/autocannon,
// these drills are the zero-install equivalent so any operator (or an opt-in CI
// job) can run them with a bare `node`.

import { randomBytes } from "node:crypto";
import zlib from "node:zlib";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

/**
 * Minimal argv parser for the drill CLIs.
 * spec: { [name]: { type: "string"|"int"|"number"|"bool", default?, repeat?, help } }
 * Accepts `--name=value`, `--name value`, and boolean `--name`.
 * Returns a plain object; unknown flags throw with the usage text.
 */
export function parseArgs(argv, spec, usage) {
  const out = {};
  for (const [name, def] of Object.entries(spec)) {
    if (def.default !== undefined) out[name] = def.default;
  }
  const resolve = (name) => {
    if (spec[name]) return name;
    const alias = Object.keys(spec).find((k) => spec[k].alias?.includes(name));
    if (alias) return alias;
    return null;
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--help" || tok === "-h") {
      console.log(usage);
      process.exit(0);
    }
    if (!tok.startsWith("--")) {
      throw new Error(`unexpected positional argument "${tok}".\n${usage}`);
    }
    let name = tok.slice(2);
    let inline = undefined;
    if (name.includes("=")) {
      const eq = name.indexOf("=");
      inline = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    const key = resolve(name);
    if (!key) throw new Error(`unknown option --${name}.\n${usage}`);
    const def = spec[key];
    if (def.type === "bool") {
      out[key] = true;
      continue;
    }
    const raw = inline !== undefined ? inline : argv[++i];
    if (raw === undefined) throw new Error(`--${name} expects a value.\n${usage}`);
    if (def.type === "int") out[key] = Number.parseInt(raw, 10);
    else if (def.type === "number") out[key] = Number(raw);
    else out[key] = raw;
    if (Number.isNaN(out[key])) throw new Error(`--${name} must be a number, got "${raw}".`);
  }
  for (const [name, def] of Object.entries(spec)) {
    if (def.repeat && out[name] !== undefined && !Array.isArray(out[name])) out[name] = [out[name]];
    if (def.repeat && out[name] === undefined) out[name] = def.default ?? [];
    if (def.required && out[name] === undefined) {
      throw new Error(`missing required option --${name}.\n${usage}`);
    }
  }
  return out;
}

/** `--header "K: V"` repeats → fetch headers object (keys lowercased, later wins). */
export function headersFromArgs(list) {
  const headers = {};
  for (const item of list ?? []) {
    const idx = item.indexOf(":");
    if (idx <= 0) throw new Error(`bad --header "${item}" — expected "Name: value".`);
    const k = item.slice(0, idx).trim().toLowerCase();
    headers[k] = item.slice(idx + 1).trim();
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

/** Nearest-rank percentile over unsorted samples. `p` in (0, 1]. */
export function percentile(samples, p) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

export function summarize(samples) {
  if (samples.length === 0) return { n: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return {
    n: sorted.length,
    min: sorted[0],
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1],
    mean,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export const fmtMs = (ms) => (ms === null || ms === undefined ? "—" : `${round1(ms)} ms`);
export const fmtSec = (s) => (s === null || s === undefined ? "—" : `${round1(s)} s`);
const round1 = (n) => Math.round(n * 10) / 10;

export function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}

export function fmtPct(x) {
  return `${(x * 100).toFixed(x < 0.0995 && x > 0 ? 2 : 1)}%`;
}

export const pad = (s, w) => String(s).padEnd(w, " ");
export const padL = (s, w) => String(s).padStart(w, " ");

export function line(char = "─", width = 72) {
  return char.repeat(width);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

export class HttpError extends Error {
  constructor(status, body, message) {
    super(message ?? `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

/** Group transport failures into stable classes for the error tables. */
export function errClass(err) {
  if (err instanceof HttpError) return `http_${err.status}`;
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return "timeout";
  const code = err?.cause?.code ?? err?.code ?? "";
  if (code === "ECONNRESET") return "conn_reset";
  if (code === "ECONNREFUSED") return "conn_refused";
  if (code === "EPIPE") return "conn_pipe";
  if (code === "UND_ERR_SOCKET") return "socket";
  return code || "error";
}

/**
 * fetch() a URL, read the full body, return { status, ms, bytes, body }.
 * Latency includes body transfer (previews/uploads are payload-bound, §13.1).
 */
export async function fetchFull(url, { method = "GET", headers = {}, body, timeoutMs = 15000 }) {
  const startedAt = performance.now();
  const signal = AbortSignal.timeout(timeoutMs);
  let res;
  let bytes = 0;
  let text = null;
  let raw = null;
  try {
    res = await fetch(url, { method, headers, body, signal, redirect: "manual" });
    if (method === "GET" || method === "HEAD") {
      raw = await res.arrayBuffer();
      bytes = raw.byteLength;
    } else {
      text = await res.text();
      bytes = Buffer.byteLength(text ?? "");
    }
  } catch (err) {
    err.__class = errClass(err);
    throw err;
  }
  const ms = performance.now() - startedAt;
  return { status: res.status, ms, bytes, body: text ?? Buffer.from(raw ?? ""), headers: res.headers };
}

// ---------------------------------------------------------------------------
// SSE (§13.2 run event stream)
// ---------------------------------------------------------------------------

/** Async generator over SSE frames of a fetch Response body. */
export async function* sseFrames(body) {
  const decoder = new TextDecoder();
  let buf = "";
  let pendingEvent = "";
  let pendingData = [];
  let pendingId = "";
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let sep;
    while ((sep = buf.search(/\r?\n\r?\n/)) !== -1) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep).replace(/^\r?\n\r?\n/, "");
      for (const rawLine of frame.split(/\r?\n/)) {
        if (rawLine.startsWith(":")) continue; // SSE comment / keepalive
        const colon = rawLine.indexOf(":");
        const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
        let value = colon === -1 ? "" : rawLine.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") pendingEvent = value;
        else if (field === "data") pendingData.push(value);
        else if (field === "id") pendingId = value;
      }
      if (pendingData.length > 0 || pendingEvent) {
        yield { event: pendingEvent, data: pendingData.join("\n"), id: pendingId };
      }
      pendingEvent = "";
      pendingData = [];
      pendingId = "";
    }
  }
}

/**
 * Follow a §13.2 run event stream until a terminal event
 * (run.succeeded | run.failed | run.cancelled) or the deadline.
 * Resumes with Last-Event-ID on stream drop (spec: client dedupes by `seq`).
 * Returns { terminal, seq, events, reconnects, ms, timedOut }.
 */
export async function followRunEvents(url, { headers = {}, deadlineMs, terminal = ["run.succeeded", "run.failed", "run.cancelled"], maxReconnects = 2, onEvent }) {
  const startedAt = performance.now();
  let lastSeq = 0;
  let reconnects = 0;
  const seen = [];
  for (;;) {
    const remaining = deadlineMs - (performance.now() - startedAt);
    if (remaining <= 0) return { terminal: null, seq: lastSeq, events: seen, reconnects, ms: performance.now() - startedAt, timedOut: true };
    const signal = AbortSignal.timeout(Math.max(1, Math.floor(remaining)));
    let res;
    try {
      res = await fetch(url, {
        headers: {
          accept: "text/event-stream",
          ...headers,
          ...(lastSeq > 0 ? { "last-event-id": String(lastSeq) } : {}),
        },
        signal,
      });
    } catch (err) {
      if (reconnects < maxReconnects && errClass(err) !== "timeout") {
        reconnects++;
        continue;
      }
      return { terminal: null, seq: lastSeq, events: seen, reconnects, ms: performance.now() - startedAt, timedOut: true, transport: errClass(err) };
    }
    if (!res.ok || !res.body) {
      if (reconnects < maxReconnects) {
        reconnects++;
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      return { terminal: null, seq: lastSeq, events: seen, reconnects, ms: performance.now() - startedAt, timedOut: true, transport: `http_${res.status}` };
    }
    let streamEnded = false;
    try {
      for await (const frame of sseFrames(res.body)) {
        let evt = null;
        try {
          evt = frame.data ? JSON.parse(frame.data) : null;
        } catch {
          evt = null;
        }
        const type = evt?.type ?? frame.event;
        const seq = typeof evt?.seq === "number" ? evt.seq : Number.parseInt(frame.id, 10) || 0;
        if (seq > lastSeq) lastSeq = seq;
        if (type) {
          seen.push({ type, seq, payload: evt?.payload ?? null });
          onEvent?.({ type, seq, payload: evt?.payload ?? null });
          if (terminal.includes(type)) {
            return { terminal: type, seq: lastSeq, events: seen, reconnects, ms: performance.now() - startedAt, timedOut: false };
          }
        }
      }
      streamEnded = true;
    } catch (err) {
      if (errClass(err) === "timeout") {
        return { terminal: null, seq: lastSeq, events: seen, reconnects, ms: performance.now() - startedAt, timedOut: true };
      }
      streamEnded = true;
    }
    if (streamEnded && reconnects < maxReconnects) {
      reconnects++;
      continue;
    }
    if (streamEnded) {
      return { terminal: null, seq: lastSeq, events: seen, reconnects, ms: performance.now() - startedAt, timedOut: true, transport: "stream_closed" };
    }
  }
}

// ---------------------------------------------------------------------------
// Multipart + synthetic PNG (upload throughput drill)
// ---------------------------------------------------------------------------

export function randomBoundary() {
  return `----studio-drill-${randomBytes(12).toString("hex")}`;
}

/**
 * Build a multipart/form-data body from parts.
 * parts: [{ name, filename?, contentType?, data: Buffer|Uint8Array|string }]
 * Returns { body: Buffer, contentType } (Content-Length is derivable → no chunked upload).
 */
export function buildMultipart(parts, boundary = randomBoundary()) {
  const chunks = [];
  const dash = `--${boundary}`;
  for (const part of parts) {
    chunks.push(Buffer.from(`${dash}\r\n`));
    const dispo = part.filename !== undefined
      ? `form-data; name="${part.name}"; filename="${part.filename}"`
      : `form-data; name="${part.name}"`;
    let head = `Content-Disposition: ${dispo}\r\n`;
    if (part.contentType) head += `Content-Type: ${part.contentType}\r\n`;
    head += "\r\n";
    chunks.push(Buffer.from(head));
    chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`${dash}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

let crcTable = null;
function crc32(buf) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buf) >>> 0; // Node ≥ 20.12
  crcTable ??= Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Deterministic 32-bit LCG so the PNG is byte-identical across runs. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

/**
 * A valid ~targetBytes RGB PNG made of deterministic noise.
 * Noise + zlib level 0 (stored) keeps the file size predictable (~target).
 * Purely synthetic per §21 "test data: synthetic only".
 */
export function makeSyntheticPng(targetBytes = 5 * 1024 * 1024, seed = 0x9e3779b9) {
  const width = 1280;
  const bytesPerPixel = 3;
  const rowLen = width * bytesPerPixel + 1; // +1 filter byte per scanline
  const height = Math.max(1, Math.floor((targetBytes - 4096) / rowLen));
  const raw = Buffer.alloc(height * rowLen);
  const next = lcg(seed);
  for (let y = 0; y < height; y++) {
    const off = y * rowLen;
    raw[off] = 0; // filter: None
    for (let x = 1; x < rowLen; x += 4) {
      // paint a few pixels per PRNG draw for speed
      const r = next();
      raw[off + x] = (r >>> 24) & 0xff;
      if (x + 1 < rowLen) raw[off + x + 1] = (r >>> 16) & 0xff;
      if (x + 2 < rowLen) raw[off + x + 2] = (r >>> 8) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  const idat = zlib.deflateSync(raw, { level: 0 }); // stored → incompressible ≈ raw size
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return png;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Bounded-concurrency pool over an index range; fn(i) → promise. */
export function pool(count, concurrency, fn) {
  return new Promise((resolve, reject) => {
    let next = 0;
    let active = 0;
    const results = new Array(count);
    const launch = () => {
      while (active < concurrency && next < count) {
        const i = next++;
        active++;
        Promise.resolve()
          .then(() => fn(i))
          .then(
            (r) => {
              results[i] = { ok: true, value: r };
            },
            (e) => {
              results[i] = { ok: false, error: e };
            },
          )
          .then(() => {
            active--;
            if (next >= count && active === 0) resolve(results);
            else launch();
          });
      }
    };
    launch();
  });
}

/** ISO timestamp for report headers. */
export const nowIso = () => new Date().toISOString();

/** Print a machine-readable JSON summary line (`--json`). */
export function printJson(label, obj) {
  console.log(`\n${label}: ${JSON.stringify(obj)}`);
}
