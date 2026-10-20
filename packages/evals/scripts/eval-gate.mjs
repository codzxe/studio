// packages/evals/scripts/eval-gate.mjs
//
// Suite pass-rate gate (spec §19 Phase 2 exit: "eval suite >= 50 briefs with >= 85%
// pass"; §11.4 "block merge on regression beyond threshold"). Reads the JSON results
// file written by `promptfoo eval --output`, computes the pass rate and exits 0/1/2
// accordingly, so CI can treat a regression beyond the threshold as a red build.
//
// Usage: node scripts/eval-gate.mjs <promptfoo-output.json> [threshold=0.85]
// Exit codes: 0 = gate passed, 1 = gate failed (below threshold), 2 = usage/input error.

import { readFileSync } from 'node:fs';

const [file, thresholdArg] = process.argv.slice(2);
if (!file) {
  console.error('eval-gate: usage: node scripts/eval-gate.mjs <promptfoo-output.json> [threshold=0.85]');
  process.exit(2);
}

const threshold = Number(thresholdArg ?? '0.85');
if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
  console.error(`eval-gate: invalid threshold "${thresholdArg}" (expected 0 < t <= 1)`);
  process.exit(2);
}

let data;
try {
  data = JSON.parse(readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`eval-gate: cannot read/parse ${file} — did 'promptfoo eval --output' run first?`);
  process.exit(2);
}

// promptfoo's JSON export has kept a top-level { results: [...] } shape for years; the
// per-entry `success` flag is the pass/fail bit. Be defensive about minor format drift.
const results = Array.isArray(data?.results) ? data.results : Array.isArray(data?.eval?.results) ? data.eval.results : [];
if (results.length === 0) {
  console.error('eval-gate: no results in output — an empty suite never passes a gate');
  process.exit(2);
}

const isPass = (r) => r?.success === true;
const passed = results.filter(isPass).length;
const rate = passed / results.length;
const bar = `${(rate * 100).toFixed(1)}% pass (gate >= ${(threshold * 100).toFixed(0)}%) — ${passed}/${results.length} cases`;

if (rate >= threshold) {
  console.log(`eval-gate: PASS ${bar}`);
  process.exit(0);
}

// Fail loudly with the offending cases (§21: a good test "fails loudly with a message").
const failed = results.filter((r) => !isPass(r));
console.error(`eval-gate: FAIL ${bar}`);
for (const r of failed) {
  const id = r?.testCase?.id ?? r?.testCase?.description ?? r?.id ?? '<unnamed case>';
  console.error(`eval-gate:   FAILED ${id}`);
}
process.exit(1);
