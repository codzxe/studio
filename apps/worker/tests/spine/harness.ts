// apps/worker/tests/spine/harness.ts — shared fixtures for the Phase-0 spine suites.
//
// Spawns apps/mock-engine (the W2-F fake of `photocraft-cli serve`) as a REAL child
// process and connects the EngineClient facade to it over loopback TCP: the §19 Phase-0
// spine ("prove the spine end-to-end with zero product polish") and the §21 Integration
// row ("create doc, run batch, render, save, reopen, inspect. Failed-command handling"),
// plus the §3.4 crash-recovery story at process level (recovery-spine.test.ts).
//
// The harness targets the mock's CONTRACT, never its implementation: two generations of
// apps/mock-engine have lived in this repo while the spine was authored (a rich
// .pcraft-persisting revision and a slimmer rewrite), so every seam is feature-tolerant:
//   - spawn contract: `node apps/mock-engine/src/index.mjs`, MOCK_ENGINE_PORT=0
//     (ephemeral), MOCK_ENGINE_TOKEN=<64 hex> — the env vars W2-F's README pins;
//   - the bound port is announced either as a stdout JSON line
//     {"mockEngine":"listening","port":N} or a stderr line "listening on 127.0.0.1:N" —
//     both formats are accepted;
//   - filesystem roots: MOCK_ENGINE_ROOT and MOCK_ENGINE_WRITE_ROOT are both pointed at
//     the same temp directory (each generation reads its own, ignores the other's);
//   - crash faults: MOCK_ENGINE_FAULTS='{"crashOnCommand":<id>}' (rich revision, fires on
//     that command id, including inside batches) and MOCK_FAULT="crash-on-command"
//     (rewrite, fires before any engine.execute dispatch) are armed together, so a
//     standalone engine.execute of the target command crashes deterministically under
//     either convention.
//
// The EngineClient is loaded dynamically — the @studio/engine-client barrel first, the
// concrete facade module as fallback — because src/index.ts and one client.ts import were
// still landing from W2-D at authoring time. If neither resolves, the suites skip (see
// README.md › CI notes). Once the barrel is final, swap the loader for a plain import.
//
// Style: TS strict, ESM, .js extensions; no `any`, no non-null assertions.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The first four bytes of every PNG stream (RFC 2083): 89 50 4E 47. */
export const PNG_MAGIC_BYTES = [0x89, 0x50, 0x4e, 0x47] as const;

const HERE = path.dirname(fileURLToPath(import.meta.url)); // apps/worker/tests/spine
const MOCK_ENGINE_ENTRY = path.resolve(HERE, "../../../mock-engine/src/index.mjs");
const ANNOUNCE_TIMEOUT_MS = 15_000;
const STDERR_ANNOUNCE = /listening on 127\.0\.0\.1:(\d+)/;

/** apps/mock-engine entry — the describe.skipIf guard dereferences this. */
export function mockEngineEntry(): string | null {
  return existsSync(MOCK_ENGINE_ENTRY) ? MOCK_ENGINE_ENTRY : null;
}

// ---------------------------------------------------------------------------
// Structural mirrors of the EngineClient surface (packages/engine-client/src/client.ts)
// ---------------------------------------------------------------------------

/** The net-like JSON-lines socket seam the facade accepts (`connect` option). */
export interface LineSocketLike {
  write(chunk: string): boolean;
  on(event: "data", listener: (chunk: string) => void): unknown;
  on(event: "close", listener: (hadError: boolean) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  connect?(): unknown;
  destroy?(error?: Error): void;
}

/** Result envelope per AGENTS.md: { ok:false, code, message, hint, retryable }. */
export type SpineOutcome<T> =
  | { readonly ok: true; readonly result: T }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly hint: string;
      readonly retryable: boolean;
      readonly data?: unknown;
    };

export interface SpineDocNewInput {
  readonly width?: number;
  readonly height?: number;
  readonly name?: string;
}

export type SpineBatchStep = {
  readonly command: string;
  readonly params?: Record<string, unknown> | null;
};

export interface SpineBatchInput {
  readonly steps: readonly SpineBatchStep[];
  readonly stopOnError?: boolean;
}

export type SpineBatchStepOutcome =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: string };

export interface SpineBatchResult {
  readonly completed: number;
  readonly failed: number;
  readonly results: readonly SpineBatchStepOutcome[];
}

export type SpineRenderResult =
  | { readonly mime: "image/png"; readonly base64: string }
  | { readonly path: string; readonly bytes: number };

export interface SpineEngineClientOptions {
  readonly connect: () => LineSocketLike;
  readonly auth: string;
  readonly timeouts?: {
    readonly readMs?: number;
    readonly renderMs?: number;
    readonly connectMs?: number;
  };
  readonly backoff?: {
    readonly baseMs?: number;
    readonly capMs?: number;
    readonly jitter?: number;
  };
}

/** Only the facade members the spine drives; open/inspect go through `call` (README). */
export interface SpineEngineClient {
  newDocument(input?: SpineDocNewInput): Promise<SpineOutcome<{ readonly document: number }>>;
  runBatch(input: SpineBatchInput): Promise<SpineOutcome<SpineBatchResult>>;
  renderDocument(input?: { readonly maxSide?: number }): Promise<SpineOutcome<SpineRenderResult>>;
  saveDocument(input: { readonly path: string }): Promise<
    SpineOutcome<{ readonly path: string; readonly warnings: readonly string[] }>
  >;
  executeCommand(
    input: { readonly command: string; readonly params?: Record<string, unknown> | null },
    options?: { readonly kind?: "read" | "mutate" },
  ): Promise<SpineOutcome<unknown>>;
  call(
    method: string,
    params: unknown,
    options: { readonly kind: "read" | "mutate" },
  ): Promise<SpineOutcome<unknown>>;
  close(): Promise<void>;
}

