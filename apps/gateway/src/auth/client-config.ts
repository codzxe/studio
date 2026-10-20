// The auth CLIENT config the web app consumes (W4-A; §16.3, ADR-0003).
//
// Exported as a JSON-serializable value — no secrets, no server imports: it is
// the shape `createAuthClient` (better-auth/react) is initialized with in
// apps/web, so client wiring is a copy, not a rewrite:
//
//   import { createAuthClient } from "better-auth/react";
//   import { organizationClient } from "better-auth/client/plugins";
//   import { adminClient } from "better-auth/client/plugins";
//   import { apiKeyClient } from "@better-auth/api-key/client";
//   import { buildWebAuthClientConfig } from "@studio/gateway/src/auth/client-config.js";
//   // (or a shared copy of the value — it must stay secret-free to cross the
//   // package boundary; see tests: JSON.stringify(config) never carries the
//   // AUTH_SECRET/BETTER_AUTH_SECRET values)
//
//   export const authClient = createAuthClient({
//     baseURL: config.baseURL,                  // gateway origin — /api/auth/*
//     plugins: [
//       organizationClient({ teams: { enabled: config.plugins.organization.teams.enabled } }),
//       apiKeyClient(),
//       adminClient()
//     ]
//   });
//
// §15.2 posture notes for the web wave:
//   - cookies are set by the gateway (httpOnly + secure + sameSite via Better
//     Auth defaults on https); the browser never sees a token;
//   - CORS/CSRF: the gateway trusts only APP_URL (trustedOrigins, server.ts);
//   - `basePath` is Better Auth's default mount — keep the gateway Caddyfile
//     route in sync (§17.2).

export interface WebAuthClientConfig {
  /** Gateway origin serving /api/auth/* (= BETTER_AUTH_URL, .env.example). */
  readonly baseURL: string;
  /** Better Auth default mount path. */
  readonly basePath: "/api/auth";
  /** Client plugin flags — MUST mirror the server plugins (server.ts). */
  readonly plugins: {
    readonly organization: {
      readonly teams: {
        readonly enabled: true;
        /** No default team is auto-created until team tables land (server.ts). */
        readonly defaultTeam: { readonly enabled: false };
      };
    };
    readonly apiKey: {
      readonly enabled: true;
      /** §15.2 scope strings a key may request. */
      readonly scopes: readonly string[];
    };
    readonly admin: {
      readonly enabled: true;
      /** Platform-level default user role (admin plugin, server.ts). */
      readonly defaultRole: "user";
    };
  };
}

/**
 * Build the web client config for a gateway origin. Pure + frozen; validated
 * shape (a URL, not just any string) so a bad env fails at build, not at
 * click-time (§4 fail-fast posture).
 */
export function buildWebAuthClientConfig(input: {
  readonly baseURL: string;
}): Readonly<WebAuthClientConfig> {
  const baseURL = input.baseURL.trim();
  if (baseURL.length === 0) {
    throw new Error(
      "[auth] webAuthClientConfig requires the gateway origin (BETTER_AUTH_URL)."
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(baseURL);
  } catch {
    throw new Error("[auth] webAuthClientConfig.baseURL must be an http(s) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("[auth] webAuthClientConfig.baseURL must be an http(s) URL.");
  }
  return Object.freeze({
    baseURL,
    basePath: "/api/auth",
    plugins: Object.freeze({
      organization: Object.freeze({
        teams: Object.freeze({
          enabled: true,
          defaultTeam: Object.freeze({ enabled: false })
        })
      }),
      apiKey: Object.freeze({
        enabled: true,
        // §15.2: keys are scoped to exactly this set (api-keys.js).
        scopes: ["documents:read", "documents:write", "runs:create", "exports:create"]
      }),
      admin: Object.freeze({ enabled: true, defaultRole: "user" })
    })
  });
}
