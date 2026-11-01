// @studio/contracts — POST /v1/threads/:id/turn (round-12 TURN WIRE CONTRACT,
// docs/research/round12-design.md — pinned, additive only).
//
// The client-driven agent loop: the browser owns the loop and the engine, the
// gateway is STATELESS per turn (auth → load thread → credit RESERVE → ONE
// model call → persist → commit). Each POST carries the CURRENT RUN transcript
// (≤ 160 message parts, ≤ 192 KB serialized — enforced by the schema) plus the
// compact canvas snapshot (client includes it on step 0 and whenever its hash
// changed). Idempotency rides the `Idempotency-Key: ${runId}:${stepIndex}`
// HEADER (not the body): a duplicate POST for the same key must return the
// stored turn outcome, never a duplicate model call.
//
// Response: SSE StudioStreamEvents (../events.js) — run.started every turn,
// then turn.started → message.delta/tool.started → turn.completed | turn.failed.
//
// This file fixes the REQUEST body only (the sibling of ./chat.js, which stays
// for the legacy one-shot flow until the fleet retires it).

import { z } from "zod";

import { MODEL_ID_SCHEMA } from "../models.js";
import { CONTEXT_SELECTION_SCHEMA, PINNED_CONTEXT_ITEM_SCHEMA } from "./common.js";

// ---------------------------------------------------------------------------
// Bounds (design doc: "≤64 parts, ≤64KB" — raised 2026-11-02, round 14:
// long real builds (the 21-tool Google-launch run) blew past both — a
// 10-section build carries ~3 transcript parts per turn (assistant + tool
// pairs) plus steer/apply parts, so 64 parts capped a run at ~20 turns and
// 64 KB serialized at fewer. ≤ 160 parts / ≤ 192 KB keeps every legitimate
// long build under the wire while still bounding abuse.)
// ---------------------------------------------------------------------------

/** Message parts per turn request (design doc: ≤ 64; round 14: ≤ 160). */
export const MAX_TURN_MESSAGE_PARTS = 160;

/** Serialized `messages` ceiling in bytes (design doc: ≤ 64 KB; round 14: 192 KB). */
export const MAX_TURN_MESSAGES_BYTES = 192 * 1024;

/** Canvas layers per snapshot (design doc: ≤ 80). */
export const MAX_TURN_CANVAS_LAYERS = 80;

/**
 * Per-message text bound. Roomy on purpose: the REAL cap is the 64 KB
 * aggregate bound (a hostile single 32 KB part still fits the budget); the
 * old /chat route's 8 000-char user bound stays the UX guide for typed text.
 */
export const MAX_TURN_MESSAGE_TEXT_LENGTH = 32_000;

// ---------------------------------------------------------------------------
// TurnMessage — the transcript part union (discriminated on `role`)
// ---------------------------------------------------------------------------

const TURN_USER_MESSAGE_SCHEMA = z.strictObject({
  role: z.literal("user"),
  text: z.string().min(1).max(MAX_TURN_MESSAGE_TEXT_LENGTH),
});

const TURN_ASSISTANT_MESSAGE_SCHEMA = z.strictObject({
  role: z.literal("assistant"),
  // May be empty: a model round that only emitted tool calls carries "".
  text: z.string().max(MAX_TURN_MESSAGE_TEXT_LENGTH),
});

const TURN_TOOL_CALL_MESSAGE_SCHEMA = z.strictObject({
  role: z.literal("tool_call"),
  toolCallId: z.string().min(1).max(200),
  tool: z.string().min(1).max(200),
  args: z.unknown(),
});

const TURN_TOOL_RESULT_MESSAGE_SCHEMA = z.strictObject({
  role: z.literal("tool_result"),
  toolCallId: z.string().min(1).max(200),
  tool: z.string().min(1).max(200),
  result: z.unknown(),
});

const TURN_STEER_MESSAGE_SCHEMA = z.strictObject({
  role: z.literal("steer"),
  text: z.string().min(1).max(MAX_TURN_MESSAGE_TEXT_LENGTH),
});

/** One transcript part: user text, assistant text, a tool call, its echoed
 * result, or a mid-run steering message (TURN WIRE CONTRACT, exact roles). */
export const TURN_MESSAGE_SCHEMA = z.discriminatedUnion("role", [
  TURN_USER_MESSAGE_SCHEMA,
  TURN_ASSISTANT_MESSAGE_SCHEMA,
  TURN_TOOL_CALL_MESSAGE_SCHEMA,
  TURN_TOOL_RESULT_MESSAGE_SCHEMA,
  TURN_STEER_MESSAGE_SCHEMA,
]);

export type TurnMessage = z.infer<typeof TURN_MESSAGE_SCHEMA>;

// ---------------------------------------------------------------------------
// Canvas snapshot (compact; client sends on step 0 + on hash change)
// ---------------------------------------------------------------------------

/** Max length of any one canvas string (audit hardening, round 12). */
export const MAX_TURN_CANVAS_STRING = 200;

