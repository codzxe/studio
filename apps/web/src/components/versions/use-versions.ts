"use client";

// apps/web/src/components/versions/use-versions — data hooks for the version
// timeline (W8-G). Spec anchors:
//   §10.4  versions are immutable; restore creates a NEW version (history is
//          never rewritten) — the timeline refetches after every restore.
//   §13.1  GET  /v1/documents/:id/versions             → { versions: VersionDto[] }
//          POST /v1/documents/:id/versions/:versionId/restore
//                                     → 201 { document, version, bytes_stored }
//          GET  /v1/documents/:id/preview  → { url, revision, expires_at } (W4-L)
//   §13.4  POST /v1/documents/:id/commands — the manual commands surface is
//          the transport for the §5.6 `document.diff` query; §6.1 compacts
//          its reply to a summary, so full rows ride a `result` passthrough
//          only when a later gateway build exposes them.
//
// Everything goes through the typed gateway client (src/lib/api.ts): error
// envelopes unwrap into ApiError, success bodies are zod-validated at the
// boundary, and mutating POSTs auto-carry the Idempotency-Key header (§13).
//
// Routes status (W4-R registry): the routers exist
// (apps/gateway/src/routes/documents.ts, commands.ts, exports.ts) but
// routes/index.ts still mounts only /health — until the registration wave
// lands, these calls answer the registry's typed 501 envelope and the UI
// renders it as an actionable error state (comments-wave precedent).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { createGatewayClientFromEnv, isApiError, type GatewayClient } from "@/lib/api";
import {
  classifyDiffFailure,
  parseSummaryBucketCounts,
  sortVersionsAscending,
  type DiffRow,
  type DiffState,
  type DocumentDiff,
  type DocumentVersion,
} from "./version-model";

// ---------------------------------------------------------------------------
// Wire schemas (the boundary — gateway routes must mirror these, §13 audit)
// ---------------------------------------------------------------------------

/** openapi VersionDto — routes/documents.ts toVersionDto (§13.1). */
export const versionDtoSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().min(0),
  label: z.string(),
  created_by: z.string().min(1),
  created_at: z.coerce.date(),
});

/** GET /v1/documents/:id/versions success body (timeline ascending, §10.4). */
export const versionListResponseSchema = z.object({
  ok: z.literal(true),
  versions: z.array(versionDtoSchema),
});

/**
 * POST …/versions/:versionId/restore success body (201). Only the head
 * counter is consumed from `document` — the document page owns the full DTO
 * schema, so this is reliance-based, not a duplicate (§10.4: the reply's
 * `version` is the NEW head row, label "Restored from r{n}").
 */
export const restoreResponseSchema = z.object({
  ok: z.literal(true),
  document: z.object({ current_revision: z.number().int().min(0) }).passthrough(),
  version: versionDtoSchema,
  bytes_stored: z.number().int().min(0),
});

/** GET /v1/documents/:id/preview success body (signed URL, routes/exports.ts). */
export const previewUrlResponseSchema = z.object({
  url: z.string().url(),
  revision: z.number().int().min(0),
  expires_at: z.coerce.date(),
});

/**
 * §13.4 manual-commands reply (routes/commands.ts toCommandReply — §6.1
 * compact). passthrough keeps any future `result`/`diff` passthrough field
 * alive for parseDocumentDiffReply.
 */
