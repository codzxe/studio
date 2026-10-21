// apps/worker/src/session-allocator/tests/local-allocator.test.ts — W10-M.
// Deterministic unit tests for the single-box §3.2 session allocator: a FAKE
// spawner stands in for every engine process (no child is ever spawned here —
// the real spawn paths are the pure plan builders pinned below, plus the W2-J
// spine for the live mock). Kept-scope of the task:
//   - caps per org (§14.1 ladder 1/3/6 through the billing limits adapter),
//   - tenant isolation (org A never gets org B's token; token uniqueness),
//   - idle recycle (§3.2 checkpoint → recycle after the §3.4 idle timeout),
//   - mock-mode branch selection (MOCK_ENGINE=1 → apps/mock-engine spawner).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { Logger } from "../../logger.js";
import {
  type EngineSessionSpawner,
  type IdleCheckpointRequest,
  type IdleCheckpointSeam,
  type LocalAllocatorEvent,
  LocalSessionAllocator,
  type LocalSpawnRequest,
  type SessionAllocatorEnvelope,
  type SessionLimitsProvider,
  type SpawnedEngineProcess,
  type SubscriptionLookup,
  billingSessionLimits,
  buildChildEnv,
  buildMockSpawnPlan,
  buildServeSpawnPlan,
  createLocalSessionAllocator,
  isMockEngineMode,
  isSessionAllocatorError,
  parseMockAnnounceLine,
  parseServingLine,
  redactSecrets,
  resolveLocalEngineBinding,
  resolveMockEngineEntry,
  toSessionAllocatorEnvelope,
} from "../local-allocator.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOKEN = "ab".repeat(32); // 64 hex chars — §3.2 control-token shape
const IDLE_TIMEOUT_MS = 15 * 60 * 1000; // §3.4 per-session idle

/** The billing ladder as a lookup fake: §14.1 plans + the 'max' alias + trial. */
const LADDER: SubscriptionLookup = {
  getSubscription: async (organizationId: string) => {
    const plans: Record<string, string | null> = {
      "org-starter": "starter", // 1 session
      "org-pro": "pro", // 3 sessions
      "org-biz": "business", // 6 sessions
      "org-alias": "max", // 'max' → 'business' alias (W9-B)
      "org-trial": null, // trials run the starter ladder
      "org-unknown": "enterprise-999", // fails closed
    };
    const planCode = plans[organizationId];
    if (planCode === undefined) return null;
    return planCode === null ? null : { planCode };
  },
};

interface FakeProcess extends SpawnedEngineProcess {
  readonly signals: string[];
}

/** Records every spawn; never touches child_process or the network. */
class FakeSpawner implements EngineSessionSpawner {
  readonly kind = "serve" as const;
  readonly launches: LocalSpawnRequest[] = [];
  readonly processes: FakeProcess[] = [];
  /** Park launch() until this resolves (the pending-race test's gate). */
  launchDelay: Promise<void> | undefined;
  /** When set, launch() throws it once (spawn-failure paths). */
  failure: Error | undefined;

  async launch(request: LocalSpawnRequest): Promise<{
    process: SpawnedEngineProcess;
    port: number;
  }> {
    if (this.failure !== undefined) {
      const error = this.failure;
      this.failure = undefined;
      throw error;
    }
    if (this.launchDelay !== undefined) {
      await this.launchDelay;
    }
    this.launches.push(request);
    const signals: string[] = [];
    const process: FakeProcess = {
      pid: 4242 + this.processes.length,
      signals,
      stop: async (signal) => {
        signals.push(signal ?? "SIGTERM");
      },
    };
    this.processes.push(process);
    return { process, port: 20000 + this.processes.length };
  }
}

interface Harness {
  readonly allocator: LocalSessionAllocator;
  readonly spawner: FakeSpawner;
  readonly events: LocalAllocatorEvent[];
  readonly checkpoints: IdleCheckpointRequest[];
  /** Global op order: "checkpoint:<sid>" / "event:<type>:<sid>". */
  readonly order: string[];
  readonly logLines: string[];
  /** Advance the injected clock. */
  tick(ms: number): void;
  readonly baseDir: string;
}

