// W4-P — the cross-router integration harness (§20 #1/#10/#11, §15.1/§15.2).
//
// ONE `buildApp` instance mounts EVERY landed gateway router over injected
// in-memory fakes (db/queue/billing/audit/storage), so the integration suites
// exercise the REAL route handlers, the REAL typed resource guard
// (src/authz/guard.ts), the REAL billing domain (§14.2 reserve→commit→refund
// over the append-only ledger seam) and the REAL error mapper — no network,
// no DB, no timers beyond explicit clocks (AGENTS.md test law, §21).
//
// Mounted surface (buildApp applies `mount` BEFORE registerRoutes, so these
// concrete routes win over the /v1 501 catch-all):
//   POST/GET /v1/runs, GET /v1/runs/:id, POST /v1/runs/:id/cancel   (W4-G)
//   GET    /v1/runs/:id/events (SSE §13.2 — gates only here)
//   POST/GET/PATCH/DELETE /v1/documents…                            (W4-F)
//   /v1/workspaces… + /v1/invites…                                   (W4-E)
//   POST /v1/uploads, GET /v1/assets, GET/DELETE /v1/assets/:id       (W4-I)
//
// Every auth seam resolves the SAME bearer-token session map, so one probe
// table can walk every route as the same attacker. The runs router is wrapped
// with the documented W4-C wiring contract (guard.assertCan(role,
// "runs:create", session) ahead of the handler) because the runs auth seam is
// role-less today — exactly the composition routes/index.ts must ship.
//
// Money is never faked at the boundary: `billingFromLedger` adapts the real
// @studio/billing functions over the in-memory LedgerStore (the fake only
// mirrors the credit_ledger unique(idempotency_key, kind) index).

import { isTerminal } from "@studio/agent";
import { trialGrant, trialGrantKey } from "@studio/billing";
import type {
  CreditLedgerEntry,
  CreditLedgerKind,
  LedgerStore,
} from "@studio/billing";
import { err, ok, type Result } from "@studio/config";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { createMiddleware, type MiddlewareHandler } from "hono/factory";
import { pino } from "pino";
import type {
  AgentRun,
  AgentStep,
  Asset,
  AuditLog,
  CommandLogEntry,
  Document,
  DocumentVersion,
  NewAgentRun,
  NewAsset,
  NewAuditLog,
  NewCommandLogEntry,
  NewDocument,
  NewDocumentVersion,
  RunError,
  RunStatus,
} from "@studio/db";
import type {
  PutOptions,
  SignOptions,
  SignedUrl,
  Storage,
  StorageObject,
} from "../../../../packages/storage/src/types.js";
import type { AppDeps } from "../../src/app.js";
import { buildApp } from "../../src/app.js";
import { createResourceGuard } from "../../src/authz/guard.js";
import type { GuardContext } from "../../src/authz/guard.js";
import { PERMISSIONS, type Role } from "../../src/authz/roles.js";
import { gatewayTransportSchema } from "../../src/env.js";
import { withDocumentDeps } from "../../src/routes/documents.js";
import type { Principal, PrincipalResolver } from "../../src/routes/documents.js";
import { createRunEventRoutes } from "../../src/routes/runs-events.js";
import type {
  RunEventBusLike,
  RunEventSubscriptionLike,
  RunEventsAuthLike,
  RunEventsDeps,
  RunLookupLike,
  RunOrganizationRef,
  RunEventSubscribeOptions,
} from "../../src/routes/runs-events.js";
import { mountRunRoutes } from "../../src/routes/runs.js";
import { uploadRoutes } from "../../src/routes/uploads.js";
import type { UploadsEnv } from "../../src/routes/uploads.js";
import {
  createWorkspaceAuth,
  inviteRoutes,
  workspaceRoutes,
  type AuthContext as WorkspaceAuthContext,
  type WorkspaceRoutesDeps,
} from "../../src/routes/workspaces.js";
import { createAssetsService } from "../../src/services/assets.js";
import { DEFAULT_UPLOAD_LIMITS } from "../../src/services/assets.js";
import type {
  AssetCursor,
  AssetsPage,
  AssetsService,
  AssetsStore,
  ExifStripJob,
  RegisterAssetInput,
  UploadLimitsConfig,
} from "../../src/services/assets.js";
import type {
  DocumentQueries,
  DocumentsStore,
  StorageLike,
  TemplateCatalogLike,
  TemplateManifestLike,
} from "../../src/services/documents.js";
import { billingFromLedger } from "../../src/services/runs.js";
import type {
  AuthLike,
  DocumentRef,
  EnqueueLike,
  EventBusLike,
  RunCaller,
  RunEnqueuePayload,
  RunPage,
  RunPageCursor,
  RunsStore,
} from "../../src/services/runs.js";
import type {
  AuditEntry,
  AuditLike,
  DbLike,
  InvitationRow,
  InvitationStatus,
  MemberRow,
  NewInvitationRow,
  NewMemberRow,
  NewWorkspaceRow,
  WorkspaceRole,
  WorkspaceRow,
  WorkspaceSummaryRow,
} from "../../src/services/workspaces.js";
import type { AppEnv } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures — two organizations, four roles each (§15.2 ladder)
// ---------------------------------------------------------------------------

/** uuid-shaped org ids (audit_log organization ids are uuid columns, W4-E note). */
export const ORG_A = "a0000000-0000-4000-8000-00000000000a";
export const ORG_B = "b0000000-0000-4000-8000-00000000000b";
export const ORG_NAME_A = "Alpha Atelier";
export const ORG_NAME_B = "Bravo Studio";
export const ORG_SLUG_A = "alpha-atelier";
export const ORG_SLUG_B = "bravo-studio";

export const USERS = {
  ownerA: "user-owner-a",
  adminA: "user-admin-a",
  editorA: "user-editor-a",
  viewerA: "user-viewer-a",
  ownerB: "user-owner-b",
  adminB: "user-admin-b",
  editorB: "user-editor-b",
  viewerB: "user-viewer-b",
  signupOwner: "user-signup-owner",
  signupInvitee: "user-signup-invitee",
} as const;

