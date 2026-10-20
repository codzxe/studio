// @ts-check
/**
 * Selftest: spawns src/index.mjs on an ephemeral port (MOCK_ENGINE_PORT=0) and
 * speaks the real NDJSON protocol over TCP — auth reject, then the required
 * doc.new → engine.execute → doc.render roundtrip, plus the cheap contract
 * checks (repeat auth, unknown method/command, engine.commands, batch, cap).
 * Run: `node --test tests/` (no npm test deps).
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "src", "index.mjs");
const TOKEN = "0123456789abcdef".repeat(4); // 64 hex chars, synthetic

/** Features this suite needs; `describe.skipIf` semantics via describe.skip. */
const missing = [];
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
if (nodeMajor < 18) missing.push(`node>=18 (have ${process.versions.node})`);
if (typeof structuredClone !== "function") missing.push("structuredClone");
if (typeof spawn !== "function" || typeof net.createServer !== "function") missing.push("node core modules");
const d = missing.length > 0 ? describe.skip : describe;

/** Spawn one mock server; resolves once its stderr announces the real port. */
function startServer(extraEnv = {}) {
  const writeRoot = mkdtempSync(join(tmpdir(), "mock-engine-selftest-"));
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, MOCK_ENGINE_PORT: "0", MOCK_ENGINE_TOKEN: TOKEN, MOCK_ENGINE_WRITE_ROOT: writeRoot, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  const portPromise = new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`server never announced readiness; stderr: ${err}`)), 8000);
    child.stderr.on("data", (chunk) => {
      err += String(chunk);
      const m = /listening on 127\.0\.0\.1:(\d+)/.exec(err);
      if (m) {
        clearTimeout(timer);
        res(Number(m[1]));
      }
    });
    child.on("exit", (code) => rej(new Error(`server exited early (${code}); stderr: ${err}`)));
  });
  return { child, writeRoot, port: portPromise };
}

function stopServer(h) {
  h.child.kill("SIGTERM");
  return new Promise((res) => {
    const t = setTimeout(() => {
      h.child.kill("SIGKILL");
      res();
    }, 1500);
    h.child.on("exit", () => {
      clearTimeout(t);
      res();
    });
  });
}

/** A minimal NDJSON client with id correlation and hard timeouts (never hangs the suite). */
function connect(port) {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  socket.on("error", () => {});
  const client = { socket, buf: "", pending: new Map(), closed: false, closeWaiters: [] };
  socket.on("data", (chunk) => {
    client.buf += chunk.toString("utf8");
    let i = client.buf.indexOf("\n");
    while (i >= 0) {
      const line = client.buf.slice(0, i);
      client.buf = client.buf.slice(i + 1);
      if (line.trim().length > 0) {
        try {
          const msg = JSON.parse(line);
          const waiter = client.pending.get(JSON.stringify(msg.id ?? null));
          if (waiter) {
            client.pending.delete(JSON.stringify(msg.id ?? null));
            waiter(msg);
          }
        } catch { /* not a JSON line: ignore */ }
      }
      i = client.buf.indexOf("\n");
    }
  });
  socket.on("close", () => {
    client.closed = true;
    for (const [, waiter] of client.pending) waiter({ ok: false, error: "connection closed" });
    client.pending.clear();
    for (const w of client.closeWaiters.splice(0)) w();
  });
  client.call = (id, method, params = {}, ms = 4000) => {
    const key = JSON.stringify(id ?? null);
    const p = new Promise((res, rej) => {
      const timer = setTimeout(() => {
        client.pending.delete(key);
        rej(new Error(`timeout waiting for reply id=${key}`));
      }, ms);
      client.pending.set(key, (msg) => {
        clearTimeout(timer);
        res(msg);
      });
    });
    socket.write(`${JSON.stringify({ id, method, params })}\n`);
    return p;
  };
  client.waitForClose = (ms = 4000) => (client.closed ? Promise.resolve() : new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error("timeout waiting for connection close")), ms);
    client.closeWaiters.push(() => {
      clearTimeout(timer);
      res();
    });
  }));
  client.destroy = () => socket.destroy();
  return new Promise((res, rej) => {
    socket.once("connect", () => res(client));
    socket.once("error", (e) => rej(e));
  });
}

