"use client";

/**
 * The chat panel header (M4-G2 — M4-SEAMS Seam 7 + Wave-2 UI contract,
 * EDITOR_CHAT_UX §3.1): status dot + title on the left, the entitlement-driven
 * model picker (ModelPicker — `GET /v1/models` injected by M4-J, never fetched
 * here), the `Context N` button, the compact action row (cycle-mode ⤢, dock
 * toggle ⇥, close ×) and the `⋯` more menu (New chat / Reset position /
 * Keyboard shortcuts — History and Clear context are M5/M4-H and are
 * deliberately absent, matching the pinned props).
 *
 * Status law (§3.1): idle=dim dot, sending/streaming=animated pulse dot
 * (CSS-only `animate-pulse-dot`; the theme's global prefers-reduced-motion
 * override collapses it to a single frame — reduced-motion safe by
 * construction), done=ok, failed/cancelled=error tone. NO spinners in the
 * header. Reconnecting rides the §8.4 banner elsewhere; its dot pulses in the
 * warning tone so a stalled stream reads as "live, but struggling".
 *
 * Visual: tokens only (§10), 48px header (--chat-header-h), compact 28px
 * action buttons, @studio/ui Button/Menu/Tooltip/StatusDot primitives.
 */

import { Maximize2, MoreHorizontal, PanelRight, X } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import type { RunPhase } from "@/lib/chat/types";
import {
  Button,
  Menu,
  MenuContent,
  MenuItem,
  MenuItemShortcut,
  MenuTrigger,
  StatusDot,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
  type StatusTone,
} from "@studio/ui";
import { ModelPicker } from "./model-picker";
import type { ModelsListEntry } from "./model-picker";

/** Wave-2 pinned contract: one `GET /v1/models` wire item (re-exported, Seam 1). */
export type { ModelsListEntry, ModelPickerProps } from "./model-picker";
/** Re-exported for M4-J: one import surface for the whole header chrome. */
export { ModelPicker, modelDisplayName, modelTierLabel } from "./model-picker";

/** Wave-2 pinned contract — the M4-J consumption surface (verbatim). */
export interface ChatHeaderProps {
  phase: RunPhase;
  title: string;
  /** null = entitlement surface loading; [] = surface empty/failed → picker hidden. */
  models: readonly ModelsListEntry[] | null;
  activeModelId: string | null;
  onModelPick(id: string): void;
  contextCount: number;
  onContextClick(): void;
  onCycleMode(): void;
  onToggleDock(): void;
  onClose(): void;
  onNewChat(): void;
  onResetPosition(): void;
  onShortcuts(): void;
}

/** §3.1 status dot tones: dim / live-pulse / ok / error (never colour-only — the title is the label). */
const PHASE_STATUS: Readonly<Record<RunPhase, { tone: StatusTone; pulse: boolean }>> = {
  idle: { tone: "neutral", pulse: false },
  sending: { tone: "signal", pulse: true },
  streaming: { tone: "signal", pulse: true },
  reconnecting: { tone: "warning", pulse: true },
  done: { tone: "success", pulse: false },
  failed: { tone: "danger", pulse: false },
  cancelled: { tone: "danger", pulse: false },
};

/** One compact 28px icon action with a shortcut tooltip (§7.6). */
function HeaderAction(props: {
  label: string;
  tooltip: string;
  testId: string;
  onClick(): void;
  children: ReactNode;
}): ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-secondary hover:text-primary"
          aria-label={props.label}
          data-testid={props.testId}
          onClick={props.onClick}
        >
          {props.children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{props.tooltip}</TooltipContent>
    </Tooltip>
  );
}

export function ChatHeader(props: ChatHeaderProps): ReactElement {
  const status = PHASE_STATUS[props.phase];
  return (
    <header
      data-testid="chat-header"
      data-phase={props.phase}
      className="flex h-[var(--chat-header-h)] shrink-0 items-center gap-1.5 border-b border-border bg-panel px-2"
    >
      <StatusDot
        tone={status.tone}
        pulse={status.pulse}
        data-testid="chat-status"
        data-phase={props.phase}
        className="min-w-0"
      >
        <span data-testid="chat-title" className="truncate font-medium text-primary">
          {props.title}
        </span>
      </StatusDot>

      <ModelPicker
        models={props.models}
        activeModelId={props.activeModelId}
        onPick={props.onModelPick}
      />

      {/* Spacer: context + actions hug the right edge (§3.1 anatomy). */}
      <div aria-hidden="true" className="min-w-0 flex-1" />

      {props.contextCount > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          className={cn("h-7 shrink-0 gap-1 px-2 text-secondary hover:text-primary")}
          data-testid="chat-context-button"
          onClick={props.onContextClick}
        >
          Context {props.contextCount}
        </Button>
      ) : null}

      <TooltipProvider>
        <div className="flex shrink-0 items-center gap-0.5">
          <HeaderAction
            label="Cycle panel mode"
            tooltip="Cycle panel mode (⌘/Ctrl+L)"
            testId="chat-cycle-mode-button"
            onClick={props.onCycleMode}
          >
            <Maximize2 size={15} strokeWidth={1.75} aria-hidden="true" />
          </HeaderAction>
          <HeaderAction
            label="Toggle sidebar dock"
            tooltip="Dock panel to sidebar / float"
            testId="chat-dock-button"
            onClick={props.onToggleDock}
          >
            <PanelRight size={15} strokeWidth={1.75} aria-hidden="true" />
          </HeaderAction>
          <HeaderAction
            label="Close chat"
            tooltip="Close chat (Esc)"
            testId="chat-close-button"
            onClick={props.onClose}
          >
            <X size={15} strokeWidth={1.75} aria-hidden="true" />
          </HeaderAction>
        </div>
      </TooltipProvider>

      <Menu>
        <MenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 shrink-0 p-0 text-secondary hover:text-primary"
            aria-label="More chat actions"
            data-testid="chat-more-button"
          >
            <MoreHorizontal size={16} strokeWidth={1.75} aria-hidden="true" />
          </Button>
        </MenuTrigger>
        <MenuContent align="end" data-testid="chat-more-menu">
          <MenuItem data-testid="chat-menu-new-chat" onSelect={() => props.onNewChat()}>
            New chat
            <MenuItemShortcut>⌘⇧L</MenuItemShortcut>
          </MenuItem>
          <MenuItem
            data-testid="chat-menu-reset-position"
            onSelect={() => props.onResetPosition()}
          >
            Reset position
          </MenuItem>
          <MenuItem data-testid="chat-menu-shortcuts" onSelect={() => props.onShortcuts()}>
            Keyboard shortcuts
            <MenuItemShortcut>?</MenuItemShortcut>
          </MenuItem>
        </MenuContent>
      </Menu>
    </header>
  );
}
