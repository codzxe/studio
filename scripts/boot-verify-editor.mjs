#!/usr/bin/env node
// One-shot editor boot verification (local dist): boots the freshly built
// editor/target/web/dist in headless Chromium — the same environment class
// that reproduced the "Limit 'max_compute_workgroups_per_dimension' value
// 65535 is better than allowed 0" field failure (no WebGPU adapter → GL path)
// — and polls the dist's studioEngineLoad seam until readyMs (boot OK) or
// error (boot dead). Exits 0 only on a real readyMs.
//
// Usage: node scripts/boot-verify-editor.mjs [--port 8766] [--budget-ms 420000]

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const DIST = resolve(import.meta.dirname, "..", "editor/target/web/dist");
const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const PORT = Number(flag("port", "8766"));
const BUDGET_MS = Number(flag("budget-ms", "420000"));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".css": "text/css; charset=utf-8",
};

// Minimal static server with the same security headers `cargo xtask web
// --serve` sends (crossOriginIsolated is required for the workers path).
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let path = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = normalize(join(DIST, path));
  if (!file.startsWith(DIST)) { res.writeHead(403).end(); return; }
  try {
    const st = await stat(file);
    if (!st.isFile()) throw new Error("not a file");
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "content-length": st.size,
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "credentialless",
      "cache-control": "no-store",
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const { chromium } = await import("playwright");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("console", (m) => { const t = `[page ${m.type()}] ${m.text()}`; if (m.type() !== "log" || /Studio|gpu|error/i.test(t)) console.log(t.slice(0, 220)); });
page.on("pageerror", (e) => console.log(`[pageerror] ${String(e).slice(0, 220)}`));

const url = `http://127.0.0.1:${PORT}/?empty&nosw`;
console.log(`booting: ${url}`);
const t0 = Date.now();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });

let verdict = null;
while (Date.now() - t0 < BUDGET_MS) {
  verdict = await page.evaluate(() => {
    const l = window.studioEngineLoad ?? {};
    return {
      readyMs: typeof l.readyMs === "number" ? Math.round(l.readyMs) : null,
      wasmMs: typeof l.wasmMs === "number" ? Math.round(l.wasmMs) : null,
      error: l.error ?? null,
      gpu: l.gpu ?? null,
      crossOriginIsolated: typeof crossOriginIsolated === "boolean" ? crossOriginIsolated : null,
    };
  });
  if (verdict.readyMs !== null) { console.log(`READY after ${verdict.readyMs}ms (wasm ${verdict.wasmMs}ms)`); break; }
  if (verdict.error) { console.log(`ERROR after ${Date.now() - t0}ms: ${verdict.error}`); break; }
  await delay(5_000);
}
console.log("verdict:", JSON.stringify(verdict));
try { await page.screenshot({ path: "/home/z/my-project/scripts/boot-verify-editor.png" }); } catch {}
const booted = verdict?.readyMs != null;
await browser.close();
server.close();
process.exit(booted ? 0 : 1);
