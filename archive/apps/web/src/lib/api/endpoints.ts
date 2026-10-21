// apps/web — gateway endpoint constants (W8-O): the SINGLE source of every
// §13.1 path the web app may call. Pinned against the gateway's OpenAPI
// document (apps/gateway/src/openapi.ts, W1-H — 40 paths); keep both in step.
//
// Conventions:
//   - Paths are RELATIVE to the versioned base: the client baseUrl already
//     includes `/v1` (src/lib/env.ts — NEXT_PUBLIC_API_BASE_URL), so this
//     module never repeats it. Call as `client.get(endpoints.runs.detail(id))`.
//   - Dynamic segments are ALWAYS encodeURIComponent'd — ids/refs come from
//     URLs and user-adjacent state, never from trusted input (§5.7).
//   - `withQuery()` builds query strings deterministically (insertion order,
//     URLSearchParams encoding); nullish/empty params are skipped so cache
//     keys stay stable.
//
// Groups (task W8-O / §13): documents, runs (+ run-events SSE), uploads,
// assets, templates, components, credits, billing, workspaces, health,
// openapi — plus `session` (/me, Better Auth handler passthrough), which the
// existing shell hooks call (hooks/use-session.tsx).
//
// NOT for the browser: /v1/webhooks/stripe (gateway↔Stripe server-to-server)
// and /v1/projects (no consumer yet) are deliberately absent.

/** URL-encode one dynamic path segment (ids, refs, tokens). */
export function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment);
}

/** Query-string parameter values `withQuery` accepts (nullish = omitted). */
export type QueryParamValue = string | number | boolean | null | undefined;

/**
 * Append a query string to `path`, skipping null/undefined/empty values.
 * Deterministic: parameters are emitted in insertion order, encoded by
 * URLSearchParams — so the result is stable as a react-query cache key
 * component and matches the gateway's strict list schemas (W4-F).
 */
export function withQuery(
  path: string,
  params: Readonly<Record<string, QueryParamValue>>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    search.set(key, String(value));
  }
  const query = search.toString();
  return query === "" ? path : `${path}?${query}`;
}

/**
 * §13.1 endpoint surface (paths relative to the `/v1` base — see header).
 * Mirrors apps/gateway/src/openapi.ts unless a comment says otherwise.
 */
