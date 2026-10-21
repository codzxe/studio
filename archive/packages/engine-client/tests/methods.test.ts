// @studio/engine-client — W2-C method builder + envelope tests.
//
// Every fixture below is copied from the protocol sources, not invented:
//   - vendor/photocraft/crates/automation/src/rpc.rs (requests, replies, results, errors)
//   - vendor/photocraft/docs/control-protocol.md (envelope, command-list rows, jobs)
//   - crates/engine/src/{commands,file_cmds,inspect,jobs}.rs and
//     crates/automation/src/headless.rs (result keys)
// Pure in-process: no sockets, no real timers (waitForJob tests inject sleep/now).

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DOCUMENT_INSPECT_SCHEMA,
  DOC_NEW_RESULT,
  DOC_OPEN_RESULT,
  DOC_PLACE_RESULT,
  type DocSelectInput,
  SESSION_LIST_SCHEMA,
  docClose,
  docInspect,
  docNew,
  docOpen,
  docPlace,
  docSelect,
  sessionList,
} from "../src/methods/document.js";
import {
  BACKGROUND_EXECUTE_RESULT,
  BATCH_RESULT,
  COMMAND_LIST_RESULT,
  JOBS_CANCEL_RESULT,
  JOBS_LIST_RESULT,
  METHODS_RESULT,
  agentBegin,
  agentCommit,
  agentRollback,
  batch,
  engineCommands,
  engineExecute,
  engineExecuteBackground,
  isJobPending,
  isTerminalJob,
  jobsCancel,
  jobsList,
  methodsCall,
  transactionalBatch,
  waitForJob,
} from "../src/methods/engine-commands.js";
import {
  type DocExportLayersInput,
  EXPORT_RESULT,
  IMPORT_DATA_SETS_RESULT,
  docExportDataSets,
  docExportLayers,
  docImportDataSets,
} from "../src/methods/export-data.js";
import type { MethodCall, ReplyOutcome, WireSender } from "../src/methods/protocol.js";
import {
  type BuiltMethodCall,
  JOB_METHODS,
  MAX_BATCH_STEPS,
  MAX_PNG_BYTES,
  MAX_PREVIEW_SIDE,
  PROTOCOL_METHODS,
  SERVED_METHODS,
  isNotRunTimeout,
  isReplyTimeout,
  parseCallReply,
  parseEngineReply,
} from "../src/methods/protocol.js";
import {
  DOC_SAVE_RESULT,
  RENDER_RESULT,
  clampPreviewMaxSide,
  docRender,
  docSave,
  pngWithinBudget,
} from "../src/methods/render-save.js";

// -- helpers -----------------------------------------------------------------

function expectCall<TParams, TResult>(
  built: BuiltMethodCall<TParams, TResult>,
): MethodCall<TParams, TResult> {
  if (!built.ok) {
    throw new Error(`builder failed unexpectedly: ${built.code}: ${built.message}`);
  }
  return built;
}

function expectFailure<TParams, TResult>(
  built: BuiltMethodCall<TParams, TResult>,
): { code: string; message: string } {
  if (built.ok) {
    throw new Error("expected a typed failure, got a call");
  }
  return { code: built.code, message: built.message };
}

function expectParsed<T>(outcome: ReplyOutcome<T>): T {
  if (!outcome.ok) {
    throw new Error(`parse failed: ${outcome.error}`);
  }
  return outcome.result;
}

/** A WireSender that replays fixed replies and records the frames it was asked to send. */
function queueSender(replies: readonly unknown[]) {
  let sent = 0;
  const calls: { method: string; params: unknown }[] = [];
  const send: WireSender = async (request) => {
    calls.push({ method: request.method, params: request.params });
    const reply = replies[Math.min(sent, replies.length - 1)];
    sent += 1;
    if (reply === undefined) {
      throw new Error("queueSender: fixture exhausted");
    }
    return reply;
  };
  return { send, calls };
}

const fakeClock = (stepMs: number) => {
  let clock = 0;
  const sleeps: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleeps.push(ms);
    clock += stepMs;
  };
  return { now: () => clock, sleep, sleeps };
};

const noSleep = async (): Promise<void> => {};

/** Compile-time-legal holder for values the schemas must reject at runtime. */
const asInvalid = (value: unknown): never => value as never;

// -- fixtures (copied from rpc.rs / control-protocol.md) -----------------------

/** rpc.rs `METHODS`, registry order. */
const METHODS_FIXTURE = [
  "engine.execute",
  "jobs.list",
  "jobs.cancel",
  "engine.commands",
  "session.list",
  "doc.open",
  "doc.place",
  "doc.new",
  "doc.save",
  "doc.exportLayers",
  "doc.exportDataSets",
  "doc.importDataSets",
  "doc.inspect",
  "doc.render",
  "doc.select",
  "doc.close",
  "batch",
  "methods",
] as const;

/** rpc.rs command-list test: the `file.new` row — exactly these keys (+ optional keywords). */
const FILE_NEW_ROW = {
  id: "file.new",
  label: "New…",
  menu: ["File"],
  shortcut: "Cmd+N",
  params:
    '{"width":1..300000=1920,"height":1..300000=1080,"mode":"rgb|gray|grayscale|cmyk|lab"="rgb"}',
  enabled: true,
  disabledReason: null,
  needsDocument: false,
};

