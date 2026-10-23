// @studio/config — fail-fast environment schema (PRODUCT_ARCHITECTURE §14).
//
// Every Studio env var is declared exactly once here: name, purpose, group,
// secret flag and a Zod schema. `parseEnv` refuses to start the process with a
// single fatal error listing EVERY missing/invalid variable together with its
// purpose. Secret values are never echoed — reasons are redacted against the
// raw input before they can reach a log line.
import { z } from "zod";
import { Brand } from "./brand.js";

/** Structurally compatible with `process.env`. */
export type EnvSource = Record<string, string | undefined>;

/** Deployment environments (§14.3). */
export type AppEnv = "local" | "staging" | "production";

/** Structured log levels. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Sections of the typed config object and of the generated .env.example. */
export type EnvGroupName =
  | "app"
  | "db"
  | "queue"
  | "storage"
  | "stripe"
  | "auth"
  | "litellm"
  | "editor"
  | "agent"
  | "lease"
  | "render"
  | "obs";

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

/** Fixed section order for the generated .env.example. */
const GROUP_ORDER: readonly EnvGroupName[] = [
  "app",
  "db",
  "queue",
  "storage",
  "stripe",
  "auth",
  "litellm",
  "editor",
  "agent",
  "lease",
  "render",
  "obs",
];

