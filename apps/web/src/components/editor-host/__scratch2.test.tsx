import type { ApiClient } from "@studio/api-client";
import { type FakeEditorSessionClient, createFakeEditorSessionClient } from "@/lib/editor-session";
import { createFakeEditor } from "@studio/editor-bridge/fake";
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createChatShortcutBus } from "./chat-shortcut-bus";
import { EditorHost } from "./editor-host";
import type { EditorHostPayload } from "./types";

const PAYLOAD: EditorHostPayload = {
  workspaceId: "ws_test",
  manifest: {
    project: { id: "prj_test", slug: "test-project", name: "Test Project" },
    currentVersion: { id: "ver_base", label: null, sha256: "0".repeat(64), sizeBytes: 4096 },
    assets: [],
    projectFileUrl: "https://storage.test/t.ecproj",
  },
};

vi.mock("@/components/editor-host/chat-panel-slot", () => ({
  ChatPanelSlot: (props: { api: { send: (input: { message: string }) => void } }) => {
    (globalThis as Record<string, unknown>).__slotSend = props.api.send;
    return <div data-testid="chat-panel-slot-mock" />;
  },
}));

describe("scratch2", () => {
  it("send through the mounted provider", async () => {
    const sessionClient: FakeEditorSessionClient = createFakeEditorSessionClient();
    const threadsCreated: string[] = [];
    const stub = {
      threads: { create: async (projectId: string) => { threadsCreated.push(projectId); return { id: "thr_1", projectId, title: null, createdBy: "u", createdAt: "", updatedAt: "" }; } },
      models: { list: async () => ({ plan: "trial", models: [{ id: "studio-fast", tier: "fast", use: "", creditsPer1kInput: 0.01, creditsPer1kOutput: 0.03 }] }) },
      chat: { stream: () => { console.log("[s] stream called"); return { paused: false, cancel: async () => {}, abort() {}, reconnect: async () => {} }; } },
      runs: { postEvent: async () => null },
    } as unknown as ApiClient;
    const fake = createFakeEditor({ version: "0.13.0" });
    const bus = createChatShortcutBus();
    render(
      <EditorHost
        payload={PAYLOAD}
        sessionFactory={() => ({ client: sessionClient.client, leases: { acquire: async () => ({ acquired: true, holderName: "Maya", readOnly: false }), release: async () => {} }, api: stub })}
        shortcutBus={bus}
      />,
    );
    const w = screen.getByTestId("editor-iframe").contentWindow as Record<string, unknown>;
    w.effectcraftLoad = { wasmMs: 42, readyMs: 64 };
    w.effectcraft = {
      request: (m: string, p?: unknown) => fake.request(m, p ?? {}),
      execute: (c: string, p?: unknown) => fake.request("engine.execute", { command: c, params: p ?? {} }),
      commands: () => fake.request("engine.commands", {}),
      inspect: () => fake.request("ui.inspect", {}),
      screenshot: (p?: unknown) => fake.request("ui.screenshot", p ?? {}),
      renderFrame: (p?: unknown) => fake.request("render.frame", { base64: true, ...(p ?? {}) }),
      files: () => fake.files(),
      readFile: (path: string) => fake.readFile(path),
      addFile: (f: unknown, n?: string) => fake.addFile(f, n),
      info: () => ({ ...(fake.info() as Record<string, unknown>), load: { wasmMs: 42, readyMs: 64 } }),
      saveToBrowser: (path?: string) => fake.saveToBrowser(path),
      listStored: () => fake.listStored(),
      removeStored: (path: string) => fake.removeStored(path),
      flush: () => fake.flush(),
      workerFrameCheck: (p?: unknown) => fake.workerFrameCheck(p ?? {}),
    };
    await waitFor(() => expect(screen.getByTestId("editor-host")).toHaveAttribute("data-editor-phase", "open"), { timeout: 4000 });
    await waitFor(() => expect(screen.getByTestId("chat-layer")).toBeInTheDocument());
    console.log("[s] layer mounted; sending");
    const send = (globalThis as Record<string, unknown>).__slotSend as (input: { message: string }) => void;
    await act(async () => { send({ message: "what is here?" }); });
    console.log("[s] act done; threads:", JSON.stringify(threadsCreated));
    expect(threadsCreated).toEqual(["prj_test"]);
  }, 15000);
});
