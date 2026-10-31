// ROUND 13 — stream pacer unit tests (deterministic: injected fake timers,
// no real waiting). Pins the three contracts that make pacing safe:
//   1. adaptive release (typing speed at the tail, fast-forward through bulk),
//   2. flush-before-forward ordering for non-delta events (a terminal's
//      authoritative replace can never race a stale buffered tail),
//   3. strictly increasing rewritten seqs (the fold's dedupe keeps working).

import { type MockInstance, describe, expect, it, vi } from "vitest";

import type { StudioStreamEvent } from "@studio/contracts";

import { createStreamPacer, isPacedEventType } from "../stream-pacer";

function textDelta(seq: number, delta: string, runId = "run_1"): StudioStreamEvent {
  return { type: "message.delta", runId, seq, delta };
}

function reasoningDelta(seq: number, delta: string, runId = "run_1"): StudioStreamEvent {
  return { type: "reasoning.delta", runId, seq, delta };
}

function turnCompleted(seq: number, text: string, runId = "run_1"): StudioStreamEvent {
  return {
    type: "turn.completed",
    runId,
    seq,
    stepIndex: 0,
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1 },
    credits: { committed: 1 },
    assistantText: text,
    toolCalls: [],
  };
}

function toolStarted(seq: number, runId = "run_1"): StudioStreamEvent {
  return {
    type: "tool.started",
    runId,
    seq,
    toolCallId: "t1",
    name: "studio.get_context",
    args: {},
  };
}

/** Fake timer harness: capture interval callbacks, fire them manually. */
function fakeTimers(): {
  fire: (ticks: number) => void;
  activeTimers: () => number;
  vi: { setInterval: MockInstance; clearInterval: MockInstance };
} {
  const timers = new Map<number, () => void>();
  let nextId = 1;
  const setIntervalMock = vi.fn((callback: () => void, _ms: number) => {
    const id = nextId;
    nextId += 1;
    timers.set(id, callback);
    return id;
  });
  const clearIntervalMock = vi.fn((id: unknown) => {
    timers.delete(id as number);
  });
  return {
    fire(ticks: number) {
      for (const callback of [...timers.values()]) {
        for (let i = 0; i < ticks; i += 1) callback();
      }
    },
    activeTimers: () => timers.size,
    vi: { setInterval: setIntervalMock, clearInterval: clearIntervalMock },
  };
}

