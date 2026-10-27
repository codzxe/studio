// 12-w3-i7 (round 12 — client-driven agent loop, tools endpoints): the two
// server-executed generative tool seams over the STUB harness (FakeGatewayAuth
// + fake repos, no Postgres) with a stubbed global fetch. Coverage map:
//   * web_search — keyless Tavily wire shape (X-Tavily-Access-Mode header, NO
//     Authorization), keyed wire shape (Bearer, no access-mode header), body
//     mapping {query,max_results,search_depth}, 500-char content trim, the
//     §8.8 charge of exactly 1 credit at the D-12 microcredit boundary (the
//     same conversion credits-units.test.ts pins: 1 credit = 1_000_000 µc),
//     provider 429/network → retryable WEB_SEARCH_UNAVAILABLE 503 with NO
//     charge, zero balance → 402 before any provider call, invalid bodies →
//     VALIDATION_FAILED, membership denial floors (401/403/404 + §12.1
//     cross-tenant 404 + THREAD_NOT_FOUND)
//   * generate_image — unconfigured → honest non-retryable 501; configured
//     happy path (call shape {model,prompt,size,n:1}, Bearer key, b64/url
//     mapping, 8-credit charge), provider non-2xx and >10MB bodies → 503
//     retryable with no charge, invalid bodies → VALIDATION_FAILED
// The route is mounted on a local app shell (the lead wires app.ts); the
// shell mirrors buildApp's deps/requestId/error boundary so envelopes match.

import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DbError, type Repos } from "@studio/db";

import type { AppBindings, GatewayDeps } from "../src/context.js";
import { MICROCREDITS_PER_CREDIT } from "../src/credits-display.js";
import { toErrorEnvelope } from "../src/errors.js";
import { requestIdMiddleware } from "../src/middleware.js";
import { registerToolRoutes } from "../src/routes/tools.js";
import { FakeGatewayAuth, stubDeps, testEnv, unique } from "./helpers.js";

const env = testEnv();

/** The first signUp()'s org — the fakes' known-good workspace. */
const WORKSPACE_ID = "fake_org_1";
const THREAD_ID = "thr_fake_1";
const SEARCH_PATH = `/v1/threads/${THREAD_ID}/tools/web_search`;
const IMAGE_PATH = `/v1/threads/${THREAD_ID}/tools/generate_image`;

/** The optional env the route reads (round 12) — every test starts clean. */
const OPTIONAL_ENV_KEYS = [
  "TAVILY_API_KEY",
  "STUDIO_IMAGE_API_BASE_URL",
  "STUDIO_IMAGE_API_KEY",
  "STUDIO_IMAGE_API_MODEL",
] as const;

// ---------------------------------------------------------------------------
// Stub repos: only the two seams the tools routes touch (threads.get, ledger)
// ---------------------------------------------------------------------------

interface LedgerCall {
  readonly workspaceId: string;
  readonly amount: number;
  readonly idempotencyKey: string;
  readonly metadata?: unknown;
}

