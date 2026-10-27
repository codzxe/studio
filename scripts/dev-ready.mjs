#!/usr/bin/env node
/**
 * scripts/dev-ready.mjs — `pnpm dev:ready`: the one-shot, crash-proof dev boot.
 *
 * The contract (user brief): "never see EADDRINUSE, never wait in the browser
 * while Next compiles" — the stack boots detached, every page is pre-compiled
 * by server-side warmup requests, and the links are only printed once the
 * FIRST click is guaranteed instant (Option 1: `next dev` + background route
 * warmup, HMR stays live).
 *
 * Sequence (upgrades the W5-01 recipe in scripts/dev-stack.sh):
 *   [1/4] ports     — stop OUR previous dev:ready stack (pid file), kill
 *                     repo-owned zombie servers (next dev / tsx watch with a
 *                     cwd inside this repo), then pick the first FREE port
 *                     from 3000 (web) and 8787 (gateway). Foreign processes
 *                     are never killed — we move to the next port instead.
 *   [2/4] database  — `scripts/dev-sqlite.sh start` (idempotent): bootstraps
 *                     the SQLite schema and seeds the real demo data
 *                     (demo@studio.test / demo-password-12345, workspace
 *                     `demo-workspace`, project `demo-project`, 1000 credits).
 *   [3/4] editor    — verifies the WASM editor dist in apps/web/public/editor:
 *                     `\0asm` magic bytes, size floor, and every boot file the
 *                     iframe needs (studio_web.js, worker.js,
 *                     audio-worklet.js, index.html, sw.js, manifest) + the
 *                     three next/font/local .ttf files (scripts/fetch-web-fonts.mjs
 *                     — pinned google/fonts fetch, sha256-verified, offline-friendly
 *                     once fetched; `next dev` cannot compile layout.tsx without them).
 *   [4/4] boot+warm — spawns gateway (tsx watch, PORT=<gw>) then web
 *                     (`next dev`, PORT=<web>), each detached in its own
 *                     process group, waits for /v1/health, signs in as the
 *                     demo user through better-auth (real session cookie),
 *                     then GETs every route until it compiles (2xx/3xx),
 *                     range-checks the wasm over HTTP and proves the /v1
 *                     rewrite. Only then are the links printed. Services keep
 *                     running; logs in .local/{gateway,web}-dev.log.
 *
 * Commands:
 *   node scripts/dev-ready.mjs start        (default)
 *   node scripts/dev-ready.mjs stop         (kills the tracked stack + repo-owned strays)
 *   node scripts/dev-ready.mjs status       (exit 0 live / 3 down)
 *   node scripts/dev-ready.mjs logs [gateway|web|all] [--follow]
 *
 * Flags: --timeout=<seconds>  route-warmup budget (default 420)
 *        --keep               never kill anything; always move to free ports
 *        --no-seed            skip the db step (you know it is current)
 *
 * Port injection follows dev-stack.sh exactly (GATEWAY_INTERNAL_URL for the
 * /v1 rewrite, APP_URL/NEXT_PUBLIC_APP_URL for better-auth) with one hard
 * rule preserved: PORT is scoped per child process, never exported globally —
 * `next dev` honors PORT too and would otherwise steal 8787.
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureWebFonts } from "./fetch-web-fonts.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_DIR = path.join(REPO, ".local");
const DB_PATH = path.join(LOCAL_DIR, "studio-dev.db");
const STATE_FILE = path.join(LOCAL_DIR, "dev-ready.json");
const LOG_FILE = {
  gateway: path.join(LOCAL_DIR, "gateway-dev.log"),
  web: path.join(LOCAL_DIR, "web-dev.log"),
};
const WEB_BASE_PORT = 3000;
const GW_BASE_PORT = 8787;
const PORT_SCAN_RANGE = 50; // try base..base+49 before giving up

const DEMO = { email: "demo@studio.test", password: "demo-password-12345" };
const DEMO_WORKSPACE = "demo-workspace";
const DEMO_PROJECT = "demo-project"; // /w/[slug]/* resolves the PROJECT by slug (editor page contract)

const ROUTES_PUBLIC = ["/", "/sign-in", "/sign-up", "/pricing", "/faq", "/changelog", "/status"];
// URL map per the app router: the (shell) pages live directly under /w (no
// slug); /w/[slug]/editor + /w/[slug]/history take the PROJECT slug (the RSC
// resolves the project across the user's workspaces — a wrong slug 404s).
const ROUTES_AUTHED = [
  "/w",
  "/w/projects",
  "/w/billing",
  `/w/${DEMO_PROJECT}/editor`,
  `/w/${DEMO_PROJECT}/history`,
];
// A failure here means the user WOULD see a broken page — exit non-zero.
const CORE_FATAL = new Set(["/", "/sign-in", "/editor/?empty"]);
const EDITOR_WASM_ROUTE = "/editor/studio_web_bg.wasm";
const EDITOR_IFRAME_ROUTE = "/editor/?empty";

const EDITOR_DIR = path.join(REPO, "apps/web/public/editor");
const WASM_MIN_BYTES = 10 * 1024 * 1024; // the real dist is ~49.4 MB; the floor only catches truncation
const EDITOR_BOOT_FILES = [
  "studio_web_bg.wasm",
  "studio_web.js",
  "index.html",
  "worker.js",
  "audio-worklet.js",
  "sw.js",
  "manifest.webmanifest",
];

// ── tiny console kit ─────────────────────────────────────────────────────────
const color = Boolean(process.stdout.isTTY || process.env.FORCE_COLOR);
const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c(1, s);
const dim = (s) => c(2, s);
const green = (s) => c(32, s);
const yellow = (s) => c(33, s);
const red = (s) => c(31, s);
const cyan = (s) => c(36, s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtBytes = (n) => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MiB` : `${n} B`);
const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
const say = (msg = "") => process.stdout.write(`${msg}\n`);

// ── arg parsing ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    cmd: "start",
    target: "all",
    timeoutSec: 420,
    keep: false,
    noSeed: false,
    follow: false,
  };
  const rest = [];
  for (const a of argv) {
    if (a === "--keep") opts.keep = true;
    else if (a === "--no-seed") opts.noSeed = true;
    else if (a === "--follow" || a === "-f") opts.follow = true;
    else if (a.startsWith("--timeout=")) opts.timeoutSec = Number(a.slice(10)) || opts.timeoutSec;
    else rest.push(a);
  }
  const [cmd, target] = rest;
  if (cmd) opts.cmd = cmd;
  if (target) opts.target = target;
  return opts;
}

// ── state file (what is currently running) ───────────────────────────────────
function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}
function writeState(state) {
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}
function clearState() {
  try {
    fs.rmSync(STATE_FILE, { force: true });
  } catch {}
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── ports ────────────────────────────────────────────────────────────────────
function isPortFree(port, host = "0.0.0.0") {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

async function firstFreePort(base) {
  for (let p = base; p < base + PORT_SCAN_RANGE; p += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(p)) return p;
  }
  throw new Error(`no free port found in ${base}..${base + PORT_SCAN_RANGE - 1}`);
}

// ── repo-owned zombie sweep (Linux /proc; graceful no-op elsewhere) ──────────
function procEntries() {
  if (process.platform !== "linux") return [];
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return [];
  }
  for (const name of names) {
    const pid = Number(name);
    if (pid === process.pid) continue;
    try {
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`);
      const cmdline = raw.toString("utf8").split("\0").filter(Boolean).join(" ");
      out.push({ pid, cwd, cmdline });
    } catch {
      /* vanished between readdir and read — ignore */
    }
  }
  return out;
}

