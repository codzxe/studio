import { describe, expect, it } from 'vitest';
import {
  EnvFatalError,
  configuredModelProviders,
  gatewayEnvSchema,
  isEnvFatalError,
  modelProviderHealth,
  parseEnginePoolEnv,
  parseGatewayEnv,
  parseWebEnv,
  parseWorkerEnv,
  type EnvSource,
} from '../src/index.js';

const gatewayFixture: EnvSource = {
  DATABASE_URL: 'postgres://studio:pw@localhost:5432/studio',
  VALKEY_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'https://s3.example.com',
  S3_BUCKET: 'studio-assets',
  S3_REGION: 'auto',
  S3_ACCESS_KEY_ID: 'AKIAEXAMPLEKEYID',
  S3_SECRET_ACCESS_KEY: 'very-secret',
  AUTH_SECRET: 'a'.repeat(40),
  STRIPE_SECRET_KEY: 'sk_test_51example',
  STRIPE_WEBHOOK_SECRET: 'whsec_example',
  APP_URL: 'https://app.example.com',
};

const workerFixture: EnvSource = {
  DATABASE_URL: 'postgres://studio:pw@localhost:5432/studio',
  VALKEY_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'https://s3.example.com',
  S3_BUCKET: 'studio-assets',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY_ID: 'AKIAEXAMPLEKEYID',
  S3_SECRET_ACCESS_KEY: 'very-secret',
  ENGINE_BINARY_PATH: '/opt/photocraft/photocraft-cli',
  ENGINE_CAPABILITY_ROOT_BASE: '/var/lib/studio/sessions',
};

const enginePoolFixture: EnvSource = {
  DATABASE_URL: 'postgres://studio:pw@localhost:5432/studio',
  ENGINE_BINARY_PATH: '/opt/photocraft/photocraft-cli',
  ENGINE_CAPABILITY_ROOT_BASE: '/var/lib/studio/sessions',
};

const webFixture: EnvSource = {
  APP_URL: 'https://app.example.com',
  API_BASE_URL: 'https://api.example.com',
  STRIPE_PUBLISHABLE_KEY: 'pk_test_51example',
};

function fixtureWithout(base: EnvSource, key: string): EnvSource {
  const copy: Record<string, string | undefined> = { ...base };
  delete copy[key];
  return copy;
}

describe('env: gateway', () => {
  it('parses a valid gateway environment', () => {
    const env = parseGatewayEnv(gatewayFixture);
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3001); // policy default
    expect(env.S3_BUCKET).toBe('studio-assets');
    expect(env.SSE_HEARTBEAT_MS).toBe(15000);
    expect(env.SSE_RETRY_MS).toBe(3000);
    expect(env.SSE_BACKFILL_LIMIT).toBe(500);
  });

  it('coerces PORT and honours explicit values', () => {
    const env = parseGatewayEnv({ ...gatewayFixture, PORT: '8080' });
    expect(env.PORT).toBe(8080);
  });

  it('ignores unrelated process.env keys like PATH', () => {
    const env = parseGatewayEnv({ ...gatewayFixture, PATH: '/usr/bin', HOME: '/root' });
    expect(env.DATABASE_URL).toBe(gatewayFixture.DATABASE_URL);
  });

  it('names the missing variable and app in the fatal error', () => {
    try {
      parseGatewayEnv(fixtureWithout(gatewayFixture, 'DATABASE_URL'));
      expect.unreachable('parseGatewayEnv must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvFatalError);
      const fatal = error as EnvFatalError;
      expect(fatal.missing).toContain('DATABASE_URL');
      expect(fatal.message).toContain('DATABASE_URL');
      expect(fatal.message).toContain('gateway');
      expect(fatal.name).toBe('EnvFatalError');
      expect(fatal.code).toBe('env_invalid');
    }
  });

  it('aggregates multiple missing variables', () => {
    try {
      parseGatewayEnv(
        fixtureWithout(fixtureWithout(gatewayFixture, 'DATABASE_URL'), 'VALKEY_URL'),
      );
      expect.unreachable('parseGatewayEnv must throw');
    } catch (error) {
      const fatal = error as EnvFatalError;
      expect(fatal.missing).toEqual(expect.arrayContaining(['DATABASE_URL', 'VALKEY_URL']));
    }
  });

  it('names invalid variables with reasons', () => {
    try {
      parseGatewayEnv({
        ...gatewayFixture,
        VALKEY_URL: 'mysql://nope',
        PORT: 'not-a-port',
        AUTH_SECRET: 'short',
        STRIPE_SECRET_KEY: 'not-a-stripe-key',
      });
      expect.unreachable('parseGatewayEnv must throw');
    } catch (error) {
      const fatal = error as EnvFatalError;
      const names = fatal.invalid.map((entry) => entry.name);
      expect(names).toEqual(
        expect.arrayContaining(['VALKEY_URL', 'PORT', 'AUTH_SECRET', 'STRIPE_SECRET_KEY']),
      );
      expect(fatal.missing).toHaveLength(0);
    }
  });

  it('rejects out-of-range ports', () => {
    try {
      parseGatewayEnv({ ...gatewayFixture, PORT: '70000' });
      expect.unreachable('parseGatewayEnv must throw');
    } catch (error) {
      expect((error as EnvFatalError).invalid[0]?.name).toBe('PORT');
    }
  });

  it('exposes isEnvFatalError for app entrypoints', () => {
    try {
      parseGatewayEnv(fixtureWithout(gatewayFixture, 'AUTH_SECRET'));
    } catch (error) {
      expect(isEnvFatalError(error)).toBe(true);
      expect(isEnvFatalError(new Error('plain'))).toBe(false);
    }
  });

  it('the schema itself is strict (direct use rejects unknown keys)', () => {
    const parsed = gatewayEnvSchema.safeParse({ ...gatewayFixture, UNDECLARED_VAR: 'x' });
    expect(parsed.success).toBe(false); // .strict() — unknown keys rejected (§4)
    const clean = gatewayEnvSchema.safeParse(gatewayFixture);
    expect(clean.success).toBe(true);
  });
});

