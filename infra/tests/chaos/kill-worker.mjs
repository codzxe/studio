#!/usr/bin/env node
// §21 Chaos drill — kill a worker mid-job; verify queue retry + re-pick and
// the §3.4 outcome ("queue job retried with backoff ×3; if still failing,
// mark run failed and alert").
//
// Self-contained: no Valkey/BullMQ needed. The drill runs a minimal durable
// queue whose source of truth is an append-only JSONL event log (the same
// event shapes an operator would watch in production: enqueued / active /
// step / completed / retry_scheduled / failed_attempt / dead) and real worker
// child processes (this same file, `--child` mode) driven over IPC. The
// parent is the single queue arbiter + ledger writer.
//
// Scripted sequence:
//   1. enqueue 3 normal jobs + 1 poisoned job (simulated provider failure);
//      each job carries a run_id and a unique idempotency key (§13.4).
//   2. worker A claims job 1; while it is mid-run (step 2 of 3) the parent
//      SIGKILLs it — the kill -9.
//   3. expected outcome, asserted from the event log + ledger:
//        - a retry IS scheduled for the interrupted job with backoff
//          (visible `retry_scheduled` event, attempt 2, delay > 0);
//        - the surviving worker re-picks it (active attempt 2, different pid)
//          and carries it to `completed`;
//        - the ledger is charged exactly once per idempotency key (no
//          double-charge despite two processing attempts);
//        - the poisoned job fails with backoff ×3 (500/1000/2000 ms,
//          §3.4) and dead-letters: run failed + refund, no charge.
//
// Live-stack variant (documented, not automated): against the compose
// deployment run `docker compose kill -s SIGKILL worker`, then watch queue age
// and retries in the §22 metrics (queue depth/age, runs by status) and the
// BullMQ attempt counter — the same retry/re-pick/refund evidence this drill
// asserts. Runbook: docs/runbooks/RB-02-queue-backlog.md (backlog),
// RB-01-run-failure-spike.md (failure spike alerts).
//
// Zero npm dependencies; Node 22+. Opt-in drill — not CI-blocking.

import { mkdtempSync, rmSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createDrill } from "./lib/report.mjs";
import { openLedger } from "./lib/ledger.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------- child

async function childMain({ workerId }) {
  const send = (msg) => {
    try {
      process.send(msg);
    } catch {
      process.exit(0); // parent gone
    }
  };
  process.on("disconnect", () => process.exit(0));
  const claim = () => send({ t: "claim" });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  for (;;) {
    const msg = await new Promise((resolve) => {
      const onMessage = (m) => {
        process.off("message", onMessage);
        resolve(m);
      };
      process.on("message", onMessage);
      claim();
    });
    if (msg.t === "stop") process.exit(0);
    if (msg.t !== "assign") continue; // "empty" → loop
    const job = msg.job;
    const stepMs = job.stepMs ?? 250;
    for (let step = 1; step <= job.steps; step++) {
      await sleep(stepMs);
      send({ t: "step", job_id: job.job_id, step });
    }
    if (job.poison) {
      send({ t: "failed", job_id: job.job_id, reason: "simulated provider_error (drill poison)" });
    } else {
      send({ t: "done", job_id: job.job_id });
    }
  }
}

// ---------------------------------------------------------------------- usage

const argv = process.argv.slice(2);
if (argv[0] === "--child") {
  // self-spawned worker mode
  const workerId = argv.includes("--id") ? argv[argv.indexOf("--id") + 1] : `w${process.pid}`;
  await childMain({ workerId });
  process.exit(0);
}

const USAGE = `
kill-worker — §21 chaos drill: SIGKILL a worker mid-job; queue retry + re-pick.

Usage:
  node kill-worker.mjs [--keep-tmp]
`.trim();
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
const keepTmp = argv.includes("--keep-tmp");
if (argv.some((a) => !["--keep-tmp"].includes(a))) {
  console.error(`unknown option(s). ${USAGE}`);
  process.exit(1);
}

// ---------------------------------------------------------------------- drill

const drill = createDrill("§21 chaos drill — kill-worker (SIGKILL mid-job · queue retry · re-pick)");
const tmp = mkdtempSync(join(tmpdir(), "studio-kill-worker-"));
const queueLogPath = join(tmp, "queue.jsonl");
const ledger = openLedger(join(tmp, "ledger.jsonl"));

