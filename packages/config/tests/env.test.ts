import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ENV_VAR_NAMES,
  EnvFatalError,
  SECRET_ENV_VARS,
  envSchema,
  getEnv,
  isEnvFatalError,
  parseEnv,
  renderEnvExample,
  writeEnvExample,
} from "../src/index.js";
import type { EnvSource, StudioEnv } from "../src/index.js";

/** A complete, valid local-development environment. */
const localFixture: EnvSource = {
  APP_URL: "http://localhost:3000",
  APP_ENV: "local",
  DATABASE_URL: "postgres://studio:studio@localhost:5432/studio",
  S3_ENDPOINT: "http://localhost:9000",
  S3_REGION: "auto",
  S3_ACCESS_KEY_ID: "minioadmin",
  S3_SECRET_ACCESS_KEY: "minioadmin",
  S3_BUCKET: "studio-local",
  ASSET_MAX_BYTES: "524288000",
  PROJECT_MAX_BYTES: "262144000",
  STRIPE_WEBHOOK_SECRET: "whsec_local_placeholder",
  STRIPE_PRICE_IDS: '{"starter":"price_starter","pro":"price_pro","studio":"price_studio"}',
  AUTH_SECRET: "a".repeat(32),
  AUTH_GOOGLE_ID: "google-client-id",
  AUTH_GOOGLE_SECRET: "google-client-secret",
  AUTH_GITHUB_ID: "github-client-id",
  AUTH_GITHUB_SECRET: "github-client-secret",
  LITELLM_BASE_URL: "http://localhost:4000",
  LITELLM_API_KEY: "sk-litellm-local",
  CHAT_MAX_STEPS: "50",
};

const productionFixture: EnvSource = {
  ...localFixture,
  APP_URL: "https://app.studio.example.com",
  APP_ENV: "production",
  STRIPE_SECRET_KEY: "sk_live_redacted_fixture",
  VALKEY_URL: "rediss://valkey.internal:6379",
};

function without(base: EnvSource, ...keys: string[]): EnvSource {
  const copy: Record<string, string | undefined> = { ...base };
  for (const key of keys) {
    delete copy[key];
  }
  return copy;
}

function expectFatal(source: EnvSource): EnvFatalError {
  try {
    parseEnv(source);
  } catch (error) {
    expect(error).toBeInstanceOf(EnvFatalError);
    return error as EnvFatalError;
  }
  throw new Error("parseEnv unexpectedly succeeded");
}

