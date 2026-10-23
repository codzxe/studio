"use client";

import { useSyncExternalStore } from "react";

/**
 * navigator.onLine as a reactive hook (M9-H, §8.11 offline states).
 *
 * The browser fires `online`/`offline` on `window` when the network
 * connection drops or returns; `navigator.onLine` is the source of truth for
 * the current state. `useSyncExternalStore` keeps the snapshot consistent
 * across concurrent renders and gives us a server snapshot (`true`) so SSR
 * and hydration never disagree — if the client is actually offline, React
 * re-renders right after hydration with the honest value.
 *
 * Caveat (honest scope): `onLine` means "connected to SOME network", not
 * "Studio is reachable" — that is why the auth forms still show inline
 * service-unreachable errors for failed requests; this hook only gates the
 * obviously-hopeless case where the browser reports no connection at all.
 */

function subscribe(onStoreChange: () => void): () => void {
  window.addEventListener("online", onStoreChange);
  window.addEventListener("offline", onStoreChange);
  return () => {
    window.removeEventListener("online", onStoreChange);
    window.removeEventListener("offline", onStoreChange);
  };
}

function getSnapshot(): boolean {
  return navigator.onLine;
}

function getServerSnapshot(): boolean {
  // Server render: assume connected; the client corrects after hydration.
  return true;
}

/** True while the browser reports a network connection, false when offline. */
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
