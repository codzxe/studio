/**
 * prewarm-diagnose.mjs (W3-D) — one-shot diagnostic that breaks the prewarmed
 * click→open time into its phases, so the editor-open budget attribution is
 * honest (which part is dev-mode chunk serving, which is the engine).
 *
 * Flow (identical to editor-ready.mjs's prewarmed series, but instrumented):
 *   /w dashboard → await the shell prewarm → tile Open → history →
 *   "Open editor" → sample in-page timestamps until data-editor-phase="open".
 *
 * Phases reported (ms since the Open-editor click):
 *   hostMounted  — the editor page's RSC + client chunks are in and the host
 *                  mounted (dev: the unbundled chunk waterfall; prod: the
 *                  <Link>-prefetched bundle, near-instant)
 *   wasmAdopted  — the iframe's bootstrap finished init() (the compiled module
 *                  was adopted: no network wasm fetch in this phase)
 *   engineReady  — ec.start() returned (GPU device + surface up)
 *   open         — file.open + lease acquire done; the phase flips to "open"
 *
 * Assumes a live stack (same env as editor-ready.mjs; see
 * scripts/perf/boot-and-measure.sh). Usage: node prewarm-diagnose.mjs
 */

import { chromium } from "playwright";

const BASE_URL = process.env.PERF_BASE_URL ?? "http://localhost:3000";
const SEEDED_EMAIL = "demo@studio.test";
const SEEDED_PASSWORD = "demo-password-12345";
const RUNS = Number.parseInt(process.env.PERF_RUNS ?? "3", 10);

async function signIn(page) {
  await page.goto(`${BASE_URL}/sign-in?next=%2Fw`, { waitUntil: "domcontentloaded" });
  const eye = page.locator(
    'button[aria-label="Show password"], button[aria-label="Hide password"]',
  );
  for (let i = 0; i < 30; i += 1) {
    await eye.click();
    if ((await page.locator("#sign-in-password").getAttribute("type")) === "text") break;
    await page.waitForTimeout(1_000);
  }
  await eye.click();
  await page.locator("#sign-in-email").fill(SEEDED_EMAIL);
  await page.locator("#sign-in-password").fill(SEEDED_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/w", { timeout: 20_000 });
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
  for (let run = 1; run <= RUNS; run += 1) {
    const context = await browser.newContext({
      baseURL: BASE_URL,
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();
    await signIn(page);

    // Wait for the shell prewarm to finish the download + compile.
    await page.waitForFunction(
      () => {
        const w = window;
        return w.__studioEditorWasm !== undefined;
      },
      { timeout: 120_000 },
    );
    const prewarmMs = await page.evaluate(() => {
      const w = window;
      const t0 = performance.now();
      return w.__studioEditorWasm.then(
        () => Math.round(performance.now() - t0),
        () => -1,
      );
    });

    // The real path: tile Open → history → Open editor.
    await page
      .getByRole("button", { name: "Open", exact: true })
      .first()
      .click({ timeout: 60_000, force: true });
    const editorLink = page.getByTestId("history-open-editor");
    await editorLink.waitFor({ state: "visible", timeout: 60_000 });

    await page.evaluate(() => {
      const w = window;
      w.__diag = { t0: performance.now(), host: null, wasm: null, ready: null, open: null };
    });
    await editorLink.click();

    // The editor host mounts, then the iframe boots (adopts the prewarmed
    // module), then the session opens the project. The iframe's window is
    // same-origin, but guard the access anyway — a cross-origin throw inside
    // the predicate would read as a hang.
    const phases = await page
      .waitForFunction(
        () => {
          const w = window;
          const d = w.__diag;
          const host = document.querySelector('[data-testid="editor-host"]');
          if (d.host === null && host !== null) d.host = Math.round(performance.now() - d.t0);
          try {
            const load = host ? host.querySelector("iframe")?.contentWindow?.studioEngineLoad : null;
            if (d.wasm === null && load && load.wasmMs !== undefined)
              d.wasm = Math.round(performance.now() - d.t0);
            if (d.ready === null && load && load.readyMs !== undefined)
              d.ready = Math.round(performance.now() - d.t0);
          } catch {
            // Not reachable yet / isolated — keep polling.
          }
          if (host !== null && host.getAttribute("data-editor-phase") === "open") {
            d.open = Math.round(performance.now() - d.t0);
            return { host: d.host, wasm: d.wasm, ready: d.ready, open: d.open };
          }
          return false;
        },
        { timeout: 120_000, polling: 100 },
      )
      .then((h) => h.jsonValue());

    process.stdout.write(
      `run ${run}: engine prewarmed in ${prewarmMs} ms | click→host ${phases.host} ms | →iframe init ${phases.wasm} ms | →engine ready ${phases.ready} ms | →OPEN ${phases.open} ms\n`,
    );
    await context.close();
  }
  await browser.close();
}

main().catch((err) => {
  // biome-ignore lint/suspicious/noConsole: CLI perf script — reports failure to stderr before exit
  console.error(`prewarm-diagnose FAILED: ${err?.stack ?? err}`);
  process.exit(1);
});
