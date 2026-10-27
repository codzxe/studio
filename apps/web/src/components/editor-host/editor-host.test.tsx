/**
 * EditorHost component tests (M3.5/M3.6/M3.7 + the M4-J chat layer mount) —
 * the real `attachEditorBridge` against a DIST-SHAPED mount: `window.studioEngine`
 * + `window.studioEngineLoad` installed on the host's own iframe `contentWindow`
 * exactly the way the shipped dist defines them
 * (`apps/web/public/editor/index.html`, from
 * `editor/apps/studio-web/web/index.html`), with the deterministic
 * fake editor behind the API (M3-C's harness pattern).
 *
 * The session engine runs for real (`loadProjectSession` +
 * `createAutosaveController` from @/lib/editor-session) against
 * `createFakeEditorSessionClient` (imported from the test-only
 * @/lib/editor-session/testing subpath — never the production barrel); the
 * lease port is a fake §11 seam.
 * Real timers (the save chain crosses real WebCrypto); every wait uses
 * `vi.waitFor`. No network, no dev servers, deterministic.
 *
 * M4-J: the chat overlay is exercised with the REAL ChatProvider against a
 * stub api-client, with the peer-composed ChatPanelSlot mocked at this seam
 * (the slot's own composition suite lives in chat-panel-slot.test.tsx) — so
 * these tests stay independent of the wave-2 peer components.
 */

import type { ChatContextApi } from "@/lib/chat/provider";
import { GPU_FALLBACK_MARKER } from "@/lib/editor-gpu-fallback";
import {
  type FakeEditorSessionClient,
  createFakeEditorSessionClient,
} from "@/lib/editor-session/testing";
import type { ApiClient } from "@studio/api-client";
import { type FakeEditor, createFakeEditor } from "@studio/editor-bridge/fake";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ChatShortcutBus, createChatShortcutBus } from "./chat-shortcut-bus";
import { EditorHost } from "./editor-host";
import type { EditorHostPayload, LeasePort } from "./types";

// ---------------------------------------------------------------------------
// M4-J: ChatPanelSlot mock — records its props so the host tests can drive the
// provider api + the sidebar-dock callback without loading the wave-2 peers.
// (The slot file is ours; its imports are mocked so the peer components never
// load from this suite.)
// ---------------------------------------------------------------------------

const slotMock = vi.hoisted(() => ({
  mounts: [] as Array<{
    api: ChatContextApi;
    onSidebarDock: (docked: boolean, widthPx: number) => void;
  }>,
}));

vi.mock("@/components/editor-host/chat-panel-slot", () => ({
  ChatPanelSlot: (props: {
    api: ChatContextApi;
    onSidebarDock: (docked: boolean, widthPx: number) => void;
  }) => {
    slotMock.mounts.push(props);
    return <div data-testid="chat-panel-slot-mock" />;
  },
}));

// ---------------------------------------------------------------------------
// Dist-shaped mount helpers (mirror packages/editor-bridge/tests/dist.test.ts)
// ---------------------------------------------------------------------------

interface WritableLoad {
  wasmMs?: number;
  readyMs?: number;
  error?: string;
}

type EditorWindow = Window & {
  effectcraft?: Record<string, unknown>;
  studioEngineLoad?: WritableLoad;
};

function installDistEditor(
  w: EditorWindow,
  fake: FakeEditor,
  boot: { wasmMs: number; readyMs: number } | { wasmMs: number; error: string },
): void {
  const load: WritableLoad = { wasmMs: boot.wasmMs };
  if ("readyMs" in boot) {
    load.readyMs = boot.readyMs;
  } else {
    // dist: `window.studioEngineLoad.error = String(e)` (never readyMs).
    load.error = boot.error;
  }
  w.studioEngineLoad = load;
  w.effectcraft = {
    request: (method: string, params?: unknown) => fake.request(method, params ?? {}),
    execute: (command: string, params?: unknown) =>
      fake.request("engine.execute", { command, params: params ?? {} }),
    commands: () => fake.request("engine.commands", {}),
    inspect: () => fake.request("ui.inspect", {}),
    screenshot: (params?: unknown) => fake.request("ui.screenshot", params ?? {}),
    renderFrame: (params?: unknown) =>
      fake.request("render.frame", { base64: true, ...(params ?? {}) }),
    files: () => fake.files(),
    readFile: (path: string) => fake.readFile(path),
    addFile: (fileOrUrl: Blob | File | string, name?: string) => fake.addFile(fileOrUrl, name),
    info: () => ({ ...(fake.info() as Record<string, unknown>), load: w.studioEngineLoad }),
    saveToBrowser: (path?: string) => fake.saveToBrowser(path ?? undefined),
    listStored: () => fake.listStored(),
    removeStored: (path: string) => fake.removeStored(path),
    flush: () => fake.flush(),
    workerFrameCheck: (params?: unknown) => fake.workerFrameCheck(params ?? {}),
  };
}

