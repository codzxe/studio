import { chromium } from "playwright";
const BASE = "http://127.0.0.1:3000";
const browser = await chromium.launch({ args: ["--disable-dev-shm-usage", "--disable-gpu"] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log("CONSOLE", m.type(), m.text().slice(0, 300)); });
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 300)));
page.on("requestfailed", (r) => console.log("REQFAIL", r.url().slice(0, 120), r.failure()?.errorText));
page.on("response", (r) => { if (r.status() >= 400) console.log("HTTP", r.status(), r.url().slice(0, 140)); });
await page.goto(`${BASE}/sign-in`, { waitUntil: "domcontentloaded", timeout: 120_000 });
try {
  await page.waitForSelector("#sign-in-email", { timeout: 20_000 });
  console.log("EMAIL FIELD FOUND");
} catch {
  console.log("EMAIL FIELD MISSING");
}
console.log("TITLE:", await page.title());
console.log("BODYTEXT:", (await page.evaluate(() => document.body.innerText.slice(0, 400))).replace(/\n/g, " | "));
await page.screenshot({ path: "/tmp/signin-probe.png" });
await browser.close();
