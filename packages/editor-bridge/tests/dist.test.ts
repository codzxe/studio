/**
 * Dist-surface contract tests (M3.2 / BUILD_PLAN §M3 task 8).
 *
 * These mount `window.studioEngine` + `window.studioEngineLoad` EXACTLY the way
 * the shipped dist defines them (`apps/web/public/editor/index.html`, from
 * `editor/apps/studio-web/web/index.html` — READ-ONLY, verified against
 * `editor/apps/studio-web/src/api.rs`):
 *
 * - `window.studioEngineLoad = {}` synchronously, then `wasmMs` after the wasm
 *   module compiles, then `readyMs` after `ec.start()` returns; on failure
 *   `error = String(e)` and never `readyMs` (the boot order of the inline
 *   module script).
 * - `window.studioEngine` is a synchronous object literal with the 15 methods
 *   (`request`, `execute`, `commands`, `inspect`, `screenshot`, `renderFrame`,
 *   `files`, `readFile`, `addFile`, `info`, `saveToBrowser`, `listStored`,
 *   `removeStored`, `flush`, `workerFrameCheck`), `execute` routing through
 *   `ec.request("engine.execute", {command, params})`, `info()` carrying the
 *   dist's key set (`version` from CARGO_PKG_VERSION = 0.13.0, `threads`,
 *   `workers`, `audio`, `crossOriginIsolated`, `webgpu`, `serviceWorker`,
 *   `load: window.studioEngineLoad`).
 * - Startup rejections from api.rs are plain strings; the de-branded dist
 *   rejects "Studio is not running yet".
 *
 * The engine behavior behind the harness is the deterministic fake editor
 * (`createFakeEditor`, version forced to the dist's "0.13.0"), so the tests
 * stay no-network and deterministic while every shape is the dist's.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { attachEditorBridge, editorLoadState } from "../src/bridge";
import { type BridgeError, isBridgeError } from "../src/errors";
import { type FakeEditor, createFakeEditor } from "../src/fake";
import type { StudioEngineGlobal, StudioEngineWindow } from "../src/types";
import { ProjectSummarySchema } from "../src/types";

const DIST_VERSION = "0.13.0"; // editor/Cargo.toml [workspace] version → info().version

/**
 * The dist owns `studioEngineLoad` and writes to it as the boot progresses
 * (`StudioEngineLoad`'s props are read-only for bridge *consumers*); the test
 * harness plays the dist, so it gets the writable view.
 */
interface WritableEffectcraftLoad {
  wasmMs?: number;
  readyMs?: number;
  error?: string;
}

function loadOf(w: StudioEngineWindow): WritableEffectcraftLoad {
  if (!w.studioEngineLoad) {
    w.studioEngineLoad = {};
  }
  return w.studioEngineLoad as WritableEffectcraftLoad;
}

function makeIframe(src = "/editor/"): HTMLIFrameElement {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("src", src);
  document.body.appendChild(iframe);
  return iframe;
}

function editorWindow(iframe: HTMLIFrameElement): StudioEngineWindow {
  const w = iframe.contentWindow as StudioEngineWindow | null;
  if (!w) throw new Error("no contentWindow");
  return w;
}

/**
 * The dist's inline module script, backed by the fake editor: installs
 * `window.studioEngineLoad = {}` and the synchronous `window.studioEngine`
 * object literal with the dist's exact method set and info() shape. The boot
 * then has to be driven with {@link boot} (the dist awaits wasm compile +
 * `ec.start()` before setting the timings).
 */
function mountDistEditor(fake: FakeEditor = createFakeEditor({ version: DIST_VERSION })): {
  iframe: HTMLIFrameElement;
  fake: FakeEditor;
  w: StudioEngineWindow;
} {
  const iframe = makeIframe();
  const w = editorWindow(iframe);
  w.studioEngineLoad = {}; // dist: `window.studioEngineLoad = {};`
  const ec: StudioEngineGlobal = {
    request: (method, params) => fake.request(method, params ?? {}),
    execute: (command, params) => fake.request("engine.execute", { command, params: params ?? {} }),
    commands: () => fake.request("engine.commands", {}),
    inspect: () => fake.request("ui.inspect", {}),
    screenshot: (params) => fake.request("ui.screenshot", params ?? {}),
    renderFrame: (params) => fake.request("render.frame", { base64: true, ...(params ?? {}) }),
    files: () => fake.files(),
    readFile: (path) => fake.readFile(path),
    addFile: (fileOrUrl, name) => fake.addFile(fileOrUrl, name),
    // The dist spreads ec.info() and adds the browser facts + `load: window.studioEngineLoad`.
    info: () => ({
      ...((fake.info() as Record<string, unknown>) ?? {}),
      crossOriginIsolated: true,
      webgpu: false,
      serviceWorker: false,
      load: w.studioEngineLoad,
    }),
    saveToBrowser: (path) => fake.saveToBrowser(path ?? undefined),
    listStored: () => fake.listStored(),
    removeStored: (path) => fake.removeStored(path),
    flush: () => fake.flush(),
    workerFrameCheck: (params) => fake.workerFrameCheck(params ?? {}),
  };
  // The CURRENT dist defines `window.studioEngine = {...}` (the w3-A
  // de-effectcraft rename). This mount used to install the fake under the
  // pre-rename `effectcraft` while claiming to mirror the dist — which hid
  // the rename drift that broke every real attach (bridge now accepts both
  // names; this test exercises the real one).
  w.studioEngine = ec;
  return { iframe, fake, w };
}

