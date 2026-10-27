// @studio/api-client — typed fetch client for the §7.2 control plane.
//
// Every call: unwrap the §7.3 envelope (Ok → data, Err → typed ApiError),
// runtime-validate the response data with the matching Zod schema (strip
// unknown keys by default), validate request bodies client-side with the
// contracts schemas before sending, send `Idempotency-Key` on every mutation
// (§7.2: "mutations require Idempotency-Key or derive one from a client
// UUID"), support AbortSignal everywhere, and retry idempotent-safe GETs with
// exponential backoff (250/500/1000 ms) on network errors, 429 and retryable
// 5xx responses.
//
// Framework-agnostic: browser fetch, node fetch (>=22) and test doubles all
// fit `FetchLike`. The SSE chat stream lives in ./sse.ts (it must stream, not
// buffer); `chat.stream` delegates there.

import {
  ACQUIRE_LEASE_SCHEMA,
  ACTIVITY_QUERY_SCHEMA,
  APPLY_REQUEST_SCHEMA,
  AUDIT_QUERY_SCHEMA,
  type AcceptedInvite,
  type AcquireLeaseRequest,
  type ActivityEntry,
  type ApiKey,
  type ApplyRequest,
  type ApplyResponse,
  type Asset,
  type AuditEntry,
  type AuditExport,
  type AuditQuery,
  type BillingState,
  CANCEL_RENDER_SCHEMA,
  CANCEL_RUN_SCHEMA,
  CHECKOUT_SCHEMA,
  COMMENTS_QUERY_SCHEMA,
  COMMENT_REPLY_SCHEMA,
  CREATE_API_KEY_SCHEMA,
  CREATE_ASSET_SCHEMA,
  CREATE_COMMENT_SCHEMA,
  CREATE_PROJECT_SCHEMA,
  CREATE_SHARE_COMMENT_SCHEMA,
  CREATE_THREAD_SCHEMA,
  CREATE_WORKSPACE_SCHEMA,
  type CancelRenderRequest,
  type CancelRunRequest,
  type ChatRequest,
  type CheckoutRequest,
  type CheckoutResponse,
  type Comment,
  type CommentReplyRequest,
  type CreateApiKeyRequest,
  type CreateAssetRequest,
  type CreateAssetResponse,
  type CreateCommentRequest,
  type CreateProjectRequest,
  type CreateShareCommentRequest,
  type CreateThreadRequest,
  type CreateWorkspaceRequest,
  type CreatedApiKey,
  type CreditsSummary,
  type EditPlan,
  type Err,
  type EstimateResult,
  IDEMPOTENCY_KEY_SCHEMA,
  INVITE_MEMBER_SCHEMA,
  INVOICES_QUERY_SCHEMA,
  ISSUE_SHARE_LINK_SCHEMA,
  type Invite,
  type InviteMemberRequest,
  type InvoiceRecord,
  type IssueShareLinkRequest,
  LEDGER_QUERY_SCHEMA,
  type LedgerEntry,
  type MeResponse,
  type Member,
  type MemberRemoved,
  type ModelsResponse,
  type OwnershipTransferred,
  PAGINATION_QUERY_SCHEMA,
  PATCH_MEMBER_ROLE_SCHEMA,
  PATCH_PROJECT_SCHEMA,
  PATCH_WORKSPACE_SCHEMA,
  PORTAL_SCHEMA,
  PRESENCE_BEAT_SCHEMA,
  PRESENCE_VIEWERS_SCHEMA,
  PROJECTS_QUERY_SCHEMA,
  type Page,
  type PatchMemberRoleRequest,
  type PatchProjectRequest,
  type PatchWorkspaceRequest,
  type PortalRequest,
  type PortalResponse,
  type PresenceBeatRequest,
  type PresenceViewersResponse,
  type Project,
  type ProjectManifest,
  type ProjectVersion,
  QUEUE_RENDER_SCHEMA,
  type QueueRenderRequest,
  RECONCILE_REQUEST_SCHEMA,
  RENDERS_QUERY_SCHEMA,
  RENDER_ESTIMATE_REQUEST_SCHEMA,
  REQUEST_ACCESS_SCHEMA,
  RESOLVE_COMMENT_SCHEMA,
  RESTORE_VERSION_SCHEMA,
  RUN_EVENT_REQUEST_SCHEMA,
  type ReconcileReport,
  type ReconcileRequest,
  type RenderEstimateRequest,
  type RenderJob,
  type RequestAccessRequest,
  type RequestAccessResponse,
  type ResolveCommentRequestInput,
  type RestoreVersionRequest,
  type RevokedApiKey,
  type RunEventRequest,
  type RunRecord,
  SETTINGS_PATCH_SCHEMA,
  SET_VERSION_LABEL_SCHEMA,
  SHARE_COMMENTS_QUERY_SCHEMA,
  SHARE_PASSWORD_HEADER,
  type SetVersionLabelRequest,
  type SettingsPatchRequest,
  type SettingsResponse,
  type ShareComment,
  type ShareInfo,
  type ShareLinkIssued,
  type ShareLinkRevoked,
  type ShareLinkView,
  type ShareManifest,
  type SignedUrlResponse,
  type SwitchedWorkspace,
  TOPUP_SCHEMA,
  TRANSFER_OWNERSHIP_SCHEMA,
  TRIAL_REQUEST_SCHEMA,
  type Thread,
  type ThreadMessage,
  type TopUpRequest,
  type TopUpResponse,
  type TransferOwnershipRequest,
  type TrialRequest,
  type TrialResponse,
  UNDO_REQUEST_SCHEMA,
  UPLOAD_VERSION_SCHEMA,
  type UndoRequest,
  type UndoResponse,
  type VerifyAssetResponse,
  type VersionDiffSummary,
  type VersionTimelineEntry,
  type Workspace,
  type WorkspaceDetail,
  isErr,
  isOk,
} from "@studio/contracts";
import type { z } from "zod";

import {
  ApiError,
  fromResponse,
  invalidRequestError,
  isApiError,
  malformedResponseError,
  networkError,
  uploadFailedError,
} from "./api-error";
import {
  ACCEPTED_INVITE_SCHEMA,
  ACTIVITY_ENTRY_SCHEMA,
  API_KEY_SCHEMA,
  APPLY_RESPONSE_SCHEMA,
  ASSET_SCHEMA,
  AUDIT_EXPORT_SCHEMA,
  BILLING_STATE_SCHEMA,
  CHECKOUT_RESPONSE_SCHEMA,
  COMMENT_SCHEMA,
  CREATED_API_KEY_SCHEMA,
  CREATE_ASSET_RESPONSE_SCHEMA,
  CREDITS_SUMMARY_SCHEMA,
  ESTIMATE_RESULT_SCHEMA,
  INVITE_SCHEMA,
  LEASE_ACQUIRE_RESPONSE_SCHEMA,
  LEASE_RELEASE_RESPONSE_SCHEMA,
  LEASE_REQUEST_CANCELLED_RESPONSE_SCHEMA,
  LEASE_REQUEST_RESPONSE_SCHEMA,
  LEASE_STATE_RESPONSE_SCHEMA,
  LEDGER_ENTRY_SCHEMA,
  type LeaseAcquireResponse,
  type LeaseReleaseResponse,
  type LeaseRequestCancelledResponse,
  type LeaseRequestResponse,
  type LeaseStateResponse,
  MEMBER_REMOVED_SCHEMA,
  MEMBER_SCHEMA,
  ME_RESPONSE_SCHEMA,
  MODELS_RESPONSE_SCHEMA,
  OWNERSHIP_TRANSFERRED_SCHEMA,
  PAGE_ACTIVITY_SCHEMA,
  PAGE_API_KEYS_SCHEMA,
  PAGE_ASSETS_SCHEMA,
  PAGE_AUDIT_SCHEMA,
  PAGE_COMMENTS_SCHEMA,
  PAGE_INVOICES_SCHEMA,
  PAGE_LEDGER_SCHEMA,
  PAGE_MEMBERS_SCHEMA,
  PAGE_MESSAGES_SCHEMA,
  PAGE_PROJECTS_SCHEMA,
  PAGE_RENDERS_SCHEMA,
  PAGE_SHARE_COMMENTS_SCHEMA,
  PAGE_SHARE_LINKS_SCHEMA,
  PAGE_THREADS_SCHEMA,
  PAGE_VERSIONS_SCHEMA,
  PAGE_VERSION_TIMELINE_SCHEMA,
  PAGE_WORKSPACES_SCHEMA,
  PORTAL_RESPONSE_SCHEMA,
  PROJECT_MANIFEST_SCHEMA,
  PROJECT_SCHEMA,
  PROJECT_VERSION_SCHEMA,
  RECONCILE_REPORT_SCHEMA,
  RENDER_JOB_SCHEMA,
  REQUEST_ACCESS_RESPONSE_SCHEMA,
  REVOKED_API_KEY_SCHEMA,
  RUN_PLAN_RESPONSE_SCHEMA,
  RUN_RECORD_SCHEMA,
  type RunPlanResponse,
  SETTINGS_RESPONSE_SCHEMA,
  SHARE_COMMENT_SCHEMA,
  SHARE_INFO_SCHEMA,
  SHARE_LINK_ISSUED_SCHEMA,
  SHARE_LINK_REVOKED_SCHEMA,
  SHARE_LINK_VIEW_SCHEMA,
  SHARE_MANIFEST_SCHEMA,
  SIGNED_URL_RESPONSE_SCHEMA,
  SWITCHED_WORKSPACE_SCHEMA,
  THREAD_MESSAGE_SCHEMA,
  THREAD_SCHEMA,
  TRIAL_RESPONSE_SCHEMA,
  UNDO_RESPONSE_SCHEMA,
  VERIFY_ASSET_RESPONSE_SCHEMA,
  VERSION_DIFF_SUMMARY_SCHEMA,
  WORKSPACE_DETAIL_SCHEMA,
  WORKSPACE_SCHEMA,
} from "./response-schemas";
import {
  type ChatStreamController,
  type ChatStreamHandlers,
  type ChatStreamReconnectConfig,
  type TurnStreamHandle,
  type TurnStreamHandlers,
  type TurnStreamReconnectConfig,
  streamChat,
  streamTurn,
} from "./sse";
import { isAbortError, sleepWithAbort } from "./utils";

