// packages/agent/src/obs/logger.test.ts — W9-D: §22 correlation + §15.3 redaction.
// Deterministic: every case forces the console backend (or injects a pino
// fake) — the dynamic pino probe is never exercised by the suite.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_REDACT_KEYS,
  LOG_LEVELS,
  LoggerSetupError,
  REDACTED_MARKER,
  TRUNCATED_MARKER,
  correlationFields,
  createObsLogger,
  redactDeep,
  resolveLogLevel,
  type CorrelationBindings,
  type LogFields,
  type PinoFactory,
  type PinoLoggerLike,
  type PinoOptionsLike,
} from "./logger.js";

const NO_ENV: Record<string, string | undefined> = {};

describe("resolveLogLevel (§22 LOG_LEVEL env)", () => {
  it.each([
    ["explicit beats env", "warn", { LOG_LEVEL: "debug" }, "warn"],
    ["env wins when no explicit", undefined, { LOG_LEVEL: "warn" }, "warn"],
    ["garbage env degrades to info", undefined, { LOG_LEVEL: "bogus" }, "info"],
    ["silent is honored", undefined, { LOG_LEVEL: "silent" }, "silent"],
    ["no config at all → info", undefined, {}, "info"],
    ["all five §22 levels parse", "trace", {}, "trace"],
  ])("%s", (_name, explicit, env, expected) => {
    expect(resolveLogLevel(explicit, env)).toBe(expected);
  });

  it("LOG_LEVELS is the §22 ladder", () => {
    expect([...LOG_LEVELS]).toEqual(["trace", "debug", "info", "warn", "error", "fatal"]);
  });
});

describe("correlationFields (camelCase API → §22 snake_case wire)", () => {
  it.each([
    [
      "full chain",
      { requestId: "r1", workspaceId: "w1", runId: "run1", stepSeq: 2 },
      { request_id: "r1", workspace_id: "w1", run_id: "run1", step_seq: 2 },
    ],
    ["stepSeq 0 is kept (falsy trap)", { stepSeq: 0 }, { step_seq: 0 }],
    ["partial chain", { runId: "run1" }, { run_id: "run1" }],
    ["empty", {}, {}],
  ] as ReadonlyArray<[string, CorrelationBindings, Record<string, string | number>]>)(
    "%s",
    (_name, bindings, expected) => {
      expect(correlationFields(bindings)).toEqual(expected);
    },
  );
});

describe("redactDeep (§22 prompts, §15.3 fail-closed)", () => {
  it("redacts the default §22 keys at any depth, keeps everything else", () => {
    const input = {
      request_id: "keep-me",
      tool: "template_apply",
      prompt: "make me a poster",
      nested: { content: "inner", body: { deep: true }, safe: 7 },
      list: [{ body: "x" }, { plain: "y" }],
    };
    const out = redactDeep(input, "redacted");
    expect(out).toEqual({
      request_id: "keep-me",
      tool: "template_apply",
      prompt: REDACTED_MARKER,
      nested: { content: REDACTED_MARKER, body: REDACTED_MARKER, safe: 7 },
      list: [{ body: REDACTED_MARKER }, { plain: "y" }],
    });
  });

  it("raw mode (workspace opted in) passes through by reference", () => {
    const value = { prompt: "visible" };
    expect(redactDeep(value, "raw")).toBe(value);
  });

  it("never mutates the caller's object", () => {
    const input = { nested: { prompt: "secret" } };
    redactDeep(input, "redacted");
    expect(input.nested.prompt).toBe("secret");
  });

  it("matches keys case-insensitively and honors custom key sets", () => {
    expect(redactDeep({ PROMPT: "x" }, "redacted")).toEqual({ PROMPT: REDACTED_MARKER });
    expect(redactDeep({ brief: "x" }, "redacted", ["brief"])).toEqual({
      brief: REDACTED_MARKER,
    });
    expect(DEFAULT_REDACT_KEYS).toEqual(["prompt", "content", "body"]);
  });

  it("depth-caps so cyclic structures stay cycle-safe", () => {
    let node: Record<string, unknown> = { prompt: "secret" };
    for (let i = 0; i < 12; i += 1) {
      node = { safe: node };
    }
    const out = redactDeep(node, "redacted");
    const text = JSON.stringify(out);
    expect(text.includes(TRUNCATED_MARKER)).toBe(true);
    expect(text.includes("secret")).toBe(false);
  });
});

interface ConsoleHarness {
  readonly lines: string[];
  readonly parsed: () => Record<string, unknown>[];
}

async function makeConsoleLogger(
  options: Record<string, unknown> = {},
): Promise<ConsoleHarness & { logger: Awaited<ReturnType<typeof createObsLogger>> }> {
  const lines: string[] = [];
  const logger = await createObsLogger({
    ...(options as object),
    backend: "console",
    env: NO_ENV,
    sink: (line: string) => lines.push(line),
  } as Parameters<typeof createObsLogger>[0]);
  const parsed = (): Record<string, unknown>[] =>
    lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, lines, parsed };
}

