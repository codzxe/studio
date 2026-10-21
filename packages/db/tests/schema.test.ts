import { getSchema } from "better-auth/db";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { createAuth } from "../src/auth.js";
import * as schema from "../src/schema.js";

/**
 * Schema shape sanity (§9.1) + Better Auth adapter compatibility.
 *
 * The second part mirrors the adapter's own init-time introspection
 * ("Drizzle schema mismatch"): better-auth addresses each table by the model
 * name and each column by its property name, so every model field must exist
 * as a column property. This test runs without a database.
 */

const TABLES = [
  "projects",
  "projectVersions",
  "projectLeases",
  "assets",
  "agentThreads",
  "agentMessages",
  "agentRuns",
  "agentSteps",
  "creditLedger",
  "renders",
  "comments",
  "auditLog",
  // Better Auth:
  "user",
  "session",
  "account",
  "verification",
  "organization",
  "member",
  "invitation",
  "apiKey",
] as const;

type TableName = (typeof TABLES)[number];

function columnsOf(table: TableName): string[] {
  return Object.keys(getTableColumns(schema[table]));
}

function indexByName(table: TableName, name: string) {
  return getTableConfig(schema[table]).indexes.find((index) => index.config.name === name);
}

function indexColumnNames(table: TableName, name: string): string[] {
  const index = indexByName(table, name);
  const columns = index?.config.columns ?? [];
  return columns.flatMap((column) =>
    "name" in column && typeof column.name === "string" ? [column.name] : [],
  );
}

describe("schema sanity (§9.1)", () => {
  it("exports every §9.1 table + auth tables", () => {
    for (const table of TABLES) {
      expect(schema[table], table).toBeDefined();
    }
    expect(getTableConfig(schema.projects).name).toBe("projects");
    expect(getTableConfig(schema.projectVersions).name).toBe("project_versions");
    expect(getTableConfig(schema.projectLeases).name).toBe("project_leases");
    expect(getTableConfig(schema.creditLedger).name).toBe("credit_ledger");
    expect(getTableConfig(schema.apiKey).name).toBe("apikey"); // plugin default
  });

  it("projects has all §9.1 columns incl. soft delete", () => {
    const columns = columnsOf("projects");
    for (const expected of [
      "id",
      "workspaceId",
      "name",
      "slug",
      "description",
      "thumbnailUrl",
      "currentVersionId",
      "createdBy",
      "createdAt",
      "updatedAt",
      "deletedAt",
    ]) {
      expect(columns).toContain(expected);
    }
  });

  it("projects: unique slug per workspace + (workspaceId, updatedAt desc) index", () => {
    expect(indexByName("projects", "projects_workspace_slug_uniq")?.config.unique).toBe(true);
    expect(indexColumnNames("projects", "projects_workspace_updated_idx")).toEqual([
      "workspace_id",
      "updated_at",
    ]);
  });

  it("project_versions: immutable row shape with parent + content hash", () => {
    const columns = columnsOf("projectVersions");
    for (const expected of [
      "id",
      "projectId",
      "version",
      "parentVersionId",
      "objectKey",
      "sha256",
      "sizeBytes",
      "label",
      "agentRunId",
      "createdBy",
      "createdAt",
    ]) {
      expect(columns).toContain(expected);
    }
    expect(columns).not.toContain("updatedAt"); // immutable — no update path
    expect(indexByName("projectVersions", "project_versions_project_idx")).toBeDefined();
    expect(indexByName("projectVersions", "project_versions_project_sha_idx")).toBeDefined();
  });

  it("project_leases: projectId is the primary key (single lease per project)", () => {
    const projectLeaseColumns = getTableColumns(schema.projectLeases);
    expect(projectLeaseColumns.projectId.primary).toBe(true);
    expect(Object.values(projectLeaseColumns).filter((c) => c.primary).length).toBe(1);
  });

  it("credit_ledger: append-only shape, unique idempotency, workspace/created index", () => {
    const columns = columnsOf("creditLedger");
    for (const expected of [
      "id",
      "workspaceId",
      "kind",
      "amount",
      "balanceAfter",
      "runId",
      "idempotencyKey",
      "metadata",
      "createdAt",
    ]) {
      expect(columns).toContain(expected);
    }
    expect(columns).not.toContain("updatedAt");

    expect(indexByName("creditLedger", "credit_ledger_idempotency_uniq")?.config.unique).toBe(true);
    expect(indexColumnNames("creditLedger", "credit_ledger_workspace_created_idx")).toEqual([
      "workspace_id",
      "created_at",
    ]);
    expect(indexByName("creditLedger", "credit_ledger_run_idx")).toBeDefined();
  });

  it("assets: (workspaceId, sha256) dedupe index + nullable projectId", () => {
    expect(indexColumnNames("assets", "assets_workspace_sha_idx")).toEqual([
      "workspace_id",
      "sha256",
    ]);
    expect(getTableColumns(schema.assets).projectId.notNull).toBe(false);
  });

  it("agent_runs indexed by thread; agent_steps unique per (run, seq)", () => {
    expect(indexColumnNames("agentRuns", "agent_runs_thread_idx")).toEqual(["thread_id"]);
    expect(indexByName("agentSteps", "agent_steps_run_seq_uniq")?.config.unique).toBe(true);
  });

  it("comments: (projectId, resolvedAt) index per §9.1 note", () => {
    expect(indexColumnNames("comments", "comments_project_resolved_idx")).toEqual([
      "project_id",
      "resolved_at",
    ]);
  });

  it("tenant FKs: projects.workspaceId references organization.id", () => {
    const fk = getTableConfig(schema.projects).foreignKeys.find(
      (constraint) => constraint.reference().foreignTable === schema.organization,
    );
    expect(fk).toBeDefined();
  });
});

describe("Better Auth adapter compatibility (no database)", () => {
  // postgres.js connects lazily — a dummy URL is never touched here.
  const auth = createAuth({
    databaseUrl: "postgres://seed:seed@127.0.0.1:5432/studio_test",
    appUrl: "http://localhost:3000",
    secret: "unit-test-secret-0123456789",
  });

  const MODEL_TO_TABLE = {
    user: schema.user,
    session: schema.session,
    account: schema.account,
    verification: schema.verification,
    organization: schema.organization,
    member: schema.member,
    invitation: schema.invitation,
    apikey: schema.apiKey,
  } as const;

  it("every better-auth model is mapped to a table", () => {
    const models = getSchema(auth.options);
    expect(Object.keys(models).sort()).toEqual(Object.keys(MODEL_TO_TABLE).sort());
  });

  it("every model field exists as a column property (adapter requirement)", () => {
    const models = getSchema(auth.options);
    for (const [model, def] of Object.entries(models)) {
      const table = MODEL_TO_TABLE[model as keyof typeof MODEL_TO_TABLE];
      const columns = getTableColumns(table) as unknown as Record<string, unknown>;
      // `id` is implicit in getSchema output but the adapter requires it
      expect(columns.id, `${model}.id`).toBeDefined();
      for (const field of Object.keys(def.fields)) {
        expect(columns[field], `${model}.${field}`).toBeDefined();
      }
    }
  });

  it("our workspace roles are registered with the organization plugin", () => {
    const orgPlugin = auth.options.plugins?.find((p) => p.id === "organization");
    expect(orgPlugin).toBeDefined();
    const options = orgPlugin?.options as Record<string, unknown> | undefined;
    const roles = options?.roles as Record<string, unknown> | undefined;
    expect(roles?.editor).toBeDefined();
    expect(roles?.viewer).toBeDefined();
  });
});