describe("env: valid parse", () => {
  it("groups every variable into the nested typed config", () => {
    const env = parseEnv(localFixture);
    expect(env.app).toEqual({
      url: "http://localhost:3000",
      env: "local",
      logLevel: "info",
      mockModel: false,
    });
    expect(env.db.url).toBe(localFixture.DATABASE_URL);
    expect(env.storage).toEqual({
      endpoint: "http://localhost:9000",
      region: "auto",
      accessKeyId: "minioadmin",
      secretAccessKey: "minioadmin",
      bucket: "studio-local",
      assetMaxBytes: 524288000,
      projectMaxBytes: 262144000,
    });
    expect(env.stripe.webhookSecret).toBe("whsec_local_placeholder");
    expect(env.stripe.priceIds).toEqual({
      starter: "price_starter",
      pro: "price_pro",
      studio: "price_studio",
    });
    expect(env.auth.google.id).toBe("google-client-id");
    expect(env.auth.github.secret).toBe("github-client-secret");
    expect(env.litellm).toEqual({
      baseUrl: "http://localhost:4000",
      apiKey: "sk-litellm-local",
      virtualKey: undefined,
    });
    expect(env.queue.url).toBeUndefined();
    expect(env.obs.otelEndpoint).toBeUndefined();
  });

  it("applies the documented defaults", () => {
    const env = parseEnv(localFixture);
    expect(env.editor.publicPath).toBe("/editor");
    expect(env.editor.wasmMaxMb).toBe(18);
    expect(env.agent.chatMaxSteps).toBe(50);
    expect(env.agent.batchMaxSteps).toBe(100);
    expect(env.agent.batchMaxBytes).toBe(2 * 1024 * 1024);
    expect(env.agent.batchTimeoutMs).toBe(60000);
    expect(env.lease.heartbeatMs).toBe(120000);
    expect(env.lease.ttlMs).toBe(300000);
    expect(env.render).toEqual({
      cliPath: undefined,
      workerEnabled: true,
      workerConcurrency: 2,
      jobTimeoutSeconds: 1800,
      maxAttempts: 2,
      heartbeatStaleSeconds: 120,
      pollIntervalMs: 1000,
    });
  });

  it("honours explicit values over defaults and parses production", () => {
    const env = parseEnv({
      ...productionFixture,
      LOG_LEVEL: "debug",
      EDITOR_WASM_MAX_MB: "24",
      AGENT_BATCH_MAX_STEPS: "64",
      EDITOR_PUBLIC_PATH: "/editor",
    });
    expect(env.app.env).toBe("production");
    expect(env.app.logLevel).toBe("debug");
    expect(env.editor.wasmMaxMb).toBe(24);
    expect(env.agent.batchMaxSteps).toBe(64);
    expect(env.stripe.secretKey).toBe("sk_live_redacted_fixture");
    expect(env.queue.url).toBe("rediss://valkey.internal:6379");
  });

  it("accepts the documented boolean spellings for MOCK_MODEL", () => {
    for (const raw of ["true", "1", "yes", "on", "TRUE", "True"]) {
      expect(parseEnv({ ...localFixture, MOCK_MODEL: raw }).app.mockModel).toBe(true);
    }
    for (const raw of ["false", "0", "no", "off", "FALSE"]) {
      expect(parseEnv({ ...localFixture, MOCK_MODEL: raw }).app.mockModel).toBe(false);
    }
  });

  it("parses optional variables when set", () => {
    const env = parseEnv({
      ...localFixture,
      VALKEY_URL: "redis://localhost:6379",
      LITELLM_VIRTUAL_KEY: "sk-virtual-1",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
      EDITOR_DEV_SERVER_URL: "http://localhost:8765",
      STRIPE_SECRET_KEY: "sk_test_123",
    });
    expect(env.queue.url).toBe("redis://localhost:6379");
    expect(env.litellm.virtualKey).toBe("sk-virtual-1");
    expect(env.obs.otelEndpoint).toBe("http://localhost:4318");
    expect(env.editor.devServerUrl).toBe("http://localhost:8765");
    expect(env.stripe.secretKey).toBe("sk_test_123");
  });

  it("ignores unrelated keys like PATH", () => {
    const env = parseEnv({ ...localFixture, PATH: "/usr/bin", HOME: "/root", TERM: "xterm" });
    expect(env.app.url).toBe("http://localhost:3000");
  });

  it("returns a deeply frozen config", () => {
    const env = parseEnv(localFixture);
    expect(() => {
      (env.app as { url?: string }).url = "http://evil.example";
    }).toThrow(TypeError);
    expect(() => {
      (env.storage as { bucket?: string }).bucket = "other";
    }).toThrow(TypeError);
  });

  it("blank values count as unset: defaults apply, required vars are missing", () => {
    const env = parseEnv({ ...localFixture, LOG_LEVEL: "   ", VALKEY_URL: "" });
    expect(env.app.logLevel).toBe("info");
    expect(env.queue.url).toBeUndefined();
    const fatal = expectFatal({ ...localFixture, ASSET_MAX_BYTES: "" });
    expect(fatal.problems.map((problem) => problem.name)).toEqual(["ASSET_MAX_BYTES"]);
    expect(fatal.problems[0]?.kind).toBe("missing");
  });
});

