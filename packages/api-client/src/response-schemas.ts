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
  type Asset,
  type CheckoutResponse,
  type Comment,
  type CreateAssetResponse,
  type CreditsSummary,
  EDIT_PLAN_SCHEMA,
  ID_SCHEMA,
  ISO8601_SCHEMA,
  type Invite,
  LEDGER_KIND_SCHEMA,
  type LedgerEntry,
  MODEL_ID_SCHEMA,
  type ManifestAsset,
  type MeResponse,
  type Membership,
  PLAN_ID_SCHEMA,
  type Page,
  type PlanSummary,
  type PortalResponse,
  type Project,
  type ProjectManifest,
  type ProjectVersion,
  RENDER_FORMAT_SCHEMA,
  ROLE_SCHEMA,
  type RenderJob,
  type RunRecord,
  type RunStepRecord,
  type SignedUrl,
  type SignedUrlResponse,
  type Thread,
  type ThreadMessage,
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
}) satisfies z.ZodType<{ released: boolean }>;

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
}) satisfies z.ZodType<CheckoutResponse>;

export const PORTAL_RESPONSE_SCHEMA = z.object({
  url: z.string(),
}) satisfies z.ZodType<PortalResponse>;

// ---------------------------------------------------------------------------
// Renders
// ---------------------------------------------------------------------------

export const RENDER_JOB_SCHEMA = z.object({
  id: idSchema,
  projectId: idSchema,
  compId: idSchema,
  format: RENDER_FORMAT_SCHEMA,
  settings: z.record(z.string(), z.unknown()),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  credits: z.number().nonnegative().nullable(),
  resultUrl: z.string().nullable(),
  error: z.string().nullable(),
  createdBy: idSchema,
  createdAt: isoSchema,
  completedAt: isoSchema.nullable(),
}) satisfies z.ZodType<RenderJob>;

// ---------------------------------------------------------------------------
// Comments / activity
// ---------------------------------------------------------------------------

export const COMMENT_SCHEMA = z.object({
  id: idSchema,
  projectId: idSchema,
  compId: idSchema,
  layerId: nullableId,
  timeTicks: z.number().int().nonnegative().nullable(),
  body: z.string(),
  authorId: idSchema,
  resolvedAt: isoSchema.nullable(),
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
export const PAGE_ASSETS_SCHEMA = pageSchema(ASSET_SCHEMA);
export const PAGE_THREADS_SCHEMA = pageSchema(THREAD_SCHEMA);
export const PAGE_MESSAGES_SCHEMA = pageSchema(THREAD_MESSAGE_SCHEMA);
export const PAGE_LEDGER_SCHEMA = pageSchema(LEDGER_ENTRY_SCHEMA);
export const PAGE_COMMENTS_SCHEMA = pageSchema(COMMENT_SCHEMA);
export const PAGE_ACTIVITY_SCHEMA = pageSchema(ACTIVITY_ENTRY_SCHEMA);
