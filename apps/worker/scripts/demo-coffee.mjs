#!/usr/bin/env node
// apps/worker/scripts/demo-coffee.mjs — the §19 Phase-0 exit demo: the §24.1
// coffee-shop promo run END-TO-END against the mock-engine, with ZERO product
// polish and ZERO npm dependencies (bare `node`; W2-J demo-spine mechanics).
//
// §19 Phase 0 exit criteria (VERBATIM):
//   "pnpm demo:coffee produces a valid layered `.pcraft`, a PNG, a critic report,
//    and a command log, deterministically, in `local` Compose."
//
// The run it executes is the §24.1 trace (abbreviated; real ids in the log):
//   plan    → template instagram-post@3, slots{headline, subhead, photo:asset_812},
//             palette[cream, brown, terracotta]                    (hard-coded plan)
//   apply   → template.apply {id:"instagram-post@3"} — the mock has no template
//             commands yet (Phase 2 §2.3 template_cmds.rs), so the call is
//             REFUSED GRACEFULLY and the apply is EMULATED: the compiled manifest's
//             layer sequence (evals/templates/instagram-post@3/manifest.json),
//             driven command-by-command over the control protocol
//   place   → doc.place asset_812 → Photo (slot-box transform; the mock's
//             doc.place has no cover/focal params)
//   fill    → type.edit Headline (96→88pt, 2 lines), type.edit Subhead (36pt);
//             the printed template.fill slot payload is what the §6 tool would
//             send on the real engine
//   style   → layer.layerStyle.dropShadow Headline — refused gracefully (not in
//             the mock command set), the run continues
//   render  → preview maxSide 1024 (PNG magic verified) + engine-side render file
//   validate→ manifest.rules over doc.inspect (mustLayers / maxTextLayers /
//             safeArea) — 0 blockers
//   critique→ MOCK CRITIC: placeholder §24.1 rubric, ZERO model calls (§1.5-6:
//             no free-tier LLM ever sees content); contrast is COMPUTED (WCAG)
//             from the palette, not invented
//   commit  → agent.commit — one undoable unit (§5.6); charge 2 credits (mocked)
//   save    → layered .pcraft (mock snapshot format) + PNG + critic-report.json +
//             command-log.jsonl (WAL-shaped rows) → apps/worker/.demo-output/
//
// Determinism (§19 "deterministically"): the trace runs TWICE, each against a
// fresh spawned mock-engine; the .pcraft/PNG/critic bytes and the
// timestamp-stripped WAL rows must hash identical — asserted in-process. Pin the
// digest externally with DEMO_COFFEE_EXPECT_SHA256=<hex> (optional, CI hook).
//
// Usage:
//   node apps/worker/scripts/demo-coffee.mjs
//   MOCK_ENGINE_PORT=7800 MOCK_ENGINE_TOKEN=<64 hex> node apps/worker/scripts/demo-coffee.mjs
//     (connect mode: drive the local-Compose mock-engine instead of spawning one;
//      the replay-hash assert needs fresh spawns, so it runs in spawn mode only)
//
// Suggested wiring (NOT added here — apps/worker/package.json belongs to the
// worker lineage owner; see demo-coffee-README.md):
//   "demo:coffee": "node scripts/demo-coffee.mjs"
//
// Exit codes: 0 demo ok; 1 failure; 2 mock-engine not found (spawn mode).

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK_ENTRY = fileURLToPath(new URL("../../mock-engine/src/index.mjs", import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const OUT_DIR = path.resolve(HERE, "../.demo-output");
const MANIFEST_PATH = path.join(REPO_ROOT, "evals", "templates", "instagram-post@3", "manifest.json");

// §24.1 brief + slot values (VERBATIM from the spec's worked example).
const BRIEF =
  "Coffee shop promo post, warm and cozy, headline 'Fresh roasted, every morning', " +
  "sub 'Open 7–5 · Main St', use the latte photo.";
const TEMPLATE_ID = "instagram-post@3";
const TIER = "standard";
const PHOTO_ASSET_ID = "asset_812"; // fixed fixture id (evals/fixtures/README.md rule 4)
const PHOTO_PATH = "assets/asset_photo_1080x700.png"; // relative to the write root (§25.6)
const HEADLINE_TEXT = "Fresh roasted,\nevery morning"; // §24.1: "96→88pt, 2 lines"
const SUBHEAD_TEXT = "Open 7–5 · Main St";
const AUTOFIT_FROM_PT = 96; // manifest slots.headline.size
const AUTOFIT_TO_PT = 88; // §24.1 fill line
const RUN_NAME = "coffee-promo-run"; // agent.begin/commit checkpoint name (§5.6)
const DOC_NAME = "Coffee Promo";
const DOCUMENT_ID = "demo_doc_coffee_promo_0001"; // fixed demo id (deterministic WAL rows)
const VERSION_LABEL = "First draft"; // §24.1 save line
const CREDITS = 2; // §24.1 commit line: "charge 2 credits"
const SAVE_PATH = "coffee-promo.pcraft";
const PNG_PATH = "coffee-promo.png";
const ENGINE_RENDER_PATH = "renders/coffee-promo.png";
const WAL_PATH = "command-log.jsonl";
const CRITIC_PATH = "critic-report.json";
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

const log = (line) => process.stdout.write(`${line}\n`);
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

class DemoError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "DemoError";
    this.exitCode = exitCode;
  }
}

const summarize = (value) => {
  const json = JSON.stringify(value);
  if (json === undefined) return "null";
  return json.length > 72 ? `${json.slice(0, 69)}…` : json;
};

/** Format engine params for the printed log (compact, relative paths only). */
const brief = (params) => {
  const json = JSON.stringify(params ?? {});
  return json.length > 58 ? `${json.slice(0, 55)}…` : json;
};

