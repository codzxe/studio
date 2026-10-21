// Commands service + routes tests (W4-K). Deterministic, no network, no DB
// (AGENTS.md test law): the ManualCommandExecutor runs against in-memory
// fakes, and the routes are exercised through buildApp + the `mount` seam
// (documents.test.ts precedent) so the real middleware stack (request-id,
// error-mapper, §15.2 guard) is what the requests hit.
//
// Coverage mandated by the W4-K brief:
//   - allowlist table: allowed layer.new.layer; rejected agent.commit (with the
//     §25-5 hint), agent.begin/agent.rollback, template.fill, engine batch
//   - §5.6 WAL append (seq, params, result summary, revisions, run_id null)
//   - undo/redo write WAL rows (edit.undo / edit.redo, params {steps: 1})
//   - no-session error (engine_session_unavailable, open-the-document hint)
//   - tenant guard (composite scoping → cross-tenant answers 404, §12.2)
//   - §3.4 idempotency: same key = no-op on repeat (replay, never re-execute)
//   - routes: auth (401), Can-guard (§15.2 documents:write → 403 for viewers),
//     Idempotency-Key required + header/body agreement, §6.1 compact wire shape

import type { CommandLogEntry } from "@studio/db";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { PERMISSIONS, type Role } from "../src/authz/roles.js";
import { buildApp } from "../src/app.js";
import { gatewayTransportSchema } from "../src/env.js";
import {
  mountCommandRoutes,
  type CommandPrincipal,
  type CommandPrincipalResolver,
  type CommandRoutesDeps,
} from "../src/routes/commands.js";
import {
  MANUAL_COMMAND_IDEMPOTENCY_SCOPE,
  createManualCommandExecutor,
  type CommandDocumentRef,
  type CommandExecFailure,
  type CommandExecResult,
  type CommandExecutionContext,
  type CommandWalAppend,
  type CommandsStore,
  type EngineCommandReply,
  type EngineCommandRequest,
  type EngineExecution,
  type EngineLike,
  type ExecutedCommand,
  type IdempotencyLookup,
  type IdempotencyStore,
  type ManualCommandDeps,
  type ManualCommandExecutor,
  type SessionResolver,
} from "../src/services/command-exec.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_MS = Date.UTC(2026, 0, 1);
const ORG_A = "org-a";
const ORG_B = "org-b";
const DOC_A = "doc-a";
const DOC_B = "doc-b";
/** Seeded in ORG_A but with NO engine session attached (the §13.1 gate case). */
const DOC_CLOSED = "doc-closed";
const DOC_ARCHIVED = "doc-archived";
const TOKEN_A = "token-a";

/**
 * §2.2 slice of REQUIRED_ENGINE_COMMANDS (packages/engine-client/src/commands.ts)
 * covering the ids exercised here. The gateway cannot import
 * @studio/engine-client (not a dependency — SEAMS note in
 * src/services/command-exec.ts), so production injects the full list from the
 * composition root; these tests inject the same membership semantics.
 */
const ALLOWLIST = [
  "layer.new.layer",
  "type.edit",
  "edit.undo",
  "edit.redo",
  "filter.blur.gaussianBlur",
] as const satisfies readonly string[];

/** The session failure arm (test-side shorthand). */
type EngineFailure = Extract<EngineExecution, { ok: false }>;

class FakeEngine implements EngineLike {
  readonly calls: { command: string; params: Record<string, unknown> }[] = [];
  /** The next success reply (engine revisions + result payload). */
  reply: EngineCommandReply = {
    revisionBefore: 0,
    revisionAfter: 0,
    result: null,
  };
  /** When set, the NEXT execute() returns this failure (then clears). */
  nextFailure: EngineFailure | null = null;

  async execute(request: EngineCommandRequest): Promise<EngineExecution> {
    this.calls.push({ command: request.command, params: { ...request.params } });
    if (this.nextFailure !== null) {
      const failure = this.nextFailure;
      this.nextFailure = null;
      return failure;
    }
    return { ok: true, reply: { ...this.reply } };
  }
}

class FakeSessions implements SessionResolver {
  readonly map = new Map<string, EngineLike>();

  getSession(documentId: string): Promise<EngineLike | null> {
    return Promise.resolve(this.map.get(documentId) ?? null);
  }
}

