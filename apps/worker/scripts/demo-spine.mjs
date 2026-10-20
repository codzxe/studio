#!/usr/bin/env node
// apps/worker/scripts/demo-spine.mjs — the Phase-0 spine demo, runnable with bare `node`
// and ZERO dependencies (§19 Phase 0: "prove the spine end-to-end with zero product
// polish"). It is the mechanics seed for the Wave-7 `demo:coffee` template demo, which
// will wrap the same flow in a compiled template manifest + critic loop.
//
// What it does, against a REAL spawned mock-engine process (apps/mock-engine, the W2-F
// fake of `photocraft-cli serve`):
//
//   auth → doc.new 1080×1080 → batch [layer.new.layer Background, type.create Headline,
//   edit.fill] → doc.render (PNG magic bytes 89 50 4E 47 verified) → doc.save
//   → doc.open (reopen) → doc.inspect (revision advanced, layers listed)
//
// and prints the command log for the run (§19 Phase 0 step 5).
//
// Usage:
//   node scripts/demo-spine.mjs
// Spawn mode (default): a fresh mock-engine child on an ephemeral port; the .pcraft
// checkpoint lands in a temp directory that is KEPT and printed on success.
//
//   MOCK_ENGINE_PORT=7800 MOCK_ENGINE_TOKEN=<64 hex> node scripts/demo-spine.mjs
// Connect mode: drive an already-running mock-engine instead of spawning one (compose
// dev); files are written beneath that instance's own automation root.
//
// Suggested wiring (NOT added to package.json — apps/worker/package.json belongs to the
// W1-I worker lineage; see tests/spine/README.md):
//   "demo:spine": "node scripts/demo-spine.mjs"
//
// Exit codes: 0 spine ok; 1 engine/spine failure; 2 mock-engine not found.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK_ENTRY = fileURLToPath(new URL("../../mock-engine/src/index.mjs", import.meta.url));
const SAVE_PATH = "spine/happy-path.pcraft";
const HEADLINE_TEXT = "Single Origin";
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

const log = (line) => process.stdout.write(`${line}\n`);

class SpineError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "SpineError";
    this.exitCode = exitCode;
  }
}

const summarize = (value) => {
  const json = JSON.stringify(value);
  if (json === undefined) return "null";
  return json.length > 72 ? `${json.slice(0, 69)}…` : json;
};

