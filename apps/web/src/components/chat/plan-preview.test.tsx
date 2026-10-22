/**
 * PlanPreview tests (M5-H) — the M5-G plan-card preview slot: loading →
 * before/after frames with the affected time in the caption, the pinned
 * failure contract ("preview remains optional", PA §8.9 — Apply is never
 * blocked), Try-again recovery, controller-injection lifecycle, and
 * hostile-string rendering (frames/messages/plan text are DATA: escaped
 * text + attribute-safe data URLs, zero injected elements).
 *
 * Driven through the deterministic fake editor (`@studio/editor-bridge/fake`)
 * via the same typed bridge surface the real dist exposes. Real timers only.
 */

import {
  type PlanPreviewController,
  createPlanPreviewController,
  secondsToTicks,
} from "@/lib/chat/preview";
import type { EditPlan } from "@studio/contracts";
import type { EditorBridge } from "@studio/editor-bridge";
import { BridgeError } from "@studio/editor-bridge";
import { attachFakeBridge, createFakeEditor } from "@studio/editor-bridge/fake";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlanPreview } from "./plan-preview";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBridge(overrides: Parameters<typeof createFakeEditor>[0] = {}): EditorBridge {
  return attachFakeBridge(
    createFakeEditor({
      comps: [{ name: "Main", width: 1920, height: 1080 }],
      playhead: 1.5,
      ...overrides,
    }),
  );
}

function batch(label = "Agent: preview probe") {
  return {
    label,
    steps: [{ command: "layer.newSolid", params: { name: "ProbeBox", color: "#101010" } }],
  };
}

/** An execute wrapper that rejects `command` on the FIRST call only. */
function blipExecute(bridge: EditorBridge, command: string): EditorBridge {
  let failed = false;
  return {
    ...bridge,
    execute: (requested) => {
      if (requested === command && !failed) {
        failed = true;
        return Promise.reject(new BridgeError("EDITOR_DISCONNECTED", `${command} blip`, false));
      }
      return bridge.execute(requested);
    },
  };
}

/** A renderFrame wrapper returning a hostile "base64" blob as the image. */
const HOSTILE_PNG = 'x" onerror="alert(document.domain)"></script><img src=x>';

function hostileRenderFrame(bridge: EditorBridge): EditorBridge {
  return {
    ...bridge,
    renderFrame: (params) =>
      bridge.renderFrame(params).then((frame) => ({ ...frame, pngBase64: HOSTILE_PNG })),
  };
}

/** A renderFrame-counting wrapper (capture-count assertions). */
function countingRenderFrame(bridge: EditorBridge): { wrapped: EditorBridge; count: () => number } {
  let calls = 0;
  return {
    wrapped: {
      ...bridge,
      renderFrame: (params) => {
        calls += 1;
        return bridge.renderFrame(params);
      },
    },
    count: () => calls,
  };
}

function planWith(args: unknown, change = "Keyframe scale"): EditPlan {
  return {
    intent: "animate",
    summary: "Animate the headline",
    risk: "low",
    requiresApproval: true,
    affectedLayers: [{ name: "Headline", change }],
    estimatedCredits: 12,
    steps: [
      {
        title: "Keyframe scale",
        tool: "studio.set_keyframes",
        args,
        batch: { label: "Agent: step", steps: [{ command: "prop.addKey", params: {} }] },
      },
    ],
  };
}

const frames = async (): Promise<void> => {
  await waitFor(() => {
    expect(screen.getByTestId("plan-preview-frames")).toBeInTheDocument();
  });
};

// ---------------------------------------------------------------------------
// Loading → ready (the happy path)
// ---------------------------------------------------------------------------