/** Every declared env var, in .env.example order. Single source of truth. */
export const ENV_VAR_SPECS: readonly EnvVarMeta[] = [
  // ── app ──────────────────────────────────────────────────────────────────
  {
    name: "APP_URL",
    purpose: "Public origin of the web app — auth redirects, OAuth callbacks, signed URLs, CORS.",
    group: "app",
    required: true,
    secret: false,
    hasDefault: false,
    example: "http://localhost:3000",
  },
  {
    name: "APP_ENV",
    purpose:
      "Deployment environment (local, staging, production); gates dev-only flags and billing requirements.",
    group: "app",
    required: true,
    secret: false,
    hasDefault: false,
    example: "local",
  },
  {
    name: "LOG_LEVEL",
    purpose: "Verbosity of structured logs (debug, info, warn, error).",
    group: "app",
    required: false,
    secret: false,
    hasDefault: true,
    example: "info",
  },
  {
    name: "MOCK_MODEL",
    purpose: "Offline mock model provider for local development and tests.",
    group: "app",
    required: false,
    secret: false,
    hasDefault: true,
    example: "false",
    condition:
      'Rejected when APP_ENV is "production" — it would bypass real model routing and billing.',
  },
  // ── db ───────────────────────────────────────────────────────────────────
  {
    name: "DATABASE_URL",
    purpose:
      "Postgres connection string for the control plane (auth, projects, versions, runs, credits).",
    group: "db",
    required: true,
    secret: true,
    hasDefault: false,
    example: "postgres://studio:studio@localhost:5432/studio",
  },
  // ── queue ────────────────────────────────────────────────────────────────
  {
    name: "VALKEY_URL",
    purpose: "Valkey (Redis protocol) URL for job queues and rate limits.",
    group: "queue",
    required: false,
    secret: true,
    hasDefault: false,
    example: "redis://localhost:6379",
    condition: "Optional — queues and rate limits degrade gracefully when unset.",
  },
  // ── storage ──────────────────────────────────────────────────────────────
  {
    name: "S3_ENDPOINT",
    purpose:
      "S3-compatible object-storage endpoint (MinIO locally, S3/R2 in the cloud). Optional in local: the gateway falls back to a filesystem driver under .local/storage.",
    group: "storage",
    required: false,
    secret: false,
    hasDefault: false,
    example: "http://localhost:9000",
  },
  {
    name: "S3_REGION",
    purpose:
      "Object-storage region ('auto' for MinIO/R2). Optional in local with the filesystem driver.",
    group: "storage",
    required: false,
    secret: false,
    hasDefault: false,
    example: "auto",
  },
  {
    name: "S3_ACCESS_KEY_ID",
    purpose: "Object-storage access key id. Optional in local with the filesystem driver.",
    group: "storage",
    required: false,
    secret: true,
    hasDefault: false,
    example: "minioadmin",
  },
  {
    name: "S3_SECRET_ACCESS_KEY",
    purpose: "Object-storage secret access key. Optional in local with the filesystem driver.",
    group: "storage",
    required: false,
    secret: true,
    hasDefault: false,
    example: "minioadmin",
  },
  {
    name: "S3_BUCKET",
    purpose:
      "Bucket for project versions, assets, renders and previews. Optional in local with the filesystem driver.",
    group: "storage",
    required: false,
    secret: false,
    hasDefault: false,
    example: "studio-local",
  },
  {
    name: "ASSET_MAX_BYTES",
    purpose: "Hard cap on a single uploaded asset, in bytes.",
    group: "storage",
    required: true,
    secret: false,
    hasDefault: false,
    example: "524288000",
  },
  {
    name: "PROJECT_MAX_BYTES",
    purpose: "Hard cap on a serialized .ecproj project snapshot, in bytes.",
    group: "storage",
    required: true,
    secret: false,
    hasDefault: false,
    example: "262144000",
  },
  // ── stripe ───────────────────────────────────────────────────────────────
  {
    name: "STRIPE_SECRET_KEY",
    purpose: "Stripe API secret key (sk_test_… / sk_live_…).",
    group: "stripe",
    required: false,
    secret: true,
    hasDefault: false,
    example: "sk_test_replace_me",
    condition: 'Required when APP_ENV is "staging" or "production"; optional in "local".',
  },
  {
    name: "STRIPE_WEBHOOK_SECRET",
    purpose: "Stripe webhook signing secret (whsec_…) for POST /v1/webhooks/stripe.",
    group: "stripe",
    required: true,
    secret: true,
    hasDefault: false,
    example: "whsec_replace_me",
  },
  {
    name: "STRIPE_PRICE_IDS",
    purpose: 'JSON map of billing plan to Stripe price id, e.g. {"starter":"price_…"}.',
    group: "stripe",
    required: true,
    secret: false,
    hasDefault: false,
    example: '{"starter":"price_starter","pro":"price_pro","studio":"price_studio"}',
  },
  // ── auth ─────────────────────────────────────────────────────────────────
  {
    name: "AUTH_SECRET",
    purpose:
      "Better Auth session/token signing secret; at least 32 chars (openssl rand -base64 32).",
    group: "auth",
    required: true,
    secret: true,
    hasDefault: false,
    example: "replace-with-openssl-rand-base64-32",
  },
  {
    name: "AUTH_GOOGLE_ID",
    purpose: "Google OAuth client id for sign-in.",
    group: "auth",
    required: true,
    secret: false,
    hasDefault: false,
    example: "replace-me.apps.googleusercontent.com",
  },
  {
    name: "AUTH_GOOGLE_SECRET",
    purpose: "Google OAuth client secret.",
    group: "auth",
    required: true,
    secret: true,
    hasDefault: false,
    example: "replace-me",
  },
  {
    name: "AUTH_GITHUB_ID",
    purpose: "GitHub OAuth app id for sign-in.",
    group: "auth",
    required: true,
    secret: false,
    hasDefault: false,
    example: "replace-me",
  },
  {
    name: "AUTH_GITHUB_SECRET",
    purpose: "GitHub OAuth app secret.",
    group: "auth",
    required: true,
    secret: true,
    hasDefault: false,
    example: "replace-me",
  },
  // ── litellm ──────────────────────────────────────────────────────────────
  {
    name: "LITELLM_BASE_URL",
    purpose:
      "OpenAI-compatible LiteLLM gateway base URL (serves the studio-fast/smart/vision aliases).",
    group: "litellm",
    required: true,
    secret: false,
    hasDefault: false,
    example: "http://localhost:4000",
  },
  {
    name: "LITELLM_API_KEY",
    purpose: "Platform key for the LiteLLM gateway.",
    group: "litellm",
    required: true,
    secret: true,
    hasDefault: false,
    example: "sk-litellm-replace-me",
  },
  {
    name: "LITELLM_VIRTUAL_KEY",
    purpose: "LiteLLM virtual key for per-tenant budgets and spend logs.",
    group: "litellm",
    required: false,
    secret: true,
    hasDefault: false,
    example: "sk-virtual-replace-me",
    condition: "Optional in v1 — platform keys only.",
  },
  // ── editor ────────────────────────────────────────────────────────────────
  {
    name: "EDITOR_PUBLIC_PATH",
    purpose: "Path the frozen editor build is served at (same-origin iframe mount).",
    group: "editor",
    required: false,
    secret: false,
    hasDefault: true,
    example: "/editor",
  },
  {
    name: "EDITOR_DEV_SERVER_URL",
    purpose: "Dev-only URL of the cargo xtask web server proxied at the editor path.",
    group: "editor",
    required: false,
    secret: false,
    hasDefault: false,
    example: "http://localhost:8765",
    condition: 'Dev only — rejected when APP_ENV is "production".',
  },
  {
    name: "EDITOR_WASM_MAX_MB",
    purpose: "Compressed wasm size budget in MB, enforced at serving time and in CI.",
    group: "editor",
    required: false,
    secret: false,
    hasDefault: true,
    example: "18",
  },
  // ── agent ─────────────────────────────────────────────────────────────────
  {
    name: "CHAT_MAX_STEPS",
    purpose: "Maximum model/tool steps allowed in one chat run.",
    group: "agent",
    required: true,
    secret: false,
    hasDefault: false,
    example: "50",
  },
  {
    name: "AGENT_BATCH_MAX_STEPS",
    purpose: "Maximum commands in one engine.batch (applied atomically).",
    group: "agent",
    required: false,
    secret: false,
    hasDefault: true,
    example: "100",
  },
  {
    name: "AGENT_BATCH_MAX_BYTES",
    purpose: "Maximum serialized size of one engine.batch, in bytes.",
    group: "agent",
    required: false,
    secret: false,
    hasDefault: true,
    example: "2097152",
  },
  {
    name: "AGENT_BATCH_TIMEOUT_MS",
    purpose: "Execution timeout for one engine.batch, in milliseconds.",
    group: "agent",
    required: false,
    secret: false,
    hasDefault: true,
    example: "60000",
  },
  // ── lease ────────────────────────────────────────────────────────────────
  {
    name: "LEASE_HEARTBEAT_MS",
    purpose: "Single-writer lease heartbeat interval (2 minutes by default).",
    group: "lease",
    required: false,
    secret: false,
    hasDefault: true,
    example: "120000",
  },
  {
    name: "LEASE_TTL_MS",
    purpose: "Single-writer lease expiry (5 minutes by default); must exceed the heartbeat.",
    group: "lease",
    required: false,
    secret: false,
    hasDefault: true,
    example: "300000",
  },
  // ── render (M8 worker — BUILD_PLAN §2.3 feature-flag family) ─────────────
  {
    name: "EFFECTCRAFT_CLI_PATH",
    purpose:
      "Absolute path to the effectcraft-cli binary the render worker spawns. Resolution order: this value, else <repo>/editor/target/release/effectcraft-cli if present, else a PATH lookup.",
    group: "render",
    required: false,
    secret: false,
    hasDefault: false,
    example: "",
    condition:
      "Optional and never a secret — blank resolves to the repo-local release build, then PATH.",
  },
  {
    name: "RENDER_WORKER_ENABLED",
    purpose:
      "Feature flag for the M8 render worker: when false, no render jobs are dequeued (queued jobs persist).",
    group: "render",
    required: false,
    secret: false,
    hasDefault: true,
    example: "true",
  },
  {
    name: "RENDER_WORKER_CONCURRENCY",
    purpose: "Simultaneous render jobs one worker process runs (per instance).",
    group: "render",
    required: false,
    secret: false,
    hasDefault: true,
    example: "2",
  },
  {
    name: "RENDER_JOB_TIMEOUT_SECONDS",
    purpose:
      "Hard timeout for one render job, in seconds; a job that exceeds it fails with RENDER_TIMEOUT.",
    group: "render",
    required: false,
    secret: false,
    hasDefault: true,
    example: "1800",
  },
  {
    name: "RENDER_MAX_ATTEMPTS",
    purpose: "Maximum attempts (initial run plus retries) for one render job before it fails.",
    group: "render",
    required: false,
    secret: false,
    hasDefault: true,
    example: "2",
  },
  {
    name: "RENDER_HEARTBEAT_STALE_SECONDS",
    purpose:
      "A running render job whose heartbeat is older than this many seconds is considered crashed and is reclaimed for retry.",
    group: "render",
    required: false,
    secret: false,
    hasDefault: true,
    example: "120",
  },
  {
    name: "RENDER_POLL_INTERVAL_MS",
    purpose: "How often an idle render worker polls the job queue, in milliseconds.",
    group: "render",
    required: false,
    secret: false,
    hasDefault: true,
    example: "1000",
  },
  // ── obs ───────────────────────────────────────────────────────────────────
  {
    name: "OTEL_EXPORTER_OTLP_ENDPOINT",
    purpose: "OpenTelemetry OTLP endpoint for traces and metrics.",
    group: "obs",
    required: false,
    secret: false,
    hasDefault: false,
    example: "http://localhost:4318",
    condition: "Optional — telemetry is disabled when unset.",
  },
];

