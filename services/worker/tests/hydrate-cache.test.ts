// PERF-03 (2026-10-30 audit) — the sha-keyed cross-job asset cache.
//
// Pre-fix EVERY render re-downloaded EVERY project asset from object storage,
// sequentially (50 assets × 10 MB = 500 MB + 2.5–10 s latency per render).
// Now the bytes land in `<repoRoot>/.local/asset-cache/<sha256>` on first
// touch (atomic temp+rename publish) and every later render of the same
// content reads the local copy — zero object-store round trips. Hydration
// also runs in bounded-parallel groups instead of one-by-one.

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Asset, Page } from "@studio/db";
import type { StorageChoice } from "@studio/gateway/storage";

import { assetCacheRoot, hydrateJob } from "../src/hydrate.js";

const TICKS_PER_SECOND = 254_016_000_000;

/** The project bytes every test hydrates (one comp + one footage reference). */
function projectBytes(): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema: 2,
      items: {
        1: {
          id: 1,
          name: "Main",
          kind: {
            type: "Comp",
            width: 640,
            height: 360,
            frame_rate: { num: 30, den: 1 },
            duration: Math.round(2 * TICKS_PER_SECOND),
            layers: [],
          },
        },
      },
    }),
    "utf8",
  );
}

describe("hydrateJob asset cache (PERF-03)", () => {
  let repoRoot: string;
  let storageReads: string[];
  let objects: Map<string, Buffer>;

  beforeAll(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "studio-perf03-"));
  });

  afterAll(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** Counting in-memory storage: every driver.read is recorded. */
  function countingStorage(): StorageChoice {
    storageReads = [];
    objects = new Map<string, Buffer>([
      ["versions/v1", projectBytes()],
      ["assets/photo", Buffer.from("fake-png-bytes-perf03")],
    ]);
    return {
      driver: {
        read: async (key: string) => {
          storageReads.push(key);
          return objects.get(key) ?? null;
        },
      },
      local: null,
    } as unknown as StorageChoice;
  }

  function assetRow(): Asset {
    return {
      id: "ast_1",
      projectId: "prj_1",
      name: "photo.png",
      mime: "image/png",
      sizeBytes: 21,
      sha256: createHash("sha256").update("fake-png-bytes-perf03").digest("hex"),
      objectKey: "assets/photo",
      width: 640,
      height: 480,
      durationTicks: null,
      createdBy: "usr_1",
      createdAt: new Date(),
    } as unknown as Asset;
  }

  /** The one-project/one-asset assets repo the hydrator walks. */
  function assetsRepo(): Pick<import("@studio/db").Repos, "assets">["assets"] {
    return {
      list: async () => ({ items: [assetRow()], nextCursor: null }) as Page<Asset>,
    } as unknown as Pick<import("@studio/db").Repos, "assets">["assets"];
  }

  async function hydrate(renderId: string): Promise<{ workdir: string; assetCount: number }> {
    const hydrated = await hydrateJob({
      storage: countingStorage(),
      assets: assetsRepo(),
      repoRoot,
      workspaceId: "ws_1",
      row: { id: renderId, projectId: "prj_1", compId: "Main" },
      version: { objectKey: "versions/v1" },
    });
    return { workdir: hydrated.workdir, assetCount: hydrated.assetCount };
  }

  it("cache-cold downloads once and PUBLISHES the cache entry", async () => {
    const first = await hydrate("rnd_cold");
    expect(first.assetCount).toBe(1);
    // version + asset = exactly two object reads; the project bytes are NOT
    // cached (versions are per-render pinned and cheap relative to assets).
    expect(storageReads).toEqual(["versions/v1", "assets/photo"]);
    // The workdir carries the bytes under the sanitized browser name.
    expect(readFileSync(join(first.workdir, "photo.png"), "utf8")).toBe("fake-png-bytes-perf03");
    // And the cache entry exists, keyed by content sha256.
    const cachePath = join(assetCacheRoot(repoRoot), assetRow().sha256);
    expect(readFileSync(cachePath, "utf8")).toBe("fake-png-bytes-perf03");
    rmSync(first.workdir, { recursive: true, force: true });
  });

  it("cache-warm renders read ZERO asset objects (the whole point)", async () => {
    const second = await hydrate("rnd_warm");
    expect(second.assetCount).toBe(1);
    // Only the pinned version crosses the storage seam this time.
    expect(storageReads).toEqual(["versions/v1"]);
    expect(readFileSync(join(second.workdir, "photo.png"), "utf8")).toBe("fake-png-bytes-perf03");
    rmSync(second.workdir, { recursive: true, force: true });
  });
});
