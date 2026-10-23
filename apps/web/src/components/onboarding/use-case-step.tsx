"use client";

/**
 * UseCaseStep — onboarding step 2 (UI_DESIGN_SYSTEM §8.3; manifest W2-02).
 *
 * Five choices: motion graphics, title design, social video, product film,
 * other. SKIP is allowed (§8.3: skip is allowed for use case, not for the
 * workspace name). The choice persists to localStorage
 * `studio.onboarding.usecase.v1` ONLY — there is no backend field for it
 * (D-10 key style; honest: nothing is faked server-side, and the copy says
 * so). Skipping persists nothing.
 */

import { Button, cn } from "@studio/ui";
import { useState } from "react";

/** The §8.3 choice list. */
const USE_CASES = [
  { id: "motion-graphics", label: "Motion graphics" },
  { id: "title-design", label: "Title design" },
  { id: "social-video", label: "Social video" },
  { id: "product-film", label: "Product film" },
  { id: "other", label: "Other" },
] as const;

export type UseCaseId = (typeof USE_CASES)[number]["id"];

/** localStorage key (D-10) — the honest local-only seam. */
export const USE_CASE_STORAGE_KEY = "studio.onboarding.usecase.v1";

/** Best-effort write: private-mode/quota failures never block onboarding. */
function persistUseCase(useCase: UseCaseId): void {
  try {
    window.localStorage.setItem(USE_CASE_STORAGE_KEY, useCase);
  } catch {
    // The choice is advisory; a storage failure is not the user's problem.
  }
}

export interface UseCaseStepProps {
  /** Advance to step 3, carrying the choice (or null when skipped). */
  readonly onNext: (useCase: UseCaseId | null) => void;
}

export function UseCaseStep({ onNext }: UseCaseStepProps) {
  const [selected, setSelected] = useState<UseCaseId | null>(null);

  return (
    <div className="flex flex-col gap-6" data-testid="onboarding-usecase">
      <div className="flex flex-col gap-2">
        <h2 className="text-body-l font-medium text-primary">What are you making?</h2>
        <p className="text-body-s text-secondary">
          This tunes where you start. It stays on this device — skip it if you&apos;d rather jump
          straight in.
        </p>
      </div>

      <fieldset className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <legend className="sr-only">Primary use case</legend>
        {USE_CASES.map((useCase) => {
          const isSelected = useCase.id === selected;
          return (
            <button
              key={useCase.id}
              type="button"
              aria-pressed={isSelected}
              data-testid={`onboarding-usecase-${useCase.id}`}
              data-selected={isSelected || undefined}
              onClick={() => setSelected(useCase.id)}
              className={cn(
                "rounded-sm border px-4 py-3 text-left text-body-s transition-colors duration-120",
                isSelected
                  ? "border-signal bg-elevated text-primary"
                  : "border-border bg-input text-secondary hover:border-border-strong hover:text-primary",
              )}
            >
              {useCase.label}
            </button>
          );
        })}
      </fieldset>

      <div className="flex items-center gap-3">
        <Button
          type="button"
          size="lg"
          disabled={selected === null}
          onClick={() => {
            if (selected !== null) {
              persistUseCase(selected);
              onNext(selected);
            }
          }}
        >
          Continue
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="lg"
          data-testid="onboarding-usecase-skip"
          onClick={() => onNext(null)}
        >
          Skip
        </Button>
      </div>

      {selected === null ? (
        <p className="text-caption text-muted">Pick one to continue — or skip.</p>
      ) : null}
    </div>
  );
}
