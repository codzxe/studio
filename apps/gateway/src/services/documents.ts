// Documents domain service (§10.4 versioning, §13.1 documents endpoints, §12.2
// tenant-scoped queries). Owner: W4-F.
//
// Spec anchors:
//   §10.4  versions are immutable; "restore" creates a NEW version from an old
//          command log/checkpoint — history is never mutated or rewritten.
//   §13.1  GET/POST /v1/documents, GET /v1/documents/:id, versions timeline,
//          POST …/versions/:versionId/restore.
//   §12.2  every query is scoped by organization_id; composite queries only,
//          never "find by id then check". Cross-tenant ids simply miss → the
//          caller answers 404 (never confirm existence, §13.3).
//   §5.6   the `commands` table IS the WAL. The creation row records the
//          engine's `file.new` command (vendor crates/engine/src/commands.rs:530
//          — never invent command ids, docs/AGENTS.md), so a full replay from
//          revision 0 reproduces the initial canvas. NOTE (W4-F task wording):
//          the brief calls this "the WAL row for document.new"; `document.new`
//          is NOT an engine command id, so the row carries `file.new`.
//   §14.1  plan canvas ceilings 32/64/128 MP come from @studio/config
//          PLAN_LIMITS (single source of truth, limits.ts).
//
// Structure: pure helpers (cursor codec, MP gates, storage-key builder) → the
// `DocumentQueries` persistence seam (typed queries over the content schema,
// §12.2 composite scoping) with a drizzle-backed implementation → the service
// functions the routes call. Everything is injected (no I/O of its own), so
// tests run against an in-memory fake store (tests/documents.test.ts).

import { and, asc, desc, eq, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import {
  ENGINE_MAX_CANVAS_MEGAPIXELS,
  err,
  ok,
  planLimits,
  type Failure,
  type PlanId,
  type Result,
} from "@studio/config";
import {
  auditLog,
  commands,
  documentVersions,
  documents,
  type AuditLog,
  type CommandLogEntry,
  type Db,
  type Document,
  type DocumentVersion,
  type NewAuditLog,
  type NewCommandLogEntry,
  type NewDocument,
  type NewDocumentVersion,
} from "@studio/db";

// ---------------------------------------------------------------------------
// Policy constants (single values, cited; §13.3 discipline)
// ---------------------------------------------------------------------------

/**
 * Engine command recorded in the WAL for document creation. `file.new` is the
 * real engine id (vendor commands.rs:530, `{"width": n, "height": n}`); the
 * service-level "document.new" event maps onto it (§5.6 replay-safe).
 */
export const DOCUMENT_CREATE_COMMAND_NAME = "file.new";

/** §14.1 decimal megapixels: 32 MP = 32,000,000 px. */
export const MP = 1_000_000;

/** Label of the version row created together with the document (revision 1). */
export const INITIAL_VERSION_LABEL = "Initial version";

/** ContentType used for `.pcraft` bytes (engine-pool storage-adapter precedent). */
export const PCRAFT_CONTENT_TYPE = "application/octet-stream";

/** Documents list paging (§13.1 GET /v1/documents?cursor=). */
export const DEFAULT_DOCUMENTS_PAGE_SIZE = 20;
export const MAX_DOCUMENTS_PAGE_SIZE = 100;

/** Version timeline caps (§13.1 GET /v1/documents/:id/versions). */
export const DEFAULT_VERSIONS_LIMIT = 100;
export const MAX_VERSIONS_LIMIT = 200;

/** Hard cap on any encoded cursor accepted from a client (DoS guard). */
export const MAX_CURSOR_LENGTH = 1024;

/**
 * Per-side canvas cap. The engine stores raster dimensions as u16 (65535 px);
 * the MP gates below bind much tighter for real plans, this only rejects
 * absurd single sides before the multiplication can overflow intuition.
 */
export const MAX_DOCUMENT_SIDE_PX = 65535;

// ---------------------------------------------------------------------------
// Storage key builder — mirrors packages/storage keys.ts `documents/…` layout
// (RECONCILIATION: @studio/storage is not a gateway dependency, so the layout
// is mirrored locally and byte-identical: a real Storage satisfies the seam
// structurally. W2-G/W2-M fleet precedent for local structural mirrors.)
// ---------------------------------------------------------------------------

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Object key for one document version's `.pcraft` file:
 * `documents/organizations/<orgId>/documents/<docId>/<versionId>.pcraft`
 * (packages/storage keys.ts documentKey layout; §15.1 per-workspace prefixes).
 */
export function documentVersionStorageKey(input: {
  readonly organizationId: string;
  readonly documentId: string;
  readonly versionId: string;
}): Result<string> {
  for (const [field, value] of [
    ["organizationId", input.organizationId],
    ["documentId", input.documentId],
    ["versionId", input.versionId],
  ] as const) {
    if (typeof value !== "string" || !KEY_ID_PATTERN.test(value)) {
      return err("internal_error", `The ${field} is not a safe storage key component.`, {
        hint: "Document and version ids must be 1..64 chars of [A-Za-z0-9_-], starting alphanumeric.",
        retryable: false,
      });
    }
  }
  return ok(
    `documents/organizations/${input.organizationId}/documents/${input.documentId}/${input.versionId}.pcraft`,
  );
}

// ---------------------------------------------------------------------------
// List cursor codec — cursor = base64url(JSON [createdAt ISO, id])
// (deterministic keyset pagination over (createdAt DESC, id DESC)).
// ---------------------------------------------------------------------------

export interface DocumentsCursor {
  readonly createdAt: Date;
  readonly id: string;
}

const cursorPayloadSchema = z.tuple([z.string().datetime(), z.string().min(1).max(128)]);

/** Encode one row's position into the opaque cursor returned to clients. */
export function encodeDocumentsCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([createdAt.toISOString(), id]), "utf8").toString("base64url");
}