describe("createObsLogger — console fallback backend", () => {
  it("emits JSON lines with §22 correlation + level + time", async () => {
    const { logger, parsed } = await makeConsoleLogger();
    logger.info({ tool: "template_apply" }, "step_done");
    const [line] = parsed();
    expect(line.level).toBe("info");
    expect(line.msg).toBe("step_done");
    expect(line.tool).toBe("template_apply");
    expect(typeof line.time).toBe("number");
  });

  it("msg-only call shape works (pino parity)", async () => {
    const { logger, parsed } = await makeConsoleLogger();
    logger.warn("plain message");
    expect(parsed()[0]?.msg).toBe("plain message");
    expect(parsed()[0]?.level).toBe("warn");
  });

  it("child() carries the full §22 chain and children can extend it", async () => {
    const { logger, parsed } = await makeConsoleLogger();
    const child = logger.child({ requestId: "req1", workspaceId: "ws1" });
    const step = child.child({ runId: "run1", stepSeq: 2 });
    step.info("in step");
    const [line] = parsed();
    expect(line.request_id).toBe("req1");
    expect(line.workspace_id).toBe("ws1");
    expect(line.run_id).toBe("run1");
    expect(line.step_seq).toBe(2);
  });

  it("redacts §15.3 prompt-ish fields fail-closed by default", async () => {
    const { logger, parsed } = await makeConsoleLogger();
    logger.info({ prompt: "make a poster", body: { content: "x" }, safe: 1 });
    const [line] = parsed();
    expect(line.prompt).toBe(REDACTED_MARKER);
    expect(line.body).toBe(REDACTED_MARKER);
    expect(line.safe).toBe(1);
  });

  it("raw mode (workspace opt-in) keeps prompt content", async () => {
    const { logger, parsed } = await makeConsoleLogger({ promptLogging: "raw" });
    logger.info({ prompt: "make a poster" });
    expect(parsed()[0]?.prompt).toBe("make a poster");
  });

  it("base fields ride every line and are redacted once at creation", async () => {
    const { logger, parsed } = await makeConsoleLogger({
      base: { service: "worker", prompt: "boot" },
    });
    logger.info("hello");
    const [line] = parsed();
    expect(line.service).toBe("worker");
    expect(line.prompt).toBe(REDACTED_MARKER);
  });

  it("level threshold from env LOG_LEVEL filters calls", async () => {
    const quiet = await makeConsoleLogger({ level: "warn" });
    quiet.logger.info("suppressed");
    expect(quiet.lines.length).toBe(0);
    quiet.logger.error("emitted");
    expect(quiet.parsed()[0]?.level).toBe("error");

    const fromEnv = await makeConsoleLogger({
      level: undefined,
      env: { LOG_LEVEL: "error" },
    });
    fromEnv.logger.warn("suppressed too");
    expect(fromEnv.lines.length).toBe(0);
  });

  it("silent suppresses everything", async () => {
    const { logger, lines } = await makeConsoleLogger({ level: "silent" });
    logger.fatal("nothing");
    expect(lines.length).toBe(0);
  });
});

interface CapturedPinoCall {
  readonly method: string;
  readonly fields: Record<string, unknown>;
  readonly msg: string | undefined;
}

function fakePino(): {
  readonly calls: CapturedPinoCall[];
  readonly children: Record<string, unknown>[];
  readonly seenOptions: Array<PinoOptionsLike | undefined>;
  readonly factory: PinoFactory;
} {
  const calls: CapturedPinoCall[] = [];
  const children: Record<string, unknown>[] = [];
  const seenOptions: Array<PinoOptionsLike | undefined> = [];
  const record =
    (method: string) =>
    (fields: unknown, msg?: string): void => {
      calls.push({ method, fields: fields as Record<string, unknown>, msg });
    };
  const make = (): PinoLoggerLike => ({
    child: (bindings: LogFields) => {
      children.push(bindings);
      return make();
    },
    trace: record("trace"),
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    fatal: record("fatal"),
  });
  const factory: PinoFactory = (options) => {
    seenOptions.push(options);
    return make();
  };
  return { calls, children, seenOptions, factory };
}

describe("createObsLogger — pino backend (injected factory)", () => {
  it("uses pino when resolvable via auto backend, passing level + base", async () => {
    const pino = fakePino();
    const logger = await createObsLogger({
      backend: "auto",
      pinoModule: pino.factory,
      level: "debug",
      base: { service: "worker" },
      env: NO_ENV,
    });
    expect(logger.backend).toBe("pino");
    expect(logger.level).toBe("debug");
    expect(pino.seenOptions[0]?.level).toBe("debug");
    expect(pino.seenOptions[0]?.base).toEqual({ service: "worker" });
  });

  it("still redacts in the wrapper before pino sees the fields", async () => {
    const pino = fakePino();
    const logger = await createObsLogger({
      pinoModule: pino.factory,
      env: NO_ENV,
    });
    logger.info({ prompt: "secret", safe: 2 }, "step");
    expect(pino.calls[0]?.msg).toBe("step");
    expect(pino.calls[0]?.fields.prompt).toBe(REDACTED_MARKER);
    expect(pino.calls[0]?.fields.safe).toBe(2);
  });

  it("child() binds §22 snake_case correlation ids on the pino side", async () => {
    const pino = fakePino();
    const logger = await createObsLogger({ pinoModule: pino.factory, env: NO_ENV });
    const child = logger.child({ requestId: "req1", runId: "run1" });
    expect(pino.children[0]).toEqual({ request_id: "req1", run_id: "run1" });
    child.error("boom");
    expect(pino.calls[0]?.method).toBe("error");
    expect(pino.calls[0]?.msg).toBe("boom");
  });

  it("LoggerSetupError is a typed error for the forced-unavailable case", () => {
    const error = new LoggerSetupError("pino_unavailable", "no pino");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("pino_unavailable");
  });
});
