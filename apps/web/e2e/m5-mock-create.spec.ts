/**
 * M5 mock-create — the OFFLINE CREATION journey: with ZERO model keys
 * (MOCK_MODEL=true — no LiteLLM, no OpenAI, no API key anywhere), a
 * brand-new project created from the dashboard can be driven end to end:
 * blank editor (the no-version start-from-scratch flow) → chat ask → the
 * mock model's compile-enriched CREATE plan → ONE click Apply → the real
 * engine.batch (comp.new + layer.newText) → the real version upload (v1,
 * baseVersionId null — the first-snapshot path) → the applied card with the
 * one-undo-step promise, and the created composition verifiably present in
 * the engine AND on the server.
 *
 * This is the user-facing guarantee behind "make sure the project should be
 * able to make something without any API": the entire create loop runs on
 * the local stack. The mock plan's wire shape is asserted in
 * e2e/chat.spec.ts + m5-agent-edits.spec.ts; this spec proves the JOURNEY.
 *
 * Boot: the README recipe (seeded demo user → real /sign-in → dashboard) —
 * identical to e2e/chat.spec.ts's sign-in helpers (duplicated per the
 * gateway-tests precedent: e2e specs never import sibling spec files).
 *
 * Determinism contract: the run goes to the REAL gateway (MOCK_MODEL=true),
 * the apply to the REAL engine bridge, the save to the REAL versions route.
 * The only route watcher is passive (it records, never fulfills).
 */

