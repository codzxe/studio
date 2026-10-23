// The settings API seam (W2-07, manifest "SETTINGS PART 2" web half):
// a narrow port the real `@studio/api-client` satisfies structurally, so every
// interactive surface under /w/settings/{api-keys,audit,models} is testable
// against a fake and the production build never hand-rolls a call
// (the asBillingPort / asSharePort house pattern).
//
// Every namespace is LANDED and bound directly — no casts, no runtime
// presence checks:
// - `client.apiKeys.{create,list,revoke}` and `client.models.list` (W1-02/03);
// - `client.settings.{get,update}` over GET/PATCH /v1/me/settings and
//   `client.audit.list(workspaceId, query)` over GET /v1/workspaces/:id/audit
//   (the W3-G2 gap closed on main: gateway routes/settings.ts +
//   routes/workspace-audit.ts and the api-client namespaces shipped — the old
//   cast seam was deleted in Wave 2 per the W1-A4/A5 audits).
//
// Boundary law (apps/web): `@studio/contracts` is `import type` ONLY — the
// wire types below come from contracts via `import type`, and the audit query
// input comes from `@studio/api-client` (the client's own input type).

import {
  type ApiClient,
  type AuditQueryInput,
  type CallOptions,
  type PaginationQueryInput,
  createApiClient,
  isApiError,
} from "@studio/api-client";
import type {
  ApiKey,
  AuditEntry,
  CreateApiKeyRequest,
  CreatedApiKey,
  ModelsResponse,
  Page,
  RevokedApiKey,
  SettingsPatchRequest,
  SettingsResponse,
} from "@studio/contracts";

/** Same-origin API root (Caddy fronts `/v1` in production — README §Env). */
export const SETTINGS_API_BASE_URL = "/v1";

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/**
 * The settings surface `@studio/api-client` exposes (W2-07 view half). Flat
 * method names; every namespace is bound structurally so a client signature
 * change is a typecheck failure here, never a runtime surprise.
 */
export interface SettingsPort {
  /**
   * POST /v1/workspaces/:id/api-keys — mint a workspace API key
   * (owner/admin). The response carries the plaintext `key` EXACTLY ONCE
   * (§7.1: hashed at rest, revocable) — persist it immediately, there is no
   * way to read it back.
   */
  readonly createApiKey: (
    workspaceId: string,
    body: CreateApiKeyRequest,
    options?: CallOptions,
  ) => Promise<CreatedApiKey>;
  /**
   * GET /v1/workspaces/:id/api-keys — the workspace's keys,
   * cursor-paginated, NEVER key material.
   */
  readonly listApiKeys: (
    workspaceId: string,
    query?: PaginationQueryInput,
    options?: CallOptions,
  ) => Promise<Page<ApiKey>>;
  /**
   * DELETE /v1/workspaces/:id/api-keys/:keyId — revoke (owner/admin,
   * idempotent). A revoked key fails every later Bearer authentication.
   */
  readonly revokeApiKey: (
    workspaceId: string,
    keyId: string,
    options?: CallOptions,
  ) => Promise<RevokedApiKey>;
  /**
   * GET /v1/workspaces/:id/audit — the workspace audit log, newest first
   * (viewer floor mirroring the project activity feed). Entries carry the
   * actor's display name — never emails, ips or metadata (law #1).
   */
  readonly listAudit: (
    workspaceId: string,
    query?: AuditQueryInput,
    options?: CallOptions,
  ) => Promise<Page<AuditEntry>>;
  /** GET /v1/models — the workspace plan + the models selectable on it (§8.2). */
  readonly listModels: (options?: CallOptions) => Promise<ModelsResponse>;
  /**
   * GET /v1/me/settings — the signed-in user's preferences. The row is
   * per USER (no workspace context); `autoApplyEnabled` reads false until
   * the first opt-in PATCH (D-22: apply is always your explicit click).
   */
  readonly getSettings: (options?: CallOptions) => Promise<SettingsResponse>;
  /** PATCH /v1/me/settings — upsert; echoes the stored value. */
  readonly updateSettings: (
    body: SettingsPatchRequest,
    options?: CallOptions,
  ) => Promise<SettingsResponse>;
}

// ---------------------------------------------------------------------------
// Adapter + production port
// ---------------------------------------------------------------------------

/**
 * Compile-time pin (and tiny adapter): the production `ApiClient` satisfies
 * {@link SettingsPort} — the settings pages never hand-roll a call. All four
 * namespaces (apiKeys, models, settings, audit) are landed api-client
 * members bound directly.
 */
export function asSettingsPort(client: ApiClient): SettingsPort {
  return {
    createApiKey: client.apiKeys.create,
    listApiKeys: client.apiKeys.list,
    revokeApiKey: client.apiKeys.revoke,
    listModels: client.models.list,
    listAudit: client.audit.list,
    getSettings: client.settings.get,
    updateSettings: client.settings.update,
  };
}

/** Builds the production port for one workspace-scoped settings page load. */
export function createDefaultSettingsPort(workspaceId: string): SettingsPort {
  return asSettingsPort(
    createApiClient({
      baseUrl: SETTINGS_API_BASE_URL,
      headers: { "x-workspace-id": workspaceId },
    }),
  );
}

// ---------------------------------------------------------------------------
// Typed failure mapping (§7.3 → §14 microcopy)
// ---------------------------------------------------------------------------

/** A bounded, human-safe action failure (message + optional hint + request id). */
export interface SettingsActionError {
  readonly message: string;
  readonly hint?: string;
  readonly requestId?: string;
}

/**
 * Map any thrown failure from a {@link SettingsPort} call to §14 microcopy.
 * ApiErrors keep their server message/hint/request id; anything else is the
 * sanitized generic (never a raw body or stack — law #1).
 */
export function toSettingsActionError(error: unknown): SettingsActionError {
  if (isApiError(error)) {
    return { message: error.message, hint: error.hint, requestId: error.requestId };
  }
  return { message: "Something went wrong on our side.", hint: "Try again in a moment." };
}