function currentIframe(): HTMLIFrameElement {
  const iframe = screen.getByTestId("editor-iframe") as HTMLIFrameElement;
  expect(iframe.contentWindow).not.toBeNull();
  return iframe;
}

function iframeWindow(): EditorWindow {
  return currentIframe().contentWindow as EditorWindow;
}

// ---------------------------------------------------------------------------
// Fake lease port (§11 semantics, injectable per test)
// ---------------------------------------------------------------------------

type LeaseOutcome = "acquired" | "refused" | "fail";

interface FakeLeasePort extends LeasePort {
  readonly acquireCalls: string[];
  releaseCalls: number;
  setOutcome(outcome: LeaseOutcome): void;
}

function createFakeLeasePort(initial: LeaseOutcome = "acquired"): FakeLeasePort {
  let outcome = initial;
  const port: FakeLeasePort = {
    acquireCalls: [],
    releaseCalls: 0,
    async acquire(sessionId: string) {
      port.acquireCalls.push(sessionId);
      if (outcome === "fail") throw new Error("network down");
      if (outcome === "acquired") return { acquired: true, holderName: "Maya", readOnly: false };
      return { acquired: false, holderName: "Dana Flow", readOnly: true };
    },
    async release() {
      port.releaseCalls += 1;
    },
    setOutcome(next) {
      outcome = next;
    },
  };
  return port;
}

// ---------------------------------------------------------------------------
// Shared host setup
// ---------------------------------------------------------------------------

const ZERO_SHA = "0".repeat(64);

const PAYLOAD: EditorHostPayload = {
  workspaceId: "ws_test",
  manifest: {
    project: { id: "prj_test", slug: "test-project", name: "Test Project" },
    currentVersion: { id: "ver_base", label: null, sha256: ZERO_SHA, sizeBytes: 4096 },
    assets: [],
    projectFileUrl: "https://storage.test/test-project/ver_base.ecproj",
  },
};

interface HostHarness {
  readonly fakeClient: FakeEditorSessionClient;
  readonly leases: FakeLeasePort;
  readonly bus: ChatShortcutBus;
  readonly fake: FakeEditor;
}

function renderHost(
  overrides: {
    readonly sessionClient?: FakeEditorSessionClient;
    readonly lease?: FakeLeasePort;
    readonly assets?: Record<string, Uint8Array | Error>;
    readonly upload?: () =>
      | {
          ok: true;
          version: { id: string; label: string | null; sha256: string; sizeBytes: number };
        }
      | { ok: false; conflict: true; serverVersion: null }
      | { ok: false; error: Error };
    /** M4-J: a stub api-client exposed via the session factory mounts the chat layer. */
    readonly chatApi?: ApiClient;
  } = {},
): HostHarness {
  const uploadBehavior = overrides.upload;
  const sessionClient =
    overrides.sessionClient ??
    createFakeEditorSessionClient({
      ...(overrides.assets === undefined ? {} : { assets: overrides.assets }),
      ...(uploadBehavior === undefined ? {} : { upload: () => uploadBehavior() }),
    });
  const leases = overrides.lease ?? createFakeLeasePort();
  const bus = createChatShortcutBus();
  render(
    <EditorHost
      payload={PAYLOAD}
      sessionFactory={() => ({
        client: sessionClient.client,
        leases,
        ...(overrides.chatApi === undefined ? {} : { api: overrides.chatApi }),
      })}
      shortcutBus={bus}
    />,
  );
  return { fakeClient: sessionClient, leases, bus, fake: createFakeEditor({ version: "0.13.0" }) };
}

