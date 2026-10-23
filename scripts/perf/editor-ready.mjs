/**
 * editor-ready.mjs — BUILD_PLAN §6 "Editor ready" budget measurement
 * (warm < 6 s, cold < 12 s), on-box via Playwright's own chromium.
 *
 * WHAT IT MEASURES
 *   navigation start → editor-ready signal, where "ready" is the app's own
 *   bridge/session readiness marker: `[data-testid="editor-host"]` flips its
 *   `data-editor-phase` attribute to `"open"` (apps/web/src/components/
 *   editor-host/editor-host.tsx → use-editor-session.ts: wasm bridge ready →
 *   project downloaded → file.open + lease acquire → phase "open"). The m5
 *   e2e journey waits on the exact same attribute (e2e/m5-agent-edits.spec.ts
 *   openSeededEditor), so this is the same signal, timed.
 *
 *   The timestamp is read IN-PAGE (`performance.now()` at the moment the
 *   condition first holds inside waitForFunction), i.e. milliseconds since
 *   navigation start — not host wall-clock around Playwright bookkeeping.
 *   A host-side wall-clock delta is kept as a cross-check.
 *
 * BOOTSTRAPPING (copied from the m5 spec, e2e/README.md §5b/§6):
 *   real /sign-in form as the seeded demo user → session cookie → `?next=`
 *   round-trip to the editor URL. One bootstrap context (untimed) also warms
 *   the dev server's on-demand route compile; its storageState (cookies) is
 *   replayed into every measurement context.
 *
 * SERIES
 *   cold-ish ×N: fresh context per run (empty HTTP cache → the wasm and every
 *     chunk are re-fetched) — NOT a true cold boot: the dev server, the OS
 *     page cache and the gateway are already warm, hence "cold-ish".
 *   warm ×N: one context, first an untimed load, then N reloads of the same
 *     editor URL (warm HTTP cache) — "same session reload".
 *
 * HONEST LIMITS (recorded with every result set — docs/performance.md)
 *   - `next dev` (Turbopack, no prod bundling/minify, dev overlays) — numbers
 *     are inflated vs a production build.
 *   - sandbox shared CPU (2 cores) + software GL (headless, no GPU).
 *   - loopback network (no real transfer latency).
 *
 * USAGE (ONE shell invocation — the sandbox reaps background processes):
 *   see scripts/perf/boot-and-measure.sh (boots gateway + `next dev`
 *   per apps/web/e2e/README.md §5b, runs this script, tears down).
 *
 * Requires a live stack: PERF_BASE_URL (default http://localhost:3000 — the
 * Next 16 dev-origin rule means the browser MUST use `localhost`, never
 * 127.0.0.1; e2e/README.md §5b).
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// ---------------------------------------------------------------------------
// Knobs (env-overridable)
// ---------------------------------------------------------------------------

const BASE_URL = process.env.PERF_BASE_URL ?? "http://localhost:3000";
const EDITOR_PATH = process.env.PERF_EDITOR_PATH ?? "/w/demo-project/editor";
const RUNS = Number.parseInt(process.env.PERF_RUNS ?? "5", 10);
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.env.PERF_OUT_DIR ?? resolve(HERE, "results");

/** Seeded demo login (packages/db/scripts/seed.ts — dev fixture, never prod). */
const SEEDED_EMAIL = "demo@studio.test";
const SEEDED_PASSWORD = "demo-password-12345";

/** Wasm boot + manifest → project download → file.open + lease. (m5 spec.) */
const EDITOR_OPEN_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------

/** Nearest-rank percentile: sorted[ceil(p·n)-1] (BUILD_PLAN §6 "p75, not best case"). */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

function stats(ms) {
  const sorted = [...ms].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0] ?? null,
    p50: percentile(sorted, 50),
    p75: percentile(sorted, 75),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1] ?? null,
    samples: sorted,
  };
}