class FakeCommandsStore implements CommandsStore {
  readonly documents = new Map<string, CommandDocumentRef>();
  readonly rows: CommandLogEntry[] = [];
  failAppend = false;

  seedDocument(
    organizationId: string,
    documentId: string,
    options: { readonly archived?: boolean } = {},
  ): void {
    this.documents.set(`${organizationId}:${documentId}`, {
      archived: options.archived ?? false,
    });
  }

  async findDocument(
    organizationId: string,
    documentId: string,
  ): Promise<CommandDocumentRef | null> {
    return this.documents.get(`${organizationId}:${documentId}`) ?? null;
  }

  async appendCommand(row: CommandWalAppend): Promise<CommandLogEntry> {
    if (this.failAppend) {
      this.failAppend = false;
      throw new Error("fake store: append failed");
    }
    const seq = this.rows.filter((entry) => entry.documentId === row.documentId).length + 1;
    const entry: CommandLogEntry = {
      id: `cmd-${this.rows.length + 1}`,
      documentId: row.documentId,
      organizationId: row.organizationId,
      runId: row.runId,
      seq,
      commandName: row.commandName,
      params: row.params,
      result: row.result,
      revisionBefore: row.revisionBefore,
      revisionAfter: row.revisionAfter,
      createdAt: new Date(BASE_MS),
    };
    this.rows.push(entry);
    return { ...entry };
  }
}

interface FakeClaim {
  readonly organizationId: string;
  result: Record<string, unknown> | null;
}

const claimKey = (key: string, scope: string): string => `${key}\u0000${scope}`;

class FakeIdempotency implements IdempotencyStore {
  readonly claims = new Map<string, FakeClaim>();

  async lookup(key: string, scope: string, organizationId: string): Promise<IdempotencyLookup> {
    const claim = this.claims.get(claimKey(key, scope));
    if (claim === undefined) {
      return { status: "new" };
    }
    if (claim.organizationId !== organizationId) {
      return { status: "foreign" };
    }
    if (claim.result === null) {
      return { status: "open" };
    }
    return { status: "completed", result: claim.result };
  }

  async claim(key: string, scope: string, organizationId: string): Promise<boolean> {
    const slot = claimKey(key, scope);
    if (this.claims.has(slot)) {
      return false; // unique(key, scope) — the §3.4 backstop.
    }
    this.claims.set(slot, { organizationId, result: null });
    return true;
  }

  async complete(
    key: string,
    scope: string,
    organizationId: string,
    result: Record<string, unknown>,
  ): Promise<void> {
    const slot = claimKey(key, scope);
    const claim = this.claims.get(slot);
    if (claim === undefined || claim.organizationId !== organizationId) {
      return;
    }
    this.claims.set(slot, { organizationId, result });
  }

  /** Test seeding: install a claim row directly. */
  seedClaim(key: string, organizationId: string, result: Record<string, unknown> | null): void {
    this.claims.set(claimKey(key, MANUAL_COMMAND_IDEMPOTENCY_SCOPE), {
      organizationId,
      result,
    });
  }
}

// --- narrowing helpers (vitest expect() does not narrow discriminated unions)

function expectFailure<T>(result: CommandExecResult<T>): CommandExecFailure {
  if (result.ok) {
    throw new Error("test bug: expected a failure envelope");
  }
  return result;
}

function expectExecuted(result: CommandExecResult<ExecutedCommand>): ExecutedCommand {
  if (!result.ok) {
    throw new Error(`test bug: expected success, got ${result.code}`);
  }
  return result.value;
}

function soleRow(store: FakeCommandsStore): CommandLogEntry {
  expect(store.rows.length).toBe(1);
  const row = store.rows[0];
  if (row === undefined) {
    throw new Error("test bug: expected exactly one WAL row");
  }
  return row;
}

function ctx(organizationId: string, userId: string): CommandExecutionContext {
  return { organizationId, userId, requestId: "req-test" };
}

interface ExecutorHarness {
  readonly engine: FakeEngine;
  readonly sessions: FakeSessions;
  readonly store: FakeCommandsStore;
  readonly idempotency: FakeIdempotency;
  readonly deps: ManualCommandDeps;
  readonly executor: ManualCommandExecutor;
}

