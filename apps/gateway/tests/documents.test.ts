// Documents routes + service tests (W4-F). Deterministic, no network: the
// service runs against an in-memory fake-db store (AGENTS.md test law), and
// routes are exercised through buildApp + the `mount` seam (app.test.ts
// precedent) so the full middleware stack (request-id, error-mapper) is real.
//
// Coverage mandated by the W4-F brief:
//   - create + template path (catalog validation, alias body key)
//   - ceiling rejection (200 MP on starter; §14.1 32/64/128 + §2.2 engine gate)
//   - pagination determinism (keyset cursor, ties, malformed cursor)
//   - restore creates a NEW version — history never mutated
//   - tenant guard (composite scoping → cross-tenant answers 404, §12.2/§13.3)
//   - archive ≠ delete (soft marker only; §12.2)

import { describe, expect, it } from "vitest";
import pino from "pino";
import type { PlanId } from "@studio/config";
import type {
  AuditLog,
  CommandLogEntry,
  Document,
  DocumentVersion,
  NewAuditLog,
  NewCommandLogEntry,
  NewDocument,
  NewDocumentVersion,
} from "@studio/db";
import { buildApp } from "../src/app.js";
import type { AppDeps } from "../src/app.js";
import { gatewayTransportSchema } from "../src/env.js";
import {
  withDocumentDeps,
  type DocumentRoutesDeps,
  type MemberRole,
  type Principal,
} from "../src/routes/documents.js";
import {
  decodeDocumentsCursor,
  documentVersionStorageKey,
  encodeDocumentsCursor,
  validateCanvasMegapixels,
  type DocumentQueries,
  type DocumentsStore,
  type StorageLike,
  type TemplateCatalogLike,
  type TemplateManifestLike,
} from "../src/services/documents.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_MS = Date.UTC(2026, 0, 1);
const JSON_HEADERS = { "content-type": "application/json" } as const;

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    organizationId: "org-1",
    userId: "user-1",
    plan: "business",
    role: "owner",
    ...overrides,
  };
}

/** In-memory fake-db mirroring the SQL semantics the service relies on:
 *  composite (org-scoped) filters, unique(document_id, revision), and
 *  all-or-nothing transactions with rollback. */
class FakeDocumentsStore implements DocumentsStore {
  documents: Document[] = [];
  versions: DocumentVersion[] = [];
  commands: CommandLogEntry[] = [];
  audits: AuditLog[] = [];
  /** Test hook: the guarded revision bump reports a lost race when true. */
  bumpShouldFail = false;

  private copy(row: Document): Document {
    return { ...row };
  }

