/**
 * M9 visual QA — the CI-owned Playwright harness (BUILD_PLAN §M9 task 7:
 * "Screenshots at 390/768/1024/1280/1440/1920; 200% zoom; reduced motion;
 * axe. Editor screenshot diff vs upstream.").
 *
 * This file owns the first three bullets of that task. The axe bullet lives
 * in e2e/m9-axe.spec.ts; the editor-diff-vs-upstream bullet is NOT here by
 * design — its pixel baselines already exist as the "editor-unchanged-*"
 * shots in e2e/chat.spec.ts and e2e/m5-agent-edits.spec.ts, and this wave
 * must NOT touch them.
 *
 * NEVER RUN ON THE BUILD-FLEET BOX — same class of debt as chat.spec.ts,
 * m5-agent-edits.spec.ts, m7-collab.spec.ts and m8-renders.spec.ts
 * (M3/M4/M5/M7/M8 precedent): this box has no browsers and no dev servers,
 * so `@playwright/test` is NOT installed here. apps/web/tsconfig.json
 * excludes `e2e` from typecheck for exactly that reason and the web vitest
 * config never matches `e2e/*.spec.ts`; CI owns the devDependency, the
 * lockfile and the run (e2e/README.md §11 is the M9 recipe).
 *
 * ----------------------------------------------------------------------------
 * What this harness asserts (and what it deliberately does NOT)
 * ----------------------------------------------------------------------------
 *
 * - VIEWPORT SWEEP at UI_DESIGN_SYSTEM §13's canonical widths
 *   (320/390/768/1024/1280/1440/1920) over the 8 marketing pages, the 2 auth
 *   pages and the 4 authed shell pages. At EVERY width: the document answers
 *   < 400, the page's surface testid renders, the §13 primary action stays
 *   visible ("never hide the primary action on mobile") and a full-page
 *   screenshot SMOKE lands (file exists + non-blank byte floor). At 320 and
 *   390 the sweep additionally HARD-GATES horizontal scroll (§12 "no
 *   horizontal scroll at 320px", manifest W2-10).
 * - Screenshots are SMOKES, not pixel baselines: existence + byte floor
 *   only. Runner GPUs rasterize differently (README §First run), so pixel
 *   baselines exist ONLY for the editor-unchanged proof (chat/m5 specs).
 * - 200% ZOOM spot-check (§12 "usable at 200%"): deviceScaleFactor 2 at 390
 *   and 768 — the no-horizontal-scroll gate re-applies, the primary action
 *   must stay visible, and a smoke shot lands.
 * - REDUCED MOTION arm (§6.2): emulateMedia({ reducedMotion: "reduce" })
 *   then prove BOTH that the emulation took (matchMedia) and that the
 *   theme.css override is live (the first .frame-line's computed
 *   animation-duration collapses to ~0), with the same layout invariants
 *   (surface + primary + no h-scroll at 390).
 * - PERF SMOKE (LCP/CLS) on the landing via performance.getEntriesByType —
 *   an inline, guarded helper (README §11e): CLS < 0.1 is the HARD gate
 *   (BUILD_PLAN §M9 exit criteria); LCP is RECORDED with a pathological
 *   smoke ceiling, never judged against §16.2's 2.5 s — that budget is a
 *   throttled production-build measurement, and a warm `next dev` number is
 *   not it (an honest note, not a fake green).
 *
 * ----------------------------------------------------------------------------
 * ACTIVE today vs WAVE-PENDING routes (the honest split)
 * ----------------------------------------------------------------------------
 *
 * The marketing + auth sweeps are ACTIVE against surfaces verified in
 * source at write time. The four AUTHED routes are written against the
 * ROUTE CONTRACT and note which sibling task owns each surface:
 *
 *   /w                  — W2-03 replaces the current stub with the §8.4
 *                         dashboard; the primary action "New project" is
 *                         §8.4's pinned actions row. W2-01 wraps it in the
 *                         shell. WAVE-PENDING.
 *   /w/projects         — W2-04 creates the route (§8.5). §8.5 pins NO
 *                         single primary action (table/grid toggle +
 *                         filters), so the sweep pins the seeded project
 *                         ("Demo Project") — the route's content contract.
 *                         WAVE-PENDING (route does not exist pre-wave).
 *   /w/billing          — LIVE today (`billing-view`); W2-01 moves it into
 *                         the (shell) group URL-unchanged and W2-08 only
 *                         ADDS the usage section. Primary: the "Buy credits"
 *                         flow (topup-flow). ACTIVE.
 *   /w/settings/members — W2-06 creates the route (§8.9); primary action
 *                         /invite/i (the invite dialog §8.9 pins).
 *                         WAVE-PENDING (route does not exist pre-wave).
 *
 * If CI runs before those siblings land, exactly these tests red on 404s —
 * that is the documented mid-wave state, not a harness bug.
 *
 * ----------------------------------------------------------------------------
 * Determinism contract
 * ----------------------------------------------------------------------------
 *
 * - Boot: the README recipe (§4 env, §5 webServer — zero new env vars, zero
 *   new ports). The public sweeps need no auth, no seed, no fixtures; the
 *   authed sweep needs the seeded demo user (§2) through the REAL /sign-in
 *   form (the m7 recipe's signIn helper, verbatim). No editor is opened, so
 *   the §3 `.ecproj` staging and §10 share fixture are NOT needed here.
 * - One page.goto per (page × viewport): a real device paints fresh at its
 *   width — no mid-test resizes, no sleeps; every wait is a testid / role /
 *   URL / status wait (house rule).
 * - Screenshot smokes write to testInfo.outputPath (run artifacts, never
 *   committed) with animations disabled and the caret hidden, so the shots
 *   are deterministic captures of the painted layout.
 * - The 320px gate is the §12/§13 contract, not a guess about current
 *   chrome: on-box px math suggests the marketing header's CTA pair may
 *   overflow 320px (there is no browser on this box to confirm). If CI
 *   confirms, the fix belongs in the app chrome (site-header.tsx, or §13's
 *   sticky bottom bar) — never in this gate. README §11b says the same.
 *
 * ----------------------------------------------------------------------------
 * Selector map driven by this spec (drift detector — verified in source)
 * ----------------------------------------------------------------------------
 *
 *   landing-footer (surface) + header link "Start trial"   (marketing)/page.tsx
 *     + components/marketing/site-header.tsx (the hero/final CTA links say
 *     "Start 14-day trial" — exact:true keeps the header link unambiguous)
 *   pricing-page (+ pricing-card-*)                        (marketing)/pricing
 *   faq-page                                                (marketing)/faq
 *   status-page (+ status-board)                            (marketing)/status
 *   changelog-page                                          (marketing)/changelog
 *   legal-terms / legal-privacy / legal-licences            (marketing)/legal/*
 *   sign-in-form (#sign-in-email, #sign-in-password)        auth/sign-in-form
 *   sign-up-form (+ button "Create account")                auth/sign-up-form
 *   billing-view, topup-flow                                billing views (live)
 *   .frame-line (reduced-motion probe — the §2.3 signature
 *     element, present on every marketing page and the auth layout)
 *   WAVE-PENDING pins: button /new project/i (§8.4 actions row),
 *   text "Demo Project" (the seed's project), button /invite/i (§8.9)
 */

