// @studio/worker — the studio-cli runner (docs/phases/m8-cli-spike.md §1–§3).
//
// Binary resolution (§1): STUDIO_ENGINE_CLI_PATH → <repo>/editor/target/release/
// studio-cli when present → bare `studio-cli` on PATH.
//
// The argv (§2): `--project <workdir>/project.ecproj render --comp <id>
// --format <h264|png> --out <path> [--fps N] [--start S] [--end S]
// [--resolution K] [--quality best|draft] --json --progress`. v1 maps
// mp4 → h264, png-seq → png (D-2: the worker NEVER passes other formats —
// the pipeline refuses them before spawn).
//
// Surfaces (§3): stderr `progress <done> <total> <elapsed> <left|->` lines
// (tolerant parse, non-matching lines ignored); stdout `--json` success
// `{"rendered":[{"comp","output","seconds"}]}` / failure `{"error": …}` +
// exit 1. CLI error text may contain ABSOLUTE PATHS (law #1) — it is mapped
// to typed RENDER_* codes here and never forwarded raw.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { RenderFailureCode } from "./errors.js";
import type { CompFacts } from "./hydrate.js";

// ───────────────────────────────────────────────────────────────────────────
// Binary resolution (spike §1)
// ───────────────────────────────────────────────────────────────────────────

export interface ResolvedCli {
  readonly path: string;
  readonly source: "env" | "repo-build" | "path";
}

export function resolveCliPath(cliPath: string | undefined, repoRoot: string): ResolvedCli {
  // Legacy deployments (pre-rename) set EFFECTCRAFT_CLI_PATH: honored for one release.
  if (cliPath === undefined && process.env.EFFECTCRAFT_CLI_PATH) {
    cliPath = process.env.EFFECTCRAFT_CLI_PATH;
  }
  if (cliPath !== undefined && cliPath.trim() !== "") {
    return { path: cliPath, source: "env" };
  }
  const repoBuild = join(repoRoot, "editor", "target", "release", "studio-cli");
  if (existsSync(repoBuild)) {
    return { path: repoBuild, source: "repo-build" };
  }
  return { path: "studio-cli", source: "path" };
}

// ───────────────────────────────────────────────────────────────────────────
// Settings → CLI knobs (spike §2 mapping rules)
// ───────────────────────────────────────────────────────────────────────────

/** The render-relevant subset of RENDER_SETTINGS_SCHEMA (validated upstream). */
export interface RenderKnobSettings {
  readonly timeFrom?: number | undefined;
  readonly timeTo?: number | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly frameRate?: number | undefined;
  readonly quality?: string | undefined;
}

export type EffectiveQuality = "draft" | "good" | "best";

export interface RenderKnobs {
  /** h264 for mp4, png for png-seq (the CLI format vocabulary). */
  readonly cliFormat: "h264" | "png";
  /** Present flags only — omitted means the comp's native value applies. */
  readonly flags: {
    readonly fps?: number;
    readonly start?: number;
    readonly end?: number;
    /** Long-edge scale factor vs the comp (spike §2 `--resolution <K>`). */
    readonly resolution?: number;
    /** The CLI has no "good": draft → draft, best → best, good → omit. */
    readonly quality?: "best" | "draft";
  };
  /** What the output will actually be — the ACTUAL-cost inputs (§10.2). */
  readonly effective: {
    readonly fps: number;
    readonly longEdgePx: number;
    readonly quality: EffectiveQuality;
    readonly outputSeconds: number;
  };
}

const GOOD: EffectiveQuality = "good";

/**
 * Derive CLI flags + effective render facts from the row's settings and the
 * hydrated comp's native facts (spike §2):
 * - width/height → a single long-edge `--resolution` scale factor (aspect
 *   preserved; default `full` at the comp's native size);
 * - quality `draft|good|best` → CLI `draft|best`, `good` omitted (renders at
 *   the default tier); the effective quality for COST keeps `good`;
 * - frameRate → `--fps`; effective fps falls back to the comp's native rate;
 * - timeFrom/timeTo → `--start/--end`; outputSeconds = the rendered range.
 */
