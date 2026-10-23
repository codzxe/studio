// @studio/api-client — runtime validation schemas for RESPONSE data.
//
// @studio/contracts fixes the §7.2 response SHAPES as TypeScript interfaces
// (MeResponse, Project, …); only a handful are Zod schemas (the §7.4 event
// union, the §8.6 EditPlan, request bodies and leaf scalars). This module
// mirrors those interfaces as Zod schemas so the client can runtime-validate
// every response and the dev fixtures — "strip unknown by default" (the zod
// object default), exactly as §7.2 demands for forward compatibility.
//
// Every schema is pinned to its contracts interface with `satisfies
// z.ZodType<…>`: if a contract interface changes, `tsc --noEmit` fails HERE
// first, before any runtime drift can ship. Leaf validators are reused from
// contracts wherever they exist (ids, slugs, roles, enums, ISO-8601, EditPlan).

import {
  type AcceptedInvite,
  type ActivityEntry,
  type ApplyResponse,
  type Asset,
  type AuditExport,
  type AuditExportRow,
  BILLING_STATUS_SCHEMA,
  type BillingEntitlements,
  type BillingState,
  type CheckoutResponse,
  type Comment,
  type CreateAssetResponse,
  type CreditsSummary,
  EDIT_PLAN_SCHEMA,
  ID_SCHEMA,
  INVOICE_STATUS_SCHEMA,
  ISO8601_SCHEMA,
  type Invite,
  type InvoiceRecord,
  LEASE_QUEUE_ENTRY_SCHEMA,
  LEDGER_KIND_SCHEMA,
  type LeaseQueueEntry,
  type LedgerEntry,
  MODEL_ID_SCHEMA,
  type ManifestAsset,
  type MeResponse,
  type Membership,
  type ModelsResponse,
  PLAN_ID_SCHEMA,
  type Page,
  type PlanSummary,
  type PortalResponse,
  type Project,
  type ProjectManifest,
  type ProjectVersion,
  RENDER_FORMAT_SCHEMA,
  RENDER_QUALITY_SCHEMA,
  RENDER_STATUSES,
  ROLE_SCHEMA,
  type RenderEstimate,
  type RenderJob,
  type RequestAccessResponse,
  type RunRecord,
  type RunStepRecord,
  type ShareComment,
  type ShareInfo,
  type ShareLinkIssued,
  type ShareLinkRevoked,
  type ShareLinkView,
  type ShareManifest,
  type SignedUrl,
  type SignedUrlResponse,
  TOP_UP_PACK_ID_SCHEMA,
  type Thread,
  type ThreadMessage,
  type TrialResponse,
  type UndoResponse,
  type VersionDiffSummary,
  type VersionTimelineEntry,
  WORKSPACE_SLUG_SCHEMA,
  type Workspace,
} from "@studio/contracts";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared leaves
// ---------------------------------------------------------------------------

const idSchema = ID_SCHEMA;
const isoSchema = ISO8601_SCHEMA;
const nullableId = idSchema.nullable();

// ---------------------------------------------------------------------------
// GET /v1/me
// ---------------------------------------------------------------------------

const MEMBERSHIP_SCHEMA = z.object({
  workspaceId: idSchema,
  role: ROLE_SCHEMA,
  workspace: z.object({
    id: idSchema,
    name: z.string(),
    slug: WORKSPACE_SLUG_SCHEMA,
  }),
}) satisfies z.ZodType<Membership>;

const PLAN_SUMMARY_SCHEMA = z.object({
  plan: PLAN_ID_SCHEMA,
  creditsBalance: z.number(),
  includedCredits: z.number(),
  renewsAt: isoSchema.nullable(),
}) satisfies z.ZodType<PlanSummary>;

export const ME_RESPONSE_SCHEMA = z.object({
  user: z.object({
    id: idSchema,
    name: z.string().nullable(),
    email: z.string(),
  }),
  memberships: z.array(MEMBERSHIP_SCHEMA),
  plan: PLAN_SUMMARY_SCHEMA,
}) satisfies z.ZodType<MeResponse>;

// ---------------------------------------------------------------------------
// Workspaces / invites
// ---------------------------------------------------------------------------

