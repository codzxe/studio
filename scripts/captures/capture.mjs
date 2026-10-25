#!/usr/bin/env node
/**
 * W3-I THROWAWAY capture script — REAL marketing captures from the live
 * stack (boot recipe: edge :3100 → gateway :8787 MOCK_MODEL=true + next :3000,
 * seeded sqlite demo project; fixture bytes staged by build-fixture.mjs).
 *
 * Produces (into apps/web/public/marketing/ + scripts/captures/.raw/):
 *   - editor-frame.png   the real editor page (/w/demo-project/editor), 16:9
 *                        1920×1080, wasm open, timeline scrubbed to a
 *                        composed frame, chat collapsed (pure editor).
 *   - agent-ask.png      real crop: the user message + the agent's streamed
 *                        reply from the real chat panel (the exchange the
 *                        MOCK_MODEL runner always produces — a rename
 *                        request, so the canned mock reply + plan read
 *                        coherently in the still).
 *   - agent-plan.png     real crop: the real plan card (proposed state).
 *   - .raw/demo-loop.raw.webm — page video of the whole session; the runner
 *                        trims the tail (deterministic: -sseof) into the
 *                        ≤8s muted loop + poster frame.
 *
 * Every interaction is the real product: the real /sign-in form, the real
 * wasm editor, the real MOCK_MODEL chat stream, real timeline scrubbing.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const BASE = process.env.CAPTURE_BASE_URL ?? "http://127.0.0.1:3100";
// Repo root derived from this file's own URL — works from any checkout on any OS.
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const OUT = join(REPO, "apps/web/public/marketing");
const RAW = join(REPO, "scripts/captures/.raw");
const EMAIL = "demo@studio.test";
const PASSWORD = "demo-password-12345";
const EDITOR_PATH = "/w/demo-project/editor";

mkdirSync(OUT, { recursive: true });
mkdirSync(RAW, { recursive: true });

const log = (...a) => console.log(`[capture ${new Date().toISOString().slice(11, 19)}]`, ...a);
const marks = {
  contextStart: 0,
  typingStart: 0,
  sentAt: 0,
  streamDoneAt: 0,
  motionStart: 0,
  closedAt: 0,
};

const browser = await chromium.launch({
  // /dev/shm is 64MB on this box — Chromium's default shm usage crashes the
  // renderer without this flag. NOTE: NO --disable-gpu — the W2-09 editor
  // capability gate probes navigator.gpu / canvas.getContext("webgl2")
  // BEFORE mounting the editor host, and --disable-gpu kills SwiftShader's
  // software WebGL2 in headless chromium → UnsupportedGpuState → the editor
  // never mounts (the t=15:02 probe pinned exactly that). Default headless
  // chromium (the e2e config's launch) renders WebGL2 via SwiftShader.
  args: ["--disable-dev-shm-usage"],
});
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  recordVideo: { dir: RAW, size: { width: 1920, height: 1080 } },
});
marks.contextStart = Date.now();
const page = await context.newPage();
page.on("pageerror", (e) => log("PAGEERROR:", String(e).slice(0, 200)));
page.on("crash", () => log("PAGE CRASHED"));

try {
  // ── 1. the REAL sign-in form → the seeded editor ──────────────────────
  // The form's submit handler is client-side (better-auth → router.push). A
  // click that lands before hydration fires a NATIVE form GET (→ "/sign-in?")
  // and the fields reset — the W5-02 runs pinned exactly that failure under
  // fleet CPU contention. Strategy: hydration-aware retries on the real form;
  // if the form never lands, sign in through the REAL better-auth endpoint
  // (cookie shared via the request context) and go straight to the editor.
  log("signing in via the real /sign-in form");
  await page.goto(`${BASE}/sign-in?next=${encodeURIComponent(EDITOR_PATH)}`, {
    waitUntil: "load",
    timeout: 180_000,
  });
  await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {
    log("WARN: networkidle never settled (continuing)");
  });
  let signedIn = false;
  for (let attempt = 1; attempt <= 3 && !signedIn; attempt++) {
    await page.locator("#sign-in-email").waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(2500); // hydration settle
    await page.locator("#sign-in-email").fill(EMAIL);
    await page.locator("#sign-in-password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    try {
      await page.waitForURL(`**${EDITOR_PATH}`, { timeout: 30_000 });
      signedIn = true;
    } catch {
      const url = page.url();
      if (url.includes("/sign-in?")) {
        log(`sign-in attempt ${attempt}: pre-hydration native submit — settling and retrying`);
      } else {
        log(`sign-in attempt ${attempt}: still on ${url} — retrying`);
      }
      await page.waitForLoadState("load", { timeout: 60_000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }
  }
  if (!signedIn) {
    log("form sign-in did not land — falling back to the real better-auth endpoint");
    const response = await context.request.post(`${BASE}/v1/auth/sign-in/email`, {
      headers: { "content-type": "application/json", origin: BASE },
      data: { email: EMAIL, password: PASSWORD },
    });
    if (!response.ok()) {
      throw new Error(`better-auth sign-in failed: ${response.status()} ${await response.text()}`);
    }
    await page.goto(`${BASE}${EDITOR_PATH}`, { waitUntil: "load", timeout: 180_000 });
  }
  log("signed in, landed on the editor route");

  // ── 2. the real wasm editor opens the seeded project ──────────────────
  await page.waitForSelector('[data-testid="editor-host"][data-editor-phase="open"]', {
    timeout: 120_000,
  });
  log("editor phase=open (project opened by the real wasm engine)");
  const editorFrame = page.frames().find((f) => f.url().includes("/editor/"));
  if (editorFrame) {
    const ec = await editorFrame.evaluate(() => typeof window.effectcraft);
    const canvases = await editorFrame.evaluate(() => document.querySelectorAll("canvas").length);
    log(`iframe window.effectcraft=${ec}, canvases=${canvases}`);
  } else {
    log("WARN: editor iframe not found by URL");
  }
  await page.waitForSelector('[data-testid="chat-layer"]', { timeout: 30_000 });
  await page.waitForSelector('[data-testid="chat-header"]', { timeout: 30_000 });
  log("chat layer mounted");
  await page.waitForTimeout(2500); // canvas settle after open

  // ── 3. scrub the timeline to a composed frame (~2s) ───────────────────
  const iframeBox = await page.getByTestId("editor-iframe").boundingBox();

  async function readPlayhead() {
    await page.getByTestId("chat-context-button").click();
    await page.waitForSelector('[data-testid="context-popover"]', { timeout: 10_000 });
    const text = await page.getByTestId("context-row-playhead").innerText();
    await page.getByTestId("context-done").click();
    await page.waitForTimeout(250);
    return text.trim();
  }

  // Click the iframe first (focus inside the editor, D-5).
  await page.mouse.click(
    iframeBox.x + iframeBox.width * 0.5,
    iframeBox.y + iframeBox.height * 0.45,
  );
  await page.waitForTimeout(400);

  const before = await readPlayhead();
  log(`playhead before scrub: ${before}`);
  let scrubbed = false;
  // The time ruler lives somewhere in the bottom band; sweep candidate rows
  // and click — a click on the ruler jumps the playhead (verified below).
  for (const fy of [0.7, 0.74, 0.78, 0.82, 0.86, 0.66, 0.62]) {
    const y = iframeBox.y + iframeBox.height * fy;
    const x = iframeBox.x + iframeBox.width * 0.3;
    await page.mouse.click(x, y);
    await page.waitForTimeout(350);
    const t = await readPlayhead();
    log(`scrub probe fy=${fy} → ${t}`);
    const m = /Playhead (\d{2}):(\d{2})\.(\d+)/.exec(t);
    if (m) {
      const secs = Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 100;
      if (secs > 0.5) {
        scrubbed = true;
        log(`scrub zone found at fy=${fy}, playhead=${secs.toFixed(2)}s`);
        break;
      }
    }
  }
  if (!scrubbed) log("WARN: could not verify playhead movement (continuing)");

  // ── 4. editor-frame.png — the pure editor (chat collapsed) ────────────
  await page.getByTestId("chat-close-button").click();
  await page.waitForSelector('[data-testid="chat-collapsed-pill"]', { timeout: 10_000 });
  await page.waitForTimeout(900); // collapse transition + canvas settle
  await page.screenshot({ path: `${OUT}/editor-frame.png`, type: "png" });
  log("editor-frame.png saved");

  // ── 5. reopen the chat and run the REAL mock exchange ─────────────────
  await page.getByTestId("chat-collapsed-pill").click();
  await page.waitForSelector('[data-testid="chat-header"]', { timeout: 10_000 });
  await page.waitForTimeout(600);

  const composer = page.getByLabel("Message the agent");
  await composer.click();
  marks.typingStart = Date.now();
  // A rename request — the mock runner's canned reply ("I'll rename that
  // layer for you…") and its rename plan read coherently against it, so the
  // still crops tell one true story (the same mock flow the m4 e2e pins).
  await page.keyboard.type("Rename the headline layer to Subtitle.", { delay: 110 });
  await composer.press("Enter");
  marks.sentAt = Date.now();
  log("question sent");

  await page.waitForSelector(
    '[data-testid="tool-card"][data-tool="studio.get_context"][data-status="done"]',
    { timeout: 30_000 },
  );
  await page.waitForSelector('[data-testid="plan-card"]', { timeout: 30_000 });
  await page.waitForSelector('[data-testid="chat-status"][data-phase="done"]', {
    timeout: 30_000,
  });
  marks.streamDoneAt = Date.now();
  log(`mock run done in ${marks.streamDoneAt - marks.sentAt}ms`);
  await page.waitForTimeout(1200); // settle animations

  // ── 6. real chat crops for the agent story ────────────────────────────
  // Ask: the user message + the agent's reply text (label + markdown), i.e.
  // everything from the user bubble down to just above the tool card — the
  // raw tool-card JSON and the plan card get their own crop / none.
  const userMsg = page.locator('[data-testid="chat-message"][data-role="user"]');
  const toolCard = page.locator('[data-testid="tool-card"][data-tool="studio.get_context"]');
  const panelBox = await page.getByTestId("chat-panel-layer").boundingBox();
  const b1 = await userMsg.boundingBox();
  const bTool = await toolCard.boundingBox();
  const pad = 10;
  // Bottom bound: the tool card's top (the reply text ends above it).
  const clipTop = Math.max(panelBox.y, b1.y - pad);
  const clipBottom = Math.min(panelBox.y + panelBox.height, bTool.y - pad);
  const clip = {
    x: panelBox.x,
    y: clipTop,
    width: panelBox.width,
    height: clipBottom - clipTop,
  };
  await page.screenshot({ path: `${OUT}/agent-ask.png`, type: "png", clip });
  log(`agent-ask.png saved (${Math.round(clip.width)}x${Math.round(clip.height)})`);
  log(
    `ask crop spans user msg + agent reply (${Math.round(b1.height)}px + ${Math.round(
      clipBottom - b1.y,
    )}px of reply)`,
  );

  // Plan: the real plan card element — first collapsed (summary + risk +
  // actions = the approval model at a glance), then with the steps disclosure
  // expanded (the atomic batch step visible).
  const planCard = page.locator('[data-testid="plan-card"]');
  await planCard.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300); // scroll settle
  await planCard.screenshot({ path: `${OUT}/agent-plan.png`, type: "png" });
  const pb = await planCard.boundingBox();
  log(`agent-plan.png saved (${Math.round(pb.width)}x${Math.round(pb.height)})`);

  // Expanded plan card (steps disclosure) + expanded tool card (the agent's
  // evidence: the real get_context result for the open comp).
  const stepsToggle = planCard.getByTestId("plan-steps-toggle");
  if (await stepsToggle.count()) {
    await stepsToggle.click();
    await page.waitForTimeout(400);
    await planCard.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await planCard.screenshot({ path: `${OUT}/agent-plan-expanded.png`, type: "png" });
    log("agent-plan-expanded.png saved (steps disclosure open)");
  } else {
    log("WARN: plan-steps-toggle not found (skipping expanded crop)");
  }
  const toolToggle = toolCard.getByTestId("tool-card-toggle");
  if (await toolToggle.count()) {
    await toolToggle.click();
    await page.waitForTimeout(400);
    await toolCard.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await toolCard.screenshot({ path: `${OUT}/agent-context.png`, type: "png" });
    log("agent-context.png saved (tool card expanded)");
  } else {
    log("WARN: tool-card-toggle not found (skipping context crop)");
  }

  // A full-panel still (fallback/inspection asset).
  await page
    .getByTestId("chat-panel-layer")
    .screenshot({ path: `${RAW}/chat-panel-full.png`, type: "png" });

  // ── 7. motion for the demo loop (video tail) ──────────────────────────
  // Real interaction: playback (Space) + a slow timeline scrub drag through
  // the discovered scrub zone. Content settles as the video's final 8s.
  marks.motionStart = Date.now();
  await page.mouse.click(
    iframeBox.x + iframeBox.width * 0.5,
    iframeBox.y + iframeBox.height * 0.45,
  );
  await page.waitForTimeout(300);
  await page.keyboard.press("Space");
  await page.waitForTimeout(2000);
  // Slow scrub: left → right across the timeline band (below the chat panel).
  const dragY = iframeBox.y + iframeBox.height * 0.8;
  await page.mouse.move(iframeBox.x + iframeBox.width * 0.08, dragY);
  await page.mouse.down();
  for (let i = 1; i <= 24; i++) {
    await page.mouse.move(iframeBox.x + iframeBox.width * (0.08 + 0.34 * (i / 24)), dragY, {
      steps: 2,
    });
    await page.waitForTimeout(80);
  }
  await page.mouse.up();
  await page.waitForTimeout(700);
  log("motion sequence complete (Space + timeline scrub)");

  marks.closedAt = Date.now();
  const summary = {
    contextStart: marks.contextStart,
    typingStart: marks.typingStart,
    sentAt: marks.sentAt,
    streamDoneAt: marks.streamDoneAt,
    motionStart: marks.motionStart,
    closedAt: marks.closedAt,
    offsets: {
      typing: (marks.typingStart - marks.contextStart) / 1000,
      sent: (marks.sentAt - marks.contextStart) / 1000,
      streamDone: (marks.streamDoneAt - marks.contextStart) / 1000,
      motionStart: (marks.motionStart - marks.contextStart) / 1000,
      closed: (marks.closedAt - marks.contextStart) / 1000,
    },
  };
  writeFileSync(`${RAW}/timeline.json`, JSON.stringify(summary, null, 2));
  log("timeline.json:", JSON.stringify(summary.offsets));
} catch (error) {
  // biome-ignore lint/suspicious/noConsole: CLI capture script — reports failure to stderr before exit
  console.error("[capture] FAILED:", error);
  await page.screenshot({ path: `${RAW}/failure.png` }).catch(() => {});
  process.exitCode = 1;
} finally {
  const video = page.video();
  await context.close();
  const videoPath = await video.path();
  log("video saved:", videoPath);
  await browser.close();
}