function log(...args) {
  process.stdout.write(`[${new Date().toISOString()}] ${args.join(" ")}\n`);
}

// ---------------------------------------------------------------------------
// Chromium process-tree RSS (an UPPER BOUND on the browser footprint — the
// §6 "editor memory" budget scenario is a 1080p 20-layer comp on the
// reference box, so this is a data point, not that number).
// ---------------------------------------------------------------------------

function processTreeRssMb(rootPid) {
  try {
    const out = execSync("ps -eo pid=,ppid=,rss=,args=", { encoding: "utf8" });
    const procs = [];
    let browserPid = rootPid ?? null;
    for (const line of out.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      const [, pid, ppid, rss, args] = m;
      procs.push({ pid: Number(pid), ppid: Number(ppid), rss: Number(rss) });
      // Playwright 1.57 exposes no browser.process(); find the headless
      // chromium main process by its ms-playwright path instead.
      if (rootPid === undefined && args.includes("ms-playwright") && args.includes("--headless")) {
        browserPid = Number(pid);
      }
    }
    if (browserPid === null) return null;
    const byPpid = new Map();
    for (const p of procs) {
      const list = byPpid.get(p.ppid) ?? [];
      list.push(p);
      byPpid.set(p.ppid, list);
    }
    let totalKb = 0;
    const queue = [browserPid];
    const seen = new Set();
    while (queue.length > 0) {
      const pid = queue.pop();
      if (seen.has(pid)) continue;
      seen.add(pid);
      const node = procs.find((p) => p.pid === pid);
      if (node) totalKb += node.rss;
      for (const child of byPpid.get(pid) ?? []) queue.push(child.pid);
    }
    return Math.round((totalKb / 1024) * 10) / 10;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// m5 spec bootstrapping — real /sign-in form (eye-toggle hydration canary),
// then land on the seeded project's editor. Copied from
// apps/web/e2e/m5-agent-edits.spec.ts openSeededEditor().
// ---------------------------------------------------------------------------

async function waitForSignInHydration(page) {
  const password = page.locator("#sign-in-password");
  const eyeToggle = page.locator(
    'button[aria-label="Show password"], button[aria-label="Hide password"]',
  );
  let hydrated = false;
  for (let i = 0; i < 30 && !hydrated; i += 1) {
    await eyeToggle.click();
    hydrated = (await password.getAttribute("type")) === "text";
    if (!hydrated) await page.waitForTimeout(1_000);
  }
  if (!hydrated) {
    throw new Error("sign-in form never hydrated (eye-toggle canary timed out)");
  }
  await eyeToggle.click(); // restore hidden-password state
}

/**
 * Transient-navigation error classes worth retrying on this fleet's shared
 * box: parallel agents hot-restart `next dev` / race for :3000, so a page.goto
 * can be refused for a few seconds while the server is between listeners.
 */
function isTransientNavError(err) {
  const msg = String(err?.message ?? err);
  return (
    msg.includes("ERR_CONNECTION_REFUSED") ||
    msg.includes("ERR_CONNECTION_TIMED_OUT") ||
    msg.includes("ERR_EMPTY_RESPONSE") ||
    msg.includes("net::ERR_NETWORK") ||
    msg.includes("Target page, context or browser has been closed")
  );
}

/** page.goto with bounded backoff for transient refusals (see above). */
async function gotoWithRetry(page, url, waitUntil = "domcontentloaded", tries = 5) {
  for (let i = 1; i <= tries; i += 1) {
    try {
      await page.goto(url, { waitUntil, timeout: 60_000 });
      return;
    } catch (err) {
      if (i === tries || !isTransientNavError(err)) throw err;
      await page.waitForTimeout(2_000 * i);
    }
  }
}

async function signInThroughForm(page) {
  const attempt = async () => {
    await gotoWithRetry(page, `/sign-in?next=${encodeURIComponent(EDITOR_PATH)}`);
    await waitForSignInHydration(page);
    await page.locator("#sign-in-email").fill(SEEDED_EMAIL);
    await page.locator("#sign-in-password").fill(SEEDED_PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL(`**${EDITOR_PATH}`, { timeout: 20_000 });
  };
  let lastErr;
  for (let i = 0; i < 3; i += 1) {
    try {
      await attempt();
      return;
    } catch (err) {
      lastErr = err;
      // absorb a cold dev-server first submit (m5 run-3 note) AND transient
      // port races from parallel fleet agents (see isTransientNavError)
      await page.waitForTimeout(3_000);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// One timed editor load: navigation start → data-editor-phase="open".
// ---------------------------------------------------------------------------

async function measureEditorOpen(page, label) {
  const errors = [];
  const onPageError = (err) => errors.push(String(err));
  const onConsole = (msg) => {
    if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
  };
  page.on("pageerror", onPageError);
  page.on("console", onConsole);

  const url = `${BASE_URL}${EDITOR_PATH}`;
  const t0Wall = Date.now();
  try {
    await gotoWithRetry(page, url, "commit");
    // The editor-ready signal: performance.now() read in-page at the moment
    // the phase attribute first reads "open" — ms since navigation start.
    const openSinceNavStart = await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="editor-host"]');
        if (el !== null && el.getAttribute("data-editor-phase") === "open") {
          return performance.now();
        }
        return false;
      },
      { timeout: EDITOR_OPEN_TIMEOUT_MS },
    ).then((handle) => handle.jsonValue());
    const wallMs = Date.now() - t0Wall;

    // Post-open context metrics (one round-trip): navigation timing, the wasm
    // resource entry as actually served, JS heap, chromium tree RSS.
    const extras = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0];
      const wasm = performance
        .getEntriesByType("resource")
        .filter((e) => e.name.endsWith(".wasm"))
        .map((e) => ({
          name: e.name.split("/").pop(),
          durationMs: Math.round(e.duration),
          transferSize: e.transferSize,
          encodedBodySize: e.encodedBodySize,
          decodedBodySize: e.decodedBodySize,
        }))
        .sort((a, b) => b.transferSize - a.transferSize)
        .slice(0, 3);
      const mem = performance.memory
        ? {
            usedJSHeapMb: Math.round((performance.memory.usedJSHeapSize / 1048576) * 10) / 10,
            totalJSHeapMb: Math.round((performance.memory.totalJSHeapSize / 1048576) * 10) / 10,
          }
        : null;
      return {
        domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
        loadEventMs: nav ? Math.round(nav.loadEventEnd) : null,
        wasm,
        mem,
      };
    });
    const rssMb = processTreeRssMb();

    return {
      label,
      ok: true,
      openSinceNavStartMs: Math.round(openSinceNavStart * 10) / 10,
      wallMs,
      ...extras,
      chromiumTreeRssMb: rssMb,
      errors,
    };
  } catch (err) {
    return { label, ok: false, wallMs: Date.now() - t0Wall, error: String(err), errors };
  } finally {
    page.off("pageerror", onPageError);
    page.off("console", onConsole);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`editor-ready measurement — base ${BASE_URL}, editor ${EDITOR_PATH}, ${RUNS} runs/series`);
  const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
  const result = {
    kind: "editor-ready",
    startedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    editorPath: EDITOR_PATH,
    cold: [],
    warm: [],
  };
  // Incremental persistence: rewrite the result file after every series so a
  // timeout/kill still leaves the samples that already landed on disk.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = resolve(OUT_DIR, `editor-ready-${stamp}.json`);
  const persist = () => writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);

  try {
    // --- Bootstrap: real form sign-in (untimed) + first editor open (untimed
    // warmup for the dev server's on-demand route compile), then keep only the
    // session cookies for the measurement contexts.
    log("bootstrap: sign-in via the real /sign-in form (m5 flow, untimed)");
    const boot = await browser.newContext({
      baseURL: BASE_URL,
      viewport: { width: 1280, height: 720 },
    });
    const bootPage = await boot.newPage();
    await signInThroughForm(bootPage);
    log("bootstrap: signed in — first editor open (untimed warmup / route compile)");
    const warmup = await measureEditorOpen(bootPage, "bootstrap-warmup");
    log(`bootstrap: editor open ${warmup.ok ? "OK" : "FAILED"} in ${warmup.openSinceNavStartMs ?? warmup.wallMs} ms (discarded)`);
    if (!warmup.ok) throw new Error(`bootstrap editor open failed: ${warmup.error}`);
    const storageState = await boot.storageState();
    await boot.close();

    // --- Cold-ish series: fresh context per run (empty HTTP cache).
    for (let i = 1; i <= RUNS; i += 1) {
      log(`cold run ${i}/${RUNS}: fresh context, goto ${EDITOR_PATH}`);
      const context = await browser.newContext({
        baseURL: BASE_URL,
        storageState,
        viewport: { width: 1280, height: 720 },
      });
      const page = await context.newPage();
      let sample = await measureEditorOpen(page, `cold-${i}`);
      if (!sample.ok && isTransientNavError(sample.error)) {
        log(`cold run ${i}: transient nav failure (${sample.error}) — one clean retry`);
        sample = await measureEditorOpen(page, `cold-${i}r`);
      }
      result.cold.push(sample);
      log(
        `cold run ${i}: ${sample.ok ? `${sample.openSinceNavStartMs} ms (nav→open)` : `FAILED: ${sample.error}`}`,
      );
      await context.close();
    }
    persist();

    // --- Warm series: ONE context — untimed warmup load, then N timed reloads.
    const warmContext = await browser.newContext({
      baseURL: BASE_URL,
      storageState,
      viewport: { width: 1280, height: 720 },
    });
    const warmPage = await warmContext.newPage();
    log("warm series: untimed warmup load (warms this context's HTTP cache)");
    const warmWarmup = await measureEditorOpen(warmPage, "warm-warmup");
    log(`warm warmup: ${warmWarmup.ok ? `${warmWarmup.openSinceNavStartMs} ms` : `FAILED: ${warmWarmup.error}`} (discarded)`);
    for (let i = 1; i <= RUNS; i += 1) {
      log(`warm run ${i}/${RUNS}: same session reload`);
      let sample = await measureEditorOpen(warmPage, `warm-${i}`);
      if (!sample.ok && isTransientNavError(sample.error)) {
        log(`warm run ${i}: transient nav failure (${sample.error}) — one clean retry`);
        sample = await measureEditorOpen(warmPage, `warm-${i}r`);
      }
      result.warm.push(sample);
      log(
        `warm run ${i}: ${sample.ok ? `${sample.openSinceNavStartMs} ms (nav→open)` : `FAILED: ${sample.error}`}`,
      );
    }
    await warmContext.close();
    persist();
  } finally {
    await browser.close().catch(() => {});
  }

  const coldOk = result.cold.filter((s) => s.ok).map((s) => s.openSinceNavStartMs);
  const warmOk = result.warm.filter((s) => s.ok).map((s) => s.openSinceNavStartMs);
  result.summary = {
    cold: stats(coldOk),
    warm: stats(warmOk),
    budget: { warmMs: 6000, coldMs: 12000 },
    note: "cold = fresh browser context (empty HTTP cache), warm dev server; warm = same-session reload. next dev (not a production build); sandbox shared CPU; headless software GL.",
  };

  log("SUMMARY editor-ready (nav start → data-editor-phase=open, in-page perf.now)");
  log(JSON.stringify(result.summary, null, 2));
  persist(); // final rewrite, now including summary
  log(`results written: ${outPath}`);
}

main().catch((err) => {
  console.error(`editor-ready FAILED: ${err?.stack ?? err}`);
  process.exit(1);
});
