import { DbError } from "./errors-lite.js";

/**
 * Version logic — pure helpers for the optimistic-concurrency protocol (§9.3).
 * `expectedVersionId` is required on upload; a mismatch with
 * `projects.currentVersionId` yields PROJECT_VERSION_CONFLICT (409).
 */

export function assertExpectedVersion(
  currentVersionId: string | null,
  expectedVersionId: string | null,
): void {
  if (currentVersionId !== expectedVersionId) {
    throw DbError.versionConflict({ expectedVersionId, currentVersionId });
  }
}

/** v1 has no parent; every subsequent version is parent+1. */
export function nextVersionNumber(parentVersion: number | null): number {
  if (parentVersion === null || parentVersion < 0) return 1;
  return parentVersion + 1;
}

/** Descriptor for the NEW version row created by restoring an old one. */
export interface RestorePlan {
  readonly version: number; // new version number (current + 1)
  readonly parentVersionId: string; // the restored version — history never rewritten
  readonly objectKey: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly label: string;
}

export function buildRestorePlan(input: {
  currentVersionNumber: number | null;
  source: {
    id: string;
    version: number;
    objectKey: string;
    sha256: string;
    sizeBytes: number;
  };
  label?: string;
}): RestorePlan {
  return {
    version: nextVersionNumber(input.currentVersionNumber),
    parentVersionId: input.source.id,
    objectKey: input.source.objectKey,
    sha256: input.source.sha256,
    sizeBytes: input.source.sizeBytes,
    label: input.label ?? `restore of v${input.source.version}`,
  };
}