import { promises as fsp } from "node:fs";
import { type Locator, type Page, type TestInfo, expect, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Seeded world (packages/db/scripts/seed.ts — e2e/README.md §2)
// ---------------------------------------------------------------------------

/** The seed's demo login (dev fixture credentials, never production). */
const SEEDED_EMAIL = "demo@studio.test";
const SEEDED_PASSWORD = "demo-password-12345";

// ---------------------------------------------------------------------------
// The §13 canonical viewport ladder + the M9.7 gates
// ---------------------------------------------------------------------------

/** UI_DESIGN_SYSTEM §13: "Test at 320px, 390px, 768px, 1024px, 1280px, 1440px, 1920px." */
const VIEWPORTS = [
  { name: "320", width: 320, height: 568 },
  { name: "390", width: 390, height: 844 },
  { name: "768", width: 768, height: 1024 },
  { name: "1024", width: 1024, height: 768 },
  { name: "1280", width: 1280, height: 800 },
  { name: "1440", width: 1440, height: 900 },
  { name: "1920", width: 1920, height: 1080 },
] as const;

/**
 * Widths where the no-horizontal-scroll gate hard-fails (§12 "no horizontal
 * scroll at 320px", §13, manifest W2-10 "no horizontal scroll at 320/390").
 */
const H_SCROLL_GATE_WIDTHS: readonly number[] = [320, 390];

/**
 * A full-page shot of any real surface at any swept width is comfortably six
 * figures of bytes; a blank or flat fill compresses to ~2–6 KiB. 10 KiB
 * separates "the page painted" from "the page is blank" without pinning
 * pixels (the runner-GPU caveat is why this is a smoke, not a baseline).
 */
const SHOT_BYTE_FLOOR = 10 * 1024;

/** CLS gate — BUILD_PLAN §M9 exit criteria: "CLS < 0.1". */
const CLS_MAX = 0.1;
/**
 * LCP pathological ceiling — NOT §16.2's 2.5 s production budget (that is a
 * throttled production-build measurement; this run is a warm dev server).
 * The ceiling only catches a page that never meaningfully paints.
 */
const LCP_SMOKE_CEILING_MS = 15_000;

// ---------------------------------------------------------------------------
// The swept pages (surface + primary action, pinned per page)
// ---------------------------------------------------------------------------

type SweptPage = {
  /** Slug for screenshot names + failure messages. */
  id: string;
  /** The route swept. */
  path: string;
  /**
   * Surface testid proving the RIGHT page rendered (verified in source; null
   * for wave-pending surfaces whose component tree is still landing — there
   * the route + primary-action pins are the contract, per the header notes).
   */
  surface: string | null;
  /** §13 "Never hide the primary action on mobile" — pinned per page. */
  primary: (page: Page) => Locator;
};

/**
 * Every marketing page's persistent primary action is the SiteHeader CTA
 * ("Start trial" — components/marketing/site-header.tsx). exact:true keeps
 * it unambiguous: the landing hero/final CTAs say "Start 14-day trial" and
 * the pricing cards say "Start <Plan> trial" — none exact-match.
 */
const marketingPrimary = (page: Page): Locator =>
  page.getByRole("link", { name: "Start trial", exact: true });

const MARKETING_PAGES: readonly SweptPage[] = [
  {
    id: "landing",
    path: "/",
    // The footer pins "the whole page rendered" for the full-page shots.
    surface: "landing-footer",
    primary: marketingPrimary,
  },
  { id: "pricing", path: "/pricing", surface: "pricing-page", primary: marketingPrimary },
  { id: "faq", path: "/faq", surface: "faq-page", primary: marketingPrimary },
  { id: "status", path: "/status", surface: "status-page", primary: marketingPrimary },
  { id: "changelog", path: "/changelog", surface: "changelog-page", primary: marketingPrimary },
  { id: "legal-terms", path: "/legal/terms", surface: "legal-terms", primary: marketingPrimary },
  {
    id: "legal-privacy",
    path: "/legal/privacy",
    surface: "legal-privacy",
    primary: marketingPrimary,
  },
  {
    id: "legal-licences",
    path: "/legal/licences",
    surface: "legal-licences",
    primary: marketingPrimary,
  },
];

const AUTH_PAGES: readonly SweptPage[] = [
  {
    id: "sign-in",
    path: "/sign-in",
    surface: "sign-in-form",
    primary: (page) => page.getByRole("button", { name: "Sign in", exact: true }),
  },
  {
    id: "sign-up",
    path: "/sign-up",
    surface: "sign-up-form",
    primary: (page) => page.getByRole("button", { name: "Create account", exact: true }),
  },
];

/**
 * The authed shell pages — see the header's WAVE-PENDING notes. These pins
 * are written against the route contract (§8.4/§8.5/§8.8/§8.9 + the W2
 * manifest), not against landed source: /w's "New project" button, the
 * seeded "Demo Project" as /w/projects' content pin, live billing's
 * topup-flow, and /w/settings/members' invite action.
 */
const AUTHED_PAGES: readonly SweptPage[] = [
  {
    id: "w-dashboard",
    path: "/w",
    surface: null,
    primary: (page) => page.getByRole("button", { name: /new project/i }),
  },
  {
    id: "w-projects",
    path: "/w/projects",
    surface: null,
    primary: (page) => page.getByText("Demo Project", { exact: true }).first(),
  },
  {
    id: "w-billing",
    path: "/w/billing",
    surface: "billing-view",
    primary: (page) => page.getByTestId("topup-flow"),
  },
  {
    id: "w-settings-members",
    path: "/w/settings/members",
    surface: null,
    primary: (page) => page.getByRole("button", { name: /invite/i }),
  },
];

/** The reduced-motion arm pages: the two richest layouts + one auth page. */
const REDUCED_MOTION_PAGES: readonly SweptPage[] = [
  MARKETING_PAGES[0],
  MARKETING_PAGES[1],
  AUTH_PAGES[0],
];

/** The arm re-checks the mobile gate width + one desktop width. */
const REDUCED_MOTION_VIEWPORTS = VIEWPORTS.filter(
  (viewport) => viewport.name === "390" || viewport.name === "1280",
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sign the seeded demo user in through the REAL /sign-in form (better-auth
 * email+password → session cookie) and land on `nextPath` — the m7 spec's
 * recipe, verbatim (e2e/m7-collab.spec.ts signIn).
 */
async function signIn(page: Page, nextPath: string): Promise<void> {
  await page.goto(`/sign-in?next=${encodeURIComponent(nextPath)}`);
  await page.locator("#sign-in-email").fill(SEEDED_EMAIL);
  await page.locator("#sign-in-password").fill(SEEDED_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(`**${nextPath}`);
}

/**
 * §12/§13 gate: the page must not scroll horizontally. The 1px tolerance
 * absorbs subpixel rounding only — a real overflow fails with the widths in
 * the message. If this gate reds, fix the page chrome (never the gate).
 */
async function expectNoHorizontalScroll(page: Page, at: string): Promise<void> {
  const overflow = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(
    overflow.scrollWidth - overflow.clientWidth,
    `${at}: §12/§13 — no horizontal scroll (scrollWidth ${overflow.scrollWidth} vs clientWidth ${overflow.clientWidth}); fix the page chrome, never this gate (e2e/README.md §11b)`,
  ).toBeLessThanOrEqual(1);
}

/**
 * Screenshot SMOKE, not a pixel baseline: one full-page capture into the
 * run's output dir (never committed), asserted to exist and be non-blank
 * via the byte floor. Runner-GPU pixel variance is why nothing here diffs
 * against a committed image (README §11d).
 */
async function expectScreenshotSmoke(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath("m9-visual", `${name}.png`);
  await page.screenshot({ animations: "disabled", caret: "hide", fullPage: true, path });
  const { size } = await fsp.stat(path);
  expect(
    size,
    `${name}: the full-page shot must exist and be non-blank (>= ${SHOT_BYTE_FLOOR} bytes; got ${size})`,
  ).toBeGreaterThan(SHOT_BYTE_FLOOR);
}

/**
 * The sweep itself: fresh paint per (page × viewport) — a real device loads
 * at its own width; every wait below is a status/testid/role wait.
 */
async function sweepViewports(page: Page, testInfo: TestInfo, entry: SweptPage): Promise<void> {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const response = await page.goto(entry.path);

    // The document must answer: a 404 means a WAVE-PENDING route has not
    // landed yet (header notes) — or a real regression. Either way, name it.
    expect(
      response,
      `${entry.id}: page.goto(${entry.path}) must produce a document response`,
    ).not.toBeNull();
    expect(
      response?.status(),
      `${entry.id}: ${entry.path} must answer < 400 at ${viewport.width}px (wave-pending route? see the spec header)`,
    ).toBeLessThan(400);

    if (entry.surface !== null) {
      await expect(
        page.getByTestId(entry.surface),
        `${entry.id}: the surface testid must render at ${viewport.width}px`,
      ).toBeVisible();
    }
    await expect(
      entry.primary(page),
      `${entry.id}: §13 — the primary action must stay visible at ${viewport.width}px`,
    ).toBeVisible();

    if (H_SCROLL_GATE_WIDTHS.includes(viewport.width)) {
      await expectNoHorizontalScroll(page, `${entry.id} @ ${viewport.width}px`);
    }

    await expectScreenshotSmoke(page, testInfo, `${entry.id}-${viewport.name}`);
  }
}

// ---------------------------------------------------------------------------
// Perf smoke helper (README §11e — CI-owned honest note)
// ---------------------------------------------------------------------------

type LandingVitals = { lcpMs: number | null; cls: number };

/**
 * performance.getEntriesByType readers (Chromium — the suite's only engine):
 * LCP = the last buffered largest-contentful-paint entry's startTime; CLS =
 * the sum of layout-shift values without hadRecentInput (the standard field
 * formula). Inline AND guarded by design (W2-10): a runner whose buffer is
 * empty must produce a skip with a printed reason, never a crash or a red.
 */
async function readLandingVitals(page: Page): Promise<LandingVitals> {
  return page.evaluate(() => {
    const lastLcp = performance.getEntriesByType("largest-contentful-paint").at(-1);
    let cls = 0;
    for (const entry of performance.getEntriesByType("layout-shift")) {
      const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean };
      if (!shift.hadRecentInput) {
        cls += shift.value;
      }
    }
    return { lcpMs: lastLcp === undefined ? null : lastLcp.startTime, cls };
  });
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

test.describe("M9 visual — marketing pages viewport sweep", () => {
  for (const entry of MARKETING_PAGES) {
    test(`${entry.path} keeps its primary action on screen and photographs clean at every width`, async ({
      page,
    }, testInfo) => {
      await sweepViewports(page, testInfo, entry);
    });
  }
});

test.describe("M9 visual — auth pages viewport sweep", () => {
  for (const entry of AUTH_PAGES) {
    test(`${entry.path} keeps its primary action on screen and photographs clean at every width`, async ({
      page,
    }, testInfo) => {
      await sweepViewports(page, testInfo, entry);
    });
  }
});

test.describe("M9 visual — authed shell pages viewport sweep (W2 wave-pending routes)", () => {
  for (const entry of AUTHED_PAGES) {
    test(`${entry.path} renders authed, keeps its primary action on screen and photographs clean at every width`, async ({
      page,
    }, testInfo) => {
      // The m7 boot recipe: REAL /sign-in as the seeded demo user → session
      // cookie. Every later viewport re-navigates with that cookie.
      await signIn(page, entry.path);
      await expect(page).toHaveURL(`**${entry.path}`);
      await sweepViewports(page, testInfo, entry);
    });
  }
});

// ---------------------------------------------------------------------------
// Reduced motion (§6.2) — emulation arm
// ---------------------------------------------------------------------------

test.describe("M9 visual — reduced motion (§6.2)", () => {
  for (const entry of REDUCED_MOTION_PAGES) {
    test(`${entry.path} holds layout with prefers-reduced-motion: reduce`, async ({
      page,
    }, testInfo) => {
      await page.emulateMedia({ reducedMotion: "reduce" });

      for (const viewport of REDUCED_MOTION_VIEWPORTS) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(entry.path);

        // 1. The emulation took (Chromium honors emulateMedia for
        //    prefers-reduced-motion in matchMedia AND the CSS cascade).
        const reduceMatches = await page.evaluate(
          () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        );
        expect(
          reduceMatches,
          `${entry.id} @ ${viewport.name}: emulateMedia({reducedMotion:'reduce'}) must be observable via matchMedia`,
        ).toBe(true);

        // 2. The theme.css §6.2 override is live: the §2.3 signature element
        //    (.frame-line — every swept page has one, `draw` animates it)
        //    collapses to a ~zero animation-duration under reduce.
        const animationSeconds = await page.evaluate(() => {
          const frameLine = document.querySelector(".frame-line");
          return frameLine === null
            ? null
            : Number.parseFloat(getComputedStyle(frameLine).animationDuration);
        });
        expect(
          animationSeconds,
          `${entry.id} @ ${viewport.name}: a .frame-line must exist for the §6.2 probe`,
        ).not.toBeNull();
        expect(
          animationSeconds ?? 0,
          `${entry.id} @ ${viewport.name}: §6.2 — reduced motion must collapse the frame-line animation (computed ${animationSeconds}s)`,
        ).toBeLessThanOrEqual(0.0001);

        // 3. No layout breakage: the same invariants as the sweep.
        if (entry.surface !== null) {
          await expect(page.getByTestId(entry.surface)).toBeVisible();
        }
        await expect(
          entry.primary(page),
          `${entry.id} @ ${viewport.name}: the primary action survives reduced motion`,
        ).toBeVisible();
        if (H_SCROLL_GATE_WIDTHS.includes(viewport.width)) {
          await expectNoHorizontalScroll(page, `${entry.id} @ ${viewport.name} reduced-motion`);
        }
        await expectScreenshotSmoke(page, testInfo, `${entry.id}-reduced-motion-${viewport.name}`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 200% zoom spot-check (§12 "usable at 200%") — deviceScaleFactor 2
// ---------------------------------------------------------------------------

test.describe("M9 visual — 200% zoom (deviceScaleFactor 2, §12)", () => {
  test.describe("390 @2x", () => {
    test.use({ deviceScaleFactor: 2, viewport: { width: 390, height: 844 } });

    test("/ stays usable at 200% zoom (390 @2x)", async ({ page }, testInfo) => {
      await page.goto("/");
      await expect(page.getByTestId("landing-footer")).toBeVisible();
      await expect(page.getByRole("link", { name: "Start trial", exact: true })).toBeVisible();
      await expectNoHorizontalScroll(page, "/ @ 390 @2x");
      await expectScreenshotSmoke(page, testInfo, "landing-390@2x");
    });

    test("/sign-in stays usable at 200% zoom (390 @2x)", async ({ page }, testInfo) => {
      await page.goto("/sign-in");
      await expect(page.getByTestId("sign-in-form")).toBeVisible();
      await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
      await expectNoHorizontalScroll(page, "/sign-in @ 390 @2x");
      await expectScreenshotSmoke(page, testInfo, "sign-in-390@2x");
    });
  });

  test.describe("768 @2x", () => {
    test.use({ deviceScaleFactor: 2, viewport: { width: 768, height: 1024 } });

    test("/ stays usable at 200% zoom (768 @2x)", async ({ page }, testInfo) => {
      await page.goto("/");
      await expect(page.getByTestId("landing-footer")).toBeVisible();
      await expect(page.getByRole("link", { name: "Start trial", exact: true })).toBeVisible();
      await expectNoHorizontalScroll(page, "/ @ 768 @2x");
      await expectScreenshotSmoke(page, testInfo, "landing-768@2x");
    });

    test("/pricing stays usable at 200% zoom (768 @2x)", async ({ page }, testInfo) => {
      await page.goto("/pricing");
      await expect(page.getByTestId("pricing-page")).toBeVisible();
      await expect(page.getByRole("link", { name: "Start trial", exact: true })).toBeVisible();
      await expectNoHorizontalScroll(page, "/pricing @ 768 @2x");
      await expectScreenshotSmoke(page, testInfo, "pricing-768@2x");
    });
  });
});

// ---------------------------------------------------------------------------
// Landing perf smoke — LCP/CLS via performance.getEntriesByType (§11e)
// ---------------------------------------------------------------------------

test.describe("M9 visual — landing perf smoke (LCP/CLS)", () => {
  test("landing CLS holds the §M9 budget; LCP is recorded (dev-mode smoke, not the §16.2 budget)", async ({
    page,
  }, testInfo) => {
    // The whole suite is chromium-only and this test runs last in the file,
    // so the route is warm — the honest precondition for a stable reading.
    await page.goto("/");
    await page.waitForLoadState("load");
    // Fully rendered before reading: the footer is the page's last section.
    await expect(page.getByTestId("landing-footer")).toBeVisible();

    const vitals = await readLandingVitals(page);

    // CLS is geometry, stable in dev: the §M9 exit criterion is a hard gate.
    expect(
      vitals.cls,
      "landing CLS (sum of layout-shift without recent input) must hold §M9's < 0.1 budget",
    ).toBeLessThan(CLS_MAX);

    // LCP: recorded + a pathological ceiling only. Guarded — an empty buffer
    // on some runner skips this half with the reason printed, never reds.
    if (vitals.lcpMs === null) {
      test.skip(
        true,
        "no largest-contentful-paint entry buffered on this runner — the LCP half is CI-owned (e2e/README.md §11e)",
      );
    }
    expect(
      vitals.lcpMs,
      `landing LCP must at least paint inside the ${LCP_SMOKE_CEILING_MS}ms smoke ceiling (the 2.5s §16.2 budget is a throttled production measurement — README §11e)`,
    ).toBeLessThanOrEqual(LCP_SMOKE_CEILING_MS);
    testInfo.annotations.push({
      type: "lcp-ms",
      description: `dev-mode LCP ${Math.round(vitals.lcpMs ?? -1)}ms (recorded, not budget-gated; CLS ${vitals.cls})`,
    });
  });
});
