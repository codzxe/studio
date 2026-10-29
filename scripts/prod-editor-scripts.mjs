#!/usr/bin/env node
// Round-13 perf: enumerate the CLIENT JS the authenticated editor route loads.
// Signs up a throwaway account, creates one workspace + one project, then GETs
// /w/<slug>/editor HTML and lists every <script src> with its transfer size.
// Answers: does the editor route really pull the 481KB shared chunk (contracts
// catalog + better-auth/noble crypto) the DevTools trace blamed for LCP delay?
//
// Usage: node scripts/prod-editor-scripts.mjs [--keep]   (default BASE: prod)
import { writeFileSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "https://motiongra.vercel.app";
const STAMP = Date.now();
const EMAIL = `probe-r13js-${STAMP}@test.local`;
const PASSWORD = `Probe!r13js${STAMP}`;

async function api(method, path, body, extraHeaders = {}, cookie) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      origin: BASE,
      ...(cookie ? { cookie } : {}),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, res };
}

// 1. sign up → session cookie
const su = await api("POST", "/v1/auth/sign-up/email", {
  email: EMAIL,
  password: PASSWORD,
  name: "Probe R13 JS",
});
if (su.status !== 200) {
  console.error("sign-up failed:", su.status, su.text.slice(0, 200));
  process.exit(1);
}
const session = (su.res.headers.get("set-cookie") ?? "")
  .split(",")
  .map((c) => c.trim().split(";")[0])
  .find((p) => p.includes("session_token"));
if (!session) {
  console.error("no session cookie");
  process.exit(1);
}
const cookie = session;
writeFileSync("/home/z/my-project/scripts/captures/probe-editor-cookie.txt", `${cookie}\n`);

// 2. one workspace + one project
const ws = await api("POST", "/v1/workspaces", { name: `Probe WS ${STAMP}`, slug: `probe-ws-${STAMP}` }, { "idempotency-key": `pws-${STAMP}` }, cookie);
if (ws.status !== 201 && ws.status !== 200) {
  console.error("workspace failed:", ws.status, ws.text.slice(0, 200));
  process.exit(1);
}
const wsId = ws.json.data.id;
const pr = await api("POST", "/v1/projects", { name: "Probe Editor JS" }, { "x-workspace-id": wsId, "idempotency-key": `ppr-${STAMP}` }, cookie);
if (pr.status !== 201 && pr.status !== 200) {
  console.error("project failed:", pr.status, pr.text.slice(0, 200));
  process.exit(1);
}
const slug = pr.json.data.slug;
console.log("project slug:", slug, "email:", EMAIL);

// 3. fetch the editor page HTML (authenticated)
const page = await api("GET", `/w/${slug}/editor`, undefined, {}, cookie);
if (page.status !== 200) {
  console.error("editor page:", page.status, page.text.slice(0, 200));
  process.exit(1);
}
writeFileSync("/home/z/my-project/scripts/captures/prod-editor-page.html", page.text);

// 4. list script srcs in order + HEAD their sizes
const srcs = [...page.text.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
const uniq = [...new Set(srcs)];
console.log(`\n${uniq.length} script srcs (of ${srcs.length} tags):`);
let total = 0;
const rows = [];
for (const src of uniq) {
  const url = src.startsWith("http") ? src : `${BASE}${src}`;
  const head = await fetch(url, { method: "GET", headers: { range: "bytes=0-0" } });
  const len = head.headers.get("content-range")?.split("/")[1] ?? head.headers.get("content-length") ?? "?";
  const enc = head.headers.get("content-encoding") ?? "identity";
  const n = Number(len);
  if (!Number.isNaN(n)) total += n;
  rows.push({ src, bytes: len, enc });
}
rows.sort((a, b) => Number(b.bytes) - Number(a.bytes));
for (const r of rows) {
  console.log(String(r.bytes).padStart(9), `${(Number(r.bytes) / 1024).toFixed(0).padStart(5)}KB`, r.src.replace(BASE, ""));
}
console.log(`TOTAL raw bytes (pre-compression): ${(total / 1024).toFixed(0)}KB`);

// 5. does the HTML contain the LCP-relevant text SSR'd? (project name / boot overlay)
const nameInHtml = page.text.includes("Probe Editor JS");
console.log("\nproject name SSR'd in HTML:", nameInHtml);
console.log("boot overlay text SSR'd:", /Preparing|booting|Loading/i.test(page.text));
