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
 * ROUND-12 TRUTH — the client-driven turn loop (research/round12-design.md)
 * ----------------------------------------------------------------------------
 *
 * The gateway is now STATELESS PER TURN: the run loop lives in the browser
 * (apps/web/src/lib/chat/chat-controller.ts). One run =
 *   POST /v1/threads/:id/turn (step 0)  → message.delta + TWO write-tool
 *     proposals (studio.create_composition + studio.create_text, each with a
 *     server-compiled proposal.compiled carrier — services/gateway/src/routes/
 *     turn.ts `mockTurn` under MOCK_MODEL=true);
 *   the client ACCUMULATES the carriers (never executes write tools mid-run),
 *     echoes `resultForModel` and settles the tool chips via a synthesized
 *     tool.result (the turn wire has no tool.result events — 12-w5-t1 pin);
 *   POST /v1/threads/:id/turn (step 1)  → the mock's closing text
 *     "Done — I created the Agent Demo composition with a text layer."
 *     with toolCalls: [] ⇒ the run ENDS locally;
 *   mergeEditPlans(carriers) → POST /v1/runs/:id/plan → the server VALIDATES +
 *     re-compiles the plan authoritatively + stamps the §7.3 verdict
 *     (the seeded demo user has NO settings row = auto-apply ON, and the
 *     merged create plan is auto-eligible) → the plan card folds → the
 *     round-10 AUTO-APPLY DRIVE fires at the client-synthesized run.completed.
 *
 * Card facts asserted (all derived, no magic numbers unexplained):
 *   merged summary  = `Create composition "Agent Demo" (+1 more changes)`
 *     (mergeEditPlans — first carrier summary + the (+N) suffix);
 *   intent "create" (both carriers agree), requiresApproval false;
 *   risk "medium" — SERVER-recomputed (create_composition floors medium);
 *   estimatedCredits = estimateCredits(medium, 2 steps) = (1 + 2×0.5) × 1.25
 *     = 2.5 → the card renders "≈ 2.5 credits";
 *   steps = the two carriers: `Create composition "Agent Demo"` /
 *     studio.create_composition + `Add text layer "Agent Text"` /
 *     studio.create_text; purely additive ⇒ NO affected-layers section.
 *
 * KNOWN PRODUCT GAP (reported to the lead; the spec pins the INTENDED
 * journey and stays RED until it lands): routes/apply.ts `applyable()`
 * (line ~57/128) still requires run.status ∈ {awaiting_approval, completed},
 * but the round-12 plan route (routes/turn.ts POST /v1/runs/:id/plan) stores
 * plan_json WITHOUT transitioning the run out of "running" (the loop ends
 * runs CLIENT-side; nothing server-side marks them terminal). Until the plan
 * route writes the run status, the real POST /v1/runs/:id/apply 409s
 * RUN_NOT_ACTIVE and the auto-applied assertions below fail honestly. Fix
 * direction: runs.update(..., {planJson, status: "awaiting_approval"}) in
 * the plan route (running → awaiting_approval is a legal transition).
 *
 * The scripted high-risk leg: MOCK_MODEL only ever proposes create carriers,
 * and no real model is contacted — so the danger-chrome tests install their
 * OWN scripted gateway leg via `page.route` on the TURN wire
 * (`POST …/v1/threads/<id>/turn`) fulfilled with byte-exact §7.4 frames
 * (`id: <seq>\ndata: <json>\n\n`, the turn route's sseFrame format) that
 * parse against STUDIO_STREAM_EVENT_SCHEMA: the client's real reader folds
 * them like any server stream. The scripted stream carries a `plan` event
 * (still a first-class §7.4 type — the client itself synthesizes one from
 * the plan POST response at run end) plus a terminal `turn.completed` with
 * toolCalls: [] ⇒ NO carriers accumulate ⇒ NO plan POST fires for a run the
 * gateway never created (which would honestly 404 RUN_NOT_FOUND). The
 * scripted batch uses REAL curated command ids (layer.setBlendMode —
 * packages/contracts command-registry) and the pinned $request resolution
 * placeholder, mirroring what the plan compiler (M5-B) emits.
 *
 * ----------------------------------------------------------------------------
 * testid map driven by this spec (drift detector — every id verified against
 * the source when written; plan-card.tsx / confirm-dialog.tsx unchanged in
 * round 12)
 * ----------------------------------------------------------------------------
 *
 *   plan-card            (+ data-status, data-applied, data-risk,
 *                         data-intent, data-requires-approval)  plan-card.tsx
 *   plan-risk, plan-intent, plan-requires-confirmation          plan-card.tsx
 *   plan-steps-toggle (BUTTON, aria-expanded), plan-steps       plan-card.tsx
 *   plan-affected, plan-credits                                 plan-card.tsx
 *   plan-preview (slot — proposed only), plan-diff (ditto), plan-note (gone)
 *   plan-actions, plan-confirm, plan-confirm-checkbox,         plan-card.tsx
 *   plan-apply, plan-cancel
 *   plan-applying, plan-applied, plan-undo, plan-undone,         plan-card.tsx
 *   plan-reapply, plan-reapply-blocked
 *   tool-card (+ data-tool, data-status), tool-card-toggle,      tool-card.tsx
 *   tool-card-details, tool-card-result
 *   chat-confirm-dialog, chat-confirm-title,                   confirm-dialog.tsx
 *   chat-confirm-cancel, chat-confirm-confirm
 *   editor-host (+ data-editor-phase), editor-iframe,           editor-host.tsx
 *   editor-viewport, chat-layer
 *   chat-header, chat-status (+ data-phase)                     header.tsx
 *   chat-thread-list, chat-composer (aria-label "Message the agent"),
 *   chat-progress-strip (live phases only — progress-strip.tsx),
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
/** Two mock turns + the plan POST — a generous upper bound for the run. */
const RUN_SETTLE_TIMEOUT_MS = 30_000;
/** ONE atomic engine.batch + version upload + applyRun report (M5-F). */
const APPLY_SETTLE_TIMEOUT_MS = 30_000;
/** ONE edit.undo + undoRun report — the §M5.5 escape hatch. */
const UNDO_SETTLE_TIMEOUT_MS = 30_000;

/**
 * The scripted run's id (any nonempty string binds the client's stream
 * normalizer; kept stable across the fixture's frames).
 */
const SCRIPTED_RUN_ID = "run_m5_e2e_high_risk";

/** The mock journey's created composition (routes/turn.ts `mockTurn`). */
const MOCK_COMP = "Agent Demo";
/** The mock journey's created text layer (mockTurn's studio.create_text). */
const MOCK_TEXT_LAYER = "Agent Text";
/** The mock's closing text (turn 1 — the run ends on this turn). */
const MOCK_CLOSING_TEXT = "Done — I created the Agent Demo composition with a text layer.";

type EffectcraftGlobal = {
  execute: (command: string, params?: unknown) => Promise<unknown>;
};

// ---------------------------------------------------------------------------
// Helpers — boot + the scripted-gateway leg
// ---------------------------------------------------------------------------

/**
 * Sign the seeded demo user in through the REAL /sign-in form (better-auth
 * email+password → session cookie) and land on the seeded project's editor
 * with the chat overlay mounted (identical to e2e/chat.spec.ts — the M4
 * recipe's `?next=` round-trip).
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
  // Run-3 hardening: on a cold dev boot the fill+click sequence can run
  // before React attaches onSubmit — the click then performs a native
  // no-op GET submit (the inputs carry no `name`, so the URL is a bare
  // "/sign-in?") and NO /v1/auth/sign-in/email POST ever fires (confirmed
  // in the run-3 failure trace: zero auth requests, one stray GET, on BOTH
  // attempts). The canary below gates the fill+submit on live React
  // handlers; the outer retry also absorbs the gateway's ~8s cold boot
  // (a first submit that 502'd through the edge surfaces as an inline
  // form error and leaves the URL unchanged).
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

/** The editor iframe's frame (the only frame under /editor/). */
function editorFrame(page: Page) {
  const frame = page.frames().find((f) => f.url().includes("/editor/"));
  if (frame === undefined) {
    throw new Error("editor iframe not found");
  }
  return frame;
}

/** LIVE-engine proof: the names in `project.summary` (read-only query). */
async function engineCompositionNames(page: Page): Promise<string[]> {
  return editorFrame(page).evaluate(async () => {
    const summary = (await (
      window as unknown as { effectcraft: EffectcraftGlobal }
    ).effectcraft.execute("project.summary", {})) as { items?: Array<{ name?: string }> };
    return (summary.items ?? []).map((item) => String(item.name ?? ""));
  });
}

/** LIVE-engine proof: the layer names of one comp (`comp.info`, by name). */
async function engineLayerNames(page: Page, comp: string): Promise<string[]> {
  return editorFrame(page).evaluate(async (compName) => {
    const info = (await (
      window as unknown as { effectcraft: EffectcraftGlobal }
    ).effectcraft.execute("comp.info", { comp: compName })) as {
      layers?: Array<{ name?: string }>;
    };
    return (info.layers ?? []).map((layer) => String(layer.name ?? ""));
  }, comp);
}

/**
 * One §7.4 event → one SSE frame, byte-shaped like the gateway's `sseFrame`
 * (services/gateway/src/routes/turn.ts): `id: <seq>\ndata: <json>\n\n`.
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
 * The scripted-gateway leg: intercept the TURN wire
 * (`POST /v1/threads/:id/turn` — the round-12 SSE endpoint that replaced the
 * retired `/chat` loop) and fulfill it with a complete, deterministic SSE
 * body. The REAL client reader/reducer/thread fold the frames exactly like a
 * server stream; the real gateway (auth, threads, models, ledger) serves
 * everything else.
 */
async function installScriptedRun(
  page: Page,
  events: ReadonlyArray<Record<string, unknown>>,
): Promise<void> {
  await page.route("**/v1/threads/*/turn", async (route) => {
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

/**
 * The scripted-gateway leg's REPORT half (W3-C1): `POST /v1/runs/:id/apply`
 * + `POST /v1/runs/:id/undo` for the SCRIPTED run, answered with §7.3-exact
 * Ok envelopes (the api-client unwraps `{data}` and validates it against
 * APPLY_RESPONSE_SCHEMA / UNDO_RESPONSE_SCHEMA — response-schemas.ts).
 *
 * Why the report legs are scripted when nothing else on the apply path is:
 * the run row only exists client-side (the turn POST this spec intercepts
 * never reaches the gateway's `runs.create`), so the real apply/undo routes
 * would honestly 404 RUN_NOT_FOUND — a scripted-stream artifact, not an app
 * bug. Everything the journey actually proves stays REAL: the resolve →
 * patch → ONE atomic engine.batch → `saveNow("agent-apply")` chain, and the
 * VERSION UPLOAD leg (`POST /v1/projects/:id/versions` hits the real
 * gateway), plus the local `edit.undo` and the reapply-drift gate. The
 * gateway's own apply/undo semantics (ledger settle, lineage, lease guard)
 * are covered by its suite (services/gateway/tests), not by this browser
 * journey.
 */
async function installScriptedApplyReport(page: Page): Promise<void> {
  await page.route("**/v1/runs/*/apply", async (route) => {
    const body = route.request().postDataJSON() as { versionId?: string };
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      // Echo the run's uploaded version id (the gateway echoes it too).
      body: JSON.stringify({
        data: { applied: true, versionId: body.versionId ?? "", creditsCommitted: 2.25 },
      }),
    });
  });
  await page.route("**/v1/runs/*/undo", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ data: { undone: true } }),
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
          // Two steps so the batch ALWAYS changes content: the engine
          // records NO undo step for a no-op set (Session::edit's
          // same-content branch), and every journey run ADVANCES the project
          // head to the Multiply version — a single Multiply step would be a
          // silent no-op on re-runs and the Undo leg would die with "nothing
          // to undo". Normal-then-Multiply changes content from EITHER head
          // state and lands on Multiply both times (deterministic content).
          {
            command: "layer.setBlendMode",
            params: { layers: ["$request:req_bg"], mode: "Normal" },
          },
          {
            command: "layer.setBlendMode",
            params: { layers: ["$request:req_bg"], mode: "Multiply" },
          },
        ],
      },
    },
  ],
};

