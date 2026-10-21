/**
 * Table-driven tests for the version-history pure model (W8-G): §10.4
 * timeline invariants, §5.6 diff-bucket grouping/summary, §6.1 failure
 * classification into graceful UI states. No network, no React — the module
 * is import-free. Deterministic, <5 s.
 */
import { describe, expect, it } from "vitest";
import {
  classifyDiffFailure,
  currentRevisionOf,
  diffIsEmpty,
  diffUnavailableBody,
  diffUnavailableHeading,
  emptyDiff,
  formatBounds,
  formatVersionDate,
  groupDiffRowsByLayerName,
  movedRowDetails,
  parseSummaryBucketCounts,
  propLabel,
  shortenAuthorId,
  sortVersionsAscending,
  summarizeDiffCounts,
  type DiffRow,
} from "./version-model";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The §5.6 example from engine-patches/agent_cmds/document_diff.rs, row shape. */
const row = (overrides: Partial<DiffRow> & { layerId: number }): DiffRow => ({
  name: "Headline",
  kind: "text",
  boundsFrom: null,
  boundsTo: null,
  propsChanged: [],
  ...overrides,
});

/** The moved row of the sample diff, reused by the movedRowDetails cases. */
const movedSample = row({
  layerId: 5,
  parentFrom: null,
  parentTo: 7,
  orderFrom: 2,
  orderTo: 0,
  propsChanged: ["opacity"],
});

const sampleDiff = {
  from: 6,
  to: 13,
  added: [row({ layerId: 8, name: "Badge", kind: "pixel", boundsTo: [10, 12, 44, 60] })],
  removed: [row({ layerId: 9, name: "Scratch copy", boundsFrom: [0, 0, 20, 20] })],
  changed: [
    row({ layerId: 2, boundsFrom: [0, 0, 100, 50], boundsTo: [0, 8, 100, 50], propsChanged: ["bounds", "opacity"] }),
    row({ layerId: 4, boundsFrom: [5, 5, 30, 30], boundsTo: [5, 5, 30, 42], propsChanged: ["fill"] }),
  ],
  moved: [movedSample],
};

const version = (revision: number, label = `r${revision}`) => ({
  id: `version-${revision}`,
  revision,
  label,
  createdBy: "user_018f9a4b",
  createdAt: new Date(`2026-07-0${Math.min(revision, 9)}T14:03:05.000Z`),
});

// ---------------------------------------------------------------------------
// Timeline (§10.4)
// ---------------------------------------------------------------------------

describe("sortVersionsAscending", () => {
  it("orders ascending and never mutates the input", () => {
    const input = [version(3), version(1), version(2)];
    const sorted = sortVersionsAscending(input);
    expect(sorted.map((v) => v.revision)).toEqual([1, 2, 3]);
    expect(input.map((v) => v.revision)).toEqual([3, 1, 2]);
  });

  it("is stable for equal revisions", () => {
    const a = version(2, "first");
    const b = version(2, "second");
    expect(sortVersionsAscending([b, a]).map((v) => v.label)).toEqual(["second", "first"]);
  });
});

describe("currentRevisionOf", () => {
  it.each([
    { revisions: [] as number[], expected: null },
    { revisions: [1], expected: 1 },
    { revisions: [1, 4, 2], expected: 4 },
  ])("returns $expected for revisions $revisions", ({ revisions, expected }) => {
    expect(currentRevisionOf(revisions.map((r) => version(r)))).toBe(expected);
  });
});

describe("formatVersionDate", () => {
  it.each([
    { value: "2026-07-04T14:03:05.000Z", expected: "4 Jul 2026, 14:03 UTC" },
    { value: new Date("2026-01-31T00:09:00.000Z"), expected: "31 Jan 2026, 00:09 UTC" },
    { value: new Date("2026-12-09T23:60:00.000Z"), expected: "—" },
  ])("formats $value deterministically", ({ value, expected }) => {
    expect(formatVersionDate(value)).toBe(expected);
  });

  it("ignores local timezone offsets (UTC-only rendering)", () => {
    const local = new Date(2026, 6, 4, 23, 30); // whatever the host timezone is
    const formatted = formatVersionDate(local);
    expect(formatted.endsWith("UTC")).toBe(true);
    expect(formatted).not.toBe("—");
  });
});