describe("env: fail-fast on missing vars", () => {
  it("lists EVERY missing variable with its purpose in one fatal error", () => {
    const fatal = expectFatal(
      without(localFixture, "APP_URL", "DATABASE_URL", "AUTH_SECRET", "CHAT_MAX_STEPS"),
    );
    expect(fatal.problems.map((problem) => problem.name)).toEqual([
      "APP_URL",
      "DATABASE_URL",
      "AUTH_SECRET",
      "CHAT_MAX_STEPS",
    ]);
    for (const problem of fatal.problems) {
      expect(problem.kind).toBe("missing");
      expect(problem.reason).toBe("missing");
      expect(problem.purpose.length).toBeGreaterThan(10);
    }
    for (const name of ["APP_URL", "DATABASE_URL", "AUTH_SECRET", "CHAT_MAX_STEPS"]) {
      expect(fatal.message).toContain(name);
    }
    expect(fatal.message).toContain("auth");
    expect(fatal.message).toContain("never");
    expect(isEnvFatalError(fatal)).toBe(true);
  });

  it("isEnvFatalError rejects other errors", () => {
    expect(isEnvFatalError(new Error("x"))).toBe(false);
  });
});

describe("env: fail-fast on invalid vars", () => {
  it("names the variable, the reason and the purpose — never the value", () => {
    const secret = "mysql://super-secret-user:hunter2@db.internal:5432/prod";
    const fatal = expectFatal({ ...localFixture, DATABASE_URL: secret });
    const problem = fatal.problems.find((entry) => entry.name === "DATABASE_URL");
    expect(problem?.kind).toBe("invalid");
    expect(problem?.reason).toContain("postgres:// or postgresql://");
    expect(fatal.message).not.toContain("hunter2");
    expect(fatal.message).not.toContain("super-secret-user");
  });

  it("rejects non-postgres URLs with the postgres-specific reason", () => {
    const fatal = expectFatal({ ...localFixture, DATABASE_URL: "mysql://localhost/studio" });
    expect(fatal.message).toContain("PostgreSQL URL");
  });

  it("validates APP_URL as an absolute http(s) URL", () => {
    expect(
      parseEnv({ ...localFixture, APP_URL: "https://app.studio.example.com" }).app.url,
    ).toContain("https");
    const fatal = expectFatal({ ...localFixture, APP_URL: "not-a-url" });
    expect(fatal.problems[0]?.name).toBe("APP_URL");
  });

  it("validates APP_ENV and LOG_LEVEL enums without echoing the bad value", () => {
    const envFatal = expectFatal({ ...localFixture, APP_ENV: "dev" });
    expect(envFatal.message).toContain('must be one of: "local", "staging", "production"');
    expect(envFatal.message).not.toContain('"dev"');
    const logFatal = expectFatal({ ...localFixture, LOG_LEVEL: "loud" });
    expect(logFatal.message).toContain("debug");
  });

  it("coerces numeric fields and reports non-numbers without echoing them", () => {
    const fatal = expectFatal({ ...localFixture, ASSET_MAX_BYTES: "twenty-mb" });
    const problem = fatal.problems[0];
    expect(problem?.name).toBe("ASSET_MAX_BYTES");
    expect(problem?.reason).toContain("whole number");
    expect(fatal.message).not.toContain("twenty-mb");
    const negative = expectFatal({ ...localFixture, CHAT_MAX_STEPS: "-5" });
    expect(negative.problems[0]?.reason).toContain("must be at least 1");
  });

  it("rejects malformed STRIPE_PRICE_IDS JSON and non-object JSON", () => {
    const badJson = expectFatal({ ...localFixture, STRIPE_PRICE_IDS: "{oops}" });
    expect(badJson.problems[0]?.reason).toContain("JSON");
    const notObject = expectFatal({ ...localFixture, STRIPE_PRICE_IDS: '["price_1"]' });
    expect(notObject.problems[0]?.name).toBe("STRIPE_PRICE_IDS");
    const values = expectFatal({
      ...localFixture,
      STRIPE_PRICE_IDS: '{"starter":42}',
    });
    expect(values.problems[0]?.name).toBe("STRIPE_PRICE_IDS");
  });

  it("enforces the 32-char AUTH_SECRET minimum without echoing the secret", () => {
    const fatal = expectFatal({ ...localFixture, AUTH_SECRET: "too-short" });
    expect(fatal.problems[0]?.reason).toContain("32");
    expect(fatal.message).not.toContain("too-short");
  });

  it("enforces a plausible S3 bucket name", () => {
    const fatal = expectFatal({ ...localFixture, S3_BUCKET: "Not_A_Valid_Bucket" });
    expect(fatal.problems[0]?.reason).toContain("bucket");
  });

  it("enforces http(s) for editor/obs/litellm endpoints and redis:// for Valkey", () => {
    const editor = expectFatal({ ...localFixture, EDITOR_DEV_SERVER_URL: "ftp://localhost:8765" });
    expect(editor.problems[0]?.name).toBe("EDITOR_DEV_SERVER_URL");
    const otel = expectFatal({ ...localFixture, OTEL_EXPORTER_OTLP_ENDPOINT: "localhost:4318" });
    expect(otel.problems[0]?.name).toBe("OTEL_EXPORTER_OTLP_ENDPOINT");
    const valkey = expectFatal({ ...localFixture, VALKEY_URL: "amqp://localhost" });
    expect(valkey.problems[0]?.reason).toContain("redis:// or rediss://");
  });

  it("collects several invalid variables at once", () => {
    const fatal = expectFatal({
      ...localFixture,
      APP_URL: "nope",
      LITELLM_BASE_URL: "also-nope",
      EDITOR_WASM_MAX_MB: "zero",
    });
    expect(fatal.problems.map((problem) => problem.name)).toEqual([
      "APP_URL",
      "LITELLM_BASE_URL",
      "EDITOR_WASM_MAX_MB",
    ]);
  });

  it("validates the editor public path shape", () => {
    expect(parseEnv({ ...localFixture, EDITOR_PUBLIC_PATH: "/editor" }).editor.publicPath).toBe(
      "/editor",
    );
    const trailing = expectFatal({ ...localFixture, EDITOR_PUBLIC_PATH: "/editor/" });
    expect(trailing.problems[0]?.reason).toContain("trailing slash");
    const relative = expectFatal({ ...localFixture, EDITOR_PUBLIC_PATH: "editor" });
    expect(relative.problems[0]?.reason).toContain("absolute");
  });
});

