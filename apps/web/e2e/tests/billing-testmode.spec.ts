// W10-L — §21 E2E row, billing half: "billing in Stripe test mode".
//
// Plans per spec pricing: $30/mo → 100 credits, $60/mo → 250 credits,
// $120/mo → 600 credits. The (app)/billing pages are session-gated, so all
// specs need the gateway (compose "local" profile, NoopStripe seam —
// apps/gateway/src/services/stripe.ts — is the dev/test stand-in for the real
// Stripe SDK; §4 fail-fast forbids NoopStripe in production). Specs skip
// loudly while no gateway is reachable.
//
// The gateway fetches are ROUTE-MOCKED so the pricing/redirect assertions are
// deterministic without a live gateway billing service. The intercepted URL
// shapes (`**/v1/billing/plans**`, `/v1/billing/checkout`) are the PLACEHOLDER
// wire contract — align with apps/gateway/src/openapi.ts when wiring (see
// e2e/README.md §Assertable).
import { expect, test, type Page } from "@playwright/test";
import { signUpViaUi } from "../helpers/auth";
import { GATEWAY_SKIP_REASON, probeGateway } from "../helpers/gateway";

// Top-level await: one probe per worker (workers=1), before skip evaluation.
const gateway = await probeGateway();

/** PLACEHOLDER plans payload — align with the gateway billing/plans wire shape. */
const PLANS_FIXTURE = {
  ok: true,
  plans: [
    { id: "starter", name: "Starter", priceUsd: 30, credits: 100 },
    { id: "pro", name: "Pro", priceUsd: 60, credits: 250 },
    { id: "max", name: "Max", priceUsd: 120, credits: 600 },
  ],
};

/** Stripe test-mode checkout URLs look like https://checkout.stripe.com/c/pay/… */
const STRIPE_CHECKOUT_URL = /^https:\/\/checkout\.stripe\.com\/c\/pay\//;

/** Install the deterministic billing route mocks for one page. */
async function mockBilling(page: Page): Promise<void> {
  // Plans fetch — mocked so pricing renders deterministically (no live Stripe).
  await page.route("**/v1/billing/plans**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(PLANS_FIXTURE),
    }),
  );
  // Checkout session fetch — a real test-mode call would redirect to
  // checkout.stripe.com; the mock returns the same URL shape.
  await page.route(/\/v1\/billing\/checkout/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        url: "https://checkout.stripe.com/c/pay/e2e_test_mode_fixture",
      }),
    }),
  );
  // Never load stripe.com from E2E — serve a local stub at the redirect target.
  await page.route("https://checkout.stripe.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<html><body>stripe test-mode stub (E2E intercept)</body></html>",
    }),
  );
}

test.describe.serial("billing (Stripe test mode)", () => {
  test.skip(!gateway.reachable, `${GATEWAY_SKIP_REASON} (${gateway.detail})`);

  // Route-mocked fetch: needs the gateway only for the session (sign-up),
  // not for the billing calls themselves.
  test("plans: /billing renders $30 / $60 / $120", async ({ page }) => {
    await mockBilling(page);
    await signUpViaUi(page);
    await page.goto("/billing");
    await expect(page.getByText("$30").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("$60").first()).toBeVisible();
    await expect(page.getByText("$120").first()).toBeVisible();
  });

  // §21 "billing in Stripe test mode": the upgrade click must (a) hit the
  // gateway checkout endpoint and (b) land on a checkout.stripe.com/c/pay URL.
  // With the compose "local" profile + NoopStripe the same route-mocked shape
  // is served locally; with a real Stripe TEST-MODE key the live redirect
  // matches the identical pattern.
  test("checkout: upgrade click redirects to a Stripe test-mode URL", async ({ page }) => {
    const checkoutCalls: string[] = [];
    await mockBilling(page);
    await page.route(/\/v1\/billing\/checkout/, async (route) => {
      checkoutCalls.push(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          url: "https://checkout.stripe.com/c/pay/e2e_test_mode_fixture",
        }),
      });
    });
    await signUpViaUi(page);
    await page.goto("/billing");
    await expect(page.getByText("$60").first()).toBeVisible({ timeout: 15_000 });
    await page
      .locator('button:has-text("Upgrade"), button:has-text("Choose"), button:has-text("Select")')
      .first()
      .click();
    expect(checkoutCalls.length).toBeGreaterThan(0);
    expect(checkoutCalls[0] ?? "").toMatch(/\/v1\/billing\/checkout/);
    await page.waitForURL(STRIPE_CHECKOUT_URL, { timeout: 15_000 });
  });

  // The result pages are static (app) routes — cheap placeholders for the
  // Stripe-redirect round trip; both render under a signed-in session.
  test("checkout: success and cancelled pages render", async ({ page }) => {
    await signUpViaUi(page);
    await page.goto("/billing/checkout/success");
    await expect(page).toHaveURL(/\/billing\/checkout\/success/);
    await expect(page.locator("body")).toContainText(/\w/);
    await page.goto("/billing/checkout/cancelled");
    await expect(page).toHaveURL(/\/billing\/checkout\/cancelled/);
    await expect(page.locator("body")).toContainText(/\w/);
  });
});
