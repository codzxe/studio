import { describe, expect, it } from "vitest";

import { type ApiError, isApiError } from "../src/api-error";
import { createApiClient } from "../src/client";
import { type RecordedCall, jsonErr, jsonOk, textResponse } from "./helpers";

function header(call: RecordedCall, name: string): string | null {
  if (call.init?.headers === undefined) return null;
  if (call.init.headers instanceof Headers) return call.init.headers.get(name);
  const record = call.init.headers as Record<string, string>;
  return record[name] ?? null;
}

const BASE = "https://api.studio.test/v1";

// A §7.2-valid `GET /me` payload — /me responses are schema-validated, so
// tests that await `me.get()` must feed it a real MeResponse (the
// MALFORMED_RESPONSE tests pin the validation itself).
const ME = {
  user: { id: "usr_1", name: null, email: "maya@example.com" },
  memberships: [],
  plan: { plan: "pro", creditsBalance: 3200, includedCredits: 2500, renewsAt: null },
};

function makeClient(handler: (input: string, init?: RequestInit) => Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fetch = async (input: string, init?: RequestInit) => {
    calls.push({ input, init });
    return handler(input, init);
  };
  return { calls, fetch, client: createApiClient({ baseUrl: BASE, fetch }) };
}

describe("createApiClient — envelope unwrap", () => {
  it("returns Ok.data and strips unknown keys via the response schema", async () => {
    const me = {
      user: { id: "usr_1", name: "Maya", email: "maya@example.com", sneaky: "drop me" },
      memberships: [],
      plan: { plan: "pro", creditsBalance: 3200, includedCredits: 2500, renewsAt: null },
      extra: "dropped",
    };
    const { client } = makeClient(() => Promise.resolve(jsonOk(me)));
    const result = await client.me.get();
    expect(result.user.name).toBe("Maya");
    expect("sneaky" in result.user).toBe(false);
    expect("extra" in result).toBe(false);
  });

  it("throws a typed ApiError for an Err envelope", async () => {
    const { client } = makeClient(() =>
      Promise.resolve(
        jsonErr(409, {
          code: "PROJECT_VERSION_CONFLICT",
          message: "This project changed while you were working.",
          hint: "Open the latest version.",
          retryable: false,
          requestId: "req_wire_9",
        }),
      ),
    );
    const error = await client.projects.get("prj_1").catch((e: unknown) => e);
    expect(isApiError(error)).toBe(true);
    const apiError = error as ApiError;
    expect(apiError.code).toBe("PROJECT_VERSION_CONFLICT");
    expect(apiError.message).toBe("This project changed while you were working.");
    expect(apiError.hint).toBe("Open the latest version.");
    expect(apiError.retryable).toBe(false);
    expect(apiError.requestId).toBe("req_wire_9");
    expect(apiError.status).toBe(409);
  });

  it("treats a 2xx body carrying an Err envelope as a failure (§7.3 decides)", async () => {
    const { client } = makeClient(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              code: "INSUFFICIENT_CREDITS",
              message: "out of credits",
              retryable: false,
              requestId: "req_x",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    await expectAsyncFail(client.credits.get(), (error) => {
      expect(error.code).toBe("INSUFFICIENT_CREDITS");
      expect(error.status).toBe(200);
    });
  });

  it("throws MALFORMED_RESPONSE for a 200 without an envelope", async () => {
    const { client } = makeClient(() =>
      Promise.resolve(textResponse(200, JSON.stringify({ hello: 1 }), "application/json")),
    );
    await expectAsyncFail(client.me.get(), (error) => {
      expect(error.code).toBe("MALFORMED_RESPONSE");
      expect(error.status).toBe(200);
      expect(error.retryable).toBe(true);
    });
  });

  it("throws MALFORMED_RESPONSE when envelope data fails schema validation", async () => {
    const { client } = makeClient(() =>
      Promise.resolve(jsonOk({ user: { id: "u", name: null, email: "x" } })),
    );
    await expectAsyncFail(client.me.get(), (error) => {
      expect(error.code).toBe("MALFORMED_RESPONSE");
    });
  });

  it("returns null for an empty 2xx body on void mutations (soft delete)", async () => {
    const { client, calls } = makeClient(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    const result = await client.projects.delete("prj_1");
    expect(result).toBeNull();
    expect(calls[0]?.input).toBe(`${BASE}/projects/prj_1`);
    expect(calls[0]?.init?.method).toBe("DELETE");
  });
});

describe("createApiClient — idempotency keys (§7.2)", () => {
  it("auto-derives an Idempotency-Key on mutations", async () => {
    const { client, calls } = makeClient(() =>
      Promise.resolve(
        jsonOk({
          id: "wsp_1",
          name: "N",
          slug: "n",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        }),
      ),
    );
    await client.workspaces.create({ name: "Northlight Motion", slug: "northlight-motion" });
    const key = header(calls[0] ?? ({} as RecordedCall), "Idempotency-Key");
    expect(key).not.toBeNull();
    expect(key?.length).toBeGreaterThanOrEqual(8);
    // A second call derives a fresh key.
    await client.workspaces.create({ name: "Two", slug: "two" });
    const second = header(calls[1] ?? ({} as RecordedCall), "Idempotency-Key");
    expect(second).not.toBe(key);
  });

  it("uses the caller's explicit key and rejects short ones client-side", async () => {
    const { client, calls } = makeClient(() =>
      Promise.resolve(
        jsonOk({
          id: "thr_1",
          projectId: "p",
          title: null,
          createdBy: "u",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        }),
      ),
    );
    await client.threads.create("prj_1", {}, { idempotencyKey: "idem-explicit-0001" });
    expect(header(calls[0] ?? ({} as RecordedCall), "Idempotency-Key")).toBe("idem-explicit-0001");

    await expectAsyncFail(
      client.threads.create("prj_1", {}, { idempotencyKey: "short" }),
      (error) => {
        expect(error.code).toBe("VALIDATION_FAILED");
        expect(error.status).toBe(0); // client-side: never sent
      },
    );
    expect(calls).toHaveLength(1);
  });

  it("never sends Idempotency-Key on GETs", async () => {
    const { client, calls } = makeClient(() =>
      Promise.resolve(jsonOk({ items: [], nextCursor: null })),
    );
    await client.projects.list({ limit: 10 });
    expect(header(calls[0] ?? ({} as RecordedCall), "Idempotency-Key")).toBeNull();
  });
});

describe("createApiClient — query params", () => {
  it("serializes cursor/limit and skips undefined", async () => {
    const { client, calls } = makeClient(() =>
      Promise.resolve(jsonOk({ items: [], nextCursor: null })),
    );
    await client.projects.list({ cursor: "cur_abc", limit: 7 });
    expect(calls[0]?.input).toBe(`${BASE}/projects?cursor=cur_abc&limit=7`);
  });

  it("defaults limit to 50 (§7.2 pagination)", async () => {
    const { client, calls } = makeClient(() =>
      Promise.resolve(jsonOk({ items: [], nextCursor: null })),
    );
    await client.workspaces.list();
    expect(calls[0]?.input).toBe(`${BASE}/workspaces?limit=50`);
  });

  it("passes route filters through (comments compId/resolved)", async () => {
    const { client, calls } = makeClient(() =>
      Promise.resolve(jsonOk({ items: [], nextCursor: null })),
    );
    await client.comments.list("prj_1", { compId: "cmp_main", resolved: false });
    const url = calls[0]?.input ?? "";
    expect(url).toContain("compId=cmp_main");
    expect(url).toContain("resolved=false");
    expect(url).toContain("limit=50");
  });

  it("rejects limit > 100 client-side (contracts bound)", async () => {
    const { client, calls } = makeClient(() =>
      Promise.resolve(jsonOk({ items: [], nextCursor: null })),
    );
    await expectAsyncFail(client.projects.list({ limit: 101 }), (error) => {
      expect(error.code).toBe("VALIDATION_FAILED");
    });
    expect(calls).toHaveLength(0);
  });
});

describe("createApiClient — request bodies", () => {
  it("validates bodies client-side with the contracts schemas", async () => {
    const { client, calls } = makeClient(() => Promise.resolve(jsonOk({})));
    await expectAsyncFail(
      client.workspaces.create({ name: "x", slug: "NOT-URL-SAFE" } as never),
      (error) => {
        expect(error.code).toBe("VALIDATION_FAILED");
        expect(error.status).toBe(0);
      },
    );
    expect(calls).toHaveLength(0);
  });

  it("refines still run client-side (patch needs at least one field)", async () => {
    const { client, calls } = makeClient(() => Promise.resolve(jsonOk({})));
    await expectAsyncFail(client.projects.patch("prj_1", {}), (error) => {
      expect(error.code).toBe("VALIDATION_FAILED");
    });
    expect(calls).toHaveLength(0);
  });

  it("serializes the validated body as JSON with content-type", async () => {
    const { client, calls } = makeClient(() =>
      Promise.resolve(
        jsonOk({
          id: "p",
          workspaceId: "w",
          name: "n",
          slug: "s",
          thumbnailUrl: null,
          // W1-c (§9.1 lifecycle): `archived` is a required wire field now.
          archived: false,
          currentVersionId: null,
          createdBy: "u",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          deletedAt: null,
        }),
      ),
    );
    await client.projects.create({ name: "Launch film", description: "Q4 launch" });
    const call = calls[0];
    expect(call?.input).toBe(`${BASE}/projects`);
    expect(header(call ?? ({} as RecordedCall), "Content-Type")).toBe("application/json");
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      name: "Launch film",
      description: "Q4 launch",
    });
  });

  it("runs.postEvent enforces the apply.result sha256/errorCode refine", async () => {
    const { client, calls } = makeClient(() => Promise.resolve(jsonOk(null)));
    await expectAsyncFail(
      client.runs.postEvent("run_1", { type: "apply.result", ok: true }),
      (error) => expect(error.code).toBe("VALIDATION_FAILED"),
    );
    expect(calls).toHaveLength(0);

    await client.runs.postEvent("run_1", {
      type: "apply.result",
      ok: true,
      sha256: "a".repeat(64),
    });
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body.sha256).toBe("a".repeat(64));
  });
});

