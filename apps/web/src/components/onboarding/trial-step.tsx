"use client";

/**
 * TrialStep — onboarding step 3, "Start" (UI_DESIGN_SYSTEM §8.3; DECISIONS
 * D-4; manifest W2-02).
 *
 * Two §8.3 exits, ONE primary:
 *
 * - "Start trial" (primary) → `POST /v1/billing/trial`. Card required — the
 *   D-4 copy is stated verbatim up front. Every failure is a TYPED arm
 *   rendered inline (§8.2: inline, not toasts):
 *     · 400 payment-method-required — honest guidance + a `/w/billing` link
 *       (the real-Stripe card-fingerprint seam is deliberately NOT faked
 *       here; the user adds a card first, then returns).
 *     · 403 card-already-trialed — one trial per payment method.
 *     · 409 workspace-has-history — one trial per workspace.
 *     · anything else — the bounded §7.3 message + hint + request id.
 *   Success → the trial-days notice, then `/w`.
 * - "Create workspace" (secondary) → `/w` without a trial (start one later
 *   from Billing).
 *
 * Boundary law (apps/web): `@studio/contracts` is `import type` ONLY.
 */

import { daysUntil, formatDate } from "@/components/billing/page-format";
import { type CallOptions, isApiError } from "@studio/api-client";
import type { TrialResponse } from "@studio/contracts";
import { Button } from "@studio/ui";
import Link from "next/link";
import { useMemo, useState } from "react";

/** The D-4 trial copy, verbatim (UI_DESIGN_SYSTEM §8.2). */
const TRIAL_COPY = "14 days free, then $29/mo. Card required today. Cancel anytime.";

/** A small billing-link builder so every arm that needs one uses the same label. */
function billingLink() {
  return (
    <Link
      href="/w/billing"
      data-testid="onboarding-trial-billing-link"
      className="text-primary underline underline-offset-3 transition-colors duration-120 hover:text-signal"
    >
      Go to Billing
    </Link>
  );
}

/** The typed trial arms — one per §7.3 failure the route can answer. */
type TrialArm =
  /** 400: the workspace's Stripe customer carries no card fingerprint. */
  | { readonly kind: "payment-method" }
  /** 403: the card already started a trial on another workspace. */
  | { readonly kind: "card-trialed" }
  /** 409: this workspace already spent its trial. */
  | { readonly kind: "workspace-history" }
  /** Anything else — bounded §7.3 surface. */
  | {
      readonly kind: "unavailable";
      readonly message: string;
      readonly hint?: string;
      readonly requestId?: string;
    };

function trialArm(error: unknown): TrialArm {
  if (isApiError(error)) {
    // The gateway answers the card-required 400 as VALIDATION_FAILED with
    // that exact message (routes/billing.ts §M6 task 5) — the message is the
    // only typed discriminator from its sibling 400 (blocked email domain).
    if (error.status === 400 && /payment method/i.test(error.message)) {
      return { kind: "payment-method" };
    }
    if (error.status === 403) return { kind: "card-trialed" };
    if (error.status === 409) return { kind: "workspace-history" };
    return {
      kind: "unavailable",
      message: error.message,
      hint: error.hint,
      requestId: error.requestId,
    };
  }
  return {
    kind: "unavailable",
    message: "Couldn't start the trial. Try again in a moment.",
    hint: "Check your connection, then retry.",
  };
}

export interface TrialStepProps {
  /** The workspace step 1 created (id + display fields). */
  readonly workspace: { readonly id: string; readonly name: string; readonly slug: string };
  /** POST /v1/billing/trial, already workspace-scoped (injected). */
  readonly startTrial: (options?: CallOptions) => Promise<TrialResponse>;
  /** Navigate (injected — the flow's seam or a test fake). */
  readonly navigate: (to: string) => void;
  /** Clock pin for the trial-days notice (deterministic tests). */
  readonly nowIso?: string;
}

