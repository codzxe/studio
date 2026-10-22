/**
 * M7 collaboration — the CI-owned Playwright specs (BUILD_PLAN §M7 tasks 1–5:
 * comments, presence, lease UX, versions/activity, the public share page).
 *
 * NEVER RUN ON THE BUILD-FLEET BOX — same class of debt as e2e/chat.spec.ts and
 * e2e/m5-agent-edits.spec.ts (M3/M4/M5 precedent): this box has no browsers and
 * no dev servers, so `@playwright/test` is NOT installed here.
 * apps/web/tsconfig.json excludes `e2e` from typecheck for exactly that reason
 * and the web vitest config never matches `e2e/*.spec.ts`; CI owns the
 * devDependency, the lockfile and the run (e2e/README.md is the boot recipe —
 * env, seed, the staged `.ecproj` fixture, the share-link fixture §10).
 *
 * ----------------------------------------------------------------------------
 * What is ACTIVE today vs WIRING-PENDING (fixme) — the honest split
 * ----------------------------------------------------------------------------
 *
 * Five journeys, all against the LIVE app (real sign-in, real editor wasm, real
 * gateway + Postgres — the seed's demo project):
 *
 *   1. (ACTIVE) Comments — the M7-F panel over the real editor: open the panel
 *      from the floating toggle, create an ANCHORED comment (the create box
 *      prefills comp "Main" + the playhead time chip from the live bridge),
 *      reply (thread depth 2), resolve (the thread leaves "Open", returns
 *      under "Resolved"/"All"), and reload the page: the anchored thread is
 *      still there — the §M7 exit criterion "comments survive reload and link
 *      to the right comp/time". Fully real: create/reply/resolve POST through
 *      the gateway and land in Postgres.
 *   2. (ACTIVE) Presence + lease — the M7-G chrome: the presence strip renders
 *      the beat's viewers (scripted-gateway presence responses — three
 *      viewers incl. the self avatar), and the lease banner renders the REAL
 *      holder state ("You have the edit lease" — the M3 session acquires the
 *      seeded project's lease on open). A second test drives the
 *      scripted-gateway lease-state matrix (the M5 spec's scenario-B
 *      page.route pattern): viewer ("Viewing — Maya Rivera is editing" +
 *      countdown) → Request edit → queued ("You're #2 in line" + Cancel
 *      request) → cancel → back to viewer.
 *   3. (ACTIVE) History — the M7-H surface at /w/demo-project/history: the
 *      seeded timeline rows (v1–v3, current badge, first-version linkage, the
 *      real structural diff), the inline label edit (real POST — the demo
 *      owner can label), the §9.3 restore dialog with its TYPED confirmation
 *      (wrong label keeps Restore disabled; "empty project" — v1's exact seed
 *      label — unlocks it; the restore creates a NEW v4 and never rewrites
 *      history), and the activity tab pagination (scripted-gateway activity
 *      pages: 25 rows → Load more → 30 → "That's the whole feed.") + the
 *      admin audit export download (real route, real payload).
 *   4. (ACTIVE) Share — the M7-I public journey at /s/:token, fully REAL
 *      thanks to the README §10 share-link fixture (the page's FIRST read —
 *      `GET /v1/share/:token` — happens server-side in the RSC route, so no
 *      browser-level scripted gateway can serve it; the fixture rows make the
 *      real gateway serve everything): the noindex meta, the password gate
 *      (wrong → the typed 401 copy, right → unlock), the guest comment submit
 *      (name/email/body → real row), the request-access form, and the
 *      "no editor for anonymous" pin — ZERO iframes and ZERO requests under
 *      /editor/ on the whole page. Plus the open link (no gate) and the
 *      §12.1 404 for an unknown-but-well-formed token.
 *   5. (ACTIVE) Read-only — the D-23 pin under a scripted lease-held state:
 *      the read-only chrome strip renders ("Viewing — Maya Rivera is
 *      editing" + countdown), the CHAT still opens and completes a full
 *      read-only run through the gate-wrapped bridge (the studio.get_context
 *      tool card reaches done — reads pass, D-23), the proposal renders with
 *      NO apply control anywhere (the host wires no apply ports in this
 *      session — see below), and the comments panel stays fully usable with
 *      the lease note + a comment posted under another member's lease
 *      (review is the point of the read-only state).
 *   6. (fixme, WIRING-PENDING) The apply-blocked half of D-23: clicking Apply
 *      while another member holds the lease must fail LOCALLY with the typed
 *      lease explanation. Written as real code against the pinned contract
 *      (lib/chat/apply.ts → ReadOnlyLeaseError → card status "failed" +
 *      plan-failed-detail naming the holder + NO retry); flip
 *      `test.fixme` → `test` when editor-host.tsx passes the ChatProvider
 *      `applyPorts` (see the test's header note — the precise blocker).
 *
 * ----------------------------------------------------------------------------
 * Determinism contract (no real network model, no real second user)
 * ----------------------------------------------------------------------------
 *
 * - Boot: the README recipe (seeded demo user → real /sign-in → real editor
 *   wasm opening the staged `.ecproj` fixture → additive collab chrome), the
 *   gateway in MOCK_MODEL=true mode. Sign-in is the M4/M5 primary (a fresh
 *   user owns no workspace — README §6).
 * - Scripted-gateway legs (page.route, the M5 scenario-B pattern) answer ONLY
 *   the surfaces the seed's single-user world cannot produce, with
 *   schema-exact §7.3 envelopes (`{ data: … }`) that parse against the
 *   api-client's runtime validators:
 *     · `POST|GET /v1/projects/:id/presence` → PRESENCE_VIEWERS (3 viewers);
 *     · `GET /v1/projects/:id/lease-state` → LEASE_STATE_RESPONSE (viewer /
 *       queued, holder "Maya Rivera" — LEASE_STATE_RESPONSE_SCHEMA);
 *     · `POST|DELETE /v1/projects/:id/lease-request` → the join/cancel
 *       outcomes (LeaseRequestResponse / LeaseRequestCancelledResponse);
 *     · `GET /v1/projects/:id/activity` → two cursor pages (Page<
 *       ActivityEntry>).
 *   Everything else (comments create/reply/resolve, versions list/diff/label/
 *   restore, audit export, share meta/manifest/comments/request-access, the
 *   chat run, the real lease acquire + heartbeat) goes to the REAL gateway.
 * - The share journey needs the README §10 fixture rows (two share_tokens:
 *   one open, one password-protected with the pinned password). Unknown-token
 *   404s, the noindex meta and the no-editor pin run against the real page.
 * - The lease-state polls happen at banner MOUNT (plus every 15 s and on
 *   window focus), and the presence beat at poller mount (plus every 120 s) —
 *   so every scripted route is installed BEFORE `page.goto`, and the
 *   scripted lease-state handler is STATEFUL (viewer → queued → viewer) to
 *   drive the request/cancel loop deterministically.
 *
 * ----------------------------------------------------------------------------
 * testid map driven by this spec (drift detector — every id verified against
 * the source when written)
 * ----------------------------------------------------------------------------
 *
 *   comments-toggle, comments-layer (+ data-open)                comments-region.tsx
 *   comments-panel, comments-header, comments-title,             comments-panel.tsx
 *   comments-project, comments-close
 *   comments-filters, comments-filter-{open,resolved,all},       comments-panel.tsx
 *   comments-comp-filter, comments-comp-menu,
 *   comments-comp-option-all, comments-comp-option-<id>
 *   comments-lease-note (+ data-holder)                          comments-panel.tsx
 *   comments-list, comments-empty, comments-load-more            comments-panel.tsx
 *   comments-composer, comments-composer-anchor,
 *   comments-composer-anchor-{comp,layer,time},                  comments-panel.tsx
 *   comments-composer-refresh, comments-composer-send
 *   comment-thread-<id>, comment-row-<id> (+ data-depth),        comments-panel.tsx
 *   comment-author-<id>, comment-body-<id>,
 *   comment-anchor-{comp,layer,time}-<id>,
 *   comment-reply-open-<id>, comment-reply-box-<id>,
 *   comment-reply-send-<id>, comment-resolve-<id>,
 *   comment-reopen-<id>, comment-resolved-<id>
 *   (inputs by aria-label: "Write a comment" / "Write a reply")
 *   presence-strip (+ data-viewer-count), presence-viewer         presence-strip.tsx
 *   (+ data-self), presence-overflow, presence-viewer-name/comp (tooltip)
 *   lease-banner (+ data-youare), lease-holder-status,            lease-banner.tsx
 *   lease-readonly-strip, lease-countdown, lease-queue-line,
 *   lease-request-button, lease-cancel-request-button
 *   history-view, history-project-name, history-open-editor,      history-view.tsx
 *   history-tabs, history-tab-{versions,activity},
 *   history-panel-{versions,activity}, audit-export-button
 *   version-timeline, timeline-list, version-row                 version-timeline.tsx
 *   (+ data-version/current/agent), version-number, version-label,
 *   version-label-edit(+button/input/save/cancel), version-author,
 *   version-linkage, version-diff(+toggle/parent), version-current-badge,
 *   version-restore, restore-dialog-title, restore-input,
 *   restore-confirm, timeline-end
 *   activity-feed, activity-row (+ data-action), activity-actor,  activity-feed.tsx
 *   activity-verb, activity-target, activity-day, activity-day-group,
 *   activity-load-more, activity-end
 *   share-page, share-header, share-project-name, share-gate,    share-review.tsx
 *   share-gate-form, share-gate-input, share-gate-submit,
 *   share-surface, share-player, share-version-label,
 *   share-player-empty, share-comments, share-comments-count,
 *   share-comment-<id>, share-comment-author, share-comment-body,
 *   share-composer(+name/email/body/submit/success),
 *   share-request-access(+email/message/submit/ok)               share-request-access.tsx
 *   not-found                                                     app/not-found.tsx
 *   editor-host (+ data-editor-phase), editor-iframe,            editor-host.tsx
 *   chat-layer, chat-header, chat-status (+ data-phase),          header.tsx
 *   chat-close-button, chat-thread-list, tool-card (+ data-tool/
 *   data-status), plan-card (+ data-status), plan-actions,
 *   plan-failed, plan-failed-detail, plan-retry                  plan-card.tsx
 *   (composer by aria-label "Message the agent")
 */

