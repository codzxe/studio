// @studio/contracts — chat threads (PRODUCT_ARCHITECTURE.md §7.2, §9.1).

import { z } from "zod";

import { ID_SCHEMA, type Id } from "./common.js";

export const THREAD_TITLE_SCHEMA = z.string().max(200);

/** `POST /v1/projects/:id/threads` body (projectId in path). */
export const CREATE_THREAD_SCHEMA = z.strictObject({
  title: THREAD_TITLE_SCHEMA.optional(),
});

export type CreateThreadRequest = z.infer<typeof CREATE_THREAD_SCHEMA>;

/**
 * `POST /v1/threads/:id/messages` body (w8 harness fix — the stop-context
 * fix): the client persists a user message OUTSIDE any run turn — today the
 * undelivered steers (sent while a run was live, cancelled by stop) existed
 * only in the sender's tab, so every later run's model history lost them.
 * `note` carries the honest provenance shown in the thread (e.g.
 * "sent while the agent was working — not answered yet"); the model reads
 * content_json.message + note through the normal history mapping.
 */
export const CREATE_THREAD_MESSAGE_SCHEMA = z.strictObject({
  message: z.string().min(1).max(20_000),
  note: z.string().min(1).max(300).optional(),
});

export type CreateThreadMessageRequest = z.infer<typeof CREATE_THREAD_MESSAGE_SCHEMA>;

/** Thread row (§9.1 `agent_threads`). */
export interface Thread {
  readonly id: Id;
  readonly projectId: Id;
  readonly title: string | null;
  readonly createdBy: Id;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const THREAD_MESSAGE_ROLE_SCHEMA = z.enum(["user", "assistant", "system"]);

export type ThreadMessageRole = z.infer<typeof THREAD_MESSAGE_ROLE_SCHEMA>;

/** Message row (§9.1 `agent_messages`; content_json stays opaque here). */
export interface ThreadMessage {
  readonly id: Id;
  readonly threadId: Id;
  readonly role: ThreadMessageRole;
  readonly content: unknown;
  readonly runId: Id | null;
  readonly createdAt: string;
}

export const THREAD_ID_SCHEMA = ID_SCHEMA;
