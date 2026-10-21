// W9-H — §22 audit export + summary route tests (apps/gateway/src/routes/audit.ts).
// Deterministic fakes, no network, no DB (AGENTS.md test rules).
//
// The export route is exercised END-TO-END over the REAL W4-Q AuditService
// backed by an in-memory AuditStoreLike — the health-audit.test.ts pattern:
// the fake implements the keyset/page semantics independently of
// DrizzleAuditStore, so cursor math asserted here is the SERVICE contract.
// Only the auth seam, the 30-day counts seam and the clock are faked.
//
// Covers: pagination (cursor walk, newest first), the admin+ role gate
// (viewer/editor denied, admin/owner ok, API-key scope narrowing), tenant
// guard (cross_tenant_denied), from/to filters, CSV wire shape (header row,
// RFC 4180 escaping, same rows as JSON, X-Next-Cursor paging) and the
// summary card.
//
//   §22    audit trail exportable per workspace
//   §15.1  tenant guard — distinct cross_tenant_denied envelope
//   §15.2  RBAC enforced server-side (admin+ via the authz guard)
//   §13.3  typed envelopes on every failure

import type { Result } from "@studio/config";
import type { NewAuditLog } from "@studio/db";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { PERMISSIONS, type Role } from "../src/authz/roles.js";
import { errorMapper } from "../src/middleware/error-mapper.js";
import {
  auditRowsToCsv,
  csvEscapeField,
  mountAuditRoutes,
  SUMMARY_WINDOW_DAYS,
  type AuditActionCountsLike,
  type AuditAuthLike,
  type AuditRouteCaller,
} from "../src/routes/audit.js";
import {
  AuditService,
  type AuditPageOptions,
  type AuditRow,
  type AuditStoreLike,
} from "../src/services/audit.js";
import type { AppEnv } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG = "11111111-1111-4111-8111-111111111111";
const FOREIGN_ORG = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2025-06-15T12:00:00.000Z");
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const AUDIT_PATH = `/v1/workspaces/${ORG}/audit`;
const SUMMARY_PATH = `/v1/audit/summary/${ORG}`;
const CSV_HEADER = "id,organization_id,actor_id,action,target,metadata,created_at";

function member(role: Role, organizationId: string): AuditRouteCaller {
  return {
    userId: `user-${role}`,
    organizationId,
    role,
    permissions: PERMISSIONS[role],
  };
}

type Principal = AuditRouteCaller | "forbidden";

function defaultPrincipals(extra: Record<string, Principal> = {}): Record<string, Principal> {
  return {
    viewer: member("viewer", ORG),
    editor: member("editor", ORG),
    admin: member("admin", ORG),
    owner: member("owner", ORG),
    foreignAdmin: member("admin", FOREIGN_ORG),
    // Admin role, but an API-key session narrowed to a non-gate scope.
    adminKeyNarrow: {
      userId: "user-key-1",
      organizationId: ORG,
      role: "admin",
      permissions: ["documents:read"],
    },
    seamDenied: "forbidden",
    ...extra,
  };
}

class FakeAuth implements AuditAuthLike {
  readonly #entries: Record<string, Principal>;

  constructor(entries: Record<string, Principal>) {
    this.#entries = entries;
  }

  async authenticate(request: Request): Promise<Result<AuditRouteCaller>> {
    const header = request.headers.get("authorization") ?? "";
    const principal = header.replace(/^Bearer /, "");
    const entry = this.#entries[principal];
    if (entry === undefined) {
      return {
        ok: false,
        code: "unauthorized",
        message: "Missing or invalid credentials.",
        hint: "Send Authorization: Bearer <token>.",
        retryable: false,
      };
    }
    if (entry === "forbidden") {
      return {
        ok: false,
        code: "forbidden",
        message: "Authenticated caller is not allowed.",
        hint: "Auth seam denial (test fixture).",
        retryable: false,
      };
    }
    return { ok: true, value: entry };
  }
}

/**
 * In-memory AuditStoreLike — mirrors DrizzleAuditStore's semantics
 * independently: org-scoped, inclusive from/to, exclusive keyset `before`
 * anchor, newest-first (created_at DESC, id DESC), bounded page.
 */
class InMemoryAuditStore implements AuditStoreLike {
  readonly rows: AuditRow[] = [];