// The §8.2/§10.1 wire type of `models.list()` — re-exported from the public
// surface (the package barrel re-exports this module) so model-picker
// consumers don't need a separate @studio/contracts import for it.
export type { ModelsResponse };

// ---------------------------------------------------------------------------
// Options and shapes
// ---------------------------------------------------------------------------

/** Anything that behaves like `fetch` (browser, node >=22, test doubles). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Factory for mutation idempotency keys (§7.2). Default: `crypto.randomUUID()`. */
export type IdempotencyKeyFactory = () => string;

/** Per-call options: cancellation + explicit idempotency key for mutations. */
export interface CallOptions {
  readonly signal?: AbortSignal;
  /** §7.2 idempotency key; auto-generated when omitted. */
  readonly idempotencyKey?: string;
}

/**
 * Share-surface call options: everything in CallOptions plus the optional
 * password that protected share tokens require (`x-share-password` header —
 * never a query parameter, so it stays out of logs and referrers).
 */
export interface ShareCallOptions extends CallOptions {
  readonly password?: string;
}

export interface ApiClientOptions {
  /**
   * API root INCLUDING the version segment. Default `"/v1"` (same-origin,
   * browser). Node/test callers pass an absolute origin, e.g.
   * `http://127.0.0.1:8787/v1`.
   */
  readonly baseUrl?: string;
  /** `fetch` implementation; defaults to the global. */
  readonly fetch?: FetchLike;
  /** Extra headers merged into every request (e.g. `Authorization` for API keys). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Idempotency-key factory for mutations. */
  readonly idempotencyKey?: IdempotencyKeyFactory;
  /** Sleep seam for the retry backoff (tests inject zero-delay sleeps). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** GET retry backoff, initial attempt + one retry per entry. Default 250/500/1000 ms. */
  readonly retry?: { readonly delaysMs?: readonly number[] };
}

/** Default GET backoff (task spec): 250 ms → 500 ms → 1000 ms, then give up. */
export const RETRY_DELAYS_MS: readonly number[] = [250, 500, 1000];

const DEFAULT_BASE_URL = "/v1";

// Query-parameter shapes use the contracts schemas' INPUT types: defaulted
// fields (e.g. `limit: 50`) stay optional for callers, while parse() still
// applies the defaults before the request goes out.
export type PaginationQueryInput = z.input<typeof PAGINATION_QUERY_SCHEMA>;
export type CommentsQueryInput = z.input<typeof COMMENTS_QUERY_SCHEMA>;
export type ShareCommentsQueryInput = z.input<typeof SHARE_COMMENTS_QUERY_SCHEMA>;
export type LedgerQueryInput = z.input<typeof LEDGER_QUERY_SCHEMA>;
export type ActivityQueryInput = z.input<typeof ACTIVITY_QUERY_SCHEMA>;
export type AuditQueryInput = z.input<typeof AUDIT_QUERY_SCHEMA>;
export type RendersQueryInput = z.input<typeof RENDERS_QUERY_SCHEMA>;
/** W1-c (§9.1): projects list + the archived filter (true → archived only). */
export type ProjectsQueryInput = z.input<typeof PROJECTS_QUERY_SCHEMA>;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Serialized query string; `undefined`/`null` values are skipped. */
export function buildQuery(
  params: Record<string, string | number | boolean | null | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text === "" ? "" : `?${text}`;
}

interface RequestPlan<T> {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly path: string;
  readonly query?: Record<string, string | number | boolean | undefined>;
  readonly body?: unknown;
  /**
   * Pre-built request body (W5-09): multipart/form-data for the version
   * upload. Sent as-is; NO Content-Type is set so fetch derives the
   * multipart boundary itself. Mutually exclusive with `body`.
   */
  readonly rawBody?: BodyInit;
  /** Runtime schema for the unwrapped `data` (strip unknown by default). */
  readonly responseSchema?: z.ZodType<T>;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
  /** Extra request headers (e.g. the share password gate header). */
  readonly headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Client implementation
// ---------------------------------------------------------------------------

interface ClientInternals {
  readonly baseUrl: string;
  readonly fetchImpl: FetchLike;
  readonly extraHeaders: Record<string, string>;
  readonly newKey: IdempotencyKeyFactory;
  readonly sleep: (ms: number) => Promise<void>;
  readonly retryDelays: readonly number[];
}

function encodeId(id: string): string {
  return encodeURIComponent(id);
}

class ApiClientImpl {
  constructor(readonly core: ClientInternals) {}

  /**
   * One HTTP call: envelope unwrap, response validation, GET retry with
   * backoff. Never surfaces raw response text — errors are typed ApiErrors.
   */
  async request<T>(plan: RequestPlan<T>): Promise<T> {
    const url = `${this.core.baseUrl}${plan.path}${plan.query ? buildQuery(plan.query) : ""}`;

    let attempt = 0;
    for (;;) {
      let status = 0;
      let statusText = "";
      let text = "";
      try {
        const init = this.buildInit(plan);
        const response = await this.core.fetchImpl(url, init);
        status = response.status;
        statusText = response.statusText;
        text = await response.text();
      } catch (error) {
        if (isAbortError(error) || plan.signal?.aborted) throw error;
        const netError = networkError(error);
        if (!this.shouldRetry(plan, netError, attempt)) throw netError;
        await this.backoff(plan, attempt);
        attempt += 1;
        continue;
      }

      if (status < 200 || status > 299) {
        const apiError = await fromResponse({
          status,
          statusText,
          text: async () => text,
        });
        if (!this.shouldRetry(plan, apiError, attempt)) throw apiError;
        await this.backoff(plan, attempt);
        attempt += 1;
        continue;
      }

      return this.unwrapOk<T>(status, text, plan);
    }
  }

  private buildInit(plan: RequestPlan<unknown>): RequestInit {
    const headers = new Headers(this.core.extraHeaders);
    headers.set("Accept", "application/json");
    if (plan.rawBody === undefined && plan.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    if (plan.idempotencyKey !== undefined) headers.set("Idempotency-Key", plan.idempotencyKey);
    if (plan.headers !== undefined) {
      for (const [name, value] of Object.entries(plan.headers)) headers.set(name, value);
    }
    const init: RequestInit = {
      method: plan.method,
      headers,
      signal: plan.signal,
    };
    // rawBody (multipart form) goes out verbatim — the browser/undici fetch
    // derives the Content-Type + boundary; a manual one would break parsing.
    if (plan.rawBody !== undefined) init.body = plan.rawBody;
    else if (plan.body !== undefined) init.body = JSON.stringify(plan.body);
    return init;
  }

  /** Only idempotent-safe GETs retry, and only when the failure is retryable. */
  private shouldRetry(plan: RequestPlan<unknown>, error: ApiError, attempt: number): boolean {
    if (plan.method !== "GET") return false;
    if (attempt >= this.core.retryDelays.length) return false;
    if (error.status === 0) return true; // network error before any response
    if (error.status === 408 || error.status === 429 || error.status >= 500) {
      return error.retryable;
    }
    return false;
  }

  /**
   * Round-12 seam: ONE JSON POST whose 2xx body may be a RAW payload (the
   * turn route family returns plain JSON) OR the §7.3 Ok envelope — both
   * accepted, `isErr` always the failure arm. No retry (mutations), the
   * caller's idempotency key rides the header. Without a response schema the
   * parsed payload returns as-is (best-effort surfaces like abandon).
   */
  async rawJsonPost<T>(plan: {
    readonly path: string;
    readonly body: unknown;
    readonly responseSchema?: z.ZodType<T>;
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  }): Promise<T> {
    const url = `${this.core.baseUrl}${plan.path}`;
    const headers = new Headers(this.core.extraHeaders);
    headers.set("Accept", "application/json");
    headers.set("Content-Type", "application/json");
    headers.set("Idempotency-Key", plan.idempotencyKey);
    let response: Response;
    try {
      response = await this.core.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(plan.body),
        signal: plan.signal,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw networkError(error);
    }
    if (!response.ok) {
      throw await fromResponse(response);
    }
    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw malformedResponseError(response.status);
    }
    if (isErr(json)) {
      const error = json.error;
      throw new ApiError({
        code: error.code,
        message: error.message,
        hint: error.hint,
        retryable: error.retryable,
        requestId: error.requestId,
        status: response.status,
        cause: json,
      });
    }
    const payload = isOk(json) ? json.data : json;
    if (plan.responseSchema === undefined) return payload as T;
    try {
      return plan.responseSchema.parse(payload);
    } catch (error) {
      throw malformedResponseError(response.status, error);
    }
  }

