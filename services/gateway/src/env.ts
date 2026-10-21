// @studio/gateway — environment (§14).
//
// The single source of truth for every env var is @studio/config's schema;
// the gateway never reads `process.env` directly. This module exports the
// typed env plus gateway-local derivations (port, mount paths, package
// version for /health).

import { createRequire } from "node:module";

import { getEnv, type StudioEnv } from "@studio/config";

/** The typed, grouped, frozen Studio configuration (see @studio/config). */
export type Env = StudioEnv;

/** Better Auth is mounted under `/v1/auth/*` (§7.1 + task W2-b). */
export const AUTH_MOUNT_PATH = "/v1/auth";

/**
 * The baseURL handed to `createAuth` so better-auth's internal router
 * basePath matches our Hono mount. Verified against installed better-auth
 * 1.7.12: `router basePath = new URL(baseURL).pathname`, and `withPath()`
 * only appends the default `/api/auth` when the baseURL has NO path — so
 * appending our mount path makes the handler serve `/v1/auth/*` while the
 * trusted-origin auto-derivation still uses the bare origin (safe).
 * APP_URL is expected to be an origin-only URL in v1.
 */
export function authBaseFor(env: Env): string {
  return `${env.app.url.replace(/\/+$/, "")}${AUTH_MOUNT_PATH}`;
}

/** Default gateway port (§14.1). */
export const DEFAULT_PORT = 8787;

export function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_PORT;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

/** Process-wide env accessor (WeakMap singleton per source object). */
export function getGatewayEnv(): Env {
  return getEnv();
}

/** Gateway package version, read from package.json at module load. */
function readPackageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const GATEWAY_VERSION: string = readPackageVersion();
