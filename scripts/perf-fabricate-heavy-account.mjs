#!/usr/bin/env node
// Fabricate the heavy ACCOUNT shape (workspaces are the multiplier):
//   - as many workspaces as the plan allows (stop on the first quota 429)
//   - 2 projects each (within the trial 3/workspace cap)
//   - the TARGET project in the LAST-created workspace
// Then the caller times GET /w/perf-target/editor with the session cookie.
import { readFileSync } from "node:fs";

const COOKIE_FILE = process.argv[2] ?? "/tmp/prod-cookies.txt";
const BASE = "https://motiongra.vercel.app";
const jar = readFileSync(COOKIE_FILE, "utf8");
const line = jar.split("\n").find((l) => l.includes("session_token"));
const parts = line.trim().split(/\s+/);
const cookie = `${parts[parts.length - 2]}=${parts[parts.length - 1]}`;
const RUN = `${Date.now()}`;

async function api(method, path, body, extraHeaders = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: BASE, cookie, ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

const t0 = Date.now();
const log = (...a) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s]`, ...a);

let made = 0;
let lastWsId = null;
for (let w = 1; w <= 30; w++) {
  const ws = await api(
    "POST",
    "/v1/workspaces",
    { name: `Bulk WS ${RUN} ${w}`, slug: `perf-bulk-${RUN}-${w}` },
    { "idempotency-key": `perf-ws-${RUN}-${w}` },
  );
  if (ws.status === 429) {
    log(`workspace quota hit after ${made} workspaces:`, ws.text.slice(0, 100));
    break;
  }
  if (ws.status !== 201 && ws.status !== 200) {
    log(`ws ${w} -> ${ws.status}`, ws.text.slice(0, 120));
    break;
  }
  lastWsId = ws.json.data.id;
  for (let p = 1; p <= 2; p++) {
    const r = await api(
      "POST",
      "/v1/projects",
      { name: `Bulk ${w}-${p}` },
      { "x-workspace-id": lastWsId, "idempotency-key": `perf-prj-${RUN}-${w}-${p}` },
    );
    if (r.status !== 201 && r.status !== 200) {
      log(`project ${w}/${p} -> ${r.status}`, r.text.slice(0, 100));
    }
  }
  made++;
}

if (lastWsId === null) {
  log("no workspace could be created");
  process.exit(1);
}
const target = await api(
  "POST",
  "/v1/projects",
  { name: "Perf Target" },
  { "x-workspace-id": lastWsId, "idempotency-key": `perf-target-${RUN}` },
);
if (target.status !== 201 && target.status !== 200) {
  log("target ->", target.status, target.text.slice(0, 120));
  process.exit(1);
}
console.log("DONE", JSON.stringify({ workspaces: made, slug: target.json.data.slug }));
