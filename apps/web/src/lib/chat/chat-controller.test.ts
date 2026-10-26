/**
 * Controller suite — Seam 4 wire orchestration against a scripted fake of the
 * `@studio/api-client` chat-stream seam (deterministic, no network).
 *
 * The fake mirrors the DOCUMENTED streamChat contract (sse.ts), not its bytes:
 * segments replay from a server-seq cursor (Last-Event-ID semantics) with the
 * SAME body idempotency key, the §8.4 backoff schedule is 1s/2s/4s→30s with 3
 * automatic attempts before `onPause`, `cancel()` records the
 * `/v1/runs/:id/cancel` POST + aborts, `reconnect()` restarts the loop. The
 * `raw` mode feeds every event verbatim (no cursor dedupe) to exercise the
 * REDUCER's own replay guard; the `gateAfterSeq` hook parks the emitter so
 * tests interleave (stop/queue) without racing the event loop. §7.4 event
 * sequences come from the api-client's committed fixtures.
 */

// W2-B3: fixtures moved off the main barrel to the `./fixtures` subpath
// (bundle hygiene — production code can no longer import demo data).
import { ApiError } from "@studio/api-client";
import type { ApiClient, ChatStreamHandlers } from "@studio/api-client";
import { fixtures } from "@studio/api-client/fixtures";
import type {
  ChatRequest,
  ContextSelection,
  EditPlan,
  ModelId,
  StudioStreamEvent,
} from "@studio/contracts";
import { describe, expect, it } from "vitest";

import type { ApplicablePlan, ApplyController, ApplyOutcome } from "./apply";
import { type ChatController, createChatController } from "./chat-controller";
import type { ChatControllerClient, ChatSendInput, ChatStreamHandle } from "./types";

// ---------------------------------------------------------------------------
// Fake api-client chat-stream seam
// ---------------------------------------------------------------------------

interface FakeRunScript {
  /** Ordered run log; each segment replays from the cursor unless `raw`. */
  events: readonly StudioStreamEvent[];
  /** Emit every event verbatim each segment (no cursor dedupe). */
  raw?: boolean;
  /** `"start"`: every segment fails before any event (server unreachable);
   *  `{ afterSeq }`: the first segment drops right after that event. */
  dropAt: "start" | { afterSeq: number } | null;
  /** Park the emitter after this event until `release()` (test pacing). */
  gateAfterSeq?: number;
  /** The chat POST is rejected non-retryably (a fatal §7.3 envelope). */
  fatalPostError?: { code: string; message: string; retryable: boolean; status: number };
  /** `chat.stream` throws synchronously (client-side validation shape). */
  syncThrow?: unknown;
}

interface RecordedSegment {
  lastEventId: string | null;
  idempotencyKey: string;
  message: string;
  model?: string;
}

const TERMINAL_TYPES = new Set(["run.completed", "run.failed", "run.cancelled"]);

class FakeChatStream implements ChatStreamHandle {
  readonly segments: RecordedSegment[] = [];
  readonly cancelRequests: string[] = [];
  aborts = 0;
  paused = false;

  readonly #script: FakeRunScript;
  readonly #body: ChatRequest;
  readonly #handlers: ChatStreamHandlers;
  readonly #sleep: (ms: number) => Promise<void>;
  #cursor = -1;
  #attempts = 0;
  #stopped = false;
  #terminal = false;
  #finished = false;
  #runId: string | null = null;
  #dropUsed = false;
  #gate: Promise<void> | null = null;
  #releaseGate: (() => void) | null = null;

