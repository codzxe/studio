import { describe, expect, it } from "vitest";
import {
  ID_PREFIXES,
  defaultIdGenerator,
  idSchema,
  isNewId,
  newAssetId,
  newId,
  newProjectId,
  newRenderId,
  newRequestId,
  newRunId,
  newThreadId,
  newVersionId,
} from "../src/index.js";

const HEX32 = /^[0-9a-f]{32}$/;

describe("ids: prefixes", () => {
  it("declares the readable entity prefixes", () => {
    expect(ID_PREFIXES).toEqual({
      project: "prj",
      version: "ver",
      asset: "ast",
      thread: "thr",
      run: "run",
      render: "rnd",
      request: "req",
    });
  });

  it("per-entity helpers emit their own prefix plus 32 hex chars", () => {
    const cases = [
      [newProjectId(), "prj_"],
      [newVersionId(), "ver_"],
      [newAssetId(), "ast_"],
      [newThreadId(), "thr_"],
      [newRunId(), "run_"],
      [newRenderId(), "rnd_"],
      [newRequestId(), "req_"],
    ] as const;
    for (const [id, prefix] of cases) {
      expect(id.startsWith(prefix)).toBe(true);
      expect(id).toHaveLength(prefix.length + 32);
      expect(id.slice(prefix.length)).toMatch(HEX32);
    }
  });
});

describe("ids: generation", () => {
  it("defaultIdGenerator returns a stripped UUID (32 lowercase hex)", () => {
    expect(defaultIdGenerator()).toMatch(HEX32);
  });

  it("newId accepts a deterministic generator seam", () => {
    const fixed = () => "0123456789abcdef0123456789abcdef";
    expect(newId("project", fixed)).toBe("prj_0123456789abcdef0123456789abcdef");
  });

  it("generated ids are unique", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      seen.add(newRunId());
    }
    expect(seen.size).toBe(500);
  });
});

describe("ids: validation", () => {
  it("isNewId checks prefix and body", () => {
    expect(isNewId(newProjectId(), "project")).toBe(true);
    expect(isNewId(newProjectId(), "version")).toBe(false);
    expect(isNewId("prj_short", "project")).toBe(false);
    expect(isNewId("prj_NOTHEX!", "project")).toBe(false);
    expect(isNewId("", "project")).toBe(false);
  });

  it("idSchema validates prefixed ids at boundaries and names the prefix in errors", () => {
    const schema = idSchema("thread");
    expect(schema.safeParse(newThreadId()).success).toBe(true);
    const wrongPrefix = schema.safeParse(newProjectId());
    expect(wrongPrefix.success).toBe(false);
    const malformed = schema.safeParse("thr_oops");
    expect(malformed.success).toBe(false);
    if (!malformed.success) {
      expect(malformed.error.issues[0]?.message).toContain("thr_");
    }
  });
});
