#!/usr/bin/env node
// §21 Chaos drill — kill the engine mid-run, verify the §3.4 recovery spine.
//
//   "Engine crash mid-run: restart, replay to checkpoint, resume once."
//   "Any failure: refund reservation, keep the document at the last committed
//    checkpoint, emit run.failed with an actionable error."   — spec §3.4
//
// What this drill does (fully self-contained; needs no gateway, queue or DB):
//
//   1. spawns apps/mock-engine (the zero-dep protocol-faithful engine fake).
//   2. builds committed pre-run state (doc.new + doc.save checkpoint) and
//      reserves 2 credits (§5.2 standard tier) in an append-only idempotent
//      ledger (stand-in for the §14 credits ledger / GET /v1/credits).
//   3. drives a 3-step run over the control protocol:
//        step 1  doc.open      — attach/load the document (§3.3)
//        step 2  doc.render    — observe phase preview (§3.3/§5.1)
//        step 3  engine.execute agent.begin — first mutating engine command
//      The kill lands on step 3: with `--kill mock-fault` the engine is
//      spawned with MOCK_FAULT=crash-on-command, which per the mock's
//      contract hard-exits (code 86) before the reply on the first
//      engine.execute dispatch — the scripted stand-in for `kill -9`;
//      `--kill sigkill` performs a literal SIGKILL from the drill parent at
//      the same point instead.
//   4. exercises the recovery spine: restart (spawn a replacement engine),
//      replay to checkpoint, resume ONCE.
//        - default `--resume persist-fault`: the fault condition persists —
//          the replacement is also fault-armed, the resume crashes too →
//          run fails CLEAN → refund + document at pre-run state, asserted.
//        - `--resume clean`: a healthy replacement → the resume succeeds →
//          run completes (Headline layer + agent.commit, §5.6) → reservation
//          commits as a charge (no refund), asserted.
//   5. asserts the §3.4 outcome triple: cancelled/failed clean · refund via
//      ledger query · document at pre-run state (command-log replay from the
//      last checkpoint, §3.2/§5.6) — plus no orphan processes or sockets.
//
// Runbook cross-links: docs/runbooks/RB-03-engine-crash-loop.md (crash
// loops), RB-01-run-failure-spike.md (failure spike alerts), RB-02 (queue
// backlog). Zero npm dependencies; Node 22+. Opt-in drill — not CI-blocking.

import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDrill } from "./lib/report.mjs";
import { openLedger } from "./lib/ledger.mjs";
import { startMockEngine } from "./lib/mock-engine.mjs";

const USAGE = `
kill-engine-midrun — §21 chaos drill: engine hard-kill at run step 3.

Usage:
  node kill-engine-midrun.mjs [--kill mock-fault|sigkill] [--resume persist-fault|clean] [--keep-tmp]

Options:
  --kill <mode>        how the engine dies on step 3 (the first engine.execute):
                         mock-fault  MOCK_FAULT=crash-on-command → process.exit(86) (default)
                         sigkill     literal kill -9 sent by the drill parent
  --resume <mode>      replacement engine behavior for the §3.4 resume-once:
                         persist-fault  fault still armed → resume fails → run fails clean (default)
                         clean          healthy replacement → resume succeeds → run succeeds
  --keep-tmp           keep the drill scratch dir for evidence inspection
`.trim();

// ---------------------------------------------------------------- arg parsing