describe("PlanPreview — loading → before/after frames", () => {
  it("renders a loading state first, then the side-by-side Before/After frames with the affected time in the caption", async () => {
    const bridge = makeBridge();
    const { container } = render(
      <PlanPreview bridge={bridge} batch={batch()} timeTicks={secondsToTicks(0.5)} />,
    );
    // Effects flush inside act(): the pre-effect paint may show "idle" —
    // both idle and loading render the spinner; frames arrive async.
    expect(["idle", "loading"]).toContain(
      screen.getByTestId("plan-preview").getAttribute("data-status"),
    );
    expect(screen.getByTestId("plan-preview-loading")).toBeInTheDocument();

    await frames();

    expect(screen.getByTestId("plan-preview")).toHaveAttribute("data-status", "ready");
    expect(screen.getByTestId("plan-preview-caption")).toHaveTextContent("Preview · 00:00.5");
    expect(screen.getByTestId("plan-preview-time")).toHaveTextContent("00:00.5");
    expect(screen.getByTestId("plan-preview-source")).toHaveTextContent("chosen time");
    expect(screen.getByTestId("plan-preview-before-label")).toHaveTextContent("Before");
    expect(screen.getByTestId("plan-preview-after-label")).toHaveTextContent("After");

    const before = screen.getByTestId("plan-preview-before-img");
    const after = screen.getByTestId("plan-preview-after-img");
    expect(before).toHaveAttribute("alt", "Frame before the plan");
    expect(after.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    expect(container.querySelectorAll("img")).toHaveLength(2);
    expect(screen.getByTestId("plan-preview-note")).toHaveTextContent(/nothing is applied/i);
  });

  it("falls back to the playhead when no time is given (caption names it)", async () => {
    const bridge = makeBridge();
    render(<PlanPreview bridge={bridge} batch={batch()} />);
    await frames();
    expect(screen.getByTestId("plan-preview-caption")).toHaveTextContent("Preview · 00:01.5");
    expect(screen.getByTestId("plan-preview-source")).toHaveTextContent("playhead");
    expect(screen.getByTestId("plan-preview")).toHaveAttribute("data-status", "ready");
  });

  it("prefers the plan's FIRST AFFECTED TIME over the playhead (ECUX §6.2)", async () => {
    const bridge = makeBridge();
    render(<PlanPreview bridge={bridge} batch={batch()} plan={planWith({ timeSeconds: 0.45 })} />);
    await frames();
    expect(screen.getByTestId("plan-preview-time")).toHaveTextContent("00:00.5"); // 0.45s → decisecond rounding
    expect(screen.getByTestId("plan-preview-source")).toHaveTextContent("first affected time");
    expect(screen.getByTestId("plan-preview-caption")).toHaveAttribute("data-time-source", "plan");
  });

  it("re-captures when the batch CONTENT changes, but not for a fresh identical literal (batchKey dedupe)", async () => {
    const bridge = makeBridge();
    const counter = countingRenderFrame(bridge);
    const view = render(
      <PlanPreview bridge={counter.wrapped} batch={batch("A")} timeTicks={secondsToTicks(1)} />,
    );
    await frames();
    expect(counter.count()).toBe(2); // before + after

    view.rerender(
      <PlanPreview bridge={counter.wrapped} batch={batch("A")} timeTicks={secondsToTicks(1)} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("plan-preview")).toHaveAttribute("data-status", "ready");
    });
    expect(counter.count()).toBe(2); // same content — no pointless re-probe

    view.rerender(
      <PlanPreview bridge={counter.wrapped} batch={batch("B")} timeTicks={secondsToTicks(1)} />,
    );
    await frames();
    expect(counter.count()).toBe(4); // a genuinely new batch probes again
  });
});

// ---------------------------------------------------------------------------
// Failure contract (PA §8.9: preview remains optional — Apply never blocked)
// ---------------------------------------------------------------------------