describe("stream pacer", () => {
  it("buffers delta text and releases it in small adaptive pieces", () => {
    const timers = fakeTimers();
    const out: StudioStreamEvent[] = [];
    const pacer = createStreamPacer((event) => out.push(event), {
      setInterval: timers.vi.setInterval as unknown as typeof setInterval,
      clearInterval: timers.vi.clearInterval as unknown as (handle: unknown) => void,
    });

    // A single 30-char burst (the "whole reply in one chunk" case).
    pacer.push(textDelta(0, "0123456789".repeat(3)));
    expect(out).toEqual([]); // nothing until the first tick
    expect(timers.activeTimers()).toBe(1);

    // Backlog 30 → ceil(30/14)=3 chars/tick: two ticks release 6 chars.
    timers.fire(2);
    expect(out).toHaveLength(2);
    expect(out.map((event) => (event as { delta: string }).delta).join("")).toBe("012345");

    // Seqs strictly increase from the first event's seq.
    expect(out.map((event) => event.seq)).toEqual([0, 1]);
  });

  it("speeds up proportionally with a large backlog (never lags the source)", () => {
    const timers = fakeTimers();
    const out: StudioStreamEvent[] = [];
    const pacer = createStreamPacer((event) => out.push(event), {
      setInterval: timers.vi.setInterval as unknown as typeof setInterval,
      clearInterval: timers.vi.clearInterval as unknown as (handle: unknown) => void,
    });

    const big = "x".repeat(3200);
    pacer.push(textDelta(0, big));
    // First tick releases the clamped max (160 chars — backlog 3200/14 = 229
    // is above the cap) — bulk is fast-forwarded, never dripped.
    timers.fire(1);
    expect(out[0]).toMatchObject({ type: "message.delta" });
    expect((out[0] as { delta: string }).delta).toBe("x".repeat(160));
    // The adaptive curve shrinks with the backlog but the min (3/tick) keeps
    // draining — enough ticks always converge, and the timer self-stops.
    timers.fire(1_000);
    const drained = out.map((event) => (event as { delta: string }).delta).join("");
    expect(drained).toBe(big);
    expect(timers.activeTimers()).toBe(0); // auto-stops when empty
  });

  it("flushes the backlog BEFORE forwarding non-delta events (ordering contract)", () => {
    const timers = fakeTimers();
    const out: StudioStreamEvent[] = [];
    const pacer = createStreamPacer((event) => out.push(event), {
      setInterval: timers.vi.setInterval as unknown as typeof setInterval,
      clearInterval: timers.vi.clearInterval as unknown as (handle: unknown) => void,
    });

    pacer.push(textDelta(0, "Building the composition now"));
    pacer.push(toolStarted(1));
    // The tool.started arrives IMMEDIATELY, after a synchronous flush.
    const types = out.map((event) => event.type);
    expect(types).toEqual([
      "message.delta", // the whole buffered tail, flushed first
      "tool.started", // then the non-delta event
    ]);
    // Ordering + monotonic seqs.
    expect((out[0]?.seq ?? 0) < (out[1]?.seq ?? 0)).toBe(true);
  });

  it("a terminal turn.completed flushes the tail then forwards (authoritative replace is safe)", () => {
    const timers = fakeTimers();
    const out: StudioStreamEvent[] = [];
    const pacer = createStreamPacer((event) => out.push(event), {
      setInterval: timers.vi.setInterval as unknown as typeof setInterval,
      clearInterval: timers.vi.clearInterval as unknown as (handle: unknown) => void,
    });

    pacer.push(reasoningDelta(0, "Plan: one comp, one text layer."));
    pacer.push(textDelta(1, "Done building."));
    pacer.push(turnCompleted(2, "Done building."));

    expect(out.map((event) => event.type)).toEqual([
      "reasoning.delta",
      "message.delta",
      "turn.completed",
    ]);
    const seqs = out.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length); // strictly unique
  });

  it("keeps reasoning and text pieces in source order while pacing", () => {
    const timers = fakeTimers();
    const out: StudioStreamEvent[] = [];
    const pacer = createStreamPacer((event) => out.push(event), {
      setInterval: timers.vi.setInterval as unknown as typeof setInterval,
      clearInterval: timers.vi.clearInterval as unknown as (handle: unknown) => void,
    });

    pacer.push(reasoningDelta(0, "thinking-"));
    pacer.push(reasoningDelta(1, "more-"));
    pacer.push(textDelta(2, "answer-"));
    timers.fire(3);
    pacer.flush();

    // Pieces may be split at tick boundaries, but TYPE ORDER is source order
    // and each type's concatenation is byte-exact.
    const reasoning = out
      .filter((event) => event.type === "reasoning.delta")
      .map((event) => (event as { delta: string }).delta)
      .join("");
    const text = out
      .filter((event) => event.type === "message.delta")
      .map((event) => (event as { delta: string }).delta)
      .join("");
    expect(reasoning).toBe("thinking-more-");
    expect(text).toBe("answer-");
    // No text piece may precede a reasoning piece (source order).
    const firstTextIndex = out.findIndex((event) => event.type === "message.delta");
    const lastReasoningIndex = out.map((e) => e.type).lastIndexOf("reasoning.delta");
    expect(firstTextIndex).toBeGreaterThan(lastReasoningIndex);
  });

  it("dispose() drops the backlog and kills the timer (stop() mid-stream)", () => {
    const timers = fakeTimers();
    const out: StudioStreamEvent[] = [];
    const pacer = createStreamPacer((event) => out.push(event), {
      setInterval: timers.vi.setInterval as unknown as typeof setInterval,
      clearInterval: timers.vi.clearInterval as unknown as (handle: unknown) => void,
    });

    pacer.push(textDelta(0, "half-streamed"));
    pacer.dispose();
    timers.fire(5);
    expect(out).toEqual([]);
    expect(timers.activeTimers()).toBe(0);
    // A late delta after dispose is dropped, never emitted.
    pacer.push(textDelta(1, "late"));
    expect(out).toEqual([]);
  });

  it("the seq cursor never goes below an incoming event's seq (interleaved synthesized events)", () => {
    const timers = fakeTimers();
    const out: StudioStreamEvent[] = [];
    const pacer = createStreamPacer((event) => out.push(event), {
      setInterval: timers.vi.setInterval as unknown as typeof setInterval,
      clearInterval: timers.vi.clearInterval as unknown as (handle: unknown) => void,
    });

    // First event sets the cursor at 100.
    pacer.push(textDelta(100, "hi"));
    pacer.flush();
    // A synthesized event OUTSIDE the pacer already used seq 101 (the
    // controller's run.seqBase) — the next incoming event carries 102.
    pacer.push(textDelta(102, "there"));
    pacer.flush();
    const seqs = out.map((event) => event.seq);
    expect(seqs.every((seq, index) => index === 0 || seq > (seqs[index - 1] ?? seq))).toBe(true);
  });

  it("empty deltas never enqueue work", () => {
    const timers = fakeTimers();
    const out: StudioStreamEvent[] = [];
    const pacer = createStreamPacer((event) => out.push(event), {
      setInterval: timers.vi.setInterval as unknown as typeof setInterval,
      clearInterval: timers.vi.clearInterval as unknown as (handle: unknown) => void,
    });
    pacer.push(textDelta(0, ""));
    expect(timers.activeTimers()).toBe(0);
    expect(out).toEqual([]);
    expect(isPacedEventType("message.delta")).toBe(true);
    expect(isPacedEventType("reasoning.delta")).toBe(true);
    expect(isPacedEventType("tool.started")).toBe(false);
  });
});