export const WORKSPACE_SCHEMA = z.object({
  id: idSchema,
  name: z.string(),
  slug: WORKSPACE_SLUG_SCHEMA,
  createdAt: isoSchema,
  updatedAt: isoSchema,
}) satisfies z.ZodType<Workspace>;

export const INVITE_SCHEMA = z.object({
  id: idSchema,
  workspaceId: idSchema,
  email: z.string(),
  role: ROLE_SCHEMA,
  status: z.enum(["pending", "accepted", "revoked"]),
  expiresAt: isoSchema.nullable(),
  createdAt: isoSchema,
}) satisfies z.ZodType<Invite>;

export const ACCEPTED_INVITE_SCHEMA = z.object({
  inviteId: idSchema,
  workspaceId: idSchema,
  role: ROLE_SCHEMA,
}) satisfies z.ZodType<AcceptedInvite>;

// ---------------------------------------------------------------------------
// Projects / manifest
// ---------------------------------------------------------------------------

export const PROJECT_SCHEMA = z.object({
  id: idSchema,
  workspaceId: idSchema,
  name: z.string(),
  slug: z.string(),
  thumbnailUrl: z.string().nullable(),
  currentVersionId: nullableId,
  createdBy: idSchema,
  createdAt: isoSchema,
  updatedAt: isoSchema,
  deletedAt: isoSchema.nullable(),
}) satisfies z.ZodType<Project>;

export const SIGNED_URL_SCHEMA = z.object({
  url: z.string(),
  method: z.enum(["GET", "PUT", "POST"]),
  expiresAt: isoSchema,
  headers: z.record(z.string(), z.string()),
}) satisfies z.ZodType<SignedUrl>;

const MANIFEST_ASSET_SCHEMA = z.object({
  id: idSchema,
  name: z.string(),
  mime: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  durationTicks: z.number().int().nonnegative().nullable(),
  url: z.string(),
}) satisfies z.ZodType<ManifestAsset>;

export { MANIFEST_ASSET_SCHEMA };

export const PROJECT_MANIFEST_SCHEMA = z.object({
  projectId: idSchema,
  currentVersion: z
    .object({
      id: idSchema,
      version: z.number().int().positive(),
      sha256: z.string(),
      label: z.string().nullable(),
      sizeBytes: z.number().int().positive(),
      createdAt: isoSchema,
      url: z.string(),
    })
    .nullable(),
  assets: z.array(MANIFEST_ASSET_SCHEMA),
  updatedAt: isoSchema,
}) satisfies z.ZodType<ProjectManifest>;

// ---------------------------------------------------------------------------
// Versions (upload response is the client-side two-phase contract: the
// descriptor POST returns the immutable version row + the signed PUT target;
// mirrors the assets two-phase shape)
// ---------------------------------------------------------------------------

export const PROJECT_VERSION_SCHEMA = z.object({
  id: idSchema,
  projectId: idSchema,
  version: z.number().int().positive(),
  parentVersionId: nullableId,
  sha256: z.string(),
  sizeBytes: z.number().int().positive(),
  label: z.string().nullable(),
  agentRunId: nullableId,
  createdBy: idSchema,
  createdAt: isoSchema,
}) satisfies z.ZodType<ProjectVersion>;

// M7 task 4 — the version TIMELINE (superset of the version row: author
// display name, agent-run presence, 12-char sha256 prefix for UI copy).
export const PROJECT_VERSION_TIMELINE_SCHEMA = z.object({
  id: idSchema,
  projectId: idSchema,
  version: z.number().int().positive(),
  parentVersionId: nullableId,
  sha256: z.string(),
  sizeBytes: z.number().int().positive(),
  label: z.string().nullable(),
  agentRunId: nullableId,
  createdBy: idSchema,
  createdAt: isoSchema,
  createdByName: z.string().nullable(),
  isAgent: z.boolean(),
  sha256Prefix: z.string().min(12).max(12),
}) satisfies z.ZodType<VersionTimelineEntry>;

// M7 task 4 — structural diff vs the parent (no deep content diff in v1).
export const VERSION_DIFF_SUMMARY_SCHEMA = z.object({
  fromParent: z
    .object({
      parentVersionId: idSchema,
      parentVersion: z.number().int().positive(),
      sizeDeltaBytes: z.number().int(),
      labelChanged: z.boolean(),
      authorChanged: z.boolean(),
      createdGapMs: z.number().int().nonnegative(),
    })
    .nullable(),
  summary: z.string().max(200),
}) satisfies z.ZodType<VersionDiffSummary>;