export function TrialStep({ workspace, startTrial, navigate, nowIso }: TrialStepProps) {
  const [status, setStatus] = useState<"idle" | "starting" | "started">("idle");
  const [arm, setArm] = useState<TrialArm | null>(null);
  const [trialEnd, setTrialEnd] = useState<string | null>(null);
  const now = useMemo(() => new Date(nowIso ?? Date.now()), [nowIso]);

  function onStartTrial() {
    setStatus("starting");
    setArm(null);
    startTrial()
      .then((response) => {
        setTrialEnd(response.trialEnd);
        setStatus("started");
        navigate("/w");
      })
      .catch((error: unknown) => {
        setArm(trialArm(error));
        setStatus("idle");
      });
  }

  if (status === "started" && trialEnd !== null) {
    const days = daysUntil(trialEnd, now);
    return (
      <div
        className="flex flex-col gap-4"
        data-testid="onboarding-trial-started"
        data-status="started"
      >
        <h2 className="text-body-l font-medium text-primary">Trial started.</h2>
        <p className="text-body-s text-secondary">
          {days} {days === 1 ? "day" : "days"} free, until {formatDate(trialEnd)}. Your card
          isn&apos;t charged during the trial.
        </p>
        <p className="text-body-s text-muted">
          Taking you to your workspace — or{" "}
          <Link
            href="/w"
            data-testid="onboarding-trial-continue"
            className="text-primary underline underline-offset-3 transition-colors duration-120 hover:text-signal"
          >
            continue now
          </Link>
          .
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6" data-testid="onboarding-trial">
      <div className="flex flex-col gap-2">
        <h2 className="text-body-l font-medium text-primary">Start creating.</h2>
        <p className="text-body-s text-secondary">
          Your workspace <span className="text-primary">{workspace.name}</span> is ready at{" "}
          <span className="text-primary">/w/{workspace.slug}</span>.
        </p>
      </div>

      <p
        className="rounded-sm border border-border bg-input px-4 py-3 text-body-s text-primary"
        data-testid="onboarding-trial-copy"
      >
        {TRIAL_COPY}
      </p>

      {arm !== null ? (
        <div
          role="alert"
          data-testid="onboarding-trial-error"
          data-arm={arm.kind}
          className="flex flex-col gap-2"
        >
          {arm.kind === "payment-method" ? (
            <>
              <p className="text-caption text-danger">
                A payment method is required to start a trial.
              </p>
              <p className="text-caption text-secondary">
                Add a card in Billing first, then come back — the trial starts once a card is on
                file and isn&apos;t charged while it runs.
              </p>
              <p className="text-caption text-secondary">{billingLink()}</p>
            </>
          ) : null}
          {arm.kind === "card-trialed" ? (
            <>
              <p className="text-caption text-danger">
                That payment method already started a trial.
              </p>
              <p className="text-caption text-secondary">
                Trials are one per card. {billingLink()} to choose a plan instead.
              </p>
            </>
          ) : null}
          {arm.kind === "workspace-history" ? (
            <>
              <p className="text-caption text-danger">
                This workspace already has a billing history.
              </p>
              <p className="text-caption text-secondary">
                Trials are one per workspace. {billingLink()} to choose a plan instead.
              </p>
            </>
          ) : null}
          {arm.kind === "unavailable" ? (
            <>
              <p className="text-caption text-danger">{arm.message}</p>
              {arm.hint ? <p className="text-caption text-muted">{arm.hint}</p> : null}
              {arm.requestId ? (
                <p className="text-caption text-muted">Request {arm.requestId}</p>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="button" size="lg" loading={status === "starting"} onClick={onStartTrial}>
          Start trial
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="lg"
          data-testid="onboarding-trial-skip"
          onClick={() => navigate("/w")}
        >
          Create workspace
        </Button>
      </div>

      <p className="text-caption text-muted">
        Skip the trial — you can start one later from Billing.
      </p>
    </div>
  );
}
