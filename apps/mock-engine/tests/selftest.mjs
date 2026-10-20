// @studio/mock-engine — self-test of the transport + engine, run with bare `node --test`
// (this app IS the test tool, so it validates itself against the vendor protocol's own
// pinned behaviors from vendor/photocraft/crates/automation/src/rpc.rs tests).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, before, test } from "node:test";

import { METHODS } from "../src/engine.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ENTRY = path.join(HERE, "..", "src", "index.mjs");
const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const WRONG_TOKEN = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/**
 * Spawn a mock engine and wait for its listening line (the W2-J env contract).
 * @param {Record<string, string>} [env] extra environment entries
 * @returns {Promise<{child: import("node:child_process").ChildProcess, port: number, stop: () => Promise<void>}>}
 */
function startServer(env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], {
      env: {
        ...process.env,
        MOCK_ENGINE_PORT: "0",
        MOCK_ENGINE_TOKEN: TOKEN,
        MOCK_ENGINE_ROOT: root,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "";
    const onLine = (line) => {
      try {
        const message = JSON.parse(line);
        if (message.mockEngine === "listening") {
          cleanup();
          resolve({
            child,
            port: message.port,
            stop: () =>
              new Promise((done) => {
                child.on("exit", () => done());
                child.kill("SIGTERM");
                setTimeout(() => child.kill("SIGKILL"), 1500).unref();
              }),
          });
        }
      } catch {
        reject(new Error(`unexpected stdout line: ${line}`));
      }
    };
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        onLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    /** @param {Buffer} chunk */
    const onErrData = (chunk) => process.stderr.write(chunk); // surfaces fail-fast messages
    const cleanup = () => {
      child.stdout.off("data", onData);
      child.stderr.off("data", onErrData);
      child.off("error", onError);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onErrData);
    child.on("error", onError);
  });
}

/** A minimal protocol client: newline-delimited JSON with id-correlated replies. */
class Client {
  /**
   * @param {number} port
   * @param {string} [token] authenticate immediately when given
   */
  constructor(port, token = null) {
    this.socket = net.connect({ host: "127.0.0.1", port });
    this.buffer = "";
    /** @type {Array<(reply: any|null) => void>} */
    this.waiters = [];
    this.socket.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      let newline;
      while ((newline = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        const waiter = this.waiters.shift();
        if (waiter) waiter(line.trim().length === 0 ? null : JSON.parse(line));
      }
    });
    this.open = new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });
    this.authenticated = token === null ? Promise.resolve(null) : this.auth(token);
  }

  /** @param {string} token */
  auth(token) {
    return this.call("auth", { token }, "auth");
  }

  /**
   * @param {string} method
   * @param {any} [params]
   * @param {any} [id]
   * @returns {Promise<any|null>} the parsed reply, or null when the connection closed
   */
  call(method, params, id = 1) {
    this.socket.write(`${JSON.stringify({ id, method, params: params ?? {} })}\n`);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(new Error("timeout")), 4000);
      this.waiters.push((reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      this.socket.once("close", () => {
        clearTimeout(timer);
        const waiter = this.waiters.pop();
        if (waiter) waiter(null);
      });
    });
  }

  end() {
    this.socket.end();
  }

  destroy() {
    this.socket.destroy();
  }
}

/** Decode a PNG's IHDR dimensions without a dependency. @param {Buffer} bytes */
function pngDims(bytes) {
  assert.equal(bytes.readUInt32BE(0), 0x89504e47, "PNG signature");
  assert.equal(bytes.toString("ascii", 12, 16), "IHDR");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

let root = "";
let server = null;
let port = 0;
const held = [];

before(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "mock-engine-selftest-"));
  server = await startServer();
  port = server.port;
});

after(async () => {
  for (const client of held) client.destroy();
  if (server) await server.stop();
  rmSync(root, { recursive: true, force: true });
});

test("auth rejects a wrong token and closes, without exposing any method", async () => {
  const client = new Client(port, null);
  await client.open;
  const reply = await client.call("auth", { token: WRONG_TOKEN }, "a");
  assert.equal(reply.ok, false);
  assert.equal(reply.error, "authentication required");
  const closed = new Promise((resolve) => client.socket.once("close", resolve));
  assert.equal(await closed, undefined, "the connection is closed after a refused auth");
});

test("requests before auth are refused the same way", async () => {
  const client = new Client(port, null);
  await client.open;
  const reply = await client.call("methods", {});
  assert.equal(reply.ok, false);
  assert.equal(reply.error, "authentication required");
  await new Promise((resolve) => client.socket.once("close", resolve));
});

