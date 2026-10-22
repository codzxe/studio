/**
 * Chat engine UI-state types — Seam 4 of docs/phases/M4-SEAMS.md
 * (EDITOR_CHAT_UX §8.1 M4 slice + §8.4; PRODUCT_ARCHITECTURE.md §7.4).
 *
 * This module models the whole THREAD (a message list where each assistant
 * message is bound to the run that produced it), not a single run — the
 * wave-2 UI agents (M4-E…M4-J) render `ChatUiState` straight out of the
 * controller's store. The M4 slice of the §8.1 state machine stays the
 * thread `phase`; the M5 apply slice (`applying`/`applied`/`undoing`/`undone`)
 * lives per-plan in `ChatUiMessage.planRuntime` (M5-F) so the thread phase
 * keeps driving sends/steer/reconnect exactly as it did in M4.
 *
 * Boundary law (see lib/editor-session/types.ts, AGENTS.md hard rule):
 * - `@studio/contracts` is imported `import type` ONLY. The §7.4 event types
 *   plus `EditPlan`/`ContextSelection`/`PinnedContextItem`/`ModelId` arrive
 *   as types; NO contracts Zod schema ever runs in web at runtime.
 * - `@studio/api-client` is the runtime wire-validation layer. Its
 *   `chat.stream` (sse.ts) parses + validates the SSE wire, dedupes server
 *   `seq` replays and owns the §8.4 reconnect loop (same idempotency key +
 *   `Last-Event-ID`, backoff 1s/2s/4s/8s→30s, 3 attempts then pause). This
 *   engine CONSUMES its typed output; it never re-validates events here.
 */

import type { ChatStreamHandlers, ChatStreamReconnectConfig } from "@studio/api-client";
import type {
  AgentBatch,
  ChatRequest,
  ContextSelection,
  EditPlan,
  ModelId,
  PinnedContextItem,
  PlanRisk,
} from "@studio/contracts";

import type { LayerResolutionRequest } from "./apply";

// ---------------------------------------------------------------------------
// Run phases (M4 slice of EDITOR_CHAT_UX §8.1) + per-run UI state
// ---------------------------------------------------------------------------

/**
 * Whole-thread phase. `sending` = a chat POST is in flight but no
 * `run.started` has arrived yet; `reconnecting` = the §8.4 banner state while
 * the api-client backs off; `done`/`failed`/`cancelled` are terminal.
 */
export type RunPhase =
  | "idle"
  | "sending"
  | "streaming"
  | "reconnecting"
  | "done"
  | "failed"
  | "cancelled";

/**
 * One live tool-call card (§6.1): cards appear as soon as the call starts.
 * `tool.started` → `running` (with args); `tool.result` → `done` (result) or
 * `failed` when the result is the Seam 6 failure shape
 * `{ error: string; message?: string }`; `tool.delta` appends `deltaText`.
 */
export interface ToolCardState {
  readonly toolCallId: string;
  readonly name: string;
  readonly args?: unknown;
  readonly status: "queued" | "running" | "done" | "failed";
  readonly result?: unknown;
  /** Accumulated `tool.delta` text (rare in M4 — read-only tools answer at once). */
  readonly deltaText?: string;
}

/**
 * The M5 runtime payload of a `plan` event, beyond the M4 card data: the
 * server-compiled batch the ApplyController executes, the layer names it
 * still needs bound to ids, and the apply lifecycle of THIS plan (driven by
 * user gestures — the stream never touches it; M5-G's plan card renders it).
 */
export interface PlanRuntime {
  /** The server-compiled `engine.batch` payload (allowlisted + §8.5-validated). */
  readonly compiledBatch: AgentBatch;
  /** Layer names the plan references; resolved client-side at apply (§8.7). */
  readonly resolutionRequests?: readonly LayerResolutionRequest[];
  /** The version the plan was compiled against — the reapply gate (§M5.5, D-21). */
  readonly baseVersionId?: string;
  /**
   * The SERVER-recomputed risk from the plan event (plan-compiler output,
   * D-21: never the model's self-declared value). The card displays it
   * verbatim; `undefined` ⇒ the card falls back to `plan.risk`.
   */
  readonly risk?: PlanRisk;
  /**
   * The SERVER-recomputed deterministic credit estimate (§8.8). Displayed
   * verbatim — never client credit math; `undefined` ⇒ `plan.estimatedCredits`.
   */
  readonly estimatedCredits?: number;
  /**
   * The §7.3 server-side auto-apply verdict (D-22): UI GUIDANCE ONLY —
   * `mode: "auto"` pre-arms the card (hint + focus emphasis on Apply), it
   * NEVER executes anything; Apply stays the user's explicit click.
   */
  readonly autoApply?: { readonly mode: "auto" | "propose"; readonly reason: string };
  /**
   * The candidate strings of the last `ambiguous` apply outcome (apply.ts's
   * pinned `"${layerName} (layer ${id})"` format) — the card's
   * ambiguous-resolution state renders them as pick buttons.
   */
  readonly candidates?: readonly string[];
  /**
   * The user's ambiguous-layer picks (M5-Q): requestId → the layer id they
   * chose. Pre-patched into the batch (`$request:` tokens) by
   * `applicablePlanOf` so the re-driven apply skips name resolution for the
   * picked requests (§8.7 — the pick is user authority).
   */
  readonly resolutionPicks?: Readonly<Record<string, number>>;
  /** Apply lifecycle of this plan (user gestures fold it, never the stream). */
  readonly outcome:
    | "idle"
    | "applying"
    | "applied"
    | "apply-failed"
    | "undoing"
    | "undone"
    | "undo-failed";
  /** The version the applied edit created (set on a successful apply). */
  readonly versionId?: string;
  /** The last apply/undo failure, rendered by the card (safe text). */
  readonly error?: ChatUiError;
  /** `onCancel` (§6.2): the user dismissed the card for this plan. */
  readonly dismissed?: boolean;
}