export const TOKENS = {
  ownerA: "tok-owner-a",
  adminA: "tok-admin-a",
  editorA: "tok-editor-a",
  viewerA: "tok-viewer-a",
  ownerB: "tok-owner-b",
  adminB: "tok-admin-b",
  editorB: "tok-editor-b",
  viewerB: "tok-viewer-b",
  signupOwner: "tok-signup-owner",
  signupInvitee: "tok-signup-invitee",
} as const;

/** Deterministic time base; a ticking clock shared by every service. */
const BASE_MS = Date.UTC(2026, 0, 12, 9, 0, 0);

/**
 * One authenticated session. Every auth seam resolves the same map, so a
 * token is a member of exactly one organization per test. `permissions`
 * models the API-key scope narrowing (§15.2/ADR-0003): when present it
 * REPLACES the member's effective grants (narrowing can never widen).
 */
export interface TestSession {
  readonly userId: string;
  readonly email: string;
  organizationId: string;
  readonly role: Role;
  readonly permissions?: readonly string[];
}

// ---------------------------------------------------------------------------
// In-memory ledger — the ONLY money fake; mirrors unique(idempotency_key, kind)
// ---------------------------------------------------------------------------

export class InMemoryLedger implements LedgerStore {
  private readonly rows: CreditLedgerEntry[] = [];
  private readonly seen = new Set<string>();

  async append(entry: CreditLedgerEntry): Promise<void> {
    if (!Number.isSafeInteger(entry.delta)) {
      throw new Error(`fake ledger: bad delta ${entry.delta}`);
    }
    const composite = `${entry.idempotencyKey}\u0000${entry.kind}`;
    if (this.seen.has(composite)) {
      // Mirrors the credit_ledger unique index (W1-F) — §14.2 rule 6.
      throw new Error(`fake ledger: duplicate append (${composite})`);
    }
    this.seen.add(composite);
    this.rows.push({ ...entry });
  }

  async balanceAfter(organizationId: string): Promise<number> {
    let sum = 0;
    for (const row of this.rows) {
      if (row.organizationId === organizationId) {
        sum += row.delta;
      }
    }
    return sum;
  }

  async findByIdempotency(idempotencyKey: string, kind: CreditLedgerKind): Promise<boolean> {
    return this.seen.has(`${idempotencyKey}\u0000${kind}`);
  }

  /** Test accessor: every appended row, insertion order (append-only, §12.2). */
  all(): readonly CreditLedgerEntry[] {
    return [...this.rows];
  }

  entriesOfKind(kind: CreditLedgerKind, organizationId?: string): readonly CreditLedgerEntry[] {
    return this.rows.filter(
      (row) =>
        row.kind === kind && (organizationId === undefined || row.organizationId === organizationId),
    );
  }
}

// ---------------------------------------------------------------------------
// Runs fakes (seam shapes from src/services/runs.ts)
// ---------------------------------------------------------------------------

/** Postgres 23505 stand-in — walks the same cause chain as isUniqueViolation. */
class UniqueViolationError extends Error {
  readonly code = "23505";
}

export class FakeRunsStore implements RunsStore {
  private readonly runs: AgentRun[] = [];
  private readonly steps: AgentStep[] = [];
  /** The runs seam re-reads documents created through the documents router. */
  private readonly documentsSource: () => readonly Document[];
  missIdempotencyLookups = 0;

  constructor(documentsSource: () => readonly Document[]) {
    this.documentsSource = documentsSource;
  }

  all(): readonly AgentRun[] {
    return [...this.runs];
  }

  async findDocument(organizationId: string, documentId: string): Promise<DocumentRef | null> {
    const doc = this.documentsSource().find(
      (row) => row.id === documentId && row.organizationId === organizationId,
    );
    return doc === undefined
      ? null
      : { currentRevision: doc.currentRevision, archived: doc.archivedAt !== null };
  }

  async findByIdempotency(organizationId: string, idempotencyKey: string): Promise<AgentRun | null> {
    if (this.missIdempotencyLookups > 0) {
      this.missIdempotencyLookups -= 1;
      return null;
    }
    return (
      this.runs.find(
        (run) => run.organizationId === organizationId && run.idempotencyKey === idempotencyKey,
      ) ?? null
    );
  }

  async insertRun(row: NewAgentRun): Promise<AgentRun> {
    const run = FakeRunsStore.materialize(row);
    // Mirrors agent_runs.idempotency_key UNIQUE (W1-E) — the §3.4 backstop.
    if (this.runs.some((existing) => existing.idempotencyKey === run.idempotencyKey)) {
      throw new UniqueViolationError("idempotency_key already taken");
    }
    this.runs.push(run);
    return run;
  }

  async getRun(organizationId: string, runId: string): Promise<AgentRun | null> {
    return this.runs.find((run) => run.organizationId === organizationId && run.id === runId) ?? null;
  }

