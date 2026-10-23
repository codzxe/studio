/**
 * OfflineBanner tests (W2-01, §8.11) — the shell-level offline state wraps
 * `lib/use-online-status` + the shared `OfflineState`: null while online, the
 * honest copy when the browser reports no connection. jsdom defaults
 * navigator.onLine to true, so each offline case redefines the property and
 * fires the event the browser would (the auth-offline test pattern).
 */

import { OfflineBanner } from "@/components/shell/offline-banner";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

/** jsdom navigator.onLine shim. */
function setNavigatorOnline(online: boolean) {
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    get: () => online,
  });
  window.dispatchEvent(new Event(online ? "online" : "offline"));
}

beforeEach(() => {
  setNavigatorOnline(true);
});

describe("OfflineBanner", () => {
  it("renders null while online (the shell's visual layout is unchanged)", () => {
    const { container } = render(<OfflineBanner />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("offline-state")).not.toBeInTheDocument();
  });

  it("renders the shared OfflineState with shell-honest copy when offline", () => {
    setNavigatorOnline(false);
    render(<OfflineBanner />);
    expect(screen.getByTestId("shell-offline-banner")).toBeInTheDocument();
    expect(screen.getByTestId("offline-state")).toBeInTheDocument();
    expect(
      screen.getByText("You're offline. Your last saved version is safe."),
    ).toBeInTheDocument();
  });

  it("reappears and disappears with the connection (live store)", async () => {
    render(<OfflineBanner />);
    expect(screen.queryByTestId("shell-offline-banner")).not.toBeInTheDocument();

    await act(async () => {
      setNavigatorOnline(false);
    });
    expect(screen.getByTestId("shell-offline-banner")).toBeInTheDocument();

    await act(async () => {
      setNavigatorOnline(true);
    });
    expect(screen.queryByTestId("shell-offline-banner")).not.toBeInTheDocument();
  });
});
