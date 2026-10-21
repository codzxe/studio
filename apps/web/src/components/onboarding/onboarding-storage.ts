// components/onboarding/onboarding-storage.ts — persistence plumbing for the
// onboarding kit (§19 Phase 4). All storage access is behind an injectable
// SafeStorage so tests run without a DOM, and private-mode browsers degrade to
// "don't persist" instead of throwing.

import {
  CHECKLIST_CELEBRATED_KEY,
  CHECKLIST_STORAGE_KEY,
  emptyChecklistSteps,
  markChecklistStep,
  parseChecklistSteps,
  serializeChecklistSteps,
  type ChecklistStepId,
  type ChecklistSteps,
} from "./checklist-model";

export interface SafeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Same-tab broadcast so every mounted checklist/tour stays in sync. */
export const CHECKLIST_CHANGED_EVENT = "onboarding:checklist-changed";

/**
 * localStorage behind a probe: null on the server and in browsers where
 * storage is blocked (private mode, disabled cookies).
 */
export function getBrowserStorage(): SafeStorage | null {
  if (typeof window === "undefined") return null;
  try {
    const probe = "__onboarding_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readChecklistSteps(storage: SafeStorage | null): ChecklistSteps {
  return parseChecklistSteps(storage?.getItem(CHECKLIST_STORAGE_KEY) ?? null);
}

export function writeChecklistSteps(
  storage: SafeStorage | null,
  steps: ChecklistSteps,
): void {
  storage?.setItem(CHECKLIST_STORAGE_KEY, serializeChecklistSteps(steps));
  notifyChecklistChanged();
}

export function notifyChecklistChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(CHECKLIST_CHANGED_EVENT));
}

/**
 * Mark one checklist step done (persisted + broadcast). Call this from the
 * page where the action actually happens, e.g. the compose page marks
 * "first-prompt" once a run is submitted — see README.md for the wiring list.
 */
export function markChecklistStepDone(
  step: ChecklistStepId,
  storage: SafeStorage | null = getBrowserStorage(),
): ChecklistSteps {
  const next = markChecklistStep(readChecklistSteps(storage) ?? emptyChecklistSteps(), step, true);
  writeChecklistSteps(storage, next);
  return next;
}

/** Celebration flag: shown exactly once per browser profile. */
export function readCelebratedAt(storage: SafeStorage | null): string | null {
  return storage?.getItem(CHECKLIST_CELEBRATED_KEY) ?? null;
}

export function writeCelebratedAt(
  storage: SafeStorage | null,
  value: string,
): string {
  storage?.setItem(CHECKLIST_CELEBRATED_KEY, value);
  return value;
}
