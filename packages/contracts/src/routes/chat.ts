// @studio/contracts — POST /v1/threads/:id/chat (PRODUCT_ARCHITECTURE.md §7.2).
//
// The response is an AI SDK UI stream whose data parts are the §7.4
// StudioStreamEvents (see ../events.js). This file fixes the request body only.

import { z } from "zod";

import { MODEL_ID_SCHEMA } from "../models.js";
import {
  CONTEXT_SELECTION_SCHEMA,
  IDEMPOTENCY_KEY_SCHEMA,
  PINNED_CONTEXT_ITEM_SCHEMA,
} from "./common.js";

/** Message bodies are bounded; larger prompts are a client-side UX problem. */
export const CHAT_MESSAGE_SCHEMA = z.string().min(1).max(8000);

/**
 * `POST /v1/threads/:id/chat` body (§7.2): the user message, the context
 * selection for this message (EDITOR_CHAT_UX §5) and an idempotency key so a
 * retry never duplicates a run (§8.4 reconnect rules).
 *
 * `model` is OPTIONAL (§8.2 plan gating): unset → the plan's default model;
 * set but not entitled on the workspace's plan → MODEL_NOT_ENTITLED (403).
 * M4-SEAMS Seam 1.
 */
export const CHAT_REQUEST_SCHEMA = z.strictObject({
  message: CHAT_MESSAGE_SCHEMA,
  context: CONTEXT_SELECTION_SCHEMA,
  idempotencyKey: IDEMPOTENCY_KEY_SCHEMA,
  pinned: z.array(PINNED_CONTEXT_ITEM_SCHEMA).max(20).default([]),
  model: MODEL_ID_SCHEMA.optional(),
});

export type ChatRequest = z.infer<typeof CHAT_REQUEST_SCHEMA>;
