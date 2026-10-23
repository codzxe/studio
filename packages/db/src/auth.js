import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, organization } from "better-auth/plugins";
import { role } from "better-auth/plugins/access";
import { defaultRoles } from "better-auth/plugins/organization/access";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";
function defaultSecureCookies(appUrl) {
    try {
        return new URL(appUrl).protocol === "https:";
    }
    catch {
        return false;
    }
}
export function createAuth(env) {
    const db = env.db ?? drizzle(postgres(env.databaseUrl, { max: 10 }), { schema });
    const socialProviders = {};
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
            apiKey(),
            admin(),
        ],
    });
}
//# sourceMappingURL=auth.js.map