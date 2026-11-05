/**
 * Studio-export tests — the transcript→markdown renderer, the clipboard copy
 * (primary async-clipboard path + execCommand textarea fallback) and the
 * file download (blob URL + anchor click + revoke, SSR no-op). Pure module;
 * deterministic (frozen clock for the `Exported` line); jsdom.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatUiMessage, ToolCardState } from "@/lib/chat/types";

import { copyTranscript, downloadTranscript, transcriptToMarkdown } from "./studio-export";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function message(
  id: string,
  role: ChatUiMessage["role"],
  text: string,
  toolCards: readonly ToolCardState[] = [],
  runId?: string,
): ChatUiMessage {
  return {
    id,
    role,
    text,
    toolCards,
    ...(runId === undefined ? {} : { runId }),
  };
}

const MIXED = [
  message("m1", "user", "Find where the credits gate lives."),
  message(
    "m2",
    "assistant",
    "The gate lives in services/gateway/src/routes/chat.ts.",
    [
      {
        toolCallId: "tc_1",
        name: "grep_search",
        status: "done",
        args: { query: "INSUFFICIENT_CREDITS" },
      },
      {
        toolCallId: "tc_2",
        name: "read_file",
        status: "failed",
        result: { error: "IO", message: "file gone" },
      },
    ],
    "run_1",
  ),
] satisfies readonly ChatUiMessage[];

const MARKDOWN = "# Credits gate — Studio\n\nExported 2026-11-05T12:00:00.000Z\n";

const FROZEN_NOW = new Date("2026-11-05T12:00:00Z");

/** Runs the callback with the clock frozen so the `Exported` line is exact. */
function withFrozenTime(run: () => void): void {
  vi.useFakeTimers();
  vi.setSystemTime(FROZEN_NOW);
  try {
    run();
  } finally {
    vi.useRealTimers();
  }
}

// ---------------------------------------------------------------------------
// jsdom global restore (clipboard / execCommand / URL object-URL statics)
// ---------------------------------------------------------------------------

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (clipboardDescriptor) {
    Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, "clipboard");
  }
  if (execCommandDescriptor) {
    Object.defineProperty(document, "execCommand", execCommandDescriptor);
  } else {
    Reflect.deleteProperty(document, "execCommand");
  }
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

// ---------------------------------------------------------------------------
// transcriptToMarkdown (pure)
// ---------------------------------------------------------------------------

describe("transcriptToMarkdown (pure)", () => {
  it("renders a ChatGPT-style markdown doc for a mixed transcript", () => {
    withFrozenTime(() => {
      const md = transcriptToMarkdown(MIXED, {
        projectName: "Studio",
        threadTitle: "Credits gate",
      });
      expect(md).toBe(`# Credits gate — Studio

Exported 2026-11-05T12:00:00.000Z

## You

Find where the credits gate lives.

## Agent

The gate lives in services/gateway/src/routes/chat.ts.

Tools:
- grep_search (done)
- read_file (failed)
`);
      // Run bindings, card args/results and plan/credits never leak into the doc.
      expect(md).not.toContain("run_1");
      expect(md).not.toContain("INSUFFICIENT_CREDITS");
    });
  });

  it("falls back to the Chat heading for an untitled thread", () => {
    withFrozenTime(() => {
      const md = transcriptToMarkdown([MIXED[0] as ChatUiMessage], {
        projectName: "Studio",
        threadTitle: null,
      });
      expect(md).toBe(
        "# Chat — Studio\n\nExported 2026-11-05T12:00:00.000Z\n\n## You\n\nFind where the credits gate lives.\n",
      );
    });
  });

  it("emits the header block only for an empty transcript", () => {
    withFrozenTime(() => {
      const md = transcriptToMarkdown([], {
        projectName: "Studio",
        threadTitle: "Credits gate",
      });
      expect(md).toBe("# Credits gate — Studio\n\nExported 2026-11-05T12:00:00.000Z\n");
    });
  });

  it("omits the Tools block for user cards and card-less assistant messages", () => {
    const md = transcriptToMarkdown(
      [
        message("m1", "user", "Run the check", [
          { toolCallId: "tc_0", name: "user_tool", status: "done" },
        ]),
        message("m2", "assistant", "Check complete."),
      ],
      { projectName: "Studio", threadTitle: "T" },
    );
    expect(md).not.toContain("Tools:");
    expect(md).not.toContain("user_tool");
    expect(md).toContain("## You\n\nRun the check\n\n## Agent\n\nCheck complete.\n");
  });

  it("keeps the doc whitespace-clean (single trailing newline, no trailing spaces)", () => {
    const md = transcriptToMarkdown(
      [message("m1", "assistant", "trailing spaces in source   \n\n")],
      { projectName: "Studio", threadTitle: "T" },
    );
    const lines = md.split("\n");
    expect(md.endsWith("\n")).toBe(true);
    expect(md.endsWith("\n\n")).toBe(false);
    expect(lines.at(-1)).toBe("");
    expect(lines.every((line) => line === line.trimEnd())).toBe(true);
    expect(md).toContain("## Agent\n\ntrailing spaces in source\n");
  });
});