/**
 * Decode and validate a client cursor. Strict by design: a malformed cursor is
 * a 400, never a silent restart from the first page (no page skipping lies).
 */
export function decodeDocumentsCursor(cursor: string): Result<DocumentsCursor> {
  const rejected = (message: string): Failure =>
    err("validation_failed", message, {
      hint: "Pass the next_cursor value from the previous page exactly as received.",
      retryable: false,
    });
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) {
    return rejected("The list cursor is malformed.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return rejected("The list cursor is malformed.");
  }
  const parsed = cursorPayloadSchema.safeParse(decoded);
  if (!parsed.success) {
    return rejected("The list cursor is malformed.");
  }
  return ok({ createdAt: new Date(parsed.data[0]), id: parsed.data[1] });
}

// ---------------------------------------------------------------------------
// Canvas validation — plan MP ceiling first, then the §2.2 engine hard ceiling
// (gate ordering mirrors @studio/engine-client budgets.checkCanvasMegapixels;
// that package is not a gateway dependency, ceilings come from @studio/config).
// ---------------------------------------------------------------------------

export interface CanvasCheck {
  readonly megapixels: number;
}

/**
 * §14.1: max canvas 32/64/128 MP by plan. `plan_limit` (402 per the stable
 * code → status map) covers both gates: the plan ceiling and the §2.2 64 MP
 * engine ceiling the `business` plan exceeds on paper (limits.ts NOTE).
 */
export function validateCanvasMegapixels(
  width: number,
  height: number,
  plan: PlanId,
): Result<CanvasCheck> {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return err("validation_failed", "Canvas dimensions must be positive integers.", {
      retryable: false,
    });
  }
  const pixels = width * height; // ≤ 65535² ≈ 4.29e9 — safe without BigInt
  const planCeilingPx = planLimits(plan).maxCanvasMegapixels * MP;
  if (pixels > planCeilingPx) {
    return err(
      "plan_limit",
      `Canvas exceeds the ${planLimits(plan).maxCanvasMegapixels} megapixel limit of the current plan.`,
      {
        hint: "Upgrade the workspace plan or shrink the canvas (§14.1 max canvas per plan).",
        retryable: false,
      },
    );
  }
  if (pixels > ENGINE_MAX_CANVAS_MEGAPIXELS * MP) {
    return err("plan_limit", "Canvas exceeds the rendering engine's 64 megapixel ceiling.", {
      hint: "The engine caps canvases at 64 MP today (§2.2); use a smaller canvas for now.",
      retryable: false,
    });
  }
  return ok({ megapixels: pixels / MP });
}

// ---------------------------------------------------------------------------
// Injected seams (structural; local mirrors of sibling-package contracts —
// see the RECONCILIATION note in routes/documents.ts)
// ---------------------------------------------------------------------------

