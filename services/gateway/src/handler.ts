// @studio/gateway — fetch handler for serverless mounts (§14 deployment).
//
// The exact dependency wiring of startServer() (index.ts) minus the Node
// listener and the signal plumbing: env parse (fail fast) → lazy db handle →
// better-auth → repos → buildApp. The result is a plain
// (Request) => Promise<Response> the Vercel adapter (api/gateway.ts) and any
// other fetch-shaped host (edge workers, tests) can call directly.
//
// The app is built ONCE per process/instance and memoized: a serverless warm
// instance reuses its db pool, auth instance, rate-limiter state and run
// registry. A cold-start build failure rejects the first request AND clears
// the memo, so the next request retries the build instead of wedging the
// instance on a cached rejection (e.g. a transient env fix via redeploy).

import { sql } from "drizzle-orm";

import { createAuth, createDb, createRepos } from "@studio/db";

import { buildApp } from "./app.js";
import { adaptBetterAuth } from "./auth.js";
import { type GatewayDeps, createInMemoryChatReplayStore } from "./context.js";
import { GATEWAY_VERSION, authBaseFor, getGatewayEnv } from "./env.js";
import { createInMemoryIdempotencyStore } from "./idempotency.js";
import { createLogger } from "./logger.js";
import { createInMemoryRateLimiter } from "./rate-limit.js";
import { RunRegistry, createRunnerForEnv } from "./runner.js";
import { createStorage } from "./storage.js";
import { createStripeSeam } from "./stripe.js";

type GatewayApp = ReturnType<typeof buildApp>;

let appPromise: Promise<GatewayApp> | undefined;

async function buildOnce(): Promise<GatewayApp> {
  const env = getGatewayEnv();
  const logger = createLogger(env);

  // Postgres: lazy pool (postgres.js connects on first query).
  const db = createDb(env.db.url);
  const auth = adaptBetterAuth(
    createAuth({
      databaseUrl: env.db.url,
      // §7.1 + W2-b: better-auth serves under our /v1/auth/* mount — its
      // internal basePath comes from this URL's path.
      appUrl: authBaseFor(env),
      secret: env.auth.secret,
      trustedOrigins: env.auth.trustedOrigins,
      google: { clientId: env.auth.google.id, clientSecret: env.auth.google.secret },
      github: { clientId: env.auth.github.id, clientSecret: env.auth.github.secret },
      db,
    }),
  );
  const repos = createRepos(db);
  const storageChoice = createStorage(env);

  const deps: GatewayDeps = {
    env,
    auth,
    repos,
    storage: storageChoice.driver,
    local: storageChoice.local,
    runner: createRunnerForEnv(env, logger),
    runs: new RunRegistry(),
    limiter: createInMemoryRateLimiter(),
    idempotency: createInMemoryIdempotencyStore(),
    chatReplay: createInMemoryChatReplayStore(),
    logger,
    stripe: createStripeSeam(env),
    version: GATEWAY_VERSION,
    dbHealth: async () => {
      await db.execute(sql`select 1`);
      return true;
    },
  };

  return buildApp({ deps });
}

/**
 * Handle one gateway request. `request` must carry the FULL `/v1/...` path
 * (Hono routes on the pathname only — the origin is irrelevant). Builds the
 * app on first use per process.
 */
export async function gatewayFetch(request: Request): Promise<Response> {
  if (appPromise === undefined) {
    appPromise = buildOnce().catch((error: unknown) => {
      appPromise = undefined;
      throw error;
    });
  }
  const app = await appPromise;
  return app.fetch(request);
}
