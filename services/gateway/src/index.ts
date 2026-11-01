// @studio/gateway — entrypoint (§14 deployment).
//
// startServer(): parse env (fail fast via @studio/config), wire real deps
// (the db handle via @studio/db — LAZY: pg pools connect on first query, so
// the gateway boots with db:false and /health reports it), build the app and
// listen on PORT (default 8787). Graceful shutdown closes the listener and
// the db handle (dialect-aware: pg pool drains, sqlite handle closes).

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { sql } from "drizzle-orm";

import { createAuth, createDb, createRepos, getDialect } from "@studio/db";

import { buildApp } from "./app.js";
import { adaptBetterAuth } from "./auth.js";
import { type GatewayDeps, createInMemoryChatReplayStore } from "./context.js";
import { AUTH_MOUNT_PATH, GATEWAY_VERSION, authBaseFor, getGatewayEnv, parsePort } from "./env.js";
import { createInMemoryIdempotencyStore } from "./idempotency.js";
import { createLogger } from "./logger.js";
import { createInMemoryRateLimiter } from "./rate-limit.js";
import { RunRegistry, createRunnerForEnv } from "./runner.js";
import { createStorage } from "./storage.js";
import { createStripeSeam } from "./stripe.js";

export interface RunningServer {
  readonly port: number;
  readonly server: ServerType;
  close(): Promise<void>;
}

/**
 * Wire the production dependency set and start the HTTP listener.
 * The gateway does NOT block on the database: `createDb` is lazy and
 * /health reports reachability; db-needing routes degrade to the typed
 * SERVICE_UNAVAILABLE envelope.
 */
export async function startServer(): Promise<RunningServer> {
  const env = getGatewayEnv();
  const logger = createLogger(env);
  const port = parsePort(process.env.PORT);

  // Postgres: lazy pool (postgres.js connects on first query).
  const db = createDb(env.db.url);
  const auth = adaptBetterAuth(
    createAuth({
      databaseUrl: env.db.url,
      // §7.1 + W2-b: better-auth serves under our /v1/auth/* Hono mount —
      // its internal basePath comes from this URL's path (verified against
      // installed better-auth 1.7.12; see auth.ts).
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

  const app = buildApp({ deps });
  const server = serve({ fetch: app.fetch, port }, (info) => {
    logger.info("gateway_listening", {
      port: info.port,
      env: env.app.env,
      mockModel: env.app.mockModel,
      authMount: AUTH_MOUNT_PATH,
    });
  });

  const close = async (): Promise<void> => {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error !== undefined) rejectClose(error);
        else resolveClose();
      });
    });
    try {
      // Dialect-aware teardown (W4-GWI, W3-A follow-up #1): the pg pool ends
      // (draining in-flight queries, bounded at 5s); the sqlite dev handle
      // closes synchronously. The static type stays createDb's pg-flavored
      // seam, so the sqlite client goes through a structural cast — the same
      // runtime-dialect-over-static-type seam the repos key off getDialect.
      if (getDialect(db) === "sqlite") {
        (db.$client as unknown as { close(): void }).close();
      } else {
        await db.$client.end({ timeout: 5 });
      }
    } catch {
      // pool already gone
    }
  };

  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
  for (const signal of signals) {
    process.once(signal, () => {
      logger.info("gateway_shutdown", { signal });
      void close().finally(() => {
        process.exit(0);
      });
    });
  }

  return { port, server, close };
}

function isInvokedDirectly(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isInvokedDirectly()) {
  try {
    await startServer();
  } catch (error) {
    // EnvFatalError and friends print safely on their own; anything else
    // still never echoes values (only names).
    // biome-ignore lint/suspicious/noConsole: server entrypoint must print startup failures to stderr
    console.error(
      "[gateway] failed to start:",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  }
}