const SESSION_FIXTURE = {
  active: 0,
  documents: [
    { index: 0, name: "Untitled", path: null, width: 64, height: 48, dirty: false, revision: 3 },
  ],
  foreground: "#000000",
  background: "#ffffff",
};

const INSPECT_FIXTURE = {
  name: "Untitled",
  path: null,
  width: 64,
  height: 48,
  mode: "Rgb",
  depth: 8,
  resolution: 72,
  activeLayer: 3,
  selectedLayers: [3],
  isolatedLayers: [],
  hasSelection: false,
  selectionBounds: null,
  // Layer rows stay opaque to the builder layer (shallow validation by design).
  layers: [{ id: 3, name: "Ink", kind: "pixel", visible: true, bounds: [0, 0, 64, 48] }],
  history: ["New Document", "Gaussian Blur"],
  snapshots: [{ id: 1, name: "Snapshot 1" }],
  canUndo: true,
  canRedo: false,
  revision: 3,
  quickMask: false,
};

const RUNNING_JOB = {
  id: 7,
  command: "filter.blur.gaussianBlur",
  label: "Gaussian Blur",
  document: 0,
  state: "running",
  progress: 0.25,
  message: "",
  elapsedMs: 1.5,
} as const;

const DONE_JOB = { ...RUNNING_JOB, state: "done", progress: 1, result: { filter: {} } } as const;

// -- method name constants ------------------------------------------------------

describe("method name constants", () => {
  it("SERVED_METHODS matches rpc.rs `METHODS` order exactly", () => {
    expect([...SERVED_METHODS]).toEqual([...METHODS_FIXTURE]);
  });

  it("PROTOCOL_METHODS covers the Appendix B surface and nothing un-served", () => {
    const names = Object.values(PROTOCOL_METHODS);
    expect(names).toHaveLength(16);
    for (const name of names) {
      expect((SERVED_METHODS as readonly string[]).includes(name)).toBe(true);
    }
  });

  it("JOB_METHODS are the §Background jobs methods", () => {
    expect(JOB_METHODS).toEqual({ jobsList: "jobs.list", jobsCancel: "jobs.cancel" });
  });
});

// -- request builders: exact method names + params ------------------------------

