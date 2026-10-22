/**
 * PlanCard tests (M5-G) — the full apply/undo card: §6.2 layout (risk badge,
 * affected name+change rows, steps with tool ids behind a disclosure, credits
 * shown VERBATIM from the server value), the M5 states matrix, the high-risk
 * confirm checkbox + dialog gate, re-apply drift gating, hostile-string
 * immunity (M4-N corpus) and the tokens-only style law (no inline hex).
 * Deterministic; jsdom.
 *
 * M4 delta: the pinned "Apply arrives with M5 — this plan is a preview." note
 * is GONE (apply is real now), and the steps disclosure is the one button a
 * callback-less mount renders — Apply/Cancel only appear once the thread
 * layer wires callbacks (read-only mounts stay read-only).
 */

import type { EditPlan } from "@studio/contracts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { textFixture } from "@/lib/chat/__tests__/injection-corpus";
import { PLAN_CARD_STATUSES, PlanCard } from "./plan-card";

function plan(overrides: Partial<EditPlan> = {}): EditPlan {
  return {
    intent: "animate",
    summary: "Animate the headline scale with a springy overshoot",
    risk: "low",
    requiresApproval: true,
    affectedLayers: [
      { name: "Headline", change: "Keyframe Scale" },
      { name: "Subhead", change: "Delay 0.2s" },
    ],
    estimatedCredits: 12,
    steps: [
      {
        title: "Keyframe Scale 20% → 110% → 100%",
        tool: "studio.set_keyframes",
        args: {},
        batch: { label: "Agent: animate headline", steps: [{ command: "prop.set", params: {} }] },
      },
      {
        title: "Add overshoot at 0.45s",
        tool: "studio.add_effect",
        args: {},
        batch: { label: "Agent: overshoot", steps: [{ command: "prop.set", params: {} }] },
      },
    ],
    ...overrides,
  };
}

/** Any hex-looking literal in a class attribute (the raw-hex law, #8). */
const HEX_CLASS = /#[0-9a-f]{3,8}/i;

