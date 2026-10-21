import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastViewport } from "../src/components/toast.js";
import {
  TOAST_DEFAULT_DURATION_MS,
  createToastStore,
  toast,
  toastStore,
  toastVariantFromStatus,
  type ToastStore,
} from "../src/lib/toast-store.js";

afterEach(() => {
  toastStore.dismissAll();
  vi.useRealTimers();
});

describe("toast store (pure logic)", () => {
  it("push applies the defaults: info variant, default duration, unique ids", () => {
    const store = createToastStore();
    const idA = store.push("Saved");
    const idB = store.push("Render queued");
    const { toasts } = store.getState();
    expect(toasts.map((t) => t.title)).toEqual(["Saved", "Render queued"]);
    expect(toasts.map((t) => t.variant)).toEqual(["info", "info"]);
    expect(toasts.map((t) => t.duration)).toEqual([
      TOAST_DEFAULT_DURATION_MS,
      TOAST_DEFAULT_DURATION_MS,
    ]);
    expect(idA).not.toBe(idB);
  });

  it("push accepts full input (description, variant, custom duration)", () => {
    const store = createToastStore();
    const id = store.push({
      title: "Render failed",
      description: "The engine is unavailable. Try again shortly.",
      variant: "error",
      duration: 250,
    });
    const pushed = store.getState().toasts[0];
    expect(pushed).toMatchObject({
      id,
      variant: "error",
      title: "Render failed",
      description: "The engine is unavailable. Try again shortly.",
      duration: 250,
    });
  });

  it("dismiss removes one toast and is a no-op for unknown ids", () => {
    const store = createToastStore();
    const idA = store.push("A");
    const idB = store.push("B");
    store.dismiss(idA);
    expect(store.getState().toasts.map((t) => t.title)).toEqual(["B"]);
    store.dismiss("toast-does-not-exist");
    expect(store.getState().toasts).toHaveLength(1);
    expect(idB).toBe(store.getState().toasts[0]?.id);
  });

  it("dismissAll empties the store (and emits)", () => {
    const store = createToastStore();
    store.push("A");
    store.push("B");
    const seen: number[] = [];
    const unsubscribe = store.subscribe(() => seen.push(store.getState().toasts.length));
    store.dismissAll();
    expect(store.getState().toasts).toHaveLength(0);
    expect(seen).toEqual([0]);
    unsubscribe();
  });

  it("subscribe fires on push and unsubscribe stops delivery", () => {
    const store = createToastStore();
    const calls: string[] = [];
    const unsubscribe = store.subscribe(() => calls.push("change"));
    store.push("one");
    store.push("two");
    unsubscribe();
    store.push("three");
    expect(calls).toHaveLength(2);
  });

  it("update patches a live toast and ignores unknown ids", () => {
    const store = createToastStore();
    const id = store.push({ title: "Rendering…", variant: "info" });
    store.update(id, { title: "Render complete", variant: "success" });
    expect(store.getState().toasts[0]).toMatchObject({
      id,
      title: "Render complete",
      variant: "success",
    });
    const before = store.getState();
    store.update("toast-does-not-exist", { title: "nope" });
    expect(store.getState()).toBe(before); // no change, no emit
  });

  it("auto-dismisses after duration (timers) and keeps duration 0 sticky", () => {
    vi.useFakeTimers();
    const store = createToastStore();
    store.push({ title: "quick", duration: 100 });
    store.push({ title: "sticky", duration: 0 });
    expect(store.getState().toasts).toHaveLength(2);
    act(() => {
      vi.advanceTimersByTime(99);
    });
    expect(store.getState().toasts).toHaveLength(2);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(store.getState().toasts.map((t) => t.title)).toEqual(["sticky"]);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(store.getState().toasts.map((t) => t.title)).toEqual(["sticky"]);
  });

  it("a manual dismiss cancels the pending auto-dismiss timer", () => {
    vi.useFakeTimers();
    const store = createToastStore();
    const id = store.push({ title: "bye", duration: 100 });
    store.dismiss(id);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // already gone, and no late emit/crash
    expect(store.getState().toasts).toHaveLength(0);
  });

  it("createToastStore instances are isolated from each other", () => {
    const a = createToastStore();
    const b = createToastStore();
    a.push("in-a");
    b.push("in-b-1");
    b.push("in-b-2");
    expect(a.getState().toasts.map((t) => t.title)).toEqual(["in-a"]);
    expect(b.getState().toasts.map((t) => t.title)).toEqual(["in-b-1", "in-b-2"]);
  });

  it("toast helper emitters bind variants on the singleton store", () => {
    toast.success("ok");
    toast.error({ title: "bad", description: "hint" });
    toast.warning("warned");
    toast.info("noted");
    expect(toastStore.getState().toasts.map((t) => t.variant)).toEqual([
      "success",
      "error",
      "warning",
      "info",
    ]);
    expect(toastStore.getState().toasts[1]?.description).toBe("hint");
  });

  // Table-driven: run-state → toast variant (mirrors Badge STATUS_BADGE_VARIANT, §13.2).
  it.each([
    ["succeeded", "success"],
    ["succeeded_with_warnings", "warning"],
    ["warning", "warning"],
    ["failed", "error"],
    ["error", "error"],
    ["cancelled", "info"],
    ["canceled", "info"],
    ["queued", "info"],
    ["running", "info"],
    ["some_future_status", "info"],
  ] as const)("toastVariantFromStatus(%j) → %j", (status, expected) => {
    expect(toastVariantFromStatus(status)).toBe(expected);
  });
});

describe("ToastViewport (render)", () => {
  it("renders live toasts with role=status, variant styling and a labelled dismiss button", () => {
    const store: ToastStore = createToastStore();
    render(<ToastViewport store={store} />);
    expect(screen.queryByRole("status")).toBeNull();

    act(() => {
      store.push({ title: "Document saved", description: "Version 3 created", variant: "success" });
    });
    const item = screen.getByRole("status");
    expect(item).toHaveTextContent("Document saved");
    expect(item).toHaveTextContent("Version 3 created");
    expect(item).toHaveAttribute("data-variant", "success");

    act(() => {
      screen.getByRole("button", { name: "Dismiss notification" }).click();
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders multiple toasts in push order", () => {
    const store = createToastStore();
    render(<ToastViewport store={store} />);
    act(() => {
      store.push("first");
      store.push({ title: "second", variant: "error" });
    });
    const items = screen.getAllByRole("status");
    expect(items.map((el) => el.textContent)).toEqual(["first", "second"]);
  });

  it("auto-dismiss removes a toast from the DOM after its duration", () => {
    vi.useFakeTimers();
    const store = createToastStore();
    render(<ToastViewport store={store} />);
    act(() => {
      store.push({ title: "flash", duration: 250 });
    });
    expect(screen.getByRole("status")).toBeDefined();
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
