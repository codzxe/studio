import { expect, test } from "@playwright/test";

test("debug sign-in → editor journey", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300));
  });
  page.on("response", (res) => {
    if (res.url().includes("/v1/") && res.status() >= 400) {
      consoleErrors.push(`HTTP ${res.status()} ${res.url().slice(0, 160)}`);
    }
  });

  await page.goto(`/sign-in?next=${encodeURIComponent("/w/demo-project/editor")}`);
  await page.locator("#sign-in-email").fill("demo@studio.test");
  await page.locator("#sign-in-password").fill("demo-password-12345");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await page.waitForTimeout(8000);
  console.log("URL after sign-in+8s:", page.url());
  const alert = page.locator("p[role=alert]");
  console.log("formError:", (await alert.count()) > 0 ? await alert.first().textContent() : "(none)");
  console.log("console/network errors:", JSON.stringify(consoleErrors.slice(0, 10), null, 1));
  console.log("editor-host count:", await page.getByTestId("editor-host").count());
  console.log("body snippet:", (await page.locator("body").innerText()).slice(0, 400).replace(/\n+/g, " | "));
});
