/**
 * Visual verification journey — screenshots at every stage of the editor
 * session + the device-lost recovery (docs/phases/M3.md "Known tails" #6),
 * saved to <repo>/download/screenshots/ for human/VLM inspection.
 *
 * What is proven, against the REAL stack (real sign-in, real editor wasm,
 * real gateway + sqlite, real version uploads, real RSC):
 *   1. the sign-in page renders and works;
 *   2. the editor boots and opens the seeded project (canvas + chat layer);
 *   3. an edit goes through the real engine (comp.new);
 *   4. the device loss (at the dist's own boundary — the exact function the
 *      wasm device-lost callback calls) shows the recovery overlay in its
 *      "saving" stage (the upload is route-delayed 4 s so the stage is
 *      captured deterministically);
 *   5. the recovery save uploads + the page reloads + the editor reopens
 *      WITH the edit (the comp survived the "loss");
 *   6. the history page shows the new version with its
 *      "Save after graphics device loss" label;
 *   7. the workspace dashboard lists the project.
 *
 * Same boot recipe as e2e/chat.spec.ts (e2e/README.md); no extra setup.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Seeded world (packages/db/scripts/seed.ts — e2e/README.md §Seed)
// ---------------------------------------------------------------------------

const SEEDED_EMAIL = "demo@studio.test";
const SEEDED_PASSWORD = "demo-password-12345";
const SEEDED_EDITOR_PATH = "/w/demo-project/editor";
const SEEDED_HISTORY_PATH = "/w/demo-project/history";

/** Wasm boot + manifest → project download → file.open. */
const EDITOR_OPEN_TIMEOUT_MS = 120_000;
/** The recovery save (bridge → gateway upload) + the reload. */
const RECOVERY_TIMEOUT_MS = 30_000;

/**
 * The frozen dist's JS-snippet module (the glue's own import path): the
 * committed tree pins `snippets/effectcraft-web-6247e0b7c298e283`.
 */
const HOST_JS_PATH = "/editor/snippets/effectcraft-web-6247e0b7c298e283/js/host.js";

/** The comp the recovery journey creates (its presence proves the save). */
const RECOVERY_COMP = "Recovery Check";

/** Where the screenshots land (the user-facing download directory). */
const SHOT_DIR = join(import.meta.dirname, "..", "..", "..", "download", "screenshots");

/** Hold the version upload this long so the overlay's saving stage is
 *  screenshot-deterministic (the recovery itself is faster than a shutter). */
const UPLOAD_HOLD_MS = 4_000;

type EffectcraftGlobal = {
  request: (method: string, params?: unknown) => Promise<unknown>;
  execute: (command: string, params?: unknown) => Promise<unknown>;
};

// ---------------------------------------------------------------------------
// Boot recipe (identical to e2e/chat.spec.ts)
// ---------------------------------------------------------------------------

async function waitForSignInHydration(page: Page): Promise<void> {
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
  // Restore the hidden-password state the recipe expects.
  await eyeToggle.click();
}

async function openSeededEditor(page: Page): Promise<void> {
  const attemptSignIn = async (): Promise<void> => {
    await page.goto(`/sign-in?next=${encodeURIComponent(SEEDED_EDITOR_PATH)}`);
    await waitForSignInHydration(page);
    await page.locator("#sign-in-email").fill(SEEDED_EMAIL);
    await page.locator("#sign-in-password").fill(SEEDED_PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL(`**${SEEDED_EDITOR_PATH}`, { timeout: 20_000 });
  };
  try {
    await attemptSignIn();
  } catch {
    await attemptSignIn();
  }

  await expect(page.getByTestId("editor-host")).toHaveAttribute("data-editor-phase", "open", {
    timeout: EDITOR_OPEN_TIMEOUT_MS,
  });
  await expect(page.getByTestId("editor-iframe")).toBeVisible();
}

/** The editor iframe's frame (the only frame under /editor/). */
function editorFrame(page: Page) {
  const frame = page.frames().find((f) => f.url().includes("/editor/"));
  if (frame === undefined) {
    throw new Error("editor iframe not found");
  }
  return frame;
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(SHOT_DIR, name), fullPage: false });
}

// ---------------------------------------------------------------------------
// The journey
// ---------------------------------------------------------------------------

