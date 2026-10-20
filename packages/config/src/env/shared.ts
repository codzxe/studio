// @studio/config — shared env-parsing machinery.
// Spec §4: all env vars are parsed and typed once in packages/config; a missing or
// invalid variable makes the process refuse to start (fail fast, never default a
// secret). Errors below are typed and name the offending variable.
import { z } from 'zod';

/** Source of environment variables (structurally compatible with `process.env`). */
export type EnvSource = Record<string, string | undefined>;

/** A variable that was present but failed schema validation. */
export interface EnvInvalidVar {
  readonly name: string;
  readonly reason: string;
}

/**
 * Typed fatal error thrown by every `parseEnv` in this package.
 * Carries the offending names so startup logs can point at the exact variables.
 */
export class EnvFatalError extends Error {
  readonly code = 'env_invalid' as const;
  readonly appName: string;
  readonly missing: readonly string[];
  readonly invalid: readonly EnvInvalidVar[];

  constructor(params: {
    appName: string;
    missing: readonly string[];
    invalid: readonly EnvInvalidVar[];
  }) {
    const parts: string[] = [];
    if (params.missing.length > 0) {
      parts.push(`missing required variable(s): ${params.missing.join(', ')}`);
    }
    if (params.invalid.length > 0) {
      parts.push(
        `invalid variable(s): ${params.invalid.map((v) => `${v.name} (${v.reason})`).join(', ')}`,
      );
    }
    super(`[config] ${params.appName}: environment is invalid — ${parts.join('; ')}`);
    this.name = 'EnvFatalError';
    this.appName = params.appName;
    this.missing = params.missing;
    this.invalid = params.invalid;
  }
}

/** Type guard for fail-fast handlers in app entrypoints. */
export function isEnvFatalError(value: unknown): value is EnvFatalError {
  return value instanceof EnvFatalError;
}

// ---------------------------------------------------------------------------
// Schema building blocks (Zod v3). Env vars are always strings; numeric fields
// are coerced with explicit regexes so error messages stay human-readable.
// ---------------------------------------------------------------------------

export const requiredString = z.string().min(1, 'must not be empty');
export const optionalString = requiredString.optional();
export const httpUrl = z.string().url('must be a valid http(s) URL');

export const postgresUrl = z
  .string()
  .min(1, 'must not be empty')
  .refine(
    (value) => /^postgres(ql)?:\/\//.test(value),
    'must be a PostgreSQL URL starting with postgres:// or postgresql://',
  );

export const valkeyUrl = z.string().min(1, 'must not be empty').refine(
  (value) => /^rediss?:\/\//.test(value),
  'must be a Valkey/Redis URL (redis:// or rediss://); Valkey only, not Redis 7.4+ (§16.5)',
);

const digits = z
  .string()
  .regex(/^\d+$/, 'must be a positive integer written in plain digits');

export const positiveIntFromString = digits
  .transform(Number)
  .pipe(z.number().int('must be an integer').min(1, 'must be >= 1'));

export const positiveIntMsFromString = digits
  .transform(Number)
  .pipe(z.number().int('must be an integer of milliseconds').min(1, 'must be >= 1 ms'));

export const portFromString = digits.transform(Number).pipe(
  z
    .number()
    .int('must be an integer')
    .min(1, 'must be between 1 and 65535')
    .max(65535, 'must be between 1 and 65535'),
);

export const nodeEnv = z
  .enum(['development', 'production', 'test'])
  .default('development');

// ---------------------------------------------------------------------------
// Parse helper
// ---------------------------------------------------------------------------

/**
 * Validates a filtered view of `env` against a strict Zod object schema and
 * returns the typed config, or throws `EnvFatalError` naming every missing or
 * invalid variable (fail fast, §4). Keys not declared in the schema are ignored
 * because `process.env` always carries unrelated variables (PATH, …); the schema
 * itself is strict for direct (non-process.env) uses and tests.
 */
export function parseEnvSchema<Shape extends z.ZodRawShape>(
  appName: string,
  schema: z.ZodObject<Shape, 'strict'>,
  env: EnvSource,
): z.output<z.ZodObject<Shape, 'strict'>> {
  const shape = schema.shape;
  const filtered: Record<string, string | undefined> = {};
  for (const key of Object.keys(shape)) {
    const value = env[key];
    if (value !== undefined) {
      filtered[key] = value;
    }
  }

  const result = schema.safeParse(filtered);
  if (result.success) {
    return result.data;
  }

  const missing: string[] = [];
  const invalid: EnvInvalidVar[] = [];
  for (const issue of result.error.issues) {
    const name =
      issue.path.length > 0 ? issue.path.map((part) => String(part)).join('.') : '(root)';
    if (
      issue.code === 'invalid_type' &&
      typeof issue.received === 'string' &&
      issue.received === 'undefined'
    ) {
      if (!missing.includes(name)) {
        missing.push(name);
      }
    } else if (!invalid.some((entry) => entry.name === name)) {
      invalid.push({ name, reason: issue.message });
    }
  }
  throw new EnvFatalError({ appName, missing, invalid });
}
