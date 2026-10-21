#!/usr/bin/env node
// §21 Load drill — run creation burst + SSE follow to terminal.
//
// 10 concurrent `POST /v1/documents/:id/runs` (spec §13.1) with a tier mix,
// each with a unique Idempotency-Key (§13.4: every mutating endpoint requires
// one; unique per burst so retries/blast-bursts never double-create), then
// SSE-follow each run (§13.2) to a terminal event. Per-tier run durations are
// compared against the §5.2 wall-clock budgets:
//   quick 2 min · standard 5 min · complex 10 min · premium 10 min · max 15 min
//   image 1 min · image_hd 2 min
//
// TARGET: the gateway, with the engine pool backed by apps/mock-engine
// (zero-dep protocol-faithful engine fake — see apps/mock-engine/README.md,
// env contract MOCK_ENGINE_PORT / MOCK_ENGINE_TOKEN). A mock-backed gateway is
// the cheap way to drill the full HTTP + queue + run spine without a real
// engine; a staging stack with real models also works but runs take §5.2-long
// wall-clock times.
//
// Zero npm dependencies; Node 22+. Opt-in drill — not CI-blocking.

import {
  fetchFull,
  followRunEvents,
  headersFromArgs,
  line,
  pad,
  parseArgs,
  fmtSec,
  nowIso,
  pool,
  printJson,
  summarize,
} from "./lib/common.mjs";
import { randomBytes as rb } from "node:crypto";

const USAGE = `
runs-burst — §21 load drill: 10 concurrent runs, per-tier wall clocks vs §5.2.

Usage:
  node runs-burst.mjs --base <url> --document <id> [options]

Options:
  --base <url>          (required) gateway base URL, e.g. http://127.0.0.1:3000
  --document <id>       (required) document id to run against
  --count <n>           runs per burst                (default 10, §21)
  --concurrency <n>     max runs in flight            (default 10)
  --mix <spec>          tier mix, "tier=count,…"     (default quick=4,standard=4,complex=1,premium=1)
                        known tiers: quick, standard, complex, premium, max, image, image_hd
  --prompt <text>       run brief                     (default a §24-style poster brief)
  --template <id>       optional template, e.g. instagram-post@3
  --header "K: V"       extra headers (repeatable: auth cookie / API key)
  --grace-ms <n>        allowed over the §5.2 wall clock (default 30000)
  --cancel-on-hang      POST /v1/runs/:id/cancel (§13.1) when the deadline is hit
  --strict              exit 2 if any run fails / hangs / breaches its budget
  --json                additionally print one machine-readable JSON summary line
`.trim();

// §5.2 run tiers and budgets — wall-clock column is the drill's comparison
// baseline; credits are echoed back from the create response.
const TIER_BUDGETS_MS = {
  quick: { minutes: 2 },
  standard: { minutes: 5 },
  complex: { minutes: 10 },
  premium: { minutes: 10 },
  max: { minutes: 15 },
  image: { minutes: 1 },
  image_hd: { minutes: 2 },
};
const TERMINAL = ["run.succeeded", "run.failed", "run.cancelled"];
const DEFAULT_PROMPT =
  "Design a bold product poster for a specialty coffee launch: headline, subhead, one photo slot, price tag; brand palette warm neutrals.";

const args = parseArgs(
  process.argv.slice(2),
  {
    base: { type: "string", required: true, help: "gateway base URL" },
    document: { type: "string", required: true, help: "document id" },
    count: { type: "int", default: 10 },
    concurrency: { type: "int", default: 10 },
    mix: { type: "string", default: "quick=4,standard=4,complex=1,premium=1" },
    prompt: { type: "string", default: DEFAULT_PROMPT },
    template: { type: "string" },
    header: { type: "string", repeat: true, default: [] },
    "grace-ms": { type: "int", default: 30000 },
    "cancel-on-hang": { type: "bool" },
    strict: { type: "bool" },
    json: { type: "bool" },
  },
  USAGE,
);
if (!/^[a-z0-9_@.-]+$/i.test(args.document)) {
  console.error(`--document looks invalid: ${args.document}`);
  process.exit(1);
}
if (!args.base.startsWith("http")) {
  console.error(`--base must be an http(s) URL, got ${args.base}`);
  process.exit(1);
}
const base = args.base.replace(/\/+$/, "");
const headers = headersFromArgs(args.header);

// ----------------------------------------------------------------- tier mix

