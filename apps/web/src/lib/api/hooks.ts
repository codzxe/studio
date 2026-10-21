"use client";

// apps/web — shared react-query hooks layer over the typed gateway client
// (W8-O). Everything React-shaped that the §13 surface needs lives here:
//   - `queryKeys`: the typed queryKey factory — every shape is FROZEN to the
//     conventions already shipped by the ad-hoc hooks (invalidations cross
//     modules by array equality, so a "nicer" key would split the cache):
//       documents  → components/documents/use-documents.ts (W8-C) +
//                    components/versions/use-versions.ts (W8-H)
//       runs       → app/(app)/runs/[id]/page.tsx ["run", id] + hooks/use-session.tsx
//       assets     → components/assets/use-assets.ts (W8-I)
//       session    → hooks/use-session.tsx (W8-A)
//       catalog    → components/gallery/use-catalog.ts (W8-J)
//       comments   → components/comments/use-comments.ts (W8-F)
//   - `useApiQuery` / `useApiMutation`: thin wrappers adding the transport
//     defaults the whole app wants — envelope-aware retry/backoff, and the
//     401 seam — so individual hooks stop re-declaring them;
//   - the 401 seam: one installable handler (`setUnauthorizedHandler`) that
//     future waves (W8-B auth wiring) point at a redirect to /sign-in.
//
// NOT re-exported through the src/lib/api.ts shim on purpose: this module
// pulls React + @tanstack/react-query, and the shim must stay importable
// from node-env unit tests (tests/api.test.ts) and server components.
// Import hooks explicitly: `import { useApiQuery } from "@/lib/api/hooks"`.

import {
  useMutation,
  useQuery,
  type QueryFunctionContext,
  type QueryKey,
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";
import { ApiError, isApiError } from "./client";

// ---------------------------------------------------------------------------
// Typed queryKeys factory — shapes frozen to the existing conventions
// ---------------------------------------------------------------------------

/**
 * Every react-query cache key the web app uses, in one typed home. Arrays —
 * not opaque strings — so `queryClient.invalidateQueries({ queryKey:
 * queryKeys.documents.lists })` keeps working across modules.
 */
export const queryKeys = {
  documents: {
    /** Root — invalidate everything documents-related (rarely: drops seeded details). */
    all: ["documents"] as const,
    /** Prefix matching every list/infinite-list entry (W8-C documentsKeys.lists). */
    lists: ["documents", "list"] as const,
    /** One list entry — pass the NORMALIZED query (W8-C normalizeListQuery). */
    list: (query: Readonly<Record<string, unknown>>) =>
      ["documents", "list", query] as const,
    /** Prefix matching every document detail entry. */
    details: ["documents", "detail"] as const,
    detail: (documentId: string) => ["documents", "detail", documentId] as const,
    /** Dashboard grid rows (W8-A useRecentDocuments). */
    recent: (limit: number, workspaceId: string | null) =>
      ["documents", "recent", limit, workspaceId] as const,
    /** Versions PREFIX — W8-H appends its page size: [...versions(id), limit]. */
    versions: (documentId: string) => ["documents", documentId, "versions"] as const,
    versionDiff: (documentId: string, from: number, to: number) =>
      ["documents", documentId, "diff", from, to] as const,
  },
  runs: {
    /** Root of the plural list keys. */
    all: ["runs"] as const,
    /** Dashboard strip rows (W8-A useRecentRuns). */
    recent: (limit: number, workspaceId: string | null) =>
      ["runs", "recent", limit, workspaceId] as const,
    /** One run's status payload — NOTE the singular "run": frozen to the
     * timeline page's existing key (app/(app)/runs/[id]/page.tsx). */
    detail: (runId: string) => ["run", runId] as const,
  },
  assets: {
    /** Root — invalidate after uploads/deletes (W8-I). */
    all: ["assets"] as const,
    /** Infinite-list prefix (W8-I ASSETS_LIST_QUERY_KEY). */
    list: ["assets", "list"] as const,
    /** One infinite-list entry (W8-I appends the page size). */
    listPage: (pageSize: number) => ["assets", "list", pageSize] as const,
    /** §15.1 signed URL entries (short staleTime by TTL). */
    url: (assetId: string) => ["assets", "url", assetId] as const,
  },
  session: {
    /** Root — refreshSession() invalidates this prefix (W8-A). */
    all: ["session"] as const,
    me: ["session", "me"] as const,
    workspaces: ["session", "workspaces"] as const,
    credits: (workspaceId: string | null) => ["session", "credits", workspaceId] as const,
  },
  catalog: {
    /** Discovery card lists (W8-J; params are the built URLSearchParams state). */
    templates: (params: Readonly<Record<string, unknown>>) =>
      ["catalog", "templates", params] as const,
    components: (params: Readonly<Record<string, unknown>>) =>
      ["catalog", "components", params] as const,
    /** Full manifests — immutable id@version pins, staleTime Infinity (W8-J). */
    template: (id: string, version: number) => ["catalog", "template", id, version] as const,
    component: (id: string, version: number) => ["catalog", "component", id, version] as const,
  },
  comments: {
    /** Root — editor and viewer both hold per-document threads (W8-F). */
    all: ["comments"] as const,
    forDocument: (documentId: string) => ["comments", documentId] as const,
  },
  auth: {
    /** Invite accept card (app/(app)/invite/[token]). */
    invitation: (token: string) => ["auth", "invitation", token] as const,
  },
} as const;

// ---------------------------------------------------------------------------
// Retry / backoff defaults — envelope-aware (§13.3 retryable flags)
// ---------------------------------------------------------------------------

export const API_QUERY_MAX_RETRIES = 2;
export const API_RETRY_BASE_DELAY_MS = 1_000;
export const API_RETRY_MAX_DELAY_MS = 30_000;

/** §13.3: only retry what the envelope marked retryable (plus 429 backoff). */
export function apiQueryRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= API_QUERY_MAX_RETRIES) {
    return false;
  }
  if (isApiError(error)) {
    if (error.status === 429) {
      return true; // rate-limited: back off and try again
    }
    // 5xx / network / timeout carry retryable:true from the client unwrap;
    // 4xx envelopes and drift (ZodError) stay fatal.
    return error.retryable;
  }
  return false;
}