/**
 * Minimal manifest surface the create path needs (existence + identity). A
 * @studio/tools `TemplateManifest` satisfies this structurally.
 */
export interface TemplateManifestLike {
  readonly id: string;
  readonly version: string;
}

/** Catalog lookup by `"id@version"` (§5.5 template refs; tools TemplateCatalogLike). */
export interface TemplateCatalogLike {
  get(templateRef: string): Promise<TemplateManifestLike | undefined>;
}

/**
 * Object-storage seam for `.pcraft` version bytes (§10.3). Mirrors
 * @studio/storage's `Storage.get/put` (null on miss); the engine-pool
 * StorageLike variant resolves `undefined` — its composition adapter maps.
 */
export interface StorageLike {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, data: Uint8Array, options: { readonly contentType: string }): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Persistence seam — typed queries over the content schema (§12.2: every
// method is composite-scoped by organization_id; no find-then-check paths)
// ---------------------------------------------------------------------------

/** Row patch for the documents pointer row; only these fields are mutable. */
export interface DocumentRowPatch {
  readonly name?: string;
  readonly archivedAt?: Date | null;
  readonly currentRevision?: number;
  readonly updatedAt?: Date;
}

export interface SelectDocumentsPageInput {
  readonly organizationId: string;
  /** Fetch size; the service passes page size + 1 to detect a next page. */
  readonly limit: number;
  /** Keyset position; null starts from the newest row. */
  readonly before: DocumentsCursor | null;
  readonly includeArchived: boolean;
}

/** The query methods (what a transaction receives — no nested transactions). */
export interface DocumentQueries {
  insertDocumentRow(row: NewDocument): Promise<Document>;
  insertVersionRow(row: NewDocumentVersion): Promise<DocumentVersion>;
  insertCommandRow(row: NewCommandLogEntry): Promise<CommandLogEntry>;
  insertAuditRow(row: NewAuditLog): Promise<AuditLog>;
  /** Composite fetch (§12.2): misses cross-tenant ids. */
  selectDocument(documentId: string, organizationId: string): Promise<Document | undefined>;
  /** Composite fetch of one immutable version row. */
  selectDocumentVersion(
    documentId: string,
    organizationId: string,
    versionId: string,
  ): Promise<DocumentVersion | undefined>;
  /** Newest-first keyset page (createdAt DESC, id DESC — deterministic). */
  selectDocumentsPage(input: SelectDocumentsPageInput): Promise<readonly Document[]>;
  /** Version timeline ascending by revision (§13.1). */
  selectVersionTimeline(
    documentId: string,
    organizationId: string,
    limit: number,
  ): Promise<readonly DocumentVersion[]>;
  /** Head version row (highest revision), or undefined when none exist. */
  selectLatestVersion(
    documentId: string,
    organizationId: string,
  ): Promise<DocumentVersion | undefined>;
  /** Apply a patch to the pointer row, composite-scoped; undefined on miss. */
  updateDocumentRow(
    documentId: string,
    organizationId: string,
    patch: DocumentRowPatch,
  ): Promise<Document | undefined>;
  /**
   * Optimistic-concurrency pointer bump: only moves currentRevision when it
   * still equals `expectedRevision` (guard against concurrent restores,
   * §14.2-style idempotent money paths get the same discipline). Returns
   * undefined when the guard fails; the unique(document_id, revision) index
   * below is the second line of defence.
   */
  bumpDocumentRevision(
    documentId: string,
    organizationId: string,
    expectedRevision: number,
    newRevision: number,
    updatedAt: Date,
  ): Promise<Document | undefined>;
}

/** The seam the service consumes: queries + an all-or-nothing transaction. */
export interface DocumentsStore extends DocumentQueries {
  withTransaction<T>(operation: (tx: DocumentQueries) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Drizzle-backed implementation (real queries; composed by the root)
// ---------------------------------------------------------------------------

/** Drizzle executor: the pooled db or an open transaction (same method surface). */
type DrizzleExecutor = Parameters<Parameters<Db["transaction"]>[0]>[0];

function firstRow<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`db insert returned no row: ${what}`);
  }
  return row;
}

