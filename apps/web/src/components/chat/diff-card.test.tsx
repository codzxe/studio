/**
 * PlanDiffCard tests (W1-d) — the EDITOR_CHAT_UX §6.3 semantic diff card:
 * pure derivation over the compiled batch (prop.set/prop.addKey/layer.rename/
 * new-layer/effect/preset/comp commands, `$request:` tokens, numeric refs,
 * last-write-wins merges, keyframe caps, the bounded generic fallback), the
 * live before-value reads through the REAL fake editor bridge (lib/chat/
 * context.ts `collectOldPropertyValues`), the honest "—" when no old value
 * can be known, hostile-batch totality and the tokens-only style law.
 *
 * Driven through the deterministic fake editor (`@studio/editor-bridge/fake`)
 * via the same typed bridge surface the real dist exposes.
 */

import type { AgentBatchInput, EditorBridge } from "@studio/editor-bridge";
import { attachFakeBridge, createFakeEditor } from "@studio/editor-bridge/fake";
import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PlanDiffCard, derivePlanDiff } from "./diff-card";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A deterministic project: comp "Main" with a text layer "Headline". */
async function makeBridgeWithHeadline(): Promise<EditorBridge> {
  const fake = createFakeEditor({ comps: [{ name: "Main", width: 1920, height: 1080 }] });
  await fake.execute("layer.newText", { text: "Headline" }); // id 1, text "Headline"
  return attachFakeBridge(fake);
}

/** The hostile duplicate-name project: TWO layers named "Headline". */
async function makeBridgeWithTwinHeadlines(): Promise<EditorBridge> {
  const fake = createFakeEditor({ comps: [{ name: "Main" }] });
  await fake.execute("layer.newText", { text: "Headline" }); // id 1
  await fake.execute("layer.newText", { text: "Twin" }); // id 2 (uniquified)
  await fake.execute("layer.rename", { layer: 2, name: "Headline" }); // real twins
  return attachFakeBridge(fake);
}

function batch(
  steps: NonNullable<AgentBatchInput["steps"]>,
  label = "Agent: diff fixture",
): AgentBatchInput {
  return { label, steps };
}

// ---------------------------------------------------------------------------
// derivePlanDiff — pure derivation
// ---------------------------------------------------------------------------

