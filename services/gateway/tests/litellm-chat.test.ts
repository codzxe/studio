// M4-A — Seam 1 (chat route model selection + entitlements) and the runner
// selector (createRunnerForEnv). Deterministic: the LiteLLM path runs against
// a stubbed global fetch; no network, no Postgres.

import { afterEach, describe, expect, it, vi } from "vitest";

import { CHAT_REQUEST_SCHEMA, type ChatRequest } from "@studio/contracts";

import { isGatewayError } from "../src/errors.js";
import { resolveChatModel } from "../src/routes/chat.js";
import {
  type AgentRun,
  type AgentRunStream,
  type RunStreamPayload,
  type ToolWaitResult,
  createRunnerForEnv,
} from "../src/runner.js";
import { testEnv } from "./helpers.js";

const baseRequest = {
  message: "make the headline pop",
  context: {},
  idempotencyKey: "key-1234",
  pinned: [],
} as const;

// ---------------------------------------------------------------------------
// CHAT_REQUEST_SCHEMA — optional model field (M4 Seam 1)
// ---------------------------------------------------------------------------

describe("CHAT_REQUEST_SCHEMA.model", () => {
  it("stays optional: bodies without a model parse as before", () => {
    const parsed = CHAT_REQUEST_SCHEMA.parse(baseRequest);
    expect(parsed.model).toBeUndefined();
    expect(parsed.pinned).toEqual([]);
  });

  it("accepts a §8.2 alias when the client picks a model", () => {
    const parsed = CHAT_REQUEST_SCHEMA.parse({ ...baseRequest, model: "studio-smart" });
    expect(parsed.model).toBe("studio-smart");
  });

  it("rejects unknown model ids and unknown keys (strictObject)", () => {
    expect(CHAT_REQUEST_SCHEMA.safeParse({ ...baseRequest, model: "gpt-4o" }).success).toBe(false);
    expect(CHAT_REQUEST_SCHEMA.safeParse({ ...baseRequest, vendor: "x" }).success).toBe(false);
  });

  it("ChatRequest keeps the optional ModelId in its inferred type", () => {
    const request: ChatRequest = CHAT_REQUEST_SCHEMA.parse({
      ...baseRequest,
      model: "studio-fast",
    });
    expect(request.model).toBe("studio-fast");
  });
});

// ---------------------------------------------------------------------------
// resolveChatModel — plan entitlements (§8.2, §10.1)
// ---------------------------------------------------------------------------

