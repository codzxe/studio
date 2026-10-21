// W6-P — barrel assembly gate: every curated public export of @studio/agent
// resolves from src/index.ts, and the three cross-module star-export collisions
// resolve to the DOCUMENTED winners. ESM silently DROPS ambiguous star-exported
// names (TS: TS2308) — so a collision that slips past the barrel would show up
// here as a missing/undefined symbol, and a wrong precedence as a wrong value.
//
// Not asserted (yet): nothing — W7-M wired the last extension point: guards/
// (ToolCallGate + injection helpers, W6-K) and brand/ (W7-F) are exported from
// src/index.ts and pinned by the rows below (fleet convention: the wiring owner
// adds the barrel export line AND the rows).
//
// Deterministic by construction: importing the barrel evaluates only module
// top-levels (zod schemas, config-alignment loops) — no network, no clock use,
// no engine. Runs in well under a second.
import { describe, expect, expectTypeOf, it } from "vitest";
import * as agent from "../src/index.js";

/** Every key of the barrel namespace must be a defined runtime value. */
function expectNamespaceIsClean(): void {
  const keys = Object.keys(agent);
  // Uniqueness tripwire ("no duplicate export names"): Object.keys cannot
  // repeat, but this pins the invariant the barrel exists to provide.
  expect(new Set(keys).size).toBe(keys.length);
  for (const key of keys) {
    expect(agent[key as keyof typeof agent], `undefined export: ${key}`).toBeDefined();
  }
  // Floor: 281 value exports at assembly time; ambiguous star collisions would
  // be silently dropped and shrink the namespace.
  expect(keys.length).toBeGreaterThanOrEqual(275);
}

