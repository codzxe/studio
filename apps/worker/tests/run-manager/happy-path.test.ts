// apps/worker/tests/run-manager/happy-path.test.ts — the §24.1 coffee trace
// through StudioRunProcessor (W7-N; the W6-N suite's happy path).
//
// Spec anchors:
//   §24.1  the worked example this trace pins: standard tier, template path,
//          apply → fill, validator "0 blockers, 1 minor", critic accept,
//          agent.commit, 2-credit charge.
//   §5.1   plan first → one transaction → small steps → observe after act →
//          validate before critique → finalize; every transition lands in the
//          §5.1 table order.
//   §5.6   agent.begin before the first mutating command; agent.commit folds
//          the run into ONE undoable entry; .pcraft + checkpoint durable.
//   §13.2  the exact run-event timeline the client replays.
//   §14.2  rule 2: success commits the actual tier cost (standard = 2 credits).
//
// ALL fakes per repo conventions (fake-deps.ts); deterministic, no network.
import { describe, expect, it } from "vitest";
import { StudioRunProcessor } from "../../src/run-manager/processor.js";
import {
  COFFEE_DOCUMENT_ID,
  FAKE_NOW_MS,
  INSTAGRAM_TEMPLATE,
  PCRAFT_BYTES,
  PREVIEW_URL,
  VALIDATOR_MINOR_CODE,
  coffeePlan,
  defaultPcraftStorageKey,
  makeFakes,
  makeJob,
  validatorPassResult,
} from "./fake-deps.js";

/** Unwraps a recorded row list that must hold exactly one entry. */
function sole<T>(rows: readonly T[], label: string): T {
  expect(rows, label).toHaveLength(1);
  const head = rows[0];
  if (head === undefined) {
    throw new Error(`${label}: expected exactly one recorded row`);
  }
  return head;
}