test.describe("Visual verification — editor session + device-lost recovery", () => {
  test.beforeEach(() => {
    test.setTimeout(300_000);
    mkdirSync(SHOT_DIR, { recursive: true });
  });

  test("sign-in → editor → edit → device lost → save → reload → reopen (screenshots)", async ({
    page,
  }) => {
    // -- 1. Sign-in page ----------------------------------------------------
    await page.goto(`/sign-in?next=${encodeURIComponent(SEEDED_EDITOR_PATH)}`);
    await waitForSignInHydration(page);
    await shot(page, "01-sign-in.png");

    // -- 2. Sign in + the editor opens the seeded project -------------------
    await page.locator("#sign-in-email").fill(SEEDED_EMAIL);
    await page.locator("#sign-in-password").fill(SEEDED_PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL(`**${SEEDED_EDITOR_PATH}`, { timeout: 20_000 });
    await expect(page.getByTestId("editor-host")).toHaveAttribute("data-editor-phase", "open", {
      timeout: EDITOR_OPEN_TIMEOUT_MS,
    });
    // Give the wasm canvas a beat to composite the fixture's comp, then shoot.
    await page.waitForTimeout(2_500);
    await shot(page, "02-editor-open.png");

    // -- 3. An edit through the REAL engine ---------------------------------
    await editorFrame(page).evaluate(
      (name) =>
        (window as unknown as { effectcraft: EffectcraftGlobal }).effectcraft.execute("comp.new", {
          name,
          open: false,
        }),
      RECOVERY_COMP,
    );

    // Hold POST /v1/projects/:id/versions for a beat (GETs pass through) so
    // the overlay's saving stage is deterministic to capture; arm the reload
    // watcher BEFORE the loss (the recovery can out-run a late waiter).
    await page.route("**/v1/projects/*/versions*", async (route) => {
      if (route.request().method() === "POST") {
        await page.waitForTimeout(UPLOAD_HOLD_MS);
      }
      await route.continue();
    });
    const reloadNavigation = page.waitForRequest(
      (req) =>
        req.isNavigationRequest() &&
        req.method() === "GET" &&
        new URL(req.url()).pathname === SEEDED_EDITOR_PATH,
      { timeout: RECOVERY_TIMEOUT_MS },
    );

    // -- 4. The device loss (the dist's own boundary) ------------------------
    await editorFrame(page).evaluate(async (hostPath) => {
      const host = (await import(hostPath)) as {
        showDeviceLost: (message: string, kept: boolean) => void;
      };
      host.showDeviceLost(
        "GPU device lost (Unknown): A valid external Instance reference no longer exists (e2e)",
        false,
      );
    }, HOST_JS_PATH);

    // The recovery overlay, in its saving stage (the upload is held).
    await expect(page.getByTestId("device-lost-overlay")).toBeVisible({
      timeout: RECOVERY_TIMEOUT_MS,
    });
    await expect(page.getByTestId("device-lost-copy")).toContainText(
      "Saving your work, then reopening the editor",
    );
    await shot(page, "03-device-lost-overlay-saving.png");

    // -- 5. The save lands + the page reloads + the editor reopens ----------
    await reloadNavigation;
    await expect(page.getByTestId("editor-host")).toHaveAttribute("data-editor-phase", "open", {
      timeout: EDITOR_OPEN_TIMEOUT_MS,
    });
    await page.waitForTimeout(2_500);
    await shot(page, "04-editor-reopened.png");

    // The edit survived the device loss (the recovery save's version).
    const items = await editorFrame(page).evaluate(async () => {
      // query commands (project.summary) ride the execute channel — the
      // bridge's own `query()` maps onto `effectcraft.execute` (bridge.ts).
      const summary = (await (
        window as unknown as { effectcraft: EffectcraftGlobal }
      ).effectcraft.execute("project.summary", {})) as { items?: Array<{ name?: string }> };
      return (summary.items ?? []).map((item) => String(item.name ?? ""));
    });
    expect(items).toContain(RECOVERY_COMP);

    // -- 6. The history page shows the recovery save's version --------------
    await page.goto(SEEDED_HISTORY_PATH);
    await expect(page.getByTestId("history-view")).toBeVisible({
      timeout: RECOVERY_TIMEOUT_MS,
    });
    await expect(page.getByTestId("history-view")).toContainText(
      "Save after graphics device loss",
      { timeout: RECOVERY_TIMEOUT_MS },
    );
    await shot(page, "05-history-versions.png");

    // -- 7. The workspace dashboard lists the project ------------------------
    await page.goto("/w");
    await expect(page.locator("main")).toContainText("Demo Project", {
      timeout: RECOVERY_TIMEOUT_MS,
    });
    await shot(page, "06-workspace.png");
  });
});
