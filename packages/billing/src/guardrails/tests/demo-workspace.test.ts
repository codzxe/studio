// The shared demo-workspace policy (§16.2/§18.4): the reserved demo org id,
// the N=10 runs/day GLOBAL cap, watermarked exports (WatermarkLike contract),
// the DEMO_ENABLED global kill switch, and gate ordering/hints over
// in-memory seams.

import { describe, expect, it } from "vitest";
import {
  DEMO_EXPORT_WATERMARK,
  DEMO_KILL_SWITCH_ENV_VAR,
  DEMO_ORG_ID,
  DEMO_RUNS_PER_DAY,
  DemoWorkspacePolicy,
  exportWatermarkFor,
  isDemoWorkspace,
  parseDemoEnabled,
  type WatermarkLike,
} from "../demo-workspace.js";
import { InMemoryDemoSeams, expectErr, expectOk } from "./fakes.js";

function makePolicy(
  init: { runsToday?: number; enabled?: boolean; demoOrgDisabled?: boolean } = {},
): { policy: DemoWorkspacePolicy; seams: InMemoryDemoSeams } {
  const seams = new InMemoryDemoSeams();
  seams.runsToday = init.runsToday ?? 0;
  seams.demoOrgDisabled = init.demoOrgDisabled ?? false;
  const policy = new DemoWorkspacePolicy(seams, { enabled: init.enabled ?? true });
  return { policy, seams };
}

// ---------------------------------------------------------------------------
// The shared demo workspace + the §16.2 caps
// ---------------------------------------------------------------------------

