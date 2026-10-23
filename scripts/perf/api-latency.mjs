/**
 * api-latency.mjs — BUILD_PLAN §6 "API read p95 < 300 ms" / "API write
 * p95 < 600 ms" budget measurement, on-box against a live gateway.
 *
 * WHAT IT MEASURES (client-observed, loopback):
 *   - GET /health ×N — unauthenticated liveness read (context; not the budget
 *     number — that rides on the authed read).
 *   - GET /v1/projects ×N — THE budget read: real auth (better-auth session
 *     cookie minted via POST /v1/auth/sign-in/email as the seeded demo user —
 *     the same sign-in W1-A2's curl proved) + x-workspace-id + member/project
 *     queries server-side.
 *   - POST /v1/projects/prj_demo/presence ×N — THE budget write, chosen
 *     because it is a genuinely SAFE write: the (project_id, user_id) PK makes
 *     the heartbeat upsert idempotent, rows are ephemeral (TTL sweep, never
 *     audit-logged — services/gateway/src/routes/presence.ts documents both),
 *     and 30 beats sit far under the 60/min/user mutation rate limit.
 *     Deliberately NOT measured: project/version/asset writes (they mutate the
 *     seeded world and enqueue side effects other suites rely on).
 *
 *   One untimed warmup request per endpoint precedes each timed loop, so TCP
 *   connection setup and any first-hit server compile cost are not folded into
 *   the distribution.
 *
 * HONEST LIMITS (recorded with every result set — docs/performance.md)
 *   - loopback (127.0.0.1): no real network latency — this is a floor for the
 *     budget's over-the-network intent, measuring gateway processing + node
 *     fetch overhead.
 *   - sandbox shared CPU (2 cores) — other fleet agents may contend.
 *   - dev-mode tsx process (no prod bundling); the gateway is otherwise the
 *     real app code path (auth, workspace middleware, repos, sqlite twin).
 *
 * USAGE (ONE shell invocation — the sandbox reaps background processes):
 *   see scripts/perf/boot-and-measure.sh (boots the gateway on :8787 with the
 *   e2e/README.md §5b env + seeded .local/e2e.db, runs this script, tears
 *   down). PERF_GATEWAY_URL overrides the target origin.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GATEWAY_URL = (
  process.env.PERF_GATEWAY_URL ?? "http://127.0.0.1:8787"
).replace(/\/$/, "");
const RUNS = Number.parseInt(process.env.PERF_RUNS ?? "30", 10);
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.env.PERF_OUT_DIR ?? resolve(HERE, "results");

/** Seeded demo login (packages/db/scripts/seed.ts — dev fixture, never prod). */
const SEEDED_EMAIL = "demo@studio.test";
const SEEDED_PASSWORD = "demo-password-12345";
const WORKSPACE_ID = "org_demo";
const PROJECT_ID = "prj_demo";

// ---------------------------------------------------------------------------
// Stats helpers (same nearest-rank percentile as editor-ready.mjs)
// ---------------------------------------------------------------------------

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

function stats(ms) {
  const sorted = [...ms].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0] ?? null,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1] ?? null,
    samples: sorted,
  };
}

function log(...args) {
  process.stdout.write(`[${new Date().toISOString()}] ${args.join(" ")}\n`);
}

// ---------------------------------------------------------------------------
// One timed request: await the full response body so the number includes
// serialization + transfer, not just status-line arrival.
// ---------------------------------------------------------------------------

async function timedFetch(label, url, init, expectStatus, ms) {
  const t0 = performance.now();
  // init may be a factory: per-request headers (fresh Idempotency-Key per
  // mutation — the gateway REPLAYS a reused key's stored result, which would
  // turn the write series into a replay-cache read).
  const built = typeof init === "function" ? init() : init;
  const res = await fetch(url, built);
  const body = await res.text();
  const dt = performance.now() - t0;
  if (res.status !== expectStatus) {
    throw new Error(
      `${label}: expected ${expectStatus}, got ${res.status} — body: ${body.slice(0, 300)}`,
    );
  }
  ms.push(Math.round(dt * 10) / 10);
  return body;
}