describe("StudioRunProcessor — §24.1 happy path (standard tier, template path)", () => {
  it("runs plan → template_apply+fill → validate pass → critic accept → commit → full charge", async () => {
    const fakes = makeFakes();
    const processor = new StudioRunProcessor(fakes.deps);

    const outcome = await processor.process(makeJob(fakes));

    // -- §24.1 terminal: succeeded, full charge, one committed checkpoint ----
    expect(outcome.status).toBe("succeeded");
    expect(outcome.creditsUsed).toBe(2);
    expect(outcome.documentCheckpointId).toBe(defaultPcraftStorageKey(COFFEE_DOCUMENT_ID, 42));
    expect(outcome.warnings).toEqual([]);
    expect(outcome.error).toBeUndefined();

    // -- §5.1: the two plan steps executed, in order, with planned args -------
    expect(fakes.tools.toolRuns.map((run) => run.name)).toEqual(["template_apply", "template_fill"]);
    expect(fakes.tools.toolRuns[0]?.args).toEqual({ ref: INSTAGRAM_TEMPLATE });
    expect(fakes.tools.toolRuns[1]?.args).toEqual({
      headline: "Fresh roasted, every morning",
      subhead: "Open 7–5 · Main St",
      photo: "asset_812",
    });
    expect(fakes.models.executor.invocations.map((call) => call.plannedTool)).toEqual([
      "template_apply",
      "template_fill",
    ]);

    // -- planner: one §23.2 call; the persisted plan is the emitted plan -------
    expect(fakes.models.planner.prompts).toHaveLength(1);
    expect(fakes.models.planner.prompts[0]).toContain("BRIEF:");
    expect(fakes.models.planner.prompts[0]).toContain("CATALOG:");
    expect(fakes.db.savedPlans).toHaveLength(1);
    expect(fakes.db.savedPlans[0]?.plan).toEqual(coffeePlan());
    const planEvent = sole(fakes.emit.of("run.plan"), "run.plan");
    expect(planEvent.plan).toEqual(coffeePlan());

    // -- validator: one cycle, tool received the documentId + template pin ---
    expect(fakes.models.validatorArgs).toEqual([
      { documentId: COFFEE_DOCUMENT_ID, template: INSTAGRAM_TEMPLATE },
    ]);

    // -- critic: one §23.3 pass over the render + the validator report --------
    expect(fakes.models.criticArgs).toHaveLength(1);
    const criticArgs = fakes.models.criticArgs[0];
    if (criticArgs === undefined) {
      throw new Error("expected one critique call");
    }
    expect(criticArgs.brief).toContain("Coffee shop promo post");
    expect(criticArgs.previewUrl).toBe(PREVIEW_URL);
    expect(criticArgs.palette).toEqual(["#6B4F3A", "#F4E7D3", "#D96C3B"]);
    expect(criticArgs.validatorReport).toBe(validatorPassResult().summary);
    expect(criticArgs.layerSummary).toContain("Headline");

    // -- §3.4: nothing was armed (no recovery, no cancel, one release) ---------
    expect(fakes.recovery.requests).toEqual([]);
    expect(fakes.cancellation.observations).toHaveLength(4); // plan, execute, validate, critique gates
    expect(fakes.engines.acquires).toHaveLength(1);
    expect(fakes.engines.sessions[0]?.releaseCount).toBe(1);
  });

  it("emits the §13.2 timeline in order and persists the §5.1 transitions in order", async () => {
    const fakes = makeFakes();
    const processor = new StudioRunProcessor(fakes.deps);

    await processor.process(makeJob(fakes));

    // §5.1: queued → planning → executing → observing → rendering → validating
    //       → critiquing → finalizing (terminals write via finalizeRun).
    expect(fakes.db.statusCalls).toEqual([
      "planning",
      "executing",
      "observing",
      "rendering",
      "validating",
      "critiquing",
      "finalizing",
    ]);

    // §13.2: the exact timeline a client replays; run.queued is the gateway's.
    expect(fakes.emit.types()).toEqual([
      "run.plan",
      "run.started",
      "step.started",
      "step.finished",
      "step.started",
      "step.finished",
      "preview.updated",
      "validate.report",
      "critique.report",
      "credits.charged",
      "run.succeeded",
    ]);
    expect(fakes.emit.count("run.queued")).toBe(0);

    // run.started carries the §5.6 checkpoint revision the engine echoed.
    const started = sole(fakes.emit.of("run.started"), "run.started");
    expect(started.revisionBefore).toBe(41);

    // Step events: §23.1 directives, phase "executing", no §5.5 deviations.
    const startedSteps = fakes.emit.of("step.started");
    const finishedSteps = fakes.emit.of("step.finished");
    expect(startedSteps.map((step) => step.tool)).toEqual(["template_apply", "template_fill"]);
    expect(startedSteps.every((step) => step.phase === "executing")).toBe(true);
    expect(finishedSteps.map((step) => [step.stepSeq, step.tool, step.ok])).toEqual([
      [0, "template_apply", true],
      [1, "template_fill", true],
    ]);
    expect(finishedSteps.every((step) => step.deviationFromPlan === false)).toBe(true);
    expect(finishedSteps.every((step) => step.durationMs === 0)).toBe(true);

    // §5.1 observe after act: the ≤1024 px preview rides with the revision the
    // two tool bumps reached (41 → 43).
    const preview = sole(fakes.emit.of("preview.updated"), "preview.updated");
    expect(preview.url).toBe(PREVIEW_URL);
    expect(preview.revision).toBe(43);

    // §24.1: "0 blockers, 1 minor: subhead 14px from safe area" — minors never
    // gate (§11.1) and never ride the run warnings.
    const validate = sole(fakes.emit.of("validate.report"), "validate.report");
    expect(validate.ok).toBe(true);
    expect(validate.blockers).toEqual([]);
    expect(validate.majors).toEqual([]);
    expect(validate.minors).toEqual([VALIDATOR_MINOR_CODE]);

    // §24.1 critique: 4/4/5/5/4/5 accept.
    const critique = sole(fakes.emit.of("critique.report"), "critique.report");
    expect(critique.verdict).toBe("accept");
    expect(critique.scores).toEqual({
      hierarchy: 4,
      balance: 4,
      contrast: 5,
      brief_adherence: 5,
      brand_fit: 4,
      editability: 5,
    });
    expect(critique.issues).toEqual([]);

    // §14.2 rule 2 → credits.charged (full, not partial) → run.succeeded.
    const charged = sole(fakes.emit.of("credits.charged"), "credits.charged");
    expect(charged.charged).toBe(2);
    expect(charged.partial).toBe(false);
    const succeeded = sole(fakes.emit.of("run.succeeded"), "run.succeeded");
    expect(succeeded.revisionAfter).toBe(42); // the §5.6 fold bumps the revision once
    expect(succeeded.warnings).toEqual([]);
  });

  it("commits the §5.6 transaction exactly once and settles §14.2 rule 2 in the ledger", async () => {
    const fakes = makeFakes();
    const processor = new StudioRunProcessor(fakes.deps);

    await processor.process(makeJob(fakes));

    // §5.6: agent.begin before the first mutating command; agent.commit folds
    // the run into ONE undoable entry — no rollback on the happy path.
    expect(fakes.engines.sessions[0]?.txCalls.map((call) => call.command)).toEqual([
      "agent.begin",
      "agent.commit",
    ]);

    // The begin marker row (the WAL keeps only markers here — content commands
    // ride the engine, tracked by the tool wiring, not this seam).
    expect(fakes.wal.rows).toEqual([
      {
        documentId: COFFEE_DOCUMENT_ID,
        seq: 1,
        commandName: "agent.begin",
        params: { name: "agent-run run_coffee_1" },
        revisionBefore: 41,
        revisionAfter: 41,
      },
    ]);

    // §3.3 step 6: .pcraft bytes to object storage at the documents key, and
    // the durable checkpoint row (document_versions replay base).
    expect(fakes.storage.puts).toEqual([
      { key: defaultPcraftStorageKey(COFFEE_DOCUMENT_ID, 42), bytes: PCRAFT_BYTES },
    ]);
    expect(fakes.checkpoints.saved).toEqual([
      {
        documentId: COFFEE_DOCUMENT_ID,
        runId: "run_coffee_1",
        seq: 1,
        revision: 42,
        storageKey: defaultPcraftStorageKey(COFFEE_DOCUMENT_ID, 42),
        checkpointRef: { engineSnapshotId: 1 },
      },
    ]);

    // §14.2 rule 2: one commit row settling the full hold (delta 0), never a
    // refund; the §14.2 rule-1 hold remains the only other row.
    const commits = fakes.ledger.ofKind("commit");
    expect(commits).toHaveLength(1);
    expect(commits[0]?.delta).toBe(0);
    expect(commits[0]?.idempotencyKey).toBe("run_coffee_1:commit");
    expect(commits[0]?.runId).toBe("run_coffee_1");
    expect(fakes.ledger.ofKind("refund")).toEqual([]);
    expect(fakes.ledger.balanceAfter("org_main")).toBe(-2); // hold → charge, no refund

    // §22 usage rollup: numbers only, from the two fake executor streams.
    const usage = sole(fakes.db.usage, "recordUsage");
    expect(usage.runId).toBe("run_coffee_1");
    expect(usage.usage).toEqual({ tokensIn: 1_200, tokensOut: 300, cacheHits: 900 });

    // §3.3 step 6/7: the terminal write.
    const finalization = sole(fakes.db.finalizations, "finalizeRun");
    expect(finalization.runId).toBe("run_coffee_1");
    expect(finalization.status).toBe("succeeded");
    expect(finalization.revisionAfter).toBe(42);
    expect(finalization.creditsCharged).toBe(2);
    expect(finalization.error).toBeUndefined();
    expect(finalization.finishedAt).toEqual(new Date(FAKE_NOW_MS));

    // The row itself is terminal — §3.4 retries replay, never re-apply.
    expect(fakes.row.status).toBe("succeeded");
    expect(fakes.row.creditsCharged).toBe(2);
  });
});
