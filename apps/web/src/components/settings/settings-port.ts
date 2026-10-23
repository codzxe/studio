// The settings API seam (W2-07, manifest "SETTINGS PART 2" web half):
// a narrow port the real `@studio/api-client` satisfies structurally, so every
// interactive surface under /w/settings/{api-keys,audit,models} is testable
// against a fake and the production build never hand-rolls a call
// (the asBillingPort / asSharePort house pattern).
//
// Composition across BOTH halves of the settings wave:
// - `client.apiKeys.{create,list,revoke}` and `client.models.list` are LANDED
//   namespaces (W1-02/03) — bound directly, no cast.
// - `client.settings.{get,update}` and `client.audit.list(workspaceId, query)`
//   DO NOT EXIST yet: the wire contracts landed (contracts routes/settings.ts
//   + routes/audit.ts, W3-G3) but the GATEWAY routes (GET/PATCH
//   /v1/me/settings + GET /v1/workspaces/:id/audit) and the api-client
//   namespaces never did — a Wave-2 backend gap (documented in the W5-03
//   worklog; do NOT fake data behind them). Until they land, this module
//   reaches the expected shapes through ONE narrow typed cast with a runtime
//   presence check — a deployment without the namespaces degrades to the
//   honest typed failure below instead of a TypeError. When the namespaces
//   are on main, DELETE the cast and bind them directly (TODO(W3-G2) marks
//   the exact lines).
//
// Boundary law (apps/web): `@studio/contracts` is `import type` ONLY — the
// W3-G2 wire shapes are restated here as local types (the billing page's
// "type-only restatements" precedent).

import {
  type ApiClient,
  type CallOptions,
  type PaginationQueryInput,
  createApiClient,
  isApiError,
} from "@studio/api-client";
import type {
  ApiKey,
  CreateApiKeyRequest,
  CreatedApiKey,
  ModelsResponse,
  Page,
  RevokedApiKey,
} from "@studio/contracts";

/** Same-origin API root (Caddy fronts `/v1` in production — README §Env). */
export const SETTINGS_API_BASE_URL = "/v1";

// ---------------------------------------------------------------------------
// W3-G2 wire restatements (local; import-type-only law)
// ---------------------------------------------------------------------------

/**
 * `GET/PATCH /v1/me/settings` payload (W3-G2 lands
 * `packages/contracts/src/routes/settings.ts`). User-scoped by design (the
 * settings repo is per-USER, not per-workspace) — `autoApplyEnabled` defaults
 * to false: agent edits stay propose-only until the user opts in (D-22).
 */
export interface UserSettings {
  readonly autoApplyEnabled: boolean;
}

/** `PATCH /v1/me/settings` body — the one v1 preference the route carries. */
export interface UpdateUserSettingsRequest {
  readonly autoApplyEnabled: boolean;
}

/**
 * One `GET /v1/workspaces/:id/audit` row. W3-G2's route mirrors the activity
 * DTO (gateway routes/activity.ts `toDto`): the user-facing log carries actor
 * name + action + target + time; emails, metadata and ips never cross into it
 * (law #1 — those live in the admin-only project audit export).
 */
export interface AuditEntry {
  readonly id: string;
  readonly actorId: string;
  readonly actorName: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly createdAt: string;
}

/**
 * `GET /v1/workspaces/:id/audit` query — the house cursor pagination plus the
 * SERVER-side `targetType` filter (`repos.audit.list`'s targetType). The
 * action filter stays client-side over loaded rows (the wire has no action
 * param — same posture as the M7 activity feed).
 */
export interface AuditQueryInput {
  readonly cursor?: string;
  readonly limit?: number;
  readonly targetType?: string;
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/**
 * The settings surface `@studio/api-client` exposes (W2-07 view half). Flat
 * method names; every landed namespace is bound structurally so a client
 * signature change is a typecheck failure here, never a runtime surprise.
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
   * (W3-G2 seam; viewer floor mirroring the project activity feed).
   */
  readonly listAudit: (
    workspaceId: string,
    query?: AuditQueryInput,
    options?: CallOptions,
  ) => Promise<Page<AuditEntry>>;
  /** GET /v1/models — the workspace plan + the models selectable on it (§8.2). */
  readonly listModels: (options?: CallOptions) => Promise<ModelsResponse>;
  /** GET /v1/me/settings — the signed-in user's preferences (W3-G2 seam). */
  readonly getSettings: (options?: CallOptions) => Promise<UserSettings>;
  /** PATCH /v1/me/settings — upsert the signed-in user's preferences (W3-G2 seam). */
  readonly updateSettings: (
    body: UpdateUserSettingsRequest,
    options?: CallOptions,
  ) => Promise<UserSettings>;
}

