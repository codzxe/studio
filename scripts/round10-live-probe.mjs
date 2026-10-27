// Round 10 — LIVE auto-apply E2E wire probe (motiongra.vercel.app).
//
// Verifies the round-10 v2 chain on PRODUCTION with MOCK_MODEL=false:
//   sign-up → workspace → project → thread → settings read (v2 default ON)
//   → chat WORK request ("create a text layer…") → REAL DeepSeek tool calls
//   → a plan event that is COMPILE-ENRICHED (compiledBatch) and stamped with
//   the §7.3 v2 verdict {mode:"auto"} for the fresh (default-ON) user
//   → opt-out (PATCH settings false) → the next run's verdict proposes
//   with reason "setting-disabled" (the per-user seam end-to-end).
//
// The probe exercises the SERVER side of auto-apply (verdict + rescue +
// enrichment). The browser-side execution (engine.batch → save → applyRun)
// is driven by the client auto-drive and covered by the unit/integration
// suites; the /v1/runs/:id/apply endpoint itself is exercised live by
// scripts/round10-apply-probe.mjs.
//
// Usage: node scripts/round10-live-probe.mjs [baseUrl]
// Probe rows it creates: probe-r10-<stamp>@test.local + probe-r10-ws-<stamp>.

const BASE = process.argv[2] ?? "https://motiongra.vercel.app";
const ORIGIN = BASE;
const STAMP = Date.now();
const EMAIL = `probe-r10-${STAMP}@test.local`;
const PASSWORD = `Probe!r10pass${STAMP}`;

function log(step, detail = "") {
  console.log(`[probe] ${step}${detail ? ` — ${detail}` : ""}`);
}

async function call(method, path, { body, cookie, workspace } = {}) {
  const headers = {
    "content-type": "application/json",
    origin: ORIGIN,
    referer: `${ORIGIN}/`,
    "user-agent": "studio-probe/1.0",
  };
  if (cookie) headers.cookie = cookie;
  if (workspace) headers["x-workspace-id"] = workspace;
  if (body !== undefined)
    headers["idempotency-key"] = `idem-${STAMP}-${Math.random().toString(36).slice(2, 10)}`;
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 400) };
  }
  return { status: response.status, json };
}

