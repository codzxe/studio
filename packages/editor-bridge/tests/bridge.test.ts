/**
 * Bridge tests: handshake, timeouts, retry, error normalization, batch
 * validation, events, shortcut forwarding — against a jsdom iframe with the
 * FakeEditor (or hand-rolled stubs) installed as `window.effectcraft`.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AttachOptions, attachEditorBridge, forwardShortcut } from "../src/bridge";
import { type BridgeError, isBridgeError } from "../src/errors";
import { type FakeEditor, createFakeEditor } from "../src/fake";
import type { EffectcraftGlobal, EffectcraftWindow } from "../src/types";

function makeIframe(src = "/editor/"): HTMLIFrameElement {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("src", src);
  document.body.appendChild(iframe);
  return iframe;
}

function editorWindow(iframe: HTMLIFrameElement): EffectcraftWindow {
  const w = iframe.contentWindow as EffectcraftWindow | null;
  if (!w) throw new Error("no contentWindow");
  return w;
}

/** Install the fake (or a stub) as the iframe's `window.effectcraft`. */
function install(
  iframe: HTMLIFrameElement,
  effectcraft: EffectcraftGlobal | FakeEditor,
  load: { wasmMs?: number; readyMs?: number; error?: string } = { wasmMs: 1, readyMs: 2 },
): void {
  const w = editorWindow(iframe);
  w.effectcraft = effectcraft as EffectcraftGlobal;
  w.effectcraftLoad = load;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(() => {
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

describe("attachEditorBridge: handshake", () => {
  it("resolves once effectcraftLoad.readyMs is set; ready() is idempotent", async () => {
    const iframe = makeIframe();
    const fake = createFakeEditor();
    const attach = attachEditorBridge(iframe);
    install(iframe, fake);
    const bridge = await attach;
    expect(bridge).toBeDefined();
    await expect(bridge.ready()).resolves.toBe(undefined);
    expect(bridge.version()).toBe("0.13.0-fake");
    iframe.remove();
  });

  it("emits the ready event (sticky, with load timings) to late subscribers", async () => {
    const seen: Array<[string, unknown]> = [];
    const iframe = makeIframe();
    const attach = attachEditorBridge(iframe, {
      onEvent: (event, payload) => seen.push([event, payload]),
    });
    install(iframe, createFakeEditor(), { wasmMs: 33, readyMs: 44 });
    const bridge = await attach;
    expect(seen.length).toBe(1);
    expect(seen[0]?.[0]).toBe("ready");
    expect(seen[0]?.[1]).toMatchObject({ readyMs: 44, wasmMs: 33, version: "0.13.0-fake" });

    // sticky: a listener registered after attach still sees it, exactly once
    const replayed: unknown[] = [];
    bridge.on("ready", (p) => replayed.push(p));
    expect(replayed.length).toBe(1);
    await bridge.ready();
    expect(replayed.length).toBe(1); // ready() must not re-emit
    iframe.remove();
  });

  it("rejects with EDITOR_LOAD_FAILED when the editor failed to start", async () => {
    const iframe = makeIframe();
    const attach = attachEditorBridge(iframe);
    install(iframe, createFakeEditor(), { error: "wasm compile failed" });
    const err = await attach.then(
      () => {
        throw new Error("should not resolve");
      },
      (e: unknown) => e,
    );
    expect(isBridgeError(err)).toBe(true);
    expect((err as BridgeError).code).toBe("EDITOR_LOAD_FAILED");
    expect((err as BridgeError).retryable).toBe(false);
    expect((err as BridgeError).message).toContain("wasm compile failed");
    iframe.remove();
  });

  it("rejects with EDITOR_NOT_READY on handshake timeout (polls until the deadline)", async () => {
    vi.useFakeTimers();
    const iframe = makeIframe(); // never installed
    const attach = attachEditorBridge(iframe, { readyTimeoutMs: 300 });
    const expectation = expect(attach).rejects.toMatchObject({
      code: "EDITOR_NOT_READY",
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(500);
    await expectation;
    iframe.remove();
  });

  it("supports an optional ready() hook instead of readyMs", async () => {
    vi.useFakeTimers();
    const iframe = makeIframe();
    const fake = createFakeEditor();
    const withReady = {
      ...fake,
      ready: () => new Promise<void>((resolve) => setTimeout(resolve, 10)),
    } as EffectcraftGlobal & { ready: () => Promise<void> };
    install(iframe, withReady, {}); // no readyMs — the hook must be used
    const attach = attachEditorBridge(iframe, { readyTimeoutMs: 1000 });
    const bridge = await vi.advanceTimersByTimeAsync(50).then(() => attach);
    expect(bridge.version()).toBe("0.13.0-fake");
    vi.useRealTimers();
    iframe.remove();
  });
});

// ---------------------------------------------------------------------------
// Timeouts, retries, normalized errors
// ---------------------------------------------------------------------------

/** A minimal effectcraft stub with overridable behaviors. */
function stubEffectcraft(behavior: {
  execute?: (command: string, params?: unknown) => unknown;
  request?: (method: string, params?: unknown) => unknown;
  inspect?: () => unknown;
  info?: () => unknown;
}): EffectcraftGlobal {
  const asy = <T>(v: T | Promise<T>): Promise<T> => Promise.resolve(v);
  return {
    request: (method, params) => asy(behavior.request?.(method, params) ?? {}),
    execute: (command, params) => {
      const out = behavior.execute?.(command, params);
      if (out === undefined) return Promise.resolve({});
      return asy(out);
    },
    commands: () => Promise.resolve([]),
    inspect: () => Promise.resolve(behavior.inspect?.() ?? {}),
    screenshot: () => Promise.resolve({}),
    renderFrame: () => Promise.resolve({}),
    files: () => [],
    readFile: () => undefined,
    addFile: () => Promise.resolve("/stub"),
    info: () => behavior.info?.() ?? { version: "9.9.9-stub" },
    saveToBrowser: () => Promise.resolve({ path: "/p", bytes: 1 }),
    listStored: () => Promise.resolve({}),
    removeStored: () => true,
    flush: () => Promise.resolve(),
    workerFrameCheck: () => Promise.resolve({}),
  };
}

describe("bridge calls: timeout / retry / errors", () => {
  it("times out a hanging call with EDITOR_TIMEOUT (retryable)", async () => {
    vi.useFakeTimers();
    const iframe = makeIframe();
    install(
      iframe,
      stubEffectcraft({
        execute: () => new Promise<unknown>(() => {}), // never settles
      }),
    );
    const bridge = await attachEditorBridge(iframe, { callTimeoutMs: 50 });
    const callP = bridge.query("project.summary");
    const expectation = expect(callP).rejects.toMatchObject({
      code: "EDITOR_TIMEOUT",
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(80);
    await expectation;
    iframe.remove();
  });

  it("retries once on a transient not-ready rejection and succeeds", async () => {
    vi.useFakeTimers();
    const iframe = makeIframe();
    let calls = 0;
    install(
      iframe,
      stubEffectcraft({
        execute: () => {
          calls++;
          if (calls === 1) throw "Studio is not running yet"; // the dist's api.rs string
          return { items: [] };
        },
      }),
    );
    const bridge = await attachEditorBridge(iframe);
    const callP = bridge.query<Record<string, unknown>>("project.summary");
    await vi.advanceTimersByTimeAsync(300); // > RETRY_DELAY_MS
    const result = await callP;
    expect(result).toEqual({ items: [] });
    expect(calls).toBe(2);
    iframe.remove();
  });

  it("classifies a persistent not-ready rejection as EDITOR_NOT_READY", async () => {
    vi.useFakeTimers();
    const iframe = makeIframe();
    let calls = 0;
    install(
      iframe,
      stubEffectcraft({
        execute: () => {
          calls++;
          throw "Studio is not running yet"; // the dist's api.rs string
        },
      }),
    );
    const bridge = await attachEditorBridge(iframe);
    const errors: unknown[] = [];
    bridge.on("error", (e) => errors.push(e));
    const callP = bridge.query("project.summary");
    const expectation = expect(callP).rejects.toMatchObject({ code: "EDITOR_NOT_READY" });
    await vi.advanceTimersByTimeAsync(300);
    await expectation;
    expect(calls).toBe(2); // retried exactly once
    expect(errors.length).toBe(1);
    expect(isBridgeError(errors[0])).toBe(true);
    iframe.remove();
  });

  it("maps 'request dropped' to EDITOR_DISCONNECTED and editor errors to EDITOR_CALL_FAILED", async () => {
    const iframe = makeIframe();
    install(
      iframe,
      stubEffectcraft({
        execute: (command: string) => {
          if (command === "dropper") throw "request dropped";
          if (command === "baddy") throw "invalid parameters for `prop.set`: missing `value`";
          return {};
        },
      }),
    );
    const bridge = await attachEditorBridge(iframe);
    const dropErr = (await bridge.query("dropper").then(
      () => {
        throw new Error("no");
      },
      (e: unknown) => e,
    )) as BridgeError;
    expect(dropErr.code).toBe("EDITOR_DISCONNECTED");
    expect(dropErr.retryable).toBe(true);

    const failErr = (await bridge.query("baddy").then(
      () => {
        throw new Error("no");
      },
      (e: unknown) => e,
    )) as BridgeError;
    expect(failErr.code).toBe("EDITOR_CALL_FAILED");
    expect(failErr.retryable).toBe(false);
    expect(failErr.message).toContain("missing `value`");
    expect(failErr.cause).toBe("invalid parameters for `prop.set`: missing `value`");
    iframe.remove();
  });

  it("rejects every call after dispose() with EDITOR_DISCONNECTED", async () => {
    const iframe = makeIframe();
    install(iframe, createFakeEditor());
    const bridge = await attachEditorBridge(iframe);
    bridge.dispose();
    const err = (await bridge.inspect().then(
      () => {
        throw new Error("no");
      },
      (e: unknown) => e,
    )) as BridgeError;
    expect(err.code).toBe("EDITOR_DISCONNECTED");
    iframe.remove();
  });

  it("rejects parse mismatches as EDITOR_CALL_FAILED", async () => {
    const iframe = makeIframe();
    install(iframe, stubEffectcraft({ inspect: () => ({ nowindow: true }) }));
    const bridge = await attachEditorBridge(iframe);
    const err = (await bridge.inspect().then(
      () => {
        throw new Error("no");
      },
      (e: unknown) => e,
    )) as BridgeError;
    expect(err.code).toBe("EDITOR_CALL_FAILED");
    expect(err.message).toContain("unexpected editor result");
    iframe.remove();
  });
});

// ---------------------------------------------------------------------------
// Batch validation (§8.5)
// ---------------------------------------------------------------------------

describe("bridge.batch: validation", () => {
  async function bridgeOf(
    fake?: FakeEditor,
  ): Promise<Awaited<ReturnType<typeof attachEditorBridge>>> {
    const iframe = makeIframe();
    install(iframe, fake ?? createFakeEditor());
    return attachEditorBridge(iframe);
  }

  it("rejects more than 100 steps", async () => {
    const bridge = await bridgeOf();
    const steps = Array.from({ length: 101 }, () => ({ command: "comp.new" }));
    const err = (await bridge.batch({ steps }).then(
      () => {
        throw new Error("no");
      },
      (e: unknown) => e,
    )) as BridgeError;
    expect(err.code).toBe("EDITOR_CALL_FAILED");
    expect(err.message).toContain("invalid agent batch");
  });

  it("accepts exactly 100 steps", async () => {
    const bridge = await bridgeOf(createFakeEditor({ failOn: {} }));
    const steps = Array.from({ length: 100 }, () => ({ command: "comp.new" }));
    const result = await bridge.batch({ label: "big", steps });
    expect(result.steps).toBe(100);
  });

  it("rejects a non-atomic batch (agent batches are atomic, §8.5)", async () => {
    const bridge = await bridgeOf();
    const err = (await bridge
      .batch({ steps: [{ command: "comp.new" }], atomic: false as unknown as true })
      .then(
        () => {
          throw new Error("no");
        },
        (e: unknown) => e,
      )) as BridgeError;
    expect(err.message).toContain("atomic");
  });

  it("rejects timeoutMs above the 60 s cap", async () => {
    const bridge = await bridgeOf();
    const err = (await bridge.batch({ steps: [{ command: "comp.new" }], timeoutMs: 61_000 }).then(
      () => {
        throw new Error("no");
      },
      (e: unknown) => e,
    )) as BridgeError;
    expect(err.message).toContain("timeoutMs");
  });

  it("rejects empty step lists", async () => {
    const bridge = await bridgeOf();
    const err = (await bridge.batch({ steps: [] }).then(
      () => {
        throw new Error("no");
      },
      (e: unknown) => e,
    )) as BridgeError;
    expect(err.message).toContain("invalid agent batch");
  });
});

// ---------------------------------------------------------------------------
// Events + version
// ---------------------------------------------------------------------------

describe("bridge events", () => {
  it("forwards focus/blur/resize from the iframe's window (no polling)", async () => {
    const iframe = makeIframe();
    install(iframe, createFakeEditor());
    const bridge = await attachEditorBridge(iframe);
    const events: Array<[string, unknown]> = [];
    const offFocus = bridge.on("focus", (p) => events.push(["focus", p]));
    const offResize = bridge.on("resize", (p) => events.push(["resize", p]));

    const w = editorWindow(iframe);
    w.dispatchEvent(new Event("focus"));
    w.dispatchEvent(new Event("blur"));
    w.dispatchEvent(new Event("resize"));
    expect(events.map(([name]) => name)).toEqual(["focus", "focus", "resize"]);
    expect((events[0]?.[1] as { focused: boolean }).focused).toBe(true);
    expect((events[1]?.[1] as { focused: boolean }).focused).toBe(false);
    const resize = events[2]?.[1] as { width: number; height: number };
    expect(typeof resize.width).toBe("number");
    expect(typeof resize.height).toBe("number");

    offFocus();
    offResize();
    w.dispatchEvent(new Event("resize"));
    expect(events.length).toBe(3);
    iframe.remove();
  });

  it("emits an error event on a version mismatch but still resolves", async () => {
    const events: Array<[string, unknown]> = [];
    const iframe = makeIframe();
    const attach = attachEditorBridge(iframe, {
      version: "0.12",
      onEvent: (event, payload) => events.push([event, payload]),
    });
    install(iframe, createFakeEditor({ version: "0.13.0-fake" }));
    const bridge = await attach;
    expect(bridge.version()).toBe("0.13.0-fake");
    expect(events.length).toBe(2);
    expect(events[0]?.[0]).toBe("ready");
    expect(events[1]?.[0]).toBe("error");
    expect((events[1]?.[1] as Error).message).toContain("0.13.0-fake");
    iframe.remove();
  });

  it("emits no error event when the version prefix matches", async () => {
    const events: Array<[string, unknown]> = [];
    const iframe = makeIframe();
    const attach = attachEditorBridge(iframe, {
      version: "0.13",
      onEvent: (event, payload) => events.push([event, payload]),
    });
    install(iframe, createFakeEditor({ version: "0.13.0-fake" }));
    const bridge = await attach;
    expect(bridge.version()).toBe("0.13.0-fake");
    expect(events.map(([name]) => name)).toEqual(["ready"]);
    iframe.remove();
  });
});

// ---------------------------------------------------------------------------
// forwardShortcut (EDITOR_CHAT_UX §9.2)
// ---------------------------------------------------------------------------

function keydown(w: Window, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { cancelable: true, ...init });
  w.dispatchEvent(event);
  return event;
}

describe("forwardShortcut", () => {
  it("forwards Cmd/Ctrl+L/K/I/. and Shift combos to callbacks", async () => {
    const iframe = makeIframe();
    const seen: string[] = [];
    forwardShortcut(iframe, {
      toggleChat: () => {
        seen.push("L");
      },
      inlineEdit: () => {
        seen.push("K");
      },
      agent: () => {
        seen.push("I");
      },
      stop: () => {
        seen.push(".");
      },
      newChat: () => {
        seen.push("shift+L");
      },
      undoAgentRun: () => {
        seen.push("shift+U");
      },
      escape: () => {
        seen.push("esc");
      },
      send: () => {
        seen.push("enter");
      },
    });
    const w = editorWindow(iframe);

    keydown(w, { key: "l", ctrlKey: true });
    keydown(w, { key: "l", metaKey: true });
    keydown(w, { key: "k", ctrlKey: true });
    keydown(w, { key: "i", metaKey: true });
    keydown(w, { key: ".", ctrlKey: true });
    keydown(w, { key: "l", ctrlKey: true, shiftKey: true });
    keydown(w, { key: "u", metaKey: true, shiftKey: true });
    keydown(w, { key: "Escape" });
    keydown(w, { key: "Enter", ctrlKey: true });

    expect(seen).toEqual(["L", "L", "K", "I", ".", "shift+L", "shift+U", "esc", "enter"]);
    iframe.remove();
  });

  it("does not forward unhandled keys, plain Shift+L, or alt-modified combos", async () => {
    const iframe = makeIframe();
    const seen: string[] = [];
    forwardShortcut(iframe, {
      toggleChat: () => {
        seen.push("L");
      },
      newChat: () => {
        seen.push("shift+L");
      },
    });
    const w = editorWindow(iframe);
    keydown(w, { key: "z", ctrlKey: true }); // editor's own undo
    keydown(w, { key: "l" }); // plain L (no modifier)
    keydown(w, { key: "l", shiftKey: true }); // Shift+L without Cmd/Ctrl
    keydown(w, { key: "l", ctrlKey: true, altKey: true }); // Alt combo → the editor's
    expect(seen).toEqual([]);
    iframe.remove();
  });

  it("prevents default on handled shortcuts, not when the handler declines", async () => {
    const iframe = makeIframe();
    forwardShortcut(iframe, {
      toggleChat: () => true,
      escape: () => false,
    });
    const w = editorWindow(iframe);
    const chat = keydown(w, { key: "l", ctrlKey: true });
    const esc = keydown(w, { key: "Escape" });
    expect(chat.defaultPrevented).toBe(true);
    expect(esc.defaultPrevented).toBe(false);
    iframe.remove();
  });

  it("the detach function removes the listener", async () => {
    const iframe = makeIframe();
    const seen: string[] = [];
    const detach = forwardShortcut(iframe, {
      toggleChat: () => {
        seen.push("L");
      },
    });
    const w = editorWindow(iframe);
    keydown(w, { key: "l", ctrlKey: true });
    detach();
    keydown(w, { key: "l", ctrlKey: true });
    expect(seen).toEqual(["L"]);
    iframe.remove();
  });
});

// ---------------------------------------------------------------------------
// End-to-end: the real bridge over the fake editor
// ---------------------------------------------------------------------------

describe("bridge over fake editor (end-to-end)", () => {
  it("runs §8.5's kinetic-title batch and reflects it in layer.tree", async () => {
    const iframe = makeIframe();
    install(iframe, createFakeEditor());
    const bridge = await attachEditorBridge(iframe);

    const result = await bridge.batch({
      label: "Agent: build kinetic title",
      steps: [
        { command: "comp.new", params: { name: "Main", width: 1920, height: 1080 } },
        { command: "layer.newSolid", params: { name: "Background", color: "#0B0D10" } },
        { command: "layer.rename", params: { layer: "$2.layer", name: "Background" } },
        {
          command: "prop.set",
          params: { layer: "$2.layer", path: "transform/opacity", value: 50 },
        },
      ],
    });
    expect(result.steps).toBe(4);

    const solid = result.results[1] as { layer: number };
    const tree = await bridge.query<Record<string, unknown>>("layer.tree", { layer: solid.layer });
    expect(tree.name).toBe("Background");
    const props = tree.properties as {
      children: Array<{ path: string; value: unknown }>;
    };
    const opacity = props.children.find((c) => c.path === "transform/opacity");
    expect(opacity?.value).toBe(50);

    const history = await bridge.query<{ undo: string[] }>("project.summary");
    // upstream `fold`: the comp.new undo entry is folded INTO the batch step
    expect(history.undo).toEqual(["Agent: build kinetic title"]);
    iframe.remove();
  });

  it("renderFrame returns the 1×1 png stub as pngBase64; screenshot too", async () => {
    const iframe = makeIframe();
    install(iframe, createFakeEditor());
    const bridge = await attachEditorBridge(iframe);
    const compNew = await bridge.execute<{ comp: number }>("comp.new", { name: "A" });
    const frame = await bridge.renderFrame({ comp: compNew.comp, time: 1 });
    expect(frame.pngBase64).toBeDefined();
    expect(frame.width).toBe(1920);
    expect(frame.pngBase64?.startsWith("iVBORw0KGgo")).toBe(true);
    const shot = await bridge.screenshot();
    expect(shot.pngBase64).toBeDefined();
    iframe.remove();
  });

  it("readFile / saveToBrowser / addFile round-trip through the file table", async () => {
    const iframe = makeIframe();
    install(iframe, createFakeEditor());
    const bridge = await attachEditorBridge(iframe);
    await bridge.execute("comp.new", { name: "S" });
    const saved = await bridge.saveToBrowser("/cloud/project.ecproj");
    expect(saved.path).toBe("/cloud/project.ecproj");
    expect(saved.bytes).toBeGreaterThan(0);
    const bytes = await bridge.readFile("/cloud/project.ecproj");
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('"schema":"studio-fake-ecproj"');

    const path = await bridge.addFile(new Blob(["hello world"]), "notes.txt");
    expect(path).toBe("/notes.txt");
    const read = await bridge.readFile("/notes.txt");
    expect(new TextDecoder().decode(read)).toBe("hello world");

    const err = (await bridge.readFile("/nope.bin").then(
      () => {
        throw new Error("no");
      },
      (e: unknown) => e,
    )) as BridgeError;
    expect(err.code).toBe("EDITOR_CALL_FAILED");
    expect(err.message).toContain("/nope.bin");
    iframe.remove();
  });

  it("addAsset stores bytes and returns the editor-assigned path", async () => {
    const iframe = makeIframe();
    install(iframe, createFakeEditor());
    const bridge = await attachEditorBridge(iframe);
    const path = await bridge.addAsset({
      assetId: "a1",
      name: "photo 1.png",
      bytes: new TextEncoder().encode("pngdata"),
    });
    // upstream path_for basenames: /assets/<id>/<name> → /<name>
    expect(path).toBe("/photo-1.png");
    const bytes = await bridge.readFile(path);
    expect(new TextDecoder().decode(bytes)).toBe("pngdata");
    iframe.remove();
  });

  it("addAsset can fetch a signed URL in the parent frame", async () => {
    const iframe = makeIframe();
    install(iframe, createFakeEditor());
    const bridge = await attachEditorBridge(iframe);
    const path = await bridge.addAsset({
      assetId: "a2",
      name: "icon.svg",
      url: "data:text/plain;base64,aWNvbg==",
    });
    expect(path).toBe("/icon.svg");
    const bytes = await bridge.readFile(path);
    expect(new TextDecoder().decode(bytes)).toBe("icon");
    iframe.remove();
  });

  it("commands(filter) / describe() / info() / capabilities()", async () => {
    const iframe = makeIframe();
    install(iframe, createFakeEditor());
    const bridge = await attachEditorBridge(iframe);
    const all = await bridge.commands();
    expect(all.length).toBeGreaterThan(15);
    expect(all.some((c) => c.id === "engine.batch")).toBe(true);
    const layers = await bridge.commands("layer");
    expect(
      layers.every((c) => c.id.includes("layer") || c.label.toLowerCase().includes("layer")),
    ).toBe(true);

    const desc = await bridge.describe("prop.set");
    expect(desc.command).toBe("prop.set");
    expect(desc.schema).toBeDefined();
    expect(desc.undoable).toBe(true);

    const info = bridge.info();
    expect(info.version).toBe("0.13.0-fake");
    expect(info.load?.readyMs).toBe(2); // from effectcraftLoad
    const caps = await bridge.capabilities();
    expect(caps.version).toBe("0.13.0-fake");
    expect(caps.commands).toBeGreaterThan(15);
    iframe.remove();
  });

  it("request() passes through control methods (ui.playback)", async () => {
    const iframe = makeIframe();
    install(iframe, createFakeEditor());
    const bridge = await attachEditorBridge(iframe);
    const stopped = await bridge.request<{ playing: boolean }>("ui.playback", { action: "stop" });
    expect(stopped.playing).toBe(false);
    const started = await bridge.request<{ playing: boolean }>("ui.playback", { action: "toggle" });
    expect(started.playing).toBe(true);
    iframe.remove();
  });
});
