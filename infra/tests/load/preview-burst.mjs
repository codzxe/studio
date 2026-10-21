#!/usr/bin/env node
// §21 Load drill — preview read path.
//
// Sustained GET preview traffic at a fixed rate (default: 100 requests/min,
// spec §21) for N minutes, at a bounded concurrency, against one preview URL
// (§13.1 `GET /v1/documents/:id/preview?w=1024`). Reports p50/p95/p99, error
// rate, achieved throughput, per-window latency buckets, and the "knee":
// the first window where p50 ≥ 2× the baseline p50 (latency doubling point) —
// the box's saturation signal used to document scaling triggers.
//
// `--ramp` doubles the offered rate each phase to actively hunt the knee;
// sustained mode instead watches for drift at the §21 target rate.
//
// Zero npm dependencies; Node 22+. Opt-in drill — not CI-blocking.

import {
  fetchFull,
  headersFromArgs,
  line,
  pad,
  padL,
  parseArgs,
  percentile,
  fmtBytes,
  fmtMs,
  fmtPct,
  nowIso,
  printJson,
  summarize,
} from "./lib/common.mjs";

const USAGE = `
preview-burst — §21 load drill: 100 preview GETs/min sustained, find the knee.

Usage:
  node preview-burst.mjs --url <preview-url> [options]

Options:
  --url <u>            (required) full preview URL, e.g.
                       http://127.0.0.1:3000/v1/documents/<id>/preview?w=1024
  --rate <n>          offered requests/min            (default 100, §21)
  --minutes <n>        sustained duration in minutes   (default 2)
  --concurrency <n>   max in-flight requests           (default 10)
  --header "K: V"     extra request header (repeatable: auth cookie, API key)
  --timeout-ms <n>    per-request timeout              (default 15000)
  --bucket-seconds <n> latency bucket size            (default 10)
  --ramp              double --rate each --phase-seconds until --max-rate
  --phase-seconds <n> ramp phase length               (default 20)
  --max-rate <n>      ramp ceiling, requests/min      (default rate × 32)
  --knee-factor <x>    p50 multiple vs baseline = knee (default 2)
  --error-budget <x>  error-rate budget for breach flag (default 0.05, §22 alert)
  --strict            exit 2 on knee / error-budget breach (CI-friendly)
  --json              additionally print one machine-readable JSON summary line
`.trim();

const args = parseArgs(
  process.argv.slice(2),
  {
    url: { type: "string", required: true, help: "preview URL" },
    rate: { type: "int", default: 100 },
    minutes: { type: "number", default: 2 },
    concurrency: { type: "int", default: 10 },
    header: { type: "string", repeat: true, default: [] },
    "timeout-ms": { type: "int", default: 15000 },
    "bucket-seconds": { type: "int", default: 10 },
    ramp: { type: "bool" },
    "phase-seconds": { type: "int", default: 20 },
    "max-rate": { type: "int", default: 0 },
    "knee-factor": { type: "number", default: 2 },
    "error-budget": { type: "number", default: 0.05 },
    strict: { type: "bool" },
    json: { type: "bool" },
  },
  USAGE,
);

if (args.rate <= 0 || args.minutes <= 0 || args.concurrency <= 0) {
  console.error(`--rate, --minutes and --concurrency must be > 0.\n${USAGE}`);
  process.exit(1);
}
const headers = headersFromArgs(args.header);
const maxRate = args.ramp ? (args["max-rate"] || args.rate * 32) : args.rate;
if (args.ramp && maxRate < args.rate) {
  console.error("--max-rate must be ≥ --rate.");
  process.exit(1);
}

// ---------------------------------------------------------------- scheduling

// Offered-load plan: [{atMs, ratePerMin}] — sustained is a single-phase plan.
function buildPlan() {
  const totalMs = args.ramp ? Infinity : args.minutes * 60_000;
  const phases = [];
  if (!args.ramp) {
    phases.push({ atMs: 0, rate: args.rate });
  } else {
    let at = 0;
    for (let rate = args.rate; rate <= maxRate; rate *= 2) {
      phases.push({ atMs: at, rate });
      at += args["phase-seconds"] * 1000;
    }
    phases.push({ atMs: at, rate: Infinity }); // sentinel: stop
  }
  return { phases, totalMs };
}