describe("createApiClient — abortSignal", () => {
  it("forwards the signal to fetch", async () => {
    const controller = new AbortController();
    const { client, calls } = makeClient(() => Promise.resolve(jsonOk(ME)));
    await client.me.get({ signal: controller.signal });
    expect(calls[0]?.init?.signal).toBe(controller.signal);
  });

  it("propagates abort errors unwrapped (never an ApiError)", async () => {
    const controller = new AbortController();
    const { client } = makeClient(() => {
      controller.abort();
      return Promise.reject(controller.signal.reason);
    });
    const error = await client.me.get({ signal: controller.signal }).catch((e: unknown) => e);
    expect(isApiError(error)).toBe(false);
    expect((error as Error).name).toBe("AbortError");
  });
});

describe("createApiClient — extra headers + paths", () => {
  it("merges option headers into every request", async () => {
    const calls: RecordedCall[] = [];
    const client = createApiClient({
      baseUrl: BASE,
      headers: { Authorization: "Bearer demo" },
      fetch: async (input, init) => {
        calls.push({ input, init });
        return jsonOk({ items: [], nextCursor: null });
      },
    });
    await client.assets.list();
    expect(header(calls[0] ?? ({} as RecordedCall), "Authorization")).toBe("Bearer demo");
  });

  it("encodes path ids", async () => {
    const { client, calls } = makeClient(() =>
      Promise.resolve(jsonOk({ url: "https://x", expiresAt: "2026-01-01T00:00:00Z" })),
    );
    await client.assets.getUrl("ast/1");
    expect(calls[0]?.input).toBe(`${BASE}/assets/ast%2F1/url`);
  });

  it("trims a trailing slash from baseUrl", async () => {
    const { client, calls } = makeClient(() =>
      Promise.resolve(jsonOk({ items: [], nextCursor: null })),
    );
    const trailing = createApiClient({
      baseUrl: `${BASE}/`,
      fetch: async (input, init) => {
        calls.push({ input, init });
        return jsonOk(ME);
      },
    });
    await trailing.me.get();
    expect(calls[0]?.input).toBe(`${BASE}/me`);
    await client.workspaces.list();
    expect(calls[1]?.input).toBe(`${BASE}/workspaces?limit=50`);
  });
});