  async insertDocumentRow(row: NewDocument): Promise<Document> {
    const id = row.id;
    if (id === undefined) throw new Error("fake-db: document row needs an explicit id");
    if (this.documents.some((d) => d.id === id)) throw new Error("duplicate document id");
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
    if (id === undefined) throw new Error("fake-db: version row needs an explicit id");
    const revision = row.revision ?? -1;
    if (
      this.versions.some(
        (v) => v.documentId === row.documentId && v.revision === revision,
      )
    ) {
      // unique(document_id, revision) — the WAL/history immutability guard.
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
    if (id === undefined) throw new Error("fake-db: command row needs an explicit id");
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
      id: row.id ?? "audit-default",
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

  async selectDocument(
    documentId: string,
    organizationId: string,
  ): Promise<Document | undefined> {
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
        v.documentId === documentId &&
        v.organizationId === organizationId &&
        v.id === versionId,
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
        // Strictly after the cursor in (createdAt DESC, id DESC) order.
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
      .filter(
        (v) => v.documentId === documentId && v.organizationId === organizationId,
      )
      .sort((a, b) => a.revision - b.revision)
      .slice(0, limit)
      .map((v) => ({ ...v }));
  }

  async selectLatestVersion(
    documentId: string,
    organizationId: string,
  ): Promise<DocumentVersion | undefined> {
    const rows = await this.selectVersionTimeline(documentId, organizationId, Number.MAX_SAFE_INTEGER);
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
    if (this.bumpShouldFail) {
      return undefined;
    }
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

class FakeStorage implements StorageLike {
  objects = new Map<string, Uint8Array>();
  puts: Array<{ key: string; bytes: number; contentType: string }> = [];
  failNextGet = false;
  failNextPut = false;

  async get(key: string): Promise<Uint8Array | null> {
    if (this.failNextGet) {
      this.failNextGet = false;
      throw new Error("storage get failed");
    }
    return this.objects.get(key) ?? null;
  }

  async put(
    key: string,
    data: Uint8Array,
    options: { readonly contentType: string },
  ): Promise<unknown> {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error("storage put failed");
    }
    this.objects.set(key, data.slice());
    this.puts.push({ key, bytes: data.byteLength, contentType: options.contentType });
    return { key, bytes: data.byteLength };
  }
}

class FakeTemplates implements TemplateCatalogLike {
  manifests = new Map<string, TemplateManifestLike>();
  calls: string[] = [];

  constructor(entries: Record<string, TemplateManifestLike> = {}) {
    for (const [ref, manifest] of Object.entries(entries)) {
      this.manifests.set(ref, manifest);
    }
  }

  async get(templateRef: string): Promise<TemplateManifestLike | undefined> {
    this.calls.push(templateRef);
    return this.manifests.get(templateRef);
  }
}

class FakeAuth {
  current: { ok: true; value: Principal } | { ok: false; code: "unauthorized"; message: string };

  constructor(initial: Principal) {
    this.current = { ok: true, value: initial };
  }

  authenticate(): Promise<
    { ok: true; value: Principal } | { ok: false; code: "unauthorized"; message: string }
  > {
    return Promise.resolve(this.current);
  }
}

function makeHarness(options: {
  readonly principal?: Principal;
  readonly templates?: Record<string, TemplateManifestLike>;
} = {}) {
  let tick = 0;
  const clock = (): Date => new Date(BASE_MS + (tick += 1));
  let counter = 0;
  const newId = (): string => `id-${String((counter += 1)).padStart(4, "0")}`;
  const store = new FakeDocumentsStore();
  const storage = new FakeStorage();
  const templates = new FakeTemplates(options.templates);
  const auth = new FakeAuth(options.principal ?? principal());
  const deps: DocumentRoutesDeps = {
    store,
    storage,
    templates,
    auth,
    now: clock,
    newId,
  };
  const app = buildApp({
    env: gatewayTransportSchema.parse({}),
    logger: pino({ enabled: false }),
    version: "0.0.0-test",
    probes: [],
    startedAt: BASE_MS,
    mount: (a) => {
      a.route("/v1/documents", withDocumentDeps(deps));
    },
  });
  return { app, store, storage, templates, auth, deps };
}

interface Envelope {
  ok: boolean;
  code?: string;
  message?: string;
  hint?: string;
  retryable?: boolean;
}

interface DocumentDto {
  id: string;
  name: string;
  width_px: number;
  height_px: number;
  current_revision: number;
  template_id: string | null;
  archived_at: string | null;
}

interface VersionDto {
  id: string;
  revision: number;
  label: string;
}

async function createDocumentRequest(
  app: ReturnType<typeof buildApp>,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request("/v1/documents", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { ...JSON_HEADERS, "idempotency-key": "test-key-1" },
  });
}

/** Create one document via the API and return its ids. */
async function createDoc(
  app: ReturnType<typeof buildApp>,
  name: string,
): Promise<{ documentId: string; versionId: string }> {
  const res = await createDocumentRequest(app, { name, width: 1080, height: 1080 });
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    document: DocumentDto;
    version: VersionDto;
  };
  return { documentId: body.document.id, versionId: body.version.id };
}

/** Seed a version row + bytes directly (simulates an engine-pool checkpoint). */
function seedVersion(
  store: FakeDocumentsStore,
  storage: FakeStorage,
  input: {
    readonly documentId: string;
    readonly revision: number;
    readonly versionId: string;
    readonly bytes?: Uint8Array;
  },
): DocumentVersion {
  const row: DocumentVersion = {
    id: input.versionId,
    documentId: input.documentId,
    organizationId: "org-1",
    label: `seed r${input.revision}`,
    revision: input.revision,
    checkpointRef: { kind: "doc.save", path: "seed" },
    storageKey: `documents/organizations/org-1/documents/${input.documentId}/${input.versionId}.pcraft`,
    createdBy: "user-1",
    createdAt: new Date(BASE_MS + input.revision * 10_000),
  };
  store.versions.push({ ...row });
  if (input.bytes !== undefined) {
    storage.objects.set(row.storageKey, input.bytes);
  }
  return row;
}

// ---------------------------------------------------------------------------
// Pure service helpers
// ---------------------------------------------------------------------------

describe("validateCanvasMegapixels (§14.1 plan ceiling + §2.2 engine gate)", () => {
  it("accepts the exact plan ceiling", () => {
    const starter = validateCanvasMegapixels(4000, 8000, "starter"); // exactly 32 MP
    expect(starter).toEqual({ ok: true, value: { megapixels: 32 } });
    const pro = validateCanvasMegapixels(8000, 8000, "pro"); // exactly 64 MP
    expect(pro.ok).toBe(true);
  });

  it("rejects 200 MP on the starter plan with plan_limit (402 wire status)", () => {
    const result = validateCanvasMegapixels(20000, 10000, "starter");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("plan_limit");
      expect(result.message).toContain("32 megapixel");
    }
  });

  it("enforces the plan ladder (64 MP on pro, 128 MP on business)", () => {
    expect(validateCanvasMegapixels(8001, 8000, "pro").ok).toBe(false); // 64.008 MP > pro
    expect(validateCanvasMegapixels(11313, 11313, "business").ok).toBe(true); // 127.98 MP
    expect(validateCanvasMegapixels(11548, 11548, "business").ok).toBe(false); // 133.36 MP > 128 MP
  });

  it("rejects above the §2.2 engine ceiling even within the business plan", () => {
    const result = validateCanvasMegapixels(8000, 9000, "business"); // 72 MP ≤ 128 MP plan
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("plan_limit");
      expect(result.message).toContain("engine");
      expect(result.hint).toContain("64 MP");
    }
  });