function makeExecutor(): ExecutorHarness {
  const engine = new FakeEngine();
  const sessions = new FakeSessions();
  const store = new FakeCommandsStore();
  const idempotency = new FakeIdempotency();
  store.seedDocument(ORG_A, DOC_A);
  store.seedDocument(ORG_B, DOC_B);
  // ORG_A document with no attached engine session — the §13.1 session gate.
  store.seedDocument(ORG_A, DOC_CLOSED);
  store.seedDocument(ORG_A, DOC_ARCHIVED, { archived: true });
  sessions.map.set(DOC_A, engine);
  const deps: ManualCommandDeps = { sessions, store, idempotency, allowlist: ALLOWLIST };
  return { engine, sessions, store, idempotency, deps, executor: createManualCommandExecutor(deps) };
}

// ---------------------------------------------------------------------------
// Service: the §13.1/§25-5 allowlist table
// ---------------------------------------------------------------------------

describe("ManualCommandExecutor — allowlist (§13.1/§25-5)", () => {
  it("executes an allowlisted command, appends the §5.6 WAL row, replies compact", async () => {
    const h = makeExecutor();
    h.engine.reply = {
      revisionBefore: 4,
      revisionAfter: 5,
      result: { layer: 3, name: "Badge", history: { nested: "DO_NOT_LEAK" } },
    };

    const result = await h.executor.executeManualCommand(ctx(ORG_A, "user-a"), DOC_A, {
      command: "layer.new.layer",
      params: { name: "Badge" },
      idempotencyKey: "key-ok-1",
    });
    const executed = expectExecuted(result);

    expect(executed.seq).toBe(1);
    expect(executed.command).toBe("layer.new.layer");
    expect(executed.revisionBefore).toBe(4);
    expect(executed.revisionAfter).toBe(5);
    expect(executed.replayed).toBe(false);
    // §6.1 compact reply: scalars only — the nested engine dump never surfaces.
    expect(executed.summary).toContain("layer=3");
    expect(executed.summary).toContain('name="Badge"');
    expect(executed.summary).not.toContain("DO_NOT_LEAK");
    expect(executed.summary).not.toContain("history");

    expect(h.engine.calls).toEqual([
      { command: "layer.new.layer", params: { name: "Badge" } },
    ]);

    const row = soleRow(h.store);
    expect(row.documentId).toBe(DOC_A);
    expect(row.organizationId).toBe(ORG_A);
    expect(row.runId).toBeNull(); // §13.4: manual commands are not run commands.
    expect(row.commandName).toBe("layer.new.layer");
    expect(row.params).toEqual({ name: "Badge" });
    expect(row.revisionBefore).toBe(4);
    expect(row.revisionAfter).toBe(5);
    // The stored result IS the §6.1 summary record — never the raw dump.
    expect(row.result).toEqual({
      summary: executed.summary,
      warnings: [],
      fields: { layer: 3, name: "Badge" },
    });
  });

  it("rejects agent.commit with the §25-5 agent-transaction reason (hint)", async () => {
    const h = makeExecutor();
    const failure = expectFailure(
      await h.executor.executeManualCommand(ctx(ORG_A, "user-a"), DOC_A, {
        command: "agent.commit",
        params: {},
        idempotencyKey: "key-denied-1",
      }),
    );
    expect(failure.code).toBe("command_not_allowlisted");
    expect(failure.retryable).toBe(false);
    expect(failure.message).toContain("not on the manual allowlist");
    expect(failure.hint ?? "").toContain("manual surface");
    expect(failure.hint ?? "").toContain("§25-5");
    expect(h.engine.calls).toEqual([]);
    expect(h.store.rows).toEqual([]);
    expect(h.idempotency.claims.size).toBe(0);
  });

  it.each(["agent.begin", "agent.rollback"])(
    "rejects %s with the same §25-5 reason",
    async (command) => {
      const h = makeExecutor();
      const failure = expectFailure(
        await h.executor.executeManualCommand(ctx(ORG_A, "user-a"), DOC_A, {
          command,
          params: {},
          idempotencyKey: "key-denied-2",
        }),
      );
      expect(failure.code).toBe("command_not_allowlisted");
      expect(failure.hint ?? "").toContain("§25-5");
      expect(h.engine.calls).toEqual([]);
    },
  );

  it("rejects template.fill with the tool-compilation reason", async () => {
    const h = makeExecutor();
    const failure = expectFailure(
      await h.executor.executeManualCommand(ctx(ORG_A, "user-a"), DOC_A, {
        command: "template.fill",
        params: { slots: {} },
        idempotencyKey: "key-denied-3",
      }),
    );
    expect(failure.code).toBe("command_not_allowlisted");
    expect(failure.hint ?? "").toContain("template_fill tool");
  });

  it("rejects engine-level batch with the §25-5 one-command reason", async () => {
    const h = makeExecutor();
    const failure = expectFailure(
      await h.executor.executeManualCommand(ctx(ORG_A, "user-a"), DOC_A, {
        command: "batch",
        params: { steps: [] },
        idempotencyKey: "key-denied-4",
      }),
    );
    expect(failure.code).toBe("command_not_allowlisted");
    expect(failure.hint ?? "").toContain("§25-5");
    expect(failure.hint ?? "").toContain("one allowlisted command per call");
  });

  it("rejects unknown ids with the generic allowlist hint", async () => {
    const h = makeExecutor();
    const failure = expectFailure(
      await h.executor.executeManualCommand(ctx(ORG_A, "user-a"), DOC_A, {
        command: "layer.nukeEverything",
        params: {},
        idempotencyKey: "key-denied-5",
      }),
    );
    expect(failure.code).toBe("command_not_allowlisted");
    expect(failure.hint ?? "").toContain("allowlist");
  });
});

