/**
 * M12 turn loop — the ROUND-10 "stuck in loop" KILLER regression (the
 * round-12 design doc's P0: research/round12-design.md "The production
 * 'stuck in loop' (ROOT-CAUSED, must die)").
 *
 * THE BUG (round 10): the agent loop executed INSIDE the SSE request on a
 * serverless function; the event log was a per-isolate in-memory Map. A real
 * multi-tool run exceeded the platform's 60s hard-kill → the client re-POSTed
 * the same idempotency key → the in-memory log was gone → replay MISS → the
 * gateway started a DUPLICATE run (duplicate user message, duplicate credit
 * reserve, leaked hold, zombie `running` row) → the client dropped the
 * foreign run's events → no terminal → RUN_PAUSED → Retry → another
 * duplicate → infinite loop. On RELOAD the thread surfaced as still
 * "running" with no way forward.
 *
 * THE KILL (round 12): the loop moved to the BROWSER
 * (apps/web/src/lib/chat/chat-controller.ts) and every gateway request is
 * ONE bounded turn (POST /v1/threads/:id/turn) with durable per-turn
 * persistence (assistant text + steps rows + the plan POST's plan_json) and
 * per-turn credit reserve/commit. There is NO server-side run state to
 * resuscitate: a page reload is just HISTORY (GET /v1/threads/:id/messages
 * + GET /v1/runs/:id — useThreadHistory's auto-adopt of the newest thread),
 * never a re-POST, never a duplicate run, never a zombie chip.
 *
 * THIS SPEC pins the kill property end-to-end against the REAL app (real
 * gateway in MOCK_MODEL=true mode — zero keys, deterministic two-turn mock
 * journey; see e2e/chat.spec.ts for the journey's shape):
 *   1. drive the mock run to completion (plan card auto-applied, phase done);
 *   2. RELOAD the page (the exact round-10 bug trigger);
 *   3. the thread history renders — the user text + the assistant's final
 *      text come back from the persisted rows;
 *   4. NO zombie "running" state: the phase reads idle, the live progress
 *      strip is gone and the streaming pill dot never mounts;
 *   5. the reloaded plan card is READ-ONLY (the M4 shape — a reloaded page
 *      must never resurrect an actionable plan);
 *   6. the wire stayed SILENT: zero POST /v1/threads/:id/turn after the
 *      reload (a passive counter — no network fakes, the real routes answer).
 *
 * NEVER RUN ON THE BUILD-FLEET BOX — same class of debt as e2e/chat.spec.ts
 * (no browsers, no dev servers; `@playwright/test` is CI-owned — see
 * e2e/README.md for the boot recipe). Every selector verified against the
 * landed surfaces; helpers duplicated per the gateway-tests precedent (e2e
 * specs never import sibling spec files).
 *
 * NOTE (same dependency as the M5 specs): the applied-state wait pins the
 * INTENDED auto-apply journey; it stays RED until the lead lands the plan
 * route's run-status write (routes/apply.ts `applyable()` still requires
 * awaiting_approval/completed while the round-12 plan route never
 * transitions the run out of "running" — see m5-agent-edits.spec.ts's
 * header note). The RELOAD assertions themselves are independent of it.
 */

import { type Page, expect, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Seeded world (packages/db/scripts/seed.ts — e2e/README.md §Seed)
// ---------------------------------------------------------------------------

/** The seed's demo login (dev fixture credentials, never production). */
const SEEDED_EMAIL = "demo@studio.test";
const SEEDED_PASSWORD = "demo-password-12345";

/** `/w/[slug]/editor` for the seeded project (slug "demo-project"). */
const SEEDED_EDITOR_PATH = "/w/demo-project/editor";

/** Wasm boot + manifest → project download → file.open + the chat bridge. */
const EDITOR_OPEN_TIMEOUT_MS = 120_000;
/** Second bridge attach (chat layer) after the editor reports `open`. */
const CHAT_MOUNT_TIMEOUT_MS = 30_000;
/** Two mock turns + the plan POST — a generous upper bound for the run. */
const RUN_SETTLE_TIMEOUT_MS = 30_000;
/** The auto-apply drive: ONE atomic engine.batch + upload + applyRun. */
const APPLY_SETTLE_TIMEOUT_MS = 30_000;
/** History adopt + GET /v1/threads/:id/messages + GET /v1/runs/:id rows. */
const HISTORY_SETTLE_TIMEOUT_MS = 30_000;

/** The mock's closing text (routes/turn.ts `mockTurn`, turn 1). */
const MOCK_CLOSING_TEXT = "Done — I created the Agent Demo composition with a text layer.";

// ---------------------------------------------------------------------------
// Helpers (the M4/M5 recipe — real /sign-in → the seeded editor)
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
  // Run-3 hardening (chat.spec.ts carries the full post-mortem): gate the
  // fill+submit on live React handlers; the outer retry absorbs the
  // gateway's ~8s cold boot.
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
  await expect(page.getByTestId("chat-layer")).toBeVisible({ timeout: CHAT_MOUNT_TIMEOUT_MS });
  await expect(page.getByTestId("chat-header")).toBeVisible();
}

