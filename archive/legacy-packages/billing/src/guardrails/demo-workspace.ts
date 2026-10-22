// @studio/billing — the shared demo-workspace policy (W9-N).
//
// Spec anchors:
//   §16.2  the landing page's interactive demo: "embed the static wasm editor
//          (free, no backend) plus a capped 'try the agent' flow on a shared
//          demo workspace (N runs/day, global kill switch, watermarked
//          exports)". The marketing site never calls paid APIs directly —
//          everything goes through this ONE shared demo workspace.
//   §18.4  "One shared demo account with a fixed small credit grant; demos are
//          rate-limited… the 'try the agent' demo is capped at N runs per day
//          platform-wide with a global kill switch."
//
// The three §16.2 knobs this module owns:
//   1. N runs/day — a GLOBAL total (all visitors share the demo workspace,
//      so the counter is platform-wide, not per-user): DEMO_RUNS_PER_DAY.
//   2. Watermarked exports — the export pipeline reads `exportWatermarkFor`
//      and stamps the watermark when `required` is true (WatermarkLike note
//      contract below).
//   3. Global kill switch — env `DEMO_ENABLED`; the whole demo flow refuses
//      when it is off. Env parsing is the @studio/config owner's job
//      (flagged in the worklog); `parseDemoEnabled` is the pure parser.
//
// The demo org is also a WORKSPACE, so the §18.4 admin kill switch still
// applies to it: pass an `isDisabled` seam (DailySpendGuard's) and the demo
// route gets the same `disabled_workspace` verdict as everyone else.
//
// Failure mode: the run-counter seam fails OPEN (rate-limit middleware
// precedent — abuse protection must not turn a counter blip into a marketing
// outage). The kill switch itself is env-parsed config, not a seam.

import { nextUtcMidnightIso } from "./daily-caps.js";
import {
  type GuardrailResult,
  guardrailErr,
  guardrailOk,
  isValidOrgId,
  sanitizeCounter,
} from "./types.js";

// ---------------------------------------------------------------------------
// The shared demo workspace (§16.2)
// ---------------------------------------------------------------------------

/**
 * THE demo organization id: the one shared workspace the landing page's
 * "try the agent" flow runs in (§16.2 "a shared demo workspace"). Provisioned
 * once by ops; a reserved slug so it can never collide with a member org id.
 */
export const DEMO_ORG_ID = "demo-workspace";

/** Is this org the shared demo workspace? (Export pipeline + routes gate on this.) */
export function isDemoWorkspace(orgId: string): boolean {
  return orgId === DEMO_ORG_ID;
}

// ---------------------------------------------------------------------------
// N runs/day, platform-wide (§16.2/§18.4)
// ---------------------------------------------------------------------------

/**
 * The demo run budget: N runs per day, GLOBAL total across all visitors
 * (§16.2 "N runs/day"; §18.4 "capped at N runs per day platform-wide").
 * N = 10 per the W9-N task brief. The window is the §12 UTC rollup day.
 */
export const DEMO_RUNS_PER_DAY = 10;

// ---------------------------------------------------------------------------
// Watermarked exports (§16.2) — the WatermarkLike note contract
// ---------------------------------------------------------------------------

/**
 * The note contract the EXPORT PIPELINE consumes (§16.2 "watermarked
 * exports"): `required` flags whether the export must carry a watermark;
 * `text` is the stamp copy. Export owners read the flag from
 * `exportWatermarkFor(orgId)` and apply their own compositing — this module
 * never touches pixels (§25: no LLM pixel painting; a static text stamp is
 * the pipeline's job).
 *
 * `text` is user-facing copy: product-neutral, no codenames (§1.5/AGENTS.md —
 * "studio" is internal-only), no competitor names (§16.2 truthfulness).
 */
export interface WatermarkLike {
  /** True → the export MUST be stamped (demo workspace exports, §16.2). */
  readonly required: boolean;
  /** The watermark copy stamped when `required`; empty string when not. */
  readonly text: string;
}

/** The demo watermark: every export from the shared demo workspace (§16.2). */
export const DEMO_EXPORT_WATERMARK: WatermarkLike = {
  required: true,
  text: "Demo export",
};

/** Plain exports: every workspace that is not the demo org (§16.2). */
const NO_WATERMARK: WatermarkLike = { required: false, text: "" };

/**
 * The one lookup the export pipeline calls: does THIS org's export need a
 * watermark? (§16.2: demo exports are watermarked; paid workspaces are not —
 * §14.1 even gates watermark-free export fidelity by plan.)
 */
export function exportWatermarkFor(orgId: string): WatermarkLike {
  return isDemoWorkspace(orgId) ? DEMO_EXPORT_WATERMARK : NO_WATERMARK;
}

// ---------------------------------------------------------------------------
// Global kill switch — env DEMO_ENABLED (§16.2/§18.4)
// ---------------------------------------------------------------------------

/** The env var that turns the whole demo flow off (ops lever, no deploy). */
export const DEMO_KILL_SWITCH_ENV_VAR = "DEMO_ENABLED";