const cookieOf = (result) => (result.setCookie ? result.setCookie.split(";")[0] : "");
async function callRaw(method, path, { body, cookie, workspace } = {}) {
  const headers = {
    "content-type": "application/json",
    origin: ORIGIN,
    referer: `${ORIGIN}/`,
    "user-agent": "studio-probe/1.0",
  };
  if (cookie) headers.cookie = cookie;
  if (workspace) headers["x-workspace-id"] = workspace;
  if (body !== undefined)
    headers["idempotency-key"] = `idem-${STAMP}-${Math.random().toString(36).slice(2, 10)}`;
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
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

log("base", BASE);

// 1. Sign-up
const signUp = await callRaw("POST", "/v1/auth/sign-up/email", {
  body: { email: EMAIL, password: PASSWORD, name: "Probe R10" },
});
if (signUp.status !== 200) {
  console.error("sign-up failed:", signUp.status, JSON.stringify(signUp.json).slice(0, 400));
  process.exit(1);
}
const cookie = cookieOf(signUp);
log("sign-up", `${EMAIL} -> ${signUp.status}`);

// 2. Settings read — the v2 default for a fresh user must be ON.
const settingsBefore = await call("GET", "/v1/me/settings", { cookie });
log("settings GET", `${settingsBefore.status} ${JSON.stringify(settingsBefore.json)}`);

// 3. Workspace + project + thread
const ws = await callRaw("POST", "/v1/workspaces", {
  body: { name: `Probe R10 ${STAMP}`, slug: `probe-r10-ws-${STAMP}` },
  cookie,
});
if (ws.status !== 201) {
  console.error("workspace failed:", ws.status, JSON.stringify(ws.json).slice(0, 400));
  process.exit(1);
}
const workspaceId = ws.json.data?.id ?? ws.json.workspace?.id ?? ws.json.id;
const project = await call("POST", "/v1/projects", {
  body: { name: `Probe Project ${STAMP}` },
  cookie,
  workspace: workspaceId,
});
const projectId = project.json.data?.id ?? project.json.project?.id ?? project.json.id;
const thread = await call("POST", `/v1/projects/${projectId}/threads`, {
  body: { title: "Round 10 probe" },
  cookie,
  workspace: workspaceId,
});
const threadId = thread.json.data?.id ?? thread.json.thread?.id ?? thread.json.id;
if (!threadId) {
  console.error("thread failed:", thread.status, JSON.stringify(thread.json).slice(0, 400));
  process.exit(1);
}
log("workspace/project/thread", `${workspaceId} / ${projectId} / ${threadId}`);

// 4. Trial-credit grant for the fresh probe workspace (ops-side; 50 credits).
const { execFileSync } = await import("node:child_process");
execFileSync(
  process.execPath,
  ["scripts/studio-credit-grant.mjs", "--slug", `probe-r10-ws-${STAMP}`, "--credits", "50"],
  { stdio: "inherit", cwd: "/home/z/my-project" },
);

// 5b. The probe plays the BROWSER's role for client tool calls: it answers
// studio.get_context etc. through POST /v1/runs/:id/events — the exact seam
// the real editor's tool executor uses (tool-executor.ts). Without a live
// editor the run would fail EDITOR_DISCONNECTED at the first client tool.
const CLIENT_TOOL_RESULTS = {
  "studio.get_context": {
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
  },
  "studio.list_layers": {
    comp: { id: 1, name: "Comp 1", width: 1920, height: 1080, duration: 10.01, frameRate: 29.97 },
    layers: [],
  },
  "studio.get_properties": { layers: {} },
  "studio.render_preview": { comp: "Comp 1", time: 0, width: 16, height: 9, pngBase64: null },
};

async function answerClientTool(runId, toolCallId, name) {
  const result = CLIENT_TOOL_RESULTS[name];
  if (result === undefined) return; // server-resolved tools are not postable
  const response = await fetch(`${BASE}/v1/runs/${runId}/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: ORIGIN,
      referer: `${ORIGIN}/`,
      "x-workspace-id": workspaceId,
      "idempotency-key": `toolresult:${runId}:${toolCallId}`.slice(0, 128),
    },
    body: JSON.stringify({ type: "tool.result", toolCallId, result }),
  });
  log("tool answer", `${name} -> ${response.status}`);
}

// 6. Chat run — a WORK request; stream until terminal, 120s ceiling.
async function runChat(message, idempotencyKey) {
  const response = await fetch(`${BASE}/v1/threads/${threadId}/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: ORIGIN,
      referer: `${ORIGIN}/`,
      "x-workspace-id": workspaceId,
    },
    body: JSON.stringify({
      message,
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
      idempotencyKey,
      pinned: [],
    }),
  });
  if (response.status !== 200) {
    return { httpError: response.status, body: (await response.text()).slice(0, 500) };
  }
  const started = Date.now();
  const tools = [];
  const plans = [];
  let text = "";
  let events = 0;
  let terminal = null;
  let runId = null;
  const reader = response.body.getReader();
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
      if (dataLine) {
        const payload = dataLine.slice(5).trim();
        if (payload !== "") {
          let event;
          try {
            event = JSON.parse(payload);
          } catch {
            event = null;
          }
          if (event !== null) {
            events += 1;
            if (event.type === "run.started") {
              runId = event.runId;
              terminal = null;
            } else if (event.type === "message.delta") {
              text += event.delta ?? "";
            } else if (event.type === "tool.started") {
              tools.push(event.name);
              // Answer client tools as the editor would (server-resolved
              // tools ignore the post; the route only accepts expected ids).
              await answerClientTool(event.runId, event.toolCallId, event.name);
            } else if (event.type === "plan") {
              plans.push({
                intent: event.plan?.intent,
                summary: event.plan?.summary,
                batchSteps: (event.compiledBatch?.steps ?? []).map((step) => step.command),
                resolutionRequests: (event.resolutionRequests ?? []).length,
                risk: event.risk,
                estimatedCredits: event.estimatedCredits,
                autoApply: event.autoApply,
              });
            } else if (event.type === "run.failed") {
              terminal = { type: event.type, code: event.code, message: event.message };
              break readLoop;
            } else if (event.type === "run.completed" || event.type === "run.cancelled") {
              terminal = { type: event.type };
              break readLoop;
            }
          }
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
  await reader.cancel().catch(() => undefined);
  return { events, tools, plans, text, terminal, runId, seconds: (Date.now() - started) / 1000 };
}

log("chat #1", "work request: create a text layer (fresh user, auto-apply default ON)");
const run1 = await runChat(
  "Add a white text layer named Headline that says Hello World centered in the composition.",
  `probe-r10-${STAMP}-1`,
);
if (run1.httpError !== undefined) {
  console.error("chat #1 failed:", run1.httpError, run1.body);
  process.exit(1);
}
console.log(
  `[probe] run #1: ${run1.events} events in ${run1.seconds.toFixed(1)}s, terminal=${JSON.stringify(run1.terminal)}`,
);
console.log(`[probe] run #1 tools: ${run1.tools.join(", ") || "(none)"}`);
for (const plan of run1.plans) console.log(`[probe] run #1 plan: ${JSON.stringify(plan)}`);
console.log(`[probe] run #1 text: ${JSON.stringify((run1.text ?? "").slice(0, 260))}`);

// 6. Opt-out: PATCH the settings OFF, then a second run must propose.
const patch = await call("PATCH", "/v1/me/settings", {
  body: { autoApplyEnabled: false },
  cookie,
});
log("settings PATCH off", `${patch.status} ${JSON.stringify(patch.json)}`);

log("chat #2", "same kind of request after opting out (verdict must propose setting-disabled)");
const run2 = await runChat(
  "Add a gray text layer named Subtitle that says Studio Test just below the middle.",
  `probe-r10-${STAMP}-2`,
);
if (run2.httpError !== undefined) {
  console.error("chat #2 failed:", run2.httpError, run2.body);
  process.exit(1);
}
console.log(
  `[probe] run #2: ${run2.events} events in ${run2.seconds.toFixed(1)}s, terminal=${JSON.stringify(run2.terminal)}`,
);
console.log(`[probe] run #2 tools: ${run2.tools.join(", ") || "(none)"}`);
for (const plan of run2.plans) console.log(`[probe] run #2 plan: ${JSON.stringify(plan)}`);

// 7. Verdicts.
const verdict1auto = run1.plans.some(
  (plan) => plan.autoApply?.mode === "auto" && (plan.batchSteps?.length ?? 0) > 0,
);
const verdict2settingDisabled = run2.plans.some(
  (plan) => plan.autoApply?.mode === "propose" && plan.autoApply?.reason === "setting-disabled",
);
const completed1 = run1.terminal?.type === "run.completed";
const completed2 = run2.terminal?.type === "run.completed";

console.log("\n[probe] ===== VERDICT =====");
console.log(
  `[probe] fresh user default ON:          ${settingsBefore.json?.data?.autoApplyEnabled === true || settingsBefore.json?.autoApplyEnabled === true ? "PASS" : "FAIL"} (GET /v1/me/settings)`,
);
console.log(
  `[probe] run #1 completed:               ${completed1 ? "PASS" : "FAIL"} (${run1.terminal?.code ?? "ok"})`,
);
console.log(
  `[probe] run #1 plan auto-eligible:      ${verdict1auto ? "PASS" : "FAIL"} (enriched compiledBatch + {mode:auto})`,
);
console.log(`[probe] run #2 completed:               ${completed2 ? "PASS" : "FAIL"}`);
console.log(
  `[probe] run #2 opt-out proposes:        ${verdict2settingDisabled ? "PASS" : "FAIL"} (reason=setting-disabled)`,
);

const allPass = verdict1auto && verdict2settingDisabled && completed1 && completed2;
console.log(
  `\n[probe] RESULT: ${allPass ? "AUTO-APPLY WIRE CHAIN LIVE — the agent's work now lands." : "INCOMPLETE — see the transcript above."}`,
);
console.log(
  `[probe] rows to clean: user ${EMAIL}, workspace probe-r10-ws-${STAMP}, project ${projectId}`,
);
process.exitCode = allPass ? 0 : 1;