/** Server processes started from inside THIS repo (previous dev:ready /
 *  dev-stack / manual `pnpm dev` boots). Never matches foreign processes. */
function findRepoServers() {
  const re = /(^|\s)(next( dev|-server)?|tsx(\.watch)?)($|\s)/;
  return procEntries()
    .filter((p) => p.cwd === REPO || p.cwd?.startsWith(`${REPO}/`))
    .filter((p) => re.test(p.cmdline))
    .map((p) => p.pid);
}

async function killPids(pids, { label }) {
  const live = pids.filter((pid) => pidAlive(pid));
  if (live.length === 0) return;
  say(dim(`                  stopping ${label}: ${live.join(", ")}`));
  for (const pid of live) {
    try {
      process.kill(-pid, "SIGTERM"); // own process group first (children included)
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
  }
  const deadline = Date.now() + 6000;
  let remaining = live.filter((pid) => pidAlive(pid));
  while (remaining.length > 0 && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await sleep(250);
    remaining = remaining.filter((pid) => pidAlive(pid));
  }
  for (const pid of remaining) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
  if (remaining.length > 0)
    say(yellow(`                  warning: ${remaining.join(", ")} ignored SIGKILL`));
}

/** Stop the tracked dev:ready stack (if any) + repo-owned strays. */
async function stopStack({ quiet = false, includeStrays = true } = {}) {
  const state = readState();
  const tracked = [];
  if (state?.gateway?.pid) tracked.push(state.gateway.pid);
  if (state?.web?.pid) tracked.push(state.web.pid);
  if (tracked.length > 0 && !quiet)
    say(dim("                  previous dev:ready stack found (state file)"));
  await killPids(tracked, { label: "dev:ready stack" });
  if (includeStrays) await killPids(findRepoServers(), { label: "repo-owned dev servers" });
  clearState();
}

// ── pnpm resolution (this box ships pnpm only via corepack) ──────────────────
function pnpmRun() {
  if (process.platform === "win32") return { cmd: "pnpm.cmd", args: ["dev"], shell: true };
  try {
    execFileSync("pnpm", ["--version"], { stdio: "ignore" });
    return { cmd: "pnpm", args: ["dev"], shell: false };
  } catch {
    return { cmd: "corepack", args: ["pnpm", "dev"], shell: false };
  }
}

// ── [2/4] database ───────────────────────────────────────────────────────────
async function ensureDatabase() {
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  const res = spawn("bash", ["scripts/dev-sqlite.sh", "start"], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, STUDIO_SQLITE_DB: DB_PATH, STUDIO_SQLITE_URL: `file:${DB_PATH}` },
  });
  let out = "";
  res.stdout.on("data", (d) => {
    out += d;
  });
  res.stderr.on("data", (d) => {
    out += d;
  });
  const code = await new Promise((resolve, reject) => {
    res.on("error", reject);
    res.on("close", resolve);
  });
  if (code !== 0) {
    throw new Error(
      `scripts/dev-sqlite.sh start failed (exit ${code}):\n${out.trim().split("\n").slice(-12).join("\n")}`,
    );
  }
  const size = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;
  const seeded = /seed ok/.test(out);
  return { size, seeded };
}

