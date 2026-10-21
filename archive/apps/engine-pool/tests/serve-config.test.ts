// serve-config — table-driven contract tests for the pure `photocraft-cli serve`
// spawn-plan builder. Everything here is pure: no fs, no network, no clocks, no
// spawning, no ambient paths — the flags were read from the vendor CLI
// (apps/photocraft-cli/src/lib.rs) and are frozen as the expectations below.

import { describe, expect, it } from "vitest";

import { isEnginePoolError } from "../src/index.js";
import {
  SCRUBBED_ENV_KEYS,
  SERVE_VALUE_FLAGS,
  TOKEN_FILE_NAME,
  buildChildEnv,
  buildServeSpawnPlan,
  isControlToken,
  isLoopbackPort,
  isSafeDirSegment,
  parseServingPort,
  redactSecrets,
  resolveSessionDirs,
} from "../src/spawners/serve-config.js";
import type { SpawnRequest } from "../src/types.js";

const TOKEN = "ab".repeat(32); // 64 lowercase hex — exactly what the pool mints (§3.2)
const ORG = "0f9c6a2e-6f70-4d3f-9a13-2d5ac4f30b91";
const SESSION = "c1b3e7d5-84d2-4c14-bcd8-c01fee4d3a60";
const CONFIG = {
  binaryPath: "/opt/engines/photocraft-cli",
  capabilityRootBase: "/srv/engine-roots",
};

const request = (overrides: Partial<SpawnRequest> = {}): SpawnRequest => ({
  sessionId: SESSION,
  organizationId: ORG,
  documentId: "doc-1",
  token: TOKEN,
  readRoot: `/srv/engine-roots/${ORG}/${SESSION}/read`,
  writeRoot: `/srv/engine-roots/${ORG}/${SESSION}/write`,
  ...overrides,
});

/** Every rejection from the builder must be a typed spawn_failed (§4 envelope). */
const expectSpawnFailed = (call: () => unknown): void => {
  try {
    call();
  } catch (error) {
    if (!isEnginePoolError(error)) {
      throw new Error(`expected EnginePoolError spawn_failed, got: ${String(error)}`);
    }
    expect(error.code).toBe("spawn_failed");
    return;
  }
  throw new Error("expected spawn_failed, but nothing was thrown");
};