import { type Page, expect, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Seeded world (packages/db/scripts/seed.ts — e2e/README.md §Seed + §10)
// ---------------------------------------------------------------------------

/** The seed's demo login (dev fixture credentials, never production). */
const SEEDED_EMAIL = "demo@studio.test";
const SEEDED_PASSWORD = "demo-password-12345";

/** `/w/[slug]/editor` and `/w/[slug]/history` for the seeded project. */
const SEEDED_EDITOR_PATH = "/w/demo-project/editor";
const SEEDED_HISTORY_PATH = "/w/demo-project/history";

/** The seed's project display name (prj_demo, slug "demo-project"). */
const SEEDED_PROJECT_NAME = "Demo Project";

/**
 * The share-link fixture tokens (README §10) — url-safe, ≥ 16 chars, matching
 * the contracts SHARE_TOKEN_PATH_SCHEMA. The locked one's password is
 * pinned there too; both rows never expire.
 */
const SHARE_TOKEN_OPEN = "e2e-share-open-7f3d92b1c4";
const SHARE_TOKEN_LOCKED = "e2e-share-locked-2a6e8d41f9";
const SHARE_PASSWORD = "review-pass-1234";

/** Wasm boot + manifest → project download → file.open + the chat bridge. */
const EDITOR_OPEN_TIMEOUT_MS = 120_000;
/** Second/third bridge attach (chat layer, comments region) after "open". */
const CHAT_MOUNT_TIMEOUT_MS = 30_000;
/** A generous bound for one mock-model run / one real gateway mutation. */
const RUN_SETTLE_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Helpers — boot + the scripted-gateway legs (M5 scenario-B pattern)
// ---------------------------------------------------------------------------

/**
 * Sign the seeded demo user in through the REAL /sign-in form (better-auth
 * email+password → session cookie) and land on `nextPath` — the M4/M5
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
 * mounted (identical to e2e/chat.spec.ts / e2e/m5-agent-edits.spec.ts).
 * Scripted-gateway routes for THIS page must be installed BEFORE the call.
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

/** One §7.3 success envelope as a route.fulfill body. */
function okEnvelope(data: unknown): { status: number; contentType: string; body: string } {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data }),
  };
}

