// @studio/gateway — agent runner seam + SSE run log (§7.4, §8.8, §8.9;
// EDITOR_CHAT_UX §8 streaming states).
//
// The chat route never talks to a model directly: it creates the run,
// reserves credits, then hands the run to an AgentRunner that emits §7.4
// StudioStreamEvents through the run log. The log assigns the monotonic
// `seq`, keeps the ordered event history for Last-Event-ID replay, and
// exposes the expected toolCallIds that POST /v1/runs/:id/events validates
// against (§7.4 rule: results accepted only for the expected toolCallId).
//
// Runners:
//   * MockRunner     — env MOCK_MODEL=true: run.started → text deltas →
//                      a small valid EditPlan ("rename layer") →
//                      studio.get_context tool.started/result → done.
//   * LiteLLMRunner  — MOCK_MODEL=false: the REAL OpenAI-compatible runner
//                      (src/litellm/, D-16): streams via the LiteLLM proxy,
//                      executes the 4 client read tools through the
//                      tool-result wait seam below, resolves studio.plan_edit
//                      server-side as a structured-output call, and converts
//                      usage → committed credits (§8.8).

import { randomUUID } from "node:crypto";

import type { StudioEnv } from "@studio/config";

import {
  EDIT_PLAN_SCHEMA,
  estimateCredits,
  type ContextSelection,
  type EditPlan,
  type PinnedContextItem,
  type StudioStreamEvent,
} from "@studio/contracts";
import { computeReserveAmount } from "@studio/db";

import { createLiteLLMRunner } from "./litellm/runner.js";
import { nullLogger, type Logger } from "./logger.js";

/** All 12 §7.4 payloads minus the runId/seq the log assigns. */
export type RunStreamPayload = {
  [K in StudioStreamEvent["type"]]: Omit<Extract<StudioStreamEvent, { type: K }>, "runId" | "seq">;
}[StudioStreamEvent["type"]];

/** One prior thread turn handed to the model as prompt history (§8.3). */
export interface AgentRunHistoryTurn {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface AgentRun {
  readonly runId: string;
  readonly threadId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly model: string;
  readonly baseVersionId: string | null;
  readonly message: string;
  readonly context: ContextSelection;
  readonly pinned: readonly PinnedContextItem[];
  /** Integer credits held for this run (already reserved by the route). */
  readonly reservedCredits: number;
  /** Last turns of thread history BEFORE this run's message (§8.3 "last 6
   * turns"); the chat route loads them from the threads repo. Optional so the
   * MockRunner and unit harnesses can omit it. */
  readonly history?: readonly AgentRunHistoryTurn[];
}

/** Result of waiting for a client-reported tool result (§7.4 / M4 Seam 2). */
export type ToolWaitResult =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly reason: "timeout" | "aborted" };

/** What the runner hands back to the chat route for ledger finalization. */
export interface AgentRunStream {
  emit(payload: RunStreamPayload): StudioStreamEvent;
  /** Let the SSE transport flush between events (keeps streaming observable). */
  yieldToStream(): Promise<void>;
  /** Register a toolCallId whose client-reported result will be accepted. */
  expectToolCall(toolCallId: string, tool: string): void;
  /**
   * Wait for the editor client to POST the result of `toolCallId` via
   * /v1/runs/:id/events (M4 Seam 2). The chat route wires this to the run
   * log's own tool.result events with the runner's TOOL_RESULT_TIMEOUT_MS;
   * the LiteLLM runner maps `timeout` → run.failed EDITOR_DISCONNECTED and
   * `aborted` → cancelled.
   */
  waitForToolResult(toolCallId: string): Promise<ToolWaitResult>;
  /** Aborted when the client disconnects or POST /runs/:id/cancel fires. */
  readonly signal: AbortSignal;
}

export type AgentRunOutcome =
  | { readonly kind: "completed"; readonly committedCredits: number }
  | { readonly kind: "failed"; readonly code: string; readonly message: string; readonly retryable: boolean }
  | { readonly kind: "cancelled" };

export interface AgentRunner {
  start(run: AgentRun, stream: AgentRunStream): Promise<AgentRunOutcome>;
  cancel(runId: string): void;
}

// ---------------------------------------------------------------------------
// Run log + registry
// ---------------------------------------------------------------------------

const TERMINAL_TYPES = new Set(["run.completed", "run.failed", "run.cancelled"]);

export class RunLog {
  readonly runId: string;
  private readonly events: StudioStreamEvent[] = [];
  private readonly listeners = new Set<(event: StudioStreamEvent) => void>();
  private readonly expectedTools = new Map<string, string>();
  private readonly signal: AbortSignal | null;
  private plan: EditPlan | null = null;
  private terminal: StudioStreamEvent | null = null;
  private nextSeq = 0;

  constructor(runId: string, signal?: AbortSignal) {
    this.runId = runId;
    this.signal = signal ?? null;
  }