/** Build the query set over one drizzle executor (db or tx). */
function drizzleQueries(exec: DrizzleExecutor): DocumentQueries {
  return {
    async insertDocumentRow(row: NewDocument): Promise<Document> {
      return firstRow(await exec.insert(documents).values(row).returning(), "documents");
    },
    async insertVersionRow(row: NewDocumentVersion): Promise<DocumentVersion> {
      return firstRow(await exec.insert(documentVersions).values(row).returning(), "document_versions");
    },
    async insertCommandRow(row: NewCommandLogEntry): Promise<CommandLogEntry> {
      return firstRow(await exec.insert(commands).values(row).returning(), "commands");
    },
    async insertAuditRow(row: NewAuditLog): Promise<AuditLog> {
      return firstRow(await exec.insert(auditLog).values(row).returning(), "audit_log");
    },
    async selectDocument(documentId: string, organizationId: string): Promise<Document | undefined> {
      const rows = await exec
        .select()
        .from(documents)
        .where(and(eq(documents.id, documentId), eq(documents.organizationId, organizationId)))
        .limit(1);
      return rows[0];
    },
    async selectDocumentVersion(
      documentId: string,
      organizationId: string,
      versionId: string,
    ): Promise<DocumentVersion | undefined> {
      const rows = await exec
        .select()
        .from(documentVersions)
        .where(
          and(
            eq(documentVersions.documentId, documentId),
            eq(documentVersions.organizationId, organizationId),
            eq(documentVersions.id, versionId),
          ),
        )
        .limit(1);
      return rows[0];
    },
    async selectDocumentsPage(input: SelectDocumentsPageInput): Promise<readonly Document[]> {
      // undefined branches are skipped by drizzle's and()/or() combinators.
      const before = input.before;
      return exec
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.organizationId, input.organizationId),
            input.includeArchived ? undefined : isNull(documents.archivedAt),
            before === null
              ? undefined
              : or(
                  lt(documents.createdAt, before.createdAt),
                  and(
                    eq(documents.createdAt, before.createdAt),
                    lt(documents.id, before.id),
                  ),
                ),
          ),
        )
        .orderBy(desc(documents.createdAt), desc(documents.id))
        .limit(input.limit);
    },
    async selectVersionTimeline(
      documentId: string,
      organizationId: string,
      limit: number,
    ): Promise<readonly DocumentVersion[]> {
      return exec
        .select()
        .from(documentVersions)
        .where(
          and(
            eq(documentVersions.documentId, documentId),
            eq(documentVersions.organizationId, organizationId),
          ),
        )
        .orderBy(asc(documentVersions.revision))
        .limit(limit);
    },
    async selectLatestVersion(
      documentId: string,
      organizationId: string,
    ): Promise<DocumentVersion | undefined> {
      const rows = await exec
        .select()
        .from(documentVersions)
        .where(
          and(
            eq(documentVersions.documentId, documentId),
            eq(documentVersions.organizationId, organizationId),
          ),
        )
        .orderBy(desc(documentVersions.revision))
        .limit(1);
      return rows[0];
    },
    async updateDocumentRow(
      documentId: string,
      organizationId: string,
      patch: DocumentRowPatch,
    ): Promise<Document | undefined> {
      const rows = await exec
        .update(documents)
        .set({
          name: patch.name,
          archivedAt: patch.archivedAt,
          currentRevision: patch.currentRevision,
          updatedAt: patch.updatedAt,
        })
        .where(and(eq(documents.id, documentId), eq(documents.organizationId, organizationId)))
        .returning();
      return rows[0];
    },
    async bumpDocumentRevision(
      documentId: string,
      organizationId: string,
      expectedRevision: number,
      newRevision: number,
      updatedAt: Date,
    ): Promise<Document | undefined> {
      const rows = await exec
        .update(documents)
        .set({ currentRevision: newRevision, updatedAt })
        .where(
          and(
            eq(documents.id, documentId),
            eq(documents.organizationId, organizationId),
            eq(documents.currentRevision, expectedRevision),
          ),
        )
        .returning();
      return rows[0];
    },
  };
}

/** drizzleDocumentsStore(db) — the typed queries over the content schema. */
export function drizzleDocumentsStore(db: Db): DocumentsStore {
  return {
    ...drizzleQueries(db),
    withTransaction: <T>(operation: (tx: DocumentQueries) => Promise<T>): Promise<T> =>
      db.transaction(async (tx) => operation(drizzleQueries(tx))),
  };
}