const TIER_CREDITS = { standard: 2, quick: 1 }; // §5.2
const BACKOFF_MS = [500, 1000, 2000]; // §3.4 backoff ×3
const MAX_ATTEMPTS = 3;

let seq = 0;
function logEvent(type, fields = {}) {
  const record = { seq: ++seq, at: new Date().toISOString(), ts: Date.now(), type, ...fields };
  appendFileSync(queueLogPath, `${JSON.stringify(record)}\n`);
  return record;
}

const jobs = [
  { job_id: "job-1", run_id: "run_w9l_kw_j1", tier: "standard", poison: false },
  { job_id: "job-2", run_id: "run_w9l_kw_j2", tier: "quick", poison: false },
  { job_id: "job-3", run_id: "run_w9l_kw_j3", tier: "standard", poison: false },
  { job_id: "job-4-poison", run_id: "run_w9l_kw_j4", tier: "quick", poison: true },
].map((j) => ({ ...j, idem_key: `w9l-kw-${j.job_id}`, status: "queued", attempt: 0, claimant: null, readyAt: 0 }));

const byId = new Map(jobs.map((j) => [j.job_id, j]));
const workers = new Map(); // pid → {child, id, currentJob}
let killedPid = null;
const terminal = new Set();

function eligibleJob() {
  const now = Date.now();
  return jobs.find((j) => j.status === "queued" && !terminal.has(j.job_id) && j.readyAt <= now);
}

function scheduleRetryOrDead(job, reason) {
  job.claimant = null;
  if (job.attempt >= MAX_ATTEMPTS) {
    job.status = "dead";
    terminal.add(job.job_id);
    logEvent("dead", { job_id: job.job_id, attempts: job.attempt, reason });
    const refund = ledger.apply({ type: "refund", key: job.idem_key, credits: TIER_CREDITS[job.tier], run_id: job.run_id, reason });
    drill.event(`job ${job.job_id} DEAD after ${job.attempt} attempts → refund posted (§3.4 mark failed)`);
    return;
  }
  const delay = BACKOFF_MS[job.attempt - 1];
  job.status = "queued";
  job.readyAt = Date.now() + delay;
  logEvent("retry_scheduled", { job_id: job.job_id, attempt: job.attempt + 1, delay_ms: delay, reason });
}