  async insert(row: NewAuditLog): Promise<void> {
    const wide = row as unknown as Record<string, unknown>;
    const id = typeof wide["id"] === "string" && wide["id"].length > 0 ? wide["id"] : randomUUID();
    this.rows.push({
      id,
      organizationId: row.organizationId,
      actorId: row.actorId,
      action: row.action,
      target: row.target ?? "platform:none",
      metadata: row.metadata,
      createdAt: row.createdAt ?? NOW,
    });
  }

  async page(organizationId: string, options: AuditPageOptions): Promise<readonly AuditRow[]> {
    const visible = this.rows.filter((row) => {
      if (row.organizationId !== organizationId) {
        return false;
      }
      if (options.from !== undefined && row.createdAt.getTime() < options.from.getTime()) {
        return false;
      }
      if (options.to !== undefined && row.createdAt.getTime() > options.to.getTime()) {
        return false;
      }
      if (options.before !== undefined) {
        const delta = row.createdAt.getTime() - options.before.createdAt.getTime();
        if (delta > 0) {
          return false;
        }
        if (delta === 0 && !(row.id < options.before.id)) {
          return false;
        }
      }
      return true;
    });
    const sorted = [...visible].sort((a, b) => {
      const delta = b.createdAt.getTime() - a.createdAt.getTime();
      return delta !== 0 ? delta : b.id.localeCompare(a.id);
    });
    return sorted.slice(0, options.limit);
  }
}

class FakeSummary implements AuditActionCountsLike {
  readonly calls: { organizationId: string; since: Date }[] = [];
  readonly #counts: Record<string, number>;

  constructor(counts: Record<string, number>) {
    this.#counts = { ...counts };
  }

