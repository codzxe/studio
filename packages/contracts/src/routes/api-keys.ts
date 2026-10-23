// @studio/contracts — /v1/workspaces/:id/api-keys (PRODUCT_ARCHITECTURE.md
// §7.1 "scoped, hashed, revocable API keys", §7.2, §3.3 capability
// `manageApiKeys`; BUILD_PLAN §M1 tasks 1+2; AUD-1 gap #2).
//
// Wire (owner/admin only — the `manageApiKeys` capability):
//   POST   /v1/workspaces/:id/api-keys          CREATE_API_KEY_SCHEMA →
//                                               CreatedApiKey (the plaintext
//                                               key crosses the wire EXACTLY
//                                               ONCE, on create, never after)
//   GET    /v1/workspaces/:id/api-keys          cursor-paginated Page<ApiKey>
//                                               (NEVER key material)
//   DELETE /v1/workspaces/:id/api-keys/:keyId   → RevokedApiKey (idempotent)
//
// Scope storage (verified against the installed @better-auth/api-key
// 1.7.12): the plugin natively supports `permissions` on a key — a
// better-auth access-control Statements map, e.g. {projects: ["read"]} — set
// server-side at mint time and enforced by the plugin's own verify path
// (`role(statements).authorize(request)`). The wire vocabulary below is
// `<resource>:<action>`; "*" is EXPANDED to the full statement map at mint
// time because better-auth's authorize() has no wildcard resource/action
// semantics. Scope enforcement against individual gateway routes is a
// follow-up integration (this wave ships the vocabulary + storage +
// plugin-native verification); the workspace binding rides the plugin's
// key `metadata` (`workspaceId` + `createdBy`), which is why the apiKey
// plugin is configured with `enableMetadata: true`.

import { z } from "zod";

import { ID_SCHEMA, type Id, ISO8601_SCHEMA, PAGINATION_QUERY_SCHEMA } from "./common.js";

/**
 * v1 API-key scope vocabulary (§7.1 "scoped"). A key carries a set of these;
 * "*" grants the full v1 vocabulary (expanded to the complete statement map
 * at mint time — see module docs).
 */
export const API_KEY_SCOPES = [
  "projects:read",
  "projects:write",
  "renders:queue",
  "chat:run",
  "billing:read",
  "*",
] as const satisfies readonly string[];

export const API_KEY_SCOPE_SCHEMA = z.enum(API_KEY_SCOPES);

export type ApiKeyScope = z.infer<typeof API_KEY_SCOPE_SCHEMA>;

/** A single scope maps to one better-auth access-control statement pair. */
interface ScopeStatement {
  readonly resource: string;
  readonly action: string;
}

const SCOPE_STATEMENTS: Readonly<Record<Exclude<ApiKeyScope, "*">, ScopeStatement>> = {
  "projects:read": { resource: "projects", action: "read" },
  "projects:write": { resource: "projects", action: "write" },
  "renders:queue": { resource: "renders", action: "queue" },
  "chat:run": { resource: "chat", action: "run" },
  "billing:read": { resource: "billing", action: "read" },
};

/**
 * The full v1 statement map — what "*" expands to (and the exact shape the
 * plugin stores in `apikey.permissions` / enforces on verify).
 */
export const API_KEY_ALL_STATEMENTS: Readonly<Record<string, readonly string[]>> = {
  projects: ["read", "write"],
  renders: ["queue"],
  chat: ["run"],
  billing: ["read"],
};

/**
 * Wire scopes → plugin statements (create path). "*" short-circuits to the
 * full map; other scopes union their resource/action pairs.
 */
export function apiKeyScopesToStatements(scopes: readonly string[]): Record<string, string[]> {
  if (scopes.includes("*")) {
    const full: Record<string, string[]> = {};
    for (const [resource, actions] of Object.entries(API_KEY_ALL_STATEMENTS)) {
      full[resource] = [...actions];
    }
    return full;
  }
  const out: Record<string, string[]> = {};
  for (const scope of scopes) {
    const statement = SCOPE_STATEMENTS[scope as Exclude<ApiKeyScope, "*">];
    if (statement === undefined) continue;
    const actions = out[statement.resource] ?? [];
    if (!actions.includes(statement.action)) actions.push(statement.action);
    out[statement.resource] = actions;
  }
  return out;
}

