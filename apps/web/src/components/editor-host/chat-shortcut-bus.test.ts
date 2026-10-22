/**
 * `chat-shortcut-bus` tests (M3.6/D-5) — publish/subscribe/recording, the
 * seam M4's chat overlay will consume.
 */

import { describe, expect, it, vi } from "vitest";
import { createChatShortcutBus } from "./chat-shortcut-bus";

describe("chat-shortcut-bus", () => {
  it("records published events (newest last) and notifies subscribers", () => {
    const bus = createChatShortcutBus();
    const seen: string[] = [];
    const unsubscribe = bus.subscribe((event) => seen.push(event.shortcut));

    bus.publish("inlineEdit", "k");
    bus.publish("toggleChat", "l");

    expect(seen).toEqual(["inlineEdit", "toggleChat"]);
    expect(bus.recent().map((event) => event.shortcut)).toEqual(["inlineEdit", "toggleChat"]);
    expect(bus.recent()[0]?.key).toBe("k");

    unsubscribe();
    bus.publish("agent", "i");
    expect(seen).toHaveLength(2);
  });

  it("a throwing subscriber never breaks publish", () => {
    const bus = createChatShortcutBus();
    bus.subscribe(() => {
      throw new Error("buggy M4 handler");
    });
    const good = vi.fn();
    bus.subscribe(good);
    bus.publish("inlineEdit", "k");
    expect(good).toHaveBeenCalledTimes(1);
    expect(bus.recent()).toHaveLength(1);
  });

  it("bounds the recent log", () => {
    const bus = createChatShortcutBus(3);
    for (let i = 0; i < 5; i++) bus.publish("toggleChat", "l");
    expect(bus.recent()).toHaveLength(3);
  });
});
