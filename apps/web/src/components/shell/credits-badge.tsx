"use client";

// components/shell/credits-badge — topbar run-credit balance (W8-A).
//
// Fetch placeholder: reads the balance surfaced by the session context
// (GET /v1/credits, §13.1) and links to /billing — the §14.2 top-up path
// (a 402 on run creation points the user the same way). States:
// loading → pulse pill, error → muted "unavailable", ready → balance.
// TODO(W8-B): /v1/credits is a not-implemented gateway route today, so the
// shell shows the error state until the billing wave lands it.

import { Zap } from "lucide-react";
import Link from "next/link";
import { useSession } from "@/hooks/use-session";

const CREDITS_LINK_CLASS =
  "inline-flex h-6 items-center gap-1 rounded-full bg-surface-muted px-3 text-xs font-medium text-foreground transition-colors hover:bg-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const CREDITS_UNAVAILABLE_CLASS =
  "inline-flex h-6 items-center gap-1 rounded-full border border-border px-3 text-xs font-medium text-muted-foreground";

export function CreditsBadge() {
  const { credits } = useSession();

  if (credits.status === "loading") {
    return (
      <span
        role="status"
        aria-label="Loading credits balance"
        className="inline-flex h-6 w-20 animate-pulse items-center rounded-full bg-surface-muted"
      />
    );
  }
  if (credits.status === "error") {
    return (
      <span
        title={credits.message ?? "The credits service is unavailable."}
        className={CREDITS_UNAVAILABLE_CLASS}
      >
        <Zap className="size-3.5 shrink-0" aria-hidden="true" />
        Credits unavailable
      </span>
    );
  }
  const balance = credits.balance ?? 0;
  return (
    <Link
      href="/billing"
      aria-label={`Credits balance: ${formatCredits(balance)}. Open billing.`}
      className={CREDITS_LINK_CLASS}
    >
      <Zap className="size-3.5 shrink-0 text-accent" aria-hidden="true" />
      {formatCredits(balance)} credits
    </Link>
  );
}

/** 1 decimal at most — credit math is fractional only in half-charge cases. */
function formatCredits(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