describe("createApiClient — versions.upload (two-phase)", () => {
  const versionRow = {
    id: "ver_9",
    projectId: "prj_1",
    version: 5,
    parentVersionId: "ver_4",
    sha256: "b".repeat(64),
    sizeBytes: 4,
    label: "agent run",
    agentRunId: null,
    createdBy: "usr_1",
    createdAt: "2026-01-01T00:00:00Z",
  };

  it("POSTs the descriptor then PUTs the bytes to the signed URL", async () => {
    const { client, calls } = makeClient(async (input) => {
      if (input === `${BASE}/projects/prj_1/versions`) {
        return jsonOk({
          version: versionRow,
          upload: {
            url: "https://cdn.studio.test/signed?token=x",
            method: "PUT",
            expiresAt: "2026-01-01T00:05:00Z",
            headers: { "x-amz-server-side-encryption": "AES256" },
          },
        });
      }
      return new Response(null, { status: 200 });
    });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const version = await client.versions.upload(
      "prj_1",
      { baseVersionId: "ver_4", sha256: "b".repeat(64), label: "agent run", bytes },
      { idempotencyKey: "idem-upload-0001" },
    );
    expect(version.id).toBe("ver_9");
    const post = calls[0];
    expect(post?.init?.method).toBe("POST");
    expect(header(post ?? ({} as RecordedCall), "Idempotency-Key")).toBe("idem-upload-0001");
    const descriptor = JSON.parse(String(post?.init?.body)) as Record<string, unknown>;
    expect(descriptor.sizeBytes).toBe(4); // computed from the bytes
    expect(descriptor.baseVersionId).toBe("ver_4");

    const put = calls[1];
    expect(put?.input).toBe("https://cdn.studio.test/signed?token=x");
    expect(put?.init?.method).toBe("PUT");
    expect(put?.init?.body).toBe(bytes);
    expect(header(put ?? ({} as RecordedCall), "x-amz-server-side-encryption")).toBe("AES256");
  });

  it("computes sizeBytes from a Blob", async () => {
    const { client, calls } = makeClient(async (input) => {
      if (input === `${BASE}/projects/prj_1/versions`) {
        return jsonOk({
          version: versionRow,
          upload: {
            url: "https://cdn.studio.test/blob",
            method: "PUT",
            expiresAt: "2026-01-01T00:05:00Z",
            headers: {},
          },
        });
      }
      return new Response(null, { status: 200 });
    });
    const blob = new Blob(["12345678"], { type: "application/octet-stream" });
    await client.versions.upload("prj_1", {
      baseVersionId: "ver_4",
      sha256: "b".repeat(64),
      bytes: blob,
    });
    const descriptor = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(descriptor.sizeBytes).toBe(8);
    expect(calls[1]?.init?.body).toBe(blob);
  });

  it("throws UPLOAD_FAILED when the signed PUT fails", async () => {
    const { client } = makeClient(async (input) => {
      if (input === `${BASE}/projects/prj_1/versions`) {
        return jsonOk({
          version: versionRow,
          upload: {
            url: "https://cdn.studio.test/fail",
            method: "PUT",
            expiresAt: "2026-01-01T00:05:00Z",
            headers: {},
          },
        });
      }
      return new Response("Forbidden", { status: 403 });
    });
    await expectAsyncFail(
      client.versions.upload("prj_1", {
        baseVersionId: "ver_4",
        sha256: "b".repeat(64),
        bytes: new Uint8Array([9]),
      }),
      (error) => {
        expect(error.code).toBe("UPLOAD_FAILED");
        expect(error.retryable).toBe(true);
      },
    );
  });

  it("rejects non-Blob/non-Uint8Array bytes before sending", async () => {
    const { client, calls } = makeClient(() => Promise.resolve(jsonOk(null)));
    await expectAsyncFail(
      client.versions.upload("prj_1", {
        baseVersionId: "v",
        sha256: "b".repeat(64),
        bytes: "not bytes" as never,
      }),
      (error) => expect(error.code).toBe("VALIDATION_FAILED"),
    );
    expect(calls).toHaveLength(0);
  });
});

