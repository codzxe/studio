/**
 * M8 renders — the CI-owned Playwright specs (BUILD_PLAN §M8 task 2: the
 * "Render…" dialog + history drawer over the editor, the live estimate, the
 * queue → poll → cancel → download journey, and the project-hub renders tab).
 *
 * NEVER RUN ON THE BUILD-FLEET BOX — same class of debt as e2e/chat.spec.ts,
 * e2e/m5-agent-edits.spec.ts and e2e/m7-collab.spec.ts (M3/M4/M5/M7
 * precedent): this box has no browsers and no dev servers, so
 * `@playwright/test` is NOT installed here. apps/web/tsconfig.json excludes
 * the `e2e` directory from typecheck for exactly that reason and the web
 * vitest config never matches an `e2e/*.spec.ts` file; CI owns the
 * devDependency, the lockfile and the run (e2e/README.md is the boot recipe
 * — env, seed, the staged `.ecproj` fixture; NO new setup steps and NO new
 * baselines for this spec).
 *
 * ---------------------------------------------------------------------------
 * ACTIVE today — and ZERO fixmes (the honest split)
 * ---------------------------------------------------------------------------
 *
 * Seven journeys. Every scenario went ACTIVE because the whole M8 render UI
 * landed with M8-I (dialog, drawer, header entry), M8-J (hub panel) and the
 * M8-waveB closeout fixes — each surface verified in source at write time:
 *
 *   1. (ACTIVE) DIALOG + FORMAT GATE — the chat-header "Render…" button opens
 *      the document-level dialog (D-18: a portal; the editor iframe stays
 *      alive behind it), the live comp prefills from the bridge, the format
 *      picker offers EXACTLY MP4 + PNG sequence (D-2: the reserved
 *      prores/gif/wav rows are absent, never shown-disabled; labels come
 *      from @studio/config RENDER_FORMATS), the resolution ladder reads the
 *      comp's native px back, an inverted range explains itself inline and
 *      disables queueing, Tab stays inside the portal (focus trap) and Esc
 *      closes.
 *   2. (ACTIVE) LIVE ESTIMATE — POST /v1/renders/estimate scripted with a
 *      schema-exact EstimateResult envelope keyed to the dialog inputs: the
 *      estimate line shows credits + output seconds + the server long edge,
 *      ONE settings change coalesces to exactly ONE re-estimate (the 400 ms
 *      debounce — no request storm), the estimate carries NO idempotency key
 *      anywhere (a pure read per contracts), and the wire body mirrors the
 *      picker state.
 *   3. (ACTIVE) ESTIMATE ERROR SHAPES — the server's 402 INSUFFICIENT_CREDITS
 *      and 415 RENDER_UNSUPPORTED_FORMAT envelopes both surface the honest
 *      non-blocking copy (render-status ESTIMATE_ERROR_COPY) while queueing
 *      stays available; an estimate failure is never a queue failure.
 *   4. (ACTIVE) QUEUE FLOW — click Queue → scripted POST /v1/renders answers
 *      201 with a queued RenderJob (versionId pinned SERVER-side — the
 *      request body carries no versionId; credits on display; a fresh
 *      idempotency key) → the toast lands, the dialog closes and the history
 *      drawer AUTO-OPENS (the real component behavior, render-region.tsx
 *      onQueued) with the queued row: D-11 label "Queued", the config format
 *      label, the credits chip, the cancel affordance, the toggle's active
 *      dot.
 *   5. (ACTIVE) PROGRESS + CANCEL — the drawer's ACTIVE-row poll reads a
 *      scripted running job at 40% (the server-computed percent, never
 *      re-derived) → Cancel posts the cooperative flag ("Cancelling…") → the
 *      next poll lands the terminal Cancelled row; D-11 vocabulary ONLY
 *      ("Rendering"/"Cancelled" render, "Succeeded" never does).
 *   6. (ACTIVE) COMPLETED + DOWNLOAD — a scripted completed row renders the
 *      Download action as a LINK to the verbatim signed URL with the
 *      humanized size + expiry ("46 MB", "available until Nov 9, 2099"); a
 *      failed row shows the honest RENDER_TIMEOUT copy from render-status
 *      ERROR_CODE_COPY (code label included); Esc closes the drawer.
 *   7. (ACTIVE) HUB PANEL — the M7-H history surface's additive "Renders"
 *      tab (history-view.tsx) mounts the renders hub panel (M8-J): the queue
 *      card exists, the scripted rows render with the hub testids and the
 *      same D-11 chips, the version pin resolves through the REAL versions
 *      timeline ("Snapshot v3"), progress + download + expiry + size
 *      humanize, and the honest end line renders.
 *
 * ---------------------------------------------------------------------------
 * What is scripted vs real (and why)
 * ---------------------------------------------------------------------------
 *
 * No worker process runs on the CI browser box, so EVERY renders-API leg is
 * scripted at the browser boundary (page.route — the M5 scenario-B / M7
 * scripted-gateway pattern) with schema-exact §7.3 envelopes that parse
 * against the api-client's runtime validators (RENDER_JOB_SCHEMA,
 * ESTIMATE_RESULT_SCHEMA and pageSchema in packages/api-client
 * response-schemas.ts):
 *
 *   - POST /v1/renders            → 201 Ok<RenderJob> (the queued job);
 *   - POST /v1/renders/estimate   → 200 Ok<EstimateResult>, or a 402/415 Err
 *                                   envelope (code/message/requestId);
 *   - GET  /v1/renders?projectId= → 200 Ok<Page<RenderJob>> (the history
 *                                   list, cursor end);
 *   - GET  /v1/renders/:id        → 200 Ok<RenderJob> (the ACTIVE-row poll);
 *   - POST /v1/renders/:id/cancel → 200 Ok<RenderJob> (cancelRequested).
 *
 * The REAL queue → render → settle → download journeys (real worker, real
 * effectcraft-cli, real ledger) are proven at the GATEWAY level by
 * services/gateway/tests/render-e2e.test.ts (M8-L) — this spec drives the UI.
 * Everything else here is REAL: the better-auth sign-in, the editor wasm
 * boot, the render region's lazy workspace+project scope resolution (/v1/me
 * + /v1/projects through the real gateway — the seed's project feeds the
 * scripted wire), the lease, and the hub's version-pin resolution
 * (GET /v1/projects/:id/versions against the real timeline).
 *
 * ---------------------------------------------------------------------------
 * Determinism contract
 * ---------------------------------------------------------------------------
 *
 * - Boot: the README recipe (seeded demo user → real /sign-in → the real
 *   editor wasm opening the staged `.ecproj` fixture); the dialog's comp
 *   prefill reads the fixture comp "Main" (1920×1080, ~5 s) through the real
 *   bridge. Sign-in is the M4/M5/M7 primary (README §6).
 * - Every scripted route installs BEFORE the journey's page.goto (the house
 *   rule; the render region is dormant until a surface opens, so nothing
 *   renders-side reads at editor mount — installed first anyway).
 * - ROUTE-MATCHING NOTE: Playwright glob patterns anchor at the END of the
 *   full URL (query string included), so the query-stringed history list is
 *   matched with a REGEX while the query-less routes use exact-path globs.
 * - The estimate route registers LAST (Playwright serves the most recently
 *   registered matching route first) because the estimate path also matches
 *   the per-id glob; every handler method-guards with route.fallback, the
 *   Playwright docs' canonical dispatcher pattern.
 * - The pending-cancel ladder is reversion-proof: after the cancel POST the
 *   poll answers "running + cancelRequested" for one beat, then "cancelled"
 *   — even if a poll beat raced the click, the "Cancelling…" state is stable
 *   before the terminal row lands (never a timing flash).
 * - Unique row ids per test (Date.now stamps); ZERO real DB rows are written
 *   by this spec (every renders mutation is scripted at the boundary), so
 *   re-runs against a long-lived CI database stay clean.
 * - expiresAt pins to 2099 so the humanized retention copy stays
 *   "available until" against any CI clock; createdAt pins to a fixed UTC
 *   instant so the humanized stamps never drift.
 * - The estimate debounce is re-baselined after the mount generation settles
 *   (a grace > the 400 ms debounce), so "exactly one re-estimate" counts
 *   input changes, never mount-time seeding races.
 *
 * ---------------------------------------------------------------------------
 * testid map driven by this spec (drift detector — every id verified against
 * the source when written)
 * ---------------------------------------------------------------------------
 *
 *   render-button, render-history-toggle (+ data-active),       render-region.tsx
 *   render-history-active-dot, render-toast
 *   render-dialog, render-comp, render-range-from,             render-dialog.tsx
 *   render-range-to, render-framerate (NOT "render-fps"),
 *   render-range-error, render-framerate-error,
 *   render-format-<mp4|png-seq> (segments carry data-active),
 *   render-resolution-<full|half|quarter>, render-quality-<draft|good|best>,
 *   render-size-readout, render-estimate (+ data-loading/data-error),
 *   render-estimate-error, render-estimate-min, render-queue-error,
 *   render-billing-link, render-cancel-button, render-queue-button
 *   render-history-layer, render-history-drawer (+ data-open), render-history-drawer.tsx
 *   render-history-header, render-history-title, render-history-list,
 *   render-history-close, render-row-<id> (+ data-status),
 *   render-row-<id>-status, render-row-<id>-credits,
 *   render-row-<id>-progress, render-row-<id>-error,
 *   render-row-<id>-download, render-row-<id>-meta,
 *   render-row-<id>-cancelling, render-row-<id>-cancel
 *   history-view, history-tab-renders, history-panel-renders    history-view.tsx
 *   renders-hub-panel, renders-hub-queue, renders-hub-queue-button,
 *   renders-hub-list-note, renders-hub-list, renders-hub-end,
 *   renders-hub-row-<id> (+ data-status),                       renders-panel.tsx
 *   renders-hub-row-<id>-{status,format,credits,created,progress,
 *   error,version,expires,size,download,cancel}
 *   editor-host (+ data-editor-phase), editor-iframe,          editor-host.tsx
 *   chat-layer, chat-header                                    header.tsx
 *   #sign-in-email, #sign-in-password                          auth/sign-in-form.tsx
 *
 * Copy strings asserted verbatim (single source: the components):
 *   "MP4 (H.264)", "PNG sequence" (@studio/config RENDER_FORMATS labels),
 *   "1920 × 1080 px requested", "The range end must not be before its start.",
 *   "Could not load the estimate. You can still queue the render — credits
 *   are only charged once it completes.", "Credits are charged only when the
 *   render completes.", "Render queued — Main is in Render history.",
 *   "Render history", "Queued", "Rendering", "Completed", "Failed",
 *   "Cancelled", "Cancelling…", "40% · 120/300 frames",
 *   "The render ran past the time limit and was stopped. Try a shorter range
 *   or a lower resolution. (RENDER_TIMEOUT)", "46 MB",
 *   "available until Nov 9, 2099", "Every final output queued for this
 *   project, newest first.", "120 of 300 frames · 40%", "Snapshot v3",
 *   "Available until Nov 9, 2099", "That's every render so far." (the hub
 *   end line carries a typographic apostrophe, matched verbatim below).
 */

