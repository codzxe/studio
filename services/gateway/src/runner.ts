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
//   * MockRunner        — env MOCK_MODEL=true: run.started → text deltas →
//                         a small valid EditPlan ("rename layer") →
//                         studio.get_context tool.started/result → done.
//   * UnavailableRunner  — MOCK_MODEL=false: run.started → run.failed
//                         RUN_MODEL_UNAVAILABLE (no charge). Wave 4 replaces
//                         this with the LiteLLM runner behind the same seam.

import { randomUUID } from "node:crypto";

import {
  EDIT_PLAN_SCHEMA,
  estimateCredits,
  type ContextSelection,
  type EditPlan,
  type PinnedContextItem,
  type StudioStreamEvent,
} from "@studio/contracts";
import { computeReserveAmount } from "@studio/db";

/** All 12 §7.4 payloads minus the runId/seq the log assigns. */
export type RunStreamPayload = {
  [K in StudioStreamEvent["type"]]: Omit<Extract<StudioStreamEvent, { type: K }>, "runId" | "seq">;
}[StudioStreamEvent["type"]];

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
}

/** What the runner hands back to the chat route for ledger finalization. */
export interface AgentRunStream {
  emit(payload: RunStreamPayload): StudioStreamEvent;
  /** Let the SSE transport flush between events (keeps streaming observable). */
  yieldToStream(): Promise<void>;
  /** Register a toolCallId whose client-reported result will be accepted. */
  expectToolCall(toolCallId: string, tool: string): void;
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
  private plan: EditPlan | null = null;
  private terminal: StudioStreamEvent | null = null;
  private nextSeq = 0;

  constructor(runId: string) {
    this.runId = runId;
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
}

interface RegistryEntry {
  readonly log: RunLog;
  readonly controller: AbortController;
}

export class RunRegistry {
  private readonly entries = new Map<string, RegistryEntry>();

  register(runId: string): { log: RunLog; signal: AbortSignal } {
    const log = new RunLog(runId);
    const controller = new AbortController();
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
    affectedLayers: [{ id: "layer-headline", name: "Headline", change: "Rename to Subtitle" }],
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
// UnavailableRunner (MOCK_MODEL=false — LiteLLM lands in Wave 4)
// ---------------------------------------------------------------------------

export function createUnavailableRunner(): AgentRunner {
  return {
    async start(run, stream) {
      stream.emit({ type: "run.started", model: run.model });
      await stream.yieldToStream();
      return {
        kind: "failed",
        code: "RUN_MODEL_UNAVAILABLE",
        message: "The model service is unavailable right now.",
        retryable: true,
      };
    },
    cancel() {
      // Nothing to cancel upstream (§8.9: provider down → no charge).
    },
  };
}

/** Runner by env: mock when MOCK_MODEL, unavailable otherwise (Wave 4 TODO). */
export function createRunnerForEnv(mockModel: boolean): AgentRunner {
  return mockModel ? createMockRunner() : createUnavailableRunner();
}