// ── [3/4] editor wasm verification ───────────────────────────────────────────
function verifyEditorAssets() {
  const missing = EDITOR_BOOT_FILES.filter((f) => !fs.existsSync(path.join(EDITOR_DIR, f)));
  const wasmPath = path.join(EDITOR_DIR, "studio_web_bg.wasm");
  if (!fs.existsSync(wasmPath)) {
    throw new Error(
      `editor wasm missing: ${wasmPath} — run scripts/build_editor_web.sh (see docs/PRODUCT_ARCHITECTURE.md §6.1)`,
    );
  }
  const size = fs.statSync(wasmPath).size;
  if (size < WASM_MIN_BYTES) {
    throw new Error(
      `editor wasm looks truncated: ${fmtBytes(size)} (floor ${fmtBytes(WASM_MIN_BYTES)}) — rebuild the dist`,
    );
  }
  const fd = fs.openSync(wasmPath, "r");
  const magic = Buffer.alloc(4);
  fs.readSync(fd, magic, 0, 4, 0);
  fs.closeSync(fd);
  const magicOk = magic[0] === 0x00 && magic[1] === 0x61 && magic[2] === 0x73 && magic[3] === 0x6d; // "\0asm"
  if (!magicOk)
    throw new Error(`editor wasm has invalid magic bytes — ${wasmPath} is not a wasm module`);
  return { size, missing };
}

