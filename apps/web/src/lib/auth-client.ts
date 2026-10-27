import { createAuthClient } from "better-auth/client";
import { organizationClient } from "better-auth/client/plugins";

/**
 * Better Auth browser client (client only — the server half lives in the
 * gateway's better-auth setup, and both MUST stay on the same better-auth
 * version: ^1.7.12).
 *
 * baseURL points at the auth API root: `${NEXT_PUBLIC_APP_URL}/v1/auth`
 * (docs/PRODUCT_ARCHITECTURE.md §7.1/§7.2 — auth is mounted under /v1/auth).
 * better-auth validates the URL at module-evaluation time (new URL(...) —
 * it must be absolute even in the browser bundle), so a missing env var
 * falls back to the dev origin below. Production builds set
 * NEXT_PUBLIC_APP_URL to the canonical origin.
 *
 * Fallback posture (seo.ts parity, w3-b06): LOCAL DEVELOPMENT stays silent —
 * the env is intentionally optional there. ANY OTHER BUILD falls back but
 * ERRORS LOUDLY once at module load: a prod build missing the env points
 * every browser auth call at the user's own localhost, and that
 * misconfiguration must be visible. It must NOT throw — auth is not worth
 * taking the client bundle down for.
 *
 * The organization plugin is required for the invite flow
 * (organization.getInvitation / acceptInvitation / rejectInvitation — method
 * names verified against better-auth 1.7.12 .d.ts, see
 * dist/plugins/organization/routes/crud-invites.d.mts).
 */

/** The dev fallback origin (better-auth needs an absolute URL at module-eval). */
const FALLBACK_APP_URL = "http://localhost:3000";

/** True only for local development boots (`next dev`, APP_ENV=local) — seo.ts parity. */
function isLocalDevelopment(): boolean {
  return process.env.APP_ENV === "local" || process.env.NODE_ENV === "development";
}

const APP_URL = (() => {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  if (configured !== undefined && configured.length > 0) return configured;
  if (!isLocalDevelopment()) {
    // biome-ignore lint/suspicious/noConsole: the loud non-local fallback error IS the product behavior here (deploy visibility), not debug logging
    console.error(
      `[auth] NEXT_PUBLIC_APP_URL is not set — browser auth calls fall back to the dev origin ${FALLBACK_APP_URL}. Fix the deployment: set NEXT_PUBLIC_APP_URL to the public origin (e.g. https://app.example.com) and rebuild (NEXT_PUBLIC_* vars are baked at build time). Detected APP_ENV=${process.env.APP_ENV ?? "unset"}, NODE_ENV=${process.env.NODE_ENV ?? "unset"}, NEXT_PUBLIC_APP_URL=${configured === undefined ? "unset" : "blank"}.`,
    );
  }
  return FALLBACK_APP_URL;
})();

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