const plan = buildPlan();
const rateAt = (tMs) => {
  for (let i = plan.phases.length - 1; i >= 0; i--) {
    if (tMs >= plan.phases[i].atMs) return plan.phases[i].rate;
  }
  return plan.phases[0].rate;
};

// ------------------------------------------------------------------ recorder

const samples = []; // { ms, status, ok, bytes, bucket, rate }
const pendingQueue = []; // deferred starts when the concurrency cap is hit
let inFlight = 0;
let scheduledTotal = 0;
let deferredCount = 0;
let deferredMsTotal = 0;
let stopped = false;

const t0 = performance.now();
const bucketMs = args["bucket-seconds"] * 1000;

function launch(scheduledAtMs) {
  inFlight++;
  const rate = rateAt(performance.now() - t0);
  const bucket = Math.floor((performance.now() - t0) / bucketMs);
  fetchFull(args.url, { headers, timeoutMs: args["timeout-ms"] })
    .then((res) => {
      samples.push({
        ms: res.ms,
        status: res.status,
        ok: res.status >= 200 && res.status < 300,
        bytes: res.bytes,
        bucket,
        rate,
      });
    })
    .catch((err) => {
      samples.push({ ms: err.__class === "timeout" ? args["timeout-ms"] : null, status: 0, ok: false, bytes: 0, bucket, rate, transport: err.__class });
    })
    .finally(() => {
      inFlight--;
      const next = pendingQueue.shift();
      if (next) {
        const now = performance.now() - t0;
        deferredMsTotal += now - next;
        launch(next);
      }
    });
}

function offer(scheduledAtMs) {
  scheduledTotal++;
  if (inFlight < args.concurrency) launch(scheduledAtMs);
  else {
    deferredCount++;
    pendingQueue.push(scheduledAtMs);
  }
}

function stop(reason) {
  stopped = true;
}

// --------------------------------------------------------------------- run

const totalMs = args.ramp
  ? plan.phases[plan.phases.length - 1].atMs
  : args.minutes * 60_000;

// 50 ms scheduler tick with a catch-up loop: fires every request whose
// scheduled time has come due (exact for sustained mode; in ramp mode very high
// rates are coalesced into per-tick bursts — offered count stays truthful).
let lastT = 0;
const scheduler = setInterval(() => {
  const t = performance.now() - t0;
  if (t >= totalMs) {
    clearInterval(scheduler);
    stop("plan-complete");
    return;
  }
  const rate = rateAt(t);
  if (!Number.isFinite(rate)) return;
  const interval = 60000 / rate;
  while (lastT + interval <= t && lastT + interval <= totalMs) {
    lastT += interval;
    offer(lastT);
  }
}, 50);

process.on("SIGINT", () => {
  clearInterval(scheduler);
  stop("sigint");
});

const drain = setInterval(() => {
  if (!stopped) return;
  if (inFlight === 0 && pendingQueue.length === 0) {
    clearInterval(drain);
    report();
  }
}, 50);

// -------------------------------------------------------------------- report

function windowStats() {
  const buckets = new Map();
  for (const s of samples) {
    const b = buckets.get(s.bucket) ?? { count: 0, ok: 0, ms: [], rate: s.rate, backlog: 0 };
    b.count++;
    if (s.ok) b.ok++;
    if (s.ms !== null) b.ms.push(s.ms);
    buckets.set(s.bucket, b);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, b]) => ({
      atSec: idx * args["bucket-seconds"],
      count: b.count,
      errorRate: 1 - b.ok / b.count,
      p50: percentile(b.ms, 0.5),
      p95: percentile(b.ms, 0.95),
      rate: b.rate,
    }));
}

function findKnee(windows) {
  const withSamples = windows.filter((w) => w.count >= 10);
  if (withSamples.length < 2) return null;
  const baseline = withSamples[0];
  const factor = args["knee-factor"];
  for (const w of withSamples.slice(1)) {
    if (w.p50 !== null && baseline.p50 !== null && w.p50 >= factor * baseline.p50) {
      return { atSec: w.atSec, p50: w.p50, baselineP50: baseline.p50, factor, errorRate: w.errorRate, rate: w.rate };
    }
  }
  return null;
}

