// @studio/config — engine-pool env (supervisor spawning photocraft-cli serve, §3.1).
// One engine process per active session, per-tenant token + capability roots (§3.2).
// Fail fast on every required variable (§4). Secrets are never defaulted.
import { z } from 'zod';
import {
  httpUrl,
  nodeEnv,
  parseEnvSchema,
  portFromString,
  positiveIntFromString,
  positiveIntMsFromString,
  postgresUrl,
  requiredString,
  valkeyUrl,
  type EnvSource,
} from './shared.js';

export const enginePoolEnvSchema = z
  .object({
    NODE_ENV: nodeEnv,
    // Internal control API of the supervisor itself (policy default).
    PORT: portFromString.default(3002),

    // The pool resolves workspace → capability roots, so it reads the DB (§3.2).
    DATABASE_URL: postgresUrl,
    // Valkey is optional here: the worker reaches the pool over RPC; Valkey is
    // only used for optional health/metrics publishing.
    VALKEY_URL: valkeyUrl.optional(),

    // Engine session settings (§3.2/§3.4). Binary path is explicit — never defaulted.
    ENGINE_BINARY_PATH: requiredString,
    ENGINE_CAPABILITY_ROOT_BASE: requiredString,

    // Timeouts per §3.4: tool 5 s, render 30 s, run 10 min, session idle 15 min.
    ENGINE_TOOL_TIMEOUT_MS: positiveIntMsFromString.default(5000),
    ENGINE_RENDER_TIMEOUT_MS: positiveIntMsFromString.default(30000),
    ENGINE_RUN_TIMEOUT_MS: positiveIntMsFromString.default(600000),
    ENGINE_SESSION_IDLE_TIMEOUT_MS: positiveIntMsFromString.default(900000),

    // Connection cap per session — mirrors vendor automation/src/security.rs (16).
    ENGINE_SESSION_MAX_CONNECTIONS: positiveIntFromString.default(16),
    // Memory/CPU watchdog limit (§3.2) — policy default, tune per box.
    ENGINE_SESSION_MEM_LIMIT_MB: positiveIntFromString.default(2048),
    // Global pool ceiling; per-plan session caps live in constants/limits.ts
    // (1/3/6 concurrent sessions per plan, §14.1).
    ENGINE_POOL_MAX_SESSIONS: positiveIntFromString.default(32),

    // Observability (§22) — all optional.
    OTEL_EXPORTER_OTLP_ENDPOINT: httpUrl.optional(),
    GLITCHTIP_DSN: httpUrl.optional(),
  })
  .strict();

export type EnginePoolEnv = z.infer<typeof enginePoolEnvSchema>;

/** Parses `process.env` (or a source) into a typed EnginePoolEnv or fails fast (§4). */
export function parseEnginePoolEnv(env: EnvSource = process.env): EnginePoolEnv {
  return parseEnvSchema('engine-pool', enginePoolEnvSchema, env);
}

export { parseEnginePoolEnv as parseEnv };