/** All declared env var names, in order. */
export const ENV_VAR_NAMES: readonly string[] = Object.freeze(
  ENV_VAR_SPECS.map((spec) => spec.name),
);

/** Variables whose values must never reach a log or error message. */
export const SECRET_ENV_VARS: readonly string[] = Object.freeze(
  ENV_VAR_SPECS.filter((spec) => spec.secret).map((spec) => spec.name),
);

const ENV_META: Readonly<Record<string, EnvVarMeta>> = Object.freeze(
  Object.fromEntries(ENV_VAR_SPECS.map((spec) => [spec.name, spec])),
);

function envPurpose(name: string): string {
  return ENV_META[name]?.purpose ?? "unknown variable (not declared in @studio/config)";
}

// ───────────────────────────────────────────────────────────────────────────
// Zod building blocks (zod v4). Env vars are strings; numerics are coerced with
// explicit, human-readable reasons. Custom messages avoid echoing received
// values, and `redact()` is the belt-and-braces net.
// ───────────────────────────────────────────────────────────────────────────

const httpUrl = z
  .url({ error: "must be a valid absolute URL" })
  .refine(
    (value: string) => value.startsWith("http://") || value.startsWith("https://"),
    "must be an http(s) URL",
  );

const postgresUrl = z
  .string()
  .min(1)
  .refine(
    (value: string) => /^postgres(ql)?:\/\//.test(value),
    "must be a PostgreSQL URL starting with postgres:// or postgresql://",
  );

