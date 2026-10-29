#!/usr/bin/env node
// Round-13 perf: measure the AUTHENTICATED /w/:slug/editor page's LCP in a
// fresh headless Chromium, the same machine class the DevTools traces came
// from. Reads the session cookie + project slug saved by
// scripts/prod-editor-scripts.mjs (captures/probe-editor-cookie.txt holds the
// cookie; the slug comes from argv or the probe account default).
//
// Usage: node scripts/prod-lcp-probe.mjs [slug]
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "https://motiongra.vercel.app";
const slug = process.argv[2] ?? "probe-editor-js";
const cookieLine = readFileSync(
  "/home/z/my-project/scripts/captures/probe-editor-cookie.txt",
  "utf8",
)
  .split("\n")
  .find((l) => l.includes("session_token"))
  ?.trim();
if (!cookieLine) {
  console.error("no session cookie — run scripts/prod-editor-scripts.mjs first");
  process.exit(1);
}
const eq = cookieLine.indexOf("=");
const name = cookieLine.slice(0, eq);
const value = cookieLine.slice(eq + 1);
const PAGE_URL = `${BASE}/w/${slug}/editor`;

const browser = await chromium.launch({ args: ["--disable-dev-shm-usage"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 720 } });
await context.addCookies([
  // __Secure- prefixed cookies REQUIRE secure:true in Chromium's store.
  { name, value, domain: new URL(BASE).host, path: "/", secure: true },
]);
const page = await context.newPage();

const log = (...a) => console.log(`[lcp ${new Date().toISOString().slice(11, 19)}]`, ...a);
log("open", PAGE_URL);

const t0 = Date.now();
await page.goto(PAGE_URL, { waitUntil: "load", timeout: 60_000 });
const metrics = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const nav = performance.getEntriesByType("navigation")[0];
      let lcp = null;
      const po = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        if (entries.length > 0) lcp = entries[entries.length - 1];
      });
      po.observe({ type: "largest-contentful-paint", buffered: true });
      setTimeout(() => {
        resolve({
          ttfb: Math.round(nav?.responseStart ?? -1),
          domContentLoaded: Math.round(nav?.domContentLoadedEventEnd ?? -1),
          load: Math.round(nav?.loadEventEnd ?? -1),
          lcpMs: lcp ? Math.round(lcp.startTime) : null,
          lcpElement: lcp?.element ? String(lcp.element.outerHTML).slice(0, 140) : null,
          lcpUrl: lcp?.url ?? null,
        });
      }, 2500);
    }),
);
log(JSON.stringify({ ...metrics, wallClockMs: Date.now() - t0 }, null, 1));

// Long tasks (>50ms) on the main thread during load — the INP signal.
const longTasks = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const tasks = [];
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) tasks.push(Math.round(e.duration));
      });
      po.observe({ type: "longtask", buffered: true });
      setTimeout(() => resolve(tasks.sort((a, b) => b - a).slice(0, 8)), 1500);
    }),
);
log("longtasks(ms):", JSON.stringify(longTasks));

// Script count/bytes actually fetched for this load.
const scriptBytes = await page.evaluate(() => {
  const entries = performance.getEntriesByType("resource");
  const js = entries.filter((e) => e.name.endsWith(".js"));
  return {
    jsCount: js.length,
    jsTransferKB: Math.round(js.reduce((sum, e) => sum + (e.transferSize || 0), 0) / 1024),
  };
});
log("scripts:", JSON.stringify(scriptBytes));

await page.screenshot({ path: "scripts/captures/prod-lcp-probe.png" }).catch(() => {});
await browser.close();
