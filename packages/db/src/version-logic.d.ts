import type { ProjectVersion } from "./schema.js";
/**
 * Version logic — pure helpers for the optimistic-concurrency protocol (§9.3).
 * `expectedVersionId` is required on upload; a mismatch with
 * `projects.currentVersionId` yields PROJECT_VERSION_CONFLICT (409).
 */
export declare function assertExpectedVersion(currentVersionId: string | null, expectedVersionId: string | null): void;
/** v1 has no parent; every subsequent version is parent+1. */
export declare function nextVersionNumber(parentVersion: number | null): number;
/** Descriptor for the NEW version row created by restoring an old one. */
export interface RestorePlan {
    readonly version: number;
    readonly parentVersionId: string;
    readonly objectKey: string;
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly label: string;
}
export declare function buildRestorePlan(input: {
    currentVersionNumber: number | null;
    source: {
        id: string;
        version: number;
        objectKey: string;
        sha256: string;
        sizeBytes: number;
    };
    label?: string;
}): RestorePlan;
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
export declare function buildVersionDiff(version: DiffableVersion, parent: DiffableVersion | null): VersionDiffSummary;