export const commandReplySchema = z
  .object({
    ok: z.literal(true),
    command: z.string(),
    seq: z.number().int().min(0),
    summary: z.string(),
    warnings: z.array(z.string()),
    document_revision: z.number().int().min(0),
    revision_before: z.number().int().min(0),
    revision_after: z.number().int().min(0),
    replayed: z.boolean(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// document.diff wire schemas — pinned to engine-patches/agent_cmds/document_diff.rs
// ---------------------------------------------------------------------------

const diffBoundsWireSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable();

const diffRowWireSchema = z.object({
  layer_id: z.number().int().min(0),
  name: z.string(),
  kind: z.string(),
  bounds_from: diffBoundsWireSchema,
  bounds_to: diffBoundsWireSchema,
  props_changed: z.array(z.string().min(1)),
  parent_from: z.number().int().nullable().optional(),
  parent_to: z.number().int().nullable().optional(),
  order_from: z.number().int().min(0).optional(),
  order_to: z.number().int().min(0).optional(),
});

const documentDiffWireSchema = z
  .object({
    from: z.number().int().min(0),
    to: z.number().int().min(0),
    added: z.array(diffRowWireSchema),
    removed: z.array(diffRowWireSchema),
    changed: z.array(diffRowWireSchema),
    moved: z.array(diffRowWireSchema),
  })
  .refine((diff) => diff.from <= diff.to, { message: "from must not exceed to" });

function mapDiffRow(row: z.infer<typeof diffRowWireSchema>): DiffRow {
  return {
    layerId: row.layer_id,
    name: row.name,
    kind: row.kind,
    boundsFrom: row.bounds_from,
    boundsTo: row.bounds_to,
    propsChanged: row.props_changed,
    ...(row.parent_from !== undefined ? { parentFrom: row.parent_from } : {}),
    ...(row.parent_to !== undefined ? { parentTo: row.parent_to } : {}),
    ...(row.order_from !== undefined ? { orderFrom: row.order_from } : {}),
    ...(row.order_to !== undefined ? { orderTo: row.order_to } : {}),
  };
}

function mapDocumentDiff(diff: z.infer<typeof documentDiffWireSchema>): DocumentDiff {
  return {
    from: diff.from,
    to: diff.to,
    added: diff.added.map(mapDiffRow),
    removed: diff.removed.map(mapDiffRow),
    changed: diff.changed.map(mapDiffRow),
    moved: diff.moved.map(mapDiffRow),
  };
}

/**
 * Extracts the full §5.6 diff out of a manual-commands reply. Candidate
 * locations, in order: a future `result`/`diff` passthrough field, then the
 * reply itself (a gateway build that returns the engine result directly).
 * Null when the build carries only the §6.1 compact summary.
 */
export function parseDocumentDiffReply(reply: unknown): DocumentDiff | null {
  const candidates: unknown[] = [];
  if (reply !== null && typeof reply === "object") {
    const record = reply as { result?: unknown; diff?: unknown };
    if (record.result !== undefined) {
      candidates.push(record.result);
    }
    if (record.diff !== undefined) {
      candidates.push(record.diff);
    }
  }
  candidates.push(reply);
  for (const candidate of candidates) {
    const parsed = documentDiffWireSchema.safeParse(candidate);
    if (parsed.success) {
      return mapDocumentDiff(parsed.data);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Wire → domain mapping + cache keys
// ---------------------------------------------------------------------------

function mapVersionDto(dto: z.infer<typeof versionDtoSchema>): DocumentVersion {
  return {
    id: dto.id,
    revision: dto.revision,
    label: dto.label,
    createdBy: dto.created_by,
    createdAt: dto.created_at,
  };
}

/** Timeline cache key — under ["documents", id] so restore invalidation covers it. */
export function versionsQueryKey(documentId: string): readonly [string, string, string] {
  return ["documents", documentId, "versions"] as const;
}

/** Per-pair diff cache key (from → to, §5.6). */
export function versionDiffQueryKey(
  documentId: string,
  from: number,
  to: number,
): readonly [string, string, string, number, number] {
  return ["documents", documentId, "diff", from, to] as const;
}

/**
 * Lazily resolve the gateway client: an explicit client wins (tests); the
 * default builds from NEXT_PUBLIC_API_BASE_URL on first real call, never at
 * render/SSR time (src/lib/env.ts contract; comments-wave precedent).
 */
function resolveClient(client?: GatewayClient): GatewayClient {
  return client ?? createGatewayClientFromEnv();
}

/** §13.1 versions timeline cap — request the full window (MAX_VERSIONS_LIMIT). */
const VERSIONS_LIMIT = 200;

// ---------------------------------------------------------------------------
// useVersionTimeline — list (§13.1 GET …/versions)
// ---------------------------------------------------------------------------

export interface UseVersionTimelineOptions {
  readonly documentId: string;
  /** Injected gateway client; omit for the env-configured default. */
  readonly client?: GatewayClient;
}

/** The document's versions, ascending by revision (§10.4). */
export function useVersionTimeline(options: UseVersionTimelineOptions) {
  const documentId = options.documentId;
  return useQuery({
    queryKey: [...versionsQueryKey(documentId), VERSIONS_LIMIT],
    enabled: documentId !== "",
    queryFn: async (): Promise<readonly DocumentVersion[]> => {
      const response = await resolveClient(options.client).get(
        `/documents/${encodeURIComponent(documentId)}/versions?limit=${VERSIONS_LIMIT}`,
        { schema: versionListResponseSchema },
      );
      return sortVersionsAscending(response.versions.map(mapVersionDto));
    },
  });
}

// ---------------------------------------------------------------------------
// useRestoreVersion — restore AS A NEW VERSION (§10.4/§13.1)
// ---------------------------------------------------------------------------

export interface RestoreResult {
  /** The NEW head version the restore appended ("Restored from r{n}"). */
  readonly version: DocumentVersion;
  readonly currentRevision: number;
  readonly bytesStored: number;
}

export interface UseRestoreVersionOptions {
  readonly documentId: string;
  /** Injected gateway client; omit for the env-configured default. */
  readonly client?: GatewayClient;
  /** Fires with the new head version after the cache refresh is queued. */
  readonly onRestored?: (version: DocumentVersion) => void;
}

/**
 * POST /v1/documents/:id/versions/:versionId/restore — §10.4: the source row
 * and its bytes are never mutated; a fresh head version is appended. On
 * success the whole ["documents"] subtree is invalidated: this timeline, the
 * document summaries that carry `current_revision`, and any sibling document
 * query (["documents", id, …] convention, use-session.tsx).
 */
export function useRestoreVersion(options: UseRestoreVersionOptions) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { versionId: string }): Promise<RestoreResult> => {
      const response = await resolveClient(options.client).post(
        `/documents/${encodeURIComponent(options.documentId)}/versions/${encodeURIComponent(input.versionId)}/restore`,
        { schema: restoreResponseSchema },
      );
      return {
        version: mapVersionDto(response.version),
        currentRevision: response.document.current_revision,
        bytesStored: response.bytes_stored,
      };
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["documents"] });
      options.onRestored?.(result.version);
    },
  });
}

