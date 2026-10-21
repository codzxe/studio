// W10-L — Playwright config for the §21 E2E row:
//   "Sign-up → invite → upload → prompt → stream → preview → undo → chat edit →
//    export; billing in Stripe test mode."
//
// Everything is env-driven so the same config serves (a) a lone `next dev`
// server with no gateway (web-only smoke: specs skip themselves loudly), and
// (b) the CI preview compose stack (§21 CI row: "Playwright on a preview
// compose stack").
//
// NOTE (task constraint W10-L): `@playwright/test` is deliberately NOT a
// devDependency of apps/web — it is installed by CI only. This config is
// inert until the runner installs it; see e2e/README.md §Run.
import { defineConfig, devices, type Project } from "@playwright/test";
import process from "node:process";

/** Web app origin under test (`next dev` defaults to :3000). */
function requireBaseUrl(): URL {
  const raw = process.env.E2E_BASE_URL ?? "http://localhost:3000";
  try {
    return new URL(raw);
  } catch {
    throw new Error(`E2E_BASE_URL is not a valid URL: ${raw}`);
  }
}
const BASE_URL = requireBaseUrl();

/** Gateway origin for the mock-mode journey (compose §22 bridge-only :3001). */
const GATEWAY_URL = process.env.E2E_GATEWAY_URL ?? "http://localhost:3001";

/** `E2E_BROWSERS=chromium,firefox,webkit` extends the default chromium-only set. */
const BROWSERS = (process.env.E2E_BROWSERS ?? "chromium")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

const DEVICE_BY_BROWSER: Record<string, Project["use"]> = {
  chromium: devices["Desktop Chrome"],
  firefox: devices["Desktop Firefox"],
  webkit: devices["Desktop Safari"],
};

/** Mock-friendly project set: chromium default; extras opt-in via E2E_BROWSERS. */
function projects(): Project[] {
  const out: Project[] = [];
  for (const name of BROWSERS) {
    const use = DEVICE_BY_BROWSER[name];
    if (!use) {
      throw new Error(`E2E_BROWSERS contains unknown browser "${name}" (use chromium|firefox|webkit)`);
    }
    out.push({ name, use });
  }
  return out;
}

/**
 * Web server modes (first match wins):
 *  1. `E2E_NO_WEB_SERVER=1`  — never spawn; BASE_URL is already served
 *     (CI preview compose stack, or a developer's own `pnpm dev`).
 *  2. `E2E_WEB_COMMAND=...`  — fully custom command, run verbatim from cwd.
 *  3. `E2E_WEB_STANDALONE=1` — serve the production standalone build
 *     (`next build` first, then `node .next/standalone/server.js`).
 *  4. default                — `pnpm --filter @studio/web dev` (Next dev).
 * Commands use `pnpm --filter` so they work from any cwd inside the monorepo.
 */
function webServer() {
  if (process.env.E2E_NO_WEB_SERVER === "1") {
    return undefined;
  }
  const command =
    process.env.E2E_WEB_COMMAND ??
    (process.env.E2E_WEB_STANDALONE === "1"
      ? "pnpm --filter @studio/web exec node .next/standalone/server.js"
      : "pnpm --filter @studio/web dev");
  return {
    command,
    url: BASE_URL.toString(),
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { ...process.env, PORT: BASE_URL.port || "3000" } as Record<string, string>,
    stdout: "ignore" as const,
  };
}

export default defineConfig({
  testDir: "tests",
  outputDir: "test-results",
  // Serial journey: the §21 steps share one signed-up session and one run.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  globalTimeout: 15 * 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: BASE_URL.toString(),
    actionTimeout: 15_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: projects(),
  webServer: webServer(),
});

// Re-exported for specs that print the contract in skip reasons (single knob).
export { GATEWAY_URL };