/** The scripted presence viewers (PRESENCE_VIEWERS_SCHEMA-exact, M7-B wire). */
function scriptedPresenceViewers(): unknown {
  return {
    viewers: [
      {
        userId: "usr_demo_self",
        displayName: "Demo User",
        compId: "Main",
        playheadTicks: 0,
        lastSeenAgoMs: 0,
        self: true,
      },
      {
        userId: "usr_maya",
        displayName: "Maya Rivera",
        compId: "Main",
        playheadTicks: null,
        lastSeenAgoMs: 2000,
        self: false,
      },
      {
        userId: "usr_pat",
        displayName: "Pat Orai",
        compId: null,
        playheadTicks: null,
        lastSeenAgoMs: 42_000,
        self: false,
      },
    ],
  };
}

/**
 * Script the presence beat/poll (`POST|GET /v1/projects/:id/presence`): every
 * beat answers with three active viewers (self first — the strip renders the
 * beat response in wire order). The REAL gateway would answer with just the
 * caller (the seed has one member); the strip's layout needs a crowd.
 */
async function installScriptedPresence(page: Page): Promise<void> {
  await page.route("**/v1/projects/*/presence", async (route) => {
    await route.fulfill(okEnvelope(scriptedPresenceViewers()));
  });
}

/** The scripted holder (LeaseStateResponse.holder — LEASE_* schemas). */
function scriptedHolder(): Record<string, unknown> {
  const now = Date.now();
  return {
    userId: "usr_maya",
    displayName: "Maya Rivera",
    acquiredAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 5 * 60_000).toISOString(),
  };
}

/**
 * The stateful scripted lease UX (the M5 spec's scenario-B pattern, mounted
 * BEFORE the goto so the banner's mount poll reads it):
 *  - `GET /v1/projects/:id/lease-state` answers "viewer" until the request
 *    lands, then "queued" (my own queue entry rides the queuedAt the scripted
 *    requestLease response pinned — the banner's position fallback), and back
 *    to "viewer" after the cancel;
 *  - `POST /v1/projects/:id/lease-request` answers the join outcome;
 *  - `DELETE /v1/projects/:id/lease-request` answers the cancel outcome.
 */
async function installScriptedLeaseFlow(page: Page): Promise<void> {
  const myQueuedAt = new Date(Date.now() - 30_000).toISOString();
  let phase: "viewer" | "queued" = "viewer";

  await page.route("**/v1/projects/*/lease-state", async (route) => {
    const state =
      phase === "queued"
        ? {
            holder: scriptedHolder(),
            queue: [
              {
                userId: "usr_sam",
                displayName: "Sam Vega",
                queuedAt: new Date(Date.now() - 90_000).toISOString(),
              },
              { userId: "usr_demo_queued", displayName: "Demo User", queuedAt: myQueuedAt },
            ],
            youAre: "queued",
            canAcquire: false,
          }
        : { holder: scriptedHolder(), queue: [], youAre: "viewer", canAcquire: false };
    await route.fulfill(okEnvelope(state));
  });

  await page.route("**/v1/projects/*/lease-request", async (route) => {
    const method = route.request().method();
    if (method === "DELETE") {
      phase = "viewer";
      await route.fulfill(okEnvelope({ cancelled: true }));
      return;
    }
    phase = "queued";
    await route.fulfill(
      okEnvelope({
        queued: true,
        position: 2,
        queueLength: 2,
        queuedAt: myQueuedAt,
        duplicate: false,
      }),
    );
  });
}

// ---------------------------------------------------------------------------
// The scripted activity pages (M7-H feed pagination — the M5 scenario-B class)
// ---------------------------------------------------------------------------

/** One schema-exact ActivityEntry (contracts routes/activity.ts). */
function activityEntry(index: number): Record<string, unknown> {
  const actors = ["Alex Chen", "Riley Diaz", "Sam Vega", "Jordan Kim"];
  const actions: ReadonlyArray<{
    action: string;
    targetType: string;
    verb: string;
    target: string;
  }> = [
    { action: "version.uploaded", targetType: "version", verb: "saved", target: "a version" },
    { action: "comment.created", targetType: "comment", verb: "left", target: "a comment" },
    {
      action: "lease.acquired",
      targetType: "project",
      verb: "started editing",
      target: "the project",
    },
    { action: "comment.resolved", targetType: "comment", verb: "resolved", target: "a comment" },
  ];
  // One UTC day → exactly one day-group header; newest-first page order.
  const created = new Date(Date.UTC(2026, 9, 26, 9, 0, 0) - index * 60_000).toISOString();
  const actor = index === 0 ? null : actors[index % actors.length];
  const entry = actions[index % actions.length];
  return {
    id: `aud_m7_p${index}`,
    projectId: "prj_demo",
    actorId: `usr_actor_${index % 4}`,
    actorName: actor,
    action: entry.action,
    targetType: entry.targetType,
    targetId: `tgt_m7_${index}`,
    createdAt: created,
  };
}

/**
 * Script the activity feed (`GET /v1/projects/:id/activity`) with TWO cursor
 * pages: 25 rows → `Load more` → 5 rows → "That's the whole feed." The real
 * audit table cannot seed > 25 deterministic rows; pagination is the point.
 */
async function installScriptedActivityPages(page: Page): Promise<void> {
  await page.route("**/v1/projects/*/activity", async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    if (cursor === null) {
      await route.fulfill(
        okEnvelope({
          items: Array.from({ length: 25 }, (_, index) => activityEntry(index)),
          nextCursor: "act-page-2",
        }),
      );
      return;
    }
    await route.fulfill(
      okEnvelope({
        items: Array.from({ length: 5 }, (_, index) => activityEntry(25 + index)),
        nextCursor: null,
      }),
    );
  });
}

