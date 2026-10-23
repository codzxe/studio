"use client";

import { OfflineState } from "@/components/system/system-states";
import { useOnlineStatus } from "@/lib/use-online-status";

/**
 * Offline notice for the onboarding flow (W5-06, §8.3 + §8.11): renders
 * nothing while the browser reports a connection; renders the shared
 * `OfflineState` with form-honest copy above the progress line when it
 * doesn't. The auth split layout carries the identical banner (M9-H) —
 * onboarding is the other workspace-less form journey, so it gets the same
 * page-level arm instead of waiting for each submit to fail: what is at risk
 * is nothing (typed input stays put), what to do is reconnect.
 */
export function OnboardingOfflineNotice() {
  const online = useOnlineStatus();

  if (online) {
    return null;
  }

  return (
    <div data-testid="onboarding-offline">
      <OfflineState title="You're offline. Reconnect to continue — what you've typed stays put." />
    </div>
  );
}
