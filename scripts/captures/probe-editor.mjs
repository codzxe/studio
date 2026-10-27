#!/usr/bin/env node
/** W5-02 diagnostics probe — why does the editor page never reach phase=open? */
import { chromium } from "playwright";

const BASE = process.env.CAPTURE_BASE_URL ?? "http://127.0.0.1:3101";
const EMAIL = "demo@studio.test";
const PASSWORD = "demo-password-12345";
const EDITOR_PATH = "/w/demo-project/editor";
const log = (...a) => console.log(`[probe ${new Date().toISOString().slice(11, 19)}]`, ...a);

const browser = await chromium.launch({ args: ["--disable-dev-shm-usage", "--disable-gpu"] });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await context.newPage();

page.on("pageerror", (e) => log("PAGEERROR:", String(e).slice(0, 300)));
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") log("CONSOLE", m.type(), m.text().slice(0, 250));
});
page.on("requestfailed", (r) => log("REQFAIL", r.url().slice(0, 130), r.failure()?.errorText));
page.on("response", (r) => {
  const u = r.url();
  if (r.status() >= 400 || u.includes("/v1/") || u.includes("/editor")) {
    log("HTTP", r.status(), u.replace(BASE, "").slice(0, 130));
  }
});

try {
  const response = await context.request.post(`${BASE}/v1/auth/sign-in/email`, {
    headers: { "content-type": "application/json", origin: BASE },
    data: { email: EMAIL, password: PASSWORD },
  });
  log("sign-in:", response.status());
  await page.goto(`${BASE}${EDITOR_PATH}`, { waitUntil: "load", timeout: 120_000 });

  for (let i = 0; i < 14; i++) {
    await page.waitForTimeout(5000);
    const state = await page.evaluate(() => {
      const host = document.querySelector('[data-testid="editor-host"]');
      const iframe = document.querySelector('[data-testid="editor-iframe"]');
      return {
        url: location.pathname,
        host: host ? `${host.getAttribute("data-editor-phase")}/${host.getAttribute("data-editor-boot")}` : null,
        iframe: iframe ? iframe.getAttribute("src") : null,
        frames: [...document.querySelectorAll("iframe")].length,
        bodyText: document.body.innerText.slice(0, 150).replace(/\n/g, " | "),
      };
    });
    log(`t=${(i + 1) * 5}s`, JSON.stringify(state));
    if (state.host && state.host.startsWith("open")) {
      log("EDITOR OPEN — success");
      break;
    }
  }
  const editorFrame = page.frames().find((f) => f.url().includes("/editor/"));
  if (editorFrame) {
    log("editor frame url:", editorFrame.url());
    const inner = await editorFrame
      .evaluate(() => ({
        effectcraft: typeof window.studioEngine,
        canvases: document.querySelectorAll("canvas").length,
        bodyStart: document.body.innerText.slice(0, 200).replace(/\n/g, " | "),
      }))
      .catch((e) => `frame eval failed: ${String(e).slice(0, 150)}`);
    log("editor frame internals:", JSON.stringify(inner));
  } else {
    log("NO editor frame found (iframe never navigated)");
  }
  await page.screenshot({ path: "/tmp/editor-probe.png" });
} catch (error) {
  log("FAILED:", String(error).slice(0, 400));
} finally {
  await browser.close();
}
