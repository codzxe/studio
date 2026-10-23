import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ERROR_CATALOG,
  ERROR_CODES,
  ERROR_CODE_SCHEMA,
  StudioError,
  fromUnknown,
  isErrEnvelope,
  isStudioError,
  newRequestId,
  okEnvelope,
} from "../src/index.js";
import type { Envelope, ErrEnvelope } from "../src/index.js";

// Frozen contract: the catalog is add-only. This list is the §7.3/§8.9 wire
// contract — renaming or dropping a code must fail here.
const EXPECTED_CODES: readonly string[] = [
  "PROJECT_VERSION_CONFLICT",
  "INSUFFICIENT_CREDITS",
  "LEASE_HELD",
  "LEASE_EXPIRED",
  "RUN_MODEL_UNAVAILABLE",
  "RUN_INVALID_TOOL",
  "RUN_INVALID_COMMAND",
  "RUN_BATCH_ROLLED_BACK",
  "RUN_CANCELLED",
  "EDITOR_DISCONNECTED",
  "RENDER_TIMEOUT",
  "RENDER_FAILED",
  "RENDER_UNSUPPORTED_FORMAT",
  "RENDER_QUOTA_EXCEEDED",
  "RENDER_CLI_MISSING",
  "RENDER_CLI_FAILED",
  "RENDER_CANCELLED",
  "RENDER_PROJECT_INVALID",
  "RENDER_ASSET_MISSING",
  "RENDER_CONCURRENCY_LIMIT",
  "RENDER_INTERNAL",
  "ASSET_TOO_LARGE",
  "ASSET_REJECTED",
  "QUOTA_EXCEEDED",
  "WORKSPACE_NOT_FOUND",
  "PROJECT_NOT_FOUND",
  "VERSION_NOT_FOUND",
  "THREAD_NOT_FOUND",
  "RUN_NOT_FOUND",
  "RATE_LIMITED",
  "AUTH_REQUIRED",
  "FORBIDDEN",
  "VALIDATION_FAILED",
  "INTERNAL",
];

describe("errors: catalog", () => {
  it("exposes exactly the §7.3/§8.9 codes, in order", () => {
    expect(ERROR_CODES).toEqual(EXPECTED_CODES);
    expect(Object.keys(ERROR_CATALOG)).toEqual(EXPECTED_CODES);
  });

  it("every entry has a safe message, a hint and a retryable flag", () => {
    for (const code of ERROR_CODES) {
      const entry = ERROR_CATALOG[code];
      expect(typeof entry.message).toBe("string");
      expect(entry.message.length).toBeGreaterThan(0);
      expect(typeof entry.hint).toBe("string");
      expect(typeof entry.retryable).toBe("boolean");
    }
  });

  it("§8.9 semantics are encoded per failure", () => {
    expect(ERROR_CATALOG.PROJECT_VERSION_CONFLICT.retryable).toBe(false);
    expect(ERROR_CATALOG.RUN_MODEL_UNAVAILABLE.retryable).toBe(true);
    expect(ERROR_CATALOG.INSUFFICIENT_CREDITS.retryable).toBe(false);
    expect(ERROR_CATALOG.RUN_BATCH_ROLLED_BACK.retryable).toBe(false);
    expect(ERROR_CATALOG.EDITOR_DISCONNECTED.retryable).toBe(true);
    expect(ERROR_CATALOG.RENDER_TIMEOUT.retryable).toBe(true);
    expect(ERROR_CATALOG.INTERNAL.retryable).toBe(true);
  });

  it("the M8 render family maps to the house HTTP shapes (4xx client vs 5xx server)", () => {
    // 4xx client-shaped refusals (415/429/409/400) are NOT retryable as-is.
    expect(ERROR_CATALOG.RENDER_UNSUPPORTED_FORMAT.retryable).toBe(false); // 415, D-2 gate
    expect(ERROR_CATALOG.RENDER_QUOTA_EXCEEDED.retryable).toBe(false); // 429, cycle reset
    expect(ERROR_CATALOG.RENDER_CONCURRENCY_LIMIT.retryable).toBe(true); // 429, slot frees
    expect(ERROR_CATALOG.RENDER_CANCELLED.retryable).toBe(false); // 409, mirrors RUN_CANCELLED
    expect(ERROR_CATALOG.RENDER_PROJECT_INVALID.retryable).toBe(false); // 400, bad input
    expect(ERROR_CATALOG.RENDER_ASSET_MISSING.retryable).toBe(false); // 400, bad input
    // 5xx server-shaped failures follow RENDER_FAILED/INTERNAL: retryable.
    expect(ERROR_CATALOG.RENDER_CLI_FAILED.retryable).toBe(true); // 500, transient exit
    expect(ERROR_CATALOG.RENDER_INTERNAL.retryable).toBe(true); // 500, mirrors INTERNAL
    // The one deliberate exception: a MISSING CLI binary needs operator
    // action — retrying cannot fix it.
    expect(ERROR_CATALOG.RENDER_CLI_MISSING.retryable).toBe(false); // 500, ops action
  });

  it("the quota code is spelled EXCEEDED — the CONCEEDED typo trap stays out", () => {
    expect(ERROR_CODES).toContain("RENDER_QUOTA_EXCEEDED");
    expect(ERROR_CODES).not.toContain("RENDER_QUOTA_CONCEEDED");
    expect(ERROR_CODE_SCHEMA.safeParse("RENDER_QUOTA_CONCEEDED").success).toBe(false);
  });

  it("render catalog entries render a typed envelope with safe copy", () => {
    const error = new StudioError("RENDER_UNSUPPORTED_FORMAT");
    const envelope = error.toEnvelope();
    expect(envelope.error.code).toBe("RENDER_UNSUPPORTED_FORMAT");
    expect(envelope.error.message).toBe("This render format isn't available yet.");
    expect(envelope.error.hint).toContain("MP4");
    expect(envelope.error.retryable).toBe(false);
    expect(envelope.error.requestId).toMatch(/^req_[0-9a-f]{32}$/);
  });

  it("ERROR_CODE_SCHEMA accepts every catalog code and rejects anything else", () => {
    expect(ERROR_CODE_SCHEMA.safeParse("LEASE_HELD").success).toBe(true);
    expect(ERROR_CODE_SCHEMA.safeParse("not_a_code").success).toBe(false);
  });
});

