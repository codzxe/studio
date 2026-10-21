// apps/worker/src/session-allocator/local-allocator.ts — the §3.2 session
// allocator for SINGLE-BOX mode (the §17.1 decision: gateway + worker + engine
// pool all run on one Lightsail box, so the worker supervises its engine
// `serve` processes directly instead of talking to a pool service).
//
// Owner: W10-M. This module is the local counterpart of the run-manager's
// session seam (apps/worker/src/run-manager/deps.ts, W6-N — `EngineSessionHandle`
// hands the loop ONE session per run; processor.ts PART 5 `SessionAllocatorLike`
// is the TODO(W9) pool-service client). The compose-boundary evolution —
// engine-pool running as its own service (§3.1 table) and this file becoming a
// thin client of the pool's HTTP/IPC interface — is documented in
// ./remote-note.md: the PUBLIC surface implemented here
// (`allocate(documentId, organizationId) → { endpoint, token, capabilities }`,
// `release()`, per-org caps, idle recycling) is designed to stay IDENTICAL, so
// the swap is one file (plus wiring), never a pipeline change.
//
// Spec anchors:
//   §3.2  one `photocraft-cli serve` process per active session; unique random
//         256-bit token regenerated per process; capability roots scoped to the
//         workspace's session directory; sessions NEVER shared across tenants;
//         plan cap of N concurrent sessions per org; lifecycle
//         `allocate → attach → run → (idle timeout) → save checkpoint → recycle`.
//   §3.4  per-session idle timeout: 15 minutes.
//   §14.1 the per-plan concurrent-session ladder (starter/pro/business =
//         1/3/6) owned by the billing limits service (PlanLimitsService,
//         packages/billing/src/limits/limits-service.ts, W9-B).
//   §15.1 the token never reaches the browser, never appears in logs; a
//         foreign org must not even learn a session exists.
//   §17.1 single-box hosting: everything on one box, no per-service tax.
//
// MIRROR NOTES (worker cannot import @studio/engine-pool — processor.ts:4-6
// and run-recovery.ts:21-24 precedent: the package manifest is owned elsewhere,
// so contracts are mirrored with a pointer to the canonical source):
//   1. serve spawn contract — canonical:
//      apps/engine-pool/src/spawners/serve-config.ts (`buildServeSpawnPlan`,
//      exported from the pool's barrel). Mirrored below for the TCP leg the
//      worker drives (`--port 0` → kernel-ephemeral loopback). Directory
//      layout is NOT mirrored: it comes from the canonical
//      `@studio/engine-client` `resolveRoot`/`sessionLayout` (W2-B), which the
//      worker already depends on. Switch the import on when a manifest owner
//      adds `@studio/engine-pool` to apps/worker.
//   2. mock-engine spawn — canonical:
//      apps/worker/tests/spine/harness.ts `spawnMockEngine` (W2-J): spawn
//      `node apps/mock-engine/src/index.mjs` with MOCK_ENGINE_PORT=0 (the
//      child announces the real ephemeral port on stderr), a 64-hex
//      MOCK_ENGINE_TOKEN, and MOCK_ENGINE_WRITE_ROOT=<session dir>.
//   3. error envelopes — canonical: apps/engine-pool/src/errors.ts
//      (`EnginePoolError` + `sessionLimitReached`/`sessionNotFound`).
//   4. binding decision — canonical: processor.ts `resolveEngineBinding`
//      (MOCK_ENGINE=1|true|yes → mock; a missing binary also downgrades to
//      mock so local dev boots without a Rust build).

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  EngineClient,
  generateControlToken,
  isControlToken,
  isSafePathComponent,
  resolveRoot,
  sessionLayout,
  type LineSocket,
} from "@studio/engine-client";
import { TRIAL_PLAN_LIMITS } from "@studio/billing";
import { PLAN_ID_SCHEMA, planLimits, type PlanId } from "@studio/config";

import type { Logger } from "../logger.js";

// ---------------------------------------------------------------------------
// PART 1 — typed errors (mirror apps/engine-pool/src/errors.ts)
// ---------------------------------------------------------------------------

export type SessionAllocatorErrorCode =
  | "engine_unavailable"
  | "session_limit_reached"
  | "session_not_found"
  | "spawn_failed"
  | "validation_failed";

export interface SessionAllocatorEnvelope {
  readonly ok: false;
  readonly code: SessionAllocatorErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly retryable?: boolean;
}

export interface SessionAllocatorErrorOptions {
  readonly hint?: string;
  readonly retryable?: boolean;
  /** Internal cause for logs; NEVER included in the wire envelope (§4). */
  readonly cause?: unknown;
}

/** The single error type thrown by this module; carries a stable machine code. */
export class SessionAllocatorError extends Error {
  readonly code: SessionAllocatorErrorCode;
  readonly hint: string | undefined;
  readonly retryable: boolean;

  constructor(
    code: SessionAllocatorErrorCode,
    message: string,
    options?: SessionAllocatorErrorOptions,
  ) {
    super(message, { cause: options?.cause });
    this.name = "SessionAllocatorError";
    this.code = code;
    this.hint = options?.hint;
    this.retryable = options?.retryable ?? false;
  }

  /** Wire shape: no stack, no cause, no internals (§4/§15.2). */
  toEnvelope(): SessionAllocatorEnvelope {
    return {
      ok: false,
      code: this.code,
      message: this.message,
      hint: this.hint,
      retryable: this.retryable,
    };
  }
}

/** §3.2 plan cap hit (mirror of engine-pool `sessionLimitReached`). */
export function sessionLimitReachedError(limit: number, active: number): SessionAllocatorError {
  return new SessionAllocatorError(
    "session_limit_reached",
    `Workspace engine-session limit reached (${active}/${limit} active)`,
    {
      hint: "Wait for an idle session to be recycled, close a document, or upgrade the plan.",
      retryable: true,
    },
  );
}

/**
 * Unknown session id — and the SAME error for cross-tenant lookups, so a
 * foreign organization can never learn that a session exists (§15.1, §25 r4;
 * mirror of engine-pool `sessionNotFound`).
 */
export function sessionNotFoundError(hint?: string): SessionAllocatorError {
  return new SessionAllocatorError("session_not_found", "Engine session not found", {
    hint: hint ?? "The session may have been recycled after its idle timeout.",
    retryable: false,
  });
}

export function spawnFailedError(cause?: unknown): SessionAllocatorError {
  return new SessionAllocatorError("spawn_failed", "Engine process failed to start", {
    hint: "The engine binary or its session directory is unavailable; retry after startup completes.",
    retryable: true,
    cause,
  });
}

export function validationFailedError(message: string, hint?: string): SessionAllocatorError {
  return new SessionAllocatorError("validation_failed", message, { hint, retryable: false });
}

export function isSessionAllocatorError(error: unknown): error is SessionAllocatorError {
  return error instanceof SessionAllocatorError;
}

