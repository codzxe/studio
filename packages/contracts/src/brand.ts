import { z } from 'zod';

/** Hard bounds from the plan: max 100 batch steps, 2 MB payload, 60s apply. */
export const LIMITS = {
  maxBatchSteps: 100,
  maxPlanSteps: 20,
  maxAffectedLayers: 50,
  maxPayloadBytes: 2 * 1024 * 1024,
  applyTimeoutMs: 60_000,
  maxRunModelSteps: 8,
  planValidationMs: 100,
  contextTokenBudget: 4_000,
  leaseHeartbeatMs: 120_000, // 2-minute heartbeat
  leaseExpiryMs: 300_000, // 5-minute expiry
  leaseRenewWindowMs: 30_000,
  autosaveIntervalMs: 30_000,
  renderPreviewMaxPx: 1280,
  sseResumeWindowMs: 15 * 60_000,
} as const;

/** Wire-stable roles. Every permission check goes through canDo(). */
export const ROLES = ['owner', 'admin', 'editor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];
export const Role = z.enum(ROLES);

const ROLE_RANK: Record<Role, number> = { owner: 4, admin: 3, editor: 2, viewer: 1 };

export const PERMISSIONS = [
  'workspace.read',
  'workspace.update',
  'workspace.manageMembers',
  'workspace.manageBilling',
  'project.read',
  'project.create',
  'project.update',
  'project.delete',
  'asset.read',
  'asset.upload',
  'version.read',
  'version.create',
  'version.restore',
  'lease.acquire',
  'chat.read',
  'chat.run',
  'agent.apply', // mutating agent runs
  'comment.read',
  'comment.write',
  'render.queue',
  'render.read',
  'audit.read',
  'apikey.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const MATRIX: Record<Role, Permission[] | '*'> = {
  owner: '*',
  admin: [
    'workspace.read', 'workspace.update', 'workspace.manageMembers',
    'project.read', 'project.create', 'project.update', 'project.delete',
    'asset.read', 'asset.upload', 'version.read', 'version.create', 'version.restore',
    'lease.acquire', 'chat.read', 'chat.run', 'agent.apply', 'comment.read',
    'comment.write', 'render.queue', 'render.read', 'audit.read', 'apikey.manage',
  ],
  editor: [
    'workspace.read', 'project.read', 'project.create', 'project.update',
    'asset.read', 'asset.upload', 'version.read', 'version.create', 'version.restore',
    'lease.acquire', 'chat.read', 'chat.run', 'agent.apply', 'comment.read',
    'comment.write', 'render.queue', 'render.read',
  ],
  viewer: [
    'workspace.read', 'project.read', 'asset.read', 'version.read', 'chat.read',
    'comment.read', 'render.read',
  ],
};

export function canDo(role: Role, permission: Permission): boolean {
  const list = MATRIX[role];
  return list === '*' || list.includes(permission);
}

export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** Model aliases per §8.2 — plan gating applied server-side. */
export const MODELS = ['studio-fast', 'studio-smart', 'studio-vision'] as const;
export type ModelAlias = (typeof MODELS)[number];
export const ModelAlias = z.enum(MODELS);

/** Plans per §10.1 — illustrative; final pricing is a business decision. */
export interface PlanDef {
  id: 'trial' | 'starter' | 'pro' | 'studio';
  name: string;
  priceUsd: number;
  includedCredits: number;
  seats: number;
  models: ModelAlias[];
  storageGb: number;
  renderMinutes: number;
  trialDays?: number;
}

export const PLANS: Record<PlanDef['id'], PlanDef> = {
  trial: { id: 'trial', name: 'Trial', priceUsd: 0, includedCredits: 100, seats: 1, models: ['studio-fast'], storageGb: 2, renderMinutes: 10, trialDays: 14 },
  starter: { id: 'starter', name: 'Starter', priceUsd: 29, includedCredits: 1000, seats: 1, models: ['studio-fast'], storageGb: 20, renderMinutes: 60 },
  pro: { id: 'pro', name: 'Pro', priceUsd: 79, includedCredits: 3000, seats: 3, models: ['studio-fast', 'studio-smart'], storageGb: 100, renderMinutes: 240 },
  studio: { id: 'studio', name: 'Studio', priceUsd: 199, includedCredits: 8000, seats: 10, models: ['studio-fast', 'studio-smart', 'studio-vision'], storageGb: 500, renderMinutes: 1200 },
};

export const PlanId = z.enum(['trial', 'starter', 'pro', 'studio']);
export type PlanId = z.infer<typeof PlanId>;

/** Brand tokens — the product name is a token swap, never hardcoded (§2.1). */
export const BRAND = {
  codename: 'Studio',
  tagline: 'Motion, directed by you',
  forbiddenNames: ['EffectCraft', 'ArtCraft', 'PhotoCraft', 'Cursor', 'Photoshop'],
} as const;
