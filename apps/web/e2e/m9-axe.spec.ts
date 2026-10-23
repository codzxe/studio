/**
 * M9 axe — the CI-owned accessibility sweeps (BUILD_PLAN §M9 task 7 "axe";
 * UI_DESIGN_SYSTEM §12 "WCAG 2.2 AA minimum" + §16.4 "Axe clean").
 *
 * NEVER RUN ON THE BUILD-FLEET BOX — same class of debt as chat.spec.ts,
 * m5-agent-edits.spec.ts, m7-collab.spec.ts and m8-renders.spec.ts: this box
 * has no browsers and no dev servers, so `@playwright/test` is NOT installed
 * there; apps/web/tsconfig.json excludes `e2e` from typecheck for exactly
 * that reason and the web vitest config never matches `e2e/*.spec.ts`. CI
 * owns the devDependencies, the lockfile and the run (e2e/README.md §11c).
 *
 * ----------------------------------------------------------------------------
 * The axe devDep is CI-OWNED — the runtime import guard (the §5 contract)
 * ----------------------------------------------------------------------------
 *
 * `@axe-core/playwright` is NOT a devDependency on the build box (the
 * no-install law, docs/AGENTS.md — the same ruling that keeps
 * `@playwright/test` off it, mirrored from packages/ui/README.md §5). This
 * file therefore loads it through a RUNTIME import guard, re-checked at the
 * top of every test (no top-level await — the loader stays compatible with
 * every Playwright transform target):
 *
 *   - absent  → every test below SKIPS with the install command as its
 *               printed reason (a logged, visible skip — never a silent
 *               green, never a red);
 *   - present → the sweeps go live with zero other changes.
 *
 * CI installs it once (e2e/README.md §11c):
 *
 *   pnpm --filter @studio/web add -D @axe-core/playwright
 *
 * ----------------------------------------------------------------------------
 * Scope — the W2-10 manifest ruling
 * ----------------------------------------------------------------------------
 *
 * The sweep covers the REAL marketing + auth routes (the public surfaces).
 * The @studio/ui example galleries (packages/ui/src/components/*.example.tsx)
 * are NOT routes — a page suite cannot visit them (packages/ui/README.md
 * §5) — so the primitives are exercised in situ through the pages that
 * compose them, while the component-level floor stays the unit suite's a11y
 * assertions (roles, aria wiring, keyboard journeys). The authed shell
 * pages are swept for layout by m9-visual.spec.ts; they are not in the axe
 * contract this wave.
 *
 * ----------------------------------------------------------------------------
 * Determinism contract
 * ----------------------------------------------------------------------------
 *
 * - Boot: the README recipe, zero new env/ports; the swept routes are
 *   public, so no sign-in, no seed, no fixtures — the standard webServer.
 * - Each test waits for the page's surface testid BEFORE scanning: axe
 *   measures computed styles, so paint must be complete.
 * - The Next dev overlay (`<nextjs-portal>`) is EXCLUDED from the scan: it
 *   is dev tooling, not product DOM — excluding it keeps the gate about the
 *   app. It is the only exclusion.
 * - The full JSON report is attached to every test (`axe-report-<page>`), so
 *   a red names the exact rules and nodes — no re-run needed to diagnose.
 * - The gate is ZERO violations on the WCAG A/AA tag set. First-run policy:
 *   if a rule proves environmental (dev-only chrome), add it to
 *   AXE_DISABLED_RULES with a comment — never weaken the tag set.
 *
 * ----------------------------------------------------------------------------
 * Selector map driven by this spec (drift detector — verified in source)
 * ----------------------------------------------------------------------------
 *
 *   landing-footer (surface; the §11e landing pin)   (marketing)/page.tsx
 *   pricing-page                                     (marketing)/pricing
 *   faq-page                                         (marketing)/faq
 *   status-page                                      (marketing)/status
 *   changelog-page                                   (marketing)/changelog
 *   legal-terms / legal-privacy / legal-licences     (marketing)/legal/*
 *   sign-in-form                                     auth/sign-in-form.tsx
 *   sign-up-form                                     auth/sign-up-form.tsx
 */

