/**
 * ChatPanelSlot tests (M5-I; BUILD_PLAN §M5.7 — the agent UX chrome layer).
 *
 * The slot is mounted against a FAKE provider api (the real ChatProvider loop
 * is covered by tests/chat-integration.test.tsx) + an ISOLATED layout store
 * (use-layout's optional-store seam), so every M5-I surface is tested
 * deterministically without the wire:
 *
 * - D-5 shortcut matrix: the slot publishes Cmd/Ctrl+K and Cmd/Ctrl+I from the
 *   PARENT document onto the chat bus — and binds NOTHING when unmounted
 *   (every non-editor route keeps Cmd/Ctrl+K for the command palette).
 * - Inline edit (§4.2): bus "inlineEdit" opens the bar (also from a collapsed
 *   chat), Enter submits through `api.send` TAGGED `inlineEdit: true`,
 *   Escape closes, the credits lock blocks submission.
 * - Agent mode (§4.3): bus "agent" raises the mode chip + focuses the
 *   composer; the §9 Escape escalation clears transients before collapsing.
 * - Quick actions (§4.4): chips seed the composer through the cancelable
 *   seed event (claimed = draft, unclaimed = the M4 quick-action fallback) —
 *   and a click can only ever reach chat: no bridge, no engine, no mutation.
 * - Edit cards (§6.4/§8.6): the clarify card renders the model's question +
 *   answer chips; the error card renders human copy only.
 * - Undo shortcut (§M5.5): bus "undoAgentRun" drives the controller's REAL
 *   undo of the newest applied run (the card's Undo rule); every no-op
 *   answer is honest inline notice copy — nothing fake ever runs.
 */

import { DEFAULT_LAYOUT } from "@/components/chat/layout";
import { CHAT_SEED_COMPOSER_EVENT } from "@/components/chat/quick-actions";
import { CHAT_QUICK_ACTION_EVENT } from "@/components/chat/thread";
import { type ChatLayoutStore, createChatLayoutStore } from "@/components/chat/use-layout";
import { ChatPanelSlot } from "@/components/editor-host/chat-panel-slot";
import { createChatShortcutBus } from "@/components/editor-host/chat-shortcut-bus";
import type { ChatController } from "@/lib/chat/chat-controller";
import { type ContextSnapshot, DEFAULT_FLAGS } from "@/lib/chat/context";
import type { ChatContextApi, ChatModelSummary } from "@/lib/chat/provider";
import type { ChatUiMessage, ChatUiState, PlanRuntime } from "@/lib/chat/types";
import type { AgentBatch, EditPlan } from "@studio/contracts";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const FAST_MODEL: ChatModelSummary = {
  id: "studio-fast",
  tier: "fast",
  use: "Cheap planning, classification, quick edits",
  creditsPer1kInput: 0.01,
  creditsPer1kOutput: 0.03,
};

const STEP = {
  title: "Restyle the target layer",
  tool: "studio.plan_edit",
  args: {},
  batch: { label: "Agent: restyle", steps: [{ command: "prop.set", params: {} }] },
};

function plan(intent: EditPlan["intent"], summary: string, names: string[]): EditPlan {
  return {
    intent,
    summary,
    risk: "low",
    requiresApproval: false,
    affectedLayers: names.map((name) => ({ name, change: "restyle" })),
    estimatedCredits: 1,
    steps: [STEP],
  };
}

function assistantMessage(overrides: Partial<ChatUiMessage>): ChatUiMessage {
  return {
    id: "run:run_1",
    role: "assistant",
    text: "",
    runId: "run_1",
    toolCards: [],
    ...overrides,
  };
}

/** A minimal valid compiled batch (the runtime's only required payload). */
const COMPILED_BATCH: AgentBatch = {
  label: "Agent: restyle",
  atomic: true,
  steps: [{ command: "prop.set", params: {} }],
};

/** One plan runtime at the given lifecycle point (§M5.5 gesture states). */
function planRuntime(outcome: PlanRuntime["outcome"]): PlanRuntime {
  return { compiledBatch: COMPILED_BATCH, outcome };
}