describe("resolveChatModel", () => {
  it("defaults to the plan's model when the request has none", () => {
    expect(resolveChatModel({ requested: undefined, plan: "trial", requestId: "req_1" })).toBe(
      "studio-fast",
    );
    expect(resolveChatModel({ requested: undefined, plan: "pro", requestId: "req_1" })).toBe(
      "studio-smart",
    );
  });

  it("accepts a requested model the plan allows", () => {
    expect(resolveChatModel({ requested: "studio-fast", plan: "trial", requestId: "req_1" })).toBe(
      "studio-fast",
    );
    expect(resolveChatModel({ requested: "studio-smart", plan: "pro", requestId: "req_1" })).toBe(
      "studio-smart",
    );
    expect(
      resolveChatModel({ requested: "studio-vision", plan: "studio", requestId: "req_1" }),
    ).toBe("studio-vision");
  });

  it("throws MODEL_NOT_ENTITLED (403) for a model outside the plan", () => {
    for (const [requested, plan] of [
      ["studio-smart", "trial"],
      ["studio-vision", "trial"],
      ["studio-vision", "pro"],
    ] as const) {
      try {
        resolveChatModel({ requested, plan, requestId: "req_ent" });
        expect.unreachable(`${requested} on ${plan} must be rejected`);
      } catch (error) {
        expect(isGatewayError(error)).toBe(true);
        const gatewayError = error as ReturnType<typeof Object>;
        if (isGatewayError(error)) {
          expect(error.code).toBe("MODEL_NOT_ENTITLED");
          expect(error.status).toBe(403);
          expect(error.message).toBe("That model isn't available on your plan.");
          expect(error.retryable).toBe(false);
          expect(error.requestId).toBe("req_ent");
        }
        void gatewayError;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// createRunnerForEnv — D-16 selector
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function frame(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}
const textOnly = [
  frame({ choices: [{ delta: { content: "mock answer" } }] }),
  frame({ choices: [{ delta: {}, finish_reason: "stop" }] }),
  "data: [DONE]\n\n",
];

function sseResponse(frames: readonly string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of frames) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function makeRun(): AgentRun {
  return {
    runId: "run_sel",
    threadId: "thr_sel",
    projectId: "prj_sel",
    workspaceId: "ws_sel",
    model: "studio-fast",
    baseVersionId: null,
    message: "hi",
    context: CHAT_REQUEST_SCHEMA.parse(baseRequest).context,
    pinned: [],
    reservedCredits: 5,
  };
}

function makeStream(): { events: RunStreamPayload[]; signal: AbortSignal } {
  const controller = new AbortController();
  const events: RunStreamPayload[] = [];
  return {
    events,
    signal: controller.signal,
  };
}

// A minimal typed AgentRunStream fake.
function fakeStream(state: ReturnType<typeof makeStream>): AgentRunStream {
  return {
    emit: (payload: RunStreamPayload) => {
      state.events.push(payload);
      return { ...payload, runId: "run_sel", seq: state.events.length - 1 };
    },
    yieldToStream: async () => {
      await new Promise((resolve) => setImmediate(resolve));
    },
    expectToolCall: () => {},
    waitForToolResult: async (): Promise<ToolWaitResult> => ({ ok: true, result: {} }),
    signal: state.signal,
  };
}

describe("createRunnerForEnv (D-16)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("MOCK_MODEL=true selects the MockRunner (plan + get_context signature)", async () => {
    const env = testEnv(); // MOCK_MODEL=true by default
    const runner = createRunnerForEnv(env);
    const state = makeStream();
    const outcome = await runner.start(makeRun(), fakeStream(state));
    expect(outcome).toEqual({ kind: "completed", committedCredits: expect.any(Number) });
    const types = state.events.map((event) => event.type);
    expect(types).toEqual([
      "run.started",
      "message.delta",
      "message.delta",
      "plan",
      "tool.started",
      "tool.result",
    ]);
  });

  it("MOCK_MODEL=false selects the LiteLLM runner wired to env.litellm", async () => {
    const env = testEnv({
      MOCK_MODEL: "false",
      LITELLM_BASE_URL: "http://127.0.0.1:4567",
      LITELLM_API_KEY: "sk-platform-key",
      LITELLM_VIRTUAL_KEY: "sk-virtual-ws",
      CHAT_MAX_STEPS: "6",
    });
    const fetchSpy = vi.fn(async () => sseResponse(textOnly));
    vi.stubGlobal("fetch", fetchSpy);

    const runner = createRunnerForEnv(env);
    const state = makeStream();
    const outcome = await runner.start(makeRun(), fakeStream(state));

    expect(outcome).toEqual({ kind: "completed", committedCredits: 1 });
    expect(state.events.map((event) => event.type)).toEqual(["run.started", "message.delta"]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe("http://127.0.0.1:4567/v1/chat/completions");
    expect(init.headers.authorization).toBe("Bearer sk-virtual-ws");
    const body = JSON.parse(init.body) as { model: string; messages: unknown[] };
    expect(body.model).toBe("studio-fast");
    expect(Array.isArray(body.messages)).toBe(true);
  });

  it("falls back to the platform key when no virtual key is set", async () => {
    const env = testEnv({
      MOCK_MODEL: "false",
      LITELLM_API_KEY: "sk-platform-only",
      LITELLM_VIRTUAL_KEY: undefined,
    });
    const fetchSpy = vi.fn(async () => sseResponse(textOnly));
    vi.stubGlobal("fetch", fetchSpy);
    const runner = createRunnerForEnv(env);
    const state = makeStream();
    await runner.start(makeRun(), fakeStream(state));
    const [, init] = fetchSpy.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ];
    expect(init.headers.authorization).toBe("Bearer sk-platform-only");
  });
});
