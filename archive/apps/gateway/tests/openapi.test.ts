// W4-O — OpenAPI contract gate (§13); extended by the W10-G final audit.
// Keeps apps/gateway/src/openapi.ts, apps/gateway/docs/api/openapi-contract.md
// and apps/gateway/src/routes/*.ts in lockstep. Deterministic, no network, no DB.
//
//  1. the authored const JSON-parses and is a well-formed OpenAPI 3.1 document
//     (unique operationIds, every $ref resolves, every operation carries an
//     audit status);
//  2. every path in the audit table appears exactly once in the spec — and
//     spec paths and audit rows cover each other exactly (set equality);
//  3. the error envelope is the RECONCILED FLAT shape
//     { ok:false, code, message, hint, retryable, docs_url?, details? }
//     — §13.3's nested error:{…} sketch was rejected (decision W4-O);
//  4. no route path in src/routes/ is missing from the spec (W10-G: the scan
//     table now covers EVERY router file; metrics.ts is the one documented
//     exemption — the internal-only /metrics surface, never a §13 /v1 path).
//
// W10-G additions: the audit export/summary paths (with the text/csv
// response), the /metrics exclusion, and a routes-dir coverage test so no
// router file can silently miss the scan.
//
// LIMITATIONS of the route scan (4), documented per the task text — it is a
// COARSE check:
//   - It scans string literals in router method calls only
//     (.get/.post/.put/.patch/.delete/.all/.route/.use). Template literals
//     (e.g. `${path}/*` in runs.ts, `${root}/workspaces/:id/templates` in
//     catalog.ts) and programmatically-built paths are invisible to it.
//   - Mount prefixes cannot be inferred from the sources, so a small mount
//     table mirrors the audit doc + each route file's own MOUNTING header
//     (workspaces.ts exports TWO routers, hence two mounts). If the
//     composition root mounts elsewhere, this table — and the audit — must
//     move with it.
//   - "*" catch-alls (the 501 placeholder, auth guards) are skipped: they are
//     not §13 endpoints.
//   - Comments are stripped before scanning so doc-comment examples (e.g. the
//     v1.route(...) snippets in file headers) cannot create phantom paths.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { OPENAPI_SPEC, buildOpenApiSpec, mountOpenApi } from "../src/openapi.js";
import type { AppEnv } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = join(here, "../src/routes");
const AUDIT_DOC = join(here, "../docs/api/openapi-contract.md");

// --- small typed JSON helpers (no `any`; guards keep noUncheckedIndexedAccess honest)

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${what} is not an array`);
  }
  return value;
}

/** JSON round-trip of the authored const — the exact bytes /v1/openapi.json serves. */
function parseSpec(): Record<string, unknown> {
  return asRecord(JSON.parse(JSON.stringify(OPENAPI_SPEC)), "spec");
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

interface FlatOperation {
  readonly path: string;
  readonly method: string;
  readonly operation: Record<string, unknown>;
}

function flattenOperations(parsed: Record<string, unknown>): FlatOperation[] {
  const paths = asRecord(parsed.paths, "spec.paths");
  const flat: FlatOperation[] = [];
  for (const [path, item] of Object.entries(paths)) {
    const pathItem = asRecord(item, `paths.${path}`);
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (operation !== undefined) {
        flat.push({ path, method, operation: asRecord(operation, `${path}.${method}`) });
      }
    }
  }
  return flat;
}

const AUDIT_STATUSES = new Set([
  "implemented",
  "implemented-awaiting-mount",
  "partial",
  "not-implemented",
]);

// ---------------------------------------------------------------------------
// Audit-table extraction: the endpoint table's SECOND column is the OpenAPI
// path in backticks. Other tables in the doc put prose there and are skipped
// by the startsWith("/v1/") filter.
// ---------------------------------------------------------------------------

function auditTablePaths(): string[] {
  const doc = readFileSync(AUDIT_DOC, "utf8");
  const paths: string[] = [];
  for (const line of doc.split("\n")) {
    if (!line.startsWith("|")) {
      continue;
    }
    const cells = line.split("|");
    const second = (cells[2] ?? "").trim();
    if (!second.startsWith("`/v1/")) {
      continue;
    }
    const path = second.replace(/^`/, "").replace(/`$/, "").trim();
    if (!path.startsWith("/v1/")) {
      continue;
    }
    paths.push(path);
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Route-source scanning (coarse — see the LIMITATIONS header).
// ---------------------------------------------------------------------------

