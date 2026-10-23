"use client";

/**
 * OnboardingFlow — the first-run journey after sign-up
 * (UI_DESIGN_SYSTEM §8.3; manifest W2-02).
 *
 * Three steps, ONE Card, no wizard chrome. Progress is a 3-segment LINE —
 * not numbered circles (§8.3): Workspace → Use case → Start.
 *
 * - Step 1 (Workspace) creates the workspace (`POST /v1/workspaces`) — the
 *   orphaned `slug.ts` slugify finally derives the slug live here. A typed
 *   409 CONFLICT surfaces inline ("that slug is taken").
 * - Step 2 (Use case) is skippable (§8.3). W5-03: the choice persists
 *   NOTHING — the old `studio.onboarding.usecase.v1` localStorage write had
 *   no consumer (no backend field exists), so the copy says the pick changes
 *   nothing today and nothing is stored.
 * - Step 3 (Start) offers "Start trial" (`POST /v1/billing/trial`, card
 *   required per D-4) or "Create workspace" straight to `/w`.
 *
 * The api-client surface is narrowed to a port the tests fake (the
 * page-billing-view `BillingPort` pattern); production builds it from
 * `createApiClient` same-origin. The trial call carries the freshly created
 * workspace's `x-workspace-id` (requireWorkspace reads it).
 *
 * Boundary law (apps/web): `@studio/contracts` is `import type` ONLY.
 */

import { type CallOptions, createApiClient } from "@studio/api-client";
import type { CreateWorkspaceRequest, TrialResponse, Workspace } from "@studio/contracts";
import { Card, cn } from "@studio/ui";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import { OnboardingOfflineNotice } from "./offline-notice";
import { TrialStep } from "./trial-step";
import { UseCaseStep } from "./use-case-step";
import { WorkspaceStep } from "./workspace-step";

// ---------------------------------------------------------------------------
// The api seam — a narrow port the real ApiClient satisfies structurally
// ---------------------------------------------------------------------------

/**
 * The onboarding surface `@studio/api-client` exposes. Production builds it
 * from `createApiClient` (same-origin `/v1`); tests fake it.
 */
export interface OnboardingPort {
  /** POST /v1/workspaces — step 1 (409 CONFLICT = the slug is taken). */
  readonly createWorkspace: (
    body: CreateWorkspaceRequest,
    options?: CallOptions,
  ) => Promise<Workspace>;
  /**
   * POST /v1/billing/trial — step 3, scoped to the workspace the flow just
   * created (`x-workspace-id`; card required, one per card/workspace, D-4).
   */
  readonly startTrial: (workspaceId: string, options?: CallOptions) => Promise<TrialResponse>;
}

/** Same-origin API root (Caddy fronts `/v1` in production — README §Env). */
const API_BASE_URL = "/v1";

/**
 * Builds the production port. A fresh client per call keeps the trial call's
 * `x-workspace-id` honest (it is only known after step 1 succeeds).
 */
export function createOnboardingPort(): OnboardingPort {
  return {
    createWorkspace: (body, options) =>
      createApiClient({ baseUrl: API_BASE_URL }).workspaces.create(body, options),
    startTrial: (workspaceId, options) =>
      createApiClient({
        baseUrl: API_BASE_URL,
        headers: { "x-workspace-id": workspaceId },
      }).billing.startTrial(undefined, options),
  };
}

// ---------------------------------------------------------------------------
// The 3-segment progress line (§8.3: a line, never numbered circles)
// ---------------------------------------------------------------------------

const STEP_LABELS = ["Workspace", "Use case", "Start"] as const;

type SegmentState = "done" | "current" | "todo";

function segmentState(index: number, step: number): SegmentState {
  const position = index + 1;
  if (position < step) return "done";
  if (position === step) return "current";
  return "todo";
}

function ProgressLine({ step }: { step: number }) {
  return (
    <div className="mb-8 flex flex-col gap-2" data-testid="onboarding-progress">
      <ol className="flex items-center gap-2" aria-hidden="true">
        {STEP_LABELS.map((label, index) => {
          const state = segmentState(index, step);
          return (
            <li
              key={label}
              data-testid={`onboarding-segment-${index + 1}`}
              data-state={state}
              className={cn(
                "h-1 flex-1 rounded-full transition-colors duration-120",
                state === "todo" ? "bg-border" : "bg-signal",
              )}
            />
          );
        })}
      </ol>
      <ol className="flex items-center gap-2">
        {STEP_LABELS.map((label, index) => {
          const state = segmentState(index, step);
          return (
            <li
              key={label}
              data-testid={`onboarding-step-label-${index + 1}`}
              aria-current={state === "current" ? "step" : undefined}
              className={cn(
                "flex-1 text-caption",
                state === "current"
                  ? "text-primary"
                  : state === "done"
                    ? "text-secondary"
                    : "text-muted",
              )}
            >
              {label}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

export interface OnboardingFlowProps {
  /** Injectable port (tests). Production leaves it undefined. */
  readonly api?: OnboardingPort;
  /** Injectable navigation (tests). Production routes via useRouter. */
  readonly navigate?: (to: string) => void;
}

/** The created workspace as the flow carries it from step 1 to step 3. */
interface CreatedWorkspace {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

export function OnboardingFlow({ api, navigate }: OnboardingFlowProps) {
  const router = useRouter();
  const port = useMemo<OnboardingPort>(() => api ?? createOnboardingPort(), [api]);
  const go = useCallback(
    (to: string) => {
      if (navigate !== undefined) {
        navigate(to);
        return;
      }
      router.push(to);
      router.refresh();
    },
    [navigate, router],
  );

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [workspace, setWorkspace] = useState<CreatedWorkspace | null>(null);

  return (
    <Card data-testid="onboarding-card" className="w-full max-w-md py-8 sm:p-8">
      {/* §8.11 offline (W5-06) — null while online; the forms' failure copy
          ("Check your connection, then retry.") covers requests that fail
          while technically online. */}
      <OnboardingOfflineNotice />
      <ProgressLine step={step} />

      {step === 1 ? (
        <WorkspaceStep
          createWorkspace={port.createWorkspace}
          onCreated={(created) => {
            setWorkspace({
              id: created.id,
              name: created.name,
              slug: created.slug,
            });
            setStep(2);
          }}
        />
      ) : null}

      {step === 2 ? <UseCaseStep onNext={() => setStep(3)} /> : null}

      {step === 3 && workspace !== null ? (
        <TrialStep
          workspace={workspace}
          startTrial={(options) => port.startTrial(workspace.id, options)}
          navigate={go}
        />
      ) : null}
    </Card>
  );
}
