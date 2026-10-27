/**
 * `attachFakeBridge` — adapt a `FakeEditor` (src/fake.ts) to the `EditorBridge`
 * interface, synchronously, without a DOM iframe. Test-only export (exposed
 * via `@studio/editor-bridge/fake`).
 *
 * The adapter goes through the same typed surface as the real bridge — no
 * `any`, results validated with the same Zod schemas — so tests written
 * against the fake exercise the production types and parsing too.
 */

import { z } from "zod";
import { type AgentBatch, normalizeAgentBatch } from "./batch";
import { BridgeError, messageOf } from "./errors";
import type { FakeEditor } from "./fake";
import {
  type AppCapabilities,
  AppCapabilitiesSchema,
  type BatchResult,
  BatchResultSchema,
  type CloudAsset,
  type CommandInfo,
  CommandInfoSchema,
  type CommandSchema,
  CommandSchemaSchema,
  type EditorBridge,
  type EditorEventHandler,
  type EditorEventName,
  type EditorInfo,
  EditorInfoSchema,
  type StudioEngineLoad,
  StudioEngineLoadInfoSchema,
  type RenderFrameParams,
  type RenderFrameResult,
  RenderFrameResultSchema,
  SaveResultSchema,
  type ScreenshotParams,
  type ScreenshotResult,
  ScreenshotResultSchema,
  type UiInspect,
  UiInspectSchema,
} from "./types";

export interface FakeBridgeOptions {
  /** Simulate load timings in `info().load` (defaults: 42 / 64 ms). */
  readonly load?: Partial<StudioEngineLoad>;
}

function parseOr<T>(schema: z.ZodType<T>, label: string, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (err) {
    throw new BridgeError(
      "EDITOR_CALL_FAILED",
      `${label}: unexpected fake result (${messageOf(err)})`,
      false,
      err,
    );
  }
}

/**
 * Synchronous `EditorBridge` over an in-memory `FakeEditor`.
 *
 * - `ready()` resolves immediately (the fake is always ready).
 * - `on("ready")` replays the sticky ready payload; `on("focus")`/`on("resize")`
 *   never fire (the fake has no window to listen to); `on("error")` fires for
 *   every rejected call.
 * - `dispose()` drops all listeners; later calls fail with `EDITOR_DISCONNECTED`.
 */