  emit(payload: RunStreamPayload): StudioStreamEvent {
    if (this.terminal !== null) return this.terminal;
    if (this.nextSeq === 0 && payload.type !== "run.started") {
      // Envelope rule: nothing precedes run.started.
      const started: StudioStreamEvent = { ...payload, runId: this.runId, seq: 0 } as StudioStreamEvent;
      this.push(started);
      return started;
    }
    const event = { ...payload, runId: this.runId, seq: this.nextSeq } as StudioStreamEvent;
    this.push(event);
    return event;
  }

  private push(event: StudioStreamEvent): void {
    this.events.push(event);
    this.nextSeq = event.seq + 1;
    if (event.type === "plan") this.plan = event.plan;
    if (TERMINAL_TYPES.has(event.type)) this.terminal = event;
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // listener errors never break the stream
      }
    }
  }

  /** Subscribe to future events; returns an unsubscribe function. */
  subscribe(listener: (event: StudioStreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** §7.4 reconnect: everything strictly after `seq`. */
  replayAfter(seq: number): readonly StudioStreamEvent[] {
    return this.events.filter((event) => event.seq > seq);
  }

  all(): readonly StudioStreamEvent[] {
    return this.events;
  }

  get lastSeq(): number {
    return this.events.length === 0 ? -1 : this.events.at(-1)?.seq ?? -1;
  }

  get isTerminal(): boolean {
    return this.terminal !== null;
  }

  get currentPlan(): EditPlan | null {
    return this.plan;
  }

  expectToolCall(toolCallId: string, tool: string): void {
    this.expectedTools.set(toolCallId, tool);
  }

  toolNameFor(toolCallId: string): string | null {
    return this.expectedTools.get(toolCallId) ?? null;
  }

  /**
   * Wait for the run's own `tool.result` event for `toolCallId` — the runs
   * route emits it when the editor client POSTs /v1/runs/:id/events (§7.4).
   * M4 Seam 2: never rejects; resolves `{ ok: false, reason: "timeout" }`
   * after `timeoutMs`, `aborted` when the run's signal fired first, and
   * `{ ok: true, result }` if the result already arrived before the wait.
   */
  waitToolResult(toolCallId: string, timeoutMs: number): Promise<ToolWaitResult> {
    for (const event of this.events) {
      if (event.type === "tool.result" && event.toolCallId === toolCallId) {
        return Promise.resolve({ ok: true, result: event.result });
      }
    }
    if (this.signal !== null && this.signal.aborted) {
      return Promise.resolve({ ok: false, reason: "aborted" });
    }
    return new Promise<ToolWaitResult>((resolveWait) => {
      let settled = false;
      const settle = (result: ToolWaitResult): void => {
        if (settled) return;
        settled = true;
        this.signal?.removeEventListener("abort", onAbort);
        clearTimeout(timer);
        unsubscribe();
        resolveWait(result);
      };
      const unsubscribe = this.subscribe((event) => {
        if (event.type === "tool.result" && event.toolCallId === toolCallId) {
          settle({ ok: true, result: event.result });
        }
      });
      const onAbort = (): void => {
        settle({ ok: false, reason: "aborted" });
      };
      this.signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        settle({ ok: false, reason: "timeout" });
      }, timeoutMs);
      timer.unref?.();
    });
  }
}

interface RegistryEntry {
  readonly log: RunLog;
  readonly controller: AbortController;
}

export class RunRegistry {
  private readonly entries = new Map<string, RegistryEntry>();

  register(runId: string): { log: RunLog; signal: AbortSignal } {
    const controller = new AbortController();
    // The log sees the same signal so waitToolResult can resolve `aborted`
    // the moment the run is cancelled (client abort / POST cancel).
    const log = new RunLog(runId, controller.signal);
    this.entries.set(runId, { log, controller });
    return { log, signal: controller.signal };
  }

  get(runId: string): RunLog | null {
    return this.entries.get(runId)?.log ?? null;
  }

  /** Abort the run; false when unknown or already terminal. */
  cancel(runId: string): boolean {
    const entry = this.entries.get(runId);
    if (entry === undefined) return false;
    if (entry.log.isTerminal) return false;
    entry.controller.abort();
    return true;
  }

  forget(runId: string): void {
    this.entries.delete(runId);
  }
}

function nextTick(): Promise<void> {
  return new Promise((resolveTick) => {
    setImmediate(resolveTick);
  });
}

// ---------------------------------------------------------------------------
// Credit heuristic (§8.8: reserve = estimatedCredits × 1.2, min 1)
// ---------------------------------------------------------------------------

/**
 * Deterministic pre-flight estimate from the context size (W2-b heuristic):
 * one planning step, one per ~500 chars of prompt, one per pinned chip,
 * plus a step when most context blocks are enabled. The authoritative
 * commit is actual model usage (Wave 4); only the reserve uses this.
 */