// ── [4/4] spawn + readiness ──────────────────────────────────────────────────
function childEnv({ webPort, gwPort }) {
  const appUrl = `http://localhost:${webPort}`;
  return {
    ...process.env,
    APP_ENV: "local",
    MOCK_MODEL: "true",
    DATABASE_URL: `file:${DB_PATH}`,
    AUTH_SECRET: process.env.AUTH_SECRET || "dev-local-secret-0123456789abcdef0123456789abcdef",
    AUTH_GOOGLE_ID: "replace-me",
    AUTH_GOOGLE_SECRET: "replace-me",
    AUTH_GITHUB_ID: "replace-me",
    AUTH_GITHUB_SECRET: "replace-me",
    STRIPE_WEBHOOK_SECRET: "whsec_replace_me",
    STRIPE_PRICE_IDS: '{"starter":"price_starter","pro":"price_pro","studio":"price_studio"}',
    LITELLM_BASE_URL: "http://localhost:4000",
    LITELLM_API_KEY: "sk-litellm-replace-me",
    ASSET_MAX_BYTES: "524288000",
    PROJECT_MAX_BYTES: "262144000",
    CHAT_MAX_STEPS: "50",
    APP_URL: appUrl,
    NEXT_PUBLIC_APP_URL: appUrl,
    GATEWAY_INTERNAL_URL: `http://127.0.0.1:${gwPort}`,
  };
}

function openLog(name) {
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  const fd = fs.openSync(LOG_FILE[name], "w"); // fresh log per boot — tails stay meaningful
  fs.writeSync(fd, `── studio ${name} — dev:ready boot ${new Date().toISOString()} ──\n`);
  return fd;
}

/** Spawn detached (own process group) with a fresh log; returns the pid. */
function spawnDetached({ name, cwd, env }) {
  const { cmd, args, shell } = pnpmRun();
  const fd = openLog(name);
  const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ["ignore", fd, fd], shell });
  child.unref();
  return child.pid;
}

async function waitUntil(fn, { everyMs = 500, timeoutMs, what }) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const r = await fn();
      if (r) return r;
    } catch (e) {
      lastError = String(e?.message || e).split("\n")[0];
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(everyMs);
  }
  throw new Error(
    `timed out after ${fmtMs(timeoutMs)} waiting for ${what}${lastError ? ` (last: ${lastError})` : ""}`,
  );
}

const fetchAbort = (ms) => AbortSignal.timeout(ms);

async function gatewayReady(gwPort) {
  return waitUntil(
    async () => {
      const res = await fetch(`http://127.0.0.1:${gwPort}/v1/health`, { signal: fetchAbort(2000) });
      if (!res.ok) return false;
      const body = await res.json();
      return body?.status === "ok" ? body : false;
    },
    { timeoutMs: 120_000, what: `gateway /v1/health on :${gwPort}` },
  );
}

async function webUp(webPort) {
  return waitUntil(
    async () => {
      const res = await fetch(`http://localhost:${webPort}/sign-in`, {
        redirect: "manual",
        signal: fetchAbort(5000),
      });
      await res.body?.cancel?.().catch(() => {});
      return res.status > 0;
    },
    { timeoutMs: 120_000, what: `web server on :${webPort}` },
  );
}

// ── warmup ───────────────────────────────────────────────────────────────────
async function warmRoute(origin, route, { cookie, deadline }) {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    if (Date.now() > deadline) {
      // Report the LAST real response if we got one (a bare timeout hides it).
      return last ?? { route, status: 0, ms: Date.now() - t0, ok: false, timedOut: true };
    }
    try {
      const res = await fetch(origin + route, {
        redirect: "manual",
        headers: cookie ? { cookie } : {},
        signal: fetchAbort(90_000),
      });
      const ms = Date.now() - t0;
      await res.body?.cancel?.().catch(() => {});
      const ok = res.status >= 200 && res.status < 400;
      if (ok) return { route, status: res.status, ms, ok };
      last = { route, status: res.status, ms, ok };
      // A 404 is a routing/slug verdict, not a transient — retrying only
      // spams the dev log (seen live). Report it immediately.
      if (res.status === 404) return last;
      if (Date.now() > deadline) return last;
      await sleep(2500);
    } catch (e) {
      if (Date.now() > deadline) {
        return {
          route,
          status: 0,
          ms: Date.now() - t0,
          ok: false,
          error: String(e?.message || e).split("\n")[0],
        };
      }
      await sleep(1500);
    }
  }
}

