import { z } from "zod";

import { describe, expect, it } from "vitest";

import {
  ERROR_BODY_SCHEMA,
  ERR_SCHEMA,
  META_SCHEMA,
  REQUEST_ID_SCHEMA,
  WIRE_ERROR_CODES,
  WIRE_ERROR_CODE_SCHEMA,
  err,
  isEnvelope,
  isErr,
  isOk,
  ok,
  okSchema,
} from "../src/envelope.js";

describe("envelope: §7.3 shape", () => {
  it("ok() wraps data and optional meta", () => {
    expect(ok(42)).toEqual({ data: 42 });
    expect(ok("x", { page: 1 })).toEqual({ data: "x", meta: { page: 1 } });
  });

  it("err() builds the full failure body with retryable defaulting to false", () => {
    const e = err("INSUFFICIENT_CREDITS", "Balance too low", {
      requestId: "req_1",
      hint: "Top up credits and retry",
    });
    expect(e).toEqual({
      error: {
        code: "INSUFFICIENT_CREDITS",
        message: "Balance too low",
        hint: "Top up credits and retry",
        retryable: false,
        requestId: "req_1",
      },
    });
    expect(err("X", "y", { requestId: "r", retryable: true }).error.retryable).toBe(true);
    // hint omitted entirely when not provided (wire has no `hint: undefined`)
    expect("hint" in err("X", "y", { requestId: "r" }).error).toBe(false);
  });

  it("okSchema() validates a success envelope against a data schema", () => {
    const schema = okSchema(z.object({ id: z.string() }));
    expect(schema.parse({ data: { id: "a" } })).toEqual({ data: { id: "a" } });
    expect(schema.parse({ data: { id: "a" }, meta: { total: 1 } }).meta).toEqual({ total: 1 });
    expect(schema.safeParse({ data: { id: 1 } }).success).toBe(false); // wrong data type
    expect(schema.safeParse({ error: { code: "X" } }).success).toBe(false); // not Ok
  });

  it("ERR_SCHEMA / ERROR_BODY_SCHEMA reject incomplete failure bodies", () => {
    expect(ERR_SCHEMA.safeParse({ error: { code: "X", message: "m" } }).success).toBe(false); // missing retryable/requestId
    expect(
      ERROR_BODY_SCHEMA.safeParse({
        code: "X",
        message: "m",
        retryable: true,
        requestId: "r",
        extra: 1,
      }).success,
    ).toBe(true); // extra keys tolerated on the envelope body (forward-compat)
    expect(REQUEST_ID_SCHEMA.safeParse("").success).toBe(false);
    expect(META_SCHEMA.safeParse({ a: 1 }).success).toBe(true);
    expect(META_SCHEMA.safeParse([1]).success).toBe(false); // meta is a record, not an array
  });

  it("isEnvelope accepts exactly one of data/error", () => {
    expect(isEnvelope(ok(1))).toBe(true);
    expect(isEnvelope(err("X", "y", { requestId: "r" }))).toBe(true);
    expect(isEnvelope({})).toBe(false); // neither
    expect(isEnvelope({ data: 1, error: { code: "X" } })).toBe(false); // both
    expect(isEnvelope(null)).toBe(false);
    expect(isEnvelope("ok")).toBe(false);
    expect(isEnvelope({ error: { code: "X", message: "m" } })).toBe(false); // incomplete error body
  });

  it("isOk/isErr discriminate the envelope", () => {
    expect(isOk(ok(1))).toBe(true);
    expect(isOk(err("X", "y", { requestId: "r" }))).toBe(false);
    expect(isErr(err("X", "y", { requestId: "r" }))).toBe(true);
    expect(isErr(ok(1))).toBe(false);
  });

  it("carries the §8.9 stable error codes", () => {
    for (const code of [
      "RUN_MODEL_UNAVAILABLE",
      "RUN_INVALID_TOOL",
      "RUN_INVALID_COMMAND",
      "RUN_BATCH_ROLLED_BACK",
      "EDITOR_DISCONNECTED",
      "RENDER_TIMEOUT",
      "PROJECT_VERSION_CONFLICT",
      "INSUFFICIENT_CREDITS",
    ]) {
      expect(WIRE_ERROR_CODES).toContain(code);
      expect(WIRE_ERROR_CODE_SCHEMA.safeParse(code).success).toBe(true);
    }
    expect(WIRE_ERROR_CODE_SCHEMA.safeParse("made_up_code").success).toBe(false);
  });
});
