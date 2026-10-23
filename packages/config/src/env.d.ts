import { z } from "zod";
/** Structurally compatible with `process.env`. */
export type EnvSource = Record<string, string | undefined>;
/** Deployment environments (§14.3). */
export type AppEnv = "local" | "staging" | "production";
/** Structured log levels. */
export type LogLevel = "debug" | "info" | "warn" | "error";
/** Sections of the typed config object and of the generated .env.example. */
export type EnvGroupName = "app" | "db" | "queue" | "storage" | "stripe" | "auth" | "litellm" | "editor" | "agent" | "lease" | "render" | "obs";
/** Metadata for one env var — drives error messages and the .env.example generator. */
export interface EnvVarMeta {
    readonly name: string;
    readonly purpose: string;
    readonly group: EnvGroupName;
    /** Required unconditionally. */
    readonly required: boolean;
    /** Value must never appear in errors, logs or examples with real data. */
    readonly secret: boolean;
    /** Optional with a schema default; the .env.example shows the default. */
    readonly hasDefault: boolean;
    /** Placeholder/example emitted by writeEnvExample (never a real secret). */
    readonly example: string;
    /** Extra cross-field rule worth restating next to the example. */
    readonly condition?: string;
}
/** Every declared env var, in .env.example order. Single source of truth. */
export declare const ENV_VAR_SPECS: readonly EnvVarMeta[];
/** All declared env var names, in order. */
export declare const ENV_VAR_NAMES: readonly string[];
/** Variables whose values must never reach a log or error message. */
export declare const SECRET_ENV_VARS: readonly string[];
export declare const envSchema: z.ZodObject<{
    APP_URL: z.ZodURL;
    APP_ENV: z.ZodEnum<{
        local: "local";
        staging: "staging";
        production: "production";
    }>;
    LOG_LEVEL: z.ZodDefault<z.ZodEnum<{
        debug: "debug";
        info: "info";
        warn: "warn";
        error: "error";
    }>>;
    MOCK_MODEL: z.ZodDefault<z.ZodPipe<z.ZodString, z.ZodTransform<boolean, string>>>;
    DATABASE_URL: z.ZodString;
    VALKEY_URL: z.ZodOptional<z.ZodString>;
    S3_ENDPOINT: z.ZodOptional<z.ZodURL>;
    S3_REGION: z.ZodOptional<z.ZodString>;
    S3_ACCESS_KEY_ID: z.ZodOptional<z.ZodString>;
    S3_SECRET_ACCESS_KEY: z.ZodOptional<z.ZodString>;
    S3_BUCKET: z.ZodOptional<z.ZodString>;
    ASSET_MAX_BYTES: z.ZodCoercedNumber<unknown>;
    PROJECT_MAX_BYTES: z.ZodCoercedNumber<unknown>;
    STRIPE_SECRET_KEY: z.ZodOptional<z.ZodString>;
    STRIPE_WEBHOOK_SECRET: z.ZodString;
    STRIPE_PRICE_IDS: z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<unknown, string>>, z.ZodRecord<z.ZodString, z.ZodString>>;
    AUTH_SECRET: z.ZodString;
    AUTH_GOOGLE_ID: z.ZodString;
    AUTH_GOOGLE_SECRET: z.ZodString;
    AUTH_GITHUB_ID: z.ZodString;
    AUTH_GITHUB_SECRET: z.ZodString;
    LITELLM_BASE_URL: z.ZodURL;
    LITELLM_API_KEY: z.ZodString;
    LITELLM_VIRTUAL_KEY: z.ZodOptional<z.ZodString>;
    EDITOR_PUBLIC_PATH: z.ZodDefault<z.ZodString>;
    EDITOR_DEV_SERVER_URL: z.ZodOptional<z.ZodURL>;
    EDITOR_WASM_MAX_MB: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    CHAT_MAX_STEPS: z.ZodCoercedNumber<unknown>;
    AGENT_BATCH_MAX_STEPS: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    AGENT_BATCH_MAX_BYTES: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    AGENT_BATCH_TIMEOUT_MS: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    LEASE_HEARTBEAT_MS: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    LEASE_TTL_MS: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    EFFECTCRAFT_CLI_PATH: z.ZodOptional<z.ZodString>;
    RENDER_WORKER_ENABLED: z.ZodDefault<z.ZodPipe<z.ZodString, z.ZodTransform<boolean, string>>>;
    RENDER_WORKER_CONCURRENCY: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    RENDER_JOB_TIMEOUT_SECONDS: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    RENDER_MAX_ATTEMPTS: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    RENDER_HEARTBEAT_STALE_SECONDS: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    RENDER_POLL_INTERVAL_MS: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    OTEL_EXPORTER_OTLP_ENDPOINT: z.ZodOptional<z.ZodURL>;
}, z.core.$strip>;
/** Typed, grouped configuration returned by parseEnv/getEnv. Frozen deeply. */
export interface StudioEnv {
    readonly app: {
        readonly url: string;
        readonly env: AppEnv;
        readonly logLevel: LogLevel;
        readonly mockModel: boolean;
    };
    readonly db: {
        readonly url: string;
    };
    readonly queue: {
        /** Valkey for queues/rate limits; undefined when unset (features degrade). */
        readonly url: string | undefined;
    };
    readonly storage: {
        /** Undefined only when APP_ENV is "local" and the filesystem driver is used. */
        readonly endpoint: string | undefined;
        readonly region: string | undefined;
        readonly accessKeyId: string | undefined;
        readonly secretAccessKey: string | undefined;
        readonly bucket: string | undefined;
        readonly assetMaxBytes: number;
        readonly projectMaxBytes: number;
    };
    readonly stripe: {
        /** Undefined only when APP_ENV is "local" and the key was not provided. */
        readonly secretKey: string | undefined;
        readonly webhookSecret: string;
        readonly priceIds: Readonly<Record<string, string>>;
    };
    readonly auth: {
        readonly secret: string;
        readonly google: {
            readonly id: string;
            readonly secret: string;
        };
        readonly github: {
            readonly id: string;
            readonly secret: string;
        };
    };
    readonly litellm: {
        readonly baseUrl: string;
        readonly apiKey: string;
        readonly virtualKey: string | undefined;
    };
    readonly editor: {
        readonly publicPath: string;
        /** Dev-only proxy target; rejected in production. */
        readonly devServerUrl: string | undefined;
        readonly wasmMaxMb: number;
    };
    readonly agent: {
        readonly chatMaxSteps: number;
        readonly batchMaxSteps: number;
        readonly batchMaxBytes: number;
        readonly batchTimeoutMs: number;
    };
    readonly lease: {
        readonly heartbeatMs: number;
        readonly ttlMs: number;
    };
    readonly render: {
        /** Absolute effectcraft-cli path; undefined → repo-local build, then PATH. */
        readonly cliPath: string | undefined;
        /** Feature flag — false keeps jobs queued without dequeuing them. */
        readonly workerEnabled: boolean;
        readonly workerConcurrency: number;
        readonly jobTimeoutSeconds: number;
        readonly maxAttempts: number;
        readonly heartbeatStaleSeconds: number;
        readonly pollIntervalMs: number;
    };
    readonly obs: {
        readonly otelEndpoint: string | undefined;
    };
}
export type EnvProblemKind = "missing" | "invalid" | "rejected";
/** One failing variable: kind, name, purpose and a reason that never leaks values. */
export interface EnvProblem {
    readonly kind: EnvProblemKind;
    readonly name: string;
    readonly purpose: string;
    readonly reason: string;
}
/**
 * Typed fatal error thrown by {@link parseEnv} when the environment is invalid.
 * The message lists every failing variable with its purpose; secret values are
 * never included. Entry points should catch this, log it once, and exit.
 */
