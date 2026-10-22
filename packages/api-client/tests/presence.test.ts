// @studio/api-client — presence (BUILD_PLAN §M7 task 2; PRODUCT_ARCHITECTURE.md
// §11): heartbeat + viewers poll over the typed client. Pins the wire paths,
// the strict no-cursor body scope at the client seam, response validation
// (contracts PRESENCE_VIEWERS_SCHEMA) and the heartbeat semantics the editor
// SPA implements (beat = upsert + poll in one round-trip; no SSE in v1).

import { describe, expect, it } from "vitest";

import { PRESENCE_TTL_MS, type PresenceBeatRequest } from "@studio/contracts";

import type { ApiError } from "../src/api-error";
import { isApiError } from "../src/api-error";
import { createApiClient } from "../src/client";
import { jsonOk } from "./helpers";

const BASE = "https://api.studio.test/v1";

function makeClient(handler: (input: string, init?: RequestInit) => Promise<Response>) {
  const calls: { input: string; init?: RequestInit }[] = [];
  const fetch = async (input: string, init?: RequestInit) => {
    calls.push({ input, init });
    return handler(input, init);
  };
  return { calls, client: createApiClient({ baseUrl: BASE, fetch }) };
}

function idempotencyKeyOf(call: { init?: RequestInit }): string | null {
  const headers = call.init?.headers;
  if (headers === undefined) return null;
  if (headers instanceof Headers) return headers.get("idempotency-key");
  const record = headers as Record<string, string>;
  return record["Idempotency-Key"] ?? record["idempotency-key"] ?? null;
}

const OWNER_VIEWER = {
  userId: "usr_owner",
  displayName: "Maya",
  compId: "comp_intro_01",
  playheadTicks: 123,
  lastSeenAgoMs: 0,
  self: true,
};

const OTHER_VIEWER = {
  userId: "usr_other",
  displayName: "Dana",
  compId: null,
  playheadTicks: null,
  lastSeenAgoMs: 45_000,
  self: false,
};

const VIEWERS = { viewers: [OWNER_VIEWER, OTHER_VIEWER] };

