/**
 * AuditLogView tests (W2-07) — the §8.9 "Audit" surface:
 *
 * - the log rows: time/actor/action/targetType, null-actor honesty ("A
 *   member"), cursor load-more with dedupe;
 * - the filter split: `targetType` is SERVER-side (rides every fetch — first
 *   page and load-more — and resets the list), the action filter is
 *   CLIENT-side over the loaded rows (no refetch);
 * - the CSV export: real RFC-4180 serialization of the LOADED (and action-
 *   filtered) rows, bounded at 500, escaping quotes/commas/newlines;
 * - the typed error banner + retry, the honest empty states.
 *
 * Deterministic RTL; the port is faked; no network.
 */

import { ApiError } from "@studio/api-client";
import type { AuditEntry } from "@studio/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUDIT_CSV_MAX_ROWS,
  AuditLogView,
  auditRowsToCsv,
  csvCell,
  formatAuditTimestamp,
} from "./audit-log-view";
import type { SettingsPort } from "./settings-port";

// ---------------------------------------------------------------------------
// Fixtures (the §9.1 audit shapes)
// ---------------------------------------------------------------------------

const NOW_ISO = "2026-10-21T12:00:00Z";

function auditEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: "aud_1",
    actorId: "user_1",
    actorName: "Alex",
    action: "run.applied",
    targetType: "project",
    targetId: "prj_demo",
    createdAt: "2026-10-21T09:30:00Z",
    ...overrides,
  };
}

function fakePort(overrides: Partial<SettingsPort> = {}): SettingsPort {
  return {
    createApiKey: vi.fn().mockRejectedValue(new Error("not stubbed")),
    listApiKeys: vi.fn().mockRejectedValue(new Error("not stubbed")),
    revokeApiKey: vi.fn().mockRejectedValue(new Error("not stubbed")),
    listAudit: vi.fn().mockRejectedValue(new Error("not stubbed")),
    listModels: vi.fn().mockRejectedValue(new Error("not stubbed")),
    getSettings: vi.fn().mockRejectedValue(new Error("not stubbed")),
    updateSettings: vi.fn().mockRejectedValue(new Error("not stubbed")),
    ...overrides,
  };
}

function renderView(port: SettingsPort) {
  return render(<AuditLogView workspaceId="ws_first" nowIso={NOW_ISO} api={port} />);
}

/** Keyboard-opens a Radix Select and picks the option `steps` arrows down. */
async function pickSelectOption(
  user: ReturnType<typeof userEvent.setup>,
  trigger: HTMLElement,
  steps: number,
): Promise<void> {
  trigger.focus();
  await user.keyboard("{ArrowDown}"); // open + highlight the selected option
  for (let i = 0; i < steps; i += 1) {
    await user.keyboard("{ArrowDown}");
  }
  await user.keyboard("{Enter}");
}

/** jsdom's Blob lacks .text() — read it through FileReader. */
function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

const createObjectURL = vi.fn().mockReturnValue("blob:audit-mock");
const revokeObjectURL = vi.fn();