describe("demo workspace identity + caps (§16.2)", () => {
  it("reserves one stable demo org id and only that org is the demo", () => {
    expect(DEMO_ORG_ID).toBe("demo-workspace");
    expect(isDemoWorkspace(DEMO_ORG_ID)).toBe(true);
    expect(isDemoWorkspace("org_12345")).toBe(false);
    expect(isDemoWorkspace("")).toBe(false);
  });

  it("pins the platform-wide N runs/day budget: N = 10 (§18.4)", () => {
    expect(DEMO_RUNS_PER_DAY).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Watermarked exports — the WatermarkLike note contract (§16.2)
// ---------------------------------------------------------------------------

describe("watermarked exports (§16.2 WatermarkLike contract)", () => {
  const watermarkRows: readonly { orgId: string; expected: WatermarkLike }[] = [
    { orgId: DEMO_ORG_ID, expected: { required: true, text: "Demo export" } },
    { orgId: "org_12345", expected: { required: false, text: "" } },
  ];
  for (const row of watermarkRows) {
    it(`exportWatermarkFor(${JSON.stringify(row.orgId)}) → ${row.expected.required ? "watermarked" : "plain"}`, () => {
      expect(exportWatermarkFor(row.orgId)).toEqual(row.expected);
    });
  }

  it("the demo watermark copy is user-facing: non-empty, no codenames or competitor names (§1.5/§16.2)", () => {
    expect(DEMO_EXPORT_WATERMARK.required).toBe(true);
    expect(DEMO_EXPORT_WATERMARK.text.length).toBeGreaterThan(0);
    const banned = ["studio", "photocraft", "artcraft", "photoshop", "cursor"];
    for (const word of banned) {
      expect(DEMO_EXPORT_WATERMARK.text.toLowerCase()).not.toContain(word);
    }
  });

  it("the policy surfaces the watermark through the typed result for the export pipeline", () => {
    const { policy } = makePolicy();
    expect(expectOk(policy.exportWatermark(DEMO_ORG_ID))).toEqual(DEMO_EXPORT_WATERMARK);
    const invalid = expectErr(policy.exportWatermark(""));
    expect(invalid.code).toBe("validation_failed");
  });
});

// ---------------------------------------------------------------------------
// Global kill switch — env DEMO_ENABLED (§16.2/§18.4)
// ---------------------------------------------------------------------------

describe("global kill switch DEMO_ENABLED (§16.2)", () => {
  it("names the env var and defaults the demo ON when the var is absent", () => {
    expect(DEMO_KILL_SWITCH_ENV_VAR).toBe("DEMO_ENABLED");
    expect(parseDemoEnabled({})).toBe(true);
    expect(parseDemoEnabled({ DEMO_ENABLED: undefined })).toBe(true);
  });

  const offRows = ["false", "0", "off", "no", "FALSE", "Off", " false "] as const;
  for (const value of offRows) {
    it(`DEMO_ENABLED=${JSON.stringify(value)} → demo off`, () => {
      expect(parseDemoEnabled({ DEMO_ENABLED: value })).toBe(false);
    });
  }

  const onRows = ["true", "1", "on", "yes", "enabled"] as const;
  for (const value of onRows) {
    it(`DEMO_ENABLED=${JSON.stringify(value)} → demo on`, () => {
      expect(parseDemoEnabled({ DEMO_ENABLED: value })).toBe(true);
    });
  }

  it("checkRun refuses everything while the kill switch is off, without touching the counter", async () => {
    const { policy, seams } = makePolicy({ enabled: false, runsToday: 0 });
    const failure = expectErr(await policy.checkRun());
    expect(failure.code).toBe("demo_disabled");
    expect(failure.retryable).toBe(false);
    expect(failure.hint).toContain("check back later");
    expect(seams.calls.countRunsToday).toBe(0);
    expect(policy.isEnabled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkRun: N runs/day global cap (+ optional §18.4 workspace kill switch)
// ---------------------------------------------------------------------------

describe("DemoWorkspacePolicy.checkRun (§16.2 N runs/day, global total)", () => {
  it("allows runs while the global counter is under N and reports the counter facts", async () => {
    const { policy } = makePolicy({ runsToday: DEMO_RUNS_PER_DAY - 1 });
    const facts = expectOk(await policy.checkRun());
    expect(facts).toEqual({
      runsToday: DEMO_RUNS_PER_DAY - 1,
      cap: DEMO_RUNS_PER_DAY,
      resetAtIso: "2027-03-15T00:00:00.000Z",
    });
  });

  it("blocks the Nth run with typed demo_cap_reached + reset-at hint (shared budget)", async () => {
    const { policy, seams } = makePolicy({ runsToday: DEMO_RUNS_PER_DAY });
    const failure = expectErr(await policy.checkRun());
    expect(failure.code).toBe("demo_cap_reached");
    expect(failure.retryable).toBe(true);
    expect(failure.resetAtIso).toBe("2027-03-15T00:00:00.000Z");
    expect(failure.hint).toContain("10 runs per day");
    expect(failure.hint).toContain("2027-03-15T00:00:00.000Z");
    expect(seams.calls.countRunsToday).toBe(1);
  });

  it("the §18.4 workspace kill switch also covers the demo org when the seam is provided", async () => {
    const { policy, seams } = makePolicy({ demoOrgDisabled: true, runsToday: 0 });
    const failure = expectErr(await policy.checkRun());
    expect(failure.code).toBe("disabled_workspace");
    expect(failure.retryable).toBe(false);
    expect(seams.calls.countRunsToday).toBe(0); // checked before the counter
  });

  it("fails OPEN when the run counter is down: a counter blip is not a marketing outage", async () => {
    const { policy, seams } = makePolicy({ runsToday: DEMO_RUNS_PER_DAY });
    seams.throwCounter = true;
    const facts = expectOk(await policy.checkRun());
    expect(facts.runsToday).toBe(0);
  });

  it("a broken counter reading (negative/NaN) sanitizes to 0", async () => {
    const { policy, seams } = makePolicy();
    seams.runsToday = -5;
    expect(expectOk(await policy.checkRun()).runsToday).toBe(0);
    seams.runsToday = Number.NaN;
    expect(expectOk(await policy.checkRun()).runsToday).toBe(0);
  });
});
