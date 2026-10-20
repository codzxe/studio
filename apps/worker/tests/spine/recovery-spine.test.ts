// apps/worker/tests/spine/recovery-spine.test.ts — the §3.4 crash-recovery story at
// PROCESS level, against a REAL spawned mock-engine:
//
//   1. checkpoint: doc.new → batch [layer.new.layer, type.create] → doc.save (revision R);
//   2. the mock process CRASHES while a mutating command is in flight (MOCK_FAULT=
//      crash-on-command kills it with exit code 86 before the reply — socket drop);
//   3. the client surfaces connection_dropped_mid_call with the §MCP-bridge
//      may-have-completed semantics: retryable false, hint = "the operation may have
//      completed; inspect the document before re-sending" (edits are never auto-resent,
//      vendor #1007);
//   4. restart a clean engine on a NEW ephemeral port → doc.open the checkpoint →
//      replay the run's remaining commands exactly once → the revision advanced by
//      exactly what replayed → doc.save the resumed state ("replay to checkpoint,
//      resume once").
//
// The crash lands on a standalone engine.execute rather than inside a server-side
// batch: the committed mock fires faults on `engine.execute` dispatch only (its
// `batch` executes steps inside the process without re-entering dispatch — harness.ts
// header), so the fault-armed child survives the checkpoint batch and dies
// deterministically at the first standalone engine.execute — which this suite makes
// the armed edit.fill.
//
// Skip-guard: same as engine-spine.test.ts (mock-engine entry must exist).

import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isEngineError } from "@studio/engine-client";
import type { BatchStepInput, EngineClient } from "@studio/engine-client";
import {
  type MockEngineHandle,
  cleanupSpineRoot,
  layerNamesOf,
  makeEngineClient,
  makeSpineRoot,
  mockEngineEntry,
  rawInspect,
  spawnMockEngine,
  unwrapOutcome,
} from "./harness.js";

const mockEntry = mockEngineEntry();

const CHECKPOINT_PATH = "spine/recovery-checkpoint.pcraft";
/** The commands after the checkpoint — replayed exactly once after the restart. */
const REPLAY_STEPS: readonly BatchStepInput[] = [
  { command: "layer.new.layer", params: { name: "Subhead" } },
  { command: "edit.fill", params: { contents: "color", color: "#3e2b20" } },
];

interface RecoveryContext {
  readonly mock: MockEngineHandle;
  readonly client: EngineClient;
  readonly root: string;
  /** Revision pinned by the checkpoint save; -1 until the checkpoint test runs. */
  checkpointRevision: number;
  /** The restarted engine + its client, set by the recovery test. */
  restarted: { readonly mock: MockEngineHandle; readonly client: EngineClient } | null;
}

let ctx: RecoveryContext | undefined;
let root = "";

const spine = (): RecoveryContext => {
  if (ctx === undefined) {
    throw new Error("spine context not initialised (beforeAll failed)");
  }
  return ctx;
};

