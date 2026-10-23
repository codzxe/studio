"use client";

/**
 * The project-hub API seam (W2-05, UI_DESIGN_SYSTEM §8.6): ONE narrow port the
 * real `@studio/api-client` satisfies structurally, shared by the Overview tab
 * (`hub-overview.tsx`) and the right rail (`hub-right-rail.tsx`) — the exact
 * HistoryPort/RendersHubPort doctrine: production builds it from
 * `createApiClient` (same-origin `/v1` + `x-workspace-id`); tests fake it.
 *
 * The share-links surface keeps its OWN port (`ShareLinksPort`) so the
 * share card composes standalone.
 *
 * Boundary law (apps/web): `@studio/contracts` is `import type` ONLY.
 */

import { createApiClient, isApiError } from "@studio/api-client";
import type { ApiClient } from "@studio/api-client";
import type {
  Asset,
  IssueShareLinkRequest,
  LeaseRequestCancelledResponse,
  LeaseRequestResponse,
  LeaseStateResponse,
  Member,
  Page,
  ProjectManifest,
  ShareLinkIssued,
  ShareLinkRevoked,
  ShareLinkView,
  VersionTimelineEntry,
} from "@studio/contracts";

/** Same-origin API root (Caddy fronts `/v1` in production — README §Env). */
export const HUB_API_BASE_URL = "/v1";

/**
 * The hub's `@studio/api-client` surface. Members/assets reads are the
 * workspace roster + the workspace asset LIBRARY (the wire carries no
 * project-scoped asset count through the typed client — `assets.list` takes
 * pagination only; the copy says "library" so the number never lies).
 */
export interface HubPort {
  /** GET /v1/workspaces/:id/members — the roster (owner-name resolution). */
  readonly listMembers: (query?: { readonly limit?: number }) => Promise<Page<Member>>;
  /** GET /v1/projects/:id/versions — page 1 carries the current version row. */
  readonly listVersions: (query: { readonly limit?: number }) => Promise<
    Page<VersionTimelineEntry>
  >;
  /** GET /v1/assets — the workspace library page 1 (the count surface). */
  readonly listAssets: (query?: { readonly limit?: number }) => Promise<Page<Asset>>;
  /** GET /v1/projects/:id/manifest — updatedAt (+ the honest comps gap). */
  readonly getManifest: () => Promise<ProjectManifest>;
  /** GET /v1/projects/:id/lease-state — the §M7 "X is editing" banner data. */
  readonly leaseState: () => Promise<LeaseStateResponse>;
  /** POST /v1/projects/:id/lease-request — join the edit queue (dedupes). */
  readonly requestLease: () => Promise<LeaseRequestResponse>;
  /** DELETE /v1/projects/:id/lease-request — leave the edit queue. */
  readonly cancelLeaseRequest: () => Promise<LeaseRequestCancelledResponse>;
}

/** Builds the production hub port for one project hub load. */
export function createHubPort(workspaceId: string, projectId: string): HubPort {
  const client: ApiClient = createApiClient({
    baseUrl: HUB_API_BASE_URL,
    headers: { "x-workspace-id": workspaceId },
  });
  return {
    listMembers: (query) => client.members.list(workspaceId, query),
    listVersions: (query) => client.versions.list(projectId, query),
    listAssets: (query) => client.assets.list(query),
    getManifest: () => client.projects.manifest(projectId),
    leaseState: () => client.leases.leaseState(projectId),
    requestLease: () => client.leases.requestLease(projectId),
    cancelLeaseRequest: () => client.leases.cancelLeaseRequest(projectId),
  };
}

/**
 * The member share-link surface (contracts routes/share.ts): issue shows the
 * raw token EXACTLY ONCE; the list carries NO token material.
 */
export interface ShareLinksPort {
  /** POST /v1/projects/:id/share-links — mint (the only place a token appears). */
  readonly issueLink: (body?: IssueShareLinkRequest) => Promise<ShareLinkIssued>;
  /** GET /v1/projects/:id/share-links — active links, no secrets. */
  readonly listLinks: () => Promise<Page<ShareLinkView>>;
  /** DELETE /v1/share/:id — idempotent revoke (creator or admin upstream). */
  readonly revokeLink: (id: string) => Promise<ShareLinkRevoked>;
}

/** Builds the production share-links port for one project hub load. */
export function createShareLinksPort(workspaceId: string, projectId: string): ShareLinksPort {
  const client: ApiClient = createApiClient({
    baseUrl: HUB_API_BASE_URL,
    headers: { "x-workspace-id": workspaceId },
  });
  return {
    issueLink: (body) => client.share.issueLink(projectId, body),
    listLinks: () => client.share.listLinks(projectId),
    revokeLink: (id) => client.share.revokeLink(id),
  };
}

// ---------------------------------------------------------------------------
// Typed failure mapping (§7.3 → §14: message + hint + request id)
// ---------------------------------------------------------------------------

/** §7.3-shaped action failure shared by the hub components. */
export interface HubActionError {
  readonly message: string;
  readonly hint?: string;
  readonly requestId?: string;
}

/** Maps any rejection to bounded safe copy (api-client messages are safe). */
export function toHubActionError(cause: unknown): HubActionError {
  if (isApiError(cause)) {
    return { message: cause.message, hint: cause.hint, requestId: cause.requestId };
  }
  return { message: "Something went wrong on our side.", hint: "Try again in a moment." };
}

/** §14 display bound for any wire-derived string the hub renders. */
export const HUB_TEXT_MAX = 200;

/** Bounded text — hostile strings stay data, never layout breakers. */
export function boundedHubText(value: string, max: number = HUB_TEXT_MAX): string {
  const text = value.trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** One-line §14 failure: message (+ request id) — hint renders beside it. */
export function hubErrorLine(error: HubActionError): string {
  const message = boundedHubText(error.message);
  return error.requestId === undefined ? message : `${message} (${error.requestId})`;
}