export interface UploadVersionResponse {
  readonly version: ProjectVersion;
  readonly upload: {
    readonly url: string;
    readonly method: "PUT";
    readonly expiresAt: string;
    readonly headers: Readonly<Record<string, string>>;
  };
}

export const UPLOAD_VERSION_RESPONSE_SCHEMA = z.object({
  version: PROJECT_VERSION_SCHEMA,
  upload: z.object({
    url: z.string(),
    method: z.literal("PUT"),
    expiresAt: isoSchema,
    headers: z.record(z.string(), z.string()),
  }),
}) satisfies z.ZodType<UploadVersionResponse>;

// ---------------------------------------------------------------------------
// Leases — the REAL §7.2 wire response (compat note, first real consumer)
// ---------------------------------------------------------------------------
// `POST /v1/projects/:id/lease` answers with the acquire/renew OUTCOME, not
// the §9.1 lease row the contracts `ProjectLease` interface documents:
//   { acquired, holderName, expiresAt, readOnly }   (gateway leases.ts ok body)
// `acquired: false` + `readOnly: true` = another editor holds the lease and
// this session must open read-only (§9.3). The gateway suite (leases.test.ts)
// pins this shape against live Postgres; follow-up for the contracts owner:
// add a LeaseAcquireResponse type so the row/response drift is documented in
// one place.

export interface LeaseAcquireResponse {
  /** `true` = we hold (or just renewed) the lease. */
  readonly acquired: boolean;
  /** Display name of the current holder (the gateway resolves ids to names). */
  readonly holderName: string;
  readonly expiresAt: string;
  /** `true` = this session must open read-only (§9.3: a refused acquire). */
  readonly readOnly: boolean;
}

export const LEASE_ACQUIRE_RESPONSE_SCHEMA = z.object({
  acquired: z.boolean(),
  holderName: z.string(),
  expiresAt: isoSchema,
  readOnly: z.boolean(),
}) satisfies z.ZodType<LeaseAcquireResponse>;

export const LEASE_RELEASE_RESPONSE_SCHEMA = z.object({
  released: z.boolean(),
  // §M7 task 3 takeover: the OLDEST queued requester popped at release time.
  // OPTIONAL in the client validator — pre-M7 gateways omit the field.
  nextHolder: LEASE_QUEUE_ENTRY_SCHEMA.nullable().optional(),
}) satisfies z.ZodType<LeaseReleaseResponse>;

/** `DELETE /v1/projects/:id/lease` — release + the §M7 next-holder election. */
export interface LeaseReleaseResponse {
  readonly released: boolean;
  readonly nextHolder?: LeaseQueueEntry | null;
}