const valkeyUrl = z
  .string()
  .min(1)
  .refine(
    (value: string) => /^rediss?:\/\//.test(value),
    "must be a Valkey URL starting with redis:// or rediss://",
  );

const bucketName = z
  .string()
  .min(1)
  .refine(
    (value: string) => /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value),
    "must be a valid S3 bucket name (lowercase letters, digits, dots, hyphens)",
  );

/** Whole positive integer, in plain digits, ≥ min. */
function wholeNumber(min: number) {
  return z.coerce
    .number({ error: "must be a whole number" })
    .int("must be a whole number")
    .min(min, `must be at least ${min}`);
}

const appEnvSchema = z.enum(["local", "staging", "production"], {
  error: 'must be one of: "local", "staging", "production"',
});

const logLevelSchema = z.enum(["debug", "info", "warn", "error"], {
  error: 'must be one of: "debug", "info", "warn", "error"',
});

/** Strict boolean; accepts true/false, 1/0, yes/no, on/off in any case. */
const envBool = z.string().transform((raw: string, ctx: z.RefinementCtx): boolean => {
  const value = raw.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(value)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(value)) {
    return false;
  }
  ctx.addIssue({
    code: "custom",
    message: "must be a boolean (true/false; 1/0, yes/no, on/off also accepted)",
  });
  return z.NEVER;
});