const harnesses: Harness[] = [];

function makeHarness(): Harness {
  const spawner = new FakeSpawner();
  const events: LocalAllocatorEvent[] = [];
  const checkpoints: IdleCheckpointRequest[] = [];
  const order: string[] = [];
  const logLines: string[] = [];
  const logger: Logger = {
    debug: () => undefined,
    info: (message, fields) => logLines.push(`${message} ${JSON.stringify(fields ?? {})}`),
    warn: (message, fields) => logLines.push(`${message} ${JSON.stringify(fields ?? {})}`),
    error: (message, fields) => logLines.push(`${message} ${JSON.stringify(fields ?? {})}`),
    child: () => logger,
  };
  const checkpoint: IdleCheckpointSeam = async (request) => {
    checkpoints.push(request);
    order.push(`checkpoint:${request.sessionId}`);
    return { ok: true, path: `save/${request.documentId}.pcraft` };
  };
  let now = 1_000_000;
  const baseDir = mkdtempSync(join(tmpdir(), "w10m-caps-"));
  const allocator = new LocalSessionAllocator({
    spawner,
    limits: billingSessionLimits(LADDER),
    capabilityRootBase: baseDir,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    autoStartSweeper: false,
    clock: () => now,
    checkpoint,
    logger,
    onSessionEvent: (event) => {
      order.push(`event:${event.type}:${("sessionId" in event && event.sessionId) || ""}`);
      events.push(event);
    },
  });
  const harness: Harness = {
    allocator,
    spawner,
    events,
    checkpoints,
    order,
    logLines,
    baseDir,
    tick: (ms: number) => {
      now += ms;
    },
  };
  harnesses.push(harness);
  return harness;
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    rmSync(harness.baseDir, { recursive: true, force: true });
  }
});

/** Unwrap a typed async rejection as the module's envelope. */
async function rejectionOf(promise: Promise<unknown>): Promise<SessionAllocatorEnvelope> {
  try {
    await promise;
  } catch (error) {
    if (!isSessionAllocatorError(error)) {
      throw new Error(`expected a SessionAllocatorError, got: ${String(error)}`);
    }
    return error.toEnvelope();
  }
  throw new Error("expected the promise to reject");
}

/** Unwrap a typed synchronous throw as the module's envelope. */
function throwEnvelopeOf(fn: () => unknown): SessionAllocatorEnvelope {
  try {
    fn();
  } catch (error) {
    if (!isSessionAllocatorError(error)) {
      throw new Error(`expected a SessionAllocatorError, got: ${String(error)}`);
    }
    return error.toEnvelope();
  }
  throw new Error("expected a typed throw");
}

// ---------------------------------------------------------------------------
// The serve spawn contract (mirror of engine-pool serve-config)
// ---------------------------------------------------------------------------

