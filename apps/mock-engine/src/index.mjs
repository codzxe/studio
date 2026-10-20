// @studio/mock-engine — the transport: a loopback TCP server speaking the vendor's
// control protocol (docs/control-protocol.md; implementation photocraft's
// `crates/automation/src/{rpc.rs,security.rs,budgets.rs}`):
//
//   - the first frame on every connection must be `auth`; a bad JSON frame, a wrong method
//     or a wrong token is answered `{"ok": false, "error": "authentication required"}` and
//     the connection is closed; a second `auth` later is "already authenticated" and the
//     connection keeps serving (security.rs authentication_reply / repeat_auth_reply);
//   - after auth, each request is one JSON line and each reply is one JSON line with the
//     same id (`{"id":…, "ok": true, "result": …}` / `{"id":…, "ok": false, "error": "…"}`);
//   - transport limits: 1 MiB request line, 8 MiB reply, 16 connections, 30 s idle
//     timeout, 10 s auth deadline, 256 batch steps (all enforced by the engine module too).
//
// Usage (README.md › Spawning it):
//   MOCK_ENGINE_PORT=7800 MOCK_ENGINE_TOKEN=<64 hex> MOCK_ENGINE_ROOT=/abs/dir \
//     node src/index.mjs
// The bound port is announced on stdout as one JSON line: {"mockEngine":"listening",…}.

import net from "node:net";
import process from "node:process";

import {
  AUTH_DEADLINE_MS,
  IO_TIMEOUT_MS,
  MAX_CONNECTIONS,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  MockEngine,
  MOCK_ONLY_METHODS,
} from "./engine.mjs";
import { FaultHooks } from "./faults.mjs";

// ---------------------------------------------------------------------------
// Environment contract (W2-J integration spine): PORT / TOKEN / ROOT / FAULTS
// ---------------------------------------------------------------------------

function failFast(message) {
  process.stderr.write(`mock-engine: ${message}\n`);
  process.exit(1);
}

/** The bearer token: exactly 64 hexadecimal characters (security.rs validate_token). */
function readToken() {
  const token = process.env.MOCK_ENGINE_TOKEN;
  if (token === undefined || token.length === 0) {
    failFast("MOCK_ENGINE_TOKEN is required (64 hexadecimal characters)");
  }
  if (token.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(token)) {
    failFast("MOCK_ENGINE_TOKEN must contain exactly 64 hexadecimal characters");
  }
  return token.toLowerCase();
}

function readPort() {
  const raw = process.env.MOCK_ENGINE_PORT ?? "7800";
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    failFast(`MOCK_ENGINE_PORT must be 0..65535 (0 = pick a free port), got ${JSON.stringify(raw)}`);
  }
  return port;
}

function readRoot() {
  const root = process.env.MOCK_ENGINE_ROOT;
  if (root === undefined || root.length === 0) {
    // Filesystem access fails closed without a root, exactly like the vendor
    // (docs/control-protocol.md › Security note).
    return null;
  }
  if (!root.startsWith("/")) {
    failFast("MOCK_ENGINE_ROOT must be an absolute directory path");
  }
  return root.endsWith("/") ? root.slice(0, -1) : root;
}

function readFaults() {
  const raw = process.env.MOCK_ENGINE_FAULTS;
  if (raw === undefined || raw.length === 0) return new FaultHooks({});
  try {
    return new FaultHooks(JSON.parse(raw));
  } catch (error) {
    failFast(`MOCK_ENGINE_FAULTS: ${error.message}`);
  }
}

const TOKEN = readToken();
const PORT = readPort();
const ROOT = readRoot();
const faults = readFaults();
const engine = new MockEngine({ root: ROOT, faults });

/** @param {string} line @param {string} token */
function authenticationReply(line, token) {
  let request = null;
  try {
    request = JSON.parse(line);
  } catch {
    return { reply: { id: null, ok: false, error: "authentication required" }, ok: false };
  }
  const id = isPlainObject(request) && "id" in request ? request.id : null;
  const supplied =
    isPlainObject(request) &&
    isPlainObject(request.params) &&
    typeof request.params.token === "string"
      ? request.params.token
      : "";
  const ok = isPlainObject(request) && request.method === "auth" && tokenMatches(token, supplied);
  return ok
    ? { reply: { id, ok: true, result: { authenticated: true } }, ok: true }
    : { reply: { id, ok: false, error: "authentication required" }, ok: false };
}

/** security.rs token_matches: fixed width, hex letters fold in either case, no early exit. */
function tokenMatches(expected, supplied) {
  if (expected.length !== 64 || supplied.length !== 64) return false;
  if (!/^[0-9a-fA-F]{64}$/.test(supplied)) return false;
  let different = 0;
  for (let i = 0; i < 64; i += 1) {
    different |= (expected.charCodeAt(i) | 32) ^ (supplied.charCodeAt(i) | 32);
  }
  return different === 0;
}

/** @param {unknown} v */
function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Answer one request line (rpc.rs respond + security.rs repeat_auth_reply).
 * Returns the reply value, or `null` for the hang fault (no reply at all).
 * @param {string} line
 * @param {MockEngine} engine
 */