  async listRuns(query: {
    readonly organizationId: string;
    readonly documentId?: string;
    readonly limit: number;
    readonly before?: RunPageCursor;
  }): Promise<RunPage> {
    let rows = this.runs.filter((run) => run.organizationId === query.organizationId);
    if (query.documentId !== undefined) {
      rows = rows.filter((run) => run.documentId === query.documentId);
    }
    rows.sort((left, right) => {
      const delta = right.createdAt.getTime() - left.createdAt.getTime();
      return delta !== 0 ? delta : left.id < right.id ? 1 : -1;
    });
    const before = query.before;
    if (before !== undefined) {
      rows = rows.filter(
        (run) =>
          run.createdAt.getTime() < before.createdAt.getTime() ||
          (run.createdAt.getTime() === before.createdAt.getTime() && run.id < before.id),
      );
    }
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      rows: page,
      ...(rows.length > query.limit && last !== undefined
        ? { next: { createdAt: last.createdAt, id: last.id } }
        : {}),
    };
  }

  async listSteps(organizationId: string, runId: string): Promise<readonly AgentStep[]> {
    return this.steps
      .filter((step) => step.organizationId === organizationId && step.runId === runId)
      .sort((left, right) => left.seq - right.seq);
  }

  async transitionStatus(input: {
    readonly organizationId: string;
    readonly runId: string;
    readonly from: readonly RunStatus[];
    readonly to: RunStatus;
    readonly error?: RunError;
  }): Promise<AgentRun | null> {
    const index = this.runs.findIndex(
      (run) => run.organizationId === input.organizationId && run.id === input.runId,
    );
    const current = index === -1 ? undefined : this.runs[index];
    if (current === undefined || !input.from.includes(current.status)) {
      return null;
    }
    const updated: AgentRun = {
      ...current,
      status: input.to,
      ...(isTerminal(input.to) ? { finishedAt: new Date() } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
    };
    this.runs[index] = updated;
    return updated;
  }

  /** Fills the DB defaults a real insert would apply (W1-E schema). */
  private static materialize(row: NewAgentRun): AgentRun {
    const now = new Date();
    return {
      id: row.id ?? `run-${randomUUID()}`,
      organizationId: row.organizationId,
      documentId: row.documentId,
      userId: row.userId,
      prompt: row.prompt,
      tier: row.tier,
      status: row.status ?? "queued",
      idempotencyKey: row.idempotencyKey,
      plan: row.plan ?? null,
      revisionBefore: row.revisionBefore,
      revisionAfter: row.revisionAfter ?? null,
      creditsReserved: row.creditsReserved ?? 0,
      creditsCharged: row.creditsCharged ?? 0,
      tokensIn: row.tokensIn ?? 0,
      tokensOut: row.tokensOut ?? 0,
      cacheHits: row.cacheHits ?? 0,
      modelCalls: row.modelCalls ?? {},
      costMicroUsd: row.costMicroUsd ?? 0,
      error: row.error ?? null,
      startedAt: row.startedAt ?? null,
      finishedAt: row.finishedAt ?? null,
      createdAt: now,
      updatedAt: now,
    };
  }
}

export class FakeEnqueue implements EnqueueLike {
  readonly calls: { queue: string; payload: RunEnqueuePayload; jobId: string }[] = [];
  failNext = false;

  async enqueue(
    queue: string,
    payload: RunEnqueuePayload,
    options: { readonly jobId: string },
  ): Promise<Result<{ readonly jobId: string }>> {
    this.calls.push({ queue, payload, jobId: options.jobId });
    if (this.failNext) {
      this.failNext = false;
      return err("engine_unavailable", "The queue broker is unavailable.", { retryable: true });
    }
    return ok({ jobId: options.jobId });
  }
}

export class FakeCancelEvents implements EventBusLike {
  readonly cancelled: { organizationId: string; runId: string; reason: string }[] = [];

  async runCancelled(input: {
    readonly organizationId: string;
    readonly runId: string;
    readonly reason: string;
  }): Promise<Result<{ readonly seq: number }>> {
    this.cancelled.push({ ...input });
    return ok({ seq: this.cancelled.length });
  }
}

// ---------------------------------------------------------------------------
// Documents fakes (seam shapes from src/services/documents.ts)
// ---------------------------------------------------------------------------

/** In-memory mirror of the SQL semantics the service relies on: composite
 * (org-scoped) filters, unique(document_id, revision), all-or-nothing tx. */
export class FakeDocumentsStore implements DocumentsStore {
  documents: Document[] = [];
  versions: DocumentVersion[] = [];
  commands: CommandLogEntry[] = [];
  audits: AuditLog[] = [];

  private copy(row: Document): Document {
    return { ...row };
  }

  async insertDocumentRow(row: NewDocument): Promise<Document> {
    const id = row.id;
    if (id === undefined) {
      throw new Error("fake-db: document row needs an explicit id");
    }
    const inserted: Document = {
      id,
      organizationId: row.organizationId,
      name: row.name,
      widthPx: row.widthPx,
      heightPx: row.heightPx,
      currentRevision: row.currentRevision ?? 0,
      templateId: row.templateId ?? null,
      createdBy: row.createdBy,
      createdAt: row.createdAt ?? new Date(BASE_MS),
      updatedAt: row.updatedAt ?? new Date(BASE_MS),
      archivedAt: row.archivedAt ?? null,
    };
    this.documents.push(inserted);
    return this.copy(inserted);
  }

  async insertVersionRow(row: NewDocumentVersion): Promise<DocumentVersion> {
    const id = row.id;
    if (id === undefined) {
      throw new Error("fake-db: version row needs an explicit id");
    }
    const revision = row.revision ?? -1;
    if (this.versions.some((v) => v.documentId === row.documentId && v.revision === revision)) {
      throw new Error("duplicate_version_revision");
    }
    const inserted: DocumentVersion = {
      id,
      documentId: row.documentId,
      organizationId: row.organizationId,
      label: row.label,
      revision,
      checkpointRef: row.checkpointRef ?? null,
      storageKey: row.storageKey,
      createdBy: row.createdBy,
      createdAt: row.createdAt ?? new Date(BASE_MS),
    };
    this.versions.push(inserted);
    return { ...inserted };
  }

  async insertCommandRow(row: NewCommandLogEntry): Promise<CommandLogEntry> {
    const id = row.id;
    if (id === undefined) {
      throw new Error("fake-db: command row needs an explicit id");
    }
    const seq = row.seq;
    if (this.commands.some((c) => c.documentId === row.documentId && c.seq === seq)) {
      throw new Error("duplicate_command_seq");
    }
    const inserted: CommandLogEntry = {
      id,
      documentId: row.documentId,
      organizationId: row.organizationId,
      runId: row.runId ?? null,
      seq,
      commandName: row.commandName,
      params: row.params ?? {},
      result: row.result ?? null,
      revisionBefore: row.revisionBefore,
      revisionAfter: row.revisionAfter,
      createdAt: row.createdAt ?? new Date(BASE_MS),
    };
    this.commands.push(inserted);
    return { ...inserted };
  }

