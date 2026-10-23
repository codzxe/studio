import { useOnlineStatus } from "@/lib/use-online-status";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

/**
 * useOnlineStatus (M9-H): the navigator.onLine listener hook behind the auth
 * offline states. jsdom defaults navigator.onLine to true and never fires
 * connection events on its own, so these tests redefine the property and
 * dispatch the window events the browser would fire.
 */

/** jsdom navigator.onLine shim: redefine the property + fire the browser event. */
function setNavigatorOnline(online: boolean) {
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    get: () => online,
  });
  window.dispatchEvent(new Event(online ? "online" : "offline"));
}

afterEach(() => {
  setNavigatorOnline(true);
});

describe("useOnlineStatus", () => {
  it("reports the current connection on first render", () => {
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(true);
  });

  it("flips to false when the browser goes offline and back on when it recovers", () => {
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(true);

    act(() => {
      setNavigatorOnline(false);
    });
    expect(result.current).toBe(false);

    act(() => {
      setNavigatorOnline(true);
    });
    expect(result.current).toBe(true);
  });

  it("starts honest when the browser is already offline at mount", () => {
    setNavigatorOnline(false);
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(false);
  });
});