const editorPublicPath = z
  .string()
  .min(1)
  .refine(
    (value: string) => value.startsWith("/") && value.length > 1 && !value.endsWith("/"),
    "must be an absolute path like /editor with no trailing slash",
  );

/** JSON object mapping plan names to Stripe price ids. */
const stripePriceIds = z
  .string()
  .transform((raw: string, ctx: z.RefinementCtx): unknown => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "must be valid JSON mapping plan names to Stripe price ids",
      });
      return z.NEVER;
    }
  })
  .pipe(z.record(z.string(), z.string()));

// ───────────────────────────────────────────────────────────────────────────
// The flat schema — one key per declared var. Defaults are OUTPUT-typed under
// zod v4 (`.default(n)` returns `n` unparsed), so numeric/boolean defaults are
// literal numbers/booleans, never strings.
// ───────────────────────────────────────────────────────────────────────────

export const envSchema = z.object({
  // app
  APP_URL: httpUrl,
  APP_ENV: appEnvSchema,
  LOG_LEVEL: logLevelSchema.default("info"),
  MOCK_MODEL: envBool.default(false),
  // db
  DATABASE_URL: postgresUrl,
  // queue
  VALKEY_URL: valkeyUrl.optional(),
  // storage — optional as a group: local dev runs the gateway's filesystem
  // driver (.local/storage) when the endpoint is unset; staging/production
  // must set the whole group (cross-checked below).
  S3_ENDPOINT: httpUrl.optional(),
  S3_REGION: z.string().min(1).optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  S3_BUCKET: bucketName.optional(),
  ASSET_MAX_BYTES: wholeNumber(1),
  PROJECT_MAX_BYTES: wholeNumber(1),
  // stripe
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),
  STRIPE_PRICE_IDS: stripePriceIds,
  // auth
  AUTH_SECRET: z.string().min(32, "must be at least 32 characters (openssl rand -base64 32)"),
  AUTH_GOOGLE_ID: z.string().min(1),
  AUTH_GOOGLE_SECRET: z.string().min(1),
  AUTH_GITHUB_ID: z.string().min(1),
  AUTH_GITHUB_SECRET: z.string().min(1),
  // litellm
  LITELLM_BASE_URL: httpUrl,
  LITELLM_API_KEY: z.string().min(1),
  LITELLM_VIRTUAL_KEY: z.string().min(1).optional(),
  // editor
  EDITOR_PUBLIC_PATH: editorPublicPath.default("/editor"),
  EDITOR_DEV_SERVER_URL: httpUrl.optional(),
  EDITOR_WASM_MAX_MB: wholeNumber(1).default(18),
  // agent
  CHAT_MAX_STEPS: wholeNumber(1),
  AGENT_BATCH_MAX_STEPS: wholeNumber(1).default(100),
  AGENT_BATCH_MAX_BYTES: wholeNumber(1).default(2 * 1024 * 1024),
  AGENT_BATCH_TIMEOUT_MS: wholeNumber(1).default(60_000),
  // lease
  LEASE_HEARTBEAT_MS: wholeNumber(1).default(120_000),
  LEASE_TTL_MS: wholeNumber(1).default(300_000),
  // render (M8 worker)
  EFFECTCRAFT_CLI_PATH: z.string().min(1).optional(),
  RENDER_WORKER_ENABLED: envBool.default(true),
  RENDER_WORKER_CONCURRENCY: wholeNumber(1).default(2),
  RENDER_JOB_TIMEOUT_SECONDS: wholeNumber(1).default(1800),
  RENDER_MAX_ATTEMPTS: wholeNumber(1).default(2),
  RENDER_HEARTBEAT_STALE_SECONDS: wholeNumber(1).default(120),
  RENDER_POLL_INTERVAL_MS: wholeNumber(1).default(1000),
  // obs
  OTEL_EXPORTER_OTLP_ENDPOINT: httpUrl.optional(),
});