describe("W6-P barrel: curated public surface resolves", () => {
  it("imports cleanly with a fully-defined, duplicate-free namespace", () => {
    expectNamespaceIsClean();
  });

  it("services: classes resolve (typeof function)", () => {
    // Services the run manager composes (W6 wave) + W1/W2 core classes.
    const classes = [
      "PlannerService",
      "ExecutorService",
      "ContextAssembler",
      "ObserverService",
      "RunValidator",
      "RunCritic",
      "RepairPlanner",
      "ModelRouter",
      "TransactionManager",
      "RunEventBus",
      "BudgetTracker",
      "TierBudgetTracker",
      "ProviderCacheTracker",
      "RouterError",
      "ChatEditClassifier",
      "RunStateMachine",
      "CancellationCoordinator",
      "BrandTokensService", // W7-F brand tokens (§7.5)
      "ToolCallGate", // W6-K §5.7 gate (wired by W7-M)
      "MeteringError", // W9-C money-path typed error (wired by W9-P)
      "RunUsage", // W9-C run usage accumulator
      "StepUsage", // W9-C step scope accumulator
      "ObsMetricError", // W9-D metrics validation error
      "LoggerSetupError", // W9-D logger seam error
      "TracerSetupError", // W9-D tracer seam error
      "LangfuseTraceSink", // W9-E §22 LLM trace sink
    ];
    for (const name of classes) {
      expect(typeof agent[name as keyof typeof agent], name).toBe("function");
    }
  });

  it("key functions resolve (typeof function)", () => {
    const functions = [
      "validatePlan", // W1-P §5.5 schema gate
      "canTransition", // W1-P §5.1 machine guard
      "transition",
      "isTerminal",
      "buildRunEvent", // W1-P §13.2 events
      "toWireRunEvent",
      "agentErr", // W1-P typed envelopes
      "toWireErrorCode",
      "routeChain", // W1-P §5.3 tables
      "freshCircuitBreaker",
      "buildPlannerPrompt", // W6-A §23.2
      "extractPlanJson",
      "enforcePlannerRules",
      "buildExecutorSystemPrompt", // W6-B §23.1
      "executorLimitsFromTier",
      "canonicalCallKey",
      "canonicalStringify", // W6-C §5.4 context
      "compactLayerRows",
      "hashCachePrefix",
      "parseSummary", // W6-C observer deltas
      "diffLayers",
      "buildDeltaSummary",
      "classifyOutcome", // W6-D validator
      "parseValidateSummary",
      "validateGate",
      "criticRouteEnabled", // W6-E critic
      "parseCritiqueSummary",
      "createRepairCycleCounter",
      "cycleGate", // W6-E §5.1 cycle gate
      "cycleGateForOutcome",
      "buildFixList", // W6-F repair
      "buildRepairPrompt",
      "planRepairs",
      "createBudgetTracker", // W6-G §5.2 factory
      "defaultPhaseTotal",
      "computeSettlement", // W6-G settlement
      "routeClassForTier", // W6-H router
      "preferOffPeakRoutes",
      "buildCacheablePrefix",
      "buildChatEditPrompt", // W6-J chat-edit classifier
      "enforceChatEditRules",
      "extractChatEditJson",
      "buildChatEditSteps",
      "resolveCostTier",
      "parseActionExpr",
      "runStateFailure", // W6-J run-state machine
      "timeoutErrorEnvelope",
      "defaultPcraftStorageKey", // W6-I transactions
      "sanitizeUserContent", // W6-K §5.7 injection stance
      "scanForInjectionFlags",
      "stripUnsafeControls",
      "normalizeHomoglyphs",
      "wrapAsDataBlock",
      "mutatingCommandCapFromTier", // W6-K §5.7/§5.2 tier cap
      "buildStyleGuidePayload", // W7-F §5.4 style-guide block
      "normalizeHex",
      "computeCost", // W9-C Appendix C cost (wired by W9-P)
      "imageCost", // W9-C §5.2 image COGS + credits
      "resolveModelRates", // W9-C MODEL_RATES_JSON override (fail-fast)
      "parseModelRatesEnv",
      "hasModelRate",
      "microToSafeNumber", // W9-C bigint → safe number
      "margin", // W9-C §0 60–75% COGS band
      "utcDayOf", // W9-C daily attribution
      "attributeDailyCosts",
      "createObsLogger", // W9-D correlated logger
      "redactDeep", // W9-D §15.3 redaction
      "correlationFields",
      "resolveLogLevel",
      "createTracer", // W9-D sampling + traceparent kit
      "createNoopTracer",
      "samplingRatesFromEnv",
      "createSamplingPolicy",
      "formatTraceparent",
      "parseTraceparent",
      "injectTraceparent",
      "extractTraceparent",
      "createObsMetricRegistry", // W9-D Prometheus text registry
      "createObsMetrics", // W9-D §22 metric set
      "isRunSampled", // W9-E deterministic run sampling
      "formatPromptVersion",
      "defaultPromptMasker",
      "noopLangfuse",
      "readLangfuseEnv",
    ];
    for (const name of functions) {
      expect(typeof agent[name as keyof typeof agent], name).toBe("function");
    }
  });

  it("key constants resolve with their actual kinds", () => {
    const consts: ReadonlyArray<[name: string, kind: string]> = [
      ["AGENT_ERROR_CODES", "object"], // W1-P catalog
      ["AGENT_TO_WIRE_ERROR_CODE", "object"],
      ["RUN_STATUSES", "object"], // W1-P §5.1
      ["RUN_PHASES", "object"],
      ["ALLOWED_TRANSITIONS", "object"],
      ["BUDGET_KINDS", "object"], // W1-P §5.2
      ["ROLE_ROUTES", "object"], // W1-P §5.3
      ["FAILOVER_PAIRS", "object"],
      ["RUN_EVENT_TYPES", "object"], // W1-P §13.2
      ["EVENT_BUS_ERROR_CODES", "object"], // W2-P bus
      ["planSchema", "object"], // zod §5.5
      ["GATE_RULES", "object"], // W6-D decision table
      ["EXECUTOR_SYSTEM_PROMPT_TEMPLATE", "string"], // W6-B §23.1 verbatim
      ["EXECUTOR_PHASES", "object"],
      ["REPAIR_TOOLS", "object"], // W6-F §23.4 allow-list
      ["REPAIR_PLAN_INVALID_CODE", "string"], // W6-F swap-point (flagged)
      ["CRITIC_TOOL_FAILURE_CODE", "string"], // W6-E swap-point (flagged)
      ["SETTLEMENT_POLICIES", "object"], // W6-G §14.2
      ["TRANSACTION_ERROR_CODES", "object"], // W6-I §5.6
      ["CHAT_EDIT_INVALID_CODE", "string"], // W6-J swap-point (flagged)
      ["CHAT_EDIT_ACTIONS", "object"], // W6-J §13 chat-edit actions
      ["CHAT_COST_TIERS", "object"],
      ["RUN_STATE_ERROR_CODES", "object"], // W6-J run-state catalog
      ["DEFAULT_CANCEL_REASON", "string"],
      ["CACHE_HIT_TARGET", "number"], // W6-H §5.3 >=60%
      ["DEFAULT_BRAND", "object"], // W7-F §7.5 fallback tokens
      ["FONT_ROLES", "object"],
      ["brandTokensSchema", "object"],
      ["STYLE_GUIDE_SECTION_ID", "string"],
      ["INJECTION_FLAG_PATTERNS", "object"], // W6-K §5.7 catalog
      ["USER_CONTENT_MAX_CHARS", "object"],
      ["DEFAULT_MUTATING_TOOLS", "object"], // W6-K §6 mutating set
      ["GATE_DEFAULT_ARG_CAPS", "object"],
      ["MODEL_RATES", "object"], // W9-C 14 Appendix C rates (wired by W9-P)
      ["GROSS_MARGIN_TARGET", "object"], // W9-C §0 margin band
      ["CACHE_READ_PRICE_NUMERATOR", "bigint"], // W9-C cache-read 10%
      ["CACHE_READ_PRICE_DENOMINATOR", "bigint"],
      ["CREDIT_LIST_USD", "number"], // W9-C 1 credit = $0.10
      ["REDACTED_MARKER", "string"], // W9-D §15.3 fail-closed marker
      ["LOG_LEVELS", "object"],
      ["TRACEPARENT_HEADER", "string"], // W9-D W3C propagation
      ["SAMPLED_FLAG", "number"],
      ["RENDER_CONTENT_TYPE", "string"], // W9-D Prometheus text 0.0.4
      ["RUN_DURATION_SECONDS_BUCKETS", "object"], // W9-D §22 histogram
      ["STEPS_PER_RUN_BUCKETS", "object"],
      ["NOOP_LANGFUSE", "object"], // W9-E noop client
      ["DEFAULT_TRACE_SUCCESS_SAMPLE_RATE", "number"], // W9-E 10% default
      ["PROMPT_REDACTED", "string"], // W9-E masking token
    ];
    for (const [name, kind] of consts) {
      expect(typeof agent[name as keyof typeof agent], name).toBe(kind);
    }
  });
});

