import { and, asc, desc, eq, lt, or } from "drizzle-orm";

import { type Page, clampLimit, decodeCursor, encodeCursor } from "../cursor.js";
import type { Executor, StudioDb } from "../db.js";
import { DbError } from "../errors-lite.js";
import { createId } from "../ids.js";
import type { AgentMessage, AgentThread } from "../schema.js";
import { tablesFor } from "../tables.js";
import { type WorkspaceId, requireNonEmpty, requirePositiveInt } from "./shared.js";

/** Threads repository — chat conversations attached to a project (§3.1). */
export type ChatRole = "user" | "assistant" | "system" | "tool";

export interface ThreadCreateInput {
  readonly projectId: string;
  readonly createdBy: string;
  readonly title?: string;
}

export interface MessageInput {
  readonly threadId: string;
  readonly role: ChatRole;
  readonly contentJson: unknown;
  readonly runId?: string | null;
}

export interface ListOptions {
  readonly limit?: number;
  readonly cursor?: string | null;
}

// ── Round 12: client-driven agent loop (migration 0008) ───────────────────────
//
// The browser owns the turn loop; every turn persists its transcript durably
// so `loadThreadHistory` can rebuild full history (text + tool parts) for the
// next turn's model call. TRUSTED-INTERNAL + workspace-free like the runs.ts
// round-12 seams (RendersRepo.claimNext precedent): the turn route resolves
// thread → workspace and authenticates BEFORE calling them.

/**
 * Role vocabulary loadThreadHistory emits. DB rows keep their own role
 * (agent_messages.role is free text at the column level); `system` rows are
 * dropped from history (never written by the gateway today) — the union is
 * exactly what the model-message mapper accepts.
 */
export type HistoryRole = "user" | "assistant" | "tool";

/** One transcript entry, oldest-first — content_json rides verbatim. */
export interface ThreadHistoryMessage {
  readonly role: HistoryRole;
  /** Extracted convenience text (user: content.message; assistant: content.text ?? content.message). */
  readonly text?: string;
  /** Raw agent_messages.content_json — the payload the gateway maps to model parts. */
  readonly contentJson?: unknown;
  readonly runId?: string | null;
}

export interface LoadHistoryOptions {
  /** Row cap (default 40) — the NEWEST window of the transcript. */
  readonly maxMessages?: number;
  /** Character cap (default 24000) — cost is JSON.stringify(content_json).length. */
  readonly maxChars?: number;
}

/** `insertToolMessageRow` input — one tool-call/result payload row. */
export interface ToolMessageInput {
  readonly threadId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly tool: string;
  readonly payload: unknown;
}

/**
 * Terminal state of the run that produced an assistant text row. Stored
 * INSIDE content_json ({ message, status }) — the wire role/status enums live
 * in @studio/contracts (user|assistant|system only), so the DB keeps the
 * status with the payload instead of growing a new column or role.
 */
export type AssistantMessageStatus = "completed" | "failed" | "partial";

/**
 * `insertAssistantMessageRow` input — one run's assistant text (any
 * outcome). `payload` rides content_json verbatim (round 12: the TURN WIRE
 * idempotency carrier — turnKey, toolCalls, usage, committed credits — so a
 * duplicate POST for the same (runId, stepIndex) replays the STORED outcome
 * from the database instead of re-running the model; a tool-only turn may
 * persist text "" when a payload is present).
 */
export interface AssistantMessageInput {
  readonly threadId: string;
  readonly runId: string;
  readonly text: string;
  readonly status: AssistantMessageStatus;
  readonly payload?: Readonly<Record<string, unknown>>;
}

/** `linkUserMessageToRun` input — correlate the user turn with its run. */
export interface LinkUserMessageInput {
  readonly messageId: string;
  readonly runId: string;
}

export interface ThreadsRepo {
  create(workspaceId: WorkspaceId, input: ThreadCreateInput): Promise<AgentThread>;
  listByProject(
    workspaceId: WorkspaceId,
    projectId: string,
    options?: ListOptions,
  ): Promise<Page<AgentThread>>;
  get(workspaceId: WorkspaceId, threadId: string): Promise<AgentThread>;
  addMessage(workspaceId: WorkspaceId, input: MessageInput): Promise<AgentMessage>;
  listMessages(
    workspaceId: WorkspaceId,
    threadId: string,
    options?: ListOptions,
  ): Promise<Page<AgentMessage>>;