describe("env: render worker variables (M8)", () => {
  it("honours explicit values over the defaults", () => {
    const env = parseEnv({
      ...localFixture,
      EFFECTCRAFT_CLI_PATH: "/opt/builds/effectcraft-cli",
      RENDER_WORKER_ENABLED: "false",
      RENDER_WORKER_CONCURRENCY: "8",
      RENDER_JOB_TIMEOUT_SECONDS: "900",
      RENDER_MAX_ATTEMPTS: "5",
      RENDER_HEARTBEAT_STALE_SECONDS: "30",
      RENDER_POLL_INTERVAL_MS: "250",
    });
    expect(env.render).toEqual({
      cliPath: "/opt/builds/effectcraft-cli",
      workerEnabled: false,
      workerConcurrency: 8,
      jobTimeoutSeconds: 900,
      maxAttempts: 5,
      heartbeatStaleSeconds: 30,
      pollIntervalMs: 250,
    });
  });

  it("accepts the documented boolean spellings for RENDER_WORKER_ENABLED", () => {
    for (const raw of ["true", "1", "yes", "on", "TRUE", "True"]) {
      expect(parseEnv({ ...localFixture, RENDER_WORKER_ENABLED: raw }).render.workerEnabled).toBe(
        true,
      );
    }
    for (const raw of ["false", "0", "no", "off", "FALSE"]) {
      expect(parseEnv({ ...localFixture, RENDER_WORKER_ENABLED: raw }).render.workerEnabled).toBe(
        false,
      );
    }
  });

  it("EFFECTCRAFT_CLI_PATH is optional; blank or whitespace counts as unset", () => {
    expect(parseEnv(localFixture).render.cliPath).toBeUndefined();
    expect(parseEnv({ ...localFixture, EFFECTCRAFT_CLI_PATH: "" }).render.cliPath).toBeUndefined();
    expect(
      parseEnv({ ...localFixture, EFFECTCRAFT_CLI_PATH: "   " }).render.cliPath,
    ).toBeUndefined();
    expect(
      parseEnv({ ...localFixture, EFFECTCRAFT_CLI_PATH: "./bins/effectcraft-cli" }).render.cliPath,
    ).toBe("./bins/effectcraft-cli");
  });

  it("rejects non-boolean RENDER_WORKER_ENABLED without echoing the value", () => {
    const fatal = expectFatal({ ...localFixture, RENDER_WORKER_ENABLED: "maybe" });
    expect(fatal.problems.map((problem) => problem.name)).toEqual(["RENDER_WORKER_ENABLED"]);
    expect(fatal.problems[0]?.reason).toContain("boolean");
    expect(fatal.message).not.toContain("maybe");
  });

  it("every positive-int render var rejects zero, negatives, floats and words", () => {
    const positiveIntVars = [
      "RENDER_WORKER_CONCURRENCY",
      "RENDER_JOB_TIMEOUT_SECONDS",
      "RENDER_MAX_ATTEMPTS",
      "RENDER_HEARTBEAT_STALE_SECONDS",
      "RENDER_POLL_INTERVAL_MS",
    ] as const;
    for (const name of positiveIntVars) {
      for (const bad of ["0", "-1"]) {
        const fatal = expectFatal({ ...localFixture, [name]: bad });
        expect(fatal.problems.map((problem) => problem.name)).toEqual([name]);
        expect(fatal.problems[0]?.reason).toContain("at least 1");
      }
      for (const bad of ["1.5", "two"]) {
        const fatal = expectFatal({ ...localFixture, [name]: bad });
        expect(fatal.problems.map((problem) => problem.name)).toEqual([name]);
        expect(fatal.problems[0]?.reason).toContain("whole number");
        expect(fatal.message).not.toContain(bad); // the value is never echoed
      }
      // Blank values count as unset — the documented default applies.
      for (const blank of ["", "   "]) {
        expect(parseEnv({ ...localFixture, [name]: blank })).toBeDefined();
      }
      expect(parseEnv({ ...localFixture, [name]: "1" })).toBeDefined();
    }
  });

  it("collects several invalid render variables at once", () => {
    const fatal = expectFatal({
      ...localFixture,
      RENDER_WORKER_ENABLED: "perhaps",
      RENDER_WORKER_CONCURRENCY: "two",
      RENDER_POLL_INTERVAL_MS: "-1000",
    });
    expect(fatal.problems.map((problem) => problem.name)).toEqual([
      "RENDER_WORKER_ENABLED",
      "RENDER_WORKER_CONCURRENCY",
      "RENDER_POLL_INTERVAL_MS",
    ]);
  });

  it("production accepts the render group (no extra requirements)", () => {
    // The render vars carry no staging/production cross-checks — defaults apply.
    const env = parseEnv(productionFixture);
    expect(env.render.workerEnabled).toBe(true);
    expect(env.render.workerConcurrency).toBe(2);
  });
});

