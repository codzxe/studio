// trial-grant tests — step 0 (GET /v1/credits trial check) with an injectable
// fetch stub. No network: every response shape is fabricated.

import { describe, expect, it } from "vitest";
import {
  CREDITS_PATH,
  defaultCheckTrialGrant,
  extractBalance,
  type FetchLike,
} from "./trial-grant";

const response = (status: number, body?: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json:
      body === undefined
        ? async () => {
            throw new Error("no body");
          }
        : async () => body,
  }) as unknown as Response;

const stub = (status: number, body?: unknown): FetchLike => async () => response(status, body);

describe("extractBalance", () => {
  it.each([
    ["{balance}", { balance: 30 }, 30],
    ["{credits}", { credits: 12 }, 12],
    ["{data:{balance}}", { data: { balance: 3 } }, 3],
    ["{data:{credits}}", { data: { credits: 5 } }, 5],
    ["{credits:{balance}}", { credits: { balance: 9 } }, 9],
  ])("extracts a number from %s", (_name, payload, expected) => {
    expect(extractBalance(payload)).toBe(expected);
  });

  it.each([
    ["null", null],
    ["non-object", "nope"],
    ["empty object", {}],
    ["string balance", { balance: "30" }],
    ["NaN balance", { balance: Number.NaN }],
    ["Infinity balance", { balance: Number.POSITIVE_INFINITY }],
  ])("refuses to guess a balance from %s", (_name, payload) => {
    expect(extractBalance(payload)).toBeNull();
  });
});

describe("defaultCheckTrialGrant", () => {
  it("resolves ok with the balance on a healthy response", async () => {
    const result = await defaultCheckTrialGrant(stub(200, { balance: 30 }));
    expect(result).toEqual({ ok: true, balance: 30 });
  });

  it("reads nested balances too", async () => {
    const result = await defaultCheckTrialGrant(stub(200, { data: { credits: 7 } }));
    expect(result).toEqual({ ok: true, balance: 7 });
  });

  it("calls GET /v1/credits with same-origin credentials", async () => {
    let captured: { input?: unknown; init?: RequestInit } = {};
    const spy: FetchLike = async (input, init) => {
      captured = { input, init };
      return response(200, { balance: 1 });
    };
    await defaultCheckTrialGrant(spy);
    expect(captured.input).toBe(CREDITS_PATH);
    expect(captured.init?.method).toBe("GET");
    expect(captured.init?.credentials).toBe("same-origin");
  });

  it("returns a non-retryable envelope on auth failures", async () => {
    const result = await defaultCheckTrialGrant(stub(401, {}));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("credits.unauthorized");
      expect(result.retryable).toBe(false);
      expect(result.message.length).toBeGreaterThan(0);
      expect(result.hint.length).toBeGreaterThan(0);
    }
  });

  it("returns a retryable envelope when the route is missing/unimplemented", async () => {
    for (const status of [404, 501, 503]) {
      const result = await defaultCheckTrialGrant(stub(status, {}));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.retryable).toBe(true);
    }
  });

  it("returns a retryable envelope for an unreadable body", async () => {
    const result = await defaultCheckTrialGrant(stub(200));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("credits.unreadable");
  });

  it("swallows network errors into a typed envelope", async () => {
    const dead: FetchLike = async () => {
      throw new Error("offline");
    };
    const result = await defaultCheckTrialGrant(dead);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("credits.unreachable");
      expect(result.retryable).toBe(true);
    }
  });
});
