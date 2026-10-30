/**
 * Chat engine UI-state types — Seam 4 of docs/phases/M4-SEAMS.md
 * (EDITOR_CHAT_UX §8.1 M4 slice + §8.4; PRODUCT_ARCHITECTURE.md §7.4).
 *
 * ROUND 12 (client-driven loop, docs/research/round12-design.md): the agent loop
 * lives in the browser chat-controller. It POSTs ONE bounded turn at a time
 * (`client.chat.turn`), folds the turn.* events, executes read/generative
 * tools LOCALLY through the injected `TurnToolExecutor` (i5's pinned seam),
 * echoes every tool result in the NEXT turn's transcript, and at run end
 * merges the write-tool proposal carriers into ONE plan →
 * `runs.submitPlan` → the existing plan-card fold + auto-apply drive. The
 * thread `phase` keeps its §8.1 vocabulary; `TURN_PAUSED` (the turn
 * transport's bounded-park code) plays the old RUN_PAUSED §8.4 role.
 *
 * Boundary law (see lib/editor-session/types.ts, AGENTS.md hard rule):
 * - `@studio/contracts` is imported `import type` ONLY. The §7.4 event types
 *   plus `EditPlan`/`ContextSelection`/`PinnedContextItem`/`ModelId`/turn
 *   canvas types arrive as types; NO contracts Zod schema ever runs in web
 *   at runtime.
 * - `@studio/api-client` is the runtime wire-validation layer. Its
 *   `chat.turn` (sse.ts `streamTurn`) parses + validates the turn SSE wire,
 *   rewrites the per-turn server seqs into run-scoped local seqs and owns
 *   the bounded same-key retry (transport drop → up to 3 attempts →
 *   `TURN_PAUSED`; retryable turn.failed → one retry). This engine CONSUMES
 *   its typed output; it never re-validates events here.
 */

