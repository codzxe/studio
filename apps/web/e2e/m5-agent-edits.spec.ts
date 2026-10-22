/**
 * M5 agent edits — the CI-owned Playwright journey (BUILD_PLAN §M5 task 8:
 * "prompt → plan → preview → apply → undo → redo") over the REAL editor, the
 * REAL chat overlay and the REAL plan card (components/chat/plan-card.tsx,
 * M5-G) + ChatConfirmDialog (confirm-dialog.tsx).
 *
 * NEVER RUN ON THE BUILD-FLEET BOX — same class of debt as e2e/chat.spec.ts
 * (M3/M4 precedent, docs/phases/M3.md "Known tails"): this box has no
 * browsers and no dev servers, so `@playwright/test` is NOT installed here.
 * apps/web/tsconfig.json excludes `e2e` from typecheck for exactly that
 * reason and the web vitest config never matches `e2e/*.spec.ts`; CI owns
 * the devDependency, the lockfile and the run (e2e/README.md is the boot
 * recipe — env, seed, the staged `.ecproj` fixture, baselines).
 *
 * ----------------------------------------------------------------------------
 * What is ACTIVE today vs WIRING-PENDING (fixme) — the honest split
 * ----------------------------------------------------------------------------
 *
 * The M5 wave-1 surfaces are all landed (M5-J command registry, M5-A/B write
 * tools + plan compiler, M5-C wire plan event with compiledBatch, M5-D/E
 * persistence + routes, M5-F ApplyController + planRuntime state machine,
 * M5-G plan card + confirm dialog, M5-H PlanPreview). ONE integrator-owned
 * link is still open — M5-G's follow-up #1: `message.tsx` still mounts the
 * M4 card shape (`<PlanCard plan={…} applied={false} />`), i.e. WITHOUT the
 * apply/undo callbacks, so the real thread renders the card's "proposed"
 * state with no action row. The runtime it will consume is already in state
 * (`ChatUiMessage.planRuntime`, `chat.plan.*` gestures, `applicablePlanOf` —
 * lib/chat/run-state.ts).
 *
 * This spec therefore proves, against the LIVE app:
 *   1. (ACTIVE) the mock model's plan renders the FULL M5 card in the real
 *      thread — status/risk/steps/credits/affected-layers/disclosure, no
 *      preview slot (M5-H is not thread-mounted yet — asserted absent), no
 *      M4 "Apply arrives with M5" note, and ZERO action buttons (the M4.6
 *      read-only property restated for M5: no host callbacks ⇒ no apply
 *      control, stream or not);
 *   2. (ACTIVE) a scripted high-risk plan event (route-intercepted SSE —
 *      the mock model only ever emits a low-risk plan) renders the danger
 *      chrome and STILL cannot arm an apply control — the confirm checkbox
 *      exists only in host wiring, so no stream can conjure an ungated
 *      Apply (BUILD_PLAN §M5 exit criterion "high-risk actions always
 *      require confirmation" — the gate is structural, not data-driven);
 *   3. (fixme, WIRING-PENDING) the full journey: checkbox gate → confirm
 *      dialog → Apply → applied (one undo step) → Undo → undone →
 *      Re-apply blocked (drifted, per the fixture's version head) → editor
 *      chrome unchanged outside the canvas area. Written as real code
 *      against the real testids; flip `test.fixme` → `test` when the
 *      thread layer passes the callbacks (see the test's header note);
 *   4. (ACTIVE) the editor is visually unchanged by the read-only M5 chat
 *      journey (the M4 editor-unchanged mask approach — chat chrome masked,
 *      own baseline).
 *
 * ----------------------------------------------------------------------------
 * Determinism contract (no real network, no real model)
 * ----------------------------------------------------------------------------
 *
 * - Boot: the README recipe (seeded demo user → real /sign-in → real editor
 *   wasm opening the staged `.ecproj` fixture → chat overlay) with the
 *   gateway in MOCK_MODEL=true mode. The mock runner's answer is asserted
 *   from services/gateway/src/runner.ts `createMockRunner`/`mockEditPlan`
 *   (plan: low risk, intent "edit", summary "Rename the selected layer",
 *   ONE step "Rename layer"/studio.set_properties, affected layer
 *   "Headline"/"Rename to Subtitle", estimatedCredits = estimateCredits(1
 *   low step) = (1 + 0.5) × 1 = 1.5 → the card renders "≈ 1.5 credits").
 * - High-risk variant: the spec installs its OWN scripted gateway leg —
 *   `page.route` on the chat run POST (`…/v1/threads/<id>/chat`) fulfills it with
 *   byte-exact §7.4 frames (`id: <seq>\ndata: <json>\n\n`, gateway
 *   sseFrame format) that parse against STUDIO_STREAM_EVENT_SCHEMA: the
 *   client's real reader/reducer/thread fold them like any server stream.
 *   The scripted batch uses REAL curated command ids (layer.setBlendMode —
 *   packages/contracts command-registry) and the pinned $request resolution
 *   placeholder, mirroring what the real plan compiler (M5-B) emits.
 *
 * ----------------------------------------------------------------------------
 * testid map driven by this spec (drift detector — every id verified against
 * the source when written)
 * ----------------------------------------------------------------------------
 *
 *   plan-card            (+ data-status, data-applied, data-risk,
 *                         data-intent, data-requires-approval)  plan-card.tsx
 *   plan-risk, plan-intent, plan-requires-confirmation          plan-card.tsx
 *   plan-steps-toggle (BUTTON, aria-expanded), plan-steps       plan-card.tsx
 *   plan-affected, plan-credits                                 plan-card.tsx
 *   plan-preview (slot — absent until thread-mounted), plan-note (gone)
 *   plan-actions, plan-confirm, plan-confirm-checkbox,         plan-card.tsx
 *   plan-apply, plan-cancel
 *   plan-applying, plan-applied, plan-undo, plan-undone,         plan-card.tsx
 *   plan-reapply, plan-reapply-blocked
 *   chat-confirm-dialog, chat-confirm-title,                   confirm-dialog.tsx
 *   chat-confirm-cancel, chat-confirm-confirm
 *   editor-host (+ data-editor-phase), editor-iframe,           editor-host.tsx
 *   editor-viewport, chat-layer
 *   chat-header, chat-status (+ data-phase)                     header.tsx
 *   chat-thread-list, chat-composer (aria-label "Message the agent"),
 *   chat-panel-layer, chat-collapsed-layer                      chat-panel-slot.tsx
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
/** The gateway's TOOL_RESULT_TIMEOUT_MS — a generous upper bound for runs. */
const RUN_SETTLE_TIMEOUT_MS = 30_000;
/** ONE atomic engine.batch + version upload + applyRun report (M5-F). */
const APPLY_SETTLE_TIMEOUT_MS = 30_000;