// ---------------------------------------------------------------------------
// Service: undo / redo — §13.1 "one step"
// ---------------------------------------------------------------------------

describe("ManualCommandExecutor — undo/redo (§13.1 one step)", () => {
  it("undo runs edit.undo with empty engine params and writes the one-step WAL row", async () => {
    const h = makeExecutor();
    h.engine.reply = { revisionBefore: 6, revisionAfter: 5, result: null };

    const result = await h.executor.undoOneStep(ctx(ORG_A, "user-a"), DOC_A, "key-undo-1");
    const executed = expectExecuted(result);

    expect(executed.command).toBe("edit.undo");
    expect(executed.revisionAfter).toBe(5);
    expect(executed.seq).toBe(1);
    expect(h.engine.calls).toEqual([{ command: "edit.undo", params: {} }]);

    const row = soleRow(h.store);
    expect(row.commandName).toBe("edit.undo");
    expect(row.params).toEqual({ steps: 1 }); // the WAL records the one-step intent
    expect(row.runId).toBeNull();
    expect(row.revisionBefore).toBe(6);
    expect(row.revisionAfter).toBe(5);
  });

  it("redo runs edit.redo and records params {steps:1}", async () => {
    const h = makeExecutor();
    h.engine.reply = { revisionBefore: 5, revisionAfter: 6, result: null };

    const executed = expectExecuted(
      await h.executor.redoOneStep(ctx(ORG_A, "user-a"), DOC_A, "key-redo-1"),
    );
    expect(executed.command).toBe("edit.redo");
    expect(h.engine.calls).toEqual([{ command: "edit.redo", params: {} }]);

    const row = soleRow(h.store);
    expect(row.commandName).toBe("edit.redo");
    expect(row.params).toEqual({ steps: 1 });
  });

  it("an undo with nothing to undo is summarized as a no-revision-change no-op", async () => {
    const h = makeExecutor();
    h.engine.reply = { revisionBefore: 5, revisionAfter: 5, result: null };

    const executed = expectExecuted(
      await h.executor.undoOneStep(ctx(ORG_A, "user-a"), DOC_A, "key-undo-2"),
    );
    expect(executed.summary).toContain("no revision change");
  });
});

// ---------------------------------------------------------------------------
// Service: session + tenant gates
// ---------------------------------------------------------------------------