/** Boot the host's iframe into the dist's "ready" state and await phase=open. */
async function bootToOpen(harness: HostHarness): Promise<void> {
  installDistEditor(iframeWindow(), harness.fake, { wasmMs: 42, readyMs: 64 });
  const host = screen.getByTestId("editor-host");
  await waitFor(
    () => {
      expect(host).toHaveAttribute("data-editor-phase", "open");
    },
    { timeout: 4000 },
  );
  expect(host).toHaveAttribute("data-editor-boot", "ready");
}

/** One edit through the dist surface (dirties the fake project). */
async function editProject(): Promise<void> {
  const w = iframeWindow();
  const execute = (w.effectcraft as { execute: (c: string, p?: unknown) => Promise<unknown> })
    .execute;
  await execute("comp.new", { name: "Edited comp" });
}

function pressCmdS(): void {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true, cancelable: true }),
  );
}

afterEach(() => {
  cleanup();
  // The GPU circuit breaker's marker must never leak across arms (the
  // device-lost recovery arms it; the compatibility-mode arms set it up).
  sessionStorage.removeItem(GPU_FALLBACK_MARKER);
});

// ---------------------------------------------------------------------------
// Boot UI (M3.7)
// ---------------------------------------------------------------------------

describe("EditorHost — boot", () => {
  it("shows the loading screen with the project name, then opens", async () => {
    const harness = renderHost();
    // Loading state covers the editor surface while the dist boots — but
    // never the persistent bar: the way out stays visible (w3-b05).
    expect(screen.getByTestId("editor-boot-loading")).toBeInTheDocument();
    expect(screen.getByText(/Preparing “Test Project”/)).toBeInTheDocument();
    expect(screen.getByTestId("editor-top-bar")).toHaveTextContent("Studio");

    await bootToOpen(harness);

    // The project bar carries the name (M3.5 chrome); iframe stays plain.
    expect(screen.getByTestId("editor-project-bar")).toHaveTextContent("Test Project");
    expect(screen.getByTestId("editor-iframe")).toHaveAttribute("src", "/editor/?empty");
    expect(screen.getByTestId("editor-iframe")).toHaveAttribute("title", "Studio editor");
    expect(screen.getByTestId("editor-iframe")).not.toHaveAttribute("allow");
  });

  it("mounts the persistent SaaS-brand bar ABOVE the editor surface (w3-b05)", () => {
    renderHost();

    // The bar: product mark → dashboard, breadcrumb project → its hub, and
    // the explicit way back.
    expect(screen.getByRole("link", { name: "Studio — dashboard" })).toHaveAttribute("href", "/w");
    expect(screen.getByTestId("editor-breadcrumb-project")).toHaveTextContent("Test Project");
    expect(screen.getByTestId("editor-breadcrumb-project")).toHaveAttribute(
      "href",
      "/w/test-project/history",
    );
    expect(screen.getByTestId("editor-breadcrumb-editor")).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("editor-dashboard-link")).toBeInTheDocument();

    // Structure: the iframe (and every overlay) live INSIDE the editor
    // surface, which FOLLOWS the bar — the editor only ever sees a viewport
    // resize (D-18), and no overlay can ever cover the way out.
    const bar = screen.getByTestId("editor-top-bar");
    const surface = screen.getByTestId("editor-surface");
    expect(bar.compareDocumentPosition(surface)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(surface).toContainElement(screen.getByTestId("editor-iframe"));
    expect(surface).toContainElement(screen.getByTestId("editor-project-bar"));
    expect(bar).not.toContainElement(screen.getByTestId("editor-iframe"));
  });

  it("renders the failure banner with the dist error and retries into a fresh iframe", async () => {
    const harness = renderHost();
    installDistEditor(iframeWindow(), harness.fake, {
      wasmMs: 10,
      error: "WebGPU is not supported",
    });

    await waitFor(
      () => {
        expect(screen.getByTestId("editor-boot-failed")).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
    expect(screen.getByTestId("editor-boot-error")).toHaveTextContent("WebGPU is not supported");
    expect(screen.getByTestId("editor-boot-retry")).toBeInTheDocument();

    // Retry remounts the iframe: fresh element, fresh boot, new bridge attach.
    const firstIframe = currentIframe();
    fireEvent.click(screen.getByTestId("editor-boot-retry"));
    await waitFor(() => {
      expect(screen.getByTestId("editor-iframe")).not.toBe(firstIframe);
    });
    expect(screen.getByTestId("editor-boot-loading")).toBeInTheDocument();

    // The new iframe boots clean → the session opens.
    const fresh = createFakeEditor({ version: "0.13.0" });
    installDistEditor(iframeWindow(), fresh, { wasmMs: 42, readyMs: 64 });
    await waitFor(
      () => {
        expect(screen.getByTestId("editor-host")).toHaveAttribute("data-editor-phase", "open");
      },
      { timeout: 4000 },
    );
  });
});

// ---------------------------------------------------------------------------
// Offline (§8.11, W5-06) — the editor route's own offline banner
// ---------------------------------------------------------------------------

/** jsdom navigator.onLine shim (the auth-offline / offline-banner pattern). */
function setNavigatorOnline(online: boolean) {
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    get: () => online,
  });
  window.dispatchEvent(new Event(online ? "online" : "offline"));
}

