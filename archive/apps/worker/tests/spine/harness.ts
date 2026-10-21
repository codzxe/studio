// apps/worker/tests/spine/harness.ts — shared fixtures for the Phase-0 spine suites.
//
// Spawns apps/mock-engine (the W2-F protocol-faithful fake of `photocraft-cli serve`)
// as a REAL child process and connects the REAL @studio/engine-client facade to it
// over loopback TCP: docs/BUILD_PROMPT.md §19 Phase 0 ("prove the spine end-to-end
// with zero product polish") and §21's Integration row ("create doc, run batch,
// render, save, reopen, inspect. Failed-command handling"), plus the §3.4
// crash-recovery story at process level (recovery-spine.test.ts).
//
// Everything targets the mock's pinned CONTRACT (apps/mock-engine/README.md),
// never its implementation:
//   - spawn contract: `node apps/mock-engine/src/index.mjs`, MOCK_ENGINE_PORT=0
//     (ephemeral), MOCK_ENGINE_TOKEN=<64 hex>, MOCK_ENGINE_WRITE_ROOT=<temp dir>;
//   - the bound port is announced on stderr as "listening on 127.0.0.1:<port>"
//     (a stdout JSON line {"mockEngine":"listening","port":N} is also accepted —
//     it costs ~20 lines and survives a mock rewrite);
//   - crash contract: MOCK_FAULT=crash-on-command kills the child with exit code 86
//     BEFORE the engine.execute reply is written. Faults fire on `engine.execute`
//     dispatch only — the `batch` method executes its steps inside the process
//     without re-entering dispatch — so with the fault armed, batched checkpoints
//     stay safe while a standalone engine.execute is the deterministic kill
//     (recovery-spine.test.ts).
//
// The EngineClient is imported statically: the barrel
// (packages/engine-client/src/index.ts) and the package main landed with W2-D2, the
// workspace dep is declared in apps/worker/package.json, and tsconfig.base.json maps
// `@studio/engine-client` for typecheck. The only skip-guard the suites need is the
// mock-engine entry (describe.skipIf — engine-spine.test.ts / README › CI notes).
//
// Style: TS strict, ESM, .js extensions; no `any`, no non-null assertions.

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { EngineClient } from "@studio/engine-client";
import type { EngineOutcome, LineSocket } from "@studio/engine-client";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The first four bytes of every PNG stream (RFC 2083): 89 50 4E 47. */
export const PNG_MAGIC_BYTES = [0x89, 0x50, 0x4e, 0x47] as const;
/** The same magic as a hex string, for byte-exact comparisons: 89504e47. */
export const PNG_MAGIC_HEX = "89504e47";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // apps/worker/tests/spine
const MOCK_ENGINE_ENTRY = path.resolve(HERE, "../../../mock-engine/src/index.mjs");
const ANNOUNCE_TIMEOUT_MS = 15_000;
const STDERR_ANNOUNCE = /listening on 127\.0\.0\.1:(\d+)/;

/** apps/mock-engine entry — the describe.skipIf guard dereferences this. */
export function mockEngineEntry(): string | null {
  return existsSync(MOCK_ENGINE_ENTRY) ? MOCK_ENGINE_ENTRY : null;
}

// ---------------------------------------------------------------------------
// EngineClient wiring (packages/engine-client/src/client.ts)
// ---------------------------------------------------------------------------

/**
 * A client against the spawned mock: inline 64-hex token (auth.ts), the net-socket
 * seam (`connect`), and fast-failing §3.4 budgets so a stuck engine fails the suite
 * in seconds, not minutes.
 */
export function makeEngineClient(port: number, token: string): EngineClient {
  return new EngineClient({
    auth: token,
    connect: () => connectLineSocket(port),
    timeouts: { readMs: 4_000, renderMs: 8_000, connectMs: 3_000 },
    backoff: { baseMs: 40, capMs: 400, jitter: 0 },
  });
}

/**
 * A net.Socket adapted to the facade's JSON-lines `LineSocket` seam: Buffers arrive
 * as utf-8 strings; the socket's own connect() is deliberately NOT exposed — the
 * TCP connection is initiated by net.connect here, and the facade must not re-call
 * connect() on an already-connecting socket.
 */