describe("W6-P barrel: star-export collisions resolve as documented", () => {
  it("RUN_PHASES keeps state.ts's §5.1 phases; tracker phases ride as BUDGET_PHASES", () => {
    expect(agent.RUN_PHASES).toEqual([
      "planning",
      "executing",
      "observing",
      "rendering",
      "validating",
      "critiquing",
      "repairing",
      "finalizing",
    ]);
    expect(agent.BUDGET_PHASES).toEqual(["plan", "execute", "validate", "critique", "repair"]);
    // Type-level: the canonical RunPhase is the §5.1 status subset.
    expectTypeOf<agent.RunPhase>().toEqualTypeOf<import("../src/state.js").RunPhase>();
    expectTypeOf<agent.BudgetPhase>().toEqualTypeOf<
      import("../src/budgets-service/tracker-factory.js").RunPhase
    >();
  });

  it("CritiqueIssue keeps the §13.2 payload shape; the tolerant critic twin is CriticIssue", () => {
    expectTypeOf<agent.CritiqueIssue>().toEqualTypeOf<import("../src/events.js").CritiqueIssue>();
    expectTypeOf<agent.CriticIssue>().toEqualTypeOf<
      import("../src/critic/service.js").CritiqueIssue
    >();
    // The critic twin tolerates compaction (observation/fix optional) — prove
    // the alias did not silently collapse onto the events.ts shape.
    expectTypeOf<agent.CriticIssue>().not.toEqualTypeOf<agent.CritiqueIssue>();
  });

  it("AbortSignalLike stays planner's shape; cancellation's rides as RunAbortSignalLike", () => {
    expectTypeOf<agent.AbortSignalLike>().toEqualTypeOf<
      import("../src/planner/planner.js").AbortSignalLike
    >();
    expectTypeOf<agent.RunAbortSignalLike>().toEqualTypeOf<
      import("../src/run-state/cancellation.js").AbortSignalLike
    >();
    // Structurally compatible both ways (the coordinator's extras are all
    // optional) — but the alias keeps the richer cooperative-cancel shape
    // addressable instead of dropped by the ESM ambiguity rule.
    expectTypeOf<agent.AbortSignalLike>().not.toEqualTypeOf<agent.RunAbortSignalLike>();
  });

  it("flagged-but-absent error codes stay pinned at their swap-point values", () => {
    // errors.ts (W1-P, add-only) does not carry "repair_plan_invalid" (W6-F),
    // "critique_unavailable" (W6-E) or a chat-edit-specific code (W6-J) yet;
    // these constants flip when errors.ts adopts them, so pin today's values —
    // the flip breaks this row and forces the barrel+CI conversation instead of
    // drifting silently.
    const codes: import("../src/errors.js").AgentErrorCode[] = [
      agent.REPAIR_PLAN_INVALID_CODE,
      agent.CRITIC_TOOL_FAILURE_CODE,
      agent.CHAT_EDIT_INVALID_CODE,
    ];
    expect(codes).toEqual(["plan_invalid", "tool_retry_exhausted", "plan_invalid"]);
    // The W1-P catalog itself is pinned add-only against accidental renames.
    expect(agent.AGENT_ERROR_CODES).toEqual([
      "plan_invalid",
      "budget_exceeded_soft",
      "tool_retry_exhausted",
      "revision_limit_reached",
      "run_timeout",
      "engine_session_lost",
      "provider_unhealthy",
      "prompt_injection_suspected",
      "invalid_transition",
    ]);
  });

  it("wave-9 RedactionContext: eventbus keeps the canonical name; langfuse rides aliased", () => {
    // W9-P wiring: eventbus.ts's §22 delivery-time context (organizationId+
    // runId, public since W2-P) stays `RedactionContext`; obs/langfuse.ts's
    // masking context (kind+runId+optedIn) rides as LangfuseRedactionContext.
    expectTypeOf<agent.RedactionContext>().toEqualTypeOf<
      import("../src/eventbus.js").RedactionContext
    >();
    expectTypeOf<agent.LangfuseRedactionContext>().toEqualTypeOf<
      import("../src/obs/langfuse.js").RedactionContext
    >();
    // Prove the alias did not silently collapse onto the canonical shape.
    expectTypeOf<agent.LangfuseRedactionContext>().not.toEqualTypeOf<agent.RedactionContext>();
  });

  it("cross-module invariants survive the merge", () => {
    // The shared §5.2 tracker subclass lineage is intact through the barrel:
    // W6-G's TierBudgetTracker still IS-A W1-P BudgetTracker.
    expect(agent.BUDGET_KINDS).toEqual([
      "tokens_in",
      "tokens_out",
      "tool_calls",
      "revisions",
      "wall_clock",
    ]);
    const tracker = agent.createBudgetTracker("standard");
    expect(tracker).toBeInstanceOf(agent.BudgetTracker);
    expect(tracker.tier).toBe("standard");
    // The shared context assembler default is the exported class's instance.
    expect(agent.defaultContextAssembler).toBeInstanceOf(agent.ContextAssembler);
    // The §5.5 plan schema and the §5.1 machine agree on the canonical phases:
    // state.ts's RUN_PHASES stays the barrel's RUN_PHASES (not the tracker's).
    expect(agent.RUN_PHASES).not.toContain("plan");
  });
});
