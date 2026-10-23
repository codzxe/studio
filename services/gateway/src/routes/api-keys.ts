// @studio/gateway — /v1/workspaces/:id/api-keys (BUILD_PLAN §M1 tasks 1+2,
// AUD-1 gap #2, §7.1 "scoped, hashed, revocable API keys", §3.3
// `manageApiKeys`).
//
// Owner/admin only (resolveWorkspaceContext("admin") = the capability floor).
// Minting and revocation run through the better-auth apiKey plugin server API
// (gateway auth seam): the plugin generates the key, hashes it at rest
// (SHA-256) and returns the plaintext EXACTLY ONCE; revoke is the plugin's
// `enabled: false` flip, which its verification path hard-fails (401).
// Workspace listing/tenant-gating is the @studio/db apiKeys repo — the
// plugin's own list endpoint is per-session-owner only, while a workspace
// settings surface must show every key bound to the workspace (any member's).
//
// Scopes: the wire vocabulary + plugin-statement mapping live in
// @studio/contracts routes/api-keys.ts; the plugin stores the statements
// natively (`apikey.permissions`) and enforces them on verify.
//
// Bearer authentication (no middleware change): the apiKey plugin's session
// hook + `Authorization: Bearer <key>` mint a session for the key's user on
// better-auth's own endpoints, so requireAuth/requireWorkspace accept a
// valid workspace key as its minting user (PAT model, §7.1). Revoked keys
// 401; see services/gateway/src/auth.ts getSession for the negative mapping.

import { Hono } from "hono";

import type { ApiKeyRecord } from "@studio/db";
import {
  API_KEYS_QUERY_SCHEMA,
  type ApiKey,
  apiKeyStatementsToScopes,
  apiKeyScopesToStatements,
  CREATE_API_KEY_SCHEMA,
  type CreatedApiKey,
  type RevokedApiKey,
} from "@studio/contracts";

import type { AppBindings, AppContext, GatewayDeps } from "../context.js";
import { GatewayError } from "../errors.js";
import { ok, page, pathParam } from "../http.js";
import { requireAuth, resolveWorkspaceContext } from "../middleware.js";

/** Plugin lifetime bounds (its `keyExpiration` defaults, enforced pre-call). */
const MIN_LIFETIME_SECONDS = 24 * 60 * 60; // 1 day
const MAX_LIFETIME_SECONDS = 365 * 24 * 60 * 60; // 365 days

/** Parse the raw statements JSON column; null/garbage → no scopes (fail safe). */
function scopesOf(record: ApiKeyRecord): ApiKey["scopes"] {
  if (record.permissions === null) return [];
  try {
    return apiKeyStatementsToScopes(JSON.parse(record.permissions) as unknown);
  } catch {
    return [];
  }
}

/** Repo row → wire row. NEVER includes key material (law #1). */
function toApiKeyDto(record: ApiKeyRecord): ApiKey {
  return {
    id: record.id,
    name: record.name ?? "",
    scopes: scopesOf(record),
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt !== null ? record.expiresAt.toISOString() : null,
    lastUsedAt: record.lastRequest !== null ? record.lastRequest.toISOString() : null,
    enabled: record.enabled,
  };
}

