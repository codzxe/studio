/**
 * Chat system banners (M4-F) — EDITOR_CHAT_UX §3.3 "system notices are inline
 * banners, not toasts", §8.4 "Reconnecting…" / "Run paused. Check your
 * connection.", §10 "status is never colour-only".
 *
 * Exported surface (docs/phases/M4-SEAMS.md "Wave-2 UI contract", binding):
 *   ChatBannerProps + ChatBanner, RunPausedBanner({ onRetry })
 *
 * `kind` drives the border/underline tone AND the icon; the message text is
 * always plain `--text-primary` so the banner stays readable — colour is never
 * the only signal (UI_DESIGN_SYSTEM §3.1). `error` banners announce as
 * `role="alert"`; the rest are polite `role="status"` (the thread itself is the
 * aria-live region — see thread.tsx).
 */

import { RUN_PAUSED_ERROR } from "@/lib/chat/run-state";
import { Button } from "@studio/ui";
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import type { ReactElement } from "react";

export interface ChatBannerProps {
  kind: "info" | "warning" | "error" | "success";
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss?: () => void;
}

const KIND_ICON: Record<ChatBannerProps["kind"], typeof Info> = {
  info: Info,
  warning: TriangleAlert,
  error: CircleAlert,
  success: CircleCheck,
};

/** info = neutral hairline; the tinted kinds get a 40% tone border + 10% wash. */
const KIND_CHROME: Record<ChatBannerProps["kind"], string> = {
  info: "border-border bg-panel",
  warning: "border-warning/40 bg-warning/10",
  error: "border-danger/40 bg-danger/10",
  success: "border-success/40 bg-success/10",
};

const KIND_ICON_TONE: Record<ChatBannerProps["kind"], string> = {
  info: "text-secondary",
  warning: "text-warning",
  error: "text-danger",
  success: "text-success",
};

export function ChatBanner({
  kind,
  message,
  actionLabel,
  onAction,
  onDismiss,
}: ChatBannerProps): ReactElement {
  const Icon = KIND_ICON[kind];
  const showAction = actionLabel !== undefined && onAction !== undefined;
  return (
    <div
      data-testid="chat-banner"
      data-kind={kind}
      role={kind === "error" ? "alert" : "status"}
      className={`flex items-center gap-2 rounded-sm border px-3 py-2 text-caption text-primary ${KIND_CHROME[kind]}`}
    >
      <Icon
        size={16}
        strokeWidth={1.75}
        aria-hidden="true"
        className={`shrink-0 ${KIND_ICON_TONE[kind]}`}
      />
      <p className="min-w-0 flex-1">{message}</p>
      {showAction ? (
        <Button variant="secondary" size="sm" data-testid="chat-banner-action" onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
      {onDismiss ? (
        <button
          type="button"
          data-testid="chat-banner-dismiss"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="shrink-0 text-muted transition-colors duration-120 hover:text-primary"
        >
          <X size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * §8.4 "after 3 failures, show 'Run paused. Check your connection.' with
 * Retry" — the message is the engine's own RUN_PAUSED_ERROR constant (M4-B),
 * imported so the banner can never drift from the reducer's copy.
 */
export function RunPausedBanner({ onRetry }: { onRetry: () => void }): ReactElement {
  return (
    <div data-testid="chat-banner-run-paused" className="px-3 pt-2">
      <ChatBanner
        kind="warning"
        message={RUN_PAUSED_ERROR.message}
        actionLabel="Retry"
        onAction={onRetry}
      />
    </div>
  );
}
