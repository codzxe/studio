#!/usr/bin/env node
// §21 Load drill — upload throughput.
//
// Multipart uploads (§13.1 `POST /v1/uploads`) of a synthetic ~5 MiB PNG
// (generated in code, deterministic — §21 "test data: synthetic only") at a
// fixed concurrency (default 4), reporting aggregate/per-stream throughput,
// latency percentiles and an error table. Point it at the gateway in front of
// the same object storage the product uses; against a dev compose stack this
// is the disk/network baseline for the upload path.
//
// Zero npm dependencies; Node 22+. Opt-in drill — not CI-blocking.

import {
  buildMultipart,
  fetchFull,
  HttpError,
  headersFromArgs,
  makeSyntheticPng,
  line,
  pad,
  padL,
  parseArgs,
  fmtBytes,
  fmtMs,
  fmtPct,
  nowIso,
  pool,
  printJson,
  summarize,
} from "./lib/common.mjs";

const USAGE = `
upload-throughput — §21 load drill: 5 MiB multipart uploads at concurrency 4.

Usage:
  node upload-throughput.mjs --base <url> [options]

Options:
  --base <url>         (required) gateway base URL, e.g. http://127.0.0.1:3000
  --endpoint <path>    upload endpoint                (default /v1/uploads)
  --field <name>       multipart file field name       (default "file")
  --form "k=v"         extra multipart form fields (repeatable, optional)
  --size <bytes>       target PNG size in bytes        (default 5242880 = 5 MiB)
  --count <n>          total uploads                   (default 8)
  --concurrency <n>    parallel uploads                (default 4)
  --warmup <n>         uncounted warm-up uploads       (default 1)
  --header "K: V"      extra headers (repeatable: auth cookie / API key)
  --timeout-ms <n>     per-upload timeout              (default 120000)
  --strict             exit 2 if error rate > 0 or throughput < --min-mbps
  --min-mbps <x>       strict-mode throughput floor    (default 10)
  --json               additionally print one machine-readable JSON summary line
`.trim();

const args = parseArgs(
  process.argv.slice(2),
  {
    base: { type: "string", required: true, help: "gateway base URL" },
    endpoint: { type: "string", default: "/v1/uploads" },
    field: { type: "string", default: "file" },
    form: { type: "string", repeat: true, default: [] },
    size: { type: "int", default: 5 * 1024 * 1024 },
    count: { type: "int", default: 8 },
    concurrency: { type: "int", default: 4 },
    warmup: { type: "int", default: 1 },
    header: { type: "string", repeat: true, default: [] },
    "timeout-ms": { type: "int", default: 120000 },
    strict: { type: "bool" },
    "min-mbps": { type: "number", default: 10 },
    json: { type: "bool" },
  },
  USAGE,
);

if (!args.base.startsWith("http")) {
  console.error(`--base must be an http(s) URL, got ${args.base}`);
  process.exit(1);
}
if (!args.endpoint.startsWith("/")) args.endpoint = `/${args.endpoint}`;
const base = args.base.replace(/\/+$/, "");
const url = `${base}${args.endpoint}`;
const headers = headersFromArgs(args.header);

// ------------------------------------------------------------- payload build

const png = makeSyntheticPng(args.size);
console.log(`synthetic payload  ${fmtBytes(png.byteLength)} PNG (deterministic, generated in code)`);
console.log(`target              ${url} · field "${args.field}" · concurrency ${args.concurrency}`);

const formParts = [];
for (const item of args.form) {
  const eq = item.indexOf("=");
  if (eq === -1) {
    console.error(`bad --form "${item}" — expected k=v.`);
    process.exit(1);
  }
  formParts.push({ name: item.slice(0, eq), data: item.slice(eq + 1) });
}

function uploadOnce() {
  const { body, contentType } = buildMultipart([
    ...formParts,
    { name: args.field, filename: "studio-drill-5mb.png", contentType: "image/png", data: png },
  ]);
  return fetchFull(url, {
    method: "POST",
    headers: { "content-type": contentType, "content-length": String(body.byteLength), ...headers },
    body,
    timeoutMs: args["timeout-ms"],
  });
}

// ------------------------------------------------------------------ warm-up

for (let i = 0; i < args.warmup; i++) {
  try {
    const r = await uploadOnce();
    console.log(`warm-up             ${i + 1}/${args.warmup} → HTTP ${r.status} (${fmtMs(r.ms)})`);
  } catch (err) {
    console.log(`warm-up             ${i + 1}/${args.warmup} → transport failure (${err.__class ?? "error"})`);
  }
}