/** A controller double so the Cmd/Ctrl+Shift+U undo shortcut can be observed. */
function fakeController(): { controller: ChatController; undo: ReturnType<typeof vi.fn> } {
  const undo = vi.fn();
  const controller: ChatController = {
    runId: null,
    getSnapshot: () => ({ messages: [], phase: "idle", activeRunId: null, lastSeq: -1 }),
    subscribe: () => () => undefined,
    send: vi.fn(),
    stop: vi.fn(),
    retry: vi.fn(),
    apply: vi.fn(),
    undo,
    reapply: vi.fn(),
    retrySave: vi.fn(),
    dismissPlan: vi.fn(),
    resolveCandidate: vi.fn(),
    dispose: vi.fn(),
  };
  return { controller, undo };
}

function snapshot(messages: ChatUiMessage[], phase: ChatUiState["phase"] = "idle"): ChatUiState {
  return { messages, phase, activeRunId: null, lastSeq: -1 };
}

const CONTEXT_WITH_SELECTION: ContextSnapshot = {
  flags: { ...DEFAULT_FLAGS, selection: true, selectedProperties: true },
  blocks: [
    { kind: "activeComp", label: "Comp: Main", tokenEstimate: 10, data: { name: "Main" } },
    {
      kind: "selection",
      label: "Selection: Headline",
      tokenEstimate: 20,
      data: { layers: [{ name: "Headline", type: "text" }] },
    },
  ],
  pinned: [],
  totalTokenEstimate: 30,
};

const CONTEXT_NO_SELECTION: ContextSnapshot = {
  flags: { ...DEFAULT_FLAGS, selection: false },
  blocks: [{ kind: "activeComp", label: "Comp: Main", tokenEstimate: 10, data: { name: "Main" } }],
  pinned: [],
  totalTokenEstimate: 10,
};

/** A structurally complete fake of the provider api (no wire, no bridge). */
function makeApi(options: {
  readonly bus: ReturnType<typeof createChatShortcutBus>;
  readonly snapshot?: ChatUiState;
  readonly flags?: typeof DEFAULT_FLAGS;
  readonly context?: ContextSnapshot | null;
  readonly controller?: ChatController | null;
}): { api: ChatContextApi; send: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  const retry = vi.fn();
  const api: ChatContextApi = {
    controller: options.controller ?? null,
    snapshot: options.snapshot ?? snapshot([]),
    models: [FAST_MODEL],
    activeModelId: "studio-fast",
    threadId: null,
    threadTitle: "Agent",
    threadError: null,
    flags: options.flags ?? DEFAULT_FLAGS,
    context: options.context === undefined ? null : options.context,
    pinned: [],
    panelVisible: true,
    shortcutBus: options.bus,
    send,
    stop: vi.fn(),
    retry,
    newThread: vi.fn(),
    setActiveModelId: vi.fn(),
    setFlag: vi.fn(),
    clearOptionalBlocks: vi.fn(),
    addPinned: vi.fn(),
    removePinned: vi.fn(),
    setPanelVisible: vi.fn(),
    refreshContext: vi.fn(),
  };
  return { api, send, retry };
}

const stores: ChatLayoutStore[] = [];

/** Mount the slot with an ISOLATED layout store (the use-layout test seam). */
function mountSlot(api: ChatContextApi, mode: "floating" | "sidebar" | "collapsed" = "floating") {
  const store = createChatLayoutStore({
    initial: { ...DEFAULT_LAYOUT, mode, w: 380, h: 520 },
  });
  stores.push(store);
  const view = render(
    <ChatPanelSlot api={api} onSidebarDock={() => undefined} layoutStore={store} />,
  );
  const rerenderWith = (nextApi: ChatContextApi): void => {
    view.rerender(
      <ChatPanelSlot api={nextApi} onSidebarDock={() => undefined} layoutStore={store} />,
    );
  };
  return { store, view, rerenderWith };
}

