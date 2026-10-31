// 12-w5-t4 (round 12 — the client-driven agent loop): integration coverage of
// the stateless turn route + plan + abandon over the STUB harness
// (FakeGatewayAuth + in-memory repo fakes, no Postgres, MOCK_MODEL=true — no
// network, the mock turn emits the create_composition + create_text
// proposals). SSE parsing reuses helpers.readSse (one §7.4 frame per event).
//
// WHY A LOCAL APP SHELL (the tools.test.ts precedent): buildApp mounts
// idempotencyMiddleware() BEFORE every router (app.ts), and
// IDEMPOTENCY_EXCLUDED_PATHS (middleware.ts) still only excludes the retired
// /chat path — a same-key duplicate turn POST through the FULL app would
// body-replay a JSON-wrapped snapshot of the SSE stream (content-type
// text/event-stream, body {"data":"id: 0\ndata: …"}), never the route's own
// durable replayTurnOutcome; /v1/runs/:id/plan and /v1/runs/:id/abandon would
// additionally REQUIRE an Idempotency-Key header. That interplay is a PRODUCT
// GAP (noted in worklog); this shell mirrors buildApp's deps/requestId/error
// boundary so the router's OWN wire contract is what gets pinned.
//
// Coverage map (mission items 1-9):
//   1. two-turn mock run — step 0 SSE order + durable outcome (run row
//      created/heartbeat, user row linked, issued step rows, assistant row
//      keyed by turnKey, reserve/settle), step 1 echoes tool_result parts via
//      resultForModel → final text turn with toolCalls []
//   2. same-key duplicate POST → the STORED outcome replays (bounded SSE, no
//      new rows, no ledger calls) + the aborted-mid-stream variant
//   3. stepIndex > 0 before step 0 → 404 RUN_NOT_FOUND
//   4. foreign-workspace thread → 404 THREAD_NOT_FOUND (§12.1); a run
//      attached to another thread → 404 RUN_NOT_ACTIVE
//   5. Idempotency-Key ≠ `${runId}:${stepIndex}` (or missing) → 400
//   6. credits: per-turn reserve/settle µc magnitudes (fake ledger spy) +
//      zero balance 402; turn.failed refunds — INTERNAL (readable SSE) and
//      TURN_CANCELLED (abort racing a failure); failed turns never persist
//      the turnKey so a same-key retry re-runs the model
//   7. POST /v1/runs/:id/plan — valid plan compiles + §7.3 verdict +
//      plan_json stored + the run marked COMPLETED (the D-11 applyable
//      moment); {end:true} closes a proposal-less run; invalid body 400;
//      abandoned run 409 RUN_NOT_ACTIVE; then the DB-gated REAL-app
//      chain pin: plan → apply 200
//   8. POST /v1/runs/:id/abandon — RUN_ABANDONED + status cancelled +
//      refundAll, idempotent second call; unknown run 404
//   9. heartbeat — after step 1 the run row's last_step_index is 1

import { createHash } from "node:crypto";

import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  type EditPlan,
  STUDIO_STREAM_EVENT_SCHEMA,
  type TurnMessage,
  type TurnToolCall,
} from "@studio/contracts";
import {
  type AssistantMessageInput,
  type CompleteToolStepInput,
  DbError,
  type LinkUserMessageInput,
  type MarkRunAbandonedInput,
  RUN_ABANDONED_ERROR_CODE,
  type Repos,
  type ThreadHistoryMessage,
  type ToolCallStepInput,
  type ToolMessageInput,
  type TouchRunHeartbeatInput,
} from "@studio/db";

import type { AppBindings, GatewayDeps } from "../src/context.js";
import { MICROCREDITS_PER_CREDIT, creditsToLedgerMicrocredits } from "../src/credits-display.js";
import { toErrorEnvelope } from "../src/errors.js";
import { buildTurnMessages } from "../src/litellm/turn-engine.js";
import { requestIdMiddleware } from "../src/middleware.js";
import { turnRoutes } from "../src/routes/turn.js";
import { mockEditPlan, reserveAmountFor } from "../src/runner.js";
import {
  CookieJar,
  FakeGatewayAuth,
  HAS_DATABASE,
  type RunningTestServer,
  type SseEvent,
  TEST_APP_ORIGIN,
  api,
  bootServer,
  readSse,
  stubDeps,
  testEnv,
  unique,
  uniqueEmail,
} from "./helpers.js";

const env = testEnv(); // MOCK_MODEL=true — the mock turn, no network.

const PROJECT_ID = "prj_turn_1";
const BASE_VERSION_ID = "ver_turn_base_1";
const THREAD_MAIN = "thr_turn_main";
const THREAD_OTHER = "thr_turn_other";

const USER_TEXT = "Please set up the demo composition.";
const STEP0_TEXT = "I'll set up a demo for you — a new composition with a text layer. ";
/** ROUND 13: the mock's thinking prefix (streamed as reasoning.delta frames). */
const STEP0_REASONING = [
  "The user wants a demo build. ",
  "Plan: create one composition (1920x1080, 30fps, 4s), ",
  "then a centered text layer — both are reversible writes, so they apply live.",
].join("");
const STEP1_TEXT = "Done — I created the Agent Demo composition with a text layer.";

// ---------------------------------------------------------------------------
// In-memory repo fakes: the exact seams routes/turn.ts touches, mirroring the
// real @studio/db semantics (queued create → running heartbeat, issued steps,
// {message,status,…payload} assistant content_json, ledger replay-by-key).
// Anything the route drifts onto stays loud: missing methods throw.
// ---------------------------------------------------------------------------

interface FakeThreadRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly title: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface FakeMessageRow {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "tool";
  contentJson: unknown;
  runId: string | null;
  readonly createdAt: Date;
}

interface FakeRunRow {
  id: string;
  workspaceId: string;
  threadId: string;
  projectId: string;
  model: string;
  status: string;
  planJson: unknown;
  reservedCredits: number;
  committedCredits: number;
  baseVersionId: string | null;
  lastStepIndex: number;
  heartbeatAt: Date;
  errorCode: string | null;
  completedAt: Date | null;
  readonly createdAt: Date;
}

interface FakeStepRow {
  id: string;
  runId: string;
  toolCallId: string;
  tool: string;
  argsJson: unknown;
  status: string;
  resultJson: unknown;
}

interface UserMessageCall {
  readonly workspaceId: string;
  readonly input: {
    readonly threadId: string;
    readonly role: string;
    readonly contentJson: unknown;
    readonly runId?: string | null;
  };
}

interface RunCreateCall {
  readonly workspaceId: string;
  readonly input: {
    readonly runId: string;
    readonly threadId: string;
    readonly projectId: string;
    readonly model: string;
    readonly baseVersionId: string | null;
    readonly reservedCredits: number;
  };
}

type LedgerOp =
  | {
      readonly op: "reserve";
      readonly workspaceId: string;
      readonly runId: string | null;
      readonly amount: number;
      readonly idempotencyKey: string;
    }
  | {
      readonly op: "settle";
      readonly workspaceId: string;
      readonly runId: string | null;
      readonly actualCost: number;
      readonly idempotencyKey: string;
    }
  | {
      readonly op: "refundAll";
      readonly workspaceId: string;
      readonly runId: string | null;
      readonly idempotencyKey: string;
    };

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolveFn: ((value: T) => void) | null = null;
  let rejectFn: ((error: unknown) => void) | null = null;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return {
    promise,
    resolve: (value: T) => resolveFn?.(value),
    reject: (error: unknown) => rejectFn?.(error),
  };
}

