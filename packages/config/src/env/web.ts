// @studio/config — web app env (Next.js marketing + product UI, §3.1).
// The browser talks to the gateway (REST + SSE, §13); the web app never reaches
// the engine or the DB directly. Fail fast on required variables (§4).
import { z } from 'zod';
import {
  httpUrl,
  nodeEnv,
  parseEnvSchema,
  portFromString,
  postgresUrl,
  type EnvSource,
} from './shared.js';

export const webEnvSchema = z
  .object({
    NODE_ENV: nodeEnv,
    PORT: portFromString.default('3000'),

    // Canonical public URL of the web app (OAuth redirects, emails, links).
    APP_URL: httpUrl,
    // Gateway origin for REST + SSE (§13); may differ from APP_URL in deployment.
    API_BASE_URL: httpUrl,

    // Billing pages need the publishable key (PCI scope stays with Stripe, §14.3).
    STRIPE_PUBLISHABLE_KEY: z
      .string()
      .refine(
        (v) => /^pk_(test|live)_/.test(v),
        'must be a Stripe publishable key (pk_test_… or pk_live_…)',
      ),

    // Optional: only needed if the web app performs server-side session lookups;
    // the gateway is the auth boundary (§3.1), so this is NOT required.
    DATABASE_URL: postgresUrl.optional(),

    // Observability (§22) — all optional.
    GLITCHTIP_DSN: httpUrl.optional(),
  })
  .strict();

export type WebEnv = z.infer<typeof webEnvSchema>;

/** Parses `process.env` (or a source) into a typed WebEnv or fails fast (§4). */
export function parseWebEnv(env: EnvSource = process.env): WebEnv {
  return parseEnvSchema('web', webEnvSchema, env);
}

export { parseWebEnv as parseEnv };