// ---------------------------------------------------------------------------
// Service inputs / outputs
// ---------------------------------------------------------------------------

export interface DocumentsServiceDeps {
  /** Persistence seam (drizzleDocumentsStore(db) in production, fake in tests). */
  readonly store: DocumentsStore;
  /** `.pcraft` version bytes (restore copies source bytes to the new head). */
  readonly storage: StorageLike;
  /** Template catalog — validates template refs at create (§13.1). */
  readonly templates: TemplateCatalogLike;
  /** Injected clock — deterministic tests, single time source per request. */
  now(): Date;
  /** Injected id factory (uuid in production, counters in tests). */
  newId(): string;
}

export interface CreateDocumentInput {
  readonly organizationId: string;
  readonly userId: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** Canvas MP ceiling comes from the caller's plan (§14.1). */
  readonly plan: PlanId;
  /** Template ref `"id@version"` or plain id; validated via the catalog. */
  readonly templateRef?: string;
  /** §13 preamble Idempotency-Key — recorded in the audit trail (metadata only). */
  readonly idempotencyKey?: string;
}

export interface CreatedDocument {
  readonly document: Document;
  readonly version: DocumentVersion;
  readonly command: CommandLogEntry;
}

export interface ListDocumentsInput {
  readonly organizationId: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly includeArchived?: boolean;
}

export interface DocumentsPage {
  readonly documents: readonly Document[];
  readonly nextCursor: string | null;
}

export interface UpdateDocumentInput {
  readonly organizationId: string;
  readonly userId: string;
  readonly documentId: string;
  /** Rename (§13.1 PATCH); validated by the route schema, re-checked here. */
  readonly name?: string;
  /** true → archive (soft delete §12.2), false → unarchive. */
  readonly archived?: boolean;
  readonly idempotencyKey?: string;
}

export interface ListDocumentVersionsInput {
  readonly organizationId: string;
  readonly documentId: string;
  readonly limit?: number;
}

export interface RestoreVersionInput {
  readonly organizationId: string;
  readonly userId: string;
  readonly documentId: string;
  readonly versionId: string;
  readonly idempotencyKey?: string;
}

export interface RestoredDocument {
  readonly document: Document;
  readonly version: DocumentVersion;
  readonly bytesStored: number;
}

const documentNotFound = (): Failure =>
  err("not_found", "Document not found.", {
    hint: "Check the id against GET /v1/documents for this workspace.",
    retryable: false,
  });

const versionNotFound = (): Failure =>
  err("not_found", "Version not found.", {
    hint: "Check the id against GET /v1/documents/:id/versions (revision timeline).",
    retryable: false,
  });

const storeUnavailable = (): Failure =>
  err("internal_error", "The document store is unavailable.", { retryable: true });

/** Sentinel for the optimistic-revision guard inside a restore transaction. */
class RevisionConflict extends Error {
  constructor() {
    super("document revision changed concurrently");
    this.name = "RevisionConflict";
  }
}

// ---------------------------------------------------------------------------
// Create — documents row (currentRevision 1) + version row r1 + WAL row for
// the document.new creation event (commandName = engine `file.new`, §5.6)
// ---------------------------------------------------------------------------