describe("env: cross-field rules", () => {
  it("STRIPE_SECRET_KEY is required outside local", () => {
    const staging: EnvSource = { ...localFixture, APP_ENV: "staging" };
    const fatal = expectFatal(staging);
    expect(fatal.problems.map((problem) => problem.name)).toEqual(["STRIPE_SECRET_KEY"]);
    expect(fatal.problems[0]?.kind).toBe("rejected");
    expect(fatal.problems[0]?.reason).toContain("staging");
    expect(parseEnv({ ...staging, STRIPE_SECRET_KEY: "sk_test_1" }).stripe.secretKey).toBe(
      "sk_test_1",
    );
  });

  it("MOCK_MODEL is rejected in production", () => {
    const fatal = expectFatal({ ...productionFixture, MOCK_MODEL: "true" });
    expect(fatal.problems.map((problem) => problem.name)).toEqual(["MOCK_MODEL"]);
    expect(fatal.problems[0]?.reason).toContain("production");
    expect(parseEnv({ ...productionFixture, MOCK_MODEL: "false" }).app.mockModel).toBe(false);
  });

  it("MOCK_MODEL is allowed in local", () => {
    expect(parseEnv({ ...localFixture, MOCK_MODEL: "true" }).app.mockModel).toBe(true);
  });

  it("EDITOR_DEV_SERVER_URL is rejected in production", () => {
    const fatal = expectFatal({
      ...productionFixture,
      EDITOR_DEV_SERVER_URL: "http://localhost:8765",
    });
    expect(fatal.problems[0]?.name).toBe("EDITOR_DEV_SERVER_URL");
    expect(fatal.problems[0]?.reason).toContain("dev-only");
  });

  it("LEASE_TTL_MS must exceed LEASE_HEARTBEAT_MS", () => {
    const equal = expectFatal({
      ...localFixture,
      LEASE_HEARTBEAT_MS: "1000",
      LEASE_TTL_MS: "1000",
    });
    expect(equal.problems.map((problem) => problem.name)).toEqual(["LEASE_TTL_MS"]);
    expect(equal.problems[0]?.reason).toContain("heartbeat");
    const inverted = expectFatal({
      ...localFixture,
      LEASE_HEARTBEAT_MS: "5000",
      LEASE_TTL_MS: "2000",
    });
    expect(inverted.problems[0]?.name).toBe("LEASE_TTL_MS");
  });

  it("reports several cross-field rejections together", () => {
    const fatal = expectFatal({
      ...without(productionFixture, "STRIPE_SECRET_KEY"),
      MOCK_MODEL: "1",
      EDITOR_DEV_SERVER_URL: "http://localhost:8765",
    });
    expect(fatal.problems.map((problem) => problem.name)).toEqual([
      "STRIPE_SECRET_KEY",
      "MOCK_MODEL",
      "EDITOR_DEV_SERVER_URL",
    ]);
  });
});