const DEMO_DISABLED_VALUES = new Set(["false", "0", "off", "no"]);

/**
 * Parses the global kill switch (§16.2 "global kill switch"): the demo is
 * ENABLED unless DEMO_ENABLED explicitly says otherwise (`false`/`0`/`off`/
 * `no`, case-insensitive, whitespace-trimmed). Absent or any other value →
 * enabled — a missing env var must not silently take the marketing demo
 * down; turning it off must be a deliberate, greppable change.
 */
export function parseDemoEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  const raw = env[DEMO_KILL_SWITCH_ENV_VAR];
  if (raw === undefined) {
    return true;
  }
  return !DEMO_DISABLED_VALUES.has(raw.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/** Everything the demo policy needs from the outside world (injected). */
export interface DemoWorkspaceSeams {
  /**
   * Runs started in the demo workspace since 00:00 UTC — the GLOBAL counter
   * (§18.4 "platform-wide"), backed by the §12 runs/usage_daily rollup.
   */
  countRunsToday(): Promise<number>;
  /** Wall clock, epoch ms (deterministic tests). */
  now(): number;
  /**
   * OPTIONAL reuse of the §18.4 workspace kill-switch seam
   * (DailySpendSeams.isDisabled): when provided, the demo org is also
   * rejected while an admin has it disabled. Omit to skip that check.
   */
  isDisabled?(orgId: string): Promise<boolean>;
}

/** Facts on an allowed demo run — for the "X of N runs today" counter UI. */
export interface DemoRunFacts {
  readonly runsToday: number;
  readonly cap: number;
  readonly resetAtIso: string;
}

// ---------------------------------------------------------------------------
// DemoWorkspacePolicy
// ---------------------------------------------------------------------------

/**
 * The §16.2 "try the agent" gate: global kill switch → workspace kill switch
 * (optional seam) → N-runs/day global cap, in that order (static checks first
 * so an off demo never touches the counter — limits-service checkRunIntake
 * precedent).
 */
export class DemoWorkspacePolicy {
  private readonly seams: DemoWorkspaceSeams;
  private readonly enabled: boolean;

  constructor(seams: DemoWorkspaceSeams, options: { readonly enabled?: boolean } = {}) {
    this.seams = seams;
    // Default: enabled. The wiring passes parseDemoEnabled(env) — the env
    // read itself belongs to the config owner (fail-fast env parsing, §4).
    this.enabled = options.enabled ?? true;
  }

  /** The global kill-switch verdict (§16.2): is the demo flow on at all? */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * May the landing page start one more "try the agent" run? Typed failures:
   *   `demo_disabled`      — global kill switch off (not retryable; ops lever)
   *   `disabled_workspace` — an admin disabled the shared demo workspace
   *   `demo_cap_reached`   — N runs/day exhausted (retryable, reset-at hint)
   */
  async checkRun(): Promise<GuardrailResult<DemoRunFacts>> {
    if (!this.enabled) {
      return guardrailErr("demo_disabled", "The interactive demo is turned off.", {
        hint: "The demo is temporarily unavailable. Please check back later.",
        retryable: false,
      });
    }

    if (this.seams.isDisabled !== undefined) {
      try {
        if (await this.seams.isDisabled(DEMO_ORG_ID)) {
          return guardrailErr("disabled_workspace", "The demo workspace is disabled.", {
            hint: "The demo is temporarily unavailable. Please check back later.",
            retryable: false,
          });
        }
      } catch {
        // Fail open: admin-flag seam outage ≠ marketing outage (§18.4 kill
        // switch stays env-side, which cannot throw here).
      }
    }

    let runsToday = 0;
    try {
      runsToday = sanitizeCounter(await this.seams.countRunsToday());
    } catch {
      // Fail open: the counter is abuse protection on a free surface.
      runsToday = 0;
    }

    if (runsToday >= DEMO_RUNS_PER_DAY) {
      const resetAtIso = nextUtcMidnightIso(this.seams.now());
      return guardrailErr("demo_cap_reached", "The demo's daily run budget is used up.", {
        hint: `The demo allows ${DEMO_RUNS_PER_DAY} runs per day across all visitors. It resets at ${resetAtIso} — please try again tomorrow.`,
        retryable: true,
        resetAtIso,
      });
    }

    return guardrailOk({
      runsToday,
      cap: DEMO_RUNS_PER_DAY,
      resetAtIso: nextUtcMidnightIso(this.seams.now()),
    });
  }

  /**
   * The export gate for the demo org (§16.2 watermarked exports): exports are
   * ALLOWED but always stamped. The export pipeline applies the watermark per
   * the WatermarkLike contract.
   */
  exportWatermark(orgId: string = DEMO_ORG_ID): GuardrailResult<WatermarkLike> {
    if (!isValidOrgId(orgId)) {
      return guardrailErr("validation_failed", "Invalid workspace id.", {
        hint: "The export request is missing a valid workspace identifier.",
        retryable: false,
      });
    }
    return guardrailOk(exportWatermarkFor(orgId));
  }
}
