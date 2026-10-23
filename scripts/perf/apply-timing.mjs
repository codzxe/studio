/**
 * apply-timing.mjs — BUILD_PLAN §6 "Apply (engine.batch, ≤20 steps) < 300 ms
 * p75" budget measurement, on-box via Playwright + the m5 scripted-run leg.
 *
 * WHAT IT MEASURES
 *   The §6 row is engine.batch alone, but the honest user-visible unit is
 *   confirm-Apply → plan "applied" WITH the version actually saved (D-6:
 *   apply.ts runs ONE atomic engine.batch then `autosave.saveNow("agent-apply")`
 *   uploads a new immutable version, then reports applyRun). This script
 *   times the WHOLE leg and also separates the version-upload POST, so the
 *   ledger can show both the budget-shaped number and the fuller journey.
 *
 * HOW (verbatim from apps/web/e2e/m5-agent-edits.spec.ts — the high-risk
 *   journey test):
 *   - real /sign-in form as the seeded demo user → editor open
 *     (`[data-testid="editor-host"][data-editor-phase="open"]`);
 *   - the m5 scripted-gateway leg: page.route intercepts the chat run POST
 *     and fulfills it with the spec's deterministic SSE high-risk plan
 *     (run.started → message.delta → plan[+compiledBatch+resolutions] →
 *     run.completed), so the model wire (MOCK_MODEL) never contaminates the
 *     timing;
 *   - checkbox → Apply → confirm dialog → CONFIRM is t0; then
 *       t(applied)        = plan-card data-status="applied"
 *       t(version-saved)  = first 2xx POST /v1/projects/:id/versions
 *                           (the uploadVersion multipart — bytes ride the POST)
 *   - every POST/PUT between t0 and settle is recorded with status + wall
 *     offset, so a silent save-failure (the W2-B8 triage #1 bug: batch
 *     applied, version upload never issued) is visible in the evidence file.
 *
 *   n defaults to 3 (each run applies a REAL batch and moves the project's
 *   version head — the m5 reapply gate then blocks further applies on the
 *   same thread, so each timed run reloads the editor for a fresh thread).
 *
 * HONEST LIMITS (recorded with every result set — docs/performance.md)
 *   - `next dev` + tsx gateway (not production builds); sandbox shared CPU
 *     (2 cores) + software GL; loopback.
 *   - The 300 ms budget targets engine.batch on the reference machine; the
 *     number here includes DOM/card state machinery and the version upload,
 *     so it is an UPPER BOUND for the budget row, not the row itself.
 *   - If apply is mid-fix by the W3-C1 owner (apply.ts/autosave.ts were
 *     modified in the working tree during this wave), the failure mode is
 *     recorded verbatim and the budget is marked OWED, not measured.
 *
 * USAGE (ONE shell invocation — the sandbox reaps background processes):
 *   scripts/perf/boot-and-measure.sh apply   # gateway + next dev + this file
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const BASE_URL = process.env.PERF_BASE_URL ?? "http://localhost:3000";
const EDITOR_PATH = process.env.PERF_EDITOR_PATH ?? "/w/demo-project/editor";
const RUNS = Number.parseInt(process.env.PERF_RUNS ?? "3", 10);
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.env.PERF_OUT_DIR ?? resolve(HERE, "results");

/** Seeded demo login (packages/db/scripts/seed.ts — dev fixture, never prod). */
const SEEDED_EMAIL = "demo@studio.test";
const SEEDED_PASSWORD = "demo-password-12345";

const EDITOR_OPEN_TIMEOUT_MS = 120_000;
const RUN_SETTLE_TIMEOUT_MS = 30_000;
const APPLY_SETTLE_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Stats helpers (same nearest-rank percentile as the sibling scripts)
// ---------------------------------------------------------------------------

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
    max: sorted[sorted.length - 1] ?? null,
    samples: sorted,
  };
}

function log(...args) {
  process.stdout.write(`[${new Date().toISOString()}] ${args.join(" ")}\n`);
}

// ---------------------------------------------------------------------------
// m5 spec bootstrapping (copied from editor-ready.mjs / m5-agent-edits.spec.ts)
// ---------------------------------------------------------------------------

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
  await eyeToggle.click();
}

async function signInThroughForm(page) {
  const attempt = async () => {
    await gotoWithRetry(page, `${BASE_URL}/sign-in?next=${encodeURIComponent(EDITOR_PATH)}`);
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
      await page.waitForTimeout(3_000);
    }
  }
  throw lastErr;
}

async function waitForEditorOpen(page) {
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="editor-host"]');
      return el !== null && el.getAttribute("data-editor-phase") === "open";
    },
    { timeout: EDITOR_OPEN_TIMEOUT_MS },
  );
  await page.getByTestId("chat-layer").waitFor({ state: "visible", timeout: 30_000 });
}

// ---------------------------------------------------------------------------
// The scripted high-risk plan (verbatim fixture from m5-agent-edits.spec.ts)
// ---------------------------------------------------------------------------