describe("serve spawn plan (mirror of apps/engine-pool serve-config)", () => {
  const roots = "/work/organizations/org-a/sessions/s-1";

  it("builds the exact TCP argv: port 0, token FILE (never argv), roots from flags", () => {
    const plan = buildServeSpawnPlan(
      {
        token: TOKEN,
        tokenFilePath: `${roots}/tmp/control-token`,
        readRoot: roots,
        writeRoot: roots,
      },
      { binaryPath: "/engine/photocraft-cli" },
    );
    expect(plan.command).toBe("/engine/photocraft-cli");
    expect(plan.args).toEqual([
      "serve",
      "--port",
      "0",
      "--control-token-file",
      `${roots}/tmp/control-token`,
      "--automation-read-root",
      roots,
      "--automation-write-root",
      roots,
    ]);
    expect(plan.env.PHOTOCRAFT_CONTROL_TOKEN_FILE).toBe(`${roots}/tmp/control-token`);
    expect(plan.args).not.toContain(TOKEN); // §15.1: `ps` must not see the token
  });

  it("scrubs token/root env overrides from the parent env", () => {
    const env = buildChildEnv({
      PHOTOCRAFT_CONTROL_TOKEN: "stale-token",
      PHOTOCRAFT_CONTROL_TOKEN_FILE: "/stale/token",
      PHOTOCRAFT_AUTOMATION_READ_ROOT: "/stale/read",
      PHOTOCRAFT_AUTOMATION_WRITE_ROOT: "/stale/write",
      KEEP_ME: "yes",
    });
    expect(env).toEqual({ KEEP_ME: "yes" });
  });

  it("fails typed on an empty binary, a non-64-hex token, or empty roots", () => {
    const base = { token: TOKEN, tokenFilePath: "/t", readRoot: "/r", writeRoot: "/w" };
    expect(throwEnvelopeOf(() => buildServeSpawnPlan(base, { binaryPath: "" })).code).toBe(
      "validation_failed",
    );
    expect(
      throwEnvelopeOf(() =>
        buildServeSpawnPlan({ ...base, token: "ab".repeat(31) }, { binaryPath: "/bin/x" }),
      ).code,
    ).toBe("spawn_failed");
    expect(
      throwEnvelopeOf(() =>
        buildServeSpawnPlan({ ...base, readRoot: "" }, { binaryPath: "/bin/x" }),
      ).code,
    ).toBe("spawn_failed");
  });

  it("parses the serving line and refuses non-loopback or foreign lines", () => {
    expect(parseServingLine("photocraft-cli serving on 127.0.0.1:49152")).toBe(49152);
    expect(parseServingLine("  photocraft-cli serving on 127.0.0.1:49152  ")).toBe(49152);
    expect(parseServingLine("photocraft-cli serving on 0.0.0.0:8080")).toBeUndefined();
    expect(parseServingLine("mock-engine: listening on 127.0.0.1:7800")).toBeUndefined();
    expect(parseServingLine("photocraft-cli serving on 127.0.0.1:99999")).toBeUndefined();
  });

  it("redacts secrets from buffered child output (§15.1)", () => {
    expect(redactSecrets(`token ${TOKEN} leaked`, [TOKEN])).toBe("token [redacted] leaked");
    expect(redactSecrets("clean line", [])).toBe("clean line");
  });
});

// ---------------------------------------------------------------------------
// The mock-engine spawn plan (W2-J harness pattern)
// ---------------------------------------------------------------------------