import { type Page, expect, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Seeded world (packages/db/scripts/seed.ts — e2e/README.md §Seed)
// ---------------------------------------------------------------------------

/** The seed's demo login (dev fixture credentials, never production). */
const SEEDED_EMAIL = "demo@studio.test";
const SEEDED_PASSWORD = "demo-password-12345";

/** Wasm boot + manifest → (fresh project: no download) → the chat bridge. */
const EDITOR_OPEN_TIMEOUT_MS = 120_000;
/** Second bridge attach (chat layer) after the editor reports `open`. */
const CHAT_MOUNT_TIMEOUT_MS = 30_000;
/** The gateway's TOOL_RESULT_TIMEOUT_MS — a generous upper bound for runs. */
const RUN_SETTLE_TIMEOUT_MS = 30_000;
/** ONE atomic engine.batch + version upload + applyRun report (M5-F). */
const APPLY_SETTLE_TIMEOUT_MS = 30_000;

/** The mock plan's created composition (services/gateway/src/runner.ts). */
const MOCK_COMP = "Agent Demo";

type EffectcraftGlobal = {
  request: (method: string, params?: unknown) => Promise<unknown>;
  execute: (command: string, params?: unknown) => Promise<unknown>;
};

// ---------------------------------------------------------------------------
// Helpers — sign-in + fresh-project creation (dashboard)
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

/** Sign in and land on the workspace dashboard (the projects grid). */
async function signInToDashboard(page: Page): Promise<void> {
  const attemptSignIn = async (): Promise<void> => {
    await page.goto("/sign-in?next=%2Fw");
    await waitForSignInHydration(page);
    await page.locator("#sign-in-email").fill(SEEDED_EMAIL);
    await page.locator("#sign-in-password").fill(SEEDED_PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL("**/w", { timeout: 20_000 });
  };
  try {
    await attemptSignIn();
  } catch {
    await attemptSignIn();
  }
}

/**
 * Create a brand-new project through the REAL dashboard dialog and return
 * its slug (the URL's /w/<slug>/history after the dialog's push).
 */
async function createFreshProject(page: Page): Promise<string> {
  await page.getByTestId("dashboard-new-project").click();
  const dialog = page.getByTestId("new-project-dialog");
  await expect(dialog).toBeVisible();
  await page.getByTestId("new-project-name").fill(`Mock Create ${Date.now()}`);
  await page.getByTestId("new-project-create").click();
  await page.waitForURL("**/w/*/history", { timeout: 20_000 });
  const slug = new URL(page.url()).pathname.split("/")[2] ?? "";
  if (slug === "") throw new Error("project slug not found in the URL");
  return slug;
}

/** The editor iframe's frame (the only frame under /editor/). */
function editorFrame(page: Page) {
  const frame = page.frames().find((f) => f.url().includes("/editor/"));
  if (frame === undefined) {
    throw new Error("editor iframe not found");
  }
  return frame;
}

// ---------------------------------------------------------------------------
// The journey
// ---------------------------------------------------------------------------

test.describe("M5 mock-create — zero-API-key creation: fresh project → chat → Apply → v1", () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(360_000);
    await signInToDashboard(page);
  });

  test("a from-scratch project creates its first composition through the offline agent", async ({
    page,
  }) => {
    const slug = await createFreshProject(page);

    // The blank editor: the no-version start-from-scratch flow opens the
    // editor with the engine's default project — nothing downloaded, nothing
    // to restore — and the chat layer still mounts.
    await page.goto(`/w/${slug}/editor`);
    await expect(page.getByTestId("editor-host")).toHaveAttribute("data-editor-phase", "open", {
      timeout: EDITOR_OPEN_TIMEOUT_MS,
    });
    await expect(page.getByTestId("chat-layer")).toBeVisible({ timeout: CHAT_MOUNT_TIMEOUT_MS });

    // Passive version watcher: record every upload POST (method + status).
    // Never fulfills — the REAL route must answer.
    const uploads: { url: string; status: number }[] = [];
    await page.route("**/v1/projects/*/versions*", async (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        const response = await route.fetch();
        uploads.push({ url: request.url(), status: response.status() });
        await route.fulfill({ response });
        return;
      }
      await route.continue();
    });

    // Ask the agent — the mock model (MOCK_MODEL=true, zero keys) streams its
    // compile-enriched CREATE plan through the real gateway.
    const composer = page.getByLabel("Message the agent");
    await composer.click();
    await composer.fill("Make me a demo composition with a text layer");
    await composer.press("Enter");

    const plan = page.getByTestId("plan-card");
    await expect(plan).toBeVisible({ timeout: RUN_SETTLE_TIMEOUT_MS });
    await expect(plan).toHaveAttribute("data-status", "proposed");
    await expect(plan).toHaveAttribute("data-intent", "create");
    // Medium risk (server-recomputed) needs NO confirm checkbox — one click.
    await expect(plan.getByTestId("plan-apply")).toBeEnabled({
      timeout: RUN_SETTLE_TIMEOUT_MS,
    });

    // ONE click Apply: the client allowlist passes (comp.new + layer.newText
    // are curated), the real engine executes the ATOMIC batch, the autosave
    // chain saveAs-es the never-saved project (baseVersionId null → v1) and
    // the applyRun report lands.
    await plan.getByTestId("plan-apply").click();

    await expect(plan).toHaveAttribute("data-status", "applied", {
      timeout: APPLY_SETTLE_TIMEOUT_MS,
    });
    await expect(page.getByTestId("plan-applied")).toContainText(/· one undo step\./);

    // SERVER proof: exactly one version upload answered 201 — the project's
    // FIRST version (the from-scratch path; baseVersionId null on the wire).
    expect(uploads.length).toBe(1);
    expect(uploads[0]?.status).toBe(201);

    // ENGINE proof: the created composition + text layer are live in the
    // project (query commands ride the execute channel — bridge.ts).
    const items = await editorFrame(page).evaluate(async () => {
      const summary = (await (
        window as unknown as { effectcraft: EffectcraftGlobal }
      ).effectcraft.execute("project.summary", {})) as { items?: Array<{ name?: string }> };
      return (summary.items ?? []).map((item) => String(item.name ?? ""));
    });
    expect(items).toContain(MOCK_COMP);

    // HISTORY proof: the project's version timeline shows exactly one row —
    // v1, born from the agent apply (the D-6 save reason's label), Current.
    await page.goto(`/w/${slug}/history`);
    const rows = page.getByTestId("version-row");
    await expect(rows).toHaveCount(1, { timeout: 20_000 });
    await expect(rows.first().getByTestId("version-number")).toHaveText("v1");
    await expect(rows.first().getByTestId("version-label")).toHaveText("Agent apply");
    await expect(rows.first().getByTestId("version-current-badge")).toBeVisible();
  });
});