export function estimateRunCredits(input: {
  message: string;
  context: ContextSelection;
  pinned: readonly PinnedContextItem[];
}): number {
  const enabledBlocks = Object.values(input.context).filter((enabled) => enabled === true).length;
  const rawSteps =
    1 +
    Math.floor(input.message.length / 500) +
    input.pinned.length +
    (enabledBlocks > 6 ? 1 : 0);
  const steps = Math.max(1, Math.min(20, rawSteps));
  return estimateCredits({ risk: "low", steps: Array.from({ length: steps }) });
}

/** Integer reserve for the ledger: ceil(estimate × 1.2), min 1 (§8.8). */
export function reserveAmountFor(estimatedCredits: number): number {
  return computeReserveAmount(estimatedCredits);
}

// ---------------------------------------------------------------------------
// MockRunner (MOCK_MODEL=true)
// ---------------------------------------------------------------------------

const MOCK_TOOL_CALL_ID_PREFIX = "call_mock";

/** A small, valid §8.6 EditPlan: rename one layer (auto-appliable: low risk). */
export function mockEditPlan(): EditPlan {
  const plan = {
    intent: "edit",
    summary: "Rename the selected layer",
    risk: "low",
    requiresApproval: false,
    // W3-gw bugfix: AFFECTED_LAYER_SCHEMA.id is z.number() (engine layer ids
    // are numeric) — the previous string id ("layer-headline") failed
    // EDIT_PLAN_SCHEMA.parse, so MockRunner runs ALWAYS died with
    // run.failed INTERNAL at the plan step.
    affectedLayers: [{ id: 0, name: "Headline", change: "Rename to Subtitle" }],
    estimatedCredits: estimateCredits({ risk: "low", steps: [{}] }),
    steps: [
      {
        title: "Rename layer",
        tool: "studio.set_properties",
        args: { layerId: "layer-headline", name: "Subtitle" },
        batch: {
          label: "Rename layer",
          steps: [{ command: "set_properties", params: { layerId: "layer-headline", name: "Subtitle" } }],
        },
      },
    ],
  };
  return EDIT_PLAN_SCHEMA.parse(plan);
}

export function createMockRunner(): AgentRunner {
  return {
    async start(run, stream) {
      stream.emit({ type: "run.started", model: run.model });
      await stream.yieldToStream();
      if (stream.signal.aborted) return { kind: "cancelled" };

      stream.emit({ type: "message.delta", delta: "I'll rename that layer for you — it's a one-property change." });
      await stream.yieldToStream();
      if (stream.signal.aborted) return { kind: "cancelled" };

      stream.emit({ type: "message.delta", delta: " Planning a single atomic batch so undo stays one step." });
      await stream.yieldToStream();
      if (stream.signal.aborted) return { kind: "cancelled" };

      stream.emit({ type: "plan", plan: mockEditPlan() });
      await stream.yieldToStream();
      if (stream.signal.aborted) return { kind: "cancelled" };

      const toolCallId = `${MOCK_TOOL_CALL_ID_PREFIX}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      stream.expectToolCall(toolCallId, "studio.get_context");
      stream.emit({
        type: "tool.started",
        toolCallId,
        name: "studio.get_context",
        args: { blocks: ["projectSummary", "activeComp", "selection"] },
      });
      await stream.yieldToStream();
      if (stream.signal.aborted) return { kind: "cancelled" };

      stream.emit({
        type: "tool.result",
        toolCallId,
        result: {
          projectSummary: "Project: mock project, 1 composition",
          activeComp: { id: "comp-main", name: "Main", durationTicks: 1800 },
          selection: [{ id: "layer-headline", name: "Headline", kind: "text" }],
        },
      });
      await stream.yieldToStream();
      if (stream.signal.aborted) return { kind: "cancelled" };

      const committed = Math.max(1, Math.ceil(run.reservedCredits / 2));
      return { kind: "completed", committedCredits: Math.min(committed, run.reservedCredits) };
    },
    cancel() {
      // The registry's AbortSignal is the single cancel path; nothing else to stop.
    },
  };
}

// ---------------------------------------------------------------------------
// Runner selection (D-16): mock for local dev/tests, LiteLLM in production.
// ---------------------------------------------------------------------------

/**
 * Runner by env: MockRunner when MOCK_MODEL=true (local dev + tests), the
 * real LiteLLM runner otherwise (D-16). `maxSteps` is the model round cap
 * (env CHAT_MAX_STEPS, `env.agent.chatMaxSteps`); the logger is used ONLY for
 * redacted metadata (prompt lengths + sha256 prefixes — never bodies).
 */
export function createRunnerForEnv(env: StudioEnv, logger: Logger = nullLogger): AgentRunner {
  if (env.app.mockModel) return createMockRunner();
  return createLiteLLMRunner({
    baseUrl: env.litellm.baseUrl,
    apiKey: env.litellm.apiKey,
    virtualKey: env.litellm.virtualKey,
    maxSteps: env.agent.chatMaxSteps,
    logger,
  });
}