describe("env: DATABASE_URL dialects (W1-03 sqlite dev server)", () => {
  it("accepts file: and sqlite: URLs in local", () => {
    expect(parseEnv({ ...localFixture, DATABASE_URL: "file:.local/studio-dev.db" }).db.url).toBe(
      "file:.local/studio-dev.db",
    );
    expect(
      parseEnv({ ...localFixture, DATABASE_URL: "sqlite:/tmp/studio-dev.db" }).db.url,
    ).toBe("sqlite:/tmp/studio-dev.db");
  });

  it("rejects SQLite URLs outside local with the local-only reason — never the path", () => {
    const staging = expectFatal({
      ...localFixture,
      APP_ENV: "staging",
      STRIPE_SECRET_KEY: "sk_test_1",
      DATABASE_URL: "file:/secrets/wherever/studio-dev.db",
    });
    const problem = staging.problems.find((entry) => entry.name === "DATABASE_URL");
    expect(problem?.kind).toBe("rejected");
    expect(problem?.reason).toContain("local-dev");
    expect(staging.message).toContain("PostgreSQL URL");
    // The fixture's DIRECTORY is the would-be leak; "studio-dev.db" alone is
    // the documented example path from the var's purpose text, not the value.
    expect(staging.message).not.toContain("/secrets/wherever/");
    const production = expectFatal({
      ...productionFixture,
      DATABASE_URL: "sqlite:/tmp/studio-dev.db",
    });
    expect(production.problems.map((entry) => entry.name)).toEqual(["DATABASE_URL"]);
    expect(production.problems[0]?.reason).toContain("production");
  });

  it("still rejects other schemes with the dual-dialect reason", () => {
    const fatal = expectFatal({ ...localFixture, DATABASE_URL: "mysql://localhost/studio" });
    const problem = fatal.problems.find((entry) => entry.name === "DATABASE_URL");
    expect(problem?.kind).toBe("invalid");
    expect(problem?.reason).toContain("SQLite file URL");
    expect(problem?.reason).toContain("postgres:// or postgresql://");
    // An empty file: URL is not a database either.
    const bare = expectFatal({ ...localFixture, DATABASE_URL: "file:" });
    expect(bare.problems.map((entry) => entry.name)).toEqual(["DATABASE_URL"]);
  });

  it("documents both dialects in the generated example", () => {
    const text = renderEnvExample();
    expect(text).toContain("file:.local/studio-dev.db");
    expect(text).toContain("dev:sqlite");
    expect(text).toContain('only when APP_ENV is "local"');
  });
});