function lineSocketOn(socket: net.Socket) {
  // Overloads mirror client.ts LineSocket exactly, so the adapter needs no cast.
  function on(event: "data", listener: (chunk: string) => void): unknown;
  function on(event: "close", listener: (hadError: boolean) => void): unknown;
  function on(event: "error", listener: (error: Error) => void): unknown;
  function on(event: string, listener: (...args: unknown[]) => void): unknown {
    if (event === "data") {
      socket.on("data", (chunk: Buffer) => listener(chunk.toString("utf8")));
    } else if (event === "close") {
      socket.on("close", (hadError: boolean) => listener(hadError));
    } else {
      socket.on("error", (error: Error) => listener(error));
    }
    return socket;
  }
  return on;
}

export function connectLineSocket(port: number): LineSocket {
  const socket = net.connect({ host: "127.0.0.1", port });
  socket.setNoDelay(true);
  return {
    write: (chunk: string): boolean => socket.write(chunk, "utf8"),
    on: lineSocketOn(socket),
    destroy: (error?: Error): void => {
      socket.destroy(error);
    },
  };
}

/** Unwraps an ok outcome; failures throw with the envelope's code/message/hint. */
export function unwrapOutcome<T>(outcome: EngineOutcome<T>): T {
  if (!outcome.ok) {
    const hint = outcome.hint === undefined ? "" : ` — ${outcome.hint}`;
    throw new Error(`engine call failed (${outcome.code}): ${outcome.message}${hint}`);
  }
  return outcome.result;
}

// ---------------------------------------------------------------------------
// doc.inspect narrowing (the raw `call` surface — tolerant to mock reply drift)
// ---------------------------------------------------------------------------

/**
 * The doc.inspect fields the spine asserts on. doc.inspect is driven through the
 * facade's raw `call()` on purpose: the wrappers validate replies against strict
 * method schemas (methods/document.ts), and the mock's reply predates some of those
 * shapes — the spine pins BEHAVIOUR here, schema parity is W2-E's contract-test
 * territory (packages/engine-client/tests).
 */
export interface SpineInspectLike {
  readonly revision: number;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly layers: readonly unknown[];
}

export function asInspectLike(value: unknown): SpineInspectLike | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.revision !== "number" ||
    typeof row.name !== "string" ||
    typeof row.width !== "number" ||
    typeof row.height !== "number" ||
    !Array.isArray(row.layers)
  ) {
    return null;
  }
  return {
    revision: row.revision,
    name: row.name,
    width: row.width,
    height: row.height,
    layers: row.layers as readonly unknown[],
  };
}

/** doc.inspect of the active document via the facade's raw `call` (schema-drift tolerant). */
export async function rawInspect(
  client: EngineClient,
  index?: number,
): Promise<SpineInspectLike> {
  const outcome = await client.call("doc.inspect", index === undefined ? null : { index }, {
    kind: "read",
  });
  const inspect = asInspectLike(unwrapOutcome(outcome));
  if (inspect === null) {
    throw new Error("doc.inspect replied without the fields the spine asserts");
  }
  return inspect;
}

/** Layer names, top-down, from an inspect reply (rows carry `name`). */
export function layerNamesOf(inspect: SpineInspectLike): string[] {
  const names: string[] = [];
  for (const layer of inspect.layers) {
    if (typeof layer === "object" && layer !== null) {
      const name = (layer as { name?: unknown }).name;
      if (typeof name === "string") {
        names.push(name);
      }
    }
  }
  return names;
}

/** Text contents of type layers (`row.text.text`) — the version-proof Headline marker. */
export function layerTextsOf(inspect: SpineInspectLike): string[] {
  const texts: string[] = [];
  for (const layer of inspect.layers) {
    if (typeof layer === "object" && layer !== null) {
      const text = (layer as { text?: { text?: unknown } | null }).text;
      if (typeof text === "object" && text !== null && typeof text.text === "string") {
        texts.push(text.text);
      }
    }
  }
  return texts;
}

// ---------------------------------------------------------------------------
// Temp roots
// ---------------------------------------------------------------------------

export function makeSpineRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "studio-spine-"));
}