function makeToolRepos(): {
  readonly repos: Repos;
  readonly ledgerCalls: readonly LedgerCall[];
  setBalance(microcredits: number): void;
} {
  const ledgerCallsMut: LedgerCall[] = [];
  const state = { balance: 100 * MICROCREDITS_PER_CREDIT };
  const repos = {
    threads: {
      async get(workspaceId: string, threadId: string) {
        if (workspaceId !== WORKSPACE_ID || threadId !== THREAD_ID) {
          // Mirrors the repo's message shape: "thread …" only — the gateway's
          // not-found mapper checks "workspace" FIRST (§12.1), so the fake must
          // not mention it.
          throw DbError.notFound(`thread ${threadId} not found`);
        }
        return {
          id: THREAD_ID,
          workspaceId,
          projectId: "prj_fake_1",
          title: "Fake thread",
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      },
    },
    ledger: {
      async balance(_workspaceId: string): Promise<number> {
        return state.balance;
      },
      async adjust(
        workspaceId: string,
        input: { amount: number; idempotencyKey: string; metadata?: unknown },
      ) {
        state.balance += input.amount;
        ledgerCallsMut.push({
          workspaceId,
          amount: input.amount,
          idempotencyKey: input.idempotencyKey,
          metadata: input.metadata,
        });
        return {
          entry: { id: `led_${ledgerCallsMut.length}`, workspaceId, amount: input.amount },
          replayed: false,
        };
      },
    },
  } as unknown as Repos;
  return {
    repos,
    ledgerCalls: ledgerCallsMut,
    setBalance: (microcredits: number) => {
      state.balance = microcredits;
    },
  };
}

// ---------------------------------------------------------------------------
// App shell: the deps/requestId/error-boundary prefix buildApp gives every
// route, plus ONLY the tools router (app.ts wiring is the lead's file).
// ---------------------------------------------------------------------------

function buildToolsApp(deps: GatewayDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("*", async (c, next) => {
    c.set("deps", deps);
    await next();
  });
  app.use("*", requestIdMiddleware());
  app.onError((error, c) => {
    const requestId = c.get("requestId") ?? "req_unknown";
    const { status, envelope } = toErrorEnvelope(error, requestId);
    return c.json(envelope, status as ContentfulStatusCode);
  });
  app.route("/", registerToolRoutes(deps));
  return app;
}

// ---------------------------------------------------------------------------
// Fetch stub: records the outbound provider call, replies per test.
// ---------------------------------------------------------------------------

interface FetchCall {
  readonly url: string;
  readonly method: string | undefined;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

let fetchCalls: readonly FetchCall[] = [];

function stubFetch(responder: (call: FetchCall) => Response): void {
  fetchCalls = [];
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, name) => {
        headers[name] = value;
      });
      const call: FetchCall = {
        url: String(input),
        method: init?.method,
        headers,
        body: init?.body,
      };
      fetchCalls = [...fetchCalls, call];
      return responder(call);
    },
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let auth: FakeGatewayAuth;
let repos: ReturnType<typeof makeToolRepos>;
let app: Hono<AppBindings>;

function sessionJar(
  member: { user: { token: string }; org: { id: string } },
  workspaceId?: string,
): { cookie: string; workspaceId: string } {
  return {
    cookie: `session=${member.user.token}`,
    workspaceId: workspaceId ?? member.org.id,
  };
}

async function postJson(
  path: string,
  jar: { cookie: string; workspaceId: string } | null,
  body: unknown,
): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(jar === null ? {} : { cookie: jar.cookie, "x-workspace-id": jar.workspaceId }),
      "idempotency-key": unique("tool-idem"),
    },
    body: JSON.stringify(body),
  });
}

interface ErrEnvelopeBody {
  readonly error: { code: string; message: string; retryable: boolean; hint?: string };
}

async function errOf(
  response: Response,
): Promise<{ status: number; error: ErrEnvelopeBody["error"] }> {
  const parsed = (await response.json()) as ErrEnvelopeBody;
  return { status: response.status, error: parsed.error };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  for (const key of OPTIONAL_ENV_KEYS) delete process.env[key];
  auth = new FakeGatewayAuth();
  repos = makeToolRepos();
  app = buildToolsApp(stubDeps(env, { auth, repos: repos.repos }));
  // Default: any outbound fetch is a bug — denial/validation tests must never
  // touch the network.
  stubFetch(() => {
    throw new Error("unexpected outbound fetch");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of OPTIONAL_ENV_KEYS) delete process.env[key];
});

// ---------------------------------------------------------------------------
// POST /v1/threads/:id/tools/web_search
// ---------------------------------------------------------------------------