import type {
  RunPlanResponse,
  TurnStreamHandle,
  TurnStreamHandlers,
  TurnStreamReconnectConfig,
} from "@studio/api-client";
import type {
  AgentBatch,
  ContextSelection,
  EditPlan,
  ModelId,
  PinnedContextItem,
  PlanRisk,
  TurnCanvas,
  TurnMessage,
  TurnToolCall,
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
   * The §7.3 server-side auto-apply verdict (round-10 v2): `mode: "auto"`
   * means the CONTROLLER AUTO-DRIVES Apply at run.completed (once per run,
   * guards in chat-controller.ts) — the card folds to its applied state and
   * Undo is the escape hatch. `mode: "propose"` keeps the manual Apply path.
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
  /**
   * ROUND 12: the tool calls of the run's LATEST completed turn — the chips'
   * authoritative payload (`resultForModel`, the `proposal` carrier for write
   * tools). Absent on user messages and legacy replayed runs.
   */
  readonly toolCalls?: readonly TurnToolCall[];
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
 * M6-H (BUILD_PLAN §M6 task 4, EDITOR_CHAT_UX §12, DECISIONS D-12): the §7.3
 * wire code the gateway returns when the workspace balance cannot fund a run
 * (HTTP 402, services/gateway/src/routes/chat.ts — the §8.8 pre-model-call
 * gate). Pinned as a const so the reducer and the block region can never
 * drift from the server's spelling.
 */
export const INSUFFICIENT_CREDITS_CODE = "INSUFFICIENT_CREDITS" as const;

/**
 * M6-H: the TYPED zero-balance block recorded when a chat POST/stream fails
 * with `INSUFFICIENT_CREDITS` (402) — or a terminal `run.failed` carries the
 * same code. Client-side UX truth ONLY: the server re-enforces on every send
 * (the block never fabricates a balance, it just stops wasted requests);
 * `chat.submit` clears it so a re-armed send re-checks against the server.
 */
export interface ChatBlockedCreditsState {
  readonly reason: "insufficient-credits";
  /**
   * Human-safe copy (law #1): the server's §7.3 envelope message verbatim
   * ("This workspace is out of credits.") or, for the derived zero-balance
   * arm, the §12 copy. Never codes, ids or provider internals.
   */
  readonly message: string;
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
  /**
   * M6-H: the typed zero-balance block (see {@link ChatBlockedCreditsState}).
   * Set when the thread's last failure is `INSUFFICIENT_CREDITS`, cleared by
   * `chat.submit` / `run.started` / `run.completed` — a fresh send re-checks
   * against the server (honest client-side UX; the 402 is server-enforced).
   */
  readonly blocked?: ChatBlockedCreditsState;
  /** Highest §7.4 seq folded for the ACTIVE run; replays at/below it are no-ops. */
  readonly lastSeq: number;
}

// ---------------------------------------------------------------------------
// Runtime ports (the EditorSessionClient pattern from lib/editor-session)
// ---------------------------------------------------------------------------

/**
 * ROUND 12 (pinned seam with i5's tool-executor.ts): executes ONE
 * read/generative tool call locally against the live bridge / gateway tool
 * endpoints. `execute` THROWS a ClientToolError `{code, message}` on failure
 * (never returns undefined) — the loop maps that to the §7.4 tool-failure
 * result shape. `handles` gates which tool ids are client-executable.
 */
export interface TurnToolExecutor {
  /** Executes a READ/GENERATIVE tool locally; the JSON result for the model. */
  execute(tool: string, args: unknown): Promise<unknown>;
  /** True when the tool is executable client-side (the read/generative catalog). */
  handles(tool: string): boolean;
}

/**
 * ROUND 12: builds the per-run executor (i5's `createClientToolExecutor`
 * takes the client-generated runId at construction). Called once per run
 * with the runId + the run's context selection; the returned executor serves
 * every read/generative call of that run.
 */
export type ChatToolExecutorFactory = (run: {
  readonly runId: string;
  readonly context: ContextSelection;
}) => TurnToolExecutor;

/**
 * Narrow runtime port of `@studio/api-client`'s `ApiClient` the round-12
 * chat engine consumes (the turn transport + the run-end plan/abandon
 * mutations). The real `ApiClient` satisfies this structurally — guarded by
 * a type test in chat-controller.test.ts — so the provider passes its
 * `createApiClient()` instance unchanged.
 */
export interface ChatControllerClient {
  readonly chat: {
    /**
     * POST `/v1/threads/:id/turn` — ONE bounded turn (sse.ts `streamTurn`).
     * Client-side validation failures throw synchronously (`ApiError`
     * VALIDATION_FAILED, status 0).
     */
    turn(
      threadId: string,
      body: unknown,
      handlers?: TurnStreamHandlers & {
        readonly signal?: AbortSignal;
        readonly reconnect?: TurnStreamReconnectConfig;
        /** The run's next local §7.4 seq (monotonic across turns). */
        readonly seqBase?: number;
        /** A paused attempt's `handle.lastServerSeq` (resume dedupe). */
        readonly replayCursor?: number;
      },
    ): TurnStreamHandle;
  };
  readonly runs: {
    /** POST `/v1/runs/:id/plan` — the run-end merged-plan fold (round 12). */
    submitPlan(
      runId: string,
      body: { readonly plan: EditPlan } | { readonly end: true },
      options?: { readonly signal?: AbortSignal; readonly idempotencyKey?: string },
    ): Promise<RunPlanResponse | { runId: string; ended: true }>;
    /** POST `/v1/runs/:id/abandon` — fire-and-forget give-up (stop/dispose). */
    abandon(
      runId: string,
      options?: { readonly signal?: AbortSignal; readonly idempotencyKey?: string },
    ): Promise<null>;
  };
}

/** One send: §7.2 message + context selection + pinned chips + optional model. */
export interface ChatSendInput {
  readonly message: string;
  readonly context: ContextSelection;
  readonly pinned: PinnedContextItem[];
  readonly model?: ModelId;
}

// 12-w7: re-exported for chat-controller plan-response narrowing.
export type { RunPlanResponse } from "@studio/api-client";