describe("env: getEnv singleton", () => {
  it("parses once per source object (WeakMap cache)", () => {
    const first: StudioEnv = getEnv(localFixture);
    const second: StudioEnv = getEnv(localFixture);
    expect(second).toBe(first);
    const otherSource = { ...localFixture };
    expect(getEnv(otherSource)).not.toBe(first);
  });

  it("does not cache failed parses", () => {
    const bad = without(localFixture, "APP_URL");
    expect(() => getEnv(bad)).toThrow(EnvFatalError);
    expect(() => getEnv(bad)).toThrow(EnvFatalError);
  });
});

describe("env: metadata and .env.example generator", () => {
  it("specs and the zod schema declare the same variables", () => {
    expect(ENV_VAR_NAMES).toEqual(Object.keys(envSchema.shape));
  });

  it("marks exactly the secret variables", () => {
    for (const name of [
      "DATABASE_URL",
      "VALKEY_URL",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "AUTH_SECRET",
      "AUTH_GOOGLE_SECRET",
      "AUTH_GITHUB_SECRET",
      "LITELLM_API_KEY",
      "LITELLM_VIRTUAL_KEY",
    ]) {
      expect(SECRET_ENV_VARS).toContain(name);
    }
    for (const name of [
      "APP_URL",
      "APP_ENV",
      "S3_BUCKET",
      "STRIPE_PRICE_IDS",
      "LOG_LEVEL",
      "EFFECTCRAFT_CLI_PATH",
      "RENDER_WORKER_ENABLED",
      "RENDER_WORKER_CONCURRENCY",
      "RENDER_JOB_TIMEOUT_SECONDS",
      "RENDER_MAX_ATTEMPTS",
      "RENDER_HEARTBEAT_STALE_SECONDS",
      "RENDER_POLL_INTERVAL_MS",
    ]) {
      expect(SECRET_ENV_VARS).not.toContain(name);
    }
  });

  it("renderEnvExample lists every variable with purpose and placeholder", () => {
    const text = renderEnvExample();
    for (const name of ENV_VAR_NAMES) {
      expect(text).toContain(`${name}=`);
      expect(text).toContain(`# ${name} — `);
    }
    expect(text).toContain("APP_URL=http://localhost:3000");
    expect(text).toContain("EDITOR_PUBLIC_PATH=/editor");
    expect(text).toContain("AGENT_BATCH_MAX_BYTES=2097152");
    expect(text).toContain('Rejected when APP_ENV is "production"');
    // The M8 render rows, with their defaults and the CLI resolution order.
    expect(text).toContain("EFFECTCRAFT_CLI_PATH=");
    expect(text).toContain("# EFFECTCRAFT_CLI_PATH — ");
    expect(text).toContain("RENDER_WORKER_ENABLED=true");
    expect(text).toContain("RENDER_WORKER_CONCURRENCY=2");
    expect(text).toContain("RENDER_JOB_TIMEOUT_SECONDS=1800");
    expect(text).toContain("RENDER_MAX_ATTEMPTS=2");
    expect(text).toContain("RENDER_HEARTBEAT_STALE_SECONDS=120");
    expect(text).toContain("RENDER_POLL_INTERVAL_MS=1000");
    // The render group renders between lease and obs.
    const leaseAt = text.indexOf("# ── lease ──");
    const renderAt = text.indexOf("# ── render ──");
    const obsAt = text.indexOf("# ── obs ──");
    expect(leaseAt).toBeGreaterThan(-1);
    expect(renderAt).toBeGreaterThan(leaseAt);
    expect(obsAt).toBeGreaterThan(renderAt);
    // Placeholder-free guarantee: no fixture secret ever appears.
    expect(text).not.toContain("sk_live_redacted_fixture");
  });

  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const dir of tmpDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writeEnvExample writes the generated template to disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "studio-config-"));
    tmpDirs.push(dir);
    const target = join(dir, ".env.example");
    await writeEnvExample(target);
    const text = await readFile(target, "utf8");
    expect(text).toContain("# Studio environment template.");
    for (const name of ENV_VAR_NAMES) {
      expect(text).toContain(`${name}=`);
    }
  });
});
