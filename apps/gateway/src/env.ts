// Transport-level env for the gateway (W1-H skeleton).
//
// CHOICE (per task W1-H, "either is fine — note the choice"):
//   * The FULL env matrix is validated once by `packages/config` (W1-B contract,
//     ADR-0002): `src/index.ts` calls `parseGatewayEnv(process.env)` purely as a
//     fail-fast gate (§4 "missing var = process refuses to start"). That import
//     lives ONLY in the bootstrap file, so this module — and every test — stays
//     hermetic and never touches `@studio/config`.
//   * The handful of transport fields this skeleton needs (GATEWAY_PORT,
//     LOG_LEVEL, SERVICE_VERSION) are re-projected here through a local Zod
//     schema, so we couple only to the canonical variable names from
//     `.env.example`, not to `@studio/config`'s return shape (it may still
//     evolve during W1).
//
// SERVICE_VERSION is a local override knob (build/image tag) and is NOT yet in
// `.env.example` — flag for the config wave to adopt or drop (ADR-0002 rule).

import { z } from "zod";

/** Log levels from the canonical matrix (.env.example LOG_LEVEL, §22). */
const LOG_LEVELS = ["trace", "debug", "info", "warn", "error"] as const;

export const gatewayEnvSchema = z.object({
  /** Port the gateway listens on (.env.example GATEWAY_PORT; PORT accepted as a PaaS fallback). */
  GATEWAY_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  SERVICE_VERSION: z.string().min(1).default("0.1.0")
});

export type GatewayEnv = z.infer<typeof gatewayEnvSchema>;

/**
 * Project the gateway's transport fields out of a process env (no side effects,
 * throws a ZodError on malformed values — the bootstrap turns that into a
 * refuse-to-start).
 */
export function parseTransportEnv(processEnv: NodeJS.ProcessEnv): GatewayEnv {
  return gatewayEnvSchema.parse({
    GATEWAY_PORT: processEnv.GATEWAY_PORT ?? processEnv.PORT,
    LOG_LEVEL: processEnv.LOG_LEVEL,
    SERVICE_VERSION: processEnv.SERVICE_VERSION ?? processEnv.npm_package_version
  });
}
