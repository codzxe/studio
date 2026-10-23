import { expect, test } from "@playwright/test";

test("debug sign-in → editor journey (deep)", async ({ page }) => {
  const events: string[] = [];
  page.on("response", async (res) => {
    const url = res.url();
    if (url.includes("/v1/auth/sign-in") || url.includes("/v1/me")) {
      let setCookie = "";
      try {
        setCookie = JSON.stringify(res.headers()["set-cookie"] ?? null).slice(0, 200);
      } catch {}
      events.push(`HTTP ${res.status()} ${url.slice(0, 120)} set-cookie=${setCookie}`);
    }
    if (url.includes("_rsc") && res.status() >= 300) {
      events.push(`RSC ${res.status()} ${url.slice(0, 120)} location=${res.headers()["location"] ?? ""}`);
    }
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) events.push(`nav → ${frame.url()}`);
  });

  await page.goto(`/sign-in?next=${encodeURIComponent("/w/demo-project/editor")}`);
  await page.locator("#sign-in-email").fill("demo@studio.test");
  await page.locator("#sign-in-password").fill("demo-password-12345");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await page.waitForTimeout(6000);
  const cookies = await page.context().cookies();
  console.log("cookies:", JSON.stringify(cookies.map((c) => `${c.name}(${c.value.length}ch,domain=${c.domain},path=${c.path})`)));
  console.log("EVENTS:", JSON.stringify(events, null, 1));
  console.log("URL now:", page.url());
  console.log("editor-host:", await page.getByTestId("editor-host").count());
  // probe /v1/me from the browser with the live cookie jar
  const me = await page.evaluate(async () => {
    const res = await fetch("/v1/me", { credentials: "include" });
    return `${res.status} ${(await res.text()).slice(0, 200)}`;
  });
  console.log("browser /v1/me probe:", me);
});
