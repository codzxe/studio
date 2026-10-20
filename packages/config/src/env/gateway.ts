// @studio/config — gateway env (Hono API server: REST + SSE + billing webhooks, §3.1).
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

const s3AccessKeyId = z
  .string()
  .min(3, 'S3 access key id looks too short')
  .refine((v) => /^[A-Za-z0-9]+$/.test(v), 'S3 access key id must be alphanumeric');

const s3SecretAccessKey = requiredString;

export const gatewayEnvSchema = z
  .object({
    NODE_ENV: nodeEnv,
    PORT: portFromString.default('3001'),

    // Postgres is the source of truth (§3.1 db) — required.
    DATABASE_URL: postgresUrl,
    // Valkey carries the queue, rate limits and SSE-fanout cache (§3.1) — required.
    VALKEY_URL: valkeyUrl,

    // Object storage for uploads, renders, exports (§3.1 objects). Region may be
    // the literal "auto" for Cloudflare R2.
    S3_ENDPOINT: httpUrl,
    S3_BUCKET: requiredString,
    S3_REGION: requiredString,
    S3_ACCESS_KEY_ID: s3AccessKeyId,
    S3_SECRET_ACCESS_KEY: s3SecretAccessKey,

    // Auth (Better Auth). Secrets are never defaulted (§4).
    AUTH_SECRET: z
      .string()
      .min(32, 'must be at least 32 chars (generate with: openssl rand -base64 32)'),

    // Stripe: checkout, customer portal and webhooks live in the gateway (§14.3).
    STRIPE_SECRET_KEY: z.string().refine(
      (v) => /^sk_(test|live)_/.test(v),
      'must be a Stripe secret key (sk_test_… or sk_live_…)',
    ),
    STRIPE_WEBHOOK_SECRET: z
      .string()
      .refine((v) => /^whsec_/.test(v), 'must be a Stripe webhook secret (whsec_…)'),

    // Canonical app URL (links, OAuth redirects, signed URLs).
    APP_URL: httpUrl,

    // SSE stream tuning (§13.2: client dedupes by seq, resumes with Last-Event-ID).
    // Policy defaults; override per deployment.
    SSE_HEARTBEAT_MS: positiveIntMsFromString.default('15000'),
    SSE_RETRY_MS: positiveIntMsFromString.default('3000'),
    SSE_BACKFILL_LIMIT: positiveIntFromString.default('500'),

    // Engine pool internal URL, used by /v1/health/deep only (§13.1). Optional.
    ENGINE_POOL_URL: httpUrl.optional(),

    // Observability (§22) — all optional.
    OTEL_EXPORTER_OTLP_ENDPOINT: httpUrl.optional(),
    GLITCHTIP_DSN: httpUrl.optional(),
  })
  .strict();

export type GatewayEnv = z.infer<typeof gatewayEnvSchema>;

/** Parses `process.env` (or a source) into a typed GatewayEnv or fails fast (§4). */
export function parseGatewayEnv(env: EnvSource = process.env): GatewayEnv {
  return parseEnvSchema('gateway', gatewayEnvSchema, env);
}

export { parseGatewayEnv as parseEnv };
