// Unit tests — hydration's PURE surface (spike §4): the browser-path rewrite
// (single-segment strips, deep paths untouched, sequence arrays), comp facts
// (id-or-name lookup, ticks → seconds), malformed-project typing, and the
// sanitizeAssetName seam pin (the worker writes asset files under EXACTLY the
// name the browser editor assigned).

import { describe, expect, it } from "vitest";

import { sanitizeAssetName } from "@studio/editor-bridge";

import { isRenderJobError } from "../src/errors.js";
import {
  type CompFacts,
  parseCompFacts,
  parseProjectJson,
  rewriteFootagePaths,
  stripLeadingSlashPath,
} from "../src/hydrate.js";
import { outputObjectKey, renderOutputExt } from "../src/storage.js";

const TICKS_PER_SECOND = 254_016_000_000;

/** A minimal browser-shaped .ecproj (items keyed by id, kind objects). */
function browserProject(): Record<string, unknown> {
  return {
    savedBy: "0.13.0",
    schema: 2,
    items: {
      1: {
        id: 1,
        name: "photo.png",
        kind: { type: "Footage", path: "/photo.png", missing: false },
      },
      2: {
        id: 2,
        name: "burst",
        kind: {
          type: "Footage",
          path: "/burst_0000.png",
          sequence: ["/burst_0000.png", "/burst_0001.png", "deep/keep.png"],
          missing: false,
        },
      },
      3: {
        id: 3,
        name: "Main",
        kind: {
          type: "Comp",
          width: 640,
          height: 360,
          frame_rate: { num: 30000, den: 1001 },
          duration: Math.round(2.002 * TICKS_PER_SECOND),
          layers: [],
        },
      },
    },
  };
}

describe("stripLeadingSlashPath (spike §4 rule)", () => {
  it("strips single-segment virtual paths", () => {
    expect(stripLeadingSlashPath("/photo.png")).toBe("photo.png");
    expect(stripLeadingSlashPath("/a")).toBe("a");
  });

  it("leaves relative, deep, and bare-slash paths untouched", () => {
    expect(stripLeadingSlashPath("photo.png")).toBeNull();
    expect(stripLeadingSlashPath("/deep/path.png")).toBeNull();
    expect(stripLeadingSlashPath("/")).toBeNull();
    expect(stripLeadingSlashPath("")).toBeNull();
  });
});

describe("rewriteFootagePaths (the proven leading-slash fix)", () => {
  it("rewrites Footage paths AND sequence entries; deep paths survive", () => {
    const project = browserProject();
    const result = rewriteFootagePaths(project);
    expect(result.rewritten).toBe(4); // photo path + burst path + 2 sequence entries
    const items = project.items as Record<string, { kind: Record<string, unknown> }>;
    const footage1 = items["1"]?.kind;
    const footage2 = items["2"]?.kind;
    expect(footage1?.path).toBe("photo.png");
    expect(footage2?.path).toBe("burst_0000.png");
    expect(footage2?.sequence).toEqual(["burst_0000.png", "burst_0001.png", "deep/keep.png"]);
  });

  it("returns the SAME object with zero rewrites when nothing matches", () => {
    const clean = {
      items: {
        1: { id: 1, name: "a.png", kind: { type: "Footage", path: "a.png" } },
      },
    };
    const result = rewriteFootagePaths(clean);
    expect(result.rewritten).toBe(0);
    expect(result.project).toBe(clean);
  });

  it("is a no-op for native-saved projects (absolute local paths)", () => {
    const native = {
      items: {
        1: { id: 1, kind: { type: "Footage", path: "/srv/proj/photo.png" } },
      },
    };
    expect(rewriteFootagePaths(native).rewritten).toBe(0);
    expect((native.items as Record<string, { kind: { path: string } }>)["1"]?.kind.path).toBe(
      "/srv/proj/photo.png",
    );
  });

  it("skips non-Footage kinds and tolerant-shape items", () => {
    const odd = {
      items: {
        1: { id: 1, kind: { type: "Solid", path: "/solid.png" } },
        2: "not an item",
        3: { kind: null },
      },
    };
    expect(rewriteFootagePaths(odd).rewritten).toBe(0);
  });

  it("throws TYPED RENDER_PROJECT_INVALID for a non-project shape", () => {
    for (const bad of [{}, { items: "nope" }, [], "string"]) {
      try {
        rewriteFootagePaths(bad);
        expect.unreachable("must throw");
      } catch (error) {
        expect(isRenderJobError(error)).toBe(true);
        expect((error as { code?: string }).code).toBe("RENDER_PROJECT_INVALID");
      }
    }
  });
});