/**
 * The §8.5-compiled engine payload the client's ApplyController executes.
 *
 * W3-C1 shape notes:
 * - `layers` is an ARRAY (the engine's layer-list params — `layers_p` —
 *   only read arrays; a SCALAR `layers` value is silently ignored and the
 *   command falls back to the UI selection, which is empty for an agent
 *   batch ⇒ a no-op apply with NO undo step — the "nothing to undo"
 *   failure this journey first hit). The `$request:` token inside the array
 *   resolves to the layer id and `patchPlaceholders` walks arrays too, so
 *   the patched payload is `{layers: [<id>], mode}` — the registry shape.
 * - The Normal→Multiply pair makes the batch change content from EITHER
 *   head state (see the display-plan comment above): re-runnable journey.
 */
const HIGH_RISK_COMPILED_BATCH: Record<string, unknown> = {
  label: "Agent: blend Background",
  atomic: true,
  steps: [
    { command: "layer.setBlendMode", params: { layers: ["$request:req_bg"], mode: "Normal" } },
    { command: "layer.setBlendMode", params: { layers: ["$request:req_bg"], mode: "Multiply" } },
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

/**
 * The full scripted turn: started → delta → high-risk plan → the TERMINAL
 * `turn.completed` with toolCalls: [] (the run ends CLIENT-side — the loop
 * synthesizes the §7.4 run.completed locally; no run.completed frame rides
 * the turn wire). No carriers accumulate ⇒ no run-end plan POST fires.
 */
function highRiskTurnEvents(): ReadonlyArray<Record<string, unknown>> {
  return [
    { type: "run.started", runId: SCRIPTED_RUN_ID, seq: 1, model: "studio-fast" },
    { type: "turn.started", runId: SCRIPTED_RUN_ID, seq: 2, stepIndex: 0 },
    {
      type: "message.delta",
      runId: SCRIPTED_RUN_ID,
      seq: 3,
      delta: "This restyle touches the comp background — planning it as high risk.",
    },
    {
      type: "plan",
      runId: SCRIPTED_RUN_ID,
      seq: 4,
      plan: HIGH_RISK_PLAN,
      compiledBatch: HIGH_RISK_COMPILED_BATCH,
      resolutionRequests: HIGH_RISK_RESOLUTIONS,
      risk: "high",
      estimatedCredits: 2.25,
    },
    {
      type: "turn.completed",
      runId: SCRIPTED_RUN_ID,
      seq: 5,
      stepIndex: 0,
      finishReason: "stop",
      usage: { inputTokens: 900, outputTokens: 200 },
      credits: { committed: 1 },
      assistantText: "This restyle touches the comp background — planning it as high risk.",
      toolCalls: [],
    },
  ];
}

// ---------------------------------------------------------------------------
// The M5 agent-edits journey (BUILD_PLAN §M5 task 8)
// ---------------------------------------------------------------------------

test.describe("M5 agent edits — plan card journey", () => {
  test.beforeEach(async ({ page }) => {
    // The default 30s test timeout cannot cover a cold wasm editor boot
    // (EDITOR_OPEN_TIMEOUT_MS is 120s) plus the journey's settle waits.
    test.setTimeout(360_000);
    await openSeededEditor(page);
  });

  test("the mock loop auto-applies end-to-end: chips → plan card (mode auto) → applied → canvas changed → Undo works", async ({
    page,
  }) => {
    // ROUND-12: the seeded user has NO settings row = the schema default =
    // auto-apply ON, and the mock's merged create plan (comp.new +
    // layer.newText, no resolution requests) is auto-eligible — so at the
    // client-synthesized run.completed the controller AUTO-DRIVES Apply
    // through the REAL bridge (no click): the engine executes the ATOMIC
    // batch, the save chain uploads a version and the applyRun report lands.
    const composer = page.getByLabel("Message the agent");
    await composer.click();
    await composer.fill("Set up a demo composition with a text layer");
    await composer.press("Enter");

    await expect(page.getByTestId("chat-thread-list")).toContainText(
      "Set up a demo composition with a text layer",
      { timeout: RUN_SETTLE_TIMEOUT_MS },
    );

    // TURN 0's proposals: TWO tool chips light up from tool.started and
    // settle via the loop's SYNTHESIZED tool.result (the turn wire has no
    // tool.result — the carrier's propose-only resultForModel settles them;
    // 12-w5-t1 pin). Write tools NEVER execute mid-run.
    const compChip = page.locator(
      '[data-testid="tool-card"][data-tool="studio.create_composition"]',
    );
    const textChip = page.locator('[data-testid="tool-card"][data-tool="studio.create_text"]');
    await expect(compChip).toHaveCount(1, { timeout: RUN_SETTLE_TIMEOUT_MS });
    await expect(textChip).toHaveCount(1, { timeout: RUN_SETTLE_TIMEOUT_MS });
    await expect(compChip).toHaveAttribute("data-status", "done", {
      timeout: RUN_SETTLE_TIMEOUT_MS,
    });
    await expect(textChip).toHaveAttribute("data-status", "done", {
      timeout: RUN_SETTLE_TIMEOUT_MS,
    });

    // TURN 1 closes the run: the mock's final text REPLACES the streamed
    // turn-0 text (turn.completed's assistantText is authoritative).
    const answer = page.locator('[data-testid="chat-message"][data-role="assistant"]');
    await expect(answer).toContainText(MOCK_CLOSING_TEXT, {
      timeout: RUN_SETTLE_TIMEOUT_MS,
    });

    // The card: the M5 status machine settles at APPLIED (auto-driven at
    // the local run.completed; the settle wait covers the bridge batch,
    // the save chain and the applyRun report). See the header's KNOWN
    // PRODUCT GAP note — this is RED until the plan route marks the run.
    const plan = page.getByTestId("plan-card");
    await expect(plan).toBeVisible({ timeout: RUN_SETTLE_TIMEOUT_MS });
    await expect(plan).toHaveAttribute("data-status", "applied", {
      timeout: APPLY_SETTLE_TIMEOUT_MS,
    });
    await expect(plan).toHaveAttribute("data-applied", "true");
    // SERVER-recomputed risk (create_composition floors medium — never the
    // model's declared "low") + intent "create" (both carriers agree).
    await expect(plan).toHaveAttribute("data-risk", "medium");
    await expect(plan).toHaveAttribute("data-intent", "create");
    await expect(plan).toHaveAttribute("data-requires-approval", "false");

    // §6.2 surfaces: risk badge, intent badge, MERGED summary
    // (mergeEditPlans: first carrier summary + "(+1 more changes)").
    await expect(page.getByTestId("plan-risk")).toHaveText("Medium risk");
    await expect(page.getByTestId("plan-intent")).toHaveText("Create");
    await expect(plan).toContainText('Create composition "Agent Demo" (+1 more changes)');

    // Steps: the disclosure persists in the applied state — the TWO carrier
    // steps with their tool ids (client-built carriers, gateway-parity
    // summaries — chat-controller.ts writeToolSummary).
    const stepsToggle = plan.getByTestId("plan-steps-toggle");
    await expect(stepsToggle).toBeVisible();
    await expect(stepsToggle).toHaveAttribute("aria-expanded", "true");
    await expect(stepsToggle).toContainText("2 steps");
    await expect(plan.getByTestId("plan-steps")).toBeVisible();
    await expect(plan.getByTestId("plan-steps")).toContainText('Create composition "Agent Demo"');
    await expect(plan.getByTestId("plan-steps")).toContainText("studio.create_composition");
    await expect(plan.getByTestId("plan-steps")).toContainText('Add text layer "Agent Text"');
    await expect(plan.getByTestId("plan-steps")).toContainText("studio.create_text");

    // The plan is purely ADDITIVE — no existing layers affected, so the
    // affected-layers section is absent. The server's credit estimate rides
    // VERBATIM (the card never recomputes credits client-side):
    // estimateCredits(medium, 2 steps) = (1 + 2×0.5) × 1.25 = 2.5.
    await expect(page.getByTestId("plan-affected")).toHaveCount(0);
    await expect(page.getByTestId("plan-credits")).toHaveText("≈ 2.5 credits");

    // The preview/diff slots mount only while proposed (derivePlanCardProps) —
    // after the auto-apply settles they are gone.
    await expect(page.getByTestId("plan-preview")).toHaveCount(0);
    await expect(page.getByTestId("plan-diff")).toHaveCount(0);

    // The M4 "Apply arrives with M5" note is GONE — apply is real (M5-G).
    await expect(page.getByTestId("plan-note")).toHaveCount(0);

    // The applied action row: NO Apply/Cancel (the work already landed); the
    // applied status + Undo instead. Medium risk ⇒ no checkbox, no dialog.
    await expect(plan.getByTestId("plan-confirm")).toHaveCount(0);
    await expect(page.getByTestId("chat-confirm-dialog")).toHaveCount(0);
    await expect(plan.getByTestId("plan-apply")).toHaveCount(0);
    await expect(plan.getByTestId("plan-cancel")).toHaveCount(0);
    await expect(plan.getByTestId("plan-applied")).toBeVisible();
    await expect(plan.getByTestId("plan-applied")).toContainText(/· one undo step\./);
    await expect(plan.getByTestId("plan-undo")).toBeVisible();
    await expect(plan.getByTestId("plan-undo")).toBeEnabled();

    // The run completed (chat-status) — the loop synthesized run.completed
    // after the empty-toolCalls turn.
    await expect(page.getByTestId("chat-status")).toHaveAttribute("data-phase", "done", {
      timeout: RUN_SETTLE_TIMEOUT_MS,
    });

    // CANVAS proof (the auto-apply really executed against the LIVE engine):
    // the created composition + its text layer are in the project, and the
    // new comp carries the layer (query commands ride the execute channel).
    expect(await engineCompositionNames(page)).toContain(MOCK_COMP);
    expect(await engineLayerNames(page, MOCK_COMP)).toContain(MOCK_TEXT_LAYER);

    // UNDO works — the one-click escape hatch (§M5.5): ONE edit.undo
    // reverts the WHOLE atomic batch (law #6), the card folds to undone,
    // and the live engine loses the created composition.
    await plan.getByTestId("plan-undo").click();
    await expect(plan).toHaveAttribute("data-status", "undone", {
      timeout: UNDO_SETTLE_TIMEOUT_MS,
    });
    await expect(page.getByTestId("plan-undone")).toContainText(
      "Undone — the batch reverted; the version stays in history.",
    );
    expect(await engineCompositionNames(page)).not.toContain(MOCK_COMP);
  });

  test("a scripted high-risk plan renders the danger chrome and keeps Apply gated (stream data alone never arms an apply)", async ({
    page,
  }) => {
    // The high-risk variant needs the scripted-gateway leg: MOCK_MODEL's
    // carriers are create-only by construction, and no real model is
    // contacted.
    await installScriptedRun(page, highRiskTurnEvents());

    // Wire-level honesty (round-12 shape): a plan-only turn must trigger
    // NEITHER a client-executed tool POST (the /v1/threads/:id/tools/*
    // endpoints serve web_search/generate_image) NOR the run-end plan POST
    // (no carriers accumulated ⇒ the client never POSTs /v1/runs/:id/plan).
    let toolEndpointPosts = 0;
    await page.route("**/v1/threads/*/tools/*", async (route) => {
      if (route.request().method() === "POST") toolEndpointPosts += 1;
      await route.continue();
    });
    let planPosts = 0;
    await page.route("**/v1/runs/*/plan", async (route) => {
      if (route.request().method() === "POST") planPosts += 1;
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
    // confirmation"), W5-07 truth after the M5-Q thread wiring + K-1 host
    // applyPorts mount landed: the confirm checkbox, Apply button and action
    // row DO render now — but the stream declaring risk "high" never ARMS
    // anything. The checkbox starts UNCHECKED, Apply stays disabled until it
    // is checked, and no dialog exists without an explicit confirmed click.
    // (The pre-wiring count-0 assertions below were the stale arm; the
    // full journey is the next test.)
    const checkbox = plan.getByTestId("plan-confirm-checkbox");
    const applyButton = plan.getByTestId("plan-apply");
    await expect(checkbox).toBeVisible();
    await expect(checkbox).not.toBeChecked();
    await expect(applyButton).toBeVisible();
    await expect(applyButton).toBeDisabled();
    // Run-3: the proposed card's action row is Apply + Cancel (plan-card.tsx
    // "Apply/Cancel" — the Cancel gesture landed after the count-1 pin), so
    // the row holds TWO buttons with Apply still disabled until the checkbox
    // arms it.
    await expect(plan.getByTestId("plan-cancel")).toBeVisible();
    await expect(plan.getByTestId("plan-actions").getByRole("button")).toHaveCount(2);
    await expect(page.getByTestId("chat-confirm-dialog")).toHaveCount(0);

    // The compiled batch rode the wire but executes NOTHING here: the
    // resolution + engine.batch live behind the confirmed Apply (checkbox →
    // dialog), the client never executed a write tool mid-run, and neither
    // network leg fired.
    expect(toolEndpointPosts).toBe(0);
    expect(planPosts).toBe(0);
  });

  test("high-risk journey: checkbox gates Apply → confirm dialog → applied (one undo step) → Undo → undone → Re-apply blocked (drifted)", async ({
    page,
  }) => {
    await installScriptedRun(page, highRiskTurnEvents());
    // The run row only exists client-side (the turn POST is scripted), so the
    // apply/undo REPORT legs are scripted too — see the helper's header for
    // the split of real vs scripted legs on the apply path.
    await installScriptedApplyReport(page);

    const composer = page.getByLabel("Message the agent");
    await composer.click();
    await composer.fill("Blend the Background layer to Multiply");
    await composer.press("Enter");

    const plan = page.getByTestId("plan-card");
    await expect(plan).toBeVisible({ timeout: RUN_SETTLE_TIMEOUT_MS });
    await expect(plan).toHaveAttribute("data-status", "proposed");
    await expect(plan).toHaveAttribute("data-risk", "high");

    // Preview: the M5-H PlanPreview NEVER mounts for a high-risk card
    // (message.tsx: only proposed && !highRisk probe — §6.2 nothing runs
    // before the user confirms). The mock-plan scenario above asserts the
    // preview PRESENT for the medium-risk applicable card.
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
    // chrome (timeline/panels/header), M4 mask approach. The round-10
    // baseline already masks the viewport; unchanged in round 12.
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

  test("the auto-applied journey leaves the editor chrome at the M3 baseline (canvas masked — it legitimately CHANGED, round-10)", async ({
    page,
  }) => {
    // ROUND-12: the two-turn mock loop AUTO-APPLIES — the canvas legitimately
    // GAINS the "Agent Demo" composition + text layer (the whole point), so
    // the old "editor unchanged" premise is dead: only the CHROME (header,
    // timeline, panels — everything but the viewport and the chat chrome) is
    // asserted against the baseline; the viewport stays masked because it now
    // intentionally differs. First CI run after this change MUST use
    // --update-snapshots (README §First run) to re-baseline.
    const composer = page.getByLabel("Message the agent");
    await composer.click();
    await composer.fill("Set up a demo composition with a text layer");
    await composer.press("Enter");

    await expect(page.getByTestId("plan-card")).toBeVisible({ timeout: RUN_SETTLE_TIMEOUT_MS });
    await expect(page.getByTestId("plan-card")).toHaveAttribute("data-status", "applied", {
      timeout: RUN_SETTLE_TIMEOUT_MS,
    });
    await expect(page.getByTestId("chat-status")).toHaveAttribute("data-phase", "done", {
      timeout: RUN_SETTLE_TIMEOUT_MS,
    });

    await page.mouse.move(320, 400);
    await expect(page).toHaveScreenshot("editor-autoapplied-m5-readonly.png", {
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
});
