import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, organization } from "better-auth/plugins";
import { role } from "better-auth/plugins/access";
import { defaultRoles } from "better-auth/plugins/organization/access";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getDialect } from "./db.js";
import type { StudioDb } from "./db.js";
import * as sqliteSchema from "./schema-sqlite.js";
import * as schema from "./schema.js";

/**
 * Better Auth factory — ADR-0003 + PRODUCT_ARCHITECTURE §7.1.
 *
 * Adapter API (verified against installed better-auth 1.7.12 types):
 *   `import { drizzleAdapter } from "better-auth/adapters/drizzle"` —
 *   the adapter lives in @better-auth/drizzle-adapter and is re-exported by
 *   `better-auth` through the subpath export `./adapters/drizzle`.
 *   The `schema` map keys are the model names (`user`, `session`, `account`,
 *   `verification`, `organization`, `member`, `invitation`, `apikey`);
 *   table column *property* names must equal the model field names.
 *
 * Plugins: organization (workspaces; roles owner|admin|editor|viewer — the
 * plugin default `member` role is never assigned by our product), apiKey
 * (@better-auth/api-key, hashed at rest), admin (staff actions: ban, role
 * changes, list memberships).
 */
export interface AuthEnv {
  readonly databaseUrl: string;
  /** Public app origin, e.g. https://app.studio.internal — used as baseURL + trusted origin. */
  readonly appUrl: string;
  /** Session/CSRF secret. */
  readonly secret: string;
  /** Force `Secure` session cookies (default: https app URL). */
  readonly secureCookies?: boolean;
  readonly google?: { readonly clientId: string; readonly clientSecret: string };
  readonly github?: { readonly clientId: string; readonly clientSecret: string };
  /** Reuse an existing drizzle/postgres.js handle (e.g. from createDb) instead of creating one. */
  readonly db?: StudioDb;
}

/** The auth instance type (BetterAuthInstance). Created by {@link createAuth}. */
export type Auth = ReturnType<typeof betterAuth>;

/** Hono mounting: `app.all("/auth/{*any}", (c) => auth.handler(c.req.raw))`. */
export type AuthHandler = Auth["handler"];