describe("POST /v1/threads/:id/tools/web_search (12-w3-i7)", () => {
  it("401s without a session (AUTH_REQUIRED) and never calls the provider", async () => {
    const { status, error } = await errOf(await postJson(SEARCH_PATH, null, { query: "hi" }));
    expect(status).toBe(401);
    expect(error.code).toBe("AUTH_REQUIRED");
    expect(fetchCalls).toEqual([]);
  });

  it("404s a non-member as WORKSPACE_NOT_FOUND (§12.1 — existence never leaks)", async () => {
    const owner = auth.signUp("owner");
    const stranger = auth.signUp("owner");
    const { status, error } = await errOf(
      await postJson(SEARCH_PATH, sessionJar(stranger, owner.org.id), { query: "hi" }),
    );
    expect(status).toBe(404);
    expect(error.code).toBe("WORKSPACE_NOT_FOUND");
    expect(fetchCalls).toEqual([]);
  });

  it("403s a viewer member (the chat route's editor floor)", async () => {
    const viewer = auth.signUp("viewer");
    const { status, error } = await errOf(
      await postJson(SEARCH_PATH, sessionJar(viewer), { query: "hi" }),
    );
    expect(status).toBe(403);
    expect(error.code).toBe("FORBIDDEN");
    expect(fetchCalls).toEqual([]);
  });

  it("404s an unknown in-workspace thread as THREAD_NOT_FOUND", async () => {
    const owner = auth.signUp("owner");
    const { status, error } = await errOf(
      await postJson("/v1/threads/thr_missing/tools/web_search", sessionJar(owner), {
        query: "hi",
      }),
    );
    expect(status).toBe(404);
    expect(error.code).toBe("THREAD_NOT_FOUND");
    expect(fetchCalls).toEqual([]);
  });

  it("rejects invalid bodies with VALIDATION_FAILED before the provider", async () => {
    const owner = auth.signUp("owner");
    for (const bad of [
      { query: "" },
      { query: "x".repeat(401) },
      { query: "q", maxResults: 6 },
      { query: "q", maxResults: 0 },
      { query: "q", maxResults: "three" },
      null,
    ]) {
      const { status, error } = await errOf(await postJson(SEARCH_PATH, sessionJar(owner), bad));
      expect(status).toBe(400);
      expect(error.code).toBe("VALIDATION_FAILED");
    }
    expect(fetchCalls).toEqual([]);
    expect(repos.ledgerCalls).toEqual([]);
  });

  it("keyless happy path: X-Tavily-Access-Mode header, no Authorization, trimmed results, 1-credit charge", async () => {
    const owner = auth.signUp("owner");
    stubFetch(() =>
      jsonResponse({
        results: [
          { title: "T1", url: "https://a.example", content: "c".repeat(600) },
          { title: "T2", url: "https://b.example" },
        ],
      }),
    );
    const response = await postJson(SEARCH_PATH, sessionJar(owner), {
      query: "motion graphics",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { results: { title: string; url: string; content: string }[] };
    };
    expect(body.data.results).toEqual([
      { title: "T1", url: "https://a.example", content: "c".repeat(500) },
      { title: "T2", url: "https://b.example", content: "" },
    ]);

    expect(fetchCalls).toHaveLength(1);
    const call = fetchCalls[0];
    expect(call?.url).toBe("https://api.tavily.com/search");
    expect(call?.method).toBe("POST");
    expect(call?.headers["x-tavily-access-mode"]).toBe("keyless");
    expect(call?.headers.authorization).toBeUndefined();
    expect(JSON.parse(String(call?.body))).toEqual({
      query: "motion graphics",
      max_results: 5,
      search_depth: "basic",
    });

    // §8.8: exactly 1 credit, charged through the chat seam at the D-12 µc
    // boundary with the namespaced idempotency-key path.
    expect(repos.ledgerCalls).toHaveLength(1);
    const charge = repos.ledgerCalls[0];
    expect(charge?.amount).toBe(-MICROCREDITS_PER_CREDIT);
    expect(charge?.idempotencyKey).toMatch(/^tool:web_search:/);
    expect(charge?.workspaceId).toBe(WORKSPACE_ID);
  });

  it("keyed happy path: TAVILY_API_KEY switches to Bearer auth and drops the keyless header", async () => {
    process.env.TAVILY_API_KEY = "tvly-secret-123";
    const owner = auth.signUp("owner");
    stubFetch(() =>
      jsonResponse({ results: [{ title: "K", url: "https://k.example", content: "k" }] }),
    );
    const response = await postJson(SEARCH_PATH, sessionJar(owner), {
      query: "q",
      maxResults: 3,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: unknown };
    expect(body.data).toEqual({
      results: [{ title: "K", url: "https://k.example", content: "k" }],
    });
    const call = fetchCalls[0];
    expect(call?.headers.authorization).toBe("Bearer tvly-secret-123");
    expect(call?.headers["x-tavily-access-mode"]).toBeUndefined();
    expect(JSON.parse(String(call?.body))).toEqual({
      query: "q",
      max_results: 3,
      search_depth: "basic",
    });
    expect(repos.ledgerCalls).toHaveLength(1);
    expect(repos.ledgerCalls[0]?.amount).toBe(-MICROCREDITS_PER_CREDIT);
  });

  it("provider 429 → retryable WEB_SEARCH_UNAVAILABLE 503, never charged", async () => {
    const owner = auth.signUp("owner");
    stubFetch(() => new Response("rate limited", { status: 429 }));
    const { status, error } = await errOf(
      await postJson(SEARCH_PATH, sessionJar(owner), { query: "q" }),
    );
    expect(status).toBe(503);
    expect(error.code).toBe("WEB_SEARCH_UNAVAILABLE");
    expect(error.retryable).toBe(true);
    expect(repos.ledgerCalls).toEqual([]);
  });

  it("network failure → the same retryable 503 envelope, never charged", async () => {
    const owner = auth.signUp("owner");
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    const { status, error } = await errOf(
      await postJson(SEARCH_PATH, sessionJar(owner), { query: "q" }),
    );
    expect(status).toBe(503);
    expect(error.code).toBe("WEB_SEARCH_UNAVAILABLE");
    expect(error.retryable).toBe(true);
    expect(repos.ledgerCalls).toEqual([]);
  });

  it("402 INSUFFICIENT_CREDITS on a zero balance, before any provider call", async () => {
    const owner = auth.signUp("owner");
    repos.setBalance(0);
    const { status, error } = await errOf(
      await postJson(SEARCH_PATH, sessionJar(owner), { query: "q" }),
    );
    expect(status).toBe(402);
    expect(error.code).toBe("INSUFFICIENT_CREDITS");
    expect(fetchCalls).toEqual([]);
    expect(repos.ledgerCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/threads/:id/tools/generate_image
// ---------------------------------------------------------------------------

describe("POST /v1/threads/:id/tools/generate_image (12-w3-i7)", () => {
  it("unconfigured → 501 IMAGE_GENERATION_UNAVAILABLE, non-retryable, no provider call", async () => {
    const owner = auth.signUp("owner");
    const { status, error } = await errOf(
      await postJson(IMAGE_PATH, sessionJar(owner), { prompt: "a red cube" }),
    );
    expect(status).toBe(501);
    expect(error.code).toBe("IMAGE_GENERATION_UNAVAILABLE");
    expect(error.retryable).toBe(false);
    expect(error.message).toBe(
      "Image generation is not configured for this workspace's deployment.",
    );
    expect(fetchCalls).toEqual([]);
    expect(repos.ledgerCalls).toEqual([]);
  });

  it("rejects invalid bodies with VALIDATION_FAILED", async () => {
    const owner = auth.signUp("owner");
    for (const bad of [{ prompt: "" }, { prompt: "p", size: "512x512" }, null]) {
      const { status, error } = await errOf(await postJson(IMAGE_PATH, sessionJar(owner), bad));
      expect(status).toBe(400);
      expect(error.code).toBe("VALIDATION_FAILED");
    }
    expect(fetchCalls).toEqual([]);
  });

  it("configured happy path: OpenAI-compatible call shape, b64 mapping, 8-credit charge", async () => {
    process.env.STUDIO_IMAGE_API_BASE_URL = "https://img.example.com/v1";
    process.env.STUDIO_IMAGE_API_KEY = "sk-img-test";
    process.env.STUDIO_IMAGE_API_MODEL = "studio-image-xl";
    const owner = auth.signUp("owner");
    stubFetch(() => jsonResponse({ data: [{ b64_json: "QUJD" }] }));
    const response = await postJson(IMAGE_PATH, sessionJar(owner), {
      prompt: "a red cube",
      size: "1536x1024",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { imageBase64?: string; imageUrl?: string } };
    expect(body.data).toEqual({ imageBase64: "QUJD" });

    const call = fetchCalls[0];
    expect(call?.url).toBe("https://img.example.com/v1/images/generations");
    expect(call?.headers.authorization).toBe("Bearer sk-img-test");
    expect(JSON.parse(String(call?.body))).toEqual({
      model: "studio-image-xl",
      prompt: "a red cube",
      size: "1536x1024",
      n: 1,
    });

    expect(repos.ledgerCalls).toHaveLength(1);
    const charge = repos.ledgerCalls[0];
    expect(charge?.amount).toBe(-8 * MICROCREDITS_PER_CREDIT);
    expect(charge?.idempotencyKey).toMatch(/^tool:generate_image:/);
  });

  it("url payloads map to { imageUrl } (first present field wins)", async () => {
    process.env.STUDIO_IMAGE_API_BASE_URL = "https://img.example.com/v1";
    process.env.STUDIO_IMAGE_API_KEY = "sk-img-test";
    process.env.STUDIO_IMAGE_API_MODEL = "studio-image-xl";
    const owner = auth.signUp("owner");
    stubFetch(() => jsonResponse({ data: [{ url: "https://cdn.example.com/img.png" }] }));
    const response = await postJson(IMAGE_PATH, sessionJar(owner), { prompt: "a red cube" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { imageBase64?: string; imageUrl?: string } };
    expect(body.data).toEqual({ imageUrl: "https://cdn.example.com/img.png" });
    expect(repos.ledgerCalls).toHaveLength(1);
    expect(repos.ledgerCalls[0]?.amount).toBe(-8 * MICROCREDITS_PER_CREDIT);
  });

  it("provider non-2xx → retryable 503 IMAGE_GENERATION_UNAVAILABLE, never charged", async () => {
    process.env.STUDIO_IMAGE_API_BASE_URL = "https://img.example.com/v1";
    process.env.STUDIO_IMAGE_API_KEY = "sk-img-test";
    process.env.STUDIO_IMAGE_API_MODEL = "studio-image-xl";
    const owner = auth.signUp("owner");
    stubFetch(() => new Response("boom", { status: 500 }));
    const { status, error } = await errOf(
      await postJson(IMAGE_PATH, sessionJar(owner), { prompt: "p" }),
    );
    expect(status).toBe(503);
    expect(error.code).toBe("IMAGE_GENERATION_UNAVAILABLE");
    expect(error.retryable).toBe(true);
    expect(repos.ledgerCalls).toEqual([]);
  });

  it("rejects provider bodies over 10MB with the 503 envelope and never charges", async () => {
    process.env.STUDIO_IMAGE_API_BASE_URL = "https://img.example.com/v1";
    process.env.STUDIO_IMAGE_API_KEY = "sk-img-test";
    process.env.STUDIO_IMAGE_API_MODEL = "studio-image-xl";
    const owner = auth.signUp("owner");
    stubFetch(() => new Response("x".repeat(10 * 1024 * 1024 + 1), { status: 200 }));
    const { status, error } = await errOf(
      await postJson(IMAGE_PATH, sessionJar(owner), { prompt: "p" }),
    );
    expect(status).toBe(503);
    expect(error.code).toBe("IMAGE_GENERATION_UNAVAILABLE");
    expect(error.retryable).toBe(true);
    expect(repos.ledgerCalls).toEqual([]);
  });
});
