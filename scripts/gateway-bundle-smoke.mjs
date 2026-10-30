// Final-artifact smoke: drive the prebuilt gateway bundle the same way the
// /v1 Next route does — gatewayFetch(Request) with the real /v1 path.
// SEC-12 (2026-10-30 audit): resolve the bundle RELATIVE TO THE REPO — the
// old absolute /home/z/... import could never run from a fresh clone, which
// is exactly why the stale-bundle regression (SEC-01) went unnoticed.
//
// SQLITE-TWIN RUNS (DATABASE_URL=file:…): the bundle's lazy requires
// (better-sqlite3, drizzle-orm/better-sqlite3 — "@studio/db"'s deps, not
// apps/web's) resolve from apps/web/api upward; a pnpm workspace does not
// link them into apps/web/node_modules. ensureSqliteTwinLinks() symlinks the
// exact .pnpm store copies in when missing so a fresh clone can run this
// smoke without touching any manifest or lockfile.
import { existsSync, symlinkSync } from "node:fs";
import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function ensureSqliteTwinLinks() {
  const webModules = join(REPO_ROOT, "apps", "web", "node_modules");
  const pnpmDir = join(REPO_ROOT, "node_modules", ".pnpm");
  if (!existsSync(pnpmDir)) return; // not a pnpm install layout — leave as-is
  for (const packageName of ["better-sqlite3", "drizzle-orm"]) {
    const linkPath = join(webModules, packageName);
    if (existsSync(linkPath)) continue;
    const storeEntry = readdirSync(pnpmDir)
      .filter((entry) => entry.startsWith(`${packageName}@`))
      .sort()
      .at(-1);
    if (storeEntry === undefined) continue;
    const target = join(pnpmDir, storeEntry, "node_modules", packageName);
    if (!existsSync(target)) continue;
    try {
      symlinkSync(relative(webModules, target), linkPath);
    } catch {
      // Read-only checkout / raced with a parallel run — the require failure
      // below will explain, and Postgres smokes never need these links.
    }
  }
}

ensureSqliteTwinLinks();

const { gatewayFetch } = await import("../apps/web/api/gateway.mjs");

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
