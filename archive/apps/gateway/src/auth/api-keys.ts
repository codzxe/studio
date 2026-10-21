// Gateway-scoped API keys (W4-A; §15.2, ADR-0003) — verification only.
//
// Storage + hashing live in the Better Auth `apiKey` plugin (§16.3): keys are
// hashed at rest (SHA-256, never disabled), revocable (`enabled=false`), carry
// last-used metadata and per-key rate limits. The plugin's verify endpoint —
// `auth.api.verifyApiKey({ body: { key } })`, POST /api-key/verify — does the
// hash lookup and the enabled/expiry/quota/rate-limit accounting against the
// api_key table (mapped in ./server.js). This module owns what is
// gateway-SPECIFIC:
//
//   - the §15.2 scope vocabulary stored in api_key.scopes:
//       documents:read | documents:write | runs:create | exports:create
//     plus ONE reserved binding entry `org:<organizationId>` — the tenant
//     anchor of the key (§15.1). Keys are minted per workspace by the
//     key-management route (W4+): buildApiKeyScopes() below produces the exact
//     JSON to store.
//   - verification result: a SessionContext-shaped caller (contract of
//     src/middleware/auth-context.js / src/authz/guard.js) whose permissions
//     are the key scopes INTERSECTED with the owner's current workspace role —
//     "an editor's key can hold runs:create; a viewer's cannot" (ADR-0003),
//     including after a later demotion. Owner left the workspace → the key
//     is invalid (fail closed, §15.1).
//
// FAILURE SHAPE: every rejection is the single typed error `api_key_invalid`
// (task contract) — message/hint differentiate, `retryable` marks transient
// rate limiting. The request-level wrapper returns plain null instead so the
// middleware can answer its one generic 401 (no key-validity oracle, §15.2).

import { and, eq } from "drizzle-orm";
import type { Db } from "@studio/db";
import { member as memberTable } from "@studio/db";
import type { AuthResolverDeps } from "../middleware/auth-context.js";
import { extractBearerToken } from "../middleware/auth-context.js";
import { isRole, PERMISSIONS, type Permission, type Role } from "../authz/roles.js";
import { getAuthDb, getAuthServer, type AuthServer } from "./server.js";
import { getSessionUser, type SessionContext } from "./session.js";
import { z } from "zod";

/** Reserved workspace-binding prefix inside api_key.scopes (§15.1 anchor). */
export const ORG_SCOPE_PREFIX = "org:";

/**
 * §15.2 — the exact scope set a public key may hold. Subset of the member
 * permission vocabulary (authz/roles.js) so key grants can always be
 * represented as member permission strings.
 */
export const API_KEY_SCOPES: readonly Permission[] = [
  "documents:read",
  "documents:write",
  "runs:create",
  "exports:create"
];

// ---------------------------------------------------------------------------
// scopes codec (api_key.scopes)
// ---------------------------------------------------------------------------

/** One scope entry after trimming — boundary guard for stored DB data. */
const scopeEntrySchema = z.string().trim().min(1).max(256);

/**
 * Coerce the stored `scopes` value into a flat list of entry strings. Accepts
 * every shape the column can hold:
 *   - JSON text  `["org:…","documents:read"]`      (our convention)
 *   - JS array  ["org:…","documents:read"]         (adapter-decoded JSON)
 *   - statement Record `{"documents":["read"]}`   (plugin `permissions` format)
 *   - Postgres array literal `{a,b}`              (defensive)
 * Anything else (or malformed JSON) yields [] — fail closed.
 */
function coerceScopeEntries(raw: unknown): readonly string[] {
  if (raw === null || raw === undefined) {
    return [];
  }
  let items: unknown = raw;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (text.length === 0) {
      return [];
    }
    try {
      items = JSON.parse(text);
    } catch {
      if (text.startsWith("{") && text.endsWith("}")) {
        items = text
          .slice(1, -1)
          .split(",")
          .map((entry) => entry.replace(/^"|"$/g, "").trim())
          .filter((entry) => entry.length > 0);
      } else {
        return [];
      }
    }
  }
  if (Array.isArray(items)) {
    return items
      .map((item) => (typeof item === "string" ? item : null))
      .filter((item): item is string => item !== null);
  }
  if (typeof items === "object") {
    // Plugin statement format: { resource: [actions] } → "resource:action".
    const entries: string[] = [];
    for (const [resource, actions] of Object.entries(items)) {
      if (!Array.isArray(actions)) {
        continue;
      }
      for (const action of actions) {
        if (typeof action === "string") {
          entries.push(`${resource}:${action}`);
        }
      }
    }
    return entries;
  }
  return [];
}