import { type Page, expect, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Seeded world (packages/db/scripts/seed.ts — e2e/README.md §2)
// ---------------------------------------------------------------------------

/** The seed's demo login (dev fixture credentials, never production). */
const SEEDED_EMAIL = "demo@studio.test";
const SEEDED_PASSWORD = "demo-password-12345";

/** `/w/[slug]/editor` and `/w/[slug]/history` for the seeded project. */
const SEEDED_EDITOR_PATH = "/w/demo-project/editor";
const SEEDED_HISTORY_PATH = "/w/demo-project/history";

/** The seed's project display name (prj_demo, slug "demo-project"). */
const SEEDED_PROJECT_NAME = "Demo Project";

/** The seed's immutable ids the scripted wire pins (README §2 table). */
const SEEDED_PROJECT_ID = "prj_demo";
const SEEDED_CURRENT_VERSION_ID = "ver_demo_3";

/** The staged fixture comp (README §3): 1920×1080, ~5 s, named "Main". */
const SEEDED_COMP_NAME = "Main";

/** Wasm boot + manifest → project download → file.open + the chat bridge. */
const EDITOR_OPEN_TIMEOUT_MS = 120_000;
/** Second bridge attach (chat layer) after the editor reaches "open". */
const CHAT_MOUNT_TIMEOUT_MS = 30_000;
/** A generous bound for one scripted wire round-trip cycle to settle. */
const RUN_SETTLE_TIMEOUT_MS = 30_000;
/** The dialog's live-estimate debounce (render-dialog.tsx ESTIMATE_DEBOUNCE_MS). */
const ESTIMATE_DEBOUNCE_MS = 400;
/** Grace > the debounce: any mount-time estimate generation has fired. */
const ESTIMATE_SETTLE_GRACE_MS = ESTIMATE_DEBOUNCE_MS + 250;

/**
 * The honest estimate-failure copy (render-status.ts ESTIMATE_ERROR_COPY) —
 * the dialog is code-agnostic BY DESIGN: any typed error maps to this one
 * non-blocking line, because the estimate never gates queueing.
 */
const ESTIMATE_ERROR_COPY =
  "Could not load the estimate. You can still queue the render — credits are only charged once it completes.";

// ---------------------------------------------------------------------------
// Helpers — boot (the M4/M5/M7 recipe, mirrored from m7-collab.spec.ts)
// ---------------------------------------------------------------------------

/**
 * Sign the seeded demo user in through the REAL /sign-in form (better-auth
 * email+password → session cookie) and land on `nextPath` — the M4/M5/M7
 * recipe's `?next=` round-trip.
 */
async function signIn(page: Page, nextPath: string): Promise<void> {
  await page.goto(`/sign-in?next=${encodeURIComponent(nextPath)}`);
  await page.locator("#sign-in-email").fill(SEEDED_EMAIL);
  await page.locator("#sign-in-password").fill(SEEDED_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(`**${nextPath}`);
}

/**
 * Sign in and land on the seeded project's editor with the chat overlay
 * mounted (identical to e2e/chat.spec.ts + the M5/M7 specs). Scripted-gateway
 * routes for THIS page must be installed BEFORE the call.
 */
async function openSeededEditor(page: Page): Promise<void> {
  await signIn(page, SEEDED_EDITOR_PATH);

  await expect(page.getByTestId("editor-host")).toHaveAttribute("data-editor-phase", "open", {
    timeout: EDITOR_OPEN_TIMEOUT_MS,
  });
  await expect(page.getByTestId("editor-iframe")).toBeVisible();
  await expect(page.getByTestId("chat-layer")).toBeVisible({ timeout: CHAT_MOUNT_TIMEOUT_MS });
  await expect(page.getByTestId("chat-header")).toBeVisible();
}

/** True when the page's focus sits inside the `[data-testid=testId]` element. */
async function focusIsInside(page: Page, testId: string): Promise<boolean> {
  return page.evaluate((id) => {
    const active = document.activeElement;
    return active !== null && active.closest(`[data-testid="${id}"]`) !== null;
  }, testId);
}

// ---------------------------------------------------------------------------
// Wire helpers — schema-exact §7.3 envelopes (packages/contracts envelope.ts)
// ---------------------------------------------------------------------------

/** One §7.3 success envelope as a route.fulfill payload. */
function okEnvelope(data: unknown): { status: number; contentType: string; body: string } {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data }),
  };
}

