"use client";

// apps/web/src/components/realtime — presence avatars (W8-R).
//
// Spec anchors: §19 Phase 3 ("Presence via Centrifugo (cursors optional)") —
// this bar shows WHO is viewing a document, nothing more. §25 rule 3: no
// cursors, no collaborative painting in v1; the roster is display-only and
// never feeds document state.
//
// PURE PRESENTATIONAL over the presence client (the seam in
// src/lib/realtime/presence.ts): all data arrives via props — the React
// glue lives in use-presence.ts. Typical mount (W8-F / editor topbar):
//
//   const { members, lastDelta } = usePresence({
//     channel: documentPresenceChannel(documentId),
//     selfId: session.user?.id ?? null,
//   });
//   <PresenceBar members={members} selfId={session.user?.id ?? null}
//                selfName={session.user?.name} lastDelta={lastDelta} />
//
// v1 styling stays token-pure (same decision as the shell/auth-form: the
// @studio/ui tokens are not mapped into globals.css yet) — no per-user
// avatar hues; a deterministic hue wheel is a theme-wave TODO.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  initialsOf,
  type PresenceDelta,
  type PresenceMember,
} from "@/lib/realtime/presence";

// ---------------------------------------------------------------------------
// Types + pure presentation helpers
// ---------------------------------------------------------------------------

interface ToastEntry {
  readonly id: number;
  readonly text: string;
}

export interface PresenceBarProps {
  /** Roster straight from usePresence (`update.roster`). */
  readonly members: readonly PresenceMember[];
  /** Current user's id (session context); null when unauthenticated. */
  readonly selfId: string | null;
  /** Display name for the synthesized "you" chip until the roster lands. */
  readonly selfName?: string | null;
  /** Drives join/leave toasts (usePresence `lastDelta`); `sync` stays quiet. */
  readonly lastDelta?: PresenceDelta | null;
  /** Avatars shown before the "+N" chip (default 5). */
  readonly maxVisible?: number;
  /** Toast lifetime in ms (default 4000). */
  readonly toastDurationMs?: number;
  readonly className?: string;
}

function labelOf(member: PresenceMember): string {
  return `${member.name ?? "Member"}${member.self ? " (you)" : ""}`;
}

/**
 * Dedupe by id (a user may hold two connections), self first, join order
 * after that. Synthesizes the "you" entry when the roster doesn't include
 * it yet so the bar renders something honest before the first heartbeat.
 */
function orderForBar(
  members: readonly PresenceMember[],
  selfId: string | null,
  selfName: string | null,
): readonly PresenceMember[] {
  const byId = new Map<string, PresenceMember>();
  for (const member of members) {
    if (!byId.has(member.id)) {
      byId.set(member.id, member);
    }
  }
  const selfKey = selfId ?? "";
  if (selfKey === "") {
    return [...byId.values()];
  }
  const existing = byId.get(selfKey);
  const self: PresenceMember =
    existing === undefined ? { id: selfKey, name: selfName, self: true } : { ...existing, self: true };
  const others: PresenceMember[] = [];
  for (const member of byId.values()) {
    if (member.id !== selfKey) {
      others.push(member);
    }
  }
  return [self, ...others];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PresenceBar({
  members,
  selfId,
  selfName = null,
  lastDelta = null,
  maxVisible = 5,
  toastDurationMs = 4_000,
  className = "",
}: PresenceBarProps) {
  const display = useMemo(() => orderForBar(members, selfId, selfName), [members, selfId, selfName]);
  const [toasts, setToasts] = useState<readonly ToastEntry[]>([]);
  const nextToastId = useRef(0);
  const toastTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  // One toast per join/leave delta ("Ada joined" / "Bo left"); `sync` never
  // toasts (§19: presence, not noise). Each toast owns its dismissal timer
  // so a rapid follow-up delta never strands an earlier toast.
  useEffect(() => {
    if (lastDelta === null || lastDelta.type === "sync") {
      return;
    }
    const name = lastDelta.member.name ?? "Someone";
    const text = lastDelta.type === "join" ? `${name} joined` : `${name} left`;
    nextToastId.current += 1;
    const id = nextToastId.current;
    setToasts((prev) => [...prev.slice(-2), { id, text }]);
    const timer = setTimeout(() => {
      toastTimers.current.delete(id);
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, toastDurationMs);
    toastTimers.current.set(id, timer);
  }, [lastDelta, toastDurationMs]);

  // Unmount clears every pending toast timer.
  useEffect(() => {
    const timers = toastTimers.current;
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  if (display.length === 0) {
    return null;
  }
  const visible = display.slice(0, maxVisible);
  const overflow = display.slice(maxVisible);

  return (
    <div
      role="group"
      aria-label={`Viewing now: ${display.length}`}
      className={`flex items-center gap-2 ${className}`}
    >
      <ul className="flex items-center -space-x-2">
        {visible.map((member) => (
          <li key={member.id} className="rounded-full ring-2 ring-background">
            <span
              title={labelOf(member)}
              aria-label={labelOf(member)}
              className={`flex h-7 w-7 items-center justify-center rounded-full border text-[11px] font-semibold ${
                member.self
                  ? "border-ring bg-accent text-accent-foreground"
                  : "border-border bg-surface-muted text-foreground"
              }`}
            >
              {initialsOf(member.name)}
            </span>
          </li>
        ))}
        {overflow.length > 0 ? (
          <li className="rounded-full ring-2 ring-background">
            <span
              title={`${overflow.length} more viewing`}
              className="flex h-7 w-7 items-center justify-center rounded-full border border-border bg-surface-muted text-[11px] font-semibold text-muted-foreground"
            >
              +{overflow.length}
            </span>
          </li>
        ) : null}
      </ul>
      {toasts.length > 0 ? (
        <div aria-live="polite" className="flex items-center gap-1">
          {toasts.map((toast) => (
            <p
              key={toast.id}
              className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              {toast.text}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