  // ── Round 12 client-driven agent loop (trusted-internal; see ToolMessageInput) ──

  /** Persist one tool payload as a role "tool" transcript row. */
  insertToolMessageRow(input: ToolMessageInput): Promise<AgentMessage>;
  /** Persist a run's assistant text (any outcome) as role "assistant". */
  insertAssistantMessageRow(input: AssistantMessageInput): Promise<AgentMessage>;
  /** Set run_id on a user message row (user ↔ run correlation; 404 when not a user row). */
  linkUserMessageToRun(input: LinkUserMessageInput): Promise<AgentMessage>;
  /**
   * Full transcript window for a model call: newest `maxMessages` rows
   * (default 40), further trimmed to `maxChars` (default 24000) — stop before
   * exceeding either cap — returned OLDEST-first, tool rows included.
   */
  loadThreadHistory(
    threadId: string,
    options?: LoadHistoryOptions,
  ): Promise<ThreadHistoryMessage[]>;
}

export function createThreadsRepo(db: StudioDb): ThreadsRepo {
  // Dialect-aware tables (W3-A, tables.ts seam) — see createProjectsRepo.
  const { agentMessages, agentRuns, agentThreads, projects } = tablesFor(db);
  async function requireThread(
    exec: Executor,
    workspaceId: WorkspaceId,
    threadId: string,
  ): Promise<AgentThread> {
    const [thread] = await exec
      .select({ thread: agentThreads })
      .from(agentThreads)
      .innerJoin(projects, eq(agentThreads.projectId, projects.id))
      .where(and(eq(agentThreads.id, threadId), eq(projects.workspaceId, workspaceId)))
      .limit(1);
    if (!thread) throw DbError.notFound("thread");
    return thread.thread;
  }

  /** Trusted-internal thread lookup by id alone (round 12 — see ToolMessageInput). */
  async function requireThreadById(exec: Executor, threadId: string): Promise<AgentThread> {
    const [thread] = await exec
      .select()
      .from(agentThreads)
      .where(eq(agentThreads.id, threadId))
      .limit(1);
    if (!thread) throw DbError.notFound("thread");
    return thread;
  }

  /** The run must exist AND belong to this thread (trusted-internal cross-check). */
  async function requireRunOnThread(exec: Executor, threadId: string, runId: string) {
    const [run] = await exec
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.threadId, threadId)))
      .limit(1);
    if (!run) throw DbError.notFound("run");
  }

  return {
    async create(workspaceId, input) {
      requireNonEmpty(input.projectId, "projectId");
      requireNonEmpty(input.createdBy, "createdBy");
      const rows = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, workspaceId)))
        .limit(1);
      if (rows.length === 0) throw DbError.notFound("project");

      const [thread] = await db
        .insert(agentThreads)
        .values({
          id: createId("thr"),
          projectId: input.projectId,
          createdBy: input.createdBy,
          title: input.title,
        })
        .returning();
      if (!thread) throw DbError.conflict("Could not create thread");
      return thread;
    },

    async listByProject(workspaceId, projectId, options) {
      const limit = clampLimit(options?.limit);
      const cursor = decodeCursor(options?.cursor ?? null);
      const rows = await db
        .select({ thread: agentThreads })
        .from(agentThreads)
        .innerJoin(projects, eq(agentThreads.projectId, projects.id))
        .where(
          and(
            eq(agentThreads.projectId, projectId),
            eq(projects.workspaceId, workspaceId),
            cursor
              ? or(
                  lt(agentThreads.updatedAt, new Date(cursor.t)),
                  and(
                    eq(agentThreads.updatedAt, new Date(cursor.t)),
                    lt(agentThreads.id, cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(agentThreads.updatedAt), desc(agentThreads.id))
        .limit(limit + 1);

      const items = rows.map((row) => row.thread).slice(0, limit);
      const last = items.at(-1);
      const hasMore = rows.length > limit;
      return {
        items,
        nextCursor:
          hasMore && last ? encodeCursor({ t: last.updatedAt.toISOString(), id: last.id }) : null,
      };
    },

    async get(workspaceId, threadId) {
      return requireThread(db, workspaceId, threadId);
    },

    async addMessage(workspaceId, input) {
      requireNonEmpty(input.threadId, "threadId");
      if (!["user", "assistant", "system", "tool"].includes(input.role)) {
        throw DbError.validation("Invalid message role");
      }
      return db.transaction(async (tx) => {
        const thread = await requireThread(tx, workspaceId, input.threadId);
        const [message] = await tx
          .insert(agentMessages)
          .values({
            id: createId("msg"),
            threadId: thread.id,
            role: input.role,
            contentJson: input.contentJson,
            runId: input.runId ?? null,
          })
          .returning();
        if (!message) throw DbError.conflict("Could not insert message");
        await tx
          .update(agentThreads)
          .set({ updatedAt: new Date() })
          .where(eq(agentThreads.id, thread.id));
        return message;
      });
    },

    async listMessages(workspaceId, threadId, options) {
      await requireThread(db, workspaceId, threadId);
      const limit = clampLimit(options?.limit);
      const cursor = decodeCursor(options?.cursor ?? null);
      const rows = await db
        .select()
        .from(agentMessages)
        .where(
          and(
            eq(agentMessages.threadId, threadId),
            cursor
              ? or(
                  lt(agentMessages.createdAt, new Date(cursor.t)),
                  and(
                    eq(agentMessages.createdAt, new Date(cursor.t)),
                    lt(agentMessages.id, cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(agentMessages.createdAt), desc(agentMessages.id))
        .limit(limit + 1);

      const items = rows.slice(0, limit);
      const last = items.at(-1);
      const hasMore = rows.length > limit;
      return {
        items,
        nextCursor:
          hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null,
      };
    },

    // ── Round 12 client-driven agent loop (trusted-internal) ──────────────────

    async insertToolMessageRow(input) {
      const threadId = requireNonEmpty(input.threadId, "threadId");
      const runId = requireNonEmpty(input.runId, "runId");
      const toolCallId = requireNonEmpty(input.toolCallId, "toolCallId");
      const tool = requireNonEmpty(input.tool, "tool");
      return db.transaction(async (tx) => {
        const thread = await requireThreadById(tx, threadId);
        await requireRunOnThread(tx, thread.id, runId);
        const [message] = await tx
          .insert(agentMessages)
          .values({
            id: createId("msg"),
            threadId: thread.id,
            role: "tool",
            contentJson: { kind: "tool", toolCallId, tool, payload: input.payload },
            runId,
          })
          .returning();
        if (!message) throw DbError.conflict("Could not insert tool message");
        await tx
          .update(agentThreads)
          .set({ updatedAt: new Date() })
          .where(eq(agentThreads.id, thread.id));
        return message;
      });
    },

    async insertAssistantMessageRow(input) {
      const threadId = requireNonEmpty(input.threadId, "threadId");
      const runId = requireNonEmpty(input.runId, "runId");
      const text =
        input.payload !== undefined && input.text.trim() === ""
          ? // A tool-call turn may carry (near-)empty assistant text —
            // OpenAI-compatible models routinely emit whitespace-only content
            // alongside tool_calls (observed live: GLM behind the LiteLLM seam
            // sent "\n" + studio.create_text and the turn died on
            // DbError "text is required"). With a payload riding along
            // (toolCalls/usage — the turn route always sends one for
            // tool-call turns), whitespace-only text normalizes to "" instead
            // of failing the whole run; a text-only turn still requires real
            // text. (12-w5-t2 replay pin: NON-empty text stays verbatim.)
            ""
          : (() => {
              // Validate non-empty WITHOUT storing the trimmed value: turn
              // replay fidelity needs the VERBATIM assistant text (trailing
              // whitespace included) — requireNonEmpty's trim would corrupt
              // it (12-w5-t2 journey pin).
              if (input.text.trim() === "") {
                throw DbError.validation("text is required");
              }
              return input.text;
            })();
      if (!["completed", "failed", "partial"].includes(input.status)) {
        throw DbError.validation("Invalid assistant message status");
      }
      return db.transaction(async (tx) => {
        const thread = await requireThreadById(tx, threadId);
        await requireRunOnThread(tx, thread.id, runId);
        const [message] = await tx
          .insert(agentMessages)
          .values({
            id: createId("msg"),
            threadId: thread.id,
            role: "assistant",
            // Status rides inside the payload: the WIRE role/status enums live
            // in @studio/contracts (user|assistant|system only) — the DB row
            // stays a plain assistant text with a self-describing content_json.
            contentJson: { message: text, status: input.status, ...(input.payload ?? {}) },
            runId,
          })
          .returning();
        if (!message) throw DbError.conflict("Could not insert assistant message");
        await tx
          .update(agentThreads)
          .set({ updatedAt: new Date() })
          .where(eq(agentThreads.id, thread.id));
        return message;
      });
    },

    async linkUserMessageToRun(input) {
      const messageId = requireNonEmpty(input.messageId, "messageId");
      const runId = requireNonEmpty(input.runId, "runId");
      // Only a USER row may be linked; a missing id (or an assistant/tool row)
      // reads as NOT_FOUND before any write happens.
      const [message] = await db
        .select({ id: agentMessages.id, threadId: agentMessages.threadId })
        .from(agentMessages)
        .where(and(eq(agentMessages.id, messageId), eq(agentMessages.role, "user")))
        .limit(1);
      if (!message) throw DbError.notFound("message");
      await requireRunOnThread(db, message.threadId, runId);
      const [updated] = await db
        .update(agentMessages)
        .set({ runId })
        .where(and(eq(agentMessages.id, message.id), eq(agentMessages.role, "user")))
        .returning();
      if (!updated) throw DbError.notFound("message");
      return updated;
    },

    async loadThreadHistory(threadId, options) {
      const id = requireNonEmpty(threadId, "threadId");
      const maxMessages = requirePositiveInt(options?.maxMessages ?? 40, "maxMessages");
      const maxChars = requirePositiveInt(options?.maxChars ?? 24_000, "maxChars");
      await requireThreadById(db, id);

      // Newest-first window (same keyset order as listMessages), then reversed.
      const rows = await db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.threadId, id))
        .orderBy(desc(agentMessages.createdAt), desc(agentMessages.id))
        .limit(maxMessages);

      const mapped = rows
        .map((row) => toHistoryEntry(row))
        .filter((entry): entry is ThreadHistoryMessage => entry !== null);

      // Char budget, walked NEWEST → older (mapped is newest-first): keep a
      // PREFIX while the total stays within maxChars; stop BEFORE exceeding.
      // A single entry larger than the whole budget yields an empty window —
      // honest: the current turn rides the turn request itself.
      let kept = 0;
      let budget = 0;
      for (const entry of mapped) {
        const cost = historyCostOf(entry);
        if (budget + cost > maxChars) break;
        budget += cost;
        kept += 1;
      }
      // Kept prefix is newest-first; the contract is OLDEST-first.
      return mapped.slice(0, kept).reverse();
    },
  };
}

// ── History mapping (pure; toPlanState precedent) ────────────────────────────

/** First non-empty string among `keys` inside a content_json object. */
function textFromContent(contentJson: unknown, keys: readonly string[]): string | undefined {
  if (typeof contentJson === "string") return contentJson.length > 0 ? contentJson : undefined;
  if (typeof contentJson !== "object" || contentJson === null) return undefined;
  const record = contentJson as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Map one agent_messages row onto the model-history vocabulary (round 12).
 * User rows read `content.message` (the legacy chat.ts shape
 * {message, context, pinned}); assistant rows read `content.text` (legacy
 * finalize shape) or `content.message` (the round-12 {message, status} shape);
 * tool rows carry their payload in content_json. `system` rows → null (never
 * written today; they must not reach a model-message mapper as a fake role).
 */
export function toHistoryEntry(
  row: Pick<AgentMessage, "role" | "contentJson" | "runId">,
): ThreadHistoryMessage | null {
  switch (row.role) {
    case "user":
      return {
        role: "user",
        text: textFromContent(row.contentJson, ["message"]),
        contentJson: row.contentJson,
        runId: row.runId,
      };
    case "assistant":
      return {
        role: "assistant",
        text: textFromContent(row.contentJson, ["text", "message"]),
        contentJson: row.contentJson,
        runId: row.runId,
      };
    case "tool":
      return { role: "tool", contentJson: row.contentJson, runId: row.runId };
    default:
      return null;
  }
}

/**
 * Character cost of one history entry for the loadThreadHistory budget:
 * JSON.stringify(content_json).length — the raw payload the gateway maps to
 * model parts. The extracted `text` is a SUBSET of that payload (user:
 * content.message; assistant: content.text|message), so it is never counted
 * twice; an entry without content_json (impossible for a NOT NULL column, kept
 * for type honesty) falls back to its text length.
 */
export function historyCostOf(entry: ThreadHistoryMessage): number {
  if (entry.contentJson !== undefined) return JSON.stringify(entry.contentJson).length;
  return entry.text?.length ?? 0;
}