import { type Page, type TestInfo, expect, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// The runtime guard (packages/ui/README.md §5 contract — CI owns the devDep)
// ---------------------------------------------------------------------------

/** Minimal local result shape (the real types ride the CI-side devDep). */
type AxeResults = {
  violations: Array<{
    id: string;
    impact: "minor" | "moderate" | "serious" | "critical" | null;
    help: string;
    helpUrl: string;
    nodes: Array<{ target: string[] }>;
  }>;
};

/**
 * Minimal local builder shape — exactly the surface this spec uses
 * (constructor takes `{ page }`; the fluent methods return the builder).
 */
type AxeBuilderInstance = {
  withTags: (tags: string[]) => AxeBuilderInstance;
  disableRules: (rules: string[]) => AxeBuilderInstance;
  exclude: (selector: string | string[]) => AxeBuilderInstance;
  analyze: () => Promise<AxeResults>;
};
type AxeBuilderCtor = new (options: { page: Page }) => AxeBuilderInstance;

/** The skip reason every axe test carries when the devDep is absent. */
const AXE_ABSENT_SKIP_REASON =
  "@axe-core/playwright is not installed — CI-owned devDep; install with `pnpm --filter @studio/web add -D @axe-core/playwright` (e2e/README.md §11c, packages/ui/README.md §5)";

/** One log line for the whole run, not one per skipped test. */
let warnedAxeAbsent = false;

/**
 * The runtime loader (the "try import" half of the §5 guard): absent → null
 * (plus a single logged warning naming the install command); present → the
 * constructor. Called at the top of every test — the ES module cache makes
 * every load after the first free.
 */
async function loadAxeBuilder(): Promise<AxeBuilderCtor | null> {
  try {
    const mod = (await import("@axe-core/playwright")) as {
      AxeBuilder: AxeBuilderCtor;
    };
    return mod.AxeBuilder;
  } catch (error) {
    if (!warnedAxeAbsent) {
      warnedAxeAbsent = true;
      // biome-ignore lint/suspicious/noConsole: the absent-devDep skip reason must stay visible in the run log
      console.warn(
        `[m9-axe] @axe-core/playwright is not installed on this box (${
          error instanceof Error ? error.message : String(error)
        }) — the a11y sweeps will SKIP with the install reason. CI installs it per e2e/README.md §11c: pnpm --filter @studio/web add -D @axe-core/playwright (packages/ui/README.md §5 contract).`,
      );
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// The sweep configuration (one place to tune — never weaken the tags)
// ---------------------------------------------------------------------------

/** §12 "WCAG 2.2 AA minimum": the WCAG 2.0/2.1 A+AA rule tags. */
const AXE_TAGS: string[] = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/**
 * Rules disabled with cause — EMPTY by design. First-run policy: an
 * environmental rule gets an entry + a comment here; the tag set stays.
 */
const AXE_DISABLED_RULES: string[] = [];

/** Dev tooling, not product DOM (the one sanctioned exclusion). */
const AXE_EXCLUDED_SELECTOR = "nextjs-portal";

/** The public routes swept (surface testids verified in source). */
const AXE_PAGES: readonly { id: string; path: string; surface: string }[] = [
  { id: "landing", path: "/", surface: "landing-footer" },
  { id: "pricing", path: "/pricing", surface: "pricing-page" },
  { id: "faq", path: "/faq", surface: "faq-page" },
  { id: "status", path: "/status", surface: "status-page" },
  { id: "changelog", path: "/changelog", surface: "changelog-page" },
  { id: "legal-terms", path: "/legal/terms", surface: "legal-terms" },
  { id: "legal-privacy", path: "/legal/privacy", surface: "legal-privacy" },
  { id: "legal-licences", path: "/legal/licences", surface: "legal-licences" },
  { id: "sign-in", path: "/sign-in", surface: "sign-in-form" },
  { id: "sign-up", path: "/sign-up", surface: "sign-up-form" },
];

// ---------------------------------------------------------------------------
// The sweeps
// ---------------------------------------------------------------------------

test.describe("M9 axe — WCAG A/AA sweeps over the public routes", () => {
  for (const entry of AXE_PAGES) {
    test(`${entry.path} is axe-clean (WCAG 2.x A/AA)`, async ({ page }, testInfo) => {
      // The §5 guard: an absent devDep is a VISIBLE skip with the install
      // command as the reason — never a silent green, never a red.
      const Builder = await loadAxeBuilder();
      test.skip(Builder === null, AXE_ABSENT_SKIP_REASON);
      if (Builder === null) {
        throw new Error("unreachable: test.skip above already aborted the absent case");
      }

      await page.goto(entry.path);
      // Paint must be complete before the scan (axe reads computed styles).
      await expect(page.getByTestId(entry.surface)).toBeVisible();

      const results = await new Builder({ page })
        .withTags(AXE_TAGS)
        .disableRules(AXE_DISABLED_RULES)
        .exclude(AXE_EXCLUDED_SELECTOR)
        .analyze();

      // The report is attached BEFORE the assert, so a red is diagnosable
      // from the artifact alone.
      await attachAxeReport(testInfo, entry.id, results);

      expect(
        results.violations,
        `${entry.path}: ${results.violations.length} WCAG A/AA violation(s) — full node list attached as axe-report-${entry.id}`,
      ).toEqual([]);
    });
  }
});

/** Attach the full axe JSON report to the test output (diagnostics-first). */
async function attachAxeReport(testInfo: TestInfo, id: string, results: AxeResults): Promise<void> {
  await testInfo.attach(`axe-report-${id}`, {
    body: JSON.stringify(results, null, 2),
    contentType: "application/json",
  });
}