/** Mount prefixes per route file, from the audit doc + each file's header. */
const ROUTE_MOUNTS: Readonly<Record<string, readonly string[]>> = {
  "health.ts": ["/v1/health"],
  // workspaces.ts exports TWO routers (workspaceRoutes + inviteRoutes).
  "workspaces.ts": ["/v1/workspaces", "/v1/invites"],
  "documents.ts": ["/v1/documents"],
  "runs.ts": ["/v1/runs"],
  "runs-events.ts": ["/v1"],
  "uploads.ts": ["/v1"],
  "index.ts": ["/v1"],
  // --- W10-G: the wave-4…9 modules awaiting the composition-root wiring ---
  // audit.ts mounts TWO routers (workspaceAuditRoutes + auditSummaryRoutes).
  "audit.ts": ["/v1/workspaces", "/v1/audit"],
  "billing.ts": ["/v1/billing", "/v1/webhooks/stripe"],
  "catalog.ts": ["/v1"],
  "commands.ts": ["/v1/documents"],
  // exports.ts mounts TWO routers (exportRoutes + previewRoutes) on literal prefixes.
  "exports.ts": ["/v1/documents/:id/exports", "/v1/documents/:id/preview"],
  // credits.ts mounts TWO routers (creditRoutes + usageRoutes).
  "credits.ts": ["/v1/credits", "/v1/usage"],
};

/**
 * Route files deliberately OUTSIDE the spec scan: metrics.ts mounts at
 * /metrics — the internal-only Prometheus surface (§22/§17.2, W9-G), NEVER
 * a §13 /v1 path, behind the METRICS_TOKEN Basic-auth seam. The audit doc's
 * "out-of-band surfaces" section owns that note; any addition here must be
 * cited there.
 */
const ROUTE_SCAN_EXEMPT: Readonly<Record<string, string>> = {
  "metrics.ts": "internal-only /metrics (W9-G, §22/§17.2) — never a /v1 path",
};