describe("EditorHost — offline (§8.11)", () => {
  it("renders no offline chrome while online (editor UI unchanged)", () => {
    setNavigatorOnline(true);
    renderHost();
    expect(screen.queryByTestId("editor-offline-banner")).not.toBeInTheDocument();
  });

  it("shows the honest offline banner when the browser reports no connection", async () => {
    const harness = renderHost();
    await bootToOpen(harness);

    await act(async () => {
      setNavigatorOnline(false);
    });

    const banner = screen.getByTestId("editor-offline-banner");
    expect(banner).toHaveTextContent("You're offline.");
    expect(banner).toHaveTextContent(/last saved version is safe/);
    expect(banner).toHaveTextContent(/kept and retried automatically/);

    await act(async () => {
      setNavigatorOnline(true);
    });
    expect(screen.queryByTestId("editor-offline-banner")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Load + missing assets (M3.3)
// ---------------------------------------------------------------------------

describe("EditorHost — load", () => {
  it("opens the project and shows a NON-blocking banner for missing assets", async () => {
    const harness = renderHost({
      assets: {
        ast_logo: new TextEncoder().encode("logo-png-bytes"),
        ast_font: new Error("HTTP 403: no asset"),
      },
    });
    await bootToOpen(harness);

    const banner = screen.getByTestId("editor-missing-assets-banner");
    expect(banner).toHaveTextContent("1 asset could not be loaded");

    // Expandable list (hover/expand affordance per the M3.3 brief).
    fireEvent.click(screen.getByTestId("editor-missing-assets-expand"));
    expect(screen.getByTestId("editor-missing-assets-list")).toHaveTextContent(
      "font.png — could not register asset: HTTP 403: no asset",
    );
  });

  it("renders the load-failed banner when the project file cannot open", async () => {
    const harness = renderHost({
      sessionClient: createFakeEditorSessionClient({
        projectBytes: new TextEncoder().encode("not-an-ecproj"),
      }),
    });
    installDistEditor(iframeWindow(), harness.fake, { wasmMs: 42, readyMs: 64 });
    await waitFor(
      () => {
        expect(screen.getByTestId("editor-host")).toHaveAttribute(
          "data-editor-phase",
          "load-failed",
        );
      },
      { timeout: 4000 },
    );
    expect(screen.getByTestId("editor-load-failed")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Autosave wiring + save triggers (M3.4 / D-6)
// ---------------------------------------------------------------------------

describe("EditorHost — saves", () => {
  it("Cmd/Ctrl+S on the page saves exactly once with the manual label", async () => {
    const harness = renderHost();
    await bootToOpen(harness);
    await editProject();

    pressCmdS();

    await waitFor(
      () => {
        expect(harness.fakeClient.calls.uploads).toHaveLength(1);
      },
      { timeout: 4000 },
    );
    expect(harness.fakeClient.calls.uploads[0]?.input.label).toBe("Manual save");
    expect(harness.fakeClient.calls.uploads[0]?.input.baseVersionId).toBe("ver_base");

    // The transient Saved chip appears (D-6 feedback).
    await waitFor(() => {
      expect(screen.getByTestId("editor-saved-chip")).toBeInTheDocument();
    });
  });

  it("shows the non-alarming error banner on failed saves and guards beforeunload", async () => {
    const harness = renderHost({
      upload: () => ({ ok: false, error: new Error("storage unreachable") }),
    });
    await bootToOpen(harness);
    await editProject();

    pressCmdS();

    await waitFor(
      () => {
        expect(screen.getByTestId("editor-save-error")).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
    expect(screen.getByTestId("editor-save-error")).toHaveTextContent(/kept and retried/);

    // The controller kept `proactiveDirty` → the unsaved-changes guard fires.
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("renders the blocking conflict banner on a 409 and never overwrites", async () => {
    const harness = renderHost({
      upload: () => ({ ok: false, conflict: true, serverVersion: null }),
    });
    await bootToOpen(harness);
    await editProject();

    pressCmdS();

    await waitFor(
      () => {
        expect(screen.getByTestId("editor-conflict-banner")).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
    expect(screen.getByTestId("editor-conflict-banner")).toHaveTextContent(
      "This project changed on the server.",
    );
    expect(screen.getByTestId("editor-conflict-load-server")).toBeInTheDocument();
    // Conflict parks: exactly one upload attempt (no silent overwrite).
    expect(harness.fakeClient.calls.uploads).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Graphics device lost (the dist's `studio:deviceLost` report) — recovery
// ---------------------------------------------------------------------------

/** Stub jsdom's not-implemented `location.reload`; exposes the call count.
 * jsdom's own `reload` is non-configurable on the Location instance, but the
 * `location` accessor on window is replaceable — swap the whole object for the
 * test's duration and put the real one back after. */
function stubLocationReload(): { reloads: () => number; restore: () => void } {
  let count = 0;
  const original = window.location;
  const origin = original.origin;
  // biome-ignore lint/performance/noDelete: jsdom's window.location accessor is replaceable only by deleting it first — the documented jsdom recipe.
  delete (window as { location?: Location }).location;
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: {
      origin,
      href: original.href,
      reload: (): void => {
        count += 1;
      },
    },
  });
  return {
    reloads: () => count,
    restore: () => {
      Object.defineProperty(window, "location", {
        configurable: true,
        writable: true,
        value: original,
      });
    },
  };
}

/** The dist's report: `js/host.js` posts `studio:deviceLost` to the parent. */
function reportDeviceLost(
  message = "GPU device lost (Unknown): A valid external Instance reference no longer exists",
  source: Window | null = iframeWindow(),
): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      origin: window.location.origin,
      source,
      data: { type: "studio:deviceLost", message },
    }),
  );
}

describe("EditorHost — graphics device lost", () => {
  it("recovers: saves through the autosave chain, then reloads the page", async () => {
    const reload = stubLocationReload();
    try {
      const harness = renderHost();
      await bootToOpen(harness);
      await editProject();

      reportDeviceLost();

      // The breaker is armed FIRST — before the save — so whichever reload
      // path runs reopens on the WebGL2 compatibility boot (M3 tail 6: a
      // reload cannot fix a persistently broken WebGPU stack).
      expect(sessionStorage.getItem(GPU_FALLBACK_MARKER)).toBe("1");

      // The recovery overlay owns the page while the save runs.
      await waitFor(
        () => {
          expect(screen.getByTestId("device-lost-overlay")).toBeInTheDocument();
        },
        { timeout: 4000 },
      );
      expect(screen.getByTestId("device-lost-copy")).toHaveTextContent(/Saving your work/);
      expect(screen.getByTestId("device-lost-detail")).toHaveTextContent(
        "GPU device lost (Unknown): A valid external Instance reference no longer exists",
      );

      // The save lands through the real chain: saveToBrowser → upload.
      await waitFor(
        () => {
          expect(harness.fakeClient.calls.uploads).toHaveLength(1);
        },
        { timeout: 4000 },
      );
      expect(harness.fakeClient.calls.uploads[0]?.input.label).toBe(
        "Save after graphics device loss",
      );
      expect(harness.fakeClient.calls.uploads[0]?.input.baseVersionId).toBe("ver_base");

      // Then the page reloads (RSC re-fetch: the editor reopens on a fresh
      // device with the just-saved version).
      await waitFor(
        () => {
          expect(reload.reloads()).toBe(1);
        },
        { timeout: 4000 },
      );

      // The deliberate reload bypasses the unsaved-changes guard.
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    } finally {
      reload.restore();
    }
  });

  it("parks on the failed stage when the save cannot land; Reload now reloads", async () => {
    const reload = stubLocationReload();
    try {
      const harness = renderHost({
        upload: () => ({ ok: false, error: new Error("storage unreachable") }),
      });
      await bootToOpen(harness);
      await editProject();

      reportDeviceLost("GPU device lost (Destroyed): destroyed");

      // The retry chain fails → the overlay flips to the buttons.
      await waitFor(
        () => {
          expect(screen.getByTestId("device-lost-retry")).toBeInTheDocument();
        },
        { timeout: 4000 },
      );
      expect(reload.reloads()).toBe(0); // never a blind reload

      // The failed copy names the last saved version (the base version).
      expect(screen.getByTestId("device-lost-copy")).toHaveTextContent(/ver_base/);
      expect(screen.getByTestId("device-lost-reload")).toBeInTheDocument();

      // Try again re-enters the recovery save, fails again → buttons return.
      fireEvent.click(screen.getByTestId("device-lost-retry"));
      await waitFor(
        () => {
          expect(screen.getByTestId("device-lost-retry")).toBeInTheDocument();
        },
        { timeout: 4000 },
      );

      fireEvent.click(screen.getByTestId("device-lost-reload"));
      expect(reload.reloads()).toBe(1);

      // The deliberate reload bypasses the unsaved-changes guard.
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    } finally {
      reload.restore();
    }
  });

  it("ignores foreign messages (origin, source, type)", async () => {
    const reload = stubLocationReload();
    try {
      const harness = renderHost();
      await bootToOpen(harness);

      // Different origin.
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://evil.test",
          source: iframeWindow(),
          data: { type: "studio:deviceLost", message: "x" },
        }),
      );
      // Different source (not our iframe).
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: window,
          data: { type: "studio:deviceLost", message: "x" },
        }),
      );
      // Different type.
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: iframeWindow(),
          data: { type: "other", message: "x" },
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(screen.queryByTestId("device-lost-overlay")).not.toBeInTheDocument();
      expect(reload.reloads()).toBe(0);
    } finally {
      reload.restore();
    }
  });

  it("read-only session: straight to a fresh editor (no upload of ours)", async () => {
    const reload = stubLocationReload();
    try {
      const harness = renderHost({ lease: createFakeLeasePort("refused") });
      await bootToOpen(harness);

      reportDeviceLost();

      await waitFor(
        () => {
          expect(reload.reloads()).toBe(1);
        },
        { timeout: 4000 },
      );
      expect(harness.fakeClient.calls.uploads).toHaveLength(0);
    } finally {
      reload.restore();
    }
  });

  it("clean project: nothing owed — straight reload, never the failed stage", async () => {
    const reload = stubLocationReload();
    try {
      const harness = renderHost();
      await bootToOpen(harness);
      // (no editProject: the project is clean — the server already has it all)

      reportDeviceLost();

      await waitFor(
        () => {
          expect(reload.reloads()).toBe(1);
        },
        { timeout: 4000 },
      );
      expect(screen.queryByTestId("device-lost-retry")).not.toBeInTheDocument();
      expect(harness.fakeClient.calls.uploads).toHaveLength(0);
    } finally {
      reload.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// GPU compatibility mode (M3 tail 6) — the WebGL2 fallback boot after a
// device loss this tab session
// ---------------------------------------------------------------------------

describe("EditorHost — GPU compatibility mode", () => {
  it("boots the iframe on the WebGL2 compatibility URL and shows the banner", async () => {
    sessionStorage.setItem(GPU_FALLBACK_MARKER, "1");
    const harness = renderHost();

    // The iframe document URL carries gpu=webgl2 (the dist's no-adapter path:
    // WebGL2 context first, egui-wgpu on its WebGL backend) + nogpuworkers
    // (frame/job workers render on their CPU — their own WebGPU devices
    // would die the same way the presentation device did).
    expect(screen.getByTestId("editor-iframe")).toHaveAttribute(
      "src",
      "/editor/?empty&gpu=webgl2&nogpuworkers",
    );

    await bootToOpen(harness);

    // The banner names the cost and offers the way back to WebGPU.
    expect(screen.getByTestId("editor-gpu-fallback-banner")).toBeInTheDocument();
    expect(screen.getByTestId("editor-gpu-retry-webgpu")).toBeInTheDocument();
  });

  it("Try WebGPU again clears the breaker and reloads (guard stays quiet)", async () => {
    const reload = stubLocationReload();
    try {
      sessionStorage.setItem(GPU_FALLBACK_MARKER, "1");
      const harness = renderHost();
      await bootToOpen(harness);

      fireEvent.click(screen.getByTestId("editor-gpu-retry-webgpu"));

      expect(reload.reloads()).toBe(1);
      expect(sessionStorage.getItem(GPU_FALLBACK_MARKER)).toBe(null);
      // A deliberate reload: no unsaved-changes double-prompt.
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    } finally {
      reload.restore();
    }
  });

  it("the banner is dismissable for the session", async () => {
    sessionStorage.setItem(GPU_FALLBACK_MARKER, "1");
    const harness = renderHost();
    await bootToOpen(harness);

    fireEvent.click(screen.getByTestId("editor-gpu-fallback-dismiss"));
    expect(screen.queryByTestId("editor-gpu-fallback-banner")).not.toBeInTheDocument();
    // The breaker itself stays armed — only the notice is dismissed.
    expect(sessionStorage.getItem(GPU_FALLBACK_MARKER)).toBe("1");
  });

  it("no marker: the plain WebGPU boot, no banner", async () => {
    const harness = renderHost();
    expect(screen.getByTestId("editor-iframe")).toHaveAttribute("src", "/editor/?empty");
    await bootToOpen(harness);
    expect(screen.queryByTestId("editor-gpu-fallback-banner")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Read-only enforcement (§9.3 / M3.5 badge)
// ---------------------------------------------------------------------------

describe("EditorHost — read-only lease", () => {
  it("refused acquire → read-only badge + banner, and no controller is created", async () => {
    const harness = renderHost({ lease: createFakeLeasePort("refused") });
    await bootToOpen(harness);

    expect(screen.getByTestId("editor-readonly-banner")).toHaveTextContent(
      "Opened read-only — Dana Flow is editing.",
    );
    expect(screen.getByTestId("editor-readonly-badge")).toBeInTheDocument();

    // Cmd+S must go nowhere (no autosave controller exists → nothing uploads).
    await editProject();
    pressCmdS();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(harness.fakeClient.calls.uploads).toHaveLength(0);
    expect(screen.queryByTestId("editor-saved-chip")).not.toBeInTheDocument();
  });

  it("a failed lease check falls back permissive with the warning banner", async () => {
    const harness = renderHost({ lease: createFakeLeasePort("fail") });
    await bootToOpen(harness);

    expect(screen.getByTestId("editor-lease-warning")).toBeInTheDocument();
    expect(screen.queryByTestId("editor-readonly-banner")).not.toBeInTheDocument();

    // Saves still work — the controller exists.
    await editProject();
    pressCmdS();
    await waitFor(
      () => {
        expect(harness.fakeClient.calls.uploads).toHaveLength(1);
      },
      { timeout: 4000 },
    );
  });
});

// ---------------------------------------------------------------------------
// Shortcut forwarding (M3.6 / D-5)
// ---------------------------------------------------------------------------

describe("EditorHost — shortcuts", () => {
  it("forwards Cmd/Ctrl+K from inside the iframe onto the chat bus (D-5: inline edit)", async () => {
    const harness = renderHost();
    await bootToOpen(harness);

    const w = iframeWindow();
    w.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }),
    );
    expect(harness.bus.recent()).toEqual([
      expect.objectContaining({ shortcut: "inlineEdit", key: "k" }),
    ]);

    // Handled events are stopped before the editor sees them.
    const event = new KeyboardEvent("keydown", {
      key: "l",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    w.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(harness.bus.recent()).toHaveLength(2);
    expect(harness.bus.recent()[1]?.shortcut).toBe("toggleChat");
  });
});

// ---------------------------------------------------------------------------
// M4-J: the chat layer over the editor (additive overlay, D-18)
// ---------------------------------------------------------------------------

/** A stub api-client covering exactly the calls the ChatProvider makes. */
function createStubChatClient() {
  const calls = { modelsListed: 0, threadsCreated: [] as string[] };
  const client = {
    threads: {
      create: async (projectId: string) => {
        calls.threadsCreated.push(projectId);
        return {
          id: `thr_${calls.threadsCreated.length}`,
          projectId,
          title: null,
          createdBy: "usr_test",
          createdAt: "2026-10-22T00:00:00.000Z",
          updatedAt: "2026-10-22T00:00:00.000Z",
        };
      },
    },
    models: {
      list: async () => {
        calls.modelsListed += 1;
        return {
          plan: "trial",
          models: [
            {
              id: "studio-fast",
              tier: "fast",
              use: "Cheap planning, classification, quick edits",
              creditsPer1kInput: 0.01,
              creditsPer1kOutput: 0.03,
            },
          ],
        };
      },
    },
    chat: {
      stream: () => ({
        paused: false,
        cancel: async () => undefined,
        abort: () => undefined,
        reconnect: async () => undefined,
      }),
    },
    runs: { postEvent: async () => null },
  } as unknown as ApiClient;
  return { client, calls };
}

describe("EditorHost — M4-J chat layer", () => {
  it("mounts no chat layer when the injected session has no api client", async () => {
    const harness = renderHost();
    await bootToOpen(harness);
    expect(screen.queryByTestId("chat-layer")).not.toBeInTheDocument();
    expect(slotMock.mounts).toHaveLength(0);
  });

  it("mounts the chat provider + slot over the OPEN editor with the page's ids, bus and dock wiring", async () => {
    const stub = createStubChatClient();
    const harness = renderHost({ chatApi: stub.client });
    await bootToOpen(harness);

    // The overlay layer + the real provider mounted (models fetched through
    // the session's api client exactly once on open).
    await waitFor(() => {
      expect(screen.getByTestId("chat-layer")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByTestId("chat-panel-slot-mock")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(stub.calls.modelsListed).toBe(1);
    });

    const mount = slotMock.mounts[slotMock.mounts.length - 1] as NonNullable<
      (typeof slotMock.mounts)[number]
    >;
    expect(slotMock.mounts[slotMock.mounts.length - 1]).toBeDefined();
    expect(mount.api.shortcutBus).toBe(harness.bus); // the page's bus flows through
    expect(typeof mount.onSidebarDock).toBe("function");

    // The lazily-created thread uses the RSC payload's project id.
    await act(async () => {
      mount.api.send({ message: "what is here?" });
    });
    await waitFor(() => {
      expect(stub.calls.threadsCreated).toEqual(["prj_test"]);
    });
    expect(screen.getByTestId("editor-iframe")).not.toHaveAttribute("style"); // never restyled

    // Sidebar dock (D-18): the viewport WRAPPER resizes; the iframe keeps its own styles.
    await act(async () => {
      mount.onSidebarDock(true, 380);
    });
    expect(screen.getByTestId("editor-viewport")).toHaveStyle({ width: "calc(100% - 380px)" });
    await act(async () => {
      mount.onSidebarDock(false, 380);
    });
    expect(screen.getByTestId("editor-viewport")).not.toHaveStyle({
      width: "calc(100% - 380px)",
    });
  });
});