describe("createApiClient — surface map", () => {
  it("hits the documented §7.2 paths for every namespace", async () => {
    const { client, calls } = makeClient(() => Promise.resolve(jsonOk(null)));
    // Rejections here are schema-validation noise (Ok<null>); paths are what
    // matters, and every call is recorded before its response is unwrapped.
    const ignore = (promise: Promise<unknown>): Promise<void> =>
      promise.then(
        () => undefined,
        () => undefined,
      );
    const recorder = client;
    // A Response body is single-use: every paginated GET needs a FRESH page
    // response (a reused one rejects on the second read as a network error,
    // and the GET retry backoff — real sleeps, no injected seam here — burns
    // seconds per call). okFetch records into the same call log so the
    // paginated paths appear in await order.
    const okFetch = async (input: string, init?: RequestInit): Promise<Response> => {
      calls.push({ input, init });
      return jsonOk({ items: [], nextCursor: null });
    };
    const paginated = createApiClient({ baseUrl: BASE, fetch: okFetch });

    await ignore(recorder.me.get());
    await ignore(paginated.workspaces.list());
    await ignore(recorder.workspaces.patch("w1", { name: "New" }));
    await ignore(recorder.invites.create("w1", { email: "a@b.example", role: "editor" }));
    await ignore(recorder.invites.accept("tok_123"));
    await ignore(paginated.projects.list());
    await ignore(recorder.projects.get("p1"));
    await ignore(recorder.projects.patch("p1", { description: "d" }));
    await ignore(recorder.projects.delete("p1"));
    await ignore(recorder.projects.manifest("p1"));
    await ignore(paginated.versions.list("p1"));
    await ignore(recorder.versions.restore("p1", "ver_1", { confirmLabel: "v1" }));
    await ignore(recorder.versions.label("p1", "ver_1", { label: "shipped cut" }));
    await ignore(recorder.versions.diff("p1", "ver_1"));
    await ignore(recorder.leases.acquire("p1", { sessionId: "sess_12345678" }));
    await ignore(recorder.leases.release("p1"));
    await ignore(paginated.assets.list());
    await ignore(
      recorder.assets.createDescriptor({
        name: "a.png",
        mime: "image/png",
        sizeBytes: 10,
        sha256: "c".repeat(64),
        width: 10,
        height: 10,
      }),
    );
    await ignore(recorder.assets.getUrl("ast_1"));
    await ignore(paginated.threads.list("p1"));
    await ignore(recorder.threads.create("p1", { title: "t" }));
    await ignore(paginated.threads.messages("thr_1"));
    await ignore(recorder.runs.get("run_1"));
    await ignore(recorder.runs.cancel("run_1", { reason: "stop" }));
    await ignore(
      recorder.runs.postEvent("run_1", { type: "tool.result", toolCallId: "tc_1", result: 1 }),
    );
    await ignore(recorder.credits.get());
    await ignore(paginated.credits.ledger());
    await ignore(recorder.billing.checkout({ planId: "pro" }));
    await ignore(recorder.billing.portal({ returnUrl: "https://app/studio.example.com" }));
    await ignore(paginated.billing.invoices());
    await ignore(
      recorder.renders.create({
        projectId: "p1",
        compId: "cmp_1",
        format: "mp4",
        settings: { width: 1920, height: 1080 },
        idempotencyKey: "idem-render-0001",
      }),
    );
    await ignore(recorder.renders.get("rnd_1"));
    await ignore(paginated.renders.list());
    await ignore(recorder.renders.cancel("rnd_1"));
    await ignore(
      recorder.renders.estimate({
        projectId: "p1",
        compId: "cmp_1",
        format: "mp4",
        settings: { width: 1920, height: 1080 },
      }),
    );
    await ignore(paginated.comments.list("p1"));
    await ignore(paginated.comments.listThreadedComments("p1"));
    await ignore(recorder.comments.create("p1", { compId: "cmp_1", body: "note" }));
    await ignore(recorder.comments.replyComment("cmt_1", { body: "reply note" }));
    await ignore(recorder.comments.resolveComment("cmt_1"));
    await ignore(paginated.activity.list("p1"));
    await ignore(recorder.activity.auditExport("p1"));

    const paths = calls.map((call) => call.input.replace(BASE, "").split("?")[0]);
    expect(paths).toEqual([
      "/me",
      "/workspaces",
      "/workspaces/w1",
      "/workspaces/w1/invites",
      "/invites/tok_123/accept",
      "/projects",
      "/projects/p1",
      "/projects/p1",
      "/projects/p1",
      "/projects/p1/manifest",
      "/projects/p1/versions",
      "/projects/p1/versions/ver_1/restore",
      "/projects/p1/versions/ver_1/label",
      "/projects/p1/versions/ver_1/diff",
      "/projects/p1/lease",
      "/projects/p1/lease",
      "/assets",
      "/assets",
      "/assets/ast_1/url",
      "/projects/p1/threads",
      "/projects/p1/threads",
      "/threads/thr_1/messages",
      "/runs/run_1",
      "/runs/run_1/cancel",
      "/runs/run_1/events",
      "/credits",
      "/credits/ledger",
      "/billing/checkout",
      "/billing/portal",
      "/billing/invoices",
      "/renders",
      "/renders/rnd_1",
      "/renders",
      "/renders/rnd_1/cancel",
      "/renders/estimate",
      "/projects/p1/comments",
      "/projects/p1/comments",
      "/projects/p1/comments",
      "/comments/cmt_1/replies",
      "/comments/cmt_1/resolve",
      "/projects/p1/activity",
      "/projects/p1/audit-export",
    ]);
  });
});

