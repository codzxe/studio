// tests/contract.test.ts — spec §21 Contract-testing row: "Recorded RPC fixtures + schema
// tests. The control protocol client against frozen responses; detect upstream drift in CI."
//
// Layers, in order:
//   1. Fixture pins — every recorded-style reply in fixtures/replies parses against Zod
//      schemas transcribed from vendor/photocraft (rpc.rs, security.rs, budgets.rs,
//      inspect.rs, commands.rs — see protocol-schemas.ts for the per-line citations).
//   2. Transport driving — JsonLinesTransport (tests/reference-transport.ts) replays the
//      fixtures through FakeSocket: parsing, correlation, error paths, budget enforcement.
//      NOTE (task fallback): src/index.ts is owned by W2-D and was absent at authoring
//      time, so per the W2-E task this file drives the transport + methods layers
//      directly; the reference transport is the executable protocol spec until src lands.
//   3. Real client — once src/index.ts exists it is auto-detected and driven through the
//      same FakeSocket + fixtures (skipIf absent; a mismatched seam FAILS with a reconcile
//      message — this file is the meeting point of the W2-D/W2-E contract).

import { describe, expect, it } from "vitest";
import { ENGINE_PNG_MAX_BYTES, ENGINE_PREVIEW_MAX_PX, ENGINE_REPLY_MAX_BYTES } from "@studio/config";
import { FakeSocket } from "./fake-socket.js";
import {
  MAX_BATCH_STEPS,
  MAX_REPLY_BYTES,
  MAX_REQUEST_BYTES,
  METHODS_PIN,
  OVERSIZED_REQUEST_ERROR,
  REQUIRED_METHODS,
  authOkSchema,
  batchResultSchema,
  commandListResultSchema,
  correlationIdSchema,
  docInspectResultSchema,
  docNewResultSchema,
  envelopeSchema,
  renderBase64ResultSchema,
  renderPathResultSchema,
  sessionListResultSchema,
} from "./protocol-schemas.js";
import { EngineTransportError, JsonLinesTransport } from "./reference-transport.js";
import { type Exchange, loadReply } from "./fixtures.js";

/** 64-hex token shape from docs/control-protocol.md (the auth-ok fixture's synthetic value). */
const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/** Fixtures whose reply correlates with the request by id (error-transport replies id:null). */
const CORRELATABLE_FIXTURES = [
  "auth-ok",
  "auth-rejected",
  "doc-new",
  "session-list",
  "doc-inspect",
  "doc-render-base64",
  "doc-render-path",
  "engine-commands",
  "batch-results",
  "error-bad-params",
  "error-unknown-method",
  "methods",
] as const;

function paramsOf(fixture: Exchange): unknown {
  return fixture.request.params;
}

// ---------------------------------------------------------------------------
// 1. Fixture pins — the frozen-response schema tests (§21)
// ---------------------------------------------------------------------------

