// Transport-level env for the gateway (W1-H skeleton).
//
// CHOICE (per task W1-H, "either is fine — note the choice"): the FULL env
// matrix is validated once by `packages/config` — `src/index.ts` calls
// `parseGatewayEnv(process.env)` (verified W1-B contract:
// `(env: EnvSource = process.env) => GatewayEnv`) as the fail-fast gate (§4
// "missing var = process refuses to start"). That import lives ONLY in the
// bootstrap file, so this module — and every test — stays hermetic and never
// touches `@studio/config`.
//
// The transport fields this skeleton needs (GATEWAY_PORT/PORT, LOG_LEVEL,
// SERVICE_VERSION) are projected here through a local Zod schema: LOG_LEVEL
// and SERVICE_VERSION are not in @studio/config's gateway schema yet, and the
// canonical matrix (ADR-0002 `.env.example`) names the port GATEWAY_PORT while
// the config schema uses PORT — this projection accepts both. When the
// config wave settles naming, buildApp deps can switch to consuming the typed
// GatewayEnv directly.
//
// SERVICE_VERSION is a local override knob (image/build tag) and is NOT yet in
// `.env.example` — flag for the config wave to adopt or drop (ADR-0002 rule).

import { z } from "zod";

/** Log levels from the canonical matrix (.env.example LOG_LEVEL, §22). */
const LOG_LEVELS = ["trace", "debug", "info", "warn", "error"] as const;

export const gatewayTransportSchema = z.object({
  /** Listen port — .env.example GATEWAY_PORT, with PORT as the config-schema/PaaS fallback. */
  GATEWAY_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  SERVICE_VERSION: z.string().min(1).default("0.1.0")
});

export type TransportEnv = z.infer<typeof gatewayTransportSchema>;

/**
 * Project the gateway's transport fields out of a process env (no side effects,
 * throws a ZodError on malformed values — the bootstrap turns that into a
 * refuse-to-start).
 */
export function parseTransportEnv(processEnv: NodeJS.ProcessEnv): TransportEnv {
  return gatewayTransportSchema.parse({
    GATEWAY_PORT: processEnv.GATEWAY_PORT ?? processEnv.PORT,
    LOG_LEVEL: processEnv.LOG_LEVEL,
    SERVICE_VERSION: processEnv.SERVICE_VERSION ?? processEnv.npm_package_version
  });
}
