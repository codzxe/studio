// @studio/engine-pool — the REAL spawner: one `photocraft-cli serve` child process per
// session (§2.2, §3.2). Implements the Wave 1 seams (../types.js) with the exact vendor
// CLI contract; every flag, stderr line and exit-code reference lives in
// ./serve-config.ts and ./README.md with vendor line numbers.
//
// Lifecycle contract implemented here:
// - start(): create the session dirs, write the pool's token to the per-session 0600
//   control-token file (serve READS an existing file — security.rs:185-211 — so it
//   authenticates with the pool's token, not a serve-minted one), spawn the binary,
//   and resolve only once the process accepts work:
//     - TCP: the stderr line `photocraft-cli serving on 127.0.0.1:<port>` (lib.rs:
//       582-584, printed after the bind; `--port 0` reports the ephemeral port there).
//     - stdio: no banner exists (lib.rs:587-590), so readiness is "spawned and still
//       alive"; the `methods` handshake belongs to @studio/engine-client (W2-H/I).
// - stop(): SIGTERM first (stdio transport: stdin EOF first — serve_lines returns 0 on
//   EOF, rpc.rs:247-264), escalate to SIGKILL after the grace window (§3.2 kill path;
//   the pool has already marked the session crashed via its stop-failure path §3.4).
//   The child is its own process-group leader (`detached: true`) and the WHOLE group is
//   signalled, so a wedged engine cannot leave orphans behind.
// - exit-event: an unexpected exit emits `exit` + `crash`; the pool's watchdog flips the
//   session to `crashed` and the worker replays from the last checkpoint (§3.4).
// - stdout/stderr land in a bounded, secret-redacted ring buffer (`diagnostics()`)
//   for ops; no `console.log`, no token ever buffered or logged (§15.1).

import { type ChildProcess, type SpawnOptions, spawn as nodeSpawn } from "node:child_process";
import { mkdir, rmdir, unlink, writeFile } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";

import { DEFAULT_DRAIN_GRACE_MS } from "../constants.js";
import { engineUnavailable, spawnFailed } from "../errors.js";
import type {
  EngineEventKind,
  EngineEventMap,
  EngineProcess,
  SpawnRequest,
  Spawner,
  StopSignal,
} from "../types.js";
import {
  type ServeConfig,
  type ServeSpawnPlan,
  buildServeSpawnPlan,
  parseServingPort,
  redactSecrets,
} from "./serve-config.js";

/** Default wait for the readiness line (lib.rs prints it immediately after bind). */
export const DEFAULT_READINESS_TIMEOUT_MS = 15_000;
/** SIGTERM → SIGKILL escalation window; matches the pool's drain grace (§3.4). */
export const DEFAULT_STOP_GRACE_MS = DEFAULT_DRAIN_GRACE_MS;
/** Final wait for the exit event after SIGKILL before stop() gives up. */
export const DEFAULT_KILL_GRACE_MS = 5_000;
/** Diagnostic ring-buffer capacity (lines) per process — bounded memory (§22). */
export const DEFAULT_DIAGNOSTICS_CAPACITY = 256;
/** Hard cap for one buffered output line; engine replies can be huge, logs must not be. */
const MAX_LINE_CHARS = 2_000;
/** Cap for a newline-less chunk before it is force-flushed (vendor replies ≤ 8 MiB). */
const MAX_BUFFERED_LINE_CHARS = 1_000_000;

/** Injectable `child_process.spawn` — lets CI smoke tests substitute a fake binary. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface PhotocraftServeSpawnerOptions extends ServeConfig {
  /** Child spawn override (tests / CI smoke script). Defaults to node:child_process. */
  readonly spawn?: SpawnFn;
  /** Readiness deadline for the `serving on` line (default 15 s). */
  readonly readinessTimeoutMs?: number;
  /** Grace between the first stop signal and SIGKILL (default 5 s, §3.4). */
  readonly stopGraceMs?: number;
  /** Final wait for the exit event after SIGKILL (default 5 s). */
  readonly killGraceMs?: number;
  /** Diagnostic ring-buffer capacity in lines (default 256). */
  readonly diagnosticsCapacity?: number;
}

/** A resolved/rejected pair handed between the spawn wiring and the readiness wait. */
interface ReadyGate {
  readonly resolve: () => void;
  readonly reject: (reason?: unknown) => void;
}

