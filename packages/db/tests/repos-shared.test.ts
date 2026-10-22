import { describe, expect, it } from "vitest";

import { isUniqueViolation } from "../src/repos/shared.js";

/**
 * isUniqueViolation — SQLSTATE 23505 recognition through drizzle's error
 * wrapping (M6-D finding, fixed M6-E).
 *
 * postgres.js raises a PostgresError carrying the SQLSTATE on `.code`
 * (e.g. 23505 unique_violation); drizzle-orm 0.45 wraps every failed query in
 * `DrizzleQueryError` ("Failed query …") and preserves the driver error on
 * `.cause` (src: errors.ts — `cause?: Error`, ES2022 Error cause). So a
 * shallow `.code === "23505"` check on the surface error misses EVERY unique
 * violation raised through a drizzle insert. The real-path proof is the
 * integration suite (duplicate runs.addStep → typed CONFLICT); these units
 * pin the chain-walk shapes and the negatives without a DB.
 */

/** postgres.js PostgresError shape (Error + SQLSTATE code). */
function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, severity: "ERROR" });
}

/** drizzle DrizzleQueryError shape — surface message + `.cause` = driver error. */
function drizzleWrap(cause: unknown, message = "Failed query: insert into …"): Error {
  return new Error(message, { cause });
}

describe("isUniqueViolation (drizzle .cause-chain walk)", () => {
  it("recognizes a direct postgres.js PostgresError (code 23505 on the surface)", () => {
    expect(
      isUniqueViolation(
        pgError("23505", 'duplicate key value violates unique constraint "t_pkey"'),
      ),
    ).toBe(true);
  });

  it("recognizes a drizzle-wrapped 23505 — the code lives on .cause, not the surface", () => {
    const wrapped = drizzleWrap(pgError("23505", "duplicate key …"));
    expect("code" in wrapped && wrapped.code === "23505").toBe(false); // surface has no code
    expect(isUniqueViolation(wrapped)).toBe(true);
  });

  it("recognizes 23505 through a doubly-wrapped cause chain", () => {
    const inner = pgError("23505", "duplicate key …");
    const middle = drizzleWrap(inner);
    const outer = drizzleWrap(middle);
    expect(isUniqueViolation(outer)).toBe(true);
  });

  it("rejects wrapped non-unique SQLSTATEs (23503 FK, 23514 check, 42P07 duplicate table)", () => {
    expect(isUniqueViolation(drizzleWrap(pgError("23503", "insert or update on table …")))).toBe(
      false,
    );
    expect(
      isUniqueViolation(drizzleWrap(pgError("23514", "new row violates check constraint"))),
    ).toBe(false);
    expect(isUniqueViolation(drizzleWrap(pgError("42P07", 'relation "t" already exists')))).toBe(
      false,
    );
  });

  it("rejects errors whose cause chain never carries 23505", () => {
    expect(isUniqueViolation(new Error("connection refused"))).toBe(false);
    expect(isUniqueViolation(drizzleWrap(new Error("ECONNREFUSED")))).toBe(false);
    // chain terminating in null / undefined is safe (no infinite walk)
    const endsNull = new Error("x", { cause: null });
    expect(isUniqueViolation(endsNull)).toBe(false);
  });

  it("rejects non-error inputs without throwing", () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
    expect(isUniqueViolation(23505)).toBe(false);
    expect(isUniqueViolation({ code: "23505", cause: undefined })).toBe(true); // still a pg-shaped object
  });
});