export const endpoints = {
  documents: {
    /** GET list / POST create (cursor-paged, W4-F). */
    list: "/documents",
    /** GET one / PATCH rename-archive / DELETE (W4-F). */
    detail: (documentId: string) => `/documents/${encodePathSegment(documentId)}`,
    /** GET version history (newest first). */
    versions: (documentId: string) =>
      `/documents/${encodePathSegment(documentId)}/versions`,
    /** POST restore a version (§10.6 forward-only append). */
    restoreVersion: (documentId: string, versionId: string) =>
      `/documents/${encodePathSegment(documentId)}/versions/${encodePathSegment(versionId)}/restore`,
    /** GET layer tree (editor). */
    layers: (documentId: string) => `/documents/${encodePathSegment(documentId)}/layers`,
    /** GET layer inspect payloads (editor tooling). */
    inspect: (documentId: string) => `/documents/${encodePathSegment(documentId)}/inspect`,
    /** GET a document's runs / POST create one (§3.3 step 2). */
    runs: (documentId: string) => `/documents/${encodePathSegment(documentId)}/runs`,
    /** POST an engine command batch (control protocol, §2). */
    commands: (documentId: string) => `/documents/${encodePathSegment(documentId)}/commands`,
    undo: (documentId: string) => `/documents/${encodePathSegment(documentId)}/undo`,
    redo: (documentId: string) => `/documents/${encodePathSegment(documentId)}/redo`,
    /** POST export renders (async job, §12). */
    exports: (documentId: string) => `/documents/${encodePathSegment(documentId)}/exports`,
    /** GET the rendered preview PNG at a revision (§10.4). */
    preview: (documentId: string) => `/documents/${encodePathSegment(documentId)}/preview`,
  },
  runs: {
    /** GET run list (cursor-paged, dashboard strip). */
    list: "/runs",
    /** POST create a run (§3.3; body camelCase per W4-G). */
    create: "/runs",
    /** GET run status/cost (timeline page; §13.1). */
    detail: (runId: string) => `/runs/${encodePathSegment(runId)}`,
    /** POST cancel a run (§14.2 refund semantics). */
    cancel: (runId: string) => `/runs/${encodePathSegment(runId)}/cancel`,
    /**
     * GET run events — the §13.2 SSE stream (backfill, then live). Consumed
     * by `GatewayClient.streamRunEvents` (./sse.ts), never by hand.
     */
    events: (runId: string) => `/runs/${encodePathSegment(runId)}/events`,
  },
  uploads: {
    /** POST multipart upload (one `file` part; §12.1 checksum dedupe). */
    create: "/uploads",
  },
  assets: {
    /** GET keyset-paged library (cursor + limit, W4-I). */
    list: "/assets",
    /** GET metadata + §15.1 signed URL / DELETE (editor+). */
    detail: (assetId: string) => `/assets/${encodePathSegment(assetId)}`,
  },
  templates: {
    /** GET §7.4 discovery cards (`?tags=&query=`). */
    list: "/templates",
    /**
     * GET full §7.2 manifest. Client route used by W8-J (use-catalog.ts);
     * openapi documents only the list path today — TODO(drift): W4-J adds it.
     * Pin with `?version=N` — `id@version` refs are immutable (§10.4).
     */
    detail: (templateId: string) => `/templates/${encodePathSegment(templateId)}`,
  },
  components: {
    /** GET §8.3 discovery cards (`?tags=&query=`). */
    list: "/components",
    /** GET full §8.2 manifest (same drift note as templates.detail). */
    detail: (componentId: string) => `/components/${encodePathSegment(componentId)}`,
  },
  credits: {
    /** GET workspace credit balance (§14.1; provisional shape, audit D2). */
    balance: "/credits",
  },
  billing: {
    /** POST Stripe Checkout session (§14.2 top-up). */
    checkout: "/billing/checkout",
    /** POST Stripe billing portal session. */
    portal: "/billing/portal",
    /** GET usage roll-up (billing page). */
    usage: "/usage",
  },
  workspaces: {
    /** GET memberships / POST create (§15.2 RBAC). */
    list: "/workspaces",
    detail: (workspaceId: string) => `/workspaces/${encodePathSegment(workspaceId)}`,
    /** GET members / POST invite. */
    members: (workspaceId: string) => `/workspaces/${encodePathSegment(workspaceId)}/members`,
    /** PATCH/DELETE one member (role changes, removal). */
    member: (workspaceId: string, userId: string) =>
      `/workspaces/${encodePathSegment(workspaceId)}/members/${encodePathSegment(userId)}`,
    /** GET pending invites. */
    invites: (workspaceId: string) => `/workspaces/${encodePathSegment(workspaceId)}/invites`,
    /** DELETE/re-send one invite. */
    invite: (workspaceId: string, inviteId: string) =>
      `/workspaces/${encodePathSegment(workspaceId)}/invites/${encodePathSegment(inviteId)}`,
    /** GET invite details by token (accept page — no auth). */
    inviteByToken: (token: string) => `/invites/${encodePathSegment(token)}`,
    /** POST accept an invite by token (no auth; mints the session). */
    acceptInvite: (token: string) => `/invites/${encodePathSegment(token)}/accept`,
  },
  session: {
    /** GET the current user + memberships (shell; provisional, audit D2). */
    me: "/me",
    /** Better Auth handler passthrough (sign-in/out, session…; §13 auth). */
    auth: (handler: string) => `/auth/${encodePathSegment(handler)}`,
  },
  health: {
    /** GET liveness (no auth). */
    live: "/health",
    /** GET dependency probe (DB/queue/engine pool). */
    deep: "/health/deep",
  },
  openapi: {
    /** GET the OpenAPI document (contract-drift checks; §13). */
    document: "/openapi.json",
  },
} as const;