// The engine-global name(s) the shipped dist actually defines. The bridge
// reads `window.studioEngine ?? window.effectcraft` (src/bridge.ts engineOf);
// if the dist renames the global again, THIS is the test that fails first.
function distGlobalNames(): string[] {
  // Vitest transforms import.meta.url in the jsdom environment, so resolve
  // from the package cwd (tests run with cwd = packages/editor-bridge).
  const candidates = [resolve(process.cwd(), "../../apps/web/public/editor/index.html")];
  const distPath = candidates.find((c) => existsSync(c));
  const html = distPath ? readFileSync(distPath, "utf8") : "";
  const names: string[] = [];
  if (/window\.studioEngine\s*=/.test(html)) names.push("studioEngine");
  if (/window\.effectcraft\s*=/.test(html)) names.push("effectcraft");
  return names;
}

/** Drive the dist's boot sequence: wasm compile → start, or start failure. */
function boot(
  w: StudioEngineWindow,
  outcome: { wasmMs: number; readyMs: number } | { wasmMs: number; error: string } = {
    wasmMs: 420,
    readyMs: 1337,
  },
): void {
  const load = loadOf(w);
  load.wasmMs = outcome.wasmMs;
  if ("readyMs" in outcome) {
    load.readyMs = outcome.readyMs;
  } else {
    // dist: `window.studioEngineLoad.error = String(e); throw e;`
    load.error = outcome.error;
  }
}

