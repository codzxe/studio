/**
 * IdleCommentsRegion tests (round-13 LCP/INP fix) — the post-load idle
 * deferral around the page-level comments slot:
 *
 *   1. the region mounts ONLY after the idle callback fires (the slot is
 *      empty on the critical path — that is the point of the wrapper)
 *   2. once idle, the REAL CommentsRegion renders with every prop passed
 *      through untouched
 *   3. engines without requestIdleCallback still get the region (timeout
 *      fallback)
 *   4. a STILL-LOADING document does not import before the window load
 *      event — the field bug this pins: on a 4x-throttled machine the
 *      comments chunk evaluated inside the LCP render-delay window because
 *      a bare requestIdleCallback fired in an idle gap mid-load. The load
 *      gate guarantees every eager script has evaluated first.
 *
 * jsdom's document.readyState is "complete" by test time, so tests 1-3
 * exercise the schedule-immediately branch; test 4 shadows readyState to
 * reach the load-event branch.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IdleCommentsRegion } from "./idle-comments-region";

// The region itself is stubbed — its product behavior is covered by
// comments-region.test.tsx; this suite pins the deferral contract only.
vi.mock("./comments-region", () => ({
  CommentsRegion: (props: Record<string, unknown>) => (
    <div data-testid="stub-region" data-project={String(props.projectId)} />
  ),
}));

// jsdom has no requestIdleCallback — drive it by hand per test. A standalone
// type (NOT intersected with Window): lib.dom declares requestIdleCallback
// required on Window, and `Window & { x?: … }` keeps it required — delete
// would then be a type error.
type IdleWindow = {
  requestIdleCallback?: (callback: () => void) => number;
  cancelIdleCallback?: (handle: number) => void;
};

function stubIdleCallbacks(): () => void {
  const win = window as unknown as IdleWindow;
  let pending: (() => void) | null = null;
  win.requestIdleCallback = (callback: () => void): number => {
    pending = callback;
    return 1;
  };
  win.cancelIdleCallback = vi.fn();
  return () => {
    pending?.();
  };
}

const PROPS = {
  workspaceId: "ws_probe",
  projectId: "prj_probe",
  projectName: "Probe",
} as const;

afterEach(() => {
  cleanup();
  const win = window as unknown as IdleWindow;
  win.requestIdleCallback = undefined;
  win.cancelIdleCallback = undefined;
  vi.restoreAllMocks();
});

describe("IdleCommentsRegion — the idle deferral", () => {
  it("renders nothing until the browser goes idle (the comments chunks stay off the critical path)", async () => {
    const fire = stubIdleCallbacks();
    render(<IdleCommentsRegion {...PROPS} />);

    expect(screen.queryByTestId("stub-region")).not.toBeInTheDocument();

    fire();
    // The dynamic import resolves on a later tick.
    await waitFor(() => {
      expect(screen.getByTestId("stub-region")).toBeInTheDocument();
    });
  });

  it("once idle: the real region renders with every prop passed through", async () => {
    const fire = stubIdleCallbacks();
    render(<IdleCommentsRegion {...PROPS} />);

    fire();
    await waitFor(() => {
      expect(screen.getByTestId("stub-region")).toBeInTheDocument();
    });
    expect(screen.getByTestId("stub-region")).toHaveAttribute("data-project", "prj_probe");
  });

  it("engines without requestIdleCallback still mount the region (timeout fallback)", async () => {
    render(<IdleCommentsRegion {...PROPS} />);

    // No idle callback registered — the 1.5s fallback timer must deliver.
    await waitFor(
      () => {
        expect(screen.getByTestId("stub-region")).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it("a still-loading document does not import before the load event (load gate)", async () => {
    // Shadow readyState so the component takes the load-event branch.
    Object.defineProperty(document, "readyState", {
      value: "loading",
      configurable: true,
    });
    try {
      const fire = stubIdleCallbacks();
      render(<IdleCommentsRegion {...PROPS} />);

      // An idle gap opening mid-load must NOT deliver the import: before
      // the load event the component has not registered any idle callback.
      fire();
      expect(screen.queryByTestId("stub-region")).not.toBeInTheDocument();
      // Give the (unregistered) dynamic import ample time to prove absence.
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
      expect(screen.queryByTestId("stub-region")).not.toBeInTheDocument();

      // The load event fires: NOW the idle callback is registered and the
      // import rides idle time after the eager scripts have evaluated.
      window.dispatchEvent(new Event("load"));
      fire();
      await waitFor(() => {
        expect(screen.getByTestId("stub-region")).toBeInTheDocument();
      });
    } finally {
      // Remove the own-property shadow, restoring the prototype getter.
      // Reflect.deleteProperty, NOT the delete operator (biome noDelete) and
      // NOT an undefined assignment — that would leave an own property
      // shadowing the getter with a broken value for every later test.
      Reflect.deleteProperty(document, "readyState");
    }
  });
});