// ---------------------------------------------------------------------------
// The loop-kill journey
// ---------------------------------------------------------------------------

test.describe("M12 turn loop — reload is history, never a zombie run", () => {
  test.beforeEach(async ({ page }) => {
    // Cold wasm boot (120s) + the journey's settle waits.
    test.setTimeout(360_000);
    await openSeededEditor(page);
  });

  test("after the mock run completes, a page reload restores the transcript with NO running state and NO turn re-POST", async ({
    page,
  }) => {
    // --- 1. Drive the REAL two-turn mock journey to completion ----------------
    const composer = page.getByLabel("Message the agent");
    await composer.click();
    await composer.fill("Set up a demo composition with a text layer");
    await composer.press("Enter");

    const plan = page.getByTestId("plan-card");
    await expect(plan).toBeVisible({ timeout: RUN_SETTLE_TIMEOUT_MS });
    // See the header note: RED until the plan route marks the run row.
    await expect(plan).toHaveAttribute("data-status", "applied", {
      timeout: APPLY_SETTLE_TIMEOUT_MS,
    });
    await expect(page.getByTestId("chat-status")).toHaveAttribute("data-phase", "done", {
      timeout: RUN_SETTLE_TIMEOUT_MS,
    });

    // --- 2. The reload — the EXACT round-10 bug trigger -----------------------
    // Passive wire counter (installed AFTER the run, BEFORE the reload):
    // the client-driven loop must stay SILENT across a reload — no
    // idempotent re-POST can exist because nothing server-side owns the
    // loop anymore. It records and continues; the REAL routes answer.
    let turnPostsAfterReload = 0;
    await page.route("**/v1/threads/*/turn", async (route) => {
      if (route.request().method() === "POST") turnPostsAfterReload += 1;
      await route.continue();
    });

    await page.reload();

    // --- 3. The editor + chat reboot from the fixture, nothing resurrects ----
    await expect(page.getByTestId("editor-host")).toHaveAttribute("data-editor-phase", "open", {
      timeout: EDITOR_OPEN_TIMEOUT_MS,
    });
    await expect(page.getByTestId("chat-layer")).toBeVisible({ timeout: CHAT_MOUNT_TIMEOUT_MS });

    // --- 4. HISTORY renders from the persisted rows (auto-adopt of the
    // newest thread; GET /v1/threads/:id/messages — useThreadHistory): the
    // user text AND the mock's closing assistant text both come back.
    const thread = page.getByTestId("chat-thread-list");
    await expect(thread).toContainText("Set up a demo composition with a text layer", {
      timeout: HISTORY_SETTLE_TIMEOUT_MS,
    });
    await expect(thread).toContainText(MOCK_CLOSING_TEXT, {
      timeout: HISTORY_SETTLE_TIMEOUT_MS,
    });

    // --- 5. NO zombie "running" chip: the phase is IDLE (no live run), the
    // progress strip never mounts outside live phases, and the collapsed
    // pill's streaming dot is absent (pill.tsx).
    await expect(page.getByTestId("chat-status")).toHaveAttribute("data-phase", "idle");
    await expect(page.getByTestId("chat-progress-strip")).toHaveCount(0);
    await expect(page.getByTestId("chat-pill-streaming-dot")).toHaveCount(0);

    // --- 6. The reloaded plan card is READ-ONLY (the M4 shape, from the run's
    // plan_json): proposed display, ZERO action buttons — a reloaded page
    // must never resurrect an actionable plan (useThreadHistory's pinned
    // guard).
    const reloadedCard = page.getByTestId("plan-card");
    await expect(reloadedCard).toBeVisible({ timeout: HISTORY_SETTLE_TIMEOUT_MS });
    await expect(reloadedCard).toHaveAttribute("data-status", "proposed");
    await expect(reloadedCard).toHaveAttribute("data-applied", "false");
    await expect(reloadedCard.getByTestId("plan-apply")).toHaveCount(0);
    await expect(reloadedCard.getByTestId("plan-cancel")).toHaveCount(0);
    await expect(reloadedCard.getByTestId("plan-undo")).toHaveCount(0);

    // --- 7. The wire stayed silent: the loop-kill property itself. -----------
    expect(turnPostsAfterReload).toBe(0);
  });
});
