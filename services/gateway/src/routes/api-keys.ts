// @studio/gateway — /v1/workspaces/:id/api-keys seam stub (M1.1/M1.6 gap fix
// W1-b). Integrator pre-mounted this router so W1-b can own the file
// end-to-end without touching the shared app.ts. W1-b REPLACES this stub with
// the real API-key surface (create with name+scopes+expiry show-once, list,
// revoke, last-used). AUD-1: the better-auth apiKey plugin and the apikey
// table exist but no route ever minted or revoked a key, and API-key scope
// tests were missing.

import { Hono } from "hono";

import type { AppBindings, GatewayDeps } from "../context.js";

export function apiKeysRoutes(_deps: GatewayDeps): Hono<AppBindings> {
  return new Hono<AppBindings>();
}
