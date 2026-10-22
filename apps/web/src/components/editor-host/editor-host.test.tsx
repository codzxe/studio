/**
 * EditorHost component tests (M3.5/M3.6/M3.7 + the M4-J chat layer mount) —
 * the real `attachEditorBridge` against a DIST-SHAPED mount: `window.effectcraft`
 * + `window.effectcraftLoad` installed on the host's own iframe `contentWindow`
 * exactly the way the shipped dist defines them
 * (`apps/web/public/editor/index.html`, from
 * `editor/apps/effectcraft-web/web/index.html`), with the deterministic
 * fake editor behind the API (M3-C's harness pattern).
 *
 * The session engine runs for real (`loadProjectSession` +
 * `createAutosaveController` from @/lib/editor-session) against
 * `createFakeEditorSessionClient`; the lease port is a fake §11 seam.
 * Real timers (the save chain crosses real WebCrypto); every wait uses
 * `vi.waitFor`. No network, no dev servers, deterministic.
 *
 * M4-J: the chat overlay is exercised with the REAL ChatProvider against a
 * stub api-client, with the peer-composed ChatPanelSlot mocked at this seam
 * (the slot's own composition suite lives in chat-panel-slot.test.tsx) — so
 * these tests stay independent of the wave-2 peer components.
 */

import type { ApiClient } from "@studio/api-client";
import { type FakeEditorSessionClient, createFakeEditorSessionClient } from "@/lib/editor-session";
import type { ChatContextApi } from "@/lib/chat/provider";
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
  mounts: [] as Array<{ api: ChatContextApi; onSidebarDock: (docked: boolean, widthPx: number) => void }>,
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
  effectcraftLoad?: WritableLoad;
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
    // dist: `window.effectcraftLoad.error = String(e)` (never readyMs).
    load.error = boot.error;
  }
  w.effectcraftLoad = load;
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
    info: () => ({ ...(fake.info() as Record<string, unknown>), load: w.effectcraftLoad }),
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
});

// ---------------------------------------------------------------------------
// Boot UI (M3.7)
// ---------------------------------------------------------------------------

describe("EditorHost — boot", () => {
  it("shows the loading screen with the project name, then opens", async () => {
    const harness = renderHost();
    // Loading state covers the iframe while the dist boots.
    expect(screen.getByTestId("editor-boot-loading")).toBeInTheDocument();
    expect(screen.getByText(/Preparing “Test Project”/)).toBeInTheDocument();

    await bootToOpen(harness);

    // The project bar carries the name (M3.5 chrome); iframe stays plain.
    expect(screen.getByTestId("editor-project-bar")).toHaveTextContent("Test Project");
    expect(screen.getByTestId("editor-iframe")).toHaveAttribute("src", "/editor/?empty");
    expect(screen.getByTestId("editor-iframe")).toHaveAttribute("title", "Studio editor");
    expect(screen.getByTestId("editor-iframe")).not.toHaveAttribute("allow");
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

    const mount = slotMock.mounts[slotMock.mounts.length - 1];
    expect(mount).toBeDefined();
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