export async function createDocument(
  deps: DocumentsServiceDeps,
  input: CreateDocumentInput,
): Promise<Result<CreatedDocument>> {
  const canvas = validateCanvasMegapixels(input.width, input.height, input.plan);
  if (!canvas.ok) {
    return canvas;
  }
  if (input.templateRef !== undefined) {
    let manifest: TemplateManifestLike | undefined;
    try {
      manifest = await deps.templates.get(input.templateRef);
    } catch {
      return err("internal_error", "The template catalog is unavailable.", { retryable: true });
    }
    if (manifest === undefined) {
      return err("validation_failed", "The template does not exist.", {
        hint: 'List the catalog with GET /v1/templates and pass template_id as "id@version" (§5.5).',
        retryable: false,
      });
    }
  }

  const documentId = deps.newId();
  const versionId = deps.newId();
  const createdAt = deps.now();
  const key = documentVersionStorageKey({
    organizationId: input.organizationId,
    documentId,
    versionId,
  });
  if (!key.ok) {
    return key;
  }

  const documentRow: NewDocument = {
    id: documentId,
    organizationId: input.organizationId,
    name: input.name,
    widthPx: input.width,
    heightPx: input.height,
    // §10.4: revision 1 exists from creation; the WAL row below advances 0 → 1.
    currentRevision: 1,
    templateId: input.templateRef ?? null,
    createdBy: input.userId,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
  };
  // checkpoint_ref null: reconstructed purely from the command log (§5.6) —
  // the engine pool materializes the .pcraft on the first attach/run and owns
  // the checkpoint_ref shape from there.
  const versionRow: NewDocumentVersion = {
    id: versionId,
    documentId,
    organizationId: input.organizationId,
    label: INITIAL_VERSION_LABEL,
    revision: 1,
    checkpointRef: null,
    storageKey: key.value,
    createdBy: input.userId,
    createdAt,
  };
  // The WAL row for the creation event (§5.6): seq 1, revision 0 → 1, result
  // non-null so full replay reproduces the canvas. params mirror the engine's
  // `file.new` surface exactly (width/height) — the template ref is recorded
  // on the documents row and applied by the first run, never on this row.
  const commandRow: NewCommandLogEntry = {
    id: deps.newId(),
    documentId,
    organizationId: input.organizationId,
    runId: null,
    seq: 1,
    commandName: DOCUMENT_CREATE_COMMAND_NAME,
    params: { width: input.width, height: input.height },
    result: {},
    revisionBefore: 0,
    revisionAfter: 1,
    createdAt,
  };
  const auditRow: NewAuditLog = {
    id: deps.newId(),
    organizationId: input.organizationId,
    actorId: input.userId,
    action: "document.create",
    target: `document:${documentId}`,
    metadata: {
      width: input.width,
      height: input.height,
      template_id: input.templateRef ?? null,
      idempotency_key: input.idempotencyKey ?? null,
    },
    createdAt,
  };

  try {
    const created = await deps.store.withTransaction(async (tx) => {
      const document = await tx.insertDocumentRow(documentRow);
      const version = await tx.insertVersionRow(versionRow);
      const command = await tx.insertCommandRow(commandRow);
      await tx.insertAuditRow(auditRow);
      return { document, version, command };
    });
    return ok(created);
  } catch {
    return err("internal_error", "The document could not be created.", { retryable: true });
  }
}

// ---------------------------------------------------------------------------
// List — keyset pagination over (createdAt DESC, id DESC), archived excluded
// unless asked (archive ≠ delete, §12.2 soft-delete marker)
// ---------------------------------------------------------------------------

function boundedLimit(limit: number | undefined, fallback: number, max: number): number {
  const requested = limit === undefined ? fallback : limit;
  if (!Number.isSafeInteger(requested) || requested < 1) {
    return fallback;
  }
  return Math.min(requested, max);
}

export async function listDocuments(
  deps: DocumentsServiceDeps,
  input: ListDocumentsInput,
): Promise<Result<DocumentsPage>> {
  let before: DocumentsCursor | null = null;
  if (input.cursor !== undefined && input.cursor !== "") {
    const decoded = decodeDocumentsCursor(input.cursor);
    if (!decoded.ok) {
      return decoded;
    }
    before = decoded.value;
  }
  const limit = boundedLimit(input.limit, DEFAULT_DOCUMENTS_PAGE_SIZE, MAX_DOCUMENTS_PAGE_SIZE);
  let rows: readonly Document[];
  try {
    rows = await deps.store.selectDocumentsPage({
      organizationId: input.organizationId,
      limit: limit + 1,
      before,
      includeArchived: input.includeArchived ?? false,
    });
  } catch {
    return storeUnavailable();
  }
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return ok({
    documents: page,
    nextCursor: hasMore && last !== undefined ? encodeDocumentsCursor(last.createdAt, last.id) : null,
  });
}

// ---------------------------------------------------------------------------
// Read — composite org-scoped fetches (§12.2)
// ---------------------------------------------------------------------------

export async function getDocument(
  deps: DocumentsServiceDeps,
  input: { readonly documentId: string; readonly organizationId: string },
): Promise<Result<Document>> {
  try {
    const document = await deps.store.selectDocument(input.documentId, input.organizationId);
    if (document === undefined) {
      return documentNotFound();
    }
    return ok(document);
  } catch {
    return storeUnavailable();
  }
}