  it("rejects non-positive or non-integer dimensions", () => {
    for (const [width, height] of [
      [0, 100],
      [100, -1],
      [1.5, 10],
    ] as const) {
      const result = validateCanvasMegapixels(width, height, "starter");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("validation_failed");
      }
    }
  });
});

describe("cursor codec (encoded createdAt+id, keyset pagination)", () => {
  it("round-trips a position", () => {
    const createdAt = new Date(BASE_MS + 5_000);
    const cursor = encodeDocumentsCursor(createdAt, "doc-0007");
    const decoded = decodeDocumentsCursor(cursor);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.id).toBe("doc-0007");
      expect(decoded.value.createdAt.toISOString()).toBe(createdAt.toISOString());
    }
  });

  it("rejects malformed cursors strictly", () => {
    for (const cursor of ["!!!", "aGk=", JSON.stringify(["nope"]), "[]", ""]) {
      const decoded = decodeDocumentsCursor(cursor);
      expect(decoded.ok).toBe(false);
      if (!decoded.ok) {
        expect(decoded.code).toBe("validation_failed");
      }
    }
  });

  it("rejects oversized cursors (DoS guard)", () => {
    const decoded = decodeDocumentsCursor("x".repeat(1025));
    expect(decoded.ok).toBe(false);
  });
});