/** Convert anything thrown into a safe envelope; unknown errors stay generic. */
export function toSessionAllocatorEnvelope(error: unknown): SessionAllocatorEnvelope {
  if (isSessionAllocatorError(error)) return error.toEnvelope();
  return {
    ok: false,
    code: "engine_unavailable",
    message: "Engine session operation failed",
    hint: "Retry; if the problem persists, contact support.",
    retryable: true,
  };
}

// ---------------------------------------------------------------------------
// PART 2 — the serve spawn contract (MIRROR of engine-pool's serve-config)
// ---------------------------------------------------------------------------

/**
 * Env the engine child must never inherit: token/roots could override the
 * explicit flags via serve's env fallback (security.rs:312-316) and silently
 * change the credential or capability scope. Mirror of serve-config.ts
 * `SCRUBBED_ENV_KEYS`.
 */
export const SCRUBBED_ENV_KEYS: readonly string[] = [
  "PHOTOCRAFT_CONTROL_TOKEN",
  "PHOTOCRAFT_CONTROL_TOKEN_FILE",
  "PHOTOCRAFT_AUTOMATION_READ_ROOT",
  "PHOTOCRAFT_AUTOMATION_WRITE_ROOT",
];

/**
 * Sanitized child env (mirror of serve-config.ts `buildChildEnv`): the parent
 * record minus the scrubbed keys, then the per-session extras. The result is
 * the COMPLETE env the child sees — nothing ambient.
 */
export function buildChildEnv(
  parent?: Readonly<Record<string, string | undefined>>,
  extra?: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  const write = (key: string, value: string | undefined): void => {
    if (value === undefined || SCRUBBED_ENV_KEYS.includes(key)) return;
    env[key] = value;
  };
  for (const [key, value] of Object.entries(parent ?? {})) write(key, value);
  for (const [key, value] of Object.entries(extra ?? {})) write(key, value);
  return env;
}

/**
 * The readiness line `serve` prints on stderr after the loopback bind
 * (lib.rs:582-584; with `--port 0` it reports the kernel-assigned ephemeral
 * port). Mirror of serve-config.ts `parseServingPort`.
 */
export function parseServingLine(line: string): number | undefined {
  const match = /^photocraft-cli serving on 127\.0\.0\.1:(\d{1,5})$/.exec(line.trim());
  const digits = match?.[1];
  if (digits === undefined) return undefined;
  const port = Number.parseInt(digits, 10);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : undefined;
}

/** Replace every occurrence of each secret with `[redacted]` (§15.1). */
export function redactSecrets(line: string, secrets: readonly string[]): string {
  let redacted = line;
  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.replaceAll(secret, "[redacted]");
  }
  return redacted;
}

/** What one `photocraft-cli serve` launch needs (the TCP leg only). */
export interface ServeSpawnRequest {
  /** 256-bit control token, 64 hex chars — regenerated per process (§3.2). */
  readonly token: string;
  /** Token file path (`<sessionDir>/tmp/control-token`, 0600) — never argv. */
  readonly tokenFilePath: string;
  /** Capability roots (§3.2, §15.1) — both scope the same session directory. */
  readonly readRoot: string;
  readonly writeRoot: string;
  /** Loopback port; 0 = kernel-assigned ephemeral (lib.rs:571-574). */
  readonly port?: number;
}

export interface ServeSpawnConfig {
  /** Absolute path to the `photocraft-cli` binary — env `ENGINE_BINARY_PATH`. */
  readonly binaryPath: string;
  /** Parent env for the child; sanitized by `buildChildEnv`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface ServeSpawnPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Build the exact argv for one `photocraft-cli serve` process — MIRROR of
 * engine-pool's `buildServeSpawnPlan` (apps/engine-pool/src/spawners/
 * serve-config.ts) restricted to the TCP transport the worker drives:
 * the token rides a 0600 file so `ps` never sees it
 * (control-protocol.md:340-342); roots are read from flags only
 * (lib.rs:250-252); `--port 0` asks the kernel for an ephemeral loopback port
 * which the serving line reports back. Throws a typed `spawn_failed` on
 * invalid input so failures stay at the spawn boundary. The stdio transport
 * (no `--port`, JSON lines, no token — lib.rs:587-590) is intentionally NOT
 * mirrored: single-box allocation is always TCP on loopback.
 */
export function buildServeSpawnPlan(
  request: ServeSpawnRequest,
  config: ServeSpawnConfig,
): ServeSpawnPlan {
  if (config.binaryPath.length === 0) {
    throw validationFailedError(
      "Engine binary path is empty",
      "Set ENGINE_BINARY_PATH to the pinned engine binary (§3.2).",
    );
  }
  if (!isControlToken(request.token)) {
    // serve validates this too (security.rs:92-97) and would exit 1 after
    // reading the token file; failing here keeps the error at the boundary.
    throw spawnFailedError(new Error("control token must be 64 hex characters (§3.2)"));
  }
  if (request.readRoot.length === 0 || request.writeRoot.length === 0) {
    // workspace.rs:157-158: an empty root is refused by serve (exit 1).
    throw spawnFailedError(new Error("capability roots must not be empty"));
  }
  const port = request.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw spawnFailedError(new Error(`invalid loopback port: ${String(request.port)}`));
  }
  return {
    command: config.binaryPath,
    args: [
      "serve",
      "--port",
      String(port),
      // The token lives in a 0600 file, never on the command line.
      "--control-token-file",
      request.tokenFilePath,
      "--automation-read-root",
      request.readRoot,
      "--automation-write-root",
      request.writeRoot,
    ],
    env: {
      ...buildChildEnv(config.env),
      // security.rs:312-316 env fallback — the SAME file as the flag,
      // belt-and-braces (mirror note: serve-config.ts does this too).
      PHOTOCRAFT_CONTROL_TOKEN_FILE: request.tokenFilePath,
    },
  };
}

// ---------------------------------------------------------------------------
// PART 3 — the mock-engine spawn plan (W2-J harness pattern)
// ---------------------------------------------------------------------------

/** Harness `STDERR_ANNOUNCE` (apps/worker/tests/spine/harness.ts, W2-J). */
export const MOCK_ANNOUNCE_RE = /listening on 127\.0\.0\.1:(\d+)/;

export interface MockSpawnRequest {
  readonly token: string;
  /** Capability write root — the mock's `MOCK_ENGINE_WRITE_ROOT`. */
  readonly writeRoot: string;
}