describe("mock-engine spawn plan (W2-J harness pattern)", () => {
  it("builds the harness env contract: port 0, 64-hex token, write root", () => {
    const plan = buildMockSpawnPlan(
      { token: TOKEN, writeRoot: "/work/sessions/s-1" },
      { nodePath: "/usr/bin/node", entry: "apps/mock-engine/src/index.mjs" },
    );
    expect(plan.command).toBe("/usr/bin/node");
    expect(plan.args).toEqual(["apps/mock-engine/src/index.mjs"]);
    expect(plan.env.MOCK_ENGINE_PORT).toBe("0");
    expect(plan.env.MOCK_ENGINE_TOKEN).toBe(TOKEN);
    expect(plan.env.MOCK_ENGINE_WRITE_ROOT).toBe("/work/sessions/s-1");
    expect(plan.env.MOCK_ENGINE_ROOT).toBe("/work/sessions/s-1");
  });

  it("overwrites stale MOCK_* values inherited from the parent env", () => {
    const plan = buildMockSpawnPlan(
      { token: TOKEN, writeRoot: "/w" },
      {
        nodePath: "/usr/bin/node",
        entry: "apps/mock-engine/src/index.mjs",
        env: { MOCK_ENGINE_PORT: "7800", MOCK_ENGINE_TOKEN: "stale" },
      },
    );
    expect(plan.env.MOCK_ENGINE_PORT).toBe("0");
    expect(plan.env.MOCK_ENGINE_TOKEN).toBe(TOKEN);
  });

  it("fails typed on a non-64-hex token or an empty entry", () => {
    expect(
      throwEnvelopeOf(() =>
        buildMockSpawnPlan(
          { token: "short", writeRoot: "/w" },
          { nodePath: "/usr/bin/node", entry: "apps/mock-engine/src/index.mjs" },
        ),
      ).code,
    ).toBe("spawn_failed");
    expect(
      throwEnvelopeOf(() =>
        buildMockSpawnPlan(
          { token: TOKEN, writeRoot: "/w" },
          { nodePath: "/usr/bin/node", entry: "" },
        ),
      ).code,
    ).toBe("validation_failed");
  });

  it("parses the mock announce line", () => {
    expect(parseMockAnnounceLine("mock-engine: listening on 127.0.0.1:7801")).toBe(7801);
    expect(parseMockAnnounceLine("listening on 127.0.0.1:0")).toBeUndefined();
    expect(parseMockAnnounceLine("photocraft-cli serving on 127.0.0.1:7801")).toBeUndefined();
  });

  it("resolves the default apps/mock-engine entry, nulls on an explicit miss", () => {
    const entry = resolveMockEngineEntry();
    expect(entry).not.toBeNull();
    expect(entry?.endsWith(join("mock-engine", "src", "index.mjs"))).toBe(true);
    expect(resolveMockEngineEntry("/definitely/not/here.mjs")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Env binding + mock-mode branch selection (processor.ts mirror)
// ---------------------------------------------------------------------------

describe("env binding (processor.ts resolveEngineBinding mirror)", () => {
  it.each([
    ["1", true],
    ["true", true],
    ["YES", true],
    [" yes ", true],
    ["0", false],
    ["", false],
    ["off", false],
    [undefined, false],
  ])("MOCK_ENGINE=%p selects mock=%p", (value, mock) => {
    expect(isMockEngineMode({ MOCK_ENGINE: value })).toBe(mock);
  });

  it("binds mock_env > engine_binary_missing > engine_binary_present", () => {
    expect(resolveLocalEngineBinding({ MOCK_ENGINE: "1", ENGINE_BINARY_PATH: "/x" })).toEqual({
      mode: "mock",
      reason: "mock_env",
    });
    expect(resolveLocalEngineBinding({})).toEqual({
      mode: "mock",
      reason: "engine_binary_missing",
    });
    expect(
      resolveLocalEngineBinding({
        MOCK_ENGINE: "0",
        ENGINE_BINARY_PATH: fileURLToPath(import.meta.url),
      }),
    ).toEqual({ mode: "serve", reason: "engine_binary_present" });
  });

  it("the factory selects the mock spawner for MOCK_ENGINE=1 (branch pin)", () => {
    const bundle = createLocalSessionAllocator({
      env: { MOCK_ENGINE: "1", DATABASE_URL: "ignored-by-the-schema" },
      limits: billingSessionLimits(LADDER),
      autoStartSweeper: false,
    });
    expect(bundle.binding).toEqual({ mode: "mock", reason: "mock_env" });
    expect(bundle.spawner.kind).toBe("mock");
    expect(bundle.capabilityRootBase).toBe(join(tmpdir(), "studio-engine-sessions"));
  });

  it("the factory selects the serve spawner when the binary exists", () => {
    const binaryDir = mkdtempSync(join(tmpdir(), "w10m-bin-"));
    const binary = join(binaryDir, "photocraft-cli");
    writeFileSync(binary, "#!/bin/sh\n", { mode: 0o755 });
    const base = mkdtempSync(join(tmpdir(), "w10m-base-"));
    const bundle = createLocalSessionAllocator({
      env: {
        ENGINE_BINARY_PATH: binary,
        ENGINE_CAPABILITY_ROOT_BASE: base,
        MOCK_ENGINE: "0",
      },
      limits: billingSessionLimits(LADDER),
      autoStartSweeper: false,
    });
    expect(bundle.binding).toEqual({ mode: "serve", reason: "engine_binary_present" });
    expect(bundle.spawner.kind).toBe("serve");
    rmSync(binaryDir, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  });

  it("fails typed: serve mode without a capability base; mock without an entry", () => {
    const binaryDir = mkdtempSync(join(tmpdir(), "w10m-bin-"));
    const binary = join(binaryDir, "photocraft-cli");
    writeFileSync(binary, "#!/bin/sh\n", { mode: 0o755 });
    expect(
      throwEnvelopeOf(() =>
        createLocalSessionAllocator({
          env: { ENGINE_BINARY_PATH: binary },
          limits: billingSessionLimits(LADDER),
        }),
      ).code,
    ).toBe("validation_failed");
    rmSync(binaryDir, { recursive: true, force: true });
    expect(
      throwEnvelopeOf(() =>
        createLocalSessionAllocator({
          env: { MOCK_ENGINE: "1", MOCK_ENGINE_ENTRY: "/definitely/not/here.mjs" },
          limits: billingSessionLimits(LADDER),
        }),
      ).code,
    ).toBe("engine_unavailable");
  });

  it("unwired caps fail closed at allocation time (no lookup, no limits)", async () => {
    const { allocator } = createLocalSessionAllocator({
      env: { MOCK_ENGINE: "1" },
      autoStartSweeper: false,
    });
    const envelope = await rejectionOf(allocator.allocate("doc-1", "org-starter"));
    expect(envelope).toMatchObject({ code: "validation_failed", retryable: false });
  });
});

// ---------------------------------------------------------------------------
// Per-org caps — §14.1 ladder 1/3/6 via the billing limits adapter
// ---------------------------------------------------------------------------

describe("per-org caps (§3.2 plan limit, §14.1 ladder via billing)", () => {
  it.each([
    ["org-starter", 1],
    ["org-pro", 3],
    ["org-biz", 6],
  ])("%p allows exactly %p concurrent sessions", async (orgId, cap) => {
    const { allocator } = makeHarness();
    for (let index = 0; index < cap; index += 1) {
      const allocation = await allocator.allocate(`doc-${index}`, orgId);
      expect(allocation.organizationId).toBe(orgId);
    }
    expect(allocator.sessionCount(orgId)).toBe(cap);
    const envelope = await rejectionOf(allocator.allocate(`doc-${cap}`, orgId));
    expect(envelope).toMatchObject({
      ok: false,
      code: "session_limit_reached",
      retryable: true,
    });
    expect(envelope.message).toContain(`${cap}/${cap} active`);
  });

  it("recycling one session frees capacity for the next allocation", async () => {
    const { allocator } = makeHarness();
    const first = await allocator.allocate("doc-1", "org-starter");
    await rejectionOf(allocator.allocate("doc-2", "org-starter"));
    await allocator.recycle(first.sessionId, first.organizationId);
    expect(allocator.sessionCount("org-starter")).toBe(0);
    await expect(allocator.allocate("doc-2", "org-starter")).resolves.toMatchObject({
      sessionId: expect.any(String),
    });
  });

  it("idle keep-warm sessions still hold the org's slot until recycled", async () => {
    const { allocator, tick } = makeHarness();
    const first = await allocator.allocate("doc-1", "org-starter");
    await first.release();
    expect(first.state).toBe("idle");
    const envelope = await rejectionOf(allocator.allocate("doc-2", "org-starter"));
    expect(envelope.code).toBe("session_limit_reached");
    tick(IDLE_TIMEOUT_MS);
    await allocator.sweepIdle();
    expect(allocator.sessionCount("org-starter")).toBe(0);
    await expect(allocator.allocate("doc-2", "org-starter")).resolves.toMatchObject({
      sessionId: expect.any(String),
    });
  });

  it("closes the check-then-spawn race: one winner under a gated launch", async () => {
    const { allocator, spawner } = makeHarness();
    let releaseGate: () => void = () => undefined;
    spawner.launchDelay = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const first = allocator.allocate("doc-race", "org-starter");
    await new Promise((resolve) => setTimeout(resolve, 0)); // park first at the gate
    const second = allocator.allocate("doc-race", "org-starter");
    releaseGate();
    const [firstResult, secondResult] = await Promise.allSettled([first, second]);
    expect(firstResult.status).toBe("fulfilled");
    expect(secondResult.status).toBe("rejected");
    expect(allocator.sessionCount("org-starter")).toBe(1);
  });

  it("surfaces spawn failures as typed spawn_failed envelopes", async () => {
    const { allocator, spawner } = makeHarness();
    spawner.failure = new Error("boom (internal)");
    const envelope = await rejectionOf(allocator.allocate("doc-1", "org-pro"));
    expect(envelope).toMatchObject({ code: "spawn_failed", retryable: true });
    expect(envelope.message).not.toContain("boom"); // §4: internals never leak
  });

  it("rejects empty ids typed", async () => {
    const { allocator } = makeHarness();
    const envelope = await rejectionOf(allocator.allocate("", "org-pro"));
    expect(envelope.code).toBe("validation_failed");
  });
});

describe("billingSessionLimits (§14.1 ladder, trial + alias + fail-closed)", () => {
  const limits: SessionLimitsProvider = billingSessionLimits(LADDER);
  it.each([
    ["org-starter", 1],
    ["org-pro", 3],
    ["org-biz", 6],
    ["org-alias", 6], // 'max' → 'business' (limits-service PLAN_CODE_ALIASES mirror)
    ["org-trial", 1], // trials run the starter ladder (trial-rules.ts)
  ])("%p → cap %p", async (orgId, cap) => {
    await expect(limits.maxConcurrentSessions(orgId)).resolves.toBe(cap);
  });

  it("fails closed on an unknown plan code", async () => {
    const envelope = await rejectionOf(limits.maxConcurrentSessions("org-unknown"));
    expect(envelope).toMatchObject({ code: "validation_failed", retryable: false });
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation — §3.2 "never shared across tenants" + §15.1 no-leak
// ---------------------------------------------------------------------------

describe("tenant isolation (§3.2/§15.1)", () => {
  it("mints a unique 64-hex token per session; org A never gets org B's token", async () => {
    const { allocator } = makeHarness();
    const orgA = await Promise.all([
      allocator.allocate("doc-a1", "org-pro"),
      allocator.allocate("doc-a2", "org-pro"),
    ]);
    const orgB = await Promise.all([
      allocator.allocate("doc-b1", "org-biz"),
      allocator.allocate("doc-b2", "org-biz"),
    ]);
    const tokens = [...orgA, ...orgB].map((allocation) => allocation.token);
    expect(new Set(tokens).size).toBe(tokens.length); // uniqueness per session
    for (const token of tokens) {
      expect(token).toMatch(/^[0-9a-f]{64}$/); // §3.2 256-bit, hex
    }
    for (const a of orgA) {
      for (const b of orgB) {
        expect(a.token).not.toBe(b.token);
        expect(a.sessionId).not.toBe(b.sessionId);
      }
    }
  });

  it("scopes capability roots per org + session (§3.2 per-tenant isolation)", async () => {
    const { allocator } = makeHarness();
    const a = await allocator.allocate("doc-a", "org-pro");
    const b = await allocator.allocate("doc-b", "org-biz");
    expect(a.capabilities.sessionDir).toContain(
      join("organizations", "org-pro", "sessions", a.sessionId),
    );
    expect(b.capabilities.sessionDir).toContain(
      join("organizations", "org-biz", "sessions", b.sessionId),
    );
    expect(a.capabilities.readRoot).toBe(a.capabilities.sessionDir);
    expect(a.capabilities.writeRoot).toBe(a.capabilities.sessionDir);
    expect(Object.keys(a.capabilities.subdirs).sort()).toEqual([
      "assets",
      "renders",
      "save",
      "tmp",
    ]);
    expect(a.endpoint).toBe(`127.0.0.1:${a.port}`); // §3.2 loopback only
  });

  it("cross-tenant lookups get the SAME answer as unknown ids (existence not leaked)", async () => {
    const { allocator } = makeHarness();
    const a = await allocator.allocate("doc-a", "org-pro");
    expect(allocator.session(a.sessionId, "org-pro")).toBeDefined();
    expect(allocator.session(a.sessionId, "org-biz")).toBeUndefined();
    expect(allocator.session("no-such-session", "org-pro")).toBeUndefined();

    const foreign = await rejectionOf(allocator.release(a.sessionId, "org-biz"));
    const unknown = await rejectionOf(allocator.release("no-such-session", "org-pro"));
    expect(foreign.code).toBe("session_not_found");
    expect(unknown.code).toBe("session_not_found");
    expect(foreign.message).toBe(unknown.message);
    expect(() => allocator.touch(a.sessionId, "org-biz")).toThrowError(
      expect.objectContaining({ code: "session_not_found" }),
    );
  });

  it("tokens never appear in log lines (§15.1)", async () => {
    const { allocator, logLines, tick } = makeHarness();
    const a = await allocator.allocate("doc-a", "org-pro");
    await a.release();
    tick(IDLE_TIMEOUT_MS);
    await allocator.sweepIdle();
    const logged = logLines.join("\n");
    expect(logged).not.toContain(a.token);
    expect(logged).not.toContain(TOKEN);
  });
});

// ---------------------------------------------------------------------------
// Idle recycle — §3.2 idle timeout → save checkpoint → recycle
// ---------------------------------------------------------------------------

describe("idle recycle (§3.2 lifecycle: idle → checkpoint → recycle)", () => {
  it("keeps a released session until the §3.4 idle timeout, then recycles it", async () => {
    const { allocator, events, order, checkpoints, spawner, tick } = makeHarness();
    const a = await allocator.allocate("doc-a", "org-pro");
    await a.release();
    expect(a.state).toBe("idle");

    tick(IDLE_TIMEOUT_MS - 1);
    await expect(allocator.sweepIdle()).resolves.toEqual([]);
    expect(allocator.sessionCount("org-pro")).toBe(1);

    tick(1);
    await expect(allocator.sweepIdle()).resolves.toEqual([a.sessionId]);
    // §3.2 order: checkpoint BEFORE the process stop / eviction event.
    expect(order.indexOf(`checkpoint:${a.sessionId}`)).toBeLessThan(
      order.indexOf(`event:session_evicted:${a.sessionId}`),
    );
    expect(spawner.processes[0]?.signals).toEqual(["SIGTERM"]);
    expect(checkpoints[0]?.documentId).toBe("doc-a");
    expect(checkpoints[0]?.capabilities).toBe(a.capabilities);
    expect(allocator.session(a.sessionId, "org-pro")).toBeUndefined();
    expect(a.state).toBe("draining");
    expect(events.map((event) => event.type)).toEqual([
      "session_allocated",
      "session_idle",
      "session_checkpointed",
      "session_evicted",
    ]);
  });

  it("touch resets the idle clock; double release never extends it", async () => {
    const { allocator, events, tick } = makeHarness();
    const a = await allocator.allocate("doc-a", "org-pro");
    await a.release();
    await a.release(); // idempotent keep-warm release
    expect(events.filter((event) => event.type === "session_idle")).toHaveLength(1);

    tick(10 * 60 * 1000);
    allocator.touch(a.sessionId, a.organizationId);
    tick(14 * 60 * 1000);
    await expect(allocator.sweepIdle()).resolves.toEqual([]); // 14 min < 15 since touch
    tick(60 * 1000);
    await expect(allocator.sweepIdle()).resolves.toEqual([a.sessionId]); // 15 min since touch
  });

  it("also recycles stuck attached sessions (engine-pool eviction parity)", async () => {
    const { allocator, tick } = makeHarness();
    const a = await allocator.allocate("doc-a", "org-pro"); // never released
    tick(IDLE_TIMEOUT_MS);
    await expect(allocator.sweepIdle()).resolves.toEqual([a.sessionId]);
    expect(allocator.sessionCount("org-pro")).toBe(0);
  });

  it("evicts the most-idle session first", async () => {
    const { allocator, tick } = makeHarness();
    const older = await allocator.allocate("doc-old", "org-pro");
    const newer = await allocator.allocate("doc-new", "org-pro");
    await older.release();
    tick(5 * 60 * 1000);
    await newer.release();
    tick(IDLE_TIMEOUT_MS);
    await expect(allocator.sweepIdle()).resolves.toEqual([older.sessionId, newer.sessionId]);
  });

  it("a failed checkpoint never blocks the recycle (§3.4 WAL is the fallback)", async () => {
    let now = 0;
    const baseDir = mkdtempSync(join(tmpdir(), "w10m-caps-"));
    const checkpoints: IdleCheckpointRequest[] = [];
    const failing: IdleCheckpointSeam = async (request) => {
      checkpoints.push(request);
      throw new Error("engine refused the save");
    };
    const allocator = new LocalSessionAllocator({
      spawner: new FakeSpawner(),
      limits: billingSessionLimits(LADDER),
      capabilityRootBase: baseDir,
      idleTimeoutMs: 1_000,
      autoStartSweeper: false,
      clock: () => now,
      checkpoint: failing,
    });
    const a = await allocator.allocate("doc-a", "org-pro");
    await a.release();
    now += 1_000;
    await expect(allocator.sweepIdle()).resolves.toEqual([a.sessionId]);
    expect(checkpoints).toHaveLength(1); // tried, failed, recycled anyway
    expect(allocator.session(a.sessionId, "org-pro")).toBeUndefined();
    rmSync(baseDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Drain + envelopes + observers
// ---------------------------------------------------------------------------

describe("drain and robustness", () => {
  it("drain checkpoints + stops every session and refuses new allocations", async () => {
    const { allocator, events } = makeHarness();
    await allocator.allocate("doc-a", "org-pro");
    await allocator.allocate("doc-b", "org-pro");
    await allocator.drain();
    expect(allocator.snapshot()).toMatchObject({
      total: 0,
      byState: { attached: 0, idle: 0, draining: 0 },
    });
    expect(events.at(-1)).toMatchObject({ type: "allocator_drained", evicted: 2 });
    const envelope = await rejectionOf(allocator.allocate("doc-c", "org-pro"));
    expect(envelope).toMatchObject({ code: "engine_unavailable", retryable: false });
  });

  it("the sweeper timer is startable/stoppable and idempotent", () => {
    const { allocator } = makeHarness();
    allocator.startIdleSweeper();
    allocator.startIdleSweeper();
    allocator.stopIdleSweeper();
    allocator.stopIdleSweeper();
  });

  it("a throwing §22 observer never breaks the allocator", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "w10m-caps-"));
    const allocator = new LocalSessionAllocator({
      spawner: new FakeSpawner(),
      limits: billingSessionLimits(LADDER),
      capabilityRootBase: baseDir,
      autoStartSweeper: false,
      clock: () => 1,
      onSessionEvent: () => {
        throw new Error("observer exploded");
      },
    });
    const allocation = await allocator.allocate("doc-a", "org-pro");
    expect(allocation.sessionId).toEqual(expect.any(String));
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("unknown failures convert to a generic safe envelope (§4)", () => {
    const envelope = toSessionAllocatorEnvelope(new Error("secret internals"));
    expect(envelope).toMatchObject({ ok: false, code: "engine_unavailable", retryable: true });
    expect(envelope.message).not.toContain("secret");
  });
});