// ---------------------------------------------------------------------------
// M7 task 1 — comments (BUILD_PLAN §M7 "Anchor to project/comp/layer/time;
// create, reply, resolve; filters"; exit criterion "Comments survive reload
// and link to the right comp/time")
// ---------------------------------------------------------------------------

test.describe("M7 comments — anchored threads over the real editor", () => {
  test("anchored comment: create with the prefilled anchor → reply → resolve → filters → reload persistence", async ({
    page,
  }) => {
    await openSeededEditor(page);

    // The comments panel opens from the floating toggle (M7-F). Collapse the
    // chat first so the floating chat panel never covers the toggle.
    await page.getByTestId("chat-close-button").click();
    await expect(page.getByTestId("chat-collapsed-layer")).toBeVisible();

    const toggle = page.getByTestId("comments-toggle");
    await expect(toggle).toBeVisible();
    await toggle.click();

    const panel = page.getByTestId("comments-panel");
    await expect(panel).toBeVisible();
    await expect(page.getByTestId("comments-title")).toHaveText("Comments");
    await expect(page.getByTestId("comments-project")).toContainText(SEEDED_PROJECT_NAME);

    // The create box prefills the CURRENT editor context (bridge ui.inspect →
    // comp.info): the fixture project's comp is "Main" and the playhead at
    // rest is 0 ticks → "0:00". A layer chip renders only when a layer is
    // selected — data-driven, never asserted into existence.
    const anchorBox = page.getByTestId("comments-composer-anchor");
    await expect(anchorBox).toBeVisible({ timeout: CHAT_MOUNT_TIMEOUT_MS });
    await expect(page.getByTestId("comments-composer-anchor-comp")).toContainText("Main");
    await expect(page.getByTestId("comments-composer-anchor-time")).toContainText("0:00");

    // CREATE — Enter posts from the textarea (the panel's pinned UX).
    const stamp = Date.now().toString(36);
    const rootBody = `Anchored review note ${stamp}`;
    const composer = page.getByLabel("Write a comment");
    await composer.fill(rootBody);
    await composer.press("Enter");

    // The new thread renders newest-first with the anchor chips + "You".
    const thread = page.locator('[data-testid^="comment-thread-"]').filter({ hasText: rootBody });
    await expect(thread).toBeVisible({ timeout: RUN_SETTLE_TIMEOUT_MS });
    const rootRow = thread.locator('[data-testid^="comment-row-"]').filter({ hasText: rootBody });
    await expect(rootRow).toBeVisible();
    await expect(rootRow.locator('[data-testid^="comment-author-"]')).toHaveText("You");
    await expect(rootRow.locator('[data-testid^="comment-anchor-comp-"]')).toContainText("Main");
    await expect(rootRow.locator('[data-testid^="comment-anchor-time-"]')).toBeVisible();

    // REPLY — the reply box inherits the thread anchor (wire: parentId only).
    const replyBody = `Reply on the same anchor ${stamp}`;
    await rootRow.locator('[data-testid^="comment-reply-open-"]').click();
    await expect(rootRow.locator('[data-testid^="comment-reply-box-"]')).toBeVisible();
    await page.getByLabel("Write a reply").fill(replyBody);
    await rootRow.locator('[data-testid^="comment-reply-send-"]').click();

    const replyRow = thread.locator('[data-testid^="comment-row-"]').filter({ hasText: replyBody });
    await expect(replyRow).toBeVisible({ timeout: RUN_SETTLE_TIMEOUT_MS });
    await expect(replyRow).toHaveAttribute("data-depth", "2");

    // RESOLVE — under "All" the resolved badge renders; the thread-level
    // filter semantics then take the whole thread out of "Open" (D-15: a
    // filter never SPLITS a thread — the replies follow their root).
    await page.getByTestId("comments-filter-all").click();
    await expect(thread).toBeVisible();
    await thread.locator('[data-testid^="comment-resolve-"]').first().click();
    await expect(thread.locator('[data-testid^="comment-resolved-"]')).toContainText("Resolved", {
      timeout: RUN_SETTLE_TIMEOUT_MS,
    });

    // FILTERS — "Open" drops the resolved thread; "Resolved" brings it back.
    await page.getByTestId("comments-filter-open").click();
    await expect(thread).toHaveCount(0, { timeout: RUN_SETTLE_TIMEOUT_MS });
    await page.getByTestId("comments-filter-resolved").click();
    await expect(thread).toBeVisible();
    await expect(thread.locator('[data-testid^="comment-resolved-"]')).toContainText("Resolved");
    await page.getByTestId("comments-filter-all").click();
    await expect(thread).toBeVisible();

    // The comp-filter menu lists the live project's comps (D-15); picking
    // "All comps" closes the menu and keeps the thread visible.
    await page.getByTestId("comments-comp-filter").click();
    await expect(page.getByTestId("comments-comp-menu")).toBeVisible();
    const mainOption = page
      .locator('[data-testid^="comments-comp-option-"]')
      .filter({ hasText: "Main" });
    await expect(mainOption).toBeVisible();
    await page.getByTestId("comments-comp-option-all").click();
    await expect(page.getByTestId("comments-comp-menu")).toHaveCount(0);
    await expect(
      page.locator('[data-testid^="comment-thread-"]').filter({ hasText: rootBody }),
    ).toBeVisible();

    // RELOAD PERSISTENCE — the §M7 exit criterion: the anchored, resolved
    // thread survives a full editor reboot (the rows live in Postgres).
    await page.reload();
    await expect(page.getByTestId("editor-host")).toHaveAttribute("data-editor-phase", "open", {
      timeout: EDITOR_OPEN_TIMEOUT_MS,
    });
    await page.getByTestId("comments-toggle").click();
    await expect(page.getByTestId("comments-panel")).toBeVisible();
    await page.getByTestId("comments-filter-resolved").click();
    await expect(
      page.locator('[data-testid^="comment-thread-"]').filter({ hasText: rootBody }),
    ).toBeVisible({ timeout: RUN_SETTLE_TIMEOUT_MS });
    await expect(
      page
        .locator('[data-testid^="comment-thread-"]')
        .filter({ hasText: rootBody })
        .locator('[data-testid^="comment-row-"]')
        .filter({ hasText: replyBody }),
    ).toBeVisible();
    await expect(
      page
        .locator('[data-testid^="comment-thread-"]')
        .filter({ hasText: rootBody })
        .locator('[data-testid^="comment-anchor-comp-"]'),
    ).toContainText("Main");
  });
});

