#!/usr/bin/env node
/**
 * prod-deploy-poll.mjs — wait for the NEXT production deployment to go live
 * by watching the served chunk set of a public page change.
 *
 * WHY: the box carries no Vercel token (box resets keep wiping it), so the
 * deployment watch can't use the API. But every deployment serves a fresh
 * content-addressed chunk graph: when ANY chunk name in the served HTML
 * differs from the baseline set, the new build is live. Baseline can be
 * seeded with --seed (fetch once, save, exit) and then awaited with no flags.
 *
 * Usage:
 *   node scripts/prod-deploy-poll.mjs --seed   # record today's baseline
 *   node scripts/prod-deploy-poll.mjs           # poll until the set changes
 *   node scripts/prod-deploy-poll.mjs --url https://motiongra.vercel.app/pricing
 *
 * Exit 0 when the new deployment is live, 1 on timeout.
 */

import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(HERE, "captures", "deploy-poll-baseline.json");

const args = process.argv.slice(2);
const seed = args.includes("--seed");
const urlFlag = args.indexOf("--url");
const URL_ = urlFlag === -1 ? "https://motiongra.vercel.app/" : args[urlFlag + 1];
const TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 45 * 1000;

async function servedChunkSet(url) {
  const html = await (await fetch(url)).text();
  const names = [...html.matchAll(/\/_next\/static\/(?:immutable\/)?chunks\/([^"']+\.js)/g)].map(
    (m) => m[1],
  );
  return [...new Set(names)].sort();
}

function printSet(title, set) {
  console.log(`${title} (${set.length} chunks): ${set.join(", ")}`);
}

if (seed) {
  const set = await servedChunkSet(URL_);
  writeFileSync(BASELINE_PATH, JSON.stringify({ url: URL_, set }, null, 2));
  printSet("Baseline recorded", set);
  process.exit(0);
}

if (!existsSync(BASELINE_PATH)) {
  console.error("No baseline — run with --seed first.");
  process.exit(1);
}
const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
printSet("Baseline", baseline.set);

const started = Date.now();
while (Date.now() - started < TIMEOUT_MS) {
  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  let current;
  try {
    current = await servedChunkSet(URL_);
  } catch (error) {
    console.log(`fetch failed (${error.message}), retrying…`);
    continue;
  }
  const changed = current.filter((name) => !baseline.set.includes(name));
  const gone = baseline.set.filter((name) => !current.includes(name));
  if (changed.length > 0 || gone.length > 0) {
    console.log(`NEW DEPLOYMENT LIVE after ${Math.round((Date.now() - started) / 1000)}s`);
    printSet("Served now", current);
    if (changed.length > 0) console.log(`New chunks: ${changed.join(", ")}`);
    if (gone.length > 0) console.log(`Removed chunks: ${gone.join(", ")}`);
    process.exit(0);
  }
  console.log(`unchanged (${current.length} chunks) — waiting…`);
}
console.error("Timed out waiting for a new deployment.");
process.exit(1);