/**
 * Plugin statements → wire scopes (list path). Keys are only minted through
 * the vocabulary, so every stored pair maps back; a statement set that covers
 * the whole v1 map reads as ["*"]. Unknown pairs (older/newer vocabulary)
 * are dropped rather than leaked — the list surface stays wire-stable.
 */
export function apiKeyStatementsToScopes(statements: unknown): ApiKeyScope[] {
  const record =
    typeof statements === "object" && statements !== null
      ? (statements as Record<string, unknown>)
      : {};
  const pairs = new Set<string>();
  let coversAll = true;
  for (const [resource, actions] of Object.entries(API_KEY_ALL_STATEMENTS)) {
    for (const action of actions) pairs.add(`${resource}:${action}`);
  }
  const covered = new Set<string>();
  for (const [resource, rawActions] of Object.entries(record)) {
    if (!Array.isArray(rawActions)) continue;
    for (const action of rawActions) {
      if (typeof action !== "string") continue;
      covered.add(`${resource}:${action}`);
    }
  }
  for (const pair of pairs) {
    if (!covered.has(pair)) coversAll = false;
  }
  if (coversAll) return ["*"];
  const scopes: ApiKeyScope[] = [];
  for (const scope of API_KEY_SCOPES) {
    if (scope === "*") continue;
    const statement = SCOPE_STATEMENTS[scope];
    if (covered.has(`${statement.resource}:${statement.action}`)) scopes.push(scope);
  }
  return scopes;
}

/**
 * `POST /v1/workspaces/:id/api-keys` body.
 *
 * `expiresAt` is a future ISO-8601 instant; the plugin enforces a 1-day
 * minimum and a 365-day maximum lifetime (its `keyExpiration` defaults) and
 * the gateway pre-checks both so the error is a clean 400 VALIDATION_FAILED.
 */
export const CREATE_API_KEY_SCHEMA = z.strictObject({
  name: z.string().min(1).max(32),
  scopes: z.array(API_KEY_SCOPE_SCHEMA).min(1).max(API_KEY_SCOPES.length),
  expiresAt: ISO8601_SCHEMA.optional(),
});

export type CreateApiKeyRequest = z.infer<typeof CREATE_API_KEY_SCHEMA>;

/** GET /v1/workspaces/:id/api-keys query — the house cursor pagination. */
export const API_KEYS_QUERY_SCHEMA = PAGINATION_QUERY_SCHEMA;

export type ApiKeysQuery = z.infer<typeof API_KEYS_QUERY_SCHEMA>;

/** A workspace API key as the settings surface lists it — NEVER key material. */
export interface ApiKey {
  readonly id: Id;
  readonly name: string;
  readonly scopes: readonly ApiKeyScope[];
  readonly createdAt: string;
  /** null = never expires. */
  readonly expiresAt: string | null;
  /** Last successful Bearer authentication (null until first use). */
  readonly lastUsedAt: string | null;
  /** false once revoked — revoked keys fail authentication with 401. */
  readonly enabled: boolean;
}

/**
 * Create response — the plaintext key appears EXACTLY here, ONCE. The server
 * stores only the plugin's SHA-256 hash; there is no way to read `key` back.
 */
export interface CreatedApiKey extends ApiKey {
  /** Alias of `createdAt` (start of validity). */
  readonly startsAt: string;
  /** The full plaintext key (`studio_…`). Show once, then never again. */
  readonly key: string;
}

/** Revoke response — idempotent: the same row for a repeat DELETE. */
export interface RevokedApiKey {
  readonly id: Id;
  readonly revokedAt: string;
  readonly enabled: false;
}

/** Path param schema for DELETE /v1/workspaces/:id/api-keys/:keyId. */
export const API_KEY_ID_SCHEMA = ID_SCHEMA;