test("auth accepts the token case-insensitively and methods lists the vendor surface", async () => {
  const client = new Client(port, null);
  await client.open;
  const reply = await client.call("auth", { token: TOKEN.toUpperCase() }, "auth");
  assert.deepEqual(reply, { id: "auth", ok: true, result: { authenticated: true } });
  const methods = await client.call("methods", {}, "m");
  assert.deepEqual(methods.result, METHODS);
  assert.ok(methods.result.includes("batch"));
  client.end();
});

test("doc.new → execute → inspect → render roundtrip", async () => {
  const client = new Client(port, TOKEN);
  await client.authenticated;

  const created = await client.call("doc.new", { width: 40, height: 30, background: "white" }, 1);
  assert.deepEqual(created.result, { document: 0 });

  const fail = await client.call("engine.execute", { command: "layer.new.layer", params: [] }, 2);
  assert.equal(fail.ok, false, "params must be a JSON object");
  assert.match(fail.error, /invalid parameters for `layer\.new\.layer`: params must be a JSON object/);

  const layer = await client.call("engine.execute", { command: "layer.new.layer", params: { name: "Ink" } }, 3);
  assert.deepEqual(layer.result, { layer: 2 });

  const inspected = await client.call("doc.inspect", {}, 4);
  assert.equal(inspected.result.name, "Untitled");
  assert.equal(inspected.result.width, 40);
  assert.equal(inspected.result.layers.length, 2);
  assert.equal(inspected.result.layers[0].name, "Ink"); // top-down
  assert.equal(inspected.result.layers[0].kind, "Pixel");
  assert.equal(inspected.result.activeLayer, 2);
  assert.deepEqual(inspected.result.history, ["New Layer"]);
  assert.ok(inspected.result.canUndo);

  const rendered = await client.call("doc.render", { maxSide: 1024 }, 5);
  assert.equal(rendered.result.mime, "image/png");
  const png = Buffer.from(rendered.result.base64, "base64");
  assert.deepEqual(pngDims(png), { width: 40, height: 30 }, "no upscaling below maxSide");

  const scaled = await client.call("doc.render", { maxSide: 20 }, 6);
  assert.deepEqual(pngDims(Buffer.from(scaled.result.base64, "base64")), { width: 20, height: 15 });

  const oversize = await client.call("doc.render", { maxSide: 4096 }, 7);
  assert.equal(oversize.ok, false);
  assert.match(oversize.error, /preview side exceeds 2048 pixels/);

  const session = await client.call("session.list", {}, 8);
  assert.equal(session.result.documents[0].dirty, true, "edits leave the document dirty");
  client.end();
});

test("errors: unknown method, unknown command, disabled command, bad index", async () => {
  const client = new Client(port, TOKEN);
  await client.authenticated;

  const method = await client.call("nope", {}, 1);
  assert.equal(method.ok, false);
  assert.equal(method.error, "unknown method `nope` (try `methods`)");

  const command = await client.call("engine.execute", { command: "no.such.command" }, 2);
  assert.equal(command.error, "unknown command `no.such.command`");

  const index = await client.call("doc.close", { index: "0" }, 3);
  assert.equal(index.error, "`index` must be a non-negative integer");

  // A fresh second server process has no document: layer commands report needsDocument.
  const fresh = await startServer();
  const probe = new Client(fresh.port, TOKEN);
  await probe.authenticated;
  const commands = await probe.call("engine.commands", { filter: "layer.new.layer" }, 1);
  const entry = commands.result.find((c) => c.id === "layer.new.layer");
  assert.equal(entry.enabled, false);
  assert.equal(entry.disabledReason, "no document open");
  assert.equal(entry.needsDocument, true);
  assert.deepEqual(
    Object.keys(entry).sort(),
    ["disabledReason", "enabled", "id", "label", "menu", "needsDocument", "params", "shortcut"],
    "the command-list reply shape is pinned (rpc.rs #3684)",
  );
  const refused = await probe.call("engine.execute", { command: "layer.new.layer" }, 2);
  assert.equal(
    refused.error,
    "command `layer.new.layer` is not available right now: no document open",
  );
  const ambient = await probe.call("engine.execute", { command: "file.open" }, 3);
  assert.match(ambient.error, /uses ambient filesystem paths and is disabled/);
  probe.end();
  await fresh.stop();
  client.end();
});

test("a second auth frame answers 'already authenticated' and keeps serving", async () => {
  const client = new Client(port, TOKEN);
  await client.authenticated;
  const again = await client.call("auth", { token: TOKEN }, "again");
  assert.deepEqual(again, { id: "again", ok: false, error: "already authenticated" });
  const methods = await client.call("methods", {}, "m");
  assert.equal(methods.ok, true);
  client.end();
});