// ── M7 lease UX (BUILD_PLAN §M7 task 3) ─────────────────────────────────────
// contracts fixes the full Zod schemas for these wires (co-designed with the
// gateway routes), so they are re-exported directly instead of mirrored:
//   GET    /v1/projects/:id/lease-state   the "Alex is editing" banner data
//   POST   /v1/projects/:id/lease-request join the edit queue (dedupe/cap)
//   DELETE /v1/projects/:id/lease-request leave the queue
export {
  LEASE_REQUEST_CANCELLED_RESPONSE_SCHEMA,
  LEASE_REQUEST_RESPONSE_SCHEMA,
  LEASE_STATE_RESPONSE_SCHEMA,
} from "@studio/contracts";
export type {
  LeaseQueueEntry,
  LeaseRequestCancelledResponse,
  LeaseRequestResponse,
  LeaseStateHolder,
  LeaseStateResponse,
  LeaseYouAre,
} from "@studio/contracts";

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export const ASSET_SCHEMA = z.object({
  id: idSchema,
  workspaceId: idSchema,
  projectId: nullableId,
  name: z.string(),
  mime: z.string(),
  sizeBytes: z.number().int().positive(),
  sha256: z.string(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  durationTicks: z.number().int().nonnegative().nullable(),
  createdBy: idSchema,
  createdAt: isoSchema,
}) satisfies z.ZodType<Asset>;

export const CREATE_ASSET_RESPONSE_SCHEMA = z.object({
  asset: ASSET_SCHEMA,
  upload: z.object({
    url: z.string(),
    method: z.literal("PUT"),
    expiresAt: isoSchema,
    headers: z.record(z.string(), z.string()),
  }),
}) satisfies z.ZodType<CreateAssetResponse>;

export const SIGNED_URL_RESPONSE_SCHEMA = z.object({
  url: z.string(),
  expiresAt: isoSchema,
}) satisfies z.ZodType<SignedUrlResponse>;

// ---------------------------------------------------------------------------
// Threads / messages
// ---------------------------------------------------------------------------

export const THREAD_SCHEMA = z.object({
  id: idSchema,
  projectId: idSchema,
  title: z.string().nullable(),
  createdBy: idSchema,
  createdAt: isoSchema,
  updatedAt: isoSchema,
}) satisfies z.ZodType<Thread>;

export const THREAD_MESSAGE_SCHEMA = z.object({
  id: idSchema,
  threadId: idSchema,
  role: z.enum(["user", "assistant", "system"]),
  content: z.unknown(),
  runId: nullableId,
  createdAt: isoSchema,
}) satisfies z.ZodType<ThreadMessage>;

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

const RUN_STEP_RECORD_SCHEMA = z.object({
  seq: z.number().int().nonnegative(),
  tool: z.string(),
  status: z.enum(["started", "succeeded", "failed", "skipped"]),
  durationMs: z.number().int().nonnegative().nullable(),
}) satisfies z.ZodType<RunStepRecord>;

export const RUN_RECORD_SCHEMA = z.object({
  id: idSchema,
  threadId: idSchema,
  projectId: idSchema,
  model: MODEL_ID_SCHEMA,
  status: z.enum([
    "queued",
    "streaming",
    "awaiting_approval",
    "applying",
    "completed",
    "failed",
    "cancelled",
  ]),
  plan: EDIT_PLAN_SCHEMA.nullable(),
  steps: z.array(RUN_STEP_RECORD_SCHEMA),
  reservedCredits: z.number().nonnegative(),
  committedCredits: z.number().nonnegative().nullable(),
  baseVersionId: nullableId,
  resultVersionId: nullableId,
  errorCode: z.string().nullable(),
  createdAt: isoSchema,
  completedAt: isoSchema.nullable(),
}) satisfies z.ZodType<RunRecord>;

// ---------------------------------------------------------------------------
// Runs — apply / undo (§8.7, M5 seam)
// ---------------------------------------------------------------------------

export const APPLY_RESPONSE_SCHEMA = z.object({
  applied: z.literal(true),
  versionId: idSchema,
  creditsCommitted: z.number().nonnegative(),
}) satisfies z.ZodType<ApplyResponse>;

export const UNDO_RESPONSE_SCHEMA = z.object({
  undone: z.literal(true),
}) satisfies z.ZodType<UndoResponse>;

// ---------------------------------------------------------------------------
// Models — GET /v1/models (§8.2/§10.1 entitlement read)
// ---------------------------------------------------------------------------

export const MODELS_RESPONSE_SCHEMA = z.object({
  plan: PLAN_ID_SCHEMA,
  models: z.array(
    z.object({
      id: MODEL_ID_SCHEMA,
      tier: z.enum(["fast", "smart", "vision"]),
      use: z.string(),
      creditsPer1kInput: z.number(),
      creditsPer1kOutput: z.number(),
    }),
  ),
}) satisfies z.ZodType<ModelsResponse>;

// ---------------------------------------------------------------------------
// Credits / billing
// ---------------------------------------------------------------------------

export const CREDITS_SUMMARY_SCHEMA = z.object({
  balance: z.number().nonnegative(),
  includedCredits: z.number().nonnegative(),
  purchasedCredits: z.number().nonnegative(),
  reserved: z.number().nonnegative(),
  plan: PLAN_ID_SCHEMA,
  renewsAt: isoSchema.nullable(),
}) satisfies z.ZodType<CreditsSummary>;

export const LEDGER_ENTRY_SCHEMA = z.object({
  id: idSchema,
  workspaceId: idSchema,
  kind: LEDGER_KIND_SCHEMA,
  amount: z.number(),
  balanceAfter: z.number(),
  runId: nullableId,
  idempotencyKey: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: isoSchema,
}) satisfies z.ZodType<LedgerEntry>;

export const CHECKOUT_RESPONSE_SCHEMA = z.object({
  sessionId: z.string(),
  url: z.string(),
  /** Present (true) when the server switched an existing subscription directly. */
  planChanged: z.boolean().optional(),
}) satisfies z.ZodType<CheckoutResponse>;

export const PORTAL_RESPONSE_SCHEMA = z.object({
  url: z.string(),
}) satisfies z.ZodType<PortalResponse>;

const BILLING_ENTITLEMENTS_SCHEMA = z.object({
  seats: z.number().int().nonnegative(),
  models: z.array(z.string()),
  maxProjects: z.number().int().nonnegative(),
  storageBytes: z.number().int().nonnegative(),
  renderMinutesPerMonth: z.number().int().nonnegative(),
  monthlyCreditAllowance: z.number().int().nonnegative(),
}) satisfies z.ZodType<BillingEntitlements>;

/** `GET /v1/billing/state` — the ONE billing read the UI consumes (§M6.1). */
export const BILLING_STATE_SCHEMA = z.object({
  plan: PLAN_ID_SCHEMA,
  status: BILLING_STATUS_SCHEMA,
  currentPeriodEnd: isoSchema.nullable(),
  trialEnd: isoSchema.nullable(),
  cancelAtPeriodEnd: z.boolean(),
  graceEnd: isoSchema.nullable(),
  entitlements: BILLING_ENTITLEMENTS_SCHEMA,
  // Raw ledger numbers in µc (D-12) — the same units as CREDITS_SUMMARY.balance.
  credits: z.object({ balance: z.number(), reserved: z.number() }),
  topUpPacks: z.array(
    z.object({
      packId: TOP_UP_PACK_ID_SCHEMA,
      credits: z.number().int().positive(),
    }),
  ),
}) satisfies z.ZodType<BillingState>;

/** `POST /v1/billing/trial` — the started trial (D-4: state on the Starter row). */
export const TRIAL_RESPONSE_SCHEMA = z.object({
  trialStarted: z.literal(true),
  trialEnd: isoSchema,
}) satisfies z.ZodType<TrialResponse>;

/** One `GET /v1/billing/invoices` row (F-J3 — recorded Stripe invoices). */
export const INVOICE_SCHEMA = z.object({
  id: idSchema,
  stripeInvoiceId: z.string(),
  // MONEY in Stripe minor units (cents) — never credits (§9.1, D-12).
  amountCents: z.number().int().nonnegative(),
  currency: z.string(),
  status: INVOICE_STATUS_SCHEMA,
  periodStart: isoSchema.nullable(),
  periodEnd: isoSchema.nullable(),
  hostedUrl: z.string().nullable(),
  pdfUrl: z.string().nullable(),
  createdAt: isoSchema,
}) satisfies z.ZodType<InvoiceRecord>;

// ---------------------------------------------------------------------------
// Renders (§7.2 render queue v2 — D-11, BUILD_PLAN §M8 task 2)
// ---------------------------------------------------------------------------
//
// D-11 pin: the render status vocabulary is the DB's — `completed`, NEVER
// `succeeded` (the pre-D-11 wire name). The validator imports RENDER_STATUSES
// from contracts so a vocabulary change fails typecheck HERE before any
// runtime drift can ship.

export const RENDER_JOB_SCHEMA = z.object({
  id: idSchema,
  projectId: idSchema,
  compId: idSchema,
  /** The immutable §9.2 version snapshot the job renders (server-resolved at queue time). */
  versionId: idSchema,
  format: RENDER_FORMAT_SCHEMA,
  settings: z.record(z.string(), z.unknown()),
  status: z.enum(RENDER_STATUSES),
  /** `true` once POST /cancel is accepted; the worker honors it at the next frame boundary. */
  cancelRequested: z.boolean(),
  /** Frame progress (0/0/0 while queued; framesTotal from settings or the comp). */
  progress: z.object({
    framesDone: z.number().int().nonnegative(),
    framesTotal: z.number().int().nonnegative(),
    percent: z.number().min(0).max(100),
  }),
  credits: z.number().nonnegative().nullable(),
  resultUrl: z.string().nullable(),
  error: z.string().nullable(),
  /** Machine-readable failure code (RENDER_* from config errors); null unless failed. */
  errorCode: z.string().nullable(),
  /** Output size in bytes; null until the output lands in object storage. */
  sizeBytes: z.number().int().nonnegative().nullable(),
  createdBy: idSchema,
  createdAt: isoSchema,
  /** Null while queued (set when the worker marks the job running). */
  startedAt: isoSchema.nullable(),
  completedAt: isoSchema.nullable(),
  /** Signed result URL expiry (§9.2 retention); null until the output exists. */
  expiresAt: isoSchema.nullable(),
}) satisfies z.ZodType<RenderJob>;

/** `POST /v1/renders/estimate` — pre-flight quote (no mutation, no ledger). */
export const RENDER_ESTIMATE_SCHEMA = z.object({
  /** Credits the queue call would reserve (µc, D-12). */
  credits: z.number().nonnegative(),
  /** Output duration in seconds (settings range or the comp length). */
  outputSeconds: z.number().nonnegative(),
  /** Long-edge pixel size AFTER plan clamping (the number the UI shows). */
  longEdgePx: z.number().int().positive(),
  /** The applied format (echoed; a future worker may downshift). */
  format: RENDER_FORMAT_SCHEMA,
  /** The applied quality (draft | good | best). */
  quality: RENDER_QUALITY_SCHEMA,
  /** `true` when a plan minimum was applied instead of the requested settings. */
  minApplied: z.boolean(),
}) satisfies z.ZodType<RenderEstimate>;

// ---------------------------------------------------------------------------
// Comments / activity
// ---------------------------------------------------------------------------

export const COMMENT_SCHEMA = z.object({
  id: idSchema,
  projectId: idSchema,
  compId: idSchema,
  layerId: nullableId,
  timeTicks: z.number().int().nonnegative().nullable(),
  // Threaded list (M7): parent link for client-side tree building.
  parentCommentId: nullableId,
  body: z.string(),
  // Null on guest rows (share-link comments) — see guestName.
  authorId: nullableId,
  guestName: z.string().nullable(),
  guestEmail: z.string().nullable(),
  resolvedAt: isoSchema.nullable(),
  // Resolver user id (recorded on resolve, cleared on reopen).
  resolvedBy: nullableId,
  createdAt: isoSchema,
}) satisfies z.ZodType<Comment>;

export const ACTIVITY_ENTRY_SCHEMA = z.object({
  id: idSchema,
  projectId: nullableId,
  actorId: idSchema,
  actorName: z.string().nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: nullableId,
  createdAt: isoSchema,
}) satisfies z.ZodType<ActivityEntry>;

// M7 task 4 — the ADMIN-ONLY audit export (ids/emails are compliance data in
// this surface, never UI copy — see routes/activity.ts for the law-#1 nuance).
export const AUDIT_EXPORT_ROW_SCHEMA = z.object({
  id: idSchema,
  actorId: nullableId,
  actorName: z.string().nullable(),
  actorEmail: z.string().nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: nullableId,
  metadata: z.unknown().nullable(),
  ip: z.string().nullable(),
  createdAt: isoSchema,
}) satisfies z.ZodType<AuditExportRow>;

export const AUDIT_EXPORT_SCHEMA = z.object({
  projectId: idSchema,
  generatedAt: isoSchema,
  maxRows: z.number().int().positive(),
  rowCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  rows: z.array(AUDIT_EXPORT_ROW_SCHEMA),
}) satisfies z.ZodType<AuditExport>;

// ---------------------------------------------------------------------------
// Cursor pagination (§7.2 list endpoints)
// ---------------------------------------------------------------------------

/** `{ items, nextCursor }` page schema for one item schema. */
export function pageSchema<T>(item: z.ZodType<T>) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  }) satisfies z.ZodType<Page<T>>;
}

