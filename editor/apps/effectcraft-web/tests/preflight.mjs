// The index.html BOOT PREFLIGHT under Node with a fake DOM — no browser or
// Wasm build needed:
//
//   node apps/effectcraft-web/tests/preflight.mjs
//
// Extracts the inline module script from web/index.html and boots it once per
// scenario, asserting the M3 tail 6 rules:
// - Windows boots with NO GPU workers (`?noworkers` normalized into the URL)
//   — three concurrent WebGPU devices on one adapter trip the Chromium/D3D12
//   "A valid external Instance reference no longer exists" crash — unless the
//   URL explicitly opts back in with `?workers=2`.
// - macOS/Linux keep the engine's default workers (no URL rewrite).
// - The WebGL2 compatibility boot (armed marker) still normalizes
//   `?gpu=webgl2&nogpuworkers`, and the Windows gate never fights it.
// - The legacy `studio_force_webgl` poison pill (a PERMANENT localStorage
//   marker written by older local builds on device loss) is wiped from both
//   storages on every boot.
// - The engine's adapter is recorded (`effectcraftLoad.gpu.adapter`) so a
//   hybrid-graphics laptop booting the iGPU is diagnosable.
// - The source (web/index.html) and the Studio dist copy
//   (apps/web/public/editor/index.html) are byte-identical.
// Exits non-zero on failure.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../../..");
const SOURCE = join(repo, "editor/apps/effectcraft-web/web/index.html");
const DIST = join(repo, "apps/web/public/editor/index.html");

// The frozen dist copy must stay byte-identical to the source (the build
// copies it; a manual edit of one side is the classic drift bug).
assert.equal(readFileSync(SOURCE, "utf8"), readFileSync(DIST, "utf8"), "dist index.html is byte-identical to the source");

const html = readFileSync(SOURCE, "utf8");
const match = html.match(/<script type="module">([\s\S]*?)<\/script>/);
assert.ok(match, "the inline module script is present");
// The only import is the engine glue — swap it for harness stubs.
const script = match[1].replace(
  'import init, * as ec from "./effectcraft_web.js";',
  "const init = globalThis.__ecInit; const ec = globalThis.__ecApi;",
);
assert.ok(!script.includes("import "), "no other imports to stub");

const MODULE_STUB = { __wasmModule: true };

/**
 * Boot the preflight in a fresh fake environment. Returns what the page
 * observable recorded: the final URL (after any replaceState), the storages,
 * `effectcraftLoad` and the adapter-request log.
 */
async function boot({ platform, userAgent, search = "/editor/?empty", session = {}, local = {}, adapter }) {
  const statusEl = { textContent: "", className: "" };
  const canvasEl = { getContext: () => ({ getExtension: () => null }) };
  const sessionStore = new Map(Object.entries(session));
  const localStore = new Map(Object.entries(local));
  const adapterCalls = [];
  const gpu = adapter === null
    ? { requestAdapter: () => Promise.resolve(null) }
    : {
        requestAdapter: (options) => {
          adapterCalls.push(options);
          return Promise.resolve(adapter);
        },
      };
  const define = (key, value) =>
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  define("window", globalThis);
  define("self", globalThis);
  define("document", { getElementById: (id) => (id === "status" ? statusEl : canvasEl) });
  define("navigator", { platform, userAgent, gpu });
  define("location", { search, hash: "", href: `https://studio.test${search}` });
  define("history", { replaceState: (_s, _t, url) => (globalThis.location.search = url) });
  define("localStorage", {
    getItem: (k) => localStore.get(k) ?? null,
    setItem: (k, v) => localStore.set(k, String(v)),
    removeItem: (k) => localStore.delete(k),
  });
  define("sessionStorage", {
    getItem: (k) => sessionStore.get(k) ?? null,
    setItem: (k, v) => sessionStore.set(k, String(v)),
    removeItem: (k) => sessionStore.delete(k),
  });
  define("WebAssembly", { compileStreaming: async () => MODULE_STUB, compile: async () => MODULE_STUB });
  define("fetch", async () => ({ ok: true, status: 200, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(8) }));
  define("__ecInit", async () => {});
  define("__ecApi", { start: async () => {}, info: () => ({}) });

  try {
    await new Function(`return (async () => {\n${script}\n})()`)();
  } finally {
    const out = {
      search: globalThis.location.search,
      effectcraftLoad: globalThis.window.effectcraftLoad,
      sessionStore,
      localStore,
      adapterCalls,
      status: statusEl.textContent,
    };
    for (const key of ["window", "self", "document", "navigator", "location", "history", "localStorage", "sessionStorage", "WebAssembly", "fetch", "__ecInit", "__ecApi"]) {
      try {
        delete globalThis[key];
      } catch {
        // A non-configurable built-in: leave it (a later boot redefines it).
      }
    }
    return out;
  }
}

const WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0";
const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0";
const RTX = { info: { vendor: "nvidia", architecture: "ad10x", device: "", description: "NVIDIA GeForce RTX 3050" } };

// ── 1. Windows, default boot: workers gated, WebGPU kept, adapter recorded ──
{
  const r = await boot({ platform: "Win32", userAgent: WIN_UA, adapter: RTX, local: { studio_force_webgl: "1" }, session: { studio_force_webgl: "1" } });
  const params = new URLSearchParams(r.search);
  assert.ok(params.has("noworkers"), "Windows boot normalizes ?noworkers into the URL");
  assert.ok(!params.has("nogpuworkers"), "no WebGL2 downgrade — the main device stays WebGPU");
  assert.ok(!params.has("workers"), "no explicit opt-out leaked into the URL");
  assert.equal(r.effectcraftLoad.gpu.webgpu, true, "WebGPU adapter answered");
  assert.equal(r.effectcraftLoad.gpu.adapter.vendor, "nvidia", "the engine's adapter is recorded");
  assert.match(r.effectcraftLoad.gpu.adapter.description, /RTX 3050/);
  assert.equal(r.localStore.has("studio_force_webgl"), false, "legacy localStorage poison pill wiped");
  assert.equal(r.sessionStore.has("studio_force_webgl"), false, "legacy sessionStorage poison pill wiped");
  assert.deepEqual(r.adapterCalls, [{ powerPreference: "high-performance" }], "the pre-flight asks for the high-performance GPU");
}

// ── 2. Windows, explicit `?workers=2`: the URL is left alone ────────────────
{
  const r = await boot({ platform: "Win32", userAgent: WIN_UA, search: "/editor/?empty&workers=2", adapter: RTX });
  assert.equal(r.search, "/editor/?empty&workers=2", "an explicit workers opt-in is honored (no rewrite)");
  assert.ok(r.effectcraftLoad.gpu.webgpu, "engine boots WebGPU with the opted-in workers");
}

// ── 3. macOS/Linux: engine defaults (2 workers), no URL rewrite ─────────────
{
  const r = await boot({ platform: "MacIntel", userAgent: LINUX_UA, adapter: RTX });
  assert.equal(r.search, "/editor/?empty", "non-Windows boots are untouched");
  assert.ok(r.effectcraftLoad.gpu.webgpu);
}

// ── 4. Armed fallback (any platform): WebGL2 normalization still wins ───────
{
  const r = await boot({
    platform: "Win32",
    userAgent: WIN_UA,
    session: { "studio:editor-gpu-fallback": "1" },
    adapter: { requestAdapter: () => Promise.reject(new Error("should never be called — the fallback shims it")) },
  });
  const params = new URLSearchParams(r.search);
  assert.equal(params.get("gpu"), "webgl2", "the armed fallback normalizes the WebGL2 boot");
  assert.ok(params.has("nogpuworkers"), "worker GPUs are off in compatibility mode");
  assert.equal(r.effectcraftLoad.gpu.fallback, true, "the mode is visible in effectcraftLoad");
  assert.equal(r.effectcraftLoad.gpu.webgpu, false);
  assert.ok(r.effectcraftLoad.gpu.webgl2, "the WebGL2 floor answered");
}

console.log("preflight: ok");