describe("request builders", () => {
  it("doc.open sends exactly {path} (rpc.rs fixture: doc.open in.jpg)", () => {
    const call = expectCall(docOpen({ path: "in.jpg" }));
    expect(call.method).toBe("doc.open");
    expect(call.params).toEqual({ path: "in.jpg" });
  });

  it("doc.new passes file.new params through, untouched", () => {
    expect(expectCall(docNew({ width: 8, height: 8 })).params).toEqual({ width: 8, height: 8 });
    expect(expectCall(docNew({ width: 64, height: 32, background: "white" })).params).toEqual({
      width: 64,
      height: 32,
      background: "white",
    });
    const full = expectCall(
      docNew({
        width: 1920,
        height: 1080,
        mode: "rgb",
        depth: 16,
        background: "#ff8800",
        backgroundColor: [1, 0, 0],
        resolution: 300,
        name: "Poster",
      }),
    );
    expect(full.method).toBe("doc.new");
    expect(full.params).toEqual({
      width: 1920,
      height: 1080,
      mode: "rgb",
      depth: 16,
      background: "#ff8800",
      backgroundColor: [1, 0, 0],
      resolution: 300,
      name: "Poster",
    });
  });

  it("doc.new without input sends {} — the engine applies the file.new defaults", () => {
    const call = expectCall(docNew());
    expect(call.params).toEqual({});
  });

  it("doc.place sends the read-root path plus the command's own options", () => {
    const call = expectCall(docPlace({ path: "logo.png", scale: 50 }));
    expect(call.method).toBe("doc.place");
    expect(call.params).toEqual({ path: "logo.png", scale: 50 });
    expect(
      expectCall(docPlace({ path: "logo.png", fit: true, center: [10, 20], index: 1 })).params,
    ).toEqual({
      path: "logo.png",
      fit: true,
      center: [10, 20],
      index: 1,
    });
  });

  it("doc.select requires an index; doc.close and doc.inspect take an optional one", () => {
    expect(expectCall(docSelect({ index: 0 })).method).toBe("doc.select");
    expect(expectCall(docSelect({ index: 0 })).params).toEqual({ index: 0 });
    expect(expectCall(docClose()).params).toEqual({});
    expect(expectCall(docClose({ index: 0 })).params).toEqual({ index: 0 });
    expect(expectCall(docInspect()).params).toEqual({});
    expect(expectCall(docInspect({ index: 1 })).params).toEqual({ index: 1 });
    expect(expectCall(sessionList()).method).toBe("session.list");
    expect(expectCall(sessionList()).params).toEqual({});
  });

  it("doc.save sends the write-root path and the format options (rpc.rs fixture: out.png)", () => {
    expect(expectCall(docSave({ path: "out.png" })).params).toEqual({ path: "out.png" });
    const full = expectCall(
      docSave({
        path: "card.pcraft",
        format: "pcraft",
        quality: 90,
        index: 0,
        tiffLayers: true,
        tgaBits: 32,
        ddsCompression: "bc3",
        ddsMipmaps: true,
        dpxBits: 10,
      }),
    );
    expect(full.method).toBe("doc.save");
    expect(full.params).toEqual({
      path: "card.pcraft",
      format: "pcraft",
      quality: 90,
      index: 0,
      tiffLayers: true,
      tgaBits: 32,
      ddsCompression: "bc3",
      ddsMipmaps: true,
      dpxBits: 10,
    });
  });

  it("doc.render sends index/maxSide/path exactly (rpc.rs fixture: maxSide 10)", () => {
    expect(expectCall(docRender({ maxSide: 10 })).params).toEqual({ maxSide: 10 });
    expect(expectCall(docRender({ maxSide: 0 })).params).toEqual({ maxSide: 0 });
    expect(expectCall(docRender({ path: "r.png", maxSide: 32, index: 2 })).params).toEqual({
      path: "r.png",
      maxSide: 32,
      index: 2,
    });
    expect(expectCall(docRender()).params).toEqual({});
  });

  it("engine.execute sends {command, params, wait} and defaults to waiting", () => {
    const call = expectCall(engineExecute({ command: "layer.new.layer", params: { name: "Ink" } }));
    expect(call.method).toBe("engine.execute");
    expect(call.params).toEqual({ command: "layer.new.layer", params: { name: "Ink" } });
    expect(
      expectCall(engineExecute({ command: "filter.blur.gaussianBlur", params: { radius: 3 } }))
        .params,
    ).toEqual({
      command: "filter.blur.gaussianBlur",
      params: { radius: 3 },
    });
    expect(expectCall(engineExecute({ command: "command.list", params: null })).params).toEqual({
      command: "command.list",
      params: null,
    });
    expect(expectCall(engineExecute({ command: "edit.undo" })).params).toEqual({
      command: "edit.undo",
    });
  });

  it("engine.execute with wait:false flags the background start (rpc.rs fixture)", () => {
    const call = expectCall(
      engineExecuteBackground({ command: "filter.blur.gaussianBlur", params: { radius: 40 } }),
    );
    expect(call.params).toEqual({
      command: "filter.blur.gaussianBlur",
      params: { radius: 40 },
      wait: false,
    });
  });

  it("engine.commands sends {} or {filter} (rpc.rs fixture: filter blur)", () => {
    expect(expectCall(engineCommands()).method).toBe("engine.commands");
    expect(expectCall(engineCommands()).params).toEqual({});
    expect(expectCall(engineCommands({ filter: "blur" })).params).toEqual({ filter: "blur" });
  });

  it("jobs and methods builders send the exact minimal params", () => {
    expect(expectCall(jobsList()).method).toBe("jobs.list");
    expect(expectCall(jobsList()).params).toEqual({});
    expect(expectCall(jobsCancel({ job: 7 })).method).toBe("jobs.cancel");
    expect(expectCall(jobsCancel({ job: 7 })).params).toEqual({ job: 7 });
    expect(expectCall(jobsCancel()).params).toEqual({});
    expect(expectCall(methodsCall()).method).toBe("methods");
    expect(expectCall(methodsCall()).params).toEqual({});
  });

  it("export/import builders send the capability-root params (rpc.rs fixtures)", () => {
    expect(
      expectCall(docExportLayers({ dir: "out", format: "png", prefix: "card" })).params,
    ).toEqual({
      dir: "out",
      format: "png",
      prefix: "card",
    });
    const dataSets = expectCall(
      docExportDataSets({ dir: "sets", format: "png", dataSets: ["one"], naming: "{index}" }),
    );
    expect(dataSets.method).toBe("doc.exportDataSets");
    expect(dataSets.params).toEqual({
      dir: "sets",
      format: "png",
      dataSets: ["one"],
      naming: "{index}",
    });
    expect(expectCall(docImportDataSets({ path: "sets.csv" })).params).toEqual({
      path: "sets.csv",
    });
    expect(expectCall(docImportDataSets({ path: "sets.csv", delimiter: ";" })).params).toEqual({
      path: "sets.csv",
      delimiter: ";",
    });
  });
});

// -- batch ----------------------------------------------------------------------

