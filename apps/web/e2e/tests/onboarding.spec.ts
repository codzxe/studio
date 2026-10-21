// W10-L — §21 E2E row, the user journey half:
//   "Sign-up → invite → upload → prompt → stream → preview → undo → chat edit
//    → export" (billing in Stripe test mode → billing-testmode.spec.ts).
//
// MOCK-MODE CONTRACT (requirement — e2e/README.md §Contract): the compose
// "local" profile runs the gateway with MockEngineAdapter (engine →
// apps/mock-engine: protocol-faithful NDJSON, doc.render = the same 8×8 gray
// PNG this suite uploads) and NoopStripe. While that profile is absent, every
// gateway-dependent hop SKIPS loudly (probeGateway) — never fails.
//
// SELECTORS ARE PLACEHOLDERS: `data-e2e="…"` hooks are the primary contract
// (e2e/README.md §Selectors); the fallbacks are resilient generic selectors.
// §21 "invite" hop is DEFERRED — it needs a gateway-minted invite token; see
// README §Deferred.
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { pngUpload } from "../fixtures/png";
import { signUpViaUi, testCreds } from "../helpers/auth";
import { GATEWAY_SKIP_REASON, probeGateway } from "../helpers/gateway";

// Top-level await: one probe per worker (workers=1), before skip evaluation.
const gateway = await probeGateway();

/** Shared serial-journey state (test.describe.serial guarantees the order). */
const state = {
  creds: testCreds(),
  workspaceName: `E2E Workspace ${randomUUID().slice(0, 6)}`,
  runPath: null as string | null,
};

test.describe("web-only smoke (no gateway required)", () => {
  // Assertable without a live gateway: the (auth) shell itself renders.
  test("sign-up form renders on /sign-up", async ({ page }) => {
    await page.goto("/sign-up");
    await expect(page.locator("input[type=email]").first()).toBeVisible();
    await expect(page.locator("input[type=password]").first()).toBeVisible();
    await expect(page.locator('button[type="submit"]').first()).toBeVisible();
  });
});

