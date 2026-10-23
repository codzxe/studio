// Unit tests — the CLI runner surface (spike §1–§3). Deterministic, no
// process spawns, no DB: resolution order, knob derivation, argv grammar,
// progress parsing, stdout shapes, failure classification.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildRenderArgs,
  classifyCliFailure,
  createThrottledEmitter,
  formatScale,
  parseCliStdout,
  parseProgressLine,
  renderOutputPaths,
  resolveCliPath,
  resolveRenderKnobs,
} from "../src/cli.js";

const COMP = { width: 640, height: 360, frameRate: 30000 / 1001, durationSeconds: 2.002 };

describe("resolveCliPath (spike §1 order)", () => {
  it("uses the env value verbatim when set", () => {
    expect(resolveCliPath("/opt/custom/effectcraft-cli", "/repo")).toEqual({
      path: "/opt/custom/effectcraft-cli",
      source: "env",
    });
  });

  it("falls back to the repo release build when present", () => {
    const root = mkdtempSync(join(tmpdir(), "cli-resolve-"));
    try {
      mkdirSync(join(root, "editor", "target", "release"), { recursive: true });
      const bin = join(root, "editor", "target", "release", "effectcraft-cli");
      writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
      expect(resolveCliPath(undefined, root)).toEqual({ path: bin, source: "repo-build" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to PATH when the repo build is absent", () => {
    const missingRoot = join(tmpdir(), "definitely-not-a-repo");
    expect(resolveCliPath(undefined, missingRoot)).toEqual({
      path: "effectcraft-cli",
      source: "path",
    });
  });

  it("treats a blank env value as unset (the .env.example default)", () => {
    const root = mkdtempSync(join(tmpdir(), "cli-resolve-"));
    try {
      mkdirSync(join(root, "editor", "target", "release"), { recursive: true });
      writeFileSync(join(root, "editor", "target", "release", "effectcraft-cli"), "#!/bin/sh\n", {
        mode: 0o755,
      });
      expect(resolveCliPath("  ", root).source).toBe("repo-build");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveRenderKnobs (spike §2 mapping)", () => {
  it("mp4 → h264; native defaults produce no flags", () => {
    const knobs = resolveRenderKnobs({ format: "mp4", settings: {}, comp: COMP });
    expect(knobs.cliFormat).toBe("h264");
    expect(knobs.flags).toEqual({});
    expect(knobs.effective).toEqual({
      fps: COMP.frameRate,
      longEdgePx: 640,
      quality: "good",
      outputSeconds: 2.002,
    });
  });

  it("png-seq → png; explicit fps/quality/range map to flags", () => {
    const knobs = resolveRenderKnobs({
      format: "png-seq",
      settings: { frameRate: 24, quality: "best", timeFrom: 0.5, timeTo: 1.5 },
      comp: COMP,
    });
    expect(knobs.cliFormat).toBe("png");
    expect(knobs.flags).toEqual({ fps: 24, start: 0.5, end: 1.5, quality: "best" });
    expect(knobs.effective).toEqual({
      fps: 24,
      longEdgePx: 640,
      quality: "best",
      outputSeconds: 1,
    });
  });

  it("quality `draft` maps to --quality draft; `good` maps to NO flag but stays the effective cost quality", () => {
    const draft = resolveRenderKnobs({ format: "mp4", settings: { quality: "draft" }, comp: COMP });
    expect(draft.flags.quality).toBe("draft");
    expect(draft.effective.quality).toBe("draft");
    const good = resolveRenderKnobs({ format: "mp4", settings: { quality: "good" }, comp: COMP });
    expect(good.flags.quality).toBeUndefined();
    expect(good.effective.quality).toBe("good");
  });

  it("width/height → a single long-edge --resolution scale factor", () => {
    const knobs = resolveRenderKnobs({
      format: "mp4",
      settings: { width: 1920, height: 1080 },
      comp: COMP,
    });
    expect(knobs.flags.resolution).toBeCloseTo(3, 6);
    expect(knobs.effective.longEdgePx).toBe(1920);
  });

  it("height-only requests still scale by the long edge (aspect preserved)", () => {
    const knobs = resolveRenderKnobs({ format: "mp4", settings: { height: 180 }, comp: COMP });
    expect(knobs.flags.resolution).toBeCloseTo(0.5, 6);
    expect(knobs.effective.longEdgePx).toBe(320);
  });

  it("an fps equal to the comp rate omits --fps (native)", () => {
    const knobs = resolveRenderKnobs({
      format: "mp4",
      settings: { frameRate: COMP.frameRate },
      comp: COMP,
    });
    expect(knobs.flags.fps).toBeUndefined();
    expect(knobs.effective.fps).toBe(COMP.frameRate);
  });
});

describe("renderOutputPaths (spike §2/§5)", () => {
  it("mp4 renders a single out.mp4 in the workdir", () => {
    expect(renderOutputPaths("mp4", "/w")).toEqual({
      outPath: "/w/out.mp4",
      mp4Path: "/w/out.mp4",
      seqDir: null,
    });
  });

  it("png-seq renders a sequence stem whose frames zip into one artifact", () => {
    expect(renderOutputPaths("png-seq", "/w")).toEqual({
      outPath: "/w/seq/frame.png",
      mp4Path: null,
      seqDir: "/w/seq",
    });
  });
});

describe("buildRenderArgs (spike §2 exact grammar)", () => {
  it("mp4: --project, render, --comp, --format h264, --out, then --json --progress", () => {
    expect(
      buildRenderArgs({
        projectPath: "/w/project.ecproj",
        outPath: "/w/out.mp4",
        compId: "Main",
        cliFormat: "h264",
        flags: {},
      }),
    ).toEqual([
      "--project",
      "/w/project.ecproj",
      "render",
      "--comp",
      "Main",
      "--format",
      "h264",
      "--out",
      "/w/out.mp4",
      "--json",
      "--progress",
    ]);
  });

  it("png-seq with every flag present, in the pinned order", () => {
    expect(
      buildRenderArgs({
        projectPath: "/w/project.ecproj",
        outPath: "/w/seq/frame.png",
        compId: "2",
        cliFormat: "png",
        flags: { fps: 30, start: 1, end: 2, resolution: 1.5, quality: "draft" },
      }),
    ).toEqual([
      "--project",
      "/w/project.ecproj",
      "render",
      "--comp",
      "2",
      "--format",
      "png",
      "--out",
      "/w/seq/frame.png",
      "--fps",
      "30",
      "--start",
      "1",
      "--end",
      "2",
      "--resolution",
      "1.5",
      "--quality",
      "draft",
      "--json",
      "--progress",
    ]);
  });

  it("never emits any other format (D-2)", () => {
    const args = buildRenderArgs({
      projectPath: "/w/p.ecproj",
      outPath: "/w/out.mp4",
      compId: "Main",
      cliFormat: "h264",
      flags: {},
    });
    expect(args.join(" ")).not.toMatch(/prores|webm|gif|wav|av1|hevc/);
  });
});

describe("formatScale", () => {
  it("trims trailing zeros and keeps up to 6 decimals", () => {
    expect(formatScale(3)).toBe("3");
    expect(formatScale(1.5)).toBe("1.5");
    expect(formatScale(1 / 3)).toBe("0.333333");
    expect(formatScale(0.0625)).toBe("0.0625");
  });
  it("degenerate scales fall back to 1 (full)", () => {
    expect(formatScale(Number.NaN)).toBe("1");
    expect(formatScale(0)).toBe("1");
    expect(formatScale(-2)).toBe("1");
  });
});

describe("parseProgressLine (spike §3 grammar, tolerant)", () => {
  it("parses the four-field grammar", () => {
    expect(parseProgressLine("progress 50 60 0.3 0.1")).toEqual({
      framesDone: 50,
      framesTotal: 60,
      secondsElapsed: 0.3,
      secondsLeft: 0.1,
    });
  });

  it("accepts the `-` unknown-time-left marker", () => {
    expect(parseProgressLine("progress 0 899 0.0 -")).toEqual({
      framesDone: 0,
      framesTotal: 899,
      secondsElapsed: 0,
      secondsLeft: null,
    });
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseProgressLine("  progress 1 2 0.1 -  \n")).not.toBeNull();
  });

  it("ignores every non-matching line (banner, done:, empty, engine chatter)", () => {
    for (const line of [
      "",
      "progress",
      "progress 50 60",
      "progress 50 60 0.3",
      "progress 50 60 0.3 0.1 extra",
      "progress done total elapsed left",
      "done: Main → /tmp/out.mp4 in 0.37s",
      "Main → out.mp4 (640×360, 60 frames, H.264)",
      "progress 1.5 60 0.3 -",
      "progressx 1 2 0.3 -",
      "progress -1 60 0.3 -",
      "progress 99999999999999999999999 60 0.3 -",
    ]) {
      expect(parseProgressLine(line)).toBeNull();
    }
  });
});

describe("createThrottledEmitter (~1/s, final value never dropped)", () => {
  it("emits the first item immediately, then at most one per window", () => {
    let now = 1_000;
    const emitted: string[] = [];
    const throttled = createThrottledEmitter<string>(
      (v) => emitted.push(v),
      1_000,
      () => now,
    );
    throttled.push("a");
    now += 100;
    throttled.push("b");
    now += 100;
    throttled.push("c");
    expect(emitted).toEqual(["a"]);

    now += 900; // 1100ms since first emit → window open
    throttled.push("d");
    expect(emitted).toEqual(["a", "d"]);

    now += 100; // inside the window again — held
    throttled.push("e");
    expect(emitted).toEqual(["a", "d"]);
    throttled.flush();
    expect(emitted).toEqual(["a", "d", "e"]);
  });

  it("flush is a no-op without a pending item", () => {
    const emitted: number[] = [];
    const throttled = createThrottledEmitter<number>(
      (v) => emitted.push(v),
      1_000,
      () => 0,
    );
    throttled.push(1);
    throttled.flush();
    throttled.flush();
    expect(emitted).toEqual([1]);
  });
});

describe("parseCliStdout (spike §3 JSON surfaces)", () => {
  it('parses success: {"rendered":[{comp,output,seconds}]}', () => {
    expect(
      parseCliStdout('{"rendered":[{"comp":"Main","output":"/x/out.mp4","seconds":0.37}]}\n'),
    ).toEqual({
      kind: "success",
      rendered: [{ comp: "Main", output: "/x/out.mp4", seconds: 0.37 }],
    });
  });

  it('parses failure: {"error":"…"}', () => {
    expect(parseCliStdout('{"error":"boom"}')).toEqual({ kind: "failure", message: "boom" });
  });

  it("returns null for empty, non-JSON or foreign shapes", () => {
    expect(parseCliStdout("")).toBeNull();
    expect(parseCliStdout("not json")).toBeNull();
    expect(parseCliStdout("[1,2,3]")).toBeNull();
    expect(parseCliStdout('{"other":true}')).toBeNull();
  });
});

describe("classifyCliFailure (typed codes, never raw text)", () => {
  it("spawn ENOENT → RENDER_CLI_MISSING", () => {
    expect(classifyCliFailure({ message: "any", spawnCode: "ENOENT" })).toBe("RENDER_CLI_MISSING");
  });

  it('"is not a project" engine error → RENDER_PROJECT_INVALID', () => {
    expect(
      classifyCliFailure({
        message: "/abs/path.ecproj is not a project Studio can open: expected value",
      }),
    ).toBe("RENDER_PROJECT_INVALID");
  });

  it("every other failure → RENDER_CLI_FAILED", () => {
    expect(classifyCliFailure({ message: "render queue failed" })).toBe("RENDER_CLI_FAILED");
    expect(classifyCliFailure({ message: "", spawnCode: "EACCES" })).toBe("RENDER_CLI_FAILED");
  });
});