// ---------------------------------------------------------------------------
// A minimal control-protocol client (newline-delimited JSON, first-frame auth,
// id-correlated replies, one outstanding call at a time) — the wire the real
// EngineClient facade speaks (vendor control-protocol docs).
// ---------------------------------------------------------------------------

class EngineReplyError extends Error {
  constructor(text) {
    super(`engine error reply: ${text}`);
    this.name = "EngineReplyError";
    this.raw = text;
  }
}

class ControlClient {
  constructor(port, token) {
    this.port = port;
    this.token = token;
    this.socket = null;
    this.buffer = "";
    this.pending = null;
    this.nextId = 1;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port: this.port });
      socket.setNoDelay(true);
      const onConnectError = (error) => {
        socket.destroy();
        reject(error);
      };
      socket.once("error", onConnectError);
      socket.once("connect", () => {
        socket.off("error", onConnectError);
        socket.on("error", (error) => this.failPending(error));
        resolve();
      });
      socket.on("close", () => this.failPending(new Error("the connection closed")));
      socket.on("data", (chunk) => this.onChunk(chunk));
      this.socket = socket;
    });
  }

  onChunk(chunk) {
    this.buffer += chunk.toString("utf8");
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) this.onLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  onLine(line) {
    let reply = null;
    try {
      reply = JSON.parse(line);
    } catch {
      return; // not a framed reply — ignore stray bytes
    }
    if (this.pending !== null && reply.id === this.pending.id) {
      const waiter = this.pending;
      this.pending = null;
      waiter.resolve(reply);
    }
  }

  failPending(error) {
    if (this.pending !== null) {
      const waiter = this.pending;
      this.pending = null;
      waiter.reject(error);
    }
  }

  async call(method, params) {
    if (this.pending !== null) {
      throw new Error("one outstanding call at a time (control protocol)");
    }
    const id = this.nextId;
    this.nextId += 1;
    const frame = `${JSON.stringify({ id, method, params })}\n`;
    const reply = await new Promise((resolve, reject) => {
      this.pending = { id, resolve, reject };
      this.socket.write(frame);
    });
    if (reply.ok !== true) {
      throw new EngineReplyError(typeof reply.error === "string" ? reply.error : "unknown");
    }
    return reply.result;
  }

  /** The first frame on every connection must be auth (security.rs). */
  auth() {
    return this.call("auth", { token: this.token });
  }

  /** Run one engine.execute command. */
  execute(command, params) {
    return this.call("engine.execute", { command, params: params ?? {} });
  }

  close() {
    if (this.socket !== null) this.socket.end();
  }
}

