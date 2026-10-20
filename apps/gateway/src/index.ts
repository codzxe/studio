// Gateway bootstrap — the ONLY file with process/env/signal side effects.
// Startup: parse env (fail fast) → build app → listen (pino startup log).
// Shutdown: SIGTERM/SIGINT → stop accepting → drain → close.

import { serve } from "@hono/node-server";
import { parseGatewayEnv } from "@studio/config";
import pino from "pino";
import { buildApp } from "./app.js";
import { parseTransportEnv } from "./env.js";
import { REQUEST_LOG_REDACT_PATHS } from "./middleware/logger.js";
import { stubProbes } from "./routes/health.js";

// Behind Caddy in staging/prod (§17.2); direct on localhost:8787 for local runs.
const BIND_HOST = "0.0.0.0";
// Max time to drain in-flight requests before force-closing keep-alives.
const SHUTDOWN_DRAIN_MS = 10_000;

function main(): void {
  // Fail-fast gate for the FULL env matrix (§4, ADR-0002): parseGatewayEnv is
  // the W1-B contract in packages/config — a missing/stale REQUIRED secret
  // throws here, so a misconfigured gateway never boots. NOTE(W1-H): if the
  // contract lands with a different call shape, this single call is the only
  // place to adjust.
  try {
    parseGatewayEnv(process.env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`gateway: refusing to start — invalid environment: ${message}\n`);
    process.exitCode = 1;
    return;
  }

  const env = parseTransportEnv(process.env); // GATEWAY_PORT / LOG_LEVEL / SERVICE_VERSION

  const logger = pino({
    level: env.LOG_LEVEL,
    redact: { paths: [...REQUEST_LOG_REDACT_PATHS], censor: "[redacted]" }, // §22 redaction
    base: { service: "gateway", version: env.SERVICE_VERSION }
  });

  const app = buildApp({
    env,
    logger,
    version: env.SERVICE_VERSION,
    probes: stubProbes(), // TODO(W2+): real db/valkey/storage/engine/provider probes
    startedAt: Date.now()
  });

  const server = serve({ fetch: app.fetch, port: env.GATEWAY_PORT, hostname: BIND_HOST });
  logger.info(
    { port: env.GATEWAY_PORT, hostname: BIND_HOST, pid: process.pid },
    "gateway: listening — GET /v1/health"
  );

  let draining = false;
  const shutdown = (signal: string): void => {
    if (draining) {
      return;
    }
    draining = true;
    logger.info(
      { signal, drain_timeout_ms: SHUTDOWN_DRAIN_MS },
      "gateway: stopping accept loop, draining"
    );
    server.close(() => {
      logger.info("gateway: drained — goodbye");
      process.exit(0);
    });
    server.closeIdleConnections();
    const force = setTimeout(() => {
      logger.warn("gateway: drain timeout — force-closing remaining connections");
      server.closeAllConnections();
    }, SHUTDOWN_DRAIN_MS);
    force.unref();
  };

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.on("uncaughtException", (error) => {
    logger.fatal({ err: error }, "gateway: uncaught exception — exiting");
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "gateway: unhandled rejection — exiting");
    process.exit(1);
  });
}

main();
