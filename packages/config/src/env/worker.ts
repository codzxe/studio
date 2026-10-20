// @studio/config — worker env (BullMQ consumer: agent loop, tools, critic, §3.1).
// Fail fast on every required variable (§4). Secrets are never defaulted.
import { z } from 'zod';
import {
  httpUrl,
  nodeEnv,
  parseEnvSchema,
  positiveIntMsFromString,
  postgresUrl,
  requiredString,
  valkeyUrl,
  type EnvSource,
} from './shared.js';

/**
 * Model provider classes per §5.3 (one env key per class; never a single vendor).
 * All keys are OPTIONAL: the worker must boot without any provider so it can
 * still serve queue housekeeping; routing then reports the provider as
 * unconfigured (health flag) and refuses runs whose tier needs that class.
 */
export const MODEL_PROVIDER_CLASSES = [
  'gemini',
  'anthropic',
  'openai',
  'deepseek',
  'flux',
] as const satisfies readonly string[];

export type ModelProviderClass = (typeof MODEL_PROVIDER_CLASSES)[number];

export const MODEL_PROVIDER_ENV_KEYS = {
  gemini: 'GEMINI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  flux: 'FLUX_API_KEY',
} as const satisfies Record<ModelProviderClass, string>;

export const modelProviderKeySchema = z
  .string()
  .min(8, 'looks too short to be a real API key')
  .optional();

export const workerEnvSchema = z
  .object({
    NODE_ENV: nodeEnv,

    // Postgres (run/ledger state) + Valkey (BullMQ queue) are both required (§3.1).
    DATABASE_URL: postgresUrl,
    VALKEY_URL: valkeyUrl,

    // Object storage for renders, .pcraft checkpoints, exports (§3.1 objects).
    S3_ENDPOINT: httpUrl,
    S3_BUCKET: requiredString,
    S3_REGION: requiredString,
    S3_ACCESS_KEY_ID: z
      .string()
      .min(3, 'S3 access key id looks too short')
      .refine((v) => /^[A-Za-z0-9]+$/.test(v), 'S3 access key id must be alphanumeric'),
    S3_SECRET_ACCESS_KEY: requiredString,

    // Engine session settings (§3.2/§3.4). Binary path is explicit — never defaulted.
    ENGINE_BINARY_PATH: requiredString,
    // Base directory under which per-workspace capability roots are created (§3.2).
    ENGINE_CAPABILITY_ROOT_BASE: requiredString,

    // Timeouts per §3.4: tool 5 s, render 30 s, run 10 min, session idle 15 min.
    ENGINE_TOOL_TIMEOUT_MS: positiveIntMsFromString.default('5000'),
    ENGINE_RENDER_TIMEOUT_MS: positiveIntMsFromString.default('30000'),
    ENGINE_RUN_TIMEOUT_MS: positiveIntMsFromString.default('600000'),
    ENGINE_SESSION_IDLE_TIMEOUT_MS: positiveIntMsFromString.default('900000'),

    // Model provider keys — optional-with-health-flag (§5.3). Constraint 6 (§1.5):
    // no free LLM tiers for customer data; no OpenRouter in production.
    GEMINI_API_KEY: modelProviderKeySchema,
    ANTHROPIC_API_KEY: modelProviderKeySchema,
    OPENAI_API_KEY: modelProviderKeySchema,
    DEEPSEEK_API_KEY: modelProviderKeySchema,
    FLUX_API_KEY: modelProviderKeySchema,
    FLUX_BASE_URL: httpUrl.optional(),

    // Observability (§22) — all optional.
    OTEL_EXPORTER_OTLP_ENDPOINT: httpUrl.optional(),
    LANGFUSE_PUBLIC_KEY: z.string().min(8, 'looks too short to be a real key').optional(),
    LANGFUSE_SECRET_KEY: z.string().min(8, 'looks too short to be a real key').optional(),
    GLITCHTIP_DSN: httpUrl.optional(),
  })
  .strict();

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/** Static (env-level) health of a model provider; runtime circuit breakers live in the worker. */
export interface ModelProviderHealth {
  readonly provider: ModelProviderClass;
  readonly envKey: string;
  readonly configured: boolean;
  readonly apiKey: string | null;
}

/** Returns the per-provider configuration map used for tier routing decisions (§5.3). */
export function modelProviderHealth(
  env: WorkerEnv,
): Record<ModelProviderClass, ModelProviderHealth> {
  const health = {} as Record<ModelProviderClass, ModelProviderHealth>;
  for (const provider of MODEL_PROVIDER_CLASSES) {
    const envKey = MODEL_PROVIDER_ENV_KEYS[provider];
    const apiKey = env[envKey] ?? null;
    health[provider] = { provider, envKey, configured: apiKey !== null, apiKey };
  }
  return health;
}

/** Provider classes that have a key configured in this worker's environment. */
export function configuredModelProviders(env: WorkerEnv): readonly ModelProviderClass[] {
  const health = modelProviderHealth(env);
  return MODEL_PROVIDER_CLASSES.filter((provider) => health[provider].configured);
}

/** Parses `process.env` (or a source) into a typed WorkerEnv or fails fast (§4). */
export function parseWorkerEnv(env: EnvSource = process.env): WorkerEnv {
  return parseEnvSchema('worker', workerEnvSchema, env);
}

export { parseWorkerEnv as parseEnv };