/** Exponential backoff: 1 s, 2 s, … capped at 30 s. */
export function apiRetryDelay(failureCount: number): number {
  return Math.min(API_RETRY_BASE_DELAY_MS * 2 ** failureCount, API_RETRY_MAX_DELAY_MS);
}

// ---------------------------------------------------------------------------
// 401 handling seam — one hook for the auth wave (redirect to sign-in)
// ---------------------------------------------------------------------------

export const UNAUTHORIZED_STATUS = 401;

/** Where the auth gate sends expired sessions (server gate: layout.tsx). */
export const SIGN_IN_PATH = "/sign-in";

/** Narrow any thrown value to "the session is gone". */
export function isUnauthorizedError(error: unknown): boolean {
  return isApiError(error) && error.status === UNAUTHORIZED_STATUS;
}

export type UnauthorizedHandler = (error: ApiError) => void;

let unauthorizedHandler: UnauthorizedHandler | null = null;

/**
 * Install the app-wide 401 reaction (W8-B TODO: call this once from the
 * session provider with a `router.replace(SIGN_IN_PATH)` closure, or use
 * `redirectUnauthorizedHandler`). Uninstalls when passed null.
 */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

/** Notifies the seam (no-op until a handler is installed). */
export function handleUnauthorized(error: unknown): void {
  if (unauthorizedHandler === null || !isUnauthorizedError(error)) {
    return;
  }
  unauthorizedHandler(error);
}

/**
 * Ready-made handler for `setUnauthorizedHandler`: hard-navigates to
 * /sign-in. Client-side only — on the server the (app) layout's session gate
 * owns redirects, and mid-prerender 401s must stay typed error states.
 */
export const redirectUnauthorizedHandler: UnauthorizedHandler = () => {
  if (typeof window === "undefined") {
    return;
  }
  window.location.replace(SIGN_IN_PATH);
};

// ---------------------------------------------------------------------------
// useApiQuery — useQuery with the shared gateway defaults
// ---------------------------------------------------------------------------

/**
 * `useQuery` + the app's §13 defaults: envelope-aware retry/backoff and the
 * 401 seam. Everything else (queryKey, queryFn, staleTime, enabled…) passes
 * through untouched — see @tanstack/react-query v5 options.
 */
export function useApiQuery<TQueryFnData, TQueryKey extends QueryKey = QueryKey>(
  options: UseQueryOptions<TQueryFnData, Error, TQueryFnData, TQueryKey>,
): UseQueryResult<TQueryFnData, Error> {
  const { queryFn, retry, retryDelay, ...rest } = options;
  return useQuery<TQueryFnData, Error, TQueryFnData, TQueryKey>({
    ...rest,
    retry: retry ?? apiQueryRetry,
    retryDelay: retryDelay ?? apiRetryDelay,
    queryFn:
      queryFn === undefined
        ? undefined
        : (context: QueryFunctionContext<TQueryKey>) =>
            Promise.resolve(queryFn(context)).catch((error: unknown) => {
              handleUnauthorized(error);
              throw error;
            }),
  });
}

// ---------------------------------------------------------------------------
// useApiMutation — useMutation with §3.4-safe defaults
// ---------------------------------------------------------------------------

/**
 * `useMutation` + the app's defaults: NO automatic retries (§3.4 idempotency
 * is explicit — replays reuse the caller's Idempotency-Key) and the 401 seam
 * fired from onError (single path, unlike queries which have no onError).
 */
export function useApiMutation<TData, TVariables, TContext = unknown>(
  options: UseMutationOptions<TData, Error, TVariables, TContext>,
): UseMutationResult<TData, Error, TVariables, TContext> {
  const { onError, retry, ...rest } = options;
  return useMutation<TData, Error, TVariables, TContext>({
    ...rest,
    retry: retry ?? false,
    onError: (error: Error, variables: TVariables, context: TContext | undefined) => {
      handleUnauthorized(error);
      onError?.(error, variables, context);
    },
  });
}
