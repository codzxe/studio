import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isApiError } from "../src/api-error.js";
import { RETRY_DELAYS_MS, createApiClient } from "../src/client.js";
import { jsonErr, jsonOk } from "./helpers.js";

const BASE = "https://api.studio.test/v1";
const ME = {
  user: { id: "usr_1", name: null, email: "maya@northlight.example" },
  memberships: [],
  plan: { plan: "trial", creditsBalance: 10, includedCredits: 10, renewsAt: null },
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function makeClient(handler: () => Promise<Response>) {
  const calls: unknown[][] = [];
  const fetch = async (...args: unknown[]) => {
    calls.push(args);
    return handler();
  };
  const client = createApiClient({
    baseUrl: BASE,
    fetch: fetch as unknown as (input: string, init?: RequestInit) => Promise<Response>,
  });
  return { client, calls };
}

describe("GET retry with exponential backoff (250/500/1000 ms)", () => {
  it("exposes the documented default schedule", () => {
    expect(RETRY_DELAYS_MS).toEqual([250, 500, 1000]);
  });

  it("retries a 429 once after 250 ms and succeeds", async () => {
    let calls = 0;
    const { client } = makeClient(() => {
      calls += 1;
      return calls === 1
        ? Promise.resolve(
            jsonErr(429, { code: "RATE_LIMITED", message: "Too many requests.", retryable: true }),
          )
        : Promise.resolve(jsonOk(ME));
    });

    const pending = client.me.get();
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(1); // still backing off
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(0);
    const me = await pending;
    expect(calls).toBe(2);
    expect(me.user.email).toBe("maya@northlight.example");
  });

  it("retries retryable 5xx twice (250 + 500 ms) then succeeds", async () => {
    let calls = 0;
    const { client } = makeClient(() => {
      calls += 1;
      return calls <= 2
        ? Promise.resolve(
            jsonErr(503, { code: "INTERNAL_ERROR", message: "down", retryable: true }),
          )
        : Promise.resolve(jsonOk(ME));
    });

    const pending = client.me.get();
    await vi.advanceTimersByTimeAsync(250);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(0);
    await pending;
    expect(calls).toBe(3);
  });

  it("retries network errors (fetch rejected before a response)", async () => {
    let calls = 0;
    const { client } = makeClient(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new TypeError("fetch failed"))
        : Promise.resolve(jsonOk(ME));
    });

    const pending = client.me.get();
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(0);
    await pending;
    expect(calls).toBe(2);
  });

  it("gives up after three retries (four attempts) and throws", async () => {
    let calls = 0;
    const { client } = makeClient(() => {
      calls += 1;
      return Promise.resolve(
        jsonErr(500, { code: "INTERNAL_ERROR", message: "down", retryable: true }),
      );
    });

    const pending = client.me.get();
    // Attach the rejection handler BEFORE advancing the timers: the final
    // attempt settles during the advance, and a promise that rejects with no
    // handler yet is an unhandled rejection (vitest fails the file on it).
    const outcome = pending.then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(250 + 500 + 1000);
    await vi.advanceTimersByTimeAsync(0);
    const error = await outcome;
    expect(calls).toBe(4);
    expect(isApiError(error)).toBe(true);
    expect((error as { code: string }).code).toBe("INTERNAL_ERROR");
  });

  it("does NOT retry mutations (POST 5xx stays one attempt)", async () => {
    let calls = 0;
    const { client } = makeClient(() => {
      calls += 1;
      return Promise.resolve(
        jsonErr(503, { code: "INTERNAL_ERROR", message: "down", retryable: true }),
      );
    });

    const error = await client.workspaces.create({ name: "N", slug: "n" }).then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e,
    );
    expect(calls).toBe(1);
    expect((error as { code: string }).code).toBe("INTERNAL_ERROR");
  });

  it("does not retry a 5xx whose envelope says retryable=false", async () => {
    let calls = 0;
    const { client } = makeClient(() => {
      calls += 1;
      return Promise.resolve(
        jsonErr(500, { code: "RUN_BATCH_ROLLED_BACK", message: "rolled back", retryable: false }),
      );
    });

    await expectAsyncFailure(client.me.get());
    expect(calls).toBe(1);
  });

  it("does not retry non-retryable 4xx", async () => {
    let calls = 0;
    const { client } = makeClient(() => {
      calls += 1;
      return Promise.resolve(
        jsonErr(404, { code: "NOT_FOUND", message: "Not found.", retryable: false }),
      );
    });

    const error = await getError(client.me.get());
    expect(calls).toBe(1);
    expect((error as { code: string }).code).toBe("NOT_FOUND");
  });

  it("aborts during backoff instead of retrying (abort errors stay unwrapped)", async () => {
    let calls = 0;
    const controller = new AbortController();
    const { client } = makeClient(() => {
      calls += 1;
      return Promise.resolve(
        jsonErr(429, { code: "RATE_LIMITED", message: "slow down", retryable: true }),
      );
    });

    const pending = client.me.get({ signal: controller.signal });
    await vi.advanceTimersByTimeAsync(50); // first attempt failed; sleeping 250 ms
    controller.abort();
    const error = await pending.then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e,
    );
    expect(calls).toBe(1);
    expect(isApiError(error)).toBe(false);
    expect((error as Error).name).toBe("AbortError");
  });

  it("respects a custom retry schedule via options", async () => {
    const delays: number[] = [];
    let calls = 0;
    const client = createApiClient({
      baseUrl: BASE,
      fetch: (async () => {
        calls += 1;
        if (calls === 1) {
          return jsonErr(429, { code: "RATE_LIMITED", message: "x", retryable: true });
        }
        return jsonOk(ME);
      }) as unknown as (input: string, init?: RequestInit) => Promise<Response>,
      retry: { delaysMs: [120] },
      sleep: async (ms: number) => {
        delays.push(ms);
      },
    });

    const me = await client.me.get();
    expect(me.user.id).toBe("usr_1");
    expect(calls).toBe(2);
    expect(delays).toEqual([120]);
  });
});

async function expectAsyncFailure(promise: Promise<unknown>): Promise<void> {
  await getError(promise);
}

async function getError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the call to reject");
    },
    (e: unknown) => e,
  );
}