describe("parseProjectJson (malformed version bytes → typed)", () => {
  it("parses valid JSON", () => {
    expect(parseProjectJson(Buffer.from(JSON.stringify(browserProject())))).toBeTypeOf("object");
  });

  it("throws a typed RENDER_PROJECT_INVALID for garbage bytes", () => {
    // (f) of the dispatch's integration matrix, proven at the unit level too.
    try {
      parseProjectJson(Buffer.from("<html>definitely not json"));
      expect.unreachable("must throw");
    } catch (error) {
      expect(isRenderJobError(error)).toBe(true);
      expect((error as { code?: string }).code).toBe("RENDER_PROJECT_INVALID");
    }
  });
});

describe("parseCompFacts (id-or-name lookup, ticks → seconds)", () => {
  const project = browserProject();

  it("finds the comp by numeric id and by name — identical facts", () => {
    const byId = parseCompFacts(project, "3");
    const byName = parseCompFacts(project, "Main");
    expect(byId).toEqual(byName);
    const facts = byId as CompFacts;
    expect(facts.width).toBe(640);
    expect(facts.height).toBe(360);
    expect(facts.frameRate).toBeCloseTo(30000 / 1001, 9);
    expect(facts.durationSeconds).toBeCloseTo(2.002, 9);
  });

  it("returns null for a comp that is not in the project", () => {
    expect(parseCompFacts(project, "Missing")).toBeNull();
    expect(parseCompFacts(project, "")).toBeNull();
    expect(parseCompFacts(browserProject(), "1")).toBeNull(); // a Footage id, not a comp
  });

  it("returns null for degenerate comp shapes", () => {
    expect(parseCompFacts({ items: {} }, "x")).toBeNull();
    expect(parseCompFacts({ items: { a: { kind: { type: "Comp" } } } }, "x")).toBeNull();
    expect(parseCompFacts(null, "x")).toBeNull();
    expect(parseCompFacts({ items: null }, "x")).toBeNull();
  });
});

describe("sanitizeAssetName seam (the browser-assigned name, exact)", () => {
  it("is exported by @studio/editor-bridge and behaves as the editor does", () => {
    expect(sanitizeAssetName("photo.png")).toBe("photo.png");
    expect(sanitizeAssetName("My Photo.PNG")).toBe("My-Photo.PNG");
    expect(sanitizeAssetName("../evil/x.png")).toBe("evil-x.png");
    expect(sanitizeAssetName("a  b.png")).toBe("a-b.png");
    expect(sanitizeAssetName("...")).toBe("asset");
    expect(sanitizeAssetName("")).toBe("asset");
  });
});

describe("output key derivation (§9.2, deterministic per render)", () => {
  it("maps formats to output extensions (png-seq zips → .zip, spike §5)", () => {
    expect(renderOutputExt("mp4")).toBe("mp4");
    expect(renderOutputExt("png-seq")).toBe("zip");
  });

  it("reuses the row's pre-created key; else derives the SAME key on every attempt", () => {
    const ws = "ws_demo";
    const row = { objectKey: null, projectId: "prj_1", id: "rdr_1", format: "mp4" };
    const first = outputObjectKey(row, ws);
    const second = outputObjectKey(row, ws);
    expect(first).toBe(second);
    expect(first).toBe(`workspaces/${ws}/projects/prj_1/renders/rdr_1/output.mp4`);
    expect(outputObjectKey({ ...row, objectKey: "pre/created.mp4" }, ws)).toBe("pre/created.mp4");
    expect(outputObjectKey({ ...row, format: "png-seq" }, ws)).toBe(
      `workspaces/${ws}/projects/prj_1/renders/rdr_1/output.zip`,
    );
  });
});