// F-J3 wire: GET /v1/billing/invoices — recorded Stripe invoices, money in
// Stripe minor units (cents), never credits (the credit ledger is its own
// D-12 microcredit domain).
describe("createApiClient — billing.invoices (F-J3)", () => {
  it("GETs /billing/invoices, serializes the cursor, and parses the page", async () => {
    const { client, calls } = makeClient(() =>
      Promise.resolve(
        jsonOk({
          items: [
            {
              id: "inv_1",
              stripeInvoiceId: "in_stripe_1",
              amountCents: 1200,
              currency: "usd",
              status: "paid",
              periodStart: "2026-10-01T00:00:00.000Z",
              periodEnd: "2026-10-31T23:59:59.000Z",
              hostedUrl: "https://stripe.test/i",
              pdfUrl: "https://stripe.test/i.pdf",
              createdAt: "2026-10-31T23:59:59.000Z",
              organizationId: "ws_1", // not on the wire shape — schema-stripped
            },
          ],
          nextCursor: "cur_2",
        }),
      ),
    );
    const result = await client.billing.invoices({ cursor: "cur_1", limit: 25 });
    expect(calls[0]?.input).toBe(`${BASE}/billing/invoices?cursor=cur_1&limit=25`);
    const firstCall = calls[0];
    if (firstCall === undefined) throw new Error("no recorded call");
    expect(header(firstCall, "idempotency-key")).toBeNull(); // GETs never carry one
    expect(result.items).toHaveLength(1);
    const invoice = result.items[0];
    if (invoice === undefined) throw new Error("no invoice row");
    expect(invoice).toMatchObject({
      id: "inv_1",
      stripeInvoiceId: "in_stripe_1",
      amountCents: 1200,
      currency: "usd",
      status: "paid",
    });
    expect("organizationId" in invoice).toBe(false);
    expect(result.nextCursor).toBe("cur_2");
  });

  it("rejects an off-vocabulary invoice status client-side (contracts bound)", async () => {
    const { client } = makeClient(() =>
      Promise.resolve(
        jsonOk({
          items: [
            {
              id: "inv_1",
              stripeInvoiceId: "in_stripe_1",
              amountCents: 1200,
              currency: "usd",
              status: "refunded", // NOT in INVOICE_STATUSES
              periodStart: null,
              periodEnd: null,
              hostedUrl: null,
              pdfUrl: null,
              createdAt: "2026-10-31T23:59:59.000Z",
            },
          ],
          nextCursor: null,
        }),
      ),
    );
    await expectAsyncFail(client.billing.invoices(), (error) => {
      expect(error.code).toBe("MALFORMED_RESPONSE");
    });
  });
});

