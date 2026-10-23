"use client";

import { OfflineState } from "@/components/system/system-states";
import { useOnlineStatus } from "@/lib/use-online-status";

/**
 * OfflineBanner (W2-01, §8.11) — the shell-level offline state, wrapping
 * `lib/use-online-status` (navigator.onLine as a reactive store) and the
 * shared `OfflineState` from system-states.
 *
 * Renders `null` while the browser reports a connection (the shell's visual
 * layout is unchanged online). When it doesn't, the banner appears ABOVE the
 * page content (between the top bar and the main region) with shell-honest
 * copy: what is at risk (nothing — the last saved version is safe on the
 * server) and what to do (reconnect, then retry).
 *
 * Honest scope (inherited from the hook): `onLine` means "connected to SOME
 * network", not "the gateway is reachable" — request failures still surface
 * through their own typed inline errors; this banner only covers the
 * obviously-hopeless case.
 */
export function OfflineBanner() {
  const online = useOnlineStatus();

  if (online) {
    return null;
  }

  return (
    <div
      data-testid="shell-offline-banner"
      className="border-b border-border bg-elevated px-5 py-3"
    >
      <OfflineState title="You're offline. Your last saved version is safe." />
    </div>
  );
}