/**
 * Factory for real engine processes. Construct with the parsed engine-pool env:
 *
 * ```ts
 * const spawner = new PhotocraftServeSpawner({
 *   binaryPath: env.ENGINE_BINARY_PATH,          // required, never defaulted (§4)
 *   capabilityRootBase: env.ENGINE_CAPABILITY_ROOT_BASE,
 *   env: process.env,                            // sanitized before the spawn
 * });
 * ```
 */
export class PhotocraftServeSpawner implements Spawner {
  readonly #options: PhotocraftServeSpawnerOptions;

  constructor(options: PhotocraftServeSpawnerOptions) {
    if (options.binaryPath.length === 0 || options.capabilityRootBase.length === 0) {
      // Fail fast (§4): the binary path and root base come from env, never defaults.
      throw engineUnavailable({
        message: "Engine spawner is misconfigured",
        hint: "Set ENGINE_BINARY_PATH and ENGINE_CAPABILITY_ROOT_BASE (packages/config env/engine-pool.ts).",
      });
    }
    this.#options = options;
  }

  /** `Spawner.spawn` must never block or touch the network (../types.js) — pure here. */
  spawn(request: SpawnRequest): EngineProcess {
    return new PhotocraftServeProcess(request, this.#options);
  }
}

/** One supervised `photocraft-cli serve` child process. */
export class PhotocraftServeProcess implements EngineProcess {
  readonly #options: PhotocraftServeSpawnerOptions;
  readonly #capacity: number;
  readonly #handlers = new Map<
    EngineEventKind,
    Array<(event: EngineEventMap[EngineEventKind]) => void>
  >();
  readonly #ring: string[] = [];
  #token = "";
  #plan?: ServeSpawnPlan;
  #child?: ChildProcess;
  #resolvedPort?: number;
  #started = false;
  /** True once we ASKED for this exit (stop path) — such exits are not crashes. */
  #stopping = false;
  #exited = false;
  readonly #exitWaiters: Array<() => void> = [];
  #readyGate?: ReadyGate;
  #readyTimer?: ReturnType<typeof setTimeout>;
  #lineBuf = "";

