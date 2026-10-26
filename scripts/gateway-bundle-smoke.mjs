// Final-artifact smoke: drive the prebuilt gateway bundle the same way the
// /v1 Next route does — gatewayFetch(Request) with the real /v1 path.
import { gatewayFetch } from "/home/z/my-project/apps/web/api/gateway.mjs";

const APP_URL = process.env.APP_URL ?? "https://motiongra.vercel.app";

async function call(method, path, body, cookie) {
  const headers = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  const response = await gatewayFetch(
    new Request(`${APP_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await response.text();
  return { status: response.status, setCookie: response.headers.get("set-cookie"), text };
}

console.log("=== GET /v1/health ===");
const health = await call("GET", "/v1/health");
console.log("status:", health.status, "| body:", health.text.slice(0, 120));

console.log("\n=== POST /v1/auth/sign-up/email ===");
const email = `route-${Date.now()}@test.local`;
const signUp = await call("POST", "/v1/auth/sign-up/email", {
  name: "Route Probe",
  email,
  password: "Probe-12345678!",
});
console.log("status:", signUp.status);
console.log("set-cookie:", (signUp.setCookie ?? "").slice(0, 70));
console.log("body:", signUp.text.slice(0, 180));

const cookie = signUp.setCookie?.split(";")[0];
if (cookie) {
  console.log("\n=== GET /v1/auth/get-session (cookie) ===");
  const session = await call("GET", "/v1/auth/get-session", undefined, cookie);
  console.log("status:", session.status, "| body:", session.text.slice(0, 160));

  console.log("\n=== GET /v1/me (Hono stack + repos) ===");
  const me = await call("GET", "/v1/me", undefined, cookie);
  console.log("status:", me.status, "| body:", me.text.slice(0, 160));
}

console.log("\n(final-artifact smoke done)");
process.exit(0);