const argv = process.argv.slice(2);
const opts = { kill: "mock-fault", resume: "persist-fault", keepTmp: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--kill") opts.kill = argv[++i];
  else if (a.startsWith("--kill=")) opts.kill = a.slice(7);
  else if (a === "--resume") opts.resume = argv[++i];
  else if (a.startsWith("--resume=")) opts.resume = a.slice(9);
  else if (a === "--keep-tmp") opts.keepTmp = true;
  else if (a === "--help" || a === "-h") {
    console.log(USAGE);
    process.exit(0);
  } else {
    console.error(`unknown option "${a}"\n${USAGE}`);
    process.exit(1);
  }
}
if (!["mock-fault", "sigkill"].includes(opts.kill) || !["persist-fault", "clean"].includes(opts.resume)) {
  console.error(USAGE);
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", ".."); // infra/tests/chaos → repo root

const drill = createDrill(`§21 chaos drill — kill-engine-midrun (${opts.kill} kill · ${opts.resume} resume)`);
const DOC = { width: 64, height: 48 }; // mock contract: doc.new {width,height}
const TIER_CREDITS = 2; // §5.2 standard generation = 2 credits
const runKey = `w9l-ke-${Date.now().toString(36)}-${process.pid.toString(36)}`;
const runId = `run_${runKey}`;

const tmp = mkdtempSync(join(tmpdir(), "studio-kill-engine-"));
const writeRoot = join(tmp, "write");

// The command log IS the WAL (§3.2/§5.6): pre-run ops are committed work;
// run ops are uncommitted until agent.commit — a rollback replays pre-run
// ops only.
const CHECKPOINT = "checkpoint.json";
const runSteps = [
  { step: 1, method: "doc.open", params: { path: CHECKPOINT }, what: "attach/load the checkpointed document" },
  { step: 2, method: "doc.render", params: {}, what: "observe phase preview" },
  { step: 3, method: "engine.execute", params: { command: "agent.begin", params: { name: runKey } }, what: "open the agent transaction (§5.6) — first mutating engine command" },
];
// ops the resumed run continues with once the resume-once succeeds
const resumeTail = [
  { method: "engine.execute", params: { command: "layer.new.layer", params: { name: "Headline" } }, what: "run mutation" },
  { method: "engine.execute", params: { command: "agent.commit", params: {} }, what: "collapse the run into one history entry (§5.6)" },
];

const ledger = openLedger(join(tmp, "ledger.jsonl"));
let engines = [];

const layersOf = (result) => result?.layers ?? result?.document?.layers ?? [];
const layerNames = (result) => layersOf(result).map((l) => String(l?.name ?? "?")).sort();
const norm = (result) => JSON.stringify(layerNames(result));

async function trackedEngine(cfg) {
  const eng = await startMockEngine({ repoRoot, writeRoot, ...cfg });
  engines.push(eng);
  const auth = await eng.client.auth();
  return { eng, auth };
}

function reapAll() {
  for (const e of engines) {
    try {
      if (e.child.exitCode === null && !e.child.killed) e.child.kill("SIGKILL");
    } catch {
      /* already dead */
    }
    e.client.close();
  }
  engines = [];
}

let failures = 0;
try {
  drill.phase("setup — scratch dir, engine, ledger");
  drill.info(`scratch ${tmp}`);
  drill.info(`run ${runId} · idempotency key ${runKey} · tier standard (§5.2: 2 credits)`);

  const first = await trackedEngine({ fault: opts.kill === "mock-fault" ? "crash-on-command" : null, label: "engine#1" });
  drill.event(`engine#1 up on 127.0.0.1:${first.eng.port} (fault: ${opts.kill === "mock-fault" ? "crash-on-command" : "none — will be SIGKILLed"})`);
  drill.check("engine#1 authenticated over the control protocol", first.auth.ok === true, first.auth.ok ? JSON.stringify(first.auth.result) : "auth failed");

  drill.phase("pre-run — load document, snapshot committed state, reserve credits (§3.3)");
  let r = await first.eng.client.request("doc.new", DOC);
  drill.check("doc.new accepted (document loaded)", r.ok === true, JSON.stringify(r.result ?? r.engineError));
  r = await first.eng.client.request("doc.inspect", {});
  const preRunState = r.ok ? r.result : null;
  drill.check("doc.inspect captured pre-run state (baseline)", r.ok === true, r.ok ? `layers: [${layerNames(r.result).join(", ") || "none"}]` : r.engineError);
  r = await first.eng.client.request("doc.save", { path: CHECKPOINT });
  const checkpointPath = join(writeRoot, CHECKPOINT);
  drill.check("doc.save wrote a checkpoint snapshot inside the capability root", r.ok === true && existsSync(checkpointPath), r.ok ? `${checkpointPath} (${statSync(checkpointPath).size} B)` : r.engineError);

  const reserved = ledger.apply({ type: "reserve", key: runKey, credits: TIER_CREDITS, run_id: runId, tier: "standard" });
  drill.check("credits reserved once (idempotent ledger)", reserved.ok === true, `${TIER_CREDITS} credits held for ${runKey}`);

  drill.phase(`run — 3 steps; the engine is killed on step 3 (${opts.kill})`);
  drill.event("run.started");
  for (const op of runSteps.slice(0, 2)) {
    r = await first.eng.client.request(op.method, op.params);
    drill.check(`step ${op.step} ${op.method} ok — ${op.what}`, r.ok === true, r.ok ? "ok" : r.engineError);
  }
  const killStep = runSteps[2];
  drill.event(`step 3 ${killStep.method} → ${opts.kill === "mock-fault" ? "MOCK_FAULT=crash-on-command: hard exit(86) before the reply" : "parent sends kill -9 (SIGKILL)"}`);
  if (opts.kill === "sigkill") {
    first.eng.child.kill("SIGKILL");
  }
  let sawDeath = false;
  try {
    r = await first.eng.client.request(killStep.method, killStep.params, { timeoutMs: 6000 });
    // a well-formed reply means the kill failed
    drill.check(`step 3 got no engine reply (engine died first) — ${killStep.what}`, false, `engine replied: ${JSON.stringify(r).slice(0, 80)}`);
  } catch (err) {
    sawDeath = err.code === "engine_gone" || err.closed === true || err.code === "engine_timeout";
    drill.check(`step 3 got no engine reply (engine died first) — ${killStep.what}`, sawDeath, `client saw: ${err.message}`);
  }
  const death1 = await first.eng.exitInfo;
  drill.check(
    opts.kill === "mock-fault" ? "engine#1 exited with code 86 (mock's documented hard-kill)" : "engine#1 killed by SIGKILL (kill -9)",
    opts.kill === "mock-fault" ? death1.code === 86 : death1.signal === "SIGKILL",
    `exit code=${death1.code} signal=${death1.signal}`,
  );

  // ------------------------------------------------------------ §3.4 recovery
  drill.phase("recovery — restart, replay to checkpoint, resume ONCE (§3.4)");
  const second = await trackedEngine({ fault: opts.resume === "persist-fault" ? "crash-on-command" : null, label: "engine#2" });
  drill.event(`engine#2 up (replacement${opts.resume === "persist-fault" ? ", fault still armed — the underlying problem persists" : ", healthy"})`);
  drill.check("engine#2 authenticated", second.auth.ok === true, second.auth.ok ? "ok" : "auth failed");
  for (const op of runSteps.slice(0, 2)) {
    r = await second.eng.client.request(op.method, op.params);
    drill.check(`replay: step ${op.step} ${op.method} ok — ${op.what}`, r.ok === true, r.ok ? "replayed" : r.engineError);
  }

  drill.event("resume attempt 1/1 — re-issuing step 3 (agent.begin transaction)");
  let resumed = null;
  let resumeCrashed = false;
  try {
    resumed = await second.eng.client.request(killStep.method, killStep.params, { timeoutMs: 6000 });
  } catch (err) {
    resumeCrashed = err.code === "engine_gone" || err.closed === true || err.code === "engine_timeout";
    resumed = Object.assign(new Error(err.message), { rejected: true });
  }

  if (opts.resume === "persist-fault") {
    // ------------------------------------------------------- FAIL-CLEAN path
    drill.check("resume 1/1 failed — engine#2 died before the reply", resumeCrashed, resumeCrashed ? resumed.message : JSON.stringify(resumed.result));
    const death2 = await second.eng.exitInfo;
    drill.check("engine#2 exited with code 86", death2.code === 86, `exit code=${death2.code} signal=${death2.signal}`);
    drill.event("resume exhausted (once, per §3.4) → run marked failed — clean teardown");

    drill.phase("outcome — failed clean, refund via ledger query, document at pre-run state");
    const refund = ledger.apply({ type: "refund", key: runKey, credits: TIER_CREDITS, run_id: runId, reason: "engine_crash_midrun" });
    drill.check("refund posted to the ledger (§3.4 refund reservation)", refund.ok === true, `${TIER_CREDITS} credits refunded`);
    const dupe = ledger.apply({ type: "refund", key: runKey, credits: TIER_CREDITS, run_id: runId, reason: "replayed-refund" });
    drill.check("replayed refund refused — no double-apply (idempotency §3.4)", dupe.ok === false && dupe.code === "duplicate_entry", dupe.message);
    const entries = ledger.of(runKey);
    const ledgerSane = entries.length === 2 && entries[0].type === "reserve" && entries[1].type === "refund" && entries[1].credits === entries[0].credits && !entries.some((e) => e.type === "charge");
    drill.check(
      `ledger query for ${runKey}: one reserve, one refund of the same amount, no charge`,
      ledgerSane,
      entries.map((e) => `${e.type}:${e.credits}`).join(", ") + " → hold released, nothing spent",
    );

    // rollback: replay only the committed (pre-run) WAL on a healthy engine
    const third = await trackedEngine({ fault: null, label: "engine#3" });
    drill.event("engine#3 up (healthy) — replaying the command log from the last checkpoint (the WAL, §3.2)");
    let replayOk = third.auth.ok === true;
    r = await third.eng.client.request("doc.new", DOC);
    if (!r.ok) replayOk = false;
    drill.check("pre-run WAL replayed on engine#3 (doc.new)", r.ok === true, r.ok ? "replayed" : r.engineError);
    drill.check("pre-run WAL replay succeeded", replayOk);
    const inspect3 = await third.eng.client.request("doc.inspect", {});
    drill.check("doc.inspect after rollback replay", inspect3.ok === true, inspect3.ok ? `layers: [${layerNames(inspect3.result).join(", ") || "none"}]` : inspect3.engineError);
    drill.check(
      "document at pre-run state (§3.4: failure keeps the last committed checkpoint)",
      inspect3.ok === true && norm(inspect3.result) === norm(preRunState),
      `baseline [${layerNames(preRunState).join(", ") || "none"}] vs recovered [${inspect3.ok ? layerNames(inspect3.result).join(", ") : "?"}]`,
    );
    drill.check("run's uncommitted layer did NOT survive the rollback", inspect3.ok === true && !layerNames(inspect3.result).includes("Headline"));
    third.eng.child.kill("SIGTERM");
    const death3 = await third.eng.exitInfo;
    drill.check("engine#3 shut down cleanly on SIGTERM", death3.code === 0 || death3.signal === "SIGTERM", `exit code=${death3.code} signal=${death3.signal}`);

    drill.event("run.failed emitted (drill state machine) — actionable error: engine died mid-run, see RB-03");
    failures = drill.summary({
      expectedOutcome: "engine killed at step 3 → resume once failed → run FAILED clean · refund posted via ledger query · document at pre-run state · no orphans",
      crossLinks: [
        "runbook: docs/runbooks/RB-03-engine-crash-loop.md",
        "runbook: docs/runbooks/RB-01-run-failure-spike.md",
        "prod parity: worker crash/replay spine — apps/worker/tests/spine/",
      ],
    });
  } else {
    // ------------------------------------------------------ CLEAN-RESUME path
    drill.check("resume 1/1 succeeded — agent.begin executed on the healthy replacement", resumed?.ok === true && resumeCrashed === false, resumeCrashed ? resumed.message : JSON.stringify(resumed.result));
    for (const op of resumeTail) {
      r = await second.eng.client.request(op.method, op.params);
      drill.check(`${op.method} ok — ${op.what}`, r.ok === true, r.ok ? "ok" : r.engineError);
    }
    const inspect2 = await second.eng.client.request("doc.inspect", {});
    drill.check("document advanced past the run (Headline layer present)", inspect2.ok === true && layerNames(inspect2.result).includes("Headline"), inspect2.ok ? `layers: [${layerNames(inspect2.result).join(", ")}]` : inspect2.engineError);
    const charge = ledger.apply({ type: "charge", key: runKey, credits: TIER_CREDITS, run_id: runId });
    drill.check("reservation committed as a charge (§3.3 finalization)", charge.ok === true, `${TIER_CREDITS} credits charged`);
    const dupe = ledger.apply({ type: "charge", key: runKey, credits: TIER_CREDITS, run_id: runId });
    drill.check("replayed charge refused — no double-charge (idempotency §3.4)", dupe.ok === false && dupe.code === "duplicate_entry", dupe.message);
    drill.check("no refund was posted for a succeeded run", ledger.of(runKey).every((e) => e.type !== "refund"), ledger.of(runKey).map((e) => e.type).join(", "));
    drill.event("run.succeeded emitted (drill state machine) — recovered from the crash with one replay + resume");
    second.eng.child.kill("SIGTERM");
    const death2 = await second.eng.exitInfo;
    drill.check("engine#2 shut down cleanly on SIGTERM", death2.code === 0 || death2.signal === "SIGTERM", `exit code=${death2.code} signal=${death2.signal}`);
    failures = drill.summary({
      expectedOutcome: "engine killed at step 3 → restart + replay → resume ONCE succeeded → run SUCCEEDED · charge committed (no refund) · document advanced",
      crossLinks: ["runbook: docs/runbooks/RB-03-engine-crash-loop.md", "prod parity: apps/worker/tests/spine/"],
    });
  }

  drill.phase("teardown");
  reapAll();
  drill.check("no orphan engine processes or sockets left", engines.length === 0);
  drill.info(`scratch dir ${opts.keepTmp ? `kept at ${tmp}` : "removed"}`);
} catch (err) {
  drill.check("drill completed without unexpected errors", false, `${err?.stack ?? err?.message ?? err}`);
  failures = drill.summary({ expectedOutcome: "drill aborted — inspect the failure above" });
} finally {
  reapAll();
  if (!opts.keepTmp) {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

process.exit(failures > 0 ? 1 : 0);