d("mock-engine selftest (spawned TCP server)", () => {
  /** @type {any} */ let srv;

  before(async () => {
    srv = startServer();
    await srv.port;
  });

  after(async () => {
    await stopServer(srv);
  });

  it("rejects a wrong token with `authentication required` and closes", async (t) => {
    const port = await srv.port;
    const c = await connect(port);
    t.after(() => c.destroy());
    const bad = await c.call("auth", "auth", { token: "f".repeat(64) });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, "authentication required");
    await c.waitForClose();
  });

  it("doc.new → engine.execute → doc.render roundtrip, then save/inspect/close", async (t) => {
    const port = await srv.port;
    const c = await connect(port);
    t.after(() => c.destroy());
    const auth = await c.call("auth", "auth", { token: TOKEN });
    assert.deepEqual(auth, { id: "auth", ok: true, result: { authenticated: true } });

    const created = await c.call(1, "doc.new", { width: 800, height: 600, background: "white" });
    assert.equal(created.ok, true);
    assert.equal(created.result.document, 0);

    const layer = await c.call(2, "engine.execute", { command: "layer.new.layer", params: { name: "Ink" } });
    assert.equal(layer.ok, true);
    assert.equal(typeof layer.result.layer, "number");

    const typed = await c.call(3, "engine.execute", { command: "type.create", params: { text: "Hi", x: 10, y: 20 } });
    assert.equal(typed.ok, true);
    assert.equal(typed.result.bounds.length, 4);

    const rendered = await c.call(4, "doc.render", { maxSide: 1024 });
    assert.equal(rendered.ok, true);
    assert.equal(rendered.result.mime, "image/png");
    const png = Buffer.from(rendered.result.base64, "base64");
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(png.readUInt32BE(16), 8, "IHDR width");
    assert.equal(png.readUInt32BE(20), 8, "IHDR height");

    const inspected = await c.call(5, "doc.inspect", {});
    assert.equal(inspected.ok, true);
    assert.equal(inspected.result.layers.length, 3);
    assert.equal(inspected.result.layers[0].kind, "Type", "top-down order");
    assert.equal(inspected.result.layers[0].text.text, "Hi");
    assert.equal(inspected.result.layers.at(-1).name, "Background");
    assert.ok(inspected.result.revision >= 3);

    const saved = await c.call(6, "doc.save", { path: "snapshots/roundtrip.json" });
    assert.equal(saved.ok, true);
    const onDisk = JSON.parse(readFileSync(join(srv.writeRoot, "snapshots/roundtrip.json"), "utf8"));
    assert.equal(onDisk.layers.length, 3);

    const session = await c.call(7, "session.list", {});
    assert.equal(session.result.documents[0].dirty, false, "a layered save clears dirty");

    const closed = await c.call(8, "doc.close", {});
    assert.equal(closed.ok, true);
    const emptied = await c.call(9, "session.list", {});
    assert.equal(emptied.result.active, null);
  });

  it("repeat auth is `already authenticated` and the connection keeps serving", async (t) => {
    const port = await srv.port;
    const c = await connect(port);
    t.after(() => c.destroy());
    await c.call("auth", "auth", { token: TOKEN });
    const again = await c.call("again", "auth", { token: TOKEN });
    assert.deepEqual(again, { id: "again", ok: false, error: "already authenticated" });
    const still = await c.call("still", "methods", {});
    assert.equal(still.ok, true);
  });

  it("correlates unknown method/command errors to the request id", async (t) => {
    const port = await srv.port;
    const c = await connect(port);
    t.after(() => c.destroy());
    await c.call("auth", "auth", { token: TOKEN });
    const badMethod = await c.call(41, "nope", {});
    assert.deepEqual(badMethod, { id: 41, ok: false, error: "unknown method `nope` (try `methods`)" });
    const badCommand = await c.call(42, "engine.execute", { command: "filter.noise.addNoise" });
    assert.equal(badCommand.ok, false);
    assert.ok(badCommand.error.includes("unknown command"), badCommand.error);
    assert.equal(badCommand.id, 42);
  });

  it("engine.commands lists exactly the supported commands", async (t) => {
    const port = await srv.port;
    const c = await connect(port);
    t.after(() => c.destroy());
    await c.call("auth", "auth", { token: TOKEN });
    const made = await c.call(1, "doc.new", {});
    assert.equal(made.ok, true);
    const commands = await c.call(2, "engine.commands", {});
    assert.equal(commands.ok, true);
    assert.deepEqual(
      commands.result.map((r) => r.id),
      [
        "layer.new.layer", "layer.new.group", "layer.delete", "layer.setProps", "layer.select",
        "type.create", "type.edit", "edit.fill", "layer.arrange.bringToFront", "layer.arrange.sendToBack",
        "edit.transform", "layer.layerMask.revealAll", "agent.begin", "agent.commit", "agent.rollback",
      ],
    );
    for (const row of commands.result) {
      assert.equal(row.enabled, true);
      assert.equal(row.disabledReason, null);
      assert.equal(row.needsDocument, false);
    }
  });

  it("batch runs steps in order and stops on the first error", async (t) => {
    const port = await srv.port;
    const c = await connect(port);
    t.after(() => c.destroy());
    await c.call("auth", "auth", { token: TOKEN });
    await c.call(1, "doc.new", {});
    const batch = await c.call(2, "batch", {
      steps: [
        { command: "layer.new.layer", params: { name: "A" } },
        { method: "session.list" },
        { command: "definitely.not.a.command" },
        { command: "layer.new.layer", params: { name: "never-run" } },
      ],
    });
    assert.equal(batch.ok, true);
    assert.equal(batch.result.completed, 2);
    assert.equal(batch.result.failed, 1);
    assert.equal(batch.result.results.length, 3, "stopOnError (default) halts after the failure");
    assert.equal(batch.result.results[2].ok, false);
    assert.ok(batch.result.results[2].error.includes("unknown command"));
  });

  it("closes the 17th connection past the 16-connection cap", async (t) => {
    const port = await srv.port;
    const held = [];
    for (let i = 0; i < 16; i++) held.push(await connect(port));
    t.after(() => held.forEach((c) => c.destroy()));
    const extra = await connect(port);
    await extra.waitForClose();
    assert.equal(extra.closed, true, "the excess connection is rejected before any dispatch");
  });

  it("MOCK_FAULT=crash-on-command exits the process on engine.execute", async () => {
    const faulty = startServer({ MOCK_FAULT: "crash-on-command" });
    const port = await faulty.port;
    const c = await connect(port);
    await c.call("auth", "auth", { token: TOKEN });
    const code = await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error("faulty server never exited")), 4000);
      faulty.child.on("exit", (exitCode) => {
        clearTimeout(timer);
        res(exitCode);
      });
      c.call(1, "engine.execute", { command: "layer.new.layer" }).catch(() => {});
    });
    assert.equal(code, 86);
    c.destroy();
  });
});