export async function getLatestDocumentVersion(
  deps: DocumentsServiceDeps,
  input: { readonly documentId: string; readonly organizationId: string },
): Promise<Result<DocumentVersion | null>> {
  try {
    const version = await deps.store.selectLatestVersion(
      input.documentId,
      input.organizationId,
    );
    return ok(version ?? null);
  } catch {
    return storeUnavailable();
  }
}

// ---------------------------------------------------------------------------
// Update — rename / archive / unarchive; one audit row per actual transition
// ---------------------------------------------------------------------------

export async function updateDocument(
  deps: DocumentsServiceDeps,
  input: UpdateDocumentInput,
): Promise<Result<Document>> {
  if (input.name === undefined && input.archived === undefined) {
    return err("validation_failed", "Provide at least one field to update: name or archived.", {
      retryable: false,
    });
  }
  let existing: Document | undefined;
  try {
    existing = await deps.store.selectDocument(input.documentId, input.organizationId);
  } catch {
    return storeUnavailable();
  }
  if (existing === undefined) {
    return documentNotFound();
  }

  const now = deps.now();
  const patch: {
    name?: string;
    archivedAt?: Date | null;
    currentRevision?: number;
    updatedAt: Date;
  } = { updatedAt: now };
  const audits: NewAuditLog[] = [];

  if (input.name !== undefined && input.name !== existing.name) {
    patch.name = input.name;
    audits.push({
      id: deps.newId(),
      organizationId: input.organizationId,
      actorId: input.userId,
      action: "document.rename",
      target: `document:${input.documentId}`,
      metadata: { name: input.name, idempotency_key: input.idempotencyKey ?? null },
      createdAt: now,
    });
  }
  const wasArchived = existing.archivedAt !== null;
  if (input.archived !== undefined && input.archived !== wasArchived) {
    // Archive semantics = soft delete (§12.2 archived_at marker); the GDPR
    // hard-delete job owns true removal — this path never drops rows.
    patch.archivedAt = input.archived ? now : null;
    audits.push({
      id: deps.newId(),
      organizationId: input.organizationId,
      actorId: input.userId,
      action: input.archived ? "document.archive" : "document.unarchive",
      target: `document:${input.documentId}`,
      metadata: { idempotency_key: input.idempotencyKey ?? null },
      createdAt: now,
    });
  }
  if (audits.length === 0) {
    // Idempotent no-op (e.g. DELETE on an already-archived document): the
    // state is already correct, so no audit noise and no updatedAt churn.
    return ok(existing);
  }

  try {
    const updated = await deps.store.withTransaction(async (tx) => {
      const row = await tx.updateDocumentRow(input.documentId, input.organizationId, patch);
      for (const audit of audits) {
        await tx.insertAuditRow(audit);
      }
      return row;
    });
    if (updated === undefined) {
      return documentNotFound();
    }
    return ok(updated);
  } catch {
    return err("internal_error", "The document could not be updated.", { retryable: true });
  }
}

// ---------------------------------------------------------------------------
// Versions — immutable timeline ascending by revision (§10.4, §13.1)
// ---------------------------------------------------------------------------

export async function listDocumentVersions(
  deps: DocumentsServiceDeps,
  input: ListDocumentVersionsInput,
): Promise<Result<{ readonly versions: readonly DocumentVersion[] }>> {
  let document: Document | undefined;
  try {
    document = await deps.store.selectDocument(input.documentId, input.organizationId);
  } catch {
    return storeUnavailable();
  }
  if (document === undefined) {
    return documentNotFound();
  }
  try {
    const limit = boundedLimit(input.limit, DEFAULT_VERSIONS_LIMIT, MAX_VERSIONS_LIMIT);
    const versions = await deps.store.selectVersionTimeline(
      input.documentId,
      input.organizationId,
      limit,
    );
    return ok({ versions });
  } catch {
    return storeUnavailable();
  }
}

// ---------------------------------------------------------------------------
// Restore — §10.4/§13.1: restore AS A NEW VERSION. History is never mutated:
// the source row stays byte-identical, a fresh version row (revision =
// currentRevision + 1) references the source checkpoint, and the source's
// .pcraft bytes are COPIED to a new object key so the new head survives any
// future lifecycle of the source version's objects.
// ---------------------------------------------------------------------------