async function warmRoutes(origin, routes, opts, { cookie, concurrency = 3 } = {}) {
  const deadline = Date.now() + opts.timeoutSec * 1000;
  const queue = [...routes];
  const results = [];
  async function worker() {
    for (;;) {
      const route = queue.shift();
      if (!route) return;
      // eslint-disable-next-line no-await-in-loop
      const r = await warmRoute(origin, route, { cookie, deadline });
      results.push(r);
      const mark = r.ok ? green("✓") : CORE_FATAL.has(route) ? red("✗") : yellow("!");
      say(
        `                     ${mark} ${String(r.status || "—").padEnd(3)}  ${route.padEnd(36)} ${fmtMs(r.ms)}${r.timedOut ? dim(" (timeout)") : ""}${r.error ? dim(` (${r.error})`) : ""}`,
      );
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, routes.length) }, worker));
  return results;
}

/** Real better-auth sign-in against the gateway — gives the warmup a genuine
 *  session cookie so the /w/* pages compile their AUTHENTICATED render.
 *  better-auth 1.7 rejects POSTs whose Origin is missing or `null`
 *  (MISSING_OR_NULL_ORIGIN — undici sends `Origin: null`), so we present the
 *  app origin the gateway already trusts (APP_URL → createAuth baseURL). */
async function signIn(gwPort, appUrl) {
  const res = await fetch(`http://127.0.0.1:${gwPort}/v1/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appUrl },
    body: JSON.stringify(DEMO),
    signal: fetchAbort(15_000),
  });
  if (!res.ok) throw new Error(`sign-in HTTP ${res.status}`);
  const jar = (res.headers.getSetCookie?.() ?? []).map((ck) => ck.split(";")[0]).filter(Boolean);
  if (jar.length === 0) throw new Error("sign-in returned no session cookie");
  await res.body?.cancel?.().catch(() => {});
  return jar.join("; ");
}

/** Range-probe the wasm THROUGH the web origin: proves serving + mime + bytes
 *  without downloading 49 MB. Range ignored (200) is fine — we read one chunk. */
async function verifyWasmOverHttp(webPort) {
  const res = await fetch(`http://localhost:${webPort}${EDITOR_WASM_ROUTE}`, {
    headers: { range: "bytes=0-3" },
    signal: fetchAbort(30_000),
  });
  const contentType = res.headers.get("content-type") || "";
  const reader = res.body.getReader();
  const { value } = await reader.read();
  await reader.cancel().catch(() => {});
  const magicOk =
    !!value && value[0] === 0x00 && value[1] === 0x61 && value[2] === 0x73 && value[3] === 0x6d;
  if (!magicOk)
    throw new Error(
      "wasm over HTTP did not start with the \\0asm magic — the dist is corrupt or mis-served",
    );
  return { status: res.status, contentType, partial: res.status === 206 };
}

// ── log tails (failure reporting) ────────────────────────────────────────────
function tailOf(name, lines = 15) {
  try {
    const content = fs.readFileSync(LOG_FILE[name], "utf8").trimEnd().split("\n");
    return content.slice(-lines).join("\n");
  } catch {
    return `(${LOG_FILE[name]} not readable)`;
  }
}
function printLogTails() {
  for (const name of ["gateway", "web"]) {
    say(dim(`── last ${name} log lines (${LOG_FILE[name]}) ──`));
    say(dim(tailOf(name)));
  }
}