describe('env: worker', () => {
  it('defaults the §3.4 engine timeouts', () => {
    const env = parseWorkerEnv(workerFixture);
    expect(env.ENGINE_TOOL_TIMEOUT_MS).toBe(5000); // §3.4 tool 5 s
    expect(env.ENGINE_RENDER_TIMEOUT_MS).toBe(30000); // §3.4 render 30 s
    expect(env.ENGINE_RUN_TIMEOUT_MS).toBe(600000); // §3.4 run 10 min
    expect(env.ENGINE_SESSION_IDLE_TIMEOUT_MS).toBe(900000); // §3.4 idle 15 min
  });

  it('model provider keys are all optional', () => {
    const env = parseWorkerEnv(workerFixture);
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.FLUX_API_KEY).toBeUndefined();
  });

  it('reports unconfigured providers via the health flag', () => {
    const env = parseWorkerEnv(workerFixture);
    const health = modelProviderHealth(env);
    expect(Object.values(health).every((entry) => entry.configured === false)).toBe(true);
    expect(configuredModelProviders(env)).toEqual([]);
  });

  it('reports configured providers via the health flag', () => {
    const env = parseWorkerEnv({
      ...workerFixture,
      GEMINI_API_KEY: 'gemini-key-12345',
      FLUX_API_KEY: 'flux-key-123456',
    });
    const health = modelProviderHealth(env);
    expect(health.gemini).toEqual({
      provider: 'gemini',
      envKey: 'GEMINI_API_KEY',
      configured: true,
      apiKey: 'gemini-key-12345',
    });
    expect(health.flux.configured).toBe(true);
    expect(health.anthropic.configured).toBe(false);
    expect(configuredModelProviders(env)).toEqual(['gemini', 'flux']);
  });

  it('names missing engine session settings', () => {
    try {
      parseWorkerEnv(fixtureWithout(workerFixture, 'ENGINE_BINARY_PATH'));
      expect.unreachable('parseWorkerEnv must throw');
    } catch (error) {
      expect((error as EnvFatalError).missing).toContain('ENGINE_BINARY_PATH');
    }
  });

  it('accepts timeout overrides', () => {
    const env = parseWorkerEnv({ ...workerFixture, ENGINE_TOOL_TIMEOUT_MS: '8000' });
    expect(env.ENGINE_TOOL_TIMEOUT_MS).toBe(8000);
  });
});

describe('env: engine-pool', () => {
  it('applies supervisor policy defaults', () => {
    const env = parseEnginePoolEnv(enginePoolFixture);
    expect(env.PORT).toBe(3002);
    expect(env.ENGINE_SESSION_MAX_CONNECTIONS).toBe(16); // vendor security.rs
    expect(env.ENGINE_SESSION_MEM_LIMIT_MB).toBe(2048);
    expect(env.ENGINE_POOL_MAX_SESSIONS).toBe(32);
    expect(env.ENGINE_SESSION_IDLE_TIMEOUT_MS).toBe(900000); // §3.4
  });

  it('names missing required variables', () => {
    try {
      parseEnginePoolEnv(fixtureWithout(enginePoolFixture, 'DATABASE_URL'));
      expect.unreachable('parseEnginePoolEnv must throw');
    } catch (error) {
      expect((error as EnvFatalError).missing).toContain('DATABASE_URL');
    }
  });
});

describe('env: web', () => {
  it('parses a valid web environment', () => {
    const env = parseWebEnv(webFixture);
    expect(env.PORT).toBe(3000);
    expect(env.DATABASE_URL).toBeUndefined(); // optional: gateway is the auth boundary
  });

  it('names a missing API base URL', () => {
    try {
      parseWebEnv(fixtureWithout(webFixture, 'API_BASE_URL'));
      expect.unreachable('parseWebEnv must throw');
    } catch (error) {
      const fatal = error as EnvFatalError;
      expect(fatal.missing).toContain('API_BASE_URL');
      expect(fatal.message).toContain('web');
    }
  });

  it('rejects a malformed publishable key', () => {
    try {
      parseWebEnv({ ...webFixture, STRIPE_PUBLISHABLE_KEY: 'sk_live_oops' });
      expect.unreachable('parseWebEnv must throw');
    } catch (error) {
      expect((error as EnvFatalError).invalid[0]?.name).toBe('STRIPE_PUBLISHABLE_KEY');
    }
  });
});