/**
 * The scripted run's id (any nonempty string binds the client's stream
 * normalizer; kept stable across the fixture's frames).
 */
const SCRIPTED_RUN_ID = "run_m5_e2e_high_risk";

// ---------------------------------------------------------------------------
// Helpers — boot + the scripted-gateway leg
// ---------------------------------------------------------------------------

/**
 * Sign the seeded demo user in through the REAL /sign-in form (better-auth
 * email+password → session cookie) and land on the seeded project's editor
 * with the chat overlay mounted (identical to e2e/chat.spec.ts — the M4
 * recipe's `?next=` round-trip).
 */
async function openSeededEditor(page: Page): Promise<void> {
  await page.goto(`/sign-in?next=${encodeURIComponent(SEEDED_EDITOR_PATH)}`);
  await page.locator("#sign-in-email").fill(SEEDED_EMAIL);
  await page.locator("#sign-in-password").fill(SEEDED_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(`**${SEEDED_EDITOR_PATH}`);

  await expect(page.getByTestId("editor-host")).toHaveAttribute("data-editor-phase", "open", {
    timeout: EDITOR_OPEN_TIMEOUT_MS,
  });
  await expect(page.getByTestId("editor-iframe")).toBeVisible();
  await expect(page.getByTestId("chat-layer")).toBeVisible({ timeout: CHAT_MOUNT_TIMEOUT_MS });
  await expect(page.getByTestId("chat-header")).toBeVisible();
}

/**
 * One §7.4 event → one SSE frame, byte-shaped like the gateway's `sseFrame`
 * (services/gateway/src/routes/chat.ts): `id: <seq>\ndata: <json>\n\n`.
 * The client parses WHATWG frames and validates each payload against
 * STUDIO_STREAM_EVENT_SCHEMA (packages/api-client/src/sse.ts) — so every
 * fixture payload below must be schema-exact.
 */
function sseFrames(events: ReadonlyArray<Record<string, unknown>>): string {
  return events
    .map((event) => `id: ${String(event.seq)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

/**
 * The scripted-gateway leg: intercept the chat run POST
 * (`POST /v1/threads/:id/chat`, same-origin through the dev edge) and
 * fulfill it with a complete, deterministic SSE body. The REAL client
 * reader/reducer/thread fold the frames exactly like a server stream; the
 * real gateway (auth, threads, models, ledger) serves everything else.
 */
async function installScriptedRun(
  page: Page,
  events: ReadonlyArray<Record<string, unknown>>,
): Promise<void> {
  await page.route("**/v1/threads/*/chat", async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
      },
      body: sseFrames(events),
    });
  });
}

// ---------------------------------------------------------------------------
// The scripted high-risk plan (§8.6 EDIT_PLAN_SCHEMA-exact; M5 wire shape)
// ---------------------------------------------------------------------------

/**
 * The plan-compiler output shape for a high-risk restyle (display plan +
 * the server-compiled batch). Every command id is REAL + curated
 * (packages/contracts command-registry: layer.setBlendMode `{layers?, mode?}`),
 * and the layer reference rides the pinned `$request:<id>` placeholder that
 * the client resolves BY NAME against the live comp (law #5: layer ids
 * never enter the model context; M5-F resolves via comp.info).
 *
 * estimatedCredits: estimateCredits({risk: "high", steps: [{}]}) =
 * (1 + 1×0.5) × 1.5 = 2.25 — the card displays the server value VERBATIM.
 */
const HIGH_RISK_PLAN: Record<string, unknown> = {
  intent: "style",
  summary: "Restyle the Background solid with a Multiply blend",
  risk: "high",
  requiresApproval: true,
  affectedLayers: [{ id: 1, name: "Background", change: "Blend mode Multiply" }],
  estimatedCredits: 2.25,
  steps: [
    {
      title: "Set the Background blend mode to Multiply",
      tool: "studio.set_properties",
      args: { layerName: "Background", property: "blendMode", value: "Multiply" },
      batch: {
        label: "Agent: blend Background",
        steps: [
          {
            command: "layer.setBlendMode",
            params: { layers: "$request:req_bg", mode: "Multiply" },
          },
        ],
      },
    },
  ],
};

/** The §8.5-compiled engine payload the client's ApplyController executes. */
const HIGH_RISK_COMPILED_BATCH: Record<string, unknown> = {
  label: "Agent: blend Background",
  atomic: true,
  steps: [
    { command: "layer.setBlendMode", params: { layers: "$request:req_bg", mode: "Multiply" } },
  ],
};

/**
 * The name→id bindings the client resolves before executing (§8.7). The
 * seeded fixture comp ("Main") has exactly ONE layer named "Background", so
 * the resolution is deterministic.
 */
const HIGH_RISK_RESOLUTIONS: ReadonlyArray<Record<string, unknown>> = [
  { requestId: "req_bg", layerName: "Background", disambiguation: [] },
];

/** The full scripted run: started → delta → high-risk plan → completed. */
function highRiskRunEvents(): ReadonlyArray<Record<string, unknown>> {
  return [
    { type: "run.started", runId: SCRIPTED_RUN_ID, seq: 1, model: "studio-fast" },
    {
      type: "message.delta",
      runId: SCRIPTED_RUN_ID,
      seq: 2,
      delta: "This restyle touches the comp background — planning it as high risk.",
    },
    {
      type: "plan",
      runId: SCRIPTED_RUN_ID,
      seq: 3,
      plan: HIGH_RISK_PLAN,
      compiledBatch: HIGH_RISK_COMPILED_BATCH,
      resolutionRequests: HIGH_RISK_RESOLUTIONS,
      risk: "high",
      estimatedCredits: 2.25,
    },
    { type: "run.completed", runId: SCRIPTED_RUN_ID, seq: 4 },
  ];
}

// ---------------------------------------------------------------------------
// The M5 agent-edits journey (BUILD_PLAN §M5 task 8)
// ---------------------------------------------------------------------------

test.describe("M5 agent edits — plan card journey", () => {
  test.beforeEach(async ({ page }) => {
    await openSeededEditor(page);
  });

  test("the mock model's plan renders the full M5 card in the real thread (proposed, risk, steps, credits, affected layers)", async ({
    page,
  }) => {
    // The MOCK_MODEL runner always streams the same script (runner.ts) —
    // deltas + an EditPlan + one studio.get_context call — whatever the
    // prompt says. A plan-flavored prompt keeps the scenario honest.
    const composer = page.getByLabel("Message the agent");
    await composer.click();
    await composer.fill("Rename the selected layer to Subtitle");
    await composer.press("Enter");

    await expect(page.getByTestId("chat-thread-list")).toContainText("Rename the selected layer", {
      timeout: RUN_SETTLE_TIMEOUT_MS,
    });

    // The card: the M5 status machine at rest (M5-G). Without thread
    // callbacks it is a read-only view of the plan event.
    const plan = page.getByTestId("plan-card");
    await expect(plan).toBeVisible({ timeout: RUN_SETTLE_TIMEOUT_MS });
    await expect(plan).toHaveAttribute("data-status", "proposed");
    await expect(plan).toHaveAttribute("data-applied", "false");
    await expect(plan).toHaveAttribute("data-risk", "low");
    await expect(plan).toHaveAttribute("data-intent", "edit");
    await expect(plan).toHaveAttribute("data-requires-approval", "false");

    // §6.2 surfaces: risk badge, intent badge, summary.
    await expect(page.getByTestId("plan-risk")).toHaveText("Low risk");
    await expect(page.getByTestId("plan-intent")).toHaveText("Edit");
    await expect(plan).toContainText("Rename the selected layer");

    // Steps: the disclosure is a BUTTON now (M5-G) — default expanded, one
    // step with its tool id, and it toggles the ordered list.
    const stepsToggle = plan.getByTestId("plan-steps-toggle");
    await expect(stepsToggle).toBeVisible();
    await expect(stepsToggle).toHaveAttribute("aria-expanded", "true");
    await expect(stepsToggle).toContainText("1 step");
    await expect(plan.getByTestId("plan-steps")).toBeVisible();
    await expect(plan.getByTestId("plan-steps")).toContainText("Rename layer");
    await expect(plan.getByTestId("plan-steps")).toContainText("studio.set_properties");
    await stepsToggle.click();
    await expect(stepsToggle).toHaveAttribute("aria-expanded", "false");
    await expect(plan.getByTestId("plan-steps")).toBeHidden();
    await stepsToggle.click();
    await expect(plan.getByTestId("plan-steps")).toBeVisible();

    // Affected layers + the server's credit estimate, VERBATIM (the card
    // never recomputes credits client-side).
    await expect(page.getByTestId("plan-affected")).toContainText("Headline");
    await expect(page.getByTestId("plan-affected")).toContainText("Rename to Subtitle");
    await expect(page.getByTestId("plan-credits")).toHaveText("≈ 1.5 credits");

    // The M5-H PlanPreview is NOT mounted by the thread layer yet (M5-G
    // follow-up #1): the preview slot renders only when the host passes it.
    // Assert the card renders WITHOUT it — flip to the before/after pane
    // assertions (plan-preview-panel/-frames) when the thread wires M5-H.
    await expect(page.getByTestId("plan-preview")).toHaveCount(0);

    // The M4 "Apply arrives with M5" note is GONE — apply is real (M5-G).
    await expect(page.getByTestId("plan-note")).toHaveCount(0);

    // Read-only proof (M4.6 restated for M5): the card mounts without
    // callbacks, so the action row holds ZERO buttons and no Apply control
    // exists anywhere in the page. (The steps disclosure is a button — the
    // M4 whole-card button-count pin no longer holds.)
    await expect(plan.getByTestId("plan-actions").getByRole("button")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /apply/i })).toHaveCount(0);
    await expect(plan.getByTestId("plan-apply")).toHaveCount(0);
    await expect(plan.getByTestId("plan-confirm")).toHaveCount(0);
    await expect(page.getByTestId("chat-confirm-dialog")).toHaveCount(0);

    // The run completes normally (the mock's read tool answered through the
    // real bridge; nothing was executed against the engine).
    await expect(page.getByTestId("chat-status")).toHaveAttribute("data-phase", "done", {
      timeout: RUN_SETTLE_TIMEOUT_MS,
    });
  });

  test("a scripted high-risk plan renders the danger chrome and cannot arm an apply control (the gate is host wiring, not stream data)", async ({
    page,
  }) => {
    // The high-risk variant needs the scripted-gateway leg: MOCK_MODEL's one
    // plan is low-risk by construction, and no real model is contacted.
    await installScriptedRun(page, highRiskRunEvents());

    // Wire-level honesty: a plan-only stream must not trigger ANY client
    // tool execution (zero POSTs to /v1/runs/:id/events).
    let toolResultPosts = 0;
    await page.route("**/v1/runs/*/events", async (route) => {
      toolResultPosts += 1;
      await route.continue();
    });

    const composer = page.getByLabel("Message the agent");
    await composer.click();
    await composer.fill("Blend the Background layer to Multiply");
    await composer.press("Enter");

    // The scripted stream is complete and terminal — the thread settles.
    await expect(page.getByTestId("chat-status")).toHaveAttribute("data-phase", "done", {
      timeout: RUN_SETTLE_TIMEOUT_MS,
    });

    const plan = page.getByTestId("plan-card");
    await expect(plan).toBeVisible();
    await expect(plan).toHaveAttribute("data-status", "proposed");
    await expect(plan).toHaveAttribute("data-risk", "high");
    await expect(plan).toHaveAttribute("data-requires-approval", "true");
    await expect(plan).toHaveClass(/border-danger/);

    // §6.2 high-risk chrome: the danger badge + the explicit warning line.
    await expect(page.getByTestId("plan-risk")).toHaveText("High risk");
    await expect(page.getByTestId("plan-requires-confirmation")).toBeVisible();
    await expect(page.getByTestId("plan-requires-confirmation")).toContainText(
      "High risk — requires confirmation before it runs.",
    );
    await expect(page.getByTestId("plan-credits")).toHaveText("≈ 2.25 credits");

    // The STRUCTURAL gate (BUILD_PLAN §M5 "high-risk actions always require
    // confirmation"): the confirm checkbox, the Apply button and the dialog
    // exist only in host wiring — a stream declaring risk "high" cannot arm
    // an ungated apply. Until the thread layer passes the callbacks
    // (M5-G follow-up #1), NONE of these surfaces render.
    await expect(plan.getByTestId("plan-confirm-checkbox")).toHaveCount(0);
    await expect(plan.getByTestId("plan-apply")).toHaveCount(0);
    await expect(plan.getByTestId("plan-actions").getByRole("button")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /apply/i })).toHaveCount(0);
    await expect(page.getByTestId("chat-confirm-dialog")).toHaveCount(0);

    // The compiled batch rode the wire but executes NOTHING here: the
    // resolution + engine.batch live behind the (wiring-gated) Apply.
    expect(toolResultPosts).toBe(0);
  });

  // -------------------------------------------------------------------------
  // WIRING-PENDING (fixme): the full apply → undo → re-apply journey
  // -------------------------------------------------------------------------
  //
  // NOT fixme because of CI ownership (CI runs this suite — README §Run):
  // the only missing link is the thread-layer mount. `message.tsx` still
  // renders `<PlanCard plan={message.plan} applied={false} />` with no
  // callbacks (M5-G "Integrator follow-ups" #1), so the action row cannot
  // exist in the real thread YET. Everything it needs IS landed: the card
  // state machine + confirm dialog (M5-G), the ApplyController
  // resolve→patch→ONE engine.batch→saveNow("agent-apply")→applyRun
  // (lib/chat/apply.ts), the planRuntime state + chat.plan.* gestures +
  // applicablePlanOf (lib/chat/run-state.ts), the M5-E apply/undo routes and
  // the M5-D persistence.
  //
  // FLIPPED 2026-10-24: the thread wiring (M5-Q) + the host applyPorts mount
  // (K-1 fix) landed; the journey below is ACTIVE. Original flip note:
  // FLIP: change `test.fixme` → `test` when the thread layer maps the
  // planRuntime outcome to the card's status props and passes
  // onApply/onUndo/onReapply (+ reapplyDrifted per the session's version
  // head). Every assertion below is written against the card's pinned
  // contract (plan-card.tsx) so the flip is mechanical.
  //
  // Re-apply drift is the DETERMINISTIC fixture outcome: after apply, the
  // session sits on the newly UPLOADED version (not the plan's base —
  // lib/chat/apply.ts notes the session pointer restore is an unimplemented
  // session-level concern, and PLAN_EVENT_SCHEMA does not carry
  // baseVersionId on the wire — it is stripped by the SSE reader), so the
  // reapply gate answers base-version-changed ⇒ Re-apply disabled + the
  // §M5.5 explanation. If the wiring later restores the pointer, flip the
  // two drifted assertions to the enabled + re-applied path.
  test("high-risk journey: checkbox gates Apply → confirm dialog → applied (one undo step) → Undo → undone → Re-apply blocked (drifted)", async ({
    page,
  }) => {
    await installScriptedRun(page, highRiskRunEvents());

    const composer = page.getByLabel("Message the agent");
    await composer.click();
    await composer.fill("Blend the Background layer to Multiply");
    await composer.press("Enter");

    const plan = page.getByTestId("plan-card");
    await expect(plan).toBeVisible({ timeout: RUN_SETTLE_TIMEOUT_MS });
    await expect(plan).toHaveAttribute("data-status", "proposed");
    await expect(plan).toHaveAttribute("data-risk", "high");

    // Preview: the M5-H PlanPreview is not thread-mounted in this
    // environment — the card renders without the slot (asserted ACTIVE in
    // the mock-plan scenario above). When the wiring mounts it, assert
    // plan-preview-panel data-status="ready" + plan-preview-frames here.
    await expect(page.getByTestId("plan-preview")).toHaveCount(0);

    // §6.2: the confirm CHECKBOX gates the Apply button.
    const checkbox = plan.getByTestId("plan-confirm-checkbox");
    const applyButton = plan.getByTestId("plan-apply");
    await expect(checkbox).toBeVisible();
    await expect(applyButton).toBeDisabled();
    await checkbox.check();
    await expect(applyButton).toBeEnabled();

    // The confirm dialog is the second gate — Escape cancels WITHOUT
    // applying (the card stays proposed, no engine.batch).
    await applyButton.click();
    const dialog = page.getByTestId("chat-confirm-dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("chat-confirm-title")).toContainText(
      "Apply this high-risk plan?",
    );
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(plan).toHaveAttribute("data-status", "proposed");

    // Confirmed apply: ONE atomic engine.batch → applying → applied with
    // the one-undo-step indicator (law #6).
    await applyButton.click();
    await expect(dialog).toBeVisible();
    await page.getByTestId("chat-confirm-confirm").click();
    await expect(plan).toHaveAttribute("data-status", "applied", {
      timeout: APPLY_SETTLE_TIMEOUT_MS,
    });
    await expect(page.getByTestId("plan-applied")).toContainText(/· one undo step\./);
    await expect(plan.getByTestId("plan-undo")).toBeVisible();

    // Undo: ONE edit.undo reverts the whole batch (§7.2).
    await plan.getByTestId("plan-undo").click();
    await expect(plan).toHaveAttribute("data-status", "undone", {
      timeout: APPLY_SETTLE_TIMEOUT_MS,
    });
    await expect(page.getByTestId("plan-undone")).toContainText(
      "Undone — the batch reverted; the version stays in history.",
    );

    // Re-apply is the version-head gate (§M5.5): the fixture's session
    // sits on the APPLIED version (never restored to the plan's base), so
    // the gate answers drifted — disabled + the explanation.
    await expect(plan.getByTestId("plan-reapply")).toBeDisabled();
    await expect(page.getByTestId("plan-reapply-blocked")).toContainText(
      "Re-apply is blocked — the project moved on since this run was undone.",
    );

    // The editor is visually unchanged OUTSIDE the canvas area by the
    // whole journey (applied then undone): mask the chat chrome AND the
    // canvas viewport (editor-viewport hosts the wasm iframe where the
    // edit legitimately changed pixels) — the pinned shot is the editor
    // chrome (timeline/panels/header), M4 mask approach.
    await page.mouse.move(320, 400);
    await expect(page).toHaveScreenshot("editor-unchanged-m5-journey.png", {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.01,
      mask: [
        page.getByTestId("chat-panel-layer"),
        page.getByTestId("chat-collapsed-layer"),
        page.getByTestId("editor-viewport"),
      ],
    });
  });

  test("the editor is visually unchanged by the M5 read-only chat journey", async ({ page }) => {
    // After a full plan-bearing run (mock plan card in the thread, nothing
    // applied), the editor's pixels are the M3-baseline pixels: the M4
    // mask approach — chat chrome masked, everything else is the editor.
    // First CI run: --update-snapshots (README §First run).
    const composer = page.getByLabel("Message the agent");
    await composer.click();
    await composer.fill("Rename the selected layer to Subtitle");
    await composer.press("Enter");

    await expect(page.getByTestId("plan-card")).toBeVisible({ timeout: RUN_SETTLE_TIMEOUT_MS });
    await expect(page.getByTestId("chat-status")).toHaveAttribute("data-phase", "done", {
      timeout: RUN_SETTLE_TIMEOUT_MS,
    });

    await page.mouse.move(320, 400);
    await expect(page).toHaveScreenshot("editor-unchanged-m5-readonly.png", {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.01,
      mask: [page.getByTestId("chat-panel-layer"), page.getByTestId("chat-collapsed-layer")],
    });
  });
});