// ---------------------------------------------------------------------------
// copyTranscript — clipboard
// ---------------------------------------------------------------------------

describe("copyTranscript — clipboard", () => {
  it("writes through navigator.clipboard when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    await expect(copyTranscript(MARKDOWN)).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(MARKDOWN);
  });

  it("falls back to a hidden textarea + execCommand('copy') when the clipboard API is missing", async () => {
    Reflect.deleteProperty(navigator, "clipboard"); // jsdom has none anyway
    let seen: string | null = null;
    const execCommand = vi.fn(() => {
      seen = document.querySelector("textarea")?.value ?? null;
      return true;
    });
    document.execCommand = execCommand;

    await expect(copyTranscript(MARKDOWN)).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledTimes(1);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(seen).toBe(MARKDOWN);
    expect(document.querySelector("textarea")).toBeNull(); // cleaned up after itself
  });

  it("returns false when execCommand reports a failed copy", async () => {
    Reflect.deleteProperty(navigator, "clipboard");
    document.execCommand = vi.fn(() => false);

    await expect(copyTranscript(MARKDOWN)).resolves.toBe(false);
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("returns false when the async clipboard rejects and no legacy fallback exists", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    Reflect.deleteProperty(document, "execCommand");

    await expect(copyTranscript(MARKDOWN)).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// downloadTranscript — file download
// ---------------------------------------------------------------------------

describe("downloadTranscript — file download", () => {
  it("downloads via a temporary text/markdown anchor and revokes the object URL", () => {
    const createObjectURL = vi.fn((_blob: Blob) => "blob:mock-url");
    const revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    const clicked: HTMLAnchorElement[] = [];
    const click = vi.spyOn(HTMLElement.prototype, "click").mockImplementation(function (
      this: HTMLElement,
    ) {
      clicked.push(this as HTMLAnchorElement);
    });

    downloadTranscript(MARKDOWN, "credits-gate-chat.md");

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]?.[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob?.type).toBe("text/markdown");
    expect(blob?.size).toBeGreaterThan(0);

    expect(click).toHaveBeenCalledTimes(1);
    expect(clicked).toHaveLength(1);
    expect(clicked[0]?.getAttribute("href")).toBe("blob:mock-url");
    expect(clicked[0]?.getAttribute("download")).toBe("credits-gate-chat.md");
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
    expect(document.querySelector("a")).toBeNull(); // anchor removed
  });

  it("is a no-op without a browser (SSR guard)", () => {
    const createObjectURL = vi.fn(() => "blob:never");
    URL.createObjectURL = createObjectURL;
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("document", undefined);

    expect(() => downloadTranscript(MARKDOWN, "chat.md")).not.toThrow();
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