export function resolveRenderKnobs(input: {
  format: string;
  settings: RenderKnobSettings;
  comp: CompFacts;
}): RenderKnobs {
  const { settings, comp } = input;
  const cliFormat = input.format === "png-seq" ? "png" : "h264";

  const fps =
    settings.frameRate !== undefined && settings.frameRate > 0
      ? settings.frameRate
      : comp.frameRate > 0
        ? comp.frameRate
        : 30; // defensive: unreachable (comp facts always carry a rate)

  const start = settings.timeFrom !== undefined ? settings.timeFrom : undefined;
  const end = settings.timeTo !== undefined ? settings.timeTo : undefined;
  const outputSeconds = (end ?? comp.durationSeconds) - (start ?? 0);

  const compLongEdge = Math.max(comp.width, comp.height);
  const scaleX =
    settings.width !== undefined && settings.width > 0 ? settings.width / comp.width : 0;
  const scaleY =
    settings.height !== undefined && settings.height > 0 ? settings.height / comp.height : 0;
  const targetScale = Math.max(scaleX, scaleY);
  let resolution: number | undefined;
  let longEdgePx = compLongEdge;
  if (targetScale > 0) {
    // Uniform scale honoring the LARGER relative request (the CLI's --resolution
    // is one factor): 1920×1080 on a 640×360 comp → 3; height-only 180 → 0.5.
    resolution = targetScale;
    longEdgePx = Math.round(compLongEdge * targetScale);
  }

  const quality: EffectiveQuality =
    settings.quality === "draft" || settings.quality === "best" ? settings.quality : GOOD;

  const flags: {
    fps?: number;
    start?: number;
    end?: number;
    resolution?: number;
    quality?: "best" | "draft";
  } = {};
  if (fps !== comp.frameRate) flags.fps = fps;
  if (start !== undefined) flags.start = start;
  if (end !== undefined) flags.end = end;
  if (resolution !== undefined) flags.resolution = resolution;
  // The CLI has no "good": draft → draft, best → best, good → omit (renders
  // at the default tier). The EFFECTIVE quality (cost) keeps `good`.
  if (quality === "draft" || quality === "best") flags.quality = quality;

  return {
    cliFormat,
    flags,
    effective: {
      fps,
      longEdgePx: Math.max(1, longEdgePx),
      quality,
      outputSeconds,
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Output paths (spike §2/§5)
// ───────────────────────────────────────────────────────────────────────────

export interface RenderOutputPaths {
  /** `--out` value: out.mp4, or the sequence stem (writes frame_00000.png …). */
  readonly outPath: string;
  /** mp4: the single output file. png-seq: the directory of frames to zip. */
  readonly mp4Path: string | null;
  readonly seqDir: string | null;
}

export function renderOutputPaths(format: string, workdir: string): RenderOutputPaths {
  if (format === "png-seq") {
    const seqDir = join(workdir, "seq");
    return { outPath: join(seqDir, "frame.png"), mp4Path: null, seqDir };
  }
  const mp4Path = join(workdir, "out.mp4");
  return { outPath: mp4Path, mp4Path, seqDir: null };
}

// ───────────────────────────────────────────────────────────────────────────
// The argv builder (spike §2 — exact grammar)
// ───────────────────────────────────────────────────────────────────────────

export interface RenderArgsInput {
  readonly projectPath: string;
  readonly outPath: string;
  readonly compId: string;
  readonly cliFormat: "h264" | "png";
  readonly flags: RenderKnobs["flags"];
}

export function buildRenderArgs(input: RenderArgsInput): string[] {
  const args = [
    "--project",
    input.projectPath,
    "render",
    "--comp",
    input.compId,
    "--format",
    input.cliFormat,
    "--out",
    input.outPath,
  ];
  if (input.flags.fps !== undefined) args.push("--fps", String(input.flags.fps));
  if (input.flags.start !== undefined) args.push("--start", String(input.flags.start));
  if (input.flags.end !== undefined) args.push("--end", String(input.flags.end));
  if (input.flags.resolution !== undefined) {
    args.push("--resolution", formatScale(input.flags.resolution));
  }
  if (input.flags.quality !== undefined) args.push("--quality", input.flags.quality);
  args.push("--json", "--progress");
  return args;
}

/** Up to 6 decimals, trailing zeros trimmed — the engine parses this as f64. */
export function formatScale(scale: number): string {
  if (!Number.isFinite(scale) || scale <= 0) return "1";
  return scale.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

// ───────────────────────────────────────────────────────────────────────────
// Progress line parser (spike §3 grammar, tolerant)
// ───────────────────────────────────────────────────────────────────────────

export interface ProgressLine {
  readonly framesDone: number;
  readonly framesTotal: number;
  readonly secondsElapsed: number;
  readonly secondsLeft: number | null;
}

const PROGRESS_RE = /^progress (\d+) (\d+) (\d+(?:\.\d+)?) (\d+(?:\.\d+)|-)$/;

/** `progress <done> <total> <elapsed> <left|->` — null for every other line. */
export function parseProgressLine(line: string): ProgressLine | null {
  const match = PROGRESS_RE.exec(line.trim());
  if (match === null) return null;
  const framesDone = Number(match[1]);
  const framesTotal = Number(match[2]);
  const secondsElapsed = Number(match[3]);
  if (!Number.isSafeInteger(framesDone) || !Number.isSafeInteger(framesTotal)) return null;
  const secondsLeft = match[4] === "-" ? null : Number(match[4]);
  return { framesDone, framesTotal, secondsElapsed, secondsLeft };
}

/**
 * Coalesce a high-frequency stream into ~1 callback/second WITHOUT dropping
 * the final value: while throttled the newest item is held and flushed by the
 * next `push` after the window (or explicitly by `flush`).
 */
export function createThrottledEmitter<T>(
  emit: (value: T) => void,
  intervalMs: number,
  clock: () => number = Date.now,
): { push(value: T): void; flush(): void } {
  let lastEmit = Number.NEGATIVE_INFINITY;
  let pending: T | undefined;
  return {
    push(value: T): void {
      pending = value;
      const now = clock();
      if (now - lastEmit >= intervalMs) {
        lastEmit = now;
        const item = pending;
        pending = undefined;
        emit(item);
      }
    },
    flush(): void {
      if (pending === undefined) return;
      lastEmit = clock();
      const item = pending;
      pending = undefined;
      emit(item);
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// stdout JSON shapes (spike §3)
// ───────────────────────────────────────────────────────────────────────────

export interface CliRenderedEntry {
  readonly comp: string;
  readonly output: string;
  readonly seconds: number;
}

export type CliStdout =
  | { readonly kind: "success"; readonly rendered: readonly CliRenderedEntry[] }
  | { readonly kind: "failure"; readonly message: string };

/** Parse the CLI's `--json` stdout: success / failure / null (not the shape). */
export function parseCliStdout(stdout: string): CliStdout | null {
  const text = stdout.trim();
  if (text === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (Array.isArray(record.rendered)) {
    const rendered = record.rendered
      .filter(
        (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null,
      )
      .map((entry) => ({
        comp: String(entry.comp ?? ""),
        output: String(entry.output ?? ""),
        seconds: Number(entry.seconds ?? 0),
      }));
    return { kind: "success", rendered };
  }
  if (typeof record.error === "string") {
    return { kind: "failure", message: record.error };
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// Failure classification (spike §3 → typed codes; law #1: never the raw text)
// ───────────────────────────────────────────────────────────────────────────

export function classifyCliFailure(input: {
  message: string;
  spawnCode?: string;
}): RenderFailureCode {
  if (input.spawnCode === "ENOENT") return "RENDER_CLI_MISSING";
  if (input.message.includes("is not a project")) return "RENDER_PROJECT_INVALID";
  return "RENDER_CLI_FAILED";
}

// ───────────────────────────────────────────────────────────────────────────
// The runner (detached process group, graceful kill)
// ───────────────────────────────────────────────────────────────────────────

export type KillReason = "cancel" | "timeout" | "lost";

export type CliRunResult =
  | { readonly kind: "success"; readonly rendered: readonly CliRenderedEntry[] }
  | {
      readonly kind: "failure";
      readonly code: RenderFailureCode;
      readonly exitCode: number | null;
      /** Raw CLI detail — LOG ONLY (absolute paths live here; law #1). */
      readonly raw: string;
    }
  | { readonly kind: "killed"; readonly reason: KillReason };

export interface RenderCliHandle {
  /** Resolves exactly once when the process exits (or failed to spawn). */
  readonly done: Promise<CliRunResult>;
  /** SIGTERM the process group, then SIGKILL after `graceMs`. Idempotent. */
  kill(reason: KillReason, graceMs?: number): void;
}

const KILL_GRACE_MS = 5_000;

export function spawnRenderCli(options: {
  cliPath: string;
  args: readonly string[];
  cwd?: string;
  onProgress?: (progress: ProgressLine) => void;
}): RenderCliHandle {
  let killed: KillReason | null = null;
  let killTimer: ReturnType<typeof setTimeout> | null = null;

  const child = spawn(options.cliPath, options.args, {
    cwd: options.cwd,
    detached: true, // own process group → the whole renderer dies on kill
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderrTail = "";
  const throttled =
    options.onProgress === undefined ? null : createThrottledEmitter(options.onProgress, 1_000);

  const done = new Promise<CliRunResult>((resolve) => {
    const settle = (result: CliRunResult): void => {
      if (throttled !== null) throttled.flush();
      resolve(result);
    };

    child.on("error", (error: NodeJS.ErrnoException) => {
      // Spawn failures (ENOENT, EACCES) — the process never existed.
      settle({
        kind: "failure",
        code: classifyCliFailure({ message: error.message, spawnCode: error.code }),
        exitCode: null,
        raw: error.message,
      });
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (throttled !== null) {
        for (const line of text.split("\n")) {
          const progress = parseProgressLine(line);
          if (progress !== null) throttled.push(progress);
        }
      }
      stderrTail = (stderrTail + text).slice(-2_000);
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.on("exit", (code, signal) => {
      if (killTimer !== null) clearTimeout(killTimer);
      if (killed !== null) {
        settle({ kind: "killed", reason: killed });
        return;
      }
      const parsed = parseCliStdout(stdout);
      if (code === 0) {
        if (parsed !== null && parsed.kind === "success") {
          settle({ kind: "success", rendered: parsed.rendered });
          return;
        }
        settle({
          kind: "failure",
          code: classifyCliFailure({ message: parsed?.kind === "failure" ? parsed.message : "" }),
          exitCode: code,
          raw: parsed === null ? stdout.slice(0, 500) : stdout,
        });
        return;
      }
      // Non-zero exit: prefer the JSON error object, fall back to stderr tail
      // (usage errors print nothing on stdout) — for classification only.
      const message = parsed?.kind === "failure" ? parsed.message : stderrTail;
      settle({
        kind: "failure",
        code: classifyCliFailure({ message }),
        exitCode: code ?? (signal === null ? null : -1),
        raw: message || `exit ${code ?? "?"} signal ${signal ?? "none"}`,
      });
    });
  });

  const signalGroup = (signal: NodeJS.Signals): void => {
    const pid = child.pid;
    try {
      // Negative pid = the process group (the detached child leads it).
      if (pid === undefined) throw new Error("not started");
      process.kill(-pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    }
  };

  return {
    done,
    kill(reason: KillReason, graceMs: number = KILL_GRACE_MS): void {
      if (killed !== null) return; // first kill wins
      killed = reason;
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => signalGroup("SIGKILL"), graceMs);
      killTimer.unref?.();
    },
  };
}
