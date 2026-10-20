// apps/worker/tests/spine/recovery-spine.test.ts — the §3.4 crash-recovery story at
// PROCESS level, against a REAL spawned mock-engine:
//
//   1. checkpoint: doc.new → batch [layer.new.layer, type.create] → doc.save (revision R);
//   2. the mock process CRASHES while a mutating command is in flight (the armed fault
//      hook kills it before the reply — process.exit, socket drop);
//   3. the client surfaces connection_dropped_mid_call with the §MCP-bridge
//      may-have-completed semantics: retryable false, hint = "the operation may have
//      completed; inspect the document before re-sending" (edits are never auto-resent,
//      vendor #1007);
//   4. restart a clean engine on the same root → doc.open the checkpoint → inspect FIRST
//      (the crashed command provably never persisted) → replay the run's remaining
//      commands → the revision advanced by exactly what replayed → doc.save the resumed
//      state ("replay to checkpoint, resume once").
//
// The crash lands on a standalone engine.execute of the fault-armed command rather than
// inside a batch: the two mock-engine generations expose different fault conventions
// (per-command-id inside batches vs per-engine.execute dispatch — harness.ts header),
// and engine.execute is the intersection that crashes deterministically under both. When
// W2-F's README pins the final fault contract, a true mid-batch kill is a one-line change
// (arm crashOnCommand and send the crashing step inside the replay batch).
//
// Skip-guards: same as engine-spine.test.ts (mock-engine entry + resolvable EngineClient).

import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupSpineRoot,
  layerNamesOf,
  loadEngineClient,
  makeEngineClient,
  makeSpineRoot,
  mockEngineEntry,
  rawInspect,
  spawnMockEngine,
  unwrapOutcome,
  type MockEngineHandle,
  type SpineBatchStep,
  type SpineEngineClient,
  type SpineEngineClientCtor,
} from "./harness.js";

const mockEntry = mockEngineEntry();
const engineClientCtor = mockEntry === null ? null : await loadEngineClient();
const spineReady = mockEntry !== null && engineClientCtor !== null;

const CHECKPOINT_PATH = "spine/recovery-checkpoint.pcraft";
/** The commands after the checkpoint — replayed exactly once after the restart. */
const REPLAY_STEPS: readonly SpineBatchStep[] = [
  { command: "layer.new.layer", params: { name: "Subhead" } },
  { command: "edit.fill", params: { contents: "color", color: "#3e2b20" } },
];

interface RecoveryContext {
  readonly mock: MockEngineHandle;
  readonly client: SpineEngineClient;
  readonly root: string;
  /** Revision pinned by the checkpoint save; -1 until the checkpoint test runs. */
  checkpointRevision: number;
  /** The restarted engine + its client, set by the recovery test. */
  restarted: { readonly mock: MockEngineHandle; readonly client: SpineEngineClient } | null;
}

let ctx: RecoveryContext | undefined;
let root = "";

const spine = (): RecoveryContext => {
  if (ctx === undefined) {
    throw new Error("spine context not initialised (beforeAll failed)");
  }
  return ctx;
};

const ctor = (): SpineEngineClientCtor => {
  if (engineClientCtor === null) {
    throw new Error("EngineClient unavailable; the spine guard should have skipped this suite");
  }
  return engineClientCtor;
};

describe.skipIf(!spineReady)("§3.4 crash recovery spine — kill, inspect, replay, resume", () => {
  beforeAll(async () => {
    root = makeSpineRoot();
    const mock = await spawnMockEngine({ root, crashOnCommand: "edit.fill" });
    ctx = {
      mock,
      client: makeEngineClient(ctor(), mock.port, mock.token),
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

  it(
    "checkpoints the run: doc.new → batch → doc.save pins revision R",
    async () => {
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
    },
    15_000,
  );

  it(
    "crashes the engine mid-run and surfaces connection_dropped_mid_call (§3.4)",
    async () => {
      // Mutating call, armed to die before its reply: the socket drops while the
      // request is in flight — the client must NOT auto-resend (vendor #1007).
      const outcome = await spine().client.executeCommand(
        { command: "edit.fill", params: { contents: "color", color: "#f5ede3" } },
        { kind: "mutate" },
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) {
        return; // narrows the envelope for the assertions below
      }
      expect(outcome.code).toBe("connection_dropped_mid_call");
      // §MCP bridge: mutating drops are never auto-retried — inspect, then decide.
      expect(outcome.retryable).toBe(false);
      expect(outcome.hint).toContain("may have completed");
      expect(outcome.hint).toContain("inspect");
      // The underlying failure travels as data (§5.7), never dropped; its exact `source`
      // ("transport" vs "mid_call") is the facade's business — the spine pins the envelope
      // contract (code + retryable + hint), not the diagnostics.
      expect(
        outcome.data !== undefined && typeof outcome.data === "object",
        "the envelope carries its cause as data",
      ).toBe(true);
      // The fault hook really killed the process (not a timeout, not a graceful close).
      const exit = await spine().mock.exited;
      expect(exit.code !== null && exit.code !== 0, `exit ${JSON.stringify(exit)}`).toBe(true);
    },
    15_000,
  );

  it(
    "recovers §3.4-style: restart → doc.open → inspect-first → replay → revision advanced",
    async () => {
      // Restart a CLEAN engine on the same root (no fault armed) and connect a fresh
      // client — the engine-pool supervisor's move after a crash.
      const fresh = await spawnMockEngine({ root: spine().root });
      const client = makeEngineClient(ctor(), fresh.port, fresh.token);
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
    },
    15_000,
  );
});
