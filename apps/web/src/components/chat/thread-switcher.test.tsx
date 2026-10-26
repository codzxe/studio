/**
 * ThreadSwitcher tests (ROUND 12 "Chat UI v3" — the thread switcher
 * dropdown). Pure-props component: rows in via `threads`, switches out via
 * `onOpenThread` (the hook's adoptThread), New chat via `onNewThread`.
 */

import { ThreadSwitcher, threadSwitcherLabel } from "@/components/chat/thread-switcher";
import type { Thread } from "@studio/contracts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

function thread(id: string, title: string | null, updatedAt: string): Thread {
  return {
    id,
    projectId: "proj_1",
    title,
    createdBy: "user_1",
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt,
  };
}

const THREADS: readonly Thread[] = [
  thread("thr_2", "Motion graphics pass", "2026-10-22T10:00:00.000Z"),
  thread("thr_1", null, "2026-10-21T10:00:00.000Z"),
];

function mount(options?: {
  readonly activeThreadId?: string | null;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly threads?: readonly Thread[];
}) {
  const onOpenThread = vi.fn();
  const onNewThread = vi.fn();
  render(
    <ThreadSwitcher
      threads={options?.threads ?? THREADS}
      activeThreadId={options?.activeThreadId ?? null}
      disabled={options?.disabled}
      loading={options?.loading}
      onOpenThread={onOpenThread}
      onNewThread={onNewThread}
    />,
  );
  return { onOpenThread, onNewThread };
}

describe("ThreadSwitcher", () => {
  it("labels the active thread (fallback Untitled chat)", async () => {
    const user = userEvent.setup();
    mount({ activeThreadId: "thr_2" });
    expect(screen.getByTestId("chat-thread-switcher").textContent).toContain(
      "Motion graphics pass",
    );
    // Untitled rows render the honest fallback.
    await user.click(screen.getByTestId("chat-thread-switcher"));
    const menu = screen.getByTestId("chat-thread-menu");
    expect(within(menu).getByText("Untitled chat")).toBeInTheDocument();
  });

  it("switches through onOpenThread and never re-picks the active row", async () => {
    const user = userEvent.setup();
    const { onOpenThread } = mount({ activeThreadId: "thr_2" });
    await user.click(screen.getByTestId("chat-thread-switcher"));
    const menu = screen.getByTestId("chat-thread-menu");
    // The ACTIVE row is marked aria-current…
    const rows = within(menu).getAllByTestId("chat-thread-option");
    const activeRow = rows.find((row) => row.getAttribute("data-thread-id") === "thr_2");
    expect(activeRow).toBeDefined();
    expect(activeRow).toHaveAttribute("aria-current", "true");
    // …and clicking it must not re-fire the switch (we're already there).
    await user.click(activeRow as HTMLElement);
    expect(onOpenThread).not.toHaveBeenCalled();
  });

  it("picks a different thread through onOpenThread", async () => {
    const user = userEvent.setup();
    const { onOpenThread } = mount({ activeThreadId: "thr_1" });
    await user.click(screen.getByTestId("chat-thread-switcher"));
    const menu = screen.getByTestId("chat-thread-menu");
    const options = within(menu).getAllByTestId("chat-thread-option");
    await user.click(options[0] as HTMLElement);
    expect(onOpenThread).toHaveBeenCalledWith("thr_2", "Motion graphics pass");
  });

  it("starts a new chat through the pinned gesture", async () => {
    const user = userEvent.setup();
    const { onNewThread } = mount();
    await user.click(screen.getByTestId("chat-thread-switcher"));
    await user.click(screen.getByTestId("chat-thread-new"));
    expect(onNewThread).toHaveBeenCalledTimes(1);
  });

  it("renders the loading state honestly", async () => {
    const user = userEvent.setup();
    mount({ threads: [], loading: true });
    await user.click(screen.getByTestId("chat-thread-switcher"));
    expect(screen.getByTestId("chat-thread-menu-loading")).toBeInTheDocument();
  });

  it("renders the empty state honestly (no rows, the fallback copy)", async () => {
    const user = userEvent.setup();
    const { onNewThread } = mount({ threads: [] });
    await user.click(screen.getByTestId("chat-thread-switcher"));
    expect(screen.getByText("No past chats yet.")).toBeInTheDocument();
    expect(onNewThread).not.toHaveBeenCalled();
  });
});

describe("threadSwitcherLabel", () => {
  it("resolves the active thread's title, null-id and unknown ids fall back", () => {
    expect(threadSwitcherLabel(THREADS, "thr_2", "Fallback")).toBe("Motion graphics pass");
    expect(threadSwitcherLabel(THREADS, null, "Fallback")).toBe("Fallback");
    expect(threadSwitcherLabel(THREADS, "thr_missing", "Fallback")).toBe("Fallback");
    // An untitled active thread ALSO falls back (never an empty chip).
    expect(threadSwitcherLabel(THREADS, "thr_1", "Fallback")).toBe("Fallback");
  });
});
