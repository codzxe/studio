import { z } from 'zod';
import { Role, ModelAlias, PlanId } from './brand.js';

/** Wire shapes for every API entity. The repository layer returns these (validated). */

export const Me = z.object({
  user: z.object({ id: z.string(), name: z.string(), email: z.string(), image: z.string().nullable() }),
  memberships: z.array(z.object({
    organization: Workspace,
    role: Role,
  })),
});
export const Workspace = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  plan: PlanId,
  trialEndsAt: z.string().nullable(),
  logo: z.string().nullable(),
});
export type Workspace = z.infer<typeof Workspace>;

export const WorkspaceSummary = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  plan: PlanId,
  role: Role,
  memberCount: z.number().int(),
  creditBalance: z.number().int(),
  logo: z.string().nullable(),
});
export type WorkspaceSummary = z.infer<typeof WorkspaceSummary>;

export const Project = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  currentVersionId: z.string().nullable(),
  currentVersion: z.number().int().nullable(),
  archived: z.boolean(),
  updatedAt: z.string(),
  createdAt: z.string(),
  compCount: z.number().int(),
  durationTicks: z.number().int().nullable(),
  editState: z.enum(['free', 'leased-elsewhere', 'leased-you']).nullable(),
  leaseHolderName: z.string().nullable(),
});
export type Project = z.infer<typeof Project>;

export const Version = z.object({
  id: z.string(),
  version: z.number().int(),
  sha256: z.string(),
  sizeBytes: z.number().int(),
  label: z.string().nullable(),
  agentRunId: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
});
export type Version = z.infer<typeof Version>;

export const Asset = z.object({
  id: z.string(),
  name: z.string(),
  mime: z.string(),
  sizeBytes: z.number().int(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  durationTicks: z.number().int().nullable(),
  /** stable virtual path: /assets/<assetId>/<sanitizedName> */
  virtualPath: z.string(),
  createdAt: z.string(),
});
export type Asset = z.infer<typeof Asset>;

export const ProjectManifest = z.object({
  project: Project,
  currentVersion: Version,
  assets: z.array(z.object({ asset: Asset, downloadUrl: z.string() })),
  projectUrl: z.string(),
});
export type ProjectManifest = z.infer<typeof ProjectManifest>;

export const Thread = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Thread = z.infer<typeof Thread>;

export const MessageContent = z.object({
  text: z.string(),
  /** card payloads keyed by kind; only kinds the client knows render as cards */
  cards: z
    .array(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('tool'), toolCallId: z.string(), name: z.string(), status: z.string(), summary: z.string(), args: z.unknown().optional(), result: z.unknown().optional() }),
        z.object({ kind: z.literal('plan'), runId: z.string() }),
        z.object({ kind: z.literal('applied'), runId: z.string(), versionId: z.string().optional(), summary: z.string() }),
        z.object({ kind: z.literal('undone'), runId: z.string() }),
        z.object({ kind: z.literal('error'), code: z.string(), message: z.string() }),
        z.object({ kind: z.literal('notice'), message: z.string() }),
      ]),
    )
    .optional(),
});
export type MessageContent = z.infer<typeof MessageContent>;

export const ChatMessage = z.object({
  id: z.string(),
  threadId: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  content: MessageContent,
  runId: z.string().nullable(),
  createdAt: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const RunStatus = z.enum(['running', 'awaiting_approval', 'applied', 'undone', 'completed', 'failed', 'cancelled']);
export type RunStatus = z.infer<typeof RunStatus>;

export const Run = z.object({
  id: z.string(),
  threadId: z.string(),
  projectId: z.string(),
  model: ModelAlias,
  status: RunStatus,
  plan: z.unknown().nullable(),
  reservedCredits: z.number().int(),
  committedCredits: z.number().int(),
  baseVersionId: z.string().nullable(),
  resultVersionId: z.string().nullable(),
  errorCode: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type Run = z.infer<typeof Run>;

export const RunStep = z.object({
  seq: z.number().int(),
  tool: z.string(),
  status: z.string(),
  durationMs: z.number().int().nullable(),
});
export type RunStep = z.infer<typeof RunStep>;

export const CreditEntry = z.object({
  id: z.string(),
  kind: z.enum(['grant', 'reserve', 'commit', 'refund', 'adjust']),
  amount: z.number().int(),
  balanceAfter: z.number().int(),
  runId: z.string().nullable(),
  createdAt: z.string(),
});
export type CreditEntry = z.infer<typeof CreditEntry>;

export const CreditSummary = z.object({
  balance: z.number().int(),
  includedMonthly: z.number().int(),
  usedThisCycle: z.number().int(),
  plan: PlanId,
});
export type CreditSummary = z.infer<typeof CreditSummary>;

export const Render = z.object({
  id: z.string(),
  projectId: z.string(),
  compId: z.string(),
  format: z.enum(['mp4', 'png-sequence', 'gif', 'wav']),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
  settings: z.record(z.string(), z.unknown()),
  credits: z.number().int(),
  downloadUrl: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type Render = z.infer<typeof Render>;

export const Comment = z.object({
  id: z.string(),
  projectId: z.string(),
  compId: z.string().nullable(),
  layerId: z.string().nullable(),
  timeTicks: z.number().int().nullable(),
  body: z.string(),
  authorName: z.string(),
  authorId: z.string(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Comment = z.infer<typeof Comment>;

export const ActivityEvent = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  actorName: z.string().nullable(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string().nullable(),
  createdAt: z.string(),
});
export type ActivityEvent = z.infer<typeof ActivityEvent>;

export const Member = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  role: Role,
  joinedAt: z.string(),
});
export type Member = z.infer<typeof Member>;

export const Invitation = z.object({
  id: z.string(),
  email: z.string(),
  role: Role,
  status: z.enum(['pending', 'accepted', 'revoked']),
  expiresAt: z.string(),
});
export type Invitation = z.infer<typeof Invitation>;