describe("buildServeSpawnPlan — argv matches the lib.rs `serve` contract", () => {
  const tcpCases = [
    { name: "ephemeral loopback (port 0)", port: 0 },
    { name: "explicit loopback port", port: 51723 },
  ];

  for (const { name, port } of tcpCases) {
    it(`TCP (${name}): serve --port --control-token-file --roots`, () => {
      const plan = buildServeSpawnPlan(request({ port }), CONFIG);
      const dirs = resolveSessionDirs({
        baseDir: CONFIG.capabilityRootBase,
        organizationId: ORG,
        sessionId: SESSION,
      });
      expect(plan.args).toEqual([
        "serve",
        "--port",
        String(port),
        "--control-token-file",
        dirs.tokenFilePath,
        "--automation-read-root",
        `/srv/engine-roots/${ORG}/${SESSION}/read`,
        "--automation-write-root",
        `/srv/engine-roots/${ORG}/${SESSION}/write`,
      ]);
      expect(plan.command).toBe(CONFIG.binaryPath);
      expect(plan.transport).toBe("tcp");
      expect(plan.port).toBe(port);
    });
  }

  it("every emitted flag is one the subcommand actually takes (lib.rs:103, unknown → exit 2)", () => {
    for (const port of [0, 51723, undefined]) {
      const plan = buildServeSpawnPlan(request({ port }), CONFIG);
      const flags = plan.args.filter((arg) => arg.startsWith("--"));
      expect(flags.length).toBeGreaterThan(0);
      for (const flag of flags) {
        expect(SERVE_VALUE_FLAGS).toContain(flag);
      }
      // lib.rs:104: serve has NO bare flags — argv is pairs: odd slots flags, even values.
      for (let index = 1; index < plan.args.length; index += 2) {
        const flag = plan.args[index];
        if (flag === undefined) throw new Error("argv is not flag/value pairs");
        expect(SERVE_VALUE_FLAGS).toContain(flag);
        expect(flag.includes("=")).toBe(false); // we emit `--flag value` (lib.rs:126-129)
      }
      for (let index = 2; index < plan.args.length; index += 2) {
        const value = plan.args[index];
        if (value === undefined) throw new Error("argv has a dangling flag value");
        expect(value.startsWith("--")).toBe(false);
      }
    }
  });

  it("stdio transport (no --port): JSON lines on stdio, NO token flags (lib.rs:587-590)", () => {
    const plan = buildServeSpawnPlan(request({ port: undefined }), CONFIG);
    expect(plan.args).toEqual([
      "serve",
      "--automation-read-root",
      `/srv/engine-roots/${ORG}/${SESSION}/read`,
      "--automation-write-root",
      `/srv/engine-roots/${ORG}/${SESSION}/write`,
    ]);
    expect(plan.transport).toBe("stdio");
    expect(plan.port).toBeUndefined();
    expect(plan.args).not.toContain("--port");
    expect(plan.args).not.toContain("--control-token");
    expect(plan.args).not.toContain("--control-token-file");
  });

  it("capability roots are forwarded verbatim from the SpawnRequest (§3.2)", () => {
    const plan = buildServeSpawnPlan(
      request({ port: 0, readRoot: "/elsewhere/read", writeRoot: "/elsewhere/write" }),
      CONFIG,
    );
    expect(plan.args).toContain("/elsewhere/read");
    expect(plan.args).toContain("/elsewhere/write");
  });

  it("rejects an empty binary path, empty roots, a non-64-hex token, and bad ports (fail fast, §4)", () => {
    expectSpawnFailed(() =>
      buildServeSpawnPlan(request({ port: 0 }), { ...CONFIG, binaryPath: "" }),
    );
    expectSpawnFailed(() => buildServeSpawnPlan(request({ port: 0, readRoot: "" }), CONFIG));
    for (const token of ["short", `${TOKEN}0`, "z".repeat(64)]) {
      expectSpawnFailed(() => buildServeSpawnPlan(request({ port: 0, token }), CONFIG));
    }
    for (const port of [-1, 65536, 1.5, Number.NaN]) {
      expectSpawnFailed(() => buildServeSpawnPlan(request({ port }), CONFIG));
    }
  });
});

