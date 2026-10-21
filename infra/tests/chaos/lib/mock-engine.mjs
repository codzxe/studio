// Spawn + talk to apps/mock-engine (zero-dep protocol-faithful engine fake).
// Wire contract per apps/mock-engine/README.md:
//   - loopback TCP, newline-delimited JSON frames
//   - first frame must be auth: {"id":"auth","method":"auth","params":{"token":hex}}
//   - replies: {"id","ok","result"} | {"id","ok":false,"error":"…"}
//   - stderr: "listening on 127.0.0.1:<port>" (port 0 → ephemeral)
//   - MOCK_FAULT=crash-on-command → hard process.exit(86) before the reply
//     on an engine.execute dispatch (the scripted stand-in for `kill -9`)
//   - MOCK_FAULT=hang → no reply at all;  MOCK_FAULT=oversized-reply → >8 MiB frame

import { spawn } from "node:child_process";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

/** Generate a 64-hex token like the engine's control token. */
export const newToken = () => randomBytes(32).toString("hex");

export function makeNdjsonClient({ port, token, label = "mock-engine" }) {
  const pending = new Map();
  let nextId = 0;
  let closed = false;
  let closeReason = null;
  const closeWaiters = [];
  const socket = net.connect(port, "127.0.0.1");

  const buffer = { data: "" };
  socket.on("data", (chunk) => {
    buffer.data += chunk.toString("utf8");
    let nl;
    while ((nl = buffer.data.indexOf("\n")) !== -1) {
      const line = buffer.data.slice(0, nl);
      buffer.data = buffer.data.slice(nl + 1);
      if (!line.trim()) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue; // ignore non-JSON noise
      }
      const waiter = pending.get(frame.id);
      if (waiter) {
        pending.delete(frame.id);
        clearTimeout(waiter.timer);
        if (frame.ok === true) waiter.resolve({ ok: true, result: frame.result });
        else waiter.reject(Object.assign(new Error(frame.error ?? "engine error"), { engineError: frame.error }));
      }
    }
  });

  function markClosed(reason) {
    if (closed) return;
    closed = true;
    closeReason = reason;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(Object.assign(new Error(`engine connection closed (${reason}) before reply`), { closed: true, code: "engine_gone" }));
    }
    pending.clear();
    for (const w of closeWaiters) w();
  }

  socket.on("close", () => markClosed("socket-close"));
  socket.on("error", (err) => markClosed(`socket-error ${err.code ?? err.message}`));

  function request(method, params, { timeoutMs = 8000 } = {}) {
    if (closed) return Promise.reject(Object.assign(new Error(`engine gone (${closeReason})`), { code: "engine_gone" }));
    const id = `req-${++nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error(`engine reply timeout after ${timeoutMs} ms (${method})`), { code: "engine_timeout" }));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      socket.write(`${JSON.stringify({ id, method, params: params ?? {} })}\n`);
    });
  }

  return {
    socket,
    /** First frame per the protocol: auth with the token. */
    auth: () => request("auth", { token }, { timeoutMs: 4000 }),
    request,
    closed: () => closed,
    closeReason: () => closeReason,
    close() {
      if (!closed) socket.destroy();
    },
    /** Resolves when the connection is gone. */
    onGone() {
      if (closed) return Promise.resolve(closeReason);
      return new Promise((resolve) => closeWaiters.push(() => resolve(closeReason)));
    },
  };
}

export function startMockEngine({
  repoRoot, // studio repo root
  writeRoot,
  token = newToken(),
  fault = null, // "crash-on-command" | "hang" | "oversized-reply" | null
  label = "mock-engine",
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join("src", "index.mjs")], {
      cwd: join(repoRoot, "apps", "mock-engine"),
      env: {
        ...process.env,
        MOCK_ENGINE_PORT: "0", // ephemeral; real port arrives on stderr
        MOCK_ENGINE_TOKEN: token,
        MOCK_ENGINE_WRITE_ROOT: writeRoot,
        ...(fault ? { MOCK_FAULT: fault } : {}),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });

    const fail = (message, hint) => {
      child.kill("SIGKILL");
      reject(Object.assign(new Error(message), { hint }));
    };
    const timer = setTimeout(() => fail(`${label} did not announce its port in 15 s`, "apps/mock-engine/src/index.mjs should print 'listening on 127.0.0.1:<port>' to stderr"), 15000);

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const m = /listening on 127\.0\.0\.1:(\d+)/.exec(stderr);
      if (m) {
        clearTimeout(timer);
        const port = Number(m[1]);
        const exitInfo = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
        resolve({
          child,
          port,
          token,
          exitInfo, // Promise<{code, signal}> — assert exit code 86 / SIGKILL here
          client: makeNdjsonClient({ port, token, label }),
          kill(signal = "SIGKILL") {
            try {
              child.kill(signal);
            } catch {
              /* already gone */
            }
          },
        });
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      fail(`${label} spawn failed: ${err.message}`, "is apps/mock-engine present?");
    });
  });
}