  constructor(request: SpawnRequest, options: PhotocraftServeSpawnerOptions) {
    this.#options = options;
    this.#capacity = options.diagnosticsCapacity ?? DEFAULT_DIAGNOSTICS_CAPACITY;
    this.#token = request.token;
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  /** The port the engine actually bound (TCP; parsed from the serving line). */
  get boundPort(): number | undefined {
    return this.#resolvedPort;
  }

  /** Transport actually in use ("tcp" | "stdio"); undefined before start(). */
  get transport(): ServeSpawnPlan["transport"] | undefined {
    return this.#plan?.transport;
  }

  /** JSON-lines pipes for the stdio transport (null on TCP / before start()). */
  get stdin(): Writable | null {
    return this.#child?.stdin ?? null;
  }

  get stdout(): Readable | null {
    return this.#child?.stdout ?? null;
  }

  /** Snapshot of the diagnostic ring buffer (oldest first), secrets redacted (§22). */
  diagnostics(): readonly string[] {
    return [...this.#ring];
  }

  async start(request: SpawnRequest): Promise<void> {
    if (this.#started) {
      throw engineUnavailable({
        message: "Engine process was already started",
        hint: "One session, one process (§3.2); spawn a new one instead of restarting.",
      });
    }
    this.#started = true;
    this.#token = request.token;

    const plan = buildServeSpawnPlan(request, {
      binaryPath: this.#options.binaryPath,
      capabilityRootBase: this.#options.capabilityRootBase,
      env: this.#options.env,
    });
    this.#plan = plan;

    try {
      await this.#prepareSessionFiles(plan, request);
    } catch (error) {
      throw spawnFailed(error);
    }

    const spawnFn = this.#options.spawn ?? nodeSpawn;
    let child: ChildProcess;
    try {
      child = spawnFn(plan.command, plan.args, {
        env: { ...plan.env },
        stdio: ["pipe", "pipe", "pipe"],
        // New process group so stop() can signal the WHOLE group (a wedged engine
        // must not leak processes — apps/engine-pool README §Wave 2).
        detached: true,
      });
    } catch (error) {
      throw spawnFailed(error);
    }
    this.#child = child;
    child.stdout?.on("data", (chunk: Buffer) => this.#onOutput("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.#onOutput("stderr", chunk));
    child.on("error", (error: Error) => this.#onSpawnError(error));
    child.on("exit", (code, signal) => this.#onExit(code, signal));

    await this.#awaitReady();
  }

  async stop(signal: StopSignal = "SIGTERM"): Promise<void> {
    const child = this.#child;
    this.#stopping = true;
    if (child === undefined || this.#exited) {
      await this.#cleanupFiles();
      return;
    }
    const exited = this.#waitExit();
    const stopGraceMs = this.#options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    const killGraceMs = this.#options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

    if (signal === "SIGTERM" && this.#plan?.transport === "stdio") {
      // Graceful stdio stop: serve_lines returns Ok(()) — exit code 0 — on stdin EOF
      // (rpc.rs:247-264), so EOF is the engine's own shutdown path.
      try {
        child.stdin?.end();
      } catch {
        // Pipe already gone; the signal escalation below still applies.
      }
    } else {
      this.#signalChild(child, signal);
    }
    if ((await this.#raceExit(exited, stopGraceMs)) === "exit") {
      await this.#cleanupFiles();
      return;
    }

    // Grace window blown: escalate to SIGKILL. The pool has already marked the session
    // crashed via its watchdog stop-failure path; this just reaps the process (§3.4).
    this.#signalChild(child, "SIGKILL");
    await this.#raceExit(exited, killGraceMs);
    await this.#cleanupFiles();
  }

  onEvent<K extends EngineEventKind>(kind: K, handler: (event: EngineEventMap[K]) => void): void {
    const list = this.#handlers.get(kind) ?? [];
    list.push(handler as (event: EngineEventMap[EngineEventKind]) => void);
    this.#handlers.set(kind, list);
  }

  // ---- spawn wiring -------------------------------------------------------------

  /**
   * Prepare the on-disk state serve needs at argv-parse / workspace-open time:
   * the capability roots (must exist — workspace.rs open_root:155-165) and the
   * 0600 control-token file holding the POOL's token (security.rs:185-211 reads an
   * existing file instead of minting one). A stale file from a previous incarnation
   * of the same session id is replaced (the token is regenerated per process, §3.2).
   */
  async #prepareSessionFiles(plan: ServeSpawnPlan, request: SpawnRequest): Promise<void> {
    await mkdir(request.readRoot, { recursive: true });
    await mkdir(request.writeRoot, { recursive: true });
    if (plan.transport !== "tcp") return; // stdio carries no token (lib.rs:587-590)
    await mkdir(plan.dirs.tmpDir, { recursive: true });
    await unlink(plan.dirs.tokenFilePath).catch(() => undefined);
    await writeFile(plan.dirs.tokenFilePath, `${request.token}\n`, {
      mode: 0o600,
      flag: "wx", // exclusive create, like the vendor's create_token_file (security.rs:172-178)
    });
  }

  /**
   * Readiness gate. TCP: the `photocraft-cli serving on 127.0.0.1:<port>` stderr line
   * (lib.rs:582-584). stdio: no banner exists — settle one macrotask and confirm the
   * process is still alive; the `methods` frame handshake is the engine client's job.
   */
  async #awaitReady(): Promise<void> {
    const plan = this.#plan;
    if (plan === undefined) throw spawnFailed(new Error("no spawn plan"));
    const timeoutMs = this.#options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    const gate = new Promise<void>((resolve, reject) => {
      this.#readyGate = { resolve, reject };
      this.#readyTimer = setTimeout(
        () => this.#failReady(new Error(`serve did not report readiness within ${timeoutMs} ms`)),
        timeoutMs,
      );
    });
    if (plan.transport === "stdio") {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (!this.#exited) this.#settleReady();
    }
    await gate;
  }

  #settleReady(): void {
    const gate = this.#readyGate;
    if (gate === undefined) return;
    this.#readyGate = undefined;
    this.#clearReadyTimer();
    gate.resolve();
    this.#emit("ready", { kind: "ready", port: this.#resolvedPort });
  }

  #failReady(cause: unknown): void {
    const gate = this.#readyGate;
    if (gate === undefined) return;
    this.#readyGate = undefined;
    this.#clearReadyTimer();
    // Never leave a half-ready child running behind a failed allocation.
    const child = this.#child;
    this.#stopping = true;
    if (child !== undefined && !this.#exited) this.#signalChild(child, "SIGKILL");
    gate.reject(spawnFailed(cause));
  }

  #clearReadyTimer(): void {
    if (this.#readyTimer !== undefined) {
      clearTimeout(this.#readyTimer);
      this.#readyTimer = undefined;
    }
  }

  // ---- process wiring -----------------------------------------------------------

  #onOutput(stream: "stdout" | "stderr", chunk: Buffer): void {
    this.#lineBuf += chunk.toString("utf8");
    if (!this.#lineBuf.includes("\n") && this.#lineBuf.length > MAX_BUFFERED_LINE_CHARS) {
      // Bound memory on a newline-less blob (engine replies can be MiB): flush cut.
      const head = this.#lineBuf.slice(0, MAX_LINE_CHARS);
      this.#lineBuf = "";
      this.#handleLine(stream, `${head}… [line truncated: no newline]`);
      return;
    }
    let newlineIndex = this.#lineBuf.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.#lineBuf.slice(0, newlineIndex).replace(/\r$/, "");
      this.#lineBuf = this.#lineBuf.slice(newlineIndex + 1);
      this.#handleLine(stream, line);
      newlineIndex = this.#lineBuf.indexOf("\n");
    }
  }