afterAll(() => {
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------
// editorLoadState — the M3.7 failure seam
// ---------------------------------------------------------------------------

describe("shipped-dist drift gate (the engine global name)", () => {
  it("the committed dist defines a global the bridge reads (studioEngine | effectcraft)", () => {
    const names = distGlobalNames();
    expect(
      names.length > 0,
      `apps/web/public/editor/index.html defines none of window.studioEngine / window.effectcraft — the bridge's engineOf() would never attach (this is exactly how the w3-A rename broke every real editor boot while these tests stayed green)`,
    ).toBe(true);
  });

  it("the bridge attaches to the CURRENT dist's global name (studioEngine), not just the pre-rename one", async () => {
    // The mount under `studioEngine` (mountDistEditor) must be enough — no
    // `effectcraft` fallback present on the window at all.
    const { iframe, fake, w } = mountDistEditor();
    expect(w.studioEngine).toBeDefined();
    expect(w.effectcraft).toBeUndefined();
    boot(w);
    const bridge = await attachEditorBridge(iframe);
    expect(bridge.version()).toContain(DIST_VERSION);
    // A real request round-trip proves the CALL layer resolves the same
    // global the handshake did (both used to read `effectcraft` only).
    const commands = await bridge.request("engine.commands", {});
    expect(commands).toBeDefined();
    bridge.dispose();
    iframe.remove();
  });
});

describe("editorLoadState: the dist's boot sequence", () => {
  it("is 'loading' before the dist's globals exist", () => {
    const iframe = makeIframe();
    expect(editorLoadState(iframe)).toEqual({ status: "loading" });
    iframe.remove();
  });

  it("tracks loading → readyMs: ready (the dist's success order)", () => {
    const { iframe, w } = mountDistEditor();
    const load = loadOf(w);
    expect(editorLoadState(iframe)).toEqual({ status: "loading" }); // studioEngineLoad = {}
    load.wasmMs = 420; // wasm module compiled, start() pending
    expect(editorLoadState(iframe)).toEqual({ status: "loading", wasmMs: 420 });
    load.readyMs = 1337; // ec.start() returned
    expect(editorLoadState(iframe)).toEqual({
      status: "ready",
      wasmMs: 420,
      readyMs: 1337,
    });
    iframe.remove();
  });

  it("is 'failed' with the dist's error the moment the wasm boots into a throw", () => {
    const { iframe, w } = mountDistEditor();
    const load = loadOf(w);
    load.wasmMs = 420;
    load.error = "CompileError: WebAssembly.instantiate(): failed to magically compile";
    expect(editorLoadState(iframe)).toEqual({
      status: "failed",
      error: "CompileError: WebAssembly.instantiate(): failed to magically compile",
      wasmMs: 420,
      readyMs: undefined,
    });
    iframe.remove();
  });
});

// ---------------------------------------------------------------------------
// attachEditorBridge against the dist-shaped global
// ---------------------------------------------------------------------------

describe("attachEditorBridge × shipped dist surface", () => {
  it("attaches to the dist global: version 0.13.0, dist info() shape, sticky ready payload", async () => {
    const events: Array<[string, unknown]> = [];
    const { iframe, w } = mountDistEditor();
    const attach = attachEditorBridge(iframe, {
      version: DIST_VERSION,
      onEvent: (event, payload) => events.push([event, payload]),
    });
    boot(w, { wasmMs: 420, readyMs: 1337 });
    const bridge = await attach;

    // The version guard must not false-positive on the shipped dist (0.13.0).
    expect(events.map(([name]) => name)).toEqual(["ready"]);
    expect(bridge.version()).toBe("0.13.0");

    const info = bridge.info();
    expect(info.version).toBe("0.13.0");
    // the dist's info().load is window.studioEngineLoad; the bridge re-reads it
    // from the window (authoritative) — values must match the booted state
    expect(info.load).toMatchObject({ wasmMs: 420, readyMs: 1337 });
    // the dist's info() extras pass through the loose schema
    const raw = w.studioEngine?.info() as Record<string, unknown>;
    expect(raw.crossOriginIsolated).toBe(true);
    expect(raw.serviceWorker).toBe(false);

    expect((events[0]?.[1] as { readyMs?: number }).readyMs).toBe(1337);
    iframe.remove();
  });

  it("rejects with EDITOR_LOAD_FAILED when the dist's start() throws (and emits the bus error pre-attach)", async () => {
    const events: Array<[string, unknown]> = [];
    const { iframe, w } = mountDistEditor();
    const attach = attachEditorBridge(iframe, {
      onEvent: (event, payload) => events.push([event, payload]),
    });
    boot(w, { wasmMs: 500, error: "TypeError: NetworkError when attempting to fetch resource." });
    const err = await attach.then(
      () => {
        throw new Error("should not resolve");
      },
      (e: unknown) => e,
    );
    expect(isBridgeError(err)).toBe(true);
    expect((err as BridgeError).code).toBe("EDITOR_LOAD_FAILED");
    expect((err as BridgeError).retryable).toBe(false);
    expect((err as BridgeError).message).toContain("NetworkError");
    expect(editorLoadState(iframe).status).toBe("failed");

    // the pre-attach onEvent handler saw the failure on the bus
    expect(events.length).toBe(1);
    expect(events[0]?.[0]).toBe("error");
    expect((events[0]?.[1] as BridgeError).code).toBe("EDITOR_LOAD_FAILED");
    iframe.remove();
  });

  it("ready() rejects with EDITOR_LOAD_FAILED after the editor reloads into a failed boot", async () => {
    const { iframe, w } = mountDistEditor();
    boot(w, { wasmMs: 420, readyMs: 1337 });
    const bridge = await attachEditorBridge(iframe);

    // The editor page reloads and this boot fails: fresh load object with error only.
    w.studioEngineLoad = { wasmMs: 10, error: "Unreachable: editor dist gone" };
    const err = await bridge.ready().then(
      () => {
        throw new Error("should not resolve");
      },
      (e: unknown) => e,
    );
    expect(isBridgeError(err)).toBe(true);
    expect((err as BridgeError).code).toBe("EDITOR_LOAD_FAILED");
    expect(editorLoadState(iframe)).toMatchObject({
      status: "failed",
      error: "Unreachable: editor dist gone",
    });
    iframe.remove();
  });

  it("accepts the dist's 0.13.x version against a '0.13' guard (no false positive)", async () => {
    const { iframe, w } = mountDistEditor(createFakeEditor({ version: "0.13.1" }));
    const events: Array<[string, unknown]> = [];
    const attach = attachEditorBridge(iframe, {
      version: "0.13",
      onEvent: (event, payload) => events.push([event, payload]),
    });
    boot(w, { wasmMs: 1, readyMs: 2 });
    const bridge = await attach;
    expect(bridge.version()).toBe("0.13.1");
    expect(events.map(([name]) => name)).toEqual(["ready"]); // mismatch would emit "error"
    iframe.remove();
  });

  it("still surfaces a real version mismatch as an error event (guard works)", async () => {
    const { iframe, w } = mountDistEditor(createFakeEditor({ version: "0.14.0" }));
    const events: Array<[string, unknown]> = [];
    const attach = attachEditorBridge(iframe, {
      version: DIST_VERSION,
      onEvent: (event, payload) => events.push([event, payload]),
    });
    boot(w, { wasmMs: 1, readyMs: 2 });
    const bridge = await attach;
    expect(bridge.version()).toBe("0.14.0");
    expect(events.map(([name]) => name)).toEqual(["ready", "error"]);
    expect((events[1]?.[1] as Error).message).toContain("0.14.0");
    iframe.remove();
  });
});

// ---------------------------------------------------------------------------
// Error normalization against the dist's api.rs strings
// ---------------------------------------------------------------------------

describe("dist api.rs error strings", () => {
  it("retries the de-branded 'Studio is not running yet' startup rejection once", async () => {
    vi.useFakeTimers();
    const { iframe, w } = mountDistEditor();
    // Dist fidelity: api.rs's request() rejects with the plain string while the
    // control channel is down — the bridge must retry it exactly once.
    const ec = w.studioEngine;
    if (!ec) throw new Error("no studioEngine");
    const original = ec.request.bind(ec);
    let calls = 0;
    ec.request = (method: string, params?: unknown) => {
      calls++;
      if (calls === 1) return Promise.reject("Studio is not running yet");
      return original(method, params);
    };
    boot(w, { wasmMs: 420, readyMs: 1337 });
    const bridge = await attachEditorBridge(iframe);
    const p = bridge.request<Array<unknown>>("engine.commands", {});
    await vi.advanceTimersByTimeAsync(300); // > RETRY_DELAY_MS
    const result = await p;
    expect(Array.isArray(result)).toBe(true); // resolved on the retry
    expect(calls).toBe(2);
    vi.useRealTimers();
    iframe.remove();
  });

  it("maps 'request dropped' to EDITOR_DISCONNECTED (channel disconnect)", async () => {
    const { iframe, w } = mountDistEditor();
    boot(w, { wasmMs: 420, readyMs: 1337 });
    const ec = w.studioEngine;
    if (!ec) throw new Error("no studioEngine");
    ec.request = () => Promise.reject("request dropped");
    const bridge = await attachEditorBridge(iframe);
    const err = (await bridge.request("engine.commands", {}).then(
      () => {
        throw new Error("no");
      },
      (e: unknown) => e,
    )) as BridgeError;
    expect(err.code).toBe("EDITOR_DISCONNECTED");
    expect(err.retryable).toBe(true);
    iframe.remove();
  });
});

// ---------------------------------------------------------------------------
// M3.3/M3.4 surface: saveToBrowser / readFile / addAsset / project.summary.dirty
// ---------------------------------------------------------------------------

describe("dist surface for load-sequence + autosave (M3.3/M3.4)", () => {
  it("project.summary carries the dirty flag through the dist mount (M3.4 source of truth)", async () => {
    const { iframe, w } = mountDistEditor();
    boot(w);
    const bridge = await attachEditorBridge(iframe);
    const before = ProjectSummarySchema.parse(await bridge.query("project.summary"));
    expect(before.dirty).toBe(false);

    await bridge.execute("comp.new", { name: "Main" });
    const after = ProjectSummarySchema.parse(await bridge.query("project.summary"));
    expect(after.dirty).toBe(true); // upstream query.rs: `"dirty": s.is_dirty()`

    const saved = await bridge.saveToBrowser("/cloud/project.ecproj"); // {path, bytes} (file.rs save_to)
    expect(saved.path).toBe("/cloud/project.ecproj");
    expect(saved.bytes).toBeGreaterThan(0);
    const bytes = await bridge.readFile("/cloud/project.ecproj");
    expect(bytes.byteLength).toBe(saved.bytes);
    iframe.remove();
  });

  it("addAsset lands the cloud asset under a path the editor actually assigned", async () => {
    const { iframe, w } = mountDistEditor();
    boot(w);
    const bridge = await attachEditorBridge(iframe);
    const path = await bridge.addAsset({
      assetId: "ast_123",
      name: "hero v2.png",
      bytes: new TextEncoder().encode("png-bytes"),
    });
    // upstream path_for basenames /assets/<id>/<name> → /<name>
    expect(path).toBe("/hero-v2.png");
    const bytes = await bridge.readFile(path);
    expect(new TextDecoder().decode(bytes)).toBe("png-bytes");
    iframe.remove();
  });
});
