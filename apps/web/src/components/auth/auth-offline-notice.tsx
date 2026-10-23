"use client";

import { OfflineState } from "@/components/system/system-states";
import { useOnlineStatus } from "@/lib/use-online-status";

/**
 * Offline notice for the auth split layout (M9-H, §8.2 + §8.11): renders
 * nothing while the browser reports a connection; renders the shared
 * OfflineState with auth-honest copy above the form when it doesn't. The
 * forms gate their submits separately (inline "You're offline." errors) —
 * this banner is the page-level "auth is offline-aware" half, so every
 * auth route carries an offline state without redesigning the forms.
 */
export function AuthOfflineNotice() {
  const online = useOnlineStatus();

  if (online) {
    return null;
  }

  return (
    <OfflineState title="You're offline. Reconnect to continue — what you've typed stays put." />
  );
}