describe("batch builders", () => {
  /** rpc.rs batch test steps, verbatim. */
  const STEPS = [
    { command: "layer.new.layer", params: { name: "A" } },
    { command: "no.such.command" },
    { command: "layer.new.layer", params: { name: "B" } },
    { method: "doc.inspect" },
  ];

  it("sends the steps verbatim; stopOnError is omitted (engine default true)", () => {
    const call = expectCall(batch({ steps: STEPS }));
    expect(call.method).toBe("batch");
    expect(call.params).toEqual({ steps: STEPS });
  });

  it("forwards an explicit stopOnError: false (rpc.rs fixture)", () => {
    expect(expectCall(batch({ steps: STEPS, stopOnError: false })).params).toEqual({
      steps: STEPS,
      stopOnError: false,
    });
  });

  it("keeps a command step's wait: false (rpc.rs fixture: background batch step)", () => {
    const call = batch({
      steps: [
        { command: "layer.new.layer" },
        { command: "edit.fill", params: { color: "#808080" } },
        { command: "filter.blur.gaussianBlur", params: { radius: 40 }, wait: false },
      ],
    });
    expect(expectCall(call).params).toEqual({
      steps: [
        { command: "layer.new.layer" },
        { command: "edit.fill", params: { color: "#808080" } },
        { command: "filter.blur.gaussianBlur", params: { radius: 40 }, wait: false },
      ],
    });
  });

  it("accepts at most 256 steps (rpc.rs: maximum is 256)", () => {
    const steps = Array.from({ length: MAX_BATCH_STEPS }, () => ({ command: "command.list" }));
    expect(expectCall(batch({ steps })).params.steps).toHaveLength(MAX_BATCH_STEPS);
    const tooMany = Array.from({ length: MAX_BATCH_STEPS + 1 }, () => ({
      command: "command.list",
    }));
    const failure = expectFailure(batch({ steps: tooMany }));
    expect(failure.code).toBe("engine_limit");
    expect(failure.message).toBe(
      `batch contains ${MAX_BATCH_STEPS + 1} steps; maximum is ${MAX_BATCH_STEPS}`,
    );
  });

  it("refuses a nested batch method step, as the engine does", () => {
    const failure = expectFailure(batch({ steps: [{ method: "batch" }] }));
    expect(failure.code).toBe("invalid_params");
    expect(failure.message).toContain("nested");
  });

  it("rejects ambiguous and empty steps client-side", () => {
    const both = { command: "edit.undo", method: "doc.inspect" };
    const failure = expectFailure(batch({ steps: [both] }));
    expect(failure.code).toBe("invalid_params");
    expect(failure.message).toContain("not both");
    const neither = { params: {} } as unknown as { command: string };
    const failure2 = expectFailure(batch({ steps: [neither] }));
    expect(failure2.code).toBe("invalid_params");
    expect(failure2.message).toContain("needs `command` or `method`");
  });

  it("rejects unknown method steps before dispatch", () => {
    const failure = expectFailure(batch({ steps: [{ method: "doc.nope" }] }));
    expect(failure.code).toBe("invalid_params");
    expect(failure.message).toContain("unknown method `doc.nope`");
  });

  it("rejects a non-array steps value without throwing (untyped callers)", () => {
    const badInput = { steps: undefined } as unknown as { steps: readonly [] };
    const failure = expectFailure(batch(badInput));
    expect(failure.code).toBe("invalid_params");
    expect(failure.message).toContain("`steps` must be an array");
  });

  it("rejects `wait` on a method step (rpc.rs reads it for command steps only)", () => {
    const sneaky = { method: "doc.inspect", wait: false };
    const failure = expectFailure(batch({ steps: [sneaky] }));
    expect(failure.code).toBe("invalid_params");
  });
});

describe("transactional batches (§5.6)", () => {
  it("wraps the steps in agent.begin/agent.commit and forces stop-on-error", () => {
    const call = expectCall(
      transactionalBatch({
        name: "run-42",
        steps: [{ command: "layer.new.layer", params: { name: "A" } }],
      }),
    );
    expect(call.method).toBe("batch");
    expect(call.params).toEqual({
      steps: [
        { command: "agent.begin", params: { name: "run-42" } },
        { command: "layer.new.layer", params: { name: "A" } },
        { command: "agent.commit" },
      ],
    });
    expect("stopOnError" in call.params).toBe(false);
  });

  it("reserves two step slots for begin/commit", () => {
    const limit = MAX_BATCH_STEPS - 2;
    const fits = Array.from({ length: limit }, () => ({ command: "edit.undo" }));
    expect(expectCall(transactionalBatch({ name: "x", steps: fits })).params.steps).toHaveLength(
      MAX_BATCH_STEPS,
    );
    const failure = expectFailure(
      transactionalBatch({
        name: "x",
        steps: Array.from({ length: limit + 1 }, () => ({ command: "edit.undo" })),
      }),
    );
    expect(failure.code).toBe("engine_limit");
  });

  it("refuses stopOnError: false — the caller rolls back instead of continuing", () => {
    const failure = expectFailure(transactionalBatch({ name: "x", steps: [], stopOnError: false }));
    expect(failure.code).toBe("invalid_params");
    expect(failure.message).toContain("agent.rollback");
  });

  it("requires a non-empty checkpoint name", () => {
    expect(expectFailure(transactionalBatch({ name: "", steps: [] })).code).toBe("invalid_params");
    expect(expectFailure(transactionalBatch({ name: "   ", steps: [] })).code).toBe(
      "invalid_params",
    );
  });

  it("exposes the §5.6 transaction commands as engine.execute calls", () => {
    expect(expectCall(agentBegin("run-42")).params).toEqual({
      command: "agent.begin",
      params: { name: "run-42" },
    });
    expect(expectCall(agentCommit()).params).toEqual({ command: "agent.commit" });
    expect(expectCall(agentRollback()).params).toEqual({ command: "agent.rollback" });
  });
});

// -- builder validation ----------------------------------------------------------