function respond(line, engine) {
  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    return { id: null, ok: false, error: `bad JSON: ${error.message}` };
  }
  const id = isPlainObject(request) && "id" in request ? request.id : null;
  if (isPlainObject(request) && request.method === "auth") {
    return { id, ok: false, error: "already authenticated" };
  }
  const method = isPlainObject(request) && typeof request.method === "string" ? request.method : null;
  if (method === null) {
    return { id, ok: false, error: "missing `method`" };
  }
  const params = isPlainObject(request) && "params" in request ? request.params : null;
  if (faults.hangs(method)) {
    return null; // hang fault: the client must hit its own request timeout
  }
  try {
    const result = engine.handle(method, params);
    return { id, ok: true, result };
  } catch (error) {
    // The vendor's last-resort guard: a request that would panic answers an error instead
    // of taking down the connection (rpc.rs respond → catch_unwind).
    const message = error instanceof Error ? error.message : String(error);
    return { id, ok: false, error: message };
  }
}

/** budgets.rs write_reply: a reply past the ceiling is replaced by a small error. */
function encodeReply(reply) {
  const encoded = JSON.stringify(reply);
  if (Buffer.byteLength(encoded, "utf8") <= MAX_RESPONSE_BYTES - 1) {
    return encoded;
  }
  return JSON.stringify({
    id: "id" in reply ? reply.id : null,
    ok: false,
    error: `response exceeds ${MAX_RESPONSE_BYTES} bytes; operation may have completed`,
  });
}

// ---------------------------------------------------------------------------
// One connection
// ---------------------------------------------------------------------------

let connections = 0;

/**
 * @param {net.Socket} socket
 * @param {MockEngine} engine
 */
function serveConnection(socket, engine) {
  let authenticated = false;
  /** @type {Buffer} */
  let buffer = Buffer.alloc(0);
  const connectedAt = Date.now();

  // security.rs: IO_TIMEOUT for idle read/write, AUTH_DEADLINE absolute from connect (#4965).
  socket.setTimeout(IO_TIMEOUT_MS);
  const authDeadlineTimer = setTimeout(() => {
    if (!authenticated) socket.destroy();
  }, AUTH_DEADLINE_MS);
  socket.on("timeout", () => socket.destroy());
  socket.on("close", () => clearTimeout(authDeadlineTimer));

  socket.on("data", (chunk) => {
    if (!authenticated && Date.now() - connectedAt > AUTH_DEADLINE_MS) {
      socket.destroy();
      return;
    }
    buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
    let newline = buffer.indexOf(10);
    while (newline !== -1) {
      const lineBytes = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      const oversized = lineBytes.length + 1 > MAX_REQUEST_BYTES;
      if (!oversized) {
        let line;
        try {
          line = utf8Decoder.decode(lineBytes);
        } catch {
          // Non-UTF-8 line: the TCP server closes the connection (rpc.rs serve_tcp_connection).
          socket.destroy();
          return;
        }
        handleLine(line, oversized);
      } else {
        handleLine(null, true);
        return;
      }
      newline = buffer.indexOf(10);
    }
    if (buffer.length > MAX_REQUEST_BYTES) {
      // An over-long line without its newline yet: answer and close, as the vendor does
      // (security.rs read_bounded_line reports TooLong once MAX_REQUEST_BYTES is exceeded).
      handleLine(null, true);
      return;
    }
  });

  /**
   * @param {string|null} line null for an over-long frame
   * @param {boolean} oversized
   */
  function handleLine(line, oversized) {
    /** @type {{id: any, ok: boolean, result?: any, error?: string}|null} */
    let reply;
    if (oversized) {
      reply = { id: null, ok: false, error: `request exceeds ${MAX_REQUEST_BYTES} bytes` };
      socket.write(`${JSON.stringify(reply)}\n`);
      socket.end(); // A TCP connection is closed after an oversized line.
      return;
    }
    if (line.trim().length === 0) return; // blank lines are ignored
    if (!authenticated) {
      const auth = authenticationReply(line, TOKEN);
      socket.write(`${JSON.stringify(auth.reply)}\n`);
      if (auth.ok) {
        authenticated = true;
        clearTimeout(authDeadlineTimer);
      } else {
        socket.end(); // rejected before any method is dispatched
      }
      return;
    }
    reply = respond(line, engine);
    if (reply === null) return; // hang fault: no reply, connection stays open
    socket.write(`${encodeReply(reply)}\n`);
  }
}

// ---------------------------------------------------------------------------
// Listener
// ---------------------------------------------------------------------------

const server = net.createServer({ noDelay: true });

server.on("connection", (socket) => {
  if (connections >= MAX_CONNECTIONS) {
    socket.write(`${JSON.stringify({ id: null, ok: false, error: "connection limit reached" })}\n`);
    socket.end();
    return;
  }
  connections += 1;
  socket.on("close", () => {
    connections -= 1;
  });
  serveConnection(socket, engine);
});

server.on("error", (error) => {
  failFast(`cannot listen on 127.0.0.1:${PORT}: ${error.message}`);
});

server.listen(PORT, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : PORT;
  process.stdout.write(
    `${JSON.stringify({
      mockEngine: "listening",
      host: "127.0.0.1",
      port,
      pid: process.pid,
      root: ROOT,
      mockOnlyMethods: [...MOCK_ONLY_METHODS],
    })}\n`,
  );
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// A crash must never be silent in dev; the catch-all in `respond` already keeps requests
// from killing the process, so anything reaching here is a transport bug worth seeing.
process.on("uncaughtException", (error) => {
  process.stderr.write(`mock-engine: uncaught exception: ${error.stack}\n`);
  shutdown();
});