  constructor(
    script: FakeRunScript,
    body: ChatRequest,
    handlers: ChatStreamHandlers,
    sleep: (ms: number) => Promise<void>,
  ) {
    this.#script = script;
    this.#body = body;
    this.#handlers = handlers;
    this.#sleep = sleep;
    if (script.gateAfterSeq !== undefined) {
      this.#gate = new Promise<void>((resolve) => {
        this.#releaseGate = resolve;
      });
    }
    void this.#loop();
  }

  get lastEventId(): string | null {
    return this.#cursor >= 0 ? String(this.#cursor) : null;
  }

  /** Test hook: resume an emitter parked by `gateAfterSeq`. */
  release(): void {
    this.#releaseGate?.();
  }

  #finish(reason: "terminal" | "aborted" | "paused" | "error"): void {
    if (this.#finished) return;
    this.#finished = true;
    const status =
      reason === "terminal"
        ? "applied"
        : reason === "aborted"
          ? "cancelled"
          : reason === "error"
            ? "failed"
            : "streaming";
    this.#handlers.onDone?.({ reason, runId: this.#runId, status });
  }

  async #loop(): Promise<void> {
    this.#finished = false;
    const schedule = [1000, 2000, 4000, 8000];
    for (;;) {
      // The first event always lands after a macrotask — like a real HTTP
      // round trip, so callers observe `sending`/`reconnecting` first.
      await tick();
      if (this.#stopped) {
        this.#finish("aborted");
        return;
      }
      if (this.#terminal) {
        this.#finish("terminal");
        return;
      }
      this.segments.push({
        lastEventId: this.lastEventId,
        idempotencyKey: this.#body.idempotencyKey,
        message: this.#body.message,
        model: this.#body.model,
      });
      if (this.#script.fatalPostError !== undefined) {
        const fatal = this.#script.fatalPostError;
        this.#handlers.onError?.(
          new ApiError({
            code: fatal.code,
            message: fatal.message,
            retryable: fatal.retryable,
            status: fatal.status,
          }),
        );
        this.#finish("error");
        return;
      }
      let dropped = this.#script.dropAt === "start";
      if (!dropped) {
        for (const event of this.#script.events) {
          if (!this.#script.raw) {
            // Replay dedupe with Last-Event-ID semantics (what the gateway
            // replays, the cursor has already seen).
            if (event.seq <= this.#cursor) continue;
            this.#cursor = event.seq;
          }
          if (event.type === "run.started") this.#runId = event.runId;
          this.#handlers.onEvent?.(event);
          if (TERMINAL_TYPES.has(event.type)) {
            this.#terminal = true;
            break;
          }
          if (this.#stopped) {
            this.#finish("aborted");
            return;
          }
          const dropAt = this.#script.dropAt;
          if (
            typeof dropAt === "object" &&
            dropAt !== null &&
            !this.#dropUsed &&
            event.seq === dropAt.afterSeq
          ) {
            this.#dropUsed = true;
            dropped = true;
            break;
          }
          if (this.#gate !== null && event.seq === this.#script.gateAfterSeq) {
            const gate = this.#gate;
            this.#gate = null; // fire once
            await gate;
          }
          await tick();
        }
      }
      if (this.#terminal) {
        this.#finish("terminal");
        return;
      }
      if (this.#stopped) {
        this.#finish("aborted");
        return;
      }
      // Dropped (or closed without a terminal event) → the §8.4 loop.
      if (this.#attempts >= 3) {
        this.paused = true;
        this.#handlers.onPause?.({ attempts: this.#attempts });
        this.#finish("paused");
        return;
      }
      this.#attempts += 1;
      const delayMs = schedule[this.#attempts - 1] ?? 30_000;
      this.#handlers.onReconnect?.({
        attempt: this.#attempts,
        delayMs,
        lastEventId: this.lastEventId,
      });
      await this.#sleep(delayMs);
    }
  }

  cancel(): Promise<void> {
    this.#stopped = true;
    if (this.#runId !== null) this.cancelRequests.push(this.#runId);
    this.#releaseGate?.();
    this.#finish("aborted");
    return Promise.resolve();
  }

  abort(): void {
    this.#stopped = true;
    this.aborts += 1;
    this.#releaseGate?.();
    this.#finish("aborted");
  }

  async reconnect(): Promise<void> {
    if (this.#stopped || this.#terminal) return;
    this.paused = false;
    this.#attempts = 0;
    await this.#loop();
  }
}

class FakeChatClient implements ChatControllerClient {
  readonly streams: FakeChatStream[] = [];
  readonly streamCalls: Array<{ threadId: string; body: ChatRequest }> = [];
  readonly #scripts: FakeRunScript[];
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(
    scripts: readonly FakeRunScript[],
    sleep: (ms: number) => Promise<void> = () => Promise.resolve(),
  ) {
    this.#scripts = [...scripts];
    this.#sleep = sleep;
  }

  readonly chat = {
    stream: (
      threadId: string,
      body: ChatRequest,
      handlers?: ChatStreamHandlers,
    ): ChatStreamHandle => {
      const script = this.#scripts.shift() ?? { events: [], dropAt: null };
      this.streamCalls.push({ threadId, body });
      if (script.syncThrow !== undefined) throw script.syncThrow;
      const stream = new FakeChatStream(script, body, handlers ?? {}, this.#sleep);
      this.streams.push(stream);
      return stream;
    },
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function until(condition: () => boolean, budget = 500): Promise<void> {
  for (let i = 0; i < budget && !condition(); i += 1) await tick();
  if (!condition()) throw new Error("condition not met within the tick budget");
}

/** Pumps the event loop a few macrotasks (lets parked emitters settle). */
async function pump(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await tick();
}

const APPLIED = fixtures.runs.applied.events;
const UNDONE = fixtures.runs.undone.events;
const RUN_A = "run_demo_launch_applied";
const RUN_B = "run_demo_launch_undone";

const CONTEXT: ContextSelection = {
  projectSummary: true,
  activeComp: true,
  selection: false,
  playhead: true,
  focusedPanel: true,
  selectedProperties: false,
  currentFrame: false,
  recentCommands: false,
  comments: false,
};

const OPTIONS = {
  workspaceId: "ws_demo",
  projectId: "prj_demo_launch_film",
  threadId: "thr_demo_launch",
};

function makeController(
  client: FakeChatClient,
  errors: Array<{ code: string; message: string }> = [],
): ChatController {
  return createChatController({
    ...OPTIONS,
    client,
    onError: (error) => errors.push(error),
  });
}

function send(controller: ChatController, message: string, model?: ModelId): void {
  controller.send({ message, context: CONTEXT, pinned: [], ...(model ? { model } : {}) });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("createChatController — happy path", () => {
  it("streams a full run end-to-end (fixtures script)", async () => {
    const client = new FakeChatClient([{ events: APPLIED, dropAt: null }]);
    const errors: Array<{ code: string; message: string }> = [];
    const controller = makeController(client, errors);
    let notified = 0;
    controller.subscribe(() => {
      notified += 1;
    });

    send(controller, "Make the headline pop.");
    expect(controller.getSnapshot().phase).toBe("sending");
    expect(controller.getSnapshot().messages).toHaveLength(1);
    expect(client.streamCalls[0]?.threadId).toBe(OPTIONS.threadId);
    expect(client.streamCalls.length).toBe(1);

    await until(() => controller.getSnapshot().phase === "done");
    const state = controller.getSnapshot();
    expect(notified).toBeGreaterThan(4); // user msg + submit + ≥3 events
    expect(state.messages).toHaveLength(2);
    const assistant = state.messages[1];
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.runId).toBe(RUN_A);
    expect(controller.runId).toBe(RUN_A);
    expect(assistant?.text).toBe(
      "I'll animate Scale from 20% to 100% with an overshoot at 0.45s, settling at 0.7s. Keyframing now — the text layer stays editable.",
    );
    expect(assistant?.plan).toEqual(fixtures.plans.headlineSpring);
    expect(assistant?.credits).toEqual({ reserved: 0, committed: 29.75, balance: 2389.5 });
    expect(assistant?.toolCards[0]).toMatchObject({
      name: "studio.get_context",
      status: "done",
    });
    expect(state.lastSeq).toBe(9);
    expect(state.error).toBeUndefined();
    expect(errors).toEqual([]);
    controller.dispose();
  });

  it("sends the §7.2 body: message, context, pinned, idempotency key ≥8, model when set", async () => {
    const client = new FakeChatClient([{ events: APPLIED, dropAt: null }]);
    const controller = makeController(client);
    send(controller, "Render a preview.", "studio-fast");
    await until(() => controller.getSnapshot().phase === "done");
    const first = client.streams[0]?.segments[0];
    expect(first?.idempotencyKey.length).toBeGreaterThanOrEqual(8);
    expect(first?.message).toBe("Render a preview.");
    expect(first?.model).toBe("studio-fast");
    controller.dispose();
  });
});

describe("createChatController — replay dedupe + store semantics", () => {
  it("raw duplicate events change nothing and notify nobody", async () => {
    const events: StudioStreamEvent[] = [
      { type: "run.started", runId: "run_raw", seq: 0, model: "studio-smart" },
      { type: "message.delta", runId: "run_raw", seq: 1, delta: "Hello " },
      { type: "message.delta", runId: "run_raw", seq: 1, delta: "Hello " }, // duplicate seq
      {
        type: "tool.started",
        runId: "run_raw",
        seq: 2,
        toolCallId: "c1",
        name: "studio.list_layers",
        args: {},
      },
      { type: "tool.result", runId: "run_raw", seq: 3, toolCallId: "c1", result: { layers: 3 } },
      { type: "run.completed", runId: "run_raw", seq: 4 },
    ];
    const client = new FakeChatClient([{ events, raw: true, dropAt: { afterSeq: 3 } }]);
    const controller = makeController(client);
    let notified = 0;
    controller.subscribe(() => {
      notified += 1;
    });
    send(controller, "Hi");
    await until(() => controller.getSnapshot().phase === "done");
    const state = controller.getSnapshot();
    // Segment 2 re-fed everything raw; the reducer dropped the replays, and
    // the duplicate delta produced NO state change at all.
    expect(state.messages[1]?.text).toBe("Hello ");
    expect(state.messages[1]?.toolCards).toHaveLength(1);
    expect(state.lastSeq).toBe(4);
    // user msg + submit + started + delta + tool.started + tool.result + the
    // §8.4 reconnecting banner + completed = exactly 8; the duplicate seq
    // and the replayed tail produced NO notifications.
    expect(notified).toBe(8);
    // Referential stability: terminal no-ops keep the same snapshot object.
    const frozen = controller.getSnapshot();
    controller.retry();
    controller.stop();
    expect(controller.getSnapshot()).toBe(frozen);
    controller.dispose();
    expect(controller.getSnapshot()).toBe(frozen);
  });

  it("subscribe returns an working unsubscribe; getSnapshot is stable between changes", async () => {
    const client = new FakeChatClient([{ events: APPLIED, dropAt: null }]);
    const controller = makeController(client);
    let a = 0;
    let b = 0;
    const off = controller.subscribe(() => {
      a += 1;
    });
    controller.subscribe(() => {
      b += 1;
    });
    off();
    send(controller, "Hi");
    await until(() => controller.getSnapshot().phase === "done");
    expect(a).toBe(0);
    expect(b).toBeGreaterThan(0);
    const s1 = controller.getSnapshot();
    expect(controller.getSnapshot()).toBe(s1);
    controller.dispose();
  });
});

describe("createChatController — reconnect (§8.4)", () => {
  it("transport drop → same idempotency key + Last-Event-ID cursor, banner, recovery", async () => {
    const client = new FakeChatClient([{ events: APPLIED, dropAt: { afterSeq: 2 } }]);
    const controller = makeController(client);
    const phases: string[] = [];
    controller.subscribe(() => {
      phases.push(controller.getSnapshot().phase);
    });
    send(controller, "Make the headline pop.");
    await until(() => controller.getSnapshot().phase === "done");

    const [segment1, segment2] = client.streams[0]?.segments ?? [];
    expect(segment1?.idempotencyKey).toBe(segment2?.idempotencyKey); // §8.4 same key
    expect(segment2?.lastEventId).toBe("2"); // Last-Event-ID = last seen seq
    expect(segment1?.message).toBe(segment2?.message);
    expect(client.streamCalls.length).toBe(1); // the api-client loop, not a re-send
    expect(phases).toContain("reconnecting");
    expect(phases.at(-1)).toBe("done");
    // No duplicated deltas after the replay: the fixture text appears once.
    expect(controller.getSnapshot().messages[1]?.text).toContain("I'll animate Scale from 20%");
    expect(controller.getSnapshot().lastSeq).toBe(9);
    controller.dispose();
  });

  it("3 consecutive failures park with RUN_PAUSED; retry() resumes the SAME run", async () => {
    const script: FakeRunScript = { events: APPLIED, dropAt: "start" };
    const client = new FakeChatClient([script]);
    const errors: Array<{ code: string; message: string }> = [];
    const controller = makeController(client, errors);
    const phases: string[] = [];
    controller.subscribe(() => {
      phases.push(controller.getSnapshot().phase);
    });
    send(controller, "Make the headline pop.");
    await until(() => controller.getSnapshot().phase === "failed");

    const state = controller.getSnapshot();
    expect(state.phase).toBe("failed");
    expect(state.error).toEqual({
      code: "RUN_PAUSED",
      message: "Run paused. Check your connection.",
      retryable: true,
    });
    expect(errors[0]?.code).toBe("RUN_PAUSED");
    const handle = client.streams[0];
    expect(handle?.paused).toBe(true);
    expect(handle?.segments.length).toBe(4); // original POST + 3 §8.4 retries

    // §8.4 "Run paused. Check your connection." → the user hits Retry.
    script.dropAt = null;
    controller.retry();
    expect(controller.getSnapshot().phase).toBe("reconnecting");
    await until(() => controller.getSnapshot().phase === "done");
    expect(controller.getSnapshot().error).toBeUndefined();
    expect(controller.getSnapshot().messages[1]?.text).toContain("I'll animate Scale");
    expect(client.streamCalls.length).toBe(1); // resume, never a duplicate run
    expect(phases).toContain("reconnecting");
    controller.dispose();
  });
});

describe("createChatController — stop (§8.3)", () => {
  it("stop() cancels the run server-side and settles the phase locally at once", async () => {
    const client = new FakeChatClient([{ events: APPLIED, dropAt: null, gateAfterSeq: 3 }]);
    const controller = makeController(client);
    send(controller, "Make the headline pop.");
    // The gate parks the emitter right after the first delta — no race.
    await until(
      () =>
        (controller.getSnapshot().messages[1]?.text.length ?? 0) > 0 &&
        controller.getSnapshot().phase === "streaming",
    );
    controller.stop();
    const state = controller.getSnapshot();
    expect(state.phase).toBe("cancelled"); // local, immediate
    expect(state.activeRunId).toBe(RUN_A);
    const handle = client.streams[0];
    expect(handle?.cancelRequests).toEqual([RUN_A]); // the fused cancel POST
    client.streams[0]?.release();
    await pump();
    expect(controller.getSnapshot().phase).toBe("cancelled");
    expect(controller.getSnapshot().messages[1]?.text).toContain("I'll animate Scale");
    controller.dispose();
  });
});

describe("createChatController — steer queue (§3.4)", () => {
  it("sends while streaming queue locally and flush after the terminal phase", async () => {
    const client = new FakeChatClient([
      { events: APPLIED, dropAt: null, gateAfterSeq: 3 },
      { events: UNDONE, dropAt: null },
    ]);
    const controller = makeController(client);
    send(controller, "Make the headline pop.");
    await until(
      () =>
        (controller.getSnapshot().messages[1]?.text.length ?? 0) > 0 &&
        controller.getSnapshot().phase === "streaming",
    );

    send(controller, "Soften the subhead.");
    // Queued: the user message renders immediately, no second POST.
    let state = controller.getSnapshot();
    expect(state.phase).toBe("streaming");
    expect(client.streamCalls.length).toBe(1);
    expect(state.messages).toHaveLength(3);
    expect(state.messages[2]).toMatchObject({ role: "user", text: "Soften the subhead." });

    client.streams[0]?.release();
    await until(() => controller.getSnapshot().phase === "done");
    state = controller.getSnapshot();
    expect(client.streamCalls.length).toBe(2); // flushed when run A settled
    expect(client.streamCalls[1]?.body.message).toBe("Soften the subhead.");
    expect(client.streamCalls[1]?.body.idempotencyKey.length).toBeGreaterThanOrEqual(8);
    expect(state.messages).toHaveLength(4); // user, assistant A, user B, assistant B
    expect(state.messages[1]?.runId).toBe(RUN_A);
    expect(state.messages[3]?.runId).toBe(RUN_B);
    expect(state.activeRunId).toBe(RUN_B);
    // The queued send used its OWN idempotency key (fresh key per send).
    const keyA = client.streams[0]?.segments[0]?.idempotencyKey;
    const keyB = client.streams[1]?.segments[0]?.idempotencyKey;
    expect(keyA).toBeDefined();
    expect(keyB).toBeDefined();
    expect(keyA).not.toBe(keyB);
    controller.dispose();
  });
});

describe("createChatController — error surfaces", () => {
  it("run.failed maps code/message and onError; retry() starts a FRESH run without a duplicate user message", async () => {
    const failedRun: StudioStreamEvent[] = [
      { type: "run.started", runId: "run_failed_1", seq: 0, model: "studio-smart" },
      { type: "message.delta", runId: "run_failed_1", seq: 1, delta: "partial" },
      {
        type: "run.failed",
        runId: "run_failed_1",
        seq: 2,
        code: "RUN_MODEL_UNAVAILABLE",
        message: "The model is unavailable. Retry or switch models.",
        retryable: true,
      },
    ];
    const client = new FakeChatClient([
      { events: failedRun, dropAt: null },
      { events: APPLIED, dropAt: null },
    ]);
    const errors: Array<{ code: string; message: string }> = [];
    const controller = makeController(client, errors);
    send(controller, "Make the headline pop.");
    await until(() => controller.getSnapshot().phase === "failed");
    let state = controller.getSnapshot();
    expect(state.error).toEqual({
      code: "RUN_MODEL_UNAVAILABLE",
      message: "The model is unavailable. Retry or switch models.",
      retryable: true,
    });
    expect(state.messages[1]?.text).toBe("partial");
    expect(errors).toEqual([
      {
        code: "RUN_MODEL_UNAVAILABLE",
        message: "The model is unavailable. Retry or switch models.",
      },
    ]);

    controller.retry(); // terminal failure → fresh key, no duplicate user message
    await until(() => controller.getSnapshot().phase === "done");
    state = controller.getSnapshot();
    expect(client.streamCalls.length).toBe(2);
    const key1 = client.streams[0]?.segments[0]?.idempotencyKey;
    const key2 = client.streams[1]?.segments[0]?.idempotencyKey;
    expect(key1).not.toBe(key2);
    expect(state.messages).toHaveLength(3); // user + failed assistant + new assistant
    expect(state.messages.filter((m) => m.role === "user")).toHaveLength(1);
    controller.dispose();
  });

  it("INSUFFICIENT_CREDITS on send → error state, no assistant message", async () => {
    const client = new FakeChatClient([
      {
        events: [],
        dropAt: null,
        fatalPostError: {
          code: "INSUFFICIENT_CREDITS",
          message: "You're 8 credits short. Upgrade or pick a smaller model.",
          retryable: false,
          status: 402,
        },
      },
    ]);
    const errors: Array<{ code: string; message: string }> = [];
    const controller = makeController(client, errors);
    send(controller, "Make the headline pop.");
    await until(() => controller.getSnapshot().phase === "failed");
    const state = controller.getSnapshot();
    expect(state.error).toEqual({
      code: "INSUFFICIENT_CREDITS",
      message: "You're 8 credits short. Upgrade or pick a smaller model.",
      retryable: false,
    });
    expect(state.messages).toHaveLength(1); // the user message only
    expect(state.messages[0]?.role).toBe("user");
    expect(state.activeRunId).toBeNull();
    expect(errors).toEqual([
      {
        code: "INSUFFICIENT_CREDITS",
        message: "You're 8 credits short. Upgrade or pick a smaller model.",
      },
    ]);
    controller.dispose();
  });

  it("pre-run failures retry with the SAME idempotency key (never duplicate a run)", async () => {
    const client = new FakeChatClient([
      {
        events: [],
        dropAt: null,
        fatalPostError: {
          code: "MODEL_NOT_ENTITLED",
          message: "That model isn't available on your plan.",
          retryable: false,
          status: 403,
        },
      },
      { events: APPLIED, dropAt: null },
    ]);
    const controller = makeController(client);
    send(controller, "Make the headline pop.", "studio-vision");
    await until(() => controller.getSnapshot().phase === "failed");
    controller.retry();
    expect(controller.getSnapshot().phase).toBe("sending");
    await until(() => controller.getSnapshot().phase === "done");
    expect(client.streamCalls.length).toBe(2);
    const key1 = client.streams[0]?.segments[0]?.idempotencyKey;
    const key2 = client.streams[1]?.segments[0]?.idempotencyKey;
    expect(key2).toBe(key1); // §8.4: same key — the gateway replays/creates idempotently
    const state = controller.getSnapshot();
    expect(state.messages).toHaveLength(2); // no duplicate user message
    expect(state.messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(state.messages[1]?.runId).toBe(RUN_A);
    controller.dispose();
  });

  it("a synchronous client validation throw surfaces as the error state", async () => {
    const client = new FakeChatClient([
      {
        events: [],
        dropAt: null,
        syncThrow: new ApiError({
          code: "VALIDATION_FAILED",
          message: "That request didn't look right.",
          retryable: false,
          status: 0,
        }),
      },
    ]);
    const errors: Array<{ code: string; message: string }> = [];
    const controller = makeController(client, errors);
    send(controller, "Hi");
    const state = controller.getSnapshot();
    expect(state.phase).toBe("failed");
    expect(state.error).toEqual({
      code: "VALIDATION_FAILED",
      message: "That request didn't look right.",
      retryable: false,
    });
    expect(state.messages).toHaveLength(1);
    expect(client.streams).toHaveLength(0); // threw before a handle existed
    expect(errors).toEqual([
      { code: "VALIDATION_FAILED", message: "That request didn't look right." },
    ]);
    controller.dispose();
  });

  it("dispose aborts the in-flight stream and freezes the snapshot", async () => {
    const client = new FakeChatClient([{ events: APPLIED, dropAt: null, gateAfterSeq: 3 }]);
    const controller = makeController(client);
    send(controller, "Make the headline pop.");
    await until(() => controller.getSnapshot().phase === "streaming");
    controller.dispose();
    const handle = client.streams[0];
    expect(handle?.aborts).toBe(1); // abort, not cancel — dispose is teardown
    expect(handle?.cancelRequests).toEqual([]);
    const frozen = controller.getSnapshot();
    client.streams[0]?.release();
    await pump();
    expect(controller.getSnapshot()).toBe(frozen); // late events never land
    controller.dispose();
  });
});

describe("createChatController — type seam", () => {
  it("the real ApiClient satisfies ChatControllerClient (compile-time guard)", () => {
    // `{} as ApiClient` compiles because {} is comparable; the ASSIGNMENT is
    // the check — it stops compiling the moment the port drifts from the
    // api-client's real chat.stream signature.
    const check: ChatControllerClient = {} as ApiClient;
    expect(typeof check).toBe("object");
  });
});

// ---------------------------------------------------------------------------
// ROUND-10 v2 — the AUTO-APPLY DRIVE: verdict "auto" ⇒ the controller itself
// drives Apply at run.completed (no click), once per run, guarded.
// ---------------------------------------------------------------------------

describe("createChatController — auto-apply drive (round-10 v2)", () => {
  const RUN = "run_auto_1";

  const DEMO_PLAN: EditPlan = {
    intent: "create",
    summary: 'Add text layer "Headline"',
    risk: "low",
    requiresApproval: false,
    affectedLayers: [] as Array<{ name: string; change: string }>,
    estimatedCredits: 1.5,
    steps: [
      {
        title: "Add the headline",
        tool: "studio.create_text",
        args: { text: "Hello", name: "Headline" },
        batch: {
          label: "Add the headline",
          steps: [{ command: "create_text", params: { text: "Hello" } }],
        },
      },
    ],
  };

  const DEMO_COMPILED = {
    label: 'Agent: Add text layer "Headline"',
    atomic: true as const,
    steps: [{ command: "layer.newText", params: { text: "Hello", name: "Headline" } }],
  };

  /** A run script ending in run.completed; the plan event's verdict is a knob. */
  const autoRunScript = (
    autoApply: { mode: "auto" | "propose"; reason: string },
    extra: { resolutionRequests?: Array<{ requestId: string; layerName: string }> } = {},
  ): readonly StudioStreamEvent[] => [
    { type: "run.started", runId: RUN, seq: 0, model: "studio-smart" },
    { type: "message.delta", runId: RUN, seq: 1, delta: "Built it." },
    {
      type: "plan",
      runId: RUN,
      seq: 2,
      plan: DEMO_PLAN,
      compiledBatch: DEMO_COMPILED,
      ...(extra.resolutionRequests === undefined
        ? {}
        : { resolutionRequests: extra.resolutionRequests }),
      risk: "low",
      estimatedCredits: 1.5,
      autoApply,
    } as StudioStreamEvent,
    { type: "run.completed", runId: RUN, seq: 4 },
  ];

  /** The minimal recording engine; outcome defaults to a successful apply. */
  function makeEngine(outcome?: ApplyOutcome): {
    engine: ApplyController;
    appliedWith: Array<ApplicablePlan>;
  } {
    const appliedWith: Array<ApplicablePlan> = [];
    const ok: ApplyOutcome = outcome ?? { ok: true, versionId: "ver_auto_1", creditsCommitted: 1 };
    const engine: ApplyController = {
      apply: async (plan) => {
        appliedWith.push(plan);
        return ok;
      },
      reapply: async () => ok,
      undo: async () => ({ ok: true, undone: true }),
      retrySave: async () => ok,
    };
    return { engine, appliedWith };
  }

  function makeAutoController(
    client: FakeChatClient,
    engine: ApplyController,
    errors: Array<{ code: string; message: string }> = [],
  ): ChatController {
    return createChatController({
      ...OPTIONS,
      client,
      apply: engine,
      onError: (error) => errors.push(error),
    });
  }

  it("verdict auto + engine present ⇒ apply fires at run.completed, once, and the card folds to applied", async () => {
    const client = new FakeChatClient([
      { events: autoRunScript({ mode: "auto", reason: "eligible" }), dropAt: null },
    ]);
    const { engine, appliedWith } = makeEngine();
    const controller = makeAutoController(client, engine);

    send(controller, "Add a headline.");
    await until(() => controller.getSnapshot().phase === "done");
    // The engine was called exactly once, with the enriched plan's batch.
    await until(() => appliedWith.length === 1);
    expect(appliedWith[0]?.runId).toBe(RUN);
    expect(appliedWith[0]?.compiledBatch.steps).toEqual(DEMO_COMPILED.steps);
    // The card folds to the APPLIED state (the plan runtime settled).
    await until(() => {
      const runtime = controller.getSnapshot().messages[1]?.planRuntime;
      return runtime?.outcome === "applied";
    });
    const runtime = controller.getSnapshot().messages[1]?.planRuntime;
    expect(runtime?.versionId).toBe("ver_auto_1");
    controller.dispose();
  });

  it("a duplicated run.completed (raw replay) still applies exactly ONCE", async () => {
    const script = [
      ...autoRunScript({ mode: "auto", reason: "eligible" }),
      // The §8.4 loop may replay the terminal event after a reconnect; the
      // fold dedupes by seq and the drive's once-per-run guard holds.
      { type: "run.completed", runId: RUN, seq: 4 } as StudioStreamEvent,
    ];
    const client = new FakeChatClient([{ events: script, dropAt: null, raw: true }]);
    const { engine, appliedWith } = makeEngine();
    const controller = makeAutoController(client, engine);

    send(controller, "Add a headline.");
    await until(() => controller.getSnapshot().phase === "done");
    await pump();
    expect(appliedWith).toHaveLength(1);
    controller.dispose();
  });

  it("no apply engine (read-only embed) ⇒ nothing fires, no crash, the card stays proposed", async () => {
    const client = new FakeChatClient([
      { events: autoRunScript({ mode: "auto", reason: "eligible" }), dropAt: null },
    ]);
    const controller = makeController(client);

    send(controller, "Add a headline.");
    await until(() => controller.getSnapshot().phase === "done");
    await pump();
    const runtime = controller.getSnapshot().messages[1]?.planRuntime;
    expect(runtime?.outcome).toBe("idle");
    controller.dispose();
  });

  it("unresolved layer-name requests ⇒ the drive stays OFF (ambiguity needs the user's pick)", async () => {
    const client = new FakeChatClient([
      {
        events: autoRunScript(
          { mode: "auto", reason: "eligible" },
          { resolutionRequests: [{ requestId: "req_1", layerName: "Headline" }] },
        ),
        dropAt: null,
      },
    ]);
    const { engine, appliedWith } = makeEngine();
    const controller = makeAutoController(client, engine);

    send(controller, "Add a headline.");
    await until(() => controller.getSnapshot().phase === "done");
    await pump();
    expect(appliedWith).toHaveLength(0);
    expect(controller.getSnapshot().messages[1]?.planRuntime?.outcome).toBe("idle");
    controller.dispose();
  });

  it("verdict propose ⇒ nothing fires (manual Apply stays the path)", async () => {
    const client = new FakeChatClient([
      { events: autoRunScript({ mode: "propose", reason: "risk-too-high" }), dropAt: null },
    ]);
    const { engine, appliedWith } = makeEngine();
    const controller = makeAutoController(client, engine);

    send(controller, "Add a headline.");
    await until(() => controller.getSnapshot().phase === "done");
    await pump();
    expect(appliedWith).toHaveLength(0);
    controller.dispose();
  });
});
