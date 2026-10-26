// Round 10 — LIVE apply-chain probe (motiongra.vercel.app).
//
// The auto-apply wire probe (round10-live-probe.mjs) proves the verdict and
// the compiled batch reach the client. This probe completes the LAST server
// hop the client's auto-drive performs after engine.batch executes in the
// browser: version upload (D-6 save moment, agentRunId = the run) →
// POST /v1/runs/:id/apply (lineage + credits + applied_at) → undo.
// On LIVE production + the REAL Supabase, never exercised before.
//
// Usage: node scripts/round10-apply-probe.mjs [baseUrl]
// Rows it creates: probe-r10-ap-<stamp>@test.local + probe-r10-ap-ws-<stamp>.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const BASE = process.argv[2] ?? "https://motiongra.vercel.app";
const ORIGIN = BASE;
const STAMP = Date.now();
const EMAIL = `probe-r10-ap-${STAMP}@test.local`;
const PASSWORD = `Probe!r10ap${STAMP}`;
const DEMO_BYTES = readFileSync("/home/z/my-project/apps/web/demo-project.ecproj");

function log(step, detail = "") {
  console.log(`[apply-probe] ${step}${detail ? ` — ${detail}` : ""}`);
}

async function call(method, path, { body, cookie, workspace, rawBody, contentType } = {}) {
  const headers = {
    "content-type": contentType ?? "application/json",
    origin: ORIGIN,
    referer: `${ORIGIN}/`,
    "user-agent": "studio-probe/1.0",
  };
  if (cookie) headers.cookie = cookie;
  if (workspace) headers["x-workspace-id"] = workspace;
  if (body !== undefined || rawBody !== undefined) {
    headers["idempotency-key"] = `idem-${STAMP}-${Math.random().toString(36).slice(2, 10)}`;
  }
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const setCookie = response.headers.get("set-cookie") ?? "";
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 400) };
  }
  return { status: response.status, json, setCookie };
}

const dataOf = (result) => result.json?.data ?? result.json;
const cookieOf = (result) => (result.setCookie ? result.setCookie.split(";")[0] : "");

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

// ── Setup ───────────────────────────────────────────────────────────────────
const signUp = await call("POST", "/v1/auth/sign-up/email", {
  body: { email: EMAIL, password: PASSWORD, name: "Probe R10 Apply" },
});
const cookie = cookieOf(signUp);
const ws = await call("POST", "/v1/workspaces", {
  body: { name: `Probe R10 Apply ${STAMP}`, slug: `probe-r10-ap-ws-${STAMP}` },
  cookie,
});
const workspaceId = dataOf(ws)?.id;
const project = await call("POST", "/v1/projects", {
  body: { name: `Apply Probe ${STAMP}` },
  cookie,
  workspace: workspaceId,
});
const projectId = dataOf(project)?.id;
const thread = await call("POST", `/v1/projects/${projectId}/threads`, {
  body: { title: "Apply probe" },
  cookie,
  workspace: workspaceId,
});
const threadId = dataOf(thread)?.id;
if (!threadId) {
  console.error(
    "setup failed:",
    JSON.stringify({
      signUp: signUp.status,
      ws: ws.status,
      project: project.status,
      thread: thread.status,
    }),
  );
  process.exit(1);
}
log("setup", `ws=${workspaceId} project=${projectId} thread=${threadId}`);

const { execFileSync } = await import("node:child_process");
execFileSync(
  process.execPath,
  ["scripts/studio-credit-grant.mjs", "--slug", `probe-r10-ap-ws-${STAMP}`, "--credits", "50"],
  { stdio: "inherit", cwd: "/home/z/my-project" },
);

// ── Run 1: a work request (the probe answers client tools as the editor) ────
const CONTEXT_RESULT = {
  projectSummary: { comps: 1, layers: 0, effects: 0, assets: 0 },
  activeComp: {
    id: 1,
    name: "Comp 1",
    width: 1920,
    height: 1080,
    frameRate: 29.97,
    duration: 10.01,
    layers: [],
  },
  playhead: { timeSeconds: 0, playing: false },
  focusedPanel: "composition",
  selection: { layerIds: [], tree: null },
};

const chatResponse = await fetch(`${BASE}/v1/threads/${threadId}/chat`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    cookie,
    origin: ORIGIN,
    referer: `${ORIGIN}/`,
    "x-workspace-id": workspaceId,
    "idempotency-key": `probe-r10-ap-${STAMP}-chat`,
  },
  body: JSON.stringify({
    message:
      "Add a white text layer named Headline that says Hello World centered in the composition.",
    context: {
      projectSummary: true,
      activeComp: true,
      selection: false,
      playhead: true,
      focusedPanel: true,
      selectedProperties: false,
      currentFrame: false,
      recentCommands: false,
      comments: false,
    },
    idempotencyKey: `probe-r10-ap-${STAMP}-chat`,
    pinned: [],
  }),
});
if (chatResponse.status !== 200) {
  console.error("chat failed:", chatResponse.status, (await chatResponse.text()).slice(0, 500));
  process.exit(1);
}

