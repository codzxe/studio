/**
 * Pure-logic tests for queue topology and job payload contracts (§3.1, §5.2,
 * §3.4). No Redis, no network, deterministic — per docs/AGENTS.md.
 */
import { describe, expect, it } from "vitest";
import {
  EXPORT_FORMATS,
  IMAGE_SIZE_CLASSES,
  IMAGE_SIZE_RESOLUTIONS,
  InvalidJobPayloadError,
  InvalidRunTierError,
  JOB_RETRY,
  QUEUE_NAMES,
  RUN_QUEUE_BY_TIER,
  RUN_TIERS,
  TIMEOUTS_MS,
  TIER_WALL_CLOCK_MS,
  exportJobPayloadSchema,
  imageJobPayloadSchema,
  parseJobPayload,
  runJobPayloadSchema,
  runQueueName,
  type RunTier,
} from "../src/queues.js";

const runFixture = (tier: RunTier): Record<string, unknown> => ({
  runId: "run_018f",
  organizationId: "org_acme",
  tier,
});

const exportFixture: Record<string, unknown> = {
  documentId: "doc_77",
  format: "png",
  idempotencyKey: "exp_9f2a",
};

const imageFixture: Record<string, unknown> = {
  prompt: "cedar-plank salmon hero shot",
  sizeClass: "1024x1024",
  runId: "run_018f",
};

describe("run job payload schema", () => {
  it("accepts one valid fixture per tier (§5.2)", () => {
    for (const tier of RUN_TIERS) {
      const parsed = runJobPayloadSchema.safeParse(runFixture(tier));
      expect(parsed.success, `tier ${tier}`).toBe(true);
      if (parsed.success) {
        expect(parsed.data.tier).toBe(tier);
      }
    }
  });

  it("strips unknown keys so payloads can evolve", () => {
    const parsed = runJobPayloadSchema.safeParse({ ...runFixture("standard"), futureField: "x" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Object.hasOwn(parsed.data, "futureField")).toBe(false);
    }
  });

  const invalidRunCases: Array<[string, Record<string, unknown>]> = [
    ["missing runId", { organizationId: "org_acme", tier: "standard" }],
    ["empty runId", { runId: "", organizationId: "org_acme", tier: "standard" }],
    ["empty organizationId", { runId: "run_1", organizationId: "", tier: "standard" }],
    ["unknown tier", { runId: "run_1", organizationId: "org_acme", tier: "ultra" }],
    ["numeric runId", { runId: 42, organizationId: "org_acme", tier: "quick" }],
    ["oversized id", { runId: "x".repeat(65), organizationId: "org_acme", tier: "quick" }],
  ];
  for (const [label, payload] of invalidRunCases) {
    it(`rejects ${label}`, () => {
      expect(runJobPayloadSchema.safeParse(payload).success).toBe(false);
    });
  }
});

describe("export job payload schema", () => {
  for (const format of EXPORT_FORMATS) {
    it(`accepts ${format} exports`, () => {
      const parsed = exportJobPayloadSchema.safeParse({ ...exportFixture, format });
      expect(parsed.success).toBe(true);
    });
  }

  it("accepts optional width/height/quality", () => {
    const parsed = exportJobPayloadSchema.safeParse({
      ...exportFixture,
      width: 1080,
      height: 1350,
      quality: 92,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.width).toBe(1080);
      expect(parsed.data.height).toBe(1350);
      expect(parsed.data.quality).toBe(92);
    }
  });

  const invalidExportCases: Array<[string, Record<string, unknown>]> = [
    ["missing idempotencyKey", { documentId: "doc_77", format: "png" }],
    ["unknown format", { ...exportFixture, format: "gif" }],
    ["zero width", { ...exportFixture, width: 0 }],
    ["fractional width", { ...exportFixture, width: 12.5 }],
    ["width above cap", { ...exportFixture, width: 9000 }],
    ["quality below range", { ...exportFixture, quality: 0 }],
    ["quality above range", { ...exportFixture, quality: 101 }],
    ["missing documentId", { format: "png", idempotencyKey: "k" }],
    ["numeric format", { ...exportFixture, format: 1 }],
  ];
  for (const [label, payload] of invalidExportCases) {
    it(`rejects ${label}`, () => {
      expect(exportJobPayloadSchema.safeParse(payload).success).toBe(false);
    });
  }
});