/** A 201 success envelope (the gateway's queue status, routes/renders.ts). */
function createdEnvelope(data: unknown): { status: number; contentType: string; body: string } {
  return { ...okEnvelope(data), status: 201 };
}

/** One §7.3 failure envelope (code/message/retryable/requestId, ERR shape). */
function errEnvelope(
  status: number,
  code: string,
  message: string,
): { status: number; contentType: string; body: string } {
  return {
    status,
    contentType: "application/json",
    body: JSON.stringify({
      error: { code, message, retryable: false, requestId: `req-m8e2e-${code.toLowerCase()}` },
    }),
  };
}

/**
 * One RenderJob v2 on the wire — the full 19-field shape (contracts
 * routes/renders.ts RenderJob; the api-client RENDER_JOB_SCHEMA parses it
 * field-by-field). D-11 statuses only; `credits` is a whole-credit DISPLAY
 * number (D-12); `versionId` is the SERVER-pinned snapshot (ver_demo_3 — the
 * seed's current version, so the hub resolves "Snapshot v3" through the REAL
 * timeline).
 */
function renderJob(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "rnd_m8e2e_unknown",
    projectId: SEEDED_PROJECT_ID,
    compId: SEEDED_COMP_NAME,
    versionId: SEEDED_CURRENT_VERSION_ID,
    format: "mp4",
    settings: {
      timeFrom: 0,
      timeTo: 5,
      frameRate: 29.97,
      quality: "good",
      width: 1920,
      height: 1080,
    },
    status: "queued",
    cancelRequested: false,
    progress: { framesDone: 0, framesTotal: 0, percent: 0 },
    credits: 5,
    resultUrl: null,
    error: null,
    errorCode: null,
    sizeBytes: null,
    createdBy: "usr_demo",
    createdAt: "2026-10-26T09:48:00.000Z",
    startedAt: null,
    completedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

/** Scripted EstimateResult values keyed to the dialog's request body. */
const ESTIMATE_CREDITS_BY_QUALITY: Readonly<Record<string, number>> = {
  draft: 2.5,
  good: 5,
  best: 9.5,
};

/**
 * The estimate answer for one dialog request — the numbers visibly key to
 * the picker state (quality → credits; format → output seconds), so the
 * re-estimate is observable in the DOM, and the echo fields stay
 * schema-exact (ESTIMATE_RESULT_SCHEMA: format + quality enums).
 */
function estimateFor(body: Record<string, unknown>): {
  status: number;
  contentType: string;
  body: string;
} {
  const settings = (body.settings ?? {}) as Record<string, unknown>;
  const quality =
    typeof settings.quality === "string" && settings.quality in ESTIMATE_CREDITS_BY_QUALITY
      ? settings.quality
      : "good";
  const format = body.format === "png-seq" ? "png-seq" : "mp4";
  return okEnvelope({
    credits: ESTIMATE_CREDITS_BY_QUALITY[quality],
    outputSeconds: format === "png-seq" ? 60 : 10,
    longEdgePx: 1920,
    format,
    quality,
    minApplied: false,
  });
}

// ---------------------------------------------------------------------------
// The scripted renders wire (page.route — installed BEFORE every goto)
// ---------------------------------------------------------------------------

/** The 402/415 estimate error shapes the gateway catalog pins (errors.ts). */
const ESTIMATE_ERROR_SHAPES: ReadonlyArray<{
  readonly status: number;
  readonly code: string;
  readonly message: string;
}> = [
  { status: 402, code: "INSUFFICIENT_CREDITS", message: "Not enough credits for this render." },
  {
    status: 415,
    code: "RENDER_UNSUPPORTED_FORMAT",
    message: "That format is not available yet.",
  },
];

/**
 * Scripts `POST /v1/renders/estimate`. The responder receives the parsed
 * request body. REGISTER THIS LAST among the render routes — the estimate
 * path also matches the per-id glob and Playwright serves the most recently
 * registered matching route first.
 */
async function installScriptedEstimate(
  page: Page,
  respond: (body: Record<string, unknown>) => { status: number; contentType: string; body: string },
): Promise<{
  readonly bodies: Record<string, unknown>[];
  readonly keyHeaders: (string | null)[];
}> {
  const bodies: Record<string, unknown>[] = [];
  const keyHeaders: (string | null)[] = [];
  await page.route("**/v1/renders/estimate", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const body = route.request().postDataJSON() as Record<string, unknown>;
    bodies.push(body);
    keyHeaders.push(route.request().headers()["idempotency-key"] ?? null);
    const answer = respond(body);
    await route.fulfill(answer);
  });
  return { bodies, keyHeaders };
}