beforeEach(() => {
  vi.restoreAllMocks();
  createObjectURL.mockClear();
  createObjectURL.mockReturnValue("blob:audit-mock");
  revokeObjectURL.mockClear();
  // jsdom ships no URL.createObjectURL — the export path stubs it.
  Object.defineProperty(URL, "createObjectURL", {
    value: createObjectURL,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    value: revokeObjectURL,
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  Object.defineProperty(URL, "createObjectURL", {
    value: undefined,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    value: undefined,
    writable: true,
    configurable: true,
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("auditRowsToCsv (bounded, real RFC-4180)", () => {
  it("serializes the header + one line per row", () => {
    const result = auditRowsToCsv([
      auditEntry(),
      auditEntry({
        id: "aud_2",
        actorName: null,
        action: "member.invited",
        targetType: null,
        targetId: null,
      }),
    ]);
    expect(result.rowCount).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.csv).toBe(
      [
        "time,actor,action,targetType,targetId",
        "2026-10-21T09:30:00Z,Alex,run.applied,project,prj_demo",
        "2026-10-21T09:30:00Z,A member,member.invited,,",
      ].join("\r\n"),
    );
  });

  it("escapes quotes, commas and newlines by quoting + doubling", () => {
    expect(csvCell('weird,"quoted"')).toBe('"weird,""quoted"""');
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(csvCell("plain")).toBe("plain");
  });

  it("bounds the export at 500 rows and reports the cut", () => {
    const rows = Array.from({ length: AUDIT_CSV_MAX_ROWS + 3 }, (_, i) =>
      auditEntry({ id: `aud_${i}`, action: `action.${i}` }),
    );
    const result = auditRowsToCsv(rows);
    expect(result.rowCount).toBe(AUDIT_CSV_MAX_ROWS);
    expect(result.truncated).toBe(true);
    expect(result.csv.split("\r\n")).toHaveLength(AUDIT_CSV_MAX_ROWS + 1);
  });
});

describe("formatAuditTimestamp", () => {
  it("renders the §14 datetime style, UTC-pinned; hostile ISO degrades to —", () => {
    expect(formatAuditTimestamp("2026-10-21T09:30:00Z")).toBe("Oct 21, 2026, 09:30");
    expect(formatAuditTimestamp("not-a-date")).toBe("—");
  });
});

// ---------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------

describe("AuditLogView — rows", () => {
  it("renders time, actor, action, target type; null actors read 'A member'", async () => {
    const port = fakePort({
      listAudit: vi.fn().mockResolvedValue({
        items: [
          auditEntry(),
          auditEntry({
            id: "aud_2",
            actorName: null,
            action: "member.invited",
            targetType: null,
          }),
        ],
        nextCursor: null,
      }),
    });
    renderView(port);

    const rows = await screen.findAllByTestId("audit-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByTestId("audit-row-actor")).toHaveTextContent("Alex");
    expect(within(rows[0] as HTMLElement).getByTestId("audit-row-action")).toHaveTextContent(
      "run.applied",
    );
    expect(within(rows[0] as HTMLElement).getByTestId("audit-row-target-type")).toHaveTextContent(
      "project",
    );
    expect(within(rows[0] as HTMLElement).getByTestId("audit-row-time")).toHaveTextContent(
      "Oct 21, 2026, 09:30",
    );
    expect(within(rows[1] as HTMLElement).getByTestId("audit-row-actor")).toHaveTextContent(
      "A member",
    );
    expect(
      within(rows[1] as HTMLElement).queryByTestId("audit-row-target-type"),
    ).not.toBeInTheDocument();

    expect(port.listAudit).toHaveBeenCalledWith("ws_first", { limit: 25 });
  });

  it("load-more passes the cursor back and merges (dedupe by id)", async () => {
    const port = fakePort({
      listAudit: vi
        .fn()
        .mockResolvedValueOnce({
          items: [auditEntry()],
          nextCursor: "cursor-2",
        })
        .mockResolvedValueOnce({
          items: [
            auditEntry({ id: "aud_2", action: "render.queued" }),
            auditEntry(), // duplicate id — dropped
          ],
          nextCursor: null,
        }),
    });
    renderView(port);
    await screen.findAllByTestId("audit-row");

    await userEvent.click(screen.getByTestId("audit-load-more"));

    await waitFor(() => {
      expect(port.listAudit).toHaveBeenNthCalledWith(2, "ws_first", {
        cursor: "cursor-2",
        limit: 25,
      });
    });
    await waitFor(() => {
      expect(screen.getAllByTestId("audit-row")).toHaveLength(2);
    });
  });

  it("surfaces the typed error and retries; the empty filter state is honest", async () => {
    const port = fakePort({
      listAudit: vi
        .fn()
        .mockRejectedValueOnce(
          new ApiError({
            code: "INTERNAL_ERROR",
            message: "Something went wrong on our side.",
            status: 500,
          }),
        )
        .mockResolvedValueOnce({ items: [], nextCursor: null }),
    });
    renderView(port);

    expect(await screen.findByTestId("audit-error")).toHaveTextContent(
      "Something went wrong on our side.",
    );
    await userEvent.click(screen.getByTestId("audit-error-retry"));
    expect(await screen.findByTestId("audit-empty")).toHaveTextContent(
      "No audit entries for this filter.",
    );
  });
});

// ---------------------------------------------------------------------------
// The filter split
// ---------------------------------------------------------------------------

describe("AuditLogView — filters", () => {
  it("targetType is SERVER-side: it rides every fetch and resets the list", async () => {
    const port = fakePort({
      listAudit: vi.fn().mockResolvedValue({
        items: [auditEntry()],
        nextCursor: null,
      }),
    });
    const user = userEvent.setup();
    renderView(port);
    await screen.findAllByTestId("audit-row");

    // Open the Target type Select and pick the option one down from "All".
    await pickSelectOption(user, screen.getByTestId("audit-target-type-trigger"), 1);

    await waitFor(() => {
      expect(port.listAudit).toHaveBeenLastCalledWith("ws_first", {
        limit: 25,
        targetType: "project",
      });
    });
  });

  it("the action filter is CLIENT-side: narrows the loaded rows, no refetch", async () => {
    const port = fakePort({
      listAudit: vi.fn().mockResolvedValue({
        items: [
          auditEntry(),
          auditEntry({ id: "aud_2", action: "render.queued" }),
          auditEntry({ id: "aud_3", action: "run.applied" }),
        ],
        nextCursor: null,
      }),
    });
    const user = userEvent.setup();
    renderView(port);
    await screen.findAllByTestId("audit-row");
    expect(screen.getByTestId("audit-row-count")).toHaveTextContent("3 of 3 loaded rows");
    const fetchCount = port.listAudit as ReturnType<typeof vi.fn>;
    const callsAfterLoad = fetchCount.mock.calls.length;

    // Open the Action Select: "All actions" is highlighted, one down is the
    // first loaded action in sorted order (render.queued < run.applied).
    await pickSelectOption(user, screen.getByTestId("audit-action-trigger"), 1);

    await waitFor(() => {
      expect(screen.getAllByTestId("audit-row")).toHaveLength(1);
    });
    expect(screen.getByTestId("audit-row-count")).toHaveTextContent("1 of 3 loaded rows");
    // Client-side only: the port saw NO new call.
    expect(fetchCount.mock.calls.length).toBe(callsAfterLoad);
  });

  it("a stale action filter across a targetType reload shows the in-table empty row and disables the export", async () => {
    // Real path to a no-match state: every listed action option matches the
    // CURRENT rows, but a targetType refetch can replace the rows out from
    // under a still-selected action filter.
    const port = fakePort({
      listAudit: vi
        .fn()
        .mockResolvedValueOnce({
          items: [auditEntry({ action: "render.queued" })],
          nextCursor: null,
        })
        .mockResolvedValueOnce({
          items: [auditEntry()],
          nextCursor: null,
        }),
    });
    const user = userEvent.setup();
    renderView(port);
    await screen.findAllByTestId("audit-row");

    // Action filter = render.queued (one down — the only loaded action).
    await pickSelectOption(user, screen.getByTestId("audit-action-trigger"), 1);
    await waitFor(() => {
      expect(screen.getAllByTestId("audit-row")).toHaveLength(1);
    });

    // Now refilter server-side (targetType = project): the new page carries
    // only run.applied rows — the stale action filter matches nothing.
    await pickSelectOption(user, screen.getByTestId("audit-target-type-trigger"), 1);
    await waitFor(() => {
      expect(port.listAudit).toHaveBeenLastCalledWith("ws_first", {
        limit: 25,
        targetType: "project",
      });
    });

    expect(await screen.findByTestId("audit-no-match")).toHaveTextContent(
      "No loaded rows match this action.",
    );
    expect(screen.queryByTestId("audit-row")).not.toBeInTheDocument();
    // Zero matching rows → nothing to export.
    expect(screen.getByTestId("audit-export-csv")).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

describe("AuditLogView — CSV export", () => {
  it("downloads the loaded rows as a real CSV through a Blob", async () => {
    const port = fakePort({
      listAudit: vi.fn().mockResolvedValue({
        items: [auditEntry(), auditEntry({ id: "aud_2", action: "render.queued" })],
        nextCursor: null,
      }),
    });
    renderView(port);
    await screen.findAllByTestId("audit-row");

    await userEvent.click(screen.getByTestId("audit-export-csv"));

    await waitFor(() => {
      expect(createObjectURL).toHaveBeenCalledTimes(1);
    });
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    const text = await blobText(blob);
    expect(text).toContain("time,actor,action,targetType,targetId");
    expect(text).toContain("2026-10-21T09:30:00Z,Alex,run.applied,project,prj_demo");
    expect(text).toContain("render.queued");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:audit-mock");
  });

  it("exports the action-FILTERED rows", async () => {
    const port = fakePort({
      listAudit: vi.fn().mockResolvedValue({
        items: [auditEntry(), auditEntry({ id: "aud_2", action: "render.queued" })],
        nextCursor: null,
      }),
    });
    const user = userEvent.setup();
    renderView(port);
    await screen.findAllByTestId("audit-row");

    // Filter to render.queued, then export — only that row ships.
    await pickSelectOption(user, screen.getByTestId("audit-action-trigger"), 1);
    await waitFor(() => {
      expect(screen.getAllByTestId("audit-row")).toHaveLength(1);
    });
    await userEvent.click(screen.getByTestId("audit-export-csv"));
    await waitFor(() => {
      expect(createObjectURL).toHaveBeenCalledTimes(1);
    });
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    const text = await blobText(blob);
    expect(text).toContain("render.queued");
    expect(text).not.toContain("run.applied");
  });
});
