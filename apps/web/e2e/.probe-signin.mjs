import { chromium } from "@playwright/test";

const probe = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const logs = [];
  page.on("console", (m) => logs.push(`[console.${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
  const responses = [];
  page.on("response", (r) => {
    if (r.url().includes("/v1/") || r.url().includes("/sign-in") || r.url().includes("/w"))
      responses.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 110)}`);
  });
  await page.goto("http://localhost:3000/sign-in?next=%2Fw", { waitUntil: "load" });
  await page.locator("#sign-in-password").waitFor({ state: "visible", timeout: 10000 });
  await page.getByLabel("Email").fill("demo@studio.test");
  await page.locator("#sign-in-password").fill("demo-password-12345");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForTimeout(6000);
  console.log("URL now:", page.url());
  console.log("--- responses ---");
  for (const r of responses.slice(0, 20)) console.log(r);
  console.log("--- logs ---");
  for (const l of logs.slice(0, 20)) console.log(l);
  const errBanner = await page
    .getByText(/invalid|error|wrong|failed/i)
    .count()
    .catch(() => -1);
  console.log("error-ish text count:", errBanner);
  await browser.close();
};

probe().catch((e) => {
  console.error("PROBE FAILED:", e.message);
  process.exit(1);
});
