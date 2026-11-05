/**
 * ChatFirstStudio tests (round 16 — the chat-first studio route).
 *
 * The component's contract is the SHELL: one persistent mode bar, ONE engine
 * mount that flips between hidden (chat) and visible (engine), and an opaque
 * chat layer that unmounts in Engine mode. The heavy children (EditorHost,
 * ChatSurface, capability gate) are mocked at the component seam — their own
 * suites cover their internals; here we pin the mode/visibility behavior.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { EditorHostPayload, EditorSessionFactory } from "@/components/editor-host/types";
import type { ApiClient } from "@studio/api-client";

vi.mock("@/components/editor-host/editor-host", () => ({
  EditorHost: ({ payload }: { payload: EditorHostPayload }) => (
    <div data-testid="editor-host-stub">{payload.manifest.project.name}</div>
  ),
}));

vi.mock("@/components/editor-host/capability-gate", () => ({
  EditorCapabilityGate: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="capability-gate-stub">{children}</div>
  ),
}));

vi.mock("@/components/chat-studio/chat-surface", () => ({
  ChatSurface: () => <div data-testid="chat-surface-stub">chat</div>,
}));

import { ChatFirstStudio } from "@/components/chat-studio/chat-first-studio";

function makePayload(): EditorHostPayload {
  return {
    workspaceId: "ws_1",
    manifest: {
      project: { id: "prj_1", slug: "the-line", name: "THE LINE" },
      currentVersion: null,
      assets: [],
      projectFileUrl: null,
    },
  };
}

const sessionStub = {
  client: {} as EditorSessionFactory["client"],
  leases: {} as EditorSessionFactory["leases"],
  // The chat face mounts only when the session carries an api-client —
  // the same rule the editor host applies to its own chat layer.
  api: {} as ApiClient,
} satisfies EditorSessionFactory;

describe("ChatFirstStudio", () => {
  it("mounts Chat as the DEFAULT mode with the engine live but hidden", () => {
    const { container } = render(
      <ChatFirstStudio payload={makePayload()} sessionFactory={() => sessionStub} />,
    );
    // Chat layer present, engine layer hidden but MOUNTED (one session).
    expect(screen.getByTestId("studio-mode-chat").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("studio-mode-engine").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("chat-surface-stub")).toBeTruthy();
    const engineLayer = screen.getByTestId("studio-engine-layer");
    expect(engineLayer.getAttribute("aria-hidden")).toBe("true");
    expect(engineLayer.className).toContain("opacity-0");
    expect(screen.getByTestId("editor-host-stub")).toBeTruthy();
    // The whole shell fills the column under the bar.
    expect(container.querySelector('[data-testid="chat-first-studio"]')).toBeTruthy();
  });

  it("flips to Engine without unmounting the editor, and back", async () => {
    const user = userEvent.setup();
    render(<ChatFirstStudio payload={makePayload()} sessionFactory={() => sessionStub} />);

    await user.click(screen.getByTestId("studio-mode-engine"));
    const engineLayer = screen.getByTestId("studio-engine-layer");
    expect(screen.getByTestId("studio-mode-engine").getAttribute("aria-pressed")).toBe("true");
    // The editor is now VISIBLE (no opacity/aria-hidden) and the chat layer is GONE.
    expect(engineLayer.getAttribute("aria-hidden")).not.toBe("true");
    expect(engineLayer.className).not.toContain("opacity-0");
    expect(screen.queryByTestId("chat-surface-stub")).toBeNull();
    expect(screen.getByTestId("editor-host-stub")).toBeTruthy();

    // ...and back to Chat: the editor stays the SAME mount (no remount).
    await user.click(screen.getByTestId("studio-mode-chat"));
    expect(screen.getByTestId("studio-mode-chat").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("chat-surface-stub")).toBeTruthy();
    expect(screen.getByTestId("editor-host-stub")).toBeTruthy();
  });
});