const mix = new Map();
for (const entry of args.mix.split(",")) {
  const m = /^\s*([a-z_]+)\s*=\s*(\d+)\s*$/.exec(entry);
  if (!m) {
    console.error(`bad --mix entry "${entry}" — expected tier=count.`);
    process.exit(1);
  }
  const tier = m[1];
  if (!TIER_BUDGETS_MS[tier]) {
    console.error(`unknown tier "${tier}" (known: ${Object.keys(TIER_BUDGETS_MS).join(", ")})`);
    process.exit(1);
  }
  mix.set(tier, (mix.get(tier) ?? 0) + Number(m[2]));
}
const plan = [];
for (const [tier, n] of mix) for (let i = 0; i < n; i++) plan.push(tier);
while (plan.length < args.count) plan.push("standard");
if (plan.length > args.count) {
  console.error(`--mix sums to ${plan.length} runs but --count is ${args.count}.`);
  process.exit(1);
}

// ------------------------------------------------------------------- drill

const burstId = `w9l-${new Date().toISOString().replace(/[:.]/g, "")}-${rb(4).toString("hex")}`;
const results = [];

const t0 = performance.now();

await pool(args.count, args.concurrency, async (i) => {
  const tier = plan[i];
  const idemKey = `${burstId}-run-${i}`; // unique per run per burst (§13.4)
  const record = { tier, idemKey, runId: null, created: false, terminal: null, createMs: null, runMs: null, reservedCredits: null, error: null, hung: false };
  results[i] = record;

  // §13.1 create: POST /v1/documents/:id/runs { prompt, tier?, template? }
  let createRes;
  try {
    createRes = await fetchFull(`${base}/v1/documents/${encodeURIComponent(args.document)}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idemKey, ...headers },
      body: JSON.stringify({ prompt: args.prompt, tier, ...(args.template ? { template: args.template } : {}) }),
      timeoutMs: 30000,
    });
  } catch (err) {
    record.error = `create transport failure: ${err.__class ?? "error"}`;
    return;
  }
  record.createMs = createRes.ms;
  if (createRes.status < 200 || createRes.status >= 300) {
    // §13.3 envelope: { error: { code, message, hint?, retryable } }
    let code = `http_${createRes.status}`;
    try {
      const body = JSON.parse(createRes.body);
      if (body?.error?.code) code = `${code}:${body.error.code}`;
    } catch {
      /* non-JSON error body */
    }
    record.error = `create rejected (${code})`;
    return;
  }
  let runId = null;
  try {
    const body = JSON.parse(createRes.body);
    runId = body?.run_id ?? null;
    record.reservedCredits = body?.credits_reserved ?? null;
  } catch {
    record.error = "create response was not JSON";
    return;
  }
  if (!runId) {
    record.error = "create response missing run_id";
    return;
  }
  record.runId = runId;
  record.created = true;

  // §13.2 follow: SSE to terminal, resume with Last-Event-ID on drops.
  const budgetMs = TIER_BUDGETS_MS[tier].minutes * 60_000 + args["grace-ms"];
  let follow;
  try {
    follow = await followRunEvents(`${base}/v1/runs/${encodeURIComponent(runId)}/events`, {
      headers,
      deadlineMs: budgetMs,
      terminal: TERMINAL,
    });
  } catch (err) {
    record.error = `follow transport failure: ${err?.message ?? err}`;
    record.hung = true;
    return;
  }
  record.terminal = follow.terminal;
  record.runMs = follow.ms;
  record.hung = follow.timedOut;
  if (follow.timedOut) {
    if (args["cancel-on-hang"]) {
      try {
        await fetchFull(`${base}/v1/runs/${encodeURIComponent(runId)}/cancel`, {
          method: "POST",
          headers: { "idempotency-key": `${idemKey}-cancel`, ...headers },
          body: "{}",
          timeoutMs: 10000,
        });
        record.cancelled = true;
      } catch {
        record.cancelled = false;
      }
    }
  }
});

// -------------------------------------------------------------------- report

const elapsedSec = (performance.now() - t0) / 1000;
const perTier = new Map();
for (const tier of new Set(plan)) perTier.set(tier, []);
for (const r of results) perTier.get(r.tier).push(r);

const createOk = results.filter((r) => r.created);
const terminalOk = results.filter((r) => r.terminal === "run.succeeded");
const failedRuns = results.filter((r) => r.terminal === "run.failed" || r.terminal === "run.cancelled");
const hungRuns = results.filter((r) => r.hung);
const createFail = results.filter((r) => !r.created);
const reserved = createOk.reduce((a, r) => a + (r.reservedCredits ?? 0), 0);

console.log(line("═"));
console.log(`§21 runs-burst drill — ${nowIso()}`);
console.log(line("═"));
console.log(`target             ${base} (document ${args.document})`);
console.log(`burst              id ${burstId} · ${args.count} runs @ concurrency ${args.concurrency}`);
console.log(`mix                ${args.mix}`);
console.log(line());
console.log(`created            ${createOk.length}/${args.count}  (POST errors: ${createFail.length})`);
console.log(`terminal           succeeded ${terminalOk.length} · failed/cancelled ${failedRuns.length} · hung ${hungRuns.length}`);
console.log(`credits reserved   ${reserved} (sum of credits_reserved, §13.1)`);
console.log(`burst wall clock   ${fmtSec(elapsedSec)}`);
console.log(line());
console.log(`${pad("tier", 10)}${pad("n", 4)}${pad("ok", 4)}${pad("fail/hang", 11)}${pad("create p50", 12)}${pad("run p50", 12)}${pad("run p95", 12)}${pad("run max", 12)}${pad("§5.2 budget", 13)}${pad("breach", 7)}`);
let anyBreach = false;
for (const [tier, rs] of perTier) {
  const budgetMs = TIER_BUDGETS_MS[tier].minutes * 60_000;
  const ok = rs.filter((r) => r.terminal === "run.succeeded");
  const createLat = summarize(rs.map((r) => r.createMs).filter(Boolean));
  const runDur = summarize(ok.map((r) => r.runMs).filter(Boolean));
  const breaches = rs.filter((r) => r.runMs !== null && r.runMs > budgetMs + args["grace-ms"] && r.terminal === "run.succeeded");
  const breach = breaches.length > 0 || rs.some((r) => r.hung);
  if (breach) anyBreach = true;
  const hangCount = rs.filter((r) => r.hung).length;
  const failCount = rs.length - ok.length - hangCount;
  console.log(
    `${pad(tier, 10)}${pad(rs.length, 4)}${pad(ok.length, 4)}${pad(`${failCount}/${hangCount}`, 11)}${pad(createLat.p50 ? `${Math.round(createLat.p50)} ms` : "—", 12)}${pad(runDur.p50 ? fmtSec(runDur.p50 / 1000) : "—", 12)}${pad(runDur.p95 ? fmtSec(runDur.p95 / 1000) : "—", 12)}${pad(runDur.max ? fmtSec(runDur.max / 1000) : "—", 12)}${pad(`${TIER_BUDGETS_MS[tier].minutes} min`, 13)}${pad(breach ? "⚠ yes" : "-", 7)}`,
  );
}
console.log(line());
if (createFail.length > 0) {
  const counts = new Map();
  for (const r of createFail) counts.set(r.error, (counts.get(r.error) ?? 0) + 1);
  console.log("create failures:");
  for (const [err, n] of counts) console.log(`  ${pad(n, 4)} ${err}`);
}
const broken = results.filter((r) => r.error && r.created);
if (broken.length > 0) {
  console.log("follow failures:");
  for (const r of broken) console.log(`  ${r.runId}  ${r.error}`);
}
if (hungRuns.length > 0) {
  console.log(`hung runs (no terminal within budget + grace): ${hungRuns.map((r) => r.runId).join(", ")}`);
  console.log(`  → §3.4 on timeout: cancel, rollback, refund — check the ledger (GET /v1/credits)`);
}
const noTerminal = results.filter((r) => r.created && r.terminal === null);
if (noTerminal.length > 0 && !anyBreach) anyBreach = true;
console.log(line());
console.log(anyBreach
  ? "VERDICT  ⚠ budget breaches or hung runs observed — investigate queue depth / engine pool (§22: queue age > 2 min alert, engine restarts)"
  : "VERDICT  ✓ every run reached a terminal state within its §5.2 wall clock (+ grace)");

const summary = {
  drill: "runs-burst",
  burstId,
  target: base,
  document: args.document,
  runs: results.map((r) => ({ tier: r.tier, runId: r.runId, terminal: r.terminal, createMs: r.createMs, runMs: r.runMs, hung: r.hung, error: r.error, reservedCredits: r.reservedCredits })),
  perTierBudgets: Object.fromEntries(Object.entries(TIER_BUDGETS_MS).map(([t, b]) => [t, b.minutes])),
  anyBreach,
  elapsedSec: Number(elapsedSec.toFixed(1)),
};
if (args.json) printJson("SUMMARY_JSON", summary);

if (createOk.length === 0) process.exit(1);
if (args.strict && (anyBreach || failedRuns.length > 0 || hungRuns.length > 0 || broken.length > 0)) process.exit(2);
process.exit(0);