let stepNumber = 0;
async function step(label, run) {
  stepNumber += 1;
  log(`[${String(stepNumber).padStart(2, "0")}] ${label}`);
  try {
    const result = await run();
    log(`     ok → ${summarize(result)}`);
    return result;
  } catch (error) {
    log(`     FAILED: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// A minimal control-protocol client (newline-delimited JSON, first-frame auth,
// id-correlated replies, one outstanding call at a time) — the wire the real
// EngineClient facade speaks (docs/control-protocol.md).
// ---------------------------------------------------------------------------

class EngineReplyError extends Error {
  constructor(text) {
    super(`engine error reply: ${text}`);
    this.name = "EngineReplyError";
  }
}

class ControlClient {
  constructor(port, token) {
    this.port = port;
    this.token = token;
    this.socket = null;
    this.buffer = "";
    this.pending = null;
    this.nextId = 1;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port: this.port });
      socket.setNoDelay(true);
      const onConnectError = (error) => {
        socket.destroy();
        reject(error);
      };
      socket.once("error", onConnectError);
      socket.once("connect", () => {
        socket.off("error", onConnectError);
        socket.on("error", (error) => this.failPending(error));
        resolve();
      });
      socket.on("close", () => this.failPending(new Error("the connection closed")));
      socket.on("data", (chunk) => this.onChunk(chunk));
      this.socket = socket;
    });
  }

  onChunk(chunk) {
    this.buffer += chunk.toString("utf8");
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) {
        this.onLine(line);
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  onLine(line) {
    let reply = null;
    try {
      reply = JSON.parse(line);
    } catch {
      return; // not a framed reply — ignore stray bytes
    }
    if (this.pending !== null && reply.id === this.pending.id) {
      const waiter = this.pending;
      this.pending = null;
      waiter.resolve(reply);
    }
  }

  failPending(error) {
    if (this.pending !== null) {
      const waiter = this.pending;
      this.pending = null;
      waiter.reject(error);
    }
  }

  async call(method, params) {
    if (this.pending !== null) {
      throw new Error("one outstanding call at a time (control protocol)");
    }
    const id = this.nextId;
    this.nextId += 1;
    const frame = `${JSON.stringify({ id, method, params })}\n`;
    const reply = await new Promise((resolve, reject) => {
      this.pending = { id, resolve, reject };
      this.socket.write(frame);
    });
    if (reply.ok !== true) {
      throw new EngineReplyError(typeof reply.error === "string" ? reply.error : "unknown");
    }
    return reply.result;
  }

  /** The first frame on every connection must be auth (security.rs). */
  auth() {
    return this.call("auth", { token: this.token });
  }

  close() {
    if (this.socket !== null) {
      this.socket.end();
    }
  }
}

// ---------------------------------------------------------------------------
// mock-engine spawn (env contract per apps/mock-engine: MOCK_ENGINE_PORT=0 picks an
// ephemeral port; the bound port is announced on stdout as JSON or on stderr as text)
// ---------------------------------------------------------------------------

const ANNOUNCE_TIMEOUT_MS = 15_000;
const STDERR_ANNOUNCE = /listening on 127\.0\.0\.1:(\d+)/;

async function waitForAnnouncedPort(child) {
  return new Promise((resolve, reject) => {
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let settled = false;
    const finish = (port) => {
      if (settled) return;
      settled = true;
      cleanup();
      clearTimeout(deadline);
      resolve(port);
    };
    const fail = (reason) => {
      if (settled) return;
      settled = true;
      cleanup();
      clearTimeout(deadline);
      reject(reason);
    };
    const deadline = setTimeout(() => {
      fail(new Error(`no listening announcement within ${ANNOUNCE_TIMEOUT_MS} ms`));
    }, ANNOUNCE_TIMEOUT_MS);
    const onStdout = (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      let newline = stdoutBuffer.indexOf("\n");
      while (newline !== -1) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.mockEngine === "listening" && Number.isInteger(message.port)) {
            finish(message.port);
          }
        } catch {
          // not the JSON announcement line
        }
        newline = stdoutBuffer.indexOf("\n");
      }
    };
    const onStderr = (chunk) => {
      stderrBuffer += chunk.toString("utf8");
      const match = STDERR_ANNOUNCE.exec(stderrBuffer);
      if (match !== null) {
        const port = Number.parseInt(match[1], 10);
        if (Number.isInteger(port) && port > 0) {
          finish(port);
        }
      }
    };
    const onError = (error) => fail(error);
    const cleanup = () => {
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("error", onError);
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.on("error", onError);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!existsSync(MOCK_ENTRY)) {
    throw new SpineError(`mock-engine not found at ${MOCK_ENTRY} (apps/mock-engine, W2-F)`, 2);
  }

  const externalPort = Number.parseInt(process.env.MOCK_ENGINE_PORT ?? "", 10);
  const externalToken = process.env.MOCK_ENGINE_TOKEN ?? "";
  const external = Number.isInteger(externalPort) && externalPort > 0 && externalToken.length === 64;

  let port = externalPort;
  let token = externalToken;
  let child = null;
  let root = null;

  log("studio Phase-0 spine demo (§19) — engine spine end-to-end");
  if (external) {
    log(`mode: connect to a running mock-engine on 127.0.0.1:${port}`);
  } else {
    root = mkdtempSync(path.join(tmpdir(), "studio-demo-spine-"));
    token = randomBytes(32).toString("hex"); // 256-bit control token (security.rs)
    log("mode: spawn a fresh mock-engine (ephemeral port)");
    child = spawn(process.execPath, [MOCK_ENTRY], {
      env: {
        ...process.env,
        MOCK_ENGINE_PORT: "0",
        MOCK_ENGINE_TOKEN: token,
        MOCK_ENGINE_ROOT: root,
        MOCK_ENGINE_WRITE_ROOT: root,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      port = await waitForAnnouncedPort(child);
    } catch (error) {
      throw new SpineError(error instanceof Error ? error.message : String(error));
    }
    log(`mock-engine listening on 127.0.0.1:${port}`);
  }

  const client = new ControlClient(port, token);
  try {
    await step("connect (loopback TCP)", () => client.connect());
    await step("auth — first frame, 256-bit control token", () => client.auth());

    const created = await step("doc.new 1080×1080 (Coffee Promo)", () =>
      client.call("doc.new", { width: 1080, height: 1080, name: "Coffee Promo" }),
    );
    const baseline = await step("doc.inspect (fresh document)", () => client.call("doc.inspect", null));

    const batch = await step(
      "batch: layer.new.layer Background → type.create Headline → edit.fill",
      () =>
        client.call("batch", {
          steps: [
            { command: "layer.new.layer", params: { name: "Background" } },
            { command: "type.create", params: { text: HEADLINE_TEXT, x: 540, y: 420, size: 72 } },
            { command: "edit.fill", params: { contents: "color", color: "#f5ede3" } },
          ],
        }),
    );
    if (batch.failed !== 0 || batch.completed !== 3) {
      throw new Error(`batch did not complete cleanly: ${summarize(batch)}`);
    }
    for (const [index, result] of (batch.results ?? []).entries()) {
      log(`     · step ${index} ${result.ok === true ? "ok" : `FAILED: ${result.error}`}`);
    }

    const render = await step("doc.render {maxSide:512} (inline PNG preview)", () =>
      client.call("doc.render", { maxSide: 512 }),
    );
    if (typeof render.base64 !== "string") {
      throw new Error(`expected the inline render variant, got ${summarize(render)}`);
    }
    const png = Buffer.from(render.base64, "base64");
    const magic = [png[0], png[1], png[2], png[3]];
    if (magic[0] !== PNG_MAGIC[0] || magic[1] !== PNG_MAGIC[1] || magic[2] !== PNG_MAGIC[2] || magic[3] !== PNG_MAGIC[3]) {
      throw new Error(`doc.render did not return a PNG (magic ${summarize(magic)})`);
    }
    log(`     PNG magic 89 50 4E 47 verified (${png.length} bytes)`);

    const saved = await step(`doc.save ${SAVE_PATH} (layered checkpoint)`, () =>
      client.call("doc.save", { path: SAVE_PATH }),
    );
    const opened = await step(`doc.open ${SAVE_PATH} (reopen)`, () =>
      client.call("doc.open", { path: SAVE_PATH }),
    );
    const inspect = await step("doc.inspect (reopened document)", () => client.call("doc.inspect", null));

    const layers = Array.isArray(inspect.layers)
      ? inspect.layers.map((layer) => (layer && layer.name ? String(layer.name) : "?"))
      : [];
    const revisionBefore = typeof baseline.revision === "number" ? baseline.revision : "?";
    const revisionAfter = typeof inspect.revision === "number" ? inspect.revision : "?";
    log("");
    log("spine summary");
    log(`  document index ....... ${summarize(created.document ?? opened.document)}`);
    log(`  revision ............. ${revisionBefore} → ${revisionAfter}`);
    log(`  layers (top-down) .... ${summarize(layers)}`);
    log(`  saved ................ ${saved.path} (mock reports ${summarize(saved.bytes ?? "n/a")} bytes)`);
    if (root !== null) {
      log(`  artifacts kept in .... ${path.join(root, SAVE_PATH.split("/")[0])}`);
    } else {
      log("  artifacts live under the running mock-engine's own automation root");
    }
    log("Phase-0 spine: ok (auth, doc.new, batch, render PNG, save, reopen, inspect)");
    process.exitCode = 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`demo-spine: ${message}\n`);
    process.exitCode = error instanceof SpineError ? error.exitCode : 1;
  } finally {
    client.close();
    if (child !== null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        child.once("exit", resolve);
        setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 1500).unref();
      });
    }
    if (process.exitCode !== 0 && root !== null) {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

await main();