describe("builder validation (fail fast, typed envelopes)", () => {
  it("doc.select rejects a missing index (rpc.rs: doc.select needs `index`)", () => {
    const missing = {} as unknown as DocSelectInput;
    const failure = expectFailure(docSelect(missing));
    expect(failure.code).toBe("invalid_params");
    expect(failure.message).toContain("doc.select");
  });

  it('rejects the rpc.rs invalid-index table: "0", -1, 0.5, true', () => {
    for (const bad of ["0", -1, 0.5, true] as unknown[]) {
      expect(expectFailure(docSelect({ index: bad as number })).code).toBe("invalid_params");
      expect(expectFailure(docInspect({ index: bad as number })).code).toBe("invalid_params");
      expect(expectFailure(docClose({ index: bad as number })).code).toBe("invalid_params");
    }
  });

  it("doc.place and doc.open refuse parent traversal (rpc.rs: ../outside/logo.png)", () => {
    const place = expectFailure(docPlace({ path: "../outside/logo.png" }));
    expect(place.message).toContain("read root");
    expect(expectFailure(docPlace({ path: "" })).code).toBe("invalid_params");
    expect(expectFailure(docOpen({ path: "../outside/logo.png" })).code).toBe("invalid_params");
  });

  it("doc.save and doc.render refuse parent traversal under the write root", () => {
    expect(expectFailure(docSave({ path: "../escaped/x.png" })).code).toBe("invalid_params");
    expect(expectFailure(docRender({ path: "../escaped/x.png" })).code).toBe("invalid_params");
  });

  it("engine.execute rejects non-object params (control-protocol.md §Methods)", () => {
    for (const bad of [[1], "abc", 5, true] as unknown[]) {
      const failure = expectFailure(
        engineExecute({ command: "edit.fill", params: bad as Record<string, unknown> }),
      );
      expect(failure.code).toBe("invalid_params");
      expect(failure.message).toContain("engine.execute");
    }
    expect(expectFailure(engineExecute({ command: "" })).code).toBe("invalid_params");
  });

  it("doc.render enforces the preview ceiling the engine enforces (rpc.rs: 2049 rejected)", () => {
    expect(expectFailure(docRender({ maxSide: MAX_PREVIEW_SIDE + 1 })).code).toBe("invalid_params");
    expect(expectFailure(docRender({ maxSide: -1 })).code).toBe("invalid_params");
    expect(expectFailure(docRender({ maxSide: 1.5 })).code).toBe("invalid_params");
    expect(expectCall(docRender({ maxSide: 0 })).ok).toBe(true);
    expect(expectCall(docRender({ maxSide: 32 })).ok).toBe(true);
  });

  it("doc.save validates the codec options exactly as the engine's param checkers do", () => {
    expect(expectFailure(docSave({ quality: 0 })).code).toBe("invalid_params");
    expect(expectFailure(docSave({ quality: 101 })).code).toBe("invalid_params");
    expect(expectFailure(docSave({ quality: 90.5 })).code).toBe("invalid_params");
    expect(expectFailure(docSave({ tgaBits: asInvalid(25) })).code).toBe("invalid_params");
    expect(expectFailure(docSave({ dpxBits: asInvalid(11) })).code).toBe("invalid_params");
    expect(expectFailure(docSave({ ddsCompression: asInvalid("dxt5") })).code).toBe(
      "invalid_params",
    );
    expect(expectCall(docSave({ quality: 1 })).ok).toBe(true);
    expect(expectCall(docSave({ tgaBits: 24, dpxBits: 16, ddsCompression: "none" })).ok).toBe(true);
  });

  it("doc.new validates the background union: named, #rgb or #rrggbb", () => {
    expect(expectCall(docNew({ background: "#f80" })).ok).toBe(true);
    expect(expectCall(docNew({ background: "transparent" })).ok).toBe(true);
    expect(expectFailure(docNew({ background: "purple" })).code).toBe("invalid_params");
  });

  it("export/import builders require their root path and a non-empty delimiter", () => {
    const missing = {} as unknown as DocExportLayersInput;
    expect(expectFailure(docExportLayers(missing)).code).toBe("invalid_params");
    expect(expectFailure(docExportLayers({ dir: "../escaped" })).code).toBe("invalid_params");
    expect(expectFailure(docExportDataSets({ dir: "" })).code).toBe("invalid_params");
    expect(expectFailure(docImportDataSets({ path: "../outside.csv" })).code).toBe(
      "invalid_params",
    );
    expect(expectFailure(docImportDataSets({ path: "sets.csv", delimiter: "" })).code).toBe(
      "invalid_params",
    );
  });

  it("failures carry the house envelope shape", () => {
    const built = docSelect({ index: -1 });
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(Object.keys(built).sort()).toEqual(["code", "message", "ok"]);
      expect(built).toEqual({
        ok: false,
        code: "invalid_params",
        message: expect.stringContaining("doc.select"),
      });
    }
  });
});

// -- reply envelope parsing --------------------------------------------------------