describe("createApiClient — presence (heartbeat IS the poll)", () => {
  it("beatPresence posts the strict body and parses the viewers response", async () => {
    const { calls, client } = makeClient(() => Promise.resolve(jsonOk(VIEWERS)));
    const result = await client.presence.beatPresence("prj_1", {
      compId: "comp_intro_01",
      playheadTicks: 123,
      clientNonce: "tab-1-beat-0001",
    });
    expect(calls).toHaveLength(1);
    const { input, init } = calls[0] as { input: string; init: RequestInit };
    expect(input).toBe(`${BASE}/projects/prj_1/presence`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      compId: "comp_intro_01",
      playheadTicks: 123,
      clientNonce: "tab-1-beat-0001",
    });
    // Mutations always carry an Idempotency-Key (§7.2).
    expect(idempotencyKeyOf(calls[0] as { init?: RequestInit })).toBeTruthy();
    expect(result.viewers).toHaveLength(2);
    expect(result.viewers[0]).toEqual(OWNER_VIEWER);
    expect(result.viewers[1]?.self).toBe(false);
    expect(result.viewers[1]?.lastSeenAgoMs).toBe(45_000);
  });

  it("beatPresence with no body sends a bare heartbeat {}", async () => {
    const { calls, client } = makeClient(() => Promise.resolve(jsonOk(VIEWERS)));
    const result = await client.presence.beatPresence("prj_1");
    expect(JSON.parse(String((calls[0] as { init: RequestInit }).init.body))).toEqual({});
    expect(result.viewers).toHaveLength(2);
  });

  it("listPresence GETs the viewers list without an idempotency key", async () => {
    const { calls, client } = makeClient(() => Promise.resolve(jsonOk(VIEWERS)));
    const result = await client.presence.listPresence("prj_1");
    expect(calls[0]?.input).toBe(`${BASE}/projects/prj_1/presence`);
    expect((calls[0] as { init?: RequestInit }).init?.method).toBe("GET");
    expect(idempotencyKeyOf(calls[0] as { init?: RequestInit })).toBeNull();
    expect(result.viewers[0]?.displayName).toBe("Maya");
  });

  it("response validation strips unknown keys on viewer entries (§7.2 forward compat)", async () => {
    const { client } = makeClient(() =>
      Promise.resolve(
        jsonOk({
          viewers: [{ ...OWNER_VIEWER, cursorX: 0.5, cursorY: 0.25, extra: "drop" }],
        }),
      ),
    );
    const result = await client.presence.beatPresence("prj_1");
    expect(result.viewers).toHaveLength(1);
    // toStrictEqual is deep-strict: any cursor/extra key that survived would fail.
    expect(result.viewers[0]).toStrictEqual(OWNER_VIEWER);
  });

  it("rejects a malformed viewer entry as MALFORMED_RESPONSE (typed validation)", async () => {
    const { client } = makeClient(() =>
      Promise.resolve(jsonOk({ viewers: [{ userId: "usr_owner", displayName: "Maya" }] })),
    );
    const error = await client.presence
      .beatPresence("prj_1")
      .then(() => null)
      .catch((e: unknown) => e);
    expect(isApiError(error)).toBe(true);
    expect((error as ApiError).code).toBe("MALFORMED_RESPONSE");
  });

  it("STRICT BODY (scope pin): cursor/mouse fields never leave the client", async () => {
    const { calls, client } = makeClient(() => Promise.resolve(jsonOk(VIEWERS)));
    // Deliberately smuggled past the COMPILE-TIME type to prove the runtime
    // strictObject pin — a rogue field must fail VALIDATION_FAILED pre-fetch.
    const cursorPayload = { cursorX: 0.5, cursorY: 0.5 } as unknown as PresenceBeatRequest;
    const bad = await client.presence
      .beatPresence("prj_1", cursorPayload)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(isApiError(bad)).toBe(true);
    expect((bad as ApiError).code).toBe("VALIDATION_FAILED");
    // Nothing was sent — the co-editing telemetry never reaches the wire.
    expect(calls).toHaveLength(0);
  });

  it("STRICT BODY: unknown keys of any name are rejected client-side", async () => {
    const { calls, client } = makeClient(() => Promise.resolve(jsonOk(VIEWERS)));
    const roguePayload = {
      selection: ["layer_1"],
      mouse: { x: 1 },
    } as unknown as PresenceBeatRequest;
    const bad = await client.presence
      .beatPresence("prj_1", roguePayload)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(isApiError(bad)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("bounds: playhead > 36_000_000 and compId > 120 chars are rejected before sending", async () => {
    const { calls, client } = makeClient(() => Promise.resolve(jsonOk(VIEWERS)));
    const overTicks = await client.presence
      .beatPresence("prj_1", { playheadTicks: 36_000_001 })
      .then(() => null)
      .catch((e: unknown) => e);
    const longComp = await client.presence
      .beatPresence("prj_1", { compId: "c".repeat(121) })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(isApiError(overTicks)).toBe(true);
    expect(isApiError(longComp)).toBe(true);
    expect(calls).toHaveLength(0);
    // The boundary values themselves are valid…
    const { client: okClient } = makeClient(() => Promise.resolve(jsonOk(VIEWERS)));
    await okClient.presence.beatPresence("prj_1", { playheadTicks: 36_000_000 });
    await okClient.presence.beatPresence("prj_1", { compId: "c".repeat(120) });
  });

  it("a 429 RATE_LIMITED beat surfaces as a retryable ApiError", async () => {
    const limited = new Response(
      JSON.stringify({
        error: {
          code: "RATE_LIMITED",
          message: "Too many requests.",
          retryable: true,
          requestId: "req_presence_1",
        },
      }),
      { status: 429, headers: { "content-type": "application/json" } },
    );
    const { calls, client } = makeClient(() => Promise.resolve(limited));
    const error = await client.presence
      .beatPresence("prj_1")
      .then(() => null)
      .catch((e: unknown) => e);
    expect(isApiError(error)).toBe(true);
    const apiError = error as ApiError;
    expect(apiError.code).toBe("RATE_LIMITED");
    expect(apiError.retryable).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it("PRESENCE_TTL_MS is exported for the web (2 × LEASE_HEARTBEAT_MS = 4 minutes)", () => {
    // The sweep horizon the client renders "last seen" states against: two
    // missed 2-minute heartbeats and a viewer is swept server-side.
    expect(PRESENCE_TTL_MS).toBe(240_000);
  });
});