export function attachFakeBridge(fake: FakeEditor, opts: FakeBridgeOptions = {}): EditorBridge {
  const listeners = new Map<EditorEventName, Set<EditorEventHandler>>();
  let disposed = false;
  let stickyReady: { payload: unknown } | null = null;
  const load: StudioEngineLoad = {
    wasmMs: opts.load?.wasmMs ?? 42,
    readyMs: opts.load?.readyMs ?? 64,
  };

  const emit = (event: EditorEventName, payload: unknown): void => {
    for (const cb of [...(listeners.get(event) ?? [])]) cb(payload);
  };

  const on = (event: EditorEventName, cb: EditorEventHandler): (() => void) => {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(cb);
    if (event === "ready" && stickyReady) cb(stickyReady.payload);
    return () => {
      set?.delete(cb);
    };
  };

  async function call<T>(label: string, run: () => Promise<T> | T, timeoutMs?: number): Promise<T> {
    // The fake answers instantly — `timeoutMs` is accepted for signature
    // parity with the real bridge and deliberately ignored (nothing to wait on).
    void timeoutMs;
    if (disposed) {
      throw new BridgeError("EDITOR_DISCONNECTED", `${label}: bridge is disposed`, false);
    }
    try {
      return await run();
    } catch (err) {
      const bridgeErr = new BridgeError(
        "EDITOR_CALL_FAILED",
        `${label}: ${messageOf(err)}`,
        false,
        err,
      );
      emit("error", bridgeErr);
      throw bridgeErr;
    }
  }

  const bridge: EditorBridge = {
    ready(): Promise<void> {
      return call("ready", () => undefined);
    },

    inspect(): Promise<UiInspect> {
      return call("inspect", async () => parseOr(UiInspectSchema, "inspect", await fake.inspect()));
    },

    commands(filter?: string): Promise<CommandInfo[]> {
      return call("commands", async () =>
        parseOr(
          z.array(CommandInfoSchema),
          "commands",
          await fake.request("engine.commands", filter === undefined ? {} : { filter }),
        ),
      );
    },

    describe(command: string): Promise<CommandSchema> {
      return call("describe", async () =>
        parseOr(
          CommandSchemaSchema,
          "describe",
          await fake.execute("command.describe", { command }),
        ),
      );
    },

    query<T = unknown>(command: string, params?: unknown): Promise<T> {
      return call(`query ${command}`, async () => (await fake.execute(command, params ?? {})) as T);
    },

    execute<T = unknown>(
      command: string,
      params?: unknown,
      opts?: { readonly timeoutMs?: number },
    ): Promise<T> {
      // The fake answers instantly; opts.timeoutMs is accepted for signature
      // parity with the real bridge (and honored where call() supports it).
      return call(
        `execute ${command}`,
        async () => (await fake.execute(command, params ?? {})) as T,
        opts?.timeoutMs,
      );
    },

    request<T = unknown>(method: string, params?: unknown): Promise<T> {
      return call(`request ${method}`, async () => (await fake.request(method, params ?? {})) as T);
    },

    async batch(input: Parameters<EditorBridge["batch"]>[0]): Promise<BatchResult> {
      let parsed: AgentBatch;
      try {
        parsed = normalizeAgentBatch(input); // §8.5 bounds + refs, via @studio/contracts
      } catch (err) {
        const bridgeErr = new BridgeError(
          "EDITOR_CALL_FAILED",
          `invalid agent batch: ${messageOf(err)}`,
          false,
          err,
        );
        emit("error", bridgeErr);
        throw bridgeErr;
      }
      return call(`batch ${JSON.stringify(parsed.label)}`, async () =>
        parseOr(
          BatchResultSchema,
          "batch",
          await fake.execute("engine.batch", {
            label: parsed.label,
            atomic: true,
            steps: parsed.steps,
          }),
        ),
      );
    },

    renderFrame(params: RenderFrameParams): Promise<RenderFrameResult> {
      return call("renderFrame", async () =>
        parseOr(RenderFrameResultSchema, "renderFrame", await fake.renderFrame(params)),
      );
    },

    addFile(file: Blob | File | string, name?: string): Promise<string> {
      return call("addFile", async () =>
        parseOr(z.string(), "addFile", await fake.addFile(file, name)),
      );
    },

    async addAsset(asset: CloudAsset): Promise<string> {
      if (asset.bytes === undefined) {
        const bridgeErr = new BridgeError(
          "EDITOR_CALL_FAILED",
          "addAsset: the fake editor needs `bytes` (it does not fetch)",
          false,
        );
        emit("error", bridgeErr);
        throw bridgeErr;
      }
      const name = `${asset.assetId}-${asset.name}`
        .replace(/[/\\]/g, "-")
        .replace(/[^A-Za-z0-9._-]+/g, "-");
      const blob =
        asset.bytes instanceof Blob
          ? asset.bytes
          : new Blob([new Uint8Array(asset.bytes)], { type: "application/octet-stream" });
      return call("addAsset", async () =>
        parseOr(z.string(), "addAsset", await fake.addFile(blob, name)),
      );
    },

    saveToBrowser(path: string): Promise<{ path: string; bytes: number }> {
      return call("saveToBrowser", async () =>
        parseOr(SaveResultSchema, "saveToBrowser", await fake.saveToBrowser(path)),
      );
    },

    readFile(path: string): Promise<Uint8Array> {
      return call("readFile", () => {
        const bytes = fake.readFile(path);
        if (bytes === undefined) {
          throw new BridgeError(
            "EDITOR_CALL_FAILED",
            `readFile: no file at ${JSON.stringify(path)}`,
            false,
          );
        }
        return bytes;
      });
    },

    screenshot(params?: ScreenshotParams): Promise<ScreenshotResult> {
      return call("screenshot", async () =>
        parseOr(ScreenshotResultSchema, "screenshot", await fake.screenshot(params ?? {})),
      );
    },

    on,

    version(): string {
      const info = parseOr(EditorInfoSchema, "info", fake.info());
      return info.version;
    },

    info(): EditorInfo {
      const info = parseOr(EditorInfoSchema, "info", fake.info());
      return { ...info, load: parseOr(StudioEngineLoadInfoSchema, "info.load", load) };
    },

    capabilities(): Promise<AppCapabilities> {
      return call("capabilities", async () =>
        parseOr(AppCapabilitiesSchema, "capabilities", await fake.execute("app.capabilities")),
      );
    },

    dispose(): void {
      disposed = true;
      listeners.clear();
    },
  };

  // "ready" is sticky (replayed to late subscribers); no listener can exist
  // before this function returns, so no emit is needed.
  stickyReady = {
    payload: { readyMs: load.readyMs, wasmMs: load.wasmMs, version: bridge.version() },
  };
  return bridge;
}
