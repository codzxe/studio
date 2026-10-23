/**
 * M4 chat loop — the CI-owned Playwright E2E (BUILD_PLAN §M4 task 7:
 * "open editor → ask 'what's on this comp?' → receive a correct summary").
 *
 * NEVER RUN ON THE BUILD-FLEET BOX: this spec needs a real browser, the real
 * editor wasm dist and a live gateway — it is written for the CI big box
 * (docs/phases/M3.md "Known tails" #1; this file is the M4 half of that
 * Playwright debt). This box has no browsers and no dev servers, so
 * `@playwright/test` is NOT installed here: apps/web/tsconfig.json excludes
 * `e2e` and `playwright.config.ts` from typecheck for exactly that reason,
 * and CI owns the devDependency + lockfile sync (see e2e/README.md for the
 * full boot recipe — env, seed, project fixture, snapshots policy).
 *
 * Every selector below was verified against the landed wave-2 surfaces
 * (components/chat/*, components/editor-host/*) — see e2e/README.md for the
 * per-testid source map. The mock answer text is asserted verbatim from
 * services/gateway/src/runner.ts `createMockRunner` (MOCK_MODEL=true): the
 * runner streams two message deltas, an informational EditPlan and one
 * studio.get_context tool call whose result carries the mock comp payload.
 *
 * Auth note (documented deviation from the brief's "sign-up primary"): a
 * freshly signed-up user owns NO workspace and NO project in this product —
 * the seed (packages/db/scripts/seed.ts) creates the demo user's workspace
 * and project rows explicitly, so the UI path to the SEEDED editor is the
 * real /sign-in form as the seeded demo user. The sign-up-flow variant (for
 * suites that onboard their own workspace) and the raw session-cookie
 * variant are both documented in e2e/README.md.
 */

import { type Page, expect, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Seeded world (packages/db/scripts/seed.ts — see e2e/README.md §Seed)
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
/** The gateway's TOOL_RESULT_TIMEOUT_MS — a generous upper bound for runs. */
const RUN_SETTLE_TIMEOUT_MS = 30_000;

/** ~token estimate label shape from apps/web/src/lib/chat/tokens.ts. */
const TOKEN_ESTIMATE_RE = /~\d+(\.\d+)?k? tokens/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sign the seeded demo user in through the REAL /sign-in form (better-auth
 * email+password → session cookie) and land on the seeded project's editor
 * with the chat overlay mounted (the panel defaults to floating mode).
 */
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
  // Run-3 hardening (full post-mortem in m5-agent-edits.spec.ts): a
  // cold-boot fill+click can beat React hydration — the form then submits
  // natively as a no-op GET (no `name` attributes) and no auth POST fires.
  // The canary gates fill+submit on live React handlers; the outer retry
  // also absorbs a gateway still in its ~8s cold boot (first submit 502s
  // through the edge as an inline form error).
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

  // The editor boots the real wasm dist and opens the seeded project's file
  // (fixture bytes staged by the boot recipe — README §Project fixture).
  await expect(page.getByTestId("editor-host")).toHaveAttribute("data-editor-phase", "open", {
    timeout: EDITOR_OPEN_TIMEOUT_MS,
  });

  // The chat layer mounts once the editor's second bridge attaches (M4-J);
  // a fresh browser profile has no persisted layout → floating by default.
  await expect(page.getByTestId("editor-iframe")).toBeVisible();
  await expect(page.getByTestId("chat-layer")).toBeVisible({ timeout: CHAT_MOUNT_TIMEOUT_MS });
  await expect(page.getByTestId("chat-header")).toBeVisible();
}

// ---------------------------------------------------------------------------
// The M4 chat loop, read-only agent (BUILD_PLAN §M4 task 7)
// ---------------------------------------------------------------------------