function report() {
  const elapsedMs = performance.now() - t0;
  const ok = samples.filter((s) => s.ok);
  const failed = samples.filter((s) => !s.ok);
  const lat = summarize(ok.map((s) => s.ms).filter((m) => m !== null));
  const bytes = samples.reduce((a, s) => a + (s.bytes || 0), 0);
  const errorRate = samples.length ? failed.length / samples.length : 1;
  const windows = windowStats();
  const knee = findKnee(windows);
  const achievedRps = ok.length / (elapsedMs / 1000);

  console.log(line("═"));
  console.log(`§21 preview-burst drill — ${nowIso()}`);
  console.log(line("═"));
  console.log(`target            ${args.url}`);
  console.log(`mode              ${args.ramp ? `ramp ${args.rate}→${maxRate} req/min (${args["phase-seconds"]}s phases)` : `sustained ${args.rate} req/min × ${args.minutes} min`}`);
  console.log(`concurrency cap   ${args.concurrency}`);
  console.log(`offered           ${scheduledTotal} requests (${(scheduledTotal / (elapsedMs / 60000)).toFixed(1)}/min)`);
  if (deferredCount > 0) {
    console.log(`backpressure      ${deferredCount} deferred starts (avg wait ${(deferredMsTotal / deferredCount).toFixed(0)} ms) — concurrency cap saturated`);
  }
  console.log(line());
  console.log(`completed         ${samples.length}  ok ${ok.length}  failed ${failed.length}`);
  console.log(`error rate         ${fmtPct(errorRate)}${errorRate > args["error-budget"] ? "  ⚠ over §22 error budget" : ""}`);
  console.log(`achieved          ${achievedRps.toFixed(2)} ok req/s · ${fmtBytes(bytes)} transferred (${fmtBytes(bytes / (elapsedMs / 1000))}/s)`);
  console.log(`latency p50/p95/p99  ${fmtMs(lat.p50)} / ${fmtMs(lat.p95)} / ${fmtMs(lat.p99)}   (min ${fmtMs(lat.min)}, max ${fmtMs(lat.max)})`);

  console.log(line());
  console.log(`${pad("window", 10)}${pad("req", 6)}${pad("err%", 8)}${pad("p50", 12)}${pad("p95", 12)}${pad("req/min", 10)}`);
  for (const w of windows) {
    console.log(`${pad(`${w.atSec}s`, 10)}${pad(w.count, 6)}${pad((w.errorRate * 100).toFixed(1), 8)}${pad(fmtMs(w.p50), 12)}${pad(fmtMs(w.p95), 12)}${pad(w.rate, 10)}`);
  }

  console.log(line());
  if (knee) {
    console.log(`KNEE  latency doubled at t≈${knee.atSec}s (p50 ${fmtMs(knee.p50)} ≥ ${knee.factor}× baseline ${fmtMs(knee.baselineP50)})`);
    console.log(`      offered rate at knee ${knee.rate} req/min · error rate ${fmtPct(knee.errorRate)}`);
    console.log(`      SCALING TRIGGER: past this point add capacity (§3.1 gateway replicas / engine-pool sessions)`);
  } else {
    console.log(`KNEE  none — p50 stayed under ${args["knee-factor"]}× baseline at every sampled window`);
    console.log(`      headroom: no scaling trigger fired at this offered load`);
  }
  if (errorRate > args["error-budget"]) {
    console.log(`SCALING TRIGGER  error rate ${fmtPct(errorRate)} > ${fmtPct(args["error-budget"])} (§22 run-failure alert band)`);
  }
  if (deferredCount > scheduledTotal * 0.05) {
    console.log(`SCALING TRIGGER  ${deferredCount}/${scheduledTotal} starts deferred — raise concurrency or add a gateway replica (§3.1)`);
  }

  const summary = {
    drill: "preview-burst",
    url: args.url,
    mode: args.ramp ? "ramp" : "sustained",
    offered: scheduledTotal,
    ok: ok.length,
    failed: failed.length,
    errorRate,
    achievedRps: Number(achievedRps.toFixed(3)),
    p50: lat.p50,
    p95: lat.p95,
    p99: lat.p99,
    knee,
    backpressure: { deferred: deferredCount, avgDeferredMs: deferredCount ? Math.round(deferredMsTotal / deferredCount) : 0 },
    elapsedMs: Math.round(elapsedMs),
  };
  if (args.json) printJson("SUMMARY_JSON", summary);

  if (samples.length === 0) {
    console.error("\nno requests completed — is the target up? (opt-in drill, refusing to report zero samples)");
    process.exit(1);
  }
  const breached = args.strict && (knee !== null || errorRate > args["error-budget"]);
  process.exit(breached ? 2 : 0);
}
