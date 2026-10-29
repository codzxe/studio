#!/usr/bin/env node
// Round-13 perf repro, step 1: sign up a throwaway prod account and drop the
// session cookie as a Netscape jar file for scripts/perf-fabricate-heavy-account.mjs
// (its jar parser: the line containing `session_token`, last two whitespace
// tokens = cookie name + value). The account email carries the probe marker so
// scripts/probe-cleanup.mjs can find it later.
//
// Usage: node scripts/prod-signup-jar.mjs [jarFile]
// Rows it creates: probe-r13t-<stamp>@test.local (delete via probe-cleanup).

import { writeFileSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "https://motiongra.vercel.app";
const JAR = process.argv[2] ?? "/tmp/prod-cookies.txt";
const STAMP = Date.now();
const EMAIL = `probe-r13t-${STAMP}@test.local`;
const PASSWORD = `Probe!r13t${STAMP}`;

const res = await fetch(`${BASE}/v1/auth/sign-up/email`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: BASE, referer: `${BASE}/` },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: "Probe R13 TTFB" }),
});
const text = await res.text();
if (res.status !== 200) {
  // biome-ignore lint/suspicious/noConsole: diagnostic probe script — console output is its report
  console.error("sign-up failed:", res.status, text.slice(0, 300));
  process.exit(1);
}
const setCookie = res.headers.get("set-cookie") ?? "";
const session = setCookie
  .split(",")
  .map((chunk) => chunk.trim().split(";")[0])
  .find((pair) => pair.includes("session_token"));
if (!session) {
  // biome-ignore lint/suspicious/noConsole: diagnostic probe script — console output is its report
  console.error("no session_token in set-cookie:", setCookie.slice(0, 200));
  process.exit(1);
}
const [name, value] = session.split("=");
// Netscape-format line: domain  flag  path  secure  expiry  name  value
writeFileSync(JAR, `${new URL(BASE).host}\tFALSE\t/\tTRUE\t0\t${name}\t${value}\n`);
// biome-ignore lint/suspicious/noConsole: diagnostic probe script — console output is its report
console.log("OK", JSON.stringify({ email: EMAIL, password: PASSWORD, jar: JAR }));