  async insertAuditRow(row: NewAuditLog): Promise<AuditLog> {
    const inserted: AuditLog = {
      id: row.id ?? `audit-${this.audits.length + 1}`,
      organizationId: row.organizationId ?? null,
      actorId: row.actorId ?? null,
      action: row.action,
      target: row.target,
      metadata: row.metadata ?? {},
      createdAt: row.createdAt ?? new Date(BASE_MS),
    };
    this.audits.push(inserted);
    return { ...inserted };
  }

  async selectDocument(documentId: string, organizationId: string): Promise<Document | undefined> {
    const found = this.documents.find(
      (d) => d.id === documentId && d.organizationId === organizationId,
    );
    return found === undefined ? undefined : this.copy(found);
  }

  async selectDocumentVersion(
    documentId: string,
    organizationId: string,
    versionId: string,
  ): Promise<DocumentVersion | undefined> {
    const found = this.versions.find(
      (v) =>
        v.documentId === documentId && v.organizationId === organizationId && v.id === versionId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async selectDocumentsPage(input: {
    readonly organizationId: string;
    readonly limit: number;
    readonly before: { readonly createdAt: Date; readonly id: string } | null;
    readonly includeArchived: boolean;
  }): Promise<readonly Document[]> {
    const rows = this.documents
      .filter((d) => d.organizationId === input.organizationId)
      .filter((d) => input.includeArchived || d.archivedAt === null)
      .filter((d) => {
        const before = input.before;
        if (before === null) {
          return true;
        }
        const rowMs = d.createdAt.getTime();
        const cursorMs = before.createdAt.getTime();
        if (rowMs !== cursorMs) {
          return rowMs < cursorMs;
        }
        return d.id < before.id;
      })
      .sort((a, b) => {
        const dt = b.createdAt.getTime() - a.createdAt.getTime();
        if (dt !== 0) {
          return dt;
        }
        if (a.id === b.id) {
          return 0;
        }
        return a.id < b.id ? 1 : -1;
      })
      .slice(0, input.limit);
    return rows.map((row) => this.copy(row));
  }

  async selectVersionTimeline(
    documentId: string,
    organizationId: string,
    limit: number,
  ): Promise<readonly DocumentVersion[]> {
    return this.versions
      .filter((v) => v.documentId === documentId && v.organizationId === organizationId)
      .sort((a, b) => a.revision - b.revision)
      .slice(0, limit)
      .map((v) => ({ ...v }));
  }

  async selectLatestVersion(
    documentId: string,
    organizationId: string,
  ): Promise<DocumentVersion | undefined> {
    const rows = await this.selectVersionTimeline(
      documentId,
      organizationId,
      Number.MAX_SAFE_INTEGER,
    );
    return rows.length === 0 ? undefined : rows[rows.length - 1];
  }

  async updateDocumentRow(
    documentId: string,
    organizationId: string,
    patch: {
      readonly name?: string;
      readonly archivedAt?: Date | null;
      readonly currentRevision?: number;
      readonly updatedAt?: Date;
    },
  ): Promise<Document | undefined> {
    const found = this.documents.find(
      (d) => d.id === documentId && d.organizationId === organizationId,
    );
    if (found === undefined) {
      return undefined;
    }
    if (patch.name !== undefined) {
      found.name = patch.name;
    }
    if (patch.archivedAt !== undefined) {
      found.archivedAt = patch.archivedAt;
    }
    if (patch.currentRevision !== undefined) {
      found.currentRevision = patch.currentRevision;
    }
    found.updatedAt = patch.updatedAt ?? new Date();
    return this.copy(found);
  }

  async bumpDocumentRevision(
    documentId: string,
    organizationId: string,
    expectedRevision: number,
    newRevision: number,
    updatedAt: Date,
  ): Promise<Document | undefined> {
    const found = this.documents.find(
      (d) => d.id === documentId && d.organizationId === organizationId,
    );
    if (found === undefined || found.currentRevision !== expectedRevision) {
      return undefined;
    }
    found.currentRevision = newRevision;
    found.updatedAt = updatedAt;
    return this.copy(found);
  }

  async withTransaction<T>(operation: (tx: DocumentQueries) => Promise<T>): Promise<T> {
    const snapshot = {
      documents: structuredClone(this.documents),
      versions: structuredClone(this.versions),
      commands: structuredClone(this.commands),
      audits: structuredClone(this.audits),
    };
    try {
      return await operation(this);
    } catch (error) {
      // All-or-nothing, like the SQL transaction.
      this.documents = snapshot.documents;
      this.versions = snapshot.versions;
      this.commands = snapshot.commands;
      this.audits = snapshot.audits;
      throw error;
    }
  }
}

export class FakeDocumentStorage implements StorageLike {
  readonly objects = new Map<string, Uint8Array>();
  readonly puts: { key: string; bytes: number; contentType: string }[] = [];

  async get(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key) ?? null;
  }

  async put(
    key: string,
    data: Uint8Array,
    options: { readonly contentType: string },
  ): Promise<unknown> {
    this.objects.set(key, data.slice());
    this.puts.push({ key, bytes: data.byteLength, contentType: options.contentType });
    return { key, bytes: data.byteLength, contentType: options.contentType };
  }
}

export class FakeTemplateCatalog implements TemplateCatalogLike {
  private readonly manifests = new Map<string, TemplateManifestLike>();

