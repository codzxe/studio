// Shared Hono context types for the gateway.

import type { Logger } from "pino";

/**
 * Hono app env (context variables) shared by middleware and routes.
 * Kept in one place so middleware and routers stay type-compatible when mounted.
 */
export interface AppEnv {
  Variables: {
    /** §22 request/run correlation — echoed back as `X-Request-Id`. */
    requestId: string;
    /** Request-scoped pino child logger (requestId already bound). */
    logger: Logger;
  };
}