test.describe("M4 chat — read-only agent", () => {
  test.beforeEach(async ({ page }) => {
    // The default 30s test timeout cannot cover a cold wasm editor boot
    // (EDITOR_OPEN_TIMEOUT_MS is 120s) plus the run-settle waits.
    test.setTimeout(300_000);
    await openSeededEditor(page);
  });

  test("editor loads and chat opens", async ({ page }) => {
    // The editor itself is the M3 surface; the chat is additive over it (D-18).
    await expect(page.getByTestId("editor-viewport")).toBeVisible();
    await expect(page.getByTestId("chat-slot")).toHaveAttribute("data-chat-mode", "floating");
    await expect(page.getByTestId("chat-header")).toBeVisible();

    // D-5: the chat shortcuts originate INSIDE the editor — focus the iframe
    // first, then Cmd/Ctrl+L cycles floating → sidebar (the editor keeps its
    // own shortcuts; only L/K/I forward through the same-origin listener).
    await page.getByTestId("editor-iframe").click();
    await page.keyboard.press("ControlOrMeta+l");
    await expect(page.getByTestId("chat-slot")).toHaveAttribute("data-chat-mode", "sidebar");
    await expect(page.getByTestId("chat-header")).toBeVisible();

    // …and sidebar → collapsed, where the pill takes over.
    await page.keyboard.press("ControlOrMeta+l");
    await expect(page.getByTestId("chat-slot")).toHaveAttribute("data-chat-mode", "collapsed");
    await expect(page.getByTestId("chat-collapsed-pill")).toBeVisible();
    await expect(page.getByTestId("chat-panel")).toHaveCount(0);

    // The collapsed pill is the documented way back in (§2 collapse).
    await page.getByTestId("chat-collapsed-pill").click();
    await expect(page.getByTestId("chat-slot")).toHaveAttribute("data-chat-mode", "floating");
    await expect(page.getByTestId("chat-header")).toBeVisible();
  });

  test("ask what's on this comp → read-only agent answers with the comp summary", async ({
    page,
  }) => {
    const composer = page.getByLabel("Message the agent");
    await expect(page.getByTestId("chat-empty-state")).toBeVisible();

    await composer.click();
    await composer.fill("What's on this comp?");
    await composer.press("Enter");

    // The user message renders immediately (steer-echo) and the empty state goes.
    await expect(page.getByTestId("chat-thread-list")).toContainText("What's on this comp?", {
      timeout: RUN_SETTLE_TIMEOUT_MS,
    });
    await expect(page.getByTestId("chat-empty-state")).toHaveCount(0);

    // The mock runner makes exactly one client tool call: studio.get_context.
    const toolCard = page.locator('[data-testid="tool-card"][data-tool="studio.get_context"]');
    await expect(toolCard).toHaveCount(1, { timeout: RUN_SETTLE_TIMEOUT_MS });
    await expect(toolCard).toHaveAttribute("data-status", "done", {
      timeout: RUN_SETTLE_TIMEOUT_MS,
    });

    // The assistant answer is the MOCK runner's stream, asserted verbatim
    // (services/gateway/src/runner.ts createMockRunner — the two deltas).
    const answer = page.locator('[data-testid="chat-message"][data-role="assistant"]');
    await expect(answer).toContainText(
      "I'll rename that layer for you — it's a one-property change.",
      { timeout: RUN_SETTLE_TIMEOUT_MS },
    );
    await expect(answer).toContainText("Planning a single atomic batch so undo stays one step.");
    await expect(page.getByTestId("chat-status")).toHaveAttribute("data-phase", "done", {
      timeout: RUN_SETTLE_TIMEOUT_MS,
    });

    // The mock's EditPlan renders as the M5 plan card (M5-G rewrite): a
    // status machine whose read-only mount (message.tsx passes no callbacks)
    // shows the "proposed" state with no action controls. The M4
    // "Apply arrives with M5" note is GONE (apply is real now), and the
    // steps disclosure is a BUTTON (plan-steps-toggle) — so the no-button
    // pin targets the ACTION row, not the whole card.
    const plan = page.getByTestId("plan-card");
    await expect(plan).toBeVisible();
    await expect(plan).toHaveAttribute("data-status", "proposed");
    await expect(plan).toHaveAttribute("data-applied", "false");
    await expect(plan).toContainText("Rename the selected layer");
    await expect(page.getByTestId("plan-note")).toHaveCount(0);

    // Read-only proof (M4.6, restated for M5): the card's one button is the
    // steps disclosure; the ACTION row holds ZERO buttons and no Apply
    // button exists anywhere in the page (apply/undo arrive with the M5
    // thread wiring — see e2e/m5-agent-edits.spec.ts for the journey spec).
    await expect(plan.getByTestId("plan-steps-toggle")).toBeVisible();
    await expect(plan.getByTestId("plan-actions").getByRole("button")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /apply/i })).toHaveCount(0);

    // Expanding the tool card shows the mock's context payload — the comp the
    // question was about ("Main": the seeded project's single composition).
    await toolCard.getByTestId("tool-card-toggle").click();
    await expect(toolCard.getByTestId("tool-card-details")).toBeVisible();
    await expect(toolCard.getByTestId("tool-card-result")).toContainText("Main");
  });

  test("context chips reflect what is sent", async ({ page }) => {
    // DEFAULT_FLAGS (§5.1) with no selection → exactly four context blocks:
    // project summary, active comp, playhead, focused panel.
    const contextButton = page.getByTestId("chat-context-button");
    await expect(contextButton).toHaveText(/^Context 4$/);

    await contextButton.click();
    const popover = page.getByTestId("context-popover");
    await expect(popover).toBeVisible();

    // §5.3: one row per block — label + ~token estimate (never raw data).
    const compRow = page.getByTestId("context-row-activeComp");
    await expect(compRow).toContainText("Comp: Main");
    await expect(compRow).toContainText(TOKEN_ESTIMATE_RE);

    const playheadRow = page.getByTestId("context-row-playhead");
    await expect(playheadRow).toContainText(/Playhead \d{2}:\d{2}\.\d/);
    await expect(playheadRow).toContainText(TOKEN_ESTIMATE_RE);

    await expect(page.getByTestId("context-row-projectSummary")).toContainText("Project summary");
    await expect(page.getByTestId("context-row-focusedPanel")).toContainText(TOKEN_ESTIMATE_RE);

    // Everything is on by default (the parent passes active blocks only).
    await expect(page.getByTestId("context-toggle-activeComp")).toBeChecked();
    await expect(page.getByTestId("context-toggle-playhead")).toBeChecked();

    // The total line carries the summed estimate; Done closes the popover.
    await expect(page.getByTestId("context-total")).toContainText(/tokens total$/);
    await page.getByTestId("context-done").click();
    await expect(popover).toHaveCount(0);
  });

  test("model picker respects the plan", async ({ page }) => {
    // The workspace is on the trial plan → exactly [studio-fast] (Seam 1).
    // models=null renders a disabled trigger, so toBeEnabled() is also the
    // "the /v1/models call resolved" wait.
    const modelButton = page.getByTestId("chat-model-button");
    await expect(modelButton).toBeEnabled();
    await expect(modelButton).toContainText("Fast");

    await modelButton.click();
    const picker = page.getByTestId("chat-model-popover");
    await expect(picker).toBeVisible();

    // Single-model plan: one locked, selected row — a div, never a button —
    // plus the plan note (components/chat/model-picker.tsx).
    await expect(picker.locator('[data-testid^="chat-model-option-"]')).toHaveCount(1);
    const option = page.getByTestId("chat-model-option-studio-fast");
    await expect(option).toHaveAttribute("data-locked", "true");
    await expect(option).toHaveAttribute("data-active", "true");
    await expect(page.getByTestId("chat-model-locked-note")).toContainText(
      "Your plan includes this model",
    );
    await expect(picker.getByRole("button")).toHaveCount(0);

    // Esc closes the popover without touching the panel (§9 popovers-first).
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
  });

  test("stop cancels a streaming run", async () => {
    // The MOCK_MODEL runner emits the entire run with only `yieldToStream()`
    // (setImmediate) between events — the whole stream completes in a few
    // milliseconds, so the Send→Stop transition (the composer shows Stop
    // while a run is live) is unreachable from a real browser: any attempt
    // to catch it would be a flake by construction, and a cancelled mock run
    // asserts nothing about the real cancel path that the gateway suite
    // (services/gateway/tests) doesn't already prove deterministically.
    //
    // Unskip when the gateway grows a mock pacing knob (e.g.
    // MOCK_STREAM_DELAY_MS) or point a local run at a real LiteLLM model —
    // then: send → expect chat-composer-send aria-label "Stop streaming" →
    // click it → expect the run to end cancelled (chat-status data-phase).
    test.skip(true, "MOCK_MODEL completes instantly — the streaming window is not observable");
  });

  test("editor UI unchanged by the chat overlay", async ({ page }) => {
    // BUILD_PLAN §M3 "editor screenshot equals upstream (allowing only the
    // floating project bar/chat)" — the D-18 overlay proof. Both states get
    // their own baseline (chat chrome masked); any editor-pixel change in
    // either state fails the suite. First CI run: --update-snapshots (README
    // §Snapshots). Mouse parked mid-canvas, away from the auto-hide project
    // bar and both chat surfaces, so hover chrome never enters a shot.
    const shotOptions = {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.01,
      mask: [page.getByTestId("chat-panel-layer"), page.getByTestId("chat-collapsed-layer")],
    };

    // BEFORE opening the chat: collapsed to the pill (default is floating).
    await page.getByTestId("chat-close-button").click();
    await expect(page.getByTestId("chat-collapsed-pill")).toBeVisible();
    await page.mouse.move(320, 400);
    await expect(page).toHaveScreenshot("editor-unchanged-chat-collapsed.png", shotOptions);

    // AFTER: the floating panel is back over the same editor pixels.
    await page.getByTestId("chat-collapsed-pill").click();
    await expect(page.getByTestId("chat-header")).toBeVisible();
    await page.mouse.move(320, 400);
    await expect(page).toHaveScreenshot("editor-unchanged-chat-open.png", shotOptions);
  });
});
