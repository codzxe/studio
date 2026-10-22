import { DbError } from "./errors-lite.js";
import type { ProjectVersion } from "./schema.js";

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

// ---------------------------------------------------------------------------
// M7 task 4 — version timeline + structural diff (§9.3: a version is a
// snapshot + metadata, not a diff; diffs are computed for display only).
// ---------------------------------------------------------------------------

/**
 * Timeline row: the immutable version row plus the author's display name
 * (joined from the user table at read time; `null` if the user row is gone).
 * Display-only derivations (isAgent, sha256Prefix) happen at the route.
 */
export interface VersionTimelineRow extends ProjectVersion {
  readonly createdByName: string | null;
}

/** The fields `buildVersionDiff` needs from a version row. */
export interface DiffableVersion {
  readonly id: string;
  readonly version: number;
  readonly label: string | null;
  readonly createdBy: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly createdAt: Date;
}

/** Structural diff against the parent (M7 v1: no deep content diff). */
export interface VersionDiffFromParent {
  readonly parentVersionId: string;
  readonly parentVersion: number;
  /** This version's size − the parent's (positive = grew). */
  readonly sizeDeltaBytes: number;
  readonly labelChanged: boolean;
  readonly authorChanged: boolean;
  /** Milliseconds between the parent's creation and this version's. */
  readonly createdGapMs: number;
}

export interface VersionDiffSummary {
  /** `null` for a root version (no parent to compare against). */
  readonly fromParent: VersionDiffFromParent | null;
  /** Human-safe short copy — no raw content hashes. */
  readonly summary: string;
}

/**
 * Structural diff of a version against its parent: size delta, parent linkage,
 * label/authorship change, creation time gap — plus a bounded, human-safe
 * summary string. Snapshot content is never diffed in v1; an identical sha256
 * (restore / unchanged save) is called out explicitly.
 */
export function buildVersionDiff(
  version: DiffableVersion,
  parent: DiffableVersion | null,
): VersionDiffSummary {
  if (parent === null) {
    return { fromParent: null, summary: "First version — nothing to compare against." };
  }
  const sizeDeltaBytes = version.sizeBytes - parent.sizeBytes;
  const fromParent: VersionDiffFromParent = {
    parentVersionId: parent.id,
    parentVersion: parent.version,
    sizeDeltaBytes,
    labelChanged: version.label !== parent.label,
    authorChanged: version.createdBy !== parent.createdBy,
    createdGapMs: Math.max(0, version.createdAt.getTime() - parent.createdAt.getTime()),
  };

  let summary: string;
  if (version.sha256 === parent.sha256) {
    summary = `Identical snapshot to v${parent.version} — restored or saved without changes.`;
  } else if (sizeDeltaBytes === 0) {
    summary = `Same size as v${parent.version}, but the content changed.`;
  } else {
    const magnitude = Math.abs(sizeDeltaBytes);
    summary = `${magnitude} byte${magnitude === 1 ? "" : "s"} ${
      sizeDeltaBytes > 0 ? "larger" : "smaller"
    } than v${parent.version}.`;
  }
  if (fromParent.authorChanged) {
    summary += " Saved by a different author.";
  }
  return { fromParent, summary };
}