describe("session dirs — canonical W2-B layout (§3.2)", () => {
  it("layout: <base>/organizations/<org>/sessions/<session>/tmp/control-token", () => {
    const dirs = resolveSessionDirs({
      baseDir: "/srv/engine-roots",
      organizationId: ORG,
      sessionId: SESSION,
    });
    expect(dirs.sessionDir).toBe(`/srv/engine-roots/organizations/${ORG}/sessions/${SESSION}`);
    expect(dirs.tmpDir).toBe(`${dirs.sessionDir}/tmp`);
    expect(dirs.tokenFilePath).toBe(`${dirs.tmpDir}/${TOKEN_FILE_NAME}`);
  });

  it("base-dir trailing slashes are stripped (mirrors canonical stripTrailingSlashes)", () => {
    const dirs = resolveSessionDirs({ baseDir: "/srv//", organizationId: ORG, sessionId: SESSION });
    expect(dirs.sessionDir.startsWith("/srv/organizations/")).toBe(true);
    expect(dirs.sessionDir.includes("//srv")).toBe(false);
    // A bare "/" base joins to "//organizations/…" exactly as the canonical
    // capabilities.ts string building does (POSIX treats "//" as "/").
    const root = resolveSessionDirs({ baseDir: "/", organizationId: ORG, sessionId: SESSION });
    expect(root.sessionDir.startsWith("//organizations/")).toBe(true);
  });

  it("one tenant never lands inside another tenant's dir (§25 rule 4)", () => {
    const a = resolveSessionDirs({ baseDir: "/srv", organizationId: "org-a", sessionId: "s-1" });
    const b = resolveSessionDirs({ baseDir: "/srv", organizationId: "org-b", sessionId: "s-1" });
    expect(a.sessionDir).not.toBe(b.sessionDir);
    expect(a.sessionDir.startsWith(b.sessionDir)).toBe(false);
    expect(b.sessionDir.startsWith(a.sessionDir)).toBe(false);
  });

  it("two sessions of one org never share a dir", () => {
    const a = resolveSessionDirs({ baseDir: "/srv", organizationId: ORG, sessionId: "s-1" });
    const b = resolveSessionDirs({ baseDir: "/srv", organizationId: ORG, sessionId: "s-2" });
    expect(a.sessionDir).not.toBe(b.sessionDir);
  });

  it("traversal-shaped ids fail closed (spawn_failed, never reach argv or fs)", () => {
    const badIds = [
      "",
      ".",
      "..",
      "../escape",
      "nested/inner",
      "back\\slash",
      "nul\0byte",
      "colon:id",
      "~home",
      "trail.",
      "trail ",
      "con",
      "COM1",
    ];
    for (const id of badIds) {
      expectSpawnFailed(() =>
        resolveSessionDirs({ baseDir: "/srv", organizationId: id, sessionId: SESSION }),
      );
      expectSpawnFailed(() =>
        resolveSessionDirs({ baseDir: "/srv", organizationId: ORG, sessionId: id }),
      );
    }
    expectSpawnFailed(() =>
      resolveSessionDirs({ baseDir: "", organizationId: ORG, sessionId: SESSION }),
    );
    expectSpawnFailed(() =>
      resolveSessionDirs({ baseDir: "   ", organizationId: ORG, sessionId: SESSION }),
    );
  });

  it("isSafeDirSegment table (mirrors canonical checkTenantField, §15.1)", () => {
    for (const valid of ["org-1", "s_2", "a.b", "with space", "0f9c6a2e"]) {
      expect(isSafeDirSegment(valid)).toBe(true);
    }
    for (const invalid of [
      "",
      ".",
      "..",
      "/abs",
      "trail/",
      "a/b",
      "a\\b",
      "n\0l",
      "colon:x",
      "~tilde",
      "end.",
      "end ",
      "nul",
      "com1",
      "aux.txt",
    ]) {
      expect(isSafeDirSegment(invalid)).toBe(false);
    }
  });
});

describe("token file path safety (§15.1)", () => {
  it("lives in the session's sanctioned tmp subdir and is passed as --control-token-file", () => {
    const plan = buildServeSpawnPlan(request({ port: 0 }), CONFIG);
    expect(plan.dirs.tokenFilePath.startsWith(`${plan.dirs.tmpDir}/`)).toBe(true);
    expect(plan.dirs.tokenFilePath.startsWith(`${plan.dirs.sessionDir}/tmp/`)).toBe(true);
    expect(plan.args).toContain(plan.dirs.tokenFilePath);
    expect(plan.env.PHOTOCRAFT_CONTROL_TOKEN_FILE).toBe(plan.dirs.tokenFilePath);
  });

  it("a fresh token file per session id (token is regenerated per process, §3.2)", () => {
    const first = buildServeSpawnPlan(request({ port: 0 }), CONFIG);
    const second = buildServeSpawnPlan(request({ port: 0, sessionId: "other-session" }), CONFIG);
    expect(first.dirs.tokenFilePath).not.toBe(second.dirs.tokenFilePath);
  });
});