  private backoff(plan: RequestPlan<unknown>, attempt: number): Promise<void> {
    const delay = this.core.retryDelays[attempt] ?? 0;
    return sleepWithAbort(this.core.sleep, delay, plan.signal);
  }

  /** 2xx handling: empty body → `null`; otherwise a §7.3 Ok envelope is required. */
  private unwrapOk<T>(status: number, text: string, plan: RequestPlan<T>): T {
    if (text === "") {
      if (plan.responseSchema === undefined) return null as T;
      throw malformedResponseError(status);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw malformedResponseError(status);
    }
    if (isErr(json)) {
      const error: Err["error"] = json.error;
      // A 2xx status with an Err body is still the §7.3 failure arm.
      throw new ApiError({
        code: error.code,
        message: error.message,
        hint: error.hint,
        retryable: error.retryable,
        requestId: error.requestId,
        status,
        cause: json,
      });
    }
    if (!isOk(json)) throw malformedResponseError(status);
    const data = json.data;
    if (plan.responseSchema === undefined) return data as T;
    try {
      return plan.responseSchema.parse(data);
    } catch (error) {
      throw malformedResponseError(status, error);
    }
  }

  /** Client-side §7.2 request validation — fails fast, never sends. */
  validateBody<T>(schema: z.ZodType<T>, body: unknown, path: string): T {
    try {
      return schema.parse(body);
    } catch (error) {
      if (isApiError(error)) throw error;
      throw invalidRequestError(
        Object.assign(new Error(`invalid body for ${path}`), { cause: error }),
      );
    }
  }

  autoKey(): string {
    return this.core.newKey();
  }

  // -- GETs don't send Idempotency-Key; mutations always do (auto when absent).
  async get<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined> | undefined,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
    headers?: Record<string, string>,
  ): Promise<T> {
    return this.request<T>({
      method: "GET",
      path,
      query,
      responseSchema: schema,
      signal,
      headers,
    });
  }

  async mutate<T>(
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    plan: {
      body?: unknown;
      bodySchema?: z.ZodType<unknown>;
      responseSchema?: z.ZodType<T>;
      idempotencyKey?: string;
      signal?: AbortSignal;
      headers?: Record<string, string>;
    },
  ): Promise<T> {
    const body =
      plan.bodySchema !== undefined
        ? this.validateBody(plan.bodySchema, plan.body, path)
        : plan.body;
    return this.request<T>({
      method,
      path,
      body,
      responseSchema: plan.responseSchema,
      idempotencyKey: plan.idempotencyKey ?? this.autoKey(),
      signal: plan.signal,
      headers: plan.headers,
    });
  }
}

// ---------------------------------------------------------------------------
// Public client surface
// ---------------------------------------------------------------------------

