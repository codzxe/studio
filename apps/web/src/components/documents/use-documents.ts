"use client";

// apps/web — documents server-state hooks (W8-C) over React Query.
//
// Every gateway call goes through src/lib/api.ts (the typed client, §13) —
// these hooks own NO transport of their own. Wire contracts (zod at every
// boundary, docs/AGENTS.md) mirror the gateway DTO mappers in
// apps/gateway/src/routes/documents.ts (W4-F):
//   GET    /v1/documents?cursor=&limit=&include_archived= → { ok, documents, next_cursor }
//   GET    /v1/documents/:id → { ok, document: { …, latest_version } }
//   POST   /v1/documents { name, width, height, templateId? } → 201 { ok, document, version }
// The list schema is STRICT over {cursor, limit, include_archived} — there is
// no server-side search yet, so the library's `?q=` filter stays client-side
// (documents-library.tsx placeholder; flip to a server param when the gateway
// grows one).
//
// INVALIDATION NOTES (react-query cache law for this domain):
//   - create: optimistic patch of every cached list page (onMutate) → replace
//     placeholder with the real row (onSuccess) → seed the detail cache from
//     the authoritative 201 body → invalidate ONLY the list queries
//     (documentsKeys.lists()) — never documentsKeys.all, that would discard
//     the seeded detail.
//   - future rename/archive/restore mutations: write the detail cache, then
//     invalidate documentsKeys.lists().
//   - editor/editor tooling (W8-F): after a run commits or a `preview.updated`
//     SSE event carries a new revision, invalidate documentsKeys.detail(id);
//     list rows only change on create/archive/rename.

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { z } from "zod";
import { createGatewayClientFromEnv, isApiError, type GatewayClient } from "@/lib/api";

// ---------------------------------------------------------------------------
// Wire schemas — mirrors of the gateway DTO mappers (routes/documents.ts)
// ---------------------------------------------------------------------------

const isoDateTime = z.string().datetime();

export const documentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  width_px: z.number().int().positive(),
  height_px: z.number().int().positive(),
  current_revision: z.number().int().nonnegative(),
  template_id: z.string().min(1).nullable(),
  created_by: z.string(),
  created_at: isoDateTime,
  updated_at: isoDateTime,
  archived_at: isoDateTime.nullable(),
});

export const documentVersionSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().min(1),
  label: z.string().min(1),
  created_by: z.string(),
  created_at: isoDateTime,
});

const documentListResponseSchema = z.object({
  ok: z.literal(true),
  documents: z.array(documentSchema),
  next_cursor: z.string().nullable(),
});

const documentDetailResponseSchema = z.object({
  ok: z.literal(true),
  document: documentSchema.extend({
    latest_version: documentVersionSchema.nullable(),
  }),
});

const documentCreateResponseSchema = z.object({
  ok: z.literal(true),
  document: documentSchema,
  version: documentVersionSchema,
});

export type DocumentDto = z.infer<typeof documentSchema>;
export type DocumentVersionDto = z.infer<typeof documentVersionSchema>;
export type DocumentDetailResponse = z.infer<typeof documentDetailResponseSchema>;
export type DocumentDetail = DocumentDetailResponse["document"];

// ---------------------------------------------------------------------------
// List query params — mirror of the gateway list schema + paging defaults
// (services/documents.ts DEFAULT_/MAX_DOCUMENTS_PAGE_SIZE)
// ---------------------------------------------------------------------------

export const DOCUMENTS_DEFAULT_PAGE_SIZE = 20;
export const DOCUMENTS_MAX_PAGE_SIZE = 100;

const listQuerySchema = z.object({
  cursor: z.string().min(1).max(1024).optional(),
  limit: z.number().int().min(1).max(DOCUMENTS_MAX_PAGE_SIZE).optional(),
  includeArchived: z.boolean().optional(),
});

export interface DocumentsListQuery {
  readonly cursor?: string;
  readonly limit?: number;
  readonly includeArchived?: boolean;
}