export async function restoreVersion(
  deps: DocumentsServiceDeps,
  input: RestoreVersionInput,
): Promise<Result<RestoredDocument>> {
  let document: Document | undefined;
  let source: DocumentVersion | undefined;
  try {
    document = await deps.store.selectDocument(input.documentId, input.organizationId);
    if (document === undefined) {
      return documentNotFound();
    }
    source = await deps.store.selectDocumentVersion(
      input.documentId,
      input.organizationId,
      input.versionId,
    );
  } catch {
    return storeUnavailable();
  }
  if (source === undefined) {
    return versionNotFound();
  }

  // Read the source version's storageKey through the injected StorageLike —
  // restores only proceed when the checkpoint bytes actually exist (§10.3).
  let bytes: Uint8Array | null;
  try {
    bytes = await deps.storage.get(source.storageKey);
  } catch {
    return err("storage_error", "The version's document file could not be read.", {
      hint: "Object storage may be briefly unavailable; retry the restore.",
      retryable: true,
    });
  }
  if (bytes === null) {
    return err("storage_error", "The version's document file is missing from object storage.", {
      hint: "The version row exists but its .pcraft object does not; contact support with the version id.",
      retryable: false,
    });
  }

  const newVersionId = deps.newId();
  const key = documentVersionStorageKey({
    organizationId: input.organizationId,
    documentId: input.documentId,
    versionId: newVersionId,
  });
  if (!key.ok) {
    return key;
  }
  try {
    await deps.storage.put(key.value, bytes, { contentType: PCRAFT_CONTENT_TYPE });
  } catch {
    return err("storage_error", "The restored version could not be written to object storage.", {
      hint: "Object storage may be briefly unavailable; retry the restore.",
      retryable: true,
    });
  }

  const expectedRevision = document.currentRevision;
  const newRevision = expectedRevision + 1;
  const createdAt = deps.now();
  // The new head is a materialized checkpoint, so it carries a checkpoint_ref
  // pointing back at the source (shape is opaque jsonb; the engine pool owns
  // the doc.save shape, this one is the restore marker, §5.6/§10.4).
  const versionRow: NewDocumentVersion = {
    id: newVersionId,
    documentId: input.documentId,
    organizationId: input.organizationId,
    label: `Restored from r${source.revision}`,
    revision: newRevision,
    checkpointRef: {
      kind: "document.restore",
      source: {
        versionId: source.id,
        revision: source.revision,
        storageKey: source.storageKey,
      },
      restoredAt: createdAt.toISOString(),
    },
    storageKey: key.value,
    createdBy: input.userId,
    createdAt,
  };
  const auditRow: NewAuditLog = {
    id: deps.newId(),
    organizationId: input.organizationId,
    actorId: input.userId,
    action: "document.restore",
    target: `document:${input.documentId}`,
    metadata: {
      source_version_id: source.id,
      source_revision: source.revision,
      new_revision: newRevision,
      idempotency_key: input.idempotencyKey ?? null,
    },
    createdAt,
  };

  try {
    const restored = await deps.store.withTransaction(async (tx) => {
      // Guard first: the revision slot is claimed only when the pointer still
      // matches the snapshot we validated bytes against (concurrent restores
      // lose exactly here and roll back; the unique (document_id, revision)
      // index is the second line of defence).
      const updated = await tx.bumpDocumentRevision(
        input.documentId,
        input.organizationId,
        expectedRevision,
        newRevision,
        createdAt,
      );
      if (updated === undefined) {
        throw new RevisionConflict();
      }
      const version = await tx.insertVersionRow(versionRow);
      await tx.insertAuditRow(auditRow);
      return { version, document: updated };
    });
    return ok({
      document: restored.document,
      version: restored.version,
      bytesStored: bytes.byteLength,
    });
  } catch (error) {
    if (error instanceof RevisionConflict) {
      // The put above is an orphan copy (harmless; swept with old objects) —
      // the transaction rolled back every row mutation.
      return err("conflict", "The document changed while the restore was applied.", {
        hint: "Reload the document and retry the restore.",
        retryable: true,
      });
    }
    return err("internal_error", "The version could not be restored.", { retryable: true });
  }
}