export interface MockSpawnConfig {
  /** Node executable for the child (harness uses `process.execPath`). */
  readonly nodePath: string;
  /** apps/mock-engine entry (`.mjs`), resolved by `resolveMockEngineEntry`. */
  readonly entry: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * The W2-J spine spawn pattern as a pure plan: `node apps/mock-engine/src/index.mjs`
 * with `MOCK_ENGINE_PORT=0` (ephemeral; the child announces the real port on
 * stderr), a 64-hex `MOCK_ENGINE_TOKEN`, and the session directory as the
 * mock's write root. Zero-Rust local dev and the MOCK_ENGINE=1 branch of the
 * allocator both go through here so the env contract stays pinned in tests.
 */
export function buildMockSpawnPlan(
  request: MockSpawnRequest,
  config: MockSpawnConfig,
): ServeSpawnPlan {
  if (config.entry.length === 0 || config.nodePath.length === 0) {
    throw validationFailedError(
      "Mock engine entry or node path is empty",
      "Expected the apps/mock-engine entry (MOCK_ENGINE_ENTRY) and the node executable.",
    );
  }
  if (!isControlToken(request.token)) {
    throw spawnFailedError(new Error("control token must be 64 hex characters (§3.2)"));
  }
  return {
    command: config.nodePath,
    args: [config.entry],
    env: {
      ...buildChildEnv(config.env),
      MOCK_ENGINE_PORT: "0",
      MOCK_ENGINE_TOKEN: request.token,
      MOCK_ENGINE_ROOT: request.writeRoot,
      MOCK_ENGINE_WRITE_ROOT: request.writeRoot,
    },
  };
}

/** The mock's announce line (`mock-engine: listening on 127.0.0.1:<port>`). */
export function parseMockAnnounceLine(line: string): number | undefined {
  const match = MOCK_ANNOUNCE_RE.exec(line);
  const digits = match?.[1];
  if (digits === undefined) return undefined;
  const port = Number.parseInt(digits, 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

/**
 * Default mock-engine entry: apps/mock-engine/src/index.mjs, resolved relative
 * to THIS module (apps/worker/src/session-allocator → three levels up = apps/),
 * same depth as the W2-J harness. Null when the mock is absent — callers fail
 * fast with a typed error instead of a mystery ENOENT.
 */
export function resolveMockEngineEntry(explicit?: string): string | null {
  const candidate =
    explicit !== undefined && explicit.trim().length > 0
      ? explicit
      : join(
          dirname(fileURLToPath(import.meta.url)),
          "..",
          "..",
          "..",
          "mock-engine",
          "src",
          "index.mjs",
        );
  return existsSync(candidate) ? candidate : null;
}

// ---------------------------------------------------------------------------
// PART 4 — the spawner seam (all process I/O lives behind it)
// ---------------------------------------------------------------------------

/** One supervised engine process; `stop` never rejects (best-effort escalate). */
export interface SpawnedEngineProcess {
  /** SIGTERM, escalate to SIGKILL after the grace window (§3.2 graceful drain). */
  stop(signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
  readonly pid?: number;
}

/** Everything a spawner needs; the allocator pre-resolved every path. */
export interface LocalSpawnRequest {
  readonly sessionId: string;
  readonly organizationId: string;
  readonly documentId: string;
  readonly token: string;
  readonly readRoot: string;
  readonly writeRoot: string;
  readonly sessionDir: string;
  readonly tmpDir: string;
  readonly tokenFilePath: string;
  /** Sanctioned subdirectories (assets/tmp/renders/save — W2-B layout). */
  readonly subdirs: Readonly<Record<"assets" | "tmp" | "renders" | "save", string>>;
}

/** Result of one launch: the process plus the loopback port it announced. */
export interface SpawnOutcome {
  readonly process: SpawnedEngineProcess;
  readonly port: number;
}

/** The ONLY place a real engine process can enter the allocator (tests fake it). */
export interface EngineSessionSpawner {
  /** "serve" (real binary) or "mock" (apps/mock-engine) — the branch tag. */
  readonly kind: "serve" | "mock";
  launch(request: LocalSpawnRequest): Promise<SpawnOutcome>;
}

/** Shared launcher mechanics: readiness wait + graceful stop (never rejects). */
const DEFAULT_READINESS_TIMEOUT_MS = 15_000; // harness ANNOUNCE_TIMEOUT_MS (W2-J)
const DEFAULT_STOP_GRACE_MS = 5_000; // mirror engine-pool DEFAULT_DRAIN_GRACE_MS

/** Watch stdout+stderr lines for a port; resolves on the first announcement. */
function waitForAnnouncedPort(
  child: ChildProcess,
  parse: (line: string) => number | undefined,
  timeoutMs: number,
  stderrLines: string[],
  secrets: readonly string[],
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    const finish = (port: number): void => {
      if (settled) return;
      settled = true;
      cleanup();
      clearTimeout(deadline);
      resolve(port);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      clearTimeout(deadline);
      reject(error);
    };
    const deadline = setTimeout(() => {
      fail(new Error(`engine did not announce its port within ${timeoutMs} ms`));
    }, timeoutMs);
    const scan = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          // §15.1: the token (and any secret) is redacted BEFORE buffering.
          stderrLines.push(redactSecrets(trimmed, secrets));
        }
      }
      const port = parse(text);
      if (port !== undefined) finish(port);
    };
    const onStdout = (chunk: Buffer): void => scan(chunk);
    const onStderr = (chunk: Buffer): void => scan(chunk);
    const onError = (error: Error): void => fail(error);
    const cleanup = (): void => {
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("error", onError);
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.on("error", onError);
  });
}

/** Graceful stop: signal, wait, escalate to SIGKILL, wait again, never reject. */
function stopChild(child: ChildProcess, graceMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(hardTimer);
      child.off("exit", done);
      resolve();
    };
    const killTimer = setTimeout(() => {
      // Ignored SIGTERM past the grace window (engine-pool Wave-2 escalation).
      try {
        child.kill("SIGKILL");
      } catch {
        done();
      }
    }, graceMs);
    const hardTimer = setTimeout(done, graceMs * 2);
    child.once("exit", done);
    try {
      child.kill("SIGTERM");
    } catch {
      done();
    }
  });
}

/** Buffer the child's diagnostics (already redacted) for failure hints. */
function recentLines(lines: readonly string[], count = 5): string {
  return lines
    .slice(-count)
    .map((line) => line.replaceAll(/\s+/g, " ").slice(0, 200))
    .join(" | ");
}

/** Per-session environment a real spawner adds (fonts dir stays caller-supplied). */
export interface RealSpawnerOptions {
  /** Extra env merged into every launch (e.g. CRAFT_FONTS_DIR). */
  readonly env?: Readonly<Record<string, string>>;
  /** Parent env the child inherits (sanitized); defaults to process.env. */
  readonly parentEnv?: Readonly<Record<string, string | undefined>>;
  readonly readinessTimeoutMs?: number;
  readonly stopGraceMs?: number;
}

/**
 * REAL engine spawner — `photocraft-cli serve` per the mirrored spawn contract:
 * creates the session directory layout (workspace.rs: the capability roots
 * must exist at spawn time), writes the 0600 token file itself BEFORE
 * spawning (a missing file would be auto-generated by serve with a DIFFERENT
 * token — security.rs:168-181), then waits for the serving line.
 */
export class ServeEngineSpawner implements EngineSessionSpawner {
  readonly kind = "serve" as const;
  readonly #binaryPath: string;
  readonly #parentEnv: Readonly<Record<string, string | undefined>>;
  readonly #extraEnv: Readonly<Record<string, string>>;
  readonly #readinessTimeoutMs: number;
  readonly #stopGraceMs: number;

