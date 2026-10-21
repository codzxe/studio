/**
 * tests/client.test.ts — pure validation logic of the db client.
 *
 * No network, no Postgres: postgres-js pools connect lazily on the first query,
 * so createDb/closeDb only exercise object construction and teardown.
 * Deterministic table-driven units (<5s), per docs/AGENTS.md.
 */
import { describe, expect, it } from "vitest";
import {
  DbConfigError,
  closeDb,
  createDb,
  readDatabaseUrl,
  validateConnectionString,
} from "../src/client.js";

const VALID_URL = "postgres://studio:secret@localhost:5432/studio";

/** Run `fn`, return the thrown value (undefined if nothing was thrown). */
function captureError(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("validateConnectionString", () => {
  it("accepts postgres:// and postgresql:// URLs with a host", () => {
    const valid: Array<{ raw: string; url: string }> = [
      { raw: VALID_URL, url: VALID_URL },
      {
        raw: "postgresql://postgres@db.internal:5432/prod?sslmode=require",
        url: "postgresql://postgres@db.internal:5432/prod?sslmode=require",
      },
      { raw: "postgres://u:p@127.0.0.1:5432/studio", url: "postgres://u:p@127.0.0.1:5432/studio" },
      { raw: "  postgres://u@localhost:5432/studio  ", url: "postgres://u@localhost:5432/studio" },
      { raw: "POSTGRES://u@localhost:5432/studio", url: "POSTGRES://u@localhost:5432/studio" },
    ];
    for (const { raw, url } of valid) {
      const check = validateConnectionString(raw);
      expect(check).toEqual({ ok: true, url });
    }
  });

  it("flags a missing DATABASE_URL (undefined, null, empty, whitespace)", () => {
    for (const raw of [undefined, null, "", "   ", "\t"]) {
      const check = validateConnectionString(raw);
      expect(check.ok).toBe(false);
      if (!check.ok) {
        expect(check.code).toBe("db_url_missing");
        expect(check.message).toContain("DATABASE_URL");
        expect(check.hint.length).toBeGreaterThan(0);
      }
    }
  });

  it("rejects non-postgres schemes and hostless strings", () => {
    const invalid = [
      "mysql://root@localhost/db", // wrong scheme
      "redis://localhost:6379", // wrong scheme
      "postgres", // not a URL at all
      "postgres:/localhost:5432/studio", // typo in scheme separator
      "postgres://", // scheme but no host
      "postgresql://", // scheme but no host
      "postgres://@/studio", // empty host with userinfo marker
      "postgres://user@/studio", // empty host after userinfo
    ];
    for (const raw of invalid) {
      const check = validateConnectionString(raw);
      expect(check.ok).toBe(false);
      if (!check.ok) {
        expect(check.code).toBe("db_url_invalid");
        expect(check.hint.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("readDatabaseUrl", () => {
  it("returns the trimmed URL for a valid env", () => {
    expect(readDatabaseUrl({ DATABASE_URL: `  ${VALID_URL} ` })).toBe(VALID_URL);
  });

  it("throws DbConfigError (db_url_missing) for an unset env", () => {
    const error = captureError(() => readDatabaseUrl({}));
    expect(error).toBeInstanceOf(DbConfigError);
    expect(error).toBeInstanceOf(Error);
    if (error instanceof DbConfigError) {
      expect(error.name).toBe("DbConfigError");
      expect(error.code).toBe("db_url_missing");
      expect(error.hint).toContain("DATABASE_URL");
    }
  });

  it("throws DbConfigError (db_url_invalid) for a non-postgres env", () => {
    const error = captureError(() =>
      readDatabaseUrl({ DATABASE_URL: "mysql://root@localhost/db" }),
    );
    expect(error).toBeInstanceOf(DbConfigError);
    if (error instanceof DbConfigError) {
      expect(error.code).toBe("db_url_invalid");
    }
  });
});

describe("createDb / closeDb", () => {
  it("builds a schema-less Drizzle client without connecting (lazy pool)", () => {
    const db = createDb(VALID_URL, { max: 3, idle_timeout: 5, connect_timeout: 2 });
    expect(typeof db.select).toBe("function");
    expect(typeof db.insert).toBe("function");
    expect(typeof db.update).toBe("function");
    expect(typeof db.execute).toBe("function");
  });

  it("throws DbConfigError for an invalid connection string", () => {
    const error = captureError(() => createDb("postgres://"));
    expect(error).toBeInstanceOf(DbConfigError);
    if (error instanceof DbConfigError) {
      expect(error.code).toBe("db_url_invalid");
    }
  });

  it("throws DbConfigError for unusable pool options", () => {
    const error = captureError(() => createDb(VALID_URL, { max: 0 }));
    expect(error).toBeInstanceOf(DbConfigError);
    if (error instanceof DbConfigError) {
      expect(error.code).toBe("db_options_invalid");
    }
  });

  it("creates an independent pool per call", () => {
    const a = createDb(VALID_URL);
    const b = createDb(VALID_URL);
    expect(a.$client).not.toBe(b.$client);
  });

  it("closes gracefully and is safe to call twice", async () => {
    const db = createDb(VALID_URL);
    await expect(closeDb(db)).resolves.toBeUndefined();
    await expect(closeDb(db)).resolves.toBeUndefined();
  });
});