export const PAGE_WORKSPACES_SCHEMA = pageSchema(WORKSPACE_SCHEMA);
export const PAGE_PROJECTS_SCHEMA = pageSchema(PROJECT_SCHEMA);
export const PAGE_VERSIONS_SCHEMA = pageSchema(PROJECT_VERSION_SCHEMA);
export const PAGE_VERSION_TIMELINE_SCHEMA = pageSchema(PROJECT_VERSION_TIMELINE_SCHEMA);
export const PAGE_ASSETS_SCHEMA = pageSchema(ASSET_SCHEMA);
export const PAGE_THREADS_SCHEMA = pageSchema(THREAD_SCHEMA);
export const PAGE_MESSAGES_SCHEMA = pageSchema(THREAD_MESSAGE_SCHEMA);
export const PAGE_LEDGER_SCHEMA = pageSchema(LEDGER_ENTRY_SCHEMA);
export const PAGE_INVOICES_SCHEMA = pageSchema(INVOICE_SCHEMA);
export const PAGE_COMMENTS_SCHEMA = pageSchema(COMMENT_SCHEMA);
export const PAGE_ACTIVITY_SCHEMA = pageSchema(ACTIVITY_ENTRY_SCHEMA);
export const PAGE_RENDERS_SCHEMA = pageSchema(RENDER_JOB_SCHEMA);