describe("recorded fixtures pin the engine's wire shapes", () => {
  it("every reply is a valid {id, ok, result|error} envelope that echoes the request id", async () => {
    for (const name of CORRELATABLE_FIXTURES) {
      const fixture = await loadReply(name);
      expect(correlationIdSchema.parse(fixture.request.id), name).not.toBeNull();
      const reply = envelopeSchema.parse(fixture.reply);
      expect(reply.id, name).toEqual(fixture.request.id);
    }
  });

  it("auth-ok: result is exactly {authenticated: true} (security.rs)", async () => {
    const fixture = await loadReply("auth-ok");
    authOkSchema.parse(fixture.reply);
    expect(fixture.request.method).toBe("auth");
    const params = paramsOf(fixture) as Record<string, unknown>;
    expect(params.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("auth-rejected: error 'authentication required', never a result", async () => {
    const fixture = await loadReply("auth-rejected");
    const reply = envelopeSchema.parse(fixture.reply);
    expect(reply.ok).toBe(false);
    expect(reply.error).toBe("authentication required");
    expect("result" in fixture.reply).toBe(false);
  });

  it("doc-new: result {document: index} — a session index, not an id (commands.rs)", async () => {
    const fixture = await loadReply("doc-new");
    const result = docNewResultSchema.parse(fixture.reply.result);
    expect(result).toEqual({ document: 0 });
  });

  it("session-list: documents addressed by index, with revision counters", async () => {
    const fixture = await loadReply("session-list");
    const result = sessionListResultSchema.parse(fixture.reply.result);
    expect(result.active).toBe(0);
    expect(result.documents).toHaveLength(1);
    const first = result.documents[0];
    expect(first?.name).toBe("Ad square");
    expect(first?.revision).toBeGreaterThanOrEqual(1);
  });

  it("doc-inspect: layer tree with bounds/visibility/opacity/blend/text (inspect.rs)", async () => {
    const fixture = await loadReply("doc-inspect");
    const result = docInspectResultSchema.parse(fixture.reply.result);
    expect(result.activeLayer).toBe(3);
    expect(result.selectedLayers).toEqual([3]);
    expect(result.history[0]).toBe("New Document");
    expect(result.snapshots).toEqual([{ id: 1, name: "Ad square 1" }]);

    const headline = result.layers.find((l) => l.name === "Headline");
    expect(headline?.kind).toBe("Type");
    expect(headline?.text?.text).toBe("Spring Sale");
    expect(headline?.bounds).toEqual([80, 120, 920, 96]);

    const ink = result.layers.find((l) => l.name === "Ink");
    expect(ink?.visible).toBe(false);
    expect(ink?.opacity).toBe(0.85);
    expect(ink?.blend).toBe("Multiply");
    expect(ink?.hasMask).toBe(true);
  });

  it("doc.render base64: {mime: 'image/png', base64} (rpc.rs)", async () => {
    const fixture = await loadReply("doc-render-base64");
    const result = renderBase64ResultSchema.parse(fixture.reply.result);
    expect(result.mime).toBe("image/png");
  });

  it("doc.render to path: {path, bytes} where bytes is the PNG length (rpc.rs)", async () => {
    const fixture = await loadReply("doc-render-path");
    const result = renderPathResultSchema.parse(fixture.reply.result);
    expect(result.bytes).toBeGreaterThan(0);
  });

  it("engine.commands: a BARE array; exact key set; disabledReason null iff enabled (#3684)", async () => {
    const fixture = await loadReply("engine-commands");
    const result = commandListResultSchema.parse(fixture.reply.result);
    const ids = result.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length); // unique ids

    const fileNew = result.find((c) => c.id === "file.new");
    expect(fileNew?.menu).toEqual(["File"]);
    expect(fileNew?.shortcut).toBe("Cmd+N");
    expect(fileNew?.enabled).toBe(true);
    expect(fileNew?.disabledReason).toBeNull();
    expect(fileNew?.needsDocument).toBe(false);

    const selectRect = result.find((c) => c.id === "select.rect");
    expect(typeof selectRect?.keywords).toBe("string"); // optional key, #5060

    const undo = result.find((c) => c.id === "edit.undo");
    expect(undo?.enabled).toBe(false);
    expect(undo?.disabledReason).toBe("nothing to undo");
    expect(undo?.needsDocument).toBe(false);

    for (const entry of result) {
      if (entry.needsDocument && entry.id !== "edit.undo") {
        expect(entry.disabledReason).toBe("no document open");
      }
    }
  });

  it("batch results: completed + failed === results.length; step errors name the command", async () => {
    const fixture = await loadReply("batch-results");
    const result = batchResultSchema.parse(fixture.reply.result);
    expect(result.completed).toBe(2);
    expect(result.failed).toBe(1);
    // stopOnError's default true: nothing ran past the failing step (rpc.rs batch_with_budget).
    expect(result.results).toHaveLength(3);
    const failed = result.results[2];
    expect(failed && failed.ok === false ? failed.error : undefined).toBe(
      "unknown command `no.such.command`",
    );
  });

  it("bad params are error replies naming the command and parameter (§1.5-4: Err, never panic)", async () => {
    const fixture = await loadReply("error-bad-params");
    const reply = envelopeSchema.parse(fixture.reply);
    expect(reply.ok).toBe(false);
    expect(reply.error).toBe("invalid parameters for `filter.blur.gaussianBlur`: `radius` must be a number in 0.1..1000");
    expect("result" in fixture.reply).toBe(false);
  });

  it("unknown method: error text with the '(try `methods`)' hint (rpc.rs)", async () => {
    const fixture = await loadReply("error-unknown-method");
    const reply = envelopeSchema.parse(fixture.reply);
    expect(reply.error).toBe("unknown method `nope` (try `methods`)");
  });

  it("transport-level failures reply with id:null (bad JSON / oversized line)", async () => {
    const fixture = await loadReply("error-transport");
    const reply = envelopeSchema.parse(fixture.reply);
    expect(reply.id).toBeNull();
    expect(reply.error).toMatch(/^bad JSON: /);
    const oversized = envelopeSchema.parse(fixture.reply_oversized);
    expect(oversized.error).toBe(OVERSIZED_REQUEST_ERROR);
  });

  it("methods: the frozen 18-method headless surface, in rpc.rs order", async () => {
    const fixture = await loadReply("methods");
    expect(fixture.reply.result).toEqual([...METHODS_PIN]);
    for (const method of REQUIRED_METHODS) {
      expect((fixture.reply.result as string[]).includes(method), method).toBe(true);
    }
  });

  it("engine budget constants agree with their @studio/config mirrors (budgets.rs)", () => {
    expect(ENGINE_REPLY_MAX_BYTES).toBe(MAX_REPLY_BYTES); // 8 MiB reply ceiling
    expect(ENGINE_PNG_MAX_BYTES).toBe(5 << 20); // 5 MiB PNG before base64
    expect(ENGINE_PREVIEW_MAX_PX).toBe(2048); // preview long edge
  });
});

// ---------------------------------------------------------------------------
// 2. Transport driving — parsing, correlation, error paths, budgets
// ---------------------------------------------------------------------------

describe("JsonLinesTransport drives the fixtures through FakeSocket", () => {
  it("replays every correlatable fixture: ok replies resolve result, errors reject with the engine text", async () => {
    for (const name of CORRELATABLE_FIXTURES) {
      const fixture = await loadReply(name);
      // The transport assigns its own ids; the recorded reply shape is replayed with the
      // live id so correlation is exercised end-to-end for every fixture.
      const fake = new FakeSocket({
        replies: [JSON.stringify({ ...fixture.reply, id: 1 })],
      });
      const transport = new JsonLinesTransport(fake);
      const call = transport.call(String(fixture.request.method), paramsOf(fixture));
      if (fixture.reply.ok === true) {
        await expect(call, name).resolves.toEqual(fixture.reply.result);
      } else {
        // Error replies reject with a typed EngineTransportError carrying the engine's text.
        let rejected: unknown;
        try {
          await call;
        } catch (error) {
          rejected = error;
        }
        expect(rejected, name).toBeInstanceOf(EngineTransportError);
        expect(rejected instanceof EngineTransportError && rejected.engineMessage, name).toBe(
          fixture.reply.error,
        );
      }
    }
  });

  it("authenticates first (TCP rule) and sends the token only in the auth frame", async () => {
    const fake = new FakeSocket({
      token: TOKEN,
      replies: [JSON.stringify({ id: 2, ok: true, result: { document: 0 } })],
    });
    const transport = new JsonLinesTransport(fake);

    await expect(transport.auth(TOKEN)).resolves.toEqual({ authenticated: true });
    const created = await transport.call("doc.new", { width: 1080, height: 1080, background: "white" });
    expect(created).toEqual({ document: 0 });

    expect(fake.writtenFrames[0]?.method).toBe("auth");
    expect((fake.writtenFrames[0]?.params as Record<string, unknown>).token).toBe(TOKEN);
    expect(fake.writtenFrames[1]?.method).toBe("doc.new");
    expect(fake.written).toHaveLength(2);
  });

  it("a rejected token is a terminal engine error and the connection closes", async () => {
    const fake = new FakeSocket({ token: TOKEN, replies: [] });
    const transport = new JsonLinesTransport(fake);
    await expect(transport.auth("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")).rejects.toMatchObject(
      { code: "engine_error", engineMessage: "authentication required" },
    );
    expect(fake.isDestroyed).toBe(true);
    await expect(transport.call("session.list", {})).rejects.toMatchObject({ code: "connection_closed" });
  });

  it("out-of-order replies resolve their own calls (correlation by id)", async () => {
    const fake = new FakeSocket({
      replies: [
        () => null, // let both requests be in flight before answering
        (frame, socket) => {
          socket.sendLine(JSON.stringify({ id: 2, ok: true, result: { which: "second" } }));
          return JSON.stringify({ id: 1, ok: true, result: { which: "first" } });
        },
      ],
    });
    const transport = new JsonLinesTransport(fake);
    const first = transport.call("doc.new", {});
    const second = transport.call("session.list", {});
    await expect(first).resolves.toEqual({ which: "first" });
    await expect(second).resolves.toEqual({ which: "second" });
    expect(transport.orphans).toHaveLength(0);
  });

  it("id:null transport notices never resolve a pending call", async () => {
    const fake = new FakeSocket({ replies: [() => null] });
    const transport = new JsonLinesTransport(fake);

    let settled = 0;
    const call = transport.call("doc.new", {}).then((value) => {
      settled += 1;
      return value;
    });

    fake.sendLine(JSON.stringify({ id: null, ok: false, error: "bad JSON: expected value at line 1 column 1" }));
    fake.sendLine(JSON.stringify({ id: null, ok: false, error: OVERSIZED_REQUEST_ERROR }));
    expect(settled).toBe(0); // still pending: the notices belong to no request

    fake.sendLine(JSON.stringify({ id: 1, ok: true, result: { document: 0 } }));
    await expect(call).resolves.toEqual({ document: 0 });
    expect(settled).toBe(1);
    expect(transport.notices).toHaveLength(2);
  });

  it("replies with an unknown id are recorded as orphans and never crash the transport", async () => {
    const fake = new FakeSocket({
      replies: [
        (frame, socket) => {
          // An unsolicited reply for an id the client never used arrives first…
          socket.sendLine(JSON.stringify({ id: 99, ok: true, result: { stray: true } }));
          // …then the real reply for the live call.
          return JSON.stringify({ id: 1, ok: true, result: { document: 0 } });
        },
      ],
    });
    const transport = new JsonLinesTransport(fake);
    await expect(transport.call("doc.new", {})).resolves.toEqual({ document: 0 });
    expect(transport.orphans).toEqual([{ id: 99, ok: true, result: { stray: true } }]);
  });

  it("partial chunks are reassembled into complete lines (fake socket chunkSize)", async () => {
    const fake = new FakeSocket({
      chunkSize: 7, // every server write arrives split into 7-char pieces
      replies: [JSON.stringify({ id: 1, ok: true, result: { document: 0 } })],
    });
    const transport = new JsonLinesTransport(fake);
    await expect(transport.call("doc.new", {})).resolves.toEqual({ document: 0 });
  });

  it("a server that never completes a line leaves the call pending until the socket dies", async () => {
    const fake = new FakeSocket({ omitNewline: true, replies: [JSON.stringify({ id: 1, ok: true, result: {} })] });
    const transport = new JsonLinesTransport(fake);
    const call = transport.call("doc.new", {});
    const expectation = expect(call).rejects.toMatchObject({ code: "connection_closed" });
    fake.destroy();
    await expectation;
  });

  it("socket destruction mid-call rejects pending calls with connection_closed", async () => {
    const fake = new FakeSocket({ replies: [() => null] });
    const transport = new JsonLinesTransport(fake);
    const call = transport.call("doc.render", { maxSide: 0 });
    const expectation = expect(call).rejects.toMatchObject({ code: "connection_closed" });
    fake.destroy(new Error("ECONNRESET"));
    await expectation;
  });

  it("a malformed server line is a protocol violation: pending calls fail, never throw raw", async () => {
    const fake = new FakeSocket({ replies: [() => null] });
    const transport = new JsonLinesTransport(fake);
    const call = transport.call("doc.new", {});
    const expectation = expect(call).rejects.toMatchObject({ code: "protocol_violation" });
    fake.sendLine("not json\n");
    await expectation;
    expect(transport.malformedLines).toEqual(["not json"]);
  });

  it("client-side request budget: a frame over 1 MiB is refused before it is written", async () => {
    const fake = new FakeSocket({ replies: [] });
    const transport = new JsonLinesTransport(fake);
    const oversized = "x".repeat(MAX_REQUEST_BYTES + 64);
    await expect(transport.call("engine.execute", { command: "edit.fill", params: { color: oversized } })).rejects.toMatchObject(
      { code: "budget_exceeded" },
    );
    expect(fake.written).toHaveLength(0); // the server would close the connection; never send it
  });

  it("client-side batch guard: more than 256 steps is refused before writing (security.rs)", async () => {
    const fake = new FakeSocket({ replies: [] });
    const transport = new JsonLinesTransport(fake);
    const steps = Array.from({ length: MAX_BATCH_STEPS + 1 }, () => ({ command: "edit.undo" }));
    await expect(transport.batch(steps)).rejects.toMatchObject({
      code: "budget_exceeded",
      message: `batch contains ${MAX_BATCH_STEPS + 1} steps; maximum is ${MAX_BATCH_STEPS}`,
    });
    expect(fake.written).toHaveLength(0);

    // The boundary itself is sent: exactly 256 steps is a valid request.
    const fakeBoundary = new FakeSocket({
      replies: [JSON.stringify({ id: 1, ok: true, result: { completed: 0, failed: 0, results: [] } })],
    });
    const boundaryTransport = new JsonLinesTransport(fakeBoundary);
    await expect(boundaryTransport.batch(Array.from({ length: MAX_BATCH_STEPS }, () => ({ command: "edit.undo" })))).resolves.toEqual(
      { completed: 0, failed: 0, results: [] },
    );
  });

  it("client-side reply budget: a reply line over the 8 MiB ceiling fails pending calls", async () => {
    const fake = new FakeSocket({ replies: [() => null] });
    const transport = new JsonLinesTransport(fake, { maxReplyBytes: 128 });
    const call = transport.call("engine.commands", {});
    const expectation = expect(call).rejects.toMatchObject({ code: "protocol_violation" });
    fake.sendLine(`${"x".repeat(129)}\n`);
    await expectation;
  });
});

// ---------------------------------------------------------------------------
// 3. Real EngineClient (src/index.ts — W2-D) against the same fixtures
// ---------------------------------------------------------------------------

/**
 * Load src/index.ts if it exists. The specifier is assembled at runtime so `tsc` does not
 * fail on the missing module while W2-D authors it (verbatimModuleSyntax-friendly).
 */
async function tryLoadClientModule(): Promise<unknown> {
  try {
    return await import("../src/index" + ".js");
  } catch {
    return null;
  }
}

const clientModule: unknown = await tryLoadClientModule();

/** The client seam this suite pins (the W2-D/W2-E contract): */
/*   export class EngineClient { constructor(options: { connect: () => socket }) }        */
/*   client.call(method, params) → Promise resolving the reply's `result` (or an          */
/*   {ok:true,result} envelope), surfacing ok:false replies as a rejection carrying the    */
/*   engine's error text (or as an {ok:false,…} result value — either is accepted).       */
const RECONCILE =
  "W2-D/W2-E contract drift: src/index.ts exists but does not match the pinned client seam. " +
  "Expected: `new EngineClient({ connect: () => socket })` with `call(method, params)` " +
  "(see tests/contract.test.ts header). Update src/index.ts or this block in one commit.";

interface ClientLike {
  call(method: string, params?: unknown): Promise<unknown>;
  close?: () => void;
}

function newClient(socket: FakeSocket): ClientLike {
  const module = clientModule as Record<string, unknown>;
  const candidate = module.EngineClient ?? module.default;
  if (typeof candidate !== "function") {
    throw new Error(RECONCILE);
  }
  const ctor = candidate as new (options: { connect: () => FakeSocket }) => unknown;
  let instance: unknown;
  try {
    instance = new ctor({ connect: () => socket });
  } catch (error) {
    throw new Error(`${RECONCILE} (constructor failed: ${String(error)})`);
  }
  const call = (instance as Record<string, unknown>).call;
  if (typeof call !== "function") {
    throw new Error(`${RECONCILE} (no call(method, params) on the instance)`);
  }
  return instance as ClientLike;
}

/** Accept either a raw `result` value or a whole `{ok, result|error}` envelope. */
function unwrapClientValue(value: unknown): unknown {
  if (value !== null && typeof value === "object" && "ok" in value) {
    const envelope = value as Record<string, unknown>;
    if (envelope.ok === true && "result" in envelope) {
      return envelope.result;
    }
  }
  return value;
}

describe.skipIf(clientModule === null)(
  "EngineClient (src/index.ts, W2-D) replays the recorded fixtures via FakeSocket",
  () => {
    it("auth + doc.new round-trip; engine errors surface to the caller (§1.5-4)", async () => {
      const authOk = await loadReply("auth-ok");
      const docNew = await loadReply("doc-new");
      const unknownMethod = await loadReply("error-unknown-method");

      // Id-echo scripting: robust to any client id scheme and to auto-auth clients,
      // while replaying the exact recorded result/error shapes.
      const scriptedShapes = new Map<string, Record<string, unknown>>([
        ["auth", authOk.reply],
        ["doc.new", docNew.reply],
        ["nope", unknownMethod.reply],
      ]);
      const script = (frame: Record<string, unknown>): string => {
        const shape = scriptedShapes.get(String(frame.method)) ?? unknownMethod.reply;
        return JSON.stringify({ ...shape, id: frame.id });
      };
      const fake = new FakeSocket({ replies: [script, script, script, script, script, script] });

      const client = newClient(fake);
      try {
        const created = unwrapClientValue(await client.call("doc.new", docNew.request.params));
        expect(created).toEqual(docNew.reply.result); // {document: 0}

        let rejected: Error | undefined;
        let resolved: unknown;
        try {
          resolved = await client.call("nope", {});
        } catch (error) {
          rejected = error as Error;
        }
        const surfaced =
          rejected !== undefined
            ? String((rejected as { message?: unknown }).message ?? rejected)
            : JSON.stringify(unwrapClientValue(resolved));
        expect(surfaced).toContain("unknown method `nope`");
      } finally {
        client.close?.();
      }

      expect(fake.written.length).toBeGreaterThanOrEqual(2);
      const first = fake.writtenFrames[0];
      // The TCP rule: whatever the client sends first, the recorded corpus drives it.
      expect(first?.$unparsable).toBeUndefined();
    });
  },
);