describe("ManualCommandExecutor — session and tenant gates (§12.2/§13.1)", () => {
  it("no session → engine_session_unavailable with the open-the-document hint", async () => {
    const h = makeExecutor();
    const failure = expectFailure(
      await h.executor.executeManualCommand(ctx(ORG_A, "user-a"), DOC_CLOSED, {
        command: "layer.new.layer",
        params: {},
        idempotencyKey: "key-nosession-1",
      }),
    );
    expect(failure.code).toBe("engine_session_unavailable");
    expect(failure.retryable).toBe(true);
    expect(failure.hint ?? "").toContain("Open the document first");
    expect(h.engine.calls).toEqual([]);
    expect(h.idempotency.claims.size).toBe(0); // nothing claimed before the session gate
  });

  it("a foreign-tenant document id answers not_found (composite §12.2 lookup)", async () => {
    const h = makeExecutor();
    const failure = expectFailure(
      await h.executor.executeManualCommand(ctx(ORG_B, "user-b"), DOC_A, {
        command: "layer.new.layer",
        params: {},
        idempotencyKey: "key-tenant-1",
      }),
    );
    expect(failure.code).toBe("not_found");
    expect(h.engine.calls).toEqual([]);
  });

  it("an archived document is read-only", async () => {
    const h = makeExecutor();
    const failure = expectFailure(
      await h.executor.executeManualCommand(ctx(ORG_A, "user-a"), DOC_ARCHIVED, {
        command: "layer.new.layer",
        params: {},
        idempotencyKey: "key-archived-1",
      }),
    );
    expect(failure.code).toBe("conflict");
    expect(h.engine.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Service: §3.4 idempotency — same key never double-applies
// ---------------------------------------------------------------------------

describe("ManualCommandExecutor — idempotency (§3.4)", () => {
  it("same key repeats as a no-op: engine called once, one WAL row, replayed=true", async () => {
    const h = makeExecutor();
    h.engine.reply = { revisionBefore: 4, revisionAfter: 5, result: { layer: 3 } };

    const input = {
      command: "layer.new.layer",
      params: { name: "Badge" },
      idempotencyKey: "key-idem-1",
    } as const;
    const first = expectExecuted(
      await h.executor.executeManualCommand(ctx(ORG_A, "user-a"), DOC_A, input),
    );
    const second = expectExecuted(
      await h.executor.executeManualCommand(ctx(ORG_A, "user-a"), DOC_A, input),
    );

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.seq).toBe(first.seq);
    expect(second.summary).toBe(first.summary);
    expect(second.revisionAfter).toBe(first.revisionAfter);
    expect(h.engine.calls.length).toBe(1); // never re-executed
    expect(h.store.rows.length).toBe(1); // one WAL row
  });

  it("an open claim answers conflict", async () => {
    const h = makeExecutor();
    h.idempotency.seedClaim("key-open-1", ORG_A, null);
    const failure = expectFailure(
      await h.executor.executeManualCommand(ctx(ORG_A, "user-a"), DOC_A, {
        command: "layer.new.layer",
        params: {},
        idempotencyKey: "key-open-1",
      }),
    );
    expect(failure.code).toBe("conflict");
    expect(h.engine.calls).toEqual([]);
  });

  it("a foreign-org claim answers conflict without replaying (§15)", async () => {
    const h = makeExecutor();
    h.idempotency.seedClaim("key-foreign-1", ORG_B, { ok: true, seq: 9 });
    const failure = expectFailure(
      await h.executor.executeManualCommand(ctx(ORG_A, "user-a"), DOC_A, {
        command: "layer.new.layer",
        params: {},
        idempotencyKey: "key-foreign-1",
      }),
    );
    expect(failure.code).toBe("conflict");
    expect(failure.message).not.toContain(ORG_B);
    expect(h.engine.calls).toEqual([]);
  });

  it("engine failures are recorded and replayed — edits are never resent (§3.4)", async () => {
    const h = makeExecutor();
    h.engine.nextFailure = {
      ok: false,
      code: "engine_command_failed",
      message: "layer id 42 does not exist",
      retryable: false,
    };

    const input = {
      command: "layer.new.layer",
      params: { name: "Badge" },
      idempotencyKey: "key-fail-1",
    } as const;
    const first = expectFailure(
      await h.executor.executeManualCommand(ctx(ORG_A, "user-a"), DOC_A, input),
    );
    expect(first.code).toBe("engine_command_failed");

    const second = expectFailure(
      await h.executor.executeManualCommand(ctx(ORG_A, "user-a"), DOC_A, input),
    );
    expect(second.code).toBe("engine_command_failed");
    expect(second.message).toBe(first.message);

    expect(h.engine.calls.length).toBe(1); // the refusal replayed, never re-sent
    expect(h.store.rows.length).toBe(0); // failures are never replayed from the WAL
  });

  it("a WAL append failure after a successful command answers storage_error and burns the key", async () => {
    const h = makeExecutor();
    h.store.failAppend = true;
    const input = {
      command: "layer.new.layer",
      params: { name: "Badge" },
      idempotencyKey: "key-wal-1",
    } as const;
    const first = expectFailure(
      await h.executor.executeManualCommand(ctx(ORG_A, "user-a"), DOC_A, input),
    );
    expect(first.code).toBe("storage_error");

    // Same key → the recorded failure replays; the edit is never re-executed.
    const second = expectFailure(
      await h.executor.executeManualCommand(ctx(ORG_A, "user-a"), DOC_A, input),
    );
    expect(second.code).toBe("storage_error");
    expect(h.engine.calls.length).toBe(1);
    expect(h.store.rows.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Routes — auth, §15.2 Can-guard, Idempotency-Key, §13.3 mapping, §6.1 wire
// ---------------------------------------------------------------------------

class FakeAuth implements CommandPrincipalResolver {
  constructor(private readonly principals: ReadonlyMap<string, CommandPrincipal>) {}

  async authenticate(request: Request) {
    const header = request.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const principal = this.principals.get(token);
    if (principal === undefined) {
      return {
        ok: false as const,
        code: "unauthorized" as const,
        message: "Missing or invalid credentials.",
        hint: "Send Authorization: Bearer <token>.",
      };
    }
    return { ok: true as const, value: principal };
  }
}

function principal(organizationId: string, role: Role): CommandPrincipal {
  return {
    userId: `user-${organizationId}`,
    organizationId,
    role,
    permissions: [...PERMISSIONS[role]],
  };
}

interface AppHarness {
  readonly app: ReturnType<typeof buildApp>;
  readonly engine: FakeEngine;
  readonly store: FakeCommandsStore;
}

function makeApp(options: { readonly principal?: CommandPrincipal } = {}): AppHarness {
  const engine = new FakeEngine();
  const sessions = new FakeSessions();
  const store = new FakeCommandsStore();
  const idempotency = new FakeIdempotency();
  store.seedDocument(ORG_A, DOC_A);
  store.seedDocument(ORG_A, DOC_CLOSED); // no session attached below → 503 path
  sessions.map.set(DOC_A, engine);
  const deps: ManualCommandDeps = { sessions, store, idempotency, allowlist: ALLOWLIST };
  const routes: CommandRoutesDeps = {
    auth: new FakeAuth(new Map([[TOKEN_A, options.principal ?? principal(ORG_A, "editor")]])),
    executor: createManualCommandExecutor(deps),
  };
  const app = buildApp({
    env: gatewayTransportSchema.parse({}),
    logger: pino({ enabled: false }),
    version: "0.0.0-test",
    probes: [],
    startedAt: BASE_MS,
    mount: (mounted) => {
      mountCommandRoutes(mounted, routes);
    },
  });
  return { app, engine, store };
}

interface Envelope {
  readonly ok: boolean;
  readonly code?: string;
  readonly message?: string;
  readonly hint?: string;
  readonly retryable?: boolean;
}

interface CommandReplyDto extends Envelope {
  readonly command?: string;
  readonly seq?: number;
  readonly summary?: string;
  readonly warnings?: string[];
  readonly document_revision?: number;
  readonly revision_before?: number;
  readonly revision_after?: number;
  readonly replayed?: boolean;
}

async function post(
  h: AppHarness,
  path: string,
  body: Record<string, unknown>,
  options: { readonly token?: string; readonly headers?: Record<string, string> } = {},
): Promise<Response> {
  return h.app.request(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.token ?? TOKEN_A}`,
      "content-type": "application/json",
      ...options.headers,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/documents/:id/{commands,undo,redo} (§13.1 routes)", () => {
  it("401 without credentials", async () => {
    const h = makeApp();
    const res = await post(h, `/v1/documents/${DOC_A}/commands`, {
      command: "layer.new.layer",
      params: {},
      idempotency_key: "http-key-1",
    }, { token: "unknown-token" });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Envelope;
    expect(body.ok).toBe(false);
    expect(body.code).toBe("unauthorized");
  });

  it("403 for a viewer — §15.2 documents:write is editor+ (ADR-0003)", async () => {
    const h = makeApp({ principal: principal(ORG_A, "viewer") });
    const res = await post(h, `/v1/documents/${DOC_A}/commands`, {
      command: "layer.new.layer",
      params: {},
      idempotency_key: "http-key-2",
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Envelope;
    expect(body.code).toBe("forbidden");
    expect(h.engine.calls).toEqual([]);
  });

  it("editor executes a command over HTTP — §6.1 compact wire shape", async () => {
    const h = makeApp();
    h.engine.reply = {
      revisionBefore: 4,
      revisionAfter: 5,
      result: { layer: 3, name: "Badge" },
    };
    const res = await post(
      h,
      `/v1/documents/${DOC_A}/commands`,
      { command: "layer.new.layer", params: { name: "Badge" }, idempotency_key: "http-key-3" },
      { headers: { "Idempotency-Key": "http-key-3" } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as CommandReplyDto;
    expect(body.ok).toBe(true);
    expect(body.command).toBe("layer.new.layer");
    expect(body.seq).toBe(1);
    expect(body.summary).toContain("layer=3");
    expect(body.document_revision).toBe(5);
    expect(body.revision_before).toBe(4);
    expect(body.revision_after).toBe(5);
    expect(body.replayed).toBe(false);
  });

  it("requires the Idempotency-Key (§13 preamble)", async () => {
    const h = makeApp();
    const res = await post(h, `/v1/documents/${DOC_A}/commands`, {
      command: "layer.new.layer",
      params: {},
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as Envelope;
    expect(body.code).toBe("validation_failed");
  });

  it("rejects a header/body idempotency-key disagreement", async () => {
    const h = makeApp();
    const res = await post(
      h,
      `/v1/documents/${DOC_A}/commands`,
      { command: "layer.new.layer", params: {}, idempotency_key: "one" },
      { headers: { "Idempotency-Key": "two" } },
    );
    expect(res.status).toBe(422);
    expect(h.engine.calls).toEqual([]);
  });

  it("404 for a foreign-tenant document id (§12.2 lookups stay 404)", async () => {
    const h = makeApp({ principal: principal(ORG_B, "owner") });
    const res = await post(
      h,
      `/v1/documents/${DOC_A}/commands`,
      { command: "layer.new.layer", params: {}, idempotency_key: "http-key-4" },
      { headers: { "Idempotency-Key": "http-key-4" } },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as Envelope;
    expect(body.code).toBe("not_found");
  });

  it("agent.commit maps to 400 command_not_allowlisted with the §25-5 hint", async () => {
    const h = makeApp();
    const res = await post(
      h,
      `/v1/documents/${DOC_A}/commands`,
      { command: "agent.commit", params: {}, idempotency_key: "http-key-5" },
      { headers: { "Idempotency-Key": "http-key-5" } },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Envelope;
    expect(body.code).toBe("command_not_allowlisted");
    expect(body.hint ?? "").toContain("§25-5");
  });

  it("no session maps to 503 engine_session_unavailable", async () => {
    const h = makeApp();
    const res = await post(
      h,
      `/v1/documents/${DOC_CLOSED}/commands`,
      { command: "layer.new.layer", params: {}, idempotency_key: "http-key-6" },
      { headers: { "Idempotency-Key": "http-key-6" } },
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as Envelope;
    expect(body.code).toBe("engine_session_unavailable");
    expect(body.hint ?? "").toContain("Open the document first");
  });

  it("POST /undo runs exactly one edit.undo step over HTTP", async () => {
    const h = makeApp();
    h.engine.reply = { revisionBefore: 6, revisionAfter: 5, result: null };
    const res = await post(
      h,
      `/v1/documents/${DOC_A}/undo`,
      {},
      { headers: { "Idempotency-Key": "http-undo-1" } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as CommandReplyDto;
    expect(body.command).toBe("edit.undo");
    expect(body.revision_after).toBe(5);
    expect(h.engine.calls).toEqual([{ command: "edit.undo", params: {} }]);
    const row = soleRow(h.store);
    expect(row.commandName).toBe("edit.undo");
    expect(row.params).toEqual({ steps: 1 });
  });

  it("POST /redo runs exactly one edit.redo step over HTTP", async () => {
    const h = makeApp();
    h.engine.reply = { revisionBefore: 5, revisionAfter: 6, result: null };
    const res = await post(
      h,
      `/v1/documents/${DOC_A}/redo`,
      {},
      { headers: { "Idempotency-Key": "http-redo-1" } },
    );
    expect(res.status).toBe(200);
    expect(h.engine.calls).toEqual([{ command: "edit.redo", params: {} }]);
    const row = soleRow(h.store);
    expect(row.commandName).toBe("edit.redo");
    expect(row.params).toEqual({ steps: 1 });
  });
});
