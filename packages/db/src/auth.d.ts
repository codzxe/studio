import { betterAuth } from "better-auth";
import type { StudioDb } from "./db.js";
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
    readonly google?: {
        readonly clientId: string;
        readonly clientSecret: string;
    };
    readonly github?: {
        readonly clientId: string;
        readonly clientSecret: string;
    };
    /** Reuse an existing drizzle/postgres.js handle (e.g. from createDb) instead of creating one. */
    readonly db?: StudioDb;
}
/** The auth instance type (BetterAuthInstance). Created by {@link createAuth}. */
export type Auth = ReturnType<typeof betterAuth>;
/** Hono mounting: `app.all("/auth/{*any}", (c) => auth.handler(c.req.raw))`. */
export type AuthHandler = Auth["handler"];
export declare function createAuth(env: AuthEnv): Auth;
