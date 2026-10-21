// W10-L — sign-up + session bootstrap helpers. SELECTORS ARE PLACEHOLDERS.
//
// W10-L may read the (auth) pages by NAME only (task rule), so these use
// resilient attribute-based selectors. The web UI owner should add the
// `data-e2e` hooks listed in e2e/README.md §Selectors and tighten them.
//
// Auth transport (spec §13 API table): `POST /v1/auth/*` — Better Auth
// handlers live on the GATEWAY, so sign-up requires the compose "local"
// profile (or any gateway) to be reachable; specs skip otherwise.
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";

export interface E2eCreds {
  name: string;
  email: string;
  password: string;
}

/** Unique synthetic identity per journey (RFC 6761 `.test` TLD — never real). */
export function testCreds(): E2eCreds {
  const id = randomUUID().slice(0, 8);
  return {
    name: `E2E Tester ${id}`,
    email: `w10l-${id}@example.test`,
    password: "e2e-EndToEnd-0k-Pass",
  };
}

/**
 * Drive the real (auth)/sign-up form — the source of truth for the §21
 * "Sign-up" hop. PLACEHOLDER selectors: input[name="name"]/autocomplete, the
 * first email + password inputs, and the first submit button. When the form
 * posts to the gateway and succeeds, Next redirects into the (app) shell.
 */
export async function signUpViaUi(page: Page, creds: E2eCreds = testCreds()): Promise<E2eCreds> {
  await page.goto("/sign-up");
  const name = page.locator('input[name="name"], input[autocomplete="name"]').first();
  await name.fill(creds.name);
  await page.locator("input[type=email]").first().fill(creds.email);
  await page.locator("input[type=password]").first().fill(creds.password);
  await page.locator('button[type="submit"]').first().click();
  // Leaving /sign-up at all means the auth POST succeeded (or moved to an
  // error route the per-page assertions will catch next).
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-up"), { timeout: 30_000 });
  return creds;
}

/*
 * SESSION BOOTSTRAP — NOT WIRED (NOTE for the wiring wave).
 *
 * A faster shortcut for focused specs would mint a session out-of-band and
 * inject it with `context.addCookies(...)` / Playwright `storageState`
 * instead of replaying the sign-up form. Better Auth exposes
 * `POST /v1/auth/sign-up/email` (§13 API table) on the GATEWAY, and apps/web
 * currently has no src/app/api/** route visible (W10-L ls), so the exact
 * cookie domain/path shape must be confirmed against the web app's Better
 * Auth client before wiring. Recipe once confirmed:
 *   1. fetch(`${E2E_GATEWAY_URL}/v1/auth/sign-up/email`, { method: "POST",
 *      body: { name, email, password } }) from inside the test;
 *   2. copy the session cookie via `context.cookies()` after one UI sign-up
 *      and persist it as a Playwright `storageState` JSON in test-results/;
 *   3. focused specs then use `test.use({ storageState })` to skip the form.
 * Until then the UI form is the only supported bootstrap.
 */
export const SESSION_BOOTSTRAP_NOTE =
  "session bootstrap not wired — drive signUpViaUi(), or wire the documented " +
  "storageState recipe in apps/web/e2e/helpers/auth.ts once the Better Auth " +
  "cookie shape is confirmed";