function sseFrames(events) {
  return events
    .map((event) => `id: ${String(event.seq)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

const HIGH_RISK_PLAN = {
  intent: "style",
  summary: "Restyle the Background solid with a Multiply blend",
  risk: "high",
  requiresApproval: true,
  affectedLayers: [{ id: 1, name: "Background", change: "Blend mode Multiply" }],
  estimatedCredits: 2.25,
  steps: [
    {
      title: "Set the Background blend mode to Multiply",
      tool: "studio.set_properties",
      args: { layerName: "Background", property: "blendMode", value: "Multiply" },
      batch: {
        label: "Agent: blend Background",
        steps: [
          {
            command: "layer.setBlendMode",
            params: { layers: "$request:req_bg", mode: "Multiply" },
          },
        ],
      },
    },
  ],
};

const HIGH_RISK_COMPILED_BATCH = {
  label: "Agent: blend Background",
  atomic: true,
  steps: [
    { command: "layer.setBlendMode", params: { layers: "$request:req_bg", mode: "Multiply" } },
  ],
};

const HIGH_RISK_RESOLUTIONS = [{ requestId: "req_bg", layerName: "Background", disambiguation: [] }];

function highRiskRunEvents(runId) {
  return [
    { type: "run.started", runId, seq: 1, model: "studio-fast" },
    {
      type: "message.delta",
      runId,
      seq: 2,
      delta: "This restyle touches the comp background — planning it as high risk.",
    },
    {
      type: "plan",
      runId,
      seq: 3,
      plan: HIGH_RISK_PLAN,
      compiledBatch: HIGH_RISK_COMPILED_BATCH,
      resolutionRequests: HIGH_RISK_RESOLUTIONS,
      risk: "high",
      estimatedCredits: 2.25,
    },
    { type: "run.completed", runId, seq: 4 },
  ];
}

// ---------------------------------------------------------------------------
// One timed apply run (fresh page = fresh chat thread; each apply moves the
// project's version head, so later runs on the same thread would drift-gate).
// ---------------------------------------------------------------------------

async function measureApplyOnce(page, runId) {
  const mutations = []; // { offsetMs, method, url, status } — filled by listeners
  const pageErrors = []; // pageerror + console.error text (failure evidence)
  let t0 = null;
  const now = () => Date.now();

  const onPageError = (err) => pageErrors.push(String(err?.message ?? err).slice(0, 500));
  const onConsole = (msg) => {
    if (msg.type() === "error") pageErrors.push(`console.error: ${msg.text()}`.slice(0, 500));
  };
  page.on("pageerror", onPageError);
  page.on("console", onConsole);

  const onRequest = (req) => {
    if (t0 === null) return;
    if (req.method() !== "GET" && req.method() !== "HEAD" && req.method() !== "OPTIONS") {
      mutations.push({
        offsetMs: now() - t0,
        method: req.method(),
        url: req.url().replace(BASE_URL, ""),
        status: null,
      });
    }
  };
  const onResponse = (res) => {
    if (t0 === null) return;
    const m = mutations.find(
      (x) => x.status === null && res.url().replace(BASE_URL, "") === x.url && res.request().method() === x.method,
    );
    if (m) m.status = res.status();
  };
  page.on("request", onRequest);
  page.on("response", onResponse);

  const sample = { runId, ok: false };
  try {
    await page.route("**/v1/threads/*/chat", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" },
        body: sseFrames(highRiskRunEvents(runId)),
      });
    });

    const composer = page.getByLabel("Message the agent");
    await composer.click();
    await composer.fill("Blend the Background layer to Multiply");
    await composer.press("Enter");

    const plan = page.getByTestId("plan-card");
    await plan.waitFor({ state: "visible", timeout: RUN_SETTLE_TIMEOUT_MS });
    await page
      .locator('[data-testid="plan-card"]')
      .waitFor({ state: "attached" });
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="plan-card"]');
        return el !== null && el.getAttribute("data-status") === "proposed";
      },
      { timeout: RUN_SETTLE_TIMEOUT_MS },
    );

    const checkbox = plan.getByTestId("plan-confirm-checkbox");
    const applyButton = plan.getByTestId("plan-apply");
    await checkbox.check();
    await applyButton.waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const btn = document.querySelector('[data-testid="plan-apply"]');
      return btn !== null && !btn.hasAttribute("disabled");
    }, { timeout: RUN_SETTLE_TIMEOUT_MS });

    await applyButton.click();
    const dialog = page.getByTestId("chat-confirm-dialog");
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    t0 = now();
    await page.getByTestId("chat-confirm-confirm").click();

    // applied = the card's own status machine (may land before/without save).
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="plan-card"]');
        return el !== null && el.getAttribute("data-status") === "applied";
      },
      { timeout: APPLY_SETTLE_TIMEOUT_MS },
    );
    sample.appliedMs = now() - t0;

    // version-saved = the uploadVersion multipart POST answered 2xx. Give it
    // a settle window AFTER applied (saveNow runs before the applied flip in
    // the happy path, but be generous in the unhappy one).
    const versionPost = () =>
      mutations.find(
        (m) =>
          m.status !== null &&
          m.status >= 200 &&
          m.status < 300 &&
          /^\/v1\/projects\/[^/]+\/versions(\?|$)/.test(m.url) &&
          m.method === "POST",
      );
    let saved = versionPost();
    for (let i = 0; i < 20 && saved === undefined; i += 1) {
      await page.waitForTimeout(500);
      saved = versionPost();
    }
    sample.versionSavedMs = saved !== undefined ? saved.offsetMs : null;

    // The W2-B8 failure copy — surfacing it means the save leg is still broken.
    sample.saveFailureCopyVisible = await page
      .getByText("could not be saved as a version", { exact: false })
      .count()
      .then((c) => c > 0)
      .catch(() => false);
    sample.ok = true;
  } catch (err) {
    sample.error = String(err).slice(0, 500);
    // Terminal card state at timeout (applied|failed|save-failed|…) — the
    // honest failure mode for the ledger (W2-B8 triage #1: batch applies but
    // the version save fails ⇒ card settles "failed", never "applied").
    sample.cardAtTimeout = await page
      .evaluate(() => {
        const el = document.querySelector('[data-testid="plan-card"]');
        return el === null
          ? null
          : {
              status: el.getAttribute("data-status"),
              text: (el.textContent ?? "").replace(/\s+/g, " ").slice(0, 400),
            };
      })
      .catch(() => null);
  } finally {
    page.off("request", onRequest);
    page.off("response", onResponse);
    page.off("pageerror", onPageError);
    page.off("console", onConsole);
    sample.mutations = mutations;
    sample.pageErrors = pageErrors.slice(0, 30);
  }
  return sample;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`apply-timing measurement — base ${BASE_URL}, editor ${EDITOR_PATH}, ${RUNS} runs`);
  const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
  const result = {
    kind: "apply-timing",
    startedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    editorPath: EDITOR_PATH,
    runs: RUNS,
    samples: [],
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = resolve(OUT_DIR, `apply-timing-${stamp}.json`);
  const persist = () => writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);

  try {
    // Bootstrap: sign-in through the real form (untimed), then per run a
    // fresh page → fresh editor session → fresh chat thread.
    log("bootstrap: sign-in via the real /sign-in form (m5 flow, untimed)");
    const context = await browser.newContext({
      baseURL: BASE_URL,
      viewport: { width: 1280, height: 720 },
    });
    const bootPage = await context.newPage();
    await signInThroughForm(bootPage);
    await waitForEditorOpen(bootPage); // also warms the dev-server route compile
    log("bootstrap: editor open — closing bootstrap page (untimed)");

    for (let i = 1; i <= RUNS; i += 1) {
      const page = await context.newPage();
      await gotoWithRetry(page, `${BASE_URL}${EDITOR_PATH}`, "commit");
      await waitForEditorOpen(page);
      log(`apply run ${i}/${RUNS}: editor open — scripted high-risk plan → confirm Apply`);
      const sample = await measureApplyOnce(page, `run_perf_apply_${i}_${Date.now()}`);
      result.samples.push(sample);
      log(
        `apply run ${i}: ${sample.ok
          ? `applied ${sample.appliedMs} ms, versionSaved ${sample.versionSavedMs ?? "NEVER"} ms, saveFailureCopy=${sample.saveFailureCopyVisible}`
          : `FAILED: ${sample.error}`}`,
      );
      await page.close();
      persist();
    }
    await context.close();
  } finally {
    await browser.close().catch(() => {});
  }

  const appliedOk = result.samples.filter((s) => s.ok).map((s) => s.appliedMs);
  const savedOk = result.samples
    .filter((s) => s.ok && s.versionSavedMs !== null)
    .map((s) => s.versionSavedMs);
  result.summary = {
    confirmToApplied: stats(appliedOk),
    confirmToVersionSaved: savedOk.length > 0 ? stats(savedOk) : { n: 0, note: "no version upload landed in any run" },
    budget: { row: "Apply (engine.batch, ≤20 steps)", p75Ms: 300 },
    note: "confirm→applied INCLUDES engine.batch + card state machinery + version upload + applyRun report (an upper bound for the engine.batch-only budget); next dev + tsx gateway, sandbox shared CPU, loopback; scripted SSE plan (m5 fixture) so the model wire never contaminates the timing",
  };

  log("SUMMARY apply-timing (confirm-Apply click → plan applied / version POST 2xx)");
  log(JSON.stringify(result.summary, null, 2));
  persist();
  log(`results written: ${outPath}`);
}

main().catch((err) => {
  console.error(`apply-timing FAILED: ${err?.stack ?? err}`);
  process.exit(1);
});
