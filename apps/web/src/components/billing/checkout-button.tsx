"use client";

// components/billing/checkout-button — the Stripe redirect CTAs (W8-K,
// §14.3). CheckoutButton starts POST /v1/billing/checkout for a plan or the
// credit pack; ManageBillingButton opens POST /v1/billing/portal (card and
// plan changes). Both redirect with window.location.assign — Stripe hosts
// the pages, so the app must unmount (a client-side router push would keep
// it alive behind an external URL). Failures surface through the parent via
// the typed envelope { code, message, hint } (§13.3 — user-safe by
// contract), which the card sections render inline.

import { ExternalLink, LoaderCircle } from "lucide-react";
import { useCallback } from "react";
import {
  planDisplayName,
  useCheckout,
  usePortal,
  type BillingActionError,
  type BillingPlanCode,
} from "./use-billing";

const PRIMARY_BUTTON_CLASS =
  "inline-flex h-9 items-center justify-center gap-2 rounded-md bg-accent px-4 text-sm font-semibold text-accent-foreground transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY_BUTTON_CLASS =
  "inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border px-4 text-sm font-medium transition hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

export interface CheckoutButtonProps {
  /** §14.1 wire plan code — "starter" | "pro" | "max" | "pack" (§14.3). */
  readonly planCode: BillingPlanCode;
  /** Defaults to "Choose <plan>" / "Buy credit pack" by code. */
  readonly label?: string;
  readonly variant?: "primary" | "secondary";
  readonly disabled?: boolean;
  readonly className?: string;
  /** Typed failure envelope for inline display in the owning card. */
  readonly onError?: (error: BillingActionError) => void;
}

function defaultLabel(planCode: BillingPlanCode): string {
  return planCode === "pack" ? "Buy credit pack" : `Choose ${planDisplayName(planCode)}`;
}

export function CheckoutButton({
  planCode,
  label,
  variant = "primary",
  disabled = false,
  className,
  onError,
}: CheckoutButtonProps) {
  const { pending, checkout } = useCheckout();

  const startCheckout = useCallback(async (): Promise<void> => {
    const result = await checkout(planCode);
    if (!result.ok) {
      onError?.(result);
    }
  }, [checkout, onError, planCode]);

  return (
    <button
      type="button"
      onClick={() => {
        void startCheckout();
      }}
      disabled={pending || disabled}
      className={
        className ?? (variant === "secondary" ? SECONDARY_BUTTON_CLASS : PRIMARY_BUTTON_CLASS)
      }
    >
      {pending ? (
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
      ) : (
        <ExternalLink className="size-4" aria-hidden="true" />
      )}
      {label ?? defaultLabel(planCode)}
    </button>
  );
}

export interface ManageBillingButtonProps {
  readonly label?: string;
  readonly className?: string;
  readonly disabled?: boolean;
  readonly onError?: (error: BillingActionError) => void;
}

export function ManageBillingButton({
  label = "Manage billing",
  className,
  disabled = false,
  onError,
}: ManageBillingButtonProps) {
  const { pending, openPortal } = usePortal();

  const startPortal = useCallback(async (): Promise<void> => {
    const result = await openPortal();
    if (!result.ok) {
      onError?.(result);
    }
  }, [onError, openPortal]);

  return (
    <button
      type="button"
      onClick={() => {
        void startPortal();
      }}
      disabled={pending || disabled}
      className={className ?? SECONDARY_BUTTON_CLASS}
    >
      {pending ? (
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
      ) : (
        <ExternalLink className="size-4" aria-hidden="true" />
      )}
      {label}
    </button>
  );
}
