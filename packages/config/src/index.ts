// @studio/config — the single home for env parsing, constants, events, errors
// and feature-flag types (spec §4). Everything is re-exported here; apps must
// import from `@studio/config` only.
export {
  EnvFatalError,
  isEnvFatalError,
  httpUrl,
  nodeEnv,
  optionalString,
  parseEnvSchema,
  portFromString,
  positiveIntFromString,
  positiveIntMsFromString,
  postgresUrl,
  requiredString,
  valkeyUrl,
  type EnvInvalidVar,
  type EnvSource,
} from './env/shared.js';

export {
  gatewayEnvSchema,
  parseGatewayEnv,
  type GatewayEnv,
} from './env/gateway.js';

export {
  configuredModelProviders,
  modelProviderHealth,
  modelProviderKeySchema,
  MODEL_PROVIDER_CLASSES,
  MODEL_PROVIDER_ENV_KEYS,
  workerEnvSchema,
  parseWorkerEnv,
  type ModelProviderClass,
  type ModelProviderHealth,
  type WorkerEnv,
} from './env/worker.js';

export {
  enginePoolEnvSchema,
  parseEnginePoolEnv,
  type EnginePoolEnv,
} from './env/engine-pool.js';

export { webEnvSchema, parseWebEnv, type WebEnv } from './env/web.js';

export * from './constants/tiers.js';
export * from './constants/pricing.js';
export * from './constants/limits.js';
export * from './constants/events.js';
export * from './errors.js';
export * from './flags.js';
