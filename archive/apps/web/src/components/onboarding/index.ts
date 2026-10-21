// components/onboarding/index.ts — public surface of the onboarding kit
// (§19 Phase 4). Barrel keeps import sites stable as internals evolve.

export {
  CHECKLIST_CELEBRATED_KEY,
  CHECKLIST_STEPS,
  CHECKLIST_STEP_IDS,
  CHECKLIST_STORAGE_KEY,
  TRIAL_CREDITS,
  applyChecklistOverrides,
  checklistProgress,
  checklistStepMeta,
  countCompletedSteps,
  emptyChecklistSteps,
  isChecklistComplete,
  markChecklistStep,
  nextChecklistStep,
  parseChecklistSteps,
  serializeChecklistSteps,
  type ChecklistProgress,
  type ChecklistStepId,
  type ChecklistStepMeta,
  type ChecklistSteps,
} from "./checklist-model";

export {
  CHECKLIST_CHANGED_EVENT,
  getBrowserStorage,
  markChecklistStepDone,
  readChecklistSteps,
  readCelebratedAt,
  writeChecklistSteps,
  writeCelebratedAt,
  type SafeStorage,
} from "./onboarding-storage";

export {
  CREDITS_PATH,
  defaultCheckTrialGrant,
  extractBalance,
  type FetchLike as TrialGrantFetchLike,
  type TrialGrantCheck,
  type TrialGrantFailure,
  type TrialGrantOk,
  type TrialGrantResult,
} from "./trial-grant";

export {
  DEFAULT_TOUR_STEPS,
  TOUR_STORAGE_KEY,
  TOUR_TARGET_IDS,
  TARGET_POLL_MS,
  boxFromRect,
  computeSpotlightLayout,
  parseTourState,
  readTourState,
  serializeTourState,
  writeTourState,
  type Box,
  type SpotlightLayout,
  type TourState,
  type TourStatus,
  type TourStepDef,
  type TourTargetId,
  type Viewport,
} from "./tour-model";

export {
  DEMO_BRIEF,
  DEMO_CREATE_PATH,
  DEMO_DOCUMENT_NAME,
  DEMO_TEMPLATE_ID,
  buildComposeUrl,
  buildCreateDocumentBody,
  extractDocumentId,
  parseComposeUrl,
  seedDemoDocument,
  type CreateDemoDocumentInput,
  type DemoSeedFailure,
  type DemoSeedOk,
  type DemoSeedResult,
  type FetchLike as DemoFetchLike,
} from "./demo-project";

export { DemoProjectCard } from "./demo-project-card";
export type { DemoProjectCardProps } from "./demo-project-card";

export { EmptyWorkspaceState } from "./empty-workspace-state";
export type { EmptyWorkspaceStateProps } from "./empty-workspace-state";

export { FirstSuccessChecklist } from "./first-success-checklist";
export type { FirstSuccessChecklistProps } from "./first-success-checklist";

export { GuidedTour } from "./guided-tour";
export type { GuidedTourProps } from "./guided-tour";

export { useFirstSuccess } from "./use-first-success";
export type {
  UseFirstSuccessOptions,
  UseFirstSuccessResult,
} from "./use-first-success";
