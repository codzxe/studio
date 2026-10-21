// apps/web — Zod mirrors of the MAIN §13 response payloads (W8-O).
//
// Posture: COARSE by design and PINNED against apps/gateway/src/openapi.ts
// (W1-H) plus the finer client-side mirrors that already exist and carry
// their own colocated tests:
//   - documents  → components/documents/use-documents.ts (W4-F DTO mappers)
//   - run detail → components/runs/timeline-state.ts (§13.1/§3.4/§24.4)
//   - catalog    → components/gallery/use-catalog.ts (W4-J catalog service)
//   - session    → hooks/use-session.tsx (W8-A openapi mirrors)
// This module is the shared "one screenful" contract for new consumers; the
// per-hook mirrors stay authoritative for their owners until adoption.
// Differences are tolerated: mirrors here are NOT `.strict()` and unknown
// fields are stripped, so server-side schema growth must never blank a page
// (§13.3: contract drift is a typed error, not a crash).
//
// TODO(drift, CI): pin these mirrors against the live contract — a scheduled
// job fetching `GET /v1/openapi.json` and diffing the mirrored field names
// (see endpoints.openapi.document). Until that lands, the colocated
// schema-mirror.test.ts golden fixtures are the tripwire.

import { z } from "zod";

/** Coarse ISO-8601 timestamp — `z.string().datetime()` proved too brittle a
 * pin against gateway serializers; presence is what the UI depends on. */
const isoDateTime = z.string().min(1);

// ---------------------------------------------------------------------------
// Document cards (§13.1 /v1/documents — openapi DocumentDto, W4-F)
// ---------------------------------------------------------------------------

/** One library/dashboard row — the "document card" payload. */
export const documentCardSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  width_px: z.number().int().positive(),
  height_px: z.number().int().positive(),
  current_revision: z.number().int().nonnegative(),
  /** Immutable `id@version` pin or null for blank documents (§7.2). */
  template_id: z.string().min(1).nullable(),
  created_by: z.string(),
  created_at: isoDateTime,
  updated_at: isoDateTime,
  archived_at: isoDateTime.nullable(),
});
export type DocumentCard = z.infer<typeof documentCardSchema>;

/** Version stub embedded in create/detail replies (openapi VersionDto). */
export const documentVersionCardSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().min(1),
  label: z.string().min(1),
  created_by: z.string(),
  created_at: isoDateTime,
});
export type DocumentVersionCard = z.infer<typeof documentVersionCardSchema>;

/** `GET /v1/documents` page (cursor paging, newest first). */
export const documentListEnvelopeSchema = z.object({
  ok: z.literal(true),
  documents: z.array(documentCardSchema),
  next_cursor: z.string().nullable(),
});
export type DocumentListEnvelope = z.infer<typeof documentListEnvelopeSchema>;

/** `GET /v1/documents/:id` — card + latest version stub. */
export const documentDetailEnvelopeSchema = z.object({
  ok: z.literal(true),
  document: documentCardSchema.extend({
    latest_version: documentVersionCardSchema.nullable(),
  }),
});
export type DocumentDetailEnvelope = z.infer<typeof documentDetailEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Run status (§13.1 /v1/runs, /v1/runs/:id — openapi RunListItem / RunStatus)
// ---------------------------------------------------------------------------

/**
 * Run lifecycle states — mirror of the gateway enum (W4-G; the exact list
 * components/runs/timeline-state.ts pins for the timeline). TODO(drift, CI):
 * regenerate from openapi once the drift job exists (see file header).
 */
export const RUN_STATUSES = [
  "queued",
  "planning",
  "executing",
  "observing",
  "rendering",
  "validating",
  "critiquing",
  "repairing",
  "finalizing",
  "succeeded",
  "succeeded_with_warnings",
  "failed",
  "cancelled",
] as const satisfies readonly string[];

export type RunStatus = (typeof RUN_STATUSES)[number];

export const runStatusSchema = z.enum(RUN_STATUSES);

/** Credit accounting embedded in run payloads (§14.1 reserve/charge). */
export const runCreditsSchema = z.object({
  reserved: z.number().nonnegative(),
  charged: z.number().nonnegative(),
});
export type RunCredits = z.infer<typeof runCreditsSchema>;

/** `GET /v1/runs` list item (dashboard strip). */
export const runCardSchema = z.object({
  run_id: z.string().min(1),
  document_id: z.string().min(1),
  status: runStatusSchema,
  tier: z.string().min(1),
  revision_before: z.number().int().nonnegative(),
  revision_after: z.number().int().nullable(),
  created_at: isoDateTime,
  started_at: isoDateTime.nullable(),
  finished_at: isoDateTime.nullable(),
  error: z.unknown().nullable(),
  credits: runCreditsSchema,
});
export type RunCard = z.infer<typeof runCardSchema>;

/**
 * `GET /v1/runs/:id` — the coarse "run status" mirror: the fields every
 * surface agrees on (timeline-state.ts adds plan/steps/cost detail; the
 * editor's editor-model.ts allows the rest via passthrough).
 */
export const runStatusPayloadSchema = runCardSchema.extend({
  status: runStatusSchema,
  /** §24.4 verdict/cost detail — deliberately `unknown` at this layer. */
  plan: z.unknown().optional(),
  steps: z.array(z.unknown()).optional(),
  cost: z.unknown().optional(),
});
export type RunStatusPayload = z.infer<typeof runStatusPayloadSchema>;

// ---------------------------------------------------------------------------
// Credits (§14.1 /v1/credits — provisional openapi shape, audit D2)
// ---------------------------------------------------------------------------

/**
 * `GET /v1/credits` — the balance the shell badge renders. `ok` is optional:
 * the provisional route omits it (hooks/use-session.tsx mirror note).
 * TODO(drift, CI): reconcile when the billing wave finalizes the route.
 */
export const creditsSchema = z.object({
  ok: z.literal(true).optional(),
  balance: z.number(),
});
export type Credits = z.infer<typeof creditsSchema>;

// ---------------------------------------------------------------------------
// Catalog cards (§7.4 templates / §8.3 components — W4-J catalog service)
// ---------------------------------------------------------------------------

/** `GET /v1/templates` discovery card — NOT the full §7.2 manifest. */
export const templateCardSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().nonnegative(),
  /** The immutable `id@version` pin — always explicit in replies (§7.2). */
  ref: z.string().min(1),
  name: z.string().min(1),
  tags: z.array(z.string()),
  canvas: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  slots: z.array(z.string()),
});
export type TemplateCard = z.infer<typeof templateCardSchema>;

export const templateCardsEnvelopeSchema = z.object({
  templates: z.array(templateCardSchema),
});
export type TemplateCardsEnvelope = z.infer<typeof templateCardsEnvelopeSchema>;

/** `GET /v1/components` discovery card (§8.3) — NOT the full §8.2 manifest. */
export const componentCardSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().nonnegative(),
  ref: z.string().min(1),
  name: z.string().min(1),
  tags: z.array(z.string()),
  defaultSize: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  license: z.string().min(1),
  variables: z.array(z.string()),
  comps: z.array(z.string()),
});
export type ComponentCard = z.infer<typeof componentCardSchema>;

export const componentCardsEnvelopeSchema = z.object({
  components: z.array(componentCardSchema),
});
export type ComponentCardsEnvelope = z.infer<typeof componentCardsEnvelopeSchema>;