function defaultSecureCookies(appUrl: string): boolean {
  try {
    return new URL(appUrl).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * W1-b Bearer extraction for the apiKey plugin. Verified against the installed
 * @better-auth/api-key 1.7.12: there is NO `bearer`/`enableBearer` option — the
 * plugin reads keys from `x-api-key` (configurable via `apiKeyHeaders`) or a
 * `customAPIKeyGetter`. Studio keys ride `Authorization: Bearer <key>` ONLY,
 * so the getter below is the one sanctioned hook: it returns null for every
 * other shape (cookie requests included), which keeps the plugin's session
 * hook entirely off the cookie path.
 */
function bearerApiKeyFromContext(ctx: {
  readonly headers?: Headers | null;
  readonly request?: { readonly headers?: Headers | null } | null;
}): string | null {
  const raw = ctx.request?.headers?.get("authorization") ?? ctx.headers?.get("authorization");
  if (raw === null || raw === undefined || raw === "") return null;
  const trimmed = raw.trim();
  if (!/^bearer\s+/i.test(trimmed)) return null;
  const key = trimmed.replace(/^bearer\s+/i, "").trim();
  return key === "" ? null : key;
}

export function createAuth(env: AuthEnv): Auth {
  const db = env.db ?? drizzle(postgres(env.databaseUrl, { max: 10 }), { schema });

  // W1-03 (sqlite dev server): the drizzle adapter is dialect-aware. On a
  // sqlite dev handle two things change:
  //  - `transaction: false` — better-auth wraps multi-write operations in
  //    `db.transaction(async cb)`; the better-sqlite3 driver is SYNCHRONOUS
  //    and rejects promise-returning callbacks ("Transaction function cannot
  //    return a promise"), so the wrapper must stay off. Dev-server auth
  //    operations run unwrapped; Postgres keeps the transactional wrapper.
  //  - the SQLITE TWIN tables + `provider: "sqlite"` — the pg tables carry
  //    pg column mappers (Date→ISO string) that would write wrong shapes into
  //    the twin's integer-ms timestamp columns; provider "sqlite" also flips
  //    better-auth's id/JSON capability flags to the sqlite set.
  const isSqlite = getDialect(db) === "sqlite";
  const authSchema = isSqlite ? sqliteSchema : schema;

  const socialProviders: {
    google?: { clientId: string; clientSecret: string };
    github?: { clientId: string; clientSecret: string };
  } = {};
  if (env.google) {
    socialProviders.google = {
      clientId: env.google.clientId,
      clientSecret: env.google.clientSecret,
    };
  }
  if (env.github) {
    socialProviders.github = {
      clientId: env.github.clientId,
      clientSecret: env.github.clientSecret,
    };
  }

  // The concrete generic (plugin-inferred) is not serializable at the export
  // boundary; normalize to the public BetterAuthInstance type. Same object —
  // this only widens the (invariant) option generic.
  return betterAuth({
    baseURL: env.appUrl,
    secret: env.secret,
    trustedOrigins: [env.appUrl],
    database: drizzleAdapter(db, {
      provider: isSqlite ? "sqlite" : "pg",
      transaction: !isSqlite,
      schema: {
        user: authSchema.user,
        session: authSchema.session,
        account: authSchema.account,
        verification: authSchema.verification,
        organization: authSchema.organization,
        member: authSchema.member,
        invitation: authSchema.invitation,
        apikey: authSchema.apiKey,
      },
    }),
    emailAndPassword: { enabled: true },
    socialProviders,
    advanced: {
      useSecureCookies: env.secureCookies ?? defaultSecureCookies(env.appUrl),
    },
    plugins: [
      organization({
        creatorRole: "owner",
        // Register our extra wire-stable roles so better-auth accepts them on
        // invites. W3-gw bugfix: better-auth 1.7.12 REPLACES the built-in role
        // set when `roles` is passed (hasPermission uses
        // `{...options.roles || defaultRoles}`), so listing only editor/viewer
        // wiped owner/admin/member access-control statements — the org OWNER
        // then failed every better-auth permission check (invite, org update).
        // Spread the defaults first, then add ours on top. Capability
        // enforcement still lives in @studio/db/permissions + the gateway
        // (§3.3); better-auth defaults still gate org management to
        // admin|owner.
        roles: {
          ...defaultRoles,
          editor: role({}),
          viewer: role({}),
        },
      }),
      // W1-b (BUILD_PLAN §M1 tasks 1+2, AUD-1 gap #2): workspace API keys.
      // Plugin facts verified against installed @better-auth/api-key 1.7.12:
      //  - `references` stays "user" (the plugin default): the session-mock
      //    hook (below) is USER-referenced-only — it throws for organization
      //    references — so keys act as their minting user (PAT model) through
      //    the existing gateway session/workspace middleware chain.
      //  - `enableMetadata: true`: the workspace binding rides key metadata
      //    (`{workspaceId, createdBy}`) — the plugin REJECTS metadata when the
      //    option is absent.
      //  - `enableSessionForAPIKeys: true` + the Bearer-only getter above: a
      //    valid `Authorization: Bearer <key>` mints a session for the key's
      //    user on better-auth's own endpoints (`/get-session` short-circuits),
      //    which is what the gateway's requireAuth → auth.api.getSession path
      //    consumes. The plugin warns this grants session powers to keys —
      //    accepted for v1 (§7.1 PAT model): keys are hashed at rest, revocable
      //    (verify hard-fails `enabled: false`) and workspace-bound; cookie
      //    sessions remain the only way to reach /v1/auth/* mutations.
      //  - Per-key rate limiting is left OFF at mint time (the route passes
      //    the plugin's server-only `rateLimitEnabled: false`): the plugin's
      //    default is 10 requests/day/key, which would starve legitimate
      //    automation, and the gateway already applies §7.3 per-IP route-class
      //    token buckets to Bearer requests. `lastUsedAt` tracking still
      //    works (the skip path updates `lastRequest` on every verify).
      apiKey({
        enableMetadata: true,
        enableSessionForAPIKeys: true,
        customAPIKeyGetter: (ctx) =>
          bearerApiKeyFromContext(
            ctx as unknown as {
              readonly headers?: Headers | null;
              readonly request?: { readonly headers?: Headers | null } | null;
            },
          ),
      }),
      admin(),
    ],
  }) as unknown as Auth;
}