describe("derivePlanDiff — pure §6.3 derivation over the compiled batch", () => {
  it("derives one set row per (layer, property) with the proposed value as `after`", () => {
    const diff = derivePlanDiff(
      batch([
        {
          command: "prop.set",
          params: { layer: "Headline", path: "text/sourceText", value: "New" },
        },
      ]),
    );
    expect(diff.groups).toHaveLength(1);
    expect(diff.groups[0]?.label).toBe("Headline");
    expect(diff.groups[0]?.rows).toHaveLength(1);
    const first = diff.groups[0]?.rows[0];
    expect(first?.kind).toBe("set");
    expect(first?.path).toBe("text/sourceText");
    expect(first?.after).toBe("New");
    expect(first?.layerRef).toBe("Headline");
    expect(first?.propPath).toBe("text/sourceText");
    expect(diff.hiddenCount).toBe(0);
  });

  it("groups rows by layer and merges repeated prop.set on the same path (last wins — the semantic FINAL value)", () => {
    const diff = derivePlanDiff(
      batch([
        { command: "prop.set", params: { layer: "Headline", path: "transform/scale", value: 120 } },
        { command: "prop.set", params: { layer: "Subhead", path: "transform/opacity", value: 80 } },
        { command: "prop.set", params: { layer: "Headline", path: "transform/scale", value: 150 } },
      ]),
    );
    expect(diff.groups.map((group) => group.label)).toEqual(["Headline", "Subhead"]);
    const headline = diff.groups[0]?.rows ?? [];
    expect(headline).toHaveLength(1);
    expect(headline[0]?.after).toBe(150);
  });

  it("derives a rename row: old name is KNOWN by construction (the ref), new name is `after`", () => {
    const diff = derivePlanDiff(
      batch([{ command: "layer.rename", params: { layer: "Headline", name: "Subtitle" } }]),
    );
    const rename = diff.groups[0]?.rows[0];
    expect(rename?.kind).toBe("rename");
    expect(rename?.path).toBe("Name");
    expect(rename?.before).toBe("Headline");
    expect(rename?.after).toBe("Subtitle");
  });

  it("merges prop.addKey per (layer, path) into one keyframe row with the key list", () => {
    const diff = derivePlanDiff(
      batch([
        {
          command: "prop.addKey",
          params: { layer: "Headline", path: "transform/scale", time: 0, value: 20 },
        },
        {
          command: "prop.addKey",
          params: { layer: "Headline", path: "transform/scale", time: 0.45, value: 110 },
        },
        {
          command: "prop.addKey",
          params: { layer: "Headline", path: "transform/scale", time: 0.7, value: 100 },
        },
      ]),
    );
    const keyframeRow = diff.groups[0]?.rows[0];
    expect(keyframeRow?.kind).toBe("keyframe");
    expect(keyframeRow?.keys).toEqual([
      { time: 0, value: 20 },
      { time: 0.45, value: 110 },
      { time: 0.7, value: 100 },
    ]);
  });

  it("caps the keyframe note at 12 keys and reports the rest", () => {
    const steps = Array.from({ length: 15 }, (_v, index) => ({
      command: "prop.addKey",
      params: { layer: "Headline", path: "transform/scale", time: index, value: index },
    }));
    const diff = derivePlanDiff(batch(steps));
    const keyframeRow = diff.groups[0]?.rows[0];
    expect(keyframeRow?.keys).toHaveLength(12);
    expect(keyframeRow?.moreKeyCount).toBe(3);
  });

  it("derives + rows for added layers (§6.3 '+/− rows for added layers') grouped by the new layer's name", () => {
    const diff = derivePlanDiff(
      batch([
        { command: "layer.newText", params: { text: "Badge", name: "Badge" } },
        { command: "layer.newSolid", params: { name: "Wash", color: "#101010" } },
      ]),
    );
    expect(diff.groups.map((group) => group.label)).toEqual(["Badge", "Wash"]);
    const badge = diff.groups[0]?.rows[0];
    expect(badge?.sign).toBe("+");
    expect(badge?.path).toBe("Text layer");
    expect(badge?.after).toBe("Badge");
  });

  it("derives +/− effect rows per addressed layer and a preset row", () => {
    const diff = derivePlanDiff(
      batch([
        {
          command: "effect.apply",
          params: { layers: ["Headline", "Subhead"], effect: "Gaussian Blur" },
        },
        { command: "effect.remove", params: { layer: "Subhead", effect: "Glow" } },
        { command: "anim.applyBuiltinPreset", params: { layers: ["Headline"], preset: "fadeUp" } },
      ]),
    );
    const headline = diff.groups[0]?.rows ?? [];
    expect(
      headline.some((r) => r.sign === "+" && r.path === "Effect" && r.after === "Gaussian Blur"),
    ).toBe(true);
    expect(headline.some((r) => r.path === "Preset" && r.after === "fadeUp")).toBe(true);
    const subhead = diff.groups[1]?.rows ?? [];
    expect(subhead.some((r) => r.sign === "−" && r.path === "Effect" && r.after === "Glow")).toBe(
      true,
    );
  });

  it("derives a + Composition row for comp.new and an Undo row for edit.undo", () => {
    const diff = derivePlanDiff(
      batch([
        { command: "comp.new", params: { name: "Intro", width: 1920, height: 1080 } },
        { command: "edit.undo", params: {} },
      ]),
    );
    expect(diff.groups.map((group) => group.label)).toEqual(["(composition)", "(history)"]);
    expect(diff.groups[0]?.rows[0]).toMatchObject({
      sign: "+",
      path: "Composition",
      after: "Intro",
    });
    expect(diff.groups[1]?.rows[0]).toMatchObject({
      path: "Undo",
      after: "the most recent applied agent batch",
    });
  });

  it("resolves $request: token refs through the plan's resolutionRequests for display", () => {
    const diff = derivePlanDiff(
      batch([
        {
          command: "prop.set",
          params: { layer: "$request:req_head", path: "transform/scale", value: 2 },
        },
      ]),
      [{ requestId: "req_head", layerName: "Headline" }],
    );
    expect(diff.groups[0]?.label).toBe("Headline");
    // An unknown token displays itself (honest, never fabricated).
    const unknown = derivePlanDiff(
      batch([{ command: "prop.set", params: { layer: "$request:req_x", path: "p", value: 1 } }]),
    );
    expect(unknown.groups[0]?.label).toBe("$request:req_x");
  });

  it("labels numeric layer refs as `layer N` until the live read resolves the name", () => {
    const diff = derivePlanDiff(
      batch([{ command: "prop.set", params: { layer: 1, path: "transform/scale", value: 2 } }]),
    );
    expect(diff.groups[0]?.label).toBe("layer 1");
    expect(diff.groups[0]?.rows[0]?.layerRef).toBe(1);
  });

  it("falls back to one bounded 'Other change' row for any unrecognized command — never throws, never grows", () => {
    // Hostile rows are DATA (§6.3 totality): the cast keeps the runtime
    // hostility while satisfying the typed signature at compile time.
    const hostile = batch([
      null,
      { command: 42, params: "nope" },
      { command: "mystery.cmd", params: { layer: "Headline", junk: "x".repeat(400) } },
      { command: "another.cmd", params: { deep: { deeper: { time: 1 } } } },
    ] as unknown as NonNullable<AgentBatchInput["steps"]>);
    const diff = derivePlanDiff(hostile);
    const texts = diff.groups.flatMap((group) => group.rows.map((r) => r.after));
    for (const text of texts) {
      expect(typeof text).toBe("string");
      expect((text as string).length).toBeLessThanOrEqual(73); // MAX_JSON_CHARS + ellipsis
    }
    expect(diff.groups.some((group) => group.rows.some((r) => r.path === "Other change"))).toBe(
      true,
    );
  });

  it("caps the per-group row count and reports the hidden remainder", () => {
    const steps = Array.from({ length: 40 }, (_v, index) => ({
      command: "prop.set",
      params: { layer: "Headline", path: `p${index}`, value: index },
    }));
    const diff = derivePlanDiff(batch(steps));
    expect(diff.groups[0]?.rows).toHaveLength(30);
    expect(diff.hiddenCount).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// PlanDiffCard — rendering + live before-values (the REAL fake bridge)
// ---------------------------------------------------------------------------

describe("PlanDiffCard — §6.3 rows with live before-values", () => {
  it("renders layer groups with old → new rows; the before side comes from the live editor", async () => {
    const bridge = await makeBridgeWithHeadline();
    render(
      <PlanDiffCard
        bridge={bridge}
        batch={batch([
          {
            command: "prop.set",
            params: { layer: "Headline", path: "text/sourceText", value: "New headline" },
          },
          {
            command: "prop.set",
            params: { layer: "Headline", path: "transform/scale", value: 150 },
          },
        ])}
      />,
    );

    expect(screen.getByTestId("plan-diff-title")).toHaveTextContent("Changes");
    await waitFor(() => {
      expect(screen.getAllByTestId("plan-diff-before")[0]).toHaveTextContent("Headline");
    });

    const rows = screen.getAllByTestId("plan-diff-row");
    expect(rows).toHaveLength(2);
    const [textRow, scaleRow] = rows as [HTMLElement, HTMLElement];

    expect(within(textRow).getByTestId("plan-diff-path")).toHaveTextContent("text/sourceText");
    // The fake seeds text/sourceText = "Headline" and transform/scale = 100.
    expect(within(textRow).getByTestId("plan-diff-before")).toHaveTextContent("Headline");
    expect(within(textRow).getByTestId("plan-diff-after")).toHaveTextContent("New headline");

    expect(within(scaleRow).getByTestId("plan-diff-before")).toHaveTextContent("100");
    expect(within(scaleRow).getByTestId("plan-diff-after")).toHaveTextContent("150");
    expect(screen.getByTestId("plan-diff-layer")).toHaveTextContent("Headline");
  });

  it("renders a keyframe row as `current → keyframed` with the §6.3 key list note", async () => {
    const bridge = await makeBridgeWithHeadline();
    render(
      <PlanDiffCard
        bridge={bridge}
        batch={batch([
          {
            command: "prop.addKey",
            params: { layer: "Headline", path: "transform/scale", time: 0, value: 20 },
          },
          {
            command: "prop.addKey",
            params: { layer: "Headline", path: "transform/scale", time: 0.45, value: 110 },
          },
        ])}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("plan-diff-before")).toHaveTextContent("100");
    });
    expect(screen.getByTestId("plan-diff-after")).toHaveTextContent("keyframed");
    expect(screen.getByTestId("plan-diff-keys")).toHaveTextContent(
      "keyframed: 20 @ 0s, 110 @ 0.45s",
    );
  });

  it("shows '—' honestly when NO old value can be known (no bridge)", () => {
    render(
      <PlanDiffCard
        batch={batch([
          {
            command: "prop.set",
            params: { layer: "Headline", path: "transform/scale", value: 150 },
          },
        ])}
      />,
    );
    expect(screen.getByTestId("plan-diff-before")).toHaveTextContent("—");
    expect(screen.getByTestId("plan-diff-after")).toHaveTextContent("150");
  });

  it("shows '—' for a layer name that is not (uniquely) in the comp — never a guess", async () => {
    const bridge = await makeBridgeWithTwinHeadlines();
    render(
      <PlanDiffCard
        bridge={bridge}
        batch={batch([
          {
            command: "prop.set",
            params: { layer: "Headline", path: "transform/scale", value: 150 },
          },
        ])}
      />,
    );
    // Ambiguous twin names: comp.info answers both, so the unique-name rule
    // refuses — the row stays "—" (honest) once the reads settle.
    await waitFor(() => {
      expect(screen.getAllByTestId("plan-diff-row").length).toBeGreaterThan(0);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByTestId("plan-diff-before")).toHaveTextContent("—");
  });

  it("renders numeric layer refs with their resolved layer name once the read lands", async () => {
    const bridge = await makeBridgeWithHeadline();
    render(
      <PlanDiffCard
        bridge={bridge}
        batch={batch([
          { command: "prop.set", params: { layer: 1, path: "transform/scale", value: 150 } },
        ])}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("plan-diff-layer")).toHaveTextContent("Headline");
    });
    expect(screen.getByTestId("plan-diff-before")).toHaveTextContent("100");
  });

  it("renders + rows for added layers without a before column (there is no old value)", () => {
    render(
      <PlanDiffCard batch={batch([{ command: "layer.newText", params: { text: "Badge" } }])} />,
    );
    const row = screen.getByTestId("plan-diff-row");
    expect(row.getAttribute("data-sign")).toBe("+");
    expect(within(row).queryByTestId("plan-diff-before")).toBeNull();
    expect(within(row).getByTestId("plan-diff-after")).toHaveTextContent("Badge");
  });

  it("renders the hidden-remainder note when bounds truncate the diff", () => {
    const steps = Array.from({ length: 40 }, (_v, index) => ({
      command: "prop.set",
      params: { layer: "Headline", path: `p${index}`, value: index },
    }));
    render(<PlanDiffCard batch={batch(steps)} />);
    expect(screen.getByTestId("plan-diff-more")).toHaveTextContent("+ 10 more changes not shown");
  });

  it("keeps hostile batch data inert: escaped text, no injected elements, no raw hex (law #8)", async () => {
    const bridge = await makeBridgeWithHeadline();
    const hostile = '<script>alert("x")</script>';
    const { container } = render(
      <PlanDiffCard
        bridge={bridge}
        batch={batch([
          {
            command: "prop.set",
            params: { layer: hostile, path: "text/sourceText", value: hostile },
          },
          { command: "layer.newText", params: { text: hostile, name: hostile } },
        ])}
      />,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId("plan-diff-row").length).toBe(2);
    });
    // Everything renders as TEXT (React-escaped), nothing executes.
    expect(container.querySelectorAll("script")).toHaveLength(0);
    expect(container.textContent).toContain(hostile);
    // Tokens-only styling: no raw hex in any class attribute.
    for (const node of [...container.querySelectorAll("[class]")]) {
      expect(node.getAttribute("class")).not.toMatch(/#[0-9a-f]{3,8}/i);
    }
  });
});