export type SpineEngineClientCtor = new (options: SpineEngineClientOptions) => SpineEngineClient;

// ---------------------------------------------------------------------------
// EngineClient loader (barrel first, concrete module as fallback)
// ---------------------------------------------------------------------------

// Typed as plain `readonly string[]` on purpose: a literal union would let tsc resolve
// the specifiers statically and fail on the in-flight barrel (TS2307 in this file).
const ENGINE_CLIENT_CANDIDATES: readonly string[] = [
  "@studio/engine-client",
  "../../../packages/engine-client/src/client.js",
];

export async function loadEngineClient(): Promise<SpineEngineClientCtor | null> {
  for (const candidate of ENGINE_CLIENT_CANDIDATES) {
    try {
      const mod = (await import(/* @vite-ignore */ candidate)) as Record<string, unknown>;
      const ctor = mod.EngineClient;
      if (typeof ctor === "function") {
        return ctor as SpineEngineClientCtor;
      }
    } catch {
      // Not resolvable yet (barrel or a client.ts import still landing from W2-D):
      // try the next candidate; the caller skips the suite when all fail.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Client construction
// ---------------------------------------------------------------------------

/** Fast-failing §3.4 timeouts so a stuck engine fails the suite in seconds, not minutes. */
export function makeEngineClient(
  ctor: SpineEngineClientCtor,
  port: number,
  token: string,
): SpineEngineClient {
  return new ctor({
    auth: token,
    connect: () => connectLineSocket(port),
    timeouts: { readMs: 4_000, renderMs: 8_000, connectMs: 3_000 },
    backoff: { baseMs: 40, capMs: 400, jitter: 0 },
  });
}

/**
 * A net.Socket adapted to the facade's JSON-lines seam: Buffers arrive as utf-8 strings
 * and the socket's own connect() method stays hidden (the connection is initiated by
 * net.connect; the facade must not re-call connect()).
 */
export function connectLineSocket(port: number): LineSocketLike {
  const socket = net.connect({ host: "127.0.0.1", port });
  socket.setNoDelay(true);
  const wire = {
    write: (chunk: string): boolean => socket.write(chunk, "utf8"),
    on: (event: "data" | "close" | "error", listener: (...args: never[]) => void): unknown => {
      if (event === "data") {
        socket.on("data", (chunk: Buffer) => (listener as (chunk: string) => void)(chunk.toString("utf8")));
      } else if (event === "close") {
        socket.on("close", (hadError: boolean) => (listener as (hadError: boolean) => void)(hadError));
      } else {
        socket.on("error", (error: Error) => (listener as (error: Error) => void)(error));
      }
      return socket;
    },
    destroy: (error?: Error): void => {
      socket.destroy(error);
    },
  };
  return wire as LineSocketLike;
}

/** Unwraps an ok outcome; failures throw with the envelope's code/message/hint. */
export function unwrapOutcome<T>(outcome: SpineOutcome<T>): T {
  if (!outcome.ok) {
    throw new Error(`engine call failed (${outcome.code}): ${outcome.message} — ${outcome.hint}`);
  }
  return outcome.result;
}

// ---------------------------------------------------------------------------
// doc.inspect narrowing (the raw `call` surface — both mock generations answer it)
// ---------------------------------------------------------------------------

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
export async function rawInspect(client: SpineEngineClient, index?: number): Promise<SpineInspectLike> {
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
  /** Recent stderr lines (fail-fast messages, fault logs) for diagnostics. */
  readonly stderr: readonly string[];
  /** Resolves when the process exits; a fault crash reports a non-zero `code`. */
  readonly exited: Promise<{ readonly code: number | null; readonly signal: string | null }>;
  stop(): Promise<void>;
}

export interface SpawnMockEngineOptions {
  readonly root: string;
  /**
   * Arm the crash fault so a standalone engine.execute of this command kills the
   * process before its reply (both mock fault conventions are armed — see header).
   */
  readonly crashOnCommand?: string;
}

export async function spawnMockEngine(options: SpawnMockEngineOptions): Promise<MockEngineHandle> {
  const entry = mockEngineEntry();
  if (entry === null) {
    throw new Error("apps/mock-engine/src/index.mjs is missing; the spine guard should have skipped");
  }
  const token = randomBytes(32).toString("hex"); // 64 hex chars — security.rs TOKEN_BYTES
  const env: Record<string, string | undefined> = {
    ...process.env,
    MOCK_ENGINE_PORT: "0", // 0 = bind an ephemeral port; the child announces the real one
    MOCK_ENGINE_TOKEN: token,
    MOCK_ENGINE_ROOT: options.root,
    MOCK_ENGINE_WRITE_ROOT: options.root,
  };
  if (options.crashOnCommand !== undefined) {
    env.MOCK_ENGINE_FAULTS = JSON.stringify({ crashOnCommand: options.crashOnCommand });
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

/** Accepts both announcement formats (stdout JSON line, stderr "listening on …" line). */
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

/** {"mockEngine":"listening","port":N} — the JSON announcement generation. */
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