  async get(templateRef: string): Promise<TemplateManifestLike | undefined> {
    return this.manifests.get(templateRef);
  }
}

// ---------------------------------------------------------------------------
// Workspace / membership fakes (seam shapes from src/services/workspaces.ts)
// ---------------------------------------------------------------------------

export class FakeWorkspaceDb implements DbLike {
  readonly organizations: WorkspaceRow[] = [];
  readonly memberships: MemberRow[] = [];
  readonly invitations: InvitationRow[] = [];

  constructor(private readonly clock: () => Date) {}

  async listWorkspacesForUser(userId: string): Promise<WorkspaceSummaryRow[]> {
    const rows: WorkspaceSummaryRow[] = [];
    for (const membership of this.memberships) {
      if (membership.userId !== userId) {
        continue;
      }
      const org = this.organizations.find((o) => o.id === membership.organizationId);
      if (org === undefined) {
        continue;
      }
      rows.push({
        id: org.id,
        name: org.name,
        slug: org.slug,
        createdAt: org.createdAt,
        role: membership.role,
      });
    }
    return rows;
  }

  async findWorkspace(workspaceId: string): Promise<WorkspaceRow | null> {
    return this.organizations.find((o) => o.id === workspaceId) ?? null;
  }

  async findWorkspaceBySlug(slug: string): Promise<WorkspaceRow | null> {
    return this.organizations.find((o) => o.slug === slug) ?? null;
  }

  async findMembership(userId: string, workspaceId: string): Promise<MemberRow | null> {
    return (
      this.memberships.find(
        (m) => m.userId === userId && m.organizationId === workspaceId,
      ) ?? null
    );
  }

  async listMembers(workspaceId: string): Promise<MemberRow[]> {
    return this.memberships.filter((m) => m.organizationId === workspaceId);
  }

  async listOwners(workspaceId: string): Promise<string[]> {
    return this.memberships
      .filter((m) => m.organizationId === workspaceId && m.role === "owner")
      .map((m) => m.userId);
  }

  async insertOrganization(input: NewWorkspaceRow): Promise<WorkspaceRow> {
    const created: WorkspaceRow = {
      id: input.id,
      name: input.name,
      slug: input.slug,
      logo: input.logo ?? null,
      metadata: input.metadata ?? null,
      createdAt: input.createdAt ?? this.clock(),
    };
    this.organizations.push(created);
    return created;
  }

  async insertMember(input: NewMemberRow): Promise<MemberRow> {
    const created: MemberRow = {
      id: input.id,
      organizationId: input.organizationId,
      userId: input.userId,
      role: input.role ?? "viewer",
      createdAt: input.createdAt ?? this.clock(),
    };
    this.memberships.push(created);
    return created;
  }

  async deleteMember(workspaceId: string, userId: string): Promise<boolean> {
    const index = this.memberships.findIndex(
      (m) => m.organizationId === workspaceId && m.userId === userId,
    );
    if (index === -1) {
      return false;
    }
    this.memberships.splice(index, 1);
    return true;
  }

  async updateOrganization(
    workspaceId: string,
    patch: { name?: string; metadata?: string },
  ): Promise<WorkspaceRow | null> {
    const org = this.organizations.find((o) => o.id === workspaceId);
    if (org === undefined) {
      return null;
    }
    if (patch.name !== undefined) {
      org.name = patch.name;
    }
    if (patch.metadata !== undefined) {
      org.metadata = patch.metadata;
    }
    return { ...org };
  }

  async findInvitation(token: string): Promise<InvitationRow | null> {
    return this.invitations.find((i) => i.id === token) ?? null;
  }

  async listInvitations(workspaceId: string): Promise<InvitationRow[]> {
    return this.invitations.filter((i) => i.organizationId === workspaceId);
  }

  async insertInvitation(input: NewInvitationRow): Promise<InvitationRow> {
    const created: InvitationRow = {
      id: input.id,
      organizationId: input.organizationId,
      email: input.email,
      role: input.role,
      status: input.status ?? "pending",
      expires: input.expires,
      inviterId: input.inviterId,
    };
    this.invitations.push(created);
    return created;
  }

  async updateInvitationStatus(
    token: string,
    status: InvitationStatus,
  ): Promise<InvitationRow | null> {
    const invite = this.invitations.find((i) => i.id === token);
    if (invite === undefined) {
      return null;
    }
    invite.status = status;
    return { ...invite };
  }
}

export class WorkspaceAuditRecorder implements AuditLike {
  readonly entries: AuditEntry[] = [];

  async append(entry: AuditEntry): Promise<void> {
    this.entries.push({ ...entry });
  }
}

// ---------------------------------------------------------------------------
// Asset fakes (seam shapes from src/services/assets.ts + @studio/storage)
// ---------------------------------------------------------------------------

export class FakeAssetsStore implements AssetsStore {
  readonly rows = new Map<string, Asset>();
  readonly registered: RegisterAssetInput[] = [];
  readonly audits: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly action: string;
    readonly target: string;
    readonly metadata: Record<string, unknown>;
  }[] = [];

  async registerAsset(input: RegisterAssetInput): Promise<Asset> {
    const row: Asset = {
      id: input.row.id ?? `asset-${this.rows.size + 1}`,
      organizationId: input.row.organizationId,
      uploaderId: input.row.uploaderId,
      kind: input.row.kind,
      storageKey: input.row.storageKey,
      checksum: input.row.checksum,
      bytes: input.row.bytes,
      widthPx: input.row.widthPx ?? null,
      heightPx: input.row.heightPx ?? null,
      mime: input.row.mime,
      exifStripped: input.row.exifStripped ?? false,
      origin: input.row.origin ?? "upload",
      createdAt: input.row.createdAt ?? new Date(BASE_MS),
    };
    this.rows.set(row.id, row);
    this.registered.push(input);
    return row;
  }

  async findByChecksum(organizationId: string, checksum: string): Promise<Asset | null> {
    for (const row of this.rows.values()) {
      if (row.organizationId === organizationId && row.checksum === checksum) {
        return row;
      }
    }
    return null;
  }