/** Normalized (defaults applied) list query — the cache-key shape. */
type NormalizedListQuery = Required<Omit<DocumentsListQuery, "cursor">> &
  Pick<DocumentsListQuery, "cursor">;

function normalizeListQuery(query: DocumentsListQuery): NormalizedListQuery {
  const parsed = listQuerySchema.parse(query);
  return {
    limit: parsed.limit ?? DOCUMENTS_DEFAULT_PAGE_SIZE,
    includeArchived: parsed.includeArchived ?? false,
    cursor: parsed.cursor,
  };
}

/**
 * `GET /v1/documents` path builder. Strict keys only — the gateway's list
 * schema rejects anything else (routes/documents.ts), so a client-side `q`
 * must NOT ride along here.
 */
export function buildDocumentsPath(query: DocumentsListQuery = {}): string {
  const normalized = normalizeListQuery(query);
  const params = new URLSearchParams({
    limit: String(normalized.limit),
    include_archived: String(normalized.includeArchived),
  });
  if (normalized.cursor !== undefined) {
    params.set("cursor", normalized.cursor);
  }
  return `/documents?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Query keys + the shared gateway client (lazy: env is read on first call)
// ---------------------------------------------------------------------------

export const documentsKeys = {
  all: ["documents"] as const,
  /** Matches every list/infinite-list cache entry. */
  lists: () => [...documentsKeys.all, "list"] as const,
  list: (query: DocumentsListQuery) =>
    [...documentsKeys.lists(), normalizeListQuery(query)] as const,
  /** Matches every document detail cache entry. */
  details: () => [...documentsKeys.all, "detail"] as const,
  detail: (documentId: string) => [...documentsKeys.details(), documentId] as const,
};

let cachedClient: GatewayClient | undefined;

/** One gateway client per browser session; created on first hook call. */
function gateway(): GatewayClient {
  cachedClient ??= createGatewayClientFromEnv();
  return cachedClient;
}

// ---------------------------------------------------------------------------
// Error envelopes → view models (§13.3: message + hint, never internals)
// ---------------------------------------------------------------------------

export interface ErrorEnvelopeView {
  readonly code: string;
  readonly message: string;
  readonly hint: string | undefined;
  readonly retryable: boolean;
  readonly docsUrl: string | undefined;
}

/**
 * Normalize any thrown value into a display envelope. ApiError already carries
 * the gateway's flat/nested envelope, unwrapped by the client; anything else
 * (e.g. a ZodError from contract drift) collapses to a generic message so
 * internals never reach the UI (§13.3).
 */
export function toErrorEnvelope(error: unknown): ErrorEnvelopeView {
  if (isApiError(error)) {
    return {
      code: error.code,
      message: error.message,
      hint: error.hint,
      retryable: error.retryable,
      docsUrl: error.docsUrl,
    };
  }
  return {
    code: "unexpected_error",
    message: "Something went wrong on our side.",
    hint: "Please try again in a moment.",
    retryable: true,
    docsUrl: undefined,
  };
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** One fetched page of the documents list (§13.1, cursor-paged, newest first). */
export interface DocumentsPage {
  readonly documents: readonly DocumentDto[];
  readonly nextCursor: string | null;
}

/** Infinite-data shape stored for each list cache entry. */
export type DocumentsListData = InfiniteData<DocumentsPage, string | undefined>;

export function useDocuments(query: DocumentsListQuery = {}) {
  return useInfiniteQuery({
    queryKey: documentsKeys.list(query),
    queryFn: async ({ pageParam }) => {
      const response = await gateway().get(buildDocumentsPath({ ...query, cursor: pageParam }), {
        schema: documentListResponseSchema,
      });
      return {
        documents: response.documents,
        nextCursor: response.next_cursor,
      } satisfies DocumentsPage;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

export function useDocument(documentId: string) {
  const query = useQuery({
    queryKey: documentsKeys.detail(documentId),
    queryFn: async () => {
      const response = await gateway().get(
        `/documents/${encodeURIComponent(documentId)}`,
        { schema: documentDetailResponseSchema },
      );
      return response.document;
    },
    enabled: documentId !== "",
  });
  return {
    document: query.data ?? null,
    isLoading: query.isPending,
    error: query.error,
    refetch: query.refetch,
    isRefetching: query.isRefetching,
  };
}

// ---------------------------------------------------------------------------
// Create — optimistic with rollback; see the INVALIDATION NOTES header block
// ---------------------------------------------------------------------------

export interface CreateDocumentInput {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** Optional template ref "id@version" (§5.5) — the modal does not offer one yet. */
  readonly templateId?: string;
}

/** Prefix marking a cache-only placeholder row created by onMutate. */
export const OPTIMISTIC_DOCUMENT_ID_PREFIX = "optimistic:";

export function isOptimisticDocument(document: DocumentDto): boolean {
  return document.id.startsWith(OPTIMISTIC_DOCUMENT_ID_PREFIX);
}

export function useCreateDocument() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateDocumentInput) => {
      // §13: the client attaches the Idempotency-Key header (auto UUID).
      return gateway().post("/documents", {
        body: {
          name: input.name,
          width: input.width,
          height: input.height,
          ...(input.templateId !== undefined ? { templateId: input.templateId } : {}),
        },
        schema: documentCreateResponseSchema,
      });
    },

    onMutate: async (input: CreateDocumentInput) => {
      await queryClient.cancelQueries({ queryKey: documentsKeys.lists() });
      const entries = queryClient.getQueriesData<DocumentsListData>({
        queryKey: documentsKeys.lists(),
      });

      const now = new Date().toISOString();
      // Cache-only placeholder (never sent over the wire): revision 0 until the
      // 201 body lands; `created_by: "you"` is a UI stub, replaced on success.
      const placeholder: DocumentDto = {
        id: `${OPTIMISTIC_DOCUMENT_ID_PREFIX}${crypto.randomUUID()}`,
        name: input.name.trim(),
        width_px: input.width,
        height_px: input.height,
        current_revision: 0,
        template_id: input.templateId ?? null,
        created_by: "you",
        created_at: now,
        updated_at: now,
        archived_at: null,
      };

      const snapshots = new Map<readonly unknown[], DocumentsListData>();
      for (const [key, data] of entries) {
        if (data === undefined) {
          continue;
        }
        snapshots.set(key, data);
        queryClient.setQueryData<DocumentsListData>(key, {
          ...data,
          pages: data.pages.map((page, index) =>
            index === 0
              ? { ...page, documents: [placeholder, ...page.documents] }
              : page,
          ),
        });
      }
      return { placeholderId: placeholder.id, snapshots };
    },

    onError: (_error: unknown, _input: CreateDocumentInput, context) => {
      if (context === undefined) {
        return;
      }
      // Roll the optimistic card back out of every patched list (§13.3: the
      // envelope itself is displayed by the caller from mutation.error).
      for (const [key, snapshot] of context.snapshots) {
        queryClient.setQueryData<DocumentsListData>(key, snapshot);
      }
    },

    onSuccess: (response, _input: CreateDocumentInput, context) => {
      // 1. Swap the placeholder row for the authoritative one, page by page.
      for (const [key, data] of queryClient.getQueriesData<DocumentsListData>({
        queryKey: documentsKeys.lists(),
      })) {
        if (data === undefined) {
          continue;
        }
        queryClient.setQueryData<DocumentsListData>(key, {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            documents: page.documents.map((row) =>
              context !== undefined && row.id === context.placeholderId
                ? response.document
                : row,
            ),
          })),
        });
      }
      // 2. Seed the detail cache from the 201 body (no fetch needed).
      queryClient.setQueryData<DocumentDetailResponse>(documentsKeys.detail(response.document.id), {
        ok: true,
        document: { ...response.document, latest_version: response.version },
      });
      // 3. Refetch lists (lists only — the detail above stays untouched).
      void queryClient.invalidateQueries({ queryKey: documentsKeys.lists() });
    },
  });
}