export function apiKeysRoutes(deps: GatewayDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("/v1/workspaces/*", requireAuth());

  // POST /v1/workspaces/:id/api-keys — mint. Returns the plaintext key ONCE.
  app.post("/v1/workspaces/:id/api-keys", async (c: AppContext): Promise<Response> => {
    const context = await resolveWorkspaceContext(c, pathParam(c, "id"), "admin");

    const parsed = CREATE_API_KEY_SCHEMA.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
        status: 400,
        hint: "Keys need a name (1-32 chars) and at least one scope from: projects:read, projects:write, renders:queue, chat:run, billing:read, *.",
        requestId: c.get("requestId"),
      });
    }

    // The plugin enforces a 1-day..365-day lifetime; fail fast with an
    // honest hint instead of surfacing its internal error.
    let expiresInSeconds: number | null = null;
    if (parsed.data.expiresAt !== undefined) {
      const seconds = Math.ceil((Date.parse(parsed.data.expiresAt) - Date.now()) / 1000);
      if (!Number.isFinite(seconds) || seconds < MIN_LIFETIME_SECONDS) {
        throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
          status: 400,
          hint: "expiresAt must be at least one day in the future.",
          requestId: c.get("requestId"),
        });
      }
      if (seconds > MAX_LIFETIME_SECONDS) {
        throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
          status: 400,
          hint: "expiresAt can be at most 365 days in the future.",
          requestId: c.get("requestId"),
        });
      }
      expiresInSeconds = seconds;
    }

    const statements = apiKeyScopesToStatements(parsed.data.scopes);
    const minted = await deps.auth.createWorkspaceApiKey({
      userId: c.get("auth").user.id,
      workspaceId: context.id,
      name: parsed.data.name,
      expiresInSeconds,
      statements,
    });

    const body: CreatedApiKey = {
      id: minted.id,
      name: minted.name ?? parsed.data.name,
      scopes: apiKeyStatementsToScopes(statements),
      createdAt: minted.createdAt,
      startsAt: minted.createdAt,
      expiresAt: minted.expiresAt,
      lastUsedAt: null,
      enabled: minted.enabled,
      key: minted.key,
    };

    try {
      // §7.1: audit the lifecycle WITHOUT any key material — the row names
      // the key id, its scope list and expiry, never the secret.
      await deps.repos.audit.append(context.id, {
        actorId: c.get("auth").user.id,
        action: "apikey.created",
        targetType: "api-key",
        targetId: minted.id,
        metadata: {
          keyId: minted.id,
          name: body.name,
          scopes: body.scopes,
          expiresAt: body.expiresAt,
        },
      });
    } catch {
      // see workspaces.ts: audit must not fail the mutation
    }
    return ok(c, body, 201);
  });

  // GET /v1/workspaces/:id/api-keys — every key bound to the workspace.
  app.get("/v1/workspaces/:id/api-keys", async (c: AppContext): Promise<Response> => {
    const context = await resolveWorkspaceContext(c, pathParam(c, "id"), "admin");
    const query = API_KEYS_QUERY_SCHEMA.safeParse({
      cursor: c.req.query("cursor"),
      limit: c.req.query("limit"),
    });
    if (!query.success) {
      throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
        status: 400,
        hint: "Check the pagination parameters.",
        requestId: c.get("requestId"),
      });
    }
    const result = await deps.repos.apiKeys.list(context.id, {
      cursor: query.data.cursor ?? null,
      limit: query.data.limit,
    });
    return page(c, result.items.map(toApiKeyDto), result.nextCursor);
  });

  // DELETE /v1/workspaces/:id/api-keys/:keyId — revoke (idempotent).
  app.delete("/v1/workspaces/:id/api-keys/:keyId", async (c: AppContext): Promise<Response> => {
    const context = await resolveWorkspaceContext(c, pathParam(c, "id"), "admin");
    const keyId = pathParam(c, "keyId");

    // §12.1 tenant gate: a key id from another workspace reads as 404.
    const record = await deps.repos.apiKeys.get(context.id, keyId);
    if (record === null) {
      throw new GatewayError("NOT_FOUND", "That API key was not found.", {
        status: 404,
        requestId: c.get("requestId"),
      });
    }

    if (!record.enabled) {
      // Already revoked — idempotent replay (no second plugin call, no
      // duplicate audit row); `updatedAt` is when the disable landed.
      const body: RevokedApiKey = {
        id: record.id,
        revokedAt: record.updatedAt.toISOString(),
        enabled: false,
      };
      return ok(c, body);
    }

    await deps.auth.revokeApiKey(record.id, record.referenceId);

    try {
      await deps.repos.audit.append(context.id, {
        actorId: c.get("auth").user.id,
        action: "apikey.revoked",
        targetType: "api-key",
        targetId: record.id,
        metadata: { keyId: record.id, name: record.name ?? "" },
      });
    } catch {
      // see workspaces.ts: audit must not fail the mutation
    }
    const body: RevokedApiKey = {
      id: record.id,
      revokedAt: new Date().toISOString(),
      enabled: false,
    };
    return ok(c, body);
  });

  return app;
}
