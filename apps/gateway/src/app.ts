// buildApp — the pure app factory (no globals, no listening, no process.env).
// `src/index.ts` is the only place that touches the outside world; everything
// here is injectable and testable via `app.request()`.

import { Hono } from "hono";
import type { Logger } from "pino";
import type { TransportEnv } from "./env.js";
import { errorMapper, notFoundHandler } from "./middleware/error-mapper.js";
import { requestLogger } from "./middleware/logger.js";
import { requestId } from "./middleware/request-id.js";
import type { Probe } from "./routes/health.js";
import { registerRoutes } from "./routes/index.js";
import type { AppEnv } from "./types.js";

export interface AppDeps {
  /** Transport env (parsed once at bootstrap, §4 / ADR-0002). */
  readonly env: TransportEnv;
  /** Root pino logger; request-scoped children are derived per request (§22). */
  readonly logger: Logger;
  /** Service version string reported by /v1/health. */
  readonly version: string;
  /** Dependency probes for GET /v1/health/deep (§13.1). */
  readonly probes: readonly Probe[];
  /** Epoch ms uptime anchor — injected so tests are deterministic. */
  readonly startedAt: number;
  /**
   * Extra mounts, applied after middleware but BEFORE registerRoutes (so test
   * or bootstrap routes win over the /v1 placeholder). Used by tests now; W2+
   * wiring may use it before routers get their own modules.
   */
  readonly mount?: (app: Hono<AppEnv>) => void;
}

/**
 * Build the Hono app. Middleware order is load-bearing:
 *   1. errorMapper  — outermost, so even request-id/logger failures get a typed
 *                     envelope (§13.3: never leak a stack trace).
 *   2. requestId    — adopt/generate + echo X-Request-Id (§22).
 *   3. requestLogger — child logger per request; one line per request.
 * Then the /v1 registry, then the 404 envelope for everything else.
 */
export function buildApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use(errorMapper(deps.logger));
  app.use(requestId());
  app.use(requestLogger(deps.logger));

  if (deps.mount) {
    deps.mount(app);
  }
  registerRoutes(app, deps);

  app.notFound(notFoundHandler(deps.logger));
  return app;
}
