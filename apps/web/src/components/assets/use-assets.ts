"use client";

// apps/web — asset library data hooks (W8-I). The ONLY module that talks to
// the §13.1 upload/asset endpoints from the library UI:
//
//   POST   /uploads        multipart (one `file` part + `kind`/`name` fields)
//   GET    /assets         keyset-paged library (cursor + limit)
//   GET    /assets/:id     metadata + short-lived signed URL (§15.1 ≤ 15 min)
//   DELETE /assets/:id     editor+ delete, audited server-side (§22)
//
// Wire shapes are mirrored with Zod schemas from the actual gateway contract
// (apps/gateway/src/routes/uploads.ts — W4-I) — "Zod at every boundary".
// Mutations invalidate the list cache; upload idempotency is server-side
// byte-dedupe (§12.1 checksum) plus the §13 Idempotency-Key header.
//
// ATTACH-PICKED CONTRACT (for W8-D asset-chips): embedders that need a
// picker either (a) render <AssetGrid onPick={handler}> directly, or
// (b) open `/assets?picker=1` in a new tab and listen for a `postMessage`
// of type ASSET_PICKED_MESSAGE_TYPE. Both paths deliver the same
// PickedAsset payload (asset row + fresh signed URL + expiry).

import {
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { z } from "zod";
import { ApiError, type GatewayClient, createGatewayClientFromEnv } from "@/lib/api";

// ---------------------------------------------------------------------------
// Wire schemas (mirror of the W4-I gateway route — the API contract)
// ---------------------------------------------------------------------------

/** Client-safe asset row (gateway services/assets.ts `assetSummary`). */
export const assetSummarySchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    mime: z.string().min(1),
    checksum: z.string().min(1),
    name: z.string(),
    created_at: z.string().min(1),
  })
  .strict();

export type AssetSummary = z.infer<typeof assetSummarySchema>;

/** GET /assets response — `next_cursor` is present only while a next page exists. */
export const assetListPageSchema = z
  .object({
    ok: z.literal(true),
    assets: z.array(assetSummarySchema),
    next_cursor: z.string().min(1).optional(),
  })
  .strict();

export type AssetListPage = z.infer<typeof assetListPageSchema>;