/**
 * The scripted renders surface. Route installation ORDER matters (later
 * registrations win in Playwright): the per-id GET glob registers BEFORE the
 * estimate route (installed separately, last), and every handler guards its
 * HTTP method with `route.fallback()` so a mismatched request defers to the
 * other matching handlers.
 *
 * The history list route matches with a REGEX: Playwright glob patterns
 * anchor at the end of the FULL URL (query string included), so a glob can
 * never catch `GET /v1/renders?projectId=…`.
 */
async function installScriptedRenders(
  page: Page,
  world: {
    /** GET list rows — re-evaluated per request (may be mutated by onCreate). */
    readonly rows: () => Record<string, unknown>[];
    /** POST /v1/renders → the 201 queued job (receives the parsed body). */
    readonly onCreate?: (body: Record<string, unknown>) => Record<string, unknown>;
    /** GET /v1/renders/:id — the ACTIVE-row poll answer. */
    readonly getFor?: (id: string) => Record<string, unknown>;
    /** POST /v1/renders/:id/cancel — the cancelRequested row. */
    readonly onCancel?: (id: string) => Record<string, unknown>;
  },
): Promise<{
  readonly createBodies: Record<string, unknown>[];
  readonly createKeyHeaders: (string | null)[];
  readonly listProjectIds: (string | null)[];
  readonly cancelKeyHeaders: (string | null)[];
}> {
  const createBodies: Record<string, unknown>[] = [];
  const createKeyHeaders: (string | null)[] = [];
  const listProjectIds: (string | null)[] = [];
  const cancelKeyHeaders: (string | null)[] = [];

  // POST /v1/renders — the queue mutation (no query string; glob is exact).
  if (world.onCreate !== undefined) {
    const onCreate = world.onCreate;
    await page.route("**/v1/renders", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      const body = route.request().postDataJSON() as Record<string, unknown>;
      createBodies.push(body);
      createKeyHeaders.push(route.request().headers()["idempotency-key"] ?? null);
      await route.fulfill(createdEnvelope(onCreate(body)));
    });
  }

  // GET /v1/renders?projectId=… — the history list (regex: see the docblock).
  await page.route(/\/v1\/renders\?/, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    listProjectIds.push(new URL(route.request().url()).searchParams.get("projectId"));
    await route.fulfill(okEnvelope({ items: world.rows(), nextCursor: null }));
  });

  // GET /v1/renders/:id — the drawer's ACTIVE-row poll.
  if (world.getFor !== undefined) {
    const getFor = world.getFor;
    await page.route("**/v1/renders/*", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      const id = new URL(route.request().url()).pathname.split("/").pop() ?? "";
      await route.fulfill(okEnvelope(getFor(id)));
    });
  }

  // POST /v1/renders/:id/cancel — the cooperative cancel.
  if (world.onCancel !== undefined) {
    const onCancel = world.onCancel;
    await page.route("**/v1/renders/*/cancel", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      const segments = new URL(route.request().url()).pathname.split("/");
      const id = segments.at(-2) ?? "";
      cancelKeyHeaders.push(route.request().headers()["idempotency-key"] ?? null);
      await route.fulfill(okEnvelope(onCancel(id)));
    });
  }

  return { createBodies, createKeyHeaders, listProjectIds, cancelKeyHeaders };
}

/** Boots the editor and opens the dialog from the chat header's Render entry. */
async function openRenderDialog(page: Page): Promise<void> {
  await openSeededEditor(page);
  await page.getByTestId("render-button").click();
  await expect(page.getByTestId("render-dialog")).toBeVisible();
}

/** Waits for the good-quality estimate line (the comp + scope landed signal). */
async function waitForGoodEstimate(page: Page): Promise<void> {
  await expect(page.getByTestId("render-estimate")).toContainText(
    "≈ 5.00 credits · 10 s output · 1920 px long edge",
    { timeout: RUN_SETTLE_TIMEOUT_MS },
  );
}

// ---------------------------------------------------------------------------
// M8 task 2 — the dialog: format gate, prefill, Esc/focus (D-2 + D-18)
// ---------------------------------------------------------------------------