describe("shortenAuthorId", () => {
  it.each([
    { id: "018f9a4b", expected: "018f9a4b" },
    { id: "018f9a4b-7c2d-4e11-9f3a-2b6c8d90ef12", expected: "018f9a4b…" },
    { id: "", expected: "" },
  ])("shortens $id to $expected", ({ id, expected }) => {
    expect(shortenAuthorId(id)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Diff helpers (§5.6)
// ---------------------------------------------------------------------------

describe("diffIsEmpty / emptyDiff", () => {
  it("emptyDiff(rev) is the r→r self diff and reports empty", () => {
    const diff = emptyDiff(7);
    expect(diff.from).toBe(7);
    expect(diff.to).toBe(7);
    expect(diffIsEmpty(diff)).toBe(true);
  });

  it("a real diff is not empty", () => {
    expect(diffIsEmpty(sampleDiff)).toBe(false);
  });
});

describe("summarizeDiffCounts", () => {
  it("skips zero buckets and joins with ·", () => {
    expect(summarizeDiffCounts(sampleDiff)).toBe("1 added · 1 removed · 2 changed · 1 moved");
  });

  it("returns null for an empty diff", () => {
    expect(summarizeDiffCounts(emptyDiff(3))).toBeNull();
  });
});

describe("groupDiffRowsByLayerName", () => {
  it("groups duplicate names, preserving first-appearance (layer id) order", () => {
    const rows = [
      row({ layerId: 3, name: "Background" }),
      row({ layerId: 5, name: "Headline" }),
      row({ layerId: 8, name: "Background" }),
    ];
    const groups = groupDiffRowsByLayerName(rows);
    expect(groups.map((g) => g.name)).toEqual(["Background", "Headline"]);
    expect(groups[0]?.rows.map((r) => r.layerId)).toEqual([3, 8]);
    expect(groups[1]?.rows.map((r) => r.layerId)).toEqual([5]);
  });

  it("returns an empty array for no rows", () => {
    expect(groupDiffRowsByLayerName([])).toEqual([]);
  });
});

describe("formatBounds", () => {
  it.each([
    { bounds: [12, 40, 44, 60], expected: "12, 40 · 44×60" },
    { bounds: [0, 0, 1080, 1080], expected: "0, 0 · 1080×1080" },
    { bounds: null, expected: "—" },
  ])("renders $bounds as $expected", ({ bounds, expected }) => {
    expect(formatBounds(bounds)).toBe(expected);
  });
});

describe("movedRowDetails", () => {
  it("describes a parent move", () => {
    const details = movedRowDetails(row({ layerId: 5, parentFrom: 7, parentTo: 2 }));
    expect(details).toEqual(["group 7 → group 2"]);
  });

  it("describes top-level moves and reorders separately", () => {
    expect(movedRowDetails(row({ layerId: 1, parentFrom: null, parentTo: 7 }))).toEqual([
      "top level → group 7",
    ]);
    expect(movedRowDetails(row({ layerId: 1, orderFrom: 4, orderTo: 0 }))).toEqual([
      "position 5 → 1",
    ]);
  });

  it("combines both and stays silent when nothing moved", () => {
    expect(movedRowDetails(movedSample)).toEqual(["top level → group 7", "position 3 → 1"]);
    expect(movedRowDetails(row({ layerId: 2 }))).toEqual([]);
  });
});

describe("propLabel", () => {
  it.each([
    { prop: "opacity", expected: "opacity" },
    { prop: "fill", expected: "fill" },
    { prop: "text", expected: "text" },
    { prop: "bounds", expected: "bounds" },
    { prop: "blend", expected: "blend mode" },
    { prop: "visible", expected: "visibility" },
    { prop: "someFutureProp", expected: "someFutureProp" },
  ])("labels $prop as $expected", ({ prop, expected }) => {
    expect(propLabel(prop)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Failure classification (§6.1 → graceful states)
// ---------------------------------------------------------------------------

describe("classifyDiffFailure", () => {
  it.each([
    {
      name: "manual allowlist refusal",
      input: {
        code: "command_not_allowlisted",
        status: 400,
        message: 'Command "document.diff" is not on the manual allowlist.',
        hint: "See the command palette or the API reference.",
        retryable: false,
      },
      expected: { status: "unavailable", reason: "not_allowlisted" },
    },
    {
      name: "engine patch not applied (Disabled wire string)",
      input: {
        code: "engine_command_failed",
        status: 400,
        message:
          "command `document.diff` is not available right now: no_such_command: unknown engine command",
        retryable: false,
      },
      expected: { status: "unavailable", reason: "engine_patch_missing" },
    },
    {
      name: "engine holds only current + checkpoint revisions",
      input: {
        code: "engine_command_failed",
        status: 400,
        message: "revision_out_of_range: revision 41 is unknown; valid revisions are 1..14",
        hint: "Diff the current revision.",
        retryable: false,
      },
      expected: { status: "unavailable", reason: "revision_not_held" },
    },
    {
      name: "engine session unavailable (retryable)",
      input: {
        code: "engine_session_unavailable",
        status: 503,
        message: "The document has no open editor session.",
        hint: "Open the document first.",
        retryable: true,
      },
      expected: { status: "error", retryable: true },
    },
    {
      name: "network failure (retryable)",
      input: { code: "network_error", status: 0, message: "Could not reach the server.", retryable: true },
      expected: { status: "error", retryable: true },
    },
    {
      name: "auth failure rides through",
      input: { code: "unauthorized", status: 401, message: "Sign in first.", retryable: false },
      expected: { status: "error", retryable: false },
    },
    {
      name: "unknown codes fall back to the server's retryable flag",
      input: { code: "rate_limited", status: 429, message: "Slow down.", retryable: true },
      expected: { status: "error", retryable: true },
    },
  ])("$name", ({ input, expected }) => {
    const state = classifyDiffFailure(input);
    expect(state).toMatchObject(expected);
    // §6.1: the server's message always rides through.
    expect(state).toHaveProperty("message", input.message);
  });
});

describe("unavailable copy", () => {
  it("pins the engine-patch heading for feature-gap reasons only", () => {
    expect(diffUnavailableHeading("engine_patch_missing")).toBe(
      "Diff unavailable (engine patch required)",
    );
    expect(diffUnavailableHeading("not_allowlisted")).toBe(
      "Diff unavailable (engine patch required)",
    );
    expect(diffUnavailableHeading("revision_not_held")).toBe("Diff unavailable");
    expect(diffUnavailableHeading("details_not_exposed")).toBe("Diff unavailable");
  });

  it("gives every reason a non-empty body", () => {
    for (const reason of [
      "not_allowlisted",
      "engine_patch_missing",
      "revision_not_held",
      "details_not_exposed",
    ] as const) {
      expect(diffUnavailableBody(reason).length).toBeGreaterThan(10);
    }
  });
});

describe("parseSummaryBucketCounts", () => {
  it("parses the §6.1 compact summary the commands surface returns", () => {
    expect(
      parseSummaryBucketCounts(
        "document.diff: from=41, to=46, added=<2 items>, removed=<1 items>, changed=<3 items>, moved=<1 items>",
      ),
    ).toEqual({ added: 2, removed: 1, changed: 3, moved: 1 });
  });

  it("is partial when buckets are missing and empty when nothing matches", () => {
    expect(parseSummaryBucketCounts("document.diff: added=<1 items>")).toEqual({ added: 1 });
    expect(parseSummaryBucketCounts("document.diff ok")).toEqual({});
  });
});