export function cleanupSpineRoot(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// mock-engine process
// ---------------------------------------------------------------------------

export interface MockEngineHandle {
  readonly child: ChildProcess;
  readonly port: number;
  readonly token: string;
  readonly root: string;
  /** Recent stderr lines (listening/token/fault logs) kept for diagnostics. */
  readonly stderr: readonly string[];
  /** Resolves when the process exits; the crash fault reports a non-zero `code`. */
  readonly exited: Promise<{ readonly code: number | null; readonly signal: string | null }>;
  stop(): Promise<void>;
}

export interface SpawnMockEngineOptions {
  readonly root: string;
  /**
   * Arm MOCK_FAULT=crash-on-command: the child dies with exit code 86 before the
   * reply of its FIRST engine.execute dispatch (see header — batches stay safe).
   */
  readonly crashOnExecute?: boolean;
}

export async function spawnMockEngine(options: SpawnMockEngineOptions): Promise<MockEngineHandle> {
  const entry = mockEngineEntry();
  if (entry === null) {
    throw new Error(
      "apps/mock-engine/src/index.mjs is missing; the spine guard should have skipped",
    );
  }
  const token = randomBytes(32).toString("hex"); // 64 hex chars — security.rs TOKEN_BYTES
  const env: Record<string, string | undefined> = {
    ...process.env,
    MOCK_ENGINE_PORT: "0", // 0 = bind an ephemeral port; the child announces the real one
    MOCK_ENGINE_TOKEN: token,
    MOCK_ENGINE_ROOT: options.root,
    MOCK_ENGINE_WRITE_ROOT: options.root,
  };
  if (options.crashOnExecute === true) {
    env.MOCK_FAULT = "crash-on-command";
  }
  const child = spawn(process.execPath, [entry], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr: string[] = [];
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code: code ?? null, signal: signal ?? null }));
  });
  const port = await waitForAnnouncedPort(child, stderr);
  return { child, port, token, root: options.root, stderr, exited, stop: makeStop(child, exited) };
}

/** Accepts both announcement formats (stderr "listening on …" line, stdout JSON line). */
function waitForAnnouncedPort(child: ChildProcess, stderr: string[]): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let stdoutBuffer = "";
    let settled = false;
    const finish = (port: number): void => {
      if (settled) return;
      settled = true;
      cleanup();
      clearTimeout(deadline);
      resolve(port);
    };
    const fail = (reason: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      clearTimeout(deadline);
      reject(reason);
    };
    const deadline = setTimeout(() => {
      fail(new Error(`mock-engine did not announce its port within ${ANNOUNCE_TIMEOUT_MS} ms`));
    }, ANNOUNCE_TIMEOUT_MS);
    const takeStdout = (chunk: Buffer): void => {
      stdoutBuffer += chunk.toString("utf8");
      let newline = stdoutBuffer.indexOf("\n");
      while (newline !== -1) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line.length > 0) {
          const port = portFromAnnouncement(line);
          if (port !== null) {
            finish(port);
          }
        }
        newline = stdoutBuffer.indexOf("\n");
      }
    };
    const takeStderr = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          stderr.push(trimmed);
        }
      }
      const match = STDERR_ANNOUNCE.exec(text);
      if (match !== null) {
        const port = Number.parseInt(match[1] ?? "", 10);
        if (Number.isInteger(port) && port > 0) {
          finish(port);
        }
      }
    };
    const takeError = (error: Error): void => fail(error);
    const cleanup = (): void => {
      child.stdout?.off("data", takeStdout);
      child.stderr?.off("data", takeStderr);
      child.off("error", takeError);
    };
    child.stdout?.on("data", takeStdout);
    child.stderr?.on("data", takeStderr);
    child.on("error", takeError);
  });
}

/** {"mockEngine":"listening","port":N} — the JSON announcement alternative. */
function portFromAnnouncement(line: string): number | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { mockEngine?: unknown }).mockEngine === "listening"
    ) {
      const port = (parsed as { port?: unknown }).port;
      if (typeof port === "number" && Number.isInteger(port) && port > 0) {
        return port;
      }
    }
  } catch {
    // Not JSON — the stderr announcement is handled separately.
  }
  return null;
}

function makeStop(
  child: ChildProcess,
  exited: Promise<{ code: number | null; signal: string | null }>,
): () => Promise<void> {
  return async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) {
      await exited; // already gone (e.g. the crash fault); let the exit promise settle
      return;
    }
    child.kill("SIGTERM");
    const settled = await Promise.race([
      exited.then((): boolean => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 1_500);
      }),
    ]);
    if (!settled) {
      child.kill("SIGKILL");
    }
    await exited;
  };
}
