// Better Auth server wiring for the gateway (W4-A; spec §15.2, §16.3, ADR-0003).
//
// What lives here:
//   - `createAuthServer(deps)` — the pure betterAuth() factory: Drizzle adapter
//     over @studio/db's auth tables, email+password auth, and the three plugins
//     §16.3 pins: `organization` (workspaces/members/roles/invites — roles are
//     the §15.2 ladder, see ./roles.js), `apiKey` (hashed, scoped public keys)
//     and `admin` (support tooling). Injectable + hermetic: no env, no network,
//     no connection at construction (postgres-js pools are lazy).
//   - `getAuthServer()` / `getAuthDb()` — the memoized process-env singletons the
//     bootstrap and middleware wiring consume; they fail fast through
//     `parseGatewayEnv` (packages/config, §4: a missing AUTH_SECRET refuses to
//     start) plus the local BETTER_AUTH_URL projection below.
//
// Mounting (wiring wave — recipe only, routing is NOT owned by src/auth/**):
//   import { getAuthServer } from "./auth/server.js";
//   app.all("/api/auth/*{path}", (c) => getAuthServer().handler(c.req.raw));
//
// Schema mapping notes (per better-auth Drizzle adapter conventions, verified
// against better-auth 1.7 dist):
//   - The adapter takes `schema` keyed by MODEL NAME → drizzle table, so all
//     eight tables of packages/db/src/schema/auth.ts are mapped explicitly:
//     user, session, account, verification, organization, member, invitation
//     and apiKey (the api-key plugin's model is renamed "apikey" → "apiKey"
//     via its `schema` option below).
//   - The api-key plugin's column names are remapped onto our table:
//     referenceId→owner_id, remaining→remaining_requests,
//     lastRequest→last_used_at, permissions→scopes (§15.2 scope strings ride
//     in api_key.scopes).
//
// KNOWN GAPS for the @studio/db owner (flagged in W4-A report — verify flow
// stays safe with the current columns, defaults make the gap unreachable):
//   - api_key has no `prefix`/`config_id`/`request_count`/`refill_*` columns,
//     so the plugin's built-in create endpoint and per-key rate limiting
//     (rate_limit_enabled=true) cannot work until they land; key creation and
//     scopes should go through a gateway route writing via Drizzle directly.
//   - team/team_member tables are absent (§16.3 asks for teams enabled):
//     `defaultTeam` auto-creation is OFF and no role holds team grants
//     (./roles.js) so team endpoints stay uncallable instead of half-working.

import { apiKey } from "@better-auth/api-key";
import { httpUrl, parseGatewayEnv, type EnvSource } from "@studio/config";
import {
  account as accountTable,
  apiKey as apiKeyTable,
  createDb,
  invitation as invitationTable,
  member as memberTable,
  organization as organizationTable,
  session as sessionTable,
  user as userTable,
  verification as verificationTable,
  type Db,
} from "@studio/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, organization } from "better-auth/plugins";
import { z } from "zod";
import { buildWorkspaceAccessControl } from "./roles.js";

// ---------------------------------------------------------------------------
// Local env projection (ADR-0002 pattern — see src/env.ts for the precedent)
// ---------------------------------------------------------------------------

const authEnvSchema = z.object({
  // Base URL where Better Auth handlers are mounted (.env.example; the gateway
  // origin — Caddy routes /api/auth/* to us in staging/prod, §17.2).
  BETTER_AUTH_URL: httpUrl
});

/** Fail-fast boot error for a misconfigured auth env (§4). */
export class AuthEnvError extends Error {
  readonly code = "auth_env_invalid" as const;
  readonly hint: string;

  constructor(message: string, hint: string) {
    super(`[auth] ${message}`);
    this.name = "AuthEnvError";
    this.hint = hint;
  }
}

export interface AuthEnv {
  /** Gateway origin Better Auth is served from (baseURL of the auth server). */
  readonly baseURL: string;
}

/**
 * Project the auth-relevant variables out of an env source. Throws
 * AuthEnvError on a missing/invalid BETTER_AUTH_URL (fail fast, §4).
 */
