import { describe, expect, it } from "vitest";

import { DbError, isDbError } from "../src/errors-lite.js";
import {
  assertExpectedVersion,
  buildRestorePlan,
  nextVersionNumber,
} from "../src/version-logic.js";

/**
 * Optimistic concurrency (§9.3): the pure decision core of versions.upload /
 * restore. The transaction wrapper in src/repos/versions.ts applies these
 * checks under a SELECT … FOR UPDATE on the project row; a mismatch is a
 * typed PROJECT_VERSION_CONFLICT with the comparison data attached.
 */
describe("assertExpectedVersion (§9.3)", () => {
  it("accepts matching expectations", () => {
    expect(() => assertExpectedVersion("ver_1", "ver_1")).not.toThrow();
    expect(() => assertExpectedVersion(null, null)).not.toThrow();
  });

  it("throws typed PROJECT_VERSION_CONFLICT on mismatch", () => {
    try {
      assertExpectedVersion("ver_2", "ver_1");
      expect.unreachable();
    } catch (error) {
      expect(isDbError(error)).toBe(true);
      const dbError = error as DbError;
      expect(dbError.code).toBe("PROJECT_VERSION_CONFLICT");
      expect(dbError.status).toBe(409);
      expect(dbError.details).toEqual({
        expectedVersionId: "ver_1",
        currentVersionId: "ver_2",
      });
      expect(dbError.hint).toBeDefined();
    }
  });

  it("first upload requires the project to have no current version", () => {
    expect(() => assertExpectedVersion("ver_1", null)).toThrowError(DbError);
    expect(() => assertExpectedVersion(null, "ver_1")).toThrowError(DbError);
  });
});

describe("nextVersionNumber", () => {
  it("starts at 1 and increments monotonically", () => {
    expect(nextVersionNumber(null)).toBe(1);
    expect(nextVersionNumber(0)).toBe(1);
    expect(nextVersionNumber(4)).toBe(5);
  });
});

describe("buildRestorePlan (§9.3: restore creates a NEW version)", () => {
  const source = {
    id: "ver_2",
    version: 2,
    objectKey: "workspaces/w/projects/p/versions/ver_2/project.ecproj",
    sha256: "abc",
    sizeBytes: 42,
  };

  it("new version = current + 1, parent = the restored version, same content", () => {
    const plan = buildRestorePlan({ currentVersionNumber: 4, source });
    expect(plan.version).toBe(5);
    expect(plan.parentVersionId).toBe("ver_2");
    expect(plan.objectKey).toBe(source.objectKey);
    expect(plan.sha256).toBe(source.sha256);
    expect(plan.sizeBytes).toBe(42);
    expect(plan.label).toBe("restore of v2");
  });

  it("history is never rewritten — the source keeps its number", () => {
    const plan = buildRestorePlan({ currentVersionNumber: 4, source, label: "custom" });
    expect(plan.version).toBe(5);
    expect(plan.label).toBe("custom");
    expect(source.version).toBe(2);
  });

  it("restoring with no current version yields version 1", () => {
    const plan = buildRestorePlan({ currentVersionNumber: null, source });
    expect(plan.version).toBe(1);
  });
});