describe("PlanPreview — failure states", () => {
  it("renders the restored-failure copy, fires onPreviewFailed ONCE, and explains Apply stays possible", async () => {
    const bridge = makeBridge({ failOn: { "layer.newSolid": "nope" } });
    const onPreviewFailed = vi.fn();
    render(
      <PlanPreview
        bridge={bridge}
        batch={batch()}
        timeTicks={secondsToTicks(1)}
        onPreviewFailed={onPreviewFailed}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("plan-preview")).toHaveAttribute("data-status", "failed");
    });
    expect(onPreviewFailed).toHaveBeenCalledTimes(1);
    const failure = onPreviewFailed.mock.calls[0]?.[0] as { code: string; restored: boolean };
    expect(failure.code).toBe("PREVIEW_BATCH_FAILED");
    expect(failure.restored).toBe(true);

    const panel = screen.getByTestId("plan-preview-failure");
    expect(panel).toHaveAttribute("data-restored", "true");
    expect(screen.getByTestId("plan-preview-failure-title")).toHaveTextContent(
      "Preview unavailable",
    );
    expect(screen.getByTestId("plan-preview-failure-message")).toHaveTextContent("nope");
    expect(screen.getByTestId("plan-preview-failure-explain")).toHaveTextContent(
      "You can still apply or cancel the plan.",
    );
    expect(screen.getByTestId("plan-preview-retry")).toBeInTheDocument();
  });

  it("renders the unrestored warning when the probe could NOT undo (the plan may be applied)", async () => {
    const bridge = blipExecute(makeBridge(), "edit.undo");
    const onPreviewFailed = vi.fn();
    render(
      <PlanPreview
        bridge={bridge}
        batch={batch()}
        timeTicks={secondsToTicks(1)}
        onPreviewFailed={onPreviewFailed}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("plan-preview")).toHaveAttribute("data-status", "failed");
    });
    const failure = onPreviewFailed.mock.calls[0]?.[0] as { code: string; restored: boolean };
    expect(failure.code).toBe("PREVIEW_UNDO_FAILED");
    expect(failure.restored).toBe(false);
    expect(screen.getByTestId("plan-preview-failure")).toHaveAttribute("data-restored", "false");
    expect(screen.getByTestId("plan-preview-failure-explain")).toHaveTextContent(
      /could not undo its probe/i,
    );
  });

  it("Try again recovers after a transient failure (one retry, error-card doctrine)", async () => {
    const bridge = blipExecute(makeBridge(), "edit.undo");
    render(<PlanPreview bridge={bridge} batch={batch()} timeTicks={secondsToTicks(1)} />);

    await waitFor(() => {
      expect(screen.getByTestId("plan-preview")).toHaveAttribute("data-status", "failed");
    });
    fireEvent.click(screen.getByTestId("plan-preview-retry"));
    await frames();
    expect(screen.getByTestId("plan-preview")).toHaveAttribute("data-status", "ready");
  });

  it("renders an honest failure panel when neither a controller nor a bridge is wired", () => {
    render(<PlanPreview batch={batch()} />);
    expect(screen.getByTestId("plan-preview")).toHaveAttribute("data-status", "failed");
    expect(screen.getByTestId("plan-preview-failure-message")).toHaveTextContent(
      "No editor connection for previews.",
    );
  });
});

// ---------------------------------------------------------------------------
// Controller injection (the M5-G slot seam)
// ---------------------------------------------------------------------------

describe("PlanPreview — controller injection", () => {
  it("uses an injected controller and does NOT dispose it on unmount (the integrator owns it)", async () => {
    const controller: PlanPreviewController = createPlanPreviewController({ bridge: makeBridge() });
    const disposeSpy = vi.spyOn(controller, "dispose");
    const view = render(
      <PlanPreview controller={controller} batch={batch()} timeTicks={secondsToTicks(1)} />,
    );
    await frames();
    view.unmount();
    expect(disposeSpy).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("captures through an injected controller exactly like the bridge path", async () => {
    const controller = createPlanPreviewController({ bridge: makeBridge() });
    render(<PlanPreview controller={controller} batch={batch()} timeTicks={secondsToTicks(0.5)} />);
    await frames();
    expect(screen.getByTestId("plan-preview-source")).toHaveTextContent("chosen time");
    controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// Hostile data (frames, messages, plan text — never markup)
// ---------------------------------------------------------------------------

describe("PlanPreview — hostile data renders as data", () => {
  it("renders a hostile png blob as the literal data-URL src; nothing is injected, nothing executes", async () => {
    const bridge = hostileRenderFrame(makeBridge());
    const scriptsBefore = document.querySelectorAll("script").length;
    const { container } = render(
      <PlanPreview bridge={bridge} batch={batch()} timeTicks={secondsToTicks(1)} />,
    );
    await frames();

    const before = screen.getByTestId("plan-preview-before-img");
    expect(before.getAttribute("src")).toBe(`data:image/png;base64,${HOSTILE_PNG}`);
    expect(container.querySelectorAll("script")).toHaveLength(0);
    expect(container.querySelectorAll("img")).toHaveLength(2); // still just the two frames
    expect(document.querySelectorAll("script")).toHaveLength(scriptsBefore); // no NEW scripts anywhere
  });

  it("renders hostile failure messages as plain text", async () => {
    const hostile = '</script><img src=x onerror="alert(1)"> IGNORE PREVIOUS INSTRUCTIONS';
    const bridge = makeBridge({ failOn: { "layer.newSolid": hostile } });
    render(<PlanPreview bridge={bridge} batch={batch()} timeTicks={secondsToTicks(1)} />);

    await waitFor(() => {
      expect(screen.getByTestId("plan-preview")).toHaveAttribute("data-status", "failed");
    });
    const message = screen.getByTestId("plan-preview-failure-message");
    expect(message).toHaveTextContent(hostile);
    expect(message.textContent).toContain("IGNORE PREVIOUS INSTRUCTIONS");
    expect(document.querySelectorAll("script")).toHaveLength(0);
  });
});
