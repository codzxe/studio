// scripts/e2e-probe-editor.mjs — boot /editor/?empty and dump console/network/boot state
import { chromium } from "@playwright/test";

const base = process.env.E2E_BASE_URL || "http://localhost:3000";
const b = await chromium.launch();
const page = await b.newPage();
const consoleMsgs = [];
const netFails = [];
page.on("console", (m) => consoleMsgs.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
page.on("pageerror", (e) => consoleMsgs.push(`[pageerror] ${String(e).slice(0, 400)}`));
page.on("requestfailed", (r) =>
  netFails.push(`${r.method()} ${r.url()} → ${r.failure()?.errorText}`),
);
page.on("response", (r) => {
  if (r.status() >= 400) netFails.push(`${r.status()} ${r.url()}`);
});

// biome-ignore lint/suspicious/noConsole: diagnostic probe script — console output is its report
console.log("goto", `${base}/editor/?empty`);
await page.goto(`${base}/editor/?empty`, { waitUntil: "domcontentloaded", timeout: 60000 });
for (let i = 0; i < 45; i++) {
  const state = await page
    .evaluate(() => {
      const g = window;
      const ec = g.effectcraft;
      const load = g.editorLoadState ?? g.__editorLoadState ?? null;
      return {
        hasEffectcraft: !!ec,
        version: ec?.version ? ec.version() : null,
        info: ec?.info ? ec.info() : null,
        loadState: load,
        reactKeys: Object.keys(g).filter((k) => k.startsWith("__react")).length,
      };
    })
    .catch((e) => ({ evalError: String(e).slice(0, 200) }));
  // biome-ignore lint/suspicious/noConsole: diagnostic probe script — console output is its report
  console.log(`t=${i * 2}s`, JSON.stringify(state));
  if (state.version) break;
  await page.waitForTimeout(2000);
}
// biome-ignore lint/suspicious/noConsole: diagnostic probe script — console output is its report
console.log("=== console ===");
// biome-ignore lint/suspicious/noConsole: diagnostic probe script — console output is its report
for (const m of consoleMsgs.slice(-25)) console.log(m);
// biome-ignore lint/suspicious/noConsole: diagnostic probe script — console output is its report
console.log("=== net fails (>=400) ===");
// biome-ignore lint/suspicious/noConsole: diagnostic probe script — console output is its report
for (const f of netFails.slice(-15)) console.log(f);
await b.close();
