// Round 9 — LIVE Token Harbor E2E probe (motiongra.vercel.app, Seoul icn1).
//
// Verifies the whole chain with MOCK_MODEL=false on production:
//   sign-up → workspace → project → thread → chat run → REAL model output
//   streamed through Token Harbor (deepseek-v4.1-flash / th-rudder).
//
// Mock vs real discrimination: the offline MockRunner answers EVERY prompt
// with the same canned journey (an "Agent Demo" composition + plan event).
// A real model answering "what is the capital of France?" says "Paris" —
// content the mock can never produce. run.failed is reported verbatim too
// (Token Harbor errors surface as RUN_MODEL_UNAVAILABLE).
//
// Usage: node scripts/th-live-probe.mjs [baseUrl]
// Prints a compact transcript + verdict. Probe rows it creates are listed
// for the cleanup step (probe-r9-*@test.local).

const BASE = process.argv[2] ?? "https://motiongra.vercel.app";
const ORIGIN = process.argv[3] ?? BASE;
const STAMP = Date.now();
const EMAIL = `probe-r9-${STAMP}@test.local`;
const PASSWORD = `Probe!r9pass${STAMP}`;

function log(step, detail = "") {
  console.log(`[probe] ${step}${detail ? ` — ${detail}` : ""}`);
}

async function call(method, path, { body, cookie, workspace, raw = false } = {}) {
  const headers = {
    "content-type": "application/json",
    origin: ORIGIN,
    referer: `${ORIGIN}/`,
    "user-agent": "studio-probe/1.0",
  };
  if (cookie) headers.cookie = cookie;
  if (workspace) headers["x-workspace-id"] = workspace;
  if (body && body.idempotencyKey === undefined && method === "POST" && !path.includes("/chat")) {
    headers["idempotency-key"] = `idem-${STAMP}-${Math.random().toString(36).slice(2, 10)}`;
  }
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (raw) return response;
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 400) };
  }
  return { status: response.status, json, setCookie: response.headers.get("set-cookie") ?? "" };
}

const cookieOf = (result) => (result.setCookie ? result.setCookie.split(";")[0] : "");

log("base", BASE);

// 1. Sign-up
const signUp = await call("POST", "/v1/auth/sign-up/email", {
  body: { email: EMAIL, password: PASSWORD, name: "Probe R9" },
});
if (signUp.status !== 200) {
  console.error("sign-up failed:", signUp.status, JSON.stringify(signUp.json).slice(0, 400));
  process.exit(1);
}
const cookie = cookieOf(signUp);
log("sign-up", `${EMAIL} -> ${signUp.status}`);

// 2. Workspace
const ws = await call("POST", "/v1/workspaces", {
  body: { name: `Probe R9 ${STAMP}`, slug: `probe-r9-ws-${STAMP}` },
  cookie,
});
if (ws.status !== 201) {
  console.error("workspace failed:", ws.status, JSON.stringify(ws.json).slice(0, 400));
  process.exit(1);
}
const workspaceId = ws.json.data?.id ?? ws.json.workspace?.id ?? ws.json.id;
log("workspace", `id=${workspaceId} -> 201`);

// 3. Project
const project = await call("POST", "/v1/projects", {
  body: { name: `Probe Project ${STAMP}` },
  cookie,
  workspace: workspaceId,
});
if (project.status !== 201 && project.status !== 200) {
  console.error("project failed:", project.status, JSON.stringify(project.json).slice(0, 400));
  process.exit(1);
}
const projectId = project.json.data?.id ?? project.json.project?.id ?? project.json.id;
log("project", `${projectId} -> ${project.status}`);

// 4. Thread
const thread = await call("POST", `/v1/projects/${projectId}/threads`, {
  body: { title: "Token Harbor probe" },
  cookie,
  workspace: workspaceId,
});
const threadId = thread.json.data?.id ?? thread.json.thread?.id ?? thread.json.id;
if (!threadId) {
  console.error("thread failed:", thread.status, JSON.stringify(thread.json).slice(0, 400));
  process.exit(1);
}
log("thread", `${threadId} -> ${thread.status}`);

// 4b. Trial-credit grant for the fresh probe workspace (what the card-required
// trial would seed in a Stripe-complete deployment; ops-side here because
// Stripe keys are placeholders). 50 credits = the trial allowance.
const { execFileSync } = await import("node:child_process");
execFileSync(
  process.execPath,
  ["scripts/studio-credit-grant.mjs", "--slug", `probe-r9-ws-${STAMP}`, "--credits", "50"],
  { stdio: "inherit", cwd: "/home/z/my-project" },
);

// 5. Chat run — SSE; stream until a terminal event, 90s ceiling.
const chatResponse = await fetch(`${BASE}/v1/threads/${threadId}/chat`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    cookie,
    origin: ORIGIN,
    referer: `${ORIGIN}/`,
    "x-workspace-id": workspaceId,
  },
  body: JSON.stringify({
    message:
      "Do not edit anything. Just answer in one short sentence: what is the capital city of France?",
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
    idempotencyKey: `probe-r9-${STAMP}`,
    pinned: [],
  }),
});
log("chat POST", `${chatResponse.status} ${chatResponse.headers.get("content-type") ?? ""}`);
if (chatResponse.status !== 200) {
  console.error("chat failed:", chatResponse.status, (await chatResponse.text()).slice(0, 500));
  process.exit(1);
}

const started = Date.now();
let text = "";
let events = 0;
let terminal = null;
const reader = chatResponse.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
readLoop: while (Date.now() - started < 90_000) {
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
    events += 1;
    if (event.type === "run.started") {
      log("run.started", `model=${event.model}`);
    } else if (event.type === "message.delta") {
      text += event.delta ?? "";
    } else if (event.type === "plan") {
      log("plan event", "the model proposed an EditPlan (unexpected for this prompt)");
    } else if (event.type === "run.failed") {
      terminal = { type: event.type, code: event.code, message: event.message };
      break readLoop;
    } else if (event.type === "run.completed" || event.type === "run.cancelled") {
      terminal = { type: event.type };
      break readLoop;
    }
    boundary = buffer.indexOf("\n\n");
  }
}
await reader.cancel().catch(() => undefined);

console.log(`[probe] stream: ${events} events in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`[probe] terminal: ${JSON.stringify(terminal)}`);
console.log(`[probe] assistant text (${text.length} chars):`);
console.log(text ? `  "${text.slice(0, 300)}"` : "  (none)");

// 6. Verdict: REAL output must mention Paris and must NOT be the canned mock.
const mockCanned = /Agent Demo/i.test(text);
const saysParis = /paris/i.test(text);
if (terminal?.type === "run.completed" && saysParis && !mockCanned) {
  console.log("\n[probe] VERDICT: REAL Token Harbor output — E2E chat pipeline is LIVE.");
} else if (terminal?.type === "run.failed") {
  console.log(`\n[probe] VERDICT: run FAILED ${terminal.code} — ${terminal.message}`);
} else {
  console.log(
    `\n[probe] VERDICT: inconclusive (completed=${terminal?.type === "run.completed"}, paris=${saysParis}, mock=${mockCanned})`,
  );
}
console.log(
  `\n[probe] rows to clean: user ${EMAIL}, workspace probe-r9-ws-${STAMP}, project ${projectId}`,
);