describe("reply envelope parsing (rpc.rs `respond`)", () => {
  it("parses ok replies and runs the call's result schema", () => {
    const call = expectCall(docNew({ width: 8, height: 8 }));
    const outcome = parseCallReply(call, { id: 1, ok: true, result: { document: 0 } });
    expect(outcome).toEqual({ ok: true, result: { document: 0 } });
  });

  it("preserves engine error strings verbatim (rpc.rs: unknown method)", () => {
    const outcome = parseEngineReply(
      { id: 4, ok: false, error: "unknown method `nope` (try `methods`)" },
      DOC_NEW_RESULT,
    );
    expect(outcome).toEqual({ ok: false, error: "unknown method `nope` (try `methods`)" });
  });

  it("keeps id: null error replies (bad JSON frames, oversized lines)", () => {
    for (const error of [
      "bad JSON: expected value at line 1 column 1",
      "request exceeds 1048576 bytes",
    ]) {
      const outcome = parseEngineReply({ id: null, ok: false, error }, DOC_NEW_RESULT);
      expect(outcome).toEqual({ ok: false, error });
    }
  });

  it("fails closed on non-envelope values", () => {
    for (const reply of [
      [1, 2, 3],
      "nope",
      5,
      null,
      { ok: "yes" },
      { id: 1, ok: true, result: 1, extra: true },
    ]) {
      const outcome = parseEngineReply(reply, DOC_NEW_RESULT);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).toContain("not a protocol envelope");
      }
    }
  });

  it("turns result-schema mismatches into typed failures without echoing values", () => {
    const outcome = parseEngineReply(
      { id: 1, ok: true, result: { document: "zero" } },
      DOC_NEW_RESULT,
      "doc.new",
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("doc.new");
      expect(outcome.error).toContain("schema validation");
      expect(outcome.error).not.toContain("zero");
    }
  });

  it('accepts string request ids (rpc.rs: {"id":"a"} replies)', () => {
    const outcome = parseEngineReply({ id: "a", ok: true, result: 1 }, z.unknown());
    expect(expectParsed(outcome)).toBe(1);
  });
});

// -- result schemas: fixtures copied from the engine -------------------------------

