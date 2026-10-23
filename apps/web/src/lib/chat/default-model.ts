/**
 * The default-model localStorage seam (D-10 ECUX-literal key
 * `studio.chat.model.v1`, W5-03).
 *
 * ONE canonical module for the key + quota-safe read/write so the two
 * consumers can never drift apart:
 * - `components/settings/models-preferences-view.tsx` — the §8.9 "Models"
 *   radio WRITES the user's saved default (and re-reads it for preselect);
 * - `lib/chat/provider.tsx` — the chat provider READS it when the plan's
 *   models load: a saved default that is still on-plan becomes the active
 *   model; otherwise the first allowed model stays the default.
 *
 * Verified at the seam's creation (2026-10-23) and re-verified for this
 * move: no other key of this name exists anywhere in apps/web. Reads never
 * throw — an absent, corrupt or blocked storage degrades to null (the
 * picker default), never a crash.
 */

/** D-10: the ECUX-literal localStorage key for the saved default model. */
export const DEFAULT_MODEL_STORAGE_KEY = "studio.chat.model.v1";

/** Quota-safe read: absent, corrupt or blocked storage → null (never throws). */
export function readDefaultModel(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(DEFAULT_MODEL_STORAGE_KEY);
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 100) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Quota-safe write (best-effort persistence — the saveLayout house pattern). */
export function writeDefaultModel(id: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(DEFAULT_MODEL_STORAGE_KEY, id);
    return true;
  } catch {
    return false;
  }
}
