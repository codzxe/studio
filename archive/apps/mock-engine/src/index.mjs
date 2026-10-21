// @ts-check
/**
 * Mock of the headless control server's TCP transport (protocol-faithful to
 * vendor/photocraft/crates/automation/src/security.rs + rpc.rs):
 * loopback-only JSON lines, first-frame `auth` (`authentication required` /
 * `already authenticated`), id-correlated replies, 16-connection cap, 1 MiB
 * request lines, 8 MiB reply ceiling, 30 s socket timeout. Zero dependencies.
 */
import net from "node:net";
import { randomBytes } from "node:crypto";
import process from "node:process";
import { EngineError, MockEngine } from "./engine.mjs";
import { activeFault, beforeCommand, oversizedReply } from "./faults.mjs";

const MAX_CONNECTIONS = 16; // protocol › Transport limits
const MAX_REQUEST_BYTES = 1024 * 1024; // 1 MiB encoded request line
const MAX_REPLY_BYTES = 8 * 1024 * 1024; // 8 MiB encoded reply, including the newline
const SOCKET_TIMEOUT_MS = 30_000;
const EXIT_CRASH = 86; // MOCK_FAULT=crash-on-command

/** @param {string} s */ function log(s) { process.stderr.write(`mock-engine: ${s}\n`); }

/** 64-hex token, like `PHOTOCRAFT_CONTROL_TOKEN` (256-bit). */
function randomToken() {
  return randomBytes(32).toString("hex");
}

const provided = process.env.MOCK_ENGINE_TOKEN ?? "";
if (provided && provided.length !== 64) log("`MOCK_ENGINE_TOKEN` must be 64 hex chars; generating one");
const token = provided.length === 64 ? provided : randomToken();

/** Case-insensitive 64-hex compare (security.rs :: token_matches). */
function tokenMatches(expected, supplied) {
  return expected.length === 64 && typeof supplied === "string" && supplied.length === 64 &&
    expected.toLowerCase() === supplied.toLowerCase();
}

/** One JSON reply line; refuses to blow the 8 MiB reply ceiling. */
function reply(socket, obj) {
  const line = `${JSON.stringify(obj)}\n`;
  if (Buffer.byteLength(line) > MAX_REPLY_BYTES) {
    socket.write(`${JSON.stringify({ id: obj.id ?? null, ok: false, error: "reply exceeds the 8 MiB limit" })}\n`);
    return;
  }
  socket.write(line);
}

const parsedPort = Number.parseInt(process.env.MOCK_ENGINE_PORT ?? "7800", 10);
const port = Number.isInteger(parsedPort) && parsedPort >= 0 ? parsedPort : 7800;
const engine = new MockEngine(); // one shared session across connections, like `serve`
const fault = activeFault();
const sockets = new Set();

/** Handle one request line on an authenticated connection. */
function dispatch(socket, line) {
  let req = null;
  try {
    req = JSON.parse(line);
  } catch {
    reply(socket, { id: null, ok: false, error: "invalid JSON" });
    return;
  }
  const id = req?.id ?? null;
  if (typeof req?.method !== "string") {
    reply(socket, { id, ok: false, error: "request needs `method`" });
    return;
  }
  if (req.method === "auth") {
    reply(socket, { id, ok: false, error: "already authenticated" }); // the connection keeps serving
    return;
  }
  const action = req.method === "engine.execute" ? beforeCommand(fault) : null;
  if (action === "exit") {
    log(`MOCK_FAULT=${fault}: crashing before dispatch`);
    process.exit(EXIT_CRASH);
  }
  if (action === "hang") return; // write no reply at all
  if (action === "oversized") {
    socket.write(oversizedReply(id));
    return;
  }
  try {
    reply(socket, { id, ok: true, result: engine.handle(req.method, req.params ?? null) });
  } catch (err) {
    const error = err instanceof EngineError || err instanceof Error ? err.message : String(err);
    reply(socket, { id, ok: false, error });
  }
}

/** First-frame authentication (security.rs :: authentication_reply). */
function authenticate(socket, line) {
  let id = null;
  let ok = false;
  try {
    const req = JSON.parse(line);
    id = req?.id ?? null;
    ok = req?.method === "auth" && tokenMatches(token, req?.params?.token);
  } catch {
    ok = false;
  }
  if (ok) {
    reply(socket, { id, ok: true, result: { authenticated: true } });
    return true;
  }
  reply(socket, { id, ok: false, error: "authentication required" });
  socket.end(); // an unauthenticated connection is closed after the reply
  return false;
}

const server = net.createServer((socket) => {
  if (sockets.size >= MAX_CONNECTIONS) {
    socket.destroy(); // excess connections are rejected before any dispatch
    return;
  }
  sockets.add(socket);
  const state = { authenticated: false, buf: "" };
  socket.setTimeout(SOCKET_TIMEOUT_MS);
  socket.on("timeout", () => socket.destroy()); // 30 s socket read/write timeout
  socket.on("error", () => {});
  socket.on("close", () => sockets.delete(socket));
  socket.on("data", (/** @type {Buffer} */ chunk) => {
    state.buf += chunk.toString("utf8");
    if (Buffer.byteLength(state.buf) > MAX_REQUEST_BYTES) {
      reply(socket, { id: null, ok: false, error: "request line exceeds the 1 MiB limit" });
      socket.destroy(); // a TCP connection is closed after an oversized line
      return;
    }
    let nl = state.buf.indexOf("\n");
    while (nl >= 0) {
      const line = state.buf.slice(0, nl);
      state.buf = state.buf.slice(nl + 1);
      if (line.trim().length > 0) {
        if (!state.authenticated) state.authenticated = authenticate(socket, line);
        else dispatch(socket, line);
        if (socket.destroyed) break;
      }
      nl = state.buf.indexOf("\n");
    }
  });
});

server.on("error", (err) => {
  log(`server error: ${err.message}`);
  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  const addr = server.address();
  log(`listening on 127.0.0.1:${addr.port}`);
  if (!provided) log(`token ${token} (generated; set MOCK_ENGINE_TOKEN to pin it)`);
  if (fault) log(`fault ${fault}`);
});

function shutdown() {
  for (const s of sockets) s.destroy();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
