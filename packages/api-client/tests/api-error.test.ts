import { ERROR_CATALOG } from "@studio/config";
import { WIRE_ERROR_CODES } from "@studio/contracts";
import { describe, expect, it } from "vitest";

import { ApiError, fromResponse, isApiError } from "../src/api-error";

describe("ApiError", () => {
  it("carries the §7.3 body fields plus the HTTP status", () => {
    const error = new ApiError({
      code: "PROJECT_VERSION_CONFLICT",
      message: "This project changed while you were working.",
      hint: "Open the latest version.",
      retryable: false,
      requestId: "req_test_123",
      status: 409,
    });
    expect(error.name).toBe("ApiError");
    expect(error.code).toBe("PROJECT_VERSION_CONFLICT");
    expect(error.hint).toBe("Open the latest version.");
    expect(error.retryable).toBe(false);
    expect(error.requestId).toBe("req_test_123");
    expect(error.status).toBe(409);
    expect(isApiError(error)).toBe(true);
    expect(isApiError(new Error("nope"))).toBe(false);
  });

  it("generates a req_-prefixed request id when absent", () => {
    const error = new ApiError({ code: "INTERNAL_ERROR", message: "x", status: 500 });
    expect(error.requestId).toMatch(/^req_[0-9a-f]{32}$/);
  });

  it("defaults retryable to false and keeps the cause off toJSON", () => {
    const secret = new Error("upstream https://internal.provider/key=SECRET");
    const error = new ApiError({
      code: "INTERNAL_ERROR",
      message: "Something went wrong on our side.",
      status: 500,
      cause: secret,
    });
    expect(error.retryable).toBe(false);
    const json = JSON.parse(JSON.stringify(error)) as Record<string, unknown>;
    expect(json).toEqual({
      code: "INTERNAL_ERROR",
      message: "Something went wrong on our side.",
      retryable: false,
      requestId: error.requestId,
      status: 500,
    });
    // The raw cause never leaks through serialization.
    expect(JSON.stringify(error)).not.toContain("SECRET");
  });
});

describe("fromResponse", () => {
  it("uses the §7.3 Err envelope verbatim", async () => {
    const body = {
      error: {
        code: "INSUFFICIENT_CREDITS",
        message: "This workspace is out of credits.",
        hint: "Top up credits or upgrade your plan to continue.",
        retryable: false,
        requestId: "req_wire_abc",
      },
    };
    const error = await fromResponse({
      status: 402,
      text: async () => JSON.stringify(body),
    });
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("INSUFFICIENT_CREDITS");
    expect(error.message).toBe("This workspace is out of credits.");
    expect(error.hint).toBe("Top up credits or upgrade your plan to continue.");
    expect(error.retryable).toBe(false);
    expect(error.requestId).toBe("req_wire_abc");
    expect(error.status).toBe(402);
  });

  it("maps unparseable bodies to safe generic codes, never raw text", async () => {
    const error = await fromResponse({
      status: 404,
      text: async () => "Fatal: stack trace at /srv/app/secret-path.ts",
    });
    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toBe("Not found.");
    expect(error.message).not.toContain("/srv/app");
    expect(error.retryable).toBe(false);
  });

  it.each([
    [400, "VALIDATION_FAILED", false],
    [401, "UNAUTHORIZED", false],
    [403, "FORBIDDEN", false],
    [404, "NOT_FOUND", false],
    [429, "RATE_LIMITED", true],
    [500, "INTERNAL_ERROR", true],
    [503, "INTERNAL_ERROR", true],
  ])("maps bare status %d to %s (retryable %s)", async (status, code, retryable) => {
    const error = await fromResponse({ status, text: async () => "" });
    expect(error.code).toBe(code);
    expect(error.retryable).toBe(retryable);
    expect(error.status).toBe(status);
  });

  it("keeps a body envelope's retryable=false on a retryable status", async () => {
    const error = await fromResponse({
      status: 500,
      text: async () =>
        JSON.stringify({
          error: {
            code: "RUN_BATCH_ROLLED_BACK",
            message: "rolled back",
            retryable: false,
            requestId: "req_x",
          },
        }),
    });
    expect(error.code).toBe("RUN_BATCH_ROLLED_BACK");
    expect(error.retryable).toBe(false);
  });

  it("survives a body read failure", async () => {
    const error = await fromResponse({
      status: 502,
      text: async () => {
        throw new Error("connection reset");
      },
    });
    expect(error.code).toBe("INTERNAL_ERROR");
    expect(error.retryable).toBe(true);
  });
});

describe("client-local codes align with the @studio/config catalog", () => {
  it("shared wire codes agree with the config catalog retryable defaults", () => {
    // Client fallback vs. server catalog: same code → same retryable guidance.
    for (const code of ["RATE_LIMITED", "VALIDATION_FAILED", "PROJECT_VERSION_CONFLICT"] as const) {
      expect(WIRE_ERROR_CODES).toContain(code);
      expect(ERROR_CATALOG[code]).toBeDefined();
    }
    expect(ERROR_CATALOG.RATE_LIMITED.retryable).toBe(true);
    expect(ERROR_CATALOG.VALIDATION_FAILED.retryable).toBe(false);
    expect(ERROR_CATALOG.PROJECT_VERSION_CONFLICT.retryable).toBe(false);
  });

  it("documents the spelling differences between the two catalogs", () => {
    // The client speaks §7.3 WIRE codes; @studio/config's service-side catalog
    // spells two of them differently (UNAUTHORIZED vs AUTH_REQUIRED,
    // INTERNAL_ERROR vs INTERNAL). The mapping is deliberate and tested so a
    // rename on either side trips CI here first.
    expect(ERROR_CATALOG.AUTH_REQUIRED).toBeDefined();
    expect(ERROR_CATALOG.INTERNAL).toBeDefined();
    expect(WIRE_ERROR_CODES).toContain("UNAUTHORIZED");
    expect(WIRE_ERROR_CODES).toContain("INTERNAL_ERROR");
  });
});