describe("errors: StudioError envelope (§7.3)", () => {
  it("defaults come from the catalog; requestId is a fresh req_ id", () => {
    const error = new StudioError("INSUFFICIENT_CREDITS");
    expect(error.message).toBe(ERROR_CATALOG.INSUFFICIENT_CREDITS.message);
    expect(error.retryable).toBe(false);
    expect(error.requestId).toMatch(/^req_[0-9a-f]{32}$/);
    const envelope = error.toEnvelope();
    expect(envelope).toEqual({
      error: {
        code: "INSUFFICIENT_CREDITS",
        message: ERROR_CATALOG.INSUFFICIENT_CREDITS.message,
        hint: ERROR_CATALOG.INSUFFICIENT_CREDITS.hint,
        retryable: false,
        requestId: error.requestId,
      },
    });
  });

  it("overrides win over catalog defaults", () => {
    const error = new StudioError("RATE_LIMITED", {
      message: "Slow down.",
      hint: "Try again in 30s.",
      retryable: true,
      requestId: "req_fixed",
    });
    expect(error.message).toBe("Slow down.");
    expect(error.hint).toBe("Try again in 30s.");
    expect(error.retryable).toBe(true);
    expect(error.requestId).toBe("req_fixed");
  });

  it("toJSON mirrors toEnvelope so accidental JSON.stringify cannot leak internals", () => {
    const error = new StudioError("INTERNAL", { cause: new Error("ECONNREFUSED /var/run/x") });
    expect(error.toJSON()).toEqual(error.toEnvelope());
    expect(JSON.stringify(error)).toEqual(JSON.stringify(error.toEnvelope()));
    expect(JSON.stringify(error)).not.toContain("ECONNREFUSED");
  });
});

describe("errors: fromUnknown mapper", () => {
  it("passes StudioError through unchanged", () => {
    const original = new StudioError("LEASE_HELD");
    expect(fromUnknown(original)).toBe(original);
    expect(fromUnknown(original, original.requestId)).toBe(original);
  });

  it("restamps the requestId of a StudioError when a newer request context is known", () => {
    const original = new StudioError("LEASE_HELD");
    const mapped = fromUnknown(original, "req_newer");
    expect(mapped).not.toBe(original);
    expect(mapped.requestId).toBe("req_newer");
    expect(mapped.code).toBe(original.code);
    expect(mapped.message).toBe(original.message);
  });

  it("maps ZodError to VALIDATION_FAILED without echoing the input", () => {
    const parsed = z.object({ name: z.string().min(100) }).safeParse({ name: "short" });
    expect(parsed.success).toBe(false);
    const mapped = fromUnknown(parsed.error);
    expect(mapped.code).toBe("VALIDATION_FAILED");
    const json = JSON.stringify(mapped.toEnvelope());
    expect(json).not.toContain("short");
  });

  it("maps anything else to INTERNAL and never leaks the cause", () => {
    const raw = new Error(
      "connect ECONNREFUSED 127.0.0.1:5432 at /var/run/postgresql http://provider.internal/v1",
    );
    const mapped = fromUnknown(raw);
    expect(mapped.code).toBe("INTERNAL");
    expect(mapped.message).toBe(ERROR_CATALOG.INTERNAL.message);
    expect(mapped.cause).toBe(raw);
    const json = JSON.stringify(mapped.toEnvelope());
    expect(json).not.toContain("ECONNREFUSED");
    expect(json).not.toContain("/var/run");
    expect(json).not.toContain("provider.internal");
    expect(json).not.toContain("stack");
  });

  it("handles non-error throws", () => {
    expect(fromUnknown("boom").code).toBe("INTERNAL");
    expect(fromUnknown(null).code).toBe("INTERNAL");
    expect(fromUnknown(undefined).code).toBe("INTERNAL");
    expect(fromUnknown({ weird: true }, "req_x").requestId).toBe("req_x");
  });

  it("isStudioError guards", () => {
    expect(isStudioError(new StudioError("FORBIDDEN"))).toBe(true);
    expect(isStudioError(new Error("nope"))).toBe(false);
  });
});

describe("errors: Ok envelope", () => {
  it("okEnvelope wraps data and optional meta", () => {
    expect(okEnvelope(42)).toEqual({ data: 42 });
    expect(okEnvelope([1], { page: 2 })).toEqual({ data: [1], meta: { page: 2 } });
  });

  it("isErrEnvelope discriminates the union", () => {
    const ok: Envelope<number> = okEnvelope(1);
    const err: ErrEnvelope = new StudioError("RUN_CANCELLED").toEnvelope();
    expect(isErrEnvelope(ok)).toBe(false);
    expect(isErrEnvelope(err)).toBe(true);
    expect(err.error.code).toBe("RUN_CANCELLED");
    expect(err.error.retryable).toBe(false);
  });

  it("envelope hints are always present from the catalog", () => {
    const envelope = new StudioError("PROJECT_VERSION_CONFLICT").toEnvelope();
    expect(envelope.error.hint).toContain("version");
  });

  it("newRequestId is available for gateway middleware", () => {
    expect(newRequestId()).toMatch(/^req_[0-9a-f]{32}$/);
  });
});