const started = Date.now();
let runId = null;
let plan = null;
let terminal = null;
const reader = chatResponse.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
readLoop: while (Date.now() - started < 120_000) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let boundary = buffer.indexOf("\n\n");
  while (boundary !== -1) {
    const frame = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
    if (!dataLine) continue;
    const payload = dataLine.slice(5).trim();
    if (payload === "") continue;
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    if (event.type === "run.started") {
      runId = event.runId;
    } else if (event.type === "tool.started" && event.name === "studio.get_context") {
      await fetch(`${BASE}/v1/runs/${event.runId}/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          origin: ORIGIN,
          referer: `${ORIGIN}/`,
          "x-workspace-id": workspaceId,
          "idempotency-key": `toolresult:${event.runId}:${event.toolCallId}`.slice(0, 128),
        },
        body: JSON.stringify({
          type: "tool.result",
          toolCallId: event.toolCallId,
          result: CONTEXT_RESULT,
        }),
      });
    } else if (event.type === "plan") {
      plan = event;
    } else if (
      event.type === "run.failed" ||
      event.type === "run.completed" ||
      event.type === "run.cancelled"
    ) {
      terminal = { type: event.type, code: event.code, message: event.message };
      break readLoop;
    }
    boundary = buffer.indexOf("\n\n");
  }
}
await reader.cancel().catch(() => undefined);
log(
  "run",
  `id=${runId} terminal=${terminal.type}${terminal.code ? ` code=${terminal.code} (${terminal.message ?? ""})` : ""} verdict=${JSON.stringify(plan?.autoApply)}`,
);
if (terminal.type !== "run.completed" || plan?.autoApply?.mode !== "auto") {
  console.error("run did not end with an auto-eligible plan — aborting");
  process.exitCode = 1;
  process.exit(0);
}

// ── The client's post-engine sequence (what auto-drive does after the batch) ─
// 1. Version upload: the D-6 save moment. agentRunId MUST be this run.
const versionSha = sha256Hex(DEMO_BYTES);
const baseQuery =
  plan.baseVersionId === undefined
    ? ""
    : `&baseVersionId=${encodeURIComponent(plan.baseVersionId)}`;
const upload = await call(
  "POST",
  `/v1/projects/${projectId}/versions?sha256=${versionSha}&sizeBytes=${DEMO_BYTES.byteLength}&agentRunId=${encodeURIComponent(runId)}${baseQuery}`,
  { cookie, workspace: workspaceId, rawBody: DEMO_BYTES, contentType: "application/octet-stream" },
);
const versionId = dataOf(upload)?.id ?? dataOf(upload)?.versionId;
log("version upload", `${upload.status} versionId=${versionId}`);
if (upload.status !== 200 && upload.status !== 201) {
  console.error("upload failed:", JSON.stringify(upload.json).slice(0, 400));
  process.exit(1);
}

// 2. Apply: batchSha256 over the exact engine payload (mirrors apply.ts).
const enginePayload = {
  label: plan.compiledBatch.label,
  atomic: true,
  steps: plan.compiledBatch.steps,
};
const batchSha = sha256Hex(new TextEncoder().encode(JSON.stringify(enginePayload)));
const apply = await call("POST", `/v1/runs/${runId}/apply`, {
  body: { batchSha256: batchSha, versionId, idempotencyKey: `apply-probe-${STAMP}-${runId}` },
  cookie,
  workspace: workspaceId,
});
log("apply", `${apply.status} ${JSON.stringify(dataOf(apply))}`);

// 3. Replay with the same idempotency key never double-charges (law #4).
const applyReplay = await call("POST", `/v1/runs/${runId}/apply`, {
  body: { batchSha256: batchSha, versionId, idempotencyKey: `apply-probe-${STAMP}-${runId}` },
  cookie,
  workspace: workspaceId,
});
// (different transport key, same logical apply — RUN_ALREADY_APPLIED expected)
log("apply replay", `${applyReplay.status} ${JSON.stringify(dataOf(applyReplay)).slice(0, 140)}`);

// 4. Undo: free (§8.7), idempotent.
const undo = await call("POST", `/v1/runs/${runId}/undo`, {
  body: { idempotencyKey: `undo-probe-${STAMP}-${runId}` },
  cookie,
  workspace: workspaceId,
});
log("undo", `${undo.status} ${JSON.stringify(dataOf(undo))}`);

// ── Verdict ────────────────────────────────────────────────────────────────
const applied = apply.status === 200 && dataOf(apply)?.applied === true;
const undone = undo.status === 200 && dataOf(undo)?.undone === true;
console.log("\n[apply-probe] ===== VERDICT =====");
console.log(`[apply-probe] version upload:    ${upload.status < 300 ? "PASS" : "FAIL"}`);
console.log(
  `[apply-probe] run applied:      ${applied ? "PASS" : "FAIL"} (credits committed: ${dataOf(apply)?.creditsCommitted ?? "?"})`,
);
console.log(`[apply-probe] run undone:       ${undone ? "PASS" : "FAIL"}`);
const allPass = applied && undone;
console.log(
  `\n[apply-probe] RESULT: ${allPass ? "APPLY CHAIN LIVE — plan → version → apply → undo on production." : "INCOMPLETE — see transcript."}`,
);
console.log(`[apply-probe] rows to clean: user ${EMAIL}, workspace probe-r10-ap-ws-${STAMP}`);
process.exitCode = allPass ? 0 : 1;
