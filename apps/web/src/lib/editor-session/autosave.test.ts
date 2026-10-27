import { createHash } from "node:crypto";
/**
 * A REAL event-loop hop, bypassing the faked globals (vitest fakes
 * `globalThis.setTimeout`, not the `node:timers` module). The save chain
 * crosses a real asynchronous seam — jsdom's WebCrypto `subtle.digest`
 * resolves on Node's threadpool — which fake-clock pumping alone cannot
 * drain under parallel-worker CPU contention.
 */
import { setTimeout as realSleep } from "node:timers/promises";
import vm from "node:vm";
import { type EditorBridge, attachEditorBridge } from "@studio/editor-bridge";
import type { EffectcraftGlobal, EffectcraftWindow } from "@studio/editor-bridge";
import { type FakeEditor, attachFakeBridge, createFakeEditor } from "@studio/editor-bridge/fake";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type AutosaveController, type AutosaveHooks, createAutosaveController } from "./autosave";
import { loadProjectSession } from "./load";
import {
  type FakeEditorSessionClient,
  type FakeSessionClientOptions,
  type UploadVersionResult,
  type VersionRef,
  createFakeEditorSessionClient,
  fakeBaseVersion,
} from "./testing";
import { EditorSessionError } from "./types";

/**
 * M3.4 autosave/versioning (D-6) against the deterministic fake editor.
 *
 * Each test loads a real session first under REAL timers (jsdom reads Blobs
 * through FileReader on the load path, which fake timers cannot drive), then
 * installs `vi.useFakeTimers()` BEFORE creating the controller so the 30 s
 * cadence lives on the fake clock. The save path itself never touches Blobs
 * or timers (bridge calls are microtasks, the digest is native WebCrypto), so
 * awaiting `saveNow` and pumping the clock keeps everything deterministic.
 */

const PROJECT_ID = "prj_test";

interface Harness {
  fake: FakeEditor;
  bridge: EditorBridge;
  fakeClient: FakeEditorSessionClient;
  hooks: { saved: VersionRef[]; conflicts: Array<VersionRef | null>; errors: unknown[] };
  hooksObj: AutosaveHooks;
}

let active: { controller: AutosaveController | null } | null = null;

async function openSession(clientOpts: FakeSessionClientOptions = {}): Promise<Harness> {
  const fake = createFakeEditor();
  const bridge = attachFakeBridge(fake);
  const fakeClient = createFakeEditorSessionClient(clientOpts);
  await loadProjectSession({ bridge, client: fakeClient.client, projectId: PROJECT_ID });
  const hooks = {
    saved: [] as VersionRef[],
    conflicts: [] as Array<VersionRef | null>,
    errors: [] as unknown[],
  };
  const hooksObj: AutosaveHooks = {
    onSaved: (version) => hooks.saved.push(version),
    onConflict: (serverVersion) => hooks.conflicts.push(serverVersion),
    onError: (error) => hooks.errors.push(error),
  };
  active = { controller: null };
  return { fake, bridge, fakeClient, hooks, hooksObj };
}

function makeController(
  h: Harness,
  opts: { intervalMs?: number; immediateRetries?: number } = {},
): AutosaveController {
  const controller = createAutosaveController({
    bridge: h.bridge,
    client: h.fakeClient.client,
    projectId: PROJECT_ID,
    baseVersion: fakeBaseVersion,
    hooks: h.hooksObj,
    ...opts,
  });
  if (active !== null) active.controller = controller;
  return controller;
}

async function edit(h: Harness, name = "Extra Comp"): Promise<void> {
  await h.bridge.execute("comp.new", { name });
}

function shaOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Pump the fake clock without firing pending ticks (lets native microtasks settle). */
async function pump(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await vi.advanceTimersByTimeAsync(0);
    await realSleep(1); // drain real threadpool callbacks (WebCrypto digest)
  }
}