  async countsByAction(query: {
    readonly organizationId: string;
    readonly since: Date;
  }): Promise<Record<string, number>> {
    this.calls.push({ organizationId: query.organizationId, since: query.since });
    return { ...this.#counts };
  }
}

interface Harness {
  readonly app: Hono<AppEnv>;
  readonly store: InMemoryAuditStore;
  readonly summary: FakeSummary;
}

function buildApp(options?: {
  readonly principals?: Record<string, Principal>;
  readonly summaryCounts?: Record<string, number>;
}): Harness {
  const log = pino({ level: "silent" });
  const app = new Hono<AppEnv>();
  // errorMapper first (outermost) — error-mapper.ts registration contract.
  app.use("*", errorMapper(log));
  // W1-H seam stand-in: every request gets a request id + request logger
  // (the authz guard needs both; AppEnv declares them non-optional).
  app.use("*", async (c, next) => {
    c.set("requestId", "test-req-1");
    c.set("logger", log);
    await next();
  });
  const store = new InMemoryAuditStore();
  const summary = new FakeSummary(
    options?.summaryCounts ?? { "auth.login": 2, "role.changed": 1 },
  );
  mountAuditRoutes(app, {
    auth: new FakeAuth(options?.principals ?? defaultPrincipals()),
    // The REAL §22 service over the fake store — the route's export seam.
    audit: new AuditService({ store, now: () => NOW }),
    summary,
    now: () => NOW.getTime(),
  });
  return { app, store, summary };
}

interface SeedRow {
  readonly id?: string;
  readonly action: string;
  readonly target?: string;
  readonly at: Date;
  readonly org?: string | null;
  readonly actor?: string | null;
  readonly metadata?: unknown;
}

function seed(store: InMemoryAuditStore, row: SeedRow): void {
  store.insert({
    ...(row.id !== undefined ? { id: row.id } : {}),
    organizationId: row.org ?? ORG,
    actorId: row.actor ?? "user-actor",
    action: row.action,
    target: row.target ?? "platform:none",
    metadata: row.metadata ?? {},
    createdAt: row.at,
  } as NewAuditLog);
}

/** Five rows, 1h apart, oldest first: row-1 … row-5 (newest = row-5). */
function seedTrail(store: InMemoryAuditStore): void {
  const actions = [
    "auth.login",
    "role.changed",
    "api_key.created",
    "export.created",
    "credit.adjustment",
  ];
  actions.forEach((action, index) => {
    seed(store, {
      id: `row-${index + 1}`,
      action,
      target: `document:d-${index + 1}`,
      at: new Date(NOW.getTime() - (5 - index) * HOUR_MS),
      metadata: { seq: index + 1 },
    });
  });
}

function get(app: Hono<AppEnv>, path: string, principal: string | null): Promise<Response> {
  return app.request(path, principal === null ? undefined : {
    headers: { authorization: `Bearer ${principal}` },
  });
}

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function rowIds(body: Record<string, unknown>): string[] {
  const rows = body["rows"];
  expect(Array.isArray(rows)).toBe(true);
  return (rows as Record<string, unknown>[]).map((row) => {
    expect(typeof row["id"]).toBe("string");
    return row["id"] as string;
  });
}

/** Splits a well-formed CSV body (CRLF, trailing CRLF) into its lines. */
function csvLines(text: string): string[] {
  expect(text.endsWith("\r\n")).toBe(true);
  return text.slice(0, -2).split("\r\n");
}

// ---------------------------------------------------------------------------
// Role gate (admin+ via the authz guard)
// ---------------------------------------------------------------------------

describe("GET /v1/workspaces/:id/audit — admin+ role gate", () => {
  it.each([
    { principal: "viewer", status: 403 },
    { principal: "editor", status: 403 },
    { principal: "admin", status: 200 },
    { principal: "owner", status: 200 },
  ])("$principal → $status", async ({ principal, status }) => {
    const { app, store } = buildApp();
    seedTrail(store);
    const res = await get(app, AUDIT_PATH, principal);
    expect(res.status).toBe(status);
    const body = await jsonBody(res);
    expect(body["ok"]).toBe(status === 200 ? undefined : false);
    if (status === 403) {
      expect(body["code"]).toBe("forbidden");
    } else {
      expect(rowIds(body)).toHaveLength(5);
    }
  });

  it("denies a viewer on the summary route too", async () => {
    const { app } = buildApp();
    const res = await get(app, SUMMARY_PATH, "viewer");
    expect(res.status).toBe(403);
    expect((await jsonBody(res))["code"]).toBe("forbidden");
  });

  it("denies an admin API-key session narrowed below the gate permission", async () => {
    const { app, store } = buildApp();
    seedTrail(store);
    const res = await get(app, AUDIT_PATH, "adminKeyNarrow");
    expect(res.status).toBe(403);
    const body = await jsonBody(res);
    expect(body["code"]).toBe("forbidden");
    expect(String(body["hint"])).toContain("API key");
  });
});

// ---------------------------------------------------------------------------
// Tenant guard (§15.1 — distinct cross_tenant_denied)
// ---------------------------------------------------------------------------

describe("tenant guard", () => {
  it("refuses a foreign workspace's audit trail", async () => {
    const { app, store } = buildApp();
    seedTrail(store);
    const res = await get(app, AUDIT_PATH, "foreignAdmin");
    expect(res.status).toBe(403);
    const body = await jsonBody(res);
    expect(body["ok"]).toBe(false);
    expect(body["code"]).toBe("cross_tenant_denied");
  });

  it("refuses a foreign workspace's summary card", async () => {
    const { app } = buildApp();
    const res = await get(app, SUMMARY_PATH, "foreignAdmin");
    expect(res.status).toBe(403);
    expect((await jsonBody(res))["code"]).toBe("cross_tenant_denied");
  });
});

// ---------------------------------------------------------------------------
// Auth seam envelopes
// ---------------------------------------------------------------------------

describe("auth seam", () => {
  it("returns 401 without credentials", async () => {
    const { app } = buildApp();
    const res = await get(app, AUDIT_PATH, null);
    expect(res.status).toBe(401);
    const body = await jsonBody(res);
    expect(body["ok"]).toBe(false);
    expect(body["code"]).toBe("unauthorized");
  });

  it("maps a seam-level forbidden failure to 403", async () => {
    const { app } = buildApp();
    const res = await get(app, AUDIT_PATH, "seamDenied");
    expect(res.status).toBe(403);
    expect((await jsonBody(res))["code"]).toBe("forbidden");
  });
});

// ---------------------------------------------------------------------------
// Pagination (cursor-paged, newest first)
// ---------------------------------------------------------------------------

describe("pagination", () => {
  it("walks pages newest-first without duplicates and stops cleanly", async () => {
    const { app, store } = buildApp();
    seedTrail(store);

    const page1 = await get(app, `${AUDIT_PATH}?limit=2`, "admin");
    expect(page1.status).toBe(200);
    const body1 = await jsonBody(page1);
    expect(rowIds(body1)).toEqual(["row-5", "row-4"]);
    const cursor1 = body1["next_cursor"];
    expect(typeof cursor1).toBe("string");

    const page2 = await get(
      app,
      `${AUDIT_PATH}?limit=2&cursor=${encodeURIComponent(cursor1 as string)}`,
      "admin",
    );
    const body2 = await jsonBody(page2);
    expect(rowIds(body2)).toEqual(["row-3", "row-2"]);
    const cursor2 = body2["next_cursor"];
    expect(typeof cursor2).toBe("string");

    const page3 = await get(
      app,
      `${AUDIT_PATH}?limit=2&cursor=${encodeURIComponent(cursor2 as string)}`,
      "admin",
    );
    const body3 = await jsonBody(page3);
    expect(rowIds(body3)).toEqual(["row-1"]);
    expect("next_cursor" in body3).toBe(false);

    const all = [...rowIds(body1), ...rowIds(body2), ...rowIds(body3)];
    expect(new Set(all).size).toBe(5);
  });

  it("caps limit at the §22 page bound with a 422", async () => {
    const { app } = buildApp();
    expect((await get(app, `${AUDIT_PATH}?limit=501`, "admin")).status).toBe(422);
    expect((await get(app, `${AUDIT_PATH}?limit=0`, "admin")).status).toBe(422);
  });

  it("rejects a malformed cursor with the service's invalid_cursor code", async () => {
    const { app } = buildApp();
    const res = await get(app, `${AUDIT_PATH}?cursor=not-a-cursor!!`, "admin");
    expect(res.status).toBe(422);
    expect((await jsonBody(res))["code"]).toBe("invalid_cursor");
  });

  it("rejects an over-long workspace id with 422", async () => {
    const { app } = buildApp();
    const res = await get(
      app,
      `/v1/workspaces/${"x".repeat(65)}/audit`,
      "admin",
    );
    expect(res.status).toBe(422);
    expect((await jsonBody(res))["code"]).toBe("validation_failed");
  });
});

// ---------------------------------------------------------------------------
// from/to filters (inclusive ISO-8601-Z bounds)
// ---------------------------------------------------------------------------

describe("from/to filters", () => {
  const T0 = new Date(NOW.getTime() - 3 * DAY_MS);
  const T1 = new Date(NOW.getTime() - 1 * DAY_MS);
  const T2 = NOW;

  function seedWindow(store: InMemoryAuditStore): void {
    seed(store, { id: "f-old", action: "auth.login", at: T0 });
    seed(store, { id: "f-mid", action: "auth.logout", at: T1 });
    seed(store, { id: "f-new", action: "role.changed", at: T2 });
  }

  it("from+to bound the window inclusively on both ends", async () => {
    const { app, store } = buildApp();
    seedWindow(store);
    const res = await get(
      app,
      `${AUDIT_PATH}?from=${T1.toISOString()}&to=${T1.toISOString()}`,
      "admin",
    );
    expect(res.status).toBe(200);
    expect(rowIds(await jsonBody(res))).toEqual(["f-mid"]);
  });

  it("from alone keeps everything at or after the bound", async () => {
    const { app, store } = buildApp();
    seedWindow(store);
    const res = await get(app, `${AUDIT_PATH}?from=${T1.toISOString()}`, "admin");
    expect(rowIds(await jsonBody(res))).toEqual(["f-new", "f-mid"]);
  });

  it("to alone keeps everything at or before the bound", async () => {
    const { app, store } = buildApp();
    seedWindow(store);
    const res = await get(app, `${AUDIT_PATH}?to=${T1.toISOString()}`, "admin");
    expect(rowIds(await jsonBody(res))).toEqual(["f-mid", "f-old"]);
  });

  it("from after to is a 422 invalid_window (service contract)", async () => {
    const { app, store } = buildApp();
    seedWindow(store);
    const res = await get(
      app,
      `${AUDIT_PATH}?from=${T2.toISOString()}&to=${T0.toISOString()}`,
      "admin",
    );
    expect(res.status).toBe(422);
    expect((await jsonBody(res))["code"]).toBe("invalid_window");
  });

  it("a non-ISO timestamp fails boundary validation", async () => {
    const { app } = buildApp();
    const res = await get(app, `${AUDIT_PATH}?from=yesterday`, "admin");
    expect(res.status).toBe(422);
    expect((await jsonBody(res))["code"]).toBe("validation_failed");
  });
});

// ---------------------------------------------------------------------------
// CSV export (?format=csv) — §22 exportable per workspace
// ---------------------------------------------------------------------------

describe("CSV export", () => {
  it("serves the same rows as text/csv with a header row and a download name", async () => {
    const { app, store } = buildApp();
    seedTrail(store);

    const csvRes = await get(app, `${AUDIT_PATH}?format=csv`, "admin");
    expect(csvRes.status).toBe(200);
    expect(csvRes.headers.get("Content-Type")).toContain("text/csv");
    expect(csvRes.headers.get("Content-Type")).toContain("charset=utf-8");
    const disposition = csvRes.headers.get("Content-Disposition") ?? "";
    expect(disposition).toMatch(/^attachment; filename="audit-export-/);
    expect(disposition).toMatch(/\.csv"$/);

    const lines = csvLines(await csvRes.text());
    expect(lines[0]).toBe(CSV_HEADER);
    expect(lines).toHaveLength(6); // header + 5 rows

    const jsonRes = await get(app, AUDIT_PATH, "admin");
    const jsonIds = rowIds(await jsonBody(jsonRes));
    expect(lines.slice(1).map((line) => line.split(",")[0])).toEqual(jsonIds);
  });

  it("writes an empty cell for a null actor_id", async () => {
    const { app, store } = buildApp();
    seed(store, { id: "n-1", action: "auth.login", at: NOW, actor: null });
    const res = await get(app, `${AUDIT_PATH}?format=csv`, "admin");
    const [line] = csvLines(await res.text()).slice(1);
    expect(line).toContain(",,auth.login,platform:none,");
  });

  it("exports metadata as one JSON cell with RFC 4180 escaping", async () => {
    const { app, store } = buildApp();
    seed(store, {
      id: "m-1",
      action: "credit.adjustment",
      target: "ledger:abc",
      at: NOW,
      metadata: { note: 'say "hi", ok' },
    });
    const res = await get(app, `${AUDIT_PATH}?format=csv`, "admin");
    const [line] = csvLines(await res.text()).slice(1);
    const json = JSON.stringify({ note: 'say "hi", ok' });
    const expectedCell = `"${json.replace(/"/g, '""')}"`;
    const expectedLine = [
      "m-1",
      ORG,
      "user-actor",
      "credit.adjustment",
      "ledger:abc",
      expectedCell,
      NOW.toISOString(),
    ].join(",");
    expect(line).toBe(expectedLine);
  });

  it("pages via the X-Next-Cursor header (raw CSV body carries no envelope)", async () => {
    const { app, store } = buildApp();
    seedTrail(store);

    const first = await get(app, `${AUDIT_PATH}?format=csv&limit=2`, "admin");
    const cursor1 = first.headers.get("X-Next-Cursor");
    expect(typeof cursor1).toBe("string");
    expect(csvLines(await first.text())).toHaveLength(3); // header + row-5, row-4

    const second = await get(
      app,
      `${AUDIT_PATH}?format=csv&limit=2&cursor=${encodeURIComponent(cursor1 as string)}`,
      "admin",
    );
    const cursor2 = second.headers.get("X-Next-Cursor");
    expect(typeof cursor2).toBe("string");
    expect(csvLines(await second.text())).toHaveLength(3); // header + row-3, row-2

    const third = await get(
      app,
      `${AUDIT_PATH}?format=csv&limit=2&cursor=${encodeURIComponent(cursor2 as string)}`,
      "admin",
    );
    expect(third.headers.get("X-Next-Cursor")).toBeNull();
    expect(csvLines(await third.text())).toHaveLength(2); // header + row-1
  });

  it("downloads a header-only file for an empty trail", async () => {
    const { app } = buildApp();
    const res = await get(app, `${AUDIT_PATH}?format=csv`, "admin");
    expect(res.status).toBe(200);
    expect(csvLines(await res.text())).toEqual([CSV_HEADER]);
  });
});

// ---------------------------------------------------------------------------
// csvEscapeField / auditRowsToCsv — pure wire codec (table-driven)
// ---------------------------------------------------------------------------

describe("csvEscapeField (RFC 4180)", () => {
  it.each([
    ["plain", "plain"],
    ["a,b", '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ["two\nlines", '"two\nlines"'],
    ["car\rriage", '"car\rriage"'],
    ["", ""],
    ["tab\tthere", "tab\tthere"],
  ])("%j → %j", (input, expected) => {
    expect(csvEscapeField(input)).toBe(expected);
  });
});

describe("auditRowsToCsv (pure)", () => {
  it("renders a full row: header, empty actor cell, JSON metadata cell", () => {
    const csv = auditRowsToCsv([
      {
        id: "row-1",
        organization_id: ORG,
        actor_id: null,
        action: "export.created",
        target: "document:d-1",
        metadata: { k: "x" },
        created_at: "2025-06-15T12:00:00.000Z",
      },
    ]);
    expect(csv).toBe(
      `${CSV_HEADER}\r\n` +
        `row-1,${ORG},,export.created,document:d-1,"{""k"":""x""}",2025-06-15T12:00:00.000Z\r\n`,
    );
  });

  it("renders a header-only file for zero rows", () => {
    expect(auditRowsToCsv([])).toBe(`${CSV_HEADER}\r\n`);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/audit/summary/:id — 30-day counts by action (admin tooling card)
// ---------------------------------------------------------------------------

describe("GET /v1/audit/summary/:id", () => {
  it("returns 30-day counts by action for an admin", async () => {
    const { app, summary } = buildApp({ summaryCounts: { "role.changed": 1, "auth.login": 2 } });
    const res = await get(app, SUMMARY_PATH, "admin");
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body["window_days"]).toBe(30);
    expect(body["since"]).toBe(
      new Date(NOW.getTime() - SUMMARY_WINDOW_DAYS * DAY_MS).toISOString(),
    );
    expect(body["total_events"]).toBe(3);
    expect(body["by_action"]).toEqual({ "auth.login": 2, "role.changed": 1 });

    // The seam is called for the caller's workspace with the frozen clock.
    expect(summary.calls).toHaveLength(1);
    expect(summary.calls[0]?.organizationId).toBe(ORG);
    expect(summary.calls[0]?.since.getTime()).toBe(
      NOW.getTime() - SUMMARY_WINDOW_DAYS * DAY_MS,
    );
  });

  it("sums to total_events and sorts by_action keys deterministically", async () => {
    const { app } = buildApp({
      summaryCounts: { "z.last": 2, "a.first": 1, "m.mid": 3 },
    });
    const body = await jsonBody(await get(app, SUMMARY_PATH, "owner"));
    expect(body["by_action"]).toEqual({ "a.first": 1, "m.mid": 3, "z.last": 2 });
    expect(body["total_events"]).toBe(6);
  });

  it("drops malformed counts from a bad adapter instead of failing the card", async () => {
    const { app } = buildApp({
      summaryCounts: { "auth.login": 2, "bad.negative": -5, "bad.nan": Number.NaN },
    });
    const body = await jsonBody(await get(app, SUMMARY_PATH, "admin"));
    expect(body["by_action"]).toEqual({ "auth.login": 2 });
    expect(body["total_events"]).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Mount contract
// ---------------------------------------------------------------------------

describe("mountAuditRoutes", () => {
  it("honors custom paths for mounting inside a sub-app", async () => {
    const log = pino({ level: "silent" });
    const app = new Hono<AppEnv>();
    app.use("*", errorMapper(log));
    app.use("*", async (c, next) => {
      c.set("requestId", "test-req-2");
      c.set("logger", log);
      await next();
    });
    const store = new InMemoryAuditStore();
    seed(store, { id: "row-1", action: "auth.login", at: NOW });
    mountAuditRoutes(
      app,
      {
        auth: new FakeAuth(defaultPrincipals()),
        audit: new AuditService({ store, now: () => NOW }),
        summary: new FakeSummary({}),
        now: () => NOW.getTime(),
      },
      { workspacesPath: "/workspaces", auditPath: "/audit" },
    );
    const res = await get(app, `/workspaces/${ORG}/audit`, "admin");
    expect(res.status).toBe(200);
    expect(rowIds(await jsonBody(res))).toEqual(["row-1"]);
  });
});
