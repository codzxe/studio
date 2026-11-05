/**
 * ChatSidebar tests (the chat-first ChatGPT-class rail) — the New-chat
 * gesture, the client-side search filter, date-grouped ordering (newest
 * first, Today→Older), the active-thread highlight, the live-run switch
 * guard and the Open-Engine foot. Deterministic; no network; jsdom.
 */

import type { Thread } from "@studio/contracts";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ChatSidebar, groupThreads, threadDateGroup } from "./chat-sidebar";

function thread(id: string, title: string | null, updatedAt: string): Thread {
  return {
    id,
    projectId: "prj_1",
    title,
    createdBy: "usr_1",
    createdAt: updatedAt,
    updatedAt,
  };
}

const NOW = new Date("2026-11-05T12:00:00Z");

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

const props = () => ({
  threads: [
    thread("t1", "Launch film", daysAgo(0)),
    thread("t2", "Logo loop", daysAgo(1)),
    thread("t3", "Old draft", daysAgo(3)),
    thread("t4", "Ancient", daysAgo(45)),
    thread("t5", null, daysAgo(0)),
  ] satisfies readonly Thread[],
  activeThreadId: "t1",
  onOpenThread: vi.fn(),
  onNewThread: vi.fn(),
  onOpenEngine: vi.fn(),
});

describe("ChatSidebar — thread list", () => {
  it("renders every thread with the untitled fallback and highlights the active row", () => {
    render(<ChatSidebar {...props()} />);
    const rows = screen.getAllByTestId("studio-thread-row");
    expect(rows).toHaveLength(5);
    expect(screen.getByText("Untitled chat")).toBeInTheDocument();

    const active = rows.find((row) => row.getAttribute("data-thread-id") === "t1");
    expect(active).toHaveAttribute("aria-current", "true");
    expect(active?.className).toContain("bg-elevated");
  });

  it("groups threads Today / Yesterday / Previous 7 days / Older", () => {
    render(<ChatSidebar {...props()} />);
    const labels = screen.getAllByRole("heading").map((heading) => heading.textContent);
    expect(labels).toEqual(["Today", "Yesterday", "Previous 7 days", "Older"]);
    // Every rendered row is still present:
    expect(screen.getAllByTestId("studio-thread-row")).toHaveLength(5);
  });

  it("orders rows newest-first within the rail's DOM order", () => {
    render(<ChatSidebar {...props()} />);
    const ids = screen
      .getAllByTestId("studio-thread-row")
      .map((row) => row.getAttribute("data-thread-id"));
    expect(ids).toEqual(["t1", "t5", "t2", "t3", "t4"]);
  });
});

describe("ChatSidebar — gestures", () => {
  it("fires onNewThread from the New chat button", async () => {
    const user = userEvent.setup();
    const onNewThread = vi.fn();
    render(<ChatSidebar {...props()} onNewThread={onNewThread} />);
    await user.click(screen.getByTestId("studio-sidebar-new-chat"));
    expect(onNewThread).toHaveBeenCalledOnce();
  });

  it("opens a thread and reports its title; clicking the ACTIVE row only closes", async () => {
    const user = userEvent.setup();
    const onOpenThread = vi.fn();
    const onClose = vi.fn();
    render(<ChatSidebar {...props()} onOpenThread={onOpenThread} onClose={onClose} />);

    const rows = screen.getAllByTestId("studio-thread-row");
    const other = rows.find((row) => row.getAttribute("data-thread-id") === "t2");
    await user.click(other as HTMLElement);
    expect(onOpenThread).toHaveBeenCalledWith("t2", "Logo loop");

    const active = rows.find((row) => row.getAttribute("data-thread-id") === "t1");
    await user.click(active as HTMLElement);
    expect(onOpenThread).toHaveBeenCalledOnce(); // no re-open of the live thread
    expect(onClose).toHaveBeenCalled();
  });

  it("disables switching while a run is live (and New chat with it)", () => {
    render(<ChatSidebar {...props()} disabled />);
    expect(screen.getByTestId("studio-sidebar-new-chat")).toBeDisabled();
    for (const row of screen.getAllByTestId("studio-thread-row")) {
      const isActive = row.getAttribute("data-thread-id") === "t1";
      expect((row as HTMLButtonElement).disabled).toBe(!isActive);
    }
  });

  it("fires the Open-Engine foot CTA", async () => {
    const user = userEvent.setup();
    const onOpenEngine = vi.fn();
    render(<ChatSidebar {...props()} onOpenEngine={onOpenEngine} />);
    await user.click(screen.getByTestId("studio-sidebar-open-engine"));
    expect(onOpenEngine).toHaveBeenCalledOnce();
  });
});

describe("ChatSidebar — search", () => {
  it("filters the list by title (client-side, no wire call)", async () => {
    const user = userEvent.setup();
    render(<ChatSidebar {...props()} />);
    await user.type(screen.getByTestId("studio-sidebar-search"), "logo");
    const ids = screen
      .getAllByTestId("studio-thread-row")
      .map((row) => row.getAttribute("data-thread-id"));
    expect(ids).toEqual(["t2"]);
  });

  it("shows the no-match copy and a clear affordance", async () => {
    const user = userEvent.setup();
    render(<ChatSidebar {...props()} />);
    await user.type(screen.getByTestId("studio-sidebar-search"), "zzz");
    expect(screen.getByText("No chats match.")).toBeInTheDocument();
    await user.click(screen.getByLabelText("Clear search"));
    expect(screen.getAllByTestId("studio-thread-row")).toHaveLength(5);
  });

  it("shows the empty copy when the project has no threads", () => {
    render(<ChatSidebar {...props()} threads={[]} />);
    expect(screen.getByText("No past chats yet.")).toBeInTheDocument();
  });
});

describe("groupThreads / threadDateGroup (pure)", () => {
  it("buckets by day distance with case-insensitive search", () => {
    const threads = [
      thread("a", "Alpha cut", daysAgo(0)),
      thread("b", "beta cut", daysAgo(2)),
      thread("c", null, daysAgo(20)),
    ] satisfies readonly Thread[];
    const grouped = groupThreads(threads, "CUT", NOW);
    expect(grouped.map((group) => group.label)).toEqual(["Today", "Previous 7 days"]);
    expect(grouped[1]?.items.map((entry) => entry.id)).toEqual(["b"]);

    expect(threadDateGroup(daysAgo(0), NOW)).toBe("Today");
    expect(threadDateGroup(daysAgo(1), NOW)).toBe("Yesterday");
    expect(threadDateGroup(daysAgo(7), NOW)).toBe("Previous 7 days");
    expect(threadDateGroup(daysAgo(30), NOW)).toBe("Previous 30 days");
    expect(threadDateGroup(daysAgo(31), NOW)).toBe("Older");
    expect(threadDateGroup("not-a-date", NOW)).toBe("Older");
  });
});

describe("ChatSidebar — drawer variant", () => {
  it("renders the close affordance only in drawer mode", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender } = render(<ChatSidebar {...props()} onClose={onClose} />);
    expect(screen.queryByTestId("studio-sidebar-close")).not.toBeInTheDocument();

    rerender(<ChatSidebar {...props()} onClose={onClose} variant="drawer" />);
    fireEvent.click(screen.getByTestId("studio-sidebar-close"));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