  constructor(binaryPath: string, options: RealSpawnerOptions = {}) {
    this.#binaryPath = binaryPath;
    this.#parentEnv = options.parentEnv ?? process.env;
    this.#extraEnv = options.env ?? {};
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    this.#stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  }

  async launch(request: LocalSpawnRequest): Promise<SpawnOutcome> {
    const plan = buildServeSpawnPlan(
      {
        token: request.token,
        tokenFilePath: request.tokenFilePath,
        readRoot: request.readRoot,
        writeRoot: request.writeRoot,
        port: 0,
      },
      { binaryPath: this.#binaryPath, env: this.#parentEnv },
    );
    // The capability roots (and the token file's tmp/ parent) must exist at
    // spawn time; nothing is auto-created by the engine.
    for (const dir of [request.sessionDir, ...Object.values(request.subdirs)]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(request.tokenFilePath, request.token, "utf8");
    chmodSync(request.tokenFilePath, 0o600);
    const stderrLines: string[] = [];
    let child: ChildProcess;
    try {
      child = spawn(plan.command, plan.args, {
        env: { ...plan.env, ...this.#extraEnv },
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (error) {
      throw spawnFailedError(error);
    }
    let port: number;
    try {
      port = await waitForAnnouncedPort(
        child,
        parseServingLine,
        this.#readinessTimeoutMs,
        stderrLines,
        [request.token],
      );
    } catch (error) {
      await stopChild(child, this.#stopGraceMs);
      throw new SessionAllocatorError("spawn_failed", "Engine process did not become ready", {
        hint: "The engine binary started but never announced its loopback port.",
        retryable: true,
        cause: error,
      });
    }
    const graceMs = this.#stopGraceMs;
    return {
      port,
      process: {
        pid: child.pid,
        stop: async (signal) => {
          if (signal === "SIGKILL") {
            try {
              child.kill("SIGKILL");
            } catch {
              /* already gone */
            }
          }
          await stopChild(child, graceMs);
        },
      },
    };
  }
}

/**
 * MOCK engine spawner (MOCK_ENGINE=1 branch): one mock-engine child per
 * session via the W2-J harness pattern. The mock needs no token file — its
 * auth token arrives via MOCK_ENGINE_TOKEN.
 */
export class MockEngineSpawner implements EngineSessionSpawner {
  readonly kind = "mock" as const;
  readonly #entry: string;
  readonly #nodePath: string;
  readonly #parentEnv: Readonly<Record<string, string | undefined>>;
  readonly #extraEnv: Readonly<Record<string, string>>;
  readonly #readinessTimeoutMs: number;
  readonly #stopGraceMs: number;

  constructor(entry: string, options: RealSpawnerOptions = {}) {
    this.#entry = entry;
    this.#nodePath = process.execPath;
    this.#parentEnv = options.parentEnv ?? process.env;
    this.#extraEnv = options.env ?? {};
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    this.#stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  }

  async launch(request: LocalSpawnRequest): Promise<SpawnOutcome> {
    const plan = buildMockSpawnPlan(
      { token: request.token, writeRoot: request.sessionDir },
      { nodePath: this.#nodePath, entry: this.#entry, env: this.#parentEnv },
    );
    mkdirSync(request.sessionDir, { recursive: true });
    const stderrLines: string[] = [];
    let child: ChildProcess;
    try {
      child = spawn(plan.command, plan.args, {
        env: { ...plan.env, ...this.#extraEnv },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      throw spawnFailedError(error);
    }
    let port: number;
    try {
      port = await waitForAnnouncedPort(
        child,
        parseMockAnnounceLine,
        this.#readinessTimeoutMs,
        stderrLines,
        [request.token],
      );
    } catch (error) {
      await stopChild(child, this.#stopGraceMs);
      throw new SessionAllocatorError("spawn_failed", "Mock engine did not become ready", {
        hint: recentLines(stderrLines),
        retryable: true,
        cause: error,
      });
    }
    const graceMs = this.#stopGraceMs;
    return {
      port,
      process: {
        pid: child.pid,
        stop: async (signal) => {
          if (signal === "SIGKILL") {
            try {
              child.kill("SIGKILL");
            } catch {
              /* already gone */
            }
          }
          await stopChild(child, graceMs);
        },
      },
    };
  }
}

// ---------------------------------------------------------------------------
// PART 5 — per-org caps (the billing limits service seam, §14.1 ladder 1/3/6)
// ---------------------------------------------------------------------------

/**
 * Injected cap provider — the structural counterpart of engine-pool's
 * `PlanLimitsProvider`, returning the NUMBER the allocator enforces. The real
 * wiring adapts the billing limits service (packages/billing, W9-B).
 */
export interface SessionLimitsProvider {
  /** §3.2/§14.1: at most N concurrent engine sessions for this org's plan. */
  maxConcurrentSessions(organizationId: string): Promise<number>;
}

/** Subscription seam the default billing adapter needs (injected, no storage). */
export interface SubscriptionLookup {
  /** Active subscription for the org, or null when the org is on the trial. */
  getSubscription(organizationId: string): Promise<{ readonly planCode: string } | null>;
}

/**
 * Catalog-code aliasing — MIRROR of the billing limits service
 * (packages/billing/src/limits/limits-service.ts `PLAN_CODE_ALIASES`, W9-B):
 * the plans table seeds the top plan as 'max' while @studio/config names it
 * 'business'; both resolve to the same ladder.
 */
const PLAN_CODE_ALIASES: Readonly<Record<string, PlanId>> = { max: "business" };

/**
 * Default cap provider: the billing limits service's ladder (§14.1 —
 * starter/pro/business = 1/3/6 concurrent sessions; trials run the starter
 * ladder per packages/billing/src/limits/trial-rules.ts). Unknown plan codes
 * fail CLOSED with a typed error — a broken code must never silently grant a
 * ladder (mirrors the limits service's fail-closed resolveState).
 */
export function billingSessionLimits(lookup: SubscriptionLookup): SessionLimitsProvider {
  return {
    maxConcurrentSessions: async (organizationId: string) => {
      const subscription = await lookup.getSubscription(organizationId);
      if (subscription === null) {
        return TRIAL_PLAN_LIMITS.concurrentSessions;
      }
      const parsed = PLAN_ID_SCHEMA.safeParse(subscription.planCode);
      const plan = parsed.success ? parsed.data : PLAN_CODE_ALIASES[subscription.planCode];
      if (plan === undefined) {
        throw validationFailedError(
          "Workspace plan could not be verified",
          "The subscription plan code is not on the session ladder; allocation is refused.",
        );
      }
      return planLimits(plan).concurrentSessions;
    },
  };
}

// ---------------------------------------------------------------------------
// PART 6 — env binding (mirror of processor.ts `resolveEngineBinding`)
// ---------------------------------------------------------------------------

/** Env keys this module reads; parsed with Zod at the boundary (§4 fail-fast). */
export const LOCAL_ALLOCATOR_ENV_SCHEMA = z.object({
  MOCK_ENGINE: z.string().trim().optional(),
  ENGINE_BINARY_PATH: z.string().trim().optional(),
  ENGINE_CAPABILITY_ROOT_BASE: z.string().trim().optional(),
  MOCK_ENGINE_ENTRY: z.string().trim().optional(),
});

export type LocalAllocatorEnv = z.infer<typeof LOCAL_ALLOCATOR_ENV_SCHEMA>;

export interface LocalEngineBinding {
  readonly mode: "mock" | "serve";
  readonly reason: "mock_env" | "engine_binary_missing" | "engine_binary_present";
}

/** Explicit mock opt-in (any of "1", "true", "yes" — processor.ts parity). */
export function isMockEngineMode(env: Readonly<Record<string, string | undefined>>): boolean {
  return ["1", "true", "yes"].includes((env.MOCK_ENGINE ?? "").trim().toLowerCase());
}

/**
 * §3.2 binding decision — MIRROR of processor.ts `resolveEngineBinding`:
 * MOCK_ENGINE=1 forces the mock spawner; otherwise a MISSING engine binary
 * (unset, or not a file on disk) also falls back to the mock so local dev
 * boots without a Rust build; a present binary selects the real serve path.
 */
export function resolveLocalEngineBinding(
  env: Readonly<Record<string, string | undefined>>,
): LocalEngineBinding {
  if (isMockEngineMode(env)) {
    return { mode: "mock", reason: "mock_env" };
  }
  const binary = env.ENGINE_BINARY_PATH;
  const binaryPresent = binary !== undefined && binary.length > 0 && existsSync(binary);
  return binaryPresent
    ? { mode: "serve", reason: "engine_binary_present" }
    : { mode: "mock", reason: "engine_binary_missing" };
}

// ---------------------------------------------------------------------------
// PART 7 — the allocation descriptor (§3.2 one handle per session)
// ---------------------------------------------------------------------------

/** Capability roots + the sanctioned session layout (§3.2, §15.1). */
export interface EngineSessionCapabilities {
  /** Read capability root — the session directory (workspace.rs open_root). */
  readonly readRoot: string;
  /** Write capability root — the SAME session directory, separate scope. */
  readonly writeRoot: string;
  /** `<base>/organizations/<org>/sessions/<session>` (W2-B canonical layout). */
  readonly sessionDir: string;
  /** Absolute sanctioned subdirectories (assets/tmp/renders/save). */
  readonly subdirs: Readonly<Record<"assets" | "tmp" | "renders" | "save", string>>;
}

export type LocalSessionState = "attached" | "idle" | "draining";

/**
 * One live engine session bound to a document — the §3.2 descriptor the
 * run-manager's engine-session adapters connect `@studio/engine-client` with:
 * `new EngineClient({ auth: token, connect: () => lineSocket(port) })`.
 * `allocate(documentId, organizationId) → { endpoint, token, capabilities }`
 * is the stable shape the future pool-service client will keep returning
 * (remote-note.md).
 */
export interface EngineSessionAllocation {
  readonly sessionId: string;
  readonly organizationId: string;
  readonly documentId: string;
  /** Loopback endpoint `127.0.0.1:<port>` — the browser NEVER sees this (§3.2). */
  readonly endpoint: string;
  /** Announced loopback port (0 was requested; the child reported the real one). */
  readonly port: number;
  /** 256-bit token, 64 hex chars — fresh per process, never logged (§3.2/§15.1). */
  readonly token: string;
  readonly capabilities: EngineSessionCapabilities;
  readonly startedAt: number;
  /** Idle age is measured from this (§3.4 per-session idle). */
  readonly lastActivityAt: number;
  readonly state: LocalSessionState;
  /**
   * §3.2 idle keep-warm (run-manager deps.ts `EngineSessionHandle.release`):
   * the session stays alive for the next run and starts its idle clock; the
   * recycling sweep checkpoints + recycles it after the idle timeout.
   */
  release(): Promise<void>;
  /** Record activity; resets the idle clock (engine-pool `touch` parity). */
  touch(): void;
}

/** §22 observability events (names mirror engine-pool `PoolEvent`). */
export type LocalAllocatorEvent =
  | {
      readonly type: "session_allocated";
      readonly sessionId: string;
      readonly organizationId: string;
      readonly documentId: string;
    }
  | { readonly type: "session_idle"; readonly sessionId: string }
  | {
      readonly type: "session_checkpointed";
      readonly sessionId: string;
      readonly ok: boolean;
      readonly path?: string;
    }
  | {
      readonly type: "session_evicted";
      readonly sessionId: string;
      readonly reason: "idle_timeout" | "explicit" | "drained";
    }
  | { readonly type: "allocator_drained"; readonly evicted: number };

// ---------------------------------------------------------------------------
// PART 8 — LocalSessionAllocator
// ---------------------------------------------------------------------------

/** Idle-recycle checkpoint seam (§3.2: save checkpoint → recycle). */
export interface IdleCheckpointRequest {
  readonly sessionId: string;
  readonly organizationId: string;
  readonly documentId: string;
  readonly port: number;
  readonly token: string;
  readonly capabilities: EngineSessionCapabilities;
}

export interface IdleCheckpointOutcome {
  readonly ok: boolean;
  readonly path?: string;
}

/** Injectable so tests stay offline; default saves via @studio/engine-client. */
export type IdleCheckpointSeam = (request: IdleCheckpointRequest) => Promise<IdleCheckpointOutcome>;

export interface LocalSessionAllocatorOptions {
  /** The ONLY place a real engine process can enter (fake it in tests). */
  readonly spawner: EngineSessionSpawner;
  /** §14.1 per-org cap (billing limits service adapter). */
  readonly limits: SessionLimitsProvider;
  /** Base dir for per-session capability roots (env ENGINE_CAPABILITY_ROOT_BASE). */
  readonly capabilityRootBase: string;
  /** §3.4 per-session idle timeout; default 15 minutes. */
  readonly idleTimeoutMs?: number;
  /** Idle sweep cadence; default 60 s (engine-pool watchdog parity). */
  readonly sweepIntervalMs?: number;
  /** Start the recycling timer on construction (default true; tests pass false). */
  readonly autoStartSweeper?: boolean;
  /** Injectable clock (epoch ms) for deterministic idle tests. */
  readonly clock?: () => number;
  readonly newSessionId?: () => string;
  readonly newToken?: () => string;
  /** §3.2 checkpoint-before-recycle; defaults to `saveDocumentCheckpoint`. */
  readonly checkpoint?: IdleCheckpointSeam;
  /** Structured logger; defaults to a silent sink (never console.*). */
  readonly logger?: Logger;
  /** §22 hook; observer errors never affect allocator state. */
  readonly onSessionEvent?: (event: LocalAllocatorEvent) => void;
}

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000; // §3.4 per-session idle 15 min
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;

/** Silent default logger (pino wires the real one at the composition root). */
const SILENT_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => SILENT_LOGGER,
};

interface SessionRecord {
  readonly sessionId: string;
  readonly organizationId: string;
  readonly documentId: string;
  readonly token: string;
  readonly port: number;
  readonly capabilities: EngineSessionCapabilities;
  readonly startedAt: number;
  lastActivityAt: number;
  state: LocalSessionState;
  readonly process: SpawnedEngineProcess;
}

/** States that hold a live, usable process (mirror of engine-pool constants). */
const ACTIVE_STATES: readonly LocalSessionState[] = ["attached", "idle"];

/**
 * SINGLE-BOX §3.2 session allocator (the §17.1 decision): the worker manages
 * engine sessions directly — one `serve` process per active session, fresh
 * 256-bit token per process, per-tenant capability roots, per-org plan caps,
 * idle checkpoint + recycle. When engine-pool becomes its own service this
 * class is replaced by a client of the pool's HTTP/IPC interface with the
 * SAME public surface (remote-note.md).
 */
export class LocalSessionAllocator {
  readonly #options: LocalSessionAllocatorOptions;
  readonly #records = new Map<string, SessionRecord>();
  /** In-flight launches per org — closes the cap's check-then-spawn race. */
  readonly #pendingByOrg = new Map<string, number>();
  readonly #idleTimeoutMs: number;
  readonly #logger: Logger;
  #sweepTimer: ReturnType<typeof setInterval> | undefined;
  #sweepInFlight = false;
  #drained = false;

  constructor(options: LocalSessionAllocatorOptions) {
    this.#options = options;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.#logger = options.logger ?? SILENT_LOGGER;
    if (options.autoStartSweeper !== false) {
      this.startIdleSweeper();
    }
  }

  /**
   * §3.2 allocate + attach: bring up one engine process bound to the document
   * for ONE tenant, enforcing the org's plan cap (§14.1 ladder via the billing
   * limits seam). Sessions are never shared across tenants: every allocation
   * mints its own session id, token, and per-tenant capability directory.
   */
  async allocate(documentId: string, organizationId: string): Promise<EngineSessionAllocation> {
    if (this.#drained) {
      throw new SessionAllocatorError(
        "engine_unavailable",
        "Session allocator is shutting down",
        { hint: "This allocator has been drained; construct a new one.", retryable: false },
      );
    }
    if (documentId.trim().length === 0 || organizationId.trim().length === 0) {
      throw validationFailedError(
        "Document and workspace ids are required",
        "Both ids name the engine's per-tenant capability directory (§3.2).",
      );
    }
    // Reserve the launch slot SYNCHRONOUSLY (before the async cap lookup) so
    // concurrent allocations for one org see each other's in-flight launches
    // — the async-cap counterpart of engine-pool's check-then-spawn race guard
    // (pool.ts `#pendingByOrg`; there the provider is sync, here it is not).
    const pending = this.#pendingByOrg.get(organizationId) ?? 0;
    this.#pendingByOrg.set(organizationId, pending + 1);
    try {
      let cap: number;
      try {
        cap = await this.#options.limits.maxConcurrentSessions(organizationId);
      } catch (error) {
        if (isSessionAllocatorError(error)) throw error;
        throw validationFailedError(
          "Workspace plan could not be verified",
          "Session caps come from the billing limits service; a failed lookup refuses allocation.",
        );
      }
      // Includes this launch's own pending slot; active > cap ⇔ the other
      // live+pending sessions already fill the plan's ladder row.
      const pendingNow = this.#pendingByOrg.get(organizationId) ?? 0;
      const active = this.#countActive(organizationId) + pendingNow;
      if (active > Math.max(0, cap)) {
        // §3.2: a tenant may have at most N concurrent sessions (plan limit).
        throw sessionLimitReachedError(Math.max(0, cap), active - 1);
      }
      return await this.#launch(documentId, organizationId);
    } finally {
      const left = (this.#pendingByOrg.get(organizationId) ?? 1) - 1;
      if (left > 0) this.#pendingByOrg.set(organizationId, left);
      else this.#pendingByOrg.delete(organizationId);
    }
  }

  /**
   * Tenant-scoped fetch. Cross-tenant probes get `undefined` — the same answer
   * as an unknown id, so a foreign org never learns a session exists (§15.1).
   */
  session(sessionId: string, organizationId: string): EngineSessionAllocation | undefined {
    const record = this.#records.get(sessionId);
    if (record === undefined || record.organizationId !== organizationId) return undefined;
    return this.#allocationOf(record);
  }

  /** Live (non-draining) sessions for the org — the caps-closure feed. */
  sessionCount(organizationId: string): number {
    return this.#countActive(organizationId);
  }

  /** Live + in-flight sessions for the org (pending launches included). */
  inFlightCount(organizationId: string): number {
    return this.#countActive(organizationId) + (this.#pendingByOrg.get(organizationId) ?? 0);
  }

  /** Record activity; resets the idle clock (§3.4 per-session idle). */
  touch(sessionId: string, organizationId: string): void {
    const record = this.#requireTenant(sessionId, organizationId);
    record.lastActivityAt = this.#now();
  }

  /**
   * §3.2 idle keep-warm: mark the released session idle — it stays available
   * for the next run and becomes the recycling sweep's first candidate
   * (checkpoint + recycle after the idle timeout). Idempotent; never throws.
   */
  async release(sessionId: string, organizationId: string): Promise<void> {
    const record = this.#requireTenant(sessionId, organizationId);
    // Attached → idle ONLY: a repeated release must not reset the idle clock
    // (a keep-warm session would live forever) and must not re-emit.
    if (record.state !== "attached") return;
    record.state = "idle";
    record.lastActivityAt = this.#now();
    this.#emit({ type: "session_idle", sessionId });
  }

  /** Immediate teardown (§3.4 crash replacement path): checkpoint, stop, forget. */
  async recycle(sessionId: string, organizationId: string): Promise<void> {
    const record = this.#requireTenant(sessionId, organizationId);
    await this.#evict(record, "explicit");
  }

  /**
   * One deterministic idle-recycling sweep (§3.2: idle timeout → save
   * checkpoint → recycle): evicts every active session whose last activity is
   * at least `idleTimeoutMs` old, most-idle first (engine-pool registry
   * parity). Returns the evicted session ids.
   */
  async sweepIdle(): Promise<readonly string[]> {
    if (this.#sweepInFlight) return [];
    this.#sweepInFlight = true;
    try {
      const now = this.#now();
      const candidates = [...this.#records.values()]
        .filter(
          (record) =>
            ACTIVE_STATES.includes(record.state) && now - record.lastActivityAt >= this.#idleTimeoutMs,
        )
        .sort((a, b) => a.lastActivityAt - b.lastActivityAt);
      const evicted: string[] = [];
      for (const record of candidates) {
        await this.#evict(record, "idle_timeout");
        evicted.push(record.sessionId);
      }
      return evicted;
    } finally {
      this.#sweepInFlight = false;
    }
  }

  /** Start the idle recycling timer (idempotent; unref'd — never holds the loop). */
  startIdleSweeper(): void {
    if (this.#sweepTimer !== undefined) return;
    const interval = this.#options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    const timer = setInterval(() => {
      void this.sweepIdle().catch(() => undefined);
    }, interval);
    timer.unref?.();
    this.#sweepTimer = timer;
  }

  /** Stop the recycling timer (drain + tests). */
  stopIdleSweeper(): void {
    if (this.#sweepTimer !== undefined) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = undefined;
    }
  }

  /** Shutdown: checkpoint + stop every session and refuse new allocations. */
  async drain(): Promise<void> {
    this.#drained = true;
    this.stopIdleSweeper();
    let evicted = 0;
    for (const record of [...this.#records.values()]) {
      await this.#evict(record, "drained");
      evicted += 1;
    }
    this.#records.clear();
    this.#emit({ type: "allocator_drained", evicted });
  }

  /** Point-in-time counts for dashboards and tests (§22). */
  snapshot(): {
    readonly total: number;
    readonly byState: Readonly<Record<LocalSessionState, number>>;
    readonly byOrganization: Readonly<Record<string, number>>;
  } {
    const byState: Record<LocalSessionState, number> = { attached: 0, idle: 0, draining: 0 };
    const byOrganization = new Map<string, number>();
    for (const record of this.#records.values()) {
      byState[record.state] += 1;
      byOrganization.set(
        record.organizationId,
        (byOrganization.get(record.organizationId) ?? 0) + 1,
      );
    }
    return {
      total: this.#records.size,
      byState,
      byOrganization: Object.fromEntries(byOrganization),
    };
  }

  // -- internals ----------------------------------------------------------

  async #launch(documentId: string, organizationId: string): Promise<EngineSessionAllocation> {
    const sessionId = this.#options.newSessionId?.() ?? randomUUID();
    // §3.2: unique random token, regenerated per process — 256-bit, 64 hex.
    const token = this.#options.newToken?.() ?? generateControlToken();
    const tenant = {
      baseDir: this.#options.capabilityRootBase,
      organizationId,
      sessionId,
    };
    // Canonical W2-B layout: `<base>/organizations/<org>/sessions/<session>`
    // with BOTH capability scopes rooted at the session directory.
    const read = resolveRoot("read", tenant);
    if (!read.ok) {
      throw validationFailedError(
        "Workspace or session id is not usable as an engine capability directory",
        "Tenant ids must be single safe path components (§15.1).",
      );
    }
    const layout = sessionLayout(tenant);
    if (!layout.ok) {
      throw validationFailedError(
        "Workspace or session id is not usable as an engine capability directory",
        "Tenant ids must be single safe path components (§15.1).",
      );
    }
    const capabilities: EngineSessionCapabilities = {
      readRoot: read.value.root,
      writeRoot: read.value.root,
      sessionDir: read.value.root,
      subdirs: layout.value,
    };
    const request: LocalSpawnRequest = {
      sessionId,
      organizationId,
      documentId,
      token,
      readRoot: capabilities.readRoot,
      writeRoot: capabilities.writeRoot,
      sessionDir: capabilities.sessionDir,
      tmpDir: layout.value.tmp,
      tokenFilePath: join(layout.value.tmp, "control-token"),
      subdirs: layout.value,
    };
    let outcome: SpawnOutcome;
    try {
      outcome = await this.#options.spawner.launch(request);
    } catch (error) {
      if (isSessionAllocatorError(error)) throw error;
      throw spawnFailedError(error);
    }
    const now = this.#now();
    const record: SessionRecord = {
      sessionId,
      organizationId,
      documentId,
      token,
      port: outcome.port,
      capabilities,
      startedAt: now,
      lastActivityAt: now,
      state: "attached",
      process: outcome.process,
    };
    this.#records.set(sessionId, record);
    this.#emit({ type: "session_allocated", sessionId, organizationId, documentId });
    this.#logger.info("engine session allocated", {
      sessionId,
      organizationId,
      spawner: this.#options.spawner.kind,
    });
    return this.#allocationOf(record);
  }

  /** §3.2 checkpoint → graceful stop → forget. Never lets a stop failure leak. */
  async #evict(
    record: SessionRecord,
    reason: "idle_timeout" | "explicit" | "drained",
  ): Promise<void> {
    record.state = "draining";
    this.#records.delete(record.sessionId);
    const checkpoint = this.#options.checkpoint ?? saveDocumentCheckpoint;
    let outcome: IdleCheckpointOutcome = { ok: false };
    try {
      outcome = await checkpoint({
        sessionId: record.sessionId,
        organizationId: record.organizationId,
        documentId: record.documentId,
        port: record.port,
        token: record.token,
        capabilities: record.capabilities,
      });
    } catch (error) {
      // §3.2: recycling proceeds even when the checkpoint fails — the command
      // log remains the durable fallback (§3.4 WAL replay).
      this.#logger.warn("idle-recycle checkpoint failed", {
        sessionId: record.sessionId,
        error: String(error),
      });
    }
    this.#emit({
      type: "session_checkpointed",
      sessionId: record.sessionId,
      ok: outcome.ok,
      path: outcome.path,
    });
    try {
      await record.process.stop("SIGTERM");
    } catch (error) {
      this.#logger.warn("engine process stop failed during recycle", {
        sessionId: record.sessionId,
        error: String(error),
      });
    }
    this.#emit({ type: "session_evicted", sessionId: record.sessionId, reason });
  }

  #allocationOf(record: SessionRecord): EngineSessionAllocation {
    const allocator = this;
    return {
      sessionId: record.sessionId,
      organizationId: record.organizationId,
      documentId: record.documentId,
      endpoint: `127.0.0.1:${record.port}`,
      port: record.port,
      token: record.token,
      capabilities: record.capabilities,
      startedAt: record.startedAt,
      lastActivityAt: record.lastActivityAt,
      get state() {
        return record.state;
      },
      release: () => allocator.release(record.sessionId, record.organizationId),
      touch: () => allocator.touch(record.sessionId, record.organizationId),
    };
  }

  #requireTenant(sessionId: string, organizationId: string): SessionRecord {
    const record = this.#records.get(sessionId);
    if (record === undefined || record.organizationId !== organizationId) {
      // Same typed error for unknown ids and foreign tenants (§15.1): a
      // cross-tenant probe must not learn the session exists.
      throw sessionNotFoundError();
    }
    return record;
  }

  #countActive(organizationId: string): number {
    let count = 0;
    for (const record of this.#records.values()) {
      if (record.organizationId === organizationId && ACTIVE_STATES.includes(record.state)) {
        count += 1;
      }
    }
    return count;
  }

  #now(): number {
    return this.#options.clock?.() ?? Date.now();
  }

  #emit(event: LocalAllocatorEvent): void {
    const observer = this.#options.onSessionEvent;
    if (observer === undefined) return;
    try {
      observer(event);
    } catch (error) {
      // §22: an observer must never be able to break the allocator.
      this.#logger.warn("session-event observer failed", {
        type: event.type,
        error: String(error),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// PART 9 — engine-client plumbing + the env-driven factory
// ---------------------------------------------------------------------------

/**
 * A net.Socket adapted to the facade's JSON-lines `LineSocket` seam — MIRROR of
 * the W2-J harness adapter (apps/worker/tests/spine/harness.ts): Buffers
 * arrive as utf-8 strings; the TCP connection is initiated here so the
 * facade never re-calls connect() on an already-connecting socket.
 */
export function connectLineSocket(port: number): LineSocket {
  const socket = connect({ host: "127.0.0.1", port });
  socket.setNoDelay(true);
  function on(event: "data", listener: (chunk: string) => void): unknown;
  function on(event: "close", listener: (hadError: boolean) => void): unknown;
  function on(event: "error", listener: (error: Error) => void): unknown;
  function on(event: string, listener: (...args: never[]) => void): unknown {
    if (event === "data") {
      socket.on("data", (chunk: Buffer) => listener(chunk.toString("utf8")));
    } else if (event === "close") {
      socket.on("close", (hadError: boolean) => listener(hadError));
    } else {
      socket.on("error", (error: Error) => listener(error));
    }
    return socket;
  }
  return {
    write: (chunk: string): boolean => socket.write(chunk, "utf8"),
    on,
    destroy: (error?: Error): void => {
      socket.destroy(error);
    },
  };
}

/**
 * Default idle-recycle checkpoint (§3.2 "save checkpoint → recycle"): drive
 * one `@studio/engine-client` against the session and `doc.save` into the
 * session's sanctioned `save/` subdir. Best-effort — a failure never blocks
 * recycling; the command log stays the durable fallback (§3.4 WAL replay).
 */
export async function saveDocumentCheckpoint(
  request: IdleCheckpointRequest,
): Promise<IdleCheckpointOutcome> {
  if (!isSafePathComponent(request.documentId)) {
    return { ok: false };
  }
  const client = new EngineClient({
    auth: request.token,
    connect: () => connectLineSocket(request.port),
    timeouts: { readMs: 4_000, renderMs: 10_000, connectMs: 3_000 },
  });
  try {
    const outcome = await client.saveDocument({
      path: `save/${request.documentId}.pcraft`,
    });
    return outcome.ok ? { ok: true, path: outcome.result.path } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export interface CreateLocalSessionAllocatorInput {
  /** Loose env record (RunManagerEnv shape); Zod-parsed at this boundary. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** §14.1 caps — defaults to `billingSessionLimits(lookup)` when omitted. */
  readonly limits?: SessionLimitsProvider;
  /** Subscription lookup for the default billing caps adapter. */
  readonly lookup?: SubscriptionLookup;
  /** Base dir override; serve mode REQUIRES env ENGINE_CAPABILITY_ROOT_BASE. */
  readonly capabilityRootBase?: string;
  readonly idleTimeoutMs?: number;
  readonly sweepIntervalMs?: number;
  readonly autoStartSweeper?: boolean;
  readonly clock?: () => number;
  readonly newSessionId?: () => string;
  readonly newToken?: () => string;
  readonly checkpoint?: IdleCheckpointSeam;
  readonly logger?: Logger;
  readonly onSessionEvent?: (event: LocalAllocatorEvent) => void;
}

export interface LocalAllocatorBundle {
  readonly allocator: LocalSessionAllocator;
  readonly binding: LocalEngineBinding;
  /** The chosen spawner — `kind` pins the mock/serve branch for wiring logs. */
  readonly spawner: EngineSessionSpawner;
  /** The resolved capability-root base (env or local-dev default). */
  readonly capabilityRootBase: string;
}

/** Fail-closed lookup used when neither `limits` nor `lookup` was wired (§4). */
function refusingLookup(): SubscriptionLookup {
  return {
    getSubscription: () => {
      throw validationFailedError(
        "Workspace plan could not be verified",
        "Wire a SubscriptionLookup (billing limits service) or pass explicit limits.",
      );
    },
  };
}

/**
 * Env-driven factory — the single-box composition root for this module:
 * resolves the §3.2 binding (MOCK_ENGINE=1 → mock spawner; a present
 * ENGINE_BINARY_PATH → the real serve spawner; a missing binary → mock, the
 * processor.ts `resolveEngineBinding` mirror), builds the billing-backed cap
 * provider, and starts the idle recycling timer.
 */
export function createLocalSessionAllocator(
  input: CreateLocalSessionAllocatorInput,
): LocalAllocatorBundle {
  const parsed = LOCAL_ALLOCATOR_ENV_SCHEMA.parse(input.env);
  const binding = resolveLocalEngineBinding(parsed);
  let spawner: EngineSessionSpawner;
  let capabilityRootBase: string;
  if (binding.mode === "serve") {
    if (parsed.ENGINE_BINARY_PATH === undefined || parsed.ENGINE_BINARY_PATH.length === 0) {
      throw validationFailedError(
        "ENGINE_BINARY_PATH is required in serve mode",
        "Point it at the pinned engine binary (§3.2).",
      );
    }
    const base = input.capabilityRootBase ?? parsed.ENGINE_CAPABILITY_ROOT_BASE;
    if (base === undefined || base.length === 0) {
      // Fail fast (§4): the per-tenant capability roots must be anchored.
      throw validationFailedError(
        "ENGINE_CAPABILITY_ROOT_BASE is required in serve mode",
        "Set it to the base directory for per-organization session roots (§3.2, §15.1).",
      );
    }
    capabilityRootBase = base;
    spawner = new ServeEngineSpawner(parsed.ENGINE_BINARY_PATH);
  } else {
    const entry = resolveMockEngineEntry(parsed.MOCK_ENGINE_ENTRY);
    if (entry === null) {
      throw new SessionAllocatorError("engine_unavailable", "Mock engine entry not found", {
        hint: "Expected apps/mock-engine/src/index.mjs relative to the repo, or set MOCK_ENGINE_ENTRY.",
        retryable: false,
      });
    }
    // Local-dev default for the mock's write roots: a tmpdir base (the real
    // serve path never defaults — it fails fast on a missing env knob).
    capabilityRootBase =
      input.capabilityRootBase ??
      parsed.ENGINE_CAPABILITY_ROOT_BASE ??
      join(tmpdir(), "studio-engine-sessions");
    spawner = new MockEngineSpawner(entry);
  }
  const limits = input.limits ?? billingSessionLimits(input.lookup ?? refusingLookup());
  const allocator = new LocalSessionAllocator({
    spawner,
    limits,
    capabilityRootBase,
    idleTimeoutMs: input.idleTimeoutMs,
    sweepIntervalMs: input.sweepIntervalMs,
    autoStartSweeper: input.autoStartSweeper,
    clock: input.clock,
    newSessionId: input.newSessionId,
    newToken: input.newToken,
    checkpoint: input.checkpoint,
    logger: input.logger,
    onSessionEvent: input.onSessionEvent,
  });
  return { allocator, binding, spawner, capabilityRootBase };
}