// ---------------------------------------------------------------------------
// Share links (M7-E; BUILD_PLAN §M7 task 5) — public + member surfaces
// ---------------------------------------------------------------------------

/** Issue response — the ONLY place the raw share token ever appears. */
export const SHARE_LINK_ISSUED_SCHEMA = z.object({
  id: idSchema,
  token: z.string(),
  expiresAt: isoSchema.nullable(),
  hasPassword: z.boolean(),
}) satisfies z.ZodType<ShareLinkIssued>;

/** Active link for member lists — NO token material (hash never leaves the db). */
export const SHARE_LINK_VIEW_SCHEMA = z.object({
  id: idSchema,
  projectId: idSchema,
  createdBy: idSchema,
  createdAt: isoSchema,
  expiresAt: isoSchema.nullable(),
  revokedAt: isoSchema.nullable(),
  hasPassword: z.boolean(),
}) satisfies z.ZodType<ShareLinkView>;

/** Public share metadata: what is shared + how to unlock; never content. */
export const SHARE_INFO_SCHEMA = z.object({
  projectId: idSchema,
  projectName: z.string(),
  compId: nullableId,
  expiresAt: isoSchema.nullable(),
  hasPassword: z.boolean(),
  requestAccessEmail: z.string().nullable(),
}) satisfies z.ZodType<ShareInfo>;

