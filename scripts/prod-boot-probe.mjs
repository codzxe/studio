#!/usr/bin/env node
// One-shot PRODUCTION editor boot probe: opens the live editor URL in a
// fresh headless-Chromium profile (no WebGPU adapter — the field machine
// class of the 'max_compute_workgroups_per_dimension 65535 better than
// allowed 0' bug) and polls window.studioEngineLoad until readyMs (boot OK)
// or error (boot dead). Every fetch is a service-worker-cache miss in a
// fresh profile, so a green boot also exercises the sw.js cache:"reload"
// network path end to end. Exits 0 only on a real readyMs.
//
// Usage: node scripts/prod-boot-probe.mjs [URL] [--budget-ms 420000]
//   default URL: https://motiongra.vercel.app/editor/?empty&nosw

import { chromium } from "playwright";
import { setTimeout as delay } from "node:timers/promises";

const args = process.argv.slice(2);
// Positional args are URLs ONLY if they parse as http(s) — a bare numeric
// value (e.g. someone passing the budget without --budget-ms) must never be
// mistaken for a URL ("Cannot navigate to invalid URL 150000").
const urlFlag = args.find((a) => a.startsWith("http://") || a.startsWith("https://"));
const URL_TO_PROBE =
  urlFlag ?? process.env.PROD_EDITOR_URL ?? "https://motiongra.vercel.app/editor/?empty&nosw";
const budgetIdx = args.indexOf("--budget-ms");
const BUDGET_MS = budgetIdx >= 0 ? Number(args[budgetIdx + 1]) : 420_000;

const log = (...a) => console.log(`[probe ${new Date().toISOString().slice(11, 19)}]`, ...a);

const browser = await chromium.launch({ args: ["--disable-dev-shm-usage", "--disable-gpu"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 720 } });
const page = await context.newPage();

page.on("pageerror", (e) => log("PAGEERROR:", String(e).slice(0, 300)));
page.on("requestfailed", (r) => log("REQFAIL", r.url().slice(0, 120), r.failure()?.errorText));
page.on("response", (r) => {
  const u = r.url();
  if (u.includes("/editor/") && (r.status() >= 400 || u.endsWith(".wasm"))) {
    log("HTTP", r.status(), u.slice(0, 120));
  }
});

log("open", URL_TO_PROBE);
await page.goto(URL_TO_PROBE, { waitUntil: "load", timeout: 120_000 });

const t0 = Date.now();
let verdict = null;
while (Date.now() - t0 < BUDGET_MS) {
  const s = await page.evaluate(() => {
    const l = window.studioEngineLoad ?? {};
    return {
      readyMs: typeof l.readyMs === "number" ? l.readyMs : null,
      wasmMs: typeof l.wasmMs === "number" ? l.wasmMs : null,
      error: typeof l.error === "string" ? l.error : null,
      status: document.getElementById("status")?.textContent ?? null,
      canvas: (() => {
        const c = document.getElementById("studio_canvas");
        return c ? `${c.width}x${c.height}` : null;
      })(),
    };
  });
  if (s.readyMs !== null) {
    verdict = { ok: true, ...s };
    log("BOOT READY:", JSON.stringify(verdict));
    break;
  }
  if (s.error) {
    verdict = { ok: false, ...s };
    log("BOOT DEAD:", JSON.stringify(verdict));
    break;
  }
  log(`waiting… ${Math.round((Date.now() - t0) / 1000)}s status=${s.status} wasmMs=${s.wasmMs}`);
  await delay(5000);
}

if (verdict === null) {
  log("BUDGET EXPIRED without readyMs or error");
  verdict = { ok: false, timeout: true };
}

// Capture evidence either way, then exit with the verdict.
await page.screenshot({ path: "scripts/captures/prod-boot-probe.png" }).catch(() => {});
await browser.close();
process.exit(verdict.ok ? 0 : 1);