// ---------------------------------------------------------------------------
// useVersionDiff — §5.6 document.diff over the §13.4 commands surface
// ---------------------------------------------------------------------------

export interface UseVersionDiffOptions {
  readonly documentId: string;
  /** Older revision (the version row's revision). */
  readonly from: number;
  /** Newer revision — the current head for "diff vs current". */
  readonly to: number;
  readonly client?: GatewayClient;
  /** Fetch only when a pair is selected and from < to (default true). */
  readonly enabled?: boolean;
}

/**
 * Runs `document.diff {from, to}` through POST /v1/documents/:id/commands and
 * NEVER throws at the query level: every failure is classified (§6.1) into the
 * DiffState the view renders — full rows when the wire carries them, the
 * graceful "diff unavailable" states otherwise, actionable errors with the
 * server's message + hint everywhere.
 */
export function useVersionDiff(options: UseVersionDiffOptions) {
  const documentId = options.documentId;
  const from = options.from;
  const to = options.to;
  const enabled = (options.enabled ?? true) && documentId !== "" && from < to;
  return useQuery({
    queryKey: versionDiffQueryKey(documentId, from, to),
    enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<DiffState> => {
      try {
        const reply = await resolveClient(options.client).post(
          `/documents/${encodeURIComponent(documentId)}/commands`,
          {
            body: { command: "document.diff", params: { from, to } },
            schema: commandReplySchema,
          },
        );
        const diff = parseDocumentDiffReply(reply);
        if (diff !== null) {
          return { status: "ok", diff };
        }
        // §6.1 compact reply only — surface the summary counts it does carry.
        return {
          status: "unavailable",
          reason: "details_not_exposed",
          message: reply.summary,
          summaryCounts: parseSummaryBucketCounts(reply.summary),
        };
      } catch (error) {
        if (isApiError(error)) {
          return classifyDiffFailure({
            code: error.code,
            status: error.status,
            message: error.message,
            hint: error.hint,
            retryable: error.retryable,
          });
        }
        // ZodError on a success body = contract drift; env failures are the
        // only other throwers here. Both stay generic and non-leaking (§13.3).
        return classifyDiffFailure({
          code: "unexpected_response",
          status: 0,
          message: "The server returned an unexpected response.",
          retryable: false,
        });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// useDocumentPreview — cached preview URL (§13.1, routes/exports.ts W4-L)
// ---------------------------------------------------------------------------

export interface PreviewUrlResult {
  readonly url: string;
  readonly revision: number;
}

export interface UseDocumentPreviewOptions {
  readonly documentId: string;
  readonly client?: GatewayClient;
}

/**
 * Resolves the document's cached preview PNG to its signed URL. Preview is
 * per-document CURRENT state only (§13.1 has no per-version preview): the
 * view opens the URL and, for non-head rows, explains that the preview shows
 * the current version. `preview_not_rendered` (404) arrives as a typed
 * envelope with the "open the document first" hint (§6.1).
 */
export function useDocumentPreview(options: UseDocumentPreviewOptions) {
  return useMutation({
    mutationFn: async (): Promise<PreviewUrlResult> => {
      const response = await resolveClient(options.client).get(
        `/documents/${encodeURIComponent(options.documentId)}/preview`,
        { schema: previewUrlResponseSchema },
      );
      return { url: response.url, revision: response.revision };
    },
  });
}