/** Public manifest asset — name/type/dimensions + signed URL, NO ids. */
const SHARE_MANIFEST_ASSET_SCHEMA = z.object({
  name: z.string(),
  mime: z.string(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  durationTicks: z.number().nullable(),
  url: z.string(),
});

/** Public web-player manifest — NO project/version/asset ids (leak pin). */
export const SHARE_MANIFEST_SCHEMA = z.object({
  currentVersion: z
    .object({
      version: z.number().int().nonnegative(),
      label: z.string().nullable(),
      sizeBytes: z.number().int().nonnegative(),
      createdAt: isoSchema,
      url: z.string(),
    })
    .nullable(),
  assets: z.array(SHARE_MANIFEST_ASSET_SCHEMA),
  updatedAt: isoSchema,
}) satisfies z.ZodType<ShareManifest>;

/** A comment as an anonymous reviewer sees it: no member ids, no guest emails. */
export const SHARE_COMMENT_SCHEMA = z.object({
  id: idSchema,
  compId: idSchema,
  layerId: nullableId,
  timeTicks: z.number().int().nonnegative().nullable(),
  parentCommentId: nullableId,
  body: z.string(),
  guestName: z.string().nullable(),
  resolvedAt: isoSchema.nullable(),
  createdAt: isoSchema,
}) satisfies z.ZodType<ShareComment>;

/** Request-access ack — v1 notification is the workspace's audit row. */
export const REQUEST_ACCESS_RESPONSE_SCHEMA = z.object({
  ok: z.literal(true),
}) satisfies z.ZodType<RequestAccessResponse>;

/** Revoke response — idempotent: the same revokedAt on a repeat DELETE. */
export const SHARE_LINK_REVOKED_SCHEMA = z.object({
  id: idSchema,
  revokedAt: isoSchema.nullable(),
}) satisfies z.ZodType<ShareLinkRevoked>;

export const PAGE_SHARE_LINKS_SCHEMA = pageSchema(SHARE_LINK_VIEW_SCHEMA);
export const PAGE_SHARE_COMMENTS_SCHEMA = pageSchema(SHARE_COMMENT_SCHEMA);