/** Flat, validated env values (internal; the public shape is {@link StudioEnv}). */
type FlatEnv = z.output<typeof envSchema>;

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
    readonly google: { readonly id: string; readonly secret: string };
    readonly github: { readonly id: string; readonly secret: string };
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

// ───────────────────────────────────────────────────────────────────────────
// Fail-fast error
// ───────────────────────────────────────────────────────────────────────────

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
export class EnvFatalError extends Error {
  readonly code = "env_invalid" as const;
  readonly appName: string;
  readonly problems: readonly EnvProblem[];

  constructor(appName: string, problems: readonly EnvProblem[]) {
    super(formatEnvFatalMessage(appName, problems));
    this.name = "EnvFatalError";
    this.appName = appName;
    this.problems = problems;
  }
}

/** Type guard for fail-fast handlers in app entrypoints. */
export function isEnvFatalError(value: unknown): value is EnvFatalError {
  return value instanceof EnvFatalError;
}

function formatEnvFatalMessage(appName: string, problems: readonly EnvProblem[]): string {
  const lines = problems.map((problem) => {
    return `  - ${problem.name}: ${problem.reason}. (${problem.purpose})`;
  });
  return [
    `[${appName}] environment is invalid — refusing to start (${problems.length} problem(s)):`,
    ...lines,
    "Values are never included in this message; fix the listed variables in your shell or .env and restart.",
  ].join("\n");
}

/** Masks the raw value if a schema message happened to echo it. */
function redact(reason: string, raw: string | undefined): string {
  if (raw === undefined || raw === "") {
    return reason;
  }
  return reason.split(raw).join("«redacted»");
}

interface RawZodIssue {
  readonly code: string;
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly input?: unknown;
}

function issueIsMissing(issue: RawZodIssue): boolean {
  return issue.code === "invalid_type" && issue.input === undefined;
}

/** Blank/whitespace-only values count as unset (defaults then apply). */
function normalizeSource(source: EnvSource): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = {};
  for (const spec of ENV_VAR_SPECS) {
    const raw = source[spec.name];
    normalized[spec.name] = raw !== undefined && raw.trim() !== "" ? raw : undefined;
  }
  return normalized;
}

function issuesToProblems(
  issues: readonly RawZodIssue[],
  normalized: Record<string, string | undefined>,
): EnvProblem[] {
  const problems: EnvProblem[] = [];
  const seen = new Set<string>();
  for (const issue of issues) {
    const name = typeof issue.path[0] === "string" ? issue.path[0] : "(unknown)";
    // One problem per variable: a chained schema (url → http refine) can emit
    // several issues for one bad value; the first carries the best reason.
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    const raw = normalized[name];
    if (issueIsMissing(issue) && raw === undefined) {
      problems.push({
        kind: "missing",
        name,
        purpose: envPurpose(name),
        reason: "missing",
      });
      continue;
    }
    problems.push({
      kind: "invalid",
      name,
      purpose: envPurpose(name),
      reason: redact(issue.message, raw),
    });
  }
  return problems;
}

