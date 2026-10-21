// @studio/engine-pool tests — deterministic fakes + assertion helpers.
// NOTHING here spawns a real engine process; FakeSpawner/FakeEngineProcess implement
// the injectable seams from src/types.ts. No network, no real timers except the tiny
// drain-grace windows individual tests opt into.

import { expect } from "vitest";

import {
  isEnginePoolError,
  type EngineEventKind,
  type EngineEventMap,
  type EnginePoolError,
  type EnginePoolErrorCode,
  type EngineProcess,
  type SpawnRequest,
  type Spawner,
  type StopSignal,
} from "../src/index.js";

/** Deterministic epoch-ms clock: the only time source in these tests. */
export class ManualClock {
  #now: number;

  constructor(startAtMs = 1_700_000_000_000) {
    this.#now = startAtMs;
  }

  now = (): number => this.#now;

  advance = (ms: number): void => {
    this.#now += ms;
  };
}

export type StartBehavior = "resolve" | "reject";
export type StopBehavior = "resolve" | "hang";

let nextPid = 4242;

/** In-memory stand-in for one `photocraft-cli serve` process. */
export class FakeEngineProcess implements EngineProcess {
  readonly pid = nextPid++;
  readonly spawnRequest: SpawnRequest;
  readonly startCalls: SpawnRequest[] = [];
  readonly stopCalls: StopSignal[] = [];
  startBehavior: StartBehavior = "resolve";
  stopBehavior: StopBehavior = "resolve";
  readonly #handlers = new Map<
    EngineEventKind,
    Array<(event: EngineEventMap[EngineEventKind]) => void>
  >();

  constructor(request: SpawnRequest) {
    this.spawnRequest = request;
  }

  async start(request: SpawnRequest): Promise<void> {
    this.startCalls.push(request);
    if (this.startBehavior === "reject") {
      throw new Error("fake: engine never became ready (secret path /opt/internal/bin)");
    }
    this.#emit("ready", { kind: "ready" });
  }

  async stop(signal: StopSignal = "SIGTERM"): Promise<void> {
    this.stopCalls.push(signal);
    if (this.stopBehavior === "hang") {
      // A stop that never settles: the signal is ignored until the grace window ends.
      return await new Promise<void>(() => undefined);
    }
    this.#emit("exit", { kind: "exit", code: 0, signal });
  }

  onEvent<K extends EngineEventKind>(
    kind: K,
    handler: (event: EngineEventMap[K]) => void,
  ): void {
    const list = this.#handlers.get(kind) ?? [];
    list.push(handler as (event: EngineEventMap[EngineEventKind]) => void);
    this.#handlers.set(kind, list);
  }

  /** Simulate an out-of-band death (OOM kill, segfault): crash + exit events. */
  crash(code = 137): void {
    this.#emit("crash", { kind: "crash", reason: "fake: watchdog oom kill" });
    this.#emit("exit", { kind: "exit", code, signal: null });
  }

  #emit<K extends EngineEventKind>(kind: K, event: EngineEventMap[K]): void {
    for (const handler of this.#handlers.get(kind) ?? []) {
      handler(event);
    }
  }
}

/** Records spawn requests and hands out controllable fake processes. */
export class FakeSpawner implements Spawner {
  readonly requests: SpawnRequest[] = [];
  readonly processes: FakeEngineProcess[] = [];
  spawnBehavior: "ok" | "throw" = "ok";
  startBehavior: StartBehavior = "resolve";
  stopBehavior: StopBehavior = "resolve";

  spawn(request: SpawnRequest): FakeEngineProcess {
    this.requests.push(request);
    if (this.spawnBehavior === "throw") {
      throw new Error("fake: engine binary missing at /opt/secret/engine");
    }
    const process = new FakeEngineProcess(request);
    process.startBehavior = this.startBehavior;
    process.stopBehavior = this.stopBehavior;
    this.processes.push(process);
    return process;
  }
}

/** Assert a sync call throws a typed pool error with the expected code. */
export function expectEnginePoolError(
  call: () => unknown,
  code: EnginePoolErrorCode,
): EnginePoolError {
  try {
    call();
  } catch (error) {
    return assertPoolError(error, code);
  }
  throw new Error(`expected EnginePoolError ${code}, but nothing was thrown`);
}

/** Assert an async call rejects with a typed pool error with the expected code. */
export async function expectEnginePoolReject(
  call: Promise<unknown>,
  code: EnginePoolErrorCode,
): Promise<EnginePoolError> {
  try {
    await call;
  } catch (error) {
    return assertPoolError(error, code);
  }
  throw new Error(`expected EnginePoolError ${code}, but the promise resolved`);
}

function assertPoolError(error: unknown, code: EnginePoolErrorCode): EnginePoolError {
  if (!isEnginePoolError(error)) {
    throw new Error(`expected EnginePoolError ${code}, got: ${String(error)}`);
  }
  expect(error.code).toBe(code);
  const envelope = error.toEnvelope();
  expect(envelope.ok).toBe(false);
  expect(envelope.code).toBe(code);
  expect(typeof envelope.message).toBe("string");
  return error;
}
