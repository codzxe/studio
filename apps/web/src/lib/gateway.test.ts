/**
 * `gatewayCall` tests — the RSC seam's §7.3 envelope unwrap, cookie
 * forwarding, typed errors and sanitization. `next/headers` is mocked (RSC
 * cookies) and `fetch` stubbed; no network.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayHttpError, gatewayCall, isGatewayNotFound } from "./gateway";

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [
      { name: "better-auth.session_token", value: "tok_session" },
      { name: "better-auth.csrf_token", value: "tok_csrf" },
    ],
  }),
}));

const BASE = "http://127.0.0.1:8787";

beforeEach(() => {
  vi.restoreAllMocks();
});

function stubFetch(handler: (input: string, init?: RequestInit) => Promise<Response>): {
  calls: Array<{ input: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ input: url, init });
      return handler(url, init);
    }),
  );
  return { calls };
}

function okData(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), { status });
}

function errEnvelope(
  status: number,
  body: { code: string; message: string; hint?: string; retryable?: boolean },
): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: body.code,
        message: body.message,
        hint: body.hint,
        retryable: body.retryable ?? false,
        requestId: "req_test_0000000000000000000000",
      },
    }),
    { status },
  );
}

describe("gatewayCall", () => {
  it("unwraps the Ok envelope and forwards cookies + workspace header", async () => {
    const { calls } = stubFetch(() => Promise.resolve(okData({ hello: "studio" })));
    const data = await gatewayCall<{ hello: string }>("/v1/me", { workspaceId: "ws_1" });
    expect(data).toEqual({ hello: "studio" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(`${BASE}/v1/me`);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("cookie")).toBe(
      "better-auth.session_token=tok_session; better-auth.csrf_token=tok_csrf",
    );
    expect(headers.get("x-workspace-id")).toBe("ws_1");
    expect(calls[0]?.init?.cache).toBe("no-store");
  });

  it("sends the JSON body, method and Idempotency-Key for mutations", async () => {
    const { calls } = stubFetch(() => Promise.resolve(okData(null, 201)));
    await gatewayCall("/v1/projects", {
      method: "POST",
      workspaceId: "ws_1",
      idempotencyKey: "idem-post-0001",
      body: { name: "Launch film" },
    });
    expect(calls[0]?.init?.method).toBe("POST");
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("Idempotency-Key")).toBe("idem-post-0001");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ name: "Launch film" });
  });

  it("throws a typed GatewayHttpError for an Err envelope", async () => {
    stubFetch(() =>
      Promise.resolve(
        errEnvelope(409, {
          code: "PROJECT_VERSION_CONFLICT",
          message: "The project changed while you were editing",
          hint: "Reload the latest version.",
        }),
      ),
    );
    const error = await gatewayCall("/v1/projects/prj_1/versions").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayHttpError);
    const httpError = error as GatewayHttpError;
    expect(httpError.status).toBe(409);
    expect(httpError.code).toBe("PROJECT_VERSION_CONFLICT");
    expect(httpError.hint).toBe("Reload the latest version.");
    expect(httpError.requestId).toBe("req_test_0000000000000000000000");
  });

  it("treats 404 and NOT_FOUND as the cross-tenant 404 semantics (hard rule 3)", async () => {
    stubFetch(() =>
      Promise.resolve(errEnvelope(404, { code: "NOT_FOUND", message: "Not found." })),
    );
    const error = await gatewayCall("/v1/projects/prj_gone/manifest", {
      workspaceId: "ws_1",
    }).catch((e: unknown) => e);
    expect(isGatewayNotFound(error)).toBe(true);
  });

  it("sanitizes non-envelope bodies — raw text never surfaces", async () => {
    stubFetch(() =>
      Promise.resolve(new Response("Internal error at /etc/secret", { status: 500 })),
    );
    const error = await gatewayCall("/v1/projects").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayHttpError);
    const httpError = error as GatewayHttpError;
    expect(httpError.code).toBe("MALFORMED_RESPONSE");
    expect(httpError.message).not.toContain("/etc/secret");
    expect(httpError.message).not.toContain("Internal error");
  });

  it("maps an empty 401 body to the UNAUTHORIZED sanitized error", async () => {
    stubFetch(() => Promise.resolve(new Response("", { status: 401 })));
    const error = await gatewayCall("/v1/me").catch((e: unknown) => e);
    const httpError = error as GatewayHttpError;
    expect(httpError.code).toBe("UNAUTHORIZED");
    expect(httpError.message).toBe("Your session may have expired.");
  });

  it("rejects paths outside /v1 with a developer error", async () => {
    await expect(gatewayCall("/nope")).rejects.toThrow(/must be the full \/v1 route/);
  });
});