// ------------------------------------------------------------------- drill

const t0 = performance.now();
const raw = await pool(args.count, args.concurrency, async () => {
  try {
    const r = await uploadOnce();
    if (r.status < 200 || r.status >= 300) throw new HttpError(r.status, r.body);
    return { ok: true, ms: r.ms, bytes: png.byteLength, status: r.status };
  } catch (err) {
    const klass = err instanceof HttpError ? `http_${err.status}` : (err.__class ?? "error");
    return { ok: false, klass, message: String(err.message ?? err), status: err.status ?? 0 };
  }
});
const elapsedSec = (performance.now() - t0) / 1000;
const results = raw.map((r) => (r.ok ? r.value : { ok: false, klass: r.klass ?? "error", message: r.message, status: r.status }));

// -------------------------------------------------------------------- report

const ok = results.filter((r) => r.ok);
const failed = results.filter((r) => !r.ok);
const totalBytes = ok.reduce((a, r) => a + r.bytes, 0);
const throughputs = ok.map((r) => r.bytes / 1024 / 1024 / (r.ms / 1000));
const lat = summarize(ok.map((r) => r.ms));
const aggMbps = elapsedSec > 0 ? totalBytes / 1024 / 1024 / elapsedSec : 0;
const errorRate = results.length ? failed.length / results.length : 1;

console.log(line("═"));
console.log(`§21 upload-throughput drill — ${nowIso()}`);
console.log(line("═"));
console.log(`${pad("#", 4)}${pad("result", 8)}${pad("latency", 14)}${pad("MB/s", 10)}status`);
results.forEach((r, i) => {
  const mbps = r.ok ? (r.bytes / 1024 / 1024 / (r.ms / 1000)).toFixed(1) : "—";
  console.log(`${pad(i + 1, 4)}${pad(r.ok ? "ok" : "FAIL", 8)}${pad(r.ok ? fmtMs(r.ms) : "—", 14)}${pad(mbps, 10)}${r.ok ? r.status : `${r.klass ?? "error"} ${r.message?.slice(0, 60) ?? ""}`}`);
});
console.log(line());
console.log(`uploads             ${ok.length}/${results.length} ok · error rate ${fmtPct(errorRate)}`);
console.log(`payload total        ${fmtBytes(totalBytes)} in ${elapsedSec.toFixed(1)} s`);
console.log(`aggregate throughput ${aggMbps.toFixed(1)} MiB/s (concurrency ${args.concurrency})`);
if (ok.length > 0) {
  console.log(`per-upload MB/s     p50 ${percentileStr(throughputs, 0.5)} · p95 ${percentileStr(throughputs, 0.95)} · max ${Math.max(...throughputs).toFixed(1)}`);
  console.log(`latency p50/p95/p99 ${fmtMs(lat.p50)} / ${fmtMs(lat.p95)} / ${fmtMs(lat.p99)}  (max ${fmtMs(lat.max)})`);
}
if (failed.length > 0) {
  const counts = new Map();
  for (const r of failed) counts.set(r.klass ?? "error", (counts.get(r.klass ?? "error") ?? 0) + 1);
  console.log("error table:");
  for (const [klass, n] of counts) console.log(`  ${padL(n, 3)}  ${klass}`);
}
console.log(line());
if (errorRate === 0 && aggMbps > 0) {
  console.log(`headroom note       at this rate, a 5 MiB upload costs ${(png.byteLength / 1024 / 1024 / aggMbps).toFixed(1)} s of pipe — scale the gateway/object store if p95 latency doubles under ${args.concurrency * 2} concurrency (knee rule, §21)`);
}

function percentileStr(arr, p) {
  const arr2 = [...arr].sort((a, b) => a - b);
  const idx = Math.min(arr2.length - 1, Math.max(0, Math.ceil(p * arr2.length) - 1));
  return arr2[idx].toFixed(1);
}

const summary = {
  drill: "upload-throughput",
  url,
  payloadBytes: png.byteLength,
  count: results.length,
  ok: ok.length,
  failed: failed.length,
  errorRate,
  aggregateMiBps: Number(aggMbps.toFixed(2)),
  latencyP50: lat.p50,
  latencyP95: lat.p95,
  latencyP99: lat.p99,
  elapsedSec: Number(elapsedSec.toFixed(2)),
};
if (args.json) printJson("SUMMARY_JSON", summary);

if (results.length === 0 || ok.length === 0) process.exit(1);
if (args.strict && (errorRate > 0 || aggMbps < args["min-mbps"])) process.exit(2);
process.exit(0);
