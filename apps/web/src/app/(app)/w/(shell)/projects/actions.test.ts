/**
 * `loadProjectsPage` tests (W2-B3) — the retired-workaround seam.
 *
 * The action must serve browser list pages through `@studio/api-client`'s
 * `projects.list` (no more hand-built query strings): the W1-c `archived`
 * param (§9.1) and cursor continuations reach the gateway URL, the session
 * cookie + `x-workspace-id` ride the headers, and every failure lands in the
 * typed `ok: false` arm — never a throw (server actions serialize thrown
 * errors down to `message`, losing code/hint/request id).
 *
 * `next/headers` is mocked (RSC cookies) and `fetch` is stubbed — no network
 * (the lib/gateway.test.ts pattern; the api-client's own suites cover its
 * envelope unwrap + retry machinery).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadProjectsPage } from "./actions";

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [
      { name: "better-auth.session_token", value: "tok_session" },
      { name: "better-auth.csrf_token", value: "tok_csrf" },
    ],
  }),
}));

const BASE = "http://127.0.0.1:8787";

interface RecordedCall {
  readonly input: string;
  readonly init: RequestInit | undefined;
}

const calls: RecordedCall[] = [];

beforeEach(() => {
  calls.length = 0;
  vi.restoreAllMocks();
  vi.stubEnv("GATEWAY_INTERNAL_URL", BASE);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function stubFetch(handler: (input: string, init?: RequestInit) => Promise<Response>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ input: url, init });
      return handler(url, init);
    }),
  );
}

/** §7.3 Ok envelope around one `GET /v1/projects` page payload. */
function okPage(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** §7.3 Err envelope (the wire failure arm). */
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
    { status, headers: { "content-type": "application/json" } },
  );
}

/** One schema-valid §7.2 `Project` row (the api-client validates the page). */
function wireProject(id: string, name: string, archived = false) {
  return {
    id,
    workspaceId: "ws_first",
    name,
    slug: name.toLowerCase().replace(/\s+/g, "-"),
    thumbnailUrl: null,
    archived,
    currentVersionId: null,
    createdBy: "user_me",
    createdAt: "2026-10-01T09:00:00Z",
    updatedAt: "2026-10-20T09:00:00Z",
    deletedAt: null,
  };
}

describe("loadProjectsPage (W2-B3 — api-client-backed action)", () => {
  it("serves the archived window through projects.list with session + workspace headers", async () => {
    stubFetch(() =>
      Promise.resolve(
        okPage({ items: [wireProject("prj_old", "Archived cut", true)], nextCursor: null }),
      ),
    );
    const result = await loadProjectsPage("ws_first", { archived: true });

    // The retired workaround's whole point: `archived=true` must reach the wire.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(`${BASE}/v1/projects?limit=50&archived=true`);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("cookie")).toBe(
      "better-auth.session_token=tok_session; better-auth.csrf_token=tok_csrf",
    );
    expect(headers.get("x-workspace-id")).toBe("ws_first");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.id).toBe("prj_old");
      expect(result.items[0]?.archived).toBe(true);
      expect(result.nextCursor).toBeNull();
    }
  });

  it("keeps cursor continuations window-consistent (cursor + archived + limit)", async () => {
    stubFetch(() => Promise.resolve(okPage({ items: [], nextCursor: "cur_3" })));
    const result = await loadProjectsPage("ws_first", {
      archived: true,
      cursor: "cur_2",
      limit: 25,
    });

    expect(calls[0]?.input).toBe(`${BASE}/v1/projects?cursor=cur_2&limit=25&archived=true`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.nextCursor).toBe("cur_3");
  });

  it("defaults to the unarchived window (limit 50, no archived param)", async () => {
    stubFetch(() => Promise.resolve(okPage({ items: [], nextCursor: null })));
    await loadProjectsPage("ws_first");

    expect(calls[0]?.input).toBe(`${BASE}/v1/projects?limit=50`);
  });

  it("maps a §7.3 Err envelope into the typed error arm (never throws)", async () => {
    stubFetch(() =>
      Promise.resolve(
        errEnvelope(404, {
          code: "WORKSPACE_NOT_FOUND",
          message: "Not found.",
          hint: "Check the link, or refresh the list.",
        }),
      ),
    );
    const result = await loadProjectsPage("ws_gone");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("Not found.");
      expect(result.error.hint).toBe("Check the link, or refresh the list.");
      expect(result.error.requestId).toBe("req_test_0000000000000000000000");
    }
  });

  it("degrades a malformed page payload to the honest typed failure", async () => {
    // A row the §7.2 schema rejects → the api-client raises
    // MALFORMED_RESPONSE; the action surfaces its safe §7.3-style message
    // instead of crashing the browser call.
    stubFetch(() =>
      Promise.resolve(okPage({ items: [{ id: "prj_broken", name: 42 }], nextCursor: null })),
    );
    const result = await loadProjectsPage("ws_first");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("The server returned a malformed response.");
      expect(result.error.hint).toBe("Try again in a moment.");
      expect(result.error.requestId).toBeDefined();
    }
  });
});