/** Parsed api_key.scopes — the workspace binding plus valid §15.2 scope grants. */
export interface ParsedApiKeyScopes {
  /** Organization bound to the key via the `org:<id>` entry (§15.1). */
  readonly organizationId: string | null;
  /** Recognized §15.2 scopes, deduplicated, in stored order. */
  readonly permissions: readonly Permission[];
}

/**
 * Parse the stored scopes value. Unknown or over-long entries are DROPPED
 * (fail closed — a tampered column can never mint new grant strings), the
 * FIRST `org:` entry wins the workspace binding.
 */
export function parseApiKeyScopes(raw: unknown): ParsedApiKeyScopes {
  const permissions: Permission[] = [];
  let organizationId: string | null = null;
  for (const entry of coerceScopeEntries(raw)) {
    const parsed = scopeEntrySchema.safeParse(entry);
    if (!parsed.success) {
      continue;
    }
    const value = parsed.data;
    if (value.startsWith(ORG_SCOPE_PREFIX)) {
      const id = value.slice(ORG_SCOPE_PREFIX.length);
      organizationId ??= id.length > 0 ? id : null;
      continue;
    }
    const known = (API_KEY_SCOPES as readonly string[]).includes(value)
      ? (value as Permission)
      : null;
    if (known !== null && !permissions.includes(known)) {
      permissions.push(known);
    }
  }
  return { organizationId, permissions };
}

/**
 * Build the JSON text stored in api_key.scopes when minting a key (used by the
 * key-management route; §15.2 scoped keys): one `org:<id>` binding entry plus
 * the requested §15.2 scopes. Round-trips through parseApiKeyScopes.
 */
export function buildApiKeyScopes(input: {
  readonly organizationId: string;
  readonly permissions: readonly Permission[];
}): string {
  const scopes = input.permissions.filter(
    (permission, index) =>
      (API_KEY_SCOPES as readonly string[]).includes(permission) &&
      input.permissions.indexOf(permission) === index
  );
  return JSON.stringify([`${ORG_SCOPE_PREFIX}${input.organizationId}`, ...scopes]);
}

// ---------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------

/** Typed verification outcome — success context or the single typed error. */
export type ApiKeyVerification =
  | { readonly ok: true; readonly apiKeyId: string; readonly context: SessionContext }
  | {
      readonly ok: false;
      readonly code: "api_key_invalid";
      readonly message: string;
      readonly hint: string;
      readonly retryable: boolean;
    };

/**
 * Map a plugin verify error code to the client-safe envelope fields (§13.3:
 * stable code, human message, never internals). Pure — exported for tests.
 */
export function apiKeyFailureEnvelope(
  code: string | null | undefined
): { message: string; hint: string; retryable: boolean } {
  switch (code) {
    case "KEY_DISABLED":
      return {
        message: "API key is disabled.",
        hint: "This key was revoked. Create a new one in workspace settings.",
        retryable: false
      };
    case "KEY_EXPIRED":
      return {
        message: "API key has expired.",
        hint: "Create a new key in workspace settings.",
        retryable: false
      };
    case "USAGE_EXCEEDED":
      return {
        message: "API key usage limit reached.",
        hint: "This key has no remaining requests. Create a new one in workspace settings.",
        retryable: false
      };
    case "RATE_LIMITED":
      return {
        message: "API key rate limit exceeded.",
        hint: "Retry later, or raise this key's per-key rate limit in workspace settings.",
        retryable: true
      };
    default:
      return {
        message: "API key is invalid.",
        hint: "Send the key as 'Authorization: Bearer <key>' or 'x-api-key: <key>'.",
        retryable: false
      };
  }
}

function invalid(
  code: string | null | undefined
): Extract<ApiKeyVerification, { ok: false }> {
  const envelope = apiKeyFailureEnvelope(code);
  return {
    ok: false,
    code: "api_key_invalid",
    message: envelope.message,
    hint: envelope.hint,
    retryable: envelope.retryable
  };
}