/** Cross-field rules the flat schema cannot express. */
function crossCheckProblems(env: FlatEnv): EnvProblem[] {
  const problems: EnvProblem[] = [];
  const push = (name: string, reason: string): void => {
    problems.push({ kind: "rejected", name, purpose: envPurpose(name), reason });
  };

  if (env.APP_ENV !== "local" && env.S3_ENDPOINT === undefined) {
    push(
      "S3_ENDPOINT",
      `required when APP_ENV is "${env.APP_ENV}" — object storage must be configured outside local (S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET)`,
    );
  }
  if (env.APP_ENV !== "local" && env.S3_BUCKET === undefined) {
    push(
      "S3_BUCKET",
      `required when APP_ENV is "${env.APP_ENV}" — the filesystem storage driver is local-only`,
    );
  }
  if (env.APP_ENV !== "local" && env.STRIPE_SECRET_KEY === undefined) {
    push(
      "STRIPE_SECRET_KEY",
      `required when APP_ENV is "${env.APP_ENV}" — Stripe checkout, portal and webhooks cannot run without it`,
    );
  }
  if (env.APP_ENV === "production" && env.MOCK_MODEL) {
    push(
      "MOCK_MODEL",
      'must not be enabled when APP_ENV is "production" — the offline mock bypasses real model routing and billing',
    );
  }
  if (env.APP_ENV === "production" && env.EDITOR_DEV_SERVER_URL !== undefined) {
    push(
      "EDITOR_DEV_SERVER_URL",
      "is dev-only — production serves a built static editor bundle, never a dev server; unset it",
    );
  }
  if (env.LEASE_TTL_MS <= env.LEASE_HEARTBEAT_MS) {
    push(
      "LEASE_TTL_MS",
      `must exceed LEASE_HEARTBEAT_MS (currently ${env.LEASE_HEARTBEAT_MS} ms) or leases would expire between heartbeats`,
    );
  }
  return problems;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function groupEnv(flat: FlatEnv): StudioEnv {
  return deepFreeze({
    app: {
      url: flat.APP_URL,
      env: flat.APP_ENV,
      logLevel: flat.LOG_LEVEL,
      mockModel: flat.MOCK_MODEL,
    },
    db: { url: flat.DATABASE_URL },
    queue: { url: flat.VALKEY_URL },
    storage: {
      endpoint: flat.S3_ENDPOINT,
      region: flat.S3_REGION,
      accessKeyId: flat.S3_ACCESS_KEY_ID,
      secretAccessKey: flat.S3_SECRET_ACCESS_KEY,
      bucket: flat.S3_BUCKET,
      assetMaxBytes: flat.ASSET_MAX_BYTES,
      projectMaxBytes: flat.PROJECT_MAX_BYTES,
    },
    stripe: {
      secretKey: flat.STRIPE_SECRET_KEY,
      webhookSecret: flat.STRIPE_WEBHOOK_SECRET,
      priceIds: flat.STRIPE_PRICE_IDS,
    },
    auth: {
      secret: flat.AUTH_SECRET,
      google: { id: flat.AUTH_GOOGLE_ID, secret: flat.AUTH_GOOGLE_SECRET },
      github: { id: flat.AUTH_GITHUB_ID, secret: flat.AUTH_GITHUB_SECRET },
    },
    litellm: {
      baseUrl: flat.LITELLM_BASE_URL,
      apiKey: flat.LITELLM_API_KEY,
      virtualKey: flat.LITELLM_VIRTUAL_KEY,
    },
    editor: {
      publicPath: flat.EDITOR_PUBLIC_PATH,
      devServerUrl: flat.EDITOR_DEV_SERVER_URL,
      wasmMaxMb: flat.EDITOR_WASM_MAX_MB,
    },
    agent: {
      chatMaxSteps: flat.CHAT_MAX_STEPS,
      batchMaxSteps: flat.AGENT_BATCH_MAX_STEPS,
      batchMaxBytes: flat.AGENT_BATCH_MAX_BYTES,
      batchTimeoutMs: flat.AGENT_BATCH_TIMEOUT_MS,
    },
    lease: {
      heartbeatMs: flat.LEASE_HEARTBEAT_MS,
      ttlMs: flat.LEASE_TTL_MS,
    },
    render: {
      cliPath: flat.EFFECTCRAFT_CLI_PATH,
      workerEnabled: flat.RENDER_WORKER_ENABLED,
      workerConcurrency: flat.RENDER_WORKER_CONCURRENCY,
      jobTimeoutSeconds: flat.RENDER_JOB_TIMEOUT_SECONDS,
      maxAttempts: flat.RENDER_MAX_ATTEMPTS,
      heartbeatStaleSeconds: flat.RENDER_HEARTBEAT_STALE_SECONDS,
      pollIntervalMs: flat.RENDER_POLL_INTERVAL_MS,
    },
    obs: { otelEndpoint: flat.OTEL_EXPORTER_OTLP_ENDPOINT },
  });
}

/**
 * Validates `source` against the Studio env schema and returns the typed,
 * grouped, frozen config. Throws {@link EnvFatalError} naming EVERY missing or
 * invalid variable with its purpose — never any value.
 */
export function parseEnv(source: EnvSource): StudioEnv {
  const normalized = normalizeSource(source);
  const result = envSchema.safeParse(normalized);
  if (!result.success) {
    throw new EnvFatalError(Brand.codename, issuesToProblems(result.error.issues, normalized));
  }
  const crossProblems = crossCheckProblems(result.data);
  if (crossProblems.length > 0) {
    throw new EnvFatalError(Brand.codename, crossProblems);
  }
  return groupEnv(result.data);
}

const envCache = new WeakMap<EnvSource, StudioEnv>();

/**
 * Process-wide accessor. Defaults to `process.env` and parses once per source
 * object (WeakMap), so apps get a cheap singleton while tests can pass fresh
 * fixtures. Throws {@link EnvFatalError} on the first invalid environment.
 */
export function getEnv(source: EnvSource = process.env): StudioEnv {
  const cached = envCache.get(source);
  if (cached !== undefined) {
    return cached;
  }
  const parsed = parseEnv(source);
  envCache.set(source, parsed);
  return parsed;
}

// ───────────────────────────────────────────────────────────────────────────
// .env.example generator
// ───────────────────────────────────────────────────────────────────────────

/**
 * Renders the .env.example body from {@link ENV_VAR_SPECS}: every variable,
 * its purpose and requirement rule, plus a placeholder value (never a secret).
 */
export function renderEnvExample(): string {
  const lines: string[] = [
    `# ${Brand.productName} environment template.`,
    "# Generated by @studio/config (writeEnvExample). Copy to .env and fill in real values.",
    "# Never commit real secrets; startup fails fast listing anything missing or invalid.",
    "",
  ];
  for (const group of GROUP_ORDER) {
    lines.push(`# ── ${group} ──`);
    for (const spec of ENV_VAR_SPECS.filter((entry) => entry.group === group)) {
      const requirements: string[] = [];
      if (spec.required) {
        requirements.push("Required.");
      } else if (spec.hasDefault) {
        requirements.push(`Default: ${spec.example}.`);
      } else {
        requirements.push("Optional.");
      }
      if (spec.secret) {
        requirements.push("Secret — never commit.");
      }
      lines.push(`# ${spec.name} — ${spec.purpose}`);
      lines.push(`# ${requirements.join(" ")}`);
      if (spec.condition !== undefined) {
        lines.push(`# ${spec.condition}`);
      }
      lines.push(`${spec.name}=${spec.example}`);
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Writes the generated .env.example to `path` (uses a dynamic `node:fs/promises`
 * import so importing `env.ts` from a browser bundle stays side-effect free).
 */
export async function writeEnvExample(path: string | URL): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, renderEnvExample(), { encoding: "utf8", mode: 0o644 });
}