/** One rendered thread message (§3.3). */
export interface ChatUiMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  /** Assistant messages are bound to the run that produced them. */
  readonly runId?: string;
  readonly toolCards: readonly ToolCardState[];
  /** Latest `plan` event for the run — informational card in M4 (apply is M5). */
  readonly plan?: EditPlan;
  /** Latest plan's M5 runtime (compiled batch + apply lifecycle). */
  readonly planRuntime?: PlanRuntime;
  /** Latest `credits` snapshot for the run (§7.4). */
  readonly credits?: {
    readonly reserved: number;
    readonly committed: number;
    readonly balance: number;
  };
}

/** Error surface for `ChatUiState.error` (§7.3 envelope codes + §8.4 RUN_PAUSED). */
export interface ChatUiError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * Whole-thread snapshot. One immutable object per change — `getSnapshot` must
 * be referentially stable between changes for `useSyncExternalStore`.
 */
export interface ChatUiState {
  readonly messages: readonly ChatUiMessage[];
  readonly phase: RunPhase;
  /** The run currently streaming; the most recent run while terminal. */
  readonly activeRunId: string | null;
  readonly error?: ChatUiError;
  /** Highest §7.4 seq folded for the ACTIVE run; replays at/below it are no-ops. */
  readonly lastSeq: number;
}

// ---------------------------------------------------------------------------
// Runtime ports (the EditorSessionClient pattern from lib/editor-session)
// ---------------------------------------------------------------------------

/**
 * The slice of `@studio/api-client`'s `ChatStreamController` this engine
 * consumes. The real controller structurally satisfies it; tests drive a
 * scripted fake with the same shape.
 */
export interface ChatStreamHandle {
  /** Reconnect attempts exhausted — `reconnect()` resumes (§8.4). */
  readonly paused: boolean;
  /**
   * §8.3 stop, ONE fused mechanism: POST `/v1/runs/:id/cancel` (through the
   * api-client's authenticated transport, i.e. what `client.runs.cancel`
   * would send) AND abort the SSE reader. Best-effort: cancel POST failures
   * never rethrow (they land on the handle's `cancelError`).
   */
  cancel(reason?: string): Promise<void>;
  /** Abort the reader without cancelling server-side (the dispose path). */
  abort(): void;
  /** Manual retry after a pause; resets the backoff schedule. */
  reconnect(): Promise<void>;
}

/**
 * Narrow runtime port of `@studio/api-client`'s `ApiClient` the chat engine
 * consumes (chat stream only — stop/retry never call the API outside the
 * stream's own fused mechanisms). The real `ApiClient` satisfies this
 * structurally — guarded by a type test in chat-controller.test.ts — so
 * M4-J passes its `createApiClient()` instance unchanged.
 */
export interface ChatControllerClient {
  readonly chat: {
    /**
     * POST `/v1/threads/:id/chat` — returns the live stream handle
     * synchronously; client-side validation failures throw synchronously
     * (`ApiError` VALIDATION_FAILED, status 0).
     */
    stream(
      threadId: string,
      body: ChatRequest,
      handlers?: ChatStreamHandlers & {
        signal?: AbortSignal;
        reconnect?: ChatStreamReconnectConfig;
      },
    ): ChatStreamHandle;
  };
}

/** One send: §7.2 message + context selection + pinned chips + optional model. */
export interface ChatSendInput {
  readonly message: string;
  readonly context: ContextSelection;
  readonly pinned: PinnedContextItem[];
  readonly model?: ModelId;
}