  #handleLine(stream: "stdout" | "stderr", rawLine: string): void {
    // Defense in depth: the token must never reach logs or diagnostics (§15.1). With a
    // token FILE serve prints the path, not the token — redact regardless.
    const line = redactSecrets(rawLine, this.#token.length > 0 ? [this.#token] : []);
    this.#pushDiagnostic(`${stream}: ${line}`);
    this.#emit("log", { kind: "log", line });

    // Readiness (TCP): `photocraft-cli serving on 127.0.0.1:<port>` — lib.rs:582-584.
    if (this.#readyGate !== undefined && stream === "stderr") {
      const port = parseServingPort(line);
      if (port !== undefined) {
        this.#resolvedPort = port;
        this.#settleReady();
      }
    }
  }

  #onSpawnError(error: Error): void {
    this.#pushDiagnostic(`spawn error: ${error.message}`);
    if (this.#readyGate !== undefined) this.#failReady(error);
  }

  #onExit(code: number | null, signal: string | null): void {
    this.#exited = true;
    this.#pushDiagnostic(`engine exited (code=${String(code)}, signal=${String(signal)})`);
    if (this.#readyGate !== undefined) {
      this.#failReady(new Error(`engine exited before ready (code=${String(code)})`));
    }
    const stopSignal =
      signal === "SIGINT" || signal === "SIGTERM" || signal === "SIGKILL" ? signal : null;
    this.#emit("exit", { kind: "exit", code, signal: stopSignal });
    if (!this.#stopping) {
      // Unexpected exit → crash for the pool's watchdog; the worker replays from the
      // last checkpoint (§3.2, §3.4). Generic reason only — no paths, no internals.
      this.#emit("crash", {
        kind: "crash",
        reason: `engine process exited unexpectedly (code ${String(code)}, signal ${String(signal)})`,
      });
    }
    for (const waiter of this.#exitWaiters.splice(0)) waiter();
    void this.#cleanupFiles();
  }

  #signalChild(child: ChildProcess, signal: StopSignal): void {
    const pid = child.pid;
    if (pid === undefined) return;
    this.#pushDiagnostic(`sending ${signal} to engine process`);
    if (process.platform !== "win32") {
      // The child is its own group leader (detached spawn): -pid signals the whole group.
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // Group kill can race with an already-reaped child — fall through to the
        // direct signal; if that also fails the exit event is imminent anyway.
      }
    }
    try {
      child.kill(signal);
    } catch {
      // Already dead: the exit event settles the waiters.
    }
  }

  #waitExit(): Promise<void> {
    if (this.#exited) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#exitWaiters.push(resolve);
    });
  }

  async #raceExit(exited: Promise<void>, graceMs: number): Promise<"exit" | "timeout"> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        exited.then(() => "exit" as const),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), graceMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  // ---- cleanup ------------------------------------------------------------------

  /**
   * Remove the credential first (§15.1: no stale 0600 token files on disk) and
   * best-effort drop the tmp dir. The read/write roots are NOT removed — they hold
   * document checkpoints; that lifecycle belongs to the worker (§3.3 step 6).
   */
  async #cleanupFiles(): Promise<void> {
    const plan = this.#plan;
    if (plan === undefined || plan.transport !== "tcp") return;
    await unlink(plan.dirs.tokenFilePath).catch(() => undefined);
    await rmdir(plan.dirs.tmpDir).catch(() => undefined);
  }

  #pushDiagnostic(line: string): void {
    const bounded =
      line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [truncated]` : line;
    this.#ring.push(bounded);
    while (this.#ring.length > this.#capacity) this.#ring.shift();
  }

  #emit<K extends EngineEventKind>(kind: K, event: EngineEventMap[K]): void {
    for (const handler of this.#handlers.get(kind) ?? []) {
      handler(event as EngineEventMap[EngineEventKind]);
    }
  }
}