function makeTurnRepos() {
  const threads = new Map<string, FakeThreadRow>();
  const projects = new Map<
    string,
    { id: string; workspaceId: string; name: string; currentVersionId: string }
  >();
  const messages: FakeMessageRow[] = [];
  const runs = new Map<string, FakeRunRow>();
  const steps: FakeStepRow[] = [];

  const runCreates: RunCreateCall[] = [];
  const heartbeats: TouchRunHeartbeatInput[] = [];
  const toolStepCalls: ToolCallStepInput[] = [];
  const stepCompletions: CompleteToolStepInput[] = [];
  const toolMessageInserts: ToolMessageInput[] = [];
  const assistantInserts: AssistantMessageInput[] = [];
  const userMessages: UserMessageCall[] = [];
  const links: LinkUserMessageInput[] = [];
  const abandons: MarkRunAbandonedInput[] = [];
  const runUpdates: Array<{ runId: string; input: { planJson?: unknown; status?: string } }> = [];
  const ledgerOps: LedgerOp[] = [];
  const seenLedgerKeys = new Set<string>();
  let balanceMicrocredits = 100 * MICROCREDITS_PER_CREDIT;
  let autoApplyEnabled = true;
  let balanceReads = 0;
  let autoApplyReads = 0;

  // One-shot gate on the durable assistant-row insert: lets tests hold a turn
  // mid-flight (or fail it) deterministically — MOCK_MODEL turns otherwise
  // complete within microtasks.
  interface AssistantInsertGate {
    readonly failFirst: boolean;
    readonly reached: Deferred<void>;
    readonly pending: Deferred<void>;
  }
  let assistantGate: AssistantInsertGate | null = null;

  function gateAssistantInsert(failFirst: boolean): {
    readonly reached: Promise<void>;
    release(): void;
  } {
    const gate: AssistantInsertGate = {
      failFirst,
      reached: deferred<void>(),
      pending: deferred<void>(),
    };
    assistantGate = gate;
    return { reached: gate.reached.promise, release: () => gate.pending.resolve() };
  }

  function requireRunRow(runId: string): FakeRunRow {
    const row = runs.get(runId);
    if (row === undefined) throw DbError.notFound(`run ${runId} not found`);
    return row;
  }

  function nextMessageId(): string {
    return `msg_${messages.length + 1}`;
  }

  /** Mirrors repos/threads.ts toHistoryEntry (the route's replay + prompt feed). */
  function historyEntryOf(row: FakeMessageRow): ThreadHistoryMessage | null {
    const content = row.contentJson as Record<string, unknown> | null;
    const textOf = (keys: readonly string[]): string | undefined => {
      if (content === null || typeof content !== "object") return undefined;
      for (const key of keys) {
        const value = content[key];
        if (typeof value === "string" && value.length > 0) return value;
      }
      return undefined;
    };
    switch (row.role) {
      case "user":
        return {
          role: "user",
          text: textOf(["message"]),
          contentJson: row.contentJson,
          runId: row.runId,
        };
      case "assistant":
        return {
          role: "assistant",
          text: textOf(["text", "message"]),
          contentJson: row.contentJson,
          runId: row.runId,
        };
      case "tool":
        return { role: "tool", contentJson: row.contentJson, runId: row.runId };
      default:
        return null;
    }
  }

  const repos = {
    projects: {
      async get(workspaceId: string, projectId: string) {
        const project = projects.get(projectId);
        if (project === undefined || project.workspaceId !== workspaceId) {
          throw DbError.notFound(`project ${projectId} not found`);
        }
        return { ...project };
      },
    },
    threads: {
      async get(workspaceId: string, threadId: string) {
        const thread = threads.get(threadId);
        if (thread === undefined || thread.workspaceId !== workspaceId) {
          // Message shape mirrors the real repo: "thread …" only — the
          // gateway's not-found mapper checks "workspace" first (§12.1).
          throw DbError.notFound(`thread ${threadId} not found`);
        }
        return {
          id: thread.id,
          workspaceId: thread.workspaceId,
          projectId: thread.projectId,
          title: thread.title,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
        };
      },
      async addMessage(workspaceId: string, input: UserMessageCall["input"]) {
        const thread = threads.get(input.threadId);
        if (thread === undefined || thread.workspaceId !== workspaceId) {
          throw DbError.notFound(`thread ${input.threadId} not found`);
        }
        userMessages.push({ workspaceId, input: { ...input } });
        const row: FakeMessageRow = {
          id: nextMessageId(),
          threadId: thread.id,
          role: input.role as FakeMessageRow["role"],
          contentJson: input.contentJson,
          runId: input.runId ?? null,
          createdAt: new Date(),
        };
        messages.push(row);
        return { ...row };
      },
      async linkUserMessageToRun(input: LinkUserMessageInput) {
        links.push({ ...input });
        const row = messages.find((message) => message.id === input.messageId);
        if (row === undefined || row.role !== "user") {
          throw DbError.notFound("user message");
        }
        row.runId = input.runId;
        return { ...row };
      },
      async insertToolMessageRow(input: ToolMessageInput) {
        toolMessageInserts.push({ ...input });
        const run = requireRunRow(input.runId);
        if (run.threadId !== input.threadId) {
          throw DbError.conflict("Run does not belong to this thread");
        }
        const row: FakeMessageRow = {
          id: nextMessageId(),
          threadId: input.threadId,
          role: "tool",
          contentJson: {
            kind: "tool",
            toolCallId: input.toolCallId,
            tool: input.tool,
            payload: input.payload,
          },
          runId: input.runId,
          createdAt: new Date(),
        };
        messages.push(row);
        return { ...row };
      },
      async insertAssistantMessageRow(input: AssistantMessageInput) {
        assistantInserts.push({ ...input });
        const run = requireRunRow(input.runId);
        if (run.threadId !== input.threadId) {
          throw DbError.conflict("Run does not belong to this thread");
        }
        const gate = assistantGate;
        if (gate !== null) {
          assistantGate = null; // armed for exactly the first gated insert
          gate.reached.resolve();
          await gate.pending.promise;
          if (gate.failFirst) {
            throw new Error("gated assistant insert failure (test)");
          }
        }
        // Real repo: content_json = { message, status, …payload } — the round-12
        // turnKey idempotency carrier rides at the top level.
        const row: FakeMessageRow = {
          id: nextMessageId(),
          threadId: input.threadId,
          role: "assistant",
          contentJson: { message: input.text, status: input.status, ...(input.payload ?? {}) },
          runId: input.runId,
          createdAt: new Date(),
        };
        messages.push(row);
        return { ...row };
      },
      async loadThreadHistory(threadId: string): Promise<ThreadHistoryMessage[]> {
        const thread = threads.get(threadId);
        if (thread === undefined) throw DbError.notFound(`thread ${threadId} not found`);
        const entries: ThreadHistoryMessage[] = [];
        for (const row of messages) {
          if (row.threadId !== threadId) continue;
          const entry = historyEntryOf(row);
          if (entry !== null) entries.push(entry);
        }
        return entries;
      },
    },
    runs: {
      async create(workspaceId: string, input: RunCreateCall["input"]) {
        const thread = threads.get(input.threadId);
        if (thread === undefined || thread.workspaceId !== workspaceId) {
          throw DbError.notFound(`thread ${input.threadId} not found`);
        }
        // Spy on SUCCESSFUL creates only: the step-0 idempotent-tolerant retry
        // ATTEMPTS create again (the conflict is tolerated + reused), and the
        // attempt itself is not a second row.
        if (runs.has(input.runId)) throw DbError.conflict("Could not create run");
        runCreates.push({ workspaceId, input: { ...input } });
        const row: FakeRunRow = {
          id: input.runId,
          workspaceId,
          threadId: input.threadId,
          projectId: input.projectId,
          model: input.model,
          status: "queued", // the real repo's create state; heartbeat flips it
          planJson: null,
          reservedCredits: input.reservedCredits,
          committedCredits: 0,
          baseVersionId: input.baseVersionId,
          lastStepIndex: 0,
          heartbeatAt: new Date(),
          errorCode: null,
          completedAt: null,
          createdAt: new Date(),
        };
        runs.set(row.id, row);
        return { ...row };
      },
      async get(workspaceId: string, runId: string) {
        const run = requireRunRow(runId);
        if (run.workspaceId !== workspaceId) {
          throw DbError.notFound(`run ${runId} not found`);
        }
        return {
          run: { ...run },
          steps: steps.filter((step) => step.runId === runId).map((step) => ({ ...step })),
        };
      },
      async update(
        workspaceId: string,
        runId: string,
        input: { planJson?: unknown; status?: string },
      ) {
        runUpdates.push({ runId, input: { ...input } });
        const run = requireRunRow(runId);
        if (run.workspaceId !== workspaceId) {
          throw DbError.notFound(`run ${runId} not found`);
        }
        if (input.planJson !== undefined) run.planJson = input.planJson;
        // Mirrors the real repo's update: a status write lands on the row
        // (the plan route's run-completion marking) and terminal statuses
        // stamp completedAt.
        if (input.status !== undefined) {
          run.status = input.status;
          if (input.status === "completed") run.completedAt = new Date();
        }
        return { ...run };
      },
      async insertToolCallStep(input: ToolCallStepInput) {
        toolStepCalls.push({ ...input });
        const run = requireRunRow(input.runId);
        if (input.threadId !== undefined && input.threadId !== run.threadId) {
          throw DbError.conflict("Run does not belong to this thread");
        }
        const row: FakeStepRow = {
          id: `stp_${steps.length + 1}`,
          runId: input.runId,
          toolCallId: input.toolCallId,
          tool: input.tool,
          argsJson: input.argsJson,
          status: "issued",
          resultJson: undefined,
        };
        steps.push(row);
        return { ...row };
      },
      async completeToolStep(input: CompleteToolStepInput) {
        stepCompletions.push({ ...input });
        const row = steps.find((step) => step.toolCallId === input.toolCallId);
        if (row === undefined) throw DbError.notFound("step");
        row.status = "success";
        row.resultJson = input.resultJson;
        return { ...row };
      },
      async touchRunHeartbeat(input: TouchRunHeartbeatInput) {
        heartbeats.push({ ...input });
        const run = requireRunRow(input.runId);
        run.status = "running";
        run.lastStepIndex = input.lastStepIndex;
        run.heartbeatAt = new Date();
        if (input.creditsCommitted !== undefined) run.committedCredits = input.creditsCommitted;
        return { ...run };
      },
      async markRunAbandoned(input: MarkRunAbandonedInput) {
        abandons.push({ ...input });
        const run = requireRunRow(input.runId);
        if (run.status === "cancelled") return { ...run }; // idempotent re-sweep
        run.status = "cancelled";
        run.errorCode = RUN_ABANDONED_ERROR_CODE;
        run.completedAt = new Date();
        return { ...run };
      },
    },
    ledger: {
      async balance(workspaceId: string): Promise<number> {
        balanceReads += 1;
        void workspaceId;
        return balanceMicrocredits;
      },
      async reserve(
        workspaceId: string,
        input: { runId: string | null; amount: number; idempotencyKey: string },
      ) {
        if (seenLedgerKeys.has(input.idempotencyKey)) {
          return {
            entry: { id: "led_replayed", workspaceId, amount: input.amount },
            replayed: true,
          };
        }
        seenLedgerKeys.add(input.idempotencyKey);
        ledgerOps.push({
          op: "reserve",
          workspaceId,
          runId: input.runId,
          amount: input.amount,
          idempotencyKey: input.idempotencyKey,
        });
        return {
          entry: { id: `led_${ledgerOps.length}`, workspaceId, amount: input.amount },
          replayed: false,
        };
      },
      async settle(
        workspaceId: string,
        input: { runId: string | null; actualCost: number; idempotencyKey: string },
      ) {
        if (seenLedgerKeys.has(input.idempotencyKey)) {
          return { commit: null, refund: null, replayed: true };
        }
        seenLedgerKeys.add(input.idempotencyKey);
        ledgerOps.push({
          op: "settle",
          workspaceId,
          runId: input.runId,
          actualCost: input.actualCost,
          idempotencyKey: input.idempotencyKey,
        });
        return { commit: null, refund: null, replayed: false };
      },
      async refundAll(
        workspaceId: string,
        input: { runId: string | null; idempotencyKey: string },
      ) {
        if (seenLedgerKeys.has(input.idempotencyKey)) {
          return { entry: null, refunded: 0, replayed: true };
        }
        seenLedgerKeys.add(input.idempotencyKey);
        ledgerOps.push({
          op: "refundAll",
          workspaceId,
          runId: input.runId,
          idempotencyKey: input.idempotencyKey,
        });
        return { entry: null, refunded: 1, replayed: false };
      },
      // AUD-C2: the turn route's reserve-replay triage resolves the turn's
      // durable outcome through this seam (mirrors the real repo's key
      // lookup, including the settle's derived `:commit` sub-key).
      async getEntryByIdempotencyKey(
        workspaceId: string,
        idempotencyKey: string,
      ): Promise<{
        id: string;
        workspaceId: string;
        amount: number;
        createdAt: Date;
      } | null> {
        // settle(key) records its commit as deriveIdempotencyKey(key, "commit")
        // — strip the `:commit` suffix and unescape the %3A colons to recover
        // the base settle key the fake recorded.
        const seen = (key: string): boolean => seenLedgerKeys.has(key);
        const derivedCommitSeen =
          idempotencyKey.endsWith(":commit") &&
          seen(idempotencyKey.slice(0, -":commit".length).replaceAll("%3A", ":"));
        if (!seen(idempotencyKey) && !derivedCommitSeen) return null;
        return {
          id: `led_${idempotencyKey}`,
          workspaceId,
          amount: 0,
          createdAt: new Date(),
        };
      },
    },
    settings: {
      async getUserAutoApply(userId: string): Promise<boolean> {
        autoApplyReads += 1;
        void userId;
        return autoApplyEnabled;
      },
    },
  } as unknown as Repos;

  return {
    repos,
    // the spy surface (read-only by convention in tests)
    runCreates,
    heartbeats,
    toolStepCalls,
    stepCompletions,
    toolMessageInserts,
    assistantInserts,
    userMessages,
    links,
    abandons,
    runUpdates,
    ledgerOps,
    countBalanceReads: (): number => balanceReads,
    countAutoApplyReads: (): number => autoApplyReads,
    // fixtures
    addThread(threadId: string, workspaceId: string): void {
      threads.set(threadId, {
        id: threadId,
        workspaceId,
        projectId: PROJECT_ID,
        title: `Thread ${threadId}`,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      if (!projects.has(PROJECT_ID)) {
        projects.set(PROJECT_ID, {
          id: PROJECT_ID,
          workspaceId,
          name: "Fake project",
          currentVersionId: BASE_VERSION_ID,
        });
      }
    },
    seedRun(input: { runId: string; threadId: string; status?: string }): void {
      const thread = threads.get(input.threadId);
      runs.set(input.runId, {
        id: input.runId,
        workspaceId: thread?.workspaceId ?? "",
        threadId: input.threadId,
        projectId: PROJECT_ID,
        model: "studio-fast",
        status: input.status ?? "running",
        planJson: null,
        reservedCredits: 0,
        committedCredits: 0,
        baseVersionId: BASE_VERSION_ID,
        lastStepIndex: 0,
        heartbeatAt: new Date(),
        errorCode: null,
        completedAt: null,
        createdAt: new Date(),
      });
    },
    setBalance(microcredits: number): void {
      balanceMicrocredits = microcredits;
    },
    setAutoApply(enabled: boolean): void {
      autoApplyEnabled = enabled;
    },
    gateAssistantInsert,
    // row readers
    runRow: (runId: string): FakeRunRow | undefined => runs.get(runId),
    stepRow: (toolCallId: string): FakeStepRow | undefined =>
      steps.find((step) => step.toolCallId === toolCallId),
    assistantRows: (): readonly FakeMessageRow[] =>
      messages.filter((row) => row.role === "assistant"),
    userRows: (): readonly FakeMessageRow[] => messages.filter((row) => row.role === "user"),
  };
}

// ---------------------------------------------------------------------------
// App shell: the deps/requestId/error-boundary prefix buildApp gives every
// route, plus ONLY the turn router (see the file header for why the §7.2
// body-idempotency middleware is intentionally absent here).
// ---------------------------------------------------------------------------

function buildTurnApp(deps: GatewayDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("*", async (c, next) => {
    c.set("deps", deps);
    await next();
  });
  app.use("*", requestIdMiddleware());
  app.onError((error, c) => {
    const requestId = c.get("requestId") ?? "req_unknown";
    const { status, envelope } = toErrorEnvelope(error, requestId);
    return c.json(envelope, status as ContentfulStatusCode);
  });
  app.route("/", turnRoutes(deps));
  return app;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Session {
  readonly cookie: string;
  readonly workspaceId: string;
}

function sessionJar(member: { user: { token: string }; org: { id: string } }): Session {
  return { cookie: `session=${member.user.token}`, workspaceId: member.org.id };
}

let auth: FakeGatewayAuth;
let fakes: ReturnType<typeof makeTurnRepos>;
let app: Hono<AppBindings>;
let session: Session;

beforeEach(() => {
  auth = new FakeGatewayAuth();
  fakes = makeTurnRepos();
  app = buildTurnApp(stubDeps(env, { auth, repos: fakes.repos }));
  const member = auth.signUp("owner");
  session = sessionJar(member);
  fakes.addThread(THREAD_MAIN, session.workspaceId);
  fakes.addThread(THREAD_OTHER, session.workspaceId);
});

function turnBody(runId: string, stepIndex: number, messages: readonly TurnMessage[]) {
  return { runId, stepIndex, model: "studio-fast", messages };
}

async function postTurn(
  threadId: string,
  body: unknown,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<Response> {
  return app.request(`/v1/threads/${threadId}/turn`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: session.cookie,
      "x-workspace-id": session.workspaceId,
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
}

async function postRunAction(path: string, body?: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: session.cookie,
      "x-workspace-id": session.workspaceId,
      "idempotency-key": unique("runs-action"),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function errOf(
  response: Response,
): Promise<{ status: number; code: string; message: string }> {
  const body = (await response.json()) as { error?: { code: string; message: string } };
  return {
    status: response.status,
    code: body.error?.code ?? "",
    message: body.error?.message ?? "",
  };
}

/** The §7.4 wire pin: every frame parses as a StudioStreamEvent with id = seq. */
function expectValidStream(events: readonly SseEvent[], runId: string): void {
  expect(events.length).toBeGreaterThan(0);
  for (const event of events) {
    expect(STUDIO_STREAM_EVENT_SCHEMA.safeParse(event.data).success).toBe(true);
    expect(event.data.runId).toBe(runId);
    expect(event.id).toBe(event.data.seq);
  }
}

interface TurnCompletedData {
  readonly type: "turn.completed";
  readonly stepIndex: number;
  readonly finishReason: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly credits: { readonly committed: number };
  readonly assistantText?: string;
  readonly toolCalls: readonly TurnToolCall[];
}

function completedOf(events: readonly SseEvent[]): TurnCompletedData {
  const found = events.find((event) => event.data.type === "turn.completed");
  if (found === undefined) throw new Error("no turn.completed event in stream");
  return found.data as unknown as TurnCompletedData;
}

interface TurnFailedData {
  readonly stepIndex: number;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly credits: { readonly committed: number };
}

function failedOf(events: readonly SseEvent[]): TurnFailedData {
  const found = events.find((event) => event.data.type === "turn.failed");
  if (found === undefined) throw new Error("no turn.failed event in stream");
  return found.data as unknown as TurnFailedData;
}

function deltaText(events: readonly SseEvent[]): string {
  return events
    .filter((event) => event.data.type === "message.delta")
    .map((event) => (event.data as { delta: string }).delta)
    .join("");
}

/** ROUND 13: the concatenated reasoning.delta payloads. */
function reasoningText(events: readonly SseEvent[]): string {
  return events
    .filter((event) => event.data.type === "reasoning.delta")
    .map((event) => (event.data as { delta: string }).delta)
    .join("");
}

function eventTypes(events: readonly SseEvent[]): string[] {
  return events.map((event) => String(event.data.type));
}

/** The client's step-1 transcript: echo the step-0 toolCalls + results. */
function step1Transcript(completed: TurnCompletedData): TurnMessage[] {
  return [
    { role: "user", text: USER_TEXT },
    { role: "assistant", text: completed.assistantText ?? "" },
    ...completed.toolCalls.map(
      (call): TurnMessage => ({
        role: "tool_call",
        toolCallId: call.toolCallId,
        tool: call.tool,
        args: call.args,
      }),
    ),
    ...completed.toolCalls.map(
      (call): TurnMessage => ({
        role: "tool_result",
        toolCallId: call.toolCallId,
        tool: call.tool,
        result: call.resultForModel,
      }),
    ),
  ];
}

/** Mirrors routes/turn.ts:221-226 — the step-0 reserve from the assembled prompt. */
function expectedStep0Reserve(): number {
  const prompt = buildTurnMessages({
    history: [],
    transcript: [{ role: "user", text: USER_TEXT }],
    canvas: null,
  });
  const estimate = Math.max(1, Math.min(12, Math.ceil(JSON.stringify(prompt).length / 4000)));
  return creditsToLedgerMicrocredits(reserveAmountFor(estimate));
}

function contentOf(row: FakeMessageRow | undefined): Record<string, unknown> {
  return (row?.contentJson ?? {}) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 1. The two-turn mock run
// ---------------------------------------------------------------------------

describe("POST /v1/threads/:id/turn — the mock turn loop (12-w5-t4)", () => {
  it("step 0 streams the propose-only mock turn and persists the durable outcome", async () => {
    const runId = unique("run");
    const response = await postTurn(
      THREAD_MAIN,
      turnBody(runId, 0, [{ role: "user", text: USER_TEXT }]),
      `${runId}:0`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const events = await readSse(response);
    expectValidStream(events, runId);
    expect(eventTypes(events)).toEqual([
      "run.started",
      "turn.started",
      // ROUND 13 (live thinking): the mock streams its plan as reasoning
      // deltas BEFORE the text — the thinking bar renders live.
      "reasoning.delta",
      "reasoning.delta",
      "reasoning.delta",
      "message.delta",
      "tool.started",
      "tool.started",
      "turn.completed",
    ]);
    expect(events[0]?.data).toMatchObject({ type: "run.started", model: "studio-fast" });
    expect(events[1]?.data).toMatchObject({ type: "turn.started", stepIndex: 0 });
    expect(reasoningText(events)).toBe(STEP0_REASONING);
    expect(deltaText(events)).toBe(STEP0_TEXT);

    const completed = completedOf(events);
    expect(completed.stepIndex).toBe(0);
    expect(completed.finishReason).toBe("tool-calls");
    expect(completed.usage).toEqual({ inputTokens: 900, outputTokens: 200 });
    expect(completed.credits).toEqual({ committed: 1 });
    expect(completed.assistantText).toBe(STEP0_TEXT);
    expect(completed.reasoningText).toBe(STEP0_REASONING);
    expect(completed.toolCalls).toHaveLength(2);

    const [composition, text] = completed.toolCalls;
    expect(composition?.tool).toBe("studio.create_composition");
    expect(composition?.toolCallId).toBe("call_mock_00");
    expect(composition?.args).toMatchObject({ name: "Agent Demo", width: 1920, height: 1080 });
    expect(composition?.proposal?.compiled.batch.steps.map((step) => step.command)).toEqual([
      "comp.new",
    ]);
    expect(composition?.proposal?.compiled.risk).toBe("medium");
    expect(text?.tool).toBe("studio.create_text");
    expect(text?.toolCallId).toBe("call_mock_01");
    expect(text?.proposal?.compiled.batch.steps.map((step) => step.command)).toEqual([
      "layer.newText",
    ]);
    expect(text?.resultForModel).toBeTruthy();

    // The tool.started frames light the chips live (§7.4): one per emitted call.
    const started = events.filter((event) => event.data.type === "tool.started");
    expect(started.map((event) => (event.data as { name: string }).name)).toEqual([
      "studio.create_composition",
      "studio.create_text",
    ]);

    // Run row created (client-owned id) + heartbeat flips it running.
    expect(fakes.runCreates).toHaveLength(1);
    expect(fakes.runCreates[0]?.input).toMatchObject({
      runId,
      threadId: THREAD_MAIN,
      projectId: PROJECT_ID,
      model: "studio-fast",
      baseVersionId: BASE_VERSION_ID,
      reservedCredits: 0,
    });
    const run = fakes.runRow(runId);
    expect(run?.status).toBe("running");
    expect(run?.lastStepIndex).toBe(0);
    expect(run?.heartbeatAt instanceof Date).toBe(true);
    expect(run?.committedCredits).toBe(1);
    expect(fakes.heartbeats.map((beat) => beat.lastStepIndex)).toEqual([0, 0]);

    // The user turn persisted + correlated to the run.
    const users = fakes.userRows();
    expect(users).toHaveLength(1);
    expect(contentOf(users[0])).toMatchObject({ message: USER_TEXT });
    expect(fakes.links).toEqual([{ messageId: users[0]?.id, runId }]);

    // Step rows issued for both tool calls.
    expect(fakes.toolStepCalls.map((call) => call.toolCallId)).toEqual([
      "call_mock_00",
      "call_mock_01",
    ]);
    expect(fakes.toolStepCalls.every((call) => call.stepIndex === 0)).toBe(true);
    expect(fakes.stepRow("call_mock_00")?.status).toBe("issued");
    expect(fakes.stepRow("call_mock_01")?.status).toBe("issued");

    // The durable outcome: assistant row keyed by turnKey (replay carrier).
    const rows = fakes.assistantRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.runId).toBe(runId);
    expect(contentOf(rows[0])).toMatchObject({
      message: STEP0_TEXT,
      status: "completed",
      turnKey: `${runId}:0`,
      stepIndex: 0,
      committed: 1,
      reasoning: STEP0_REASONING,
    });

    // §8.8 per-turn credits: balance precheck, reserve (exact µc), settle (1 credit).
    expect(fakes.countBalanceReads()).toBeGreaterThanOrEqual(1);
    const reserve = fakes.ledgerOps.find((op) => op.op === "reserve");
    expect(reserve?.idempotencyKey).toBe(`turn:${runId}:0:reserve`);
    expect(reserve?.amount).toBe(expectedStep0Reserve());
    const settle = fakes.ledgerOps.find((op) => op.op === "settle");
    expect(settle?.idempotencyKey).toBe(`turn:${runId}:0:settle`);
    expect(settle?.actualCost).toBe(MICROCREDITS_PER_CREDIT);
  });

  it("step 1 settles the echoed tool_results (resultForModel), finishes with a text turn, and heartbeats the run", async () => {
    const runId = unique("run");
    const step0 = await postTurn(
      THREAD_MAIN,
      turnBody(runId, 0, [{ role: "user", text: USER_TEXT }]),
      `${runId}:0`,
    );
    const step0Completed = completedOf(await readSse(step0));

    const step1 = await postTurn(
      THREAD_MAIN,
      turnBody(runId, 1, step1Transcript(step0Completed)),
      `${runId}:1`,
    );
    expect(step1.status).toBe(200);
    const events = await readSse(step1);
    expectValidStream(events, runId);
    expect(eventTypes(events)).toEqual([
      "run.started",
      "turn.started",
      "message.delta",
      "turn.completed",
    ]);
    expect(deltaText(events)).toBe(STEP1_TEXT);

    const final = completedOf(events);
    expect(final.stepIndex).toBe(1);
    expect(final.finishReason).toBe("stop");
    expect(final.toolCalls).toEqual([]);
    expect(final.assistantText).toBe(STEP1_TEXT);

    // The echoed tool_result parts settle the issued steps + persist tool rows.
    expect(fakes.stepCompletions.map((call) => call.toolCallId)).toEqual([
      "call_mock_00",
      "call_mock_01",
    ]);
    for (const call of fakes.stepCompletions) {
      expect(fakes.stepRow(call.toolCallId)?.status).toBe("success");
      expect(fakes.stepRow(call.toolCallId)?.resultJson).toEqual(call.resultJson);
      expect(call.resultJson).toEqual(
        step0Completed.toolCalls.find((tool) => tool.toolCallId === call.toolCallId)
          ?.resultForModel,
      );
    }
    expect(fakes.toolMessageInserts.map((call) => call.toolCallId)).toEqual([
      "call_mock_00",
      "call_mock_01",
    ]);
    expect(fakes.toolMessageInserts.every((call) => call.runId === runId)).toBe(true);

    // Second durable assistant row, keyed by the step-1 turnKey.
    const rows = fakes.assistantRows();
    expect(rows).toHaveLength(2);
    expect(contentOf(rows[1])).toMatchObject({
      message: STEP1_TEXT,
      status: "completed",
      turnKey: `${runId}:1`,
      stepIndex: 1,
    });

    // Heartbeat: after step 1 the run row's last_step_index is 1 (0008).
    const run = fakes.runRow(runId);
    expect(run?.lastStepIndex).toBe(1);
    expect(run?.status).toBe("running");
    expect(run?.committedCredits).toBe(2);

    // Per-turn credits fired for BOTH turns.
    expect(
      fakes.ledgerOps.filter((op) => op.op === "reserve").map((op) => op.idempotencyKey),
    ).toEqual([`turn:${runId}:0:reserve`, `turn:${runId}:1:reserve`]);
    expect(
      fakes.ledgerOps.filter((op) => op.op === "settle").map((op) => op.idempotencyKey),
    ).toEqual([`turn:${runId}:0:settle`, `turn:${runId}:1:settle`]);
  });
});

// ---------------------------------------------------------------------------
// 2. Durable idempotent replay
// ---------------------------------------------------------------------------

describe("durable idempotent replay (the Idempotency-Key IS the turn key)", () => {
  it("a same-key duplicate POST replays the STORED outcome — no new rows, no ledger calls, bounded SSE", async () => {
    const runId = unique("run");
    const body = turnBody(runId, 0, [{ role: "user", text: USER_TEXT }]);
    const first = await postTurn(THREAD_MAIN, body, `${runId}:0`);
    const original = completedOf(await readSse(first));

    const assistantBefore = fakes.assistantRows().length;
    const stepsBefore = fakes.toolStepCalls.length;
    const ledgerBefore = fakes.ledgerOps.length;

    const replay = await postTurn(THREAD_MAIN, body, `${runId}:0`);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("content-type")).toContain("text/event-stream");
    const events = await readSse(replay);
    expectValidStream(events, runId);
    // Bounded replay: the stored outcome, not a second model turn.
    expect(eventTypes(events)).toEqual(["run.started", "turn.started", "turn.completed"]);
    const replayed = completedOf(events);
    expect(replayed.stepIndex).toBe(original.stepIndex);
    expect(replayed.finishReason).toBe(original.finishReason);
    expect(replayed.usage).toEqual(original.usage);
    expect(replayed.assistantText).toBe(original.assistantText);
    // ROUND 13: the replay restores the thinking text too (no delta re-stream).
    expect(replayed.reasoningText).toBe(original.reasoningText);
    expect(replayed.toolCalls).toEqual(original.toolCalls);
    // Documented replay semantics: credits were already committed by the
    // original turn, so the replay carries committed: 0.
    expect(replayed.credits).toEqual({ committed: 0 });

    // Nothing re-ran: no new assistant row, no new steps, no ledger mutation.
    expect(fakes.assistantRows()).toHaveLength(assistantBefore);
    expect(fakes.toolStepCalls).toHaveLength(stepsBefore);
    expect(fakes.ledgerOps).toHaveLength(ledgerBefore);
    expect(fakes.runCreates).toHaveLength(1);
  });

  it("a request aborted mid-stream lets the mock turn finish durably; the same-key retry replays it", async () => {
    const runId = unique("run");
    const body = turnBody(runId, 0, [{ role: "user", text: USER_TEXT }]);
    const gate = fakes.gateAssistantInsert(false); // hold the turn mid-flight
    const controller = new AbortController();
    const response = await postTurn(THREAD_MAIN, body, `${runId}:0`, controller.signal);
    await gate.reached;
    controller.abort(); // the browser tears the SSE connection down
    gate.release();

    const events = await readSse(response);
    // PRODUCT NOTE (worklog): the MOCK turn never observes the abort signal,
    // so the turn completes + settles durably — an aborted request alone does
    // NOT produce turn.failed under MOCK_MODEL (the real model path's
    // executeModelTurn would abort).
    expect(eventTypes(events)).toContain("turn.completed");
    expect(fakes.ledgerOps.some((op) => op.op === "refundAll")).toBe(false);
    expect(contentOf(fakes.assistantRows()[0])).toMatchObject({ turnKey: `${runId}:0` });

    // The client retries with the SAME key: the stored outcome replays —
    // bounded to ONE execution, no duplicate assistant row.
    const retry = await postTurn(THREAD_MAIN, body, `${runId}:0`);
    const retryEvents = await readSse(retry);
    expect(eventTypes(retryEvents)).toEqual(["run.started", "turn.started", "turn.completed"]);
    expect(fakes.assistantRows()).toHaveLength(1);
  });

  // The round-12 step-0 idempotent-tolerant run creation: a crashed step 0
  // (run row + user row persisted, durable assistant row NOT) retried under
  // the SAME key reuses the existing run instead of failing on the create
  // conflict — and does NOT persist a second user row (the transcript always
  // carries the user message, so a rare crash window only risks a MISSING
  // history row, never a duplicate).
  it("a step-0 crash after the run row exists: the same-key retry reuses the run, skips the duplicate user row, and re-runs the model", async () => {
    const runId = unique("run");
    // Attempt 1 — the durable assistant insert fails AFTER run + user rows.
    const gate = fakes.gateAssistantInsert(true);
    const first = await postTurn(
      THREAD_MAIN,
      turnBody(runId, 0, [{ role: "user", text: USER_TEXT }]),
      `${runId}:0`,
    );
    await gate.reached;
    gate.release();
    const events = await readSse(first);
    expect(eventTypes(events)).toEqual([
      "run.started",
      "turn.started",
      "reasoning.delta",
      "reasoning.delta",
      "reasoning.delta",
      "message.delta",
      "tool.started",
      "tool.started",
      "turn.failed",
    ]);
    expect(fakes.runCreates).toHaveLength(1);
    expect(fakes.userRows()).toHaveLength(1);
    expect(fakes.assistantRows().some((row) => contentOf(row).turnKey === `${runId}:0`)).toBe(
      false,
    ); // no durable outcome — the retry must re-run the model

    // Attempt 2 (same key) — runs.create would conflict; tolerated: REUSED.
    const retry = await postTurn(
      THREAD_MAIN,
      turnBody(runId, 0, [{ role: "user", text: USER_TEXT }]),
      `${runId}:0`,
    );
    const retryEvents = await readSse(retry);
    expect(eventTypes(retryEvents)).toEqual([
      "run.started",
      "turn.started",
      "reasoning.delta",
      "reasoning.delta",
      "reasoning.delta",
      "message.delta",
      "tool.started",
      "tool.started",
      "turn.completed",
    ]);
    expect(deltaText(retryEvents)).toBe(STEP0_TEXT);
    // The run row is REUSED (no second create) and the user row NOT duplicated.
    expect(fakes.runCreates).toHaveLength(1);
    expect(fakes.userRows()).toHaveLength(1);
    expect(fakes.links).toHaveLength(1);
    // The retry produced the durable outcome the crash lost.
    expect(fakes.assistantRows().some((row) => contentOf(row).turnKey === `${runId}:0`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3-5. Guards
// ---------------------------------------------------------------------------

describe("turn request guards", () => {
  it("stepIndex > 0 before step 0 → 404 RUN_NOT_FOUND (the run does not exist yet)", async () => {
    const runId = unique("run");
    const messages: TurnMessage[] = [
      { role: "user", text: USER_TEXT },
      {
        role: "tool_result",
        toolCallId: "call_x",
        tool: "studio.create_text",
        result: { ok: true },
      },
    ];
    const { status, code } = await errOf(
      await postTurn(THREAD_MAIN, turnBody(runId, 1, messages), `${runId}:1`),
    );
    expect(status).toBe(404);
    expect(code).toBe("RUN_NOT_FOUND");
    expect(fakes.ledgerOps).toEqual([]); // no reserve ever fired
    expect(fakes.runCreates).toEqual([]);
  });

  it("a thread in another workspace reads as 404 THREAD_NOT_FOUND (§12.1 — existence never leaks)", async () => {
    const runId = unique("run");
    const stranger = sessionJar(auth.signUp("owner"));
    const saved = session;
    session = stranger;
    try {
      const { status, code } = await errOf(
        await postTurn(
          THREAD_MAIN,
          turnBody(runId, 0, [{ role: "user", text: USER_TEXT }]),
          `${runId}:0`,
        ),
      );
      expect(status).toBe(404);
      expect(code).toBe("THREAD_NOT_FOUND");
    } finally {
      session = saved;
    }
    expect(fakes.runCreates).toEqual([]);
  });

  it("a run attached to another thread → 404 RUN_NOT_ACTIVE", async () => {
    const runId = unique("run");
    fakes.seedRun({ runId, threadId: THREAD_MAIN });
    const { status, code } = await errOf(
      await postTurn(
        THREAD_OTHER,
        turnBody(runId, 1, [{ role: "user", text: USER_TEXT }]),
        `${runId}:1`,
      ),
    );
    expect(status).toBe(404);
    expect(code).toBe("RUN_NOT_ACTIVE");
  });

  it("an Idempotency-Key ≠ `${runId}:${stepIndex}` (or missing) → 400 VALIDATION_FAILED", async () => {
    const runId = unique("run");
    const wrong = await errOf(
      await postTurn(
        THREAD_MAIN,
        turnBody(runId, 0, [{ role: "user", text: USER_TEXT }]),
        `${runId}:1`,
      ),
    );
    expect(wrong.status).toBe(400);
    expect(wrong.code).toBe("VALIDATION_FAILED");

    const missing = await app.request(`/v1/threads/${THREAD_MAIN}/turn`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: session.cookie,
        "x-workspace-id": session.workspaceId,
      },
      body: JSON.stringify(turnBody(runId, 0, [{ role: "user", text: USER_TEXT }])),
    });
    expect(missing.status).toBe(400);
    expect((await errOf(missing)).code).toBe("VALIDATION_FAILED");

    expect(fakes.runCreates).toEqual([]);
  });

  it("a zero balance → 402 INSUFFICIENT_CREDITS before any side effect (§8.8)", async () => {
    fakes.setBalance(0);
    const runId = unique("run");
    const { status, code } = await errOf(
      await postTurn(
        THREAD_MAIN,
        turnBody(runId, 0, [{ role: "user", text: USER_TEXT }]),
        `${runId}:0`,
      ),
    );
    expect(status).toBe(402);
    expect(code).toBe("INSUFFICIENT_CREDITS");
    expect(fakes.ledgerOps).toEqual([]);
    expect(fakes.runCreates).toEqual([]);
    expect(fakes.userRows()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. turn failure → refund (§8.8)
// ---------------------------------------------------------------------------

describe("turn failure semantics (failed turns refund and never persist the turnKey)", () => {
  it("a mid-turn persistence failure emits turn.failed INTERNAL, refunds the hold, and a same-key retry re-runs the model", async () => {
    const runId = unique("run");
    await readSse(
      await postTurn(
        THREAD_MAIN,
        turnBody(runId, 0, [{ role: "user", text: USER_TEXT }]),
        `${runId}:0`,
      ),
    );
    const step0Completed = fakes
      .assistantRows()
      .map((row) => contentOf(row).toolCalls as TurnToolCall[])
      .find((calls) => calls !== undefined);
    const transcript: TurnMessage[] = [
      { role: "user", text: USER_TEXT },
      { role: "assistant", text: STEP0_TEXT },
      ...(step0Completed ?? []).map(
        (call): TurnMessage => ({
          role: "tool_call",
          toolCallId: call.toolCallId,
          tool: call.tool,
          args: call.args,
        }),
      ),
      ...(step0Completed ?? []).map(
        (call): TurnMessage => ({
          role: "tool_result",
          toolCallId: call.toolCallId,
          tool: call.tool,
          result: call.resultForModel,
        }),
      ),
    ];

    const gate = fakes.gateAssistantInsert(true); // the durable insert fails
    const response = await postTurn(THREAD_MAIN, turnBody(runId, 1, transcript), `${runId}:1`);
    await gate.reached;
    gate.release();

    const events = await readSse(response);
    expectValidStream(events, runId);
    expect(eventTypes(events)).toEqual([
      "run.started",
      "turn.started",
      "message.delta",
      "turn.failed",
    ]);
    const failed = failedOf(events);
    expect(failed.stepIndex).toBe(1);
    expect(failed.code).toBe("INTERNAL");
    expect(failed.retryable).toBe(false);
    expect(failed.credits).toEqual({ committed: 0 });

    // The per-turn hold is refunded; nothing settles for the failed turn.
    expect(
      fakes.ledgerOps.some(
        (op) => op.op === "refundAll" && op.idempotencyKey === `turn:${runId}:1:refund`,
      ),
    ).toBe(true);
    expect(
      fakes.ledgerOps.some(
        (op) => op.op === "settle" && op.idempotencyKey === `turn:${runId}:1:settle`,
      ),
    ).toBe(false);

    // Partial text kept honestly (status "failed") — and NO turnKey row: a
    // retry must re-run the model, never replay a failure.
    const failedRows = fakes.assistantRows().filter((row) => contentOf(row).status === "failed");
    expect(failedRows).toHaveLength(1);
    expect(contentOf(failedRows[0])).toMatchObject({ message: STEP1_TEXT, status: "failed" });
    expect(contentOf(failedRows[0]).turnKey).toBeUndefined();
    expect(fakes.assistantRows().some((row) => contentOf(row).turnKey === `${runId}:1`)).toBe(
      false,
    );

    // The same-key retry RE-RUNS the turn (deltas + completion, not a replay).
    const retry = await postTurn(THREAD_MAIN, turnBody(runId, 1, transcript), `${runId}:1`);
    const retryEvents = await readSse(retry);
    expect(eventTypes(retryEvents)).toEqual([
      "run.started",
      "turn.started",
      "message.delta",
      "turn.completed",
    ]);
    expect(deltaText(retryEvents)).toBe(STEP1_TEXT);
    expect(fakes.assistantRows().some((row) => contentOf(row).turnKey === `${runId}:1`)).toBe(true);
    expect(
      fakes.ledgerOps.some(
        (op) => op.op === "settle" && op.idempotencyKey === `turn:${runId}:1:settle`,
      ),
    ).toBe(true);
  });

  it("a request aborted mid-turn with delivered output → TURN_CANCELLED + the partial usage SETTLES (AUD-C1)", async () => {
    const runId = unique("run");
    const gate = fakes.gateAssistantInsert(true);
    const controller = new AbortController();
    const response = await postTurn(
      THREAD_MAIN,
      turnBody(runId, 0, [{ role: "user", text: USER_TEXT }]),
      `${runId}:0`,
      controller.signal,
    );
    await gate.reached;
    // The abort fires the route's onAbort → the turn's AbortController; the
    // persistence call then fails while the turn is aborted, which is the
    // code path the real model's AbortError takes (see the worklog note: the
    // MOCK model alone never observes the abort signal).
    controller.abort();
    gate.release();

    const events = await readSse(response);
    expectValidStream(events, runId);
    expect(eventTypes(events)).toEqual([
      "run.started",
      "turn.started",
      "reasoning.delta",
      "reasoning.delta",
      "reasoning.delta",
      "message.delta",
      "tool.started",
      "tool.started",
      "turn.failed",
    ]);
    const failed = failedOf(events);
    expect(failed.stepIndex).toBe(0);
    expect(failed.code).toBe("TURN_CANCELLED");
    expect(failed.message).toBe("The turn was cancelled.");
    expect(failed.retryable).toBe(false);

    // AUD-C1 abort-honesty: the stream DELIVERED deltas before the abort, so
    // the turn settles the server-measured partial usage instead of the
    // pre-fix free full refund — "stream then abort at 95%" now bills what
    // it consumed (the §8.8 min-1 floor guarantees a visible charge).
    expect(typeof failed.credits.committed).toBe("number");
    expect(failed.credits.committed).toBeGreaterThanOrEqual(1);
    expect(
      fakes.ledgerOps.some(
        (op) => op.op === "settle" && op.idempotencyKey === `turn:${runId}:0:settle`,
      ),
    ).toBe(true);
    expect(
      fakes.ledgerOps.some(
        (op) => op.op === "refundAll" && op.idempotencyKey === `turn:${runId}:0:refund`,
      ),
    ).toBe(false);
    expect(fakes.assistantRows()).toHaveLength(1); // the partial-text failed row only
    expect(contentOf(fakes.assistantRows()[0])).toMatchObject({
      message: STEP0_TEXT,
      status: "failed",
    });
    expect(contentOf(fakes.assistantRows()[0]).turnKey).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 7. POST /v1/runs/:id/plan
// ---------------------------------------------------------------------------

describe("POST /v1/runs/:id/plan (the client's merged plan lands at run end)", () => {
  it("stores + re-compiles a valid plan and stamps the §7.3 auto-apply verdict", async () => {
    const runId = unique("run");
    await readSse(
      await postTurn(
        THREAD_MAIN,
        turnBody(runId, 0, [{ role: "user", text: USER_TEXT }]),
        `${runId}:0`,
      ),
    );

    const plan = mockEditPlan();
    const response = await postRunAction(`/v1/runs/${runId}/plan`, { plan });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      runId: string;
      plan: EditPlan;
      autoApply: { mode: string; reason: string };
      baseVersionId?: string;
      compiledBatch?: { steps: Array<{ command: string }> };
      risk?: string;
      estimatedCredits?: number;
      resolutionRequests?: unknown[];
    };
    expect(body.runId).toBe(runId);
    // AUD-H2: the stored/returned plan carries the SERVER-recompiled credit
    // estimate, never the client's own number — a devtools client posting a
    // lowballed estimatedCredits must not become the billed estimate.
    expect(body.plan).toEqual({
      ...plan,
      estimatedCredits: Math.max(1, Math.ceil(body.estimatedCredits ?? 0)),
    });
    expect(body.baseVersionId).toBe(BASE_VERSION_ID);
    expect(body.compiledBatch?.steps.map((step) => step.command)).toEqual([
      "comp.new",
      "layer.newText",
    ]);
    expect(body.risk).toBe("medium");
    expect(typeof body.estimatedCredits).toBe("number");
    expect(body.resolutionRequests).toEqual([]);
    expect(body.autoApply).toEqual({ mode: "auto", reason: "eligible" });

    // The plan POST IS the run's terminal moment (12-w6-e2 finding): the
    // route marks the run COMPLETED first — what makes /v1/runs/:id/apply's
    // D-11 plannable-status gate pass — then stores plan_json (the
    // authoritative copy) on the same run row.
    // AUD-H2: the stored plan carries the SERVER-recompiled estimate.
    const stampedPlan = {
      ...plan,
      estimatedCredits: Math.max(1, Math.ceil(body.estimatedCredits ?? 0)),
    };
    expect(fakes.runUpdates).toHaveLength(2);
    expect(fakes.runUpdates[0]?.input).toEqual({ status: "completed" });
    expect(fakes.runUpdates[1]?.input).toEqual({ planJson: stampedPlan });
    expect(fakes.runRow(runId)?.status).toBe("completed");
    expect(fakes.runRow(runId)?.planJson).toEqual(stampedPlan);
    expect(fakes.countAutoApplyReads()).toBe(1);
  });

  it("{end:true} — the proposal-less run's marker: {runId, ended:true}, the run row marked COMPLETED, no plan stored", async () => {
    const runId = unique("run");
    await readSse(
      await postTurn(
        THREAD_MAIN,
        turnBody(runId, 0, [{ role: "user", text: USER_TEXT }]),
        `${runId}:0`,
      ),
    );
    expect(fakes.runRow(runId)?.status).toBe("running");

    const response = await postRunAction(`/v1/runs/${runId}/plan`, { end: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ runId, ended: true });

    // The run row is closed — no stale "running" row for a read-only run.
    expect(fakes.runUpdates).toEqual([{ runId, input: { status: "completed" } }]);
    expect(fakes.runRow(runId)?.status).toBe("completed");
    expect(fakes.runRow(runId)?.planJson).toBeNull();
    // The end marker never consults the auto-apply setting (nothing to apply).
    expect(fakes.countAutoApplyReads()).toBe(0);

    // Idempotent: a repeat marker on the completed run answers the same
    // body with no further row writes.
    const again = await postRunAction(`/v1/runs/${runId}/plan`, { end: true });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ runId, ended: true });
    expect(fakes.runUpdates).toHaveLength(1);
  });

  it("rejects an invalid plan body with 400 VALIDATION_FAILED and stores nothing", async () => {
    const runId = unique("run");
    await readSse(
      await postTurn(
        THREAD_MAIN,
        turnBody(runId, 0, [{ role: "user", text: USER_TEXT }]),
        `${runId}:0`,
      ),
    );
    for (const bad of [{ plan: { intent: "create", summary: "no steps" } }, { plan: null }, null]) {
      const { status, code } = await errOf(await postRunAction(`/v1/runs/${runId}/plan`, bad));
      expect(status).toBe(400);
      expect(code).toBe("VALIDATION_FAILED");
    }
    expect(fakes.runRow(runId)?.planJson).toBeNull();
  });

  it("refuses a plan on an abandoned run with 409 RUN_NOT_ACTIVE", async () => {
    const runId = unique("run");
    await readSse(
      await postTurn(
        THREAD_MAIN,
        turnBody(runId, 0, [{ role: "user", text: USER_TEXT }]),
        `${runId}:0`,
      ),
    );
    const abandon = await postRunAction(`/v1/runs/${runId}/abandon`);
    expect(abandon.status).toBe(200);

    const { status, code } = await errOf(
      await postRunAction(`/v1/runs/${runId}/plan`, { plan: mockEditPlan() }),
    );
    expect(status).toBe(409);
    expect(code).toBe("RUN_NOT_ACTIVE");
    expect(fakes.runRow(runId)?.planJson).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. POST /v1/runs/:id/abandon
// ---------------------------------------------------------------------------

describe("POST /v1/runs/:id/abandon (no zombie running rows)", () => {
  it("marks the run abandoned (RUN_ABANDONED, status cancelled) with a full refund; idempotent on repeat", async () => {
    const runId = unique("run");
    await readSse(
      await postTurn(
        THREAD_MAIN,
        turnBody(runId, 0, [{ role: "user", text: USER_TEXT }]),
        `${runId}:0`,
      ),
    );

    const response = await postRunAction(`/v1/runs/${runId}/abandon`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ runId, status: "abandoned" });

    const run = fakes.runRow(runId);
    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe(RUN_ABANDONED_ERROR_CODE);
    expect(fakes.abandons).toEqual([{ runId }]);
    expect(
      fakes.ledgerOps.some(
        (op) => op.op === "refundAll" && op.idempotencyKey === `turn:${runId}:abandon:refund`,
      ),
    ).toBe(true);

    // Second call: the run is terminal already — same 200, no second refund.
    const second = await postRunAction(`/v1/runs/${runId}/abandon`);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ runId, status: "abandoned" });
    expect(fakes.abandons).toHaveLength(1);
    expect(fakes.ledgerOps.filter((op) => op.op === "refundAll")).toHaveLength(1);
  });

  it("abandoning an unknown run reads as 404 RUN_NOT_FOUND", async () => {
    const { status, code } = await errOf(await postRunAction("/v1/runs/run_missing/abandon"));
    expect(status).toBe(404);
    expect(code).toBe("RUN_NOT_FOUND");
    expect(fakes.ledgerOps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 10. THE REAL-APP AUTO-APPLY CHAIN (DB-gated): turn → POST /v1/runs/:id/plan
//     (marks the run COMPLETED — the D-11 applyable moment) → POST
//     /v1/runs/:id/apply → 200. Proves the 12-w6-e2 blocker is GONE: a plan
//     landed through the REAL app is appliable with no manual status surgery
//     (the apply gesture mirrors tests/apply-flow.test.ts's applyCall shape).
// ---------------------------------------------------------------------------

const db = describe.skipIf(!HAS_DATABASE);

db("turn → plan → apply through the REAL app (the D-11 chain, 12-w7)", () => {
  let server: RunningTestServer;

  beforeAll(async () => {
    server = await bootServer(); // MOCK_MODEL=true — the mock turn, no network
  }, 30_000);

  afterAll(async () => {
    await server?.close();
  });

  /** Raw-bytes version upload through the REAL versions route (D-6). */
  async function uploadSnapshot(
    jar: CookieJar,
    workspaceId: string,
    projectId: string,
    options: { baseVersionId?: string; agentRunId?: string; label?: string } = {},
  ): Promise<{ versionId: string; sha256: string }> {
    const bytes = Buffer.from(`{"turn-route-fixture":"${unique("v")}"}`, "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const query = new URLSearchParams({ sha256, sizeBytes: String(bytes.byteLength) });
    if (options.baseVersionId !== undefined) query.set("baseVersionId", options.baseVersionId);
    if (options.agentRunId !== undefined) query.set("agentRunId", options.agentRunId);
    if (options.label !== undefined) query.set("label", options.label);
    const response = await api(server.base, `/v1/projects/${projectId}/versions?${query}`, {
      method: "POST",
      jar,
      headers: {
        "x-workspace-id": workspaceId,
        "idempotency-key": unique("ver"),
        "content-type": "application/octet-stream",
      },
      rawBody: new Uint8Array(bytes),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { data: { id: string } };
    return { versionId: body.data.id, sha256 };
  }

  it("the plan POST completes the run; the apply passes the D-11 gate and answers 200", async () => {
    // Fresh workspace + credits + project + FIRST snapshot + thread (the
    // run's base_version_id needs a project head).
    const jar = new CookieJar();
    const signup = await api(server.base, "/v1/auth/sign-up/email", {
      method: "POST",
      jar,
      body: {
        email: uniqueEmail("turn-route"),
        password: "Passw0rd!longenough",
        name: "Turn Route Tester",
      },
    });
    expect(signup.status).toBe(200);
    const wsResponse = await api(server.base, "/v1/workspaces", {
      method: "POST",
      jar,
      headers: { "idempotency-key": unique("ws") },
      body: { name: unique("Turn Route WS"), slug: unique("turnroute") },
    });
    expect(wsResponse.status).toBe(201);
    const workspaceId = ((await wsResponse.json()) as { data: { id: string } }).data.id;
    await server.deps.repos.ledger.grant(workspaceId, {
      amount: 100 * MICROCREDITS_PER_CREDIT,
      idempotencyKey: unique("grant"),
    });
    const projectResponse = await api(server.base, "/v1/projects", {
      method: "POST",
      jar,
      headers: { "x-workspace-id": workspaceId, "idempotency-key": unique("prj") },
      body: { name: unique("Turn Route Project") },
    });
    expect(projectResponse.status).toBe(201);
    const projectId = ((await projectResponse.json()) as { data: { id: string } }).data.id;
    const base = await uploadSnapshot(jar, workspaceId, projectId, {});
    const threadResponse = await api(server.base, `/v1/projects/${projectId}/threads`, {
      method: "POST",
      jar,
      headers: { "x-workspace-id": workspaceId, "idempotency-key": unique("thr") },
      body: { title: "Turn route thread" },
    });
    expect(threadResponse.status).toBe(201);
    const threadId = ((await threadResponse.json()) as { data: { id: string } }).data.id;

    // STEP 0 — the mock propose turn (the create_composition + create_text
    // carriers). The Idempotency-Key header IS the turn key (wire contract).
    const runId = unique("run");
    const turn = await fetch(`${server.base}/v1/threads/${threadId}/turn`, {
      method: "POST",
      headers: {
        origin: TEST_APP_ORIGIN,
        "content-type": "application/json",
        accept: "text/event-stream",
        cookie: jar.header,
        "x-workspace-id": workspaceId,
        "idempotency-key": `${runId}:0`,
      },
      body: JSON.stringify({
        runId,
        stepIndex: 0,
        model: "studio-fast",
        messages: [{ role: "user", text: USER_TEXT }],
      }),
      redirect: "manual",
    });
    expect(turn.status).toBe(200);
    await readSse(turn); // drain to the durable completion

    // The client's merged plan lands → the §7.3 verdict + the run COMPLETED
    // (the D-11 applyable moment) + plan_json stored.
    const plan = mockEditPlan();
    const planResponse = await api(server.base, `/v1/runs/${runId}/plan`, {
      method: "POST",
      jar,
      headers: { "x-workspace-id": workspaceId, "idempotency-key": unique("plan") },
      body: { plan },
    });
    expect(planResponse.status).toBe(200);
    const planBody = (await planResponse.json()) as {
      runId: string;
      autoApply: { mode: string; reason: string };
      compiledBatch?: { label: string; steps: unknown[] };
    };
    expect(planBody.runId).toBe(runId);
    expect(planBody.autoApply).toEqual({ mode: "auto", reason: "eligible" });
    const batch = planBody.compiledBatch;
    if (batch === undefined) throw new Error("the plan POST answered no compiledBatch");
    const { run } = await server.deps.repos.runs.get(workspaceId, runId);
    expect(run.status).toBe("completed"); // D-11: applyable — THE FIX

    // The client's apply gesture (apply-flow.test.ts's shape): the executed
    // batch's sha256 + the post-batch version uploaded with agentRunId.
    const batchSha256 = createHash("sha256")
      .update(JSON.stringify({ label: batch.label, atomic: true, steps: batch.steps }))
      .digest("hex");
    const applied = await uploadSnapshot(jar, workspaceId, projectId, {
      baseVersionId: run.baseVersionId ?? base.versionId,
      agentRunId: runId,
      label: "agent-apply",
    });
    const applyKey = unique("apply");
    const applyResponse = await api(server.base, `/v1/runs/${runId}/apply`, {
      method: "POST",
      jar,
      headers: { "x-workspace-id": workspaceId, "idempotency-key": applyKey },
      body: { batchSha256, versionId: applied.versionId, idempotencyKey: applyKey },
    });
    // THE 12-w6-e2 BLOCKER IS GONE: pre-fix this 409'd RUN_NOT_ACTIVE
    // ("still planning") because nothing ever marked the run applyable.
    expect(applyResponse.status).toBe(200);
    const applyBody = (await applyResponse.json()) as {
      data: { applied: boolean; versionId: string };
    };
    expect(applyBody.data).toMatchObject({ applied: true, versionId: applied.versionId });
  }, 20_000);
});
