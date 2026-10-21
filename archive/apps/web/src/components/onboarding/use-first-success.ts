// components/onboarding/use-first-success.ts — React wiring for the
// first-success checklist (§19 Phase 4). Completion state comes from injected
// seams: localStorage (user actions), a GET /v1/credits trial-grant check
// (step 0), and host-provided overrides (e.g. real session signals).

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CHECKLIST_STORAGE_KEY,
  applyChecklistOverrides,
  checklistProgress,
  emptyChecklistSteps,
  isChecklistComplete,
  markChecklistStep,
  nextChecklistStep,
  type ChecklistProgress,
  type ChecklistStepId,
  type ChecklistStepMeta,
  type ChecklistSteps,
} from "./checklist-model";
import {
  CHECKLIST_CHANGED_EVENT,
  getBrowserStorage,
  readChecklistSteps,
  writeChecklistSteps,
  type SafeStorage,
} from "./onboarding-storage";
import {
  defaultCheckTrialGrant,
  type TrialGrantCheck,
  type TrialGrantFailure,
} from "./trial-grant";

export interface UseFirstSuccessOptions {
  /** Defaults to window.localStorage when the DOM allows it. */
  readonly storage?: SafeStorage | null;
  /** Step-0 check; defaults to defaultCheckTrialGrant (GET /v1/credits). */
  readonly checkTrialGrant?: TrialGrantCheck;
  /** The user is inside a workspace (default true) — completes "create-workspace". */
  readonly workspaceReady?: boolean;
  /** Injected completion overrides; win over storage and runtime checks. */
  readonly overrides?: Readonly<Record<string, unknown>>;
}

export interface UseFirstSuccessResult {
  readonly steps: ChecklistSteps;
  readonly progress: ChecklistProgress;
  readonly nextStep: ChecklistStepMeta | null;
  readonly complete: boolean;
  readonly trialGrantPending: boolean;
  readonly trialGrantFailure: TrialGrantFailure | null;
  readonly retryTrialGrant: () => void;
  readonly markDone: (step: ChecklistStepId) => void;
  readonly reset: () => void;
}

export function useFirstSuccess(
  options: UseFirstSuccessOptions = {},
): UseFirstSuccessResult {
  const store = useMemo<SafeStorage | null>(
    () => (options.storage !== undefined ? options.storage : getBrowserStorage()),
    [options.storage],
  );

  // Start "empty" on both server and first client render (hydration-safe),
  // then hydrate from storage in an effect.
  const [storedSteps, setStoredSteps] = useState<ChecklistSteps>(emptyChecklistSteps);
  const [trialPhase, setTrialPhase] = useState<"checking" | "done" | "failed">("checking");
  const [trialFailure, setTrialFailure] = useState<TrialGrantFailure | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  const checkRef = useRef<TrialGrantCheck>(defaultCheckTrialGrant);
  useEffect(() => {
    checkRef.current = options.checkTrialGrant ?? defaultCheckTrialGrant;
  }, [options.checkTrialGrant]);

  // Hydrate from storage + stay in sync across tabs and same-tab instances.
  useEffect(() => {
    setStoredSteps(readChecklistSteps(store));
    const sync = () => setStoredSteps(readChecklistSteps(store));
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === CHECKLIST_STORAGE_KEY) sync();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(CHECKLIST_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(CHECKLIST_CHANGED_EVENT, sync);
    };
  }, [store]);

  const trialOverridden = useMemo(
    () => typeof options.overrides?.["trial-grant"] === "boolean",
    [options.overrides],
  );

  // Step 0: the trial-grant GET /v1/credits check.
  useEffect(() => {
    if (trialOverridden) return;
    let cancelled = false;
    setTrialPhase("checking");
    setTrialFailure(null);
    checkRef
      .current()
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setTrialPhase("done");
        } else {
          setTrialPhase("failed");
          setTrialFailure(result);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setTrialPhase("failed");
        setTrialFailure({
          ok: false,
          code: "credits.unreachable",
          message: "Couldn't reach the server to check your credits.",
          hint: "Check your connection, then retry.",
          retryable: true,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [retryToken, trialOverridden]);

  const retryTrialGrant = useCallback(() => setRetryToken((token) => token + 1), []);

  const steps = useMemo<ChecklistSteps>(() => {
    let merged = storedSteps;
    if (trialPhase === "done") merged = markChecklistStep(merged, "trial-grant", true);
    if (options.workspaceReady !== false) {
      merged = markChecklistStep(merged, "create-workspace", true);
    }
    return applyChecklistOverrides(merged, options.overrides);
  }, [storedSteps, trialPhase, options.workspaceReady, options.overrides]);

  const markDone = useCallback(
    (step: ChecklistStepId) => {
      const next = markChecklistStep(readChecklistSteps(store), step, true);
      writeChecklistSteps(store, next);
      setStoredSteps(next);
    },
    [store],
  );

  const reset = useCallback(() => {
    const empty = emptyChecklistSteps();
    writeChecklistSteps(store, empty);
    setStoredSteps(empty);
  }, [store]);

  return {
    steps,
    progress: checklistProgress(steps),
    nextStep: nextChecklistStep(steps),
    complete: isChecklistComplete(steps),
    trialGrantPending: trialPhase === "checking" && !trialOverridden,
    trialGrantFailure: trialPhase === "failed" ? trialFailure : null,
    retryTrialGrant,
    markDone,
    reset,
  };
}
