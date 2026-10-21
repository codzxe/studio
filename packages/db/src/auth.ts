import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, organization } from "better-auth/plugins";
import { role } from "better-auth/plugins/access";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type { StudioDb } from "./db.js";
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

export function createAuth(env: AuthEnv): Auth {
  const db = env.db ?? drizzle(postgres(env.databaseUrl, { max: 10 }), { schema });

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
      provider: "pg",
      transaction: true,
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        organization: schema.organization,
        member: schema.member,
        invitation: schema.invitation,
        apikey: schema.apiKey,
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
        // invites. Capability enforcement lives in @studio/db/permissions +
        // the gateway (§3.3); better-auth defaults still gate org management
        // (invite/remove/billing) to admin|owner.
        roles: {
          editor: role({}),
          viewer: role({}),
        },
      }),
      apiKey(),
      admin(),
    ],
  }) as unknown as Auth;
}