describe("documentVersionStorageKey (keys.ts documents/ layout mirror)", () => {
  it("builds the canonical .pcraft key", () => {
    const key = documentVersionStorageKey({
      organizationId: "org-1",
      documentId: "doc-1",
      versionId: "ver-1",
    });
    expect(key).toEqual({
      ok: true,
      value: "documents/organizations/org-1/documents/doc-1/ver-1.pcraft",
    });
  });

  it("rejects unsafe id components", () => {
    for (const bad of ["../escape", "", "a b", "x/y"] as const) {
      const key = documentVersionStorageKey({
        organizationId: bad,
        documentId: "doc-1",
        versionId: "ver-1",
      });
      expect(key.ok).toBe(false);
      if (!key.ok) {
        expect(key.code).toBe("internal_error");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// POST /v1/documents — create + template path
// ---------------------------------------------------------------------------

describe("POST /v1/documents", () => {
  it("creates revision 1 with the WAL row for the creation event + audit", async () => {
    const { app, store, storage } = makeHarness();
    const res = await createDocumentRequest(app, { name: "Launch post", width: 1080, height: 1080 });
    expect(res.status).toBe(201);
    expect(res.headers.get("location")).toMatch(/^\/v1\/documents\/id-/);

    const body = (await res.json()) as { document: DocumentDto; version: VersionDto };
    expect(body.document.current_revision).toBe(1);
    expect(body.document.template_id).toBeNull();
    expect(body.version.revision).toBe(1);

    // documents row
    expect(store.documents).toHaveLength(1);
    const doc = store.documents[0];
    expect(doc?.name).toBe("Launch post");
    expect(doc?.currentRevision).toBe(1);

    // version row r1 with the canonical storage key
    expect(store.versions).toHaveLength(1);
    const version = store.versions[0];
    expect(version?.revision).toBe(1);
    expect(version?.storageKey).toBe(
      `documents/organizations/org-1/documents/${body.document.id}/${body.version.id}.pcraft`,
    );
    expect(storage.objects.size).toBe(0); // no engine bytes at gateway create time

    // WAL row: seq 1, revision 0 → 1, engine `file.new` command (§5.6)
    expect(store.commands).toHaveLength(1);
    const command = store.commands[0];
    expect(command?.seq).toBe(1);
    expect(command?.commandName).toBe("file.new");
    expect(command?.revisionBefore).toBe(0);
    expect(command?.revisionAfter).toBe(1);
    expect(command?.params).toEqual({ width: 1080, height: 1080 });
    expect(command?.result).toEqual({}); // non-null → replayable

    // §22 audit append
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]?.action).toBe("document.create");
    expect(store.audits[0]?.target).toBe(`document:${body.document.id}`);
  });

  it("accepts templateId and validates it through the injected catalog", async () => {
    const { app, store, templates } = makeHarness({
      templates: { "instagram-post@3": { id: "instagram-post", version: "3" } },
    });
    const res = await createDocumentRequest(app, {
      name: "From template",
      width: 1080,
      height: 1080,
      templateId: "instagram-post@3",
    });
    expect(res.status).toBe(201);
    expect(templates.calls).toContain("instagram-post@3");
    expect(store.documents[0]?.templateId).toBe("instagram-post@3");
  });

  it("accepts the §13.1 `template` alias body key", async () => {
    const { app, store } = makeHarness({
      templates: { "instagram-post@3": { id: "instagram-post", version: "3" } },
    });
    const res = await createDocumentRequest(app, {
      name: "Alias",
      width: 1080,
      height: 1080,
      template: "instagram-post@3",
    });
    expect(res.status).toBe(201);
    expect(store.documents[0]?.templateId).toBe("instagram-post@3");
  });

  it("rejects conflicting templateId/template values", async () => {
    const { app } = makeHarness({
      templates: {
        "instagram-post@3": { id: "instagram-post", version: "3" },
        "youtube-thumbnail@1": { id: "youtube-thumbnail", version: "1" },
      },
    });
    const res = await createDocumentRequest(app, {
      name: "Conflict",
      width: 1080,
      height: 1080,
      templateId: "instagram-post@3",
      template: "youtube-thumbnail@1",
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as Envelope;
    expect(body.code).toBe("validation_failed");
  });

  it("rejects an unknown template with 400 validation_failed", async () => {
    const { app } = makeHarness();
    const res = await createDocumentRequest(app, {
      name: "Bad template",
      width: 1080,
      height: 1080,
      templateId: "does-not-exist@1",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Envelope;
    expect(body.code).toBe("validation_failed");
    expect(body.message).toContain("template");
  });

  it("rejects 200 MP on the starter plan with 402 plan_limit", async () => {
    const { app, store } = makeHarness({ principal: principal({ plan: "starter" }) });
    const res = await createDocumentRequest(app, { name: "Huge", width: 20000, height: 10000 });
    expect(res.status).toBe(402);
    const body = (await res.json()) as Envelope;
    expect(body.code).toBe("plan_limit");
    expect(store.documents).toHaveLength(0); // nothing persisted on rejection
  });

  it("rejects above the engine ceiling within the business plan (72 MP)", async () => {
    const { app } = makeHarness(); // business plan by default
    const res = await createDocumentRequest(app, { name: "Engine cap", width: 8000, height: 9000 });
    expect(res.status).toBe(402);
    const body = (await res.json()) as Envelope;
    expect(body.code).toBe("plan_limit");
    expect(body.hint).toContain("64 MP");
  });

  it("accepts the exact plan boundary (64 MP on business)", async () => {
    const { app } = makeHarness();
    const res = await createDocumentRequest(app, { name: "Boundary", width: 8000, height: 8000 });
    expect(res.status).toBe(201);
  });

  it("maps schema failures to 422 and non-JSON bodies to 400", async () => {
    const { app } = makeHarness();
    const missingName = await createDocumentRequest(app, { width: 10, height: 10 });
    expect(missingName.status).toBe(422);
    expect(((await missingName.json()) as Envelope).code).toBe("validation_failed");

    const unknownField = await createDocumentRequest(app, {
      name: "X",
      width: 10,
      height: 10,
      nope: true,
    });
    expect(unknownField.status).toBe(422);

    const notJson = await app.request("/v1/documents", {
      method: "POST",
      body: "not-json",
      headers: JSON_HEADERS,
    });
    expect(notJson.status).toBe(400);
    expect(((await notJson.json()) as Envelope).code).toBe("validation_failed");
  });

  it("requires an authenticated, non-viewer principal", async () => {
    const viewer = makeHarness({ principal: principal({ role: "viewer" }) });
    const viewerRes = await createDocumentRequest(viewer.app, {
      name: "Nope",
      width: 10,
      height: 10,
    });
    expect(viewerRes.status).toBe(403);
    expect(((await viewerRes.json()) as Envelope).code).toBe("forbidden");

    const anon = makeHarness();
    anon.auth.current = { ok: false, code: "unauthorized", message: "Authentication required." };
    const anonRes = await createDocumentRequest(anon.app, { name: "Nope", width: 10, height: 10 });
    expect(anonRes.status).toBe(401);
    expect(((await anonRes.json()) as Envelope).code).toBe("unauthorized");
  });
});

// ---------------------------------------------------------------------------
// GET /v1/documents — paged list, pagination determinism
// ---------------------------------------------------------------------------

describe("GET /v1/documents (pagination determinism)", () => {
  async function createMany(
    count: number,
    plan: PlanId = "business",
  ): Promise<ReturnType<typeof makeHarness>> {
    const harness = makeHarness({ principal: principal({ plan }) });
    for (let i = 1; i <= count; i += 1) {
      const res = await createDocumentRequest(harness.app, {
        name: `doc-${String(i).padStart(2, "0")}`,
        width: 100,
        height: 100,
      });
      expect(res.status).toBe(201);
    }
    return harness;
  }

  it("walks keyset pages deterministically (newest first, cursor ties included)", async () => {
    const { app } = await createMany(12);
    const collected: string[] = [];

    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const path = cursor === null ? "/v1/documents?limit=5" : `/v1/documents?limit=5&cursor=${encodeURIComponent(cursor)}`;
      const res = await app.request(path);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        documents: DocumentDto[];
        next_cursor: string | null;
      };
      pages += 1;
      collected.push(...body.documents.map((d) => d.name));
      if (body.next_cursor === null) {
        break;
      }
      cursor = body.next_cursor;
    }
    expect(pages).toBe(3);
    expect(collected).toHaveLength(12);
    // Newest first, no dupes, complete — deterministic for a fixed seed.
    expect(collected).toEqual([
      "doc-12",
      "doc-11",
      "doc-10",
      "doc-09",
      "doc-08",
      "doc-07",
      "doc-06",
      "doc-05",
      "doc-04",
      "doc-03",
      "doc-02",
      "doc-01",
    ]);
  });

  it("replaying the same cursor yields the identical page", async () => {
    const { app } = await createMany(6);
    const first = (await (
      await app.request("/v1/documents?limit=4")
    ).json()) as { documents: DocumentDto[]; next_cursor: string };
    const next = (await (
      await app.request(`/v1/documents?limit=4&cursor=${encodeURIComponent(first.next_cursor ?? "")}`)
    ).json()) as { documents: DocumentDto[] };
    const replay = (await (
      await app.request(`/v1/documents?limit=4&cursor=${encodeURIComponent(first.next_cursor ?? "")}`)
    ).json()) as { documents: DocumentDto[] };
    expect(next.documents).toEqual(replay.documents);
  });

  it("breaks createdAt ties by id (descending) deterministically", async () => {
    const { app, store } = makeHarness();
    const sameTime = new Date(BASE_MS + 123_456);
    store.documents.push(
      {
        id: "doc-b1",
        organizationId: "org-1",
        name: "b1",
        widthPx: 10,
        heightPx: 10,
        currentRevision: 1,
        templateId: null,
        createdBy: "user-1",
        createdAt: sameTime,
        updatedAt: sameTime,
        archivedAt: null,
      },
      {
        id: "doc-b2",
        organizationId: "org-1",
        name: "b2",
        widthPx: 10,
        heightPx: 10,
        currentRevision: 1,
        templateId: null,
        createdBy: "user-1",
        createdAt: sameTime,
        updatedAt: sameTime,
        archivedAt: null,
      },
    );
    const res = await app.request("/v1/documents?limit=2");
    const body = (await res.json()) as { documents: DocumentDto[] };
    expect(body.documents.map((d) => d.id)).toEqual(["doc-b2", "doc-b1"]);
  });

  it("rejects malformed cursors and out-of-range limits", async () => {
    const { app } = await createMany(3);
    const badCursor = await app.request(`/v1/documents?cursor=${encodeURIComponent("not-a-cursor")}`);
    expect(badCursor.status).toBe(400);
    expect(((await badCursor.json()) as Envelope).code).toBe("validation_failed");

    const badLimit = await app.request("/v1/documents?limit=0");
    expect(badLimit.status).toBe(422);
    const hugeLimit = await app.request("/v1/documents?limit=101");
    expect(hugeLimit.status).toBe(422);
  });

  it("hides archived documents unless include_archived is set (archive ≠ delete)", async () => {
    const harness = await createMany(3);
    const { app, store } = harness;
    const docId = store.documents[0]?.id;
    expect(docId).toBeDefined();
    const del = await app.request(`/v1/documents/${docId}`, { method: "DELETE" });
    expect(del.status).toBe(200);

    const defaults = (await (await app.request("/v1/documents")).json()) as {
      documents: DocumentDto[];
    };
    expect(defaults.documents).toHaveLength(2);
    const including = (await (
      await app.request("/v1/documents?include_archived=true")
    ).json()) as { documents: DocumentDto[] };
    expect(including.documents).toHaveLength(3);
    expect(including.documents.some((d) => d.id === docId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/documents/:id — assertDocAccess + tenant guard
// ---------------------------------------------------------------------------

describe("GET /v1/documents/:id (assertDocAccess, tenant guard)", () => {
  it("returns the document with its latest version", async () => {
    const { app } = makeHarness();
    const { documentId } = await createDoc(app, "Read me");
    const res = await app.request(`/v1/documents/${documentId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      document: DocumentDto & { latest_version: VersionDto | null };
    };
    expect(body.document.id).toBe(documentId);
    expect(body.document.latest_version?.revision).toBe(1);
  });

  it("answers 404 for cross-tenant ids (never confirms existence, §13.3)", async () => {
    const harness = makeHarness();
    const { documentId } = await createDoc(harness.app, "Mine");
    harness.auth.current = {
      ok: true,
      value: principal({ organizationId: "org-2", userId: "user-2" }),
    };
    const res = await harness.app.request(`/v1/documents/${documentId}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Envelope;
    expect(body.code).toBe("not_found");
    // The other tenant's list never sees it either.
    const list = await harness.app.request("/v1/documents");
    const listBody = (await list.json()) as { documents: DocumentDto[] };
    expect(listBody.documents).toHaveLength(0);
  });

  it("answers 404 for unknown ids", async () => {
    const { app } = makeHarness();
    const res = await app.request("/v1/documents/nope");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH — rename / archive / unarchive
// ---------------------------------------------------------------------------

describe("PATCH /v1/documents/:id", () => {
  it("renames and appends a document.rename audit row", async () => {
    const { app, store } = makeHarness();
    const { documentId } = await createDoc(app, "Old name");
    const res = await app.request(`/v1/documents/${documentId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "New name" }),
      headers: JSON_HEADERS,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { document: DocumentDto };
    expect(body.document.name).toBe("New name");
    expect(store.documents[0]?.name).toBe("New name");
    expect(store.audits.some((a) => a.action === "document.rename")).toBe(true);
  });

  it("archives and unarchives via the archived flag", async () => {
    const { app, store } = makeHarness();
    const { documentId } = await createDoc(app, "Flippy");
    const archive = await app.request(`/v1/documents/${documentId}`, {
      method: "PATCH",
      body: JSON.stringify({ archived: true }),
      headers: JSON_HEADERS,
    });
    expect(archive.status).toBe(200);
    const archivedBody = (await archive.json()) as { document: DocumentDto };
    expect(archivedBody.document.archived_at).not.toBeNull();

    const unarchive = await app.request(`/v1/documents/${documentId}`, {
      method: "PATCH",
      body: JSON.stringify({ archived: false }),
      headers: JSON_HEADERS,
    });
    const unarchivedBody = (await unarchive.json()) as { document: DocumentDto };
    expect(unarchivedBody.document.archived_at).toBeNull();
    expect(store.audits.filter((a) => a.action === "document.archive")).toHaveLength(1);
    expect(store.audits.filter((a) => a.action === "document.unarchive")).toHaveLength(1);
  });

  it("treats a no-op rename as idempotent (no audit noise)", async () => {
    const { app, store } = makeHarness();
    const { documentId } = await createDoc(app, "Same");
    const before = store.audits.length;
    const res = await app.request(`/v1/documents/${documentId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Same" }),
      headers: JSON_HEADERS,
    });
    expect(res.status).toBe(200);
    expect(store.audits.length).toBe(before);
  });

  it("rejects empty patches, unknown ids and viewers", async () => {
    const { app } = makeHarness();
    const { documentId } = await createDoc(app, "Guard");
    const empty = await app.request(`/v1/documents/${documentId}`, {
      method: "PATCH",
      body: JSON.stringify({}),
      headers: JSON_HEADERS,
    });
    expect(empty.status).toBe(422);

    const unknown = await app.request("/v1/documents/nope", {
      method: "PATCH",
      body: JSON.stringify({ name: "X" }),
      headers: JSON_HEADERS,
    });
    expect(unknown.status).toBe(404);

    const viewer = makeHarness({ principal: principal({ role: "viewer" }) });
    const { documentId: viewerDoc } = await createDoc(viewer.app, "V");
    const denied = await viewer.app.request(`/v1/documents/${viewerDoc}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "X" }),
      headers: JSON_HEADERS,
    });
    expect(denied.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// DELETE — archive semantics (soft delete; §12.2 + §22 audit)
// ---------------------------------------------------------------------------

describe("DELETE /v1/documents/:id (archive ≠ delete)", () => {
  it("archives without dropping any row, keeps the doc readable, audits once", async () => {
    const { app, store } = makeHarness();
    const { documentId } = await createDoc(app, "Do not lose me");

    const del = await app.request(`/v1/documents/${documentId}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const body = (await del.json()) as { document: DocumentDto };
    expect(body.document.archived_at).not.toBeNull();

    // Soft delete: the row is still there (§12.2 — hard delete is the GDPR job).
    expect(store.documents).toHaveLength(1);
    expect(store.documents[0]?.archivedAt).not.toBeNull();

    // Archived documents stay readable by id and hidden from the default list.
    const get = await app.request(`/v1/documents/${documentId}`);
    expect(get.status).toBe(200);
    const list = (await (await app.request("/v1/documents")).json()) as {
      documents: DocumentDto[];
    };
    expect(list.documents).toHaveLength(0);

    expect(store.audits.filter((a) => a.action === "document.archive")).toHaveLength(1);

    // Idempotent: a second DELETE changes nothing and audits nothing more.
    const again = await app.request(`/v1/documents/${documentId}`, { method: "DELETE" });
    expect(again.status).toBe(200);
    expect(store.audits.filter((a) => a.action === "document.archive")).toHaveLength(1);
  });

  it("answers 404 for unknown ids and 403 for viewers", async () => {
    const { app } = makeHarness();
    const unknown = await app.request("/v1/documents/nope", { method: "DELETE" });
    expect(unknown.status).toBe(404);

    const viewer = makeHarness({ principal: principal({ role: "viewer" }) });
    const { documentId } = await createDoc(viewer.app, "V");
    const denied = await viewer.app.request(`/v1/documents/${documentId}`, { method: "DELETE" });
    expect(denied.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Versions timeline + restore-as-new-version (§10.4 immutability)
// ---------------------------------------------------------------------------

describe("GET /v1/documents/:id/versions", () => {
  it("returns the timeline ascending by revision", async () => {
    const { app, store, storage } = makeHarness();
    const { documentId, versionId } = await createDoc(app, "Timeline");
    seedVersion(store, storage, {
      documentId,
      versionId: "ver-seed-2",
      revision: 2,
      bytes: new Uint8Array([2, 2]),
    });
    const res = await app.request(`/v1/documents/${documentId}/versions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { versions: VersionDto[] };
    expect(body.versions.map((v) => v.revision)).toEqual([1, 2]);
    expect(body.versions[0]?.id).toBe(versionId);
  });

  it("is tenant-guarded and 404s for unknown documents", async () => {
    const harness = makeHarness();
    const { documentId } = await createDoc(harness.app, "T");
    harness.auth.current = {
      ok: true,
      value: principal({ organizationId: "org-2" }),
    };
    const cross = await harness.app.request(`/v1/documents/${documentId}/versions`);
    expect(cross.status).toBe(404);
    const unknown = await makeHarness().app.request("/v1/documents/nope/versions");
    expect(unknown.status).toBe(404);
  });
});

describe("POST /v1/documents/:id/versions/:versionId/restore", () => {
  async function seededHarness() {
    const harness = makeHarness();
    const { documentId, versionId } = await createDoc(harness.app, "Restorable");
    const bytesR1 = new Uint8Array([1, 1, 1]);
    // Engine-pool materializes r1's .pcraft; seed bytes for it.
    const key = documentVersionStorageKey({
      organizationId: "org-1",
      documentId,
      versionId,
    });
    if (!key.ok) {
      throw new Error("seed key failed");
    }
    harness.storage.objects.set(key.value, bytesR1);
    const v2 = seedVersion(harness.store, harness.storage, {
      documentId,
      versionId: "ver-seed-2",
      revision: 2,
      bytes: new Uint8Array([2, 2]),
    });
    return { ...harness, documentId, versionIdR1: versionId, bytesR1, v2 };
  }

  it("creates a NEW version — history is never mutated", async () => {
    const harness = await seededHarness();
    const versionsBefore = structuredClone(harness.store.versions);
    const documentsBefore = structuredClone(harness.store.documents);

    const res = await harness.app.request(
      `/v1/documents/${harness.documentId}/versions/${harness.versionIdR1}/restore`,
      { method: "POST" },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { document: DocumentDto; version: VersionDto };

    // New head: revision 3 (r1 + r2 existed), brand-new row and key.
    expect(body.document.current_revision).toBe(3);
    expect(body.version.revision).toBe(3);
    expect(body.version.id).not.toBe(harness.versionIdR1);
    expect(body.version.label).toBe("Restored from r1");
    const newKey = `documents/organizations/org-1/documents/${harness.documentId}/${body.version.id}.pcraft`;
    expect(harness.storage.puts).toContainEqual({
      key: newKey,
      bytes: harness.bytesR1.byteLength,
      contentType: "application/octet-stream",
    });
    // Byte copy: new key holds the source bytes.
    expect(Array.from(harness.storage.objects.get(newKey) ?? [])).toEqual(
      Array.from(harness.bytesR1),
    );

    // r1 and r2 are byte-identical to before (immutable history, §10.4).
    expect(harness.store.versions.slice(0, 2)).toEqual(versionsBefore);
    expect(harness.store.versions).toHaveLength(3);
    // Only the pointer row changed (current_revision), never the history rows.
    expect(harness.store.documents[0]?.currentRevision).toBe(3);
    expect(documentsBefore[0]?.currentRevision).toBe(2);

    // §22 audit for the restore.
    expect(
      harness.store.audits.some(
        (a) =>
          a.action === "document.restore" &&
          a.target === `document:${harness.documentId}`,
      ),
    ).toBe(true);
  });

  it("restores an older revision's bytes as the new head", async () => {
    const harness = await seededHarness();
    const res = await harness.app.request(
      `/v1/documents/${harness.documentId}/versions/${harness.v2.id}/restore`,
      { method: "POST" },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { version: VersionDto };
    expect(body.version.revision).toBe(3);
    expect(body.version.label).toBe("Restored from r2");
  });

  it("answers 404 for unknown versions, unknown docs and cross-tenant docs", async () => {
    const harness = await seededHarness();
    const unknownVersion = await harness.app.request(
      `/v1/documents/${harness.documentId}/versions/nope/restore`,
      { method: "POST" },
    );
    expect(unknownVersion.status).toBe(404);

    const unknownDoc = await harness.app.request(
      "/v1/documents/nope/versions/whatever/restore",
      { method: "POST" },
    );
    expect(unknownDoc.status).toBe(404);

    harness.auth.current = { ok: true, value: principal({ organizationId: "org-2" }) };
    const cross = await harness.app.request(
      `/v1/documents/${harness.documentId}/versions/${harness.versionIdR1}/restore`,
      { method: "POST" },
    );
    expect(cross.status).toBe(404);
  });

  it("answers 500 storage_error when the version bytes are missing", async () => {
    const harness = await seededHarness();
    harness.storage.objects.clear();
    const res = await harness.app.request(
      `/v1/documents/${harness.documentId}/versions/${harness.versionIdR1}/restore`,
      { method: "POST" },
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as Envelope;
    expect(body.code).toBe("storage_error");
  });

  it("answers 500 storage_error when storage read/write fails", async () => {
    const harness = await seededHarness();
    harness.storage.failNextGet = true;
    const read = await harness.app.request(
      `/v1/documents/${harness.documentId}/versions/${harness.versionIdR1}/restore`,
      { method: "POST" },
    );
    expect(read.status).toBe(500);
    expect(((await read.json()) as Envelope).code).toBe("storage_error");

    const harness2 = await seededHarness();
    harness2.storage.failNextPut = true;
    const write = await harness2.app.request(
      `/v1/documents/${harness2.documentId}/versions/${harness2.versionIdR1}/restore`,
      { method: "POST" },
    );
    expect(write.status).toBe(500);
    expect(((await write.json()) as Envelope).code).toBe("storage_error");
    // No rows were appended (the put happens before the transaction).
    expect(harness2.store.versions).toHaveLength(2);
  });

  it("loses a concurrent restore cleanly: 409 conflict with full rollback", async () => {
    const harness = await seededHarness();
    harness.store.bumpShouldFail = true; // another restore won the revision race
    const res = await harness.app.request(
      `/v1/documents/${harness.documentId}/versions/${harness.versionIdR1}/restore`,
      { method: "POST" },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as Envelope;
    expect(body.code).toBe("conflict");
    expect(body.retryable).toBe(true);

    // Rollback: no version row, no audit, no pointer move. (The orphan object
    // copy from the pre-transaction put is harmless — swept with old objects.)
    expect(harness.store.versions).toHaveLength(2);
    expect(harness.store.audits.some((a) => a.action === "document.restore")).toBe(false);
    expect(harness.store.documents[0]?.currentRevision).toBe(2);
  });

  it("requires an editor-or-better principal", async () => {
    const viewer = await seededHarness();
    viewer.auth.current = { ok: true, value: principal({ role: "viewer" }) };
    const res = await viewer.app.request(
      `/v1/documents/${viewer.documentId}/versions/${viewer.versionIdR1}/restore`,
      { method: "POST" },
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as Envelope).code).toBe("forbidden");
  });
});