describe("result schemas", () => {
  it("doc.new → {document: index} (commands.rs file.new)", () => {
    expect(
      expectParsed(parseEngineReply({ id: 1, ok: true, result: { document: 0 } }, DOC_NEW_RESULT)),
    ).toEqual({
      document: 0,
    });
  });

  it("doc.open → {index, name, width, height, layers, warnings} (headless.rs open)", () => {
    const fixture = {
      index: 0,
      name: "card.psd",
      width: 40,
      height: 30,
      layers: 2,
      warnings: ["adjustment layer flattened"],
    };
    expect(
      expectParsed(parseEngineReply({ id: 1, ok: true, result: fixture }, DOC_OPEN_RESULT)),
    ).toEqual(fixture);
  });

  it("doc.place → {layer, scale, bounds, smartObject} (file_cmds.rs place_bytes)", () => {
    const fixture = { layer: 1, scale: 50, bounds: [5, 3, 25, 18], smartObject: true };
    expect(
      expectParsed(parseEngineReply({ id: 1, ok: true, result: fixture }, DOC_PLACE_RESULT)),
    ).toEqual(fixture);
  });

  it("doc.save → {path, warnings} (headless.rs save)", () => {
    const fixture = { path: "out.png", warnings: [] };
    expect(
      expectParsed(parseEngineReply({ id: 1, ok: true, result: fixture }, DOC_SAVE_RESULT)),
    ).toEqual(fixture);
  });

  it("doc.render → {path, bytes} to a file, else {mime, base64} (rpc.rs)", () => {
    const toFile = { path: "render.png", bytes: 1234 };
    const inline = { mime: "image/png", base64: "iVBORw0KGgo=" };
    expect(
      expectParsed(parseEngineReply({ id: 1, ok: true, result: toFile }, RENDER_RESULT)),
    ).toEqual(toFile);
    expect(
      expectParsed(parseEngineReply({ id: 2, ok: true, result: inline }, RENDER_RESULT)),
    ).toEqual(inline);
  });

  it("session.list → {active, documents, foreground, background} (inspect.rs session)", () => {
    const result = expectParsed(
      parseEngineReply({ id: 1, ok: true, result: SESSION_FIXTURE }, SESSION_LIST_SCHEMA),
    );
    expect(result.active).toBe(0);
    expect(result.documents).toEqual(SESSION_FIXTURE.documents);
    const empty = { active: null, documents: [], foreground: "#000000", background: "#ffffff" };
    const parsedEmpty = expectParsed(
      parseEngineReply({ id: 1, ok: true, result: empty }, SESSION_LIST_SCHEMA),
    );
    expect(parsedEmpty.active).toBeNull();
  });

  it("doc.inspect → shallow document.inspect JSON (inspect.rs document)", () => {
    const result = expectParsed(
      parseEngineReply({ id: 1, ok: true, result: INSPECT_FIXTURE }, DOCUMENT_INSPECT_SCHEMA),
    );
    expect(result.name).toBe("Untitled");
    expect(result.history.at(-1)).toBe("Gaussian Blur");
    expect(result.revision).toBe(3);
    expect(result.selectedLayers).toEqual([3]);
  });

  it("engine.commands → a BARE array of pinned command rows (rpc.rs #3684)", () => {
    const rows = expectParsed(
      parseEngineReply({ id: 1, ok: true, result: [FILE_NEW_ROW] }, COMMAND_LIST_RESULT),
    );
    expect(rows).toEqual([FILE_NEW_ROW]);
    expect(Object.keys(FILE_NEW_ROW).sort()).toEqual([
      "disabledReason",
      "enabled",
      "id",
      "label",
      "menu",
      "needsDocument",
      "params",
      "shortcut",
    ]);
    // An optional `keywords` string is allowed (rpc.rs: only commands that have one).
    const withKeywords = { ...FILE_NEW_ROW, keywords: "New Document Image" };
    expect(
      expectParsed(
        parseEngineReply({ id: 1, ok: true, result: [withKeywords] }, COMMAND_LIST_RESULT),
      ),
    ).toEqual([withKeywords]);
    // The {"commands": [...]} wrapper is refused — the reply must be a bare array.
    expect(
      parseEngineReply(
        { id: 1, ok: true, result: { commands: [FILE_NEW_ROW] } },
        COMMAND_LIST_RESULT,
      ).ok,
    ).toBe(false);
  });

  it("engine.commands rows keep enabled/disabledReason/needsDocument coherent", () => {
    const disabled = {
      ...FILE_NEW_ROW,
      id: "layer.new.layer",
      enabled: false,
      disabledReason: "no document open",
      needsDocument: true,
    };
    const rows = expectParsed(
      parseEngineReply({ id: 1, ok: true, result: [disabled] }, COMMAND_LIST_RESULT),
    );
    expect(rows[0]?.enabled).toBe(false);
    expect(rows[0]?.needsDocument).toBe(true);
  });

  it("jobs.list → {jobs: [...]} with running/terminal rows (jobs.rs JobInfo)", () => {
    const result = expectParsed(
      parseEngineReply(
        { id: 1, ok: true, result: { jobs: [RUNNING_JOB, DONE_JOB] } },
        JOBS_LIST_RESULT,
      ),
    );
    expect(result.jobs).toHaveLength(2);
    expect(result.jobs.find((job) => job.state === "running")?.progress).toBe(0.25);
    expect(isTerminalJob(RUNNING_JOB)).toBe(false);
    expect(isTerminalJob(DONE_JOB)).toBe(true);
    const failed = { ...RUNNING_JOB, state: "failed", error: "filter failed" } as const;
    expect(isTerminalJob(failed)).toBe(true);
  });

  it("jobs.cancel → {cancelled} (jobs.rs)", () => {
    expect(
      expectParsed(
        parseEngineReply({ id: 1, ok: true, result: { cancelled: 1 } }, JOBS_CANCEL_RESULT),
      ),
    ).toEqual({ cancelled: 1 });
  });

  it("methods → the rpc.rs METHODS array", () => {
    const result = expectParsed(
      parseEngineReply({ id: "m", ok: true, result: METHODS_FIXTURE }, METHODS_RESULT),
    );
    expect(result).toEqual([...METHODS_FIXTURE]);
    expect(result).toContain("batch");
  });

  it("batch → {completed, failed, results} with per-step ok/err rows (rpc.rs batch)", () => {
    const fixture = {
      completed: 1,
      failed: 1,
      results: [
        { ok: true, result: { layer: 1 } },
        { ok: false, error: "unknown command `no.such.command`" },
      ],
    };
    const result = expectParsed(
      parseEngineReply({ id: 1, ok: true, result: fixture }, BATCH_RESULT),
    );
    expect(result).toEqual(fixture);
    // rpc.rs: a budget-exhausted batch ends with an error row and counts it failed.
    const budget = {
      completed: 1,
      failed: 2,
      results: [
        { ok: true, result: null },
        { ok: false, error: "unknown command `no.such.command`" },
        { ok: false, error: "batch response budget exceeded; current step may have completed" },
      ],
    };
    expect(
      expectParsed(parseEngineReply({ id: 1, ok: true, result: budget }, BATCH_RESULT)),
    ).toEqual(budget);
  });

  it("exports → {files, count}; import → {imported} (rpc.rs data-set tests)", () => {
    const exported = {
      files: ["out/card_0000_Background.png", "out/card_0001_Badge.png"],
      count: 2,
    };
    expect(
      expectParsed(parseEngineReply({ id: 1, ok: true, result: exported }, EXPORT_RESULT)),
    ).toEqual(exported);
    expect(
      expectParsed(
        parseEngineReply({ id: 2, ok: true, result: { imported: 2 } }, IMPORT_DATA_SETS_RESULT),
      ),
    ).toEqual({ imported: 2 });
  });

  it("background execute → {job, pending} or the command's own result (rpc.rs command_start)", () => {
    const pending = { job: 7, pending: true };
    expect(
      expectParsed(
        parseEngineReply({ id: 1, ok: true, result: pending }, BACKGROUND_EXECUTE_RESULT),
      ),
    ).toEqual(pending);
    expect(isJobPending(pending)).toBe(true);
    // rpc.rs Started::Done: a non-job command replies its own result even with wait:false.
    const inline = { filter: { radius: 40 } };
    expect(
      expectParsed(
        parseEngineReply({ id: 1, ok: true, result: inline }, BACKGROUND_EXECUTE_RESULT),
      ),
    ).toEqual(inline);
    expect(isJobPending(inline)).toBe(false);
  });
});

// -- preview clamps ------------------------------------------------------------

describe("preview budgets (budgets.rs ceilings)", () => {
  it("clampPreviewMaxSide caps requests at the 2048 px engine ceiling", () => {
    expect(clampPreviewMaxSide(4096)).toBe(MAX_PREVIEW_SIDE);
    expect(clampPreviewMaxSide(MAX_PREVIEW_SIDE)).toBe(MAX_PREVIEW_SIDE);
    expect(clampPreviewMaxSide(100)).toBe(100);
    expect(clampPreviewMaxSide(0)).toBe(0);
    expect(clampPreviewMaxSide(12.9)).toBe(12);
  });

  it("pngWithinBudget matches the engine's 5 MiB check", () => {
    expect(pngWithinBudget(MAX_PNG_BYTES)).toBe(true);
    expect(pngWithinBudget(MAX_PNG_BYTES + 1)).toBe(false);
    expect(pngWithinBudget(0)).toBe(true);
    expect(pngWithinBudget(-1)).toBe(false);
  });
});