describe.skipIf(mockEntry === null)("§3.4 crash recovery spine — kill, inspect, replay, resume", () => {
  beforeAll(async () => {
    root = makeSpineRoot();
    const mock = await spawnMockEngine({ root, crashOnExecute: true });
    ctx = {
      mock,
      client: makeEngineClient(mock.port, mock.token),
      root,
      checkpointRevision: -1,
      restarted: null,
    };
  }, 30_000);

  afterAll(async () => {
    await ctx?.client.close();
    const restarted = ctx?.restarted;
    if (restarted !== undefined && restarted !== null) {
      await restarted.client.close();
      await restarted.mock.stop();
    }
    await ctx?.mock.stop();
    if (root !== "") {
      cleanupSpineRoot(root);
    }
  });

  it("checkpoints the run: doc.new → batch → doc.save pins revision R", async () => {
    // Safe under the armed fault: `batch` never re-enters engine.execute dispatch.
    const created = unwrapOutcome(
      await spine().client.newDocument({
        width: 1080,
        height: 1080,
        name: "Recovery Demo",
      }),
    );
    expect(created.document).toBe(0);
    const batch = unwrapOutcome(
      await spine().client.runBatch({
        steps: [
          { command: "layer.new.layer", params: { name: "Background" } },
          { command: "type.create", params: { text: "Single Origin", x: 540, y: 420, size: 72 } },
        ],
      }),
    );
    expect(batch.failed).toBe(0);
    expect(batch.completed).toBe(2);
    const saved = unwrapOutcome(await spine().client.saveDocument({ path: CHECKPOINT_PATH }));
    expect(saved.path).toBe(CHECKPOINT_PATH);
    const onDisk = path.join(spine().root, ...CHECKPOINT_PATH.split("/"));
    expect(existsSync(onDisk), "the checkpoint file must exist on disk").toBe(true);
    spine().checkpointRevision = (await rawInspect(spine().client)).revision;
  }, 15_000);

  it("crashes the engine mid-run and surfaces connection_dropped_mid_call (§3.4)", async () => {
    // Mutating engine.execute, armed to die before its reply: the socket drops while
    // the request is in flight — the client must NOT auto-resend (vendor #1007).
    const outcome = await spine().client.executeCommand(
      { command: "edit.fill", params: { contents: "color", color: "#f5ede3" } },
      { kind: "mutate" },
    );
    expect(outcome.ok).toBe(false);
    expect(isEngineError(outcome)).toBe(true);
    if (!isEngineError(outcome)) {
      return; // narrows the envelope for the assertions below
    }
    expect(outcome.code).toBe("connection_dropped_mid_call");
    // §MCP bridge: mutating drops are never auto-retried — inspect, then decide.
    expect(outcome.retryable).toBe(false);
    expect(outcome.hint).toContain("may have completed");
    expect(outcome.hint).toContain("inspect");
    // The underlying failure travels as data (§5.7), never dropped; its exact shape
    // is the facade's business — the spine pins the envelope contract (code +
    // retryable + hint + a data cause), not the diagnostics.
    expect(
      outcome.data !== undefined && typeof outcome.data === "object",
      "the envelope carries its cause as data",
    ).toBe(true);
    // The fault hook really killed the process (not a timeout, not a graceful close).
    const exit = await spine().mock.exited;
    expect(exit.code !== null && exit.code !== 0, `exit ${JSON.stringify(exit)}`).toBe(true);
  }, 15_000);

  it("recovers §3.4-style: restart on a new port → doc.open → replay → revision advanced", async () => {
    // Restart a CLEAN engine on the same root (no fault armed) and connect a fresh
    // client — the engine-pool supervisor's move after a crash. spawnMockEngine
    // always binds a fresh ephemeral port, so this IS the new-port restart.
    const fresh = await spawnMockEngine({ root: spine().root });
    const client = makeEngineClient(fresh.port, fresh.token);
    spine().restarted = { mock: fresh, client };

    const reopened = unwrapOutcome(
      await client.call("doc.open", { path: CHECKPOINT_PATH }, { kind: "mutate" }),
    );
    expect(reopened !== null && typeof reopened === "object").toBe(true);
    const before = await rawInspect(client);

    if (before.revision === spine().checkpointRevision) {
      // The inspect-first payoff of the may-have-completed semantics: the reopened
      // checkpoint proves the crashed edit.fill never persisted, so replaying the
      // post-checkpoint commands is safe (§3.4: replay to checkpoint, resume once).
      // The committed mock synthesizes doc.open instead of rehydrating (README ›
      // Known deviations), so this branch upgrades to a full proof only on a
      // persistence-capable mock — the replay below holds either way.
      expect(layerNamesOf(before)).not.toContain("Subhead");
    }

    // Replay the run's remaining commands exactly once.
    const replayed = unwrapOutcome(await client.runBatch({ steps: REPLAY_STEPS }));
    expect(replayed.failed).toBe(0);
    expect(replayed.completed).toBe(2);

    const after = await rawInspect(client);
    // The revision advanced by exactly the replayed mutating commands (delta, not
    // absolute — see engine-spine.test.ts).
    expect(after.revision).toBe(before.revision + 2);
    expect(layerNamesOf(after)).toContain("Subhead");

    // Persist the resumed state — the run completes despite the crash.
    const saved = unwrapOutcome(await client.saveDocument({ path: CHECKPOINT_PATH }));
    expect(saved.path).toBe(CHECKPOINT_PATH);
  }, 15_000);
});