/** A window keydown helper for the host-side shortcut listener. */
function pressWindowKey(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(event);
  return event;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

// ---------------------------------------------------------------------------
// D-5 — the shortcut binding matrix
// ---------------------------------------------------------------------------

describe("ChatPanelSlot — D-5 shortcut binding (editor route only)", () => {
  it("publishes Cmd/Ctrl+K and Cmd/Ctrl+I from the PARENT document onto the bus", () => {
    const bus = createChatShortcutBus();
    const { api } = makeApi({ bus });
    mountSlot(api);

    let k: KeyboardEvent | undefined;
    let i: KeyboardEvent | undefined;
    act(() => {
      k = pressWindowKey({ key: "k", metaKey: true });
      i = pressWindowKey({ key: "i", ctrlKey: true });
    });

    expect(k?.defaultPrevented).toBe(true);
    expect(i?.defaultPrevented).toBe(true);
    expect(bus.recent().map((event) => event.shortcut)).toEqual(["inlineEdit", "agent"]);
    // The published shortcut opened the surfaces it owns (same-bus wiring).
    expect(screen.getByTestId("chat-inline-edit")).toBeInTheDocument();
    expect(screen.getByTestId("chat-agent-mode")).toBeInTheDocument();
  });

  it("ignores Shift/Alt combos, bare keys and repeats", () => {
    const bus = createChatShortcutBus();
    const { api } = makeApi({ bus });
    mountSlot(api);

    act(() => {
      pressWindowKey({ key: "k", metaKey: true, shiftKey: true });
      pressWindowKey({ key: "i", metaKey: true, altKey: true });
      pressWindowKey({ key: "k" });
      pressWindowKey({ key: "j", metaKey: true });
      pressWindowKey({ key: "k", metaKey: true, repeat: true });
    });
    expect(bus.recent()).toEqual([]);
  });

  it("binds NOTHING outside the editor route (no slot mounted)", () => {
    const bus = createChatShortcutBus();
    render(<div data-testid="some-other-route" />);
    const event = pressWindowKey({ key: "k", metaKey: true });
    expect(bus.recent()).toEqual([]);
    // Without the slot's listener the key stays free (e.g. a command palette).
    expect(event.defaultPrevented).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §4.2 inline edit
// ---------------------------------------------------------------------------

describe("ChatPanelSlot — inline edit (Cmd/Ctrl+K)", () => {
  it("opens the bar focused above the composer and Escape (bus) closes it unsent", () => {
    const bus = createChatShortcutBus();
    const { api, send } = makeApi({ bus });
    mountSlot(api);

    expect(screen.queryByTestId("chat-inline-edit")).not.toBeInTheDocument();
    act(() => bus.publish("inlineEdit", "k"));
    expect(screen.getByTestId("chat-inline-edit")).toBeInTheDocument();
    expect(screen.getByLabelText("Inline edit request")).toHaveFocus();

    act(() => bus.publish("escape", "Escape"));
    expect(screen.queryByTestId("chat-inline-edit")).not.toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();
  });

  it("expands a collapsed chat first so the bar lands next to its composer", () => {
    const bus = createChatShortcutBus();
    const { api } = makeApi({ bus });
    mountSlot(api, "collapsed");
    expect(screen.getByTestId("chat-collapsed-layer")).toBeInTheDocument();

    act(() => bus.publish("inlineEdit", "k"));
    expect(screen.getByTestId("chat-slot")).toHaveAttribute("data-chat-mode", "floating");
    expect(screen.getByTestId("chat-inline-edit")).toBeInTheDocument();
  });

  it("submits through the chat seam tagged inlineEdit: true", () => {
    const bus = createChatShortcutBus();
    const { api, send } = makeApi({ bus });
    mountSlot(api);
    act(() => bus.publish("inlineEdit", "k"));

    const input = screen.getByLabelText("Inline edit request");
    fireEvent.change(input, { target: { value: "make this warm white" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ message: "make this warm white", inlineEdit: true });
    expect(screen.queryByTestId("chat-inline-edit")).not.toBeInTheDocument();
  });

  it("a repeated Cmd/Ctrl+K re-focuses the SAME bar (idempotent open)", () => {
    const bus = createChatShortcutBus();
    const { api } = makeApi({ bus });
    mountSlot(api);
    act(() => bus.publish("inlineEdit", "k"));
    fireEvent.change(screen.getByLabelText("Inline edit request"), {
      target: { value: "still typing" },
    });
    (screen.getByTestId("chat-inline-edit-send") as HTMLElement).focus();

    act(() => bus.publish("inlineEdit", "k"));
    const bars = screen.getAllByTestId("chat-inline-edit");
    expect(bars).toHaveLength(1);
    expect(screen.getByLabelText("Inline edit request")).toHaveFocus();
    expect(screen.getByLabelText("Inline edit request")).toHaveValue("still typing");
  });

  it("locks behind the credits composer state and never sends (§12)", () => {
    const bus = createChatShortcutBus();
    const { api, send } = makeApi({
      bus,
      snapshot: {
        messages: [],
        phase: "failed",
        activeRunId: null,
        lastSeq: -1,
        error: {
          code: "INSUFFICIENT_CREDITS",
          message: "You're out of credits.",
          retryable: false,
        },
      },
    });
    mountSlot(api);
    act(() => bus.publish("inlineEdit", "k"));

    expect(screen.getByTestId("chat-inline-edit-locked")).toHaveTextContent(
      "You're out of credits.",
    );
    // Quick actions hide too — a chip must not fall back to a doomed send.
    expect(screen.queryByTestId("chat-quick-actions")).not.toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §4.3 agent mode
// ---------------------------------------------------------------------------

describe("ChatPanelSlot — agent mode (Cmd/Ctrl+I)", () => {
  it("raises the mode chip and focuses the composer", () => {
    const bus = createChatShortcutBus();
    const { api } = makeApi({ bus });
    mountSlot(api);

    act(() => bus.publish("agent", "i"));
    expect(screen.getByTestId("chat-agent-mode")).toBeInTheDocument();
    expect(screen.getByTestId("chat-slot")).toHaveFocus();

    fireEvent.click(screen.getByTestId("chat-agent-mode-exit"));
    expect(screen.queryByTestId("chat-agent-mode")).not.toBeInTheDocument();
  });

  it("§9 Escape escalation: chip first, panel collapse second", () => {
    const bus = createChatShortcutBus();
    const { api } = makeApi({ bus });
    mountSlot(api);

    act(() => bus.publish("agent", "i"));
    act(() => bus.publish("escape", "Escape"));
    expect(screen.queryByTestId("chat-agent-mode")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-slot")).toHaveAttribute("data-chat-mode", "floating");

    act(() => bus.publish("escape", "Escape"));
    expect(screen.getByTestId("chat-slot")).toHaveAttribute("data-chat-mode", "collapsed");
  });

  it("opening the inline bar exits agent mode (one focused entry at a time)", () => {
    const bus = createChatShortcutBus();
    const { api } = makeApi({ bus });
    mountSlot(api);

    act(() => bus.publish("agent", "i"));
    act(() => bus.publish("inlineEdit", "k"));
    expect(screen.queryByTestId("chat-agent-mode")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-inline-edit")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// §4.4 quick actions above the composer
// ---------------------------------------------------------------------------

describe("ChatPanelSlot — quick actions (§4.4)", () => {
  it("renders the §4.4 chips with the selection context only while a selection exists", () => {
    const bus = createChatShortcutBus();
    const withSelection = makeApi({
      bus,
      flags: { ...DEFAULT_FLAGS, selection: true },
      context: CONTEXT_WITH_SELECTION,
    });
    const first = mountSlot(withSelection.api);

    const chips = screen.getAllByTestId("chat-quick-action-chip");
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "Animate in",
      "Animate out",
      "Make it pop",
      "Match brand colors",
      "Clean up layers",
      "Explain this comp",
      "Render a preview",
    ]);
    // The §4.4 selection context is templated into the prompt (title chip).
    expect(chips[0]).toHaveAttribute("title", "Animate “Headline” in with a smooth entrance.");
    first.view.unmount();

    // No selection → no composer-row chips (the M4 empty-thread chips remain).
    const bare = makeApi({ bus, context: CONTEXT_NO_SELECTION });
    const second = mountSlot(bare.api);
    expect(screen.queryByTestId("chat-quick-actions")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("chat-quick-action").length).toBe(3);
    second.view.unmount();
  });

  it("a click SEEDS the composer when the seed event is claimed — no send, no mutation seam", () => {
    const bus = createChatShortcutBus();
    const { api, send } = makeApi({
      bus,
      flags: { ...DEFAULT_FLAGS, selection: true },
      context: CONTEXT_WITH_SELECTION,
    });
    mountSlot(api);

    const seeded: string[] = [];
    const quickSpy = vi.fn();
    const claimer = (event: Event): void => {
      event.preventDefault(); // a draft-capable composer claims the seed
      seeded.push((event as CustomEvent<string>).detail);
    };
    window.addEventListener(CHAT_SEED_COMPOSER_EVENT, claimer);
    window.addEventListener(CHAT_QUICK_ACTION_EVENT, quickSpy);
    try {
      fireEvent.click(screen.getByText("Animate in"));
    } finally {
      window.removeEventListener(CHAT_SEED_COMPOSER_EVENT, claimer);
      window.removeEventListener(CHAT_QUICK_ACTION_EVENT, quickSpy);
    }

    expect(seeded).toEqual(["Animate “Headline” in with a smooth entrance."]);
    expect(quickSpy).not.toHaveBeenCalled(); // no fallback when claimed
    expect(send).not.toHaveBeenCalled(); // chat-only: the editor cannot be touched
  });

  it("an UNCLAIMED seed falls back to the M4 quick-action send path", () => {
    const bus = createChatShortcutBus();
    const { api, send } = makeApi({
      bus,
      flags: { ...DEFAULT_FLAGS, selection: true },
      context: CONTEXT_WITH_SELECTION,
    });
    mountSlot(api);

    const quickSpy = vi.fn();
    window.addEventListener(CHAT_QUICK_ACTION_EVENT, quickSpy);
    try {
      fireEvent.click(screen.getByText("Match brand colors"));
    } finally {
      window.removeEventListener(CHAT_QUICK_ACTION_EVENT, quickSpy);
    }

    expect(quickSpy).toHaveBeenCalledTimes(1);
    expect((quickSpy.mock.calls[0]?.[0] as CustomEvent<string>).detail).toBe(
      "Match “Headline” to the brand colors.",
    );
    // The fallback is an event for the provider — the slot itself never sends.
    expect(send).not.toHaveBeenCalled();
  });

  it("flows hostile layer names as data through the seed seam", () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const bus = createChatShortcutBus();
    const { api } = makeApi({
      bus,
      flags: { ...DEFAULT_FLAGS, selection: true },
      context: {
        ...CONTEXT_WITH_SELECTION,
        blocks: [
          CONTEXT_WITH_SELECTION.blocks[0] as ContextSnapshot["blocks"][number],
          {
            kind: "selection",
            label: `Selection: ${hostile}`,
            tokenEstimate: 1,
            data: { layers: [{ name: hostile }] },
          },
        ],
      },
    });
    mountSlot(api);

    const seeded: string[] = [];
    const claimer = (event: Event): void => {
      event.preventDefault();
      seeded.push((event as CustomEvent<string>).detail);
    };
    window.addEventListener(CHAT_SEED_COMPOSER_EVENT, claimer);
    try {
      fireEvent.click(screen.getAllByTestId("chat-quick-action-chip")[0] as HTMLElement);
    } finally {
      window.removeEventListener(CHAT_SEED_COMPOSER_EVENT, claimer);
    }
    expect(seeded[0]).toBe(`Animate “${hostile}” in with a smooth entrance.`);
    // Rendered as data: the chip title carries the name verbatim, no markup.
    expect(document.querySelector("img")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §8.6 clarify card
// ---------------------------------------------------------------------------

describe("ChatPanelSlot — clarify card (§8.6)", () => {
  const clarifySnapshot = snapshot([
    assistantMessage({
      text: "I found three text layers.",
      plan: plan("clarify", "Which text layer should I change?", ["Headline", "Subhead", "Badge"]),
    }),
  ]);

  it("renders the question + answer chips wired to the composer seed seam", () => {
    const bus = createChatShortcutBus();
    const { api, send } = makeApi({ bus, snapshot: clarifySnapshot });
    mountSlot(api);

    expect(screen.getByTestId("edit-clarify-question")).toHaveTextContent(
      "Which text layer should I change?",
    );
    const chips = screen.getAllByTestId("edit-clarify-answer");
    expect(chips).toHaveLength(3);

    const seeded: string[] = [];
    const claimer = (event: Event): void => {
      event.preventDefault();
      seeded.push((event as CustomEvent<string>).detail);
    };
    window.addEventListener(CHAT_SEED_COMPOSER_EVENT, claimer);
    try {
      fireEvent.click(chips[0] as HTMLElement);
    } finally {
      window.removeEventListener(CHAT_SEED_COMPOSER_EVENT, claimer);
    }
    expect(seeded).toEqual(["Go with “Headline”."]);
    expect(send).not.toHaveBeenCalled();
  });

  it("dismisses via ×, re-raises for a LATER question, Esc clears it, and a composer answer hides it", () => {
    const bus = createChatShortcutBus();
    const { api } = makeApi({ bus, snapshot: clarifySnapshot });
    const { rerenderWith } = mountSlot(api);

    fireEvent.click(screen.getByTestId("edit-clarify-dismiss"));
    expect(screen.queryByTestId("edit-clarify-card")).not.toBeInTheDocument();

    // A LATER clarify question re-raises the card (dismissal is per-message).
    const nextClarify = makeApi({
      bus,
      snapshot: snapshot([
        assistantMessage({
          id: "run:run_2",
          text: "One more thing.",
          plan: plan("clarify", "Which layer should I restyle now?", ["Headline"]),
        }),
      ]),
    });
    rerenderWith(nextClarify.api);
    expect(screen.getByTestId("edit-clarify-card")).toBeInTheDocument();

    act(() => bus.publish("escape", "Escape"));
    expect(screen.queryByTestId("edit-clarify-card")).not.toBeInTheDocument();
    // The panel itself did NOT collapse on that Esc (transients first).
    expect(screen.getByTestId("chat-slot")).toHaveAttribute("data-chat-mode", "floating");

    // The user answers in the composer → a trailing user message hides the card.
    const answered = makeApi({
      bus,
      snapshot: snapshot([
        assistantMessage({
          id: "run:run_3",
          text: "One more thing.",
          plan: plan("clarify", "Which layer should I restyle now?", ["Headline"]),
        }),
        { id: "usr_1", role: "user", text: "Go with Headline.", toolCards: [] },
      ]),
    });
    rerenderWith(answered.api);
    expect(screen.queryByTestId("edit-clarify-card")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// §6.4 error card
// ---------------------------------------------------------------------------

describe("ChatPanelSlot — error card (§6.4)", () => {
  const failedCardSnapshot = snapshot([
    assistantMessage({
      text: "I could not finish the edit.",
      toolCards: [
        {
          toolCallId: "call_1",
          name: "studio.plan_edit",
          status: "failed",
          result: {
            error: "PLAN_INVALID",
            message:
              'at compile (/srv/gateway/plan-compiler.rs:9) {"steps": [{"command": "layer.delete"}]}',
          },
        },
      ],
    }),
  ]);

  it("renders human copy for the newest failed tool card — internals never leak", () => {
    const bus = createChatShortcutBus();
    const { api, send } = makeApi({ bus, snapshot: failedCardSnapshot });
    mountSlot(api);

    expect(screen.getByTestId("edit-error-card")).toBeInTheDocument();
    // Scope to MY surface: the peer ToolCard (§6.1) shows the raw tool message
    // in the thread — the §6.4 card above the composer must stay sanitized.
    const dom = screen.getByTestId("chat-composer-stack").textContent ?? "";
    expect(dom).not.toContain("/srv/gateway");
    expect(dom).not.toContain("plan-compiler.rs");
    expect(dom).not.toContain("layer.delete");
    expect(screen.getByTestId("edit-error-copy")).toHaveTextContent(
      "This edit didn't go through. Nothing in the project changed.",
    );
    // Terminal-but-completed run: no Retry seam (the thread owns the banner).
    expect(screen.queryByTestId("edit-error-retry")).not.toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();
  });

  it("offers Retry (api.retry) while the run phase is failed, and dismisses", () => {
    const bus = createChatShortcutBus();
    const { api, retry } = makeApi({
      bus,
      snapshot: {
        ...failedCardSnapshot,
        phase: "failed",
        error: { code: "RUN_FAILED", message: "The run stopped.", retryable: true },
      },
    });
    mountSlot(api);

    fireEvent.click(screen.getByTestId("edit-error-retry"));
    expect(retry).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("edit-error-dismiss"));
    expect(screen.queryByTestId("edit-error-card")).not.toBeInTheDocument();
  });

  it("a pending clarify question outranks the error card above the composer", () => {
    const bus = createChatShortcutBus();
    const { api } = makeApi({
      bus,
      snapshot: snapshot([
        assistantMessage({
          text: "Pick one.",
          plan: plan("clarify", "Which layer?", ["A"]),
          toolCards: [
            {
              toolCallId: "call_9",
              name: "studio.plan_edit",
              status: "failed",
              result: { error: "PLAN_INVALID", message: "stack-ish at x (/y/z.rs:1)" },
            },
          ],
        }),
      ]),
    });
    mountSlot(api);

    expect(screen.getByTestId("edit-clarify-card")).toBeInTheDocument();
    expect(screen.queryByTestId("edit-error-card")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// §M5.5 — Cmd/Ctrl+Shift+U (undoAgentRun) drives the REAL controller undo
// ---------------------------------------------------------------------------

describe("ChatPanelSlot — undoAgentRun (§M5.5)", () => {
  it("undoes the NEWEST applied run through the controller", () => {
    const bus = createChatShortcutBus();
    const { controller, undo } = fakeController();
    const { api } = makeApi({
      bus,
      controller,
      snapshot: snapshot([
        assistantMessage({
          id: "run:run_1",
          runId: "run_1",
          text: "First edit applied.",
          planRuntime: planRuntime("applied"),
        }),
        assistantMessage({
          id: "run:run_2",
          runId: "run_2",
          text: "Second edit applied.",
          planRuntime: planRuntime("applied"),
        }),
      ]),
    });
    mountSlot(api);

    act(() => bus.publish("undoAgentRun", "u"));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(undo).toHaveBeenCalledWith("run_2");
    // The shortcut answers with action, never a notice.
    expect(screen.queryByTestId("chat-notice")).not.toBeInTheDocument();
  });

  it("a failed undo stays retryable from the shortcut (the card's Undo rule)", () => {
    const bus = createChatShortcutBus();
    const { controller, undo } = fakeController();
    const { api } = makeApi({
      bus,
      controller,
      snapshot: snapshot([
        assistantMessage({
          text: "The engine undid a foreign step.",
          planRuntime: {
            ...planRuntime("undo-failed"),
            error: {
              code: "UNDO_STACK_MISMATCH",
              message: "A different edit was on top.",
              retryable: false,
            },
          },
        }),
      ]),
    });
    mountSlot(api);

    act(() => bus.publish("undoAgentRun", "u"));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(undo).toHaveBeenCalledWith("run_1");
  });

  it("does NOT fire a second undo while one is settling (the card hides Undo then)", () => {
    const bus = createChatShortcutBus();
    const { controller, undo } = fakeController();
    const { api } = makeApi({
      bus,
      controller,
      snapshot: snapshot([assistantMessage({ planRuntime: planRuntime("undoing") })]),
    });
    mountSlot(api);

    act(() => bus.publish("undoAgentRun", "u"));
    expect(undo).not.toHaveBeenCalled();
    // Honest in-flight answer — not the false "nothing to undo".
    expect(screen.getByTestId("chat-notice")).toHaveTextContent(
      "Still finishing the last edit — try again in a moment.",
    );
  });

  it("answers the honest nothing-to-undo notice when no run is applied", () => {
    const bus = createChatShortcutBus();
    const { controller, undo } = fakeController();
    const { api } = makeApi({
      bus,
      controller,
      snapshot: snapshot([
        assistantMessage({
          text: "A proposed plan.",
          plan: plan("edit", "Restyle the title", ["Headline"]),
          planRuntime: planRuntime("idle"),
        }),
      ]),
    });
    mountSlot(api);

    act(() => bus.publish("undoAgentRun", "u"));
    expect(undo).not.toHaveBeenCalled();
    expect(screen.getByTestId("chat-notice")).toHaveTextContent("There is nothing to undo.");
  });

  it("without a controller (no thread yet) the notice answers and nothing runs", () => {
    const bus = createChatShortcutBus();
    const { api } = makeApi({ bus }); // controller stays null
    mountSlot(api);

    act(() => bus.publish("undoAgentRun", "u"));
    expect(screen.getByTestId("chat-notice")).toHaveTextContent("There is nothing to undo.");
  });
});

// ---------------------------------------------------------------------------
// Composer-stack sanity: the M4 surfaces survive the M5 chrome
// ---------------------------------------------------------------------------

describe("ChatPanelSlot — M4 regression", () => {
  it("keeps the pinned M4 composer + empty-thread quick actions intact", () => {
    const bus = createChatShortcutBus();
    const { api } = makeApi({ bus });
    mountSlot(api);

    expect(screen.getByTestId("chat-composer")).toBeInTheDocument();
    expect(screen.getByTestId("chat-composer-stack")).toBeInTheDocument();
    expect(screen.getByTestId("chat-panel-composer")).toBeInTheDocument();
    expect(screen.getAllByTestId("chat-quick-action").length).toBe(3); // the M4 thread chips
  });
});