function spawnWorker(id) {
  const child = spawn(process.execPath, [SCRIPT_PATH, "--child", "--id", id], {
    cwd: HERE,
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  workers.set(child.pid, { child, id, currentJob: null });
  child.on("message", (msg) => {
    const w = workers.get(child.pid);
    if (!w) return;
    if (msg.t === "claim") {
      const job = eligibleJob();
      if (job) {
        job.status = "active";
        job.attempt += 1;
        job.claimant = child.pid;
        w.currentJob = job.job_id;
        logEvent("active", { job_id: job.job_id, attempt: job.attempt, worker_pid: child.pid, worker_id: id, run_id: job.run_id });
        child.send({ t: "assign", job: { job_id: job.job_id, poison: job.poison, steps: 3, stepMs: 250 } });
      } else {
        child.send({ t: "empty" });
      }
    } else if (msg.t === "step") {
      logEvent("step", { job_id: msg.job_id, step: msg.step, worker_pid: child.pid });
      // the chaos moment: kill worker A once job-1 reaches step 2
      if (msg.job_id === "job-1" && msg.step === 2 && id === "A") {
        killedPid = child.pid;
        logEvent("chaos_kill", { job_id: "job-1", worker_pid: child.pid, signal: "SIGKILL" });
        child.kill("SIGKILL");
      }
    } else if (msg.t === "done") {
      const job = byId.get(msg.job_id);
      if (job && job.claimant === child.pid) {
        job.status = "completed";
        terminal.add(job.job_id);
        logEvent("completed", { job_id: job.job_id, attempt: job.attempt, worker_pid: child.pid });
        const charge = ledger.apply({ type: "charge", key: job.idem_key, credits: TIER_CREDITS[job.tier], run_id: job.run_id });
        if (!charge.ok) drill.event(`charge refused for ${job.job_id}: ${charge.message}`);
        w.currentJob = null;
      }
    } else if (msg.t === "failed") {
      const job = byId.get(msg.job_id);
      if (job && job.claimant === child.pid) {
        logEvent("failed_attempt", { job_id: job.job_id, attempt: job.attempt, worker_pid: child.pid, reason: msg.reason });
        scheduleRetryOrDead(job, msg.reason);
        w.currentJob = null;
      }
    }
  });
  child.on("exit", (code, signal) => {
    const w = workers.get(child.pid);
    if (w && signal === "SIGKILL") drill.event(`worker ${w.id} (pid ${child.pid}) died by SIGKILL (exit code ${code})`);
    workers.delete(child.pid);
    // §3.4 stalled-job handling: a job claimed by a dead worker is retried
    const claimed = jobs.find((j) => j.claimant === child.pid && !terminal.has(j.job_id));
    if (claimed) {
      drill.event(`queue detected job ${claimed.job_id} orphaned by the dead worker → retry`);
      scheduleRetryOrDead(claimed, "worker_killed");
    }
  });
  return child;
}

let failures = 0;
try {
  drill.phase("setup — durable JSONL queue + idempotent ledger");
  drill.info(`scratch ${tmp}`);

  drill.phase("enqueue 4 jobs (3 normal, 1 poisoned) and start worker A");
  for (const j of jobs) logEvent("enqueued", { job_id: j.job_id, run_id: j.run_id, tier: j.tier, idem_key: j.idem_key, poison: j.poison });
  for (const j of jobs) {
    const r = ledger.apply({ type: "reserve", key: j.idem_key, credits: TIER_CREDITS[j.tier], run_id: j.run_id });
    if (!r.ok) throw new Error(`reserve failed for ${j.job_id}`);
  }
  drill.info("credits reserved for all 4 runs (§3.3)");
  const workerA = spawnWorker("A");

  // wait until worker A is mid-job-1 (step 2) and got killed
  await new Promise((resolve) => {
    const t = setInterval(() => {
      if (killedPid !== null) {
        clearInterval(t);
        resolve();
      }
    }, 20);
    setTimeout(() => {
      clearInterval(t);
      resolve();
    }, 15000);
  });
  drill.check("worker A was SIGKILLed mid-job (at step 2 of job-1)", killedPid !== null, killedPid ? `pid ${killedPid}` : "kill never happened");
  await new Promise((r) => setTimeout(r, 30));
  drill.check("worker A exit signal was SIGKILL", workerA.signalCode === "SIGKILL" || workerA.killed, `signal=${workerA.signalCode}`);

  drill.phase("recovery — surviving worker picks up retries (§3.4)");
  const workerB = spawnWorker("B");
  drill.event("worker B started — watches the queue for retries");

  // wait for all jobs to reach a terminal state (completed/dead)
  await new Promise((resolve) => {
    const t = setInterval(() => {
      if (terminal.size === jobs.length) {
        clearInterval(t);
        resolve();
      }
    }, 50);
    setTimeout(() => {
      clearInterval(t);
      resolve();
    }, 60000);
  });
  workerB.send({ t: "stop" });
  await new Promise((r) => setTimeout(r, 150));

  // ------------------------------------------------------------ assertions
  drill.phase("expected outcome — retry visible, job re-picked, no double-charge, ×3 backoff dead-letter");

  const events = () => {
    const lines = [];
    const raw = readAll(queueLogPath);
    for (const l of raw.split("\n")) if (l.trim()) lines.push(JSON.parse(l));
    return lines;
  };
  const all = events();

  const retry1 = all.find((e) => e.type === "retry_scheduled" && e.job_id === "job-1");
  drill.check("retry visible in the queue for the interrupted job (retry_scheduled)", Boolean(retry1), retry1 ? `attempt ${retry1.attempt}, delay ${retry1.delay_ms} ms, reason ${retry1.reason}` : "no retry event");
  drill.check("the retry has backoff > 0", Boolean(retry1 && retry1.delay_ms > 0), retry1 ? `${retry1.delay_ms} ms` : "");

  const actives1 = all.filter((e) => e.type === "active" && e.job_id === "job-1");
  const repick = actives1.find((e) => e.attempt === 2 && e.worker_pid !== killedPid);
  drill.check("job re-picked by the surviving worker (active attempt 2, different pid)", Boolean(repick), repick ? `picked by pid ${repick.worker_pid} (${repick.worker_id})` : "no re-pick event");
  const done1 = all.find((e) => e.type === "completed" && e.job_id === "job-1");
  drill.check("interrupted job reached completed via the re-pick", Boolean(done1) && done1.attempt === 2, done1 ? `completed on attempt ${done1.attempt}` : "not completed");

  const poisonAttempts = all.filter((e) => e.type === "failed_attempt" && e.job_id === "job-4-poison");
  const poisonRetries = all.filter((e) => e.type === "retry_scheduled" && e.job_id === "job-4-poison");
  const poisonDead = all.find((e) => e.type === "dead" && e.job_id === "job-4-poison");
  drill.check("poisoned job retried with backoff ×3 (§3.4)", poisonAttempts.length === MAX_ATTEMPTS && poisonRetries.length === MAX_ATTEMPTS - 1 && poisonDead, `attempts ${poisonAttempts.map((e) => e.attempt).join(",")} · backoffs ${poisonRetries.map((e) => e.delay_ms).join(",")} ms`);
  const poisonRefund = ledger.of("w9l-kw-job-4-poison");
  drill.check(
    "dead-lettered run refunded, never charged",
    poisonRefund.filter((e) => e.type === "refund").length === 1 && poisonRefund.every((e) => e.type !== "charge"),
    poisonRefund.map((e) => `${e.type}:${e.credits}`).join(", "),
  );

  // double-charge guard: replay a completed job's charge with the same key
  const dup = ledger.apply({ type: "charge", key: "w9l-kw-job-1", credits: TIER_CREDITS.standard, run_id: "run_w9l_kw_j1" });
  drill.check("replayed charge refused — no double-charge despite two processing attempts", dup.ok === false && dup.code === "duplicate_entry", dup.message);

  const charges = ledger.query((e) => e.type === "charge");
  drill.check("ledger charged exactly once per completed run (3 charges)", charges.length === 3, `${charges.length} charges: ${charges.map((c) => c.key).join(", ")}`);
  const completedCount = all.filter((e) => e.type === "completed").length;
  const deadCount = all.filter((e) => e.type === "dead").length;
  drill.check("queue drained: 3 completed + 1 dead-lettered", completedCount === 3 && deadCount === 1, `completed=${completedCount} dead=${deadCount}`);

  drill.phase("queue event log (evidence)");
  for (const e of all) {
    const detail = e.type === "active" ? `attempt ${e.attempt} by ${e.worker_id} (pid ${e.worker_pid})`
      : e.type === "retry_scheduled" ? `attempt ${e.attempt} in ${e.delay_ms} ms (${e.reason})`
      : e.type === "step" ? `step ${e.step} (${e.worker_id})`
      : e.type === "chaos_kill" ? `SIGKILL → worker A (pid ${e.worker_pid})`
      : e.type === "failed_attempt" ? `attempt ${e.attempt}: ${e.reason}`
      : e.type === "completed" ? `attempt ${e.attempt}`
      : "";
    console.log(`  ${String(e.seq).padStart(3)}  ${e.type.padEnd(17)} ${e.job_id ?? ""} ${detail}`);
  }

  failures = drill.summary({
    expectedOutcome: "worker killed mid-job → retry scheduled with backoff (visible) → job re-picked and completed → charged once; poison retried ×3 → dead-lettered + refunded",
    crossLinks: [
      "runbook: docs/runbooks/RB-02-queue-backlog.md",
      "runbook: docs/runbooks/RB-01-run-failure-spike.md",
      "prod parity: BullMQ stalled-job recovery + worker run-recovery (apps/worker/src/recovery/)",
    ],
  });
} catch (err) {
  drill.check("drill completed without unexpected errors", false, `${err?.stack ?? err?.message ?? err}`);
  failures = drill.summary({ expectedOutcome: "drill aborted — inspect the failure above" });
} finally {
  for (const w of workers.values()) {
    try {
      w.child.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }
  if (!keepTmp) {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

process.exit(failures > 0 ? 1 : 0);

// ---------------------------------------------------------------------- utils

function readAll(p) {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}