async function timedLoop(label, url, init, expectStatus, runs) {
  const ms = [];
  for (let i = 1; i <= runs; i += 1) {
    try {
      await timedFetch(label, url, init, expectStatus, ms);
    } catch (err) {
      throw new Error(`${label} run ${i}/${runs} failed: ${err.message}`);
    }
    if (i % 10 === 0) log(`${label}: ${i}/${runs} done`);
  }
  return stats(ms);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`api-latency measurement — gateway ${GATEWAY_URL}, ${RUNS} runs/endpoint`);
  const result = {
    kind: "api-latency",
    startedAt: new Date().toISOString(),
    gatewayUrl: GATEWAY_URL,
    runs: RUNS,
  };

  // --- Liveness read (context only; not the budget number).
  await timedFetch("health-warmup", `${GATEWAY_URL}/health`, undefined, 200, []);
  result.health = await timedLoop("GET /health", `${GATEWAY_URL}/health`, undefined, 200, RUNS);
  log(`GET /health p95 ${result.health.p95} ms (n=${result.health.n})`);

  // --- Sign in once (W1-A2's curl: POST /v1/auth/sign-in/email → session
  // cookie) and build the authed headers every /v1 request needs. Origin is
  // sent deliberately: better-auth's trusted-origins check rejects POSTs with
  // a null Origin ("MISSING_OR_NULL_ORIGIN") — a browser always sends one, so
  // the measurement must too. It must equal the gateway's APP_URL.
  const APP_ORIGIN = process.env.PERF_APP_ORIGIN ?? "http://localhost:3000";
  const signInRes = await fetch(`${GATEWAY_URL}/v1/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP_ORIGIN },
    body: JSON.stringify({ email: SEEDED_EMAIL, password: SEEDED_PASSWORD }),
  });
  if (signInRes.status !== 200) {
    throw new Error(`sign-in failed: ${signInRes.status} ${await signInRes.text()}`);
  }
  const setCookies = signInRes.headers.getSetCookie?.() ?? [];
  const cookiePairs = setCookies
    .map((raw) => raw.split(";")[0].trim())
    .filter((pair) => pair.includes("="));
  if (cookiePairs.length === 0) throw new Error("sign-in returned no Set-Cookie");
  const cookie = cookiePairs.join("; ");
  const authedHeaders = {
    cookie,
    "x-workspace-id": WORKSPACE_ID,
  };
  const authedHeadersWithOrigin = { ...authedHeaders, origin: APP_ORIGIN };
  log(`signed in as ${SEEDED_EMAIL} (${cookiePairs.length} cookie(s), authed)`);

  // --- THE budget read: GET /v1/projects.
  await timedFetch(
    "projects-warmup",
    `${GATEWAY_URL}/v1/projects`,
    { headers: authedHeaders },
    200,
    [],
  );
  result.readProjects = await timedLoop(
    "GET /v1/projects",
    `${GATEWAY_URL}/v1/projects`,
    { headers: authedHeaders },
    200,
    RUNS,
  );
  log(`GET /v1/projects p95 ${result.readProjects.p95} ms (n=${result.readProjects.n})`);

  // --- THE budget write: presence heartbeat (safe + idempotent; see header).
  // A fresh Idempotency-Key per request (mutation middleware, §7.2): each beat
  // is its own real write, never a replay.
  let beatSeq = 0;
  const beatInit = () => ({
    method: "POST",
    headers: {
      ...authedHeadersWithOrigin,
      "content-type": "application/json",
      "idempotency-key": `perf-beat-${Date.now()}-${(beatSeq += 1)}`,
    },
    body: "{}",
  });
  await timedFetch(
    "presence-warmup",
    `${GATEWAY_URL}/v1/projects/${PROJECT_ID}/presence`,
    beatInit,
    200,
    [],
  );
  result.writePresenceBeat = await timedLoop(
    `POST /v1/projects/${PROJECT_ID}/presence`,
    `${GATEWAY_URL}/v1/projects/${PROJECT_ID}/presence`,
    beatInit,
    200,
    RUNS,
  );
  log(
    `POST .../presence p95 ${result.writePresenceBeat.p95} ms (n=${result.writePresenceBeat.n})`,
  );

  result.summary = {
    health: { p95: result.health.p95 },
    read: { endpoint: "GET /v1/projects", p95: result.readProjects.p95, budgetMs: 300 },
    write: {
      endpoint: "POST /v1/projects/:id/presence",
      p95: result.writePresenceBeat.p95,
      budgetMs: 600,
    },
    note: "loopback client-observed latency (floor for the over-network budget intent); sandbox shared CPU; gateway dev process (tsx) on the sqlite twin db",
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = resolve(OUT_DIR, `api-latency-${stamp}.json`);
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);

  log("SUMMARY api-latency");
  log(JSON.stringify(result.summary, null, 2));
  log(`results written: ${outPath}`);
}

main().catch((err) => {
  console.error(`api-latency FAILED: ${err?.stack ?? err}`);
  process.exit(1);
});