describe("image job payload schema", () => {
  for (const sizeClass of IMAGE_SIZE_CLASSES) {
    it(`accepts size class ${sizeClass}`, () => {
      const parsed = imageJobPayloadSchema.safeParse({ ...imageFixture, sizeClass });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.sizeClass).toBe(sizeClass);
      }
    });
  }

  it("trims surrounding whitespace from the prompt", () => {
    const parsed = imageJobPayloadSchema.safeParse({
      ...imageFixture,
      prompt: "  surreal gradient  ",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.prompt).toBe("surreal gradient");
    }
  });

  const invalidImageCases: Array<[string, Record<string, unknown>]> = [
    ["blank prompt", { ...imageFixture, prompt: "   " }],
    ["over-long prompt", { ...imageFixture, prompt: "x".repeat(4001) }],
    ["unknown size class", { ...imageFixture, sizeClass: "512x512" }],
    ["missing runId", { prompt: "hi", sizeClass: "1024x1024" }],
    ["numeric prompt", { ...imageFixture, prompt: 42 }],
  ];
  for (const [label, payload] of invalidImageCases) {
    it(`rejects ${label}`, () => {
      expect(imageJobPayloadSchema.safeParse(payload).success).toBe(false);
    });
  }
});

describe("tier → queue naming (§3.1 one queue per model tier, §5.2)", () => {
  const expected: Record<RunTier, string> = {
    quick: "runs:quick",
    standard: "runs:standard",
    complex: "runs:complex",
    premium: "runs:premium",
    max: "runs:max",
  };

  for (const tier of RUN_TIERS) {
    it(`maps ${tier} to ${expected[tier]}`, () => {
      expect(runQueueName(tier)).toBe(expected[tier]);
      expect(RUN_QUEUE_BY_TIER[tier]).toBe(expected[tier]);
    });
  }

  it("rejects unknown tiers with a typed error (runtime guard for JS callers)", () => {
    expect(() => runQueueName("ultra" as RunTier)).toThrow(InvalidRunTierError);
  });

  it("derives every run queue name from QUEUE_NAMES.runs", () => {
    for (const tier of RUN_TIERS) {
      expect(runQueueName(tier).startsWith(`${QUEUE_NAMES.runs}:`)).toBe(true);
    }
  });
});

describe("timeout and budget constants (§3.4, §5.2)", () => {
  it("matches the §3.4 hard timeouts", () => {
    expect(TIMEOUTS_MS.tool).toBe(5_000);
    expect(TIMEOUTS_MS.render).toBe(30_000);
    expect(TIMEOUTS_MS.run).toBe(600_000);
    expect(TIMEOUTS_MS.sessionIdle).toBe(900_000);
  });

  it("matches the §5.2 tier wall clocks", () => {
    expect(TIER_WALL_CLOCK_MS.quick).toBe(120_000);
    expect(TIER_WALL_CLOCK_MS.standard).toBe(300_000);
    expect(TIER_WALL_CLOCK_MS.complex).toBe(600_000);
    expect(TIER_WALL_CLOCK_MS.premium).toBe(600_000);
    expect(TIER_WALL_CLOCK_MS.max).toBe(900_000);
  });

  it("retries failed jobs with exponential backoff (§3.4)", () => {
    expect(JOB_RETRY.attempts).toBe(3);
    expect(JOB_RETRY.backoff.type).toBe("exponential");
  });
});

describe("parseJobPayload boundary helper", () => {
  it("returns parsed data for valid payloads", () => {
    const payload = parseJobPayload(runJobPayloadSchema, runFixture("quick"), {
      queue: "runs:quick",
    });
    expect(payload.tier).toBe("quick");
  });

  it("throws a typed InvalidJobPayloadError listing field paths", () => {
    const fn = (): unknown =>
      parseJobPayload(runJobPayloadSchema, { runId: "r" }, { queue: "runs:quick", jobId: "job_1" });
    expect(fn).toThrow(InvalidJobPayloadError);
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidJobPayloadError);
      const issues = (error as InvalidJobPayloadError).issues.join(" | ");
      expect(issues).toContain("organizationId");
      expect(issues).toContain("tier");
    }
  });
});

describe("image size classes (§5.2)", () => {
  for (const sizeClass of IMAGE_SIZE_CLASSES) {
    it(`resolves ${sizeClass} to matching pixel dimensions`, () => {
      const resolution = IMAGE_SIZE_RESOLUTIONS[sizeClass];
      const [width, height] = sizeClass.split("x") as [string, string];
      expect(resolution.width).toBe(Number(width));
      expect(resolution.height).toBe(Number(height));
    });
  }
});