export const TURN_CANVAS_LAYER_SCHEMA = z.strictObject({
  id: z.number(),
  // 12-w8 audit hardening: canvas strings are CAPS — a hostile client could
  // otherwise inflate the prompt (canvas rides OUTSIDE the messages byte
  // budget) far past the per-turn credit reserve.
  name: z.string().max(MAX_TURN_CANVAS_STRING),
  type: z.string().max(MAX_TURN_CANVAS_STRING),
});

export type TurnCanvasLayer = z.infer<typeof TURN_CANVAS_LAYER_SCHEMA>;

export const TURN_CANVAS_SCHEMA = z
  .strictObject({
    activeComp: z.string().min(1).max(MAX_TURN_CANVAS_STRING).optional(),
    layers: z.array(TURN_CANVAS_LAYER_SCHEMA).max(MAX_TURN_CANVAS_LAYERS),
    selection: z.array(z.number()).max(MAX_TURN_CANVAS_LAYERS),
    playhead: z.number(),
    fps: z.number(),
    duration: z.number(),
  })
  .superRefine((canvas, ctx) => {
    // Whole-snapshot budget: with 80 layers at 200 chars the wire stays
    // ≤ ~40KB — bounded prompt cost, never an unbounded inflation vector.
    const serialized = JSON.stringify(canvas) ?? "";
    if (serialized.length > 40 * 1024) {
      ctx.addIssue({
        code: "custom",
        path: ["layers"],
        message: `canvas snapshot exceeds the 40KB budget (${serialized.length} bytes)`,
      });
    }
  });

export type TurnCanvas = z.infer<typeof TURN_CANVAS_SCHEMA>;

// ---------------------------------------------------------------------------
// The request body
// ---------------------------------------------------------------------------

/**
 * `POST /v1/threads/:id/turn` body (TURN WIRE CONTRACT, exact shape). The
 * `messages` caps — ≤ 160 parts AND ≤ 192 KB serialized — are enforced via
 * superRefine so the gateway can reject oversized transcripts with a precise
 * issue instead of a platform 413.
 */
export const TURN_REQUEST_SCHEMA = z
  .strictObject({
    /** Client-generated uuid, stable for the whole run. */
    runId: z.string().min(1).max(128),
    /** 0-based; increments per model call. Server-side abuse bound
     * (AUD-M5): the client loop caps its steps — a scripted caller must
     * not mint unbounded steps on one run row. Round 14: 63 → 159 so the
     * raised 160-part cap is reachable (a step costs ≥ 1 part). */
    stepIndex: z.number().int().min(0).max(159),
    model: MODEL_ID_SCHEMA.optional(),
    /** The CURRENT RUN transcript only (never the whole thread history). */
    messages: z.array(TURN_MESSAGE_SCHEMA).min(1).max(MAX_TURN_MESSAGE_PARTS),
    /** Context selection, as today (defaults apply). */
    context: CONTEXT_SELECTION_SCHEMA.optional(),
    /** Pinned context chips, as today. */
    pinned: z.array(PINNED_CONTEXT_ITEM_SCHEMA).max(20).optional(),
    /** Compact canvas snapshot; `null` when unchanged (client's call). */
    canvas: TURN_CANVAS_SCHEMA.nullable().optional(),
    /**
     * APPLY FEEDBACK (2026-11-01 root-cause fix): why an earlier turn's
     * proposal failed to apply, straight from the client's apply engine —
     * live-apply failures the model would otherwise NEVER see (the old loop:
     * the apply fails client-side, the canvas regresses, the model reads an
     * empty canvas, concludes its proposal vanished, and re-proposes it
     * verbatim). Bounded: ≤ 3 notes, ≤ 400 chars each; rendered into the
     * model's per-turn notes with a fix-it instruction by the gateway.
     */
    applyNotes: z.array(z.string().min(1).max(400)).max(3).optional(),
    /**
     * APPLY RECEIPTS (round 14 — the verification half of the feedback loop):
     * what the client's apply engine CONFIRMED applied since the last turn
     * (carrier summary + saved version). Without them the model cannot tell
     * applied work from lost work, re-creates existing layers after a pause,
     * and never actually VERIFIES anything — the "it says done but nothing
     * changed" complaint. Bounded: ≤ 8 receipts, ≤ 300 chars each.
     */
    applyReceipts: z.array(z.string().min(1).max(300)).max(8).optional(),
  })
  .superRefine((body, ctx) => {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(body.messages);
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["messages"],
        message: "turn messages must be JSON-serializable",
      });
      return;
    }
    if (serialized !== undefined && serialized.length > MAX_TURN_MESSAGES_BYTES) {
      ctx.addIssue({
        code: "custom",
        path: ["messages"],
        message: `turn messages exceed the ${MAX_TURN_MESSAGES_BYTES}-byte serialized limit (${serialized.length} bytes)`,
      });
    }
  });

export type TurnRequestBody = z.infer<typeof TURN_REQUEST_SCHEMA>;