describe("PlanCard — §6.2 layout", () => {
  it("renders the ✦ Plan · <summary> header, intent chip and risk badge", () => {
    render(<PlanCard plan={plan()} applied={false} />);
    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(screen.getByText(plan().summary)).toBeInTheDocument();
    expect(screen.getByTestId("plan-intent")).toHaveTextContent("Animate");
    expect(screen.getByTestId("plan-risk")).toHaveTextContent("Low risk");
  });

  it("renders numbered steps with title AND tool id", () => {
    render(<PlanCard plan={plan()} applied={false} />);
    const steps = within(screen.getByTestId("plan-steps")).getAllByRole("listitem");
    expect(steps).toHaveLength(2);
    expect(steps[0]).toHaveTextContent("1.");
    expect(steps[0]).toHaveTextContent("Keyframe Scale 20% → 110% → 100%");
    expect(steps[0]).toHaveTextContent("studio.set_keyframes");
    expect(steps[1]).toHaveTextContent("2.");
    expect(steps[1]).toHaveTextContent("studio.add_effect");
  });

  it("steps disclosure: expanded by default, collapses and re-expands (§9.2)", async () => {
    const user = userEvent.setup();
    render(<PlanCard plan={plan()} applied={false} />);
    const toggle = screen.getByTestId("plan-steps-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("plan-steps")).toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("plan-steps")).not.toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("plan-steps")).toBeInTheDocument();
  });

  it("renders affected layers as name + change rows", () => {
    render(<PlanCard plan={plan()} applied={false} />);
    const rows = within(screen.getByTestId("plan-affected")).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Headline");
    expect(rows[0]).toHaveTextContent("Keyframe Scale");
    expect(rows[1]).toHaveTextContent("Subhead");
    expect(rows[1]).toHaveTextContent("Delay 0.2s");
  });

  it("omits the Affected block when the plan touches no layers", () => {
    render(<PlanCard plan={plan({ affectedLayers: [] })} applied={false} />);
    expect(screen.queryByTestId("plan-affected")).not.toBeInTheDocument();
  });

  it("caps the affected-layers list at the §8.6 bound of 50 and says how many more", () => {
    const affectedLayers = Array.from({ length: 60 }, (_unused, index) => ({
      id: index,
      name: `Layer ${index}`,
      change: "delete",
    }));
    render(<PlanCard plan={plan({ affectedLayers })} applied={false} />);
    const rows = within(screen.getByTestId("plan-affected")).getAllByRole("listitem");
    expect(rows).toHaveLength(50);
    expect(screen.getByText("+ 10 more layers not shown")).toBeInTheDocument();
  });

  it("renders the credit estimate from the plan value", () => {
    render(<PlanCard plan={plan()} applied={false} />);
    expect(screen.getByTestId("plan-credits")).toHaveTextContent("≈ 12 credits");
  });

  it("renders NO note by default — the M4 “Apply arrives with M5” line is gone", () => {
    render(<PlanCard plan={plan()} applied={false} />);
    expect(screen.queryByTestId("plan-note")).not.toBeInTheDocument();
    expect(screen.queryByText(/apply arrives with m5/i)).not.toBeInTheDocument();
  });

  it("still honours an explicit custom note (M4 prop)", () => {
    render(<PlanCard plan={plan()} applied={false} note="Custom note." />);
    expect(screen.getByTestId("plan-note")).toHaveTextContent("Custom note.");
  });
});

describe("PlanCard — risk badges (§6.2)", () => {
  it("low renders the success tone and the strong border", () => {
    render(<PlanCard plan={plan({ risk: "low" })} applied={false} />);
    const badge = screen.getByTestId("plan-risk");
    expect(badge).toHaveTextContent("Low risk");
    expect(badge.className).toContain("text-success");
    expect(screen.getByTestId("plan-card").className).toContain("border-strong");
  });

  it("medium renders the amber tone", () => {
    render(<PlanCard plan={plan({ risk: "medium" })} applied={false} />);
    const badge = screen.getByTestId("plan-risk");
    expect(badge).toHaveTextContent("Medium risk");
    expect(badge.className).toContain("text-warning");
  });

  it("high renders red, the stronger border and the confirmation line", () => {
    render(<PlanCard plan={plan({ risk: "high" })} applied={false} />);
    const badge = screen.getByTestId("plan-risk");
    expect(badge).toHaveTextContent("High risk");
    expect(badge.className).toContain("text-danger");
    expect(screen.getByTestId("plan-card").className).toContain("border-danger");
    expect(screen.getByTestId("plan-requires-confirmation")).toHaveTextContent(
      /requires confirmation/i,
    );
  });

  it("accepts the server-recomputed risk override (plan-compiler output)", () => {
    render(<PlanCard plan={plan({ risk: "low" })} applied={false} risk="high" />);
    expect(screen.getByTestId("plan-card")).toHaveAttribute("data-risk", "high");
    expect(screen.getByTestId("plan-card").className).toContain("border-danger");
  });

  it("renders every intent as a chip", () => {
    for (const intent of [
      "create",
      "edit",
      "animate",
      "style",
      "organize",
      "render",
      "explain",
      "clarify",
    ] as const) {
      const rendered = render(<PlanCard plan={plan({ intent })} applied={false} />);
      expect(screen.getByTestId("plan-intent")).toHaveTextContent(
        intent.charAt(0).toUpperCase() + intent.slice(1),
      );
      expect(screen.getByTestId("plan-card")).toHaveAttribute("data-intent", intent);
      rendered.unmount();
    }
  });
});

describe("PlanCard — M4 backward compatibility", () => {
  it("a callback-less mount stays read-only: no Apply, no Cancel, no confirm checkbox", () => {
    render(<PlanCard plan={plan()} applied={false} />);
    expect(screen.getByTestId("plan-card")).toHaveAttribute("data-status", "proposed");
    expect(screen.getByTestId("plan-card")).toHaveAttribute("data-applied", "false");
    expect(screen.getByTestId("plan-card")).toHaveAttribute("data-requires-approval", "true");
    expect(screen.queryByTestId("plan-apply")).not.toBeInTheDocument();
    expect(screen.queryByTestId("plan-cancel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("plan-confirm")).not.toBeInTheDocument();
    // The steps disclosure is the only button a read-only mount renders.
    expect(screen.queryByRole("button", { name: /^apply/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^cancel/i })).not.toBeInTheDocument();
  });

  it("applied={true} (M4 surface widened) resolves to the applied status", () => {
    render(<PlanCard plan={plan()} applied />);
    expect(screen.getByTestId("plan-card")).toHaveAttribute("data-status", "applied");
    expect(screen.getByTestId("plan-card")).toHaveAttribute("data-applied", "true");
  });
});

describe("PlanCard — proposed actions (§6.2 Apply/Cancel)", () => {
  it("low risk: Apply fires onApply directly — no dialog", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<PlanCard plan={plan()} applied={false} onApply={onApply} />);
    await user.click(screen.getByTestId("plan-apply"));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Cancel emits the explicit plan-cancel event (the run stays otherwise usable)", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onApply = vi.fn();
    render(<PlanCard plan={plan()} applied={false} onApply={onApply} onCancel={onCancel} />);
    await user.click(screen.getByTestId("plan-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("high risk: no checkbox until the thread wires Apply; the checkbox gates the button", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    const readOnly = render(<PlanCard plan={plan({ risk: "high" })} applied={false} />);
    // Read-only high-risk mount: the warning line renders, no checkbox gate.
    expect(screen.getByTestId("plan-requires-confirmation")).toBeInTheDocument();
    expect(screen.queryByTestId("plan-confirm-checkbox")).not.toBeInTheDocument();
    readOnly.unmount();

    const interactive = render(
      <PlanCard plan={plan({ risk: "high" })} applied={false} onApply={onApply} />,
    );
    const apply = screen.getByTestId("plan-apply");
    expect(apply).toBeDisabled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("plan-confirm-checkbox"));
    expect(apply).toBeEnabled();

    await user.click(apply);
    expect(onApply).not.toHaveBeenCalled(); // gated by the confirm dialog…
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    interactive.unmount();
  });

  it("high risk: the confirm dialog's Apply fires onApply; Escape cancels without applying", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<PlanCard plan={plan({ risk: "high" })} applied={false} onApply={onApply} />);
    await user.click(screen.getByTestId("plan-confirm-checkbox"));
    await user.click(screen.getByTestId("plan-apply"));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByTestId("chat-confirm-description")).toHaveTextContent(
      "Animate the headline scale with a springy overshoot",
    );
    expect(within(dialog).getByTestId("chat-confirm-confirm").className).toContain("bg-danger");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();

    // Re-open and confirm for real — onApply fires exactly once.
    await user.click(screen.getByTestId("plan-apply"));
    await user.click(screen.getByTestId("chat-confirm-confirm"));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("PlanCard — states matrix (M5)", () => {
  it("stamps data-status for every status the thread layer can pass", () => {
    for (const status of PLAN_CARD_STATUSES) {
      const rendered = render(<PlanCard plan={plan()} applied={false} status={status} />);
      expect(screen.getByTestId("plan-card")).toHaveAttribute("data-status", status);
      rendered.unmount();
    }
  });

  it("applying: spinner + copy, no action buttons", () => {
    const onApply = vi.fn();
    const onUndo = vi.fn();
    render(
      <PlanCard plan={plan()} applied={false} status="applying" onApply={onApply} onUndo={onUndo} />,
    );
    const applying = screen.getByTestId("plan-applying");
    expect(applying).toHaveTextContent("Applying…");
    expect(applying.querySelector("output[aria-label]")).not.toBeNull();
    expect(screen.queryByTestId("plan-apply")).not.toBeInTheDocument();
    expect(screen.queryByTestId("plan-undo")).not.toBeInTheDocument();
  });

  it("applied: copy with the version label and an Undo that fires onUndo", async () => {
    const user = userEvent.setup();
    const onUndo = vi.fn();
    render(
      <PlanCard
        plan={plan()}
        applied={false}
        status="applied"
        versionLabel="12"
        onUndo={onUndo}
      />,
    );
    expect(screen.getByTestId("plan-applied")).toHaveTextContent(
      "Applied — Version 12 · one undo step.",
    );
    await user.click(screen.getByTestId("plan-undo"));
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("applied without a version label: the copy still explains the undo step", () => {
    render(<PlanCard plan={plan()} applied={false} status="applied" />);
    expect(screen.getByTestId("plan-applied")).toHaveTextContent("Applied · one undo step.");
  });

  it("undone: Re-apply is enabled and fires onReapply", async () => {
    const user = userEvent.setup();
    const onReapply = vi.fn();
    render(
      <PlanCard plan={plan()} applied={false} status="undone" onReapply={onReapply} />,
    );
    expect(screen.getByTestId("plan-undone")).toHaveTextContent(/version stays in history/i);
    const reapply = screen.getByTestId("plan-reapply");
    expect(reapply).toBeEnabled();
    await user.click(reapply);
    expect(onReapply).toHaveBeenCalledTimes(1);
  });

  it("undone + drifted base version: Re-apply is disabled and explains why (BP M5.5)", () => {
    const onReapply = vi.fn();
    render(
      <PlanCard
        plan={plan()}
        applied={false}
        status="undone"
        reapplyDrifted
        onReapply={onReapply}
      />,
    );
    expect(screen.getByTestId("plan-reapply")).toBeDisabled();
    const blocked = screen.getByTestId("plan-reapply-blocked");
    expect(blocked).toHaveTextContent(/project moved on/i);
    expect(blocked).toHaveTextContent(/plan the edit again/i);
  });

  it("failed: “nothing changed” copy + the outcome detail + Try again re-fires onApply", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(
      <PlanCard
        plan={plan()}
        applied={false}
        status="failed"
        statusDetail="The editor is offline."
        onApply={onApply}
      />,
    );
    expect(screen.getByTestId("plan-failed")).toHaveTextContent(/didn’t apply/i);
    expect(screen.getByTestId("plan-failed")).toHaveTextContent(/nothing changed/i);
    expect(screen.getByTestId("plan-failed-detail")).toHaveTextContent("The editor is offline.");
    await user.click(screen.getByTestId("plan-retry"));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("conflict (409): explains re-apply is blocked because the project moved on — no actions", () => {
    render(
      <PlanCard
        plan={plan()}
        applied={false}
        status="conflict"
        statusDetail="VERSION_CONFLICT"
      />,
    );
    expect(screen.getByTestId("plan-conflict")).toHaveTextContent(/project moved on/i);
    expect(screen.getByTestId("plan-conflict")).toHaveTextContent(/apply was rejected/i);
    expect(screen.getByText(/re-apply is blocked for this plan/i)).toBeInTheDocument();
    expect(screen.getByTestId("plan-conflict-detail")).toHaveTextContent("VERSION_CONFLICT");
    expect(screen.queryByTestId("plan-apply")).not.toBeInTheDocument();
    expect(screen.queryByTestId("plan-retry")).not.toBeInTheDocument();
    expect(screen.queryByTestId("plan-reapply")).not.toBeInTheDocument();
  });

  it("ambiguous-resolution: lists the candidates; a pick emits (requestId, candidate)", async () => {
    const user = userEvent.setup();
    const onResolveCandidate = vi.fn();
    render(
      <PlanCard
        plan={plan()}
        applied={false}
        status="ambiguous-resolution"
        resolutionRequests={[
          { requestId: "req_1", layerName: "Headline", disambiguation: ["Headline", "Headline 2"] },
        ]}
        onResolveCandidate={onResolveCandidate}
      />,
    );
    expect(screen.getByTestId("plan-ambiguous")).toHaveTextContent(
      /a layer name matches more than one layer/i,
    );
    expect(screen.getByTestId("plan-resolution")).toHaveTextContent("Headline");
    const candidates = screen.getAllByTestId("plan-candidate");
    expect(candidates).toHaveLength(2);
    const firstCandidate = candidates[0] as HTMLElement;
    await user.click(firstCandidate);
    expect(onResolveCandidate).toHaveBeenCalledWith("req_1", "Headline");
  });

  it("ambiguous-resolution without a callback: candidates render as inert data", () => {
    render(
      <PlanCard
        plan={plan()}
        applied={false}
        status="ambiguous-resolution"
        resolutionRequests={[
          { requestId: "req_1", layerName: "Headline", disambiguation: ["Headline", "Headline 2"] },
        ]}
      />,
    );
    const candidates = screen.getAllByTestId("plan-candidate");
    expect(candidates).toHaveLength(2);
    expect((candidates[0] as HTMLElement).tagName).toBe("SPAN");
    expect(within(screen.getByTestId("plan-actions")).queryAllByRole("button")).toHaveLength(0);
  });

  it("cancelled: quiet copy, no actions", () => {
    render(<PlanCard plan={plan()} applied={false} status="cancelled" />);
    expect(screen.getByTestId("plan-cancelled")).toHaveTextContent(/nothing was applied/i);
    expect(screen.queryByTestId("plan-apply")).not.toBeInTheDocument();
    expect(screen.queryByTestId("plan-undo")).not.toBeInTheDocument();
  });
});

describe("PlanCard — credits are never client math", () => {
  it("displays the server-recomputed estimate VERBATIM when provided", () => {
    render(<PlanCard plan={plan()} applied={false} estimatedCredits={7.5} />);
    expect(screen.getByTestId("plan-credits")).toHaveTextContent("≈ 7.5 credits");
  });

  it("falls back to the plan's own value — never a recomputed formula", () => {
    // estimateCredits(plan) would be 2 for a low-risk 2-step plan; the card
    // must show the event/plan value (12), proving no client-side math.
    render(<PlanCard plan={plan()} applied={false} />);
    expect(screen.getByTestId("plan-credits")).toHaveTextContent("≈ 12 credits");
  });
});

describe("PlanCard — preview slot (M5-H via the thread layer)", () => {
  it("renders the injected preview above the action row", () => {
    render(
      <PlanCard
        plan={plan()}
        applied={false}
        onApply={() => {}}
        preview={<figure data-testid="injected-preview">before/after</figure>}
      />,
    );
    const preview = screen.getByTestId("plan-preview");
    expect(within(preview).getByTestId("injected-preview")).toBeInTheDocument();
    // Above = preview precedes the action row in DOM order.
    expect(preview.compareDocumentPosition(screen.getByTestId("plan-actions"))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("renders no preview container when nothing is injected", () => {
    render(<PlanCard plan={plan()} applied={false} onApply={() => {}} />);
    expect(screen.queryByTestId("plan-preview")).not.toBeInTheDocument();
  });
});

describe("PlanCard — hostile strings stay DATA (M4-N corpus)", () => {
  it("renders hostile summaries/layer names/step titles as inert text — zero created elements", () => {
    const img = textFixture("html-img-onerror");
    const rtl = textFixture("rtl-override");
    const jailbreak = textFixture("ignore-previous");
    const { container } = render(
      <PlanCard
        plan={plan({
          summary: img.payload,
          affectedLayers: [
            { name: rtl.payload, change: jailbreak.payload },
            { name: "Headline", change: "Keyframe Scale" },
          ],
          steps: [
            {
              title: jailbreak.payload,
              tool: "studio.set_properties",
              args: {},
              batch: { label: "Agent: hostile", steps: [{ command: "prop.set", params: {} }] },
            },
          ],
        })}
        applied={false}
        onApply={() => {}}
      />,
    );
    // Data survives verbatim (needles intact — RTL/bidi chars included).
    expect(container.textContent).toContain(img.needle);
    expect(container.textContent).toContain(rtl.needle);
    expect(container.textContent).toContain(jailbreak.needle);
    // …and NOTHING was interpreted: no script/img/iframe, no on* handler attrs.
    expect(container.querySelectorAll("script")).toHaveLength(0);
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.querySelectorAll("iframe")).toHaveLength(0);
    for (const element of container.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        expect(attribute.name.startsWith("on")).toBe(false);
        // Hostile HTML renders as text: no element ever carries a hostile
        // href/src scheme either.
        if (attribute.name === "href" || attribute.name === "src") {
          expect(attribute.value).not.toMatch(/^javascript:/i);
        }
      }
    }
  });

  it("renders hostile resolution candidates as data (the clickable form stays inert text)", () => {
    const rtl = textFixture("rtl-override");
    const onResolveCandidate = vi.fn();
    const { container } = render(
      <PlanCard
        plan={plan()}
        applied={false}
        status="ambiguous-resolution"
        resolutionRequests={[
          { requestId: "req_9", layerName: rtl.payload, disambiguation: [rtl.payload] },
        ]}
        onResolveCandidate={onResolveCandidate}
      />,
    );
    expect(container.textContent).toContain(rtl.needle);
    expect(container.querySelectorAll("script, img, iframe")).toHaveLength(0);
    expect(screen.getAllByTestId("plan-candidate")).toHaveLength(1);
  });

  it("long hostile names truncate safely: the full text stays in the DOM's data, layout-safe", () => {
    const longName = `${"L".repeat(400)}<script>alert(1)</script>`;
    const { container } = render(
      <PlanCard
        plan={plan({
          summary: `${"S".repeat(300)}END-SUMMARY`,
          affectedLayers: [{ name: longName, change: "delete" }],
        })}
        applied={false}
      />,
    );
    expect(container.textContent).toContain("END-SUMMARY");
    expect(container.textContent).toContain("<script>alert(1)</script>");
    expect(container.querySelectorAll("script")).toHaveLength(0);
    const nameNode = screen.getByTestId("plan-affected").querySelector("span");
    expect(nameNode).not.toBeNull();
    expect(nameNode?.className).toContain("truncate");
    expect(nameNode?.getAttribute("dir")).toBe("auto");
  });
});

describe("PlanCard — tokens-only style law (no raw hex, law #8)", () => {
  const cases: ReadonlyArray<[string, Partial<Parameters<typeof PlanCard>[0]>]> = [
    ["proposed", { onApply: () => {}, onCancel: () => {} }],
    ["proposed high-risk", { onApply: () => {} }],
    ["applying", { status: "applying" }],
    ["applied", { status: "applied", versionLabel: "12", onUndo: () => {} }],
    ["undone", { status: "undone", onReapply: () => {} }],
    ["undone drifted", { status: "undone", reapplyDrifted: true, onReapply: () => {} }],
    ["failed", { status: "failed", statusDetail: "offline", onApply: () => {} }],
    ["conflict", { status: "conflict", statusDetail: "409" }],
    [
      "ambiguous-resolution",
      {
        status: "ambiguous-resolution",
        resolutionRequests: [{ requestId: "r", layerName: "L", disambiguation: ["a", "b"] }],
        onResolveCandidate: () => {},
      },
    ],
    ["cancelled", { status: "cancelled" }],
  ];

  it.each(cases)("renders %s without any inline style attribute or hex class", (_name, props) => {
    const overrides: Partial<EditPlan> = _name.includes("high-risk")
      ? { risk: "high" }
      : {};
    const { container } = render(
      <PlanCard plan={plan(overrides)} applied={false} note="note" {...props} />,
    );
    for (const element of container.querySelectorAll("*")) {
      expect(element.getAttribute("style")).toBeNull();
      const className = element.getAttribute("class");
      if (className !== null) {
        expect(className).not.toMatch(HEX_CLASS);
      }
    }
  });

  it("the high-risk confirm dialog is tokens-only too (classes carry no hex)", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <PlanCard plan={plan({ risk: "high" })} applied={false} onApply={() => {}} />,
    );
    await user.click(screen.getByTestId("plan-confirm-checkbox"));
    await user.click(screen.getByTestId("plan-apply"));
    // The dialog portals to body — sweep the whole document.
    for (const element of document.querySelectorAll("*")) {
      const className = element.getAttribute("class");
      if (className !== null) {
        expect(className).not.toMatch(HEX_CLASS);
      }
      const style = element.getAttribute("style");
      if (style !== null) {
        expect(style).not.toMatch(HEX_CLASS);
      }
    }
    expect(container).toBeInTheDocument();
  });
});