describe("child env — no ambient token/roots can reach the engine", () => {
  it("scrubs every PHOTOCRAFT_* token/root var from the parent AND pool extras", () => {
    for (const key of SCRUBBED_ENV_KEYS) {
      const parent = { [key]: "ambient", PATH: "/usr/bin" };
      const plan = buildServeSpawnPlan(request({ port: 0, env: { [key]: "via-extras" } }), {
        ...CONFIG,
        env: parent,
      });
      if (key === "PHOTOCRAFT_CONTROL_TOKEN_FILE") {
        // The one deliberate re-set: scrubbed, then re-pointed at OUR token file
        // (belt-and-braces with the --control-token-file flag; security.rs:312-316).
        expect(plan.env[key]).toBe(plan.dirs.tokenFilePath);
      } else {
        expect(plan.env[key]).toBeUndefined();
      }
      const fromExtras = buildChildEnv(undefined, { [key]: "via-extras" });
      expect(fromExtras[key]).toBeUndefined();
    }
  });

  it("keeps ordinary parent vars and lets pool extras override them", () => {
    const plan = buildServeSpawnPlan(request({ port: 0, env: { CRAFT_FONTS_DIR: "/fonts/w2" } }), {
      ...CONFIG,
      env: { PATH: "/usr/bin", CRAFT_FONTS_DIR: "/fonts/w1" },
    });
    expect(plan.env.PATH).toBe("/usr/bin");
    expect(plan.env.CRAFT_FONTS_DIR).toBe("/fonts/w2");
  });

  it("TCP: PHOTOCRAFT_CONTROL_TOKEN_FILE always names OUR token file (security.rs:312-316)", () => {
    const plan = buildServeSpawnPlan(request({ port: 0 }), {
      ...CONFIG,
      env: { PHOTOCRAFT_CONTROL_TOKEN_FILE: "/elsewhere/stale-token" },
    });
    expect(plan.env.PHOTOCRAFT_CONTROL_TOKEN_FILE).toBe(plan.dirs.tokenFilePath);
  });

  it("stdio: no token file var is set (the stdio transport carries no token)", () => {
    const plan = buildServeSpawnPlan(request({ port: undefined }), {
      ...CONFIG,
      env: { PHOTOCRAFT_CONTROL_TOKEN_FILE: "/elsewhere/stale-token" },
    });
    expect(plan.env.PHOTOCRAFT_CONTROL_TOKEN_FILE).toBeUndefined();
  });

  it("skips undefined parent values (process.env shape)", () => {
    expect(buildChildEnv({ FOO: undefined, BAR: "1" })).toEqual({ BAR: "1" });
    expect(buildChildEnv(undefined, undefined)).toEqual({});
  });
});

describe("readiness line — what serve prints (lib.rs:568-592)", () => {
  it("parseServingPort table", () => {
    const cases: ReadonlyArray<readonly [string, number | undefined]> = [
      ["photocraft-cli serving on 127.0.0.1:41234", 41234],
      ["photocraft-cli serving on 127.0.0.1:41234\n", 41234], // writeln!(…)
      ["photocraft-cli serving on 127.0.0.1:41234\r\n", 41234],
      ["photocraft-cli serving on 127.0.0.1:0", 0], // --port 0 binds, then reports
      ["photocraft-cli control token file: /srv/x/control-token", undefined],
      ["photocraft-cli control token: 0123abcd", undefined],
      ["photocraft-cli serving on 0.0.0.0:80", undefined], // non-loopback (rpc.rs:314-316)
      ["photocraft-cli serving on 127.0.0.1:99999", undefined], // > u16
      ["", undefined],
      ["totally unrelated stderr", undefined],
    ];
    for (const [line, expected] of cases) {
      expect(parseServingPort(line)).toBe(expected);
    }
  });

  it("isLoopbackPort table (u16; 0 = ephemeral)", () => {
    for (const valid of [0, 1, 80, 65535]) expect(isLoopbackPort(valid)).toBe(true);
    for (const invalid of [-1, 65536, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isLoopbackPort(invalid)).toBe(false);
    }
  });

  it("isControlToken table (64 hex — security.rs:92-97)", () => {
    expect(isControlToken(TOKEN)).toBe(true);
    expect(isControlToken(TOKEN.toUpperCase())).toBe(true);
    for (const invalid of ["", "short", `${TOKEN}0`, "z".repeat(64), "0".repeat(63)]) {
      expect(isControlToken(invalid)).toBe(false);
    }
  });
});

describe("diagnostics redaction (§15.1 — tokens never reach logs)", () => {
  it("redactSecrets table", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      [`token ${TOKEN} leaked`, "token [redacted] leaked"],
      [`${TOKEN}${TOKEN}`, "[redacted][redacted]"],
      ["no secrets here", "no secrets here"],
      ["", ""],
    ];
    for (const [line, expected] of cases) {
      expect(redactSecrets(line, [TOKEN])).toBe(expected);
    }
    expect(redactSecrets("irrelevant", [])).toBe("irrelevant");
    expect(redactSecrets("empty secret kept verbatim", [""])).toBe("empty secret kept verbatim");
  });
});