// -- timeout classification ------------------------------------------------------

describe("timeout classification (control-protocol.md)", () => {
  it("both timeout variants start with `timeout`", () => {
    expect(isReplyTimeout("timeout: not run")).toBe(true);
    expect(isReplyTimeout("timeout: no reply in 60s")).toBe(true);
    expect(isReplyTimeout("unknown method `x`")).toBe(false);
  });

  it("only `timeout: not run` is safe to re-send", () => {
    expect(isNotRunTimeout("timeout: not run")).toBe(true);
    expect(isNotRunTimeout("timeout: no reply in 60s, the command may still be running")).toBe(
      false,
    );
  });
});

// -- waitForJob -------------------------------------------------------------------

describe("waitForJob (jobs.list polling, §Background jobs)", () => {
  it("polls until the job is done and returns the applied result", async () => {
    const { send, calls } = queueSender([
      { id: 1, ok: true, result: { jobs: [RUNNING_JOB] } },
      { id: 2, ok: true, result: { jobs: [DONE_JOB] } },
    ]);
    const clock = fakeClock(10);
    const outcome = await waitForJob(send, 7, { sleep: clock.sleep, now: clock.now });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.job.state).toBe("done");
      expect(outcome.job.id).toBe(7);
    }
    for (const call of calls) {
      expect(call).toEqual({ method: "jobs.list", params: {} });
    }
    expect(clock.sleeps.every((ms) => ms === 50)).toBe(true);
  });

  it("resolves failed and cancelled jobs with their error/state", async () => {
    const failedJob = { ...RUNNING_JOB, state: "failed", error: "filter failed" } as const;
    const failed = await waitForJob(
      queueSender([{ id: 1, ok: true, result: { jobs: [failedJob] } }]).send,
      7,
      {
        sleep: noSleep,
      },
    );
    expect(failed.ok).toBe(true);
    if (failed.ok) {
      expect(failed.job.state).toBe("failed");
      expect(failed.job.error).toBe("filter failed");
    }
    const cancelledJob = { ...RUNNING_JOB, state: "cancelled" } as const;
    const cancelled = await waitForJob(
      queueSender([{ id: 1, ok: true, result: { jobs: [cancelledJob] } }]).send,
      7,
      {
        sleep: noSleep,
      },
    );
    expect(cancelled.ok).toBe(true);
    if (cancelled.ok) {
      expect(cancelled.job.state).toBe("cancelled");
    }
  });

  it("surfaces engine errors as engine_error, un-retryable", async () => {
    const outcome = await waitForJob(
      queueSender([{ id: 1, ok: false, error: "no document open" }]).send,
      7,
      {
        sleep: noSleep,
      },
    );
    expect(outcome).toEqual({
      ok: false,
      code: "engine_error",
      message: "no document open",
      retryable: false,
    });
  });

  it("reports job_lost after three consecutive misses (recent-list eviction)", async () => {
    const empty = { id: 1, ok: true, result: { jobs: [] } };
    // Never seen: three consecutive misses.
    const neverSeen = queueSender([empty, empty, empty, empty]);
    const outcome = await waitForJob(neverSeen.send, 42, { sleep: noSleep });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("job_lost");
    }
    // Seen running, then gone.
    const seenThenLost = queueSender([
      { id: 1, ok: true, result: { jobs: [RUNNING_JOB] } },
      empty,
      empty,
      empty,
    ]);
    const outcome2 = await waitForJob(seenThenLost.send, 7, { sleep: noSleep });
    expect(outcome2.ok).toBe(false);
    if (!outcome2.ok) {
      expect(outcome2.code).toBe("job_lost");
    }
  });

  it("times out as retryable when the job keeps running", async () => {
    const clock = fakeClock(600);
    const outcome = await waitForJob(
      queueSender([{ id: 1, ok: true, result: { jobs: [RUNNING_JOB] } }]).send,
      7,
      {
        sleep: clock.sleep,
        now: clock.now,
        timeoutMs: 1000,
      },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("job_timeout");
      expect(outcome.retryable).toBe(true);
    }
  });

  it("honours AbortSignal before the first poll", async () => {
    const { send, calls } = queueSender([{ id: 1, ok: true, result: { jobs: [DONE_JOB] } }]);
    const controller = new AbortController();
    controller.abort();
    const outcome = await waitForJob(send, 7, { signal: controller.signal, sleep: noSleep });
    expect(outcome).toEqual({
      ok: false,
      code: "aborted",
      message: "job wait aborted by the caller",
    });
    expect(calls).toHaveLength(0);
  });

  it("rejects invalid job ids and clock options without polling", async () => {
    const { send, calls } = queueSender([]);
    const invalidId = await waitForJob(send, -1);
    expect(invalidId.ok).toBe(false);
    if (!invalidId.ok) {
      expect(invalidId.code).toBe("invalid_params");
    }
    const fractional = await waitForJob(send, 1.5);
    expect(fractional.ok).toBe(false);
    const badInterval = await waitForJob(send, 1, { intervalMs: -1 });
    expect(badInterval.ok).toBe(false);
    if (!badInterval.ok) {
      expect(badInterval.code).toBe("invalid_params");
    }
    expect(calls).toHaveLength(0);
  });
});
