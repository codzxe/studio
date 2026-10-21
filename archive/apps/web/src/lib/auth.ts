"use client";

// apps/web — Better Auth React client + shared auth helpers (W8-B; §15.2, §13).
//
// Server contract (the better-auth contract, W4-A): apps/gateway/src/auth/
// {client-config.ts, server.ts} — Better Auth is served by the GATEWAY at its
// default basePath `/api/auth` (BETTER_AUTH_URL; §17.2 Caddy routes it behind
// the single production domain). This module is the browser mirror of that
// contract: same plugins, no secrets, no server imports ever.
//
// Transport split (W8-B): `/api/auth/*` calls go through this Better Auth
// client and NEVER touch src/lib/api.ts; every other gateway call stays on
// api.ts (`/v1/*`, ApiError envelopes). Better Auth client methods never
// throw — they resolve `{ data, error }`; map every error through
// `toAuthFormError` before it reaches the UI.
//
// Import only from client components. The "use client" boundary above keeps
// a stray server import from silently executing this in RSC (it becomes a
// client reference and fails loudly at build instead).

import {
  adminClient,
  magicLinkClient,
  organizationClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Gateway origin
// ---------------------------------------------------------------------------

/** Env source shape (mirror of src/lib/env.ts's `EnvSource`; keeps tests pure). */
export type AuthEnvSource = Record<string, string | undefined>;

const HTTP_URL = /^https?:\/\//;

function normalizeOrigin(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Resolve the gateway origin that serves `/api/auth/*` — the auth client's
 * `baseURL` (= the gateway's BETTER_AUTH_URL, see client-config.ts).
 *
 * Order:
 *  1. `NEXT_PUBLIC_GATEWAY_URL` — the W8-B contract variable (explicit
 *     gateway origin);
 *  2. `NEXT_PUBLIC_API_BASE_URL` minus its trailing `/v1` — derives the origin
 *     from the REST base the app already ships (§13);
 *  3. `""` — same-origin: the correct topology in production where Caddy
 *     serves the app and the gateway on one domain (§17.2); Better Auth then
 *     falls back to `window.location.origin + /api/auth`.
 *
 * NEVER throws (unlike src/lib/env.ts's fail-fast read): this runs at module
 * scope and `next build` prerenders client components without a `.env` (see
 * the counter-policy note in src/lib/env.ts); a bad or missing value surfaces
 * as a typed form error at click time instead of breaking the CI build.
 *
 * TODO(env owner, W8): adopt NEXT_PUBLIC_GATEWAY_URL in parseWebClientEnv
 * (src/lib/env.ts) + .env.example so this module stops reading process.env
 * directly ("app code never reads process.env directly" — src/lib/env.ts).
 */
export function resolveGatewayBaseURL(env: AuthEnvSource = process.env): string {
  const explicit = env.NEXT_PUBLIC_GATEWAY_URL?.trim();
  if (typeof explicit === "string" && explicit !== "" && HTTP_URL.test(explicit)) {
    return normalizeOrigin(explicit);
  }
  const restBase = env.NEXT_PUBLIC_API_BASE_URL?.trim();
  if (typeof restBase === "string" && restBase !== "" && HTTP_URL.test(restBase)) {
    return normalizeOrigin(restBase).replace(/\/v\d+$/, "");
  }
  return "";
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * The app's singleton Better Auth client (`createAuthClient` from
 * `better-auth/react` — the reactive build with the session hooks).
 *
 * Plugins mirror the server trio in apps/gateway/src/auth/server.ts, minus
 * the documented gaps:
 *  - `organizationClient` — workspaces/members/invites (§15.2 RBAC ladder);
 *    `teams.enabled: true` mirrors server.ts (team tables are absent in
 *    @studio/db, so no default team exists — the flags must stay identical
 *    on both sides, client-config.ts);
 *  - `adminClient` — platform-level support tooling (admin plugin, server.ts);
 *  - `magicLinkClient` — the sign-in "Magic link" tab is built on better-
 *    auth's magic-link API (`authClient.signIn.magicLink`).
 *    TODO(gateway, email wave): apps/gateway must enable the `magicLink()`
 *    server plugin before that tab can succeed — until then it surfaces the
 *    typed envelope error below instead of throwing;
 *  - `apiKeyClient` is NOT mounted: `@better-auth/api-key` is not a web
 *    dependency yet (the §15.2 API-key UI lands with the settings wave);
 *    add it to apps/web/package.json first.
 *
 * Cookie posture (§15.2): the httpOnly session cookie is set by the gateway;
 * `credentials: "include"` carries it (better-auth defaults this too — kept
 * explicit because dev is cross-origin: web :3000 → gateway :8787).
 */
export const authClient = createAuthClient({
  baseURL: resolveGatewayBaseURL(),
  basePath: "/api/auth",
  fetchOptions: { credentials: "include" },
  plugins: [
    organizationClient({ teams: { enabled: true } }),
    adminClient(),
    magicLinkClient(),
  ],
});

// Typing notes (W8-B):
//  - The client's TYPE is fully inferred by createAuthClient (plugins compose
//    the method surface); better-auth exports no standalone client type, so
//    `typeof authClient` is the canonical alias.
//  - Plugin endpoint payloads (e.g. organization.getInvitation) are typed
//    from the client plugins alone — treat them as untrusted and zod-parse
//    at the call site (see the invite page) rather than trusting inference.
//  - `error` results are better-fetch error objects whose exact keys vary
//    across better-auth 1.x minors (message/code/status/statusText); all
//    error UI goes through `toAuthFormError`, which narrows `unknown`.

/** The inferred Better Auth client type (all mounted plugins applied). */
export type AuthClient = typeof authClient;

/** Session shape better-auth infers from the mounted plugins. */
export type AuthSession = typeof authClient.$Infer.Session;

// ---------------------------------------------------------------------------
// Typed form errors (flat envelope)
// ---------------------------------------------------------------------------

/**
 * User-facing auth failure — the flat `{ ok:false, code, message, hint }`
 * envelope from docs/AGENTS.md, with `ok` dropped (this object's existence IS
 * the failure). Forms render `message` first and `hint` beneath it (§13.3).
 */
export interface AuthFormError {
  readonly code: string;
  readonly message: string;
  readonly hint: string | undefined;
}

const GENERIC_FAILURE = "Something went wrong. Please try again.";
const GENERIC_CODE = "auth_request_failed";

// The gateway's flat error envelope (docs/AGENTS.md code style). src/lib/
// api.ts keeps its own private copy for REST, so this is the auth-side twin.
const flatEnvelopeSchema = z.object({
  ok: z.literal(false),
  code: z.string(),
  message: z.string(),
  hint: z.string().optional(),
});

/** Keys we may pull off a better-fetch/better-auth client error object. */
interface AuthErrorLike {
  code?: unknown;
  message?: unknown;
  hint?: unknown;
}

/**
 * Narrow any auth failure into an AuthFormError:
 *  1. the flat gateway envelope (`{ ok:false, code, message, hint }`),
 *  2. better-auth client error objects (message/code via better-fetch),
 *  3. anything else (network garbage, thrown strings) → generic copy that
 *     leaks no internals (§15.2).
 */
export function toAuthFormError(error: unknown): AuthFormError {
  const flat = flatEnvelopeSchema.safeParse(error);
  if (flat.success) {
    return { code: flat.data.code, message: flat.data.message, hint: flat.data.hint };
  }
  if (typeof error === "object" && error !== null) {
    const like = error as AuthErrorLike;
    const message =
      typeof like.message === "string" && like.message.length > 0
        ? like.message
        : GENERIC_FAILURE;
    const code =
      typeof like.code === "string" && like.code.length > 0 ? like.code : GENERIC_CODE;
    const hint =
      typeof like.hint === "string" && like.hint.length > 0 ? like.hint : undefined;
    return { code, message, hint };
  }
  return { code: GENERIC_CODE, message: GENERIC_FAILURE, hint: undefined };
}

// ---------------------------------------------------------------------------
// Post-auth routing
// ---------------------------------------------------------------------------

/** Where successful auth flows land: the (app) dashboard route. */
export const POST_AUTH_PATH = "/dashboard";

/**
 * Validate a `?next=` return path before redirecting: internal absolute
 * paths only (no protocol-relative `//…`, no `/\…`, no external origins), so
 * a crafted link cannot bounce users off-site after sign-in. Falls back to
 * POST_AUTH_PATH.
 */
export function safePostAuthPath(next: string | null | undefined): string {
  if (typeof next !== "string") {
    return POST_AUTH_PATH;
  }
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return POST_AUTH_PATH;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Sign-out (topbar wiring)
// ---------------------------------------------------------------------------

/**
 * End the current session and hard-navigate to the auth area.
 *
 * Topbar user-menu wiring (W8-B): the (app) topbar (owned by the app-shell
 * wave) consumes exactly this helper —
 *
 *   import { signOut } from "@/lib/auth";
 *   <button type="button" onClick={() => { void signOut(); }}>Sign out</button>
 *
 * `window.location` (not the router) so server components re-render from a
 * cold, session-less request; the `finally` covers network failures so
 * users are never stranded on a dead menu (§15.2: no stack/internal leaks —
 * the failure is silent by design, the next page load tells the truth).
 */
export async function signOut(redirectTo: string = "/sign-in"): Promise<void> {
  try {
    await authClient.signOut(); // revokes the session server-side + clears the cookie
  } finally {
    window.location.assign(redirectTo);
  }
}
