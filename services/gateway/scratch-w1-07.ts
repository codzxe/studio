// W1-07 scratch (UNTRACKED — deleted before commit): reproduce the isolated
// members/api-keys 500s with a REAL logger so the server-side cause is visible.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serve } from "@hono/node-server";
import { parseEnv } from "@studio/config";
import { createAuth, createDb, createRepos } from "@studio/db";

import { buildApp } from "./src/app.js";
import { adaptBetterAuth } from "./src/auth.js";
import { createInMemoryChatReplayStore } from "./src/context.js";
import { createInMemoryIdempotencyStore } from "./src/idempotency.js";
import { type Logger, type LogFields } from "./src/logger.js";
import { createInMemoryRateLimiter } from "./src/rate-limit.js";
import { createMockRunner, RunRegistry } from "./src/runner.js";
import { LocalFSDriver } from "./src/storage.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const consoleLogger: Logger = {
  debug: (msg, fields) => console.log("DEBUG", msg, fields ?? {}),
  info: (msg, fields) => console.log("INFO", msg, fields ?? {}),
  warn: (msg, fields) => console.log("WARN", msg, fields ?? {}),
  error: (msg, fields) => console.log("ERROR", msg, JSON.stringify(fields ?? {})),
  child: () => consoleLogger,
};

const envSource: Record<string, string> = {
  APP_URL: "http://localhost:3000",
  APP_ENV: "local",
  LOG_LEVEL: "debug",
  MOCK_MODEL: "true",
  DATABASE_URL,
  ASSET_MAX_BYTES: "10485760",
  PROJECT_MAX_BYTES: "20971520",
  STRIPE_WEBHOOK_SECRET: "whsec_test_not_configured",
  STRIPE_PRICE_IDS: '{"starter":"price_test","pro":"price_test","studio":"price_test"}',
  AUTH_SECRET: "test-secret-test-secret-test-secret-32",
  AUTH_GOOGLE_ID: "disabled",
  AUTH_GOOGLE_SECRET: "disabled",
  AUTH_GITHUB_ID: "disabled",
  AUTH_GITHUB_SECRET: "disabled",
  LITELLM_BASE_URL: "http://127.0.0.1:4000",
  LITELLM_API_KEY: "sk-test-not-configured",
  CHAT_MAX_STEPS: "20",
};
const env = parseEnv(envSource);
const db = createDb(DATABASE_URL, { max: 5 });
const auth = adaptBetterAuth(
  createAuth({
    databaseUrl: env.db.url,
    appUrl: `${env.app.url.replace(/\/+$/, "")}/v1/auth`,
    secret: env.auth.secret,
    google: { clientId: env.auth.google.id, clientSecret: env.auth.google.secret },
    github: { clientId: env.auth.github.id, clientSecret: env.auth.github.secret },
    db,
  }),
);
const deps = {
  env,
  auth,
  repos: createRepos(db),
  storage: new LocalFSDriver(join(tmpdir(), "w107-scratch"), env.app.url),
  local: null,
  runner: createMockRunner(),
  runs: new RunRegistry(),
  limiter: createInMemoryRateLimiter(),
  idempotency: createInMemoryIdempotencyStore(),
  chatReplay: createInMemoryChatReplayStore(),
  logger: consoleLogger,
  stripe: null,
  version: "0.0.0-scratch",
  dbHealth: async () => true,
} as unknown as Parameters<typeof buildApp>[0]["deps"];

const app = buildApp({ deps });
const base = await new Promise<string>((resolve) => {
  const instance = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
    resolve(`http://127.0.0.1:${info.port}`);
  });
  void instance;
});
const suffix = `${Date.now().toString(36)}-s`;

interface Jar {
  cookie: string;
}
async function call(
  path: string,
  init: { method?: string; jar?: Jar; headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = { origin: "http://localhost:3000", ...(init.headers ?? {}) };
  if (init.jar?.cookie) headers.cookie = init.jar.cookie;
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const response = await fetch(`${base}${path}`, { method: init.method ?? "GET", headers, body, redirect: "manual" });
  const setCookies = response.headers.getSetCookie();
  if (init.jar && setCookies.length > 0) {
    const parts = init.jar.cookie ? [init.jar.cookie] : [];
    for (const raw of setCookies) parts.push(raw.split(";")[0] ?? "");
    init.jar.cookie = parts.join("; ");
  }
  return { status: response.status, text: await response.text() };
}

async function signUp(): Promise<Jar> {
  const jar: Jar = { cookie: "" };
  const r = await call("/v1/auth/sign-up/email", {
    method: "POST",
    jar,
    body: { email: `u-${suffix}-${Math.random().toString(36).slice(2, 8)}@w107.test`, password: "Passw0rd!longenough", name: "Scratch" },
  });
  if (r.status !== 200) throw new Error(`sign-up ${r.status}: ${r.text.slice(0, 300)}`);
  return jar;
}

// --- (a) stranger lists members of a workspace ------------------------------
const owner = await signUp();
const ws = await call("/v1/workspaces", {
  method: "POST",
  jar: owner,
  headers: { "idempotency-key": `ws-${suffix}` },
  body: { name: "Scratch WS", slug: `scratch-${suffix}` },
});
console.log("create ws:", ws.status);
const workspaceId = (JSON.parse(ws.text) as { data: { id: string } }).data.id;
const stranger = await signUp();
// Seam-level probe: what does getFullWorkspace do for a stranger?
const strangerHeaders = new Headers({ cookie: stranger.cookie, origin: "http://localhost:3000" });
try {
  const full = await deps.auth.getFullWorkspace(strangerHeaders, workspaceId);
  console.log("(a0) seam getFullWorkspace(stranger):", JSON.stringify(full)?.slice(0, 200));
} catch (error) {
  console.log("(a0) seam getFullWorkspace(stranger) THREW:", error, error instanceof Error ? error.stack : "");
}
const strangerList = await call(`/v1/workspaces/${workspaceId}/members`, { jar: stranger });
console.log("(a) stranger list:", strangerList.status, strangerList.text.slice(0, 300));

// --- (b) garbage bearer ------------------------------------------------------
const garbage = await call("/v1/me", { headers: { authorization: "Bearer garbage-not-a-key" } });
console.log("(b) garbage bearer /v1/me:", garbage.status, garbage.text.slice(0, 300));

// --- (c) mint + revoke + use -------------------------------------------------
const mint = await call(`/v1/workspaces/${workspaceId}/api-keys`, {
  method: "POST",
  jar: owner,
  headers: { "idempotency-key": `key-${suffix}` },
  body: { name: "scratch key", scopes: ["chat:run"] },
});
console.log("(c) mint:", mint.status, mint.text.slice(0, 200));
if (mint.status === 201) {
  const minted = JSON.parse(mint.text) as { data: { id: string; key: string } };
  const revoked = await call(`/v1/workspaces/${workspaceId}/api-keys/${minted.data.id}`, { method: "DELETE", jar: owner });
  console.log("(c) revoke:", revoked.status);
  const used = await call("/v1/me", { headers: { authorization: `Bearer ${minted.data.key}` } });
  console.log("(c) revoked key use:", used.status, used.text.slice(0, 200));
}

await db.$client.end({ timeout: 5 });
process.exit(0);