/** Typed, namespaced client for the §7.2 API surface. */
export interface ApiClient {
  readonly me: {
    /** GET /v1/me — user + memberships + plan summary. */
    get(options?: CallOptions): Promise<MeResponse>;
  };
  readonly settings: {
    /**
     * GET /v1/me/settings — the signed-in user's preferences. The row is
     * per USER (no workspace context); `autoApplyEnabled` reads false until
     * the first opt-in PATCH (D-22: apply is always your explicit click).
     */
    get(options?: CallOptions): Promise<SettingsResponse>;
    /** PATCH /v1/me/settings — upsert; echoes the stored value. */
    update(body: SettingsPatchRequest, options?: CallOptions): Promise<SettingsResponse>;
  };
  readonly workspaces: {
    list(query?: PaginationQueryInput, options?: CallOptions): Promise<Page<Workspace>>;
    create(body: CreateWorkspaceRequest, options?: CallOptions): Promise<Workspace>;
    /**
     * GET /v1/workspaces/:id (W5-09) — the workspace row + the CALLER's role
     * + the roster. A workspace the caller doesn't belong to is 404 (§12.1).
     */
    get(id: string, options?: CallOptions): Promise<WorkspaceDetail>;
    patch(id: string, body: PatchWorkspaceRequest, options?: CallOptions): Promise<Workspace>;
  };
  readonly invites: {
    create(workspaceId: string, body: InviteMemberRequest, options?: CallOptions): Promise<Invite>;
    accept(token: string, options?: CallOptions): Promise<AcceptedInvite>;
  };
  readonly members: {
    /** GET /v1/workspaces/:id/members — the workspace roster, cursor-paged. */
    list(
      workspaceId: string,
      query?: PaginationQueryInput,
      options?: CallOptions,
    ): Promise<Page<Member>>;
    /**
     * PATCH /v1/workspaces/:id/members/:memberId — change a member's role
     * (admin+; owner-target changes are owner-only; the last owner can't be
     * demoted — transfer ownership first).
     */
    changeRole(
      workspaceId: string,
      memberId: string,
      body: PatchMemberRoleRequest,
      options?: CallOptions,
    ): Promise<Member>;
    /**
     * DELETE /v1/workspaces/:id/members/:memberId — remove a member
     * (admin+; self-removal is allowed for any member except the last owner).
     */
    remove(workspaceId: string, memberId: string, options?: CallOptions): Promise<MemberRemoved>;
    /**
     * POST /v1/workspaces/:id/transfer-ownership — owner only; the previous
     * owner becomes admin. Idempotent-safe on retry after a partial failure.
     */
    transferOwnership(
      workspaceId: string,
      body: TransferOwnershipRequest,
      options?: CallOptions,
    ): Promise<OwnershipTransferred>;
    /** POST /v1/workspaces/:id/switch — set the caller's active workspace
     * (session-scoped; GET /v1/me reflects it via the active org's ledger). */
    switchWorkspace(workspaceId: string, options?: CallOptions): Promise<SwitchedWorkspace>;
  };
  readonly projects: {
    list(query?: ProjectsQueryInput, options?: CallOptions): Promise<Page<Project>>;
    create(body: CreateProjectRequest, options?: CallOptions): Promise<Project>;
    get(id: string, options?: CallOptions): Promise<Project>;
    patch(id: string, body: PatchProjectRequest, options?: CallOptions): Promise<Project>;
    /** Soft delete (§9.1 `deleted_at`); returns `null`. */
    delete(id: string, options?: CallOptions): Promise<null>;
    manifest(id: string, options?: CallOptions): Promise<ProjectManifest>;
    /**
     * POST /v1/projects/:id/duplicate (W1-c, §9.1) — copies the project and
     * its current version snapshot as "<name> (copy)". Idempotent via the
     * mutation key; respects the plan's maxProjects cap (429 QUOTA_EXCEEDED).
     */
    duplicate(id: string, options?: CallOptions): Promise<Project>;
  };
  readonly versions: {
    /** GET /v1/projects/:id/versions — the §M7.4 timeline (author name, agent-run presence, sha256 prefix). */
    list(
      projectId: string,
      query?: PaginationQueryInput,
      options?: CallOptions,
    ): Promise<Page<VersionTimelineEntry>>;
    /**
     * Immutable snapshot upload (§9.2/§9.3, W5-09): ONE multipart POST —
     * `descriptor` (JSON: sha256 + REQUIRED-but-nullable baseVersionId; a
     * stale base returns 409 PROJECT_VERSION_CONFLICT) + `file` (the bytes).
     * The gateway buffers the bytes once, hashes them server-side and
     * rejects a sha256 mismatch; `baseVersionId: null` is the ONLY valid
     * base for a project's FIRST snapshot. The idempotency key makes the
     * upload retryable without duplicating the version.
     */
    upload(
      projectId: string,
      input: {
        readonly baseVersionId: string | null;
        readonly sha256: string;
        readonly label?: string;
        readonly agentRunId?: string;
        readonly bytes: Blob | Uint8Array;
      },
      options?: CallOptions,
    ): Promise<ProjectVersion>;
    /**
     * POST /v1/projects/:id/versions/:versionId/restore — restores as a NEW
     * version (§9.3; history is never rewritten). Confirm-with-confirmation:
     * `body.confirmLabel` is REQUIRED — a bare restore is refused client-side
     * and server-side. The idempotency key makes an accidental double-POST a
     * replay instead of a second restore.
     */
    restore(
      projectId: string,
      versionId: string,
      body: RestoreVersionRequest,
      options?: CallOptions,
    ): Promise<ProjectVersion>;
    /**
     * POST /v1/projects/:id/versions/:versionId/label — labels are the ONLY
     * mutable field of a version row (§9.3 label metadata; D-24 candidate).
     */
    label(
      projectId: string,
      versionId: string,
      body: SetVersionLabelRequest,
      options?: CallOptions,
    ): Promise<ProjectVersion>;
    /**
     * GET /v1/projects/:id/versions/:versionId/diff — structural summary vs
     * the parent (size delta, authorship change, time gap); no deep content
     * diff in v1.
     */
    diff(projectId: string, versionId: string, options?: CallOptions): Promise<VersionDiffSummary>;
  };
  readonly leases: {
    /**
     * POST /v1/projects/:id/lease — acquire or renew (same body, §11).
     * Answers with the acquire outcome: `acquired: false` + `readOnly: true`
     * means another editor holds the lease (§9.3). Heartbeat = re-acquire
     * with the same `sessionId` while the tab is open.
     */
    acquire(
      projectId: string,
      body: AcquireLeaseRequest,
      options?: CallOptions,
    ): Promise<LeaseAcquireResponse>;
    /**
     * DELETE /v1/projects/:id/lease — release. When a queue exists, the
     * response carries the §M7 takeover election: the OLDEST queued
     * requester as `nextHolder` (their UI lets them acquire instantly).
     */
    release(projectId: string, options?: CallOptions): Promise<LeaseReleaseResponse>;
    /**
     * GET /v1/projects/:id/lease-state — the "Alex is editing" banner data
     * (§M7 task 3): active holder, pending queue, the caller's standing and
     * whether a `POST /lease` right now would win. Poll this for the banner.
     */
    leaseState(projectId: string, options?: CallOptions): Promise<LeaseStateResponse>;
    /**
     * POST /v1/projects/:id/lease-request — join the edit queue. Dedupes per
     * user (re-requests keep the original position); a full queue is a typed
     * QUOTA_EXCEEDED error (cap 20).
     */
    requestLease(projectId: string, options?: CallOptions): Promise<LeaseRequestResponse>;
    /** DELETE /v1/projects/:id/lease-request — leave the edit queue. */
    cancelLeaseRequest(
      projectId: string,
      options?: CallOptions,
    ): Promise<LeaseRequestCancelledResponse>;
  };
  readonly assets: {
    list(query?: PaginationQueryInput, options?: CallOptions): Promise<Page<Asset>>;
    /** POST /v1/assets — descriptor only; PUT the bytes to `upload.url`.
     * A dedupe hit returns `upload: null` + `duplicate: true` — nothing to
     * PUT, the workspace already holds these bytes. */
    createDescriptor(body: CreateAssetRequest, options?: CallOptions): Promise<CreateAssetResponse>;
    /**
     * POST /v1/assets/:id/complete (W1-c verify step) — called after the
     * PUT finishes: the gateway magic-byte-sniffs the object head and
     * back-fills image dimensions. Mismatches surface as 415
     * ASSET_TYPE_MISMATCH with the upload rejected.
     */
    complete(id: string, options?: CallOptions): Promise<VerifyAssetResponse>;
    /**
     * The full two-phase upload in one call (W1-c): descriptor → PUT the
     * bytes to the signed URL → verify (complete). A dedupe hit skips the
     * PUT and the verify call and returns the existing row with
     * `duplicate: true`.
     */
    upload(
      input: {
        readonly projectId?: string;
        readonly name: string;
        readonly mime: string;
        readonly bytes: Blob | Uint8Array;
        readonly width?: number;
        readonly height?: number;
        readonly durationTicks?: number;
      },
      options?: CallOptions,
    ): Promise<VerifyAssetResponse>;
    /** GET /v1/assets/:id/url — short-lived signed download URL. */
    getUrl(id: string, options?: CallOptions): Promise<SignedUrlResponse>;
  };
  readonly threads: {
    list(
      projectId: string,
      query?: PaginationQueryInput,
      options?: CallOptions,
    ): Promise<Page<Thread>>;
    create(projectId: string, body?: CreateThreadRequest, options?: CallOptions): Promise<Thread>;
    messages(
      threadId: string,
      query?: PaginationQueryInput,
      options?: CallOptions,
    ): Promise<Page<ThreadMessage>>;
  };
  readonly chat: {
    /** POST /v1/threads/:id/chat — AI SDK UI stream + §7.4 data parts. See ./sse.ts. */
    stream(
      threadId: string,
      body: ChatRequest,
      handlers?: ChatStreamHandlers & {
        readonly signal?: AbortSignal;
        readonly reconnect?: ChatStreamReconnectConfig;
      },
    ): ChatStreamController;
    /**
     * POST /v1/threads/:id/turn — ONE turn of the round-12 client-driven
     * loop (TURN WIRE CONTRACT): `Idempotency-Key: ${runId}:${stepIndex}`
     * rides the header, the response is a bounded SSE stream (run.started →
     * turn.started → message.delta/tool.started → turn.completed |
     * turn.failed). Transport drops re-POST the SAME key up to 3 attempts
     * then park with `TURN_PAUSED`; a retryable turn.failed retries once.
     * See ./sse.ts (`streamTurn`).
     */
    turn(
      threadId: string,
      body: unknown,
      handlers?: TurnStreamHandlers & {
        readonly signal?: AbortSignal;
        readonly reconnect?: TurnStreamReconnectConfig;
        /** The run's next local §7.4 seq (monotonic across turns; default 0). */
        readonly seqBase?: number;
        /** A paused attempt's `handle.lastServerSeq` (resume dedupe). */
        readonly replayCursor?: number;
      },
    ): TurnStreamHandle;
  };
  readonly runs: {
    get(runId: string, options?: CallOptions): Promise<RunRecord>;
    /** POST /v1/runs/:id/cancel; the response body is not part of the contracts. */
    cancel(runId: string, body?: CancelRunRequest, options?: CallOptions): Promise<null>;
    /** POST /v1/runs/:id/events — client tool result / apply result (§8.7). */
    postEvent(runId: string, body: RunEventRequest, options?: CallOptions): Promise<null>;
    /**
     * POST /v1/runs/:id/apply — record an applied plan (§8.7): commits the
     * plan credits (§8.8/D-20). Replays (same idempotency key, or the same
     * batch + version with a fresh key) return the original outcome.
     */
    applyRun(runId: string, body: ApplyRequest, options?: CallOptions): Promise<ApplyResponse>;
    /**
     * POST /v1/runs/:id/undo — undo an applied run as ONE step (§8.7);
     * free after a committed apply (no ledger mutation).
     */
    undoRun(runId: string, body: UndoRequest, options?: CallOptions): Promise<UndoResponse>;
    /**
     * POST /v1/runs/:id/plan (round-12 TURN WIRE CONTRACT) — the client-driven
     * loop's run-end fold: the browser merges the run's write-tool proposal
     * carriers into ONE EditPlan and POSTs it here; the server re-validates,
     * RE-COMPILES authoritatively, stamps the §7.3 auto-apply verdict and
     * stores `plan_json`. The default idempotency key is STABLE per run
     * (`plan:<runId>`) — a network retry replays the same decision, never
     * double work.
     */
    submitPlan(
      runId: string,
      body: { readonly plan: EditPlan } | { readonly end: true },
      options?: CallOptions,
    ): Promise<RunPlanResponse | { runId: string; ended: true }>;
    /**
     * POST /v1/runs/:id/abandon (round-12) — the client gives up mid-run
     * (stop / dispose): the run is marked abandoned + outstanding holds
     * refunded. Idempotent; the stable default key is `abandon:<runId>`.
     * Fire-and-forget at the call site — callers swallow failures.
     */
    abandon(runId: string, options?: CallOptions): Promise<null>;
  };
  readonly models: {
    /** GET /v1/models — workspace plan + the models selectable on it (§8.2). */
    list(options?: CallOptions): Promise<ModelsResponse>;
  };
  readonly credits: {
    get(options?: CallOptions): Promise<CreditsSummary>;
    ledger(query?: LedgerQueryInput, options?: CallOptions): Promise<Page<LedgerEntry>>;
    /**
     * POST /v1/credits/reconcile (W5-09) — the admin true-up over a bounded
     * window (≤ 92 days, ending ≤ now). REPORT-ONLY by default; a
     * `mode: "reconcile"` call appends ONE idempotent adjust entry when the
     * ledger and usage disagree. Ops surfaces only — no UI consumer yet.
     */
    reconcile(body: ReconcileRequest, options?: CallOptions): Promise<ReconcileReport>;
  };
  readonly billing: {
    /** POST /v1/billing/checkout — subscribe to a paid plan (D-4: trial is never a checkout target). */
    checkout(body: CheckoutRequest, options?: CallOptions): Promise<CheckoutResponse>;
    /** POST /v1/billing/topup — buy a credit pack (one-time payment). */
    topup(body: TopUpRequest, options?: CallOptions): Promise<TopUpResponse>;
    /** POST /v1/billing/portal — Stripe customer portal session. */
    portal(body?: PortalRequest, options?: CallOptions): Promise<PortalResponse>;
    /** GET /v1/billing/state — the ONE billing read the UI consumes (plan,
     * subscription status incl. grace/trialing, entitlements, credits). */
    state(options?: CallOptions): Promise<BillingState>;
    /** POST /v1/billing/trial — start the card-required 14-day trial. */
    startTrial(body?: TrialRequest, options?: CallOptions): Promise<TrialResponse>;
    /** GET /v1/billing/invoices — the workspace's recorded Stripe invoices
     * (F-J3), newest-first, cursor-paginated. `amountCents` is money in
     * Stripe minor units, never credits. */
    invoices(query?: PaginationQueryInput, options?: CallOptions): Promise<Page<InvoiceRecord>>;
  };
  readonly renders: {
    /**
     * POST /v1/renders — queue a render (§7.2 idempotent). Returns the job
     * with status `queued`, the server-resolved `versionId` snapshot and a
     * `progress` of 0 (framesTotal when the settings pin it down).
     */
    create(body: QueueRenderRequest, options?: CallOptions): Promise<RenderJob>;
    /**
     * GET /v1/renders — render history, cursor-paginated (§7.2), newest
     * first. Filter by `projectId` and/or `status`; pass `nextCursor` back
     * as `cursor` for the next page.
     */
    list(query?: RendersQueryInput, options?: CallOptions): Promise<Page<RenderJob>>;
    /** GET /v1/renders/:id — poll a job: progress, resultUrl once completed. */
    get(id: string, options?: CallOptions): Promise<RenderJob>;
    /**
     * POST /v1/renders/:id/cancel — request cancellation (idempotent via the
     * Idempotency-Key header; an optional `reason` rides the body). Returns
     * the job with `cancelRequested: true`; terminal jobs come back
     * unchanged (cancel is a no-op there).
     */
    cancel(id: string, body?: CancelRenderRequest, options?: CallOptions): Promise<RenderJob>;
    /**
     * POST /v1/renders/estimate — pre-flight quote for the render dialog:
     * credits, output seconds and the long-edge pixel size AFTER plan
     * clamping. `minApplied: true` means the platform minimum charge was
     * applied. A PURE READ per contracts: no idempotency key is sent unless
     * the caller passes one explicitly.
     */
    estimate(body: RenderEstimateRequest, options?: CallOptions): Promise<EstimateResult>;
  };
  readonly apiKeys: {
    /**
     * POST /v1/workspaces/:id/api-keys — mint a workspace API key
     * (owner/admin). The response carries the plaintext `key` EXACTLY ONCE
     * (§7.1: hashed at rest, revocable) — persist it immediately, there is
     * no way to read it back.
     */
    create(
      workspaceId: string,
      body: CreateApiKeyRequest,
      options?: CallOptions,
    ): Promise<CreatedApiKey>;
    /**
     * GET /v1/workspaces/:id/api-keys — the workspace's keys,
     * cursor-paginated, NEVER key material. `lastUsedAt` stays null until
     * the key first authenticates a Bearer request.
     */
    list(
      workspaceId: string,
      query?: PaginationQueryInput,
      options?: CallOptions,
    ): Promise<Page<ApiKey>>;
    /**
     * DELETE /v1/workspaces/:id/api-keys/:keyId — revoke (owner/admin).
     * Idempotent; a revoked key fails every later Bearer authentication with
     * 401.
     */
    revoke(workspaceId: string, keyId: string, options?: CallOptions): Promise<RevokedApiKey>;
  };
  readonly comments: {
    list(
      projectId: string,
      query?: CommentsQueryInput,
      options?: CallOptions,
    ): Promise<Page<Comment>>;
    /** GET /v1/projects/:id/comments — the flat threaded list (D-15: compId
     * filters server-side; rows carry parentCommentId for tree building). */
    listThreadedComments(
      projectId: string,
      query?: CommentsQueryInput,
      options?: CallOptions,
    ): Promise<Page<Comment>>;
    create(projectId: string, body: CreateCommentRequest, options?: CallOptions): Promise<Comment>;
    /** POST /v1/comments/:id/replies — reply; the server inherits the
     * parent's anchor and caps depth at 3. */
    replyComment(
      commentId: string,
      body: CommentReplyRequest,
      options?: CallOptions,
    ): Promise<Comment>;
    /** POST /v1/comments/:id/resolve — idempotent resolve; `resolved: false`
     * reopens the thread (empty body resolves). */
    resolveComment(
      commentId: string,
      body?: ResolveCommentRequestInput,
      options?: CallOptions,
    ): Promise<Comment>;
  };
  readonly activity: {
    list(
      projectId: string,
      query?: ActivityQueryInput,
      options?: CallOptions,
    ): Promise<Page<ActivityEntry>>;
    /**
     * GET /v1/projects/:id/audit-export — admin-only, bounded JSON export of
     * the raw audit rows (ids/emails are compliance DATA here, never UI copy).
     * Served as a Content-Disposition attachment; the client returns the
     * parsed payload so hosts can also save it as a file.
     */
    auditExport(projectId: string, options?: CallOptions): Promise<AuditExport>;
  };
  readonly audit: {
    /**
     * GET /v1/workspaces/:id/audit — the workspace-wide audit feed at the
     * VIEWER floor (any member; §12.1 renders strangers 404). Newest-first
     * cursor pagination + the server-side `targetType` filter; entries carry
     * the actor's display name — never metadata, ip or email (law #1).
     */
    list(
      workspaceId: string,
      query?: AuditQueryInput,
      options?: CallOptions,
    ): Promise<Page<AuditEntry>>;
  };
  readonly presence: {
    /**
     * POST /v1/projects/:id/presence — upsert my heartbeat and get the
     * active viewers in ONE round-trip (the heartbeat IS the poll; no SSE
     * in v1). Cadence for the editor SPA (see gateway routes/presence.ts
     * for the full recipe): beat every LEASE_HEARTBEAT_MS (120s) while the
     * tab is visible, pause while hidden, beat immediately on visible.
     * No cursor/mouse data — the body is strict-schema'd server-side.
     */
    beatPresence(
      projectId: string,
      body?: PresenceBeatRequest,
      options?: CallOptions,
    ): Promise<PresenceViewersResponse>;
    /**
     * GET /v1/projects/:id/presence — the active viewers list (no write:
     * does NOT refresh your own heartbeat; for read-only surfaces or a
     * hidden tab that still wants to render the list).
     */
    listPresence(projectId: string, options?: CallOptions): Promise<PresenceViewersResponse>;
  };
  readonly share: {
    /**
     * PUBLIC — GET /v1/share/:token. Share metadata for the /s/:token page
     * (project name, expiry, hasPassword) — never project content. No
     * session needed: the token IS the capability.
     */
    getInfo(token: string, options?: ShareCallOptions): Promise<ShareInfo>;
    /**
     * PUBLIC — GET /v1/share/:token/manifest. The web player's read surface
     * (signed URLs, no internal ids). Pass `password` for protected tokens.
     */
    getManifest(token: string, options?: ShareCallOptions): Promise<ShareManifest>;
    /** PUBLIC — GET /v1/share/:token/comments (D-15: compId filters server-side). */
    listComments(
      token: string,
      query?: ShareCommentsQueryInput,
      options?: ShareCallOptions,
    ): Promise<Page<ShareComment>>;
    /**
     * PUBLIC — POST /v1/share/:token/comments. Guest comment (name + email
     * + anchor + body); per-IP rate-limited server-side (429 RATE_LIMITED).
     */
    createComment(
      token: string,
      body: CreateShareCommentRequest,
      options?: ShareCallOptions,
    ): Promise<ShareComment>;
    /** PUBLIC — POST /v1/share/:token/request-access. Typed ok; the
     * workspace sees the request in its activity feed (v1 notification). */
    requestAccess(
      token: string,
      body: RequestAccessRequest,
      options?: ShareCallOptions,
    ): Promise<RequestAccessResponse>;
    /**
     * AUTHED — POST /v1/projects/:id/share-links (editor role). Mints a
     * token and returns it ONCE: persist the /s/:token URL immediately —
     * it can never be re-fetched (only sha256(token) is stored).
     */
    issueLink(
      projectId: string,
      body?: IssueShareLinkRequest,
      options?: CallOptions,
    ): Promise<ShareLinkIssued>;
    /** AUTHED — GET /v1/projects/:id/share-links. Active links, NO token material. */
    listLinks(projectId: string, options?: CallOptions): Promise<Page<ShareLinkView>>;
    /** AUTHED — DELETE /v1/share/:id. Revoke (creator or admin); idempotent. */
    revokeLink(id: string, options?: CallOptions): Promise<ShareLinkRevoked>;
  };
}

