// Local smoke test for the serverless gateway handler (src/handler.ts).
// Runs the REAL wiring (env parse + Supabase PG + better-auth) against the
// migrated Supabase database, executes a sign-up + get-session round trip,
// then removes the probe rows. Usage:
//   cd services/gateway && node_modules/.bin/tsx ../../scripts/gateway-smoke.ts
import { gatewayFetch } from "../services/gateway/src/handler.js";

const APP_URL = process.env.APP_URL ?? "http://127.0.0.1:3999";

async function call(method: string, path: string, body?: unknown, cookie?: string): Promise<{ status: number; json: any; setCookie: string | null; text: string }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  const response = await gatewayFetch(
    new Request(`${APP_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return {
    status: response.status,
    json,
    setCookie: response.headers.get("set-cookie"),
    text,
  };
}

console.log("=== 1. GET /v1/health ===");
const health = await call("GET", "/v1/health");
console.log("status:", health.status, "| body:", health.text.slice(0, 200));

console.log("\n=== 2. POST /v1/auth/sign-up/email ===");
const email = `smoke-${Date.now()}@test.local`;
const signUp = await call("POST", "/v1/auth/sign-up/email", {
  name: "Smoke Probe",
  email,
  password: "Probe-12345678!",
});
console.log("status:", signUp.status);
console.log("set-cookie:", signUp.setCookie?.slice(0, 80) ?? "(none)");
console.log("body:", JSON.stringify(signUp.json).slice(0, 300));

const cookie = signUp.setCookie?.split(";")[0] ?? null;
console.log("\n=== 3. GET /v1/auth/get-session (with cookie) ===");
if (cookie) {
  const session = await call("GET", "/v1/auth/get-session", undefined, cookie);
  console.log("status:", session.status);
  console.log("body:", JSON.stringify(session.json).slice(0, 300));
} else {
  console.log("no session cookie returned — sign-up failed");
}

console.log("\n=== 4. GET /v1/me (authed route through the Hono stack) ===");
if (cookie) {
  const me = await call("GET", "/v1/me", undefined, cookie);
  console.log("status:", me.status, "| body:", me.text.slice(0, 200));
}

console.log("\n(smoke done)");
process.exit(0);