/** Injectable collaborators (defaults resolve lazily; see server.ts). */
export interface VerifyApiKeyDeps {
  readonly auth?: AuthServer;
  readonly db?: Db;
}

/**
 * Extract the raw API key from a request: strict `Authorization: Bearer`
 * (reuses the middleware's RFC 9110 parser) or `x-api-key`. Null when absent.
 */
export function extractApiKey(request: Request): string | null {
  const bearer = extractBearerToken(request);
  if (bearer !== null) {
    return bearer;
  }
  const header = request.headers.get("x-api-key");
  const trimmed = typeof header === "string" ? header.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Verify a raw API key and resolve the caller (§15.2). Server-side flow —
 * called by the auth middleware per request (no caching: the plugin's verify
 * also updates last-used/rate-limit counters, so every call must reach it):
 *
 *   1. plugin verify: hash lookup + enabled + expiry + quota + per-key rate
 *      limit (api_key table, mapped in ./server.js);
 *   2. scopes: workspace binding + §15.2 grants (parseApiKeyScopes);
 *   3. owner's CURRENT member role in that workspace (Drizzle lookup — keys
 *      are personal: owner left the workspace ⇒ invalid);
 *   4. effective grants = key scopes ∩ role grants (ADR-0003: never wider
 *      than the creating member).
 *
 * Failures return the typed `api_key_invalid` envelope; infrastructure
 * exceptions from the plugin are already folded into its `valid:false`
 * response, and anything that still throws propagates (outage ≠ invalid key).
 */
export async function verifyApiKey(
  rawKey: string,
  deps: VerifyApiKeyDeps = {}
): Promise<ApiKeyVerification> {
  const trimmed = rawKey.trim();
  if (trimmed.length === 0) {
    return invalid("INVALID_API_KEY");
  }
  const auth = deps.auth ?? getAuthServer();
  const db = deps.db ?? getAuthDb();

  // (1) plugin verify — hash store, revocation, expiry, per-key limits.
  const result = await auth.api.verifyApiKey({ body: { key: trimmed } });
  if (!result.valid || !result.key) {
    return invalid(result.error?.code);
  }
  const key = result.key;

  // (2) gateway scopes — organization binding + §15.2 grants.
  const scopes = parseApiKeyScopes(key.permissions);
  if (!scopes.organizationId) {
    return invalid("KEY_NOT_FOUND"); // not bound to a workspace — unusable here
  }

  // (3) owner's current role in the bound workspace (personal keys).
  const rows = await db
    .select()
    .from(memberTable)
    .where(
      and(
        eq(memberTable.organizationId, scopes.organizationId),
        eq(memberTable.userId, key.referenceId)
      )
    )
    .limit(1);
  const role: Role | null = rows[0]?.role ?? null;
  if (!role || !isRole(role)) {
    return invalid("KEY_NOT_FOUND"); // owner is not (any longer) a member
  }

  // (4) key grants narrowed by the role — never wider than the member (ADR).
  const roleGrants: readonly string[] = PERMISSIONS[role];
  const permissions = scopes.permissions.filter((permission) =>
    roleGrants.includes(permission)
  );

  const context: SessionContext = Object.freeze({
    userId: key.referenceId,
    organizationId: scopes.organizationId,
    role,
    permissions
  });
  return { ok: true, apiKeyId: key.id, context };
}

/**
 * Request-level wrapper the auth middleware consumes
 * (AuthResolverDeps.verifyApiKey): extracts the key, verifies, and flattens
 * every failure to plain `null` — the middleware answers its one generic 401
 * (§15.2: no oracle about which mechanism or check failed).
 */
export async function verifyApiKeyRequest(
  request: Request,
  deps: VerifyApiKeyDeps = {}
): Promise<SessionContext | null> {
  const rawKey = extractApiKey(request);
  if (rawKey === null) {
    return null;
  }
  const result = await verifyApiKey(rawKey, deps);
  return result.ok ? result.context : null;
}

/**
 * The resolver pair `createDefaultAuthProvider` composes (W4-B contract —
 * src/middleware/auth-context.js). Wiring wave:
 *   requireAuth(createDefaultAuthProvider(createAuthResolvers()))
 */
export function createAuthResolvers(deps: VerifyApiKeyDeps = {}): AuthResolverDeps {
  return {
    getSession: (request) => getSessionUser(request),
    verifyApiKey: (request) => verifyApiKeyRequest(request, deps)
  };
}