/**
 * Builds the typed API client. `baseUrl` includes the version segment
 * (default `"/v1"` for same-origin browser use). All mutation methods send
 * `Idempotency-Key` (§7.2) — pass your own per logical operation, or let the
 * client derive one.
 */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const core: ClientInternals = {
    baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    fetchImpl: options.fetch ?? ((input, init) => fetch(input, init)),
    extraHeaders: { ...(options.headers ?? {}) },
    newKey: options.idempotencyKey ?? (() => crypto.randomUUID()),
    sleep: options.sleep ?? defaultSleep,
    retryDelays: options.retry?.delaysMs ?? RETRY_DELAYS_MS,
  };
  const impl = new ApiClientImpl(core);

  const mutationKey = (options: CallOptions | undefined): string | undefined => {
    const explicit = options?.idempotencyKey;
    if (explicit !== undefined) {
      // §7.2: client-generated, ≥8 chars (contracts IDEMPOTENCY_KEY_SCHEMA).
      return impl.validateBody(IDEMPOTENCY_KEY_SCHEMA, explicit, "Idempotency-Key");
    }
    return undefined;
  };

  const queryOf = (
    schema: z.ZodType<unknown>,
    query: unknown,
  ): Record<string, string | number | boolean | undefined> => {
    const parsed = impl.validateBody(schema, query ?? {}, "list query");
    const out: Record<string, string | number | boolean | undefined> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      out[k] = v as string | number | boolean | undefined;
    }
    return out;
  };
  const paginated = (query: unknown): Record<string, string | number | boolean | undefined> =>
    queryOf(PAGINATION_QUERY_SCHEMA, query);

  // Share password → x-share-password header (never the query string, so
  // logs/referrers never capture it). Undefined for open tokens.
  const passwordHeaders = (options?: ShareCallOptions): Record<string, string> | undefined =>
    options?.password === undefined ? undefined : { [SHARE_PASSWORD_HEADER]: options.password };

  const client: ApiClient = {
    // Every namespace method is `async` so client-side validation failures
    // (query schemas, explicit idempotency keys, bodies) surface as rejections
    // of the returned promise instead of synchronous throws — callers await.
    // `chat.stream` is the one synchronous member: it returns the live
    // controller immediately and throws client-side for an invalid body.
    me: {
      get: async (options) => impl.get("/me", undefined, ME_RESPONSE_SCHEMA, options?.signal),
    },
    settings: {
      get: async (options) =>
        impl.get("/me/settings", undefined, SETTINGS_RESPONSE_SCHEMA, options?.signal),
      update: async (body, options) =>
        impl.mutate("PATCH", "/me/settings", {
          body,
          bodySchema: SETTINGS_PATCH_SCHEMA,
          responseSchema: SETTINGS_RESPONSE_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
    },
    workspaces: {
      list: async (query, options) =>
        impl.get("/workspaces", paginated(query), PAGE_WORKSPACES_SCHEMA, options?.signal),
      create: async (body, options) =>
        impl.mutate("POST", "/workspaces", {
          body,
          bodySchema: CREATE_WORKSPACE_SCHEMA,
          responseSchema: WORKSPACE_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
      get: async (id, options) =>
        impl.get(
          `/workspaces/${encodeId(id)}`,
          undefined,
          WORKSPACE_DETAIL_SCHEMA,
          options?.signal,
        ),
      patch: async (id, body, options) =>
        impl.mutate("PATCH", `/workspaces/${encodeId(id)}`, {
          body,
          bodySchema: PATCH_WORKSPACE_SCHEMA,
          responseSchema: WORKSPACE_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
    },
    invites: {
      create: async (workspaceId, body, options) =>
        impl.mutate("POST", `/workspaces/${encodeId(workspaceId)}/invites`, {
          body,
          bodySchema: INVITE_MEMBER_SCHEMA,
          responseSchema: INVITE_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
      accept: async (token, options) =>
        impl.mutate("POST", `/invites/${encodeId(token)}/accept`, {
          responseSchema: ACCEPTED_INVITE_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
    },
    members: {
      list: async (workspaceId, query, options) =>
        impl.get(
          `/workspaces/${encodeId(workspaceId)}/members`,
          paginated(query),
          PAGE_MEMBERS_SCHEMA,
          options?.signal,
        ),
      changeRole: async (workspaceId, memberId, body, options) =>
        impl.mutate("PATCH", `/workspaces/${encodeId(workspaceId)}/members/${encodeId(memberId)}`, {
          body,
          bodySchema: PATCH_MEMBER_ROLE_SCHEMA,
          responseSchema: MEMBER_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
      remove: async (workspaceId, memberId, options) =>
        impl.mutate(
          "DELETE",
          `/workspaces/${encodeId(workspaceId)}/members/${encodeId(memberId)}`,
          {
            responseSchema: MEMBER_REMOVED_SCHEMA,
            idempotencyKey: mutationKey(options) ?? impl.autoKey(),
            signal: options?.signal,
          },
        ),
      transferOwnership: async (workspaceId, body, options) =>
        impl.mutate("POST", `/workspaces/${encodeId(workspaceId)}/transfer-ownership`, {
          body,
          bodySchema: TRANSFER_OWNERSHIP_SCHEMA,
          responseSchema: OWNERSHIP_TRANSFERRED_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
      switchWorkspace: async (workspaceId, options) =>
        impl.mutate("POST", `/workspaces/${encodeId(workspaceId)}/switch`, {
          responseSchema: SWITCHED_WORKSPACE_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
    },
    projects: {
      // W2-B3: the W1-c §9.1 `archived` filter must reach the wire — route
      // through PROJECTS_QUERY_SCHEMA (cursor/limit/archived), NOT the bare
      // paginated() helper, which strips it (the /w/projects workaround seam).
      list: async (query, options) =>
        impl.get(
          "/projects",
          queryOf(PROJECTS_QUERY_SCHEMA, query),
          PAGE_PROJECTS_SCHEMA,
          options?.signal,
        ),
      create: async (body, options) =>
        impl.mutate("POST", "/projects", {
          body,
          bodySchema: CREATE_PROJECT_SCHEMA,
          responseSchema: PROJECT_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
      get: async (id, options) =>
        impl.get(`/projects/${encodeId(id)}`, undefined, PROJECT_SCHEMA, options?.signal),
      patch: async (id, body, options) =>
        impl.mutate("PATCH", `/projects/${encodeId(id)}`, {
          body,
          bodySchema: PATCH_PROJECT_SCHEMA,
          responseSchema: PROJECT_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
      delete: async (id, options) =>
        impl.mutate("DELETE", `/projects/${encodeId(id)}`, {
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
      manifest: async (id, options) =>
        impl.get(
          `/projects/${encodeId(id)}/manifest`,
          undefined,
          PROJECT_MANIFEST_SCHEMA,
          options?.signal,
        ),
      duplicate: async (id, options) =>
        impl.mutate("POST", `/projects/${encodeId(id)}/duplicate`, {
          body: {},
          responseSchema: PROJECT_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
    },
    versions: {
      list: async (projectId, query, options) =>
        impl.get(
          `/projects/${encodeId(projectId)}/versions`,
          paginated(query),
          PAGE_VERSION_TIMELINE_SCHEMA,
          options?.signal,
        ),
      upload: async (projectId, input, options) => uploadVersion(impl, projectId, input, options),
      restore: async (projectId, versionId, body, options) =>
        impl.mutate(
          "POST",
          `/projects/${encodeId(projectId)}/versions/${encodeId(versionId)}/restore`,
          {
            body,
            bodySchema: RESTORE_VERSION_SCHEMA,
            responseSchema: PROJECT_VERSION_SCHEMA,
            idempotencyKey: mutationKey(options) ?? impl.autoKey(),
            signal: options?.signal,
          },
        ),
      label: async (projectId, versionId, body, options) =>
        impl.mutate(
          "POST",
          `/projects/${encodeId(projectId)}/versions/${encodeId(versionId)}/label`,
          {
            body,
            bodySchema: SET_VERSION_LABEL_SCHEMA,
            responseSchema: PROJECT_VERSION_SCHEMA,
            idempotencyKey: mutationKey(options) ?? impl.autoKey(),
            signal: options?.signal,
          },
        ),
      diff: async (projectId, versionId, options) =>
        impl.get(
          `/projects/${encodeId(projectId)}/versions/${encodeId(versionId)}/diff`,
          undefined,
          VERSION_DIFF_SUMMARY_SCHEMA,
          options?.signal,
        ),
    },
    leases: {
      acquire: async (projectId, body, options) =>
        impl.mutate("POST", `/projects/${encodeId(projectId)}/lease`, {
          body,
          bodySchema: ACQUIRE_LEASE_SCHEMA,
          responseSchema: LEASE_ACQUIRE_RESPONSE_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
      release: async (projectId, options) =>
        impl.mutate("DELETE", `/projects/${encodeId(projectId)}/lease`, {
          responseSchema: LEASE_RELEASE_RESPONSE_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
      leaseState: async (projectId, options) =>
        impl.get(
          `/projects/${encodeId(projectId)}/lease-state`,
          undefined,
          LEASE_STATE_RESPONSE_SCHEMA,
          options?.signal,
        ),
      requestLease: async (projectId, options) =>
        impl.mutate("POST", `/projects/${encodeId(projectId)}/lease-request`, {
          responseSchema: LEASE_REQUEST_RESPONSE_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
      cancelLeaseRequest: async (projectId, options) =>
        impl.mutate("DELETE", `/projects/${encodeId(projectId)}/lease-request`, {
          responseSchema: LEASE_REQUEST_CANCELLED_RESPONSE_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
    },
    assets: {
      list: async (query, options) =>
        impl.get("/assets", paginated(query), PAGE_ASSETS_SCHEMA, options?.signal),
      createDescriptor: async (body, options) =>
        impl.mutate("POST", "/assets", {
          body,
          bodySchema: CREATE_ASSET_SCHEMA,
          responseSchema: CREATE_ASSET_RESPONSE_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
      getUrl: async (id, options) =>
        impl.get(
          `/assets/${encodeId(id)}/url`,
          undefined,
          SIGNED_URL_RESPONSE_SCHEMA,
          options?.signal,
        ),
      complete: async (id, options) =>
        impl.mutate("POST", `/assets/${encodeId(id)}/complete`, {
          body: {},
          responseSchema: VERIFY_ASSET_RESPONSE_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
      upload: async (input, options) => {
        const descriptor = await impl.mutate("POST", "/assets", {
          body: {
            projectId: input.projectId,
            name: input.name,
            mime: input.mime,
            sizeBytes: input.bytes instanceof Blob ? input.bytes.size : input.bytes.byteLength,
            width: input.width,
            height: input.height,
            durationTicks: input.durationTicks,
          },
          responseSchema: CREATE_ASSET_RESPONSE_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        });
        if (descriptor.duplicate === true && descriptor.upload === null) {
          return { asset: descriptor.asset, duplicate: true };
        }
        if (descriptor.upload === null) {
          throw new ApiError({
            code: "ASSET_UPLOAD_TARGET_MISSING",
            message: "The upload target is missing.",
            status: 0,
            hint: "Retry the upload from the descriptor step.",
            retryable: true,
          });
        }
        const { url, headers } = descriptor.upload;
        const put = await core.fetchImpl(url, {
          method: "PUT",
          headers: { ...headers },
          // TS 5.7 DOM BodyInit quirk — same as uploadVersion bytes.
          body: input.bytes instanceof Blob ? input.bytes : (input.bytes as unknown as BodyInit),
          signal: options?.signal,
        });
        if (!put.ok) {
          throw uploadFailedError(put.status);
        }
        return impl.mutate("POST", `/assets/${encodeId(descriptor.asset.id)}/complete`, {
          body: {},
          responseSchema: VERIFY_ASSET_RESPONSE_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        });
      },
    },
    threads: {
      list: async (projectId, query, options) =>
        impl.get(
          `/projects/${encodeId(projectId)}/threads`,
          paginated(query),
          PAGE_THREADS_SCHEMA,
          options?.signal,
        ),
      create: async (projectId, body, options) =>
        impl.mutate("POST", `/projects/${encodeId(projectId)}/threads`, {
          body: body ?? {},
          bodySchema: CREATE_THREAD_SCHEMA,
          responseSchema: THREAD_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
      messages: async (threadId, query, options) =>
        impl.get(
          `/threads/${encodeId(threadId)}/messages`,
          paginated(query),
          PAGE_MESSAGES_SCHEMA,
          options?.signal,
        ),
    },
    chat: {
      stream: (threadId, body, handlers) =>
        streamChat({
          threadId,
          body,
          baseUrl: core.baseUrl,
          fetchImpl: core.fetchImpl,
          sleep: core.sleep,
          extraHeaders: core.extraHeaders,
          idempotencyKeyFactory: core.newKey,
          signal: handlers?.signal,
          reconnect: handlers?.reconnect,
          onEvent: handlers?.onEvent,
          onError: handlers?.onError,
          onReconnect: handlers?.onReconnect,
          onPause: handlers?.onPause,
          onDone: handlers?.onDone,
        }),
      turn: (threadId, body, handlers) =>
        streamTurn({
          threadId,
          body,
          baseUrl: core.baseUrl,
          fetchImpl: core.fetchImpl,
          extraHeaders: core.extraHeaders,
          signal: handlers?.signal,
          reconnect: {
            ...(handlers?.reconnect ?? {}),
            sleep: handlers?.reconnect?.sleep ?? core.sleep,
          },
          seqBase: handlers?.seqBase,
          replayCursor: handlers?.replayCursor,
          onEvent: handlers?.onEvent,
          onError: handlers?.onError,
          onReconnect: handlers?.onReconnect,
          onDone: handlers?.onDone,
        }),
    },
    runs: {
      get: async (runId, options) =>
        impl.get(`/runs/${encodeId(runId)}`, undefined, RUN_RECORD_SCHEMA, options?.signal),
      cancel: async (runId, body, options) =>
        impl.mutate("POST", `/runs/${encodeId(runId)}/cancel`, {
          body: body ?? {},
          bodySchema: CANCEL_RUN_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
      postEvent: async (runId, body, options) =>
        impl.mutate("POST", `/runs/${encodeId(runId)}/events`, {
          body,
          bodySchema: RUN_EVENT_REQUEST_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
      applyRun: async (runId, body, options) =>
        impl.mutate("POST", `/runs/${encodeId(runId)}/apply`, {
          body,
          bodySchema: APPLY_REQUEST_SCHEMA,
          responseSchema: APPLY_RESPONSE_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
      undoRun: async (runId, body, options) =>
        impl.mutate("POST", `/runs/${encodeId(runId)}/undo`, {
          body,
          bodySchema: UNDO_REQUEST_SCHEMA,
          responseSchema: UNDO_RESPONSE_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
      submitPlan: async (runId, body, options) =>
        impl.rawJsonPost({
          path: `/runs/${encodeId(runId)}/plan`,
          body,
          responseSchema: RUN_PLAN_RESPONSE_SCHEMA,
          // STABLE per run: a network retry replays the stored decision — the
          // server's re-compile + verdict happen exactly once per run.
          idempotencyKey: options?.idempotencyKey ?? `plan:${runId}`,
          signal: options?.signal,
        }),
      abandon: async (runId, options) => {
        // The route's shape is `{runId, status}` — not a contracts surface; the
        // payload is irrelevant to the caller. Errors propagate; the call site
        // owns the fire-and-forget posture.
        await impl.rawJsonPost<null>({
          path: `/runs/${encodeId(runId)}/abandon`,
          body: {},
          idempotencyKey: options?.idempotencyKey ?? `abandon:${runId}`,
          signal: options?.signal,
        });
        return null;
      },
    },
    models: {
      list: async (options) =>
        impl.get("/models", undefined, MODELS_RESPONSE_SCHEMA, options?.signal),
    },
    credits: {
      get: async (options) =>
        impl.get("/credits", undefined, CREDITS_SUMMARY_SCHEMA, options?.signal),
      ledger: async (query, options) =>
        impl.get(
          "/credits/ledger",
          queryOf(LEDGER_QUERY_SCHEMA, query),
          PAGE_LEDGER_SCHEMA,
          options?.signal,
        ),
      reconcile: async (body, options) =>
        impl.mutate("POST", "/credits/reconcile", {
          body,
          bodySchema: RECONCILE_REQUEST_SCHEMA,
          responseSchema: RECONCILE_REPORT_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
    },
    billing: {
      checkout: async (body, options) =>
        impl.mutate("POST", "/billing/checkout", {
          body,
          bodySchema: CHECKOUT_SCHEMA,
          responseSchema: CHECKOUT_RESPONSE_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
      topup: async (body, options) =>
        impl.mutate("POST", "/billing/topup", {
          body,
          bodySchema: TOPUP_SCHEMA,
          responseSchema: CHECKOUT_RESPONSE_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
      portal: async (body, options) =>
        impl.mutate("POST", "/billing/portal", {
          body: body ?? {},
          bodySchema: PORTAL_SCHEMA,
          responseSchema: PORTAL_RESPONSE_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
      state: async (options) =>
        impl.get("/billing/state", undefined, BILLING_STATE_SCHEMA, options?.signal),
      startTrial: async (body, options) =>
        impl.mutate("POST", "/billing/trial", {
          body: body ?? {},
          bodySchema: TRIAL_REQUEST_SCHEMA,
          responseSchema: TRIAL_RESPONSE_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
      invoices: async (query, options) =>
        impl.get(
          "/billing/invoices",
          queryOf(INVOICES_QUERY_SCHEMA, query),
          PAGE_INVOICES_SCHEMA,
          options?.signal,
        ),
    },
    renders: {
      create: async (body, options) =>
        impl.mutate("POST", "/renders", {
          body,
          bodySchema: QUEUE_RENDER_SCHEMA,
          responseSchema: RENDER_JOB_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
      list: async (query, options) =>
        impl.get(
          "/renders",
          queryOf(RENDERS_QUERY_SCHEMA, query),
          PAGE_RENDERS_SCHEMA,
          options?.signal,
        ),
      get: async (id, options) =>
        impl.get(`/renders/${encodeId(id)}`, undefined, RENDER_JOB_SCHEMA, options?.signal),
      cancel: async (id, body, options) =>
        impl.mutate("POST", `/renders/${encodeId(id)}/cancel`, {
          body: body ?? {},
          bodySchema: CANCEL_RENDER_SCHEMA,
          responseSchema: RENDER_JOB_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
      estimate: async (body, options) =>
        // A PURE READ (contracts: no idempotency key anywhere — the gateway
        // exempts the route from the §7.2 header gate), so no auto key:
        // an explicit caller key is honored, an absent one means no header.
        impl.request<EstimateResult>({
          method: "POST",
          path: "/renders/estimate",
          body: impl.validateBody(RENDER_ESTIMATE_REQUEST_SCHEMA, body, "/renders/estimate"),
          responseSchema: ESTIMATE_RESULT_SCHEMA,
          idempotencyKey: mutationKey(options),
          signal: options?.signal,
        }),
    },
    apiKeys: {
      // W1-b (§7.1 scoped, hashed, revocable): mint/list/revoke workspace
      // API keys. `key` exists ONLY on the create response (show-once);
      // list/revoke shapes never carry key material.
      create: async (workspaceId, body, options) =>
        impl.mutate("POST", `/workspaces/${encodeId(workspaceId)}/api-keys`, {
          body,
          bodySchema: CREATE_API_KEY_SCHEMA,
          responseSchema: CREATED_API_KEY_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
      list: async (workspaceId, query, options) =>
        impl.get(
          `/workspaces/${encodeId(workspaceId)}/api-keys`,
          paginated(query),
          PAGE_API_KEYS_SCHEMA,
          options?.signal,
        ),
      revoke: async (workspaceId, keyId, options) =>
        impl.mutate("DELETE", `/workspaces/${encodeId(workspaceId)}/api-keys/${encodeId(keyId)}`, {
          responseSchema: REVOKED_API_KEY_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
    },
    comments: {
      list: async (projectId, query, options) =>
        impl.get(
          `/projects/${encodeId(projectId)}/comments`,
          queryOf(COMMENTS_QUERY_SCHEMA, query),
          PAGE_COMMENTS_SCHEMA,
          options?.signal,
        ),
      listThreadedComments: async (projectId, query, options) =>
        impl.get(
          `/projects/${encodeId(projectId)}/comments`,
          queryOf(COMMENTS_QUERY_SCHEMA, query),
          PAGE_COMMENTS_SCHEMA,
          options?.signal,
        ),
      create: async (projectId, body, options) =>
        impl.mutate("POST", `/projects/${encodeId(projectId)}/comments`, {
          body,
          bodySchema: CREATE_COMMENT_SCHEMA,
          responseSchema: COMMENT_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
      replyComment: async (commentId, body, options) =>
        impl.mutate("POST", `/comments/${encodeId(commentId)}/replies`, {
          body,
          bodySchema: COMMENT_REPLY_SCHEMA,
          responseSchema: COMMENT_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
      resolveComment: async (commentId, body, options) =>
        impl.mutate("POST", `/comments/${encodeId(commentId)}/resolve`, {
          body: body ?? {},
          bodySchema: RESOLVE_COMMENT_SCHEMA,
          responseSchema: COMMENT_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
    },
    activity: {
      list: async (projectId, query, options) =>
        impl.get(
          `/projects/${encodeId(projectId)}/activity`,
          queryOf(ACTIVITY_QUERY_SCHEMA, query),
          PAGE_ACTIVITY_SCHEMA,
          options?.signal,
        ),
      auditExport: async (projectId, options) =>
        impl.get(
          `/projects/${encodeId(projectId)}/audit-export`,
          undefined,
          AUDIT_EXPORT_SCHEMA,
          options?.signal,
        ),
    },
    audit: {
      list: async (workspaceId, query, options) =>
        impl.get(
          `/workspaces/${encodeId(workspaceId)}/audit`,
          queryOf(AUDIT_QUERY_SCHEMA, query),
          PAGE_AUDIT_SCHEMA,
          options?.signal,
        ),
    },
    presence: {
      // Response validation reuses the contracts Zod schemas directly —
      // presence response SHAPES are pinned there (PRESENCE_VIEWERS_SCHEMA),
      // so there is nothing to mirror in ./response-schemas.ts.
      beatPresence: async (projectId, body, options) =>
        impl.mutate("POST", `/projects/${encodeId(projectId)}/presence`, {
          body: body ?? {},
          bodySchema: PRESENCE_BEAT_SCHEMA,
          responseSchema: PRESENCE_VIEWERS_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
      listPresence: async (projectId, options) =>
        impl.get(
          `/projects/${encodeId(projectId)}/presence`,
          undefined,
          PRESENCE_VIEWERS_SCHEMA,
          options?.signal,
        ),
    },
    share: {
      getInfo: async (token, options) =>
        impl.get(
          `/share/${encodeId(token)}`,
          undefined,
          SHARE_INFO_SCHEMA,
          options?.signal,
          passwordHeaders(options),
        ),
      getManifest: async (token, options) =>
        impl.get(
          `/share/${encodeId(token)}/manifest`,
          undefined,
          SHARE_MANIFEST_SCHEMA,
          options?.signal,
          passwordHeaders(options),
        ),
      listComments: async (token, query, options) =>
        impl.get(
          `/share/${encodeId(token)}/comments`,
          queryOf(SHARE_COMMENTS_QUERY_SCHEMA, query),
          PAGE_SHARE_COMMENTS_SCHEMA,
          options?.signal,
          passwordHeaders(options),
        ),
      createComment: async (token, body, options) =>
        impl.mutate("POST", `/share/${encodeId(token)}/comments`, {
          body,
          bodySchema: CREATE_SHARE_COMMENT_SCHEMA,
          responseSchema: SHARE_COMMENT_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
          headers: passwordHeaders(options),
        }),
      requestAccess: async (token, body, options) =>
        impl.mutate("POST", `/share/${encodeId(token)}/request-access`, {
          body,
          bodySchema: REQUEST_ACCESS_SCHEMA,
          responseSchema: REQUEST_ACCESS_RESPONSE_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
          headers: passwordHeaders(options),
        }),
      issueLink: async (projectId, body, options) =>
        impl.mutate("POST", `/projects/${encodeId(projectId)}/share-links`, {
          body: body ?? {},
          bodySchema: ISSUE_SHARE_LINK_SCHEMA,
          responseSchema: SHARE_LINK_ISSUED_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
      listLinks: async (projectId, options) =>
        impl.get(
          `/projects/${encodeId(projectId)}/share-links`,
          undefined,
          PAGE_SHARE_LINKS_SCHEMA,
          options?.signal,
        ),
      revokeLink: async (id, options) =>
        impl.mutate("DELETE", `/share/${encodeId(id)}`, {
          responseSchema: SHARE_LINK_REVOKED_SCHEMA,
          idempotencyKey: mutationKey(options) ?? impl.autoKey(),
          signal: options?.signal,
        }),
    },
  };
  return Object.freeze(client);
}

/**
 * Version snapshot upload (§9.2/§9.3, W5-09): ONE multipart POST —
 * `descriptor` (the UPLOAD_VERSION_SCHEMA JSON, with the REQUIRED-but-nullable
 * `baseVersionId`; null = the project's FIRST snapshot) + `file` (the bytes).
 * The gateway buffers the bytes once, hashes them server-side, rejects a
 * sha256 mismatch and answers `Ok<ProjectVersion>` (the row, not a signed-URL
 * handshake — bytes always ride the POST itself).
 */
async function uploadVersion(
  impl: ApiClientImpl,
  projectId: string,
  input: {
    readonly baseVersionId: string | null;
    readonly sha256: string;
    readonly label?: string;
    readonly agentRunId?: string;
    readonly bytes: Blob | Uint8Array;
  },
  options: CallOptions | undefined,
): Promise<ProjectVersion> {
  const { bytes } = input;
  if (!(bytes instanceof Blob) && !(bytes instanceof Uint8Array)) {
    throw invalidRequestError(new Error("bytes must be a Blob or Uint8Array"));
  }
  const sizeBytes = bytes instanceof Blob ? bytes.size : bytes.byteLength;
  const descriptor = impl.validateBody(
    UPLOAD_VERSION_SCHEMA,
    {
      baseVersionId: input.baseVersionId,
      sha256: input.sha256,
      label: input.label,
      agentRunId: input.agentRunId,
      sizeBytes,
    },
    "upload version descriptor",
  );

  // The gateway parses the `descriptor` part as JSON and the `file` part as
  // the bytes (routes/versions.ts multipart branch) — same protocol its own
  // suite pins (projects-versions.test.ts uploadMultipart).
  const form = new FormData();
  form.append("descriptor", JSON.stringify(descriptor));
  form.append(
    "file",
    bytes instanceof Blob
      ? bytes
      : // TS 5.7's BlobPart doesn't accept Uint8Array<ArrayBufferLike>
        // (SharedArrayBuffer edge); runtime fetch (browser + undici) does.
        new Blob([bytes as unknown as BlobPart], { type: "application/octet-stream" }),
  );

  return impl.request<ProjectVersion>({
    method: "POST",
    path: `/projects/${encodeId(projectId)}/versions`,
    // rawBody: no Content-Type header — fetch derives the multipart boundary.
    rawBody: form,
    responseSchema: PROJECT_VERSION_SCHEMA,
    idempotencyKey: options?.idempotencyKey ?? impl.autoKey(),
    signal: options?.signal,
  });
}