export function parseAuthEnv(env: EnvSource): AuthEnv {
  const result = authEnvSchema.safeParse({ BETTER_AUTH_URL: env.BETTER_AUTH_URL });
  if (!result.success) {
    const reason = result.error.issues[0]?.message ?? "invalid value";
    throw new AuthEnvError(
      `BETTER_AUTH_URL is invalid: ${reason}.`,
      "Set BETTER_AUTH_URL to the gateway origin where Better Auth handlers are mounted, e.g. http://localhost:8787 (.env.example)."
    );
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface AuthServerDeps {
  /** Drizzle handle over the studio Postgres (packages/db, lazy pool). */
  readonly db: Db;
  /** Session/cookie signing key — 32+ bytes, never defaulted (§4, §15.2). */
  readonly secret: string;
  /** Origin the auth endpoints are served from. */
  readonly baseURL: string;
  /**
   * Origins allowed for cookie-auth mutations (§15.2 CSRF). Defaults to the
   * auth origin itself; bootstrap passes the web app origin (APP_URL) too.
   */
  readonly trustedOrigins?: readonly string[];
}

/**
 * Slug for the auto-created personal workspace (vendor-starter pattern:
 * NFKD-fold, lowercase, dash-joined, capped, plus a short random suffix to
 * satisfy the organization slug UNIQUE index).
 */
function personalWorkspaceSlug(name: string): string {
  const base =
    typeof name === "string" && name.length > 0
      ? name
      : `workspace-${Date.now().toString(36)}`;
  const folded = base
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const suffix = Math.random().toString(16).slice(2, 8);
  return `${folded || "workspace"}-${suffix}`;
}

/**
 * Create the gateway's Better Auth instance. Pure configuration + lazy Drizzle
 * pool: safe to construct in tests (no connection is opened).
 *
 * Wiring mirrors the MIT reference starter (vendor/next-saas-stripe-starter
 * lib/auth/server.ts): drizzleAdapter with an explicit schema, databaseHooks
 * giving every account a personal workspace and restoring the active
 * organization on new sessions, and the §16.3 plugin trio.
 */
export function createAuthServer(deps: AuthServerDeps) {
  const auth = betterAuth({
    secret: deps.secret,
    baseURL: deps.baseURL,
    trustedOrigins: [...new Set([...(deps.trustedOrigins ?? []), deps.baseURL])],

    // §15.2/§16.3: sessions live in OUR Postgres via the Drizzle adapter —
    // every table mapped explicitly (model name → @studio/db table).
    database: drizzleAdapter(deps.db, {
      provider: "pg",
      schema: {
        user: userTable,
        session: sessionTable,
        account: accountTable,
        verification: verificationTable,
        organization: organizationTable,
        member: memberTable,
        invitation: invitationTable,
        apiKey: apiKeyTable
      }
    }),

    emailAndPassword: {
      enabled: true,
      // TODO(email wave): flip to `true` once verification emails ship
      // (§16.3 email verification; Resend/react-email). Until then sign-in
      // must stay rate-limited (§15.2) — the limiter middleware covers this.
      requireEmailVerification: false
    },

    databaseHooks: {
      user: {
        create: {
          // Every account gets a personal workspace from day one (vendor
          // starter pattern; §12.1 organization = the tenant root). The hook
          // runs after sign-up, so backfill any session created moments before.
          after: async (user, ctx) => {
            const name = user.name || (user.email.split("@")[0] ?? "workspace");
            const organization = await auth.api.createOrganization({
              body: {
                name,
                slug: personalWorkspaceSlug(name),
                userId: user.id,
                keepCurrentActiveOrganization: false
              }
            });
            if (organization && ctx) {
              await ctx.context.adapter.updateMany({
                model: "session",
                where: [{ field: "userId", value: user.id }],
                update: { activeOrganizationId: organization.id }
              });
            }
          }
        }
      },
      session: {
        create: {
          // Restore an active organization on every new session: pick the
          // oldest membership; the org switcher changes it afterwards.
          before: async (session, ctx) => {
            if (!ctx) {
              return { data: session };
            }
            const [membership] = await ctx.context.adapter.findMany<{
              organizationId: string;
            }>({
              model: "member",
              where: [{ field: "userId", value: session.userId }],
              sortBy: { field: "createdAt", direction: "asc" },
              limit: 1
            });
            return {
              data: { ...session, activeOrganizationId: membership?.organizationId ?? null }
            };
          }
        }
      }
    },

    plugins: [
      // §16.3/§15.2: workspaces, members, invites, RBAC roles.
      organization({
        // The creating member is the workspace owner (§15.2 ladder).
        creatorRole: "owner",
        // §16.3 asks for teams; the team tables are NOT in @studio/db yet, so
        // default-team auto-creation must stay OFF (creating an organization
        // would otherwise touch the missing `team` model and fail). No role
        // holds team grants either (./roles.js) — team endpoints are inert
        // until those tables land.
        teams: { enabled: true, defaultTeam: { enabled: false } },
        // owner|admin|editor|viewer statements derived from the single RBAC
        // source of truth (src/authz/roles.js, ADR-0003 matrix).
        ...buildWorkspaceAccessControl()
        // TODO(email wave): sendInvitationEmail — until it lands, invitations
        // are created but no email is sent.
      }),
      // §15.2: hashed-at-rest (SHA-256 default hasher — never disable), scoped,
      // revocable keys with last-used metadata and per-key rate limits.
      apiKey({
        // api_key.owner_id references `user` — keys are personal (the org
        // binding rides in the scopes metadata, see ./api-keys.js).
        references: "user",
        // §15.2 revocation UI needs identifiable keys.
        requireName: true,
        // Per-key limit defaults (§15.2); per-row overrides live in
        // api_key.rate_limit_* (packages/db schema/auth.ts).
        rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 100 },
        // Rename the plugin model "apikey" → our `apiKey` table and remap the
        // plugin's column names onto our schema (§15.2 + ADR-0003).
        schema: {
          apikey: {
            modelName: "apiKey",
            fields: {
              referenceId: "ownerId",
              remaining: "remainingRequests",
              lastRequest: "lastUsedAt",
              permissions: "scopes"
            }
          }
        }
      }),
      // §16.3: support tooling (ban, roles, impersonation) — platform-level
      // only; workspace RBAC stays in `member.role` (§15.2).
      admin({
        defaultRole: "user",
        adminRoles: ["admin"]
      })
    ]
  });
  return auth;
}

/** The configured Better Auth instance type (inferred with all three plugins). */
export type AuthServer = ReturnType<typeof createAuthServer>;

// ---------------------------------------------------------------------------
// Process-env singletons (bootstrap + middleware wiring)
// ---------------------------------------------------------------------------

interface AuthSingleton {
  readonly auth: AuthServer;
  readonly db: Db;
}

let singleton: AuthSingleton | null = null;

function initAuthSingleton(): AuthSingleton {
  // §4 fail fast: parseGatewayEnv throws EnvFatalError naming AUTH_SECRET (and
  // every other required gateway variable) when missing/invalid.
  const env = parseGatewayEnv(process.env);
  const { baseURL } = parseAuthEnv(process.env);
  const db = createDb(env.DATABASE_URL);
  const auth = createAuthServer({
    db,
    secret: env.AUTH_SECRET,
    baseURL,
    // §15.2: CSRF-allowed origins — the web app plus the auth origin itself.
    trustedOrigins: [env.APP_URL, baseURL]
  });
  return { auth, db };
}

/**
 * The memoized gateway auth server built from process.env. Resolves env ONCE
 * (fail fast, §4): a missing AUTH_SECRET/BETTER_AUTH_URL/DATABASE_URL throws
 * before any request is served.
 */
export function getAuthServer(): AuthServer {
  singleton ??= initAuthSingleton();
  return singleton.auth;
}

/**
 * The Drizzle handle the auth server was built on (same lazy pool). Consumers:
 * ./api-keys.js (member-role lookup for key verification). Use this instead
 * of opening a second pool.
 */
export function getAuthDb(): Db {
  singleton ??= initAuthSingleton();
  return singleton.db;
}