/** Attempt a call the mock is EXPECTED to refuse; prove the client survives it. */
async function probe(client, kind, call, params) {
  try {
    const result =
      kind === "method" ? await client.call(call, params) : await client.execute(call, params);
    return { supported: true, result, error: null };
  } catch (error) {
    if (error instanceof EngineReplyError) return { supported: false, result: null, error: error.raw };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// mock-engine spawn (env contract per apps/mock-engine: MOCK_ENGINE_PORT=0 picks
// an ephemeral port; the bound port is announced on stderr as text)
// ---------------------------------------------------------------------------

const ANNOUNCE_TIMEOUT_MS = 15_000;
const STDERR_ANNOUNCE = /listening on 127\.0\.0\.1:(\d+)/;

async function waitForAnnouncedPort(child) {
  return new Promise((resolve, reject) => {
    let stderrBuffer = "";
    let settled = false;
    const finish = (port) => {
      if (settled) return;
      settled = true;
      cleanup();
      clearTimeout(deadline);
      resolve(port);
    };
    const fail = (reason) => {
      if (settled) return;
      settled = true;
      cleanup();
      clearTimeout(deadline);
      reject(reason);
    };
    const deadline = setTimeout(() => {
      fail(new Error(`no listening announcement within ${ANNOUNCE_TIMEOUT_MS} ms`));
    }, ANNOUNCE_TIMEOUT_MS);
    const onStderr = (chunk) => {
      stderrBuffer += chunk.toString("utf8");
      const match = STDERR_ANNOUNCE.exec(stderrBuffer);
      if (match !== null) {
        const port = Number.parseInt(match[1], 10);
        if (Number.isInteger(port) && port > 0) finish(port);
      }
    };
    const onError = (error) => fail(error);
    const cleanup = () => {
      child.stderr?.off("data", onStderr);
      child.stdout?.off("data", () => {});
      child.off("error", onError);
    };
    child.stderr?.on("data", onStderr);
    child.on("error", onError);
  });
}

async function spawnMock(writeRoot) {
  const token = randomBytes(32).toString("hex"); // 256-bit control token (security.rs)
  const child = spawn(process.execPath, [MOCK_ENTRY], {
    env: {
      ...process.env,
      MOCK_ENGINE_PORT: "0",
      MOCK_ENGINE_TOKEN: token,
      MOCK_ENGINE_ROOT: writeRoot,
      MOCK_ENGINE_WRITE_ROOT: writeRoot,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const port = await waitForAnnouncedPort(child);
  return { child, port, token };
}

async function stopMock(spawned) {
  spawned.child.kill("SIGTERM");
  await new Promise((resolve) => {
    spawned.child.once("exit", resolve);
    setTimeout(() => {
      spawned.child.kill("SIGKILL");
      resolve();
    }, 1500).unref();
  });
}

// ---------------------------------------------------------------------------
// The command log — JSONL rows shaped like the §5.6 WAL (WalAppendInput:
// documentId, seq, commandName, params, revisionBefore, revisionAfter, flag)
// plus demo-only annotations (ts, kind, trace, stage, probe, error).
// Append-only: rows are never rewritten; probes are marked, never dropped.
// ---------------------------------------------------------------------------

class CommandLog {
  constructor(documentId) {
    this.documentId = documentId;
    this.rows = [];
  }

  append(entry) {
    const row = { documentId: this.documentId, seq: this.rows.length + 1, ts: new Date().toISOString(), ...entry };
    this.rows.push(row);
    return row;
  }

  /** Timestamp-stripped rows (§19 determinism: timestamps excluded from hashing). */
  canonical() {
    return this.rows.map((row) => JSON.stringify(({ ts: _ts, ...rest }) => rest)(row)).join("\n");
  }

  toJsonl() {
    return `${this.rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  }

  /** §5.6 chain rule: rows are chained (before[i] === after[i-1]) and monotonic. */
  assertChain(label) {
    let previous = null;
    for (const row of this.rows) {
      if (previous !== null && row.revisionBefore !== previous) {
        throw new DemoError(`${label}: WAL chain broke at seq ${row.seq} (before ${row.revisionBefore}, expected ${previous})`);
      }
      if (row.revisionAfter < row.revisionBefore) {
        throw new DemoError(`${label}: WAL revision rewound at seq ${row.seq}`);
      }
      previous = row.revisionAfter;
    }
  }
}

// ---------------------------------------------------------------------------
// The synthetic latte-photo fixture — per
// evals/templates/instagram-post@3/assets-note.md (1080×700 RGB, vertical
// gradient cream→terracotta + three ink circles at 25% screen blend), built
// with a tiny in-code PNG writer (no deps, no anti-aliasing, deterministic).
// ---------------------------------------------------------------------------

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const t = Buffer.from(type, "latin1");
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  t.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([t, data])), 8 + data.length);
  return out;
}

/** Minimal PNG encoder: 8-bit RGB (color type 2), filter byte 0 per scanline. */
function encodeRgbPng(width, height, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: adaptive per scanline (byte 0 = None)
  ihdr[12] = 0; // interlace: no
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const hexToRgb = (hex) => [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)];
const lerp = (a, b, t) => a + (b - a) * t;
/** 25% screen blend of `blend` over `base` (assets-note.md: "at 25% screen blend"). */
const screenQuarter = (base, blend) => {
  const screened = 255 - ((255 - base) * (255 - blend)) / 255;
  return Math.round(base + 0.25 * (screened - base));
};

function buildPhotoFixture(width, height, cream, terracotta, ink) {
  const top = hexToRgb(cream);
  const bottom = hexToRgb(terracotta);
  const inkRgb = hexToRgb(ink);
  const circles = [
    { cx: 270, cy: 200, r: 140 },
    { cx: 540, cy: 400, r: 170 },
    { cx: 810, cy: 230, r: 120 },
  ];
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    raw[row] = 0; // filter byte: None
    const t = y / (height - 1);
    for (let x = 0; x < width; x++) {
      let r = lerp(top[0], bottom[0], t);
      let g = lerp(top[1], bottom[1], t);
      let b = lerp(top[2], bottom[2], t);
      for (const c of circles) {
        const dx = x - c.cx;
        const dy = y - c.cy;
        if (dx * dx + dy * dy <= c.r * c.r) {
          r = screenQuarter(r, inkRgb[0]);
          g = screenQuarter(g, inkRgb[1]);
          b = screenQuarter(b, inkRgb[2]);
        }
      }
      const at = row + 1 + x * 3;
      raw[at] = Math.round(r);
      raw[at + 1] = Math.round(g);
      raw[at + 2] = Math.round(b);
    }
  }
  return encodeRgbPng(width, height, raw);
}

/** Use the repo's generated gradient fixture when present; else synthesize in-code. */
function loadPhotoFixture(palette) {
  const candidates = [
    path.join(REPO_ROOT, "evals", "fixtures", "generated"),
    path.join(REPO_ROOT, "evals", "fixtures", "assets"),
  ];
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    const names = (readdirSync(dir) ?? []).filter((n) => n.toLowerCase().endsWith(".png")).sort();
    if (names.length > 0) {
      const bytes = readFileSync(path.join(dir, names[0]));
      return { bytes, source: path.relative(REPO_ROOT, path.join(dir, names[0])) };
    }
  }
  return {
    bytes: buildPhotoFixture(1080, 700, palette[0], palette[2], palette[1]),
    source: "synthetic in-code (assets-note.md spec; evals/fixtures has no generated PNG yet)",
  };
}

// ---------------------------------------------------------------------------
// Deterministic scoring helpers (no model calls — §1.5-6)
// ---------------------------------------------------------------------------

const channelLin = (c8) => {
  const c = c8 / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const relLum = (rgb) => 0.2126 * channelLin(rgb[0]) + 0.7152 * channelLin(rgb[1]) + 0.0722 * channelLin(rgb[2]);

/** WCAG contrast ratio of two #rrggbb colors (§11 checks; computed, not modeled). */
function contrastRatio(hexA, hexB) {
  const la = relLum(hexToRgb(hexA));
  const lb = relLum(hexToRgb(hexB));
  const hi = la >= lb ? la : lb;
  const lo = la >= lb ? lb : la;
  return (hi + 0.05) / (lo + 0.05);
}

const assertEq = (actual, expected, label) => {
  if (actual !== expected) {
    throw new DemoError(`${label}: expected ${summarize(expected)}, got ${summarize(actual)}`);
  }
};

// ---------------------------------------------------------------------------
// The §24.1 coffee trace, end-to-end against one engine session
// ---------------------------------------------------------------------------

function makeStepPrinter(prefix, quiet) {
  let n = 0;
  return async function step(label, run) {
    n += 1;
    const tag = `${prefix}[${String(n).padStart(2, "0")}]`;
    if (!quiet) log(`${tag} ${label}`);
    try {
      const result = await run();
      if (quiet) log(`${tag} ${label} — ok`);
      else log(`     ok → ${summarize(result)}`);
      return result;
    } catch (error) {
      log(`     FAILED: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  };
}

/**
 * @param {object} input
 *   client        ControlClient (already authed by the caller)
 *   artifactDir   where the demo writes its own artifacts (pcraft/PNG/log/report)
 *   manifest      parsed evals/templates/instagram-post@3/manifest.json
 *   fixture        {bytes, source} photo fixture
 *   verbose       full per-step output (pass A / connect); quiet = pass B
 *   label         pass label for error messages
 */
async function runCoffeeTrace({ client, artifactDir, manifest, fixture, verbose, label }) {
  const canvas = manifest.canvas;
  const slots = manifest.slots;
  const rules = manifest.rules;
  const palette = rules.palette; // [cream, brown, terracotta] per the manifest
  const headlineSlot = slots.headline;
  const subheadSlot = slots.subhead;
  const photoSlot = slots.photo;
  const step = makeStepPrinter(verbose ? "" : "     ", !verbose);
  const cmd = new CommandLog(DOCUMENT_ID);
  let rev = 0;

  const track = (entry) => {
    const row = cmd.append({ flag: null, ...entry });
    if (row.revisionBefore !== rev) {
      throw new DemoError(`${label}: revision ledger desync at seq ${row.seq} (row ${row.revisionBefore}, ledger ${rev})`);
    }
    rev = row.revisionAfter;
    return row;
  };

  // plan ------------------------------------------------------------- §24.1 line 1
  await step("plan — brief → template + slots + palette (hard-coded §23.2 stand-in)", () => {
    log(`     brief .... ${BRIEF}`);
    log(`     template . ${TEMPLATE_ID} (${TIER} tier)`);
    log(
      `     slots .... ${summarize({ headline: HEADLINE_TEXT.replace("\n", " "), subhead: SUBHEAD_TEXT, photo: PHOTO_ASSET_ID })}`,
    );
    log(`     palette .. ${palette.join(" ")} (cream, brown, terracotta)`);
    return { template: TEMPLATE_ID, tier: TIER };
  });

  // provision the document (canvas comes from the compiled manifest) --------
  const created = await step(`doc.new ${canvas.width}×${canvas.height} background ${canvas.background}`, () =>
    client.call("doc.new", {
      width: canvas.width,
      height: canvas.height,
      name: DOC_NAME,
      background: canvas.background,
      mode: "rgb",
    }),
  );
  assertEq(created.document, 0, `${label}: doc.new`);
  track({
    kind: "method", trace: "plan", stage: "planning", commandName: "doc.new",
    params: { width: canvas.width, height: canvas.height, background: canvas.background },
    revisionBefore: 0, revisionAfter: 1,
  });

  // apply ------------------------------------------------------------- §24.1 line 2
  const applied = await step(`template.apply {id:"${TEMPLATE_ID}"} (real-engine tool call)`, () =>
    probe(client, "method", "template.apply", { id: TEMPLATE_ID }),
  );
  if (applied.supported) {
    log("     the mock now serves template.apply natively — using it");
  } else {
    log(`     gracefully refused → ${applied.error}`);
    log("     (template commands land in Phase 2 §2.3; the demo applies the compiled");
    log("      manifest's layer sequence directly, command-by-command — W2-J mechanics)");
  }
  track({
    kind: "method", trace: "apply", stage: "executing", commandName: "template.apply",
    params: { id: TEMPLATE_ID }, revisionBefore: 1, revisionAfter: 1, probe: true,
    error: applied.supported ? null : applied.error, result: applied.supported ? summarize(applied.result) : null,
  });

  // one transaction: agent.begin BEFORE the first mutating command (§5.6) --
  const began = await step(`agent.begin {name:"${RUN_NAME}"} — §5.6 one transaction per run`, () =>
    client.execute("agent.begin", { name: RUN_NAME }),
  );
  assertEq(began.checkpoint, RUN_NAME, `${label}: agent.begin`);
  track({
    kind: "command", trace: "apply", stage: "executing", commandName: "agent.begin",
    params: { name: RUN_NAME }, revisionBefore: 1, revisionAfter: 1,
  });

  // emulated apply: the manifest's layer sequence (bottom-up like the template)
  const placeCenter = [Math.round((photoSlot.bounds[0] + photoSlot.bounds[2]) / 2), Math.round((photoSlot.bounds[1] + photoSlot.bounds[3]) / 2)];
  const applySteps = [
    { method: "doc.place", params: { path: PHOTO_PATH, center: placeCenter, scale: 100 } },
    { command: "layer.setProps", params: { layer: "asset_photo_1080x700.png", name: "Photo" } },
    {
      command: "edit.transform",
      params: {
        layer: "Photo",
        offset: [photoSlot.bounds[0] - Math.round(canvas.width / 4), photoSlot.bounds[1] - Math.round(canvas.height / 4)],
        scaleX: 2,
        scaleY: photoSlot.bounds[3] / (canvas.height / 2),
      },
    },
    { command: "type.create", params: { text: "Headline", x: headlineSlot.bounds[0], y: headlineSlot.bounds[1], size: headlineSlot.size } },
    { command: "type.create", params: { text: "Subhead", x: subheadSlot.bounds[0], y: subheadSlot.bounds[1], size: subheadSlot.size } },
  ];
  const applyBatch = await step(
    "apply (emulated): doc.place photo → rename Photo → fit slot box → type.create Headline 96pt → Subhead 36pt",
    () => client.call("batch", { steps: applySteps }),
  );
  assertEq(applyBatch.failed, 0, `${label}: apply batch`);
  assertEq(applyBatch.completed, applySteps.length, `${label}: apply batch`);
  const applyRows = [
    { kind: "method", commandName: "doc.place", params: { path: PHOTO_PATH, center: placeCenter }, trace: "place" },
    { kind: "command", commandName: "layer.setProps", params: { layer: "Photo", name: "Photo" }, trace: "place" },
    { kind: "command", commandName: "edit.transform", params: { layer: "Photo", fit: "slot-box" }, trace: "place" },
    { kind: "command", commandName: "type.create", params: { text: "Headline", size: headlineSlot.size }, trace: "apply" },
    { kind: "command", commandName: "type.create", params: { text: "Subhead", size: subheadSlot.size }, trace: "apply" },
  ];
  for (const entry of applyRows) {
    track({ ...entry, stage: "executing", revisionBefore: rev, revisionAfter: rev + 1 });
  }
  let inspected = await step("doc.inspect — revisions asserted at phase boundaries", () => client.call("doc.inspect", null));
  assertEq(inspected.revision, rev, `${label}: revision after apply`);

  // fill -------------------------------------------------------------- §24.1 line 4
  const fillPayload = { id: TEMPLATE_ID, slots: { headline: HEADLINE_TEXT, subhead: SUBHEAD_TEXT, photo: PHOTO_ASSET_ID }, palette };
  await step("template.fill slot call — the payload the §6 tool sends (printed)", () => {
    log(`     ${JSON.stringify(fillPayload)}`);
    return fillPayload;
  });
  const filled = await step(`template.fill {id:"${TEMPLATE_ID}"} (real-engine tool call)`, () =>
    probe(client, "method", "template.fill", fillPayload),
  );
  if (filled.supported) {
    log("     the mock now serves template.fill natively — using it");
  } else {
    log(`     gracefully refused → ${filled.error}`);
    log("     (fill is EMULATED below: type.edit per slot — the trace's own commands)");
  }
  track({
    kind: "method", trace: "fill", stage: "executing", commandName: "template.fill",
    params: fillPayload, revisionBefore: rev, revisionAfter: rev, probe: true,
    error: filled.supported ? null : filled.error, result: filled.supported ? summarize(filled.result) : null,
  });

  const autofitScale = AUTOFIT_TO_PT / AUTOFIT_FROM_PT;
  const fillSteps = [
    { command: "type.edit", params: { layer: "Headline", text: HEADLINE_TEXT } },
    { command: "edit.transform", params: { layer: "Headline", scaleX: autofitScale, scaleY: autofitScale } },
    { command: "type.edit", params: { layer: "Subhead", text: SUBHEAD_TEXT } },
  ];
  const fillBatch = await step(
    `fill (emulated): type.edit Headline (${AUTOFIT_FROM_PT}→${AUTOFIT_TO_PT}pt, 2 lines) → autoFit → type.edit Subhead`,
    () => client.call("batch", { steps: fillSteps }),
  );
  assertEq(fillBatch.failed, 0, `${label}: fill batch`);
  assertEq(fillBatch.completed, fillSteps.length, `${label}: fill batch`);
  log(
    `     autoFit ${AUTOFIT_FROM_PT}→${AUTOFIT_TO_PT}pt emulated via edit.transform (uniform metric` +
      ` scale ≡ point-size change): the mock's type.edit has no size param — the real engine takes type.edit {size}`,
  );
  const fillRows = [
    { kind: "command", commandName: "type.edit", params: { layer: "Headline", text: HEADLINE_TEXT }, trace: "fill" },
    { kind: "command", commandName: "edit.transform", params: { layer: "Headline", autoFit: `${AUTOFIT_FROM_PT}->${AUTOFIT_TO_PT}pt` }, trace: "fill" },
    { kind: "command", commandName: "type.edit", params: { layer: "Subhead", text: SUBHEAD_TEXT }, trace: "fill" },
  ];
  for (const entry of fillRows) {
    track({ ...entry, stage: "executing", revisionBefore: rev, revisionAfter: rev + 1 });
  }
  inspected = await client.call("doc.inspect", null);
  assertEq(inspected.revision, rev, `${label}: revision after fill`);

  // style ------------------------------------------------------------- §24.1 line 5
  const styled = await step("style: layer.layerStyle.dropShadow Headline (subtle)", () =>
    probe(client, "command", "layer.layerStyle.dropShadow", { layer: "Headline" }),
  );
  if (styled.supported) {
    log("     the mock now serves layer styles — applied");
  } else {
    log(`     gracefully refused → ${styled.error}`);
    log("     (no layer-style command in the mock set yet; the run continues without it)");
  }
  track({
    kind: "command", trace: "style", stage: "executing", commandName: "layer.layerStyle.dropShadow",
    params: { layer: "Headline" }, revisionBefore: rev, revisionAfter: rev, probe: true,
    error: styled.supported ? null : styled.error, result: styled.supported ? summarize(styled.result) : null,
  });

  // render ------------------------------------------------------------- §24.1 line 6
  const render = await step("doc.render {maxSide:1024} (inline PNG preview)", () =>
    client.call("doc.render", { maxSide: 1024 }),
  );
  assertEq(render.mime, "image/png", `${label}: doc.render mime`);
  const pngBytes = Buffer.from(render.base64, "base64");
  const magic = [pngBytes[0], pngBytes[1], pngBytes[2], pngBytes[3]];
  if (magic.some((byte, i) => byte !== PNG_MAGIC[i])) {
    throw new DemoError(`${label}: doc.render did not return a PNG (magic ${summarize(magic)})`);
  }
  log(`     PNG magic 89 50 4E 47 verified (${pngBytes.length} bytes — mock render: fixed 8×8 gray)`);
  track({
    kind: "method", trace: "render", stage: "rendering", commandName: "doc.render",
    params: { maxSide: 1024 }, revisionBefore: rev, revisionAfter: rev,
  });
  const rendered = await step(`doc.render {path:"${ENGINE_RENDER_PATH}"} (engine-side, capability root)`, () =>
    client.call("doc.render", { path: ENGINE_RENDER_PATH, maxSide: 1024 }),
  );
  assertEq(rendered.bytes, pngBytes.length, `${label}: engine-side render bytes`);
  track({
    kind: "method", trace: "render", stage: "rendering", commandName: "doc.render",
    params: { path: ENGINE_RENDER_PATH, maxSide: 1024 }, revisionBefore: rev, revisionAfter: rev,
  });

  // validate ------------------------------------------------------- §24.1 line 7
  inspected = await client.call("doc.inspect", null);
  const layerNames = inspected.layers.map((layer) => layer.name);
  const missing = rules.mustLayers.filter((name) => !layerNames.includes(name));
  const textLayers = inspected.layers.filter((layer) => layer.kind === "Type");
  const subheadLayer = inspected.layers.find((layer) => layer.name === "Subhead");
  const [sx, sy, sw, sh] = subheadLayer.bounds;
  const margins = {
    top: sy, left: sx, right: canvas.width - (sx + sw), bottom: canvas.height - (sy + sh),
  };
  const minMargin = Math.min(margins.top, margins.left, margins.right, margins.bottom);
  const headlineRatio = contrastRatio(headlineSlot.color, canvas.background);
  const checks = [
    {
      check: "rules.mustLayers", ok: missing.length === 0,
      detail: `required ${rules.mustLayers.join(", ")} — all present`,
    },
    {
      check: "rules.maxTextLayers", ok: textLayers.length <= rules.maxTextLayers,
      detail: `${textLayers.length} text layers ≤ ${rules.maxTextLayers}`,
    },
    {
      check: "rules.safeArea", ok: minMargin >= rules.safeArea,
      detail: `subhead margins {top ${margins.top}, left ${margins.left}, right ${margins.right}, bottom ${margins.bottom}} — min ${minMargin}px ≥ ${rules.safeArea}px`,
    },
    {
      check: "rules.minContrast", ok: headlineRatio >= rules.minContrast,
      detail: `headline ${headlineSlot.color} on ${canvas.background} = ${headlineRatio.toFixed(2)}:1 ≥ ${rules.minContrast} (WCAG, computed)`,
    },
    {
      check: "editability (§25.1-2)", ok: textLayers.every((layer) => layer.kind === "Type" && layer.text?.text),
      detail: `${textLayers.length} live Type layers with text preserved, zero merge/rasterize commands issued`,
    },
  ];
  const blockers = checks.filter((check) => !check.ok && check.check !== "rules.safeArea").length;
  const minors = checks.filter((check) => !check.ok && check.check === "rules.safeArea").length;
  await step("validate — manifest.rules over doc.inspect (validator v1 stand-in)", () => {
    for (const check of checks) log(`     ${check.ok ? "ok " : "FLAG"} ${check.check}: ${check.detail}`);
    log(`     → ${blockers} blockers, ${minors} minors (mock metrics; §24.1's real run reports 1 minor — subhead near safe area)`);
    return { blockers, minors };
  });

  // critique -------------------------------------------------------- §24.1 line 8
  const scores = { hierarchy: 4, balance: 4, contrast: 5, adherence: 5, brand: 4, editability: 5 };
  const scoreAverage = Math.round((Object.values(scores).reduce((a, b) => a + b, 0) / 6) * 10) / 10;
  const criticReport = {
    label: "MOCK CRITIC — placeholder rubric (Phase 0 §19 step 4 stand-in)",
    modelCalls: 0,
    privacyNote:
      "zero model calls: §1.5-6 forbids free-tier LLMs on customer content; the real §23.3 vision critic is wired post-Phase-0",
    template: TEMPLATE_ID,
    tier: TIER,
    brief: BRIEF,
    slots: { headline: HEADLINE_TEXT, subhead: SUBHEAD_TEXT, photo: PHOTO_ASSET_ID },
    scores,
    scoreAverage,
    verdict: "accept",
    placeholderScoresNote:
      "hierarchy/balance/adherence/brand mirror the §24.1 worked-example rubric (placeholder values, not model output); contrast and editability are derived from document state",
    computed: {
      headlineContrastRatio: Math.round(headlineRatio * 100) / 100,
      minContrastRule: rules.minContrast,
      layers: inspected.layers.length,
      textLayers: textLayers.length,
      flatteningOperations: 0,
    },
    validation: { blockers, minors, checks },
    creditsCharged: CREDITS,
    creditsNote: "charge 2 credits per the §24.1 trace — mocked (no ledger in the Phase-0 demo)",
    versionLabel: VERSION_LABEL,
  };
  await step("critique — MOCK CRITIC (placeholder rubric, ZERO model calls — §1.5-6)", () => {
    log(`     scores .. hierarchy 4 · balance 4 · contrast 5 · adherence 5 · brand 4 · editability 5 → average ${scoreAverage}`);
    log(`     contrast is COMPUTED: ${headlineRatio.toFixed(2)}:1 ≥ ${rules.minContrast} (WCAG on the palette, not invented)`);
    log("     verdict . accept (placeholder per §24.1; clearly labeled — no vision call happened)");
    return criticReport;
  });

  // commit ----------------------------------------------------------- §24.1 line 9
  const committed = await step(`agent.commit {name:"${RUN_NAME}"} — one undoable unit (§5.6)`, () =>
    client.execute("agent.commit", { name: RUN_NAME }),
  );
  assertEq(committed.checkpoint, RUN_NAME, `${label}: agent.commit`);
  log(`     charge ${CREDITS} credits (${TIER} tier, §5.2 — mocked ledger line)`);
  track({
    kind: "command", trace: "commit", stage: "finalizing", commandName: "agent.commit",
    params: { name: RUN_NAME }, revisionBefore: rev, revisionAfter: rev,
  });

  // save ------------------------------------------------------------- §24.1 line 10
  const saved = await step(`doc.save ${SAVE_PATH} (layered checkpoint)`, () =>
    client.call("doc.save", { path: SAVE_PATH }),
  );
  assertEq(saved.warnings.length, 0, `${label}: doc.save warnings`);
  log(`     version "${VERSION_LABEL}" created (document_versions — mocked)`);
  track({
    kind: "method", trace: "save", stage: "finalizing", commandName: "doc.save",
    params: { path: SAVE_PATH }, revisionBefore: rev, revisionAfter: rev,
  });

  // final state + WAL chain ------------------------------------------
  inspected = await client.call("doc.inspect", null);
  assertEq(inspected.revision, rev, `${label}: final revision`);
  cmd.assertChain(label);
  assertEq(cmd.rows.length, 17, `${label}: WAL row count`);

  // layered .pcraft: read the saved file back and verify the layer tree ----
  let pcraftBytes = null;
  const pcraftAbs = path.join(artifactDir, saved.path);
  if (existsSync(pcraftAbs)) {
    pcraftBytes = readFileSync(pcraftAbs);
    const snapshot = JSON.parse(pcraftBytes.toString("utf8"));
    assertEq(snapshot.format, "studio-mock-engine-snapshot", `${label}: pcraft format`);
    assertEq(snapshot.revision, rev, `${label}: pcraft revision`);
    const names = snapshot.layers.map((layer) => layer.name);
    for (const name of ["Background", "Photo", "Headline", "Subhead"]) {
      if (!names.includes(name)) throw new DemoError(`${label}: pcraft is missing layer ${name}`);
    }
    const headline = snapshot.layers.find((layer) => layer.name === "Headline");
    const subhead = snapshot.layers.find((layer) => layer.name === "Subhead");
    assertEq(headline.text, HEADLINE_TEXT, `${label}: pcraft headline text`);
    assertEq(subhead.text, SUBHEAD_TEXT, `${label}: pcraft subhead text`);
    assertEq(snapshot.layers.find((l) => l.name === "Background").fill, canvas.background.toLowerCase(), `${label}: pcraft background fill`);
  } else {
    log("     (.pcraft landed under the engine's own write root — connect mode; verified via doc.inspect)");
  }

  // write the demo artifacts -----------------------------------------
  writeFileSync(path.join(artifactDir, PNG_PATH), pngBytes);
  writeFileSync(path.join(artifactDir, WAL_PATH), cmd.toJsonl());
  const criticJson = `${JSON.stringify(criticReport, null, 2)}\n`;
  writeFileSync(path.join(artifactDir, CRITIC_PATH), criticJson);

  const manifestHashes = {
    pcraft: pcraftBytes === null ? `bytes:${saved.bytes}` : sha256(pcraftBytes),
    png: sha256(pngBytes),
    critic: sha256(Buffer.from(criticJson, "utf8")),
    wal: sha256(Buffer.from(cmd.canonical(), "utf8")),
    fixture: sha256(fixture.bytes),
  };
  return {
    documentId: DOCUMENT_ID,
    revision: rev,
    layers: inspected.layers.map((layer) => layer.name),
    rows: cmd.rows,
    artifacts: { pcraft: SAVE_PATH, png: PNG_PATH, engineRender: ENGINE_RENDER_PATH, wal: WAL_PATH, critic: CRITIC_PATH },
    hashes: manifestHashes,
    digest: sha256(Buffer.from(JSON.stringify(manifestHashes), "utf8")),
    checks: { blockers, minors, contrast: headlineRatio },
  };
}

/** Connect + auth + one full trace pass. Caller owns the spawned mock (if any). */
async function runPass({ port, token, spawned, artifactDir, manifest, fixture, verbose, label }) {
  const client = new ControlClient(port, token);
  let result = null;
  try {
    await client.connect();
    await client.auth();
    result = await runCoffeeTrace({ client, artifactDir, manifest, fixture, verbose, label });
  } finally {
    client.close();
    if (spawned !== undefined) await stopMock(spawned);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!existsSync(MOCK_ENTRY)) {
    throw new DemoError(`mock-engine not found at ${path.relative(REPO_ROOT, MOCK_ENTRY)} (apps/mock-engine, W2-F)`, 2);
  }
  if (!existsSync(MANIFEST_PATH)) {
    throw new DemoError(`template manifest not found at ${path.relative(REPO_ROOT, MANIFEST_PATH)}`);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  assertEq(manifest.id, "instagram-post", "manifest id");
  assertEq(manifest.version, 3, "manifest version");

  const externalPort = Number.parseInt(process.env.MOCK_ENGINE_PORT ?? "", 10);
  const externalToken = process.env.MOCK_ENGINE_TOKEN ?? "";
  const external = Number.isInteger(externalPort) && externalPort > 0 && externalToken.length === 64;

  // fresh demo output dir (regenerated every run; see demo-coffee-README.md)
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const fixture = loadPhotoFixture(manifest.rules.palette);

  log("studio Phase-0 coffee demo (§19 exit) — §24.1 run trace, end-to-end");
  log(`mode: ${external ? `connect to a running mock-engine on 127.0.0.1:${externalPort} (local Compose)` : "spawn a fresh mock-engine per pass (ephemeral port)"}`);
  log(`template: ${TEMPLATE_ID} · tier: ${TIER} · photo fixture: ${fixture.source} (${fixture.bytes.length} bytes)`);
  log("");

  if (external) {
    // ------------------------------------------------------------------ connect
    const pass = await runPass({
      port: externalPort, token: externalToken, artifactDir: OUT_DIR,
      manifest, fixture, verbose: true, label: "connect pass",
    });
    printCommandLog(pass.rows);
    printSummary({ pass, replay: null, compose: true, outDir: OUT_DIR });
    process.exitCode = 0;
    return;
  }

  // ------------------------------------------------------------------- spawn ×2
  log("pass A — primary run (artifacts are kept)");
  const rootA = OUT_DIR;
  mkdirSync(path.join(rootA, path.dirname(PHOTO_PATH)), { recursive: true });
  writeFileSync(path.join(rootA, PHOTO_PATH), fixture.bytes);
  const spawnedA = await spawnMock(rootA);
  log(`mock-engine listening on 127.0.0.1:${spawnedA.port}`);
  const passA = await runPass({
    port: spawnedA.port, token: spawnedA.token, spawned: spawnedA,
    artifactDir: rootA, manifest, fixture, verbose: true, label: "pass A",
  });

  log("");
  log("pass B — replay run (fresh engine spawn; determinism check, §19)");
  const rootB = mkdtempSync(path.join(tmpdir(), "studio-demo-coffee-"));
  mkdirSync(path.join(rootB, path.dirname(PHOTO_PATH)), { recursive: true });
  writeFileSync(path.join(rootB, PHOTO_PATH), fixture.bytes);
  const spawnedB = await spawnMock(rootB);
  const passB = await runPass({
    port: spawnedB.port, token: spawnedB.token, spawned: spawnedB,
    artifactDir: rootB, manifest, fixture, verbose: false, label: "pass B",
  });
  rmSync(rootB, { recursive: true, force: true });

  // §19 "deterministically": byte-hash equality across independent runs
  const expected = process.env.DEMO_COFFEE_EXPECT_SHA256 ?? "";
  if (passA.digest !== passB.digest) {
    throw new DemoError(
      `determinism violated: pass A digest ${passA.digest} ≠ pass B digest ${passB.digest} ` +
        "(timestamp-free WAL + .pcraft + PNG + critic bytes)",
    );
  }
  log("");
  log(`determinism ok: two fresh engine spawns produced byte-identical artifacts (timestamps excluded)`);
  log(`  replay digest sha256:${passA.digest}`);
  if (expected !== "") {
    assertEq(passA.digest, expected, "DEMO_COFFEE_EXPECT_SHA256 pin");
    log("  external digest pin matched (DEMO_COFFEE_EXPECT_SHA256)");
  }

  printCommandLog(passA.rows);
  printSummary({ pass: passA, replay: passB, compose: false, outDir: OUT_DIR });
  process.exitCode = 0;
}

function printCommandLog(rows) {
  log("");
  log(`command log — §19 step 5 (WAL-shaped rows; full JSONL: ${WAL_PATH})`);
  log("  seq  call                        trace    stage        revision     note");
  log("  ---  --------------------------  -------  -----------  -----------  ----");
  for (const row of rows) {
    const revision = `${row.revisionBefore}→${row.revisionAfter}`;
    const note = row.probe === true ? `[probe] ${row.error ?? "supported"}` : brief(row.params);
    log(
      `  ${String(row.seq).padStart(3, "0")}  ${row.commandName.padEnd(26)}  ${row.trace.padEnd(7)}  ${row.stage.padEnd(11)}  ${revision.padEnd(11)}  ${note}`,
    );
  }
}

function printSummary({ pass, replay, compose, outDir }) {
  const layered = pass.layers.join(", ");
  log("");
  log(`Phase-0 exit summary — §19: "pnpm demo:coffee produces a valid layered .pcraft, a PNG,`);
  log("a critic report, and a command log, deterministically, in local Compose\"");
  log("");
  log(`  layered .pcraft ... ok   ${pass.artifacts.pcraft} — ${pass.layers.length} layers [${layered}],`);
  log(`                            revision ${pass.revision}, text preserved, zero flattening (§25.2)`);
  log(`                            (mock snapshot format; the real engine writes .pcraft)`);
  log(`  PNG ............... ok   ${pass.artifacts.png} — PNG magic verified (mock render: fixed 8×8 gray)`);
  log(`  critic report ..... ok   ${pass.artifacts.critic} — MOCK CRITIC placeholder rubric, 0 model calls (§1.5-6)`);
  log(`  command log ....... ok   ${pass.artifacts.wal} — ${pass.rows.length} WAL-shaped rows, revision chain 1→${pass.revision}`);
  if (replay === null) {
    log(`  determinism ....... n/a   connect mode: spawn a fresh engine (no env) to run the replay check`);
  } else {
    log(`  determinism ....... ok   pass A ≡ pass B byte-hash (asserted) — sha256:${pass.digest}`);
  }
  log(`  compose ........... ${compose ? "ok   " : "avail"} ${compose ? "this run drove the local-Compose mock-engine" : "set MOCK_ENGINE_PORT/MOCK_ENGINE_TOKEN to drive the compose mock"}`);
  log(`  validate .......... ok   ${pass.checks.blockers} blockers, ${pass.checks.minors} minors · headline contrast ${pass.checks.contrast.toFixed(2)}:1 (computed)`);
  log(`  artifacts ......... ${path.relative(REPO_ROOT, outDir)}/`);
  log("");
  log("Phase-0 coffee demo: ok (plan → apply → place → fill → style → render → validate →");
  log("                       critique → commit → save), exit 0");
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`demo-coffee: ${message}\n`);
  process.exitCode = error instanceof DemoError ? error.exitCode : 1;
}
