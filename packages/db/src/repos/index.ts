import type { StudioDb } from "../db.js";
import { type ApiKeysRepo, createApiKeysRepo } from "./api-keys.js";
import { type AssetsRepo, createAssetsRepo } from "./assets.js";
import { type AuditRepo, createAuditRepo } from "./audit.js";
import { type CommentsRepo, createCommentsRepo } from "./comments.js";
import { type InvoicesRepo, createInvoicesRepo } from "./invoices.js";
import { type LeasesRepo, createLeasesRepo } from "./leases.js";
import { type LedgerRepo, createLedgerRepo } from "./ledger.js";
import { type MembershipsRepo, createMembershipsRepo } from "./memberships.js";
import { type PresenceRepo, createPresenceRepo } from "./presence.js";
import { type ProjectsRepo, createProjectsRepo } from "./projects.js";
import { type RendersRepo, createRendersRepo } from "./renders.js";
import { type RunsRepo, createRunsRepo } from "./runs.js";
import { type SettingsRepo, createSettingsRepo } from "./settings.js";
import { type ShareTokensRepo, createShareTokensRepo } from "./share-tokens.js";
import { type SubscriptionsRepo, createSubscriptionsRepo } from "./subscriptions.js";
import { type ThreadsRepo, createThreadsRepo } from "./threads.js";
import { type VersionsRepo, createVersionsRepo } from "./versions.js";
import { type WebhookEventsRepo, createWebhookEventsRepo } from "./webhook-events.js";

export type { WorkspaceId, Page } from "./shared.js";
export type { ProjectsRepo } from "./projects.js";
// W1-b (§M1 tasks 1+2, AUD-1 gap #2): tenant-scoped workspace api-key reads.
export type { ApiKeysRepo, ApiKeyRecord, ApiKeysListOptions } from "./api-keys.js";
export type { VersionsRepo } from "./versions.js";
export type { LeasesRepo } from "./leases.js";
export type { AssetsRepo } from "./assets.js";
export type { ThreadsRepo } from "./threads.js";
// Round 12 (client-driven agent loop): transcript persistence + history loader.
export type {
  HistoryRole,
  ThreadHistoryMessage,
  LoadHistoryOptions,
  ToolMessageInput,
  AssistantMessageStatus,
  AssistantMessageInput,
  LinkUserMessageInput,
} from "./threads.js";
export { toHistoryEntry, historyCostOf } from "./threads.js";
export type {
  RunsRepo,
  RecordAppliedInput,
  RecordUndoneInput,
  PlanState,
  PlanLifecycleStatus,
  ToolCallStepInput,
  CompleteToolStepInput,
  TouchRunHeartbeatInput,
  MarkRunAbandonedInput,
  StaleRun,
} from "./runs.js";
export { RUN_STALE_AFTER_MS, RUN_ABANDONED_ERROR_CODE } from "./runs.js";
export type { LedgerRepo } from "./ledger.js";
export type { LedgerScope } from "./ledger.js";
// Perf round part 2: the /v1/me membership fan-out (per-org getFullWorkspace
// × N workspaces) replaced by ONE member × organization join.
export type { MembershipsRepo, MembershipRow } from "./memberships.js";
export type { CommentsRepo } from "./comments.js";
export type { RendersRepo } from "./renders.js";
// M8-A job-queue surface (additive; the worker wave codes against these).
export type {
  ScopedRender,
  RenderHeartbeatInput,
  RenderCompleteResult,
  RenderFailResult,
  RenderClaimOptions,
} from "./renders.js";
export type { AuditRepo } from "./audit.js";
export type {
  SubscriptionsRepo,
  SubscriptionUpsertInput,
  SubscriptionTransitionInput,
  EnsureStripeCustomerInput,
} from "./subscriptions.js";
export type {
  InvoicesRepo,
  RecordInvoiceInput,
  InvoiceResult,
  InvoiceListOptions,
} from "./invoices.js";
export type { SettingsRepo } from "./settings.js";
export type { WebhookEventsRepo, WebhookSeenInput } from "./webhook-events.js";
export type {
  ShareTokensRepo,
  ShareTokenIssueInput,
  ShareTokenRevokeInput,
  ShareTokenView,
  ResolvedShare,
} from "./share-tokens.js";
export type {
  PresenceRepo,
  PresenceViewer,
  PresenceBeatInput,
  PresenceViewersOptions,
} from "./presence.js";

/** The full tenant-scoped repository bundle. */
export interface Repos {
  readonly projects: ProjectsRepo;
  readonly versions: VersionsRepo;
  readonly leases: LeasesRepo;
  readonly assets: AssetsRepo;
  readonly threads: ThreadsRepo;
  readonly runs: RunsRepo;
  readonly ledger: LedgerRepo;
  /** Perf round part 2: /v1/me memberships in one joined SQL. */
  readonly memberships: MembershipsRepo;
  readonly comments: CommentsRepo;
  readonly renders: RendersRepo;
  readonly audit: AuditRepo;
  readonly subscriptions: SubscriptionsRepo;
  readonly invoices: InvoicesRepo;
  readonly settings: SettingsRepo;
  readonly webhookEvents: WebhookEventsRepo;
  /** §M7: share-link tokens (issue/verify/revoke) + presence heartbeats. */
  readonly shareTokens: ShareTokensRepo;
  readonly presence: PresenceRepo;
  /** §M1 tasks 1+2 (W1-b): workspace api-key list/tenant gate (read-only). */
  readonly apiKeys: ApiKeysRepo;
}

export function createRepos(db: StudioDb): Repos {
  return {
    projects: createProjectsRepo(db),
    versions: createVersionsRepo(db),
    leases: createLeasesRepo(db),
    assets: createAssetsRepo(db),
    threads: createThreadsRepo(db),
    runs: createRunsRepo(db),
    ledger: createLedgerRepo(db),
    memberships: createMembershipsRepo(db),
    comments: createCommentsRepo(db),
    renders: createRendersRepo(db),
    audit: createAuditRepo(db),
    subscriptions: createSubscriptionsRepo(db),
    invoices: createInvoicesRepo(db),
    settings: createSettingsRepo(db),
    webhookEvents: createWebhookEventsRepo(db),
    shareTokens: createShareTokensRepo(db),
    presence: createPresenceRepo(db),
    apiKeys: createApiKeysRepo(db),
  };
}