export declare class EnvFatalError extends Error {
    readonly code: "env_invalid";
    readonly appName: string;
    readonly problems: readonly EnvProblem[];
    constructor(appName: string, problems: readonly EnvProblem[]);
}
/** Type guard for fail-fast handlers in app entrypoints. */
export declare function isEnvFatalError(value: unknown): value is EnvFatalError;
/**
 * Validates `source` against the Studio env schema and returns the typed,
 * grouped, frozen config. Throws {@link EnvFatalError} naming EVERY missing or
 * invalid variable with its purpose — never any value.
 */
export declare function parseEnv(source: EnvSource): StudioEnv;
/**
 * Process-wide accessor. Defaults to `process.env` and parses once per source
 * object (WeakMap), so apps get a cheap singleton while tests can pass fresh
 * fixtures. Throws {@link EnvFatalError} on the first invalid environment.
 */
export declare function getEnv(source?: EnvSource): StudioEnv;
/**
 * Renders the .env.example body from {@link ENV_VAR_SPECS}: every variable,
 * its purpose and requirement rule, plus a placeholder value (never a secret).
 */
export declare function renderEnvExample(): string;
/**
 * Writes the generated .env.example to `path` (uses a dynamic `node:fs/promises`
 * import so importing `env.ts` from a browser bundle stays side-effect free).
 */
export declare function writeEnvExample(path: string | URL): Promise<void>;