test.describe.serial("§21 user journey (mock mode)", () => {
  test.skip(!gateway.reachable, `${GATEWAY_SKIP_REASON} (${gateway.detail})`);

  // 1. Sign-up — needs the gateway: (auth) form posts to `POST /v1/auth/*`.
  test("sign-up: (auth) form lands in the (app) shell", async ({ page }) => {
    await signUpViaUi(page, state.creds);
    await expect(page).toHaveURL(/\/(dashboard|compose|assets|documents|runs|templates|settings)/);
  });

  // 2. Workspace create — needs the gateway (workspace mutation + session).
  test("workspace: create one from the dashboard", async ({ page }) => {
    await page.goto("/dashboard");
    const create = page
      .locator(
        '[data-e2e="workspace-create"], button:has-text("New workspace"), button:has-text("Create workspace")',
      )
      .first();
    await create.click();
    const nameInput = page
      .locator('[data-e2e="workspace-name-input"], input[placeholder*="workspace" i]')
      .first();
    await nameInput.fill(state.workspaceName);
    await page.keyboard.press("Enter");
    await expect(page.getByText(state.workspaceName).first()).toBeVisible({ timeout: 15_000 });
  });

  // 3. Upload — the synthetic PNG fixture is generated in-test (fixtures/png).
  test("assets: upload a synthetic PNG", async ({ page }) => {
    await page.goto("/assets");
    const file = page.locator('input[type="file"]').first();
    await file.setInputFiles(pngUpload());
    // PLACEHOLDER row assertion — UI owner: data-e2e="asset-row".
    await expect(
      page.locator('[data-e2e="asset-row"], [data-e2e="asset-card"], img[alt*="asset" i]').first(),
    ).toBeVisible({ timeout: 30_000 });
  });

  // 4. Prompt — compose page starts a run (gateway queues the agent run).
  test("compose: a prompt starts a run", async ({ page }) => {
    await page.goto("/compose");
    const brief = page.locator('[data-e2e="prompt-input"], textarea').first();
    await brief.fill(
      "A cozy cafe poster: headline 'Fresh Roast', a subhead about single-origin " +
        "beans, one placed photo of a cup, brand colours terracotta and cream.",
    );
    await page.locator('[data-e2e="prompt-submit"], button[type="submit"]').first().click();
    // The run either navigates to /runs/:id or mounts the timeline inline.
    try {
      await page.waitForURL(/\/runs\//, { timeout: 10_000 });
      state.runPath = new URL(page.url()).pathname;
    } catch {
      state.runPath = null; // inline timeline on /compose — assert rows next.
    }
  });

  // 5. Stream — the timeline consumes the gateway SSE (text/event-stream);
  //    E2E asserts DOM rows, not the socket. MockEngineAdapter resolves steps
  //    instantly, so ≥2 rows must land fast; the ONLY acceptable alternative
  //    is the UI's documented graceful-offline state (skip, not fail).
  test("run: timeline streams ≥2 step rows (SSE) or shows a graceful offline state", async ({
    page,
  }) => {
    if (state.runPath) await page.goto(state.runPath);
    const steps = page.locator('[data-e2e^="run-step"]');
    const gotFirst = await steps
      .first()
      .waitFor({ timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    if (!gotFirst) {
      const offline = page
        .locator('[data-e2e="run-offline"], [data-e2e="timeline-offline"]')
        .or(page.getByText(/offline|reconnect|lost connection/i))
        .first();
      const offlineVisible = await offline.isVisible().catch(() => false);
      test.skip(
        offlineVisible,
        "run timeline shows a graceful offline state — gateway SSE not streaming " +
          "(see apps/web/e2e/README.md §Assertable)",
      );
      throw new Error(
        "run timeline neither streamed ≥2 step rows nor showed a graceful " +
          "offline state — add data-e2e='run-step' rows per apps/web/e2e/README.md §Selectors",
      );
    }
    const rows = await steps.count();
    expect(rows).toBeGreaterThanOrEqual(2);
  });

  // 6. Preview — mock-mode doc.render streams the 8×8 gray PNG; the <img>
  //    must actually decode (naturalWidth > 0), not merely exist.
  test("run: preview image renders", async ({ page }) => {
    if (state.runPath) await page.goto(state.runPath);
    const preview = page
      .locator('img[data-e2e="preview"], img[alt*="preview" i], img[alt*="render" i]')
      .first();
    await expect(preview).toBeVisible({ timeout: 60_000 });
    const naturalWidth = await preview.evaluate((el) => (el as HTMLImageElement).naturalWidth);
    expect(naturalWidth).toBeGreaterThan(0);
  });

  // 7. Undo — §20 #7: one undo reverts the whole run; E2E asserts the toast.
  test("run: undo shows a toast", async ({ page }) => {
    if (state.runPath) await page.goto(state.runPath);
    await page.getByRole("button", { name: /undo/i }).first().click();
    await expect(
      page
        .locator('[data-e2e="toast"], [role="status"], [role="alert"]')
        .filter({ hasText: /undo/i })
        .first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  // 8. Chat edit — §20 #8 quick-edit tier. The ≤2-changed-layers diff is
  //    asserted by unit/integration layers; E2E proves the flow completes.
  test("run: chat-edit quick flow answers", async ({ page }) => {
    if (state.runPath) await page.goto(state.runPath);
    const chat = page
      .locator(
        '[data-e2e="chat-input"], input[placeholder*="chat" i], input[placeholder*="ask" i], textarea',
      )
      .last();
    await chat.fill("make the subhead smaller");
    await chat.press("Enter");
    // PLACEHOLDER: a quick-tier reply lands as a step/row or chat bubble.
    await expect(
      page
        .locator('[data-e2e^="run-step"], [data-e2e="chat-reply"], [data-e2e="quick-edit"]')
        .first(),
    ).toBeVisible({ timeout: 60_000 });
  });

  // 9. Export — §20 #9 (PNG + .pcraft hash-verified replay) is an integration
  //    concern; E2E asserts the export dialog opens per the §21 row.
  test("run: export dialog opens", async ({ page }) => {
    if (state.runPath) await page.goto(state.runPath);
    await page.getByRole("button", { name: /export|download/i }).first().click();
    const dialog = page.locator('[role="dialog"], [data-e2e="export-dialog"]').first();
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByText(/png|\.pcraft/i).first()).toBeVisible();
  });
});