/** POST /uploads 201 response (`duplicate: true` = §12.1 byte-dedupe hit). */
export const uploadAssetResponseSchema = z
  .object({
    ok: z.literal(true),
    asset: z
      .object({
        id: z.string().min(1),
        kind: z.string().min(1),
        bytes: z.number().int().nonnegative(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        mime: z.string().min(1),
        checksum: z.string().min(1),
      })
      .strict(),
    duplicate: z.boolean(),
  })
  .strict();

export type UploadAssetResponse = z.infer<typeof uploadAssetResponseSchema>;

/** GET /assets/:id response — §15.1 signed URL (ttl 900 s). */
export const signedAssetUrlSchema = z
  .object({
    ok: z.literal(true),
    asset: assetSummarySchema,
    url: z
      .object({
        url: z.string().min(1),
        expires_at: z.string().min(1),
        expires_in_seconds: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

export type SignedAsset = z.infer<typeof signedAssetUrlSchema>;

/** DELETE /assets/:id response. */
export const deleteAssetResponseSchema = z
  .object({
    ok: z.literal(true),
    deleted: z.literal(true),
    id: z.string().min(1),
  })
  .strict();

export type DeleteAssetResponse = z.infer<typeof deleteAssetResponseSchema>;

// ---------------------------------------------------------------------------
// Gateway client (lazy singleton — env parsing must not run at build time)
// ---------------------------------------------------------------------------

let clientRef: GatewayClient | undefined;

/** One browser-session gateway client (see src/lib/env.ts lazy-parse note). */
function gateway(): GatewayClient {
  if (clientRef === undefined) {
    clientRef = createGatewayClientFromEnv();
  }
  return clientRef;
}

// ---------------------------------------------------------------------------
// Query keys + constants
// ---------------------------------------------------------------------------

/** Root key for every asset cache entry — invalidate this prefix after writes. */
export const ASSETS_ROOT_QUERY_KEY = ["assets"] as const;

export const ASSETS_LIST_QUERY_KEY = ["assets", "list"] as const;

/** §13.1 `limit` is capped at 100 server-side; 24 keeps the grid tidy. */
export const ASSETS_PAGE_SIZE = 24;

/**
 * Signed URLs live ≤ 900 s (§15.1). Treat cached signatures as stale after
 * 9 minutes so a thumbnail never 403s mid-scroll; cards additionally refetch
 * once on img error as a belt-and-braces (asset-card.tsx).
 */
export const SIGNED_URL_STALE_MS = 9 * 60 * 1000;

export function assetUrlQueryKey(id: string): readonly unknown[] {
  return ["assets", "url", id];
}

// ---------------------------------------------------------------------------
// Multipart upload (the gateway client JSON-encodes bodies; uploads need a
// real FormData with the boundary set by the browser — hence a local fetch
// that reuses the same §13.3 envelope unwrapping as src/lib/api.ts)
// ---------------------------------------------------------------------------

export interface UploadAssetInput {
  readonly file: File;
  /** Optional display name; the server falls back to the file's own name. */
  readonly name?: string;
}

/** Flat `{ ok:false, … }` envelope — the shape api.ts unwraps for REST calls. */
const uploadErrorEnvelopeSchema = z.object({
  ok: z.literal(false),
  code: z.string(),
  message: z.string(),
  hint: z.string().optional(),
  retryable: z.boolean().optional(),
  docs_url: z.string().optional(),
});

async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** §13.3 unwrap mirror of api.ts `toApiError` (private there; same behaviour). */
async function unwrapErrorResponse(response: Response): Promise<ApiError> {
  const parsed = uploadErrorEnvelopeSchema.safeParse(await readJsonBody(response));
  if (parsed.success) {
    return new ApiError({
      code: parsed.data.code,
      message: parsed.data.message,
      status: response.status,
      hint: parsed.data.hint,
      retryable: parsed.data.retryable ?? response.status >= 500,
      docsUrl: parsed.data.docs_url,
    });
  }
  return new ApiError({
    code: "unexpected_response",
    message: "The server returned an unexpected response.",
    status: response.status,
    retryable: response.status >= 500,
  });
}

async function uploadAssetMultipart(input: UploadAssetInput): Promise<UploadAssetResponse> {
  const form = new FormData();
  form.append("file", input.file);
  form.append("kind", "image"); // §20.2: the only uploadable kind (never fonts)
  if (input.name !== undefined && input.name !== "") {
    form.append("name", input.name);
  }
  let response: Response;
  try {
    response = await fetch(`${gateway().baseUrl}/uploads`, {
      method: "POST",
      credentials: "include", // §13: Better Auth session cookie
      headers: { "Idempotency-Key": crypto.randomUUID() }, // §13 mutating rule
      body: form, // no content-type header: the browser sets the boundary
    });
  } catch {
    throw new ApiError({
      code: "network_error",
      message: "Could not reach the server.",
      status: 0,
      retryable: true,
    });
  }
  if (!response.ok) {
    throw await unwrapErrorResponse(response);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError({
      code: "unexpected_response",
      message: "The server returned an unexpected response.",
      status: response.status,
      retryable: false,
    });
  }
  return uploadAssetResponseSchema.parse(body); // contract drift throws
}

// ---------------------------------------------------------------------------
// List (keyset-paged, newest first)
// ---------------------------------------------------------------------------

export interface AssetListPageParam {
  readonly cursor?: string;
}

const FIRST_PAGE_PARAM: AssetListPageParam = {};

async function fetchAssetPage(limit: number, pageParam: AssetListPageParam): Promise<AssetListPage> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (pageParam.cursor !== undefined) {
    params.set("cursor", pageParam.cursor);
  }
  return gateway().get(`/assets?${params.toString()}`, { schema: assetListPageSchema });
}

/**
 * The organization's asset library, newest first. `enabled` stays false on
 * the server so static prerendering never calls the gateway (env parses
 * lazily on first client use — src/lib/env.ts).
 */
export function useAssetsPages(pageSize: number = ASSETS_PAGE_SIZE) {
  return useInfiniteQuery({
    queryKey: [...ASSETS_LIST_QUERY_KEY, pageSize],
    queryFn: ({ pageParam }) => fetchAssetPage(pageSize, pageParam),
    initialPageParam: FIRST_PAGE_PARAM,
    getNextPageParam: (lastPage: AssetListPage): AssetListPageParam | undefined =>
      lastPage.next_cursor !== undefined ? { cursor: lastPage.next_cursor } : undefined,
    enabled: typeof window !== "undefined",
  });
}

// ---------------------------------------------------------------------------
// Signed URLs (§15.1 — short-lived; fetched per card, lazily)
// ---------------------------------------------------------------------------

export interface SignedAssetUrlOptions {
  /** Fetch the signature only when needed (viewport-proximate cards). */
  readonly enabled?: boolean;
}

export function useSignedAssetUrl(id: string, options?: SignedAssetUrlOptions) {
  const enabled = options?.enabled ?? true;
  return useQuery({
    queryKey: assetUrlQueryKey(id),
    queryFn: () => gateway().get(`/assets/${encodeURIComponent(id)}`, {
      schema: signedAssetUrlSchema,
    }),
    enabled,
    staleTime: SIGNED_URL_STALE_MS,
    refetchOnWindowFocus: false,
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Upload one file; the list cache is invalidated on success. */
export function useUploadAsset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: uploadAssetMultipart,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ASSETS_LIST_QUERY_KEY }),
  });
}

/** Delete one asset (§22 audited server-side); list + URL caches invalidate. */
export function useDeleteAsset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      gateway().request(`/assets/${encodeURIComponent(id)}`, {
        method: "DELETE",
        schema: deleteAssetResponseSchema,
      }),
    onSuccess: (_result: DeleteAssetResponse, id: string) => {
      queryClient.removeQueries({ queryKey: assetUrlQueryKey(id) });
      void queryClient.invalidateQueries({ queryKey: ASSETS_LIST_QUERY_KEY });
    },
  });
}

// ---------------------------------------------------------------------------
// Attach-picked contract (W8-D asset-chips)
// ---------------------------------------------------------------------------

/** What an embedder receives when a user attaches a library image. */
export interface PickedAsset {
  readonly asset: AssetSummary;
  /** Fresh signed URL (§15.1) — valid for `expiresAt`. */
  readonly url: string;
  /** ISO timestamp of the URL's expiry. */
  readonly expiresAt: string;
}

export type AssetPickedHandler = (picked: PickedAsset) => void | Promise<void>;

/** `postMessage` type used by the `/assets?picker=1` tab flow. */
export const ASSET_PICKED_MESSAGE_TYPE = "asset.picked";

/**
 * Resolve (and cache) a fresh signed URL for an asset — the shared helper
 * behind both the picker flow and `useSignedAssetUrl`.
 */
export async function resolveAssetUrl(queryClient: QueryClient, id: string): Promise<SignedAsset> {
  return queryClient.fetchQuery({
    queryKey: assetUrlQueryKey(id),
    queryFn: () =>
      gateway().get(`/assets/${encodeURIComponent(id)}`, { schema: signedAssetUrlSchema }),
    staleTime: SIGNED_URL_STALE_MS,
  });
}
