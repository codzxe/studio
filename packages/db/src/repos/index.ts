import type { StudioDb } from "../db.js";
import { type AssetsRepo, createAssetsRepo } from "./assets.js";
import { type AuditRepo, createAuditRepo } from "./audit.js";
import { type CommentsRepo, createCommentsRepo } from "./comments.js";
import { type LeasesRepo, createLeasesRepo } from "./leases.js";
import { type LedgerRepo, createLedgerRepo } from "./ledger.js";
import { type ProjectsRepo, createProjectsRepo } from "./projects.js";
import { type RendersRepo, createRendersRepo } from "./renders.js";
import { type RunsRepo, createRunsRepo } from "./runs.js";
import { type ThreadsRepo, createThreadsRepo } from "./threads.js";
import { type VersionsRepo, createVersionsRepo } from "./versions.js";

export type { WorkspaceId, Page } from "./shared.js";
export type { ProjectsRepo } from "./projects.js";
export type { VersionsRepo } from "./versions.js";
export type { LeasesRepo } from "./leases.js";
export type { AssetsRepo } from "./assets.js";
export type { ThreadsRepo } from "./threads.js";
export type {
  RunsRepo,
  RecordAppliedInput,
  RecordUndoneInput,
  PlanState,
  PlanLifecycleStatus,
} from "./runs.js";
export type { LedgerRepo } from "./ledger.js";
export type { CommentsRepo } from "./comments.js";
export type { RendersRepo } from "./renders.js";
export type { AuditRepo } from "./audit.js";

/** The full tenant-scoped repository bundle. */
export interface Repos {
  readonly projects: ProjectsRepo;
  readonly versions: VersionsRepo;
  readonly leases: LeasesRepo;
  readonly assets: AssetsRepo;
  readonly threads: ThreadsRepo;
  readonly runs: RunsRepo;
  readonly ledger: LedgerRepo;
  readonly comments: CommentsRepo;
  readonly renders: RendersRepo;
  readonly audit: AuditRepo;
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
    comments: createCommentsRepo(db),
    renders: createRendersRepo(db),
    audit: createAuditRepo(db),
  };
}