test.describe("M8 render dialog — the chat-header entry, the D-2 format gate", () => {
  test("opens from the header: live comp prefill, exactly MP4 + PNG sequence, honest readouts, Esc closes", async ({
    page,
  }) => {
    // The dialog's mount estimate fires once the comp + scope land — script
    // it so the journey stays fully deterministic.
    await installScriptedEstimate(page, estimateFor);
    await openRenderDialog(page);

    const dialog = page.getByTestId("render-dialog");
    await expect(dialog).toContainText(
      "Queue a cloud render of the current composition. The editor keeps working while it runs.",
    );
    // The live comp from the bridge (the fixture project's comp).
    await expect(page.getByTestId("render-comp")).toContainText(SEEDED_COMP_NAME);
    // D-18: the portal never blocks the editor behind it.
    await expect(page.getByTestId("editor-iframe")).toBeVisible();

    // FORMAT — D-2: exactly the two enabled rows, config labels, mp4 active;
    // the reserved formats are ABSENT (never shown-disabled).
    await expect(dialog.locator('[data-testid^="render-format-"]')).toHaveCount(2);
    await expect(page.getByTestId("render-format-mp4")).toHaveText("MP4 (H.264)");
    await expect(page.getByTestId("render-format-mp4")).toHaveAttribute("data-active", "true");
    await expect(page.getByTestId("render-format-png-seq")).toHaveText("PNG sequence");
    for (const reserved of ["prores", "gif", "wav"]) {
      await expect(page.getByTestId(`render-format-${reserved}`)).toHaveCount(0);
    }

    // RESOLUTION + QUALITY ladders + the honest px readout (the comp's
    // native 1920×1080 at the default Full tier).
    await expect(dialog.locator('[data-testid^="render-resolution-"]')).toHaveCount(3);
    await expect(page.getByTestId("render-resolution-full")).toHaveText("Full");
    await expect(dialog.locator('[data-testid^="render-quality-"]')).toHaveCount(3);
    await expect(page.getByTestId("render-quality-good")).toHaveText("Good");
    await expect(page.getByTestId("render-quality-good")).toHaveAttribute("data-active", "true");
    await expect(page.getByTestId("render-size-readout")).toContainText("1920 × 1080 px requested");

    // The range prefills from the comp (work area → duration), inputs live.
    await expect(page.getByTestId("render-range-from")).toBeEnabled();
    await expect(page.getByTestId("render-range-from")).toHaveValue("0");
    await expect(page.getByTestId("render-range-to")).not.toHaveValue("");
    await expect(page.getByTestId("render-framerate")).toBeEnabled();

    // Inline range honesty (the wire's own refine, client-side): an inverted
    // range explains itself and disables queueing — no blind submit.
    await page.getByTestId("render-range-from").fill("4");
    await page.getByTestId("render-range-to").fill("2");
    await expect(page.getByTestId("render-range-error")).toHaveText(
      "The range end must not be before its start.",
    );
    await expect(page.getByTestId("render-queue-button")).toBeDisabled();

    // Focus trap (the house dialog pin): focus placed inside the portal
    // STAYS inside it across Tab cycles.
    await page.getByTestId("render-range-from").click();
    await expect(page.getByTestId("render-range-from")).toBeFocused();
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press("Tab");
    }
    expect(await focusIsInside(page, "render-dialog")).toBe(true);

    // ESC closes (Radix primitive); the editor never lost a frame.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("render-dialog")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// M8 task 2 — the live estimate (debounced, server-priced, non-blocking)
// ---------------------------------------------------------------------------

test.describe("M8 live estimate — debounced, keyed to the inputs, pure read", () => {
  test("shows credits + output seconds from the scripted server; one settings change → exactly one re-estimate", async ({
    page,
  }) => {
    const probe = await installScriptedEstimate(page, estimateFor);
    await openRenderDialog(page);

    await waitForGoodEstimate(page);
    // minApplied false → the minimum-charge hint is absent (honest).
    await expect(page.getByTestId("render-estimate-min")).toHaveCount(0);
    // The charge-on-completion law rides every estimate.
    await expect(page.getByTestId("render-estimate")).toContainText(
      "Credits are charged only when the render completes.",
    );

    // Let any mount-time estimate generation settle (grace > the 400 ms
    // debounce absorbs the comp-prefill seeding), then re-baseline.
    await page.waitForTimeout(ESTIMATE_SETTLE_GRACE_MS);
    const baseline = probe.bodies.length;
    expect(baseline).toBeGreaterThanOrEqual(1);

    // ONE settings change → exactly ONE re-estimate after the debounce —
    // never a request storm over input changes.
    await page.getByTestId("render-quality-best").click();
    await expect(page.getByTestId("render-estimate")).toContainText(
      "≈ 9.50 credits · 10 s output · 1920 px long edge",
      { timeout: RUN_SETTLE_TIMEOUT_MS },
    );
    expect(probe.bodies.length).toBe(baseline + 1);
    await page.waitForTimeout(ESTIMATE_SETTLE_GRACE_MS);
    expect(probe.bodies.length).toBe(baseline + 1);

    // A PURE READ (contracts): no Idempotency-Key header anywhere, and the
    // body mirrors the dialog's picked state (comp, format, quality).
    expect(probe.keyHeaders.length).toBeGreaterThanOrEqual(1);
    expect(probe.keyHeaders[0]).toBeNull();
    const first = probe.bodies[0] ?? {};
    expect(first.compId).toBe(SEEDED_COMP_NAME);
    expect(first.projectId).toBe(SEEDED_PROJECT_ID);
    expect(first.format).toBe("mp4");
    const last = probe.bodies[probe.bodies.length - 1] ?? {};
    const lastSettings = (last.settings ?? {}) as Record<string, unknown>;
    expect(lastSettings.quality).toBe("best");
  });

  test("402 INSUFFICIENT_CREDITS then 415 RENDER_UNSUPPORTED_FORMAT both surface the honest copy; queueing stays available", async ({
    page,
  }) => {
    // Both scripted error shapes are §7.3-exact Err envelopes — the dialog's
    // estimate arm is code-agnostic BY DESIGN (render-dialog.tsx maps every
    // rejection to the one honest non-blocking line), which is exactly what
    // the D-2/§8.8 copy pins here.
    const servedCodes: string[] = [];
    let servedCalls = 0;
    await installScriptedEstimate(page, () => {
      const shape = ESTIMATE_ERROR_SHAPES[Math.min(servedCalls, ESTIMATE_ERROR_SHAPES.length - 1)];
      servedCalls += 1;
      servedCodes.push(shape.code);
      return errEnvelope(shape.status, shape.code, shape.message);
    });
    await openRenderDialog(page);

    // The first estimate (402) → the honest copy, flagged as an error.
    await expect(page.getByTestId("render-estimate-error")).toHaveText(ESTIMATE_ERROR_COPY, {
      timeout: RUN_SETTLE_TIMEOUT_MS,
    });
    await expect(page.getByTestId("render-estimate")).toHaveAttribute("data-error", "true");

    // Non-blocking: the failure never gates queueing, and it is NOT a queue
    // error (the queue banner stays absent).
    await expect(page.getByTestId("render-queue-button")).toBeEnabled();
    await expect(page.getByTestId("render-queue-error")).toHaveCount(0);

    // The second scripted shape (415) on the next input change — the same
    // honest copy, still non-blocking.
    await page.getByTestId("render-quality-best").click();
    await expect.poll(() => servedCalls, { timeout: RUN_SETTLE_TIMEOUT_MS }).toBe(2);
    expect(servedCodes).toEqual(["INSUFFICIENT_CREDITS", "RENDER_UNSUPPORTED_FORMAT"]);
    await expect(page.getByTestId("render-estimate-error")).toHaveText(ESTIMATE_ERROR_COPY);
    await expect(page.getByTestId("render-queue-button")).toBeEnabled();
    await expect(page.getByTestId("render-queue-error")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// M8 task 2 — queue + history over the editor (D-11 vocabulary everywhere)
// ---------------------------------------------------------------------------

test.describe("M8 queue + history — the editor journey", () => {
  test("Queue → 201 RenderJob (queued, version pinned server-side, credits display) → the drawer auto-opens with the row", async ({
    page,
  }) => {
    const renderId = `rnd_m8e2e_q_${Date.now().toString(36)}`;
    const rows: Record<string, unknown>[] = [];
    const probe = await installScriptedRenders(page, {
      rows: () => [...rows],
      onCreate: (body) => {
        const job = renderJob({
          id: renderId,
          compId: body.compId,
          format: body.format,
          status: "queued",
          credits: 5,
        });
        rows.push(job);
        return job;
      },
      // The queued row is ACTIVE → the drawer polls it; stable-queued answer.
      getFor: (id) => rows.find((row) => row.id === id) ?? renderJob({ id }),
    });
    await installScriptedEstimate(page, estimateFor); // LAST: wins its own path
    await openRenderDialog(page);

    // The estimate line proves comp + scope landed (the Queue gate).
    await waitForGoodEstimate(page);
    await page.getByTestId("render-queue-button").click();

    // The real component behavior: toast + dialog closed + drawer AUTO-OPEN.
    await expect(page.getByTestId("render-toast")).toHaveText(
      `Render queued — ${SEEDED_COMP_NAME} is in Render history.`,
      { timeout: RUN_SETTLE_TIMEOUT_MS },
    );
    await expect(page.getByTestId("render-dialog")).toHaveCount(0);
    const drawer = page.getByTestId("render-history-drawer");
    await expect(drawer).toBeVisible({ timeout: RUN_SETTLE_TIMEOUT_MS });
    await expect(drawer).toHaveAttribute("data-open", "true");
    await expect(page.getByTestId("render-history-title")).toHaveText("Render history");
    // The REAL scope resolver's project chip (never an id — law #1).
    await expect(page.getByTestId("render-history-header")).toContainText(SEEDED_PROJECT_NAME);

    // The queued row: D-11 label, config format label, credits display,
    // comp, and the cancel affordance (queued is cancellable).
    const row = page.getByTestId(`render-row-${renderId}`);
    await expect(row).toBeVisible({ timeout: RUN_SETTLE_TIMEOUT_MS });
    await expect(row).toHaveAttribute("data-status", "queued");
    await expect(page.getByTestId(`render-row-${renderId}-status`)).toHaveText("Queued");
    await expect(page.getByTestId(`render-row-${renderId}-credits`)).toHaveText("5.00 credits");
    await expect(row).toContainText("MP4 (H.264)");
    await expect(row).toContainText(SEEDED_COMP_NAME);
    await expect(page.getByTestId(`render-row-${renderId}-cancel`)).toBeVisible();
    // The header toggle's active badge (one ACTIVE render).
    await expect(page.getByTestId("render-history-active-dot")).toBeVisible();

    // WIRE PINS — the queue request is schema-honest: the REAL scope fed it
    // (projectId from the resolver), the version is pinned SERVER-side (the
    // body carries NO versionId — contracts QUEUE_RENDER_SCHEMA), a fresh
    // idempotency key rides the body, and the §7.2 header key is present.
    expect(probe.createBodies).toHaveLength(1);
    const body = probe.createBodies[0] ?? {};
    expect(body.projectId).toBe(SEEDED_PROJECT_ID);
    expect(body.compId).toBe(SEEDED_COMP_NAME);
    expect(body.format).toBe("mp4");
    expect("versionId" in body).toBe(false);
    const key = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    expect(key.length).toBeGreaterThanOrEqual(8);
    const settings = (body.settings ?? {}) as Record<string, unknown>;
    expect(settings.quality).toBe("good");
    expect(settings.width).toBe(1920);
    expect(settings.height).toBe(1080);
    expect(settings.timeFrom).toBe(0);
    expect(typeof settings.timeTo === "number" && settings.timeTo >= 5).toBe(true);
    // §7.2: the mutation rides an Idempotency-Key header as well as the body key.
    expect(probe.createKeyHeaders).toHaveLength(1);
    expect(typeof probe.createKeyHeaders[0] === "string").toBe(true);
    // The drawer's list read scoped to the REAL project id.
    expect(probe.listProjectIds.at(-1) ?? "").toBe(SEEDED_PROJECT_ID);
  });

  test("poll: running 40% progress → Cancel → the pending state → cancelled (D-11 vocabulary only)", async ({
    page,
  }) => {
    const renderId = `rnd_m8e2e_p_${Date.now().toString(36)}`;
    const rows: Record<string, unknown>[] = [];
    let cancelRequested = false;
    let postCancelPolls = 0;
    const queuedJob = () => renderJob({ id: renderId, status: "queued", credits: 5 });
    const runningJob = (cancel: boolean) =>
      renderJob({
        id: renderId,
        status: "running",
        cancelRequested: cancel,
        credits: 5,
        progress: { framesDone: 120, framesTotal: 300, percent: 40 },
        startedAt: "2026-10-26T09:47:30.000Z",
      });
    const cancelledJob = () =>
      renderJob({
        id: renderId,
        status: "cancelled",
        cancelRequested: true,
        credits: 5,
        completedAt: "2026-10-26T09:49:12.000Z",
      });
    const probe = await installScriptedRenders(page, {
      rows: () => [...rows],
      onCreate: () => {
        const job = queuedJob();
        rows.push(job);
        return job;
      },
      // The reversion-proof pending ladder: pre-cancel polls answer the
      // running 40% snapshot; the first post-cancel poll keeps the honest
      // "cancelRequested" pending state; the next one terminal-flips.
      getFor: () => {
        if (!cancelRequested) return runningJob(false);
        postCancelPolls += 1;
        return postCancelPolls >= 2 ? cancelledJob() : runningJob(true);
      },
      onCancel: () => {
        cancelRequested = true;
        return runningJob(true);
      },
    });
    await installScriptedEstimate(page, estimateFor); // LAST: wins its own path
    await openRenderDialog(page);

    await waitForGoodEstimate(page);
    await page.getByTestId("render-queue-button").click();
    const row = page.getByTestId(`render-row-${renderId}`);
    await expect(row).toBeVisible({ timeout: RUN_SETTLE_TIMEOUT_MS });

    // POLL — the drawer's first ACTIVE beat reports the running 40% snapshot
    // (the server-computed percent + frames, never re-derived by the UI).
    await expect(row).toHaveAttribute("data-status", "running", {
      timeout: RUN_SETTLE_TIMEOUT_MS,
    });
    await expect(page.getByTestId(`render-row-${renderId}-status`)).toHaveText("Rendering");
    const progress = page.getByTestId(`render-row-${renderId}-progress`);
    await expect(progress).toBeVisible();
    await expect(progress.locator('[role="progressbar"]')).toHaveAttribute("aria-valuenow", "40");
    await expect(progress).toContainText("40% · 120/300 frames");

    // CANCEL — cooperative: the server raises the flag, the row shows the
    // honest pending state (stable across poll beats — see the ladder).
    await page.getByTestId(`render-row-${renderId}-cancel`).click();
    await expect(page.getByTestId(`render-row-${renderId}-cancelling`)).toHaveText("Cancelling…", {
      timeout: RUN_SETTLE_TIMEOUT_MS,
    });
    // §7.2: the cancel mutation rides an Idempotency-Key header.
    expect(probe.cancelKeyHeaders).toHaveLength(1);
    expect(typeof probe.cancelKeyHeaders[0] === "string").toBe(true);

    // The next poll lands the terminal state — the final status chip.
    await expect(row).toHaveAttribute("data-status", "cancelled", {
      timeout: RUN_SETTLE_TIMEOUT_MS,
    });
    await expect(page.getByTestId(`render-row-${renderId}-status`)).toHaveText("Cancelled");
    // Terminal rows carry no cancel affordance and drop the toggle badge.
    await expect(page.getByTestId(`render-row-${renderId}-cancel`)).toHaveCount(0);
    await expect(page.getByTestId("render-history-active-dot")).toHaveCount(0, {
      timeout: RUN_SETTLE_TIMEOUT_MS,
    });

    // D-11 vocabulary ONLY — the DB words render; "Succeeded" never does.
    await expect(page.getByText("Succeeded")).toHaveCount(0);
  });

  test("history drawer: the completed row links the signed URL with humanized size + expiry; the failed row shows the honest RENDER_TIMEOUT copy", async ({
    page,
  }) => {
    const stamp = Date.now().toString(36);
    const doneId = `rnd_m8e2e_done_${stamp}`;
    const failId = `rnd_m8e2e_fail_${stamp}`;
    // 2099 keeps the retention copy "available until" on any CI clock.
    const signedUrl =
      "https://storage.e2e.local/workspaces/org_demo/renders/e2e-signed-result.mp4?X-Amz-Signature=e2e";
    const done = renderJob({
      id: doneId,
      status: "completed",
      credits: 5,
      resultUrl: signedUrl,
      sizeBytes: 48_234_500,
      expiresAt: "2099-11-09T12:00:00.000Z",
      completedAt: "2026-10-26T09:49:12.000Z",
    });
    const failed = renderJob({
      id: failId,
      status: "failed",
      credits: 5,
      errorCode: "RENDER_TIMEOUT",
      error: "The render worker stopped this job at the time limit.",
      completedAt: "2026-10-26T09:49:12.000Z",
    });
    await installScriptedRenders(page, { rows: () => [done, failed] });

    // Open the drawer from the header toggle (the non-queue entry).
    await openSeededEditor(page);
    await page.getByTestId("render-history-toggle").click();
    const drawer = page.getByTestId("render-history-drawer");
    await expect(drawer).toBeVisible({ timeout: RUN_SETTLE_TIMEOUT_MS });
    await expect(page.getByTestId("render-history-header")).toContainText(SEEDED_PROJECT_NAME);

    // COMPLETED — the Download action is a LINK to the verbatim signed URL.
    const doneRow = page.getByTestId(`render-row-${doneId}`);
    await expect(doneRow).toBeVisible({ timeout: RUN_SETTLE_TIMEOUT_MS });
    await expect(doneRow).toHaveAttribute("data-status", "completed");
    await expect(page.getByTestId(`render-row-${doneId}-status`)).toHaveText("Completed");
    const download = page.getByTestId(`render-row-${doneId}-download`);
    await expect(download).toHaveAttribute("href", signedUrl);
    await expect(download).toHaveAttribute("target", "_blank");
    // sizeBytes + expiresAt humanized (render-status formatBytes/
    // formatAvailableUntil: "46 MB", "available until Nov 9, 2099").
    await expect(page.getByTestId(`render-row-${doneId}-meta`)).toContainText("46 MB");
    await expect(page.getByTestId(`render-row-${doneId}-meta`)).toContainText(
      "available until Nov 9, 2099",
    );

    // FAILED — the honest catalog copy (render-status ERROR_CODE_COPY,
    // verified verbatim) + the stable code label, never internals.
    const failRow = page.getByTestId(`render-row-${failId}`);
    await expect(failRow).toBeVisible();
    await expect(failRow).toHaveAttribute("data-status", "failed");
    await expect(page.getByTestId(`render-row-${failId}-status`)).toHaveText("Failed");
    await expect(page.getByTestId(`render-row-${failId}-error`)).toHaveText(
      "The render ran past the time limit and was stopped. Try a shorter range or a lower resolution. (RENDER_TIMEOUT)",
    );

    // D-11: Completed/Failed render — "Succeeded" never does.
    await expect(page.getByText("Succeeded")).toHaveCount(0);

    // The drawer owns its Esc (the §9 topmost-layer-first order).
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// M8 task 2 — the project-hub renders tab (the M7-H surface's additive mount)
// ---------------------------------------------------------------------------

test.describe("M8 renders hub — the /history renders tab", () => {
  test("the hub panel mounts: queue card + scripted rows with the D-11 chips, the version pin, progress + download", async ({
    page,
  }) => {
    const stamp = Date.now().toString(36);
    const runId = `rnd_m8e2e_hub_run_${stamp}`;
    const doneId = `rnd_m8e2e_hub_done_${stamp}`;
    const cancelledId = `rnd_m8e2e_hub_cancel_${stamp}`;
    const signedUrl =
      "https://storage.e2e.local/workspaces/org_demo/renders/e2e-hub-result.mp4?X-Amz-Signature=e2e";
    const runRow = renderJob({
      id: runId,
      status: "running",
      credits: 5,
      progress: { framesDone: 120, framesTotal: 300, percent: 40 },
      startedAt: "2026-10-26T09:47:30.000Z",
    });
    const doneRow = renderJob({
      id: doneId,
      status: "completed",
      credits: 5,
      resultUrl: signedUrl,
      sizeBytes: 48_234_500,
      expiresAt: "2099-11-09T12:00:00.000Z",
      completedAt: "2026-10-26T09:49:12.000Z",
    });
    const cancelledRow = renderJob({
      id: cancelledId,
      status: "cancelled",
      credits: 5,
      cancelRequested: true,
      completedAt: "2026-10-26T09:49:12.000Z",
    });
    await installScriptedRenders(page, { rows: () => [runRow, doneRow, cancelledRow] });

    // The M7-H surface: sign in and open the additive Renders tab.
    await signIn(page, SEEDED_HISTORY_PATH);
    await expect(page.getByTestId("history-view")).toBeVisible();
    await page.getByTestId("history-tab-renders").click();
    await expect(page.getByTestId("history-panel-renders")).toBeVisible();
    await expect(page.getByTestId("renders-hub-panel")).toBeVisible();

    // The queue card (the demo owner can edit → canQueue) — the queue entry
    // for OUTSIDE the editor, closed by default (no estimate fires here).
    await expect(page.getByTestId("renders-hub-queue")).toBeVisible();
    await expect(page.getByTestId("renders-hub-queue")).toContainText(
      "Queue a final export — MP4 or PNG sequence.",
    );
    await expect(page.getByTestId("renders-hub-queue-button")).toBeVisible();
    await expect(page.getByTestId("renders-hub-list-note")).toHaveText(
      "Every final output queued for this project, newest first.",
    );

    // RUNNING row — the D-11 chip, the config format label, credits display,
    // the server percent (data-percent on the progress track), the cancel
    // affordance, and the version pin resolved through the REAL timeline.
    const run = page.getByTestId(`renders-hub-row-${runId}`);
    await expect(run).toBeVisible({ timeout: RUN_SETTLE_TIMEOUT_MS });
    await expect(run).toHaveAttribute("data-status", "running");
    await expect(page.getByTestId(`renders-hub-row-${runId}-status`)).toHaveText("Rendering");
    await expect(page.getByTestId(`renders-hub-row-${runId}-format`)).toHaveText("MP4");
    await expect(page.getByTestId(`renders-hub-row-${runId}-credits`)).toContainText("5 credits");
    await expect(page.getByTestId(`renders-hub-row-${runId}-progress`)).toContainText(
      "120 of 300 frames · 40%",
    );
    await expect(
      page.getByTestId(`renders-hub-row-${runId}-progress`).locator("[data-percent]"),
    ).toHaveAttribute("data-percent", "40");
    await expect(page.getByTestId(`renders-hub-row-${runId}-version`)).toHaveText("Snapshot v3", {
      timeout: RUN_SETTLE_TIMEOUT_MS,
    });
    await expect(page.getByTestId(`renders-hub-row-${runId}-cancel`)).toBeVisible();

    // COMPLETED row — the download affordance + the hub's own humanizers
    // ("Available until …" capital-A; formatVersionBytes "46 MB") + the pin.
    await expect(page.getByTestId(`renders-hub-row-${doneId}`)).toBeVisible();
    await expect(page.getByTestId(`renders-hub-row-${doneId}-status`)).toHaveText("Completed");
    await expect(page.getByTestId(`renders-hub-row-${doneId}-download`)).toBeVisible();
    await expect(page.getByTestId(`renders-hub-row-${doneId}-expires`)).toHaveText(
      "Available until Nov 9, 2099",
    );
    await expect(page.getByTestId(`renders-hub-row-${doneId}-size`)).toHaveText("46 MB");
    await expect(page.getByTestId(`renders-hub-row-${doneId}-version`)).toHaveText("Snapshot v3");
    await expect(page.getByTestId(`renders-hub-row-${doneId}-created`)).toContainText(
      "Oct 26, 2026",
    );

    // CANCELLED row — the third D-11 chip; then the vocabulary pin.
    await expect(page.getByTestId(`renders-hub-row-${cancelledId}`)).toBeVisible();
    await expect(page.getByTestId(`renders-hub-row-${cancelledId}-status`)).toHaveText("Cancelled");
    await expect(page.getByText("Succeeded")).toHaveCount(0);

    // Fewer rows than a page → the honest end line (typographic apostrophe).
    await expect(page.getByTestId("renders-hub-end")).toHaveText("That’s every render so far.");
  });
});