/** Strip line (//) and block comments, respecting strings and template literals. */
function stripComments(source: string): string {
  const out: string[] = [];
  let i = 0;
  type State = "code" | "line" | "block" | "quote" | "template";
  let state: State = "code";
  let quote = "";
  while (i < source.length) {
    const ch = source[i] ?? "";
    const next = source[i + 1] ?? "";
    if (state === "code") {
      if (ch === "/" && next === "/") {
        state = "line";
        i += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        state = "block";
        i += 2;
        continue;
      }
      if (ch === '"' || ch === "'") {
        state = "quote";
        quote = ch;
        out.push(ch);
        i += 1;
        continue;
      }
      if (ch === "`") {
        state = "template";
        out.push(ch);
        i += 1;
        continue;
      }
      out.push(ch);
      i += 1;
      continue;
    }
    if (state === "line") {
      if (ch === "\n") {
        state = "code";
        out.push(ch);
      }
      i += 1;
      continue;
    }
    if (state === "block") {
      if (ch === "*" && next === "/") {
        state = "code";
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (state === "quote") {
      if (ch === "\\") {
        out.push(ch, next);
        i += 2;
        continue;
      }
      if (ch === quote) {
        state = "code";
      }
      out.push(ch);
      i += 1;
      continue;
    }
    // template: only an unescaped backtick ends it (${…} holds no backticks in routes/)
    if (ch === "\\") {
      out.push(ch, next);
      i += 2;
      continue;
    }
    if (ch === "`") {
      state = "code";
    }
    out.push(ch);
    i += 1;
  }
  return out.join("");
}

interface RouteLiteral {
  readonly file: string;
  readonly method: string;
  readonly literal: string;
}

function scanRouteLiterals(): RouteLiteral[] {
  const found: RouteLiteral[] = [];
  for (const file of Object.keys(ROUTE_MOUNTS)) {
    const source = stripComments(readFileSync(join(ROUTES_DIR, file), "utf8"));
    // Coarse on purpose: string args with escaped quotes would confuse it —
    // none exist in routes/ (paths are plain literals).
    const pattern = /\.(get|post|put|patch|delete|all|route|use)\(\s*(?:"([^"]*)"|'([^']*)')/g;
    for (const match of source.matchAll(pattern)) {
      const method = match[1] ?? "";
      const literal = match[2] ?? match[3] ?? "";
      if (literal === "" || literal === "*" || !literal.startsWith("/")) {
        continue; // catch-alls and non-path arguments
      }
      found.push({ file, method, literal });
    }
  }
  return found;
}

/** Join a mount prefix with a route literal, hono-style. */
function joinRoute(mount: string, literal: string): string {
  if (literal === "/") {
    return mount;
  }
  return `${mount}${literal}`;
}

/** :param → {param} so hono literals match OpenAPI path keys. */
function openApiStyle(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("openapi document (W4-O)", () => {
  it("is a JSON-parsable OpenAPI 3.1 document", () => {
    const parsed = parseSpec();
    expect(parsed.openapi).toBe("3.1.0");
    const info = asRecord(parsed.info, "info");
    expect(typeof info.title).toBe("string");
    expect(typeof info.description).toBe("string");
    const paths = asRecord(parsed.paths, "paths");
    expect(Object.keys(paths).length).toBeGreaterThan(0);
    for (const path of Object.keys(paths)) {
      expect(path.startsWith("/v1/"), path).toBe(true);
      const item = asRecord(paths[path], `paths.${path}`);
      const methods = HTTP_METHODS.filter((m) => item[m] !== undefined);
      expect(methods.length > 0, `${path} has no operations`).toBe(true);
    }
  });

  it("documents the RECONCILED flat error envelope (§13.3 nested shape rejected)", () => {
    const parsed = parseSpec();
    const components = asRecord(parsed.components, "components");
    const schemas = asRecord(components.schemas, "schemas");
    const envelope = asRecord(schemas.ErrorEnvelope, "ErrorEnvelope");
    expect(envelope.type).toBe("object");
    // Required: exactly the four flat fields (hint/docs_url/details optional).
    expect(new Set(asArray(envelope.required, "required"))).toEqual(
      new Set(["ok", "code", "message", "retryable"])
    );
    const props = asRecord(envelope.properties, "ErrorEnvelope.properties");
    const ok = asRecord(props.ok, "properties.ok");
    expect(ok.const).toBe(false);
    expect(asRecord(props.code, "properties.code").type).toBe("string");
    expect(asRecord(props.message, "properties.message").type).toBe("string");
    expect(asRecord(props.retryable, "properties.retryable").type).toBe("boolean");
    expect(asRecord(props.hint, "properties.hint").type).toBe("string");
    expect(asRecord(props.docs_url, "properties.docs_url").type).toBe("string");
    expect(asRecord(props.details, "properties.details").type).toBe("array");
    // The nested §13.3 sketch must NOT appear.
    expect(Object.prototype.hasOwnProperty.call(props, "error")).toBe(false);
    expect(envelope.additionalProperties).toBe(false);
  });

  it("keeps audit statuses and refs coherent on every operation", () => {
    const parsed = parseSpec();
    const operations = flattenOperations(parsed);
    expect(operations.length).toBeGreaterThan(0);
    const operationIds = new Set<string>();
    for (const { operation } of operations) {
      const status = operation["x-studio-status"];
      expect(
        AUDIT_STATUSES.has(String(status)),
        `bad x-studio-status: ${String(status)}`
      ).toBe(true);
      const id = String(operation.operationId);
      expect(operationIds.has(id), `duplicate operationId ${id}`).toBe(false);
      operationIds.add(id);
      const responses = asRecord(operation.responses, "responses");
      expect(Object.keys(responses).length > 0).toBe(true);
    }
    // Every $ref resolves (walk the whole document).
    const refs = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const child of node) {
          walk(child);
        }
        return;
      }
      if (typeof node === "object" && node !== null) {
        const record = node as Record<string, unknown>;
        if (typeof record.$ref === "string") {
          refs.add(record.$ref);
        }
        for (const child of Object.values(record)) {
          walk(child);
        }
      }
    };
    walk(parsed);
    expect(refs.size).toBeGreaterThan(0);
    for (const ref of refs) {
      let node: unknown = parsed;
      for (const part of ref.replace("#/", "").split("/")) {
        node = node === undefined || node === null ? undefined : asRecord(node, ref)[part];
      }
      expect(node, `dangling $ref ${ref}`).toBeDefined();
    }
  });

  it("has exactly one spec path per audit-table row, and no extras either way", () => {
    const parsed = parseSpec();
    const specPaths = new Set(Object.keys(asRecord(parsed.paths, "paths")));
    const audit = auditTablePaths();
    // Exactly once in the table…
    const seen = new Set<string>();
    for (const path of audit) {
      expect(seen.has(path), `audit table lists ${path} twice`).toBe(false);
      seen.add(path);
    }
    // …and each table path exists in the spec exactly once (object keys are
    // unique by construction, so presence is the "exactly once" guarantee).
    for (const path of audit) {
      expect(specPaths.has(path), `audit path missing from spec: ${path}`).toBe(true);
    }
    // And the reverse: no undocumented spec paths.
    for (const path of specPaths) {
      expect(audit.includes(path), `spec path missing from audit table: ${path}`).toBe(true);
    }
    expect(audit.length).toBe(specPaths.size);
  });

  it("documents the §13.2 SSE stream with Last-Event-ID resume", () => {
    const parsed = parseSpec();
    const paths = asRecord(parsed.paths, "paths");
    const events = asRecord(paths["/v1/runs/{id}/events"], "events path");
    const get = asRecord(events.get, "events.get");
    const params = asArray(get.parameters, "events.get.parameters");
    const names = params.map((p) => String(asRecord(p, "param").name));
    expect(names).toContain("Last-Event-ID");
    expect(names).toContain("lastEventId");
    const responses = asRecord(get.responses, "events.get.responses");
    const ok = asRecord(responses["200"], "events 200");
    const content = asRecord(ok.content, "200.content");
    expect(Object.keys(content)).toContain("text/event-stream");
    const components = asRecord(parsed.components, "components");
    const schemas = asRecord(components.schemas, "schemas");
    const sse = asRecord(asRecord(schemas.SseEventEnvelope, "SseEventEnvelope").properties, "sse");
    const typeEnum = asArray(asRecord(sse.type, "sse.type").enum, "type enum");
    // 13 §13.2 event types + the run.resync sentinel (audit D8).
    expect(typeEnum.length).toBe(14);
    expect(typeEnum).toContain("run.resync");
  });

  // --- W10-G: the §22 audit export/summary (W9-H) with the CSV response -----

  it("documents the audit export (JSON + text/csv) and summary paths", () => {
    const parsed = parseSpec();
    const paths = asRecord(parsed.paths, "paths");

    const exportPath = asRecord(paths["/v1/workspaces/{id}/audit"], "audit export");
    const exportGet = asRecord(exportPath.get, "audit export.get");
    // W10-R: the composition root wired the W9-H group — the final audit's
    // awaiting-mount statuses flipped to `implemented` with the mounts.
    expect(String(exportGet["x-studio-status"])).toBe("implemented");
    const params = asArray(exportGet.parameters, "audit export.parameters");
    const paramNames = params.map((p) =>
      String(asRecord(asRecord(p, "param"), "param").name ?? asRecord(p, "param").name),
    );
    expect(paramNames).toContain("format");
    expect(paramNames).toContain("from");
    expect(paramNames).toContain("to");
    const responses = asRecord(exportGet.responses, "audit export.responses");
    const ok = asRecord(responses["200"], "audit export 200");
    const content = asRecord(ok.content, "audit export 200.content");
    // §22 "exportable per workspace": the SAME rows as JSON or RFC 4180 CSV.
    expect(Object.keys(content)).toContain("application/json");
    expect(Object.keys(content)).toContain("text/csv");
    const headers = asRecord(ok.headers, "audit export 200.headers");
    expect(Object.prototype.hasOwnProperty.call(headers, "X-Next-Cursor")).toBe(
      true,
    );
    expect(Object.prototype.hasOwnProperty.call(headers, "Content-Disposition")).toBe(
      true,
    );

    const summaryPath = asRecord(paths["/v1/audit/summary/{id}"], "audit summary");
    const summaryGet = asRecord(summaryPath.get, "audit summary.get");
    expect(String(summaryGet.operationId)).toBe("getAuditSummary");
    expect(String(summaryGet["x-studio-status"])).toBe("implemented");
  });

  it("carries NO awaiting-mount operation anymore (W10-R wired every module)", () => {
    const parsed = parseSpec();
    const stale = flattenOperations(parsed).filter(
      (op) => String(op.operation["x-studio-status"]) === "implemented-awaiting-mount",
    );
    expect(
      stale.map((op) => `${op.path}:${op.method}`),
      "operations still awaiting the composition root — wire them in app.ts " +
        "(W10-R) or revert this test",
    ).toEqual([]);
  });

  it("keeps the internal /metrics surface OUT of the /v1 spec (§22/§17.2)", () => {
    const parsed = parseSpec();
    const specPaths = Object.keys(asRecord(parsed.paths, "paths"));
    for (const path of specPaths) {
      expect(
        path.startsWith("/metrics"),
        `internal surface leaked into the §13 spec: ${path}`,
      ).toBe(false);
    }
    // The audit doc owns the out-of-band note (internal-only, METRICS_TOKEN).
    const doc = readFileSync(AUDIT_DOC, "utf8");
    expect(doc).toContain("/metrics");
    expect(doc.toLowerCase()).toContain("out-of-band");
  });

  it("buildOpenApiSpec clones the const and applies overrides", () => {
    const built = buildOpenApiSpec({ version: "9.9.9-test" });
    expect(built.info.version).toBe("9.9.9-test");
    expect(built).not.toBe(OPENAPI_SPEC);
    expect(built.paths).not.toBe(OPENAPI_SPEC.paths);
    expect(OPENAPI_SPEC.info.version).toBe("0.1.0");
    const untouched = buildOpenApiSpec();
    expect(untouched.info.version).toBe(OPENAPI_SPEC.info.version);
    expect(Object.keys(untouched.paths).length).toBe(Object.keys(OPENAPI_SPEC.paths).length);
  });

  it("mountOpenApi serves GET /v1/openapi.json (the spec const)", async () => {
    const app = new Hono<AppEnv>();
    mountOpenApi(app);
    const res = await app.request("/v1/openapi.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const served = asRecord(JSON.parse(await res.text()), "served spec");
    const specPaths = Object.keys(asRecord(parseSpec().paths, "paths"));
    expect(Object.keys(asRecord(served.paths, "served paths"))).toEqual(specPaths);
  });
});

describe("route files ⊆ spec (coarse scan, see header LIMITATIONS)", () => {
  it("covers every string-literal router path in src/routes/", () => {
    const specPaths = new Set(Object.keys(asRecord(parseSpec().paths, "paths")));
    const literals = scanRouteLiterals();
    expect(literals.length).toBeGreaterThan(0);
    const misses: string[] = [];
    for (const { file, literal } of literals) {
      const normalized = openApiStyle(literal);
      const mounts = ROUTE_MOUNTS[file] ?? [];
      const candidates = [normalized, ...mounts.map((m) => openApiStyle(joinRoute(m, literal)))];
      const covered = candidates.some(
        (candidate) =>
          specPaths.has(candidate) ||
          [...specPaths].some((p) => p.startsWith(`${candidate}/`))
      );
      if (!covered) {
        misses.push(`${file}: "${literal}" (tried ${candidates.join(", ")})`);
      }
    }
    expect(misses, `route literals missing from the spec:\n${misses.join("\n")}`).toEqual([]);
  });

  it("documents the scan itself: mount table files all exist in the scan", () => {
    // The scan iterates ROUTE_MOUNTS keys; if a new route file lands, the
    // audit + this table must grow with it (kept honest by the tests above
    // and the routes-dir coverage test below).
    const literals = scanRouteLiterals();
    const files = new Set(literals.map((l) => l.file));
    for (const file of Object.keys(ROUTE_MOUNTS)) {
      const isRouter = files.has(file);
      expect(
        isRouter,
        `${file} yielded no route literals — is it still a router?`
      ).toBe(true);
    }
  });

  it("leaves no route file out of the spec scan (mount table ∪ exempt = routes dir)", () => {
    const files = readdirSync(ROUTES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => entry.name)
      .sort();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const known =
        Object.prototype.hasOwnProperty.call(ROUTE_MOUNTS, file) ||
        Object.prototype.hasOwnProperty.call(ROUTE_SCAN_EXEMPT, file);
      expect(
        known,
        `${file} is neither in ROUTE_MOUNTS nor ROUTE_SCAN_EXEMPT — extend ` +
          `the audit + mount table (or document the exemption)`,
      ).toBe(true);
    }
  });
});