// The §7.2 lease wire is the acquire/renew OUTCOME (gateway leases.ts):
// { acquired, holderName, expiresAt, readOnly } — NOT the §9.1 lease row.
// The M3-A editor host is the first real consumer; these pin the compat fix.
describe("createApiClient — leases (real §7.2 wire)", () => {
  it("parses a refused acquire as the read-only outcome", async () => {
    const { client, calls } = makeClient(() =>
      Promise.resolve(
        jsonOk({
          acquired: false,
          holderName: "Dana Flow",
          expiresAt: "2026-10-15T09:07:00Z",
          readOnly: true,
        }),
      ),
    );
    const lease = await client.leases.acquire("prj_1", { sessionId: "sess_12345678" });
    expect(lease).toEqual({
      acquired: false,
      holderName: "Dana Flow",
      expiresAt: "2026-10-15T09:07:00Z",
      readOnly: true,
    });
    const post = calls[0];
    expect(post?.init?.method).toBe("POST");
    expect(post?.input).toBe(`${BASE}/projects/prj_1/lease`);
    expect(header(post ?? ({} as RecordedCall), "Idempotency-Key")).toBeTruthy();
  });

  it("parses a successful acquire (renew with the same sessionId)", async () => {
    const { client } = makeClient(() =>
      Promise.resolve(
        jsonOk({
          acquired: true,
          holderName: "Maya",
          expiresAt: "2026-10-15T09:11:00Z",
          readOnly: false,
        }),
      ),
    );
    const lease = await client.leases.acquire("prj_1", { sessionId: "sess_12345678" });
    expect(lease.acquired).toBe(true);
    expect(lease.readOnly).toBe(false);
  });

  it("parses the release outcome { released }", async () => {
    const { client, calls } = makeClient(() => Promise.resolve(jsonOk({ released: true })));
    const outcome = await client.leases.release("prj_1");
    expect(outcome).toEqual({ released: true });
    const del = calls[0];
    expect(del?.init?.method).toBe("DELETE");
    expect(del?.input).toBe(`${BASE}/projects/prj_1/lease`);
  });
});

async function expectAsyncFail(
  promise: Promise<unknown>,
  assert: (error: ApiError) => void,
): Promise<void> {
  const error = await promise.then(
    () => {
      throw new Error("expected the call to reject");
    },
    (e: unknown) => e,
  );
  expect(isApiError(error)).toBe(true);
  assert(error as ApiError);
}