test("a malformed line is answered with id null and the session keeps serving", async () => {
  const client = new Client(port, TOKEN);
  await client.authenticated;
  client.socket.write("this is not json\n");
  const reply = await new Promise((resolve) => {
    client.waiters.push((value) => resolve(value));
  });
  assert.equal(reply.ok, false);
  assert.equal(reply.id, null);
  assert.match(reply.error, /bad JSON:/);
  const session = await client.call("session.list", {}, 2);
  assert.equal(session.ok, true, "the document stays open and the session keeps serving");
  client.end();
});

test("an oversized request line is refused before dispatch and closes the connection", async () => {
  const client = new Client(port, TOKEN);
  await client.authenticated;
  const reply = await new Promise((resolve) => {
    client.waiters.push((value) => resolve(value));
    client.socket.once("close", () => resolve(null));
  });
  client.socket.write(`${" ".repeat((1 << 20) + 2)}\n`);
  assert.ok(reply, "one error reply arrives");
  assert.equal(reply.ok, false);
  assert.equal(reply.error, "request exceeds 1048576 bytes");
  await new Promise((resolve) => client.socket.once("close", resolve));
});

test("batch: sequential steps, stopOnError default, per-step envelopes", async () => {
  const client = new Client(port, TOKEN);
  await client.authenticated;
  const steps = [
    { command: "layer.new.layer", params: { name: "A" } },
    { command: "no.such.command" },
    { command: "layer.new.layer", params: { name: "B" } },
    { method: "doc.inspect" },
  ];
  const stopped = await client.call("batch", { steps }, 1);
  assert.equal(stopped.result.completed, 1);
  assert.equal(stopped.result.failed, 1);
  assert.equal(stopped.result.results.length, 2, "stopped at the first error");
  assert.equal(stopped.result.results[0].ok, true);

  const continued = await client.call("batch", { steps, stopOnError: false }, 2);
  assert.equal(continued.result.completed, 3);
  assert.equal(continued.result.failed, 1);
  const inspected = continued.result.results[3].result;
  assert.ok(inspected.layers.some((l) => l.name === "B"));

  const nested = await client.call("batch", { steps: [{ method: "batch", params: { steps: [] } }] }, 3);
  assert.equal(nested.result.results[0].error, "nested batch");

  const tooMany = await client.call("batch", { steps: Array.from({ length: 257 }, () => ({ command: "command.list" })) }, 4);
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.error, /batch contains 257 steps; maximum is 256/);
  client.end();
});

test("jobs: wait:false on a job-capable command returns a job id, list shows it done", async () => {
  const client = new Client(port, TOKEN);
  await client.authenticated;
  const started = await client.call("engine.execute", { command: "edit.transform", params: { dx: 10 }, wait: false }, 1);
  assert.equal(started.result.pending, true);
  const jobId = started.result.job;
  const listed = await client.call("jobs.list", {}, 2);
  const job = listed.result.jobs.find((j) => j.id === jobId);
  assert.equal(job.state, "done");
  assert.equal(job.progress, 1);
  assert.equal(job.command, "edit.transform");
  assert.deepEqual(Object.keys(job).sort(), [
    "command",
    "document",
    "elapsedMs",
    "id",
    "label",
    "message",
    "progress",
    "result",
    "state",
  ], "JobInfo shape (jobs.rs, camelCase)");
  const cancel = await client.call("jobs.cancel", { job: jobId }, 3);
  assert.equal(cancel.ok, false);
  assert.equal(cancel.error, `no running job ${jobId}`);
  client.end();
});

test("agent.begin → edit → rollback restores the checkpoint; commit keeps the edits", async () => {
  const client = new Client(port, TOKEN);
  await client.authenticated;
  const began = await client.call("engine.execute", { command: "agent.begin", params: { label: "try" } }, 1);
  assert.equal(began.ok, true);
  await client.call("engine.execute", { command: "layer.new.layer", params: { name: "Scratch" } }, 2);
  const rolled = await client.call("engine.execute", { command: "agent.rollback" }, 3);
  assert.equal(rolled.ok, true);
  const after = await client.call("doc.inspect", {}, 4);
  assert.ok(!after.result.layers.some((l) => l.name === "Scratch"), "rollback removed the layer");

  await client.call("engine.execute", { command: "agent.begin" }, 5);
  await client.call("engine.execute", { command: "layer.new.layer", params: { name: "Kept" } }, 6);
  const committed = await client.call("engine.execute", { command: "agent.commit" }, 7);
  assert.equal(committed.ok, true);
  const kept = await client.call("doc.inspect", {}, 8);
  assert.ok(kept.result.layers.some((l) => l.name === "Kept"));
  client.end();
});

