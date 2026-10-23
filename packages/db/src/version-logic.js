import { DbError } from "./errors-lite.js";
/**
 * Version logic — pure helpers for the optimistic-concurrency protocol (§9.3).
 * `expectedVersionId` is required on upload; a mismatch with
 * `projects.currentVersionId` yields PROJECT_VERSION_CONFLICT (409).
 */
export function assertExpectedVersion(currentVersionId, expectedVersionId) {
    if (currentVersionId !== expectedVersionId) {
        throw DbError.versionConflict({ expectedVersionId, currentVersionId });
    }
}
/** v1 has no parent; every subsequent version is parent+1. */
export function nextVersionNumber(parentVersion) {
    if (parentVersion === null || parentVersion < 0)
        return 1;
    return parentVersion + 1;
}
export function buildRestorePlan(input) {
    return {
        version: nextVersionNumber(input.currentVersionNumber),
        parentVersionId: input.source.id,
        objectKey: input.source.objectKey,
        sha256: input.source.sha256,
        sizeBytes: input.source.sizeBytes,
        label: input.label ?? `restore of v${input.source.version}`,
    };
}
/**
 * Structural diff of a version against its parent: size delta, parent linkage,
 * label/authorship change, creation time gap — plus a bounded, human-safe
 * summary string. Snapshot content is never diffed in v1; an identical sha256
 * (restore / unchanged save) is called out explicitly.
 */
export function buildVersionDiff(version, parent) {
    if (parent === null) {
        return { fromParent: null, summary: "First version — nothing to compare against." };
    }
    const sizeDeltaBytes = version.sizeBytes - parent.sizeBytes;
    const fromParent = {
        parentVersionId: parent.id,
        parentVersion: parent.version,
        sizeDeltaBytes,
        labelChanged: version.label !== parent.label,
        authorChanged: version.createdBy !== parent.createdBy,
        createdGapMs: Math.max(0, version.createdAt.getTime() - parent.createdAt.getTime()),
    };
    let summary;
    if (version.sha256 === parent.sha256) {
        summary = `Identical snapshot to v${parent.version} — restored or saved without changes.`;
    }
    else if (sizeDeltaBytes === 0) {
        summary = `Same size as v${parent.version}, but the content changed.`;
    }
    else {
        const magnitude = Math.abs(sizeDeltaBytes);
        summary = `${magnitude} byte${magnitude === 1 ? "" : "s"} ${sizeDeltaBytes > 0 ? "larger" : "smaller"} than v${parent.version}.`;
    }
    if (fromParent.authorChanged) {
        summary += " Saved by a different author.";
    }
    return { fromParent, summary };
}
//# sourceMappingURL=version-logic.js.map