/** Advance the clock by `ms`, then wait until exactly `count` uploads exist. */
async function tickUntilUploaded(h: Harness, ms: number, count: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 200 && h.fakeClient.calls.uploads.length < count; i++) {
    await vi.advanceTimersByTimeAsync(0);
    await realSleep(1);
  }
  expect(h.fakeClient.calls.uploads).toHaveLength(count);
}

beforeEach(() => {
  active = null;
});

afterEach(() => {
  active?.controller?.dispose();
  vi.useRealTimers();
  active = null;
});

describe("createAutosaveController", () => {
  it("validates its options", () => {
    expect(() =>
      createAutosaveController({
        bridge: {} as EditorBridge,
        client: {} as never,
        projectId: "",
        baseVersion: fakeBaseVersion,
      }),
    ).toThrow(EditorSessionError);
    expect(() =>
      createAutosaveController({
        bridge: {} as EditorBridge,
        client: {} as never,
        projectId: "p",
        baseVersion: { id: "", label: null, sha256: "nothex", sizeBytes: -1 },
      }),
    ).toThrow(EditorSessionError);
  });

  it("does not upload while clean; the tick keeps polling and nothing is saved", async () => {
    const h = await openSession();
    vi.useFakeTimers();
    const controller = makeController(h);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await pump();
    expect(h.fakeClient.calls.uploads).toHaveLength(0);
    expect(controller.dirty).toBe(false);
    expect(h.hooks.saved).toEqual([]);
    expect(h.hooks.errors).toEqual([]);
  });

  it("saves once per dirty tick with the exact content sha; the version chain advances", async () => {
    const h = await openSession();
    vi.useFakeTimers();
    const controller = makeController(h);

    await edit(h, "Edit One");
    // the controller's `dirty` view refreshes on the next `project.summary`
    // read (the tick); the source of truth right after the edit is the editor.
    expect(h.fake.state.dirty).toBe(true);
    await tickUntilUploaded(h, 30_000, 1);

    const first = h.fakeClient.calls.uploads[0];
    expect(first?.projectId).toBe(PROJECT_ID);
    expect(first?.input.baseVersionId).toBe("ver_base");
    expect(first?.input.label).toBe("Autosave");
    const savedBytes = h.fake.readFile("/test-project.ecproj");
    expect(savedBytes).toBeDefined();
    expect(first?.input.sha256).toBe(shaOf(savedBytes as Uint8Array));
    expect([...(first?.input.bytes ?? [])]).toEqual([...(savedBytes ?? [])]);
    expect(h.hooks.saved).toHaveLength(1);
    expect(h.hooks.saved[0]?.id).toBe("ver_upload_1");
    expect(controller.dirty).toBe(false);
    expect(h.fake.state.dirty).toBe(false);

    // a second edit saves on the next tick carrying the NEW base version id
    await edit(h, "Edit Two");
    await tickUntilUploaded(h, 30_000, 2);
    const second = h.fakeClient.calls.uploads[1];
    expect(second?.input.baseVersionId).toBe("ver_upload_1");
    expect(second?.input.sha256).toBe(shaOf(h.fake.readFile("/test-project.ecproj") as Uint8Array));
    expect(h.hooks.saved[1]?.id).toBe("ver_upload_2");
    // still exactly one upload per tick — no double-flown saves
    await vi.advanceTimersByTimeAsync(30_000);
    await pump();
    expect(h.fakeClient.calls.uploads).toHaveLength(2);
  });

  it("saveNow('manual') saves immediately without waiting for the tick", async () => {
    const h = await openSession();
    vi.useFakeTimers();
    const controller = makeController(h);
    await edit(h, "Manual Edit");
    const outcome = await controller.saveNow("manual");
    expect(outcome.saved).toBe(true);
    expect(outcome.version?.id).toBe("ver_upload_1");
    expect(h.fakeClient.calls.uploads).toHaveLength(1);
    expect(h.fakeClient.calls.uploads[0]?.input.label).toBe("Manual save");
    // the clock never advanced — the save was user-triggered, not tick-driven
    expect(vi.getTimerCount()).toBe(1); // only the next cadence timer is pending
  });

  it("a fresh project (no version) saves its FIRST version with baseVersionId null, then the chain advances", async () => {
    // Start-from-scratch: the manifest carries no currentVersion (the load
    // boots the editor's own default project), the autosave chain head starts
    // null, and the first upload is a ROOT upload (baseVersionId null, W3-G3).
    const h = await openSession({ manifest: { currentVersion: null } });
    vi.useFakeTimers();
    const controller = createAutosaveController({
      bridge: h.bridge,
      client: h.fakeClient.client,
      projectId: PROJECT_ID,
      baseVersion: null,
      defaultSaveName: "fresh-project.ecproj",
      hooks: h.hooksObj,
    });
    active = { controller };
    await edit(h, "First Edit");
    const first = await controller.saveNow("manual");
    await pump();
    expect(first.saved).toBe(true);
    expect(h.fakeClient.calls.uploads).toHaveLength(1);
    expect(h.fakeClient.calls.uploads[0]?.input.baseVersionId).toBeNull();
    // the fake saved under the default name (no session path existed yet)
    expect(h.fake.state.fileTable.map((f) => f.path)).toContain("/fresh-project.ecproj");
    expect(controller.currentVersion()?.id).toBe(h.hooks.saved[0]?.id);

    // The SECOND save chains from the first version's id (head advanced).
    await edit(h, "Second Edit");
    const second = await controller.saveNow("manual");
    await pump();
    expect(second.saved).toBe(true);
    expect(h.fakeClient.calls.uploads).toHaveLength(2);
    expect(h.fakeClient.calls.uploads[1]?.input.baseVersionId).toBe(h.hooks.saved[0]?.id);
    controller.dispose();
  });

  it("saveNow on a clean editor never uploads", async () => {
    const h = await openSession();
    const controller = makeController(h);
    const outcome = await controller.saveNow("manual");
    expect(outcome).toEqual({ saved: false });
    expect(h.fakeClient.calls.uploads).toHaveLength(0);
  });

  it("markDirty saves on the tick even when the editor reports clean", async () => {
    const h = await openSession();
    vi.useFakeTimers();
    const controller = makeController(h);
    expect(h.fake.state.dirty).toBe(false);
    controller.markDirty("agent-batch");
    expect(controller.dirty).toBe(true);
    await tickUntilUploaded(h, 30_000, 1);
    expect(h.hooks.saved).toHaveLength(1);
    expect(controller.dirty).toBe(false);
  });

  it("redundant dirty (content identical to the current version) does not create a version", async () => {
    const h = await openSession();
    const controller = makeController(h);
    await edit(h, "Edit");
    const first = await controller.saveNow("manual");
    expect(first.saved).toBe(true);
    expect(h.fakeClient.calls.uploads).toHaveLength(1);

    // undo + redo: the fake marks the project dirty again, content unchanged
    await h.bridge.execute("edit.undo");
    await h.bridge.execute("edit.redo");
    expect(h.fake.state.dirty).toBe(true);
    const second = await controller.saveNow("manual");
    expect(second.saved).toBe(true);
    expect(second.version?.id).toBe(first.version?.id);
    expect(h.fakeClient.calls.uploads).toHaveLength(1); // no second version
    expect(h.hooks.saved).toHaveLength(2);
  });

  it("conflict parks the controller: no silent overwrite, no further uploads", async () => {
    const serverVersion: VersionRef = {
      id: "ver_server_9",
      label: "collaborator edit",
      sha256: "f".repeat(64),
      sizeBytes: 4096,
    };
    const h = await openSession({
      upload: (): UploadVersionResult => ({ ok: false, conflict: true, serverVersion }),
    });
    vi.useFakeTimers();
    const controller = makeController(h);
    await edit(h, "Conflicting Edit");

    const outcome = await controller.saveNow("manual");
    expect(outcome).toEqual({ saved: false, conflict: true });
    expect(h.hooks.conflicts).toEqual([serverVersion]);
    expect(h.hooks.saved).toEqual([]);
    expect(controller.dirty).toBe(true);
    expect(h.fakeClient.calls.uploads).toHaveLength(1);

    // parked: further explicit saves keep returning the conflict, no uploads
    const again = await controller.saveNow("before-close");
    expect(again).toEqual({ saved: false, conflict: true });
    expect(h.fakeClient.calls.uploads).toHaveLength(1);
    expect(h.hooks.conflicts).toEqual([serverVersion]); // onConflict fired once

    // and the parked controller schedules no further ticks
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    await pump();
    expect(h.fakeClient.calls.uploads).toHaveLength(1);
  });

  it("transient failures retry immediately, then on the next tick, and park after the cap", async () => {
    let fail = true;
    let n = 0;
    const h = await openSession({
      upload: (): UploadVersionResult => {
        if (fail) return { ok: false, error: new Error("HTTP 503: bad gateway") };
        n++;
        return {
          ok: true,
          version: { id: `ver_recovered_${n}`, label: null, sha256: "0".repeat(64), sizeBytes: 1 },
        };
      },
    });
    vi.useFakeTimers();
    const controller = makeController(h);

    await edit(h, "Flaky Edit");
    // tick 1: initial attempt + 2 immediate retries = 3 uploads, all fail
    await tickUntilUploaded(h, 30_000, 3);
    expect(h.hooks.errors).toHaveLength(3);
    expect(h.hooks.errors.every((e) => (e as Error).message.includes("HTTP 503"))).toBe(true);

    // tick 2: two more failures reach the 5-error cap → parked
    await tickUntilUploaded(h, 30_000, 5);
    expect(h.hooks.errors).toHaveLength(6); // 5 failures + the park surfacing
    const parkError = h.hooks.errors[5] as EditorSessionError;
    expect(parkError).toBeInstanceOf(EditorSessionError);
    expect(parkError.code).toBe("autosave-parked");

    // parked: ticks stop uploading
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await pump();
    expect(h.fakeClient.calls.uploads).toHaveLength(5);
    expect(vi.getTimerCount()).toBe(0);

    // an explicit save that lands un-parks and resumes the cadence
    fail = false;
    await edit(h, "Recovery Edit");
    const recovery = await controller.saveNow("manual");
    expect(recovery.saved).toBe(true);
    expect(h.fakeClient.calls.uploads).toHaveLength(6);
    expect(vi.getTimerCount()).toBe(1); // the cadence timer is back
    await edit(h, "Post-Recovery Edit");
    await tickUntilUploaded(h, 30_000, 7);
    expect(controller.dirty).toBe(false);
  });

  it("dispose stops timers and an in-flight save is not double-flown", async () => {
    const h = await openSession({ upload: (): UploadVersionResult | "hang" => "hang" });
    vi.useFakeTimers();
    const controller = makeController(h);
    await edit(h, "Slow Save");
    const pending = controller.saveNow("manual"); // inFlight is set synchronously
    for (let i = 0; i < 200 && h.fakeClient.calls.uploads.length === 0; i++) {
      await vi.advanceTimersByTimeAsync(0);
      await realSleep(1); // real event-loop hop (WebCrypto digest seam)
    }
    expect(h.fakeClient.calls.uploads).toHaveLength(1);

    // ticks while the save is in flight are skipped (single-flight)
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.fakeClient.calls.uploads).toHaveLength(1);
    // a concurrent saveNow no longer ADOPTS the in-flight promise (w3-b06 —
    // it read bytes before the caller's edits): it CHAINS a fresh save. The
    // controller was disposed before the chain re-entered, so the chained
    // save resolves the honest disposed outcome and never uploads.
    const chained = controller.saveNow("manual");
    expect(chained).not.toBe(pending);

    controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
    h.fakeClient.resolveUpload(0, {
      ok: true,
      version: { id: "ver_upload_1", label: null, sha256: "0".repeat(64), sizeBytes: 1 },
    });
    const outcome = await pending; // an in-flight save still settles after dispose
    expect(outcome.saved).toBe(true);
    const chainedOutcome = await chained; // the chain hit the disposed gate
    expect(chainedOutcome.saved).toBe(false);
    expect((chainedOutcome.error as EditorSessionError).code).toBe("disposed");

    // after dispose: no further ticks, no further uploads, honest outcome
    await vi.advanceTimersByTimeAsync(120_000);
    await pump();
    expect(h.fakeClient.calls.uploads).toHaveLength(1);
    const afterDispose = await controller.saveNow("manual");
    expect(afterDispose.saved).toBe(false);
    expect((afterDispose.error as EditorSessionError).code).toBe("disposed");
  });

  it("saveNow during an in-flight tick save CHAINS a fresh save — before-close never adopts stale bytes (w3-b06)", async () => {
    // The regression: an explicit saveNow that landed while a tick save was
    // uploading used to dedupe onto it — the tick had read the editor bytes
    // BEFORE the user's latest edits, so before-close answered saved:true for
    // STALE bytes, the page closed, and the newer edits were lost.
    const secondVersion: VersionRef = {
      id: "ver_upload_2",
      label: null,
      sha256: "1".repeat(64),
      sizeBytes: 2,
    };
    const h = await openSession({
      upload: (_call, index) => (index === 0 ? "hang" : { ok: true, version: secondVersion }),
    });
    vi.useFakeTimers();
    const controller = makeController(h);

    await edit(h, "Edit One");
    // tick: the save reads + uploads the "Edit One" bytes, then hangs.
    await vi.advanceTimersByTimeAsync(30_000);
    for (let i = 0; i < 200 && h.fakeClient.calls.uploads.length === 0; i++) {
      await vi.advanceTimersByTimeAsync(0);
      await realSleep(1);
    }
    expect(h.fakeClient.calls.uploads).toHaveLength(1);
    const staleBytes = h.fakeClient.calls.uploads[0]?.input.bytes;

    // The user keeps editing WHILE the stale upload hangs.
    await edit(h, "Edit Two");
    expect(h.fake.state.dirty).toBe(true);

    // before-close must not adopt the in-flight (stale) outcome.
    const beforeClose = controller.saveNow("before-close");
    h.fakeClient.resolveUpload(0, {
      ok: true,
      version: { id: "ver_upload_1", label: null, sha256: "0".repeat(64), sizeBytes: 1 },
    });
    const outcome = await beforeClose;

    expect(outcome.saved).toBe(true);
    // The chained save read the CURRENT bytes: a SECOND upload whose sha is
    // the post-"Edit Two" file table (never the stale first sha), and the
    // outcome's version is the fresh one — the honest "saved" for the bytes
    // the page is closing with.
    expect(h.fakeClient.calls.uploads).toHaveLength(2);
    expect(h.fakeClient.calls.uploads[1]?.input.sha256).toBe(
      shaOf(h.fake.readFile("/test-project.ecproj") as Uint8Array),
    );
    expect(h.fakeClient.calls.uploads[1]?.input.bytes).not.toEqual(staleBytes);
    expect(h.fakeClient.calls.uploads[1]?.input.label).toBe("Save before close");
    expect(outcome.version?.id).toBe("ver_upload_2");
    expect(controller.currentVersion()?.id).toBe("ver_upload_2");
    expect(h.hooks.saved).toHaveLength(2); // one per real upload — both honest
    controller.dispose();
  });

  it("default cadence is 30 s (D-6)", async () => {
    const h = await openSession();
    vi.useFakeTimers();
    const controller = makeController(h); // no intervalMs → default 30_000
    await edit(h, "Cadence Edit");
    await vi.advanceTimersByTimeAsync(29_999);
    await pump();
    expect(h.fakeClient.calls.uploads).toHaveLength(0);
    await tickUntilUploaded(h, 1, 1);
  });

  it("a save with no project open surfaces via onError and counts toward the cap", async () => {
    const h = await openSession();
    vi.useFakeTimers();
    const controller = makeController(h, { intervalMs: 1_000, immediateRetries: 0 });
    h.fake.reset(); // no project open anymore: summary.path is null
    controller.markDirty("test");
    await vi.advanceTimersByTimeAsync(1_000);
    await pump();
    expect(h.hooks.errors.length).toBeGreaterThanOrEqual(1);
    const first = h.hooks.errors[0] as EditorSessionError;
    expect(first).toBeInstanceOf(EditorSessionError);
    expect(first.code).toBe("no-project-open");
    expect(h.fakeClient.calls.uploads).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-realm editor bytes (W3-C1 regression)
// ---------------------------------------------------------------------------

describe("createAutosaveController — cross-realm editor bytes (W3-C1)", () => {
  /**
   * The REAL editor iframe is same-origin but a SEPARATE JS realm, and
   * wasm-bindgen's `readFile` (editor/apps/effectcraft-web/src/api.rs) mints
   * its `Uint8Array` from the IFRAME's intrinsics — so a host-page
   * `instanceof Uint8Array` is `false` for real editor bytes. The old bridge
   * guard read exactly that as "no file at …", so an agent apply applied in
   * the engine but never uploaded a version (the m5 high-risk journey bug:
   * engine batch OK, saveToBrowser OK, readFile misreported). A `node:vm`
   * context is a genuine second realm and reproduces the cross-realm
   * instanceof failure exactly; the save path here runs through the REAL
   * `attachEditorBridge` readFile wrapper, not the fake editor.
   */
  it("uploads a version when readFile returns bytes minted in the editor iframe's realm", async () => {
    const foreignBytes = vm.runInNewContext(
      "new Uint8Array([123, 34, 115, 99, 104, 101, 109, 97, 34, 58, 32, 49, 125])",
    ) as Uint8Array;
    // The regression's precondition: a host-realm instanceof CANNOT see
    // these bytes — the save path must never depend on it.
    expect(foreignBytes instanceof Uint8Array).toBe(false);
    expect(foreignBytes).toHaveLength(13);

    const summary = {
      path: "/demo-project.ecproj",
      dirty: true,
      items: [],
      activeComp: null,
      selectedLayers: [],
      undo: [],
    };
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const w = iframe.contentWindow as EffectcraftWindow;
    w.effectcraft = {
      request: () => Promise.resolve({}),
      execute: (command: string) =>
        command === "project.summary" ? Promise.resolve(summary) : Promise.resolve({}),
      commands: () => Promise.resolve([]),
      inspect: () => Promise.resolve({}),
      screenshot: () => Promise.resolve({}),
      renderFrame: () => Promise.resolve({}),
      files: () => [],
      readFile: () => foreignBytes,
      addFile: () => Promise.resolve("/stub"),
      info: () => ({ version: "0.13.0-stub" }),
      saveToBrowser: () =>
        Promise.resolve({ path: "/demo-project.ecproj", bytes: foreignBytes.byteLength }),
      listStored: () => Promise.resolve({}),
      removeStored: () => true,
      flush: () => Promise.resolve(),
      workerFrameCheck: () => Promise.resolve({}),
    } as unknown as EffectcraftGlobal;
    w.effectcraftLoad = { wasmMs: 1, readyMs: 2 };
    const bridge = await attachEditorBridge(iframe);

    const fakeClient = createFakeEditorSessionClient();
    const controller = createAutosaveController({
      bridge,
      client: fakeClient.client,
      projectId: PROJECT_ID,
      baseVersion: fakeBaseVersion,
    });
    try {
      const outcome = await controller.saveNow("agent-apply");
      expect(outcome.saved).toBe(true);
      // the upload carried the iframe-realm bytes, hashed + counted intact
      expect(fakeClient.calls.uploads).toHaveLength(1);
      expect(fakeClient.calls.uploads[0]?.input.sha256).toBe(shaOf(foreignBytes));
      expect(fakeClient.calls.uploads[0]?.input.bytes.byteLength).toBe(13);
      expect(outcome.version?.sha256).toBe(shaOf(foreignBytes));
      expect(controller.dirty).toBe(false);
    } finally {
      controller.dispose();
      bridge.dispose();
      iframe.remove();
    }
  });
});