test("capability roots: traversal and escape are refused; save/open roundtrips .pcraft", async () => {
  const client = new Client(port, TOKEN);
  await client.authenticated;
  const escape = await client.call("doc.place", { path: "../../etc/passwd" }, 1);
  assert.equal(escape.ok, false);
  assert.match(escape.error, /automation path rejected: parent traversal is not allowed/);

  const absolute = await client.call("doc.open", { path: "/etc/passwd" }, 2);
  assert.match(absolute.error, /absolute paths must be inside the automation root/);

  const saved = await client.call("doc.save", { path: "state.pcraft" }, 3);
  assert.deepEqual(saved.result, { path: "state.pcraft", warnings: [] });
  const clean = await client.call("session.list", {}, 4);
  assert.equal(clean.result.documents[0].dirty, false, "a .pcraft save records the revision");

  await client.call("doc.close", {}, 5);
  const reopened = await client.call("doc.open", { path: "state.pcraft" }, 6);
  assert.equal(reopened.ok, true);
  assert.ok(reopened.result.layers >= 2, "the layers survive the roundtrip");

  const denied = await startServer({ MOCK_ENGINE_ROOT: "" });
  const probe = new Client(denied.port, TOKEN);
  await probe.authenticated;
  await probe.call("doc.new", { width: 8, height: 8 }, 1);
  const refused = await probe.call("doc.save", { path: "x.pcraft" }, 2);
  assert.match(refused.error, /automation filesystem access is not granted: write authority is absent/);
  probe.end();
  await denied.stop();
  client.end();
});

test("mock.faults: an oversized reply is cut down to the reply-budget error", async () => {
  const client = new Client(port, TOKEN);
  await client.authenticated;
  const armed = await client.call("mock.faults", { config: { oversizedReply: "doc.inspect" } }, 1);
  assert.deepEqual(armed.result.faults, { oversizedReply: "doc.inspect" });
  const reply = await client.call("doc.inspect", {}, 2);
  assert.equal(reply.ok, false);
  assert.match(reply.error, /response exceeds 8388608 bytes; operation may have completed/);
  const reset = await client.call("mock.faults", { config: null }, 3);
  assert.deepEqual(reset.result.faults, {});
  const healthy = await client.call("doc.inspect", {}, 4);
  assert.equal(healthy.ok, true);
  client.end();
});

test("fault hooks via env: crash-on-command kills the process; hang-on-method never replies", async () => {
  const crashed = await startServer({ MOCK_ENGINE_FAULTS: JSON.stringify({ crashOnCommand: "edit.fill" }) });
  const killer = new Client(crashed.port, TOKEN);
  await killer.authenticated;
  await killer.call("doc.new", { width: 8, height: 8 }, 1);
  const exit = new Promise((resolve) => crashed.child.once("exit", (code) => resolve(code)));
  killer.socket.write(`${JSON.stringify({ id: 2, method: "engine.execute", params: { command: "edit.fill", params: {} } })}\n`);
  assert.equal(await exit, 1, "the process dies mid-command; the client sees the socket drop");
  killer.destroy();

  const hung = await startServer({ MOCK_ENGINE_FAULTS: JSON.stringify({ hangOnMethod: "doc.render" }) });
  const waiter = new Client(hung.port, TOKEN);
  await waiter.authenticated;
  await waiter.call("doc.new", { width: 8, height: 8 }, 1);
  const silent = await Promise.race([
    new Promise((resolve) => {
      waiter.socket.once("data", () => resolve("data"));
    }),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 300)),
  ]);
  assert.equal(silent, "timeout", "no reply arrives; the client must hit its own request timeout");
  waiter.destroy();
  await hung.stop();
});

test("transport limits: 16 serviced connections; the 17th is refused with one line", async () => {
  const sockets = [];
  for (let i = 0; i < 16; i += 1) {
    const client = new Client(port, TOKEN);
    held.push(client);
    await client.open;
    sockets.push(client);
  }
  const extra = net.connect({ host: "127.0.0.1", port });
  const reply = await new Promise((resolve) => {
    let buffer = "";
    extra.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("\n")) resolve(JSON.parse(buffer.trim()));
    });
  });
  assert.deepEqual(reply, { id: null, ok: false, error: "connection limit reached" });
  extra.destroy();
  for (const client of sockets) client.destroy();
});