  async listAssets(query: {
    readonly organizationId: string;
    readonly limit: number;
    readonly cursor: AssetCursor | null;
  }): Promise<AssetsPage> {
    const rows = [...this.rows.values()]
      .filter((row) => row.organizationId === query.organizationId)
      .filter((row) => {
        if (query.cursor === null) {
          return true;
        }
        const created = row.createdAt.getTime();
        if (created !== query.cursor.createdAtMs) {
          return created < query.cursor.createdAtMs;
        }
        return row.id < query.cursor.id;
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id > b.id ? -1 : 1));
    const page = rows.slice(0, query.limit + 1);
    return { rows: page, hasMore: page.length > query.limit };
  }

  async getAsset(query: {
    readonly organizationId: string;
    readonly id: string;
  }): Promise<Asset | null> {
    const row = this.rows.get(query.id);
    return row !== undefined && row.organizationId === query.organizationId ? row : null;
  }

  async deleteAsset(query: {
    readonly organizationId: string;
    readonly id: string;
    readonly actorId: string;
    readonly metadata: Record<string, unknown>;
  }): Promise<Asset | null> {
    const row = this.rows.get(query.id);
    if (row === undefined || row.organizationId !== query.organizationId) {
      return null;
    }
    this.rows.delete(query.id);
    this.audits.push({
      organizationId: query.organizationId,
      actorId: query.actorId,
      action: "asset.delete",
      target: `asset:${query.id}`,
      metadata: query.metadata,
    });
    return row;
  }
}

export class FakeAssetStorage implements Storage {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  readonly signedKeys: { key: string; ttlSeconds: number }[] = [];
  putCount = 0;
  deleteCount = 0;

  async put(key: string, data: Uint8Array, options: PutOptions): Promise<StorageObject> {
    this.putCount += 1;
    this.objects.set(key, { bytes: data, contentType: options.contentType });
    return {
      key,
      bytes: data.byteLength,
      contentType: options.contentType,
      sha256: options.contentSha256 ?? "",
    };
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key)?.bytes ?? null;
  }

  async delete(key: string): Promise<void> {
    this.deleteCount += 1;
    this.objects.delete(key);
  }

  async sign(key: string, options: SignOptions): Promise<SignedUrl> {
    this.signedKeys.push({ key, ttlSeconds: options.ttlSeconds });
    return {
      url: `https://objects.test.example/signed?key=${encodeURIComponent(key)}`,
      expiresAt: BASE_MS + options.ttlSeconds * 1000,
    };
  }

  async *list(prefix: string): AsyncIterable<string> {
    for (const key of this.objects.keys()) {
      if (key.startsWith(prefix)) {
        yield key;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Run-event SSE fakes (§13.2 — only the gates are exercised here)
// ---------------------------------------------------------------------------

export class CountingEventBus implements RunEventBusLike {
  readonly subscriptions: { runId: string; fromSeq?: number; organizationId?: string }[] = [];

  subscribe(runId: string, options?: RunEventSubscribeOptions): RunEventSubscriptionLike {
    this.subscriptions.push({
      runId,
      ...(options?.fromSeq !== undefined ? { fromSeq: options.fromSeq } : {}),
      ...(options?.organizationId !== undefined
        ? { organizationId: options.organizationId }
        : {}),
    });
    return {
      lastDeliveredSeq: 0,
      ended: true,
      // Denied probes must never reach the bus; if one somehow does, the
      // pump ends immediately instead of hanging the test.
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: true as const, value: undefined }),
      }),
      unsubscribe() {
        // nothing to end — the pump never started
      },
    };
  }
}

class RunsLookup implements RunLookupLike {
  constructor(private readonly source: () => readonly AgentRun[]) {}

  async findRun(runId: string): Promise<RunOrganizationRef | null> {
    const run = this.source().find((r) => r.id === runId);
    return run === undefined ? null : { organizationId: run.organizationId };
  }
}

// ---------------------------------------------------------------------------
// Shared bearer-token auth adapters (one session map, every seam)
// ---------------------------------------------------------------------------

function sessionFromRequest(
  request: Request,
  sessions: ReadonlyMap<string, TestSession>,
): TestSession | undefined {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  return sessions.get(token);
}

/** §13.3 flat error envelope (W1-H mapper shape) — response view for tests. */
export interface ErrorEnvelope {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly hint?: string;
  readonly retryable?: boolean;
}

// ---------------------------------------------------------------------------
// Synthetic PNG (§21 synthetic-only fixtures; W2-O/W4-I conventions)
// ---------------------------------------------------------------------------

const CRC_TABLE: readonly number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table.push(c >>> 0);
  }
  return table;
})();

