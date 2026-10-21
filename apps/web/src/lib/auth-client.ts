import { createAuthClient } from "better-auth/client";
import { organizationClient } from "better-auth/client/plugins";

/**
 * Better Auth browser client (client only — the server half lives in the
 * gateway, Wave 3, and MUST stay on the same better-auth version: ^1.7.12).
 *
 * baseURL points at the auth API root: `${NEXT_PUBLIC_APP_URL}/v1/auth`
 * (docs/PRODUCT_ARCHITECTURE.md §7.1/§7.2 — auth is mounted under /v1/auth).
 * better-auth validates the URL at module-evaluation time (new URL(...) —
 * it must be absolute even in the browser bundle), so a missing env var
 * falls back to the dev origin http://localhost:3000. Production builds set
 * NEXT_PUBLIC_APP_URL to the canonical origin.
 *
 * The organization plugin is required for the invite flow
 * (organization.getInvitation / acceptInvitation / rejectInvitation — method
 * names verified against better-auth 1.7.12 .d.ts, see
 * dist/plugins/organization/routes/crud-invites.d.mts).
 */

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL && process.env.NEXT_PUBLIC_APP_URL.length > 0
    ? process.env.NEXT_PUBLIC_APP_URL
    : "http://localhost:3000";

export const authClient = createAuthClient({
  baseURL: `${APP_URL}/v1/auth`,
  plugins: [organizationClient()],
});

/**
 * Better Auth's default session cookie (packages/db/src/auth.ts uses the
 * default cookie prefix). The proxy (src/proxy.ts) checks presence only —
 * never validity; validation is the gateway's job.
 */
export const SESSION_COOKIE_NAME = "better-auth.session_token" as const;