// ---------------------------------------------------------------------------
// The W3-G2 cast seam — the ONE unsound edge in this module
// ---------------------------------------------------------------------------

/**
 * Raised when a W3-G2 namespace (`settings` / `audit`) is not on the client
 * yet — i.e. this app build is running ahead of the sibling's gateway sync.
 * Maps to the honest "not wired yet" copy in {@link toSettingsActionError};
 * never a TypeError, never a stack (law #1).
 */
export class SettingsSeamPendingError extends Error {
  readonly namespace: "settings" | "audit";

  constructor(namespace: "settings" | "audit") {
    super(`The api-client "${namespace}" namespace is not available yet (W3-G2 seam).`);
    this.name = "SettingsSeamPendingError";
    this.namespace = namespace;
  }
}

/** `true` only for this module's seam rejections. */
export function isSettingsSeamPendingError(value: unknown): value is SettingsSeamPendingError {
  return value instanceof SettingsSeamPendingError;
}

/**
 * TODO(W3-G2, backend gap): the expected `client.settings` namespace
 * (following the members pattern) — `settings: { get, update }` over
 * GET/PATCH /v1/me/settings. When it lands, delete this interface and the
 * cast in {@link settingsNamespace}, and bind `client.settings` directly in
 * {@link asSettingsPort}.
 */
interface SettingsNamespaceSeam {
  readonly get: (options?: CallOptions) => Promise<UserSettings>;
  readonly update: (
    body: UpdateUserSettingsRequest,
    options?: CallOptions,
  ) => Promise<UserSettings>;
}

/**
 * TODO(W3-G2, backend gap): the expected `client.audit` namespace —
 * `audit: { list(workspaceId, query) }` over GET /v1/workspaces/:id/audit.
 * Same deal as {@link SettingsNamespaceSeam} when it lands.
 */
interface AuditNamespaceSeam {
  readonly list: (
    workspaceId: string,
    query?: AuditQueryInput,
    options?: CallOptions,
  ) => Promise<Page<AuditEntry>>;
}

/** The narrow slice of ApiClient the cast inspects — nothing else is touched. */
interface W3G2ClientSeam {
  readonly settings?: SettingsNamespaceSeam;
  readonly audit?: AuditNamespaceSeam;
}

function settingsNamespace(client: ApiClient): SettingsNamespaceSeam {
  const seam = (client as unknown as W3G2ClientSeam).settings;
  if (seam === undefined) throw new SettingsSeamPendingError("settings");
  return seam;
}

function auditNamespace(client: ApiClient): AuditNamespaceSeam {
  const seam = (client as unknown as W3G2ClientSeam).audit;
  if (seam === undefined) throw new SettingsSeamPendingError("audit");
  return seam;
}

// ---------------------------------------------------------------------------
// Adapter + production port
// ---------------------------------------------------------------------------

/**
 * Compile-time pin (and tiny adapter): the production `ApiClient` satisfies
 * {@link SettingsPort} — the settings pages never hand-roll a call. The
 * apiKeys/models regions are landed namespaces; settings/audit go through the
 * W3-G2 cast seam above.
 */
export function asSettingsPort(client: ApiClient): SettingsPort {
  return {
    createApiKey: client.apiKeys.create,
    listApiKeys: client.apiKeys.list,
    revokeApiKey: client.apiKeys.revoke,
    listModels: client.models.list,
    listAudit: (workspaceId, query, options) =>
      auditNamespace(client).list(workspaceId, query, options),
    getSettings: (options) => settingsNamespace(client).get(options),
    updateSettings: (body, options) => settingsNamespace(client).update(body, options),
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
 * ApiErrors keep their server message/hint/request id; a pending W3-G2 seam
 * reads as the honest not-wired-yet note; anything else is the sanitized
 * generic (never a raw body or stack — law #1).
 */
export function toSettingsActionError(error: unknown): SettingsActionError {
  if (isSettingsSeamPendingError(error)) {
    return {
      message: "This part of Settings isn’t wired on this deployment yet.",
      hint: "It arrives with the current rollout — nothing is lost, try again later.",
    };
  }
  if (isApiError(error)) {
    return { message: error.message, hint: error.hint, requestId: error.requestId };
  }
  return { message: "Something went wrong on our side.", hint: "Try again in a moment." };
}