function crc32(bytes: readonly number[]): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function u32beBytes(value: number): number[] {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

function chunk(type: string, data: number[]): number[] {
  const typeBytes = [...type].map((c) => c.charCodeAt(0));
  const crc = crc32([...typeBytes, ...data]);
  return [...u32beBytes(data.length), ...typeBytes, ...data, ...u32beBytes(crc)];
}

/** A minimal valid PNG (magic-byte sniffable, far under every §20.2 cap). */
export function pngBytes(width: number, height: number): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = chunk("IHDR", [...u32beBytes(width), ...u32beBytes(height), 8, 6, 0, 0, 0]);
  const idat = chunk("IDAT", [0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]);
  const iend = chunk("IEND", []);
  return Uint8Array.from([...sig, ...ihdr, ...idat, ...iend]);
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

export interface GatewayHarness {
  readonly app: ReturnType<typeof buildApp>;
  readonly ledger: InMemoryLedger;
  readonly runsStore: FakeRunsStore;
  readonly enqueue: FakeEnqueue;
  readonly cancelEvents: FakeCancelEvents;
  readonly docsStore: FakeDocumentsStore;
  readonly docStorage: FakeDocumentStorage;
  readonly wsDb: FakeWorkspaceDb;
  readonly wsAudit: WorkspaceAuditRecorder;
  readonly assetsStore: FakeAssetsStore;
  readonly assetStorage: FakeAssetStorage;
  readonly exifJobs: ExifStripJob[];
  readonly sseBus: CountingEventBus;
  readonly sessions: ReadonlyMap<string, TestSession>;
  /** Re-binds a session's active workspace (the signup accept flow, §20 #1). */
  setSessionOrg(token: string, organizationId: string): void;
  /** Registers an extra session — e.g. an API key with narrowed scopes (§15.2). */
  addSession(token: string, session: TestSession): void;
}

export interface BuildGatewayOptions {
  /** Seed ORG_A/ORG_B rows + the full member ladder + trial grants (default). */
  readonly seedWorkspaces?: boolean;
}

export function buildGateway(options: BuildGatewayOptions = {}): GatewayHarness {
  const seedWorkspaces = options.seedWorkspaces ?? true;

  let clockTick = 0;
  const clock = (): Date => new Date(BASE_MS + (clockTick += 1) * 1_000);
  let idCounter = 0;
  const uuidId = (): string =>
    `00000000-0000-4000-8000-${String((idCounter += 1)).padStart(12, "0")}`;

  const ledger = new InMemoryLedger();
  const docsStore = new FakeDocumentsStore();
  const docStorage = new FakeDocumentStorage();
  const templates = new FakeTemplateCatalog();
  const runsStore = new FakeRunsStore(() => docsStore.documents);
  const enqueue = new FakeEnqueue();
  const cancelEvents = new FakeCancelEvents();
  const wsDb = new FakeWorkspaceDb(clock);
  const wsAudit = new WorkspaceAuditRecorder();
  const assetsStore = new FakeAssetsStore();
  const assetStorage = new FakeAssetStorage();
  const exifJobs: ExifStripJob[] = [];
  const sseBus = new CountingEventBus();

  const sessions = new Map<string, TestSession>();
  const register = (token: string, userId: string, role: Role, organizationId: string): void => {
    sessions.set(token, { userId, email: `${userId}@example.test`, organizationId, role });
  };
  register(TOKENS.ownerA, USERS.ownerA, "owner", ORG_A);
  register(TOKENS.adminA, USERS.adminA, "admin", ORG_A);
  register(TOKENS.editorA, USERS.editorA, "editor", ORG_A);
  register(TOKENS.viewerA, USERS.viewerA, "viewer", ORG_A);
  register(TOKENS.ownerB, USERS.ownerB, "owner", ORG_B);
  register(TOKENS.adminB, USERS.adminB, "admin", ORG_B);
  register(TOKENS.editorB, USERS.editorB, "editor", ORG_B);
  register(TOKENS.viewerB, USERS.viewerB, "viewer", ORG_B);
  // Signup-flow sessions start workspace-less (§20 #1: the workspace is
  // created through the API and re-bound via setSessionOrg once it exists).
  register(TOKENS.signupOwner, USERS.signupOwner, "owner", "");
  register(TOKENS.signupInvitee, USERS.signupInvitee, "viewer", "");

  if (seedWorkspaces) {
    const seedOrg = (
      id: string,
      name: string,
      slug: string,
      members: readonly { userId: string; role: WorkspaceRole }[],
    ): void => {
      wsDb.organizations.push({
        id,
        name,
        slug,
        logo: null,
        metadata: JSON.stringify({ brandTokens: {} }),
        createdAt: clock(),
      });
      for (const member of members) {
        wsDb.memberships.push({
          id: uuidId(),
          organizationId: id,
          userId: member.userId,
          role: member.role,
          createdAt: clock(),
        });
      }
    };
    seedOrg(ORG_A, ORG_NAME_A, ORG_SLUG_A, [
      { userId: USERS.ownerA, role: "owner" },
      { userId: USERS.adminA, role: "admin" },
      { userId: USERS.editorA, role: "editor" },
      { userId: USERS.viewerA, role: "viewer" },
    ]);
    seedOrg(ORG_B, ORG_NAME_B, ORG_SLUG_B, [
      { userId: USERS.ownerB, role: "owner" },
      { userId: USERS.adminB, role: "admin" },
      { userId: USERS.editorB, role: "editor" },
      { userId: USERS.viewerB, role: "viewer" },
    ]);
    // §1.4/§14.1 trial balances, appended synchronously with the SAME ledger
    // key the real trialGrant derives (trialGrantKey, §14.2 rule 6) — the
    // signup suite exercises the real grant through the route instead.
    ledger.append({
      organizationId: ORG_A,
      delta: 30,
      kind: "grant",
      idempotencyKey: trialGrantKey(ORG_A),
    });
    ledger.append({
      organizationId: ORG_B,
      delta: 30,
      kind: "grant",
      idempotencyKey: trialGrantKey(ORG_B),
    });
  }

  // --- auth adapters (one session map, every seam) ---------------------------

  const runsAuth: AuthLike = {
    async authenticate(request: Request): Promise<Result<RunCaller>> {
      const session = sessionFromRequest(request, sessions);
      if (session === undefined) {
        return err("unauthorized", "Missing or invalid credentials.", {
          hint: "Send Authorization: Bearer <token>.",
        });
      }
      return ok({ userId: session.userId, organizationId: session.organizationId });
    },
  };

  const docsAuth: PrincipalResolver = {
    async authenticate(request: Request): Promise<Result<Principal>> {
      const session = sessionFromRequest(request, sessions);
      if (session === undefined) {
        return err("unauthorized", "Missing or invalid credentials.", {
          hint: "Send Authorization: Bearer <token>.",
        });
      }
      return ok({
        organizationId: session.organizationId,
        userId: session.userId,
        plan: "business",
        role: session.role,
      });
    },
  };

  const sseAuth: RunEventsAuthLike = {
    async authenticate(request: Request) {
      const session = sessionFromRequest(request, sessions);
      return session === undefined
        ? null
        : { userId: session.userId, organizationId: session.organizationId };
    },
  };

  const wsAuth = createWorkspaceAuth((c): WorkspaceAuthContext | null => {
    const session = sessionFromRequest(c.req.raw, sessions);
    return session === undefined
      ? null
      : { userId: session.userId, email: session.email, name: session.userId };
  });

  // --- the W4-C wiring contract for runs: RBAC enforced by the guard ----------

  const runsGuard: MiddlewareHandler<AppEnv> = createMiddleware<AppEnv>(async (c, next) => {
    if (c.req.method === "POST" && c.req.path === "/v1/runs") {
      const session = sessionFromRequest(c.req.raw, sessions);
      if (session !== undefined) {
        // W4-C wiring contract (src/authz/guard.ts header): per-request guard,
        // enforce the session's OWN role + effective grants (API keys may be
        // narrower). Unauthenticated requests fall through to the route's 401.
        const guard = createResourceGuard({
          logger: c.get("logger"),
          requestId: c.get("requestId"),
        });
        const guardContext: GuardContext = {
          userId: session.userId,
          organizationId: session.organizationId,
          role: session.role,
          permissions: session.permissions ?? PERMISSIONS[session.role],
        };
        guard.assertCan(session.role, "runs:create", guardContext);
      }
    }
    await next();
  });

  // --- deps -------------------------------------------------------------------

  const runsDeps = {
    auth: runsAuth,
    billing: billingFromLedger(ledger),
    store: runsStore,
    enqueue,
    events: cancelEvents,
  };

  const docsDeps = {
    store: docsStore,
    storage: docStorage,
    templates,
    auth: docsAuth,
    now: clock,
    newId: uuidId,
  };

  const wsDeps: WorkspaceRoutesDeps = {
    db: wsDb,
    billing: {
      // The REAL trial grant over the shared ledger (§1.4 / §14.2 rule 6).
      grantTrial: (organizationId: string) => trialGrant(organizationId, ledger),
    },
    audit: wsAudit,
    auth: wsAuth,
    clock,
    newId: uuidId,
  };

  const assetsService: AssetsService = createAssetsService({
    store: assetsStore,
    storage: assetStorage,
    clock,
    newId: () => `asset-${String((idCounter += 1)).padStart(6, "0")}`,
    enqueueExifStrip: (job) => {
      exifJobs.push(job);
    },
  });

  const uploadLimits: UploadLimitsConfig = DEFAULT_UPLOAD_LIMITS;

  const uploadsMiddleware: MiddlewareHandler<UploadsEnv> = createMiddleware<UploadsEnv>(
    async (c, next) => {
      const session = sessionFromRequest(c.req.raw, sessions);
      if (session !== undefined) {
        c.set("auth", {
          userId: session.userId,
          organizationId: session.organizationId,
          role: session.role,
        });
      }
      c.set("uploadsDeps", { service: assetsService, limits: uploadLimits });
      await next();
    },
  );

  const sseDeps: RunEventsDeps = {
    auth: sseAuth,
    runLookup: new RunsLookup(() => runsStore.all()),
    bus: sseBus,
    // Never ticks here: denied probes return before any stream opens.
    heartbeatMs: 3_600_000,
  };

  // --- the app ----------------------------------------------------------------

  const app = buildApp({
    env: gatewayTransportSchema.parse({}),
    logger: pino({ enabled: false }),
    version: "0.0.0-test",
    probes: [],
    startedAt: BASE_MS,
    mount: (a) => {
      // Guard BEFORE the runs services/routes (W4-C wiring contract).
      a.use("/v1/runs", runsGuard);
      a.use("/v1/runs/*", runsGuard);
      mountRunRoutes(a, runsDeps);
      a.route("/v1", createRunEventRoutes(sseDeps));
      a.route("/v1/documents", withDocumentDeps(docsDeps));
      a.route("/v1/workspaces", workspaceRoutes(wsDeps));
      a.route("/v1/invites", inviteRoutes(wsDeps));
      // W4-I mount contract: the context middleware ahead of the bare router.
      const uploadsApp = new Hono<UploadsEnv>();
      uploadsApp.use("*", uploadsMiddleware);
      uploadsApp.route("/", uploadRoutes);
      a.route("/v1", uploadsApp);
    },
  } satisfies AppDeps);

  return {
    app,
    ledger,
    runsStore,
    enqueue,
    cancelEvents,
    docsStore,
    docStorage,
    wsDb,
    wsAudit,
    assetsStore,
    assetStorage,
    exifJobs,
    sseBus,
    sessions,
    setSessionOrg(token, organizationId) {
      const session = sessions.get(token);
      if (session === undefined) {
        throw new Error(`harness: no session registered for token ${token}`);
      }
      sessions.set(token, { ...session, organizationId });
    },
    addSession(token, session) {
      sessions.set(token, { ...session });
    },
  };
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

export function bearerHeaders(
  token: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...extra };
}

export function jsonHeaders(
  token: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return bearerHeaders(token, { "content-type": "application/json", ...extra });
}

export async function postJson(
  h: GatewayHarness,
  path: string,
  body: unknown,
  token: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return h.app.request(path, {
    method: "POST",
    headers: jsonHeaders(token, headers),
    body: JSON.stringify(body),
  });
}

export async function get(h: GatewayHarness, path: string, token: string): Promise<Response> {
  return h.app.request(path, { method: "GET", headers: bearerHeaders(token) });
}

/** Uploads one synthetic PNG through the REAL multipart route (§13.1). */
export async function uploadPng(
  h: GatewayHarness,
  token: string,
  filename = "fixture.png",
): Promise<Response> {
  const form = new FormData();
  form.append("file", new File([pngBytes(4, 3)], filename, { type: "image/png" }));
  return h.app.request("/v1/uploads", { method: "POST", body: form, headers: bearerHeaders(token) });
}