// ---------------------------------------------------------------------------
// M7 tasks 2–3 — presence strip + lease banner (the M7-G chrome)
// ---------------------------------------------------------------------------

test.describe("M7 presence + lease — who is viewing, who is editing", () => {
  test("the presence strip renders the beat's viewers and the banner shows the REAL holder state", async ({
    page,
  }) => {
    // The beat response IS the viewers list (heartbeat = poll, M7-B): three
    // viewers incl. the self entry, answered for both POST (beat) and GET.
    await installScriptedPresence(page);
    await openSeededEditor(page);

    const strip = page.getByTestId("presence-strip");
    await expect(strip).toBeVisible({ timeout: CHAT_MOUNT_TIMEOUT_MS });
    await expect(strip).toHaveAttribute("data-viewer-count", "3");
    await expect(strip).toHaveAttribute("aria-label", "3 people are viewing");
    await expect(strip.locator('[data-testid="presence-viewer"]')).toHaveCount(3);
    await expect(strip.locator('[data-testid="presence-viewer"][data-self="true"]')).toHaveCount(1);

    // The REAL lease-state (nothing scripted here): the M3 session acquired
    // the seeded project's lease on open, so the banner's mount poll reads
    // youAre = "holder" — the third state of the §M7 task 3 matrix.
    const banner = page.getByTestId("lease-banner");
    await expect(banner).toBeVisible({ timeout: CHAT_MOUNT_TIMEOUT_MS });
    await expect(banner).toHaveAttribute("data-youare", "holder");
    await expect(page.getByTestId("lease-holder-status")).toContainText("You have the edit lease");
  });

  test("scripted lease-state: viewer strip + countdown → Request edit → queued in line → Cancel request", async ({
    page,
  }) => {
    // The single-member seed cannot produce another member's lease: script
    // the lease-state + request/cancel legs (installed BEFORE the goto so
    // the banner's mount poll reads the scripted viewer state).
    await installScriptedPresence(page);
    await installScriptedLeaseFlow(page);
    await openSeededEditor(page);

    // VIEWER — the read-only strip names the holder (never an id), with the
    // live countdown ("m:ss left") and the queue join affordance.
    const banner = page.getByTestId("lease-banner");
    await expect(banner).toBeVisible({ timeout: CHAT_MOUNT_TIMEOUT_MS });
    await expect(banner).toHaveAttribute("data-youare", "viewer");
    const stripLine = page.getByTestId("lease-readonly-strip");
    await expect(stripLine).toContainText("Viewing");
    await expect(stripLine).toContainText("Maya Rivera");
    await expect(stripLine).toContainText("is editing");
    await expect(page.getByTestId("lease-countdown")).toHaveText(/\d+:\d\d left/);
    const requestButton = page.getByTestId("lease-request-button");
    await expect(requestButton).toBeVisible();
    await expect(requestButton).toHaveText("Request edit");

    // REQUEST EDIT — joins the queue; the scripted requestLease answers and
    // the banner re-polls into the queued state with MY position (the
    // queuedAt fallback — the position the scripted join pinned).
    await requestButton.click();
    await expect(banner).toHaveAttribute("data-youare", "queued", {
      timeout: RUN_SETTLE_TIMEOUT_MS,
    });
    await expect(page.getByTestId("lease-queue-line")).toHaveText("You're #2 in line");
    await expect(page.getByTestId("lease-readonly-strip")).toContainText("Maya Rivera");
    const cancelButton = page.getByTestId("lease-cancel-request-button");
    await expect(cancelButton).toBeVisible();

    // CANCEL — leaves the queue; the banner re-polls back to viewer.
    await cancelButton.click();
    await expect(banner).toHaveAttribute("data-youare", "viewer", {
      timeout: RUN_SETTLE_TIMEOUT_MS,
    });
    await expect(page.getByTestId("lease-request-button")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// M7 task 4 — versions + activity (the M7-H /history surface)
// ---------------------------------------------------------------------------

test.describe("M7 history — version timeline, restore, activity", () => {
  test("the seeded timeline: rows, current badge, first-version linkage, the real structural diff", async ({
    page,
  }) => {
    await signIn(page, SEEDED_HISTORY_PATH);

    await expect(page.getByTestId("history-view")).toBeVisible();
    await expect(page.getByTestId("history-project-name")).toHaveText(SEEDED_PROJECT_NAME);

    // The seed's immutable chain: v1 → v2 → v3, newest first, no agent rows.
    // (Run-repeat tolerance: re-runs against a long-lived CI DB have grown
    // the chain via the restore test below — the seed's three rows and the
    // CURRENT badge on the newest seed row are what stay pinned.)
    const rows = page.locator('[data-testid="version-row"]');
    await expect(rows.first()).toBeVisible({ timeout: RUN_SETTLE_TIMEOUT_MS });
    expect(await rows.count()).toBeGreaterThanOrEqual(3);
    const v3 = page.locator('[data-testid="version-row"][data-version="3"]');
    const v2 = page.locator('[data-testid="version-row"][data-version="2"]');
    const v1 = page.locator('[data-testid="version-row"][data-version="1"]');
    await expect(v3).toBeVisible();
    await expect(v3.getByTestId("version-number")).toHaveText("v3");
    await expect(v3.getByTestId("version-agent-badge")).toHaveCount(0);
    await expect(v1.getByTestId("version-linkage")).toHaveText("First version");

    // The structural diff (real GET …/diff): v3 vs its parent v2.
    await v3.getByTestId("version-diff-toggle").click();
    await expect(v3.getByTestId("version-diff")).toBeVisible();
    await expect(v3.getByTestId("version-diff-parent")).toHaveText("v2");
    await v3.getByTestId("version-diff-toggle").click();
    await expect(v3.getByTestId("version-diff")).toHaveCount(0);

    // Cursor end: a handful of rows < one page → the honest end line.
    await expect(page.getByTestId("timeline-end")).toContainText("That's the whole history.");
    await expect(page.getByTestId("timeline-load-more")).toHaveCount(0);
    await expect(v2).toBeVisible();
  });

  test("inline label edit persists (D-24: the label is the only mutable field)", async ({
    page,
  }) => {
    await signIn(page, SEEDED_HISTORY_PATH);

    const v3 = page.locator('[data-testid="version-row"][data-version="3"]');
    await expect(v3).toBeVisible({ timeout: RUN_SETTLE_TIMEOUT_MS });

    // The seeded label pre-fills the editor; the save is a REAL POST …/label.
    await v3.getByTestId("version-label-edit-button").click();
    await expect(v3.getByTestId("version-label-edit")).toBeVisible();
    await v3.getByTestId("version-label-input").fill("Client cut A");
    await v3.getByTestId("version-label-save").click();
    await expect(v3.getByTestId("version-label-edit")).toHaveCount(0, {
      timeout: RUN_SETTLE_TIMEOUT_MS,
    });
    await expect(v3.getByTestId("version-label")).toHaveText("Client cut A");
  });

  test("activity tab: day-grouped feed, cursor pagination, and the admin audit export download", async ({
    page,
  }) => {
    await signIn(page, SEEDED_HISTORY_PATH);

    // The real audit table has no deterministic 25+ rows: script two pages
    // (installed before the tab mounts — the feed fetches on tab open).
    await installScriptedActivityPages(page);
    await page.getByTestId("history-tab-activity").click();
    await expect(page.getByTestId("history-panel-activity")).toBeVisible();

    const feed = page.getByTestId("activity-feed");
    await expect(feed).toBeVisible();
    await expect(page.getByTestId("activity-row")).toHaveCount(25, {
      timeout: RUN_SETTLE_TIMEOUT_MS,
    });

    // §8.6 day grouping + the row sentence (actor · verb · target).
    await expect(page.getByTestId("activity-day-group")).toHaveCount(1);
    await expect(page.getByTestId("activity-day")).toHaveText("Oct 26, 2026");
    const firstRow = page.locator('[data-testid="activity-row"]').first();
    await expect(firstRow.getByTestId("activity-actor")).toHaveText("A member");
    await expect(firstRow.getByTestId("activity-verb")).toHaveText("saved");
    await expect(firstRow.getByTestId("activity-target")).toHaveText("a version");

    // Cursor pagination: Load more appends page two, then the feed ends.
    await page.getByTestId("activity-load-more").click();
    await expect(page.getByTestId("activity-row")).toHaveCount(30, {
      timeout: RUN_SETTLE_TIMEOUT_MS,
    });
    await expect(page.getByTestId("activity-end")).toContainText("That's the whole feed.");

    // The owner-only audit export (REAL GET …/audit-export): the parsed
    // payload downloads as the pinned filename (mirrors the gateway's
    // Content-Disposition).
    await expect(page.getByTestId("audit-export-button")).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("audit-export-button").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("studio-audit-prj_demo.json");
  });

  test("restore: the typed confirmation gates the POST; the restore creates a NEW version and never rewrites history", async ({
    page,
  }) => {
    await signIn(page, SEEDED_HISTORY_PATH);

    const v1 = page.locator('[data-testid="version-row"][data-version="1"]');
    await expect(v1).toBeVisible({ timeout: RUN_SETTLE_TIMEOUT_MS });
    const rows = page.locator('[data-testid="version-row"]');
    const rowCountBefore = await rows.count();
    // §9.3: the new version's number is the current row's + 1 (read from the
    // DOM so re-runs against a long-lived CI DB stay honest).
    const currentRow = page.locator('[data-testid="version-row"][data-current="true"]');
    await expect(currentRow).toBeVisible();
    const currentNumberText = await currentRow.getByTestId("version-number").textContent();
    const expectedNewVersion = Number.parseInt((currentNumberText ?? "v").replace("v", ""), 10);
    expect(Number.isFinite(expectedNewVersion)).toBe(true);

    // §9.3 restore: the dialog demands the version's EXACT typed label —
    // the seed's v1 label is "empty project" (restoreConfirmPhrase).
    await v1.getByTestId("version-restore").click();
    await expect(page.getByTestId("restore-dialog-title")).toHaveText("Restore v1?");
    const confirm = page.getByTestId("restore-confirm");
    await expect(confirm).toBeDisabled();

    // A wrong phrase keeps the confirm disabled (client-side gate).
    await page.getByTestId("restore-input").fill("some other label");
    await expect(confirm).toBeDisabled();

    // The exact phrase unlocks it; the REAL POST restores v1 as a NEW row
    // (version = current + 1, parent = v1 — history is never rewritten).
    await page.getByTestId("restore-input").fill("empty project");
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(page.getByTestId("restore-dialog-title")).toHaveCount(0, {
      timeout: RUN_SETTLE_TIMEOUT_MS,
    });
    const newRow = page.locator(
      `[data-testid="version-row"][data-version="${expectedNewVersion + 1}"]`,
    );
    await expect(newRow).toBeVisible({ timeout: RUN_SETTLE_TIMEOUT_MS });
    await expect(newRow).toHaveAttribute("data-current", "true");
    await expect(newRow.getByTestId("version-label")).toHaveText("Restored from v1");
    await expect(newRow.getByTestId("version-current-badge")).toBeVisible();

    // §9.3: history is never rewritten — every pre-existing row (incl. the
    // seed's v1..v3) still exists; the chain grew by exactly one row.
    await expect(rows).toHaveCount(rowCountBefore + 1, {
      timeout: RUN_SETTLE_TIMEOUT_MS,
    });
    for (const version of ["1", "2", "3"]) {
      await expect(
        page.locator(`[data-testid="version-row"][data-version="${version}"]`),
      ).toBeVisible();
    }
  });
});

// ---------------------------------------------------------------------------
// M7 task 5 — the public /s/:token review page (M7-I). Anonymous: NO sign-in.
// ---------------------------------------------------------------------------

test.describe("M7 share — public review journey (no editor for anonymous)", () => {
  test("password-protected link: wrong/right gate, guest comment, request access, noindex, zero editor wasm", async ({
    page,
  }) => {
    // The "no editor for anonymous" pin: count every request under /editor/
    // (the wasm dist mount) for the whole journey.
    let editorRequests = 0;
    await page.route("**/editor/**", async (route) => {
      editorRequests += 1;
      await route.continue();
    });

    // The RSC route read the fixture token server-side (README §10); the
    // gate renders from ShareInfo.hasPassword.
    await page.goto(`/s/${SHARE_TOKEN_LOCKED}`);
    await expect(page.getByTestId("share-page")).toBeVisible();
    await expect(page.getByTestId("share-project-name")).toHaveText(SEEDED_PROJECT_NAME);
    await expect(page.getByTestId("share-gate")).toBeVisible();
    await expect(page.getByTestId("share-gate-form")).toBeVisible();

    // A share link is a review capability, not a page to index.
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);

    // WRONG password — the gateway's 401 and the typed copy (no oracle).
    await page.getByTestId("share-gate-input").fill("definitely-not-the-password");
    await page.getByTestId("share-gate-submit").click();
    await expect(page.getByText("That password didn't unlock this link.")).toBeVisible();

    // RIGHT password — one call proves the password AND loads the surface.
    await page.getByTestId("share-gate-input").fill(SHARE_PASSWORD);
    await page.getByTestId("share-gate-submit").click();
    await expect(page.getByTestId("share-surface")).toBeVisible({
      timeout: RUN_SETTLE_TIMEOUT_MS,
    });
    await expect(page.getByTestId("share-gate")).toHaveCount(0);
    await expect(page.getByTestId("share-player")).toBeVisible();
    await expect(page.getByTestId("share-version-label")).toHaveText(/^v\d+/);

    // GUEST COMMENT — name + email + body, rate-limited server-side; the
    // row renders id-stripped (guest name only).
    await expect(page.getByTestId("share-comments")).toBeVisible();
    const stamp = Date.now().toString(36);
    const guestBody = `The title card lands too early ${stamp}`;
    await page.getByTestId("share-composer-name").fill("Riley Reviewer");
    await page.getByTestId("share-composer-email").fill("riley@example.com");
    await page.getByTestId("share-composer-body").fill(guestBody);
    await page.getByTestId("share-composer-submit").click();
    await expect(page.getByTestId("share-composer-success")).toContainText("Comment posted.", {
      timeout: RUN_SETTLE_TIMEOUT_MS,
    });
    const guestRow = page.getByTestId("share-comment-list").locator("li").filter({
      hasText: guestBody,
    });
    await expect(guestRow).toBeVisible();
    await expect(guestRow.getByTestId("share-comment-author")).toHaveText("Riley Reviewer");
    await expect(guestRow.getByTestId("share-comment-body")).toContainText(guestBody);

    // REQUEST ACCESS — the anonymous reviewer asks the workspace (recorded
    // as a share.request_access audit row — v1's notification).
    await page.getByTestId("share-request-access-email").fill("riley@example.com");
    await page
      .getByTestId("share-request-access-message")
      .fill("Need edit rights for the client review.");
    await page.getByTestId("share-request-access-submit").click();
    await expect(page.getByTestId("share-request-access-ok")).toContainText(
      "Request sent. The workspace will see it in its activity feed.",
      { timeout: RUN_SETTLE_TIMEOUT_MS },
    );

    // THE NO-EDITOR PIN: zero iframes (the editor only ever mounts through
    // editor-iframe) and zero requests under /editor/ — the review player
    // never loads the wasm dist for an anonymous visitor.
    await expect(page.locator("iframe")).toHaveCount(0);
    expect(editorRequests).toBe(0);
  });

  test("open link: no gate, the honest empty player, still zero editor", async ({ page }) => {
    let editorRequests = 0;
    await page.route("**/editor/**", async (route) => {
      editorRequests += 1;
      await route.continue();
    });

    await page.goto(`/s/${SHARE_TOKEN_OPEN}`);
    await expect(page.getByTestId("share-surface")).toBeVisible({
      timeout: RUN_SETTLE_TIMEOUT_MS,
    });
    await expect(page.getByTestId("share-gate")).toHaveCount(0);

    // The seeded project has NO uploaded assets: the player says so instead
    // of inventing a renderer (M7-I's honesty pin).
    await expect(page.getByTestId("share-player")).toBeVisible();
    await expect(page.getByTestId("share-player-empty")).toContainText(
      "No preview media is shared on this link yet.",
    );
    await expect(page.locator("iframe")).toHaveCount(0);
    expect(editorRequests).toBe(0);
  });

  test("an unknown-but-well-formed token is the §12.1 404 (never an oracle)", async ({ page }) => {
    await page.goto("/s/aaaaaaaaaaaaaaaaaaaaaaaa");
    await expect(page.getByTestId("not-found")).toBeVisible();
    await expect(page.getByTestId("share-page")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// M7 task 3 (read-only arm) — D-23: chat + review stay alive under another
// member's lease; only project mutations are gated.
// ---------------------------------------------------------------------------

test.describe("M7 read-only — another member holds the edit lease", () => {
  test("the read-only chrome renders; chat still completes a full run (D-23); comments stay open; no apply control exists", async ({
    page,
  }) => {
    // The scripted lease-held state (viewer, holder "Maya Rivera") + the
    // scripted presence — both BEFORE the goto: the banner's mount poll and
    // the presence beat are the first reads.
    await installScriptedPresence(page);
    await installScriptedLeaseFlow(page);
    await openSeededEditor(page);

    // THE READ-ONLY CHROME STRIP — the banner's viewer state with the
    // holder's NAME (law #1), the countdown, and the strip presence.
    const banner = page.getByTestId("lease-banner");
    await expect(banner).toBeVisible({ timeout: CHAT_MOUNT_TIMEOUT_MS });
    await expect(banner).toHaveAttribute("data-youare", "viewer");
    const strip = page.getByTestId("lease-readonly-strip");
    await expect(strip).toContainText("Viewing");
    await expect(strip).toContainText("Maya Rivera");
    await expect(strip).toContainText("is editing");
    await expect(page.getByTestId("lease-countdown")).toHaveText(/\d+:\d\d left/);

    // D-23, chat arm: the chat still opens and the gate-wrapped bridge lets
    // every READ through — a full mock-model run completes under the lease.
    await expect(page.getByTestId("chat-header")).toBeVisible();
    await expect(page.getByTestId("presence-strip")).toBeVisible();
    const composer = page.getByLabel("Message the agent");
    await composer.click();
    await composer.fill("What's on this comp?");
    await composer.press("Enter");

    await expect(page.getByTestId("chat-status")).toHaveAttribute("data-phase", "done", {
      timeout: RUN_SETTLE_TIMEOUT_MS,
    });
    const contextCard = page.locator('[data-testid="tool-card"][data-tool="studio.get_context"]');
    await expect(contextCard).toHaveAttribute("data-status", "done");

    // D-23, apply arm (the structural half): the run's proposal renders as
    // the callback-less card — this session wires NO apply ports, so no
    // stream + lease state can conjure an Apply control anywhere.
    const plan = page.getByTestId("plan-card");
    await expect(plan).toBeVisible();
    await expect(plan).toHaveAttribute("data-status", "proposed");
    await expect(plan.getByTestId("plan-actions").getByRole("button")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^apply/i })).toHaveCount(0);
    await expect(plan.getByTestId("plan-apply")).toHaveCount(0);

    // D-23, review arm: the comments panel OPENS under another member's
    // lease with the lease note — and posting still works (review is the
    // point of the read-only state).
    await page.getByTestId("chat-close-button").click();
    await expect(page.getByTestId("chat-collapsed-layer")).toBeVisible();
    await page.getByTestId("comments-toggle").click();

    const leaseNote = page.getByTestId("comments-lease-note");
    await expect(page.getByTestId("comments-panel")).toBeVisible();
    await expect(leaseNote).toBeVisible();
    await expect(leaseNote).toHaveAttribute("data-holder", "Maya Rivera");
    await expect(leaseNote).toContainText("Maya Rivera is editing");
    await expect(leaseNote).toContainText("you can still read and comment");

    const stamp = Date.now().toString(36);
    const readOnlyBody = `Reviewing read-only ${stamp}`;
    const readComposer = page.getByLabel("Write a comment");
    await expect(readComposer).toBeEnabled();
    await readComposer.fill(readOnlyBody);
    await readComposer.press("Enter");
    await expect(
      page.locator('[data-testid^="comment-row-"]').filter({ hasText: readOnlyBody }),
    ).toBeVisible({ timeout: RUN_SETTLE_TIMEOUT_MS });
  });

  // -------------------------------------------------------------------------
  // WIRING-PENDING (fixme): the Apply-blocked-with-lease-explanation journey
  // -------------------------------------------------------------------------
  //
  // NOT fixme because of CI ownership (CI runs this suite — README §Run) and
  // NOT because of the scripted lease (that leg works — the ACTIVE test above
  // proves the gate flips). The ONLY missing link is HOST WIRING:
  // editor-host.tsx mounts `<ChatProvider client bridge …/>` WITHOUT
  // `applyPorts`, so lib/chat/provider.tsx builds NO ApplyController
  // (`planWiring.ready === false` → the card is callback-less → no Apply
  // control exists to click). The whole lease-blocked apply pipeline IS
  // landed and unit-proven (apps/web/src/lib/chat/__tests__/apply-lease-
  // held.test.ts): the GATE-WRAPPED bridge rejects engine.batch with the
  // typed ReadOnlyLeaseError (lib/editor-session/read-only.ts), apply.ts maps
  // it to the `lease-held` outcome, and the plan card renders status
  // "failed" + plan-failed-detail with the holder-naming explanation and NO
  // Try-again (APPLY_FAILED is not in the retryable sets).
  //
  // FLIP: change `test.fixme` → `test` when editor-host.tsx passes
  // ChatProvider `applyPorts` — the M3 autosave controller (saveNow) + a
  // `currentVersionId()` session port (the use-editor-session handles own
  // both). The M5 spec's apply→undo journey fixme flips the same day (the
  // same one-line host mount).
  //
  // Deterministic fixture notes: the mock model's plan is LOW risk (no
  // confirm checkbox, no dialog — a single click drives apply), its compiled
  // batch references layer "Headline" by the pinned $request placeholder, and
  // the local gate rejection happens BEFORE any engine traffic — the
  // wire-level proof is that no /apply POST ever fires.
  test.fixme(
    "Apply under another member's lease fails locally with the typed lease explanation",
    async ({ page }) => {
      await installScriptedPresence(page);
      await installScriptedLeaseFlow(page);
      await openSeededEditor(page);

      const composer = page.getByLabel("Message the agent");
      await composer.click();
      await composer.fill("Rename the selected layer to Subtitle");
      await composer.press("Enter");

      const plan = page.getByTestId("plan-card");
      await expect(plan).toBeVisible({ timeout: RUN_SETTLE_TIMEOUT_MS });
      await expect(plan).toHaveAttribute("data-status", "proposed");

      // No apply POST can ever fire — the local gate refuses first.
      let applyPosts = 0;
      await page.route("**/v1/runs/*/apply", async (route) => {
        applyPosts += 1;
        await route.continue();
      });

      await plan.getByTestId("plan-apply").click();

      // The typed lease explanation (ReadOnlyLeaseError → apply.ts):
      // "Maya Rivera is editing this project right now. The plan was not
      // applied — request edit access, or take the lease when it is free,
      // then apply again." — holder name, never an id (law #1).
      await expect(plan).toHaveAttribute("data-status", "failed", {
        timeout: RUN_SETTLE_TIMEOUT_MS,
      });
      await expect(page.getByTestId("plan-failed")).toContainText(
        "The edit didn't apply — nothing changed.",
      );
      await expect(page.getByTestId("plan-failed-detail")).toContainText(
        "Maya Rivera is editing this project right now.",
      );
      await expect(page.getByTestId("plan-failed-detail")).toContainText(
        "request edit access, or take the lease when it is free, then apply again",
      );
      // F-L3: a post-execution-style failure offers no re-execution path.
      await expect(page.getByTestId("plan-retry")).toHaveCount(0);
      expect(applyPosts).toBe(0);
    },
  );
});