// ── commands ─────────────────────────────────────────────────────────────────
async function cmdStart(opts) {
  const t0 = Date.now();
  say(bold("dev:ready — studio stack (Option 1: next dev + route warmup, HMR live)"));
  say("");

  // [1/4] ports -------------------------------------------------------------
  say(bold(cyan("[1/4] ports")));
  if (opts.keep) {
    say(dim("      --keep: leaving every running process alone"));
  } else {
    await stopStack({ quiet: true });
    say(dim("      previous stack stopped / stray sweep done"));
  }
  const [webPort, gwPort] = [await firstFreePort(WEB_BASE_PORT), await firstFreePort(GW_BASE_PORT)];
  say(
    `      ${bold("web")} → :${green(String(webPort))}   ${bold("gateway")} → :${green(String(gwPort))}   ${dim("(first free from 3000 / 8787)")}`,
  );
  say("");

  // [2/4] database ----------------------------------------------------------
  say(bold(cyan("[2/4] database (real, no mocks)")));
  let dbInfo = { size: 0, seeded: false };
  if (opts.noSeed) {
    say(dim("      --no-seed: skipping bootstrap+seed"));
  } else {
    dbInfo = await ensureDatabase();
    say(
      `      studio-dev.db ready — ${fmtBytes(dbInfo.size)}${dbInfo.seeded ? green(" · demo seed ok") : yellow(" · seed skipped/failed (schema is bootstrapped)")}`,
    );
  }
  say("");

  // [3/4] editor wasm -------------------------------------------------------
  say(bold(cyan("[3/4] editor wasm verification")));
  let wasmInfo;
  try {
    wasmInfo = verifyEditorAssets();
  } catch (e) {
    say(red(`      ✗ ${e.message}`));
    process.exit(1);
  }
  say(
    `      studio_web_bg.wasm — ${bold(fmtBytes(wasmInfo.size))}, magic ${green("\\0asm")} ✓`,
  );
  if (wasmInfo.missing.length > 0) {
    say(
      yellow(
        `      ! missing boot files (editor may still boot — check the dist): ${wasmInfo.missing.join(", ")}`,
      ),
    );
  } else {
    say(
      dim(
        `      all ${EDITOR_BOOT_FILES.length} boot files present (WebGL2 fallback stays runtime-negotiated: ?gpu=webgl2)`,
      ),
    );
  }
  // Web fonts (next/font/local — layout.tsx): provisioned from the pinned
  // google/fonts commit, sha256-verified; a file with the right hash is kept
  // (no network on warm boots). Missing/unfetchable fonts are FATAL —
  // `next dev` fails compiling layout.tsx without them.
  const fontsT0 = Date.now();
  try {
    const fonts = await ensureWebFonts({ log: (line) => say(dim(`      ${line}`)) });
    say(
      `      ${fonts.total} web fonts — ${green(`${fonts.kept} hash-ok`)}, ${cyan(`${fonts.fetched} fetched`)} (${fmtMs(Date.now() - fontsT0)})`,
    );
  } catch (e) {
    say(red(`      ✗ web fonts: ${e instanceof Error ? e.message : String(e)}`));
    say(dim("      next dev cannot compile layout.tsx without them — pnpm fonts:web, then retry"));
    process.exit(1);
  }
  say("");

  // [4/4] boot + warm -------------------------------------------------------
  say(bold(cyan("[4/4] boot + warm routes")));
  const env = childEnv({ webPort, gwPort });
  const gwPid = spawnDetached({
    name: "gateway",
    cwd: path.join(REPO, "services/gateway"),
    env: { ...env, PORT: String(gwPort) },
  });
  const health = await gatewayReady(gwPort).catch((e) => {
    say(red(`      ✗ gateway failed to become healthy: ${e.message}`));
    printLogTails();
    say(yellow("      services left running for inspection — stop with: pnpm dev:ready:stop"));
    process.exit(1);
  });
  say(
    `      gateway :${gwPort} healthy ${health.db ? green("(db ✓)") : yellow("(db ✗ — check DATABASE_URL)")} ${dim(`pid ${gwPid}`)}`,
  );

  const webPid = spawnDetached({
    name: "web",
    cwd: path.join(REPO, "apps/web"),
    env: { ...env, PORT: String(webPort) },
  });
  await webUp(webPort).catch((e) => {
    say(red(`      ✗ web server failed to boot: ${e.message}`));
    printLogTails();
    say(yellow("      services left running for inspection — stop with: pnpm dev:ready:stop"));
    process.exit(1);
  });
  say(
    `      web :${webPort} up ${dim(`pid ${webPid}`)} — warming ${ROUTES_PUBLIC.length + ROUTES_AUTHED.length + 2} targets…`,
  );

  const webOrigin = `http://localhost:${webPort}`;
  const publicResults = await warmRoutes(webOrigin, ROUTES_PUBLIC, opts);

  let cookie = "";
  try {
    cookie = await signIn(gwPort, webOrigin);
    say(
      `      sign-in ${DEMO.email} ${green("✓")} ${dim("(real session — /w/* compiles authenticated)")}`,
    );
  } catch (e) {
    say(
      yellow(`      ! sign-in failed: ${e.message} — /w/* will warm unauthenticated (redirects)`),
    );
  }
  const authedResults = await warmRoutes(webOrigin, ROUTES_AUTHED, opts, { cookie });

  // static editor dist + wasm-over-HTTP + /v1 proxy proof
  const extras = [];
  extras.push(
    await warmRoute(webOrigin, EDITOR_IFRAME_ROUTE, {
      deadline: Date.now() + opts.timeoutSec * 1000,
    }),
  );
  const markFor = (r) => (r.ok ? green("✓") : red("✗"));
  say(
    `                     ${markFor(extras[0])} ${String(extras[0].status).padEnd(3)}  ${EDITOR_IFRAME_ROUTE.padEnd(36)} ${fmtMs(extras[0].ms)}`,
  );
  try {
    const wasmHttp = await verifyWasmOverHttp(webPort);
    say(
      `      wasm over HTTP ${wasmHttp.status} ${dim(wasmHttp.contentType)} magic ${green("\\0asm")} ✓${wasmHttp.partial ? dim(" (206 partial)") : ""}`,
    );
  } catch (e) {
    say(yellow(`      ! wasm HTTP check: ${e.message}`));
  }
  try {
    const proxyRes = await fetch(`${webOrigin}/v1/health`, { signal: fetchAbort(10_000) });
    const proxyBody = await proxyRes.json().catch(() => null);
    const okProxy = proxyRes.ok && proxyBody?.status === "ok";
    say(
      `      /v1 rewrite → gateway ${okProxy ? green("✓") : red("✗")} ${dim(`(web origin /v1/health → ${proxyRes.status})`)}`,
    );
  } catch (e) {
    say(yellow(`      ! /v1 rewrite check: ${e.message}`));
  }

  const all = [...publicResults, ...authedResults, ...extras];
  const fatalFailures = all.filter((r) => !r.ok && CORE_FATAL.has(r.route));
  const softFailures = all.filter((r) => !r.ok && !CORE_FATAL.has(r.route));
  const warmMs = Date.now() - t0;

  // state + summary ---------------------------------------------------------
  writeState({
    startedAt: new Date().toISOString(),
    pid: process.pid,
    web: { pid: webPid, port: webPort, url: `http://localhost:${webPort}`, log: LOG_FILE.web },
    gateway: { pid: gwPid, port: gwPort, url: `http://127.0.0.1:${gwPort}`, log: LOG_FILE.gateway },
    demo: DEMO,
    routes: { ok: all.filter((r) => r.ok).length, total: all.length },
  });

  say("");
  if (fatalFailures.length > 0) {
    say(
      red(
        bold(
          `dev:ready: ${fatalFailures.length} CORE route(s) failed — the browser WOULD show a crash:`,
        ),
      ),
    );
    for (const r of fatalFailures) say(red(`  ✗ ${r.route} → ${r.status || r.error || "timeout"}`));
    printLogTails();
    say(yellow("      services left running for inspection — stop with: pnpm dev:ready:stop"));
    process.exit(1);
  }

  say(bold(green("All services live:")));
  say(`  Web App   ${cyan(`http://localhost:${webPort}`)}`);
  say(`  Gateway   ${cyan(`http://127.0.0.1:${gwPort}`)}`);
  say(
    `  Editor    ${cyan(`${webOrigin}/w/${DEMO_PROJECT}/editor`)}  ${dim("(iframe → /editor/?empty, WebGL2-ready)")}`,
  );
  say(`  Sign in   ${bold(DEMO.email)} / ${bold(DEMO.password)}  ${dim("(1000 demo credits)")}`);
  if (softFailures.length > 0) {
    say("");
    say(yellow(`  Warnings — ${softFailures.length} non-core route(s) did not compile cleanly:`));
    for (const r of softFailures)
      say(
        yellow(
          `    ! ${r.route} → ${r.status || r.error || "timeout"} (opened later it will retry live)`,
        ),
      );
  }
  say("");
  say(dim(`  ready in ${fmtMs(warmMs)} · logs .local/web-dev.log · .local/gateway-dev.log`));
  say(
    dim("  stop: pnpm dev:ready:stop   status: pnpm dev:ready:status   logs: pnpm dev:ready:logs"),
  );
}

async function cmdStop() {
  say(bold("dev:ready stop"));
  await stopStack();
  const [webBusy, gwBusy] = [await isPortFree(WEB_BASE_PORT), await isPortFree(GW_BASE_PORT)];
  if (!webBusy || !gwBusy) {
    say(
      dim(
        `      note: :${!webBusy ? WEB_BASE_PORT : ""}${!webBusy && !gwBusy ? " / " : ""}${!gwBusy ? GW_BASE_PORT : ""} still held by a foreign process (not touched)`,
      ),
    );
  }
  say(green("      stopped — ports 3000/8787 range free for the next boot"));
}

async function cmdStatus() {
  const state = readState();
  if (!state) {
    say(yellow("dev:ready: no stack recorded (never started or already stopped)"));
    process.exit(3);
  }
  const rows = [];
  for (const svc of ["gateway", "web"]) {
    const s = state[svc];
    if (!s) continue;
    const alive = pidAlive(s.pid);
    let http = "—";
    try {
      const url = svc === "gateway" ? `${s.url}/v1/health` : `${s.url}/sign-in`;
      const res = await fetch(url, { redirect: "manual", signal: fetchAbort(4000) });
      await res.body?.cancel?.().catch(() => {});
      http = String(res.status);
    } catch {
      http = "unreachable";
    }
    rows.push({ svc, ...s, alive, http });
    say(
      `  ${alive && http !== "unreachable" ? green("●") : red("✗")} ${svc.padEnd(8)} pid ${String(s.pid).padEnd(7)} :${String(s.port).padEnd(5)} http ${http.padEnd(11)} ${dim(s.url)}`,
    );
  }
  const allGreen = rows.length > 0 && rows.every((r) => r.alive && r.http !== "unreachable");
  if (!allGreen) {
    say(
      yellow(
        "\n  some services are down — boot fresh with: pnpm dev:ready  (or inspect .local/*-dev.log)",
      ),
    );
    process.exit(3);
  }
  say(
    green(
      `\n  live since ${state.startedAt} · routes ${state.routes?.ok}/${state.routes?.total} compiled · demo: ${state.demo?.email}`,
    ),
  );
}

async function cmdLogs(opts) {
  const names = opts.target === "all" ? ["gateway", "web"] : [opts.target];
  for (const name of names) {
    if (!LOG_FILE[name]) {
      say(yellow(`unknown log '${name}' — use gateway | web | all`));
      process.exit(2);
    }
    say(bold(`── ${name}: ${LOG_FILE[name]} (last 40) ──`));
    try {
      const lines = fs.readFileSync(LOG_FILE[name], "utf8").trimEnd().split("\n");
      say(lines.slice(-40).join("\n"));
    } catch {
      say(dim("(no log yet)"));
    }
    say("");
  }
  if (opts.follow) {
    const { execFileSync } = await import("node:child_process");
    if (process.platform !== "win32") {
      try {
        execFileSync("tail", ["-n", "5", "-F", ...names.map((n) => LOG_FILE[n])], {
          stdio: "inherit",
        });
        return;
      } catch {}
    }
    say(dim("(follow unsupported here — re-run `pnpm dev:ready:logs` to refresh)"));
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
const opts = parseArgs(process.argv.slice(2));
try {
  if (opts.cmd === "start") await cmdStart(opts);
  else if (opts.cmd === "stop") await cmdStop();
  else if (opts.cmd === "status" || opts.cmd === "st") await cmdStatus();
  else if (opts.cmd === "logs") await cmdLogs(opts);
  else {
    say(
      "usage: node scripts/dev-ready.mjs [start|stop|status|logs [gateway|web|all]] [--timeout=N] [--keep] [--no-seed] [--follow]",
    );
    process.exit(2);
  }
} catch (e) {
  say(red(`dev:ready: ${e?.stack || e}`));
  process.exit(1);
}
