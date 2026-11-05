"use client";

/**
 * RunProgressStrip — ROUND 12 "Chat UI v3" (docs/research/round12-design.md
 * "Live progress strip: per-turn tool chips (pending/running/done/error)").
 *
 * A compact row under the composer while a run is live. The chips fold from
 * the EXISTING store state only — the live assistant message's tool cards —
 * and the strip is deliberately RESILIENT to absent data (the turn.* events
 * are cursor-only in run-state today): no tool cards yet ⇒ the row shows the
 * honest "Working…" state; a future store that exposes a per-run turn counter
 * overrides the derived step via `turnCount` (absent ⇒ derived: one step per
 * terminal tool card + the in-flight one).
 */

import { LIVE_RUN_PHASES } from "@/lib/chat/run-state";
import type { ChatUiState, RunPhase, ToolCardState } from "@/lib/chat/types";
import { Spinner } from "@studio/ui";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import type { ReactElement } from "react";

/** The strip's chip vocabulary (§ round-12 design, per-tool status). */
export type RunChipStatus = "pending" | "running" | "done" | "error";

export interface RunToolChip {
  readonly toolCallId: string;
  readonly name: string;
  readonly status: RunChipStatus;
}

export interface RunProgressStripProps {
  /** Render nothing unless a LIVE phase is passed. */
  readonly phase: RunPhase;
  /** The live run's tool chips (deriveRunProgress output). */
  readonly chips: readonly RunToolChip[];
  /** Optional authoritative turn/step counter (absent ⇒ derived). */
  readonly turnCount?: number;
}

/** `ToolCardState.status` → the strip's chip vocabulary. */
function chipStatus(status: ToolCardState["status"]): RunChipStatus {
  switch (status) {
    case "queued":
      return "pending";
    case "running":
      return "running";
    case "done":
      return "done";
    case "failed":
      return "error";
  }
}

/** Friendly short names for the chip row (raw ids as the fallback). */
const CHIP_LABELS: Readonly<Record<string, string>> = {
  "studio.get_context": "context",
  "studio.list_layers": "layers",
  "studio.get_properties": "props",
  "studio.plan_edit": "plan",
  "studio.render_preview": "preview",
  web_search: "search",
  generate_image: "image",
  render_audio: "audio",
  engine_commands: "commands",
  describe_command: "describe",
  list_commands: "list",
  add_asset: "asset",
};

function chipLabel(name: string): string {
  return CHIP_LABELS[name] ?? (name.length > 0 ? name : "tool");
}

/**
 * Derive the live run's chips + step from the store snapshot — PURE and
 * total: the last assistant message bound to the ACTIVE run supplies the
 * tool cards (absent ⇒ empty chips, step 1). Never throws on any shape.
 */
export function deriveRunProgress(snapshot: {
  readonly messages: readonly {
    readonly role: string;
    readonly runId?: string;
    readonly toolCards: readonly ToolCardState[];
  }[];
  readonly activeRunId: string | null;
}): { readonly chips: readonly RunToolChip[]; readonly step: number } {
  const runId = snapshot.activeRunId;
  let live = null as readonly ToolCardState[] | null;
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    const message = snapshot.messages[index];
    if (message === undefined) continue;
    if (message.role !== "assistant") continue;
    if (runId !== null && message.runId !== runId) continue;
    live = message.toolCards;
    break;
  }
  const cards = live ?? [];
  const chips: RunToolChip[] = cards.map((card) => ({
    toolCallId: card.toolCallId,
    name: card.name,
    status: chipStatus(card.status),
  }));
  // Derived step: every terminal tool card completed one loop step; the
  // run is always ON the next one. Honest from state alone.
  const terminal = chips.filter((chip) => chip.status === "done" || chip.status === "error").length;
  return { chips, step: terminal + 1 };
}

function ChipMark({ status }: { status: RunChipStatus }): ReactElement {
  if (status === "done") return <Check size={11} strokeWidth={2.2} aria-hidden="true" />;
  if (status === "error") return <AlertTriangle size={11} strokeWidth={2.2} aria-hidden="true" />;
  if (status === "running") return <Loader2 size={11} strokeWidth={2.2} aria-hidden="true" />;
  return (
    <span
      aria-hidden="true"
      className="inline-block h-[11px] w-[11px] rounded-full border border-current"
    />
  );
}

export function RunProgressStrip({
  phase,
  chips,
  turnCount,
}: RunProgressStripProps): ReactElement | null {
  if (!LIVE_RUN_PHASES.has(phase)) return null;
  const terminal = chips.filter((chip) => chip.status === "done" || chip.status === "error").length;
  const step = turnCount ?? terminal + 1;
  return (
    <div
      data-testid="chat-progress-strip"
      data-phase={phase}
      className="mo-pop-in relative flex w-full items-center gap-2 rounded-sm border border-border bg-elevated px-2.5 py-1.5"
    >
      <Spinner data-testid="chat-progress-spinner" />
      <p className="min-w-0 shrink-0 text-caption font-medium text-primary">
        {phase === "reconnecting" ? "Reconnecting" : "Working"}
        <span className="ml-1.5 text-muted" data-testid="chat-progress-step">
          step {step}
        </span>
      </p>
      {chips.length > 0 ? (
        <ul className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-thin">
          {chips.map((chip) => (
            <li
              key={chip.toolCallId}
              data-testid="chat-progress-tool"
              data-tool={chip.name}
              data-status={chip.status}
              title={`${chip.name} — ${chip.status}`}
              className={`mo-pop-in flex shrink-0 items-center gap-1 rounded-pill border px-1.5 py-0.5 text-caption ${
                chip.status === "error"
                  ? "border-danger/40 text-danger"
                  : chip.status === "running"
                    ? "border-signal/50 text-primary"
                    : chip.status === "done"
                      ? "border-border text-secondary"
                      : "border-border text-muted"
              }`}
            >
              <ChipMark status={chip.status} />
              <span className="max-w-24 truncate">{chipLabel(chip.name)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <span aria-hidden="true" className="mo-flow-line" />
    </div>
  );
}